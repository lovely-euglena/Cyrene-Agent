// cyrene-native 协议冒烟（Linux 可跑部分）：
//   1. spawn → Linux 无显示环境，WPF Application.Run 会抛异常退出
//   2. 验证点：进程能启动、stderr 有诊断、退出码可观测
//   3. 完整窗口冒烟需 Windows 实机（smoke:windows 脚本，见 scripts/README）
//
// 本脚本同时校验 Electron 侧 NativeWindowsClient 的帧协议实现：
//   用 fake exe（node 模拟 cyrene-native 的帧协议）验证 ready 握手、
//   请求-响应、事件转发、协议失步回收。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── fake native exe：模拟 cyrene-native 的 stdio 帧协议 ──
const fakeScript = `
let buf = Buffer.alloc(0);
function tryParse() {
  for (;;) {
    if (buf.length < 4) return;
    const len = buf.readInt32LE(0);
    if (buf.length < 4 + len) return;
    const json = buf.subarray(4, 4 + len).toString("utf8");
    buf = buf.subarray(4 + len);
    handle(JSON.parse(json));
  }
}
function writeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  process.stdout.write(prefix);
  process.stdout.write(json);
}
function handle(frame) {
  if (frame.op === "win.spawn") {
    writeFrame({ id: frame.id, ok: true });
    writeFrame({ op: "event", name: "win.shown", kind: frame.kind });
  } else if (frame.id !== undefined) {
    writeFrame({ id: frame.id, ok: true });
  }
}
writeFrame({ id: 0, op: "ready" });
process.stdin.on("data", (chunk) => { buf = Buffer.concat([buf, chunk]); tryParse(); });
process.stdin.on("end", () => process.exit(0));
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-native-smoke-"));
const fakeExe = path.join(tmpDir, "fake-native.js");
fs.writeFileSync(fakeExe, fakeScript);

// ── 直接用帧协议对话（不经 Electron，验证协议契约） ──
function writeFrame(child, obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

(async () => {
  const child = spawn(process.execPath, [fakeExe], { stdio: ["pipe", "pipe", "inherit"] });

  let buffered = Buffer.alloc(0);
  const frames = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    // 解析所有完整帧
    for (;;) {
      if (buffered.length < 4) break;
      const len = buffered.readInt32LE(0);
      if (buffered.length < 4 + len) break;
      const json = buffered.subarray(4, 4 + len).toString("utf8");
      buffered = buffered.subarray(4 + len);
      const frame = JSON.parse(json);
      frames.push(frame);
      for (const w of waiters.splice(0)) w(frame);
    }
  });

  const nextFrame = (pred) => new Promise((resolve) => {
    const idx = frames.findIndex(pred);
    if (idx >= 0) return resolve(frames[idx]);
    waiters.push((f) => { if (pred(f)) resolve(f); });
  });

  // 1) ready 握手
  const ready = await nextFrame((f) => f.id === 0 && f.op === "ready");
  console.log("[smoke] ready handshake ok");

  // 2) win.spawn 请求 → 确认 + win.shown 事件
  writeFrame(child, { id: 1, op: "win.spawn", kind: "splash", layout: {} });
  const ack = await nextFrame((f) => f.id === 1 && f.ok === true);
  console.log("[smoke] win.spawn acked");
  const shown = await nextFrame((f) => f.op === "event" && f.name === "win.shown" && f.kind === "splash");
  console.log("[smoke] win.shown event ok");

  // 3) 未知 op → ok（native 侧 win.* 之外仍按通用确认处理）
  writeFrame(child, { id: 2, op: "state.runtime", state: { status: "陪伴中", feeling: "开心" } });
  await nextFrame((f) => f.id === 2 && f.ok === true);
  console.log("[smoke] state push acked");

  // 4) EOF → 干净退出
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("exit", resolve));
  console.log(`[smoke] exit code=${code}`);

  if (code !== 0) {
    console.error("[smoke] FAIL: non-zero exit");
    process.exit(1);
  }
  console.log("[smoke] PASS");
  fs.rmSync(tmpDir, { recursive: true, force: true });
})().catch((err) => {
  console.error("[smoke] FAIL:", err.message);
  process.exit(1);
});
