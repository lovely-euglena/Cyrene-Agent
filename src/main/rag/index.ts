import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { createLocalEmbeddingProvider, getEmbeddingProvider, resetEmbeddingProvider, EmbeddingProvider, switchEmbeddingModel as switchModel, getCurrentModelDims, EmbeddingDimensionMismatchError } from "./embedding";
import type { EmbeddingIndexMetadata, VectorStore } from "./vectorstore";
import { backupSqliteStore, createVectorStore } from "./vectorstore";
import type { MemoryEntry } from "./vectorstore";
import { LOCAL_MODELS } from "./embedding-pipeline";
import { HybridRetriever } from "./retriever";
import { WorldbookManager } from "./worldbook";
import { logger, LogTag } from "../logger";
export { INJECTION_HEADER, INJECTION_PREAMBLE } from "./worldbook-constants";
import { chunkText } from "./chunk";
import { feedEntityNamesToJieba } from "../memory/entity-graph";
import { isL2LocallyRecallable } from "../memory/memory-types";
import type { DocumentImportControl } from "./file-ingest";
import { findPromptPath } from "../external-content-paths";
import { isMemoryEnabled } from "../memory/memory-mode";

// ── Global RAG instances ──
let store: VectorStore | null = null;
let retriever: HybridRetriever | null = null;
let worldbook: WorldbookManager | null = null;
let provider: EmbeddingProvider | null = null;
let activeVectorOperations = 0;
const vectorOperationsDrained = new Set<() => void>();
// 每轮对话递增，用于 DMAE repeatWindow 统计（worldbook 状态不持久化，重启回 0 可接受）
let worldbookTurnCounter = 0;

function getDataDir(): string {
  return path.join(app.getPath("userData"), "rag-data");
}

