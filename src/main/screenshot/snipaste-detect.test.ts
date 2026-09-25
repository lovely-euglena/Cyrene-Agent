import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  detectSnipasteExecutable,
  findSnipasteInCommonLocations,
  findSnipasteInPath,
  parseSnipasteFromRegistry,
} from "./snipaste-detect";

describe("snipaste-detect", () => {
  it("在 PATH 里找到 Snipaste.exe", () => {
    const env = { PATH: ["C:\\Tools", "C:\\Apps"].join(path.delimiter) };
    const exists = (candidate: string) => candidate === path.join("C:\\Apps", "Snipaste.exe");
    expect(findSnipasteInPath(env, exists)).toBe(path.join("C:\\Apps", "Snipaste.exe"));
  });

  it("常见安装目录按优先级返回第一个存在的", () => {
    const env = {
      ProgramFiles: "C:\\Program Files",
      LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    };
    const exists = (candidate: string) => candidate === path.join("C:\\Users\\u\\AppData\\Local", "Programs", "Snipaste", "Snipaste.exe");
    expect(findSnipasteInCommonLocations(env, exists)).toBe(
      path.join("C:\\Users\\u\\AppData\\Local", "Programs", "Snipaste", "Snipaste.exe"),
    );
  });

  it("注册表解析优先 DisplayIcon，其次 InstallLocation", () => {
    const output = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Snipaste",
      "    DisplayName    REG_SZ    Snipaste",
      "    InstallLocation    REG_SZ    D:\\Portable\\Snipaste",
      "    DisplayIcon    REG_SZ    D:\\Portable\\Snipaste\\Snipaste.exe,0",
    ].join("\r\n");
    expect(parseSnipasteFromRegistry(output)).toBe("D:\\Portable\\Snipaste\\Snipaste.exe");

    const locationOnly = "    InstallLocation    REG_SZ    D:\\Portable\\Snipaste";
    expect(parseSnipasteFromRegistry(locationOnly)).toBe(path.join("D:\\Portable\\Snipaste", "Snipaste.exe"));
  });

  it("显式路径存在时以它为准；缺失时不回退自动探测", async () => {
    const env = { PATH: "C:\\Apps" };
    const existing = path.join("C:\\Apps", "Snipaste.exe");
    const existsSync = (candidate: string) => candidate === existing;

    await expect(
      detectSnipasteExecutable("C:\\Explicit\\Snipaste.exe", { platform: "win32", env, existsSync }),
    ).resolves.toBeNull();
    await expect(
      detectSnipasteExecutable(existing, { platform: "win32", env, existsSync }),
    ).resolves.toBe(existing);
  });

  it("环境变量 CYRENE_SNIPASTE_PATH 可用", async () => {
    const env = { CYRENE_SNIPASTE_PATH: "C:\\Portable\\Snipaste.exe" };
    await expect(
      detectSnipasteExecutable(undefined, {
        platform: "win32",
        env,
        existsSync: (candidate) => candidate === "C:\\Portable\\Snipaste.exe",
      }),
    ).resolves.toBe("C:\\Portable\\Snipaste.exe");
  });

  it("PATH/常见目录都没命中时回退注册表（Windows）", async () => {
    const registryOutput = "    DisplayIcon    REG_SZ    D:\\Snip\\Snipaste.exe,0";
    const resolved = await detectSnipasteExecutable(undefined, {
      platform: "win32",
      env: {},
      existsSync: (candidate) => candidate === "D:\\Snip\\Snipaste.exe",
      queryRegistry: async () => registryOutput,
    });
    expect(resolved).toBe("D:\\Snip\\Snipaste.exe");
  });

  it("非 Windows 平台不查注册表", async () => {
    let queried = false;
    const resolved = await detectSnipasteExecutable(undefined, {
      platform: "darwin",
      env: {},
      existsSync: () => false,
      queryRegistry: async () => {
        queried = true;
        return "";
      },
    });
    expect(resolved).toBeNull();
    expect(queried).toBe(false);
  });
});
