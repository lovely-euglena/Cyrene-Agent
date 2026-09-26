// native 设置窗「语音合成 TTS」「语音识别 ASR」section 的宿主侧重活：
// 试听合成 / MiniMax·Mossland 音色克隆 / Mossland 音色列表。
//
// 与渲染设置页同一批引擎函数（src/main/tts/*），不复制协议逻辑：
//   - 试听结果写系统临时目录，把路径交给 WPF（MediaPlayer 播放）
//   - 克隆 / 列表直接透传引擎结果，错误原样上抛（宿主动作层负责 notice）
//   - 本模块不依赖 electron（便于单测）；临时文件由 WPF 播完自行清理

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateMiniMaxVoiceId } from "../../shared/minimax-voice";
import { synthesize as customCloudSynthesize } from "../tts/custom-cloud-engine";
import { synthesize as gptsovitsSynthesize } from "../tts/gptsovits-engine";
import { synthesize as mimoSynthesize } from "../tts/mimo-engine";
import {
  cloneVoice as minimaxCloneVoice,
  synthesize as minimaxSynthesize,
  uploadFile as minimaxUploadFile,
} from "../tts/minimax-engine";
import {
  cloneVoice as mosslandCloneVoice,
  listVoices as mosslandListVoices,
  synthesize as mosslandSynthesize,
} from "../tts/mossland-engine";
import {
  appendCustomCloudTtsLog,
  appendGptsovitsTtsLog,
  appendMinimaxTtsLog,
  appendMimoTtsLog,
} from "../tts/tts-cache";

/** 旧页 TTS_TEST_TEXT：与渲染设置页同一句试听文本。 */
export const TTS_TEST_TEXT = "你好，我是昔涟，很高兴见到你。";

