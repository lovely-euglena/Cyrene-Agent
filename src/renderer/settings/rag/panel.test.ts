// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

// RAG 面板迁移后的行为验证：
// 模型切换失败回滚并显示共享错误模态框（而非 window.alert）

function addModelCard(value: string): HTMLButtonElement {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "rag-model-card";
  card.dataset.value = value;
  document.body.appendChild(card);
  return card;
}

describe("RAG settings panel", () => {
  beforeEach(() => {
    vi.resetModules();
    document.body.replaceChildren();
    window.localStorage.clear();
    addModelCard("bgem3");
    addModelCard("text-embedding-3");
  });

  it("rolls back and shows a shared error alert when the embedding switch fails", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    Object.assign(window, {
      settings: {
        embeddingSetModel: vi.fn(async () => ({ ok: false, error: "维度不兼容" })),
      },
    });

    await import("./panel");
    await Promise.resolve();

    const first = document.querySelector('.rag-model-card[data-value="bgem3"]') as HTMLButtonElement;
    first.classList.add("is-active");
    const second = document.querySelector('.rag-model-card[data-value="text-embedding-3"]') as HTMLButtonElement;
    second.click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(alertSpy).not.toHaveBeenCalled();
    // 失败回滚：原卡片恢复激活态
    expect(first.classList.contains("is-active")).toBe(true);
    expect(second.classList.contains("is-active")).toBe(false);
    // 共享错误模态框出现并带异常详情
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("模型切换失败");
    expect(dialog!.textContent).toContain("维度不兼容");
    alertSpy.mockRestore();
  });

  it("rebuild-required 时弹迁移确认，并带 action 重发", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const embeddingSetModel = vi.fn(async (model: string, action?: string) => {
      calls.push([model, action]);
      if (!action) {
        return { ok: false, reason: "rebuild-required", requires: "rebuild", clearedEntries: 0 };
      }
      return { ok: true, modelKey: model, clearedEntries: 0, rebuiltEntries: 7 };
    });
    Object.assign(window, { settings: { embeddingSetModel } });
    const e5 = addModelCard("e5-small");

    await import("./panel");
    await new Promise((resolve) => setTimeout(resolve, 0));

    e5.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 第一次不带 action（默认拒绝，不落盘）
    expect(calls[0]).toEqual(["e5-small", undefined]);
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("索引迁移");

    // 确认「重建索引」→ 带 action 重发
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls[1]).toEqual(["e5-small", "rebuild"]);
    // 成功后卡片保持选中
    expect(e5.classList.contains("is-active")).toBe(true);
  });

  it("rebuild-required 选「清空」→ 第二次确认后带 clear 重发", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const embeddingSetModel = vi.fn(async (model: string, action?: string) => {
      calls.push([model, action]);
      if (!action) return { ok: false, reason: "rebuild-required", requires: "rebuild", clearedEntries: 0 };
      return { ok: true, modelKey: model, clearedEntries: 5, rebuiltEntries: 0 };
    });
    Object.assign(window, { settings: { embeddingSetModel } });
    const e5 = addModelCard("e5-small");

    await import("./panel");
    await new Promise((resolve) => setTimeout(resolve, 0));

    e5.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 第一个确认框（重建）→ 取消（「其他方式」）进入清空确认
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const dialog = document.getElementById("cy-modal-overlay");
    expect(dialog?.textContent).toContain("清空索引");
    (document.getElementById("cy-modal-confirm") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls[1]).toEqual(["e5-small", "clear"]);
    expect(e5.classList.contains("is-active")).toBe(true);
  });

  it("rebuild-required 两步都取消 → 回滚选中且不再发起迁移", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const embeddingSetModel = vi.fn(async (model: string, action?: string) => {
      calls.push([model, action]);
      return { ok: false, reason: "rebuild-required", requires: "rebuild", clearedEntries: 0 };
    });
    Object.assign(window, { settings: { embeddingSetModel } });
    const bgem3 = document.querySelector('.rag-model-card[data-value="bgem3"]') as HTMLButtonElement;
    const e5 = addModelCard("e5-small");

    await import("./panel");
    await new Promise((resolve) => setTimeout(resolve, 0));

    e5.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    (document.getElementById("cy-modal-cancel") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 只发起了默认拒绝探测，没有带 action 的第二次调用
    expect(calls).toHaveLength(1);
    expect(bgem3.classList.contains("is-active")).toBe(true);
    expect(e5.classList.contains("is-active")).toBe(false);
    expect(window.localStorage.getItem("cyrene.rag.model")).toBe("bgem3");
  });

  it("切换在途：卡片禁用，完成后恢复（P2-2 busy）", async () => {
    let release!: (value: unknown) => void;
    const embeddingSetModel = vi.fn(
      () => new Promise((resolve) => { release = resolve; }),
    );
    Object.assign(window, { settings: { embeddingSetModel } });
    const e5 = addModelCard("e5-small");

    await import("./panel");
    await new Promise((resolve) => setTimeout(resolve, 0));

    e5.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const bgem3 = document.querySelector('.rag-model-card[data-value="bgem3"]') as HTMLButtonElement;
    expect(bgem3.disabled).toBe(true);
    expect(e5.disabled).toBe(true);

    release({ ok: true, modelKey: "e5-small", clearedEntries: 1, rebuiltEntries: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bgem3.disabled).toBe(false);
    expect(e5.disabled).toBe(false);
  });
});
