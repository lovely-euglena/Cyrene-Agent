/**
 * 云端同步 · HTTP 客户端（IKJK2I B 簇）。
 *
 * 契约：docs/design/2026-10-06-desktop-cloud-wiring.md §4.1 + dotnet/cloud-server/README.md。
 * 方法：pair / createPairCode / capabilities / push / fetch / clone。
 *
 * - 全局 fetch + AbortSignal.timeout（默认 30s；沿 runtime-policy external-http 口径）；
 * - fetchImpl 注入便于单测（不依赖真实网络）；
 * - push：JSONL 按序列化字节 ≤5 MiB 分块（低于服务端 10 MiB 上限），eventId 幂等可重试；
 * - clone：NDJSON 流式解析（无 body 流时退化为整体文本），游标取 X-Sync-Cursor 响应头；
 * - 错误统一 SyncHttpError{code,status,serverCode?}，文本剥离 token / baseUrl（脱敏）。
 */

import { compareSyncEvents, validateSyncEvent, type SyncEventV0 } from "./sync-protocol";

/** 请求超时（默认；沿 external-http 30s）。 */
export const SYNC_HTTP_TIMEOUT_MS = 30_000;
/** push 单批上限（序列化字节；服务端 10 MiB 上限的安全余量）。 */
export const SYNC_PUSH_MAX_BYTES = 5 * 1024 * 1024;
/** fetch 单页默认条数（服务端允许 1..1000）。 */
export const SYNC_FETCH_DEFAULT_LIMIT = 200;

export type SyncHttpErrorCode =
  | "invalid_config"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "batch_invalid"
  | "batch_rejected"
  | "cursor"
  | "not_found"
  | "http"
  | "timeout"
  | "aborted"
  | "network";

const DEFAULT_ERROR_MESSAGES: Record<SyncHttpErrorCode, string> = {
  invalid_config: "同步配置不完整",
  unauthorized: "未授权（token 无效或已撤销，请重新配对）",
  forbidden: "无权访问",
  rate_limited: "请求过于频繁",
  batch_invalid: "事件批格式非法",
  batch_rejected: "事件批被服务器拒绝",
  cursor: "同步游标无效",
  not_found: "资源不存在",
  http: "服务器返回错误",
  timeout: "请求超时",
  aborted: "请求已取消",
  network: "网络请求失败",
};

export class SyncHttpError extends Error {
  readonly code: SyncHttpErrorCode;
  readonly status: number;
  readonly serverCode?: string;

  constructor(code: SyncHttpErrorCode, status = 0, serverCode?: string, message?: string) {
    super(message ?? DEFAULT_ERROR_MESSAGES[code]);
    this.name = "SyncHttpError";
    this.code = code;
    this.status = status;
    if (serverCode) this.serverCode = serverCode;
  }
}

export type SyncFetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SyncHttpClientConfig {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** 外部中止信号（服务 stop / 退出）；与超时信号合并。 */
  signal?: AbortSignal;
  fetchImpl?: SyncFetchLike;
}

export interface SyncPairResult {
  deviceId: string;
  name: string;
  token: string;
}

export interface SyncPairCodeResult {
  code: string;
  /** ISO 时间（已归一化为毫秒精度）。 */
  expiresAt: string;
}

export interface SyncPushResult {
  accepted: number;
  duplicates: number;
  /** 服务端游标（不透明，客户端原样保存）。 */
  cursor: string;
}

export interface SyncFetchPage {
  events: SyncEventV0[];
  /** 下一页 since（原样回传）。 */
  cursor: string;
  hasMore: boolean;
  /** 协议校验丢弃的事件数（正常服务端为 0）。 */
  dropped: number;
}

export interface SyncCloneResult {
  events: SyncEventV0[];
  /** X-Sync-Cursor 快照上界；缺失时为 null（下轮重试 clone）。 */
  cursor: string | null;
  dropped: number;
}

export interface SyncHttpClient {
  /** POST /v1/pair：配对码兑换 device token（公开；token 仅此一次回显）。 */
  pair(code: string, deviceName: string): Promise<SyncPairResult>;
  /** POST /v1/pair/code：已配对设备生成一次性配对码（需鉴权）。 */
  createPairCode(): Promise<SyncPairCodeResult>;
  /** GET /v1/capabilities：能力声明（公开只读）。 */
  capabilities(): Promise<Record<string, unknown>>;
  /** POST /v1/sync/push：JSONL 事件批（内部按 ≤5 MiB 分块）。 */
  push(events: readonly SyncEventV0[]): Promise<SyncPushResult>;
  /** GET /v1/sync/fetch：插入序增量（一页）。 */
  fetch(since: string, options?: { sessionId?: string; limit?: number }): Promise<SyncFetchPage>;
  /** GET /v1/sync/clone：全量 JSONL 流（游标在 X-Sync-Cursor 响应头）。 */
  clone(options?: { sessionId?: string }): Promise<SyncCloneResult>;
}

