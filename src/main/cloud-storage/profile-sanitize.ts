// 云存储档案写入白名单校验（独立模块：不依赖 electron，便于单测）。
//
// 设置页 IPC 与任何写入路径都必须先过这里：只保留已知字段，协议必须在白名单内；
// 必填项/端口/认证方式等语义校验仍由 .NET --storage-host 侧按协议把关。

import { CLOUD_STORAGE_PROTOCOLS } from "../../shared/cloud-storage";

const MAX_TEXT = 500;
const MAX_SECRET = 2_000;

function takeString(input: Record<string, unknown>, key: string, max = MAX_TEXT): string | undefined {
  const value = input[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

/** 秘密字段不 trim（密码可能含前后空格），空串视作缺省（更新时保留旧值）。 */
function takeSecret(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.slice(0, MAX_SECRET);
}

function takeBool(input: Record<string, unknown>, key: string): boolean | undefined {
  return typeof input[key] === "boolean" ? (input[key] as boolean) : undefined;
}

function takePort(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const port = Math.round(value);
  return port > 0 && port <= 65_535 ? port : undefined;
}

/** 非法输入（非对象 / 协议不在白名单）返回 null。 */
export function sanitizeCloudStorageProfile(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const protocol = takeString(input, "protocol", 16);
  if (!protocol || !(CLOUD_STORAGE_PROTOCOLS as readonly string[]).includes(protocol)) return null;

  return {
    id: takeString(input, "id", 64),
    name: takeString(input, "name", 100),
    protocol,
    host: takeString(input, "host"),
    port: takePort(input, "port"),
    username: takeString(input, "username"),
    rootPath: takeString(input, "rootPath"),
    tlsMode: input.tlsMode === "implicit" ? "implicit" : input.tlsMode === "explicit" ? "explicit" : undefined,
    allowInvalidCert: takeBool(input, "allowInvalidCert"),
    passive: takeBool(input, "passive"),
    authType: input.authType === "privateKey" ? "privateKey" : input.authType === "password" ? "password" : undefined,
    privateKeyPath: takeString(input, "privateKeyPath", 1_000),
    password: takeSecret(input, "password"),
    passphrase: takeSecret(input, "passphrase"),
    baseUrl: takeString(input, "baseUrl", 1_000),
    webdavAuthType: input.webdavAuthType === "digest" || input.webdavAuthType === "none" || input.webdavAuthType === "basic"
      ? input.webdavAuthType
      : undefined,
    bucket: takeString(input, "bucket", 255),
    endpoint: takeString(input, "endpoint", 1_000),
    region: takeString(input, "region", 100),
    pathStyle: takeBool(input, "pathStyle"),
    accessKeyId: takeSecret(input, "accessKeyId"),
    secretAccessKey: takeSecret(input, "secretAccessKey"),
    sessionToken: takeSecret(input, "sessionToken"),
  };
}
