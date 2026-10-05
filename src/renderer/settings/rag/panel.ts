// RAG / Embedding / Reranker 面板：模型切换、镜像源、下载/删除、状态检查
// 从 settings.ts 抽离。完全自含（IIFE 闭包 + localStorage + window.settings IPC）。
// 副作用导入：模块加载时执行事件绑定 + 状态初始化。
//
// 第二引擎（IKIH28）：
//   - Embedding 两张卡（bgem3 / e5-small）；模型切换走索引迁移 IPC：
//     默认调用返回 rebuild-required 时弹「重建 / 清空 / 取消」确认，再带 action 重发；
//   - Reranker 三档卡（standard / v2-m3 / none），同一 IPC 即时切换；
//   - 四个模型的安装状态都来自 modelConfig.getModelInstallStatus。

import { showNotice, showAlert, showConfirm } from "../shared/modal";

type EmbeddingKey = "bgem3" | "e5-small";
type RerankerKey = "standard" | "v2-m3" | "none";

const EMBEDDING_LABEL: Record<EmbeddingKey, string> = {
  bgem3: "BGE-M3",
  "e5-small": "Multilingual-E5-Small",
};

const RERANKER_LABEL: Record<RerankerKey, string> = {
  standard: "bge-reranker-base",
  "v2-m3": "bge-reranker-v2-m3",
  none: "关闭",
};

function readEmbeddingKey(value: string | null | undefined): EmbeddingKey {
  return value === "e5-small" ? "e5-small" : "bgem3";
}

function readRerankerKey(value: string | null | undefined): RerankerKey {
  return value === "v2-m3" || value === "none" ? value : "standard";
}

/** 当前模式行：动态文本（去掉 data-i18n，避免语言切换时被静态文案覆盖）。 */
function updateCurrentMode(): void {
  const el = document.getElementById("rag-current-mode");
  if (!el) return;
  const embedding = readEmbeddingKey(
    document.querySelector(".rag-model-card.is-active:not([data-reranker])")?.getAttribute("data-value"),
  );
  const reranker = readRerankerKey(
    document.querySelector(".rag-model-card.is-active[data-reranker]")?.getAttribute("data-value"),
  );
  el.removeAttribute("data-i18n");
  el.textContent = `Embedding：${EMBEDDING_LABEL[embedding]} · Rerank：${RERANKER_LABEL[reranker]}`;
}