/** .NET "O" 格式（7 位小数 + 时区偏移）→ 毫秒精度 ISO；解析失败返回空串。 */
export function normalizeDotNetExpiresAt(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(raw);
  if (match) {
    const ms = (match[2] ?? "").slice(0, 3).padEnd(3, "0");
    const zone = match[3] ?? "Z";
    const parsed = Date.parse(`${match[1]}.${ms}${zone}`);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  const fallback = Date.parse(raw);
  return Number.isFinite(fallback) ? new Date(fallback).toISOString() : "";
}

function isTimeoutError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (error as { name?: unknown }).name === "TimeoutError";
}

function mapStatusToCode(status: number, serverCode?: string): SyncHttpErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403 || status === 421) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (serverCode === "E_SYNC_BATCH_INVALID") return "batch_invalid";
  if (
    serverCode === "E_SYNC_BATCH_REJECTED"
    || serverCode === "E_SYNC_CHAIN"
    || serverCode === "E_SYNC_SEQ"
    || status === 413
  ) {
    return "batch_rejected";
  }
  if (serverCode && /CURSOR/i.test(serverCode)) return "cursor";
  if (status === 400 && serverCode === "E_PAIR_CODE") return "invalid_config";
  return "http";
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function cursorString(value: unknown, fallback: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function collectValidEvents(value: unknown): { events: SyncEventV0[]; dropped: number } {
  if (!Array.isArray(value)) return { events: [], dropped: 0 };
  const events: SyncEventV0[] = [];
  let dropped = 0;
  for (const item of value) {
    if (validateSyncEvent(item) === null) events.push(item as SyncEventV0);
    else dropped += 1;
  }
  return { events, dropped };
}

/** JSONL 行按序列化字节分块（批内以 "\n" 连接；单条超限独占一批）。 */
export function chunkJsonLines(lines: readonly string[], maxBytes: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, "utf8");
    const extra = current.length > 0 ? lineBytes + 1 : lineBytes;
    if (current.length > 0 && bytes + extra > maxBytes) {
      chunks.push(current);
      current = [line];
      bytes = lineBytes;
      continue;
    }
    current.push(line);
    bytes += extra;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

class SyncHttpClientImpl implements SyncHttpClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly signal: AbortSignal | undefined;
  private readonly fetchImpl: SyncFetchLike;

  constructor(config: SyncHttpClientConfig) {
    this.baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.token = config.token ?? "";
    this.timeoutMs = config.timeoutMs ?? SYNC_HTTP_TIMEOUT_MS;
    this.signal = config.signal;
    this.fetchImpl = config.fetchImpl
      ?? ((input, init) => globalThis.fetch(input, init));
  }

  async pair(code: string, deviceName: string): Promise<SyncPairResult> {
    this.assertBaseUrl();
    const response = await this.send("POST", "/v1/pair", { json: { code, deviceName } });
    const body = await this.readJson(response);
    const token = typeof body.token === "string" ? body.token : "";
    if (!token) throw new SyncHttpError("http", response.status, undefined, "服务器未返回 token");
    return {
      deviceId: typeof body.deviceId === "string" ? body.deviceId : "",
      name: typeof body.name === "string" ? body.name : "",
      token,
    };
  }

  async createPairCode(): Promise<SyncPairCodeResult> {
    this.assertConfigured();
    const response = await this.send("POST", "/v1/pair/code", { auth: true });
    const body = await this.readJson(response);
    return {
      code: typeof body.code === "string" ? body.code : "",
      expiresAt: normalizeDotNetExpiresAt(body.expiresAt),
    };
  }

  async capabilities(): Promise<Record<string, unknown>> {
    this.assertBaseUrl();
    const response = await this.send("GET", "/v1/capabilities", {});
    return await this.readJson(response);
  }

  async push(events: readonly SyncEventV0[]): Promise<SyncPushResult> {
    if (events.length === 0) return { accepted: 0, duplicates: 0, cursor: "" };
    this.assertConfigured();
    const chunks = chunkJsonLines(events.map((event) => JSON.stringify(event)), SYNC_PUSH_MAX_BYTES);
    let accepted = 0;
    let duplicates = 0;
    let cursor = "";
    for (const chunk of chunks) {
      const response = await this.send("POST", "/v1/sync/push", {
        auth: true,
        rawBody: chunk.join("\n"),
        contentType: "application/x-ndjson; charset=utf-8",
      });
      const body = await this.readJson(response);
      accepted += toNonNegativeInt(body.accepted);
      duplicates += toNonNegativeInt(body.duplicates);
      cursor = cursorString(body.cursor, cursor);
    }
    return { accepted, duplicates, cursor };
  }

  async fetch(since: string, options: { sessionId?: string; limit?: number } = {}): Promise<SyncFetchPage> {
    this.assertConfigured();
    const query = new URLSearchParams();
    if (since) query.set("since", since);
    query.set("limit", String(options.limit ?? SYNC_FETCH_DEFAULT_LIMIT));
    if (options.sessionId) query.set("sessionId", options.sessionId);
    const response = await this.send("GET", `/v1/sync/fetch?${query.toString()}`, { auth: true });
    const body = await this.readJson(response);
    const { events, dropped } = collectValidEvents(body.events);
    return {
      events,
      cursor: cursorString(body.cursor, since),
      hasMore: body.hasMore === true,
      dropped,
    };
  }

  async clone(options: { sessionId?: string } = {}): Promise<SyncCloneResult> {
    this.assertConfigured();
    const query = new URLSearchParams();
    if (options.sessionId) query.set("sessionId", options.sessionId);
    const path = query.toString() ? `/v1/sync/clone?${query.toString()}` : "/v1/sync/clone";
    const response = await this.send("GET", path, { auth: true });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw this.httpError(response.status, parseJsonObject(text));
    }
    const header = response.headers?.get?.("X-Sync-Cursor") ?? null;
    const cursor = header && header.length > 0 ? header : null;
    const parsed = await this.readEventStream(response);
    parsed.events.sort(compareSyncEvents);
    return { events: parsed.events, cursor, dropped: parsed.dropped };
  }

  // ── 内部：请求 / 错误 / 流解析 ────────────────────────────────────────────

  private assertBaseUrl(): void {
    if (!this.baseUrl) throw new SyncHttpError("invalid_config", 0, undefined, "缺少服务器地址");
  }

  private assertConfigured(): void {
    this.assertBaseUrl();
    if (!this.token) throw new SyncHttpError("invalid_config", 0, undefined, "缺少访问 token");
  }

  private async send(
    method: string,
    path: string,
    options: { auth?: boolean; json?: unknown; rawBody?: string; contentType?: string },
  ): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.auth) headers.Authorization = `Bearer ${this.token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers["Content-Type"] = options.contentType ?? "application/x-ndjson; charset=utf-8";
    } else if (options.json !== undefined) {
      body = JSON.stringify(options.json);
      headers["Content-Type"] = "application/json";
    }
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = this.signal ? AbortSignal.any([timeoutSignal, this.signal]) : timeoutSignal;
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal,
      });
    } catch (error) {
      if (this.signal?.aborted) throw new SyncHttpError("aborted", 0, undefined, DEFAULT_ERROR_MESSAGES.aborted);
      if (isTimeoutError(error) || timeoutSignal.aborted) {
        throw new SyncHttpError("timeout", 0, undefined, DEFAULT_ERROR_MESSAGES.timeout);
      }
      throw new SyncHttpError("network", 0, undefined, DEFAULT_ERROR_MESSAGES.network);
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text().catch(() => "");
    const body = parseJsonObject(text);
    if (!response.ok) throw this.httpError(response.status, body);
    return body;
  }

  /** 错误构造：文本脱敏（剥离 token / baseUrl），不含请求 URL。 */
  private httpError(status: number, body: Record<string, unknown>): SyncHttpError {
    const serverCode = typeof body.code === "string" ? body.code : undefined;
    const serverMessage = typeof body.error === "string"
      ? body.error
      : typeof body.message === "string"
        ? body.message
        : "";
    const safe = this.sanitize(serverMessage);
    const message = `HTTP ${status}${serverCode ? ` (${serverCode})` : ""}${safe ? `: ${safe}` : ""}`;
    return new SyncHttpError(mapStatusToCode(status, serverCode), status, serverCode, message);
  }

  private sanitize(text: string): string {
    let out = text.trim().slice(0, 300);
    if (!out) return "";
    if (this.token) out = out.split(this.token).join("***");
    if (this.baseUrl) out = out.split(this.baseUrl).join("<server>");
    return out;
  }

  /** NDJSON 流式解析：逐行 JSON + 协议校验；坏行计入 dropped。 */
  private async readEventStream(response: Response): Promise<{ events: SyncEventV0[]; dropped: number }> {
    const events: SyncEventV0[] = [];
    let dropped = 0;
    const pushLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let value: unknown;
      try {
        value = JSON.parse(trimmed);
      } catch {
        dropped += 1;
        return;
      }
      if (validateSyncEvent(value) === null) events.push(value as SyncEventV0);
      else dropped += 1;
    };

    const reader = response.body?.getReader?.();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) pushLine(line);
      }
      buffer += decoder.decode();
      pushLine(buffer);
      return { events, dropped };
    }
    // 测试桩 / 无 body 流：退化为整体文本解析
    const text = await response.text().catch(() => "");
    for (const line of text.split("\n")) pushLine(line);
    return { events, dropped };
  }
}

export function createSyncHttpClient(config: SyncHttpClientConfig): SyncHttpClient {
  return new SyncHttpClientImpl(config);
}
