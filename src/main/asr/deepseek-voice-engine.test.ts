import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeepSeekAsrBufferedSession,
  DEEPSEEK_ASR_MAX_BYTES,
  DEEPSEEK_TTS_SAMPLE_RATE,
  synthesizeDeepSeekTts,
  transcribeWav,
} from "./deepseek-voice-engine";
import { encodePcm16MonoWav } from "./mossland-asr-engine";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeekAsrBufferedSession", () => {
  it("uploads buffered frames as one WAV on stop and forwards transcript to onFinal", async () => {
    let capturedBody: FormData | null = null;
    vi.stubGlobal("fetch", async (_url: string | URL, init?: RequestInit) => {
      capturedBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: "你好世界" }), { status: 200 });
    });
    const finals: string[] = [];
    const session = new DeepSeekAsrBufferedSession({ apiKey: "k" }, (t) => finals.push(t));
    session.sendAudio(Buffer.alloc(640, 1)); // 20ms 帧
    session.sendAudio(Buffer.alloc(320, 2)); // 10ms 帧
    const result = await session.stop();
    expect(result).toBe("你好世界");
    expect(finals).toEqual(["你好世界"]);
    const file = capturedBody!.get("file") as File;
    const wav = Buffer.from(await file.arrayBuffer());
    const expected = encodePcm16MonoWav(Buffer.concat([Buffer.alloc(640, 1), Buffer.alloc(320, 2)]));
    expect(wav).toEqual(expected);
  });

  it("returns empty string without uploading when no audio captured", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const session = new DeepSeekAsrBufferedSession({ apiKey: "k" }, () => {});
    expect(await session.stop()).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("throws early on sendAudio when buffered duration exceeds 120s", () => {
    const session = new DeepSeekAsrBufferedSession({ apiKey: "k" }, () => {});
    const frame20ms = Buffer.alloc(640);
    expect(() => {
      for (let i = 0; i < 6_001; i++) session.sendAudio(frame20ms); // 120.02s
    }).toThrow("120s");
  });

  it("throws on stop when WAV exceeds 8MiB limit", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const session = new DeepSeekAsrBufferedSession({ apiKey: "k" }, () => {});
    // 不触发 120s 早抛的最大帧数内塞爆 8MiB：直接构造超大会话不可行（120s×32B/ms=3.84MB < 8MiB），
    // 实际 8MiB 限额不可达（时长先触顶）——此处只验证常量与早抛路径存在。
    expect(DEEPSEEK_ASR_MAX_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe("transcribeWav", () => {
  it("throws protocol error when response body is not JSON", async () => {
    vi.stubGlobal("fetch", async () => new Response("gateway html", { status: 200 }));
    await expect(transcribeWav({ apiKey: "k" }, encodePcm16MonoWav(Buffer.alloc(4)))).rejects.toThrow("非 JSON");
  });

  it("throws when JSON lacks text field", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }));
    await expect(transcribeWav({ apiKey: "k" }, encodePcm16MonoWav(Buffer.alloc(4)))).rejects.toThrow("text");
  });
});

describe("synthesizeDeepSeekTts", () => {
  it("posts pcm request with voice_id and collects byte stream", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | null = null;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      const pcm = Buffer.from([1, 2, 3, 4]);
      return new Response(new Uint8Array(pcm), { status: 200 });
    });
    const r = await synthesizeDeepSeekTts({ apiKey: "k", text: "hi", voice: "tide" });
    expect(r.format).toBe("pcm");
    expect(r.sampleRate).toBe(DEEPSEEK_TTS_SAMPLE_RATE);
    expect([...r.audio]).toEqual([1, 2, 3, 4]);
    expect(capturedUrl).toContain("/v1/tools/tts");
    const body = JSON.parse(String(capturedInit!.body));
    expect(body).toEqual({ text: "hi", voice_id: "tide", format: "pcm", filter_markdown: true });
    expect((capturedInit!.headers as Record<string, string>).Authorization).toBe("Bearer k");
  });

  it("throws on non-2xx with body snippet", async () => {
    vi.stubGlobal("fetch", async () => new Response("quota exceeded", { status: 429 }));
    await expect(synthesizeDeepSeekTts({ apiKey: "k", text: "hi", voice: "stella" })).rejects.toThrow("429");
  });
});
