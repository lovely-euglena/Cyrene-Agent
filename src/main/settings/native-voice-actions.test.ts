// 宿主侧语音动作测试：试听合成的参数映射与临时文件、克隆流程的参数校验与结果投影。

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";

const mocks = vi.hoisted(() => ({
  minimaxSynthesize: vi.fn(),
  minimaxUploadFile: vi.fn(),
  minimaxCloneVoice: vi.fn(),
  gptsovitsSynthesize: vi.fn(),
  customCloudSynthesize: vi.fn(),
  mimoSynthesize: vi.fn(),
  mosslandSynthesize: vi.fn(),
  mosslandCloneVoice: vi.fn(),
  mosslandListVoices: vi.fn(),
}));

vi.mock("../tts/minimax-engine", () => ({
  synthesize: mocks.minimaxSynthesize,
  uploadFile: mocks.minimaxUploadFile,
  cloneVoice: mocks.minimaxCloneVoice,
}));
vi.mock("../tts/gptsovits-engine", () => ({ synthesize: mocks.gptsovitsSynthesize }));
vi.mock("../tts/custom-cloud-engine", () => ({ synthesize: mocks.customCloudSynthesize }));
vi.mock("../tts/mimo-engine", () => ({ synthesize: mocks.mimoSynthesize }));
vi.mock("../tts/mossland-engine", () => ({
  synthesize: mocks.mosslandSynthesize,
  cloneVoice: mocks.mosslandCloneVoice,
  listVoices: mocks.mosslandListVoices,
}));
vi.mock("../tts/tts-cache", () => ({
  appendCustomCloudTtsLog: vi.fn(),
  appendGptsovitsTtsLog: vi.fn(),
  appendMinimaxTtsLog: vi.fn(),
  appendMimoTtsLog: vi.fn(),
}));

import {
  cloneNativeMinimaxVoice,
  cloneNativeMosslandVoice,
  listNativeMosslandVoices,
  synthesizeNativeTest,
} from "./native-voice-actions";

beforeEach(() => {
  vi.restoreAllMocks();
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("synthesizeNativeTest", () => {
  it("minimax：参数映射（vocalEnhance / model 归一）+ 写临时 mp3", async () => {
    mocks.minimaxSynthesize.mockResolvedValue(Buffer.from("mp3-bytes"));
    const result = await synthesizeNativeTest({
      engine: "minimax",
      apiKey: "k",
      voiceId: "v",
      model: "bogus-model",
      vocalEnhance: false,
      text: "你好",
    });
    expect(mocks.minimaxSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "k",
      voiceId: "v",
      text: "你好",
      model: "speech-2.8-turbo",
      vocalEnhance: { enabled: false },
    }));
    expect(result.filePath).toContain("cyrene-tts-test-");
    expect(result.filePath.endsWith(".mp3")).toBe(true);
    expect(fs.readFileSync(result.filePath, "utf8")).toBe("mp3-bytes");
    fs.rmSync(result.filePath, { force: true });
  });

  it("缺必填 / 未知引擎：抛可展示的中文错误", async () => {
    await expect(synthesizeNativeTest({ engine: "minimax", text: "x" }))
      .rejects.toThrow("请先填写 MiniMax API Key");
    await expect(synthesizeNativeTest({ engine: "gptsovits" }))
      .rejects.toThrow("请先填写 GPT-SoVITS API 地址");
    await expect(synthesizeNativeTest({ engine: "bogus" }))
      .rejects.toThrow("未知的 TTS 引擎");
  });

  it("gptsovits / custom-cloud / mimo / mossland：透传字段与返回格式", async () => {
    mocks.gptsovitsSynthesize.mockResolvedValue({ audio: Buffer.from("wav"), format: "wav" });
    const gptsovits = await synthesizeNativeTest({
      engine: "gptsovits",
      baseUrl: "http://localhost:9880",
      refAudioPath: "a.wav",
      promptText: "你好",
      format: "wav",
    });
    expect(gptsovits.format).toBe("wav");
    expect(gptsovits.filePath.endsWith(".wav")).toBe(true);

    mocks.customCloudSynthesize.mockResolvedValue({ audio: Buffer.from("mp3"), format: "mp3" });
    const customCloud = await synthesizeNativeTest({
      engine: "custom-cloud",
      endpointUrl: "https://example.com/tts",
      apiKey: "sk",
      voiceId: "cyrene",
      speed: 1.2,
      volume: 0.8,
      format: "mp3",
      timeoutMs: 30000,
    });
    expect(mocks.customCloudSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl: "https://example.com/tts",
      apiKey: "sk",
      speed: 1.2,
      volume: 0.8,
      format: "mp3",
      timeoutMs: 30000,
    }));
    expect(customCloud.filePath.endsWith(".mp3")).toBe(true);

    mocks.mimoSynthesize.mockResolvedValue({ audio: Buffer.from("wav"), format: "wav" });
    const mimo = await synthesizeNativeTest({
      engine: "mimo",
      apiKey: "mimo-key",
      voiceAudioPath: "ref.wav",
      stylePrompt: "温柔",
    });
    expect(mimo.format).toBe("wav");

    mocks.mosslandSynthesize.mockResolvedValue({ audio: Buffer.from("mp3"), format: "mp3" });
    const mossland = await synthesizeNativeTest({
      engine: "mossland",
      apiKey: "moss-key",
      voiceId: "voice-id",
      text: "试听文本",
      model: "moss-tts-1.0-pro",
      format: "wav",
    });
    expect(mocks.mosslandSynthesize).toHaveBeenCalledWith(expect.objectContaining({
      model: "moss-tts-1.0-pro",
      format: "wav",
    }));
    expect(mossland.format).toBe("mp3"); // 引擎返回的实际格式为准

    for (const result of [gptsovits, customCloud, mimo, mossland]) {
      fs.rmSync(result.filePath, { force: true });
    }
  });
});

