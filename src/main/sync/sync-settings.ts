/**
 * 云端同步 · 设置存储（IKJK2I B 簇）。
 *
 * userData/sync/settings.json：{enabled, baseUrl, deviceName, token}。
 * token 加密落盘，照抄 channels/settings-store 的 safeStorage `enc:` → `obf:` 回退模式：
 *   - safeStorage 可用（OS 钥匙串）→ `enc:<base64>`；
 *   - 不可用（headless / 沙盒 / libsecret 缺失）→ 机器指纹 XOR 混淆 `obf:<base64>`（可 round-trip，不抗逆向）；
 *   - `plain:` / 无前缀 = 旧数据，按明文读。
 *
 * 公开快照（toPublicSyncConfig）永不携带 token，仅暴露 hasToken（shared/sync-types.ts 冻结口径）。
 */

import * as fs from "fs";
import * as path from "path";
import { app, safeStorage } from "electron";
import type { SyncConfigPublic } from "../../shared/sync-types";

/** safeStorage 加密后的前缀。读取时遇到这个前缀就解密 */
const ENC_PREFIX = "enc:";
/** base64 混淆前缀（safeStorage 不可用时的兜底，可 round-trip 但不抗逆向） */
const OBF_PREFIX = "obf:";
/** 明文兜底标记（旧版数据迁移用） */
const PLAIN_PREFIX = "plain:";

/** 检测当前环境 safeStorage 是否可用。Linux 无 DISPLAY 时不可用。 */
let safeStorageAvailable: boolean | null = null;
function isSafeStorageAvailable(): boolean {
  if (safeStorageAvailable !== null) return safeStorageAvailable;
  // safeStorage 在 app ready 之前不可用（Windows：ready 后才返回 true）。
  // ready 前直接返回 false 且【不写缓存】——否则模块加载期的早期调用会把
  // false 永久缓存，导致之后 enc: 字段全部解密失败、加密全部降级为混淆。
  if (!app.isReady()) return false;
  try {
    safeStorageAvailable = safeStorage.isEncryptionAvailable();
  } catch {
    safeStorageAvailable = false;
  }
  return safeStorageAvailable;
}

/** 机器指纹 XOR 混淆 key —— 不抗逆向但保证 round-trip。
 *  用 userData 绝对路径 + 包名做 SHA256 → 16 字节（与 channels/settings-store 同构）。 */
function getMachineKey(): Buffer {
  const seed = `${app.getPath("userData")}::${app.getName()}::cyrene-sync-secret`;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash } = require("crypto") as typeof import("crypto");
  return createHash("sha256").update(seed).digest().subarray(0, 16);
}

/** XOR 混淆（不是真加密，仅挡 casual 偷窥）。 */
function obfuscate(plain: string): string {
  const key = getMachineKey();
  const buf = Buffer.from(plain, "utf8");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return OBF_PREFIX + out.toString("base64");
}

/** XOR 解混淆（必须和 obfuscate 用同一台机器 —— key 派生自 userData 路径）。 */
function deobfuscate(stored: string): string {
  const key = getMachineKey();
  const b64 = stored.slice(OBF_PREFIX.length);
  const buf = Buffer.from(b64, "base64");
  const out = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    // eslint-disable-next-line no-bitwise
    out[i] = buf[i] ^ key[i % key.length];
  }
  return out.toString("utf8");
}

/** 加密一个字符串。优先级: safeStorage > 机器指纹混淆 > 明文 */
function encryptField(plain: string): string {
  if (!plain) return "";
  if (isSafeStorageAvailable()) {
    try {
      const buf = safeStorage.encryptString(plain);
      return ENC_PREFIX + buf.toString("base64");
    } catch (err) {
      console.warn("[SyncSettings] safeStorage.encryptString 失败, 回退混淆:", err);
    }
  }
  return obfuscate(plain);
}

