/**
 * 主进程 IPC 注册 Scope：统一登记 handle/on 注册并在 dispose() 时整体注销。
 * - 同一 scope 内重复注册同一 channel 直接报错，避免重复注册污染。
 * - dispose() 幂等，按注册的逆序移除（仅为注销顺序，与退出清理阶段无关）。
 */

import { ipcMain } from "electron";

export interface IpcScope {
  handle(channel: string, listener: (...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (...args: any[]) => void): void;
  dispose(): void;
}

export interface IpcScopeMainLike {
  handle(channel: string, listener: (...args: any[]) => unknown): unknown;
  on(channel: string, listener: (...args: any[]) => void): unknown;
  removeHandler(channel: string): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}

type TrackedRegistration =
  | { kind: "handle"; channel: string; listener: (...args: any[]) => unknown }
  | { kind: "on"; channel: string; listener: (...args: any[]) => void };

export function createIpcScope(main: IpcScopeMainLike = ipcMain as IpcScopeMainLike): IpcScope {
  const registrations: TrackedRegistration[] = [];
  const handledChannels = new Set<string>();
  let disposed = false;

  function assertActive(): void {
    if (disposed) {
      throw new Error("IPC scope already disposed");
    }
  }

  return {
    handle(channel, listener) {
      assertActive();
      if (handledChannels.has(channel)) {
        throw new Error(`IPC channel already registered: ${channel}`);
      }
      handledChannels.add(channel);
      registrations.push({ kind: "handle", channel, listener });
      main.handle(channel, listener);
    },

    removeHandler(channel) {
      assertActive();
      if (!handledChannels.delete(channel)) return;
      const index = registrations.findIndex(
        (registration) => registration.kind === "handle" && registration.channel === channel,
      );
      if (index >= 0) registrations.splice(index, 1);
      main.removeHandler(channel);
    },

    on(channel, listener) {
      assertActive();
      // PR19 复审3 P1-1：ipcMain.on 同步监听器异常会升级为主进程未捕获异常
      //（Electron 默认错误框/异常），全仓无全局 uncaughtException 兜底。这里统一
      // 捕获同步异常并告警（可观察、不崩主进程）；async 监听器的 rejection 不在
      // 同步 try/catch 范围（由各自 async 调用方处理）。
      const guarded = (...args: any[]): void => {
        try {
          listener(...args);
        } catch (error) {
          console.warn(`[IpcScope] on ${channel} 监听器同步异常（已捕获，不冒泡）:`, error);
        }
      };
      registrations.push({ kind: "on", channel, listener: guarded });
      main.on(channel, guarded);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      // 逆序移除：后注册的先注销，保持与注册路径一致的对称性。
      for (const registration of registrations.reverse()) {
        try {
          if (registration.kind === "handle") main.removeHandler(registration.channel);
          else main.removeListener(registration.channel, registration.listener);
        } catch (error) {
          console.error(`[IpcScope] dispose failed for ${registration.kind} ${registration.channel}:`, error);
        }
      }
      registrations.length = 0;
      handledChannels.clear();
    },
  };
}
