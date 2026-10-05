// 本地 embedding 模型注册表（第二引擎 IKIH28）：
// LOCAL_MODELS 是模型 key → HF 名称/维度 的唯一真值点，设置归一化、
// provider 构造、路径探测都从这里派生。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cyrene-registry-test",
    getName: () => "cyrene-test",
    getAppPath: () => "/tmp/cyrene-registry-test",
  },
}));

import {
  DEFAULT_MODEL_KEY,
  LOCAL_MODELS,
  LOCAL_MODEL_KEYS,
  isLocalModelKey,
} from "./embedding-pipeline";

describe("LOCAL_MODELS registry", () => {
  it("bgem3：Xenova/bge-m3，1024 维", () => {
    expect(LOCAL_MODELS.bgem3).toEqual({ key: "bgem3", hfName: "Xenova/bge-m3", dims: 1024 });
  });

  it("e5-small：Xenova/multilingual-e5-small，384 维", () => {
    expect(LOCAL_MODELS["e5-small"]).toEqual({
      key: "e5-small",
      hfName: "Xenova/multilingual-e5-small",
      dims: 384,
    });
  });

  it("默认模型仍是 bgem3，注册键完整", () => {
    expect(DEFAULT_MODEL_KEY).toBe("bgem3");
    expect(LOCAL_MODEL_KEYS).toEqual(["bgem3", "e5-small"]);
  });

  it("isLocalModelKey 只放行注册键（原型链/空值拒绝）", () => {
    expect(isLocalModelKey("bgem3")).toBe(true);
    expect(isLocalModelKey("e5-small")).toBe(true);
    expect(isLocalModelKey("bge-m3")).toBe(false);
    expect(isLocalModelKey("constructor")).toBe(false);
    expect(isLocalModelKey(undefined)).toBe(false);
    expect(isLocalModelKey(null)).toBe(false);
    expect(isLocalModelKey(42)).toBe(false);
  });

  it("两个模型维度不同（迁移判定依赖这一点）", () => {
    expect(LOCAL_MODELS.bgem3.dims).not.toBe(LOCAL_MODELS["e5-small"].dims);
  });
});
