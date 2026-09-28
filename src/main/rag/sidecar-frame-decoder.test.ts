// sidecar 帧解码器回归测试。
//
// 重点锁死历史 P0：读取 4B 长度前缀后，若 JSON 头还没收齐，前缀
// 不能被消费（否则下一轮把 `{"id` 误读为长度，协议永久失步）。
import { describe, expect, it } from "vitest";
import {
  MAX_HEADER_BYTES,
  SidecarFrameDecoder,
  SidecarProtocolError,
} from "./sidecar-frame-decoder";

function encodeFrame(header: object, binary?: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  return Buffer.concat([prefix, json, binary ?? Buffer.alloc(0)]);
}

function bytesOf(buf: Buffer): Buffer[] {
  return Array.from(buf, (b) => Buffer.from([b]));
}

describe("SidecarFrameDecoder", () => {
  it("单 chunk 解码 header-only 帧（ready）", () => {
    const decoder = new SidecarFrameDecoder();
    const ready = { id: 0, op: "ready", modelKey: "bgem3", dim: 1024 };
    const frames = decoder.push(encodeFrame(ready));
    expect(frames).toHaveLength(1);
    expect(frames[0].header).toEqual(ready);
    expect(frames[0].binary).toBeNull();
  });

  it("单 chunk 解码带二进制段的响应帧", () => {
    const decoder = new SidecarFrameDecoder();
    const vectors = new Float32Array([1.5, -2.25, 3.125]);
    const frames = decoder.push(
      encodeFrame({ id: 7, ok: true, count: 1, dim: 3 }, Buffer.from(vectors.buffer)),
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].header).toMatchObject({ id: 7, ok: true, count: 1, dim: 3 });
    const binary = frames[0].binary!;
    const decoded = new Float32Array(
      binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.length),
    );
    expect(Array.from(decoded)).toEqual([1.5, -2.25, 3.125]);
  });

  it("单 chunk 内连续多帧按序解码", () => {
    const decoder = new SidecarFrameDecoder();
    const chunk = Buffer.concat([
      encodeFrame({ id: 1, ok: true, count: 0, dim: 1024 }),
      encodeFrame({ id: 2, ok: false, error: "boom" }),
      encodeFrame({ id: 3, ok: true, count: 2, dim: 1 }, Buffer.from(new Float32Array([9, 8]).buffer)),
    ]);
    const frames = decoder.push(chunk);
    expect(frames.map((f) => f.header.id)).toEqual([1, 2, 3]);
    expect(frames[1].header.error).toBe("boom");
    expect(frames[2].binary).not.toBeNull();
  });

  it("回归：前缀单独到达、头随后到达，不得误判长度（历史 P0）", () => {
    const decoder = new SidecarFrameDecoder();
    const frame = encodeFrame({ id: 11, ok: true, count: 1, dim: 1 }, Buffer.from(new Float32Array([42]).buffer));
    // 先只给 4 字节前缀
    const prefixOnly = frame.subarray(0, 4);
    expect(decoder.push(prefixOnly)).toEqual([]);
    // 再给剩余（头 + 二进制）
    const frames = decoder.push(frame.subarray(4));
    expect(frames).toHaveLength(1);
    expect(frames[0].header.id).toBe(11);
  });

  it("逐字节喂入（任意切分点）与整块喂入结果一致", () => {
    const raw = Buffer.concat([
      encodeFrame({ id: 0, op: "ready", modelKey: "bgem3", dim: 1024 }),
      encodeFrame({ id: 1, ok: true, count: 2, dim: 4 }, Buffer.from(new Float32Array(8).map((_, i) => i).buffer)),
      encodeFrame({ id: 2, ok: false, error: "nope" }),
    ]);

    const expected = new SidecarFrameDecoder().push(raw);
    expect(expected).toHaveLength(3);

    const decoder = new SidecarFrameDecoder();
    const frames = [];
    for (const b of bytesOf(raw)) {
      frames.push(...decoder.push(b));
    }
    expect(frames).toHaveLength(3);
    expect(frames.map((f) => f.header.id)).toEqual([0, 1, 2]);
    expect(frames[1].binary!.length).toBe(expected[1].binary!.length);
    expect(frames[1].binary!.equals(expected[1].binary!)).toBe(true);
  });

  it("二进制段跨 chunk 分片（mid-frame 状态保持）", () => {
    const decoder = new SidecarFrameDecoder();
    const payload = Buffer.from(new Float32Array([1, 2, 3, 4]).buffer);
    const frame = encodeFrame({ id: 5, ok: true, count: 4, dim: 1 }, payload);
    // 前缀+头+一半二进制
    const cut = 4 + Buffer.byteLength(JSON.stringify({ id: 5, ok: true, count: 4, dim: 1 })) + 8;
    expect(decoder.push(frame.subarray(0, cut))).toEqual([]);
    const frames = decoder.push(frame.subarray(cut));
    expect(frames).toHaveLength(1);
    expect(frames[0].binary!.length).toBe(16);
  });

  it("坏长度前缀抛 SidecarProtocolError", () => {
    const decoder = new SidecarFrameDecoder();
    // `{"id` 的前 4 字节被误读为长度 = 历史 bug 的特征值 1684611707
    const bad = Buffer.from('{"id', "utf8");
    expect(() => decoder.push(bad)).toThrow(SidecarProtocolError);
  });

  it("头超过上限抛 SidecarProtocolError", () => {
    const decoder = new SidecarFrameDecoder();
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(MAX_HEADER_BYTES + 1);
    expect(() => decoder.push(prefix)).toThrow(/bad frame length/);
  });

  it("头不是合法 JSON 时抛 SidecarProtocolError", () => {
    const decoder = new SidecarFrameDecoder();
    const payload = Buffer.from("not-json", "utf8");
    const prefix = Buffer.alloc(4);
    prefix.writeInt32LE(payload.length);
    expect(() => decoder.push(Buffer.concat([prefix, payload]))).toThrow(/not valid JSON/);
  });

  it("二进制段超上限抛 SidecarProtocolError", () => {
    const decoder = new SidecarFrameDecoder();
    const header = { id: 1, ok: true, count: 1, dim: 1 << 28 }; // count*dim*4 > 512MB
    expect(() => decoder.push(encodeFrame(header))).toThrow(/bad binary length/);
  });

  it("reset 清空未完成状态与缓冲", () => {
    const decoder = new SidecarFrameDecoder();
    const frame = encodeFrame({ id: 1, ok: true, count: 1, dim: 1 }, Buffer.from(new Float32Array([1]).buffer));
    expect(decoder.push(frame.subarray(0, 6))).toEqual([]);
    decoder.reset();
    // reset 后从头喂完整帧：不得把旧残留拼进来
    const frames = decoder.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].header.id).toBe(1);
  });
});
