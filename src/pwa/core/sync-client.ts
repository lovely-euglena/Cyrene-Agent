/**
 * 云端昔涟 PWA · cloud-server /v1 最小客户端（IKJK2L）。
 *
 * 同源相对路径（PWA 由 cloud-server 自己托管）；本地 dev 由 vite 代理到 127.0.0.1:7789。
 * 契约：docs/specs/2026-10-04-sync-protocol-v0.md + dotnet/cloud-server/README.md（HTTP 面）。
 * 拉到的事件逐条过 validateSyncEvent（服务端异常数据不进入本地缓存/重放）。
 */
import { validateSyncEvent, type SyncEventV0 } from "../../main/sync/sync-protocol";

export class SyncHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message?: string,
  ) {
    super(message ?? `HTTP ${status}${code ? ` (${code})` : ""}`);
    this.name = "SyncHttpError";
  }
}

export interface PairResult {
  deviceId: string;
  name: string;
  token: string;
}

export interface FetchPage {
  events: SyncEventV0[];
  cursor: number;
  hasMore: boolean;
  /** 被协议校验丢弃的事件数（正常服务端为 0）。 */
  dropped: number;
}

export interface PushResult {
  accepted: number;
  duplicates: number;
  cursor: number;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** cloud-server /v1 最小客户端。 */
export class SyncClient {
  constructor(
    private readonly baseUrl = "",
    private readonly fetchFn: FetchLike = (input, init) => globalThis.fetch(input, init),
  ) {}

  /** POST /v1/pair：配对码兑换 device token（token 仅此一次回显）。 */
  async pair(code: string, deviceName: string): Promise<PairResult> {
    const response = await this.request("POST", "/v1/pair", { body: { code, deviceName } });
    return {
      deviceId: String(response.deviceId ?? ""),
      name: String(response.name ?? ""),
      token: String(response.token ?? ""),
    };
  }

  /** GET /v1/sync/fetch：插入序增量（一页）。 */
  async fetchPage(token: string, since: number, limit = 200, sessionId?: string): Promise<FetchPage> {
    const query = new URLSearchParams({ since: String(since), limit: String(limit) });
    if (sessionId) query.set("sessionId", sessionId);
    const response = await this.request("GET", `/v1/sync/fetch?${query.toString()}`, { token });
    const raw = Array.isArray(response.events) ? response.events : [];
    const events: SyncEventV0[] = [];
    let dropped = 0;
    for (const item of raw) {
      if (validateSyncEvent(item) === null) {
        events.push(item as SyncEventV0);
      } else {
        dropped++;
      }
    }
    return {
      events,
      cursor: Number(response.cursor ?? since),
      hasMore: Boolean(response.hasMore),
      dropped,
    };
  }

  /** 循环分页拉到最新；onPage 供调用方增量落缓存。 */
  async fetchAll(
    token: string,
    since: number,
    onPage?: (page: FetchPage) => void,
  ): Promise<{ events: SyncEventV0[]; cursor: number; dropped: number }> {
    const events: SyncEventV0[] = [];
    let cursor = since;
    let dropped = 0;
    for (;;) {
      const page = await this.fetchPage(token, cursor);
      events.push(...page.events);
      dropped += page.dropped;
      cursor = page.cursor;
      onPage?.(page);
      if (!page.hasMore) break;
    }
    return { events, cursor, dropped };
  }

  /** POST /v1/sync/push：JSONL 事件批（整批原子）。 */
  async push(token: string, events: readonly SyncEventV0[]): Promise<PushResult> {
    const body = events.map((event) => JSON.stringify(event)).join("\n");
    const response = await this.request("POST", "/v1/sync/push", {
      token,
      rawBody: body,
      contentType: "application/x-ndjson; charset=utf-8",
    });
    return {
      accepted: Number(response.accepted ?? 0),
      duplicates: Number(response.duplicates ?? 0),
      cursor: Number(response.cursor ?? 0),
    };
  }

  private async request(
    method: string,
    path: string,
    options: { token?: string; body?: unknown; rawBody?: string; contentType?: string },
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {};
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    let body: string | undefined;
    if (options.rawBody !== undefined) {
      body = options.rawBody;
      headers["Content-Type"] = options.contentType ?? "application/json";
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers["Content-Type"] = "application/json";
    }
    const response = await this.fetchFn(this.baseUrl + path, { method, headers, body });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
    if (!response.ok) {
      const code = typeof parsed.code === "string" ? parsed.code : null;
      throw new SyncHttpError(response.status, code);
    }
    return parsed;
  }
}
