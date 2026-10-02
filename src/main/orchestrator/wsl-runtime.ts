// WSL 运行时解析层 — 探测 wsl.exe、枚举发行版、构造 Windows→WSL 调用。
//
// 用途：run_shell 的 shell:"wsl" 模式在已安装 WSL 的 Windows 桌面机上，把命令送进
// 指定发行版执行（本模块只负责探测与调用构造；执行链接入见 run-shell-tool）。
//
// 安全不变量（配合 run-shell-tool 的守卫）：
// - 模型永不直接接触 wsl.exe 的 argv：它只提供「发行版内的命令字符串」，安装/卸载/
//   删除发行版（--install / --unregister / --manage 等）在结构上无法通过本层传入。
// - 命令经 UTF-8 base64 直通（`echo <b64> | base64 -d | bash`），Windows→wsl.exe→bash
//   之间不发生引号/转义解析，规避多层 shell 注入。
//
// 编码：wsl.exe 在中文 Windows 上按 UTF-16LE 输出（`wsl -l -q`），必须单独解码，
// 直接 utf8 会得到 NUL 穿插的乱码。
//
// 平台：仅 Windows 有意义；非 Windows 上 resolveWslExecutablePath() 返回 null。

import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";

/** WSL 探测超时：wsl.exe 冷启动可能数百毫秒，给足 5s，超时视为不可用。 */
export const WSL_PROBE_TIMEOUT_MS = 5_000;

/** 发行版列表缓存 TTL：设置页与首次执行共用，避免频繁 spawn wsl.exe。 */
export const WSL_DISCOVERY_CACHE_TTL_MS = 30_000;

/** 解析后的 WSL 执行器：可执行文件 + 目标发行版（null = 用 WSL 默认发行版）。 */
export interface ResolvedWslExecutable {
  kind: "wsl";
  /** wsl.exe 绝对路径 */
  executable: string;
  /** 目标发行版名；null = 交给 wsl.exe 使用其默认发行版 */
  distro: string | null;
}

/** WSL 探测结果：可执行文件与已安装发行版列表。 */
export interface WslDiscovery {
  /** wsl.exe 路径；null = 本机找不到 wsl.exe */
  executable: string | null;
  /** 已安装发行版名（`wsl -l -q` 的解析结果，已去 BOM/NUL/空行） */
  distros: string[];
}

/** WSL 调用规格：与 cmd/bash 的 buildDirectShellInvocation 返回结构对齐。 */
export interface WslInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * 定位 wsl.exe：优先 SystemRoot\System32（系统自带存根/正式版），再扫 PATH。
 * 仅检查文件是否存在；是否真正可用由发行版列表判定（存根会返回空列表）。
 */
export function resolveWslExecutablePath(): string | null {
  const candidates: string[] = [];
  const systemRoot = process.env.SystemRoot || process.env.windir;
  if (systemRoot) candidates.push(path.join(systemRoot, "System32", "wsl.exe"));
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const directory = entry.trim().replace(/^"|"$/g, "");
    if (directory) candidates.push(path.join(directory, "wsl.exe"));
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const key = path.normalize(candidate).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // 不存在 / 不可访问 → 试下一个
    }
  }
  return null;
}

/** 解码 wsl.exe 文本输出：含 UTF-16LE BOM 或大量 NUL 字节时按 UTF-16LE，否则 UTF-8。 */
export function decodeWslText(buffer: Buffer): string {
  if (buffer.length === 0) return "";
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString("utf16le");
  }
  const sample = Math.min(buffer.length, 512);
  let zeros = 0;
  for (let i = 0; i < sample; i++) {
    if (buffer[i] === 0) zeros++;
  }
  return zeros > sample / 4 ? buffer.toString("utf16le") : buffer.toString("utf8");
}

