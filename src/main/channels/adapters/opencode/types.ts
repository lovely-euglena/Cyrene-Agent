// OpenCode 渠道协议面 —— 与 opencode serve HTTP API（OpenAPI /doc）对齐的请求/事件类型。
// 端点形态以 1.19.6 实测为准（#271）：POST /session、POST /session/{id}/message、GET /event（SSE）。
// 只声明本渠道消费的子集；字段缺失视为可选（opencode 版本演进不破坏本适配器）。

/** opencode 会话对象（POST /session 响应的投影子集）。 */
export interface OpencodeSessionInfo {
  id: string;
  title?: string;
  directory?: string;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
}

/** POST /session/{id}/message 请求体（投影子集）。 */
export interface OpencodeMessageRequest {
  providerID: string;
  modelID: string;
  parts: Array<{ type: "text"; text: string }>;
}

/** SSE /event 事件（投影子集——只关心消息增量与会话状态）。 */
export type OpencodeEvent =
  | { type: "message.part.updated"; properties: { sessionID: string; part: unknown } }
  | { type: "session.updated"; properties: { info: OpencodeSessionInfo } }
  | { type: "session.error"; properties: { sessionID: string; error?: unknown } }
  | { type: string; properties?: Record<string, unknown> };

/** opencode serve 进程配置。 */
export interface OpencodeServeConfig {
  /** opencode 可执行文件路径（缺省 PATH 查找）。 */
  binPath?: string;
  hostname?: string;
  /** 0 = 随机端口（推荐），由适配器从 serve 输出解析实际端口。 */
  port?: number;
  /** 生产必须设置（serve 未设密码时警告未加密）。 */
  serverPassword?: string;
  /** attach 复连：已有 server 时直接接，不 spawn。 */
  attachUrl?: string;
  /** LLM 供应商标识与模型（默认走 opencode 内置 mock 用于链路验证）。 */
  providerID?: string;
  modelID?: string;
}
