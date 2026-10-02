/**
 * 插件运行时管理壳：常驻 IPC 与运行期启停。
 *
 * 背景：`pluginRuntimeEnabled` 默认关（省内存），但插件管理页/管理窗仍要能
 * 打开并展示「未启用」状态、启用（记忆/仅本次）与资源限制。此前这些通道只在
 * 运行时启动后才注册，React 插件页直接报 "No handler registered"。
 *
 * 本模块把「回退注册 + 正式注册」的条件互斥逻辑收在一处：
 *   - 运行时未启用：`PLUGINS_LIST` 注册空清单回退；
 *   - 启用时：先移除回退，再由 PluginManager.start() 注册正式实现；
 *   - 停用时：manager.stop() 注销其通道，再恢复回退。
 * 组合根只需提供 manager 引用、真实启动函数与设置读写。
 */

import { IPC } from "../shared/ipc-channels";
import type { IpcScope } from "../main/application/ipc-scope";
import type { PluginManager } from "./manager";
import {
  MAX_PLUGIN_MEMORY_LIMIT_MB,
  MAX_PLUGIN_STORAGE_QUOTA_MB,
  resolvePluginMemoryLimitMb,
  resolvePluginStorageQuotaMb,
} from "./limits";
import type { PluginOverview, PluginResourceLimits } from "../shared/plugin-management";

/** 组合根提供的窄依赖：全部惰性求值，避免在 shell 生命周期外捕获状态。 */
export interface PluginRuntimeShellDeps {
  /** ipc holder（shell 装配随应用生命周期，惰性取）。 */
  getIpc: () => IpcScope;
  getSettings: () => {
    pluginRuntimeEnabled?: boolean;
    pluginStorageQuotaMb?: number;
    pluginMemoryLimitMb?: number;
  };
  saveSettings: (patch: {
    pluginRuntimeEnabled?: boolean;
    pluginStorageQuotaMb?: number;
    pluginMemoryLimitMb?: number;
  }) => void;
  getManager: () => PluginManager | undefined;
  setManager: (manager: PluginManager | undefined) => void;
  /** 复用 core 阶段保存的实参真正启动运行时；未就绪返回 null。 */
  startRuntime: () => Promise<PluginManager | null>;
  /** 停用后清空市场服务引用（页面不再视为市场可用）。 */
  clearMarketService: () => void;
}

export interface PluginRuntimeShell {
  /** 常驻管理通道：状态查询 / 运行期启停 / 资源限制读写（幂等）。 */
  registerControlIpc(): void;
  /** 运行时未启用时的 `plugins:list` 回退（幂等）。 */
  registerListFallback(): void;
  enable(options?: { persist?: boolean }): Promise<{ ok: boolean; error?: string }>;
  disable(options?: { persist?: boolean }): Promise<{ ok: boolean; error?: string }>;
}

/** PluginManager.start() 注册的管理通道；启动失败时清理由 shell 兜底。 */
const MANAGER_CHANNELS = [
  IPC.PLUGINS_LIST,
  IPC.PLUGINS_SET_ENABLED,
  IPC.PLUGINS_OPEN,
  IPC.PLUGINS_RESCAN,
  IPC.PLUGINS_IMPORT_ZIP,
  IPC.PLUGINS_UNINSTALL,
] as const;

/** startPluginRuntime 直接注册的市场/面板通道；停用时 manager.stop() 不会清理。 */
const RUNTIME_SIDE_CHANNELS = [
  IPC.PLUGINS_MARKET_LIST,
  IPC.PLUGINS_MARKET_DETAILS,
  IPC.PLUGINS_MARKET_INSTALL,
  IPC.PLUGINS_PANEL_INVOKE,
] as const;

/** 与组合根 clampInt 同口径：只接受数字，四舍五入后钳制到 [0, max]。 */
function clampLimit(value: unknown, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(max, Math.round(value)));
}