/** 解析 `wsl -l -q` 输出为发行版名列表（去 BOM/NUL/空行/首尾空白）。 */
export function parseWslDistroList(text: string): string[] {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * 枚举已安装发行版。失败/超时/未安装一律返回空列表（调用方据此判 WSL_UNAVAILABLE）。
 *
 * @param args 仅测试注入用；生产固定 `-l -q`
 */
export function listWslDistros(
  executable: string,
  timeoutMs: number = WSL_PROBE_TIMEOUT_MS,
  args: string[] = ["-l", "-q"],
): Promise<string[]> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (value: string[]) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    let child: ChildProcess;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish([]);
      return;
    }

    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.on("error", () => finish([]));
    child.on("close", () => finish(parseWslDistroList(decodeWslText(Buffer.concat(chunks)))));
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出则忽略 */ }
      finish([]);
    }, timeoutMs);
  });
}

// ── 探测缓存 ────────────────────────────────────────────
// 关闭态零开销：调用方（设置页/首次 shell:wsl）主动探测时才 spawn，结果缓存 30s。
let discoveryCache: { executable: string; distros: string[]; at: number } | null = null;

/** 探测 WSL：定位 wsl.exe 并枚举发行版，带短 TTL 缓存。 */
export async function discoverWsl(timeoutMs: number = WSL_PROBE_TIMEOUT_MS): Promise<WslDiscovery> {
  const executable = resolveWslExecutablePath();
  if (!executable) return { executable: null, distros: [] };

  const now = Date.now();
  if (
    discoveryCache
    && discoveryCache.executable === executable
    && now - discoveryCache.at < WSL_DISCOVERY_CACHE_TTL_MS
  ) {
    return { executable, distros: discoveryCache.distros };
  }

  const distros = await listWslDistros(executable, timeoutMs);
  discoveryCache = { executable, distros, at: Date.now() };
  return { executable, distros };
}

/** 清空探测缓存（设置变更/测试用）。 */
export function resetWslDiscoveryCache(): void {
  discoveryCache = null;
}

/**
 * 解析 WSL 执行器。找不到 wsl.exe 返回 null（→ WSL_UNAVAILABLE）。
 * distro 为空 = 使用 WSL 自身配置的默认发行版（调用参数不带 -d）。
 */
export async function resolveWslExecutable(distro?: string | null): Promise<ResolvedWslExecutable | null> {
  const { executable } = await discoverWsl();
  if (!executable) return null;
  const name = typeof distro === "string" ? distro.trim() : "";
  return { kind: "wsl", executable, distro: name || null };
}

/**
 * Windows 路径 → WSL 路径（`D:\code` → `/mnt/d/code`）。
 * - UNC（`\\server\share`）无法挂载 → null（调用方返回 WSL_PATH_UNSUPPORTED）
 * - 已是 POSIX 绝对路径 → 原样返回
 * - 其它（相对路径/空）→ null
 */
export function windowsPathToWslPath(winPath: string): string | null {
  if (!winPath) return null;
  const value = winPath.trim();
  if (!value) return null;
  if (/^[\\/]{2}/.test(value)) return null; // UNC
  if (value.startsWith("/")) return value; // 已是 POSIX 绝对路径
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(value);
  if (!match) return null;
  const drive = match[1].toLowerCase();
  const rest = match[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/** POSIX 单引号转义：仅用于把工作目录拼进脚本；命令本体走 base64 不经引号层。 */
export function posixSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * 构造 Windows 侧 spawn 规格：`wsl.exe [-d <distro>] -e bash -lc "echo <base64> | base64 -d | bash"`。
 *
 * 命令经 UTF-8 base64 直通，Windows 命令行→wsl.exe→bash 之间不发生引号/转义解析，
 * 从根上避免注入。工作目录（WSL 路径）以单引号拼进脚本首部 `cd`。
 */
export function buildWslInvocation(
  resolved: ResolvedWslExecutable,
  command: string,
  wslCwd?: string | null,
): WslInvocation {
  const script = wslCwd ? `cd -- ${posixSingleQuote(wslCwd)} && ${command}` : command;
  const encoded = Buffer.from(script, "utf8").toString("base64");
  const args: string[] = [];
  if (resolved.distro) args.push("-d", resolved.distro);
  args.push("-e", "bash", "-lc", `echo ${encoded} | base64 -d | bash`);
  return {
    command: resolved.executable,
    args,
    windowsVerbatimArguments: false,
  };
}
