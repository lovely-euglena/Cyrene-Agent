// OCR 设置 IPC：设置页查询本地引擎可用性与语言列表。
//
// 开关/服务商/语言的写入走通用 settings:save-general（GeneralSettings 已含 ocr* 字段），
// 这里只暴露只读的状态查询。

import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { getOcrStatus } from "./ocr-registry";

export interface OcrIpcDependencies {
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

export function registerOcrIpc(deps: OcrIpcDependencies = {}): void {
  const ipc = deps.ipc ?? createIpcScope();
  ipc.handle(IPC.SETTINGS_OCR_GET_STATUS, () => getOcrStatus());
}
