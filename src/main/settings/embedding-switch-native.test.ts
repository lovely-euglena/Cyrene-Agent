// native/WPF「昔涟设置」embedding 切换流程（复审 P1-1 / P2-3）：
//   - reject（switch 抛错 / save 抛错）：结构化回执带 embeddingSwitchFailed +
//     embeddingModel（WPF ApplyNotice 据此 RefreshSection 撤销乐观选中）；
//   - ok:false：rebuild-required 带 requires，其它失败带 embeddingSwitchFailed；
//   - ok：先 saveModelSettings 落盘，再 best-effort finalize（对账 → 贴纸失效 →
//     贴纸重建），最后广播 + 推快照 + ok 回执。
import { describe, expect, it, vi } from "vitest";
import {
  notifyEmbeddingSwitchRejected,
  runNativeEmbeddingSwitch,
  type NativeEmbeddingSwitchDeps,
} from "./embedding-switch-native";
import type { EmbeddingSwitchResult } from "../rag";

function makeDeps(switchImpl: () => Promise<EmbeddingSwitchResult>) {
  const order: string[] = [];
  const notice = vi.fn();
  const deps: NativeEmbeddingSwitchDeps = {
    switchEmbeddingModel: () => switchImpl(),
    finalize: {
      reconcileUserMemoryIndex: async () => { order.push("reconcile"); },
      invalidateStickerEmbeddingIndex: () => { order.push("invalidate"); },
      refreshStickerEmbeddingIndex: () => { order.push("refresh"); },
    },
    saveModelSettings: () => { order.push("save"); return {}; },
    broadcastModelChanged: () => { order.push("broadcast"); },
    pushSettingsSnapshotToNative: () => { order.push("snapshot"); },
    nativeNotice: notice,
  };
  return { deps, notice, order };
}

const okResult: EmbeddingSwitchResult = {
  ok: true,
  modelKey: "e5-small",
  clearedEntries: 0,
  rebuiltEntries: 2,
};

describe("runNativeEmbeddingSwitch", () => {
  it("switch reject：结构化回执带 embeddingSwitchFailed + 模型键，不落盘（P1-1）", async () => {
    const { deps, notice, order } = makeDeps(async () => { throw new Error("import boom"); });

    await runNativeEmbeddingSwitch("e5-small", undefined, { runtimeSync: "llm" }, deps);

    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "error",
      "嵌入模型切换失败：import boom",
      { embeddingSwitchFailed: true, embeddingModel: "e5-small" },
    );
    expect(order).toEqual(["snapshot"]); // 未保存设置、未收尾
  });

  it("save 抛错（ok 回调内）：同样走结构化 reject 回执（P1-1）", async () => {
    const { deps, notice } = makeDeps(async () => okResult);
    deps.saveModelSettings = () => { throw new Error("disk full"); };

    await runNativeEmbeddingSwitch("e5-small", "clear", {}, deps);

    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "error",
      "嵌入模型切换失败：disk full",
      { embeddingSwitchFailed: true, embeddingModel: "e5-small" },
    );
  });

  it("ok:false rebuild-required：结构化 data 带 requires（WPF 弹迁移确认）", async () => {
    const { deps, notice, order } = makeDeps(async () => ({
      ok: false,
      modelKey: "e5-small",
      clearedEntries: 0,
      requires: "rebuild",
      reason: "rebuild-required",
    }));

    await runNativeEmbeddingSwitch("e5-small", undefined, {}, deps);

    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "error",
      expect.stringContaining("嵌入模型切换未生效"),
      { rebuildRequired: true, embeddingModel: "e5-small", requires: "rebuild" },
    );
    expect(order).toEqual([]);
  });

  it("ok:false 其它失败：结构化 data 带 embeddingSwitchFailed", async () => {
    const { deps, notice } = makeDeps(async () => ({
      ok: false,
      modelKey: "e5-small",
      clearedEntries: 0,
      error: "model not found",
    }));

    await runNativeEmbeddingSwitch("e5-small", undefined, {}, deps);

    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "error",
      "嵌入模型切换未生效：model not found",
      { embeddingSwitchFailed: true, embeddingModel: "e5-small" },
    );
  });

  it("ok：先 save 再 finalize 三步，最后广播/推快照/ok 回执（P2-3）", async () => {
    const { deps, notice, order } = makeDeps(async () => okResult);

    await runNativeEmbeddingSwitch("e5-small", "rebuild", { runtimeSync: "llm" }, deps);

    expect(order).toEqual(["save", "reconcile", "invalidate", "refresh", "broadcast", "snapshot"]);
    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "ok",
      "嵌入模型已切换（重建 2 条，清空 0 条）",
    );
  });
});

describe("notifyEmbeddingSwitchRejected", () => {
  it("动态 import 失败回执与流程内 reject 同口径（P1-1）", () => {
    const notice = vi.fn();
    notifyEmbeddingSwitchRejected(notice, new Error("cannot find module"), "bgem3");

    expect(notice).toHaveBeenCalledWith(
      "cyrene",
      "error",
      "嵌入模型切换失败：cannot find module",
      { embeddingSwitchFailed: true, embeddingModel: "bgem3" },
    );
  });
});
