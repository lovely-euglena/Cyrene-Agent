// embedding 模型切换统一收尾（P1-4 / P2-1 复审）：
//   - 三步顺序 = 用户记忆对账 → 贴纸索引失效 → 贴纸索引重建（带统一原因）；
//   - reconcile 失败 best-effort 告警继续：模型已切换、索引 meta 已更新，
//     不能因备份步骤抛错把切换反悔成失败（否则设置不落盘、重启后配置与 meta 不符）。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_SWITCH_STICKER_REASON,
  finalizeEmbeddingModelSwitch,
} from "./embedding-switch-finalize";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finalizeEmbeddingModelSwitch", () => {
  it("三步顺序：reconcile → invalidate → refresh（带统一原因）", async () => {
    const calls: string[] = [];
    await finalizeEmbeddingModelSwitch({
      reconcileUserMemoryIndex: async () => { calls.push("reconcile"); },
      invalidateStickerEmbeddingIndex: () => { calls.push("invalidate"); },
      refreshStickerEmbeddingIndex: (reason) => { calls.push(`refresh:${reason}`); },
    });

    expect(calls).toEqual([
      "reconcile",
      "invalidate",
      `refresh:${EMBEDDING_SWITCH_STICKER_REASON}`,
    ]);
  });

  it("reconcile 失败 best-effort：不抛出，贴纸收尾照常（P2-1）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const calls: string[] = [];
    await expect(
      finalizeEmbeddingModelSwitch({
        reconcileUserMemoryIndex: async () => { throw new Error("backup failed"); },
        invalidateStickerEmbeddingIndex: () => { calls.push("invalidate"); },
        refreshStickerEmbeddingIndex: (reason) => { calls.push(`refresh:${reason}`); },
      }),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["invalidate", `refresh:${EMBEDDING_SWITCH_STICKER_REASON}`]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reconciliation failed"),
      "backup failed",
    );
  });
});