// ── Init ──
export async function initRAG(
  ragMode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  embeddingModel?: string,
  cloudDimensions?: number,
): Promise<void> {
  if (isMemoryEnabled()) {
    await initVectorMemory(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  }
  await initWorldbook();
}

async function trackVectorOperation<T>(operation: () => Promise<T>): Promise<T> {
  activeVectorOperations++;
  try {
    return await operation();
  } finally {
    activeVectorOperations--;
    if (activeVectorOperations === 0) {
      for (const resolve of vectorOperationsDrained) resolve();
      vectorOperationsDrained.clear();
    }
  }
}

async function waitForVectorOperations(): Promise<void> {
  if (activeVectorOperations === 0) return;
  await new Promise<void>((resolve) => { vectorOperationsDrained.add(resolve); });
}

export async function initVectorMemory(
  ragMode: "auto" | "local" | "cloud" = "auto",
  cloudBaseUrl?: string,
  cloudApiKey?: string,
  embeddingModel?: string,
  cloudDimensions?: number,
): Promise<void> {
  const dataDir = getDataDir();
  provider = getEmbeddingProvider(ragMode, cloudBaseUrl, cloudApiKey, embeddingModel, cloudDimensions);
  store = createVectorStore(dataDir);
  // 只有 provider 存在时才创建 retriever（向量检索依赖 embedding）
  if (provider) {
    retriever = new HybridRetriever(store, provider);
  }
  logger.info(
    LogTag.RAG,
    "vector memory initialized. Mode:", ragMode,
    "Provider:", provider?.name ?? "none",
    "Dims:", provider?.dims ?? "N/A",
    "Memories:", store.stats.total,
    provider ? "" : " [Vector retrieval disabled]"
  );
}

export async function initWorldbook(): Promise<void> {
  worldbook = new WorldbookManager(
    findPromptPath("worldbook") ?? path.join(app.getPath("userData"), "empty-worldbook"),
    { stateFile: path.join(app.getPath("userData"), "worldbook-state.json") }
  );
  await worldbook.loadFromDirectory();

  // 把实体图谱中的已有实体名灌入 jieba 自定义词典
  // 防止 "昔涟"、"小鹿" 等 AI 伴侣核心名词被错误切分
  await feedEntityNamesToJieba();
  logger.info(LogTag.RAG, "worldbook initialized");
}

/** 关闭向量记忆并释放当前进程持有的索引和嵌入模型引用；不删除磁盘数据。 */
export async function disposeVectorMemory(): Promise<void> {
  await waitForVectorOperations();
  await flushRAGStore().catch(() => { /* flush best-effort */ });
  store = null;
  retriever = null;
  provider = null;
  resetEmbeddingProvider();
}

// ── Switch embedding model (hot-swap with index migration) ──

export type EmbeddingSwitchAction = "rebuild" | "clear";

export interface EmbeddingSwitchOptions {
  onProgress?: (completed: number, total: number) => void;
  isCancelled?: () => boolean;
}

export interface EmbeddingSwitchResult {
  ok: boolean;
  modelKey?: string;
  clearedEntries: number;
  rebuiltEntries?: number;
  /** 默认拒绝时给出安全动作建议：rebuild（有数据，建议重建）| clear（空库/仅陈旧元数据） */
  requires?: EmbeddingSwitchAction;
  reason?: string;
  error?: string;
}

/** 维度 → 注册表 hfName（旧数据无 meta.model 时兼容推断；1024 → bge-m3）。 */
function inferModelNameByDims(dims: number): string | null {
  const match = Object.values(LOCAL_MODELS).find((model) => model.dims === dims);
  return match?.hfName ?? null;
}

/**
 * 重建前备份向量库（复用 reconciliation 的 VACUUM INTO / 文件拷贝模式）：
 * - sqlite：memory.db → <rag-data>/index-rebuild-backups/memory-db.<ts>.db（VACUUM INTO 一致快照）
 * - json：memory-store.json → index-rebuild-backups/memory-store.<ts>.json
 * 每类保留最近 3 份。
 */
function backupRagDataForRebuild(dataDir: string): void {
  const backupDir = path.join(dataDir, "index-rebuild-backups");
  const timestamp = Date.now();
  const sqliteSource = path.join(dataDir, "memory.db");
  const jsonSource = path.join(dataDir, "memory-store.json");
  const hasSqlite = fs.existsSync(sqliteSource);
  const hasJson = fs.existsSync(jsonSource);
  if (!hasSqlite && !hasJson) return;

  fs.mkdirSync(backupDir, { recursive: true });
  if (hasSqlite) {
    const target = path.join(backupDir, `memory-db.${timestamp}.db`);
    if (backupSqliteStore(sqliteSource, target)) {
      pruneRebuildBackups(backupDir, "memory-db", "db");
    } else {
      console.warn("[RAG] sqlite backup unavailable before rebuild; proceeding without snapshot");
    }
  }
  if (hasJson) {
    fs.copyFileSync(jsonSource, path.join(backupDir, `memory-store.${timestamp}.json`));
    pruneRebuildBackups(backupDir, "memory-store", "json");
  }
}

function pruneRebuildBackups(backupDir: string, prefix: string, extension: string, retention = 3): void {
  const suffix = `.${extension}`;
  const backups = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(`${prefix}.`) && name.endsWith(suffix))
    .sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - Math.max(1, retention)))) {
    try { fs.rmSync(path.join(backupDir, stale)); } catch { /* best effort */ }
  }
}

/**
 * clear 动作：一并删除重建备份目录（P2-4）。
 * 旧设置页/设计稿对 clear 的承诺是「删除后不可恢复」；备份目录是 rebuild 的内部
 * 快照（最多 3 份），若保留则旧记忆仍可从 rag-data/index-rebuild-backups 恢复，
 * 与文案不符。删除失败只告警（clear 本身已生效，残留备份不应让切换失败）。
 */
function clearRebuildBackups(dataDir: string): void {
  const backupDir = path.join(dataDir, "index-rebuild-backups");
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch (err) {
    console.warn("[RAG] failed to remove rebuild backups after clear:", err);
  }
}

/** 切换进行中标记（P2-2 互斥）：进行中拒绝新请求，避免两次迁移交错落盘。 */
let embeddingSwitchInFlight = false;

/** 合法的切换动作（运行时白名单；P1-1 渲染层输入不可信，编译期类型不算数）。 */
function isEmbeddingSwitchAction(value: unknown): value is EmbeddingSwitchAction {
  return value === "rebuild" || value === "clear";
}