export function createPluginRuntimeShell(deps: PluginRuntimeShellDeps): PluginRuntimeShell {
  let listFallbackRegistered = false;
  let controlIpcRegistered = false;

  const readLimits = (): PluginResourceLimits => {
    const settings = deps.getSettings();
    return {
      storageQuotaMb: resolvePluginStorageQuotaMb(settings.pluginStorageQuotaMb),
      memoryLimitMb: resolvePluginMemoryLimitMb(settings.pluginMemoryLimitMb),
      storageQuotaConfigured: typeof settings.pluginStorageQuotaMb === "number",
      memoryLimitConfigured: typeof settings.pluginMemoryLimitMb === "number",
    };
  };

  const registerListFallback = (): void => {
    if (listFallbackRegistered) return;
    deps.getIpc().handle(IPC.PLUGINS_LIST, (): PluginOverview => ({ plugins: [], issues: [] }));
    listFallbackRegistered = true;
  };

  const removeListFallback = (): void => {
    if (!listFallbackRegistered) return;
    deps.getIpc().removeHandler(IPC.PLUGINS_LIST);
    listFallbackRegistered = false;
  };

  const enable = async (options: { persist?: boolean } = {}): Promise<{ ok: boolean; error?: string }> => {
    if (options.persist !== false) deps.saveSettings({ pluginRuntimeEnabled: true });
    if (deps.getManager()) return { ok: true };
    removeListFallback();
    try {
      const manager = await deps.startRuntime();
      if (!manager) {
        registerListFallback();
        return { ok: false, error: "插件系统尚未完成初始化，暂不能启用" };
      }
      deps.setManager(manager);
      return { ok: true };
    } catch (error) {
      // 启动失败：清掉可能已注册一半的管理通道，恢复回退，保证页面仍可打开
      if (!deps.getManager()) {
        for (const channel of MANAGER_CHANNELS) {
          try { deps.getIpc().removeHandler(channel); } catch { /* ignore */ }
        }
        registerListFallback();
      }
      return {
        ok: false,
        error: `启用插件运行时失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const disable = async (options: { persist?: boolean } = {}): Promise<{ ok: boolean; error?: string }> => {
    if (options.persist !== false) deps.saveSettings({ pluginRuntimeEnabled: false });
    const manager = deps.getManager();
    if (manager) {
      try {
        await manager.stop();
      } finally {
        deps.setManager(undefined);
      }
    }
    for (const channel of RUNTIME_SIDE_CHANNELS) {
      try {
        deps.getIpc().removeHandler(channel);
      } catch (error) {
        console.warn(`[plugins] 运行期停用清理通道 ${channel} 失败:`, error);
      }
    }
    deps.clearMarketService();
    registerListFallback();
    return { ok: true };
  };

  const registerControlIpc = (): void => {
    if (controlIpcRegistered) return;
    controlIpcRegistered = true;
    deps.getIpc().handle(IPC.PLUGINS_GET_RUNTIME_STATE, () => ({
      active: Boolean(deps.getManager()),
      persisted: deps.getSettings().pluginRuntimeEnabled === true,
    }));
    deps.getIpc().handle(
      IPC.PLUGINS_SET_RUNTIME_ENABLED,
      async (_event: unknown, enabled: unknown, options: unknown) => {
        if (typeof enabled !== "boolean") return { ok: false, error: "enabled 必须是布尔值" };
        const persist = !(
          typeof options === "object" && options !== null
          && (options as { persist?: unknown }).persist === false
        );
        return enabled ? enable({ persist }) : disable({ persist });
      },
    );
    deps.getIpc().handle(IPC.PLUGINS_GET_LIMITS, () => readLimits());
    deps.getIpc().handle(IPC.PLUGINS_SET_LIMITS, (_event: unknown, input: unknown) => {
      const payload = (typeof input === "object" && input !== null ? input : {}) as {
        storageQuotaMb?: unknown;
        memoryLimitMb?: unknown;
      };
      const storage = clampLimit(payload.storageQuotaMb, MAX_PLUGIN_STORAGE_QUOTA_MB);
      const memory = clampLimit(payload.memoryLimitMb, MAX_PLUGIN_MEMORY_LIMIT_MB);
      if (storage === null || memory === null) {
        return {
          ok: false,
          error: `资源限制参数非法：存储 0-${MAX_PLUGIN_STORAGE_QUOTA_MB}`
            + ` / 内存 0-${MAX_PLUGIN_MEMORY_LIMIT_MB}（MiB 整数）`,
        };
      }
      deps.saveSettings({ pluginStorageQuotaMb: storage, pluginMemoryLimitMb: memory });
      return { ok: true, limits: readLimits() };
    });
  };

  return { registerControlIpc, registerListFallback, enable, disable };
}
