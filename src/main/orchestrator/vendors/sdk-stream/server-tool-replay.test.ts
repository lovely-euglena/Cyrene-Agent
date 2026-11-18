import { describe, expect, it } from "vitest";
import { CyreneStreamAccumulator } from "./accumulator";
import { normalizeOpenAIChunk } from "./openai-normalizer";
import type { ChatMessage } from "../../../../shared/chat-types";

/**
 * read_url 回传链（issue #253 P1）：server_tool_use/read_link 块的
 * 解析→收集→持久化形态→回放。真网样本未到位——形态按 OpenAI 兼容流
 * 推测（normalizer 双探），mock 流驱动；真网首测后校准字段名。
 */

const SIGNATURE = "srv_sig_c4f9a1b7e2d8"; // 服务端续接凭证（示例形态）

describe("server_tool_call 流解析", () => {
  it("delta.server_tool_use 直挂形态：解析出 tool/input/signature", () => {
    const deltas = normalizeOpenAIChunk({
      choices: [{
        delta: {
          server_tool_use: {
            id: "call_1", tool: "read_link",
            input: { url: "https://example.com/article" },
            signature: SIGNATURE,
          },
        },
      }],
    });
    expect(deltas).toContainEqual({
      type: "server_tool_call",
      callId: "call_1", tool: "read_link",
      input: { url: "https://example.com/article" },
      signature: SIGNATURE,
    });
  });

  it("delta.tool_calls 非 function type 形态：同样识别", () => {
    const deltas = normalizeOpenAIChunk({
      choices: [{
        delta: {
          tool_calls: [{
            id: "call_2", type: "read_link",
            input: { url: "https://example.com/2" },
            signature: SIGNATURE,
          }],
        },
      }],
    });
    expect(deltas).toContainEqual(expect.objectContaining({
      type: "server_tool_call", tool: "read_link", signature: SIGNATURE,
    }));
  });

  it("function 工具调用不误判为 server_tool_call", () => {
    const deltas = normalizeOpenAIChunk({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id: "f1", type: "function", function: { name: "read_file", arguments: "{}" } }],
        },
      }],
    });
    expect(deltas.filter(d => d.type === "server_tool_call")).toHaveLength(0);
  });
});

describe("accumulator 收集与终态", () => {
  it("serverToolCalls 原样进 snapshot 与 assistantMessage.serverToolTrace", () => {
    const acc = new CyreneStreamAccumulator();
    for (const d of normalizeOpenAIChunk({
      choices: [{
        delta: {
          server_tool_use: {
            id: "call_1", tool: "read_link",
            input: { url: "https://example.com/article" },
            signature: SIGNATURE,
          },
        },
      }],
    })) acc.apply(d);
    for (const d of normalizeOpenAIChunk({
      choices: [{ delta: { content: "正文" } }],
    })) acc.apply(d);

    expect(acc.snapshot().serverToolCalls).toEqual([{
      callId: "call_1", tool: "read_link",
      input: { url: "https://example.com/article" },
      signature: SIGNATURE,
    }]);

    const res = acc.finalize({});
    expect(res.assistantMessage.serverToolTrace).toEqual([{
      callId: "call_1", tool: "read_link",
      input: { url: "https://example.com/article" },
      signature: SIGNATURE,
    }]);
  });

  it("无服务端工具时 serverToolTrace 不落键（向后兼容：缺省=无往返）", () => {
    const acc = new CyreneStreamAccumulator();
    for (const d of normalizeOpenAIChunk({ choices: [{ delta: { content: "hi" } }] })) acc.apply(d);
    const res = acc.finalize({});
    expect("serverToolTrace" in res.assistantMessage).toBe(false);
  });
});

describe("多轮回放（OpenAI 轨 wire 组装）", () => {
  it("assistant 历史带 serverToolTrace → wire.server_tool_use 原样回传 signature", async () => {
    const { OpenAICompatAdapter } = await import("../openai-adapter");
    const adapter = new OpenAICompatAdapter("deepseek", {
      id: "deepseek", displayName: "DeepSeek", protocol: "openai",
      transport: "openai", baseUrl: "https://api.deepseek.com/v1", authStyle: "bearer",
      defaultModel: "deepseek-flash", supportsTools: true, supportsThinking: false,
      thinkingField: null, cacheStrategy: "none", testStrategy: "text", defaultModels: [],
    } as never);
    const history: ChatMessage[] = [{
      id: "m1", role: "assistant", content: "正文",
      serverToolTrace: [{
        callId: "call_1", tool: "read_link",
        input: { url: "https://example.com/article" },
        signature: SIGNATURE,
      }],
    }];
    const req = adapter.buildRequest({
      model: "deepseek-flash",
      messages: [{ role: "user", content: "问" }, ...history],
    } as never, { provider: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "k" } as never);
    const body = JSON.parse(req.body);
    const assistantWire = body.messages.find((m: { role: string }) => m.role === "assistant");
    expect(assistantWire.server_tool_use).toEqual([{
      type: "read_link",
      id: "call_1",
      input: { url: "https://example.com/article" },
      signature: SIGNATURE,
    }]);
  });
});
