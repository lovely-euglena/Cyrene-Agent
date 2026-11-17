#!/usr/bin/env node
/**
 * Live2D 双轨逐像素对照（#257 T6 验收基建，issue 评论 2「diff 工具链先行」）。
 *
 * 零依赖（node:fs/zlib/path）：内置 PNG 解码器（8-bit 非隔行，color type
 * 0/2/3/6，全 5 种 scanline filter）——侧车 GDI+ 与 Electron capturePage
 * 产物均为 8-bit RGBA，覆盖足够。
 *
 * diff 语义（与验收口径对齐，设计文档 §10 同源）：
 *   - 两图必须同尺寸（web 轨 PET_RENDER_MAX_DPR=1 → 400×500 CSS 像素即物理像素）。
 *   - 逐像素取 R/G/B/A 四通道绝对差的最大值；> channel-tol（默认 8/255，
 *     容忍 AA/浮点舍入/纹理滤波噪声）记为差异像素。
 *   - 双透明像素（A 均为 0）跳过颜色比较（透明下的 RGB 无定义）。
 *   - diff_pct = 差异像素 / 总像素 × 100（脚本产出，不接受模型自报）。
 *
 * 用法：
 *   node scripts/live2d/pixel-diff.mjs a.png b.png [--threshold 2] [--channel-tol 8] [--out diff.json]
 *   node scripts/live2d/pixel-diff.mjs --selftest
 *
 * 退出码：0 = pass（diff_pct < threshold）/ 1 = fail / 2 = 前置错误。
 * stdout 恒为 JSON（供 eval-log.mjs 机器读取 diff_pct）。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

// ── CRC32（PNG chunk 校验） ─────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG 解码 ────────────────────────────────────────────────
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** 解码 PNG → {width, height, rgba: Uint8Array}（顶行序，直通非预乘）。 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("非 PNG 文件");
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    if (crc32(buf.subarray(off + 4, off + 8 + len)) !== crc) throw new Error(`PNG chunk ${type} CRC 校验失败`);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      trns = data;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`仅支持 8-bit PNG（实际 ${bitDepth}）`);
  if (interlace !== 0) throw new Error("不支持隔行 PNG（Adam7）");
  const channels = { 0: 1, 2: 3, 3: 1, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 color type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("调色板 PNG 缺 PLTE");
  if (width <= 0 || height <= 0 || width * height > 64_000_000) throw new Error("PNG 尺寸非法");

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error("PNG 数据长度与 IHDR 不符");

  // 反滤波（PNG spec §9.2；bpp = 每像素字节数）
  const pixels = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = rowIn[x];
      switch (filter) {
        case 0: break;
        case 1: v = (v + a) & 0xff; break;
        case 2: v = (v + b) & 0xff; break;
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (v + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`未知 scanline filter ${filter}`);
      }
      row[x] = v;
    }
  }

  // 统一展开为 RGBA
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    if (colorType === 6) {
      rgba.set(pixels.subarray(i * 4, i * 4 + 4), o);
    } else if (colorType === 2) {
      rgba[o] = pixels[i * 3]; rgba[o + 1] = pixels[i * 3 + 1]; rgba[o + 2] = pixels[i * 3 + 2]; rgba[o + 3] = 255;
    } else if (colorType === 0) {
      const g = pixels[i];
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g;
      rgba[o + 3] = trns && trns.length >= 2 && g === trns.readUInt16BE(0) ? 0 : 255;
    } else {
      const idx = pixels[i];
      rgba[o] = palette[idx * 3]; rgba[o + 1] = palette[idx * 3 + 1]; rgba[o + 2] = palette[idx * 3 + 2];
      rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
    }
  }
  return { width, height, rgba };
}

// ── PNG 编码（仅 --selftest 用：filter 0 直通） ─────────────
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

export function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── diff 计算 ───────────────────────────────────────────────
export function diffImages(a, b, channelTol) {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`尺寸不一致: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  const total = a.width * a.height;
  let diffPixels = 0;
  let sumMaxDelta = 0;
  for (let i = 0; i < total; i++) {
    const o = i * 4;
    const aA = a.rgba[o + 3], bA = b.rgba[o + 3];
    // 双透明：颜色无定义，视为相同
    if (aA === 0 && bA === 0) continue;
    let maxDelta = Math.abs(aA - bA);
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.rgba[o + c] - b.rgba[o + c]);
      if (d > maxDelta) maxDelta = d;
    }
    sumMaxDelta += maxDelta;
    if (maxDelta > channelTol) diffPixels++;
  }
  return {
    total_pixels: total,
    diff_pixels: diffPixels,
    diff_pct: Math.round((diffPixels / total) * 100 * 10000) / 10000,
    mean_max_delta: Math.round((sumMaxDelta / total) * 1000) / 1000,
  };
}

// ── 自测（沙箱无 GPU 也能验证工具链自身） ───────────────────
function selftest() {
  const W = 100, H = 100;
  const base = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4;
    base[o] = (i * 7) & 0xff; base[o + 1] = (i * 13) & 0xff; base[o + 2] = (i * 29) & 0xff; base[o + 3] = 255;
  }
  // 角落留一块双透明区（验证透明跳过逻辑）
  for (let i = 0; i < 100; i++) base[i * 4 + 3] = 0;

  const cases = [];
  const check = (name, cond, detail) => {
    cases.push({ name, ok: !!cond, detail });
    console.log(`  ${cond ? "ok" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  };

  // 1. 编解码往返
  const roundtrip = decodePng(encodePng(W, H, base));
  check("encode/decode 往返一致", Buffer.from(roundtrip.rgba).equals(Buffer.from(base)));

  // 2. 同图 diff = 0
  const same = diffImages(roundtrip, decodePng(encodePng(W, H, base)), 8);
  check("同图 diff_pct=0", same.diff_pct === 0, JSON.stringify(same));

  // 3. 1% 像素大改 → diff_pct≈1（pass）；5% → fail
  const mutate = (count) => {
    const m = new Uint8Array(base);
    for (let i = 0; i < count; i++) {
      const o = (1000 + i) * 4; // 避开透明区
      // XOR 0x80：任意原值都产生 128 的通道差（必超容差）
      m[o] ^= 0x80; m[o + 1] ^= 0x80; m[o + 2] ^= 0x80;
    }
    return decodePng(encodePng(W, H, m));
  };
  const d1 = diffImages(roundtrip, mutate(100), 8);
  check("1% 差异像素 → diff_pct=1", d1.diff_pct === 1, JSON.stringify(d1));
  const d5 = diffImages(roundtrip, mutate(500), 8);
  check("5% 差异像素 → diff_pct=5", d5.diff_pct === 5, JSON.stringify(d5));

  // 4. 通道容差：±8 以内不计差异
  const noise = new Uint8Array(base);
  for (let i = 1000; i < 2000; i++) {
    const o = i * 4;
    noise[o] = Math.min(255, noise[o] + 8);
  }
  const dn = diffImages(roundtrip, decodePng(encodePng(W, H, noise)), 8);
  check("channel-tol=8 吸收 ±8 噪声", dn.diff_pct === 0, JSON.stringify(dn));

  // 5. 尺寸不一致 → 抛错
  let threw = false;
  try { diffImages(roundtrip, decodePng(encodePng(50, 50, new Uint8Array(50 * 50 * 4))), 8); } catch { threw = true; }
  check("尺寸不一致抛错", threw);

  const failed = cases.filter((c) => !c.ok).length;
  console.log(`[pixel-diff selftest] PASS=${cases.length - failed} FAIL=${failed}`);
  if (failed > 0) return 1;
  console.log("SELFTEST_OK");
  return 0;
}

// ── CLI ─────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--selftest")) process.exit(selftest());

  const positional = argv.filter((a) => !a.startsWith("--"));
  const get = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
  };
  const fail = (msg) => {
    console.log(JSON.stringify({ error: msg, pass: false }));
    process.exit(2);
  };
  if (positional.length !== 2) fail("用法: pixel-diff.mjs a.png b.png [--threshold 2] [--channel-tol 8] [--out diff.json]");
  const threshold = Number(get("--threshold", "2"));
  const channelTol = Number(get("--channel-tol", "8"));
  if (!Number.isFinite(threshold) || !Number.isFinite(channelTol)) fail("threshold/channel-tol 必须为数字");

  let a, b;
  try {
    a = decodePng(fs.readFileSync(positional[0]));
    b = decodePng(fs.readFileSync(positional[1]));
  } catch (err) {
    fail(`PNG 解码失败: ${err.message}`);
  }
  let stats;
  try {
    stats = diffImages(a, b, channelTol);
  } catch (err) {
    fail(err.message);
  }
  const report = {
    a: path.resolve(positional[0]),
    b: path.resolve(positional[1]),
    width: a.width,
    height: a.height,
    channel_tol: channelTol,
    threshold,
    ...stats,
    pass: stats.diff_pct < threshold,
  };
  const json = JSON.stringify(report, null, 2);
  const out = get("--out", null);
  if (out) fs.writeFileSync(out, json + "\n");
  console.log(json);
  process.exit(report.pass ? 0 : 1);
}

// 仅直接运行时执行 CLI（被 import 时只导出函数，供测试/eval-log 复用）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
