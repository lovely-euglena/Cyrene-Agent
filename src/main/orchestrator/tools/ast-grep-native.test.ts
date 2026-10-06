/**
 * ast_grep native 轨接线测试（IKJK3V T2 库替代批）：
 *  - search：native 参数注入（工作区根 + CLI 路径）→ 结果透传；CLI 不可解析时走 TS
 *  - replace：dryRun 单次调用；正式写入时先预演捕获 review 基线（runId 存在时）
 *  - 校验失败/CLI 缺失：不触达 native（走 TS 语义）
 *  - native 失败回退 TS；取消（AbortError）原样上抛
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

vi.mock("electron", () => ({
  app: { getPath: (_name: string) => tmpDir },
}));

const h = vi.hoisted(() => ({
  nativeCalls: [] as Array<{ tool: string; args: Record<string, unknown>; timeoutMs?: number; meta?: Record<string, unknown>; abandonOnTimeout?: boolean }>,
  nativeResults: [] as Array<string | null>,
  nativeError: null as Error | null,
}));

import { nativeToolHost } from "./native-tool-host";
import { registerAstGrepTools, resolveAstGrepCommand, toUnpackedAsarPath } from "./ast-grep-tools";

registerAstGrepTools();

function getTool(id: string): {
  execute: (args: Record<string, unknown>, ctx?: { runId?: string; resolvedWorkspaceRoot?: string }) => Promise<string>;
} {
  const tool = registry.get(id) as never;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

const CLI = resolveAstGrepCommand();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ast-grep-native-"));
  fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), 'console.log("a", x);\n', "utf8");
  h.nativeCalls = [];
  h.nativeResults = [];
  h.nativeError = null;
  vi.spyOn(nativeToolHost, "call").mockImplementation(
    async (tool: string, args: Record<string, unknown>, timeoutMs?: number, _signal?: AbortSignal, meta?: Record<string, unknown>, _onEvent?: (event: unknown) => void, abandonOnTimeout?: boolean) => {
      h.nativeCalls.push({ tool, args, timeoutMs, meta, abandonOnTimeout });
      if (h.nativeError) throw h.nativeError;
      return h.nativeResults.shift() ?? null;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveAstGrepCommand 打包态路径（P1-1）", () => {
  it("asar 虚拟路径重写为 app.asar.unpacked 真实路径", () => {
    const asar = ["C:", "app", "resources", "app.asar", "node_modules", "@ast-grep",
      "cli-win32-x64-msvc", "ast-grep.exe"].join(path.sep);
    const unpacked = ["C:", "app", "resources", "app.asar.unpacked", "node_modules", "@ast-grep",
      "cli-win32-x64-msvc", "ast-grep.exe"].join(path.sep);

    expect(toUnpackedAsarPath(asar)).toBe(unpacked);
    // 已 unpacked 的路径幂等；开发期普通 node_modules 路径不误伤
    expect(toUnpackedAsarPath(unpacked)).toBe(unpacked);
    expect(toUnpackedAsarPath(path.join(tmpDir, "node_modules", "@ast-grep", "cli", "ast-grep.exe")))
      .not.toContain("unpacked");
  });
});

describe("ast_grep native 轨", () => {
  it("search：meta 注入工作区根 + CLI 路径，看门狗 60s，结果透传", async () => {
    expect(CLI).not.toBeNull(); // 依赖已安装（CI pnpm install 含平台可选包）；null 说明解析链断了
    if (!CLI) return; // 平台包缺失环境跳过（走 TS）
    h.nativeResults = [JSON.stringify({ success: true, matchCount: 1, matches: [] })];
    const out = await getTool("ast_grep_search").execute(
      { pattern: "console.log($$$A)" },
      { resolvedWorkspaceRoot: tmpDir },
    );
    expect(JSON.parse(out).matchCount).toBe(1);
    expect(h.nativeCalls).toHaveLength(1);
    expect(h.nativeCalls[0].tool).toBe("ast_grep_search");
    expect(h.nativeCalls[0].timeoutMs).toBe(60_000);
    expect(h.nativeCalls[0].abandonOnTimeout).toBe(true); // 只读轻量隔离（#IKJLP2）
    expect(h.nativeCalls[0].meta?.workspaceRoot).toBe(tmpDir);
    expect(h.nativeCalls[0].meta?.astGrepCommand).toBe(CLI);
    expect(h.nativeCalls[0].args.pattern).toBe("console.log($$$A)");
  });

  it("replace dryRun：单次 native 调用", async () => {
    if (!CLI) return;
    h.nativeResults = [JSON.stringify({ success: true, dryRun: true, filesToChange: 0, changes: [] })];
    const out = await getTool("ast_grep_replace").execute(
      { pattern: "console.log($A)", rewrite: "logger.info($A)", dryRun: true },
      { resolvedWorkspaceRoot: tmpDir },
    );
    expect(JSON.parse(out).dryRun).toBe(true);
    expect(h.nativeCalls).toHaveLength(1);
    expect(h.nativeCalls[0].args.rewrite).toBe("logger.info($A)");
    expect(h.nativeCalls[0].meta?.workspaceRoot).toBe(tmpDir);
  });

  it("replace 正式写入（runId 存在）：先预演拿变更清单，再正式调用", async () => {
    if (!CLI) return;
    h.nativeResults = [
      JSON.stringify({ success: true, dryRun: true, planned: [{ file: "src/a.ts", matchCount: 1 }], changes: [] }),
      JSON.stringify({ success: true, dryRun: false, changedFiles: 1, changed: ["src/a.ts"], changes: [] }),
    ];
    const out = await getTool("ast_grep_replace").execute(
      { pattern: "console.log($A)", rewrite: "logger.info($A)", dryRun: false },
      { runId: "run-sg-1", resolvedWorkspaceRoot: tmpDir },
    );
    expect(JSON.parse(out).changedFiles).toBe(1);
    expect(h.nativeCalls).toHaveLength(2);
    expect(h.nativeCalls[0].args.dryRun).toBe(true);
    expect(h.nativeCalls[1].args.dryRun).toBe(false);
    // 预演捕获了 review 基线（captureBefore 落盘 absent 标记）
    const baselineDir = path.join(tmpDir, "cyrene-runs", "reviews", "run-sg-1", "before");
    expect(fs.existsSync(baselineDir)).toBe(true);
  });

  it("信任边界：伪造 __ 键被剥离；可信注入覆盖同名伪造值（无后置覆盖的键不得出现在 native 帧）", async () => {
    if (!CLI) return;
    h.nativeResults = [JSON.stringify({ success: true, matchCount: 0, matches: [] })];
    await getTool("ast_grep_search").execute(
      {
        pattern: "x",
        __astGrepCommand: "C:\\evil.exe",
        __cyreneWorkspaceRoot: "C:\\evil",
        // 无后置可信覆盖的伪造键：剥离失效会原样进入 native 帧（修复前本用例失败）
        __modelForgedInternal: "evil",
      },
      { resolvedWorkspaceRoot: tmpDir },
    );
    expect(h.nativeCalls[0].args.__modelForgedInternal).toBeUndefined();
    expect(h.nativeCalls[0].args).not.toHaveProperty("__astGrepCommand");
    expect(h.nativeCalls[0].args).not.toHaveProperty("__cyreneWorkspaceRoot");
    expect(h.nativeCalls[0].meta?.astGrepCommand).toBe(CLI);
    expect(h.nativeCalls[0].meta?.workspaceRoot).toBe(tmpDir);
  });

  it("校验失败（空 pattern）：不触达 native，返回 TS 语义错误", async () => {
    const out = await getTool("ast_grep_search").execute({ pattern: "  " }, { resolvedWorkspaceRoot: tmpDir });
    expect(JSON.parse(out).success).toBe(false);
    expect(JSON.parse(out).errors[0]).toBe("pattern 参数不能为空");
    expect(h.nativeCalls).toHaveLength(0);
  });

  it("native 失败：回退 TS 实现（真实执行搜索）", async () => {
    h.nativeError = new Error("host down");
    const out = await getTool("ast_grep_search").execute(
      { pattern: "console.log($$$A)" },
      { resolvedWorkspaceRoot: tmpDir },
    );
    expect(JSON.parse(out).success).toBe(true);
    expect(JSON.parse(out).matchCount).toBe(1);
  });

  it("取消（AbortError）：原样上抛", async () => {
    if (!CLI) return;
    const err = new Error("aborted");
    err.name = "AbortError";
    h.nativeError = err;
    await expect(
      getTool("ast_grep_search").execute({ pattern: "x" }, { resolvedWorkspaceRoot: tmpDir }),
    ).rejects.toThrow("aborted");
  });
});
