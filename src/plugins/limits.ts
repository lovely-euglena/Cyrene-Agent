/**
 * 插件资源限制的默认值与解析，优先级：设置页配置 > 环境变量 > 内置默认。
 *
 * 这些是“防无限吃资源”的软限制：存储配额只约束走插件存储 API 的写入，
 * .NET 内存上限由宿主看门狗执行；两者都不构成对恶意插件的安全边界。
 */
export const DEFAULT_PLUGIN_STORAGE_QUOTA_MB = 64;
export const DEFAULT_PLUGIN_MEMORY_LIMIT_MB = 2048;

/** 设置页允许配置的上限（防误填）。 */
export const MAX_PLUGIN_STORAGE_QUOTA_MB = 10 * 1024;
export const MAX_PLUGIN_MEMORY_LIMIT_MB = 64 * 1024;

export const PLUGIN_STORAGE_QUOTA_ENV = "CYRENE_PLUGIN_STORAGE_QUOTA_MB";
export const PLUGIN_MEMORY_LIMIT_ENV = "CYRENE_PLUGIN_MEMORY_LIMIT_MB";

function resolveEnvMb(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
}

function normalizeConfigured(value: number): number {
  return Math.max(0, Math.floor(value));
}

/** 生效的单插件存储配额（MiB）；0 = 不限。 */
export function resolvePluginStorageQuotaMb(configured?: number): number {
  if (typeof configured === "number") return normalizeConfigured(configured);
  return resolveEnvMb(PLUGIN_STORAGE_QUOTA_ENV) ?? DEFAULT_PLUGIN_STORAGE_QUOTA_MB;
}

/** 生效的 .NET 插件进程内存上限（MiB）；0 = 不限。 */
export function resolvePluginMemoryLimitMb(configured?: number): number {
  if (typeof configured === "number") return normalizeConfigured(configured);
  return resolveEnvMb(PLUGIN_MEMORY_LIMIT_ENV) ?? DEFAULT_PLUGIN_MEMORY_LIMIT_MB;
}