/** 解密一个字符串。识别 enc:/obf:/plain: 前缀。空字符串返回空。 */
function decryptField(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(ENC_PREFIX)) {
    if (!isSafeStorageAvailable()) {
      console.warn("[SyncSettings] safeStorage 不可用, 无法解密 enc: 字段");
      return "";
    }
    try {
      const buf = Buffer.from(stored.slice(ENC_PREFIX.length), "base64");
      return safeStorage.decryptString(buf);
    } catch (err) {
      console.warn("[SyncSettings] safeStorage.decryptString 失败:", err);
      return "";
    }
  }
  if (stored.startsWith(OBF_PREFIX)) {
    try {
      return deobfuscate(stored);
    } catch (err) {
      console.warn("[SyncSettings] deobfuscate 失败:", err);
      return "";
    }
  }
  if (stored.startsWith(PLAIN_PREFIX)) {
    return stored.slice(PLAIN_PREFIX.length);
  }
  // 旧数据 / 兜底：当作明文
  return stored;
}

export interface SyncSettings {
  enabled: boolean;
  baseUrl: string;
  deviceName: string;
  /** 运行时明文 token（磁盘为 enc:/obf: 密文）；空 = 未配对。 */
  token: string;
}

export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  enabled: false,
  baseUrl: "",
  deviceName: "",
  token: "",
};

/** 归一化：baseUrl 去首尾空白 + 去尾斜杠（与 channels.remote 同口径）。 */
export function normalizeSyncSettings(input: Partial<SyncSettings> | null | undefined): SyncSettings {
  const raw = input ?? {};
  return {
    enabled: raw.enabled === true,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl.trim().replace(/\/+$/, "") : "",
    deviceName: typeof raw.deviceName === "string" ? raw.deviceName.trim() : "",
    token: typeof raw.token === "string" ? raw.token : "",
  };
}

/** 同步数据目录（<userData>/sync；settings/state/事件库共用）。 */
export function syncDirPath(): string {
  return path.join(app.getPath("userData"), "sync");
}

function filePath(): string {
  return path.join(syncDirPath(), "settings.json");
}

/** 读取设置：磁盘密文 → 运行时明文；缺失 / 损坏回默认（默认关闭）。 */
export function loadSyncSettings(): SyncSettings {
  try {
    const p = filePath();
    if (!fs.existsSync(p)) return { ...DEFAULT_SYNC_SETTINGS };
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SyncSettings>;
    const loaded = normalizeSyncSettings(raw);
    if (loaded.token) loaded.token = decryptField(loaded.token);
    return loaded;
  } catch {
    return { ...DEFAULT_SYNC_SETTINGS };
  }
}

/** 保存设置（局部补丁深合并）：明文 token 写盘前加密；返回运行时明文形态。 */
export function saveSyncSettings(patch: Partial<SyncSettings>): SyncSettings {
  const existing = loadSyncSettings();
  const merged = normalizeSyncSettings({ ...existing, ...patch });
  // 避开"密文回传"：已带前缀的 token 不重复加密；空 token = 清除。
  if (
    merged.token
    && !merged.token.startsWith(ENC_PREFIX)
    && !merged.token.startsWith(OBF_PREFIX)
    && !merged.token.startsWith(PLAIN_PREFIX)
  ) {
    merged.token = encryptField(merged.token);
  }
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  fs.writeFileSync(filePath(), JSON.stringify(merged, null, 2), "utf8");

  const out: SyncSettings = { ...merged };
  if (out.token) out.token = decryptField(out.token);
  return out;
}

/** 公开快照：剥离 token（仅 hasToken）；deviceId / serverDeviceId 由状态层补充。 */
export function toPublicSyncConfig(
  settings: SyncSettings,
): Pick<SyncConfigPublic, "enabled" | "baseUrl" | "deviceName" | "hasToken"> {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    deviceName: settings.deviceName,
    hasToken: Boolean(settings.token),
  };
}
