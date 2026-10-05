/**
 * llm-host / secrets-host 契约一致性测试（H0 契约冻结）。
 *
 * 扫描 C# 事实源（LlmContracts.cs / SecretsHost.cs），抽取 op / 事件 / 错误码
 * 字符串，与 TS 侧镜像（llm-host-protocol.ts）逐字比对——任一侧改动必须同批
 * 同步，否则本测试红（同 native-settings-protocol 契约扫描先例）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LLM_EVENTS, LLM_ERRORS, LLM_LANES, LLM_OPS, SECRETS_OPS } from "./llm-host-protocol";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const CONTRACTS_CS = path.join(REPO_ROOT, "dotnet/cyrene-core/Llm/LlmContracts.cs");
const SECRETS_HOST_CS = path.join(REPO_ROOT, "dotnet/cyrene-core/Secrets/SecretsHost.cs");

function readCs(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** 抽 C# const：`public const string X = "y";` → [y] */
function extractConsts(cs: string, prefix: string): string[] {
  const re = new RegExp(`public const string ${prefix}\\w+ = "([^"]+)"`, "g");
  const out: string[] = [];
  for (const m of cs.matchAll(re)) out.push(m[1]);
  return out;
}

describe("llm-host 契约（LlmContracts.cs ↔ llm-host-protocol.ts）", () => {
  const cs = fs.readFileSync(CONTRACTS_CS, "utf8");

  it("ops：TS 每个值都在 C# 契约中", () => {
    const csOps = extractConsts(cs, "Op");
    for (const v of Object.values(LLM_OPS)) {
      expect(csOps, `op "${v}" 缺失于 LlmContracts.cs`).toContain(v);
    }
  });

  it("事件类型：TS 每个值都在 C# 契约中", () => {
    const csEvents = extractConsts(cs, "Ev");
    for (const v of Object.values(LLM_EVENTS)) {
      expect(csEvents, `event "${v}" 缺失于 LlmContracts.cs`).toContain(v);
    }
  });

  it("错误码：TS 每个值都在 C# 契约中", () => {
    const csErrors = extractConsts(cs, "Err");
    for (const v of Object.values(LLM_ERRORS)) {
      expect(csErrors, `error "${v}" 缺失于 LlmContracts.cs`).toContain(v);
    }
  });

  it("lane：TS 每个值都在 C# 契约中", () => {
    const csLanes = extractConsts(cs, "Lane");
    for (const v of Object.values(LLM_LANES)) {
      expect(csLanes, `lane "${v}" 缺失于 LlmContracts.cs`).toContain(v);
    }
  });

  it("C# 侧无未登记进 TS 镜像的契约字符串（防单侧漂移）", () => {
    const csAll = [
      ...extractConsts(cs, "Op"),
      ...extractConsts(cs, "Ev"),
      ...extractConsts(cs, "Err"),
      ...extractConsts(cs, "Lane"),
    ];
    const tsAll = [
      ...Object.values(LLM_OPS),
      ...Object.values(LLM_EVENTS),
      ...Object.values(LLM_ERRORS),
      ...Object.values(LLM_LANES),
    ];
    const unregistered = csAll.filter((v) => !tsAll.includes(v));
    expect(unregistered, `C# 新增契约未同步 TS 镜像: ${unregistered.join(", ")}`).toEqual([]);
  });
});

describe("secrets-host 契约（SecretsHost.cs 协议帧）", () => {
  // 协议 op 为字面量（与其它 host 同构，不进 const）——扫描 switch 分支锁定
  const SECRET_OPS = [
    "secret.get",
    "secret.put",
    "secret.delete",
    "secret.list",
    "secret.import",
    "secret.status",
    "secret.mark-migrated",
    "shutdown",
  ] as const;

  it("七个 secret.* op + shutdown 均存在于宿主源码", () => {
    const cs = fs.readFileSync(SECRETS_HOST_CS, "utf8");
    for (const op of SECRET_OPS) {
      expect(cs.includes(`"${op}"`), `op "${op}" 缺失于 SecretsHost.cs`).toBe(true);
    }
  });

  it("result 帧携带 data 信封 + 错误码（TS 客户端解包依据）", () => {
    const cs = fs.readFileSync(SECRETS_HOST_CS, "utf8");
    expect(cs).toContain('op = "result"');
    expect(cs).toContain("E_SECRET_");
  });
});

describe("secrets-host 契约双向绑定（复审 P1-14：SECRETS_OPS ↔ SecretsHost.cs）", () => {
  it("TS SECRETS_OPS 每个值都在 SecretsHost.cs 源码中", () => {
    const cs = fs.readFileSync(SECRETS_HOST_CS, "utf8");
    for (const op of Object.values(SECRETS_OPS)) {
      expect(cs.includes(`"${op}"`), `SECRETS_OPS.${op} 缺失于 SecretsHost.cs`).toBe(true);
    }
  });
  it("C# 侧 secret.* op 无未登记进 TS 镜像的漂移", () => {
    const cs = fs.readFileSync(SECRETS_HOST_CS, "utf8");
    const csOps = [...new Set([...cs.matchAll(/"secret\.[a-z-]+"/g)].map((m) => m[0].replaceAll('"', "")))];
    const tsOps = new Set(Object.values(SECRETS_OPS));
    for (const op of csOps) {
      expect(tsOps.has(op), `C# 新增 secret op "${op}" 未同步 TS SECRETS_OPS`).toBe(true);
    }
  });
  it("错误帧对齐仓库约定（error/errorCode/retryable，复审 P0-5）", () => {
    const secretsCs = fs.readFileSync(SECRETS_HOST_CS, "utf8");
    expect(secretsCs).toContain("errorCode = code");
    const llmCs = readCs("dotnet/cyrene-core/Llm/LlmHost.cs");
    expect(llmCs).toContain("errorCode =");
    expect(llmCs).toContain("retryable");
  });
});

describe("llm-host 契约扫描（LlmHost.cs 分发 op）", () => {
  it("宿主 switch 分支覆盖 submit/poll/cancel/status/shutdown", () => {
    const cs = readCs("dotnet/cyrene-core/Llm/LlmHost.cs");
    for (const member of ["OpSubmit", "OpPoll", "OpCancel", "OpStatus", "OpShutdown"]) {
      expect(cs.includes(`LlmContracts.${member}`), `LlmHost.cs 未分发 ${member}`).toBe(true);
    }
  });

  it("成功响应帧统一 data 信封（TS 客户端解包依据）", () => {
    const cs = readCs("dotnet/cyrene-core/Llm/LlmHost.cs");
    expect(cs).toContain("data = new { jobId = job!.Id }");
    expect(cs).toContain("nextCursor");
  });
});
