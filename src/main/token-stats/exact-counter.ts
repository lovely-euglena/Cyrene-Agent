// 精确 token 统计：上下文快照的「干跑探测 → 批量精确计数」适配层。
//
// 不直接依赖 electron/子进程（计数函数由调用方注入），便于单测。
// 原理：buildContextUsageSnapshot 的所有文本计量都经 tokenCounter；
// 先用探针 counter 跑一遍收集文本，再批量问外部计数器，最后带缓存重跑。

import { buildContextUsageSnapshot, type ContextUsageSnapshotInput } from "../orchestrator/context-usage";
import { estimateTokens } from "../orchestrator/context-manager";
import type { ContextUsageSnapshot } from "../../shared/context-usage";

export type BatchTextCounter = (texts: string[]) => Promise<number[] | null>;

export async function buildContextUsageSnapshotWithCounter(
  input: ContextUsageSnapshotInput,
  countTexts: BatchTextCounter,
): Promise<ContextUsageSnapshot> {
  const texts: string[] = [];
  buildContextUsageSnapshot({
    ...input,
    tokenCounter: (text) => {
      texts.push(text);
      return 0;
    },
  });

  const unique = Array.from(new Set(texts));
  if (unique.length === 0) return buildContextUsageSnapshot(input);

  let counts: number[] | null = null;
  try {
    counts = await countTexts(unique);
  } catch {
    counts = null;
  }
  if (
    !counts
    || counts.length !== unique.length
    || counts.some((value) => !Number.isFinite(value) || value < 0)
  ) {
    // 词表缺失/下载失败/协议异常：整体回退启发式，行为与未启用时一致。
    return buildContextUsageSnapshot(input);
  }

  const byText = new Map<string, (typeof counts)[number]>();
  unique.forEach((text, index) => byText.set(text, counts![index]));
  return buildContextUsageSnapshot({
    ...input,
    tokenCounter: (text) => byText.get(text) ?? estimateTokens(text),
  });
}
