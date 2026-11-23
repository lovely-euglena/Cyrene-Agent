/** 双轨开关解析器测试（阶段 0 验收）。 */
import { describe, expect, it } from "vitest";
import { parseConfFile, resolveDotnetConfigFrom } from "./config";

describe("parseConfFile", () => {
  it("KEY=VALUE / 注释 / 空白容错", () => {
    const conf = parseConfFile(`
# 注释行
CYRENE_TOOL_HOST=0
  CYRENE_VAD = local

broken line no eq
=noname
`);
    expect(conf.CYRENE_TOOL_HOST).toBe("0");
    expect(conf.CYRENE_VAD).toBe("local");
    expect(Object.keys(conf)).toHaveLength(2);
  });
});

describe("resolveDotnetConfigFrom", () => {
  it("默认值", () => {
    const c = resolveDotnetConfigFrom({}, null);
    expect(c.toolHost).toBe(true);
    expect(c.agentHost).toBe(false);
    expect(c.vad).toBe("hybrid");
    expect(c.live2dEngine).toBe("web");
  });

  it("环境变量覆盖 conf，conf 覆盖默认", () => {
    const c = resolveDotnetConfigFrom(
      { CYRENE_RAG_HOST: "1" },
      "CYRENE_RAG_HOST=0\nCYRENE_VOICE_HOST=1\nCYRENE_MCP_HTTP=1",
    );
    expect(c.ragHost).toBe(true); // env 赢
    expect(c.voiceHost).toBe(true); // conf 赢
    expect(c.mcpHttp).toBe(true);
  });

  it("非法枚举回退默认；布尔真值形态宽松", () => {
    const c = resolveDotnetConfigFrom(
      { CYRENE_VAD: "weird", CYRENE_AGENT_HOST: "true", CYRENE_LOOP_HOST: "on" },
      null,
    );
    expect(c.vad).toBe("hybrid");
    expect(c.agentHost).toBe(true);
    expect(c.loopHost).toBe(true);
  });

  it("LIVE2D_ENGINE 双轨开关（#257 T5）：env/conf 覆盖，非法值回退 web", () => {
    expect(resolveDotnetConfigFrom({ LIVE2D_ENGINE: "dotnet" }, null).live2dEngine).toBe("dotnet");
    expect(resolveDotnetConfigFrom({}, "LIVE2D_ENGINE=dotnet").live2dEngine).toBe("dotnet");
    // env 赢 conf
    expect(
      resolveDotnetConfigFrom({ LIVE2D_ENGINE: "web" }, "LIVE2D_ENGINE=dotnet").live2dEngine,
    ).toBe("web");
    // 大小写宽松；非法值回退默认 web
    expect(resolveDotnetConfigFrom({ LIVE2D_ENGINE: "DOTNET" }, null).live2dEngine).toBe("dotnet");
    expect(resolveDotnetConfigFrom({ LIVE2D_ENGINE: "weird" }, null).live2dEngine).toBe("web");
  });
});
