/**
 * agent-orchestrator 跨语言契约回归：
 *   1. C# OrchestratorOps 的字面量集合 == TS protocol.ts 全部 op/帧名/事件名；
 *   2. C# OrchestratorLimits 每个上限与 TS ORCHESTRATOR_LIMITS 同名同值；
 *   3. Program.cs 注册 --agent-orchestrator 入口。
 * 历史教训（native-settings-protocol）：跨语言字符串协议没有契约测试时，
 * 任何一侧改名都会变成静默丢帧。
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ORCHESTRATOR_CLIENT_FRAME_OPS,
  ORCHESTRATOR_EVENT_NAMES,
  ORCHESTRATOR_HOST_FRAME_OPS,
  ORCHESTRATOR_LIMITS,
  ORCHESTRATOR_REQUEST_OPS,
} from "./protocol";

const orchestratorCs = fs.readFileSync(
  fileURLToPath(new URL("../../../../dotnet/native-windows/Agents/AgentOrchestrator.cs", import.meta.url)),
  "utf8",
);
const programCs = fs.readFileSync(
  fileURLToPath(new URL("../../../../dotnet/native-windows/Program.cs", import.meta.url)),
  "utf8",
);

function extractCsStringConsts(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of source.matchAll(/public const string (\w+) = "([^"]+)";/g)) {
    out.set(match[1], match[2]);
  }
  return out;
}

function extractCsIntConsts(source: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of source.matchAll(/public const int (\w+) = ([\d_]+);/g)) {
    out.set(match[1], Number(match[2].replace(/_/g, "")));
  }
  return out;
}

/** C# 常量名 → TS ORCHESTRATOR_LIMITS 键（显式映射，不猜命名）。 */
const LIMIT_NAME_MAP: Record<string, keyof typeof ORCHESTRATOR_LIMITS> = {
  MaxGroups: "maxGroups",
  MaxSessionsPerGroup: "maxSessionsPerGroup",
  MailboxDepth: "mailboxDepth",
  MaxMessageChars: "maxMessageChars",
  DefaultStepTimeoutMs: "defaultStepTimeoutMs",
  MaxQueuedTurnsPerGroup: "maxQueuedTurnsPerGroup",
};

describe("agent-orchestrator 跨语言契约", () => {
  it("C# OrchestratorOps 与 TS protocol 字面量集合完全一致", () => {
    const csConsts = extractCsStringConsts(orchestratorCs);
    expect(csConsts.size).toBeGreaterThan(0);
    const csValues = [...csConsts.values()].sort();
    const tsValues = [
      ...Object.values(ORCHESTRATOR_REQUEST_OPS),
      ...Object.values(ORCHESTRATOR_HOST_FRAME_OPS),
      ...Object.values(ORCHESTRATOR_CLIENT_FRAME_OPS),
      ...Object.values(ORCHESTRATOR_EVENT_NAMES),
    ].sort();
    expect(csValues).toEqual(tsValues);
  });

  it("C# OrchestratorLimits 与 TS ORCHESTRATOR_LIMITS 同名同值", () => {
    const csLimits = extractCsIntConsts(orchestratorCs);
    const mapped = new Map<string, number>();
    for (const [csName, csValue] of csLimits) {
      const tsKey = LIMIT_NAME_MAP[csName];
      if (!tsKey) continue; // 允许 C# 侧存在本契约未映射的纯实现常量
      mapped.set(tsKey, csValue);
    }
    for (const [tsKey, tsValue] of Object.entries(ORCHESTRATOR_LIMITS)) {
      expect(mapped.get(tsKey), `缺上限映射: ${tsKey}`).toBe(tsValue);
    }
  });

  it("Program.cs 注册 --agent-orchestrator 入口", () => {
    expect(programCs).toContain('"--agent-orchestrator"');
    expect(programCs).toContain("Agents.AgentOrchestrator.RunProtocolLoop()");
  });
});
