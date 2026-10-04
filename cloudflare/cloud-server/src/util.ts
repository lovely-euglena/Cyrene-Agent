/**
 * CF 版通用工具（IKJN79）：随机数 / SHA-256 / 配对码 / 设备名。
 *
 * 语义与 .NET AuthStore 逐项对齐（字母表、格式、截断规则）；
 * 零依赖、可在 Workers 与 Node（单测）双端运行。
 */

/** 配对码字母表（易读：无 0/O/1/I/L/U；与 .NET AuthStore.CodeAlphabet 一致）。 */
export const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_CODE_LENGTH = 8;
/** 设备名上限（UTF-16 码元；截断不切断代理对，与 .NET 一致）。 */
export const MAX_DEVICE_NAME_UNITS = 64;
export const DEFAULT_DEVICE_NAME = "未命名设备";

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function randomHex(byteLength: number): string {
  return toHex(randomBytes(byteLength));
}

/** RFC 4648 base64url（无填充；与 .NET Convert.ToBase64String + 替换一致）。 */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/u, "").replace(/\+/gu, "-").replace(/\//gu, "_");
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

/** 定长比较（防时序侧信道）：比较两串的 SHA-256 摘要。 */
export async function timingSafeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Hex(left), sha256Hex(right)]);
  let diff = 0;
  for (let index = 0; index < leftHash.length; index++) {
    diff |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return diff === 0;
}

/** 8 位配对码（拒绝采样避免模偏差；显示格式见 formatPairCode）。 */
export function randomPairCode(): string {
  const alphabetLength = PAIR_CODE_ALPHABET.length;
  const limit = Math.floor(0x1_0000_0000 / alphabetLength) * alphabetLength;
  const buffer = new Uint32Array(1);
  let code = "";
  while (code.length < PAIR_CODE_LENGTH) {
    crypto.getRandomValues(buffer);
    const value = buffer[0];
    if (value >= limit) continue;
    code += PAIR_CODE_ALPHABET[value % alphabetLength];
  }
  return code;
}

/** 显示格式 XXXX-XXXX（与 .NET FormatCode 一致）。 */
export function formatPairCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 规范化用户输入的配对码（去空格/连字符、大写、校验字符集与长度；非法返回 null）。 */
export function normalizePairCode(input: unknown): string | null {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  let normalized = "";
  for (const char of input) {
    if (char === " " || char === "-") continue;
    const upper = char.toUpperCase();
    if (!PAIR_CODE_ALPHABET.includes(upper)) return null;
    normalized += upper;
    if (normalized.length > PAIR_CODE_LENGTH) return null;
  }
  return normalized.length === PAIR_CODE_LENGTH ? normalized : null;
}

/** 设备名：空白 → 默认名；超长截断到 64 码元且不切断代理对（与 .NET Redeem 一致）。 */
export function normalizeDeviceName(input: unknown): string {
  const trimmed = typeof input === "string" ? input.trim() : "";
  let name = trimmed.length > 0 ? trimmed : DEFAULT_DEVICE_NAME;
  if (name.length > MAX_DEVICE_NAME_UNITS) {
    name = name.slice(0, MAX_DEVICE_NAME_UNITS);
    const last = name.charCodeAt(name.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) name = name.slice(0, -1);
  }
  return name;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
