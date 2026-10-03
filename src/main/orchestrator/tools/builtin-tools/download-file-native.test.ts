/**
 * download_file native 轨接线测试：
 *  - 输出根注入（ctx.resolvedWorkspaceRoot → __cyreneRoot）
 *  - host 不可用回退 TS（危险后缀/路径逃逸在联网前拒绝，便于离线断言）
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  nativeResult: null as string | null,
}));

vi.mock("../native-tool-host", () => ({
  nativeFirst: async (tool: string, args: Record<string, unknown>, fallback: (a: Record<string, unknown>) => unknown) => {
    nativeMocks.calls.push({ tool, args });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    return fallback(args);
  },
}));

import { downloadFileTool } from "./download-file-tool";

function execute(args: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<string> {
  return Promise.resolve(downloadFileTool.execute(args, ctx as never));
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
});

describe("download_file native 轨", () => {
  it("native 可用：注入输出根并原样返回", async () => {
    nativeMocks.nativeResult = "[download_file] 已保存：C:\\ws\\a.png（1 KiB）";
    const out = await execute({ url: "https://example.com/a.png" }, { resolvedWorkspaceRoot: "C:\\ws" });

    expect(out).toContain("已保存");
    expect(nativeMocks.calls).toEqual([
      { tool: "download_file", args: { url: "https://example.com/a.png", __cyreneRoot: "C:\\ws" } },
    ]);
  });

  it("host 不可用回退 TS：危险后缀在联网前拒绝", async () => {
    const out = await execute({ url: "https://example.com/a.exe" }, { resolvedWorkspaceRoot: "C:\\ws" });
    expect(out).toBe("[错误] 禁止下载可执行/脚本文件: .exe");
    expect(nativeMocks.calls).toHaveLength(1);
  });

  it("host 不可用回退 TS：目录穿越在联网前拒绝", async () => {
    const out = await execute({ url: "https://example.com/a.png", filename: "../escape.png" }, { resolvedWorkspaceRoot: "C:\\ws" });
    expect(out).toContain("路径不合法");
  });
});
