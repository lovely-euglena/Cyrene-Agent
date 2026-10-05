// reranker mode → 模型目录（第二引擎 IKIH28）。
// 覆盖：standard/v2-m3 各自解析目录、未安装自动降级 none、安装状态双档位。
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  installed: new Set<string>(),
  dirCalls: [] as Array<[string, string]>,
}));

vi.mock("./model-status", () => ({
  getProjectModelBaseDir: (kind: string, modelKey: string) =>
    state.installed.has(modelKey) ? `/models/${kind}` : null,
  getProjectModelDir: (kind: string, modelKey: string) => {
    state.dirCalls.push([kind, modelKey]);
    return state.installed.has(modelKey) ? `/models/${kind}/${modelKey}` : null;
  },
}));

// 单测不走 .NET sidecar / transformers.js：只验证 mode→目录路由
vi.mock("./embedding-sidecar", () => ({
  isSidecarEnabled: () => false,
  getEmbeddingSidecarClient: () => null,
}));

import {
  getReranker,
  getRerankerInstallStatus,
  getRerankerMode,
  initReranker,
  resetReranker,
} from "./reranker";

beforeEach(() => {
  resetReranker();
  state.installed.clear();
  state.dirCalls.length = 0;
});

describe("initReranker: mode → 模型目录", () => {
  it("standard → bge-reranker-base", async () => {
    state.installed.add("standard");
    await initReranker("standard");
    expect(getRerankerMode()).toBe("standard");
    expect(getReranker()?.name).toBe("bge-reranker-base");
    expect(state.dirCalls).toContainEqual(["reranker", "standard"]);
  });

  it("v2-m3 → bge-reranker-v2-m3（bare 目录）", async () => {
    state.installed.add("v2-m3");
    await initReranker("v2-m3");
    expect(getRerankerMode()).toBe("v2-m3");
    expect(getReranker()?.name).toBe("bge-reranker-v2-m3");
    expect(state.dirCalls).toContainEqual(["reranker", "v2-m3"]);
    // 只查了 v2-m3，没有回落 standard
    expect(state.dirCalls.every(([, key]) => key === "v2-m3")).toBe(true);
  });

  it("v2-m3 未安装 → 自动降级 none（不抛错）", async () => {
    await initReranker("v2-m3");
    expect(getRerankerMode()).toBe("none");
    expect(getReranker()).toBeNull();
  });

  it("standard 未安装 → 自动降级 none（沿用既有语义）", async () => {
    await initReranker("standard");
    expect(getRerankerMode()).toBe("none");
    expect(getReranker()).toBeNull();
  });

  it("none → 直接关闭（即使模型已安装也不加载）", async () => {
    state.installed.add("standard");
    state.installed.add("v2-m3");
    await initReranker("none");
    expect(getRerankerMode()).toBe("none");
    expect(getReranker()).toBeNull();
    expect(state.dirCalls).toEqual([]);
  });

  it("切换模式会替换当前 provider", async () => {
    state.installed.add("standard");
    state.installed.add("v2-m3");
    await initReranker("standard");
    expect(getReranker()?.name).toBe("bge-reranker-base");
    await initReranker("v2-m3");
    expect(getReranker()?.name).toBe("bge-reranker-v2-m3");
    expect(getRerankerMode()).toBe("v2-m3");
  });
});

describe("getRerankerInstallStatus", () => {
  it("按 standard / v2-m3 两个 modelKey 分别探测", () => {
    state.installed.add("v2-m3");
    expect(getRerankerInstallStatus()).toEqual({ standard: false, "v2-m3": true });
  });
});
