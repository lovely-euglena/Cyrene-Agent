export interface AliyunAsrConfig {
  engine: "aliyun";
  appKey: string;
  accessKeyId: string;
  accessKeySecret: string;
  language: string;
}

export interface MosslandAsrConfig {
  engine: "mossland";
  apiKey: string;
}

/**
 * 本地 ASR：由语音输入插件（speech-input 租约）提供识别，内置 ASR 不启动。
 * 通话/聊天等待插件接管；模型、运行时、麦克风与窗口全由插件自行维护。
 */
export interface LocalAsrConfig {
  engine: "local";
}

export interface MiniMaxAsrConfig {
  engine: "minimax";
  apiKey: string;
}

export type AsrConfig = AliyunAsrConfig | MosslandAsrConfig | LocalAsrConfig | MiniMaxAsrConfig;

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
