import { describe, expect, it } from "vitest";
import { normalizeTokenizerModelId } from "./models";

describe("normalizeTokenizerModelId", () => {
  it("精确匹配（大小写不敏感）", () => {
    expect(normalizeTokenizerModelId("DeepSeek-V4.1-Flash")).toBe("deepseek-v4.1-flash");
    expect(normalizeTokenizerModelId("GLM-5.3")).toBe("glm-5.3");
  });

  it("容忍 org/model 前缀", () => {
    expect(normalizeTokenizerModelId("deepseek-ai/DeepSeek-V4.1-Flash")).toBe("deepseek-v4.1-flash");
    expect(normalizeTokenizerModelId("zai-org/GLM-5.3-Flash")).toBe("glm-5.3-flash");
  });

  it("家族变体前缀匹配（最长 key 优先）", () => {
    expect(normalizeTokenizerModelId("qwen3-235b-a22b")).toBe("qwen3");
    expect(normalizeTokenizerModelId("qwen3.5-397b-a17b")).toBe("qwen3.5");
    expect(normalizeTokenizerModelId("qwen3.8-27b-instruct")).toBe("qwen3.8-27b");
    expect(normalizeTokenizerModelId("glm-5-air")).toBe("glm-5");
    expect(normalizeTokenizerModelId("minimax-m2.1-turbo")).toBe("minimax-m2.1");
  });

  it("清单外返回 null", () => {
    expect(normalizeTokenizerModelId("gpt-5")).toBeNull();
    expect(normalizeTokenizerModelId("qwen2.5-72b")).toBeNull();
    expect(normalizeTokenizerModelId("")).toBeNull();
    expect(normalizeTokenizerModelId(undefined)).toBeNull();
  });
});
