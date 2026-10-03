/**
 * apply_patch native 轨两段式接线测试：
 *  - ① __dryRun 预检成功 → ② 对每个 hunk 写 review 基线（update+move 记 rename）→ ③ 提交
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
  recordRename: vi.fn(),
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
  getRunReviewTracker: vi.fn(() => ({
    captureBefore: nativeMocks.captureBefore,
    recordRename: nativeMocks.recordRename,
  })),
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

import { registerApplyPatchTool } from "./apply-patch-tools";

registerApplyPatchTool();

function applyPatchTool() {
  const tool = registry.get("apply_patch") as
    | {
        execute: (
          args: Record<string, unknown>,
          ctx?: { runId?: string; resolvedWorkspaceRoot?: string },
        ) => Promise<string>;
      }
    | undefined;
  if (!tool) throw new Error("apply_patch 未注册");
  return tool;
}

let tmpDir: string;

const UPDATE_ADD_PATCH =
  "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA\n*** Add File: sub/new.txt\n+hello\n*** End Patch";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apply-patch-native-test-"));
  nativeMocks.calls.length = 0;
  nativeMocks.nextResults.length = 0;
  nativeMocks.captureBefore.mockClear();
  nativeMocks.recordRename.mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("apply_patch native 两段式", () => {
  it("预检成功 → 逐文件基线 → 提交；调用序列与参数正确", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "alpha\nbeta\n");
    nativeMocks.nextResults.push(
      JSON.stringify({
        success: true,
        prepared: true,
        hunks: [
          { type: "update", path: "a.txt" },
          { type: "add", path: "sub/new.txt" },
        ],
      }),
      '{"success":true,"applied":["更新文件: a.txt","新增文件: sub/new.txt"],"errors":[],"changes":[]}',
    );

    const out = await applyPatchTool().execute(
      { patch: UPDATE_ADD_PATCH },
      { runId: "run-1", resolvedWorkspaceRoot: tmpDir },
    );

    expect(out).toContain('"success":true');
    expect(nativeMocks.calls).toEqual([
      { tool: "apply_patch", args: { patch: UPDATE_ADD_PATCH, __cyreneRoot: tmpDir, __dryRun: true } },
      { tool: "apply_patch", args: { patch: UPDATE_ADD_PATCH, __cyreneRoot: tmpDir } },
    ]);
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-1", path.join(tmpDir, "a.txt"), "a.txt");
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-1", path.join(tmpDir, "sub", "new.txt"), "sub/new.txt");
  });

  it("update + move：预检后记录 rename 基线关系", async () => {
    nativeMocks.nextResults.push(
      JSON.stringify({ success: true, prepared: true, hunks: [{ type: "update", path: "m.txt", movePath: "moved/m.txt" }] }),
      '{"success":true,"applied":["更新并移动: m.txt → moved/m.txt"],"errors":[],"changes":[]}',
    );

    await applyPatchTool().execute(
      { patch: "*** Begin Patch\n*** Update File: m.txt\n*** Move to: moved/m.txt\n@@\n-m1\n+M1\n*** End Patch" },
      { runId: "run-2", resolvedWorkspaceRoot: tmpDir },
    );

    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-2", path.join(tmpDir, "m.txt"), "m.txt");
    expect(nativeMocks.recordRename).toHaveBeenCalledWith(
      "run-2",
      path.join(tmpDir, "m.txt"),
      path.join(tmpDir, "moved", "m.txt"),
      "m.txt",
      "moved/m.txt",
    );
  });

  it("预检失败：失败结果透传、不写基线、不发提交", async () => {
    nativeMocks.nextResults.push(
      '{"success":false,"applied":[],"errors":["文件不存在，无法更新: x.txt"]}',
    );

    const out = await applyPatchTool().execute(
      { patch: "*** Begin Patch\n*** Update File: x.txt\n@@\n-a\n+b\n*** End Patch" },
      { runId: "run-3", resolvedWorkspaceRoot: tmpDir },
    );

    expect(JSON.parse(out)).toEqual({
      success: false,
      applied: [],
      errors: ["文件不存在，无法更新: x.txt"],
    });
    expect(nativeMocks.calls).toHaveLength(1);
    expect(nativeMocks.captureBefore).not.toHaveBeenCalled();
  });

  it("host 故障：回退 TS 实现并真实落盘（基线走 TS 时序）", async () => {
    const file = path.join(tmpDir, "a.txt");
    fs.writeFileSync(file, "alpha\nbeta\n");
    nativeMocks.nextResults.push(new Error("host crash"));

    const out = JSON.parse(
      await applyPatchTool().execute(
        { patch: UPDATE_ADD_PATCH },
        { runId: "run-4", resolvedWorkspaceRoot: tmpDir },
      ),
    ) as { success: boolean };

    expect(out.success).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("alpha\nBETA\n");
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("run-4", file, "a.txt");
  });

  it("取消（AbortError）：原样上抛、不回退 TS、不写基线", async () => {
    nativeMocks.nextResults.push(Object.assign(new Error("Operation aborted"), { name: "AbortError" }));

    await expect(
      applyPatchTool().execute(
        { patch: UPDATE_ADD_PATCH },
        { runId: "run-abort", resolvedWorkspaceRoot: tmpDir },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(nativeMocks.captureBefore).not.toHaveBeenCalled();
    expect(nativeMocks.calls).toHaveLength(1);
  });
});
