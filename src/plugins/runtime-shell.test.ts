import { describe, expect, it, vi } from "vitest";
import { IPC } from "../shared/ipc-channels";
import type { IpcScope } from "../main/application/ipc-scope";
import type { PluginManager } from "./manager";
import { createPluginRuntimeShell } from "./runtime-shell";

/** 记录注册/注销的假 IpcScope：重复注册抛错，与 createIpcScope 语义一致。 */
class FakeIpc implements IpcScope {
  handlers = new Map<string, (...args: any[]) => unknown>();
  removed: string[] = [];

  handle(channel: string, listener: (...args: any[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`IPC channel already registered: ${channel}`);
    this.handlers.set(channel, listener);
  }

  removeHandler(channel: string): void {
    this.removed.push(channel);
    this.handlers.delete(channel);
  }

  on(): void { /* 本测试不涉及 */ }

  dispose(): void { /* 本测试不涉及 */ }
}

function fakeManager(): PluginManager {
  return { stop: vi.fn(async () => undefined) } as unknown as PluginManager;
}

function makeHarness(options: {
  settings?: { pluginRuntimeEnabled?: boolean; pluginStorageQuotaMb?: number; pluginMemoryLimitMb?: number };
  startRuntime?: () => Promise<PluginManager | null>;
  manager?: PluginManager;
} = {}) {
  const ipc = new FakeIpc();
  const settings = { ...options.settings };
  const savedPatches: Array<Record<string, unknown>> = [];
  let manager = options.manager;
  const clearMarketService = vi.fn();
  const startRuntime = vi.fn(options.startRuntime ?? (async () => manager ?? null));
  const shell = createPluginRuntimeShell({
    getIpc: () => ipc,
    getSettings: () => settings,
    saveSettings: (patch) => {
      savedPatches.push(patch);
      Object.assign(settings, patch);
    },
    getManager: () => manager,
    setManager: (next) => { manager = next; },
    startRuntime,
    clearMarketService,
  });
  return { ipc, shell, savedPatches, settings, clearMarketService, startRuntime, getManager: () => manager };
}

describe("插件运行时管理壳", () => {
  it("常驻注册控制通道（状态/启停/资源限制）且幂等", () => {
    const { ipc, shell } = makeHarness();
    shell.registerControlIpc();
    shell.registerControlIpc();

    expect([...ipc.handlers.keys()].sort()).toEqual([
      IPC.PLUGINS_GET_LIMITS,
      IPC.PLUGINS_GET_RUNTIME_STATE,
      IPC.PLUGINS_SET_LIMITS,
      IPC.PLUGINS_SET_RUNTIME_ENABLED,
    ].sort());
  });

  it("列表回退返回空清单（运行时未启用时管理页可打开）", () => {
    const { ipc, shell } = makeHarness();
    shell.registerListFallback();
    shell.registerListFallback();

    const handler = ipc.handlers.get(IPC.PLUGINS_LIST);
    expect(handler?.()).toEqual({ plugins: [], issues: [] });
  });

  it("默认启用（persist）会写回设置并移除列表回退", async () => {
    const manager = fakeManager();
    const harness = makeHarness({ startRuntime: async () => manager });
    harness.shell.registerControlIpc();
    harness.shell.registerListFallback();

    const result = await harness.shell.enable();

    expect(result).toEqual({ ok: true });
    expect(harness.savedPatches).toContainEqual({ pluginRuntimeEnabled: true });
    expect(harness.ipc.removed).toContain(IPC.PLUGINS_LIST);
    expect(harness.getManager()).toBe(manager);
    const state = harness.ipc.handlers.get(IPC.PLUGINS_GET_RUNTIME_STATE)?.();
    expect(state).toEqual({ active: true, persisted: true });
  });

  it("仅本次启用（persist=false）不写回设置；未就绪时返回错误并恢复回退", async () => {
    const harness = makeHarness({ startRuntime: async () => null });
    harness.shell.registerListFallback();

    const result = await harness.shell.enable({ persist: false });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("尚未完成初始化");
    expect(harness.savedPatches).toEqual([]);
    expect(harness.ipc.handlers.has(IPC.PLUGINS_LIST)).toBe(true);
  });

  it("启动抛错时清理管理通道并恢复回退，错误如实返回", async () => {
    const harness = makeHarness({
      startRuntime: async () => { throw new Error("boom"); },
    });
    harness.shell.registerListFallback();

    const result = await harness.shell.enable();

    expect(result).toEqual({ ok: false, error: "启用插件运行时失败：boom" });
    for (const channel of [
      IPC.PLUGINS_LIST,
      IPC.PLUGINS_SET_ENABLED,
      IPC.PLUGINS_OPEN,
      IPC.PLUGINS_RESCAN,
      IPC.PLUGINS_IMPORT_ZIP,
      IPC.PLUGINS_UNINSTALL,
    ]) {
      expect(harness.ipc.removed).toContain(channel);
    }
    expect(harness.ipc.handlers.has(IPC.PLUGINS_LIST)).toBe(true);
  });

  it("停用会保存状态、停止 manager、清理市场/面板通道并恢复回退", async () => {
    const manager = fakeManager();
    const harness = makeHarness({ startRuntime: async () => manager });
    await harness.shell.enable();

    const result = await harness.shell.disable();

    expect(result).toEqual({ ok: true });
    expect(manager.stop).toHaveBeenCalledTimes(1);
    expect(harness.getManager()).toBeUndefined();
    expect(harness.savedPatches).toContainEqual({ pluginRuntimeEnabled: false });
    for (const channel of [
      IPC.PLUGINS_MARKET_LIST,
      IPC.PLUGINS_MARKET_DETAILS,
      IPC.PLUGINS_MARKET_INSTALL,
      IPC.PLUGINS_PANEL_INVOKE,
    ]) {
      expect(harness.ipc.removed).toContain(channel);
    }
    expect(harness.clearMarketService).toHaveBeenCalledTimes(1);
    expect(harness.ipc.handlers.get(IPC.PLUGINS_LIST)?.()).toEqual({ plugins: [], issues: [] });
  });

  it("set-runtime-enabled 通道校验参数并按 persist 选项转发", async () => {
    const manager = fakeManager();
    const harness = makeHarness({ startRuntime: async () => manager });
    harness.shell.registerControlIpc();
    const handler = harness.ipc.handlers.get(IPC.PLUGINS_SET_RUNTIME_ENABLED)!;

    expect(await handler({}, "yes")).toEqual({ ok: false, error: "enabled 必须是布尔值" });

    const enabled = await handler({}, true, { persist: false });
    expect(enabled).toEqual({ ok: true });
    expect(harness.savedPatches).toEqual([]);
    expect(harness.getManager()).toBe(manager);

    const disabled = await handler({}, false);
    expect(disabled).toEqual({ ok: true });
    expect(harness.savedPatches).toContainEqual({ pluginRuntimeEnabled: false });
  });

  it("资源限制读取生效值；写入按钳制口径保存并回读", () => {
    const harness = makeHarness({
      settings: { pluginStorageQuotaMb: 128, pluginMemoryLimitMb: undefined },
    });
    harness.shell.registerControlIpc();
    const getHandler = harness.ipc.handlers.get(IPC.PLUGINS_GET_LIMITS)!;
    const setHandler = harness.ipc.handlers.get(IPC.PLUGINS_SET_LIMITS)!;

    expect(getHandler()).toEqual({
      storageQuotaMb: 128,
      memoryLimitMb: 2048,
      storageQuotaConfigured: true,
      memoryLimitConfigured: false,
    });

    const invalid = setHandler({}, { storageQuotaMb: "128", memoryLimitMb: 64 });
    expect(invalid.ok).toBe(false);

    const saved = setHandler({}, { storageQuotaMb: 128.6, memoryLimitMb: -3 });
    expect(saved).toEqual({
      ok: true,
      limits: {
        storageQuotaMb: 129,
        memoryLimitMb: 0,
        storageQuotaConfigured: true,
        memoryLimitConfigured: true,
      },
    });
  });
});
