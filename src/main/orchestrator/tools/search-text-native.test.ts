/**
 * search_text native 轨接线测试：
 *  - native 可用：工作区根经内部参数 __cyreneWorkspaceRoot 注入，参数透传
 *  - native 不可用：回退 TS 实现（真实工作区扫描），行为零差异
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown> }>,
  nativeResult: null as string | null,
}));

vi.mock("./native-tool-host", () => ({
  nativeFirst: async (tool: string, args: Record<string, unknown>, fallback: (a: Record<string, unknown>) => unknown) => {
    nativeMocks.calls.push({ tool, args });
    if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
    return fallback(args);
  },
}));

const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

import { registerSearchTextTool } from "./search-text-tools";

registerSearchTextTool();

function searchTool() {
  const tool = registry.get("search_text") as
    | { execute: (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<string> }
    | undefined;
  if (!tool) throw new Error("search_text 未注册");
  return tool;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search-native-test-"));
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("search_text native 轨", () => {
  it("native 可用：注入工作区根并透传参数", async () => {
    nativeMocks.nativeResult = '{"matches":[]}';
    const out = await searchTool().execute(
      { query: "hello", mode: "regex" },
      { resolvedWorkspaceRoot: "C:\\ws" },
    );

    expect(out).toBe('{"matches":[]}');
    expect(nativeMocks.calls).toEqual([
      {
        tool: "search_text",
        args: { query: "hello", mode: "regex", __cyreneWorkspaceRoot: "C:\\ws" },
      },
    ]);
  });

  it("native 不可用：回退 TS 扫描真实工作区", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "hello world\nnope\n");
    const out = JSON.parse(
      await searchTool().execute(
        { query: "hello", contextLines: 1 },
        { resolvedWorkspaceRoot: tmpDir },
      ),
    );

    expect(out.totalMatches).toBe(1);
    expect(out.matches[0].path).toBe("src/a.ts");
    expect(out.matches[0].line).toBe(1);
  });

  it("无 ctx 时以进程 cwd 兜底注入（与 TS 回退口径一致）", async () => {
    nativeMocks.nativeResult = "{}";
    await searchTool().execute({ query: "x" });
    expect(nativeMocks.calls[0].args.__cyreneWorkspaceRoot).toBe(path.resolve(process.cwd()));
  });
});
