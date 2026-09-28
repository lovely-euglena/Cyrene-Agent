/**
 * 便携模式：主进程与设置渲染进程共享的接口形状（纯类型，无运行时依赖）。
 *
 * 指针文件与迁移逻辑见 src/main/portable/；这里只固定 IPC 契约。
 */

/** 数据目录状态（settings:portable-get）。 */
export interface PortableDataLocationStatus {
  /** 指针文件是否配置了自定义目录（便携/自定义）。 */
  enabled: boolean;
  /** 指针文件中的目录（已解析为绝对路径）；null = 系统默认。 */
  dataDir: string | null;
  /** 指针文件中的原始存储值（相对值原样，如 "data"）；null = 系统默认。设置页回显用。 */
  displayDir: string | null;
  /** 本次会话实际生效的数据目录（app.getPath("userData")）。 */
  effectiveDataDir: string;
  /** 系统默认数据目录（%APPDATA%/...），关闭便携模式时迁回的目标。 */
  systemDataDir: string;
  /** 程序根目录（打包版 = exe 所在目录；开发版 = 仓库根）。 */
  installRoot: string;
  /** 默认便携目录：<程序目录>/data。 */
  suggestedDir: string;
  /** 指针文件路径。 */
  configPath: string;
}

/** 迁移询问结果：迁移 / 仅切换 / 取消。 */
export type PortableMigrationChoice = "migrate" | "switch" | "cancel";

/** 应用变更请求（settings:portable-apply）。 */
export interface PortableApplyRequest {
  /** true = 使用便携/自定义目录；false = 回到系统默认目录。 */
  enabled: boolean;
  /** 便携模式下的目标目录（空 = 默认 <程序目录>/data）；支持相对路径（相对程序目录）。 */
  dir: string;
  /**
   * native 设置窗已完成的迁移选择；缺省时宿主自行弹确认框（旧 Electron 设置页路径）。
   * native 侧把选择随请求下发，宿主不再重复弹窗。
   */
  migrationChoice?: PortableMigrationChoice;
  /** native 设置窗已确认覆盖目标目录时的显式覆盖；缺省时宿主按需弹确认框。 */
  overwrite?: boolean;
}

/** 应用变更结果。 */
export type PortableApplyResult =
  | {
      status: "applied";
      targetDir: string;
      migrated: boolean;
      overwrite: boolean;
      /** 复制失败的文件/目录名（单个占用不阻断整体迁移）。 */
      failedEntries: string[];
      relaunching: boolean;
    }
  | { status: "cancelled" }
  | { status: "noop"; dataDir: string }
  | { status: "error"; error: string };
