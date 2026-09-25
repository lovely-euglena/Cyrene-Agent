/**
 * 主进程运行配置（统一解析入口）。
 *
 * 铁律：同一配置项只允许一个解析入口，取值优先级：
 *   环境变量 > ./config/cyrene.conf > 内置默认
 * 各模块禁止散读 process.env（历史 bug：`!== "0"` 把 "false"、"abc"
 * 都当启用）。
 */
import * as fs from "node:fs";
import * as path from "node:path";

/** .NET 侧运行开关（native 窗口 / agent-host 等）。 */
export interface DotnetConfig {
  /**
   * .NET agent-host 是否启用。
   * 来源：CYRENE_AGENT_HOST 环境变量 / conf `agentHost`；默认启用。
   */
  agentHost: boolean;
}

export const DOTNET_CONFIG_DEFAULTS: DotnetConfig = {
  agentHost: true,
};

/**
 * 宽松布尔解析：
 *   1/true/on/yes → true；0/false/off/no → false；其余（含非法串）→ fallback。
 */
export function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : fallback;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no") return false;
  return fallback;
}

const DEFAULT_CONF_PATH = path.resolve(process.cwd(), "config", "cyrene.conf");
const fileCache = new Map<string, Record<string, string>>();

/** 配置键归一：忽略大小写与 -/_ 分隔（agentHost / agent-host / agent_host 等价）。 */
function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[-_]/g, "");
}

/** 读取 key=value 配置文件（# / ; 注释，忽略空行与无等号行）；失败返回空表（不致命）。 */
function loadConfigFile(filePath: string): Record<string, string> {
  const cached = fileCache.get(filePath);
  if (cached) return cached;
  const out: Record<string, string> = {};
  try {
    if (fs.existsSync(filePath)) {
      for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith(";")) continue;
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        out[normalizeKey(line.slice(0, eq))] = line.slice(eq + 1).trim();
      }
    }
  } catch (err) {
    console.warn("[Config] 读取配置失败:", filePath, err instanceof Error ? err.message : err);
  }
  fileCache.set(filePath, out);
  return out;
}

/** 清空配置文件缓存（测试/配置热更新用）。 */
export function resetConfigCache(): void {
  fileCache.clear();
}

/**
 * 统一解析 .NET 运行配置（环境变量 > config/cyrene.conf > 默认）。
 * options.configPath 仅供测试注入；默认 ./config/cyrene.conf（进程 cwd）。
 */
export function resolveDotnetConfig(options?: { configPath?: string }): DotnetConfig {
  const file = loadConfigFile(options?.configPath ?? DEFAULT_CONF_PATH);
  const envRaw = process.env.CYRENE_AGENT_HOST;
  const raw = envRaw !== undefined && envRaw.trim() !== "" ? envRaw : file.agenthost;
  return {
    agentHost: raw === undefined
      ? DOTNET_CONFIG_DEFAULTS.agentHost
      : toBool(raw, DOTNET_CONFIG_DEFAULTS.agentHost),
  };
}
