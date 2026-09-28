/**
 * 打包版日志落盘（file log sink）。
 *
 * 背景：打包后的 Electron 主进程 stdout/stderr 在用户机器上默认不可见
 * （还可能断管，见 21388fe），出 bug 时用户无从排查、issue 也无法附日志。
 * 这里把 logger 输出同步落盘到 userData/logs/cyrene.log，单文件超过上限后
 * 滚动（保留 MAX_FILES 份），用户/issue 上报可直接附上日志文件。
 *
 * 设计：
 *  - 本模块不依赖 electron，日志目录由调用方注入（src/main/logger.ts 用
 *    app.getPath("userData")），便于单测。
 *  - 同步 appendFileSync：主进程日志量级很小，简单可靠胜过流式状态管理。
 *  - 磁盘错误静默吞掉：日志系统自身故障不能反过来干扰业务。
 */
import fs from "node:fs";
import path from "node:path";
import { addLogSink, type LogEntry } from "../shared/logger";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB / 份
const MAX_FILES = 3; // cyrene.log / cyrene.log.1 / cyrene.log.2

/** 时间戳格式化：2026-09-01 09:32:24.123 */
export function formatTs(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  );
}

/**
 * 轮转：当前文件超过上限时，.2 ← .1 ← 当前，并新开当前文件。
 * 文件不存在视为无需轮转。
 */
export function rotateIfNeeded(logPath: string, maxBytes = DEFAULT_MAX_BYTES): void {
  try {
    const st = fs.statSync(logPath);
    if (st.size < maxBytes) return;
  } catch {
    return; // 不存在或 stat 失败：无需轮转
  }
  for (let i = MAX_FILES - 2; i >= 1; i--) {
    const from = `${logPath}.${i}`;
    const to = `${logPath}.${i + 1}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // 源不存在：跳过
    }
  }
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // 忽略：极端情况（占用等）下放弃本轮轮转
  }
}

/** 创建文件落盘接收器。maxBytes 可注入以便测试轮转。 */
export function createFileLogSink(
  logPath: string,
  maxBytes = DEFAULT_MAX_BYTES,
): (entry: LogEntry) => void {
  return (entry: LogEntry): void => {
    const line = `${formatTs(entry.ts)} ${entry.line}\n`;
    try {
      rotateIfNeeded(logPath, maxBytes);
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // 磁盘/权限错误：静默，日志系统不能反过来报错
    }
  };
}

/**
 * 安装文件落盘接收器（主进程启动时调用一次）。
 * @param userDataDir Electron app.getPath("userData") 的结果
 * @param maxBytes 单文件滚动阈值，测试可注入小值触发真实轮转链路
 * @returns 卸载函数（测试用）
 */
export function installFileLogSink(
  userDataDir: string,
  maxBytes = DEFAULT_MAX_BYTES,
): () => void {
  const dir = path.join(userDataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  return addLogSink(createFileLogSink(path.join(dir, "cyrene.log"), maxBytes));
}

const CONSOLE_METHODS: Array<{ method: string; level: "info" | "warn" | "error" }> = [
  { method: "log", level: "info" },
  { method: "info", level: "info" },
  { method: "debug", level: "info" },
  { method: "warn", level: "warn" },
  { method: "error", level: "error" },
];

/**
 * 把 console.* 输出镜像到 <userData>/logs/cyrene.log（与 logger sink 同文件、同滚动策略）。
 *
 * 默认不开启，只有排障时用 CYRENE_DEBUG_LOGS=1 打开（见 src/main/logger.ts）：
 * 主进程大量诊断走 console.*，不镜像的话打包版几乎不留痕。
 * 注意：shared logger 走 process.stdout.write，不经过 console，因此不会与
 * logger sink 重复落盘。
 *
 * @returns 卸载函数（恢复原始 console 方法；测试用）
 */
export function installConsoleFileMirror(
  userDataDir: string,
  maxBytes = DEFAULT_MAX_BYTES,
): () => void {
  const dir = path.join(userDataDir, "logs");
  fs.mkdirSync(dir, { recursive: true });
  const sink = createFileLogSink(path.join(dir, "cyrene.log"), maxBytes);
  const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>;
  const originals: Array<{ method: string; original: (...args: unknown[]) => void }> = [];

  for (const { method, level } of CONSOLE_METHODS) {
    const original = consoleRecord[method];
    if (typeof original !== "function") continue;
    originals.push({ method, original });
    consoleRecord[method] = (...args: unknown[]): void => {
      try {
        const message = args.map(formatConsoleArg).join(" ");
        sink({ ts: Date.now(), level, tag: "console", message, line: `[console] ${message}` });
      } catch {
        // 镜像失败不影响原始输出
      }
      original.apply(console, args);
    };
  }

  return () => {
    for (const { method, original } of originals) consoleRecord[method] = original;
  };
}

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}