/**
 * 切换 embedding 模型（第二引擎 IKIH28）。
 *
 * 与旧实现的区别：模型/维度变化**不再静默 clearAll**。
 *   - 默认（无 action）：返回 { ok:false, reason:"rebuild-required", requires }，
 *     不动库、不动 provider（requires = 有数据 ? "rebuild" : "clear"）。
 *   - action="rebuild"：先备份 → 全量分批重嵌入 → 原地 upsert → IVF 重建 → meta 更新。
 *   - action="clear"：显式清空（含 meta），再切 provider。
 *
 * 入口防线：
 *   - action 运行时白名单（P1-1）：非法值直接拒绝，不落盘、不切 provider、不写 meta
 *     （渲染层可传任意真值字符串；与 native sanitize 白名单同口径）；
 *   - 切换互斥（P2-2）：进行中拒绝并回 reason="switch-in-progress"。
 */
export async function switchEmbeddingModel(
  modelKey: string,
  action?: EmbeddingSwitchAction,
  options?: EmbeddingSwitchOptions,
): Promise<EmbeddingSwitchResult> {
  if (action !== undefined && !isEmbeddingSwitchAction(action)) {
    console.warn("[RAG] rejected embedding switch with invalid action:", action);
    return {
      ok: false,
      modelKey,
      clearedEntries: 0,
      reason: "invalid-action",
      error: `Invalid embedding switch action: ${String(action)} (expected "rebuild" | "clear")`,
    };
  }
  if (embeddingSwitchInFlight) {
    return {
      ok: false,
      modelKey,
      clearedEntries: 0,
      reason: "switch-in-progress",
      error: "Another embedding model switch is already in progress",
    };
  }
  embeddingSwitchInFlight = true;
  try {
    return await performEmbeddingSwitch(modelKey, action, options);
  } finally {
    embeddingSwitchInFlight = false;
  }
}

