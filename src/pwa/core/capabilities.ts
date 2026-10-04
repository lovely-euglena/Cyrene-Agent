/**
 * 服务端能力声明（IKJN78）：/v1/capabilities 的类型、解析与降级判断。
 *
 * 四形态（完整 / CF / PHP / Git）能力边界不同，客户端据此降级：
 * - generation: none → 不显示「等待回复」（服务端不会生成回复）；
 * - pwa: false → 不提示手机访问（桌面端形态用）。
 * 老服务端无该端点时按兼容默认（generation=realtime、pwa=true），保持既有行为不变。
 */

export type GenerationMode = "realtime" | "inline" | "none";

export interface ServerCapabilities {
  impl: string;
  protocol: string;
  sync: boolean;
  clone: boolean;
  cursor: "server" | "file-offset";
  generation: GenerationMode;
  pairing: string;
  pwa: boolean;
  maxBatchBytes: number;
}

export function defaultCapabilities(): ServerCapabilities {
  return {
    impl: "unknown",
    protocol: "v0",
    sync: true,
    clone: true,
    cursor: "server",
    generation: "realtime", // 兼容默认：无能力声明（老服务端）行为不变
    pairing: "device-token",
    pwa: true,
    maxBatchBytes: 10 * 1024 * 1024,
  };
}

const GENERATION_MODES: readonly GenerationMode[] = ["realtime", "inline", "none"];

/** 宽容解析：未知/缺失字段回退到兼容默认（解析失败、老服务端、字段扩展均安全）。 */
export function parseCapabilities(raw: unknown): ServerCapabilities {
  const base = defaultCapabilities();
  if (typeof raw !== "object" || raw === null) return base;
  const value = raw as Record<string, unknown>;
  return {
    impl: typeof value.impl === "string" && value.impl.length > 0 ? value.impl : base.impl,
    protocol: typeof value.protocol === "string" && value.protocol.length > 0 ? value.protocol : base.protocol,
    sync: typeof value.sync === "boolean" ? value.sync : base.sync,
    clone: typeof value.clone === "boolean" ? value.clone : base.clone,
    cursor: value.cursor === "file-offset" ? "file-offset" : "server",
    generation: GENERATION_MODES.includes(value.generation as GenerationMode)
      ? (value.generation as GenerationMode)
      : base.generation,
    pairing: typeof value.pairing === "string" && value.pairing.length > 0 ? value.pairing : base.pairing,
    pwa: typeof value.pwa === "boolean" ? value.pwa : base.pwa,
    maxBatchBytes:
      typeof value.maxBatchBytes === "number" && Number.isFinite(value.maxBatchBytes) && value.maxBatchBytes > 0
        ? value.maxBatchBytes
        : base.maxBatchBytes,
  };
}

/** 是否显示「等待回复」占位：generation=none 的服务端不会有回复，不应显示假象。 */
export function showPendingFor(capabilities: ServerCapabilities): boolean {
  return capabilities.generation !== "none";
}
