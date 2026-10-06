/**
 * git 工具 native 轨接线测试（IKJLIL）：
 *  - 可信上下文注入：workspace / session / git 命令 / 来源 / 版本 / 身份 → 内部参数
 *  - bundled git：附带环境隔离标记（__gitIsolated）
 *  - host 不可用：回退 GitService 原路径（模型参数原样）
 *  - 取消（AbortError）：原样上抛、不回退（不重复执行副作用）
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitService } from "../../code-git/git-service";
import type { ToolContext } from "./registry/tool-context";

const nativeMocks = vi.hoisted(() => ({
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; meta?: Record<string, unknown>; options?: { signal?: AbortSignal } }>,
  nativeResult: null as string | null,
  nativeError: null as Error | null,
}));

// electron mock：importActual 加载真实 native-tool-host 链时
// native-windows-host 顶层 import electron（仅需存在，测试不触达）
vi.mock("electron", () => ({ app: { getPath: () => "" } }));

// 只替换 nativeFirst；剥离逻辑复用真实 stripInternalArgs（vi.importActual），
// 避免 mock 自行重实现——真实实现退化时本文件信任边界用例仍会失败（复审 P2-4）
vi.mock("./native-tool-host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./native-tool-host")>();
  return {
    ...actual,
    nativeFirst: async (
      tool: string,
      args: Record<string, unknown>,
      fallback: (a: Record<string, unknown>) => unknown,
      options?: { signal?: AbortSignal; meta?: Record<string, unknown> },
    ) => {
      // 模拟真实 nativeFirst 的信任边界 + meta 通道（IKJLP4）
      const nativeArgs = actual.stripInternalArgs(args);
      nativeMocks.calls.push({ tool, args: nativeArgs, meta: options?.meta, options });
      if (nativeMocks.nativeError) throw nativeMocks.nativeError;
      if (nativeMocks.nativeResult !== null) return nativeMocks.nativeResult;
      return fallback(nativeArgs);
    },
  };
});

import { createCodeGitTools } from "./git-tools";

function codeContext(workspaceRoot = "C:\\trusted"): ToolContext {
  return {
    userQuery: "提交当前修改",
    conversationId: "session-1",
    resolvedWorkspaceRoot: workspaceRoot,
    mode: "code",
  };
}

function service(overrides: Partial<GitService> = {}): GitService {
  return {
    getStatusForSession: vi.fn(),
    onChanged: vi.fn(() => () => undefined),
    watchSession: vi.fn(async () => undefined),
    unwatchSession: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
    switchBranchForSession: vi.fn(async () => "已切换到分支 main"),
    commitForSession: vi.fn(async () => "已创建提交"),
    pushForSession: vi.fn(async () => "已推送到 origin"),
    initRepository: vi.fn(async () => "已初始化 Git 仓库"),
    commit: vi.fn(async () => "已创建提交"),
    switchBranch: vi.fn(async () => "已切换到分支 main"),
    push: vi.fn(async () => "已推送到 origin"),
    revert: vi.fn(async () => "已创建回退提交"),
    diff: vi.fn(async () => ({ base: "HEAD", staged: false, files: [], insertions: 0, deletions: 0, truncated: false, patch: "", perFile: [] })),
    log: vi.fn(async () => []),
    getExecutableInfo: vi.fn(async () => ({ command: "git", source: "system" as const, version: "2.50.0" })),
    getCommitIdentity: vi.fn(() => null),
    getDedicatedConfigPath: vi.fn(() => null),
    ...overrides,
  };
}

function tool(gitService: GitService, id: string) {
  const found = createCodeGitTools(gitService).find((t) => t.id === id);
  if (!found) throw new Error(`工具未注册：${id}`);
  return found;
}

beforeEach(() => {
  nativeMocks.calls.length = 0;
  nativeMocks.nativeResult = null;
  nativeMocks.nativeError = null;
});

describe("git native 轨接线", () => {
  it("注入可信上下文（工作区/会话/命令/来源/版本/身份）并透传 native 结果", async () => {
    nativeMocks.nativeResult = '{"ok":true}';
    const gitService = service({
      getCommitIdentity: vi.fn(() => ({ name: "N", email: "e@x" })),
    });

    const out = await tool(gitService, "git_commit").execute(
      { message: "m", paths: ["a.ts"], workspaceRoot: "C:\\untrusted" },
      codeContext(),
    );

    expect(out).toBe('{"ok":true}');
    expect(nativeMocks.calls).toEqual([{
      tool: "git_commit",
      args: {
        message: "m",
        paths: ["a.ts"],
        workspaceRoot: "C:\\untrusted",
      },
      meta: {
        workspaceRoot: "C:\\trusted",
        sessionId: "session-1",
        gitCommand: "git",
        gitSource: "system",
        gitVersion: "2.50.0",
        gitIdentity: { name: "N", email: "e@x" },
      },
      options: expect.objectContaining({ signal: undefined }),
    }]);
  });

  it("bundled git：附带 gitIsolated 标记（meta；环境隔离在 C# 侧设置）", async () => {
    nativeMocks.nativeResult = "已初始化 Git 仓库";
    const gitService = service({
      getExecutableInfo: vi.fn(async () => ({ command: "C:\\res\\mingit\\git.exe", source: "bundled" as const, version: "2.50.0" })),
    });

    await tool(gitService, "git_init").execute({}, codeContext());

    expect(nativeMocks.calls[0].meta?.gitIsolated).toBe(true);
    expect(nativeMocks.calls[0].meta?.gitCommand).toBe("C:\\res\\mingit\\git.exe");
  });

  it("独立配置文件：开关开时注入 meta.gitConfigGlobal，关闭时不注入（IKJMO8）", async () => {
    nativeMocks.nativeResult = "已初始化 Git 仓库";
    const withConfig = service({ getDedicatedConfigPath: vi.fn(() => "C:\\data\\git\\config") });
    await tool(withConfig, "git_init").execute({}, codeContext());
    expect(nativeMocks.calls[0].meta?.gitConfigGlobal).toBe("C:\\data\\git\\config");

    nativeMocks.calls.length = 0;
    const withoutConfig = service();
    await tool(withoutConfig, "git_init").execute({}, codeContext());
    expect(nativeMocks.calls[0].meta?.gitConfigGlobal).toBeUndefined();
  });

  it("信任边界：模型伪造 __ 内部参数被剥离（args 不含 __；可信值只经 meta 下发）", async () => {
    nativeMocks.nativeResult = '{"ok":true}';
    const gitService = service();

    await tool(gitService, "git_status").execute(
      { __gitCommand: "C:\\evil\\git.exe", __cyreneRoot: "C:\\evil", __gitIsolated: true },
      codeContext(),
    );

    expect(nativeMocks.calls[0].args).toEqual({});
    const meta = nativeMocks.calls[0].meta;
    expect(meta?.gitCommand).toBe("git"); // 可信值只来自装配通道
    expect(meta?.workspaceRoot).toBe("C:\\trusted");
    expect(meta?.gitIsolated).toBeUndefined(); // system git 不注入隔离标记
  });

  it("host 不可用：回退 GitService（模型参数与可信上下文一致）", async () => {
    nativeMocks.nativeResult = null; // fallback
    const gitService = service();

    await tool(gitService, "git_commit").execute({ message: "m", paths: ["a.ts"] }, codeContext());

    expect(gitService.commit).toHaveBeenCalledWith(
      { sessionId: "session-1", mode: "code", workspaceRoot: "C:\\trusted" },
      "m",
      ["a.ts"],
    );
  });

  it("取消（AbortError）：原样上抛、不回退、不执行 GitService", async () => {
    nativeMocks.nativeError = Object.assign(new Error("Operation aborted"), { name: "AbortError" });
    const gitService = service();

    await expect(tool(gitService, "git_push").execute({}, codeContext())).rejects
      .toMatchObject({ name: "AbortError" });
    expect(gitService.push).not.toHaveBeenCalled();
  });

  it("非 Code 模式：保持既有拒绝语义（回退路径抛错）", async () => {
    const gitService = service();
    await expect(tool(gitService, "git_init").execute({}, { ...codeContext(), mode: "work" })).rejects
      .toThrow("Git 工具只允许在 Code 模式使用");
    expect(nativeMocks.calls).toHaveLength(0);
  });
});
