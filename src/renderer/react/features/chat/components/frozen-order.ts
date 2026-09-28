import { useMemo, useRef } from "react";

/**
 * 「冻结排序」：面板内切换开关时不重排（防止卡片跳位），
 * 只在进入面板 / 切换 tab / 目录变化（orderKey 变化）时按当时的开关状态
 * 排序一次并冻结；下次进入或切 tab 时 orderKey 变化，自然重排。
 */

/** 按 rank（越小越前，同 rank 按 id）排一次序，产出 id → 序号 的冻结表 */
export function freezeOrder<T>(
  items: readonly T[],
  getId: (item: T) => string,
  rank: (item: T) => number,
): Map<string, number> {
  const sorted = [...items].sort((a, b) => rank(a) - rank(b) || getId(a).localeCompare(getId(b)));
  return new Map(sorted.map((item, index) => [getId(item), index]));
}

/** 按冻结序号稳定排序；不在冻结表内的项（新增条目）排到最后 */
export function applyFrozenOrder<T>(
  items: readonly T[],
  order: ReadonlyMap<string, number>,
  getId: (item: T) => string,
): T[] {
  return [...items].sort(
    (a, b) =>
      (order.get(getId(a)) ?? Number.MAX_SAFE_INTEGER) -
      (order.get(getId(b)) ?? Number.MAX_SAFE_INTEGER),
  );
}

/**
 * 冻结排序 hook。
 * @param items   待排序的完整基准列表（调用方 useMemo 稳定引用）
 * @param orderKey 「重新排序」的触发键：进入面板 / 切 tab / 目录变化时才变
 * @param getId   取 id（须稳定引用，如模块级函数）
 * @param rank    当前排序权重（开启=0、关闭=1 之类；仅冻结时采样一次）
 */
export function useFrozenOrder<T>(
  items: readonly T[],
  orderKey: string,
  getId: (item: T) => string,
  rank: (item: T) => number,
): T[] {
  const frozenRef = useRef<{ key: string; order: Map<string, number> } | null>(null);
  if (frozenRef.current === null || frozenRef.current.key !== orderKey) {
    // 渲染期惰性初始化：orderKey 未变时绝不重采样，开关切换因此不会改变位置
    frozenRef.current = { key: orderKey, order: freezeOrder(items, getId, rank) };
  }
  const order = frozenRef.current.order;
  return useMemo(() => applyFrozenOrder(items, order, getId), [items, order, getId]);
}