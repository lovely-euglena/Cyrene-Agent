import type { AsrConfig } from "./asr-config";
import { resolveDotnetConfig } from "../dotnet-backend/config";
import { MosslandAsrStream } from "./mossland-asr-engine";
import { AliyunAsrStream } from "./aliyun-asr-engine";

export interface AsrStreamSession {
  start(): Promise<void>;
  sendAudio(frame: Buffer): void;
  stop(): void | Promise<string>;
}

// ── VAD 门控（G4.1，B9 隐私铁律：静默段不上云）──
// 包装 AsrStreamSession.sendAudio：local/hybrid 模式下音频帧先过
// cyrene-voice 的 Silero VAD，仅语音段转发引擎（300ms 前滚缓冲防吃字头）。
// voice host 不可用/cloud 模式 → 直通（行为同旧版，fail-open）。
interface VadGate {
  send(frame: Buffer): void;   // 原样转发或丢弃
  dispose(): void;
}

function createVadGate(inner: AsrStreamSession): VadGate {
  const mode = resolveDotnetConfig().vad;
  if (mode === "cloud") return { send: (f) => inner.sendAudio(f), dispose: () => undefined };

  let inSpeech = true;          // 起始放行（门控接管前不丢帧）
  let active = false;           // voice host 是否已确认接管
  const preRoll: Buffer[] = [];
  const PRE_ROLL_MAX = 10;      // ~320ms @ 32ms/帧

  void (async () => {
    try {
      const { voiceHostClient } = await import("../dotnet-backend/host-clients");
      if (!voiceHostClient.enabled() || !(await voiceHostClient.ensureStarted())) return;
      await voiceHostClient.vadConfig(mode, { preRollMs: 300 });
      // vad_result 事件流驱动状态机（合并回归修复：此前订阅丢失导致
      // active 后所有帧滞留 preRoll，ASR 引擎收不到任何音频）
      voiceHostClient.addEventListener((frame) => {
        if (frame.op !== "vad_result") return;
        active = true;
        if (frame.speechStart === true) {
          inSpeech = true;
          for (const b of preRoll.splice(0)) inner.sendAudio(b);
        } else if (frame.speechEnd === true) {
          inSpeech = false;
        }
      });
    } catch {
      // voice host 不可用：直通（fail-open，与 TS 原路一致）
    }
  })();

  return {
    send: (frame) => {
      if (!active || inSpeech) { inner.sendAudio(frame); return; }
      // 静默期：留前滚，丢其余（B9：静默不上云）
      preRoll.push(frame);
      if (preRoll.length > PRE_ROLL_MAX) preRoll.shift();
    },
    dispose: () => undefined,
  };
}

export function createAsrStream(
  config: AsrConfig,
  onPartial: (text: string) => void,
  onFinal: (text: string) => void,
): AsrStreamSession {
  if (config.engine === "mossland") {
    const moss = new MosslandAsrStream(config.apiKey, onFinal);
    const gate = createVadGate(moss);
    return {
      start: moss.start.bind(moss),
      sendAudio: (frame) => gate.send(frame),
      stop: moss.stop.bind(moss),
    };
  }

  // 默认引擎：阿里云（上游 2026-09-24 起，替换火山引擎）
  const stream = new AliyunAsrStream(onPartial, onFinal);
  const session: AsrStreamSession = {
    start: () => stream.start(
      config.appKey,
      config.accessKeyId,
      config.accessKeySecret,
      config.language,
    ),
    sendAudio: (frame) => stream.sendAudio(frame),
    stop: () => stream.stop(),
  };
  const gate = createVadGate(session);
  return {
    start: session.start,
    sendAudio: (frame) => gate.send(frame),
    stop: session.stop,
  };
}
