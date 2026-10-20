/**
 * 浏览器广告拦截服务（#143）——@ghostery/adblocker-electron 装配层。
 *
 * 设计（调研结论见 issue #143，API 面已按 v2.20.1 d.ts 核实）：
 * - 引擎：ElectronBlocker.fromPrebuiltAdsAndTracking（uBlock/EasyList 兼容），
 *   装在浏览器面板的 partition session 上，全部 tab 自动生效
 * - 引擎缓存：fromPrebuilt 自带 Caching（序列化到 userData），启动快
 * - 白名单：ABP 例外语法（@@||domain^$document）parse 成独立引擎，
 *   与预编译引擎 `FiltersEngine.merge` 合并——标准语法，不碰私有 API
 * - 设置热应用：applyConfig 由设置保存链路调用（enabled/allowlist 变化
 *   → disable 旧引擎 → 装配新引擎 → enable），无需重启
 * - 回退：预编译拉取失败时回退磁盘旧缓存；全失败则无拦截继续（不阻塞浏览器）
 * - 纯函数（allowlist 解析/例外规则文本）单独导出供测试
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, LogTag } from "../logger";

/** 引擎缓存新鲜期：7 天，过期重新拉预编译快照（caching 读写仍走同一路径）。 */
const ENGINE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AdblockEngine {
  enableBlockingInSession(session: unknown): void;
  disableBlockingInSession(session: unknown): void;
}

export interface AdblockCaching {
  path: string;
  read: (path: string) => Promise<Buffer>;
  write: (path: string, data: Buffer) => Promise<void>;
}

export interface AdblockDeps {
  loadPrebuilt: (caching?: AdblockCaching) => Promise<AdblockEngine>;
  /** 解析 ABP 例外规则文本（@@||host^$document）为引擎 */
  parseRules: (filtersText: string) => AdblockEngine;
  mergeEngines: (engines: AdblockEngine[]) => AdblockEngine;
  /** 反序列化磁盘缓存引擎（预编译拉取失败时的回退路径） */
  deserialize: (buffer: Buffer) => AdblockEngine;
  /** 引擎缓存文件路径（userData 下） */
  cachePath: string;
}

export interface AdblockConfig {
  enabled: boolean;
  /** 白名单域名（host 或其父域命中即放行） */
  allowlist: string[];
}

interface AdblockState {
  blocker: AdblockEngine | null;
  /** 当前已装配引擎对应的配置签名（enabled+allowlist），无变化不重复装配 */
  signature: string | null;
  session: unknown;
}

/** 白名单原始文本（逗号/换行分隔）→ 规整域名数组：去空/去协议路径/小写/去首尾点。 */
export function parseAllowlist(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    let host = part.trim().toLowerCase();
    if (!host) continue;
    host = host.replace(/^[a-z]+:\/\//, "").split("/")[0].replace(/^\.+|\.+$/g, "");
    if (host) out.add(host);
  }
  return [...out];
}

/** 白名单 → ABP 例外规则文本：@@||host^$document（整站放行，子域继承）。 */
export function buildAllowlistRulesText(allowlist: readonly string[]): string {
  return allowlist
    .map((host) => host.replace(/^\.+/, ""))
    .filter((host) => host.includes(".") || host !== "")
    .map((host) => `@@||${host}^$document`)
    .join("\n");
}

/** host 是否命中白名单（精确或父域）：用于设置页即时校验与测试。 */
export function isAllowlisted(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.+$/, "");
  if (!h) return false;
  return allowlist.some((entry) => {
    const e = entry.toLowerCase().replace(/\.+$/, "");
    return h === e || h.endsWith(`.${e}`);
  });
}

function signatureOf(config: AdblockConfig): string {
  return `${config.enabled}|${[...config.allowlist].sort().join(",")}`;
}

export function initAdblock(
  session: unknown,
  deps: AdblockDeps,
  getConfig: () => AdblockConfig,
): { applyConfig(): Promise<void>; dispose(): void } {
  const state: AdblockState = { blocker: null, signature: null, session };

  const applyConfig = async (): Promise<void> => {
    const config = getConfig();
    const signature = signatureOf(config);
    if (state.signature === signature) return;

    // 先停旧引擎（enabled/allowlist 变化都要重装）
    if (state.blocker) {
      try { state.blocker.disableBlockingInSession(state.session); } catch { /* 已销毁则忽略 */ }
      state.blocker = null;
      state.signature = null;
    }
    if (!config.enabled) {
      logger.info(LogTag.Browser, "[adblock] 已关闭");
      state.signature = signature;
      return;
    }
    try {
      const prebuilt = await deps.loadPrebuilt({
        path: deps.cachePath,
        read: (p) => fs.promises.readFile(p),
        write: (p, data) => fs.promises.writeFile(p, data),
      });
      const rulesText = buildAllowlistRulesText(config.allowlist);
      state.blocker = rulesText ? deps.mergeEngines([prebuilt, deps.parseRules(rulesText)]) : prebuilt;
      state.blocker.enableBlockingInSession(session);
      state.signature = signature;
      logger.info(LogTag.Browser, "[adblock] 引擎已启用（白名单", config.allowlist.length, "条）");
    } catch (err) {
      // 回退：预编译拉取失败时尝试磁盘旧缓存（deserialize）；再失败则无拦截继续
      logger.warn(LogTag.Browser, "[adblock] 引擎装配失败，尝试回退旧缓存:", err);
      try {
        const buffer = await fs.promises.readFile(deps.cachePath);
        state.blocker = deps.deserialize(buffer);
        state.blocker.enableBlockingInSession(session);
        state.signature = signature;
        logger.info(LogTag.Browser, "[adblock] 已回退到旧缓存引擎");
      } catch (fallbackErr) {
        logger.warn(LogTag.Browser, "[adblock] 引擎不可用（浏览器继续无拦截）:", fallbackErr);
        state.blocker = null;
        state.signature = signature;
      }
    }
  };

  return {
    applyConfig,
    dispose() {
      if (state.blocker) {
        try { state.blocker.disableBlockingInSession(state.session); } catch { /* 已销毁则忽略 */ }
        state.blocker = null;
      }
      state.signature = null;
    },
  };
}

/** settings 原始字段 → AdblockConfig（装配点用；测试锚定字段语义）。 */
export function loadAdblockConfig(raw: { adblockEnabled: boolean; adblockAllowlist: string }): AdblockConfig {
  return { enabled: raw.adblockEnabled, allowlist: parseAllowlist(raw.adblockAllowlist) };
}

/** 缓存文件路径约定（userData 下）。 */
export function adblockCachePath(userDataPath: string): string {
  return path.join(userDataPath, "adblock-engine.bin");
}

/** 缓存是否过期（mtime 超 7 天或不存在）——fromPrebuilt Caching 只管读写，
 * 过期判定由调用方在启动时做（过期则先删缓存文件强制重拉）。 */
export function isEngineCacheStale(cachePath: string, now = Date.now()): boolean {
  try {
    const mtime = fs.statSync(cachePath).mtimeMs;
    return now - mtime >= ENGINE_TTL_MS;
  } catch {
    return true;
  }
}

export function invalidateStaleEngineCache(cachePath: string, now = Date.now()): void {
  if (isEngineCacheStale(cachePath, now)) {
    try { fs.rmSync(cachePath, { force: true }); } catch { /* 不存在则忽略 */ }
  }
}
