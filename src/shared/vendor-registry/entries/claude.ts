// claude（Anthropic）的注册表条目 —— 推理规则自 shared/reasoning.ts、能力自 capabilities.ts 原样迁入。
import { defineVendor } from "../types";
import { UNKNOWN_REASONING_CAPABILITY } from "../fallback";

export const CLAUDE_REGISTRY = defineVendor({
  capability: {
    id: "claude",
    displayName: "Claude（Anthropic）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    authStyle: "x-api-key",
    defaultModel: "claude-sonnet-4-6",
    supportsTools: true,
    supportsThinking: true,
    thinkingField: "thinking",
    cacheStrategy: "cache_control",
    testStrategy: "text",
    // 自家协议 only
    supportedTransports: ["anthropic"],
  },
  shortName: "Claude",
  reasoningRules: [
    // ── claude（Anthropic）──
    // v1.3.5 吸收（06c49749）：Fable 5.1 / Opus 5.5 / Opus 5 / Sonnet 5.5 对 tool_choice
    // any/tool 返回 400 且思考不能关闭（即使用户选「关闭」must-call 也必须落 auto）。
    // 完整名精确规则在前，历史 fable-5/sonnet-5 宽规则只兜日期后缀。
    { providerId: "claude", modelPattern: /^claude-(?:fable-5-1|opus-5(?:-5)?|sonnet-5-5)$/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: false,
    } },
    { providerId: "claude", modelPattern: /^claude-fable-5/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-sonnet-5/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-opus-4-(8|7|6)/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /^claude-sonnet-4-6/i, capability: {
      control: "toggle-effort",
      supportedEfforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "high",
      requestStyle: "anthropic-adaptive",
      supportsDisable: true,
    } },
    { providerId: "claude", modelPattern: /.*/, capability: UNKNOWN_REASONING_CAPABILITY },
  ],
});