async function performEmbeddingSwitch(
  modelKey: string,
  action?: EmbeddingSwitchAction,
  options?: EmbeddingSwitchOptions,
): Promise<EmbeddingSwitchResult> {
  if (!isMemoryEnabled()) return { ok: false, clearedEntries: 0, error: "记忆模式已关闭" };
  const config = LOCAL_MODELS[modelKey];
  if (!config) return { ok: false, clearedEntries: 0, error: `Unknown embedding model: ${modelKey}` };
  try {
    const newProvider = createLocalEmbeddingProvider(modelKey);
    if (!newProvider) {
      // 模型不存在时无法切换 — 输出详细诊断帮助排查"放到 models/ 却检测不到"
      try {
        // require to avoid circular import at module load
        const { getModelInstallStatusDetail } = require("./model-status") as typeof import("./model-status");
        const detail = getModelInstallStatusDetail("embedding", modelKey);
        if (detail.existingProjectDir) {
          console.error(
            `[Cyrene] embedding model "${modelKey}" project directory exists but is incomplete.\n` +
            `  existingProjectDir: ${detail.existingProjectDir}\n` +
            `  requiredFiles:      ${JSON.stringify(detail.requiredFiles)}\n` +
            `  missingFiles:       ${JSON.stringify(detail.missingFiles)}\n` +
            `  HF cache fallback suppressed. Fix the files above, then retry.`,
          );
        } else {
          console.error(
            `[Cyrene] embedding model "${modelKey}" not detected anywhere.\n` +
            `  modelDirCandidates: ${JSON.stringify(detail.modelDirCandidates)}\n` +
            `  subPathCandidates:  ${JSON.stringify(detail.subPathCandidates)}\n` +
            `  requiredFiles:      ${JSON.stringify(detail.requiredFiles)}\n` +
            `  Drop the model files into one of the candidates above.`,
          );
        }
      } catch (diagErr) {
        console.error("[Cyrene] model diagnostic log failed:", diagErr);
      }
      return { ok: false, modelKey, clearedEntries: 0, error: "Local embedding model not found. Cannot switch." };
    }

    const newModelName = newProvider.cacheIdentity?.model ?? newProvider.name;
    const newDims = newProvider.dims;

    // 当前索引身份：meta 优先；旧数据无 meta 时按向量维度兼容推断（1024 → bgem3）
    let currentModel: string | null = null;
    let currentDims: number | null = null;
    let entryCount = 0;
    if (store) {
      store.ensureFresh();
      const entries = (store as any).entries as MemoryEntry[];
      entryCount = entries.length;
      const meta = store.getIndexMeta();
      if (meta) {
        currentDims = meta.dimensions;
        currentModel = typeof meta.model === "string" && meta.model.length > 0
          ? meta.model
          : inferModelNameByDims(meta.dimensions);
      } else if (entryCount > 0) {
        currentDims = entries[0].embedding.length;
        currentModel = inferModelNameByDims(currentDims);
      }
    }
    const mismatch = (currentDims !== null && currentDims !== newDims)
      || (currentModel !== null && currentModel !== newModelName);

    if (mismatch && !action) {
      console.log(
        `[RAG] embedding switch to ${modelKey} requires index migration ` +
        `(${currentModel ?? currentDims} → ${newModelName}); refusing silent clear`,
      );
      return {
        ok: false,
        modelKey,
        clearedEntries: 0,
        requires: entryCount > 0 ? "rebuild" : "clear",
        reason: "rebuild-required",
      };
    }

    let clearedEntries = 0;
    let rebuiltEntries = 0;
    if (mismatch && action === "rebuild") {
      backupRagDataForRebuild(getDataDir());
      rebuiltEntries = store
        ? await store.reembedAll(newProvider, {
            onProgress: options?.onProgress,
            isCancelled: options?.isCancelled,
          })
        : 0;
    } else if (mismatch && action === "clear") {
      // P2-1（复审）：clear 走严格落盘——persist/meta 任一失败内部回滚后抛出，
      // 不再出现「磁盘旧向量 + 新 meta」或忽略 saveMeta 返回值仍返回 ok。
      clearedEntries = store
        ? store.clearAll({ strict: true, nextProvider: newProvider })
        : 0;
      clearRebuildBackups(getDataDir());
    }

    // 迁移流程（reembedAll / clearAll strict）已各自严格写入新 provider meta，
    // 写失败已在上方抛出；这里只做不变量校验，避免未来路径漏写 meta 却返回 ok
    // （原实现此处忽略 setIndexMetaForProvider 返回值——复审 P2-1）。
    if (mismatch && store && store.getIndexMeta() === null) {
      throw new Error("[RAG] index metadata missing after embedding switch migration");
    }

    // provider 切换（embedding.ts：清缓存 + 切 current key + 丢旧 pipeline）。
    // 再经 getEmbeddingProvider 建一次以回填模块级 cachedProvider——否则
    // 后续无参 getEmbeddingProvider() 会按 DEFAULT_MODEL_KEY 重建 bgem3。
    switchModel(modelKey);
    provider = getEmbeddingProvider("auto", undefined, undefined, modelKey) ?? newProvider;
    if (store) {
      retriever = new HybridRetriever(store, provider);
    }

    console.log(
      "[RAG] switched embedding model to", modelKey, "dims:", newDims,
      "cleared:", clearedEntries, "rebuilt:", rebuiltEntries,
    );
    return { ok: true, modelKey, clearedEntries, rebuiltEntries };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[RAG] switch embedding model failed:", message);
    return { ok: false, modelKey, clearedEntries: 0, error: message };
  }
}

/**
 * 获取当前向量索引的元数据（只读）。
 * 用于设置 UI 展示或诊断。
 */
export function getIndexMetadata(): Readonly<EmbeddingIndexMetadata> | null {
  return store?.getIndexMeta() ?? null;
}

// ── Memory write ──
export async function addMemory(
  text: string,
  source = "user_memory",
  metadata?: Record<string, unknown>
): Promise<string> {
  if (!isMemoryEnabled()) throw new Error("记忆模式已关闭");
  if (!store || !provider) throw new Error("RAG not initialized");
  const currentStore = store;
  const currentProvider = provider;
  return trackVectorOperation(async () => {
    const entry = await currentStore.add(text, source, currentProvider, metadata);
    return entry.id;
  });
}

