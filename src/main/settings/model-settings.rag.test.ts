// RAG 模型设置归一化（第二引擎 IKIH28）：
//   embeddingModel: "bgem3" | "e5-small"
//   rerankerMode:   "standard" | "v2-m3" | "none"
// 未知值一律回落默认（bgem3 / standard），不允许脏值进入运行时。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-settings-test" } }));

import { normalizeModelSettings } from "./model-settings";

describe("normalizeModelSettings: embeddingModel", () => {
  it("缺省/未知值回落 bgem3", () => {
    expect(normalizeModelSettings({}).embeddingModel).toBe("bgem3");
    expect(normalizeModelSettings({ embeddingModel: "bge-m3" } as never).embeddingModel).toBe("bgem3");
    expect(normalizeModelSettings({ embeddingModel: "" } as never).embeddingModel).toBe("bgem3");
    expect(normalizeModelSettings({ embeddingModel: null } as never).embeddingModel).toBe("bgem3");
  });

  it("接受 e5-small（第二模型）", () => {
    expect(normalizeModelSettings({ embeddingModel: "e5-small" }).embeddingModel).toBe("e5-small");
  });
});

describe("normalizeModelSettings: rerankerMode", () => {
  it("缺省/未知值回落 standard", () => {
    expect(normalizeModelSettings({}).rerankerMode).toBe("standard");
    expect(normalizeModelSettings({ rerankerMode: "light" } as never).rerankerMode).toBe("standard");
    expect(normalizeModelSettings({ rerankerMode: 1 } as never).rerankerMode).toBe("standard");
  });

  it("接受 v2-m3 与 none", () => {
    expect(normalizeModelSettings({ rerankerMode: "v2-m3" }).rerankerMode).toBe("v2-m3");
    expect(normalizeModelSettings({ rerankerMode: "none" }).rerankerMode).toBe("none");
  });
});
