/**
 * 远程资源安全设置的渲染端订阅 store（#192）
 *
 * 聊天窗拉取一次 GeneralSettings 的安全字段 + 订阅保存广播（SETTINGS_GENERAL_CHANGED，
 * 由 settings-ipc 在 saveGeneral 后全窗广播）——白名单/开关变更即时生效，无需重启。
 * useSyncExternalStore 保证组件订阅范式合规（getSnapshot 稳定引用）。
 */

import { useSyncExternalStore } from "react";
import { DEFAULT_SECURITY_SETTINGS, normalizeSecuritySettings, type SecuritySettings } from "../../../../../shared/security-settings";

let current: SecuritySettings = DEFAULT_SECURITY_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

export async function loadSecuritySettingsOnce(): Promise<SecuritySettings> {
  if (loaded) return current;
  loaded = true;
  try {
    const raw = (await window.chat?.getGeneralSettings?.()) as { chatRemoteImageBlockEnabled?: boolean } | undefined;
    current = normalizeSecuritySettings((raw ?? {}) as never);
  } catch {
    // IPC 不可用（单测/早期窗口）：保持默认（拦截开）
    current = DEFAULT_SECURITY_SETTINGS;
  }
  emit();
  ensureSubscription();
  return current;
}

function ensureSubscription(): void {
  if (unsubscribe) return;
  unsubscribe = window.chat?.onGeneralSettingsChanged?.((raw) => {
    current = normalizeSecuritySettings((raw ?? {}) as never);
    emit();
  }) ?? null;
}

export function useSecuritySettings(): SecuritySettings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      void loadSecuritySettingsOnce();
      return () => listeners.delete(listener);
    },
    () => current,
    () => DEFAULT_SECURITY_SETTINGS,
  );
}

/** 测试辅助：重置单例 */
export function __resetSecuritySettingsStoreForTest(): void {
  current = DEFAULT_SECURITY_SETTINGS;
  loaded = false;
  listeners.clear();
  unsubscribe?.();
  unsubscribe = null;
}
