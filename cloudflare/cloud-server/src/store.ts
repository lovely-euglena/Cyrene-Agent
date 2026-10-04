/**
 * CloudStore：CF 版单租户 Durable Object（IKJN79）。
 *
 * 承载：事件库（插入序游标）/ 设备令牌（配对 / 撤销 / 轮换）/ 限流 / 生成闭环（DO alarm 重试）。
 * 语义与 .NET cloud-server（EventStore / AuthStore / DialogLoop / Program.cs）逐项对齐，
 * 由 scripts/dotnet-cloud-sync-test.py 核心档锁定（同一函数对部署实例跑）。
 *
 * 差异（已在设计文档记录）：
 * - healthz.rssMB 恒为 0（Workers 无进程 RSS 概念）；
 * - 生成失败重试由 DO alarm 承担（.NET 为进程内 2 次退避后等待下一次事件触发）；
 * - 限流为 DO 内固定窗口计数（CF 平台另有边缘限流；口径与 .NET 固定窗口一致）。
 */
import { readSyncBatch, type SyncEventV0 } from "../../../src/main/sync/sync-protocol";
import { generationEnabled, intEnv, MAX_PUSH_BODY_BYTES, type Env } from "./env";
import { replayBranch, trimContext, type ChatMessage } from "./replay";
import {
  base64Url,
  formatPairCode,
  isRecord,
  normalizeDeviceName,
  normalizePairCode,
  randomBytes,
  randomHex,
  randomPairCode,
  sha256Hex,
  timingSafeEqual,
} from "./util";

const SERVER_DEVICE_ID = "server";
const RATE_WINDOW_MS = 60_000;
const EVENT_COLUMNS =
  "id, event_id, session_id, type, lamport, device_id, seq, ts, payload, prev_hash, hash";

interface EventRow {
  id: number;
  event_id: string;
  session_id: string;
  type: string;
  lamport: number;
  device_id: string;
  seq: number;
  ts: string;
  payload: string;
  prev_hash: string | null;
  hash: string | null;
}

interface PushError {
  index: number;
  code: string;
}

interface PushOutcome {
  accepted: number;
  duplicates: number;
  cursor: number;
}

type Principal = { kind: "master" } | { kind: "device"; deviceId: string; name: string };

/** 整批拒绝（链 / 序号错误）：抛出自事务触发回滚。 */
class BatchRejected extends Error {
  constructor(readonly errors: PushError[]) {
    super("E_SYNC_BATCH_REJECTED");
  }
}

/** 配对码无效 / 已用 / 过期（统一不区分，防枚举）。 */
class RedeemRejected extends Error {}

/** 模型确定性配置错误（密钥 / 模型 / 地址）：重试无意义。 */
class ModelConfigError extends Error {}

