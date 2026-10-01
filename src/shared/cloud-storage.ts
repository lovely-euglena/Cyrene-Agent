// 云存储档案的共享视图类型（主进程 IPC ↔ 渲染设置页 ↔ 工具层共用的最小形状）。
// 秘密字段一律只有 has* 布尔位；真实凭据在 .NET --storage-host 侧 DPAPI 加密落盘。

export type CloudStorageProtocol = "ftp" | "ftps" | "sftp" | "webdav" | "s3";

export const CLOUD_STORAGE_PROTOCOLS: readonly CloudStorageProtocol[] = ["ftp", "ftps", "sftp", "webdav", "s3"];

export interface CloudStorageProfileView {
  id: string;
  name: string;
  protocol: CloudStorageProtocol | string;
  host?: string;
  port?: number;
  username?: string;
  rootPath?: string;
  tlsMode?: "explicit" | "implicit" | string;
  allowInvalidCert?: boolean;
  passive?: boolean;
  authType?: "password" | "privateKey" | string;
  privateKeyPath?: string | null;
  baseUrl?: string;
  webdavAuthType?: "basic" | "digest" | "none" | string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  pathStyle?: boolean;
  hasPassword?: boolean;
  hasPassphrase?: boolean;
  hasAccessKey?: boolean;
  createdAt?: string;
  updatedAt?: string;
}
