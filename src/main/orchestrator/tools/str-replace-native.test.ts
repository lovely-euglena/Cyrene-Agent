/**
 * str_replace native 轨两段式接线测试：
 *  - ① __dryRun 预检成功 → ② 写基线 → ③ 提交（.NET 落盘）
 *  - 预检失败：失败结果透传、无基线、无提交
 *  - host 故障：整体回退 TS 实现（真实落盘）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  nextResults: [] as Array<string | Error>,
  captureBefore: vi.fn(),
}));

vi.mock("./native-tool-host", () => ({
  nativeToolHost: {
    call: async (tool: string, args: Record<string, unknown>) => {
      nativeMocks.calls.push({ tool, args });
      const next = nativeMocks.nextResults.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    },
    setRuntimeSettings: vi.fn(),
  },
  nativeFirst: vi.fn(),
}));

vi.mock("../../dotnet-backend/config", () => ({
  resolveDotnetConfig: vi.fn(() => ({ toolHost: true })),
}));

vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

vi.mock("../review/run-review-tracker", () => ({
  getRunReviewTracker: vi.fn(() => ({ captureBefore: nativeMocks.captureBefore })),
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

vi.mock("./built-in-tools", () => ({ currentUserTimezone: () => "Asia/Shanghai" }));

import { registerLifeTools } from "./life-tools";

registerLifeTools();

function strReplaceTool() {
  const tool = registry.get("str_replace") as
    | { execute: (args: Record<string, unknown>, ctx?: { runId?: string }) => Promise<string> }
    | undefined;
  if (!tool) throw new Error("str_replace 未注册");
  return tool;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "str-replace-native-test-"));
  nativeMocks.calls.length = 0;
  nativeMocks.nextResults.length = 0;
  nativeMocks.captureBefore.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("str_replace native 两段式", () => {
  it("预检成功 → 基线 → 提交；调用序列与参数正确", async () => {
    const file = path.join(tmpDir, "a.txt");
    fs.writeFileSync(file, "alpha\nbeta\n");
    const args = { file_path: file, old_string: "beta", new_string: "BETA" };
    nativeMocks.nextResults.push(
      '{"success":true,"prepared":true}',
      '{"success":true,"tool":"str_replace","appliedEdits":1}',
    );

    const out = await strReplaceTool().execute(args, { runId: "run-1" });

    expect(out).toContain('"appliedEdits":1');
    expect(nativeMocks.calls).toEqual([
      { tool: "str_replace", args: { ...args, __dryRun: true } },
      { tool: "str_replace", args },
    ]);
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-1", file);
  });

  it("预检失败：失败结果透传、不写基线、不发提交", async () => {
    const file = path.join(tmpDir, "b.txt");
    fs.writeFileSync(file, "alpha\n");
    nativeMocks.nextResults.push('{"success":false,"errorCode":"OLD_STRING_NOT_FOUND"}');

    const out = await strReplaceTool().execute(
      { file_path: file, old_string: "nope", new_string: "x" },
      { runId: "run-2" },
    );

    expect(JSON.parse(out).errorCode).toBe("OLD_STRING_NOT_FOUND");
    expect(nativeMocks.calls).toHaveLength(1);
    expect(nativeMocks.captureBefore).not.toHaveBeenCalled();
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\n");
  });

  it("host 故障：回退 TS 实现并真实落盘", async () => {
    const file = path.join(tmpDir, "c.txt");
    fs.writeFileSync(file, "alpha\nbeta\n");
    nativeMocks.nextResults.push(new Error("host crash"));

    const out = JSON.parse(
      await strReplaceTool().execute(
        { file_path: file, old_string: "beta", new_string: "BETA" },
        { runId: "run-3" },
      ),
    );

    expect(out.success).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nBETA\n");
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-3", file);
  });
});
