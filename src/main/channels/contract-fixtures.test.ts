/**
 * 渠道契约 fixtures（TS 侧 runner）。
 *
 * 与 C# 侧（dotnet/smoke-host --selftest channel-contract fixtures/channels）共用同一套
 * fixtures/channels/cases/*.json，两侧结果必须逐字段一致
 * （docs/design/2026-10-05-server-channel.md §8.1/§8.2）。
 *
 * case 格式见 fixtures/channels/README.md；`expect` 的键必须与实际结果精确一致
 * （缺省键必须缺省）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IncomingMessage, OutgoingMessage } from "./types";
import {
  buildFeishuSendRequests,
  buildQqBotPassiveReplies,
  buildWechatSendRequests,
  channelCapability,
  makeAssistantEventId,
  makeChannelTurnId,
  makeChannelUserEventId,
  makeProactiveEventId,
  makeSessionId,
  normalizeFeishuInbound,
  normalizeQqBotEvent,
  normalizeWechatInbound,
} from "./normalizers";
import { splitTextBySentenceBreaks } from "../../shared/message-segmentation";
import { splitQqText } from "./normalizers/qq-text";

const casesDir = path.join(process.cwd(), "fixtures", "channels", "cases");
const caseFiles = fs.readdirSync(casesDir).filter((file) => file.endsWith(".json")).sort();

interface FixtureCase {
  name?: string;
  kind: "inbound" | "outbound" | "derived-ids" | "text-split" | "capability";
  channel: "wechat" | "feishu" | "qqbot";
  input: Record<string, unknown>;
  expect: unknown;
}

/** 归一化 Date/undefined → JSON 语义（与 C# 序列化对齐；_raw 不进契约）。 */
function toContractJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? undefined : item)));
}

function runInbound(fixture: FixtureCase): unknown {
  const input = fixture.input as { raw: unknown; now?: string };
  const now = new Date(input.now ?? "1970-01-01T00:00:00.000Z");
  if (fixture.channel === "wechat") {
    const result = normalizeWechatInbound(input.raw, { now });
    return result ? { message: result.message, media: result.media } : { message: null, media: [] };
  }
  if (fixture.channel === "feishu") {
    const result = normalizeFeishuInbound(input.raw, { now });
    return result ? { message: result.message, media: result.media } : { message: null, media: [] };
  }
  const raw = input.raw as { type?: unknown; data?: unknown };
  const message = normalizeQqBotEvent(String(raw.type ?? ""), (raw.data ?? {}) as Record<string, unknown>, { now });
  if (!message) return { message: null, media: [] };
  const { _raw, ...rest } = message as IncomingMessage & { _raw?: unknown };
  void _raw;
  return { message: rest, media: [] };
}

function runOutbound(fixture: FixtureCase): unknown {
  const input = fixture.input as {
    message: OutgoingMessage;
    contextToken?: string;
    clientId?: string;
    uploads?: Record<string, never>;
    voices?: Record<string, never>;
    receiveIdType?: "open_id" | "chat_id";
    durations?: Record<string, number>;
    messageId?: string;
    msgSeqUsed?: number;
    seqLimit?: number;
  };
  if (fixture.channel === "wechat") {
    return buildWechatSendRequests(input.message, {
      contextToken: input.contextToken ?? "",
      clientId: input.clientId ?? "",
      uploads: input.uploads,
      voices: input.voices,
    });
  }
  if (fixture.channel === "feishu") {
    return buildFeishuSendRequests(input.message, {
      receiveIdType: input.receiveIdType,
      uploads: input.uploads,
      durations: input.durations,
    });
  }
  return buildQqBotPassiveReplies(input.message, {
    messageId: input.messageId ?? "",
    msgSeqUsed: input.msgSeqUsed,
    seqLimit: input.seqLimit,
  });
}

function runDerivedIds(fixture: FixtureCase): unknown {
  const input = fixture.input as {
    channel: string;
    chatId: string;
    messageId?: string;
    at: string;
    text: string;
    anchorEventId: string;
    intentId: string;
  };
  const msg = {
    channel: input.channel,
    chatId: input.chatId,
    messageId: input.messageId,
    at: new Date(input.at),
    text: input.text,
  };
  const sessionId = makeSessionId(input.channel, input.chatId);
  return {
    sessionId,
    userTurnId: makeChannelTurnId(msg, "user"),
    assistantTurnId: makeChannelTurnId(msg, "assistant"),
    userEventId: makeChannelUserEventId(msg),
    assistantEventId: makeAssistantEventId(sessionId, input.anchorEventId),
    proactiveEventId: makeProactiveEventId(sessionId, input.intentId),
  };
}

function runTextSplit(fixture: FixtureCase): unknown {
  const input = fixture.input as { text: string; limit?: number };
  const parts = fixture.channel === "qqbot"
    ? splitQqText(input.text, input.limit ?? 1500)
    : splitTextBySentenceBreaks(input.text, input.limit ?? 10);
  return { parts };
}

function runCase(fixture: FixtureCase): unknown {
  switch (fixture.kind) {
    case "inbound": return runInbound(fixture);
    case "outbound": return runOutbound(fixture);
    case "derived-ids": return runDerivedIds(fixture);
    case "text-split": return runTextSplit(fixture);
    case "capability": return channelCapability(fixture.channel);
  }
}

describe("渠道契约 fixtures（TS 侧 runner）", () => {
  it("cases 目录非空", () => {
    expect(caseFiles.length).toBeGreaterThan(0);
  });

  for (const file of caseFiles) {
    const fixture = JSON.parse(fs.readFileSync(path.join(casesDir, file), "utf8")) as FixtureCase;
    it(`${file}｜${fixture.name ?? ""}`, () => {
      expect(toContractJson(runCase(fixture))).toEqual(fixture.expect);
    });
  }
});
