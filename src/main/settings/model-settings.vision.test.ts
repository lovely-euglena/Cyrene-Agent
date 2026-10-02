// loadVisionConfig 与旧配置迁移的回归测试：
// 主模型走 Anthropic 协议时视觉链路拼 /chat/completions 必然 404，
// 必须改用独立视觉模型；老配置里已配好的独立视觉模型不能被 multimodal 默认值静默旁路。
// multimodal 旧配置一次性迁移：旧文件（无 schemaVersion）首次 normalize 时执行三层判定；
// 已迁移文件（schemaVersion >= 2）不再进该迁移分支，multimodal 只认显式字段。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" } }));

import { loadVisionConfig, normalizeModelSettings, type ModelSettings, type VisionModelConfig } from "./model-settings";

// 旧版 vision 配置带 syncWithMain 标记（迁移用），比 VisionModelConfig 多一个可选字段
type LegacyVision = VisionModelConfig & { syncWithMain?: boolean };

const MINIMAX_BASE = {
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
} as const;

const COMPLETE_VISION: LegacyVision = {
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "sk-vision",
  model: "MiniMax-M3",
};

function makeSettings(overrides: Record<string, unknown> = {}): ModelSettings {
  return normalizeModelSettings({ ...MINIMAX_BASE, ...overrides });
}

describe("loadVisionConfig 主模型 Anthropic 协议降级", () => {
  it("multimodal=true + anthropic 协议 + 独立视觉模型齐全 → 用独立视觉模型（不再 404）", () => {
    const s = makeSettings({ multimodal: true, vision: COMPLETE_VISION });
    const cfg = loadVisionConfig(s);
    expect(cfg?.baseUrl).toBe("https://api.minimaxi.com/v1");
    expect(cfg?.apiKey).toBe("sk-vision");
  });

  it("multimodal=true + anthropic 协议 + 视觉模型不齐全 → 回落主模型配置（行为不变）", () => {
    const s = makeSettings({
      multimodal: true,
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    const cfg = loadVisionConfig(s);
    expect(cfg?.baseUrl).toBe("https://api.minimaxi.com/anthropic");
    expect(cfg?.apiKey).toBe("sk-test");
  });

  it("multimodal=true + openai 协议 → 仍用主模型配置直发（行为不变）", () => {
    const s = makeSettings({
      provider: "Kimi（月之暗面）",
      baseUrl: "https://api.moonshot.cn/v1",
      explicitTransport: "openai",
      multimodal: true,
      vision: COMPLETE_VISION,
    });
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.moonshot.cn/v1");
  });

  it("multimodal=false → 用独立视觉模型（既有行为不变）", () => {
    const s = makeSettings({ multimodal: false, vision: COMPLETE_VISION });
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.minimaxi.com/v1");
  });

  it("多模态开着但主模型没配 key → null（诚实拒绝）", () => {
    const s = makeSettings({ multimodal: true, apiKey: "" });
    expect(loadVisionConfig(s)).toBeNull();
  });
});

describe("normalizeModelSettings 旧配置一次性迁移（schemaVersion 1 → 5）", () => {
  it("旧配置无 multimodal 字段 + 独立视觉模型齐全 → multimodal 落 false（不静默旁路），并升级 schema", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(false);
    expect(s.schemaVersion).toBe(5);
    expect(loadVisionConfig(s)?.baseUrl).toBe("https://api.minimaxi.com/v1");
  });

  it("旧配置 syncWithMain=true → multimodal 落 true（与主模型同步）", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { ...COMPLETE_VISION, syncWithMain: true },
    });
    expect(s.multimodal).toBe(true);
    expect(s.schemaVersion).toBe(5);
  });

  it("旧配置无视觉模型 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE });
    expect(s.multimodal).toBe(true);
  });

  it("multimodal 已持久化 → 不被迁移翻转（用户显式选择优先）", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, multimodal: true, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(true);
  });

  it("旧配置视觉模型不齐全 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    expect(s.multimodal).toBe(true);
  });

  it("迁移落盘后（schemaVersion: 2）重启 → 不再进迁移分支，syncWithMain 被忽略", () => {
    // 模拟第二轮启动：上一轮迁移结果（multimodal: false）已持久化，vision 里残留的
    // syncWithMain 标记不再有任何效果
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      schemaVersion: 2,
      multimodal: false,
      vision: { ...COMPLETE_VISION, syncWithMain: true },
    } as Partial<ModelSettings>);
    expect(s.multimodal).toBe(false);
    expect(s.schemaVersion).toBe(5);
  });

  it("schemaVersion: 2 且无 multimodal 字段 → 缺省 true，不被视觉模型配置旁路", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      schemaVersion: 2,
      vision: COMPLETE_VISION,
    } as Partial<ModelSettings>);
    expect(s.multimodal).toBe(true);
  });
});
