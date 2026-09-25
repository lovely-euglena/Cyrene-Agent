import type { AsrConfig } from "./asr-config";
import { MosslandAsrStream } from "./mossland-asr-engine";
import { AliyunAsrStream } from "./aliyun-asr-engine";

export interface AsrStreamSession {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  /**
   * 外部 VAD 上报（渲染进程能量 VAD）：speech=true 语音开始 / false 静默开始。
   * 缺省不调用时门控按 fail-open 直通（见 createVadGate）。
   */
  reportVad(speech: boolean): void;
  stop(): void | Promise<string>;
}

// ── VAD 门控（B1 隐私铁律：静默段不上云） ───────────────────────────────
//
// 通话采集的是 16kHz/16bit/mono PCM（20ms/320 样本/640 字节一帧）。没有
// 门控时，用户没说话的环境音会持续上行到 ASR 云引擎。门控把未说话期间的
// 帧只放进 preRoll 环形缓冲（防吃字头），VAD 报 speechStart 才冲掉缓冲
// 并放行；speechEnd 立即关门。
//
// fail-open：若一直没有收到任何 VAD 事件（渲染端旧版/异常路径），窗口内
// 直通降级，保证 ASR 不会因为门控而收不到音频（历史 bug：所有帧滞留
// preRoll → 转写为空）。

const FRAME_BYTES_PER_MS = 16_000 * 2 / 1000; // 16kHz/16bit/mono = 32 B/ms

/** 门控参数（导出便于单测断言）。 */
export const VAD_GATE_DEFAULTS = {
  /** 语音开始前保留的音频（防吃字头） */
  preRollMs: 320,
  /** 一直收不到 VAD 事件时，超过该时长直通降级 */
  failOpenAfterMs: 1500,
} as const;

export interface VadGateOptions {
  preRollMs?: number;
  failOpenAfterMs?: number;
  /** 时钟注入（单测）；默认 Date.now */
  now?: () => number;
}

export interface VadGate {
  /** 送入一帧音频：说话中直通；静默时进 preRoll（超限裁旧） */
  push(frame: Buffer): void;
  /** VAD：语音开始（幂等；冲掉 preRoll 后开始放行） */
  speechStart(): void;
  /** VAD：静默开始（停止放行；preRoll 重新累积） */
  speechEnd(): void;
  /** 释放：丢弃缓冲（stop / 挂断时调用） */
  dispose(): void;
  /** 当前是否放行（诊断/测试） */
  isOpen(): boolean;
}

export function createVadGate(
  onFrame: (frame: Buffer) => void,
  options: VadGateOptions = {},
): VadGate {
  const preRollMs = options.preRollMs ?? VAD_GATE_DEFAULTS.preRollMs;
  const failOpenAfterMs = options.failOpenAfterMs ?? VAD_GATE_DEFAULTS.failOpenAfterMs;
  const now = options.now ?? (() => Date.now());
  const preRollBytes = Math.max(1, Math.round(preRollMs * FRAME_BYTES_PER_MS));

  const pending: Buffer[] = [];
  let pendingBytes = 0;
  let open = false;
  /** 是否收到过任何 VAD 事件：区分「VAD 缺失」与「用户沉默」——后者要一直门控 */
  let sawVad = false;
  /** 首帧时刻（-1 = 尚未收到帧；不能用 0 当哨兵——注入时钟可能从 0 起） */
  let firstFrameAt = -1;
  let disposed = false;

  const flushPending = (): void => {
    for (const frame of pending) onFrame(frame);
    pending.length = 0;
    pendingBytes = 0;
  };

  return {
    push(frame) {
      if (disposed || frame.length === 0) return;
      if (open) {
        onFrame(frame);
        return;
      }
      const at = now();
      if (firstFrameAt < 0) firstFrameAt = at;
      // VAD 事件缺失：窗口内没等到任何事件 → 直通降级（保住 ASR 可用性）
      if (!sawVad && at - firstFrameAt >= failOpenAfterMs) {
        console.warn("[ASR VAD] 未收到 VAD 事件，门控降级为直通（静默段不再过滤）");
        open = true;
        flushPending();
        onFrame(frame);
        return;
      }
      pending.push(frame);
      pendingBytes += frame.length;
      while (pendingBytes > preRollBytes && pending.length > 0) {
        pendingBytes -= pending[0].length;
        pending.shift();
      }
    },
    speechStart() {
      if (disposed) return;
      sawVad = true;
      if (open) return;
      open = true;
      flushPending(); // 冲掉 preRoll：防吃字头
    },
    speechEnd() {
      if (disposed) return;
      sawVad = true;
      open = false;
    },
    dispose() {
      disposed = true;
      open = false;
      pending.length = 0;
      pendingBytes = 0;
    },
    isOpen: () => open,
  };
}

/** 把引擎会话包一层 VAD 门控（静默段不上云；VAD 缺失时 fail-open 直通）。 */
function withVadGate(engine: {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  stop(): void | Promise<string>;
}): AsrStreamSession {
  const gate = createVadGate((frame) => engine.sendAudio(frame));
  return {
    start: () => engine.start(),
    sendAudio: (frame) => gate.push(frame),
    reportVad: (speech) => (speech ? gate.speechStart() : gate.speechEnd()),
    stop: () => {
      // 未上行的 preRoll 直接丢弃：挂断/换轮后不残留迟到音频
      gate.dispose();
      return engine.stop();
    },
  };
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
): AsrStreamSession {
  if (config.engine === "mossland") {
    return withVadGate(new MosslandAsrStream(config.apiKey, onFinal));
  }

  // 阿里云流式会话的 start 需要 4 个凭据参数，这里适配成统一的无参 start
  const aliyun = new AliyunAsrStream(onPartial, onFinal);
  return withVadGate({
    start: () => aliyun.start(config.appKey, config.accessKeyId, config.accessKeySecret, config.language),
    sendAudio: (frame) => aliyun.sendAudio(frame),
    stop: () => aliyun.stop(),
  });
}
