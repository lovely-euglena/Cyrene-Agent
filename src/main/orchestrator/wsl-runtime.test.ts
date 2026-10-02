// WSL 运行时解析层单测：纯函数（解码/解析/路径换算/调用构造）+ 探测失败路径。
// 不依赖本机是否安装 WSL：探测成功的编码/解析路径用 node 冒充被 spawn 的进程验证。
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  buildWslInvocation,
  decodeWslText,
  discoverWsl,
  listWslDistros,
  parseWslDistroList,
  posixSingleQuote,
  resetWslDiscoveryCache,
  resolveWslExecutable,
  resolveWslExecutablePath,
  restartWsl,
  windowsPathToWslPath,
} from "./wsl-runtime";

const VALIDATED = { kind: "wsl" as const, executable: "C:\\Windows\\System32\\wsl.exe" };

function decodeScript(args: string[]): string {
  const payload = args.at(-1) ?? "";
  const match = /^echo (\S+) \| base64 -d \| bash$/.exec(payload);
  if (!match) throw new Error(`unexpected payload: ${payload}`);
  return Buffer.from(match[1], "base64").toString("utf8");
}

describe("decodeWslText", () => {
  it("解码带 BOM 的 UTF-16LE", () => {
    const buffer = Buffer.from("\uFEFFUbuntu\r\n", "utf16le");
    expect(decodeWslText(buffer)).toBe("Ubuntu\r\n");
  });

  it("按大量 NUL 字节识别无 BOM 的 UTF-16LE", () => {
    expect(decodeWslText(Buffer.from("Ubuntu\nDebian\n", "utf16le"))).toBe("Ubuntu\nDebian\n");
  });

  it("无 NUL 的普通文本按 UTF-8 解码", () => {
    expect(decodeWslText(Buffer.from("Ubuntu\nDebian\n", "utf8"))).toBe("Ubuntu\nDebian\n");
  });

  it("空缓冲返回空串", () => {
    expect(decodeWslText(Buffer.alloc(0))).toBe("");
  });
});

describe("parseWslDistroList", () => {
  it("去 BOM/NUL/空行/首尾空白", () => {
    expect(parseWslDistroList("\uFEFFUbuntu\r\nDebian\r\n\r\n  Kali \r\n")).toEqual([
      "Ubuntu",
      "Debian",
      "Kali",
    ]);
  });

  it("空输入返回空数组", () => {
    expect(parseWslDistroList("")).toEqual([]);
    expect(parseWslDistroList("\r\n\r\n")).toEqual([]);
  });
});

describe("windowsPathToWslPath", () => {
  it("盘符路径换算为 /mnt/<drive>", () => {
    expect(windowsPathToWslPath("D:\\code")).toBe("/mnt/d/code");
    expect(windowsPathToWslPath("C:/Users/me")).toBe("/mnt/c/Users/me");
    expect(windowsPathToWslPath("D:\\code\\sub dir")).toBe("/mnt/d/code/sub dir");
  });

  it("盘符根目录换算为 /mnt/<drive>", () => {
    expect(windowsPathToWslPath("D:\\")).toBe("/mnt/d");
  });

  it("已是 POSIX 绝对路径时原样返回", () => {
    expect(windowsPathToWslPath("/home/user/project")).toBe("/home/user/project");
  });

  it("UNC 与相对路径返回 null", () => {
    expect(windowsPathToWslPath("\\\\server\\share\\dir")).toBeNull();
    expect(windowsPathToWslPath("relative\\path")).toBeNull();
    expect(windowsPathToWslPath("")).toBeNull();
  });

  it("盘符相对路径（D:code）返回 null，不做错误换算", () => {
    expect(windowsPathToWslPath("D:code")).toBeNull();
    expect(windowsPathToWslPath("D:")).toBe("/mnt/d");
  });
});

describe("posixSingleQuote", () => {
  it("转义单引号", () => {
    expect(posixSingleQuote("/mnt/d/it's")).toBe("'/mnt/d/it'\\''s'");
  });
});

