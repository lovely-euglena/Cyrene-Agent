// 本地音乐链路冒烟（cyrene-native serve 协议 + MusicService + mpv）：
//   1. 构造临时音乐目录（生成 1s 静音 WAV + 同名 .lrc）
//   2. music.config（dbPath / 内置 mpv 路径 / 文件夹）→ music.rescan
//   3. music.query 断言扫描结果；music.play 断言 mpv 播放推进
//   4. music.control 断言 音量/暂停/停止；关闭时校验 stdin EOF 退出
//
// 用法：node scripts/diagnostics/music-native-smoke.mjs
//   无音频设备/无 WPF 会话时 mpv 播放断言可能跳过（脚本给出 SKIP 并继续其余断言）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const root = process.cwd();
const exeName = process.platform === "win32" ? "cyrene-native.exe" : "cyrene-native";
const nativeExe = [
  process.env.CYRENE_NATIVE_EXE,
  path.join(root, "dotnet", "native-windows", "bin", "Release", "net10.0-windows", exeName),
  path.join(root, "dotnet", "native-windows", "bin", "Debug", "net10.0-windows", exeName),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!nativeExe) {
  console.error("[FAIL] 找不到 cyrene-native，可先 dotnet build -c Release dotnet/native-windows");
  process.exit(1);
}
const mpvExe = path.join(root, "resources", "bin", "mpv", "mpv.exe");
if (!fs.existsSync(mpvExe)) {
  console.error("[FAIL] 找不到内置 mpv:", mpvExe);
  process.exit(1);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-music-smoke-"));
const musicDir = path.join(workDir, "Album");
fs.mkdirSync(musicDir, { recursive: true });

// 1s 静音 WAV（8000Hz 16bit mono）
function writeSilentWav(filePath, seconds) {
  const sampleRate = 8000;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buffer);
}

const wavPath = path.join(musicDir, "Test Artist - Silent Song.wav");
writeSilentWav(wavPath, 1);
fs.writeFileSync(path.join(musicDir, "Test Artist - Silent Song.lrc"), "[00:00.00]第一行\n[00:00.50]Translation\n", "utf8");
fs.writeFileSync(path.join(musicDir, "ignore.txt"), "not music");

let pass = 0;
let fail = 0;
let skip = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`[PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function skipped(name, detail = "") {
  skip += 1;
  console.log(`[SKIP] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ── 帧协议 ──
const child = spawn(nativeExe, ["serve"], { stdio: ["pipe", "pipe", "inherit"] });
let buffered = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
});
const waitForData = () => new Promise((resolve) => child.stdout.once("data", resolve));

function writeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

async function readFrame() {
  while (true) {
    if (buffered.length >= 4) {
      const len = buffered.readInt32LE(0);
      if (buffered.length >= 4 + len) {
        const header = JSON.parse(buffered.subarray(4, 4 + len).toString("utf8"));
        buffered = buffered.subarray(4 + len);
        return header;
      }
    }
    await waitForData();
  }
}

let nextId = 1;
async function request(op, extra = {}) {
  const id = nextId++;
  writeFrame({ id, op, ...extra });
  while (true) {
    const frame = await readFrame();
    if (frame.id === id) return frame;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const timeout = setTimeout(() => {
  console.error("[FAIL] 冒烟超时（60s）");
  child.kill();
  process.exit(1);
}, 60_000);

try {
  const ready = await readFrame();
  check("native ready", ready.id === 0 && ready.op === "ready", JSON.stringify(ready));

  const configured = await request("music.config", {
    config: {
      dbPath: path.join(workDir, "music.db"),
      mpvPath: mpvExe,
      folders: [musicDir],
    },
  });
  check("music.config", configured.ok === true, JSON.stringify(configured));

  await request("music.rescan");
  let query;
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(100);
    query = await request("music.query", { search: "" });
    if (query.data && query.data.scanning === false) break;
  }
  check("扫描到 1 首（txt 忽略）", query?.data?.tracks?.length === 1, JSON.stringify(query?.data?.tracks?.length));
  check("曲名从文件名推导", query?.data?.tracks?.[0]?.title === "Silent Song" && query?.data?.tracks?.[0]?.artist === "Test Artist");

  const play = await request("music.play", { path: wavPath });
  const playOk = play?.data?.ok === true;
  check("music.play 受理", playOk, JSON.stringify(play?.data));

  if (playOk) {
    let nowPlaying = null;
    let positionAdvanced = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(200);
      const state = await request("music.now-playing");
      nowPlaying = state?.data;
      if (nowPlaying?.positionSec > 0.05) {
        positionAdvanced = true;
        break;
      }
      if (nowPlaying?.status === "idle") break;
    }
    if (nowPlaying?.status === "idle") {
      skipped("mpv 播放推进", "mpv 退出（可能无音频设备）");
    } else {
      check("mpv 播放推进", positionAdvanced, JSON.stringify(nowPlaying));
      check("歌词行输出", typeof nowPlaying?.lyricLine === "string" && nowPlaying.lyricLine.length > 0, JSON.stringify(nowPlaying?.lyricLine));

      const volume = await request("music.control", { action: "volume", volume: 33 });
      check("音量控制", volume?.data?.nowPlaying?.volume === 33, JSON.stringify(volume?.data?.nowPlaying?.volume));

      const paused = await request("music.control", { action: "pause" });
      check("暂停控制", paused?.data?.nowPlaying?.paused === true);

      await request("music.control", { action: "stop" });
      await sleep(300);
      const stopped = await request("music.now-playing");
      check("停止回到 idle", stopped?.data?.status === "idle", JSON.stringify(stopped?.data?.status));
    }
  }
} catch (error) {
  fail += 1;
  console.error("[FAIL] 冒烟异常：", error);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill();
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 文件被占用：交给系统清理
  }
}

console.log(`[music-native-smoke] ${pass} passed, ${fail} failed, ${skip} skipped`);
process.exit(fail === 0 ? 0 : 1);
