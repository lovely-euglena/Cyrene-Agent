import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

/**
 * issue #226：设置页未保存守卫。
 *
 * 有"显式保存"语义的面板（当前仅 TTS 各 provider）通过 useRegisterUnsaved
 * 上报 dirty 状态；AppRouter 的三个离开入口（切节 / IPC 切节 / 返回工作区）
 * 在放行前查 registry，任一 dirty 且开关开启时弹确认。
 *
 * 即改即存的面板（General/Preferences/Model 等走 saveImmediate）天然无未保存
 * 态，无需注册——守卫只对真有丢失风险的字段生效。
 */

type DirtyRegistry = Map<string, boolean>;

const UnsavedGuardContext = createContext<{
  report: (key: string, isDirty: boolean) => void;
} | null>(null);

/** 模块级 registry：非 React 侧（AppRouter 守卫回调）同步读取。 */
const registry: DirtyRegistry = new Map();

export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const report = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) registry.set(key, true);
    else registry.delete(key);
  }, []);
  const value = useMemo(() => ({ report }), [report]);
  return <UnsavedGuardContext.Provider value={value}>{children}</UnsavedGuardContext.Provider>;
}

/** 面板内上报未保存状态；卸载时自动注销（防切换 section 后残留误拦）。 */
export function useRegisterUnsaved(key: string, isDirty: boolean): void {
  const ctx = useContext(UnsavedGuardContext);
  const lastRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ctx || lastRef.current === isDirty) return;
    lastRef.current = isDirty;
    ctx.report(key, isDirty);
  }, [ctx, key, isDirty]);
  useEffect(() => () => {
    ctx?.report(key, false);
  }, [ctx, key]);
}

/** 任一面板存在未保存修改？ */
export function hasUnsavedChanges(): boolean {
  return registry.size > 0;
}
