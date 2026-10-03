/**
 * 双轨脚本运行环境预置（必须在其它业务模块 import 之前第一个 import）。
 *
 * 主进程工具代码依赖 electron `app.getPath("userData")`（expense 本地存储等）。
 * 脚本在纯 Node 下跑 TS 基线，这里提供最小 electron 替身：getPath → 临时目录，
 * 且**不提供** app.getAppPath/isPackaged（让 resolveNativeWindowsExe 自然失败，
 * 保证 TS 轨执行的是纯 TS 回退实现，而不是真的把 host 拉起来）。
 */
import { mkdtempSync } from "node:fs";
import Module from "node:module";
import * as os from "node:os";
import * as path from "node:path";

/** TS 轨本地存储工具（expense 等）的隔离 userData。 */
export const DUAL_TRACK_USER_DATA = mkdtempSync(path.join(os.tmpdir(), "dual-track-userdata-"));

const moduleAny = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = moduleAny._load;
moduleAny._load = function patchedLoad(request: string, ...rest: unknown[]): unknown {
  if (request === "electron") {
    return {
      app: {
        getPath: (_name?: string) => DUAL_TRACK_USER_DATA,
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};