describe("cloneNativeMinimaxVoice", () => {
  it("上传配音文件 → 训练 → 返回 voiceId（无示例音频）", async () => {
    mocks.minimaxUploadFile.mockResolvedValue({ file_id: "file-1", bytes: 1, filename: "a.mp3", purpose: "voice_clone" });
    mocks.minimaxCloneVoice.mockResolvedValue({ voiceId: "cyrene-voice-x", raw: {} });
    const result = await cloneNativeMinimaxVoice({
      apiKey: "k",
      filePath: "D:/a.mp3",
      text: "你好",
      voiceId: "cyrene-voice-x",
    });
    expect(mocks.minimaxUploadFile).toHaveBeenCalledTimes(1);
    expect(mocks.minimaxCloneVoice).toHaveBeenCalledWith(expect.objectContaining({
      fileId: "file-1",
      voiceId: "cyrene-voice-x",
      text: "你好",
    }));
    expect(result).toEqual({ voiceId: "cyrene-voice-x" });
  });

  it("示例音频：上传 prompt_audio 并带 clone_prompt；非法 voiceId 抛错", async () => {
    mocks.minimaxUploadFile
      .mockResolvedValueOnce({ file_id: "file-1", bytes: 1, filename: "a.mp3", purpose: "voice_clone" })
      .mockResolvedValueOnce({ file_id: "file-2", bytes: 1, filename: "p.mp3", purpose: "prompt_audio" });
    mocks.minimaxCloneVoice.mockResolvedValue({ voiceId: "cyrene-voice-x", raw: {} });
    await cloneNativeMinimaxVoice({
      apiKey: "k",
      filePath: "D:/a.mp3",
      promptFilePath: "D:/p.mp3",
      promptText: "示例文本",
      text: "你好",
      voiceId: "cyrene-voice-x",
    });
    expect(mocks.minimaxCloneVoice).toHaveBeenCalledWith(expect.objectContaining({
      promptAudioId: "file-2",
      promptText: "示例文本",
    }));

    await expect(cloneNativeMinimaxVoice({
      apiKey: "k",
      filePath: "D:/a.mp3",
      text: "你好",
      voiceId: "1bad",
    })).rejects.toThrow("音色 ID");
  });

  it("audioDemo 下载成功 → 返回试听临时文件；下载失败不影响主流程", async () => {
    mocks.minimaxUploadFile.mockResolvedValue({ file_id: "file-1", bytes: 1, filename: "a.mp3", purpose: "voice_clone" });
    mocks.minimaxCloneVoice.mockResolvedValue({
      voiceId: "cyrene-voice-x",
      audioDemo: "https://example.com/demo.mp3",
      raw: {},
    });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("demo").buffer,
    })));
    const withDemo = await cloneNativeMinimaxVoice({
      apiKey: "k", filePath: "D:/a.mp3", text: "你好", voiceId: "cyrene-voice-x",
    });
    expect(withDemo.demoFilePath).toBeDefined();
    expect(fs.readFileSync(withDemo.demoFilePath as string, "utf8")).toBe("demo");
    fs.rmSync(withDemo.demoFilePath as string, { force: true });

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const withoutDemo = await cloneNativeMinimaxVoice({
      apiKey: "k", filePath: "D:/a.mp3", text: "你好", voiceId: "cyrene-voice-x",
    });
    expect(withoutDemo.demoFilePath).toBeUndefined();
  });
});

describe("cloneNativeMosslandVoice / listNativeMosslandVoices", () => {
  it("克隆透传 name/description，返回 voiceId", async () => {
    mocks.mosslandCloneVoice.mockResolvedValue({ voiceId: "3f1b", name: "昔涟" });
    const result = await cloneNativeMosslandVoice({
      apiKey: "moss-key",
      filePath: "D:/a.wav",
      name: "昔涟",
      description: "温柔",
    });
    expect(mocks.mosslandCloneVoice).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "moss-key",
      name: "昔涟",
      description: "温柔",
    }));
    expect(result).toEqual({ voiceId: "3f1b", name: "昔涟" });
  });

  it("音色列表：limit 缺省 150，投影 id/name + hasMore", async () => {
    mocks.mosslandListVoices.mockResolvedValue({
      voices: [{ id: "v1", name: "昔涟" }, { id: "v2", name: "备用" }],
      hasMore: true,
    });
    const result = await listNativeMosslandVoices({ apiKey: "moss-key" });
    expect(mocks.mosslandListVoices).toHaveBeenCalledWith({ apiKey: "moss-key", limit: 150 });
    expect(result).toEqual({
      voices: [{ id: "v1", name: "昔涟" }, { id: "v2", name: "备用" }],
      hasMore: true,
    });

    await expect(listNativeMosslandVoices({})).rejects.toThrow("请先填写 Mossland API Key");
  });
});