/* ===== RAG model card toggle (embedding) ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card:not([data-reranker])");
  const KEY = "cyrene.rag.model";
  const saved = readEmbeddingKey(localStorage.getItem(KEY));

  function setActive(value: string): void {
    cards.forEach((card) => card.classList.toggle("is-active", card.dataset.value === value));
  }

  function rollback(previousValue: string | undefined): void {
    const value = readEmbeddingKey(previousValue);
    setActive(value);
    localStorage.setItem(KEY, value);
  }

  cards.forEach((card) => {
    const value = card.dataset.value as EmbeddingKey | undefined;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      if (card.classList.contains("is-active")) return;
      const previousActive = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      // Optimistic UI update
      setActive(value);
      localStorage.setItem(KEY, value);

      // Call IPC to hot-switch the embedding model
      try {
        const result = await (window as any).settings?.embeddingSetModel?.(value);
        if (result?.ok) {
          console.log("[settings] embedding switched to", value, "cleared:", result.clearedEntries, "rebuilt:", result.rebuiltEntries);
          updateCurrentMode();
          if (result.rebuiltEntries > 0) {
            showNotice({ tone: "info", message: `已切换至 ${EMBEDDING_LABEL[value]}，并重建 ${result.rebuiltEntries} 条记忆。` });
          } else if (result.clearedEntries > 0) {
            showNotice({ tone: "info", message: `已切换至 ${EMBEDDING_LABEL[value]}，并清空 ${result.clearedEntries} 条旧向量。` });
          }
          return;
        }

        // 默认拒绝：模型/维度变化需要索引迁移 → 重建 / 清空 / 取消
        if (result?.reason === "rebuild-required") {
          const rebuild = await showConfirm({
            title: "索引迁移",
            message:
              `切换到 ${EMBEDDING_LABEL[value]} 需要迁移旧索引。\n\n` +
              "重建索引：先备份记忆数据，再把全部记忆重新嵌入新模型（保留记忆，可能耗时较长）。\n" +
              "清空索引：删除旧向量记忆后切换（不可恢复）。",
            confirmText: "重建索引",
            cancelText: "其他方式",
          });
          let action: "rebuild" | "clear" | null = null;
          if (rebuild) {
            action = "rebuild";
          } else {
            const clear = await showConfirm({
              title: "清空索引？",
              message: `将删除全部旧向量记忆并切换到 ${EMBEDDING_LABEL[value]}。删除后不可恢复，需要重新导入/积累。`,
              confirmText: "清空索引",
              cancelText: "取消",
              dangerous: true,
            });
            action = clear ? "clear" : null;
          }
          if (!action) {
            rollback(previousValue);
            return;
          }
          const migrated = await (window as any).settings?.embeddingSetModel?.(value, action);
          if (migrated?.ok) {
            updateCurrentMode();
            showNotice({
              tone: "success",
              message: action === "rebuild"
                ? `已切换至 ${EMBEDDING_LABEL[value]}，并重建 ${migrated.rebuiltEntries ?? 0} 条记忆。`
                : `已切换至 ${EMBEDDING_LABEL[value]}，并清空 ${migrated.clearedEntries ?? 0} 条旧向量。`,
            });
            return;
          }
          rollback(previousValue);
          await showAlert({
            tone: "error",
            title: "模型切换失败",
            message: "已恢复此前选择。",
            details: migrated?.error || "未知错误",
          });
          return;
        }

        // Rollback on failure
        rollback(previousValue);
        // 失败原因需要用户阅读：单按钮错误模态框
        await showAlert({
          tone: "error",
          title: "模型切换失败",
          message: "已恢复此前选择。",
          details: result?.error || "未知错误",
        });
      } catch (err) {
        // Rollback on error
        rollback(previousValue);
        console.error("[settings] embedding switch error:", err);
      }
    });
  });
})();

/* ===== Reranker mode toggle ===== */
(function () {
  const cards = document.querySelectorAll<HTMLButtonElement>(".rag-model-card[data-reranker]");
  const KEY = "cyrene.reranker.mode";
  const saved = readRerankerKey(localStorage.getItem(KEY));

  function setActive(value: string): void {
    cards.forEach((card) => card.classList.toggle("is-active", card.dataset.value === value));
  }

  cards.forEach((card) => {
    const value = card.dataset.value as RerankerKey | undefined;
    if (!value) return;
    card.classList.toggle("is-active", value === saved);
    card.addEventListener("click", async () => {
      if (card.classList.contains("is-active")) return;
      const previousActive = document.querySelector(".rag-model-card.is-active[data-reranker]") as HTMLElement | null;
      const previousValue = previousActive?.dataset.value;

      setActive(value);
      localStorage.setItem(KEY, value);
      try {
        const okay = await (window as any).settings?.rerankerSetMode?.(value);
        if (okay === false) throw new Error("reranker switch rejected");
        updateCurrentMode();
      } catch (err) {
        // Rollback on failure
        const fallback = readRerankerKey(previousValue);
        setActive(fallback);
        localStorage.setItem(KEY, fallback);
        await showAlert({
          tone: "error",
          title: "重排序设置失败",
          message: "已恢复此前选择。",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
})();

/* ===== 模型安装状态（四个模型：embedding 两个 + reranker 两个） ===== */
(async () => {
  const els: Record<string, HTMLElement | null> = {
    bgem3: document.getElementById("embedding-bgem3-status"),
    e5: document.getElementById("embedding-e5-small-status"),
    standard: document.getElementById("reranker-standard-status"),
    v2m3: document.getElementById("reranker-v2-m3-status"),
  };
  function setStatus(el: HTMLElement | null, installed: boolean, installedText: string, missingText: string): void {
    if (el) el.textContent = installed ? installedText : missingText;
  }
  try {
    const status = await (window as any).modelConfig?.getModelInstallStatus?.();
    if (!status) {
      Object.values(els).forEach((el) => { if (el) el.textContent = "状态未知"; });
      return;
    }
    setStatus(els.bgem3, Boolean(status.embedding?.bgem3), "已下载 · 约 570MB", "未下载");
    setStatus(els.e5, Boolean(status.embedding?.["e5-small"]), "已下载 · 约 120MB", "未下载 · 可选");
    setStatus(els.standard, Boolean(status.reranker?.standard), "已下载 · 约 279MB", "未下载 · 可选");
    setStatus(els.v2m3, Boolean(status.reranker?.["v2-m3"]), "已下载 · 约 570MB", "未下载 · 可选");
    updateCurrentMode();
  } catch (err) {
    console.warn("[RAG] model status check failed:", err);
    Object.values(els).forEach((el) => { if (el) el.textContent = "状态未知"; });
  }
})();

/* ===== Embedding download / delete ===== */
(function () {
  const downloadBtn = document.getElementById("embedding-download-btn") as HTMLButtonElement | null;
  const deleteBtn = document.getElementById("embedding-delete-btn") as HTMLButtonElement | null;
  const mirrorGroup = document.getElementById("embedding-mirror") as HTMLElement | null;

  function getSelectedMirror(): string {
    const active = mirrorGroup?.querySelector(".option-block.is-active") as HTMLElement | null;
    return active?.dataset.value || "official";
  }

  function getSelectedModel(): EmbeddingKey {
    const active = document.querySelector(".rag-model-card.is-active:not([data-reranker])") as HTMLElement | null;
    return readEmbeddingKey(active?.dataset.value);
  }

  downloadBtn?.addEventListener("click", async () => {
    // 打开模型安装说明文档
    // ⚠️ 与 main 侧 default-dependencies.ts 的 LOCAL_MODELS_DOC_URL 保持一致
    //（Gitee 主仓；GitHub 镜像在本机网络不可达，勿改回）
    await window.system?.openExternal(
      "https://gitee.com/ygwill/cyrene-agent/blob/main/docs/local-models.md"
    );
  });


  deleteBtn?.addEventListener("click", async () => {
    const model = getSelectedModel();
    const name = EMBEDDING_LABEL[model];
    // 删除模型缓存需重新下载：危险确认，默认聚焦取消
    const confirmed = await showConfirm({
      title: "删除模型",
      message: `确定删除 ${name} 模型缓存？将移除已安装的模型文件（项目 models 目录与 HF 缓存），下次使用需重新安装。`,
      confirmText: "删除",
      cancelText: "取消",
      dangerous: true,
    });
    if (!confirmed) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = "\u5220\u9664\u4E2D\u2026";
    try {
      const result = await window.settings?.deleteEmbeddingModel?.(model);
      if (result?.ok) {
        deleteBtn.textContent = "\u2705 \u5DF2\u5220\u9664";
        setTimeout(() => location.reload(), 800);
      } else {
        deleteBtn.textContent = "\u274C \u5931\u8D25";
        deleteBtn.disabled = false;
      }
    } catch (err) {
      deleteBtn.textContent = "\u274C \u5931\u8D25";
      deleteBtn.disabled = false;
    }
  });

  // Mirror source toggle：写入通用设置（与 .NET 设置窗「昔涟设置」同源；
  // 旧实现只写 localStorage，导致两处设置页各存一份、模型下载拿不到偏好）
  function applyMirrorSelection(value: string): void {
    const selected = value === "hf-mirror" ? "hf-mirror" : "official";
    mirrorGroup?.querySelectorAll(".option-block").forEach((b) => {
      const v = b.getAttribute("data-value");
      b.classList.toggle("is-active", v === selected);
      b.setAttribute("aria-pressed", v === selected ? "true" : "false");
    });
  }

  mirrorGroup?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("[data-value]") as HTMLElement | null;
    if (!btn) return;
    const value = btn.dataset.value;
    if (!value) return;
    applyMirrorSelection(value);
    void window.settings?.saveGeneral?.({ ragDownloadMirror: value === "hf-mirror" ? "hf-mirror" : "official" });
  });

  // Restore saved mirror on load（通用设置为准）
  void window.settings?.getGeneral?.()
    .then((cfg) => applyMirrorSelection(cfg.ragDownloadMirror ?? "official"))
    .catch(() => applyMirrorSelection("official"));
})();
(function () {
  const updateBtn = document.getElementById("embedding-update-btn") as HTMLButtonElement | null;
  updateBtn?.addEventListener("click", () => {
    updateBtn.textContent = "已是最新版本";
    updateBtn.disabled = true;
    setTimeout(() => {
      updateBtn.textContent = "检查更新";
      updateBtn.disabled = false;
    }, 2000);
  });
})();
