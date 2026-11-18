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

/**
 * DeepSeek ASR（全家桶 API）：官方为一次性整段接口（≤120s/≤8MiB），
 * 引擎层做缓冲式会话适配（见 deepseek-voice-engine.ts）；VAD 门控照常生效。
 */
export interface DeepSeekAsrConfig {
  engine: "deepseek";
  apiKey: string;
}

export type AsrConfig = AliyunAsrConfig | MosslandAsrConfig | LocalAsrConfig | MiniMaxAsrConfig | DeepSeekAsrConfig;

let asrConfigGetter: (() => AsrConfig | null) | null = null;

export function setAsrConfig(getter: () => AsrConfig | null): void {
  asrConfigGetter = getter;
}

export function getAsrConfig(): AsrConfig | null {
  return asrConfigGetter?.() ?? null;
}