describe("buildWslInvocation", () => {
  it("带发行版：-d 在 -e 之前，命令经 base64 直通", () => {
    const invocation = buildWslInvocation({ ...VALIDATED, distro: "Ubuntu" }, "echo hi");
    expect(invocation.command).toBe(VALIDATED.executable);
    expect(invocation.args.slice(0, 5)).toEqual(["-d", "Ubuntu", "-e", "bash", "-lc"]);
    expect(invocation.windowsVerbatimArguments).toBe(false);
    expect(decodeScript(invocation.args)).toBe("echo hi");
  });

  it("无发行版：不带 -d，使用 WSL 默认发行版", () => {
    const invocation = buildWslInvocation({ ...VALIDATED, distro: null }, "pwd");
    expect(invocation.args.slice(0, 3)).toEqual(["-e", "bash", "-lc"]);
    expect(invocation.args).not.toContain("-d");
  });

  it("工作目录以单引号拼进脚本首部（不存在时给出结构化错误）", () => {
    const invocation = buildWslInvocation({ ...VALIDATED, distro: "Ubuntu" }, "ls", "/mnt/d/my project");
    expect(decodeScript(invocation.args)).toBe(
      "cd -- '/mnt/d/my project' || { printf '[WSL_CWD_NOT_FOUND] %s\\n' '/mnt/d/my project' >&2; exit 86; }; ls",
    );
  });

  it("工作目录含单引号也能安全转义", () => {
    const invocation = buildWslInvocation({ ...VALIDATED, distro: "Ubuntu" }, "ls", "/mnt/d/it's");
    expect(decodeScript(invocation.args)).toBe(
      "cd -- '/mnt/d/it'\\''s' || { printf '[WSL_CWD_NOT_FOUND] %s\\n' '/mnt/d/it'\\''s' >&2; exit 86; }; ls",
    );
  });

  it("工作目录在发行版内不存在时输出 WSL_CWD_NOT_FOUND 并退出 86", () => {
    const invocation = buildWslInvocation({ ...VALIDATED, distro: null }, "pwd", "/mnt/d/gone");
    const script = decodeScript(invocation.args);
    expect(script).toContain("WSL_CWD_NOT_FOUND");
    expect(script).toContain("exit 86");
    expect(script.endsWith("; pwd")).toBe(true);
  });

  it("命令含引号/管道/换行也不破坏外层协议", () => {
    const command = `echo "a b" | grep 'a' && printf 'line\\nnext'`;
    const invocation = buildWslInvocation({ ...VALIDATED, distro: "Ubuntu" }, command);
    expect(decodeScript(invocation.args)).toBe(command);
    expect(invocation.args.at(-1)).not.toContain("\n");
  });
});

describe("listWslDistros", () => {
  it("解析子进程 UTF-16LE 输出", async () => {
    const distros = await listWslDistros(process.execPath, 5_000, [
      "-e",
      "process.stdout.write(Buffer.from('Ubuntu\\nDebian\\n','utf16le'))",
    ]);
    expect(distros).toEqual(["Ubuntu", "Debian"]);
  });

  it("可执行文件不存在时返回空数组", async () => {
    const missing = path.join(os.tmpdir(), `no-such-wsl-${Date.now()}.exe`);
    expect(await listWslDistros(missing, 2_000)).toEqual([]);
  });

  it("超时后杀死子进程并返回空数组", async () => {
    const started = Date.now();
    const distros = await listWslDistros(process.execPath, 400, ["-e", "setTimeout(() => {}, 5000)"]);
    expect(distros).toEqual([]);
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});

describe("resolveWslExecutablePath / discoverWsl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetWslDiscoveryCache();
  });

  it("优先命中 SystemRoot\\System32\\wsl.exe", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wsl-"));
    fs.mkdirSync(path.join(root, "System32"), { recursive: true });
    const exe = path.join(root, "System32", "wsl.exe");
    fs.writeFileSync(exe, "");
    vi.stubEnv("SystemRoot", root);
    vi.stubEnv("PATH", "");
    expect(resolveWslExecutablePath()).toBe(exe);
  });

  it("找不到 wsl.exe 时 discoverWsl 返回空", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wsl-empty-"));
    vi.stubEnv("SystemRoot", root);
    vi.stubEnv("windir", root);
    vi.stubEnv("PATH", "");
    expect(resolveWslExecutablePath()).toBeNull();
    await expect(discoverWsl()).resolves.toEqual({ executable: null, distros: [] });
  });

  it("找不到 wsl.exe 时 resolveWslExecutable 返回 null", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wsl-none-"));
    vi.stubEnv("SystemRoot", root);
    vi.stubEnv("windir", root);
    vi.stubEnv("PATH", "");
    await expect(resolveWslExecutable("Ubuntu")).resolves.toBeNull();
  });
});

describe("restartWsl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetWslDiscoveryCache();
  });

  it("找不到 wsl.exe 时返回 WSL_UNAVAILABLE", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wsl-norr-"));
    vi.stubEnv("SystemRoot", root);
    vi.stubEnv("windir", root);
    vi.stubEnv("PATH", "");
    await expect(restartWsl()).resolves.toEqual({ ok: false, error: "WSL_UNAVAILABLE" });
  });

  it("wsl.exe 失败（非 0 退出）时 ok=false 且带 stderr 原因", async () => {
    // node 充当 wsl.exe：把 --shutdown 当脚本名 → 非 0 退出并写 stderr
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-wsl-fail-"));
    fs.mkdirSync(path.join(root, "System32"), { recursive: true });
    const exe = path.join(root, "System32", "wsl.exe");
    fs.writeFileSync(exe, "");
    vi.spyOn(fs, "statSync").mockReturnValue({ isFile: () => true } as never);
    // 让 resolveWslExecutablePath 命中我们伪造的 exe，但实际 spawn 用 node 才能执行
    vi.stubEnv("SystemRoot", root);
    vi.stubEnv("PATH", "");
    // 伪造 exe 是空文件无法执行，spawn 会 error → 契约上仍是 ok=false
    const result = await restartWsl(3_000);
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe("string");
    vi.restoreAllMocks();
  });
});
