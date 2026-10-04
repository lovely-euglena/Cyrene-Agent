import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  copyGlobalConfigToDedicated,
  dedicatedGitConfigPath,
  extractSnapshot,
  renderDedicatedGitConfig,
  syncDedicatedGitConfig,
} from "./dedicated-git-config";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-gitcfg-"));
}

describe("dedicated-git-config（IKJMO8）", () => {
  it("渲染：include 用户全局配置 + 身份/初始分支覆盖（覆盖在 include 之后、值带引号）", () => {
    const text = renderDedicatedGitConfig({ userDataDir: "C:\\data", name: 'Cy "One"', email: "a@b.c" });
    expect(text).toContain("path = ~/.gitconfig");
    expect(text).toContain("path = ~/.config/git/config");
    expect(text).toContain('name = "Cy \\"One\\""');
    expect(text).toContain('email = "a@b.c"');
    expect(text).toContain("defaultBranch = main");
    // 覆盖必须最后生效（git config 后者胜出）
    expect(text.lastIndexOf("[user]")).toBeGreaterThan(text.indexOf("[include]"));
  });

  it("sync：未显式提供快照时保留文件内既有快照（一键复制后改设置不丢副本）", () => {
    const dir = tempDir();
    const file = dedicatedGitConfigPath(dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, renderDedicatedGitConfig({
      userDataDir: dir,
      name: "A",
      email: "a@x",
      snapshot: "[core]\n\tabbrev = 12",
    }));
    expect(extractSnapshot(fs.readFileSync(file, "utf8"))).toBe("[core]\n\tabbrev = 12");

    syncDedicatedGitConfig({ userDataDir: dir, name: "B", email: "b@x" });
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("abbrev = 12");
    expect(text).toContain('name = "B"');
  });

  it("一键复制：全局配置写入快照且应用覆盖最后生效；无全局文件时 ok=false", () => {
    const dir = tempDir();
    const home = tempDir();
    fs.writeFileSync(path.join(home, ".gitconfig"), "[credential]\n\thelper = manager\n[user]\n\tname = Old");
    const result = copyGlobalConfigToDedicated({ userDataDir: dir, name: "New", email: "n@x" }, home);
    expect(result.ok).toBe(true);
    expect(result.copied).toEqual([path.join(home, ".gitconfig")]);
    const text = fs.readFileSync(result.path, "utf8");
    expect(text).toContain("helper = manager");
    expect(text).toContain('name = "New"');
    expect(text.lastIndexOf('name = "New"')).toBeGreaterThan(text.indexOf("name = Old"));

    const none = copyGlobalConfigToDedicated({ userDataDir: tempDir(), name: "N", email: "n@x" }, tempDir());
    expect(none.ok).toBe(false);
    expect(none.message).toBeTruthy();
  });
});
