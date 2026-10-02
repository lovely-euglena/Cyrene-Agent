// run_shell 的 WSL 分支测试：协议错误码、权限分档、执行链（用 node 冒充 wsl.exe 子进程）。
// 探测与调用构造被 mock，避免依赖本机是否安装 WSL；路径换算保持真实实现。
import { beforeEach, describe, expect, it, vi } from "vitest";

const wslState = vi.hoisted(() => ({
  enabled: true,
  distro: "",
  discovery: {
    executable: "C:\\Windows\\System32\\wsl.exe" as string | null,
    distros: ["Ubuntu"] as string[],
  },
}));

vi.mock("../../wsl-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../wsl-runtime")>();
  return {
    ...actual,
    discoverWsl: async () => ({
      executable: wslState.discovery.executable,
      distros: wslState.discovery.distros,
    }),
    // 用 node 冒充 wsl.exe 子进程，让执行链可观测
    buildWslInvocation: () => ({
      command: process.execPath,
      args: ["-e", "process.stdout.write('WSL_OK')"],
      windowsVerbatimArguments: false,
    }),
  };
});

vi.mock("../../../settings/settings-facade", () => ({
  loadGeneralSettings: () => ({ wslEnabled: wslState.enabled, wslDistro: wslState.distro }),
}));

import { setCurrentLevel } from "../../../permission";
import { runShellTool } from "./run-shell-tool";

interface RunShellResult {
  command: string;
  shell?: string;
  errorCode?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  effect?: string;
  sandboxed?: boolean;
  availableDistros?: string[];
  timedOut: boolean;
  captureTruncated: boolean;
  [key: string]: unknown;
}

async function run(args: Record<string, unknown>, context?: unknown): Promise<RunShellResult> {
  const raw = await runShellTool.execute(args, context as never);
  return JSON.parse(raw) as RunShellResult;
}

describe("run_shell WSL 分支", () => {
  beforeEach(() => {
    setCurrentLevel("read-only");
    wslState.enabled = true;
    wslState.distro = "";
    wslState.discovery = { executable: "C:\\Windows\\System32\\wsl.exe", distros: ["Ubuntu"] };
  });

  it("未启用时返回 WSL_DISABLED，不探测", async () => {
    wslState.enabled = false;
    const parsed = await run({ command: "echo hi", shell: "wsl" });
    expect(parsed.errorCode).toBe("WSL_DISABLED");
    expect(parsed.shell).toBe("wsl");
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stdout).toBe("");
    expect(parsed.stderr).toContain("WSL 执行未启用");
  });

  it("无 wsl.exe 或无发行版时返回 WSL_UNAVAILABLE", async () => {
    wslState.discovery = { executable: null, distros: [] };
    const parsed = await run({ command: "echo hi", shell: "wsl" });
    expect(parsed.errorCode).toBe("WSL_UNAVAILABLE");
    expect(parsed.availableDistros).toEqual([]);
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stderr).toContain("未检测到可用的 WSL 发行版");
  });

  it("配置的默认发行版不存在时返回 WSL_DISTRO_NOT_FOUND 并附可用列表", async () => {
    wslState.distro = "Debian";
    const parsed = await run({ command: "echo hi", shell: "wsl" });
    expect(parsed.errorCode).toBe("WSL_DISTRO_NOT_FOUND");
    expect(parsed.availableDistros).toEqual(["Ubuntu"]);
    expect(parsed.stderr).toContain("Debian");
    expect(parsed.stderr).toContain("Ubuntu");
  });

  it("UNC 工作目录无法映射时返回 WSL_PATH_UNSUPPORTED", async () => {
    const parsed = await run({ command: "echo hi", shell: "wsl", cwd: "\\\\server\\share\\proj" });
    expect(parsed.errorCode).toBe("WSL_PATH_UNSUPPORTED");
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stderr).toContain("无法映射到 WSL 路径");
  });

  it("完全信任档位执行命令并附带发行版列表", async () => {
    const parsed = await run(
      { command: "echo hi", shell: "wsl", cwd: "D:\\code" },
      { permissionMode: "allow_all" },
    );
    expect(parsed.errorCode).toBeUndefined();
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("WSL_OK");
    expect(parsed.shell).toBe("wsl");
    expect(parsed.sandboxed).toBe(false);
    expect(parsed.availableDistros).toEqual(["Ubuntu"]);
  });

  it("非完全信任档位只读命令放行直跑（WSL 不进沙箱）", async () => {
    const parsed = await run({ command: "echo hi", shell: "wsl" });
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe("WSL_OK");
    expect(parsed.effect).toBe("read");
    expect(parsed.sandboxed).toBe(false);
  });

  it("非完全信任档位写命令 fail-closed 拒绝", async () => {
    const parsed = await run({ command: "npm install", shell: "wsl" });
    expect(parsed.exitCode).toBe(-1);
    expect(parsed.stdout).toBe("");
    expect(parsed.stderr).toContain("无法被沙箱约束");
  });

  it("灾难命令与 WSL 管理命令在进入 WSL 前被拒绝", async () => {
    const catastrophic = await run({ command: "shutdown /s /t 0", shell: "wsl" });
    expect(catastrophic.stderr).toContain("该命令被系统禁止执行");

    const management = await run({ command: "wsl --unregister Ubuntu", shell: "cmd" });
    expect(management.exitCode).toBe(-1);
    expect(management.stderr).toContain("WSL 发行版管理命令");
  });
});
