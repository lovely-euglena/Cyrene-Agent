// WSL 真机冒烟（Windows 桌面机）：
//   1. 定位 wsl.exe（SystemRoot\System32 或 PATH）
//   2. `wsl -l -q`（UTF-16LE 解码）枚举发行版；无 WSL / 无发行版 → [SKIP] 退出 0
//   3. 用与 run_shell 相同的 base64 直通方式在发行版内执行命令，断言输出
//   4. cwd 换算：以当前工作目录为 cwd 执行 pwd，断言落在 /mnt/<盘符>/...
//   5. 引号/管道命令经 base64 直通不被外层引号层破坏
//
// 用法：node scripts/diagnostics/wsl-smoke.mjs [distro]
//   不带参数用 WSL 默认发行版；本机无 WSL 自动跳过（CI/云端不误报失败）。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

if (process.platform !== "win32") {
  console.log("[SKIP] 非 Windows 平台，WSL 冒烟不适用");
  process.exit(0);
}

function resolveWslExe() {
  const candidates = [];
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) candidates.push(path.join(systemRoot, "System32", "wsl.exe"));
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const dir = entry.trim().replace(/^"|"$/g, "");
    if (dir) candidates.push(path.join(dir, "wsl.exe"));
  }
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

function decodeWslText(buffer) {
  if (!buffer.length) return "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  let zeros = 0;
  const sample = Math.min(buffer.length, 512);
  for (let i = 0; i < sample; i++) if (buffer[i] === 0) zeros++;
  return zeros > sample / 4 ? buffer.toString("utf16le") : buffer.toString("utf8");
}

function runCapture(exe, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.from(String(error)) });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish({ code: -1, stdout: Buffer.concat(out), stderr: Buffer.from(String(error)) }));
    child.on("close", (code) => finish({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }));
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish({ code: null, stdout: Buffer.concat(out), stderr: Buffer.from("timeout") });
    }, timeoutMs);
  });
}

const exe = resolveWslExe();
if (!exe) {
  console.log("[SKIP] 未找到 wsl.exe（本机未安装 WSL）");
  process.exit(0);
}

const list = await runCapture(exe, ["-l", "-q"], 5_000);
const distros = decodeWslText(list.stdout)
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .map((line) => line.replace(/\0/g, "").trim())
  .filter(Boolean);
if (distros.length === 0) {
  console.log("[SKIP] wsl.exe 存在但未安装任何发行版");
  process.exit(0);
}

const distro = process.argv[2] || null;
if (distro && !distros.includes(distro)) {
  console.error(`[FAIL] 指定发行版 ${distro} 不存在；可用：${distros.join(", ")}`);
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`[PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function toWslPath(winPath) {
  if (/^[\\/]{2}/.test(winPath)) return null;
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(winPath);
  if (!match) return null;
  const rest = match[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return rest ? `/mnt/${match[1].toLowerCase()}/${rest}` : `/mnt/${match[1].toLowerCase()}`;
}

function wslArgs(command, wslCwd) {
  const script = wslCwd
    ? `cd -- '${wslCwd.replace(/'/g, `'\\''`)}' && ${command}`
    : command;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const args = [];
  if (distro) args.push("-d", distro);
  args.push("-e", "bash", "-lc", `echo ${encoded} | base64 -d | bash`);
  return args;
}

console.log(`[wsl-smoke] wsl.exe=${exe} distros=${distros.join(", ")}${distro ? ` distro=${distro}` : ""}`);

const echo = await runCapture(exe, wslArgs("printf cyrene-wsl-ok"));
check(
  "发行版内执行命令",
  echo.code === 0 && echo.stdout.toString("utf8").includes("cyrene-wsl-ok"),
  `code=${echo.code} stderr=${echo.stderr.toString("utf8").trim()}`,
);

const cwdWin = process.cwd();
const wslCwd = toWslPath(cwdWin);
if (wslCwd) {
  const pwd = await runCapture(exe, wslArgs("pwd", wslCwd));
  const got = pwd.stdout.toString("utf8").trim();
  check("cwd 换算生效（pwd）", pwd.code === 0 && got === wslCwd, `got=${got} want=${wslCwd}`);
} else {
  console.log(`[SKIP] 当前工作目录无法换算为 WSL 路径：${cwdWin}`);
}

const tricky = `printf '%s' "$(echo 'a b' | tr -d ' ')"`;
const trickyRun = await runCapture(exe, wslArgs(tricky));
const trickyOut = trickyRun.stdout.toString("utf8").trim();
check("引号/管道命令直通", trickyRun.code === 0 && trickyOut === "ab", `code=${trickyRun.code} out=${JSON.stringify(trickyOut)}`);

console.log(`[wsl-smoke] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
