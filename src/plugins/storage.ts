import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolvePluginStorageQuotaMb } from "./limits";
import type { PluginStorage } from "./types";

const KEY_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** 达到配额的该比例时告警一次。 */
const QUOTA_WARN_RATIO = 0.8;

export interface PluginStorageOptions {
  /** 配额字节数；0 = 不限。缺省按 limits.ts 解析（设置 > 环境变量 > 64 MiB）。 */
  quotaBytes?: number;
}

/**
 * 每个 key 一个 JSON 文件：<rootDir>/<key>.json。
 *
 * 配额是软限制：只约束经本 API 的写入，插件直接写文件系统不受限制
 * （Node 插件与宿主同进程，没有真正的磁盘隔离）；目的是防手滑与无界增长。
 */
export function createPluginStorage(rootDir: string, options: PluginStorageOptions = {}): PluginStorage {
  mkdirSync(rootDir, { recursive: true });
  const quotaBytes = options.quotaBytes ?? resolvePluginStorageQuotaMb() * 1024 * 1024;
  const fileFor = (key: string): string => path.join(rootDir, `${key}.json`);
  const assertKey = (key: string): void => {
    if (!KEY_RE.test(key)) {
      throw new Error(`非法存储 key: ${key}`);
    }
  };

  // 用量惰性初始化（首次写入时统计目录内 .json 总大小），之后按写入增量维护。
  let usedBytes: number | null = null;
  let quotaWarned = false;

  function ensureUsedBytes(): number {
    if (usedBytes !== null) return usedBytes;
    let total = 0;
    try {
      for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          total += statSync(path.join(rootDir, entry.name)).size;
        } catch {
          // 并发删除/不可读：不为统计失败阻塞写入
        }
      }
    } catch {
      total = 0;
    }
    usedBytes = total;
    return total;
  }

  function assertWithinQuota(nextBytes: number, key: string): void {
    if (quotaBytes <= 0) return;
    if (nextBytes > quotaBytes) {
      throw new Error(
        `插件存储超出配额（${Math.floor(quotaBytes / 1024 / 1024)} MiB），写入被拒绝: ${key}。`
        + "可在插件管理窗「设置」调整配额",
      );
    }
    if (!quotaWarned && nextBytes > quotaBytes * QUOTA_WARN_RATIO) {
      quotaWarned = true;
      console.warn(`[plugins] 插件存储已使用 ${(nextBytes / 1024 / 1024).toFixed(1)} MiB，接近配额上限`);
    }
  }

  function existingFileBytes(p: string): number {
    try {
      return existsSync(p) ? statSync(p).size : 0;
    } catch {
      return 0;
    }
  }

  return {
    get<T>(key: string): T | undefined {
      assertKey(key);
      const p = fileFor(key);
      if (!existsSync(p)) return undefined;
      try {
        return JSON.parse(readFileSync(p, "utf8")) as T;
      } catch {
        return undefined;
      }
    },
    set<T>(key: string, value: T): void {
      assertKey(key);
      const p = fileFor(key);
      const data = JSON.stringify(value, null, 2);
      const bytes = Buffer.byteLength(data, "utf8");
      const nextBytes = ensureUsedBytes() + bytes - existingFileBytes(p);
      assertWithinQuota(nextBytes, key);
      // 原子写：先写临时文件再 rename，避免崩溃导致 JSON 损坏
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, data, "utf8");
      renameSync(tmp, p);
      usedBytes = nextBytes;
    },
    rootDir: () => rootDir,
  };
}
