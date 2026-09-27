import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearDirectory,
  hasExistingData,
  isSamePath,
  migrateDataDir,
  readPortableConfig,
  resolveDefaultPortableDataDir,
  resolveInstallRoot,
  resolvePortableConfigPath,
  validateDataDir,
  writePortableConfig,
  type PortableFs,
} from "./portable-location";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-portable-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("路径解析", () => {
  const packaged = {
    isPackaged: true,
    appPath: path.join("C:", "app", "resources", "app.asar"),
    executablePath: path.join("D:", "Apps", "Cyrene", "Cyrene.exe"),
  };
  const dev = {
    isPackaged: false,
    appPath: path.join("D:", "code", "cyrene-agent"),
    executablePath: path.join("D:", "code", "cyrene-agent", "node_modules", "electron", "dist", "electron.exe"),
  };

  it("打包版以 exe 所在目录为程序根，开发版用仓库根", () => {
    expect(resolveInstallRoot(packaged)).toBe(path.dirname(packaged.executablePath));
    expect(resolveInstallRoot(dev)).toBe(dev.appPath);
  });

  it("指针文件与默认便携目录都落在程序根下", () => {
    expect(resolvePortableConfigPath(packaged)).toBe(
      path.join(path.dirname(packaged.executablePath), "cyrene-portable.json"),
    );
    expect(resolveDefaultPortableDataDir(packaged)).toBe(
      path.join(path.dirname(packaged.executablePath), "data"),
    );
  });
});

describe("指针文件读写", () => {
  it("缺失/损坏/空值都按默认处理", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "cyrene-portable.json");
    expect(readPortableConfig(configPath)).toEqual({ dataDir: null, storedValue: null });

    fs.writeFileSync(configPath, "not json", "utf8");
    expect(readPortableConfig(configPath)).toEqual({ dataDir: null, storedValue: null });

    fs.writeFileSync(configPath, JSON.stringify({ dataDir: "  " }), "utf8");
    expect(readPortableConfig(configPath)).toEqual({ dataDir: null, storedValue: null });

    fs.writeFileSync(configPath, JSON.stringify({ dataDir: path.parse(dir).root }), "utf8");
    expect(readPortableConfig(configPath)).toEqual({ dataDir: null, storedValue: null });

    // 记事本编辑过的文件可能带 UTF-8 BOM
    fs.writeFileSync(configPath, "\uFEFF" + JSON.stringify({ dataDir: "data" }), "utf8");
    expect(readPortableConfig(configPath)).toEqual({
      dataDir: path.resolve(dir, "data"),
      storedValue: "data",
    });
  });

  it("相对路径相对程序目录解析，绝对路径原样使用", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "cyrene-portable.json");

    writePortableConfig(configPath, "data");
    expect(readPortableConfig(configPath)).toEqual({
      dataDir: path.resolve(dir, "data"),
      storedValue: "data",
    });

    const custom = path.join(dir, "custom-data");
    writePortableConfig(configPath, custom);
    expect(readPortableConfig(configPath)).toEqual({
      dataDir: path.resolve(custom),
      storedValue: custom,
    });
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it("写入 null 删除指针文件（回到系统默认）", () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, "cyrene-portable.json");
    writePortableConfig(configPath, "data");
    expect(fs.existsSync(configPath)).toBe(true);

    writePortableConfig(configPath, null);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(readPortableConfig(configPath)).toEqual({ dataDir: null, storedValue: null });
  });
});

describe("validateDataDir", () => {
  it("拒绝空路径/相对路径/根目录/同名文件/目录重叠", () => {
    const root = makeTempDir();
    const current = path.join(root, "current");
    fs.mkdirSync(current, { recursive: true });

    expect(validateDataDir("", current).ok).toBe(false);
    expect(validateDataDir(path.join("relative", "dir"), current).ok).toBe(false);
    expect(validateDataDir(path.parse(current).root, current).ok).toBe(false);
    expect(validateDataDir(current, current).ok).toBe(false);
    expect(validateDataDir(path.join(current, "sub"), current).ok).toBe(false);
    expect(validateDataDir(root, current).ok).toBe(false);

    const file = path.join(root, "occupied.txt");
    fs.writeFileSync(file, "x", "utf8");
    expect(validateDataDir(file, current).ok).toBe(false);
  });

  it("接受全新目录并返回解析后的绝对路径", () => {
    const root = makeTempDir();
    const current = path.join(root, "current");
    const target = path.join(root, "target");
    const result = validateDataDir(target, current);
    expect(result).toEqual({ ok: true, resolved: path.resolve(target) });
  });

  it("isSamePath 忽略大小写", () => {
    expect(isSamePath(path.join("C:", "Data"), path.join("c:", "data"))).toBe(true);
    expect(isSamePath(path.join("C:", "Data"), path.join("C:", "Data2"))).toBe(false);
  });
});

describe("数据检测与迁移", () => {
  it("hasExistingData：不存在/空目录为 false，有内容为 true", () => {
    const root = makeTempDir();
    expect(hasExistingData(path.join(root, "missing"))).toBe(false);
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    expect(hasExistingData(empty)).toBe(false);
    fs.writeFileSync(path.join(empty, "a.txt"), "a", "utf8");
    expect(hasExistingData(empty)).toBe(true);
  });

  it("clearDirectory 清空内容保留目录", () => {
    const dir = makeTempDir();
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "nested", "a.txt"), "a", "utf8");
    clearDirectory(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("迁移复制数据、跳过易失缓存、保留目录结构", () => {
    const source = makeTempDir();
    fs.mkdirSync(path.join(source, "cyrene-chats"));
    fs.writeFileSync(path.join(source, "cyrene-chats", "index.json"), "{}", "utf8");
    fs.writeFileSync(path.join(source, "app-settings.json"), "{}", "utf8");
    fs.mkdirSync(path.join(source, "Cache"));
    fs.writeFileSync(path.join(source, "Cache", "junk.bin"), "x", "utf8");
    fs.writeFileSync(path.join(source, "SingletonLock"), "lock", "utf8");

    const target = makeTempDir();
    const report = migrateDataDir(source, target);

    expect(report.copied).toEqual(expect.arrayContaining(["app-settings.json", "cyrene-chats"]));
    expect(report.skipped).toEqual(expect.arrayContaining(["Cache", "SingletonLock"]));
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(path.join(target, "app-settings.json"), "utf8")).toBe("{}");
    expect(fs.readFileSync(path.join(target, "cyrene-chats", "index.json"), "utf8")).toBe("{}");
    expect(fs.existsSync(path.join(target, "Cache"))).toBe(false);
  });

  it("单个条目复制失败不阻断整体迁移", () => {
    const source = makeTempDir();
    fs.writeFileSync(path.join(source, "a.txt"), "a", "utf8");
    fs.writeFileSync(path.join(source, "b.txt"), "b", "utf8");
    const failingFs = Object.assign({}, fs, {
      cpSync: () => {
        throw new Error("EPERM: locked");
      },
    }) as unknown as PortableFs;

    const report = migrateDataDir(source, makeTempDir(), { fsImpl: failingFs });
    expect(report.copied).toEqual([]);
    expect(report.failed).toHaveLength(2);
    expect(report.failed[0].error).toContain("EPERM");
  });
});