export async function addL2MemoryVector(
  text: string,
  l2Id: string,
  metadata?: Record<string, unknown>,
): Promise<string> {
  if (!isMemoryEnabled()) throw new Error("记忆模式已关闭");
  if (!store || !provider) throw new Error("RAG not initialized");
  if (!l2Id.trim()) throw new Error("l2Id is required");
  const currentStore = store;
  const currentProvider = provider;
  return trackVectorOperation(async () => {
    const entry = await currentStore.addUnique(text, "user_memory", currentProvider, { ...metadata, l2Id });
    return entry.id;
  });
}

// ── Memory search ──
export async function searchMemory(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean }
): Promise<string[]> {
  const results = await searchMemoryEntries(query, source, topK, options);
  return results.map((r) => r.text);
}

export async function searchMemoryEntries(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean }
): Promise<Array<{ id: string; text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!isMemoryEnabled()) return [];
  return trackVectorOperation(() => searchMemoryEntriesEnabled(query, source, topK, options));
}

async function searchMemoryEntriesEnabled(
  query: string,
  source?: string,
  topK = 5,
  options?: { recordRecall?: boolean },
): Promise<Array<{ id: string; text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!retriever) return [];
  let allowedEntryIds: string[] | undefined;
  if (source === "user_memory") {
    try {
      const { memoryStore } = await import("../memory/memory-store.js");
      const memories = await memoryStore.getAllL2();
      const recallableById = new Map(
        memories.filter(isL2LocallyRecallable).map((memory) => [memory.id, memory]),
      );
      allowedEntryIds = getEntriesBySource("user_memory")
        .filter((entry) => {
          const l2Id = entry.metadata?.l2Id;
          if (typeof l2Id !== "string") return false;
          return recallableById.get(l2Id)?.ragId === entry.id;
        })
        .map((entry) => entry.id);
    } catch (err) {
      console.warn("[RAG] failed to resolve recallable user memories:", err);
      return [];
    }
  }
  const results = await retriever.retrieve(query, source, topK, { allowedEntryIds });
  if (options?.recordRecall !== false) {
    await recordUserMemoryRecalls(results);
  }
  return results.map((r) => ({
    id: r.entry.id,
    text: r.entry.text,
    createdAt: r.entry.createdAt,
    score: r.score,
    metadata: r.entry.metadata,
  }));
}

async function recordUserMemoryRecalls(results: Array<{ entry: MemoryEntry }>): Promise<void> {
  const l2Ids = results
    .filter((r) => r.entry.source === "user_memory")
    .map((r) => r.entry.metadata?.l2Id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (l2Ids.length === 0) return;
  try {
    const { memoryStore } = await import("../memory/memory-store.js");
    for (const l2Id of new Set(l2Ids)) {
      await memoryStore.updateL2RecallStats(l2Id, 1);
    }
  } catch (err) {
    console.warn("[RAG] failed to record user memory recall:", err);
  }
}

// ── History search with metadata（供 recall_history 工具用）──
// 跟 searchMemory 的区别：返回完整 entry（含 createdAt / metadata），
// 让召回工具能按时间排序、展示时间戳。
export async function searchHistoryEntries(
  query: string,
  topK = 5
): Promise<Array<{ text: string; createdAt: number; score: number; metadata?: Record<string, unknown> }>> {
  if (!isMemoryEnabled()) return [];
  return trackVectorOperation(async () => {
    if (!retriever) return [];
    const results = await retriever.retrieve(query, "chat_history", topK);
    return results.map((r) => ({
      text: r.entry.text,
      createdAt: r.entry.createdAt,
      score: r.score,
      metadata: r.entry.metadata,
    }));
  });
}

// ── Worldbook DMAE：每轮打分（本轮用户输入 + 上轮模型回复）──
export function updateWorldbookActivation(userText: string, modelText: string, turn?: number): void {
  if (!worldbook) return;
  const t = turn ?? ++worldbookTurnCounter;
  worldbook.updateActivation(userText, modelText, t);
}

// ── Worldbook DMAE：取 Active 条目内容（阈值门控 + 注入）──
export function getActiveWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getActiveEntries();
}

// ── Worldbook One-Shot：取本轮 cascade 触发的条目（不入 DMAE 状态表）──
// 返回带条目标题的完整内容（与 getActiveWorldbookEntries 一致格式，便于合并注入）
export function getCascadeWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getCascadeEntries().map(e => {
    const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
    return `【${title}】\n${e.content}`;
  });
}