export class CloudStore {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initialize());
  }

  // ── 入口 ──

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const rateLimited = await this.enforceRateLimit(request, path);
      if (rateLimited !== null) return rateLimited;

      const auth = await this.authenticate(request);
      const isPairRedeem = request.method === "POST" && path === "/v1/pair";
      if (!isPairRedeem && auth === null) return json({ code: "E_UNAUTHORIZED" }, 401);
      const principal = auth as Principal;

      if (path === "/healthz" && request.method === "GET") return this.healthz();
      if (path === "/v1/pair/code" && request.method === "POST") return await this.createPairCode(principal);
      if (isPairRedeem) return await this.redeemPairCode(request);
      if (path === "/v1/devices" && request.method === "GET") return this.listDevices(principal);
      const deviceAction = /^\/v1\/devices\/([^/]+)\/(revoke|rotate)$/u.exec(path);
      if (deviceAction !== null && request.method === "POST") {
        return await this.manageDevice(principal, decodeURIComponent(deviceAction[1]), deviceAction[2]);
      }
      if (path === "/v1/sync/push" && request.method === "POST") return await this.push(request);
      if (path === "/v1/sync/fetch" && request.method === "GET") return this.fetchEvents(url);
      if (path === "/v1/sync/clone" && request.method === "GET") return this.clone(url);
      return json({ code: "E_NOT_FOUND" }, 404);
    } catch (error) {
      console.error(`CloudStore 处理失败 path=${path}`, error instanceof Error ? error.message : String(error));
      return json({ code: "E_INTERNAL" }, 500);
    }
  }

  // ── 鉴权与限流 ──

  private async authenticate(request: Request): Promise<Principal | null> {
    const token = extractBearer(request);
    if (token === null) return null;
    const masterToken = this.env.CLOUD_TOKEN;
    if (masterToken !== undefined && masterToken.length > 0 && (await timingSafeEqual(token, masterToken))) {
      return { kind: "master" };
    }
    const tokenHash = await sha256Hex(token);
    const row = this.sql
      .exec("SELECT device_id, name, revoked_at FROM devices WHERE token_hash = ?", tokenHash)
      .toArray()[0];
    if (row === undefined || row.revoked_at !== null) return null;
    // 命中节流更新 last_seen（5 分钟窗口；与 .NET TryAuthenticate 一致）
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - 5 * 60_000).toISOString();
    this.sql.exec(
      "UPDATE devices SET last_seen_at = ? WHERE device_id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)",
      now,
      row.device_id,
      cutoff,
    );
    return { kind: "device", deviceId: row.device_id as string, name: row.name as string };
  }

  private async enforceRateLimit(request: Request, path: string): Promise<Response | null> {
    let prefix: string | null = null;
    let limit = 0;
    if (path === "/v1/pair" || path === "/v1/pair/code") {
      prefix = "pair";
      limit = intEnv(this.env.CLOUD_RATE_PAIR_PER_MIN, 10);
    } else if (path.startsWith("/v1/sync/") || path === "/v1/devices" || path.startsWith("/v1/devices/")) {
      prefix = "sync";
      limit = intEnv(this.env.CLOUD_RATE_SYNC_PER_MIN, 300);
    }
    if (prefix === null) return null;
    const window = Math.floor(Date.now() / RATE_WINDOW_MS);
    const key = `${prefix}:${await this.partitionKey(request)}`;
    this.sql.exec("DELETE FROM rate_limits WHERE window < ?", window - 1);
    this.sql.exec(
      "INSERT INTO rate_limits (key, window, count) VALUES (?, ?, 1) ON CONFLICT(key, window) DO UPDATE SET count = count + 1",
      key,
      window,
    );
    const row = this.sql.exec("SELECT count FROM rate_limits WHERE key = ? AND window = ?", key, window).toArray()[0];
    const count = row !== undefined ? Number(row.count) : 1;
    return count > limit ? json({ code: "E_RATE_LIMITED" }, 429) : null;
  }

  /** 分区键：优先按 token 哈希（不落明文），否则按客户端 IP（与 .NET PartitionKey 一致）。 */
  private async partitionKey(request: Request): Promise<string> {
    const token = extractBearer(request);
    if (token !== null) return `t:${(await sha256Hex(token)).slice(0, 16)}`;
    return `i:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`;
  }

  // ── healthz / 配对 / 设备 ──

  private healthz(): Response {
    return json({
      status: "ok",
      rssMB: 0, // Workers 无进程 RSS 概念（口径差异见设计文档 §4.2）
      cursor: this.currentCursor(),
      devices: this.countActiveDevices(),
    });
  }

  private async createPairCode(auth: Principal): Promise<Response> {
    const code = randomPairCode();
    const now = Date.now();
    const expiresAt = new Date(now + intEnv(this.env.CLOUD_PAIR_TTL_SECONDS, 300) * 1000).toISOString();
    const createdBy = auth.kind === "master" ? "master" : auth.deviceId;
    this.sql.exec("DELETE FROM pairing_codes WHERE expires_at < ?", new Date(now - 3_600_000).toISOString());
    this.sql.exec(
      "INSERT INTO pairing_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)",
      await sha256Hex(code),
      createdBy,
      new Date(now).toISOString(),
      expiresAt,
    );
    return json({ code: formatPairCode(code), expiresAt });
  }

  private async redeemPairCode(request: Request): Promise<Response> {
    let body: unknown = null;
    try {
      body = JSON.parse(await request.text());
    } catch {
      body = null;
    }
    const record = isRecord(body) ? body : {};
    const code = normalizePairCode(record.code);
    if (code === null) return json({ code: "E_PAIR_CODE" }, 400);
    const name = normalizeDeviceName(record.deviceName);
    const deviceId = `dev_${randomHex(6)}`;
    const token = `cyn_${base64Url(randomBytes(32))}`;
    const now = new Date().toISOString();
    const codeHash = await sha256Hex(code);
    const tokenHash = await sha256Hex(token);
    try {
      this.ctx.storage.transactionSync(() => {
        const redeemed = this.sql.exec(
          "UPDATE pairing_codes SET redeemed_at = ?, redeemed_by = ? WHERE code_hash = ? AND redeemed_at IS NULL AND expires_at > ?",
          now,
          deviceId,
          codeHash,
          now,
        );
        if (redeemed.rowsWritten === 0) throw new RedeemRejected();
        this.sql.exec(
          "INSERT INTO devices (device_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
          deviceId,
          name,
          tokenHash,
          now,
        );
      });
    } catch (error) {
      if (error instanceof RedeemRejected) return json({ code: "E_PAIR_CODE" }, 400);
      throw error;
    }
    return json({ deviceId, name, token });
  }

  private listDevices(auth: Principal): Response {
    if (auth.kind !== "master") return json({ code: "E_FORBIDDEN" }, 403);
    const rows = this.sql
      .exec("SELECT device_id, name, created_at, last_seen_at, revoked_at FROM devices ORDER BY created_at")
      .toArray();
    const devices = rows.map((row) => {
      const device: Record<string, unknown> = {
        deviceId: row.device_id,
        name: row.name,
        createdAt: row.created_at,
        revoked: row.revoked_at !== null,
      };
      if (row.last_seen_at !== null) device.lastSeenAt = row.last_seen_at;
      return device;
    });
    return json({ devices });
  }

  private async manageDevice(auth: Principal, deviceId: string, action: string): Promise<Response> {
    const allowed = auth.kind === "master" || auth.deviceId === deviceId;
    if (!allowed) return json({ code: "E_FORBIDDEN" }, 403);
    if (action === "revoke") {
      const revoked = this.sql.exec(
        "UPDATE devices SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL",
        new Date().toISOString(),
        deviceId,
      );
      if (revoked.rowsWritten > 0) return json({ deviceId, revoked: true });
      const exists = this.sql.exec("SELECT 1 FROM devices WHERE device_id = ? LIMIT 1", deviceId).toArray().length > 0;
      return exists ? json({ deviceId, revoked: true }) : json({ code: "E_DEVICE_NOT_FOUND" }, 404);
    }
    const token = `cyn_${base64Url(randomBytes(32))}`;
    const rotated = this.sql.exec(
      "UPDATE devices SET token_hash = ? WHERE device_id = ? AND revoked_at IS NULL",
      await sha256Hex(token),
      deviceId,
    );
    return rotated.rowsWritten > 0 ? json({ deviceId, token }) : json({ code: "E_DEVICE_NOT_FOUND" }, 404);
  }

  // ── 同步 ──

  private async push(request: Request): Promise<Response> {
    const contentLength = request.headers.get("content-length");
    if (contentLength !== null && Number(contentLength) > MAX_PUSH_BODY_BYTES) {
      return json({ code: "E_SYNC_BATCH_TOO_LARGE" }, 413);
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PUSH_BODY_BYTES) {
      return json({ code: "E_SYNC_BATCH_TOO_LARGE" }, 413);
    }
    const batch = readSyncBatch(text);
    if (batch.truncatedTail || batch.errors.length > 0) {
      return json({ code: "E_SYNC_BATCH_INVALID", truncatedTail: batch.truncatedTail, errors: batch.errors }, 400);
    }
    const lineByEventId = buildLineByEventId(text);
    let outcome: PushOutcome;
    try {
      outcome = this.ctx.storage.transactionSync(() => this.pushBatch(batch.events, lineByEventId));
    } catch (error) {
      if (error instanceof BatchRejected) return json({ code: "E_SYNC_BATCH_REJECTED", errors: error.errors }, 400);
      throw error;
    }
    if (outcome.accepted > 0) await this.triggerDialog(batch.events);
    return json({ accepted: outcome.accepted, duplicates: outcome.duplicates, cursor: String(outcome.cursor) });
  }

  /**
   * 整批校验 + 幂等插入（事务内调用；任一错误抛出 BatchRejected 触发回滚）。
   * 与 .NET EventStore.PushBatchAsync 一致：fail-fast（首个错误后不再写库，但继续收集错误）。
   */
  private pushBatch(events: SyncEventV0[], lineByEventId: Map<string, number> | null): PushOutcome {
    let accepted = 0;
    let duplicates = 0;
    let hasError = false;
    const errors: PushError[] = [];
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (this.eventIdExists(event.eventId)) {
        duplicates++;
        continue;
      }
      const code = this.checkChain(event);
      if (code !== null) {
        errors.push({ index: lineByEventId?.get(event.eventId) ?? index, code });
        hasError = true;
        continue;
      }
      if (!hasError) {
        this.insertEvent(event);
        accepted++;
      }
    }
    if (errors.length > 0) throw new BatchRejected(errors);
    return { accepted, duplicates, cursor: this.currentCursor() };
  }

  /** 链与序号校验（返回错误码；null = 通过；规则与 .NET EventStore.CheckChain 一致）。 */
  private checkChain(event: SyncEventV0): string | null {
    if (event.hash === undefined && event.prevHash !== undefined) return "E_SYNC_CHAIN";

    const tail = this.sql
      .exec(
        "SELECT seq FROM events WHERE session_id = ? AND device_id = ? ORDER BY seq DESC LIMIT 1",
        event.sessionId,
        event.deviceId,
      )
      .toArray()[0];
    if (tail !== undefined && event.seq <= Number(tail.seq)) return "E_SYNC_SEQ";

    if (event.hash !== undefined) {
      const chained = this.sql
        .exec(
          "SELECT hash FROM events WHERE session_id = ? AND device_id = ? AND hash IS NOT NULL ORDER BY seq DESC LIMIT 1",
          event.sessionId,
          event.deviceId,
        )
        .toArray()[0];
      const lastChainedHash = chained !== undefined ? (chained.hash as string) : null;
      if (lastChainedHash === null) {
        if (event.prevHash !== undefined) return "E_SYNC_CHAIN";
      } else if (event.prevHash !== lastChainedHash) {
        return "E_SYNC_CHAIN";
      }
    }
    return null;
  }

  private eventIdExists(eventId: string): boolean {
    return this.sql.exec("SELECT 1 FROM events WHERE event_id = ? LIMIT 1", eventId).toArray().length > 0;
  }

  private insertEvent(event: SyncEventV0): void {
    this.sql.exec(
      "INSERT INTO events (event_id, session_id, type, lamport, device_id, seq, ts, payload, prev_hash, hash, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      event.eventId,
      event.sessionId,
      event.type,
      event.lamport,
      event.deviceId,
      event.seq,
      event.ts,
      JSON.stringify(event.payload),
      event.prevHash ?? null,
      event.hash ?? null,
      new Date().toISOString(),
    );
  }

  private fetchEvents(url: URL): Response {
    const sinceRaw = url.searchParams.get("since") ?? "0";
    if (!/^\d+$/u.test(sinceRaw)) return json({ code: "E_SYNC_CURSOR" }, 400);
    const since = Number(sinceRaw);
    if (!Number.isSafeInteger(since)) return json({ code: "E_SYNC_CURSOR" }, 400);
    const limitRaw = url.searchParams.get("limit");
    const parsedLimit = limitRaw === null ? 200 : Number.parseInt(limitRaw, 10);
    const limit = Math.min(Math.max(Number.isFinite(parsedLimit) ? parsedLimit : 200, 1), 1000);
    const sessionId = url.searchParams.get("sessionId");
    const rows = (
      sessionId === null
        ? this.sql.exec(`SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? ORDER BY id LIMIT ?`, since, limit + 1)
        : this.sql.exec(
            `SELECT ${EVENT_COLUMNS} FROM events WHERE id > ? AND session_id = ? ORDER BY id LIMIT ?`,
            since,
            sessionId,
            limit + 1,
          )
    ).toArray() as unknown as EventRow[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const cursor = page.length > 0 ? page[page.length - 1].id : since;
    return json({ events: page.map(eventJson), cursor: String(cursor), hasMore });
  }

  private clone(url: URL): Response {
    const sessionId = url.searchParams.get("sessionId");
    const cursor = this.currentCursor();
    const rows = (
      sessionId === null
        ? this.sql.exec(`SELECT ${EVENT_COLUMNS} FROM events WHERE id <= ? ORDER BY id`, cursor)
        : this.sql.exec(`SELECT ${EVENT_COLUMNS} FROM events WHERE id <= ? AND session_id = ? ORDER BY id`, cursor, sessionId)
    ).toArray() as unknown as EventRow[];
    const body = rows.map((row) => JSON.stringify(eventJson(row))).join("\n");
    return new Response(rows.length > 0 ? `${body}\n` : "", {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "X-Sync-Cursor": String(cursor) },
    });
  }

  private currentCursor(): number {
    const row = this.sql.exec("SELECT COALESCE(MAX(id), 0) AS cursor FROM events").toArray()[0];
    return row !== undefined ? Number(row.cursor) : 0;
  }

  private countActiveDevices(): number {
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM devices WHERE revoked_at IS NULL").toArray()[0];
    return row !== undefined ? Number(row.n) : 0;
  }

  // ── 生成闭环（push 触发 → DO alarm 处理 / 重试） ──

  private async triggerDialog(events: SyncEventV0[]): Promise<void> {
    if (!generationEnabled(this.env)) return;
    const sessions = new Set<string>();
    for (const event of events) {
      if (event.type === "turn_rewind") {
        sessions.add(event.sessionId);
        continue;
      }
      if (event.type === "message.append" && isRecord(event.payload) && event.payload.role === "user") {
        sessions.add(event.sessionId);
      }
    }
    if (sessions.size === 0) return;
    const now = Date.now();
    for (const sessionId of sessions) {
      this.sql.exec(
        "INSERT OR IGNORE INTO dialog_pending (session_id, enqueued_at, attempts, next_attempt_at) VALUES (?, ?, 0, ?)",
        sessionId,
        new Date(now).toISOString(),
        now,
      );
    }
    await this.scheduleAlarm(now);
  }

  private async scheduleAlarm(when: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }

  async alarm(): Promise<void> {
    const due = this.sql
      .exec(
        "SELECT session_id, attempts FROM dialog_pending WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 5",
        Date.now(),
      )
      .toArray();
    for (const row of due) {
      const sessionId = row.session_id as string;
      const attempts = Number(row.attempts);
      let result: "done" | "retry";
      try {
        result = await this.processSession(sessionId);
      } catch (error) {
        console.warn(`生成处理异常 session=${sessionId}`, error instanceof Error ? error.message : String(error));
        result = "retry";
      }
      if (result === "done") {
        this.sql.exec("DELETE FROM dialog_pending WHERE session_id = ?", sessionId);
        continue;
      }
      const maxAttempts = intEnv(this.env.CLOUD_DIALOG_MAX_ATTEMPTS, 3);
      if (attempts + 1 >= maxAttempts) {
        this.sql.exec("DELETE FROM dialog_pending WHERE session_id = ?", sessionId);
        console.warn(`生成重试耗尽 session=${sessionId} attempts=${attempts + 1}`);
        continue;
      }
      const delay = intEnv(this.env.CLOUD_DIALOG_RETRY_BASE_MS, 1000) * 2 ** (attempts + 1);
      this.sql.exec(
        "UPDATE dialog_pending SET attempts = ?, next_attempt_at = ? WHERE session_id = ?",
        attempts + 1,
        Date.now() + delay,
        sessionId,
      );
    }
    const next = this.sql.exec("SELECT MIN(next_attempt_at) AS next FROM dialog_pending").toArray()[0];
    const nextAt = next !== undefined && next.next !== null ? Number(next.next) : null;
    if (nextAt !== null) await this.ctx.storage.setAlarm(Math.max(nextAt, Date.now() + 250));
  }

  /** 处理一个会话的待生成回复；"done" = 完成/无需处理，"retry" = 交给 alarm 退避重试。 */
  private async processSession(sessionId: string): Promise<"done" | "retry"> {
    const events = this.loadSessionEvents(sessionId);
    if (events.length === 0) return "done";
    const branch = replayBranch(events);
    if (branch.length === 0 || branch[branch.length - 1].role !== "user") return "done";
    const pendingMessage = branch[branch.length - 1];
    if (pendingMessage.text.trim().length === 0) return "done";

    // 幂等：assistant eventId = gen-<sha256(sessionId:锚点事件id)[..32]>（与 .NET DialogLoop 一致）
    const assistantEventId = `gen-${(await sha256Hex(`${sessionId}:${pendingMessage.anchorEventId}`)).slice(0, 32)}`;
    if (this.eventIdExists(assistantEventId)) return "done";

    const context: ChatMessage[] = branch.map((message) => ({ role: message.role, content: message.text }));
    const systemPrompt = this.env.CLOUD_LLM_SYSTEM_PROMPT;
    if (systemPrompt !== undefined && systemPrompt.length > 0) context.unshift({ role: "system", content: systemPrompt });
    trimContext(context, intEnv(this.env.CLOUD_LLM_CONTEXT_CHARS, 24000));

    let completion: string;
    try {
      completion = await this.complete(context);
    } catch (error) {
      if (error instanceof ModelConfigError) {
        console.warn(`模型配置不可用（不重试）session=${sessionId} status=${error.message}`);
        return "done";
      }
      console.warn(`模型调用失败 session=${sessionId}`, error instanceof Error ? error.message : String(error));
      return "retry";
    }
    if (completion.trim().length === 0) return "done";

    // 水位从存储层聚合（任意设备最大 lamport / 服务端设备最大 seq；窗口化安全）
    const watermark = this.sessionWatermark(sessionId, SERVER_DEVICE_ID);
    const generated: SyncEventV0 = {
      eventId: assistantEventId,
      sessionId,
      type: "message.append",
      lamport: watermark.maxLamport + 1,
      deviceId: SERVER_DEVICE_ID,
      seq: watermark.maxSeq + 1,
      ts: new Date().toISOString(),
      payload: { role: "assistant", text: completion, turnId: pendingMessage.turnId },
    };
    try {
      this.ctx.storage.transactionSync(() => this.pushBatch([generated], null));
    } catch (error) {
      if (error instanceof BatchRejected) {
        // seq 与并发 push 竞争等：重试会重算水位；链错误理论上不出现（服务端事件无 hash）
        console.warn(
          `生成写回被拒 session=${sessionId} event=${assistantEventId} errors=${error.errors.map((item) => item.code).join(",")}`,
        );
        return "retry";
      }
      throw error;
    }
    return "done";
  }

  private loadSessionEvents(sessionId: string): SyncEventV0[] {
    const rows = this.sql
      .exec(`SELECT ${EVENT_COLUMNS} FROM events WHERE session_id = ? ORDER BY id`, sessionId)
      .toArray() as unknown as EventRow[];
    return rows
      .map(rowToEvent)
      .sort((a, b) => a.lamport - b.lamport || ordinalCompare(a.deviceId, b.deviceId) || a.seq - b.seq);
  }

  private sessionWatermark(sessionId: string, deviceId: string): { maxLamport: number; maxSeq: number } {
    const row = this.sql
      .exec(
        "SELECT COALESCE(MAX(lamport), 0) AS max_lamport, COALESCE(MAX(CASE WHEN device_id = ? THEN seq END), 0) AS max_seq FROM events WHERE session_id = ?",
        deviceId,
        sessionId,
      )
      .toArray()[0];
    return {
      maxLamport: row !== undefined ? Number(row.max_lamport) : 0,
      maxSeq: row !== undefined ? Number(row.max_seq) : 0,
    };
  }

  /** 模型调用：echo mock（测试部署）或 OpenAI 兼容 Chat Completions（与 .NET ModelClient 对齐）。 */
  private async complete(context: ChatMessage[]): Promise<string> {
    const mode = (this.env.CLOUD_LLM_MODE ?? "").trim().toLowerCase();
    if (mode === "echo") {
      const lastUser = [...context].reverse().find((item) => item.role === "user")?.content ?? "";
      return `回声：${lastUser}`;
    }
    const apiKey = (this.env.CLOUD_LLM_API_KEY ?? "").trim();
    const model = (this.env.CLOUD_LLM_MODEL ?? "").trim() || "gpt-4o-mini";
    const baseUrl = ((this.env.CLOUD_LLM_BASE_URL ?? "").trim() || "https://api.openai.com/v1").replace(/\/+$/u, "");
    const timeoutMs = intEnv(this.env.CLOUD_LLM_TIMEOUT_SECONDS, 60) * 1000;
    const maxTokens = intEnv(this.env.CLOUD_LLM_MAX_TOKENS, 1024);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: context.map((item) => ({ role: item.role, content: item.content })),
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      throw new ModelConfigError(String(response.status));
    }
    if (!response.ok) throw new Error(`model http ${response.status}`);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    console.log(
      `生成成功 model=${model} prompt_tokens=${data.usage?.prompt_tokens ?? "-"} completion_tokens=${data.usage?.completion_tokens ?? "-"} messages=${context.length}`,
    );
    return text;
  }

  // ── 初始化 ──

  private initialize(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      lamport INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT,
      hash TEXT,
      received_at TEXT NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_order ON events(session_id, lamport, device_id, seq)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_chain ON events(session_id, device_id, seq)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_by TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT NOT NULL,
      window INTEGER NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (key, window)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dialog_pending (
      session_id TEXT PRIMARY KEY,
      enqueued_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL
    )`);
  }
}

// ── 模块级辅助 ──

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function extractBearer(request: Request): string | null {
  const raw = request.headers.get("authorization");
  if (raw === null || !raw.toLowerCase().startsWith("bearer ")) return null;
  const token = raw.slice(7).trim();
  return token.length > 0 ? token : null;
}

function ordinalCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** eventId → 0 基物理行号（与 readSyncBatch 错误索引同一空间；首见生效）。 */
function buildLineByEventId(text: string): Map<string, number> {
  const map = new Map<string, number>();
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line === "") continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (isRecord(value) && typeof value.eventId === "string" && !map.has(value.eventId)) {
        map.set(value.eventId, index);
      }
    } catch {
      // 坏行由 readSyncBatch 统一报告
    }
  }
  return map;
}

/** 行 → 协议 v0 事件（prevHash / hash 缺省不输出，与 .NET WhenWritingNull 一致）。 */
function rowToEvent(row: EventRow): SyncEventV0 {
  const event: SyncEventV0 = {
    eventId: row.event_id,
    sessionId: row.session_id,
    type: row.type as SyncEventV0["type"],
    lamport: row.lamport,
    deviceId: row.device_id,
    seq: row.seq,
    ts: row.ts,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  };
  if (row.prev_hash !== null) event.prevHash = row.prev_hash;
  if (row.hash !== null) event.hash = row.hash;
  return event;
}

function eventJson(row: EventRow): Record<string, unknown> {
  return rowToEvent(row) as unknown as Record<string, unknown>;
}
