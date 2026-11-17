// resolver 行为基准（golden）—— 直测 resolveReasoningCapability 的四类关键场景。
//
// 与 order-snapshot 的分工：snapshot 证明"数据没变"，本文件证明"行为没变"。
// 数据一致但行为退化（例如恒等判断被破坏）只有这里能抓住。
import { describe, expect, test } from "vitest";
import { resolveReasoningCapability } from "../reasoning";
import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";

describe("resolveReasoningCapability — 行为基准", () => {
  test("同厂商精确命中：glm + glm-5.3 → 强制思考 + autoEffort=high", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
  });

  test("厂商内排序敏感：qwen + qwen3-thinking → /-thinking$/ 先于 /^qwen3/ 命中 fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-thinking");
    expect(cap.control).toBe("fixed-on");
    expect(cap.requestStyle).toBe("none");
  });

  test("托管端点跨家族二轮：doubao + glm-5.3（方舟上跑 GLM）→ 找回 glm 家族规则", () => {
    const cap = resolveReasoningCapability("doubao", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.autoEffort).toBe("high");
  });

  test("跨家族二轮另一向：glm + gpt-6 → 找回 chatgpt 家族规则", () => {
    const cap = resolveReasoningCapability("glm", "gpt-6");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
  });

  test("未知模型落兜底：glm + 完全不匹配的模型名 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("glm", "totally-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(cap.control).toBe("none");
  });

  test("未知厂商 + 未知模型 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("some-unknown-vendor", "some-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  test("兜底单例全局唯一：所有厂商表尾 /.*/ 引用同一实例", () => {
    for (const vendorId of ["chatgpt", "claude", "deepseek", "glm", "qwen", "kimi", "minimax", "mimo", "doubao"]) {
      const cap = resolveReasoningCapability(vendorId, "zzz-no-such-model");
      expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    }
  });
  test("qwen + qwen4-max → reasoning_effort 三档 low/high/xhigh，默认 high，可关闭", () => {
    const cap = resolveReasoningCapability("qwen", "qwen4-max");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "xhigh"]);
    expect(cap.defaultEffort).toBe("high");
    expect(cap.supportsDisable).toBe(true);
  });
  test("Qwen4-Max 规则可跨厂商推断：托管端点使用同一型号名", () => {
    expect(resolveReasoningCapability("unknown-provider", "qwen4-max").defaultEffort).toBe("high");
  });
  // 预期值按官方模型页与 OpenAI 兼容文档独立填写（核验 2026-11-13）：四档含 xhigh，默认 high。
  test("gemini + gemini-4-neon → reasoning_effort 四档 low/medium/high/xhigh，默认 high，不可关闭", () => {
    const cap = resolveReasoningCapability("gemini", "gemini-4-neon");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh"]);
    expect(cap.defaultEffort).toBe("high");
    expect(cap.supportsDisable).toBe(false);
    expect(resolveReasoningCapability("unknown-provider", "gemini-4-neon").defaultEffort).toBe("high");
  });
  // 预期值按官方推理指南与 GPT-6.2 迁移指南独立填写（核验 2026-11-18），不从注册表复制。
  test.each(["gpt-6.2-astra", "gpt-6.2-sol"])("chatgpt + %s → 五档 effort，默认 medium，拒绝 none 不可关闭", (model) => {
    const cap = resolveReasoningCapability("chatgpt", model);
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cap.defaultEffort).toBe("medium");
    expect(cap.supportsDisable).toBe(false);
    expect(resolveReasoningCapability("unknown-provider", model).supportsDisable).toBe(false);
  });
});


