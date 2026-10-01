#!/usr/bin/env node
// 云存储托管宿主冒烟（cyrene-native --storage-host）。
//
// 对给定档案跑一遍全流程：
//   profiles.upsert → mkdir → write(content) → read(text) → read(dir) → overwrite 保护
//   → write(localPath) → download → copy → move → delete(file) → delete(dir, recursive)
//   → 读已删除路径应得 STORAGE_NOT_FOUND → 清理
//
// 用法：
//   node scripts/diagnostics/cloud-storage-smoke.mjs --profile '<json>' [--exe <path>] [--data-dir <dir>] [--keep]
//
// profile JSON 字段与 cloud_profile_save 一致（protocol/host/port/username/password/rootPath/
// baseUrl/bucket/endpoint/region/pathStyle/accessKeyId/secretAccessKey/...）。
// 例：
//   node scripts/diagnostics/cloud-storage-smoke.mjs --profile '{"protocol":"s3","bucket":"b","endpoint":"https://s3.example.com","region":"us-east-1","accessKeyId":"...","secretAccessKey":"..."}'
//   node scripts/diagnostics/cloud-storage-smoke.mjs --profile '{"protocol":"webdav","baseUrl":"https://dav.example.com/dav","username":"u","password":"p"}'
//   node scripts/diagnostics/cloud-storage-smoke.mjs --profile '{"protocol":"sftp","host":"h","port":8022,"username":"u","password":"p"}'
//
// 说明：
// - 默认使用 dotnet/native-windows 的 Release 构建；打包态用 --exe resources/native-windows/cyrene-native.exe
// - 所有远端操作都在 rootPath 下的 cyrene-smoke-<时间戳>/ 目录内，结束自动删除（--keep 保留现场）
// - 凭据只经命令行传入；宿主侧档案文件由 DPAPI 加密落盘，脚本本身不写凭据

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

function parseArgs(argv) {
  const args = { keep: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--keep") { args.keep = true; continue; }
    if (key === "--inspect") { args.inspect = true; continue; }
    if (key === "--profile") { args.profile = argv[++i]; continue; }
    if (key === "--exe") { args.exe = argv[++i]; continue; }
    if (key === "--data-dir") { args.dataDir = argv[++i]; continue; }
  }
  return args;
}

function resolveExe(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    path.join(repoRoot, "dotnet", "native-windows", "bin", "Release", "net10.0-windows", "cyrene-native.exe"),
    path.join(repoRoot, "release", "win-unpacked", "resources", "native-windows", "cyrene-native.exe"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`找不到 cyrene-native.exe，请先 dotnet build 或用 --exe 指定。候选：\n${candidates.join("\n")}`);
}

class HostClient {
  constructor(exe, dataDir) {
    this.child = spawn(exe, ["--storage-host", "--data-dir", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.seq = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      setTimeout(() => reject(new Error("storage-host 启动超时")), 15_000).unref();
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[storage-host stderr] ${text}`);
    });
    this.child.on("exit", (code) => {
      for (const [, call] of this.pending) call.reject(new Error(`storage-host 退出（code=${code}）`));
      this.pending.clear();
    });
  }

  handleLine(line) {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.op === "ready") { this.readyResolve(); return; }
    if (frame.op !== "result") return;
    const call = this.pending.get(frame.callId);
    if (!call) return;
    this.pending.delete(frame.callId);
    clearTimeout(call.timer);
    if (frame.ok === true) call.resolve(frame.data);
    else {
      const error = new Error(frame.error ?? "调用失败");
      error.errorCode = frame.errorCode ?? "STORAGE_IO_ERROR";
      call.reject(error);
    }
  }

  call(op, params = {}, timeoutMs = 120_000) {
    const callId = `smoke-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`${op} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(callId, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ op, callId, ...params })}\n`);
    });
  }

  async shutdown() {
    try {
      await this.call("shutdown", {}, 10_000);
    } catch { /* 进程可能已退出 */ }
    setTimeout(() => this.child.kill(), 3_000).unref();
  }
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  [PASS] ${name}`); }
  else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`); }
}

/** 删除后轮询确认消失（部分服务 DELETE 为最终一致，如 123 云盘 WebDAV）。 */
async function waitGone(client, profileId, remotePath, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await client.call("read", { profileId, path: remotePath });
    } catch (error) {
      if (error.errorCode === "STORAGE_NOT_FOUND") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return false;
}

