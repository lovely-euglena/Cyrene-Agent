import { afterEach, describe, expect, it, vi } from "vitest";
import { createAsrStream, createVadGate, VAD_GATE_DEFAULTS } from "./asr-dispatcher";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 20ms PCM 帧（16kHz/16bit/mono = 640 字节），首字节标记序号便于断言顺序 */
function frame(seq: number): Buffer {
  const buf = Buffer.alloc(640);
  buf[0] = seq & 0xff;
  return buf;
}

function stubMosslandFetch(text: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("createAsrStream", () => {
  it("routes a Mossland config to batch transcription behavior（说话后才上行）", async () => {
    const fetchMock = stubMosslandFetch("微信语音");
    const finals: string[] = [];
    const stream = createAsrStream(
      { engine: "mossland", apiKey: "moss-key" },
      () => {},
      (text) => finals.push(text),
    );

    await stream.start();
    stream.reportVad(true); // VAD：语音开始 → 冲 preRoll 并放行
    stream.sendAudio(Buffer.from([0, 0]));

    await expect(stream.stop()).resolves.toBe("微信语音");
    expect(finals).toEqual(["微信语音"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("静默期间（reportVad false）帧不上行，stop 不触发云端请求", async () => {
    const fetchMock = stubMosslandFetch("不应出现");
    const stream = createAsrStream(
      { engine: "mossland", apiKey: "moss-key" },
      () => {},
      () => {},
    );

    await stream.start();
    stream.reportVad(false); // VAD 在线但当前静默
    stream.sendAudio(Buffer.from([1, 2, 3]));
    stream.sendAudio(Buffer.from([4, 5, 6]));

    await expect(stream.stop()).resolves.toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("createVadGate（静默不上云 + preRoll + fail-open）", () => {
  it("静默帧只进缓冲；speechStart 按序冲掉 preRoll；speechEnd 关门", () => {
    const forwarded: Buffer[] = [];
    let at = 1_000;
    const gate = createVadGate((f) => forwarded.push(f), { now: () => at });

    for (let i = 0; i < 5; i++) {
      gate.push(frame(i));
      at += 20;
    }
    expect(forwarded).toHaveLength(0);

    gate.speechStart(); // 冲 preRoll（防吃字头）
    expect(forwarded.map((f) => f[0])).toEqual([0, 1, 2, 3, 4]);

    gate.push(frame(5));
    expect(forwarded).toHaveLength(6);

    gate.speechEnd(); // 静默开始：不再放行
    gate.push(frame(6));
    expect(forwarded).toHaveLength(6);

    gate.speechStart(); // 下一句：冲掉静默期攒下的 preRoll
    expect(forwarded.map((f) => f[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("preRoll 窗口超限裁旧（默认 320ms ≈ 16 帧）", () => {
    const forwarded: Buffer[] = [];
    let at = 0;
    const gate = createVadGate((f) => forwarded.push(f), { now: () => at });

    for (let i = 0; i < 30; i++) {
      gate.push(frame(i));
      at += 20;
    }
    gate.speechStart();
    const kept = Math.round(VAD_GATE_DEFAULTS.preRollMs * 32 / 640);
    expect(forwarded.map((f) => f[0])).toEqual(
      Array.from({ length: kept }, (_, i) => 30 - kept + i),
    );
  });

  it("一直收不到 VAD 事件 → 窗口后 fail-open 直通（含已缓冲帧）", () => {
    const forwarded: Buffer[] = [];
    let at = 0;
    const gate = createVadGate((f) => forwarded.push(f), { now: () => at, failOpenAfterMs: 1_000 });

    gate.push(frame(0)); // t=0：缓冲
    at = 500;
    gate.push(frame(1)); // t=500：仍缓冲
    expect(forwarded).toHaveLength(0);

    at = 1_000;
    gate.push(frame(2)); // 触发直通：冲缓冲 + 本帧
    expect(forwarded.map((f) => f[0])).toEqual([0, 1, 2]);

    at = 9_999;
    gate.push(frame(3));
    expect(forwarded).toHaveLength(4);
  });

  it("收到过 VAD 事件后不再 fail-open（用户长期沉默也不上云）", () => {
    const forwarded: Buffer[] = [];
    let at = 0;
    const gate = createVadGate((f) => forwarded.push(f), { now: () => at, failOpenAfterMs: 1_000 });

    gate.speechEnd(); // VAD 在线：当前静默
    at = 60_000;
    gate.push(frame(0));
    expect(forwarded).toHaveLength(0);
    expect(gate.isOpen()).toBe(false);
  });

  it("dispose 丢弃缓冲且不再放行（stop/挂断不留迟到音频）", () => {
    const forwarded: Buffer[] = [];
    const gate = createVadGate((f) => forwarded.push(f), { now: () => 0 });
    gate.push(frame(0));
    gate.dispose();
    gate.speechStart();
    expect(forwarded).toHaveLength(0);
    expect(gate.isOpen()).toBe(false);
  });
});
