import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PortableDataLocationStatus } from "../../shared/portable-mode";
import { applyPortableDataLocation, type PortableApplyDeps } from "./portable-apply";

const DEFAULT_STATUS: PortableDataLocationStatus = {
  enabled: false,
  dataDir: null,
  displayDir: null,
  effectiveDataDir: path.join("C:", "Users", "u", "AppData", "Roaming", "Cyrene"),
  systemDataDir: path.join("C:", "Users", "u", "AppData", "Roaming", "Cyrene"),
  installRoot: path.join("D:", "Apps", "Cyrene"),
  suggestedDir: path.join("D:", "Apps", "Cyrene", "data"),
  configPath: path.join("D:", "Apps", "Cyrene", "cyrene-portable.json"),
};

function createDeps(
  overrides: Partial<PortableApplyDeps> = {},
  status: PortableDataLocationStatus = DEFAULT_STATUS,
) {
  const deps: PortableApplyDeps = {
    getStatus: vi.fn(() => status),
    validateTarget: vi.fn((target: string) => ({ ok: true as const, resolved: path.resolve(target) })),
    exists: vi.fn(() => false),
    isDirectory: vi.fn(() => true),
    hasData: vi.fn(() => false),
    ensureDirectory: vi.fn(),
    clearDirectory: vi.fn(),
    migrate: vi.fn(() => ({ copied: [], skipped: [], failed: [] })),
    writeConfig: vi.fn(),
    scheduleRelaunch: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return deps;
}

describe("applyPortableDataLocation", () => {
  it("迁移询问取消：不写配置、不迁移、不重启", async () => {
    const deps = createDeps({ confirmMigrate: vi.fn().mockResolvedValue("cancel") });
    const result = await applyPortableDataLocation(
      { enabled: true, dir: path.join("E:", "CyreneData") },
      deps,
    );
    expect(result).toEqual({ status: "cancelled" });
    expect(deps.writeConfig).not.toHaveBeenCalled();
    expect(deps.migrate).not.toHaveBeenCalled();
    expect(deps.scheduleRelaunch).not.toHaveBeenCalled();
  });

  it("迁移到全新目录：复制数据、写指针、安排重启", async () => {
    const target = path.join("E:", "CyreneData");
    const deps = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("migrate"),
      migrate: vi.fn(() => ({ copied: ["app-settings.json"], skipped: ["Cache"], failed: [] })),
    });
    const result = await applyPortableDataLocation({ enabled: true, dir: target }, deps);

    expect(result).toMatchObject({
      status: "applied",
      targetDir: path.resolve(target),
      migrated: true,
      overwrite: false,
      failedEntries: [],
      relaunching: true,
    });
    expect(deps.ensureDirectory).toHaveBeenCalledWith(path.resolve(target));
    expect(deps.clearDirectory).not.toHaveBeenCalled();
    expect(deps.migrate).toHaveBeenCalledWith(DEFAULT_STATUS.effectiveDataDir, path.resolve(target));
    expect(deps.writeConfig).toHaveBeenCalledWith(path.resolve(target));

    const scheduled = vi.mocked(deps.scheduleRelaunch).mock.calls[0][0];
    scheduled();
    expect(deps.relaunch).toHaveBeenCalledTimes(1);
    expect(deps.quit).toHaveBeenCalledTimes(1);
  });

  it("默认便携目录写相对值 data（随程序搬移仍有效）", async () => {
    const deps = createDeps({ confirmMigrate: vi.fn().mockResolvedValue("switch") });
    const result = await applyPortableDataLocation({ enabled: true, dir: "" }, deps);
    expect(result).toMatchObject({ status: "applied", targetDir: DEFAULT_STATUS.suggestedDir });
    expect(deps.writeConfig).toHaveBeenCalledWith("data");
    expect(deps.migrate).not.toHaveBeenCalled();
  });

  it("目标已有数据：拒绝覆盖则取消；确认后先清空再迁移", async () => {
    const target = path.join("E:", "CyreneData");
    const denied = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("migrate"),
      hasData: vi.fn(() => true),
      confirmOverwrite: vi.fn().mockResolvedValue(false),
    });
    expect(await applyPortableDataLocation({ enabled: true, dir: target }, denied)).toEqual({
      status: "cancelled",
    });
    expect(denied.clearDirectory).not.toHaveBeenCalled();
    expect(denied.writeConfig).not.toHaveBeenCalled();

    const accepted = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("migrate"),
      hasData: vi.fn(() => true),
      confirmOverwrite: vi.fn().mockResolvedValue(true),
    });
    const result = await applyPortableDataLocation({ enabled: true, dir: target }, accepted);
    expect(result).toMatchObject({ status: "applied", overwrite: true });
    const clearOrder = vi.mocked(accepted.clearDirectory).mock.invocationCallOrder[0];
    const migrateOrder = vi.mocked(accepted.migrate).mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(migrateOrder);
  });

  it("仅切换不迁移：不询问覆盖、不复制", async () => {
    const target = path.join("E:", "CyreneData");
    const deps = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("switch"),
      hasData: vi.fn(() => true),
    });
    const result = await applyPortableDataLocation({ enabled: true, dir: target }, deps);
    expect(result).toMatchObject({ status: "applied", migrated: false });
    // 未提供 confirmOverwrite：若流程错误地走覆盖询问会直接抛错。
    expect(deps.migrate).not.toHaveBeenCalled();
  });

  it("关闭便携模式：目标为系统默认目录，指针文件删除（null）", async () => {
    const portableStatus: PortableDataLocationStatus = {
      ...DEFAULT_STATUS,
      enabled: true,
      dataDir: path.join("E:", "CyreneData"),
      effectiveDataDir: path.join("E:", "CyreneData"),
    };
    const deps = createDeps({ confirmMigrate: vi.fn().mockResolvedValue("migrate") }, portableStatus);
    const result = await applyPortableDataLocation({ enabled: false, dir: "" }, deps);
    expect(result).toMatchObject({ status: "applied", targetDir: DEFAULT_STATUS.systemDataDir });
    expect(deps.writeConfig).toHaveBeenCalledWith(null);
    expect(deps.migrate).toHaveBeenCalledWith(path.join("E:", "CyreneData"), DEFAULT_STATUS.systemDataDir);
  });

  it("目标与当前一致：noop，不弹询问", async () => {
    const deps = createDeps();
    const result = await applyPortableDataLocation(
      { enabled: true, dir: DEFAULT_STATUS.effectiveDataDir },
      deps,
    );
    expect(result).toEqual({ status: "noop", dataDir: path.resolve(DEFAULT_STATUS.effectiveDataDir) });
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it("校验失败：返回错误且不进入询问", async () => {
    const deps = createDeps({
      validateTarget: vi.fn(() => ({ ok: false as const, error: "不能把数据目录设为磁盘根目录" })),
    });
    const result = await applyPortableDataLocation({ enabled: true, dir: "C:\\" }, deps);
    expect(result).toEqual({ status: "error", error: "不能把数据目录设为磁盘根目录" });
  });

  it("部分条目复制失败仍算应用成功，失败项回传", async () => {
    const deps = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("migrate"),
      migrate: vi.fn(() => ({
        copied: ["app-settings.json"],
        skipped: [],
        failed: [{ entry: "Network", error: "EBUSY" }],
      })),
    });
    const result = await applyPortableDataLocation(
      { enabled: true, dir: path.join("E:", "CyreneData") },
      deps,
    );
    expect(result).toMatchObject({ status: "applied", failedEntries: ["Network"] });
    expect(deps.logger?.warn).toHaveBeenCalled();
  });

  it("写指针失败：返回错误且不安排重启", async () => {
    const deps = createDeps({
      confirmMigrate: vi.fn().mockResolvedValue("switch"),
      writeConfig: vi.fn(() => {
        throw new Error("EPERM: 只读");
      }),
    });
    const result = await applyPortableDataLocation(
      { enabled: true, dir: path.join("E:", "CyreneData") },
      deps,
    );
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toContain("EPERM");
    expect(deps.scheduleRelaunch).not.toHaveBeenCalled();
  });

  it("相对路径：按程序目录解析并原样存相对值（程序搬移仍有效）", async () => {
    const deps = createDeps({ confirmMigrate: vi.fn().mockResolvedValue("switch") });
    const result = await applyPortableDataLocation({ enabled: true, dir: "data2" }, deps);
    expect(result).toMatchObject({
      status: "applied",
      targetDir: path.join(DEFAULT_STATUS.installRoot, "data2"),
    });
    expect(deps.writeConfig).toHaveBeenCalledWith("data2");
  });

  it("相对上级路径（../SharedData）：解析到程序目录外，同时保留相对存储值", async () => {
    const rel = path.join("..", "SharedData");
    const deps = createDeps({ confirmMigrate: vi.fn().mockResolvedValue("switch") });
    const result = await applyPortableDataLocation({ enabled: true, dir: rel }, deps);
    expect(result).toMatchObject({
      status: "applied",
      targetDir: path.resolve(DEFAULT_STATUS.installRoot, rel),
    });
    expect(deps.writeConfig).toHaveBeenCalledWith(path.normalize(rel));
  });

  it("拒绝把数据目录设成程序目录本身（相对 '.'）", async () => {
    const confirmMigrate = vi.fn();
    const deps = createDeps({ confirmMigrate });
    const result = await applyPortableDataLocation({ enabled: true, dir: "." }, deps);
    expect(result).toMatchObject({ status: "error" });
    expect((result as { error: string }).error).toContain("程序目录");
    expect(confirmMigrate).not.toHaveBeenCalled();
  });

  it("native 预选迁移 + 覆盖：不再弹确认框，直接清空迁移", async () => {
    const target = path.join("E:", "CyreneData");
    const confirmMigrate = vi.fn();
    const confirmOverwrite = vi.fn();
    const deps = createDeps({ confirmMigrate, confirmOverwrite, hasData: vi.fn(() => true) });
    const result = await applyPortableDataLocation(
      { enabled: true, dir: target, migrationChoice: "migrate", overwrite: true },
      deps,
    );
    expect(result).toMatchObject({ status: "applied", migrated: true, overwrite: true });
    expect(confirmMigrate).not.toHaveBeenCalled();
    expect(confirmOverwrite).not.toHaveBeenCalled();
    expect(deps.clearDirectory).toHaveBeenCalledWith(path.resolve(target));
  });

  it("native 预选仅切换：不迁移、不询问覆盖", async () => {
    const confirmMigrate = vi.fn();
    const deps = createDeps({
      confirmMigrate,
      confirmOverwrite: vi.fn(),
      hasData: vi.fn(() => true),
    });
    const result = await applyPortableDataLocation(
      { enabled: true, dir: path.join("E:", "CyreneData"), migrationChoice: "switch" },
      deps,
    );
    expect(result).toMatchObject({ status: "applied", migrated: false });
    expect(confirmMigrate).not.toHaveBeenCalled();
    expect(deps.clearDirectory).not.toHaveBeenCalled();
  });
});
