// 云存储设置 IPC：档案 CRUD + 测试连接（设置页用）。
//
// 连接/凭据在 cyrene-native --storage-host（DPAPI 加密落盘），这里只做
// 入参白名单校验（profile-sanitize） + 转发，绝不回传任何秘密。

import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { nativeStorageHost } from "./native-storage-host";
import { sanitizeCloudStorageProfile } from "./profile-sanitize";

export interface CloudStorageIpcDependencies {
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

export function registerCloudStorageIpc(deps: CloudStorageIpcDependencies = {}): void {
  const ipc = deps.ipc ?? createIpcScope();

  ipc.handle(IPC.CLOUD_STORAGE_PROFILES_LIST, () => nativeStorageHost.call("profiles.list", {}, 15_000));

  ipc.handle(IPC.CLOUD_STORAGE_PROFILE_SAVE, (_event, raw: unknown) => {
    const profile = sanitizeCloudStorageProfile(raw);
    if (!profile) throw new Error("云存储档案参数无效（协议必须是 ftp/ftps/sftp/webdav/s3）");
    return nativeStorageHost.call("profiles.upsert", { profile }, 20_000);
  });

  ipc.handle(IPC.CLOUD_STORAGE_PROFILE_REMOVE, (_event, id: unknown) => {
    const profileId = typeof id === "string" ? id.trim() : "";
    if (!profileId) throw new Error("缺少档案 id");
    return nativeStorageHost.call("profiles.remove", { id: profileId }, 15_000);
  });

  ipc.handle(IPC.CLOUD_STORAGE_PROFILE_TEST, (_event, id: unknown) => {
    const profileId = typeof id === "string" ? id.trim() : "";
    if (!profileId) throw new Error("缺少档案 id");
    return nativeStorageHost.call("profiles.test", { profileId }, 30_000);
  });
}
