// DeepSeek 语音引擎（全家桶应用 API 2026-11-13，issue #253；demo speech.ts 官方形态）。
// - ASR：POST /v1/tools/asr，multipart 上传 WAV（mono 16-bit PCM）/Ogg Opus，
//   ≤120s / ≤8MiB，一次返回 {text}。官方无流式接口——本引擎做缓冲式会话：
//   sendAudio 只进缓冲（VAD 门控在外层 asr-dispatcher，静默段不进缓冲），
//   stop() 时 PCM→WAV 封头后整段上传。
// - TTS：POST /v1/tools/tts，JSON {text, voice_id, format:"pcm", filter_markdown}，
//   返回裸 PCM 字节流（24kHz/mono/16-bit LE）；产出首帧即 200。
//   服务端默认过滤代码块/表格/引用标记/长公式（filter_markdown:true）。
// 鉴权均 Authorization: Bearer。真网首测铁律：流式 TTS 帧节奏/限额需真网验证。

import { encodePcm16MonoWav } from "./mossland-asr-engine";

const DEFAULT_TOOLS_BASE_URL = "https://api.deepseek.com/v1/tools";

/** TTS 产出裸 PCM 参数：24kHz、单声道、16-bit 小端。 */
export const DEEPSEEK_TTS_SAMPLE_RATE = 24_000;

export type DeepSeekTtsVoice = "stella" | "tide";

export interface DeepSeekTtsOptions {
  apiKey: string;
  text: string;
  voice: DeepSeekTtsVoice;
  /** 缺省 true：服务端过滤代码块/表格/引用标记/长公式。 */
  filterMarkdown?: boolean;
  baseUrl?: string;
  timeoutMs?: number;
}

export interface DeepSeekTtsResult {
  audio: Buffer;
  format: "pcm";
  sampleRate: number;
}

const ASR_SAMPLE_RATE = 16_000; // Cyrene 通话采集帧率（32 B/ms），与 Mossland 编码器一致
/** ASR 限额：8 MiB（官方）。缓冲期间早抛，避免 stop 时白传。 */
export const DEEPSEEK_ASR_MAX_BYTES = 8 * 1024 * 1024;

async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** TTS 合成：收集完整 PCM 字节流后返回（首帧即 200 的服务端语义下仍等全量——dispatcher 侧负责播放节奏）。 */
export async function synthesizeDeepSeekTts(options: DeepSeekTtsOptions): Promise<DeepSeekTtsResult> {
  const base = options.baseUrl?.replace(/\/$/, "") ?? DEFAULT_TOOLS_BASE_URL;
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  try {
    const res = await fetch(`${base}/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        text: options.text,
        voice_id: options.voice,
        format: "pcm",
        filter_markdown: options.filterMarkdown ?? true,
      }),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`DeepSeek TTS HTTP ${res.status}: ${await readErrorBody(res)}`);
    const chunks: Buffer[] = [];
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return { audio: Buffer.concat(chunks), format: "pcm", sampleRate: DEEPSEEK_TTS_SAMPLE_RATE };
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** ASR 识别整段 WAV；官方为一次性接口（≤120s/≤8MiB），失败原样抛 HTTP 错误。 */
export async function transcribeWav(options: { apiKey: string; baseUrl?: string; timeoutMs?: number }, wav: Buffer): Promise<string> {
  const base = options.baseUrl?.replace(/\/$/, "") ?? DEFAULT_TOOLS_BASE_URL;
  const controller = new AbortController();
  const timer = options.timeoutMs ? setTimeout(() => controller.abort(), options.timeoutMs) : null;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "recording.wav");
    const res = await fetch(`${base}/asr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`DeepSeek ASR HTTP ${res.status}: ${await readErrorBody(res)}`);
    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`DeepSeek ASR 响应非 JSON: ${raw.slice(0, 120)}`);
    }
    const text = (parsed as { text?: unknown })?.text;
    if (typeof text !== "string") throw new Error("DeepSeek ASR 响应缺 text 字段");
    return text;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 缓冲式 ASR 会话：适配 Cyrene 流式 AsrStreamSession 接口与 DeepSeek 一次性接口。
 * sendAudio 仅入缓冲（累计时长/大小同步跟踪，超限即时抛错）；stop() 封 WAV 上传。
 */
export class DeepSeekAsrBufferedSession {
  private readonly frames: Buffer[] = [];
  private totalMs = 0;
  /** 120s 限额（官方）。缓冲期间早抛，与 8MiB 双保险。 */
  static readonly MAX_DURATION_MS = 120_000;

  constructor(
    private readonly options: { apiKey: string; baseUrl?: string; timeoutMs?: number },
    private readonly onFinal: (text: string) => void,
  ) {}

  sendAudio(frame: Buffer): void {
    this.frames.push(frame);
    this.totalMs += frame.length / 32; // 32 B/ms @16kHz/16bit/mono
    if (this.totalMs > DeepSeekAsrBufferedSession.MAX_DURATION_MS) {
      throw new Error("DeepSeek ASR 音频超过 120s 限额");
    }
  }

  /** 结束缓冲并上传识别；无有效音频时返回空串（不上传）。 */
  async stop(): Promise<string> {
    const pcm = Buffer.concat(this.frames);
    this.frames.length = 0;
    this.totalMs = 0;
    if (pcm.length === 0) return "";
    const wav = encodePcm16MonoWav(pcm);
    if (wav.length > DEEPSEEK_ASR_MAX_BYTES) {
      throw new Error(`DeepSeek ASR WAV 超过 ${DEEPSEEK_ASR_MAX_BYTES / 1024 / 1024}MiB 限额`);
    }
    const text = await transcribeWav(this.options, wav);
    this.onFinal(text);
    return text;
  }
}

/** 24kHz/16bit/mono PCM → WAV（TTS 试听用；ASR 走 mossland 16k 编码器）。 */
export function encodePcm24MonoWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = DEEPSEEK_TTS_SAMPLE_RATE * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(DEEPSEEK_TTS_SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
