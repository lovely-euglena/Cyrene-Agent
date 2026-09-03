// sidecar stdio 帧协议冒烟测试：
//   1. spawn cyrene-embed serve
//   2. 等 ready 帧（id=0）
//   3. 发 2 条 embed 请求（用 verify dump 的前 2 条文本）
//   4. 校验响应帧格式 + 向量与 dump 一致（cosine > 0.9995）
//   5. stdin EOF 退出
//
// 用法：node scripts/diagnostics/embedding-sidecar-smoke.mjs

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const exe = path.join(process.cwd(), "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", "cyrene-embed");
const modelDir = path.join(process.cwd(), "models", "Xenova", "bge-m3");
const dump = JSON.parse(fs.readFileSync("scripts/diagnostics/embedding-verify-data.json", "utf8"));

const child = spawn(exe, ["serve", modelDir], {
  env: { ...process.env, DOTNET_ROOT: process.env.HOME + "/.dotnet" },
  stdio: ["pipe", "pipe", "inherit"],
});

// ── 帧读写 ──
function writeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

async function readExact(readable, count) {
  const chunks = [];
  let total = 0;
  for await (const chunk of readable) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= count) break;
  }
  const buf = Buffer.concat(chunks);
  if (buf.length < count) throw new Error(`stdin closed: got ${buf.length}/${count}`);
  return { data: buf.subarray(0, count), rest: buf.subarray(count) };
}

// 简单缓冲式读（处理粘包）：持续监听把数据攒进 buffered，
// readFrame 轮询 buffered，用 once("data") 唤醒等待
let buffered = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
});
const waitForData = () => new Promise((resolve) => child.stdout.once("data", resolve));

async function readFrame() {
  while (true) {
    if (buffered.length >= 4) {
      const len = buffered.readInt32LE(0);
      if (buffered.length >= 4 + len) {
        const json = buffered.subarray(4, 4 + len).toString("utf8");
        buffered = buffered.subarray(4 + len);
        const header = JSON.parse(json);
        // 响应帧可能带二进制段（ok 且 count>0）
        const binaryLength = header.ok && header.count > 0 ? header.count * header.dim * 4 : 0;
        if (binaryLength === 0) return { header, binary: null };
        // 继续读二进制段
        while (buffered.length < binaryLength) {
          await waitForData();
        }
        const binary = buffered.subarray(0, binaryLength);
        buffered = buffered.subarray(binaryLength);
        return { header, binary };
      }
    }
    await waitForData();
  }
}

(async () => {
  // 1) ready 帧
  const { header: ready } = await readFrame();
  if (ready.id !== 0 || ready.op !== "ready") throw new Error(`unexpected ready: ${JSON.stringify(ready)}`);
  console.log(`[smoke] ready: model=${ready.modelKey} dim=${ready.dim}`);

  // 2) embed 请求（dump 前 2 条）
  const texts = dump.texts.slice(0, 2);
  const request = { id: 1, op: "embed", texts };
  const t0 = performance.now();
  writeFrame(request);
  const { header, binary } = await readFrame();
  const elapsed = (performance.now() - t0).toFixed(0);

  if (!header.ok) throw new Error(`embed failed: ${header.error}`);
  if (header.count !== texts.length || header.dim !== dump.dims) throw new Error(`header mismatch: ${JSON.stringify(header)}`);

  // 3) 校验向量（拷贝出对齐副本——byteOffset 未必 4 对齐，
  //    直接 new Float32Array(buffer, offset, len) 会 RangeError）
  let worst = 1;
  for (let i = 0; i < texts.length; i++) {
    const copy = binary.buffer.slice(binary.byteOffset + i * header.dim * 4, binary.byteOffset + (i + 1) * header.dim * 4);
    const actual = new Float32Array(copy);
    const expected = dump.vectors[i];
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < header.dim; k++) {
      dot += actual[k] * expected[k];
      na += actual[k] * actual[k];
      nb += expected[k] * expected[k];
    }
    worst = Math.min(worst, dot / (Math.sqrt(na) * Math.sqrt(nb)));
  }
  console.log(`[smoke] embed ${texts.length} texts in ${elapsed}ms, worst cosine=${worst.toFixed(8)}`);

  // 3b) 大批量（64 texts × 4KB = 256KB 二进制段 > 单 chunk 64KB）：
  //     响应必然跨多个 data 事件，验证 Electron 客户端的 mid-frame
  //     状态机（复现 P0 帧失步 bug 的场景——本脚本自带同样的解析逻辑）
  const bigTexts = Array.from({ length: 64 }, (_, i) => dump.texts[i % dump.texts.length]);
  writeFrame({ id: 9, op: "embed", texts: bigTexts });
  const t1 = performance.now();
  const { header: bigHeader, binary: bigBinary } = await readFrame();
  if (!bigHeader.ok || bigHeader.count !== 64) throw new Error(`big embed failed: ${JSON.stringify(bigHeader)}`);
  let bigWorst = 1;
  for (let i = 0; i < 64; i++) {
    const copy = bigBinary.buffer.slice(
      bigBinary.byteOffset + i * bigHeader.dim * 4,
      bigBinary.byteOffset + (i + 1) * bigHeader.dim * 4,
    );
    const actual = new Float32Array(copy);
    const expected = dump.vectors[i % dump.texts.length];
    let dot = 0, na = 0, nb = 0;
    for (let k = 0; k < bigHeader.dim; k++) {
      dot += actual[k] * expected[k];
      na += actual[k] * actual[k];
      nb += expected[k] * expected[k];
    }
    bigWorst = Math.min(bigWorst, dot / (Math.sqrt(na) * Math.sqrt(nb)));
  }
  console.log(`[smoke] big embed 64 texts (${bigBinary.length / 1024 | 0}KB binary, ${(performance.now() - t1).toFixed(0)}ms), worst cosine=${bigWorst.toFixed(8)}`);

  // 4) 错误帧路径：空 texts + 未知 op
  writeFrame({ id: 2, op: "embed", texts: [] });
  const { header: empty } = await readFrame();
  if (!empty.ok || empty.count !== 0) throw new Error(`empty embed failed: ${JSON.stringify(empty)}`);
  console.log(`[smoke] empty embed ok (count=0)`);

  writeFrame({ id: 3, op: "frobnicate", texts: [] });
  const { header: badOp } = await readFrame();
  if (badOp.ok || !/unsupported op/.test(badOp.error || "")) throw new Error(`bad op not rejected: ${JSON.stringify(badOp)}`);
  console.log(`[smoke] unsupported op rejected ok`);

  // 4b) 大批量之后再做一次小请求：确认协议在跨 chunk 响应后不失步
  writeFrame({ id: 4, op: "embed", texts: [dump.texts[0]] });
  const { header: afterBig } = await readFrame();
  if (!afterBig.ok || afterBig.count !== 1) throw new Error(`post-big embed failed: ${JSON.stringify(afterBig)}`);
  console.log(`[smoke] post-big embed ok (protocol still in sync)`);

  // 5) EOF 退出
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  console.log(`[smoke] exit code=${code}`);

  if (worst < 0.9995) {
    console.error("[smoke] FAIL: cosine below threshold");
    process.exit(1);
  }
  console.log("[smoke] PASS");
})().catch((err) => {
  console.error("[smoke] FAIL:", err.message);
  child.kill();
  process.exit(1);
});
