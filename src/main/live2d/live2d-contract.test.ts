/**
 * live2d-host 契约一致性测试（#257 T5）。
 *
 * 扫描 C# 事实源（Live2DContracts.cs），抽取 op / 事件 / 错误码字符串，
 * 与 TS 侧镜像（live2d-host-protocol.ts）逐字双向比对——任一侧改动必须
 * 同批同步，否则本测试红（同 llm-contract.test.ts 先例）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE2D_ERRORS, LIVE2D_EVENTS, LIVE2D_OPS } from "./live2d-host-protocol";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const LIVE2D_DIR = path.join(REPO_ROOT, "dotnet/live2d/CyreneLive2D");
const CONTRACTS_CS = path.join(LIVE2D_DIR, "Host/Live2DContracts.cs");
const PET_ENGINE_CS = path.join(LIVE2D_DIR, "PetEngine.cs");
const HOST_CS = path.join(LIVE2D_DIR, "Host/Live2DHost.cs");

/** 抽指定静态类内的 `public const string X = "y";` → [y]。 */
function classConsts(cs: string, className: string): string[] {
  const body = cs.match(new RegExp(`class ${className}\\s*\\{([\\s\\S]*?)\\n\\}`));
  expect(body, `Live2DContracts.cs 缺少类 ${className}`).not.toBeNull();
  const out: string[] = [];
  for (const m of body![1].matchAll(/public const string \w+ = "([^"]+)"/g)) out.push(m[1]);
  return out;
}

describe("live2d-host 契约（Live2DContracts.cs ↔ live2d-host-protocol.ts）", () => {
  const cs = fs.readFileSync(CONTRACTS_CS, "utf8");
  const csOps = classConsts(cs, "Live2DOps");
  const csErrors = classConsts(cs, "Live2DErrors");
  const tsOpsAndEvents = [...Object.values(LIVE2D_OPS), ...Object.values(LIVE2D_EVENTS)];

  it("ops+事件：TS 每个值都在 C# Live2DOps 中", () => {
    for (const v of tsOpsAndEvents) {
      expect(csOps, `"${v}" 缺失于 Live2DContracts.cs Live2DOps`).toContain(v);
    }
  });

  it("ops+事件：C# 侧无未登记进 TS 镜像的漂移", () => {
    const unregistered = csOps.filter((v) => !tsOpsAndEvents.includes(v));
    expect(unregistered, `C# 新增契约未同步 TS 镜像: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("错误码：TS 每个值都在 C# Live2DErrors 中", () => {
    for (const v of Object.values(LIVE2D_ERRORS)) {
      expect(csErrors, `error "${v}" 缺失于 Live2DContracts.cs Live2DErrors`).toContain(v);
    }
  });

  it("错误码：C# 侧无未登记进 TS 镜像的漂移", () => {
    const unregistered = csErrors.filter((v) => !Object.values(LIVE2D_ERRORS).includes(v as never));
    expect(unregistered, `C# 新增错误码未同步 TS 镜像: ${unregistered.join(", ")}`).toEqual([]);
  });

  it("宿主分发覆盖全部请求 op（PetEngine.cs switch 分支）", () => {
    const engine = fs.readFileSync(PET_ENGINE_CS, "utf8");
    // ready/result/event/log 是响应/信封帧 op，shutdown 在 Live2DHost 主循环处理
    const requestOps = Object.values(LIVE2D_OPS).filter(
      (op) => op !== "ready" && op !== "result" && op !== "shutdown" && op !== "event" && op !== "log",
    );
    const constNameByValue = new Map(
      [...cs.matchAll(/public const string (\w+) = "([^"]+)"/g)].map((m) => [m[2], m[1]]),
    );
    for (const op of requestOps) {
      const constName = constNameByValue.get(op);
      expect(constName, `op "${op}" 无 C# 常量名`).toBeTruthy();
      expect(engine.includes(`case Live2DOps.${constName}:`), `PetEngine.cs 未分发 op "${op}"`).toBe(true);
    }
  });

  it("shutdown 由宿主主循环处理（Live2DHost.cs）", () => {
    const host = fs.readFileSync(HOST_CS, "utf8");
    expect(host).toContain("Live2DOps.Shutdown");
  });

  it("错误帧对齐仓库约定（error/errorCode，LineHostClient 解包依据）", () => {
    const hostIo = fs.readFileSync(path.join(LIVE2D_DIR, "Host/HostIo.cs"), "utf8");
    expect(hostIo).toContain("errorCode");
  });
});
