/**
 * Main-process wrapper around the shared logger.
 *
 * Responsibilities on top of src/shared/logger.ts:
 *   - Apply the dev-vs-release default level (info when unpackaged, warn
 *     when packaged) by calling setLogLevel() at module init.
 *   - Re-export LogTag from the shared location so call sites can
 *     `import { LogTag } from "../logger"`.
 */
import { app } from "electron";
import { setLogLevel, type LogLevel } from "../shared/logger";
import { logger } from "../shared/logger";
import { installConsoleFileMirror, installFileLogSink } from "./log-sink-file";

/** CYRENE_DEBUG_LOGS=1：排障全量日志（logger 级别提到 debug + console.* 镜像落盘） */
const DEBUG_LOGS_ENABLED = process.env.CYRENE_DEBUG_LOGS === "1";

function resolveDefaultLevel(): LogLevel {
  // env wins
  const env = process.env.CYRENE_LOG_LEVEL?.toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  // 排障模式（CYRENE_DEBUG_LOGS=1）提级到 debug；否则 dev/release 默认 warn
  return DEBUG_LOGS_ENABLED ? "debug" : "warn";
}

setLogLevel(resolveDefaultLevel());

// 打包版 stdout 不可见：把日志同步落盘到 userData/logs/cyrene.log（滚动 3 份×5MB）。
// CYRENE_DEBUG_LOGS=1 时额外把 console.* 也镜像到同一文件（默认关，避免常驻双写）。
try {
  const userData = app.getPath("userData");
  installFileLogSink(userData);
  if (DEBUG_LOGS_ENABLED) installConsoleFileMirror(userData);
  if (DEBUG_LOGS_ENABLED) {
    // 排障模式启动清单：环境/开关/版本/日志路径——附日志时一眼看清运行配置
    logger.info("Runtime", "debug logs enabled", {
      logFile: `${userData}/logs/cyrene.log`,
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      packaged: app.isPackaged,
      flags: {
        nativeWindows: process.env.CYRENE_NATIVE_WINDOWS ?? "(default on)",
        detachedTray: process.env.CYRENE_DETACHED_TRAY ?? "(default on)",
        nativeAgentHost: process.env.CYRENE_AGENT_HOST ?? "(default on)",
        lazyChatWindow: process.env.CYRENE_LAZY_CHAT_WINDOW ?? "(default on)",
        lazyToastWindow: process.env.CYRENE_LAZY_TOAST_WINDOW ?? "(default on)",
        logLevel: process.env.CYRENE_LOG_LEVEL ?? "(auto=debug)",
      },
    });
  }
} catch {
  // userData 不可用时静默跳过，日志落盘只是增强项
}

export { logger, setLogLevel, LogTag } from "../shared/logger";
export type { LogLevel } from "../shared/logger";