// ── Get permanent worldbook entries ──
export function getPermanentWorldbookEntries(): string[] {
  if (!worldbook) return [];
  return worldbook.getPermanentEntries();
}

// ── Worldbook 关键词直查：后台轻量调用（Moments 反应/发帖等）用，不经 DMAE 状态机 ──
// 文本命中任一触发词即注入该条目，调用方自行决定合并常驻条目。
export function getKeywordMatchedWorldbookEntries(text: string): string[] {
  if (!worldbook) return [];
  const t = text ?? "";
  if (!t.trim()) return [];
  return worldbook.getEntries()
    .filter((e) => e.enabled && !e.permanent && e.keywords.length > 0)
    .filter((e) => e.keywords.some((kw) => t.includes(kw)))
    .sort((a, b) => b.priority - a.priority)
    .map((e) => {
      const title = e.id.replace(/^wb_[^_]+_/, "").replace(/_/g, " ");
      return `【${title}】\n${e.content}`;
    });
}

// ── Import document ──
export type ImportedDocumentResult = {
  importId: string;
  chunkCount: number;
};

export type ImportedDocumentChunk = {
  text: string;
  score: number;
  fileName?: string;
  chunkIndex?: number;
  importId?: string;
};

export type PreparedDocumentEmbedding = {
  text: string;
  chunkIndex: number;
  embedding: number[];
};

export async function appendPreparedDocumentBatch(
  fileName: string,
  importId: string,
  prepared: PreparedDocumentEmbedding[],
): Promise<void> {
  if (!store) throw new Error("RAG not initialized");
  store.addPreparedBatch(prepared.map((entry) => ({
    text: entry.text,
    embedding: entry.embedding,
    source: "imported_doc",
    metadata: { fileName, chunkIndex: entry.chunkIndex, importId },
  })));
}

export async function importPreparedDocumentForTurn(
  fileName: string,
  prepared: PreparedDocumentEmbedding[],
): Promise<ImportedDocumentResult> {
  if (!store) throw new Error("RAG not initialized");
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 8);
  const importId = `import-${Date.now()}-${id}`;
  await appendPreparedDocumentBatch(fileName, importId, prepared);
  return { importId, chunkCount: prepared.length };
}

export async function importDocumentForTurn(
  text: string,
  fileName: string,
  control?: DocumentImportControl,
): Promise<ImportedDocumentResult> {
  if (!store || !provider) throw new Error("RAG not initialized");
  const chunks = chunkText(text, "doc_" + fileName);
  control?.onProgress?.({ status: "chunking", completedChunks: chunks.length, totalChunks: chunks.length });
  if (control?.isCancelled?.()) throw new Error("cancelled");
  const id = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 8);
  const importId = `import-${Date.now()}-${id}`;
  control?.onProgress?.({ status: "embedding", completedChunks: 0, totalChunks: chunks.length });
  await store.addBatch(
    chunks.map((c) => ({ text: c.text, source: "imported_doc", metadata: { fileName, chunkIndex: c.index, importId } })),
    provider,
    { isCancelled: control?.isCancelled },
  );
  return { importId, chunkCount: chunks.length };
}

export async function importDocument(text: string, fileName: string): Promise<number> {
  const result = await importDocumentForTurn(text, fileName);
  return result.chunkCount;
}

export async function searchImportedDocumentChunksForImportIds(
  query: string,
  importIds: string[],
  topK = 6,
): Promise<ImportedDocumentChunk[]> {
  if (!retriever || !query.trim() || importIds.length === 0) return [];
  const results = await retriever.retrieve(query, "imported_doc", topK, { importIds });
  return results.map((result) => ({
    text: result.entry.text,
    score: result.score,
    fileName: typeof result.entry.metadata?.fileName === "string" ? result.entry.metadata.fileName : undefined,
    chunkIndex: typeof result.entry.metadata?.chunkIndex === "number" ? result.entry.metadata.chunkIndex : undefined,
    importId: typeof result.entry.metadata?.importId === "string" ? result.entry.metadata.importId : undefined,
  }));
}

