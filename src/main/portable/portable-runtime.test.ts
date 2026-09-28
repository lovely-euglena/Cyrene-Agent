import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  paths: {} as Record<string, string>,
  setPath: vi.fn((name: string, value: string) => {
    mock.paths[name] = value;
  }),
}));

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getAppPath: () => mock.paths.appPath,
    getPath: (name: string) => mock.paths[name],
    setPath: mock.setPath,
  },
}));

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-portable-rt-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  mock.setPath.mockClear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function loadRuntime(tempDir: string, defaultUserData: string) {
  mock.paths = {
    exe: path.join(tempDir, "Cyrene.exe"),
    appPath: tempDir,
    userData: defaultUserData,
  };
  vi.resetModules();
  return await import("./portable-runtime");
}

describe("applyPortableDataDirAtStartup", () => {
  it("无指针文件：不切换 userData", async () => {
    const tempDir = makeTempDir();
    const runtime = await loadRuntime(tempDir, path.join(tempDir, "system-data"));

    runtime.applyPortableDataDirAtStartup();

    expect(mock.setPath).not.toHaveBeenCalled();
    const status = runtime.getPortableDataLocationStatus();
    expect(status.enabled).toBe(false);
    expect(status.dataDir).toBeNull();
    expect(status.effectiveDataDir).toBe(path.join(tempDir, "system-data"));
    expect(status.suggestedDir).toBe(path.join(tempDir, "data"));
  });

  it("指针为相对路径：解析到程序目录并切换 userData（自动补建目录）", async () => {
    const tempDir = makeTempDir();
    fs.writeFileSync(
      path.join(tempDir, "cyrene-portable.json"),
      JSON.stringify({ dataDir: "data" }),
      "utf8",
    );
    const runtime = await loadRuntime(tempDir, path.join(tempDir, "system-data"));

    runtime.applyPortableDataDirAtStartup();

    const expected = path.join(tempDir, "data");
    expect(mock.setPath).toHaveBeenCalledWith("userData", expected);
    expect(fs.existsSync(expected)).toBe(true);
    const status = runtime.getPortableDataLocationStatus();
    expect(status.enabled).toBe(true);
    expect(status.dataDir).toBe(expected);
    expect(status.effectiveDataDir).toBe(expected);
  });

  it("指针为绝对路径：原样切换", async () => {
    const tempDir = makeTempDir();
    const custom = path.join(tempDir, "elsewhere", "CyreneData");
    fs.writeFileSync(
      path.join(tempDir, "cyrene-portable.json"),
      JSON.stringify({ dataDir: custom }),
      "utf8",
    );
    const runtime = await loadRuntime(tempDir, path.join(tempDir, "system-data"));

    runtime.applyPortableDataDirAtStartup();

    expect(mock.setPath).toHaveBeenCalledWith("userData", path.resolve(custom));
  });

  it("指针目录无法创建：回退系统默认", async () => {
    const tempDir = makeTempDir();
    // 指针指向一个已存在的文件 → mkdirSync 必失败
    const blocked = path.join(tempDir, "blocked");
    fs.writeFileSync(blocked, "file", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "cyrene-portable.json"),
      JSON.stringify({ dataDir: blocked }),
      "utf8",
    );
    const runtime = await loadRuntime(tempDir, path.join(tempDir, "system-data"));

    runtime.applyPortableDataDirAtStartup();

    expect(mock.setPath).not.toHaveBeenCalled();
    expect(runtime.getPortableDataLocationStatus().effectiveDataDir).toBe(
      path.join(tempDir, "system-data"),
    );
  });
});