export interface NativeTtsTestResult {
  /** 试听音频临时文件（WPF MediaPlayer 播放） */
  filePath: string;
  format: string;
  cached: boolean;
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const required = (value: unknown, message: string): string => {
  const text = str(value);
  if (!text) throw new Error(message);
  return text;
};

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

function writeTempAudio(buffer: Buffer, format: string): string {
  const ext = format === "wav" ? "wav" : format === "pcm" ? "pcm" : "mp3";
  const filePath = path.join(os.tmpdir(), `cyrene-tts-test-${randomUUID()}.${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * 试听合成（native「测试发音」按钮）：按引擎复用渲染页同参数。
 * payload.engine ∈ minimax/gptsovits/custom-cloud/mimo/mossland；
 * 文本缺省用 TTS_TEST_TEXT（Mossland 旧页用「试听文本」字段，由 WPF 显式传）。
 */
export async function synthesizeNativeTest(payload: Record<string, unknown>): Promise<NativeTtsTestResult> {
  const engine = str(payload.engine);
  const text = str(payload.text) || TTS_TEST_TEXT;
  switch (engine) {
    case "minimax": {
      const apiKey = required(payload.apiKey, "请先填写 MiniMax API Key");
      const voiceId = required(payload.voiceId, "请先填写音色 ID（或下方复刻训练）");
      const model = str(payload.model) === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo";
      const buffer = await minimaxSynthesize({
        apiKey,
        voiceId,
        text,
        model,
        vocalEnhance: { enabled: payload.vocalEnhance !== false },
        debugLog: appendMinimaxTtsLog,
      });
      return { filePath: writeTempAudio(buffer, "mp3"), format: "mp3", cached: false };
    }
    case "gptsovits": {
      const baseUrl = required(payload.baseUrl, "请先填写 GPT-SoVITS API 地址");
      const refAudioPath = required(payload.refAudioPath, "请先选择参考音频文件");
      const promptText = required(payload.promptText, "请先填写参考音频对应的文本");
      const format = str(payload.format) === "mp3" ? "mp3" : "wav";
      const result = await gptsovitsSynthesize({
        baseUrl,
        refAudioPath,
        promptText,
        text,
        format,
        debugLog: appendGptsovitsTtsLog,
      });
      return { filePath: writeTempAudio(result.audio, result.format), format: result.format, cached: false };
    }
    case "custom-cloud": {
      const endpointUrl = required(payload.endpointUrl, "请先填写自定义云端 Endpoint URL");
      const format = str(payload.format) === "wav" ? "wav" : "mp3";
      const result = await customCloudSynthesize({
        endpointUrl,
        apiKey: str(payload.apiKey),
        voiceId: str(payload.voiceId),
        text,
        speed: optionalNumber(payload.speed),
        volume: optionalNumber(payload.volume),
        format,
        timeoutMs: optionalNumber(payload.timeoutMs),
        debugLog: appendCustomCloudTtsLog,
      });
      return { filePath: writeTempAudio(result.audio, result.format), format: result.format, cached: false };
    }
    case "mimo": {
      const apiKey = required(payload.apiKey, "请先填写小米 MiMo API Key");
      const voiceAudioPath = required(payload.voiceAudioPath, "请先选择昔涟克隆参考音频");
      const result = await mimoSynthesize({
        apiKey,
        voiceAudioPath,
        text,
        stylePrompt: str(payload.stylePrompt),
        debugLog: appendMimoTtsLog,
      });
      return { filePath: writeTempAudio(result.audio, result.format), format: result.format, cached: false };
    }
    case "mossland": {
      const apiKey = required(payload.apiKey, "请先填写 Mossland API Key");
      const voiceId = required(payload.voiceId, "请先填写音色 ID（可从下方拉取列表）");
      const result = await mosslandSynthesize({
        apiKey,
        voiceId,
        text,
        model: str(payload.model) || undefined,
        format: str(payload.format) === "wav" ? "wav" : "mp3",
      });
      return { filePath: writeTempAudio(result.audio, result.format), format: result.format, cached: false };
    }
    default:
      throw new Error("未知的 TTS 引擎");
  }
}

export interface NativeMinimaxCloneResult {
  voiceId: string;
  /** 试听音频临时文件（克隆接口返回 audioDemo 时下载；下载失败不返回） */
  demoFilePath?: string;
}

/**
 * MiniMax 音色快速复刻（旧页流程：上传配音文件 → 可选上传示例音频 → 训练）。
 * 与渲染页 validateMiniMaxVoiceId 同口径校验音色命名。
 */
export async function cloneNativeMinimaxVoice(payload: Record<string, unknown>): Promise<NativeMinimaxCloneResult> {
  const apiKey = required(payload.apiKey, "请先填写 MiniMax API Key");
  const filePath = required(payload.filePath, "请选择配音文件");
  const text = required(payload.text, "请填写复刻文本");
  const voiceId = required(payload.voiceId, "请填写音色命名");
  const voiceIdError = validateMiniMaxVoiceId(voiceId);
  if (voiceIdError) throw new Error(voiceIdError);

  const upload = await minimaxUploadFile(apiKey, filePath, "voice_clone");
  const promptFilePath = str(payload.promptFilePath);
  let promptAudioId: string | undefined;
  if (promptFilePath) {
    const promptUpload = await minimaxUploadFile(apiKey, promptFilePath, "prompt_audio");
    promptAudioId = promptUpload.file_id;
  }

  const result = await minimaxCloneVoice({
    apiKey,
    fileId: upload.file_id,
    voiceId,
    ...(promptAudioId ? { promptAudioId, promptText: str(payload.promptText) || undefined } : {}),
    text,
  });

  let demoFilePath: string | undefined;
  if (result.audioDemo) {
    try {
      const response = await fetch(result.audioDemo);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 0) demoFilePath = writeTempAudio(buffer, "mp3");
      }
    } catch { /* 试听音频下载失败不影响克隆结果 */ }
  }
  return { voiceId: result.voiceId, ...(demoFilePath ? { demoFilePath } : {}) };
}

export interface NativeMosslandCloneResult {
  voiceId: string;
  name?: string;
}

/** Mossland 音色克隆（multipart 上传参考音频 → 返回 voice_id）。 */
export async function cloneNativeMosslandVoice(payload: Record<string, unknown>): Promise<NativeMosslandCloneResult> {
  const apiKey = required(payload.apiKey, "请先填写 Mossland API Key");
  const filePath = required(payload.filePath, "请选择参考音频");
  const result = await mosslandCloneVoice({
    apiKey,
    filePath,
    name: str(payload.name) || undefined,
    description: str(payload.description) || undefined,
  });
  return { voiceId: result.voiceId, ...(result.name ? { name: result.name } : {}) };
}

export interface NativeMosslandVoiceInfo {
  id: string;
  name: string;
}

export interface NativeMosslandVoiceListResult {
  voices: NativeMosslandVoiceInfo[];
  hasMore: boolean;
}

/** 拉取 Mossland 账号下音色列表（旧页 limit 150）。 */
export async function listNativeMosslandVoices(
  payload: Record<string, unknown>,
): Promise<NativeMosslandVoiceListResult> {
  const apiKey = required(payload.apiKey, "请先填写 Mossland API Key");
  const limit = optionalNumber(payload.limit) ?? 150;
  const result = await mosslandListVoices({ apiKey, limit });
  return {
    voices: result.voices.map((voice) => ({ id: voice.id, name: voice.name })),
    hasMore: result.hasMore,
  };
}