// ── Build memory context (legacy, kept for compatibility) ──
// 注意：单参签名无 modelText，故 model 奖励不触发（降级行为）。
// 主流程已改用 orchestrator 的 buildAlwaysOnContext（会传上轮模型回复）。
export async function buildMemoryContext(userInput: string): Promise<string> {
  const parts: string[] = [];

  // 1. Worldbook（DMAE：打分 + 取 Active）
  updateWorldbookActivation(userInput, "");
  const wbResults = getActiveWorldbookEntries();
  if (wbResults.length > 0) {
    parts.push("\u3010\u76f8\u5173\u80cc\u666f\u3011\n" + wbResults.join("\n\n"));
  }

  // 2. Imported docs
  const docResults = await searchMemory(userInput, "imported_doc", 5);
  if (docResults.length > 0) {
    parts.push("\u3010\u76f8\u5173\u6587\u4ef6\u7247\u6bb5\u3011\n" + docResults.map((m) => "- " + m).join("\n"));
  }

  // 3. User memory
  const memResults = await searchMemory(userInput, "user_memory", 3);
  if (memResults.length > 0) {
    parts.push("\u3010\u5173\u4e8e\u7528\u6237\u7684\u8bb0\u5fc6\u3011\n" + memResults.map((m) => "- " + m).join("\n"));
  }

  return parts.join("\n\n");
}

// ── Reset ──
export function resetRAG(): void {
  try {
    store?.dispose();
  } catch {
    /* ignore */
  }
  store = null;
  retriever = null;
  worldbook = null;
  provider = null;
  resetEmbeddingProvider();
}

export function getRAGStats() {
  store?.ensureFresh();
  return store?.stats ?? { total: 0, sources: {} };
}

export function isUserMemoryVectorStoreReady(): boolean {
  return store !== null && provider !== null;
}

/**
 * 获取指定 source 的所有向量条目（含 embedding），用于片段压缩 / 聚类。
 * 返回浅拷贝，调用方不应修改返回的 embedding。
 */
export function getEntriesBySource(source: string): Array<{ id: string; text: string; embedding: number[]; createdAt: number; weight: number; metadata?: Record<string, unknown> }> {
  if (!store) return [];
  store.ensureFresh();
  return ((store as any).entries as MemoryEntry[])
    .filter((e) => e.source === source)
    .map((e) => ({ id: e.id, text: e.text, embedding: e.embedding, createdAt: e.createdAt, weight: e.weight, metadata: e.metadata }));
}

/**
 * 面板用：导入文档分块的精简信息（不含 embedding/文本，避免大对象拷贝）。
 * SQLite 化后 memory-store.json 不再是数据源，面板不能再直接读文件。
 */
export function getImportedDocChunkInfo(): Array<{ createdAt: number; metadata?: Record<string, unknown> }> {
  if (!store) return [];
  store.ensureFresh();
  return ((store as any).entries as MemoryEntry[])
    .filter((e) => e.source === "imported_doc")
    .map((e) => ({ createdAt: e.createdAt, metadata: e.metadata }));
}

export function deleteUserMemoryVectors(ragIds: string[]): number {
  if (!store) throw new Error("RAG not initialized");
  return store.deleteEntriesByIds(ragIds, "user_memory");
}

export function deleteImportedDoc(importId: string, fileName?: string): number {
  if (!store) throw new Error("RAG not initialized");
  return store.deleteImportedDoc(importId, fileName);
}

export function hasImportedDocumentChunks(importId: string): boolean {
  store?.ensureFresh();
  return store?.hasImportedDocumentChunks(importId) ?? false;
}

/**
 * 受控退出（before-quit 链路）兼容钩子。
 * SQLite 轨（Open Code 2026-09-26 重构）：所有写路径经 persistNow 即时落盘，
 * 不再有防抖队列，此函数保留导出仅维持组合根调用契约。
 */
export async function flushRAGStore(): Promise<void> {
  store?.ensureFresh?.();
}

/** 会话紧急结束（Windows session-end）兼容钩子，语义同上（即时持久化，无待刷数据）。 */
export function flushRAGStoreSync(): void {
  store?.ensureFresh?.();
}