async function main() {  const args = parseArgs(process.argv.slice(2));
  if (!args.profile) {
    console.error("用法：node scripts/diagnostics/cloud-storage-smoke.mjs --profile '<json>' [--exe <path>] [--data-dir <dir>] [--keep]");
    process.exit(2);
  }
  const profile = JSON.parse(args.profile);
  const protocol = String(profile.protocol ?? "sftp");
  const exe = resolveExe(args.exe);
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-storage-smoke-"));
  fs.mkdirSync(dataDir, { recursive: true });

  console.log(`== 云存储冒烟：${protocol} ==`);
  console.log(`   exe: ${exe}`);
  console.log(`   data-dir: ${dataDir}`);

  const client = new HostClient(exe, dataDir);
  await client.ready;

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const base = `cyrene-smoke-${stamp}`;
  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-storage-local-"));
  const localUpload = path.join(localDir, "upload.bin");
  fs.writeFileSync(localUpload, Buffer.from([0, 1, 2, 3, 4, 5, 250, 251, 252, 253]));
  const localDownload = path.join(localDir, "downloaded.txt");

  let profileId = null;
  try {
    const saved = await client.call("profiles.upsert", {
      profile: { ...profile, name: profile.name ?? `smoke-${protocol}-${stamp}` },
    });
    profileId = saved.id;
    check("profiles.upsert", Boolean(profileId), JSON.stringify(saved));

    await client.call("profiles.test", { profileId }, 30_000);
    check("profiles.test（连接/鉴权）", true);

    if (args.inspect) {
      const listing = await client.call("read", { profileId, path: "", maxEntries: 200 });
      console.log("  根目录内容：");
      console.log(JSON.stringify(listing, null, 2));
      return;
    }

    await client.call("mkdir", { profileId, path: base, recursive: true });
    check("mkdir", true);

    await client.call("write", { profileId, path: `${base}/hello.txt`, content: "hello 云存储 smoke\n" });
    check("write(content)", true);

    const readText = await client.call("read", { profileId, path: `${base}/hello.txt` });
    check("read(text) 内容匹配", readText.kind === "text" && String(readText.text).includes("云存储"), JSON.stringify(readText).slice(0, 200));

    const readDir = await client.call("read", { profileId, path: base });
    check("read(dir) 含 hello.txt", readDir.kind === "dir" && readDir.entries.some((e) => e.name === "hello.txt"), JSON.stringify(readDir).slice(0, 200));

    let overwriteGuard = false;
    try {
      await client.call("write", { profileId, path: `${base}/hello.txt`, content: "x" });
    } catch (error) {
      overwriteGuard = error.errorCode === "STORAGE_ALREADY_EXISTS";
    }
    check("覆盖保护（默认拒绝）", overwriteGuard);

    await client.call("write", { profileId, path: `${base}/upload.bin`, localPath: localUpload });
    check("write(localPath)", true);

    const downloaded = await client.call("download", {
      profileId,
      path: `${base}/upload.bin`,
      localPath: localDownload,
    });
    const expected = fs.readFileSync(localUpload);
    const actual = fs.readFileSync(localDownload);
    check("download 字节一致", Buffer.compare(expected, actual) === 0, `${downloaded.bytes} bytes`);

    await client.call("copy", { profileId, from: `${base}/hello.txt`, to: `${base}/copy.txt` });
    const copied = await client.call("read", { profileId, path: `${base}/copy.txt` });
    check("copy + read", copied.kind === "text");

    await client.call("move", { profileId, from: `${base}/copy.txt`, to: `${base}/moved.txt` });
    const moved = await client.call("read", { profileId, path: `${base}/moved.txt` });
    check("move + read", moved.kind === "text");

    await client.call("delete", { profileId, paths: [`${base}/moved.txt`] });
    const fileGone = await waitGone(client, profileId, `${base}/moved.txt`);
    check("delete(file) → NOT_FOUND", fileGone);

    await client.call("delete", { profileId, paths: [base], recursive: true });
    const dirGone = await waitGone(client, profileId, base);
    check("delete(dir, recursive) → NOT_FOUND", dirGone);
  } catch (error) {
    fail++;
    console.log(`  [FAIL] 流程中断：${error.message}（errorCode=${error.errorCode ?? "-"}）`);
  } finally {
    if (!args.keep && profileId) {
      try { await client.call("delete", { profileId, paths: [base], recursive: true }, 60_000); } catch { /* 已删或不存在 */ }
    }
    await client.shutdown();
    fs.rmSync(localDir, { recursive: true, force: true });
  }

  console.log(`== 结果：${pass} 通过 / ${fail} 失败 ==`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`[FATAL] ${error.message}`);
  process.exit(1);
});
