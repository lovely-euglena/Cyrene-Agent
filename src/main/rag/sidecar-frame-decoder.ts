// sidecar 帧协议解码器（纯状态机，不依赖进程/electron —— 可单测）。
//
// 帧格式（见 dotnet/embedding-sidecar/Program.cs）：
//   [4B LE JSON 头长度][UTF-8 JSON 头][可选二进制段 float32 LE]
//   二进制段长度 = count × dim × 4（由头推导，不另设长度字段）
//
// ⚠️ 跨 chunk 安全的关键不变量：
//   - 4 字节长度前缀在 JSON 头**完整到达之前不得消费**（否则头被分片时
//     前缀丢失，下一轮把 JSON 开头 `{"id` 误读为长度 → 协议永久失步，
//     实测错误信息 "bad frame length 1684611707" = 0x6469227B = `{"id`）。
//   - 二进制段不完整时保存 mid-frame 状态（header + binaryLength）。

/** 响应头 JSON 上限（防御异常头字段）。 */
export const MAX_HEADER_BYTES = 1 << 20;
/** 二进制段上限（0.5M 条 × 1024 dim × 4B = 2GB 的安全边界）。 */
export const MAX_BINARY_BYTES = 512 << 20;

export interface DecodedFrame {
  header: Record<string, unknown>;
  binary: Buffer | null;
}

/** 协议失序（不可恢复，调用方应回收进程）。 */
export class SidecarProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SidecarProtocolError";
  }
}

export class SidecarFrameDecoder {
  private chunks: Buffer[] = [];
  private buffered = 0;
  /** 已读长度前缀但 JSON 头尚未收齐（前缀不得丢弃）。 */
  private pendingHeaderLen: number | null = null;
  /** 头已解析、二进制段尚未收齐。 */
  private pendingFrame: { header: Record<string, unknown>; binaryLength: number } | null = null;

  /**
   * 喂入一段 stdout 数据，返回本次可完整解析的帧。
   * 协议失序时抛 SidecarProtocolError（调用方回收进程）。
   */
  push(chunk: Buffer): DecodedFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }

    const frames: DecodedFrame[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 1) 二进制段收集中（mid-frame）
      if (this.pendingFrame) {
        const binary = this.take(this.pendingFrame.binaryLength);
        if (!binary) break;
        const header = this.pendingFrame.header;
        this.pendingFrame = null;
        frames.push({ header, binary });
        continue;
      }

      // 2) 长度前缀（跨 chunk：头未收齐前保留 pendingHeaderLen）
      if (this.pendingHeaderLen === null) {
        const prefix = this.take(4);
        if (!prefix) break;
        const headerLen = prefix.readInt32LE(0);
        if (headerLen < 0 || headerLen > MAX_HEADER_BYTES) {
          throw new SidecarProtocolError(`bad frame length ${headerLen}`);
        }
        this.pendingHeaderLen = headerLen;
      }

      // 3) JSON 头（只有完整到达才消费）
      const headerBuf = this.take(this.pendingHeaderLen);
      if (!headerBuf) break;
      const headerLen = this.pendingHeaderLen;
      this.pendingHeaderLen = null;

      let header: Record<string, unknown>;
      try {
        header = JSON.parse(headerBuf.toString("utf8")) as Record<string, unknown>;
      } catch {
        throw new SidecarProtocolError("frame header is not valid JSON");
      }

      // 4) 二进制段长度推导 + 校验
      const count = typeof header.count === "number" ? header.count : null;
      const dim = typeof header.dim === "number" ? header.dim : null;
      const binaryLength =
        header.ok === true && count !== null && dim !== null ? count * dim * 4 : 0;
      if (!Number.isFinite(binaryLength) || binaryLength < 0 || binaryLength > MAX_BINARY_BYTES) {
        throw new SidecarProtocolError(`bad binary length ${binaryLength}`);
      }
      if (binaryLength > 0) {
        this.pendingFrame = { header, binaryLength };
        continue;
      }
      frames.push({ header, binary: null });
    }
    return frames;
  }

  /** 丢弃全部缓冲与中间状态（进程重启/回收时调用）。 */
  reset(): void {
    this.chunks = [];
    this.buffered = 0;
    this.pendingHeaderLen = null;
    this.pendingFrame = null;
  }

  /**
   * 从队列头取精确 n 字节。数据不足返回 null（调用方等下个 data）。
   * 快路径（队头 chunk 足够）零拷贝返回视图；跨 chunk 时仅拼 n 字节。
   */
  private take(n: number): Buffer | null {
    if (n === 0) return Buffer.alloc(0);
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.buffered -= n;
      return out;
    }
    const out = Buffer.concat(this.chunks, n);
    let consumed = 0;
    while (consumed < n && this.chunks.length > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= n - consumed) {
        consumed += chunk.length;
        this.chunks.shift();
      } else {
        this.chunks[0] = chunk.subarray(n - consumed);
        consumed = n;
      }
    }
    this.buffered -= n;
    return out;
  }
}
