// embedding 模型切换成功后的统一收尾（P1-4）。
//
// 两个入口共用同一口径，避免 native/WPF 路径漏掉用户记忆对账或贴纸索引
// 失效/重建（漏掉时重启前贴纸语义索引仍持旧模型向量，matchSticker 会拿新
// provider 的查询向量与旧维度向量算余弦 → 匹配错乱）：
//   - 渲染层 IPC：settings-ipc.ts 的 EMBEDDING_SET_MODEL handler；
//   - native/WPF：application/default-dependencies.ts 的 cyreneAction save 分支。
//
// 放在 rag 模块、依赖以回调注入：rag 不反向依赖设置/应用层，避免循环 import。

export interface EmbeddingSwitchFinalizeDeps {
  /** 用户记忆 L2 ↔ 向量索引对账（application 层实现）。 */
  reconcileUserMemoryIndex: () => Promise<void>;
  /** 贴纸语义索引失效（旧模型向量不可复用）。 */
  invalidateStickerEmbeddingIndex: () => void;
  /** 贴纸语义索引重建（异步，失败只影响贴纸匹配）。 */
  refreshStickerEmbeddingIndex: (reason: string) => void;
}

/** 贴纸索引重建原因（两入口统一，便于日志定位）。 */
export const EMBEDDING_SWITCH_STICKER_REASON = "embedding-model-switch";

/**
 * 切换成功收尾：用户记忆对账 → 贴纸索引失效 → 贴纸索引重建。
 * 调用方在 switchEmbeddingModel 返回 ok 后调用（P2-3 复审起两个入口均为
 * 先 saveModelSettings 落盘、再本收尾、最后广播）。
 *
 * P2-1/P2-3（复审）：三步均为 best-effort——任一步抛错只告警继续，不能让已
 * 生效的模型切换被入口反向标记为失败（否则 IPC/native 返回 ok:false、设置不
 * 落盘，重启后旧配置与新索引 meta 不符）。invalidate 失败不阻断 refresh。
 */
export async function finalizeEmbeddingModelSwitch(deps: EmbeddingSwitchFinalizeDeps): Promise<void> {
  try {
    await deps.reconcileUserMemoryIndex();
  } catch (error) {
    console.warn(
      "[RAG] user memory reconciliation failed after embedding switch (continuing):",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    deps.invalidateStickerEmbeddingIndex();
  } catch (error) {
    console.warn(
      "[RAG] sticker embedding index invalidation failed after embedding switch (continuing):",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    deps.refreshStickerEmbeddingIndex(EMBEDDING_SWITCH_STICKER_REASON);
  } catch (error) {
    console.warn(
      "[RAG] sticker embedding index refresh failed after embedding switch (continuing):",
      error instanceof Error ? error.message : String(error),
    );
  }
}
