/**
 * .NET 下沉统一双轨开关解析器（阶段 0，B4/L17 共用）。
 *
 * 优先级：环境变量 > ./config/cyrene.conf > 默认值。
 * ./config 路径解析：app 根（开发期 app.getAppPath()，打包后
 * process.resourcesPath 的上一级——即 exe 旁边），便携模式强约束见 L1。
 *
 * 所有 CYRENE_* 开关唯一读入口——禁止散落各处 process.env 直读。
 */

export type VadMode = "local" | "hybrid" | "cloud";

export interface DotnetBackendConfig {
  toolHost: boolean;
  agentHost: boolean;
  loopHost: boolean;
  ragHost: boolean;
  memoryHost: boolean;
  voiceHost: boolean;
  portable: boolean;
  mcpHttp: boolean;
  vad: VadMode;
}

const DEFAULTS: DotnetBackendConfig = {
  toolHost: true,
  agentHost: false,
  loopHost: false,
  ragHost: false,
  memoryHost: false,
  voiceHost: false,
  portable: false,
  mcpHttp: false,
  vad: "hybrid",
};

const BOOL_KEYS: Record<keyof DotnetBackendConfig, string> = {
  toolHost: "CYRENE_TOOL_HOST",
  agentHost: "CYRENE_AGENT_HOST",
  loopHost: "CYRENE_LOOP_HOST",
  ragHost: "CYRENE_RAG_HOST",
  memoryHost: "CYRENE_MEMORY_HOST",
  voiceHost: "CYRENE_VOICE_HOST",
  portable: "CYRENE_PORTABLE",
  mcpHttp: "CYRENE_MCP_HTTP",
  vad: "CYRENE_VAD",
};

/** conf 文件解析（KEY=VALUE，# 注释，空白容错）。包内导出供测试。 */
export function parseConfFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

function toBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "on";
}

/** 解析入口。sources 注入便于测试：[env, confText]。 */
export function resolveDotnetConfigFrom(
  env: Record<string, string | undefined>,
  confText: string | null,
): DotnetBackendConfig {
  const conf = confText ? parseConfFile(confText) : {};
  const read = (key: string): string | undefined => env[key] ?? conf[key];
  const cfg: DotnetBackendConfig = { ...DEFAULTS };
  for (const k of Object.keys(BOOL_KEYS) as Array<keyof DotnetBackendConfig>) {
    const raw = read(BOOL_KEYS[k]);
    if (k === "vad") {
      cfg.vad = raw === "local" || raw === "hybrid" || raw === "cloud" ? raw : DEFAULTS.vad;
    } else {
      cfg[k] = toBool(raw, DEFAULTS[k] as boolean) as never;
    }
  }
  return cfg;
}

let appRootCache: string = "";
function appRoot(): string {
  if (appRootCache) return appRootCache;
  try {
    // Electron 环境：打包后 resources 的上级 = exe 目录；开发期 = 仓库根
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    appRootCache = electron.app?.isPackaged
      ? require("node:path").dirname(electron.process.resourcesPath)
      : electron.app.getAppPath();
  } catch {
    appRootCache = process.cwd();
  }
  return appRootCache;
}

/** 便携/常规共用的 conf 文件定位（L2：./config 优先）。 */
export function locateConfFile(): string | null {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const p = path.join(appRoot(), "config", "cyrene.conf");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null;
  } catch {
    return null;
  }
}

let cached: DotnetBackendConfig | null = null;

/** 生产入口（进程内缓存；测试用 resolveDotnetConfigFrom）。 */
export function resolveDotnetConfig(): DotnetBackendConfig {
  if (cached) return cached;
  cached = resolveDotnetConfigFrom(process.env as Record<string, string>, locateConfFile());
  return cached;
}

/** 测试后门。 */
export function resetDotnetConfigCache(): void {
  cached = null;
  appRootCache = "";
}
