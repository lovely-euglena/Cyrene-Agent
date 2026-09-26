// native 设置窗（.NET cyrene-native）写入协议：宿主侧白名单与取值校验。
//
// 协议（native → 宿主，走 cmd 事件通道）：
//   {"kind":"settings","action":"set","key":<general 键>,"value":...}
//   {"kind":"settings","action":"set-user-profile","profile":{...}}
//   {"kind":"settings","action":"pick-avatar"}
//
// 相关对端（改动时必须同步）：
//   - C# 侧 RequestRouter.cs（SendSetting / SendUserProfile 的键名与白名单）
//   - SettingsWindow.cs（各 section 控件读写的键名）
//   - 宿主快照 getSettingsSnapshot()（core-bootstrap.ts；读方向同一套键名）
//
// 键名历史：native 设置窗一期曾用 autoStart/trayResident/theme 读写，
// 与宿主快照 launchAtLogin/uiTheme 不一致 → 开关永远显示默认值、写入被
// 白名单丢弃（只有 petVisible 恰好对上）。本模块固化为唯一契约。

import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { normalizeWindowCornerRadius } from "../../shared/window-corner-radius";
import { normalizeUiIcon } from "../../shared/ui-icon";
import { isAllowedTimezoneValue } from "../../shared/timezone-options";
import {
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
} from "../../shared/preferences";
import { normalizeCustomStyleConfig } from "../../shared/style-sampling";
import type { GeneralSettings } from "../settings/general-settings";
import type { ModelSettings } from "../settings/model-settings";
import type { UserProfile } from "../settings-store";

/** general settings 可写键（宿主白名单；C# 侧只应发送这些键） */
export const NATIVE_GENERAL_SETTING_KEYS = [
  "launchAtLogin",
  "petVisible",
  "petAlwaysOnTop",
  "petZoom",
  "uiIcon",
  "uiTheme",
  "language",
  "windowCornerRadius",
  "toastSoundEnabled",
  "chatLineHeight",
  "assistantBubbleEnabled",
  "chatParaSpacing",
  "disableGpuElectron",
  "gitCommitAuthorName",
  "gitCommitAuthorEmail",
  "sidebarVisible",
  "tasksVisible",
  // 偏好设置（preferences section）：
  "screenshotBackend",
  "snipastePath",
  "mobileMessageSegmentation",
  "proactiveChatMode",
  "proactiveDeliveryTarget",
  "chatSocialContextEnabled",
  "momentsEnabled",
  "cyreneMomentsPostingEnabled",
  "cyreneMomentsReactionsEnabled",
  "momentsCharacterReactionsEnabled",
  "momentsLiveliness",
  "citaEnabled",
  "customStyle",
  "ragDownloadMirror",
] as const;

export type NativeGeneralSettingKey = (typeof NATIVE_GENERAL_SETTING_KEYS)[number];

/** 用户资料可写字段（不含 avatarPath——头像由宿主弹文件框，native 不传路径） */
export const NATIVE_USER_PROFILE_FIELDS = [
  "nickname",
  "callPreference",
  "birthday",
  "defaultCity",
  "timezone",
  "gender",
] as const;

// ── 设置窗路由：入口默认走 WPF（.NET），例外见下 ──────────────────────────

/**
 * Electron 专属 section：内容仍在 Electron，入口一律弹 Electron 页——
 *   - channels：渠道配置独立 Electron 窗（用户指定不迁 .NET）
 *   - tts / asr：TTS/ASR 配置保持在 Electron 设置页
 */
export const ELECTRON_ONLY_SETTINGS_SECTIONS = ["channels", "tts", "asr"] as const;

/**
 * WPF 设置窗认识的 section（与 SettingsWindow.cs 的 AddSection 对齐；
 * 契约测试锁定）。不在其中（未知 section 防落错页）或命中 ELECTRON_ONLY
 * 时，入口回 Electron 页。
 */
export const NATIVE_SETTINGS_SECTIONS = [
  "general",
  "preferences",
  "appearance",
  "user",
  "about",
  "api",
  "api-advanced",
  "disclaimer",
  "memory",
  "plugins",
  "tasks",
  "tokens",
  "cyrene",
  "channels",
  "tts",
  "asr",
] as const;

/**
 * 设置入口路由裁决：true = 弹 Electron 设置页；false = 用 WPF（.NET）设置窗。
 *   - 无 section（通用入口）→ WPF
 *   - channels / tts / asr → Electron
 *   - 其余 WPF 认识的 section（含占位 api/memory/tasks）→ WPF
 *   - WPF 不认识的 section（Electron 专属）→ Electron（避免落错页）
 */
export function shouldOpenSettingsInElectron(section?: string): boolean {
  if (!section) return false;
  if ((ELECTRON_ONLY_SETTINGS_SECTIONS as readonly string[]).includes(section)) return true;
  return !(NATIVE_SETTINGS_SECTIONS as readonly string[]).includes(section);
}

// ── section 动作契约（cmd settings <kind> {"verb":...}） ─────────────────

/**
 * native 设置窗 section 动作白名单。C# SettingsWindow.*.cs 通过
 * RequestRouter.SendSettingsAction(kind, verb, payload) 发送，宿主组合根按
 * (kind, verb) 分发；契约测试扫描 C# 源码锁定（未知 verb 会被宿主 warn 丢弃）。
 */
export const NATIVE_SECTION_ACTIONS = {
  api: ["save", "test", "test-vision", "set-default-profile", "delete-profile"],
  preferences: ["open-prompt"],
  cyrene: [
    "save",
    "open-sticker-manager",
    "add-sticker",
    "open-model-docs",
    "delete-embedding",
    "check-model-update",
  ],
  runtime: ["save"],
  tokens: ["set-days", "clear"],
  memory: [
    "save-l0",
    "save-l1",
    "delete-doc",
    "vault-bind",
    "vault-unbind",
    "vault-export",
    "vault-sync",
    "vault-auto-sync",
  ],
  scheduler: ["add", "update", "toggle", "fire", "delete", "history"],
} as const;

export type NativeSectionKind = keyof typeof NATIVE_SECTION_ACTIONS;

const USER_PROFILE_FIELD_MAX_LENGTH = 200;
const GENDERS = new Set(["secret", "male", "female"]);

/**
 * general 设置写入校验：未知键/非法值返回 null（宿主静默忽略，与旧白名单语义一致）。
 * windowCornerRadius 走共享归一化（0–40 整数）；uiTheme 走归一化（当前恒 pearl-white）。
 */
export function sanitizeNativeGeneralSetting(
  key: string,
  value: unknown,
): Partial<GeneralSettings> | null {
  switch (key) {
    case "launchAtLogin":
    case "petVisible":
    case "petAlwaysOnTop":
    case "toastSoundEnabled":
    case "assistantBubbleEnabled":
    case "disableGpuElectron":
    case "sidebarVisible":
    case "tasksVisible":
    case "chatSocialContextEnabled":
    case "momentsEnabled":
    case "cyreneMomentsPostingEnabled":
    case "cyreneMomentsReactionsEnabled":
    case "momentsCharacterReactionsEnabled":
    case "citaEnabled":
      return typeof value === "boolean" ? { [key]: value } : null;
    case "petZoom": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return { petZoom: Math.min(2, Math.max(0.5, Math.round(value * 10) / 10)) };
    }
    case "chatLineHeight": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return { chatLineHeight: Math.min(2, Math.max(1.2, Math.round(value * 100) / 100)) };
    }
    case "chatParaSpacing": {
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      return { chatParaSpacing: Math.min(1.2, Math.max(0.2, Math.round(value * 100) / 100)) };
    }
    case "uiIcon":
      return typeof value === "string" ? { uiIcon: normalizeUiIcon(value) } : null;
    case "gitCommitAuthorName":
    case "gitCommitAuthorEmail":
      return typeof value === "string" ? { [key]: value.trim().slice(0, 200) } : null;
    case "windowCornerRadius":
      if (typeof value !== "number" && typeof value !== "string") return null;
      if (typeof value === "string" && value.trim() === "") return null;
      return { windowCornerRadius: normalizeWindowCornerRadius(value) };
    case "uiTheme":
      return typeof value === "string" ? { uiTheme: normalizeUiTheme(value) as UiTheme } : null;
    case "language":
      // GeneralSettings.language 当前仅支持 zh-CN（normalizeGeneralSettings 会强制归一）
      return value === "zh-CN" ? { language: "zh-CN" } : null;
    // ── 偏好设置（preferences section）：渲染页同款归一化（非法值回落默认档） ──
    case "mobileMessageSegmentation":
      return typeof value === "string"
        ? { mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(value) }
        : null;
    case "proactiveChatMode":
      return typeof value === "string" ? { proactiveChatMode: normalizeProactiveChatMode(value) } : null;
    case "proactiveDeliveryTarget":
      return typeof value === "string"
        ? { proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(value) }
        : null;
    case "momentsLiveliness":
      return value === "quiet" || value === "natural" || value === "lively"
        ? { momentsLiveliness: value }
        : null;
    case "screenshotBackend":
      return value === "builtin" || value === "snipaste" ? { screenshotBackend: value } : null;
    case "snipastePath":
      return typeof value === "string" ? { snipastePath: value.trim().slice(0, 500) } : null;
    case "customStyle":
      return value !== null && typeof value === "object"
        ? { customStyle: normalizeCustomStyleConfig(value) }
        : null;
    case "ragDownloadMirror":
      return value === "official" || value === "hf-mirror" ? { ragDownloadMirror: value } : null;
    default:
      return null;
  }
}

/**
 * 用户资料写入校验：只保留白名单字段的合法值；无有效字段时返回 null。
 * 时区必须命中共享白名单；性别必须为 secret/male/female。
 */
export function sanitizeNativeUserProfile(raw: unknown): Partial<UserProfile> | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const patch: Partial<UserProfile> = {};
  let hasField = false;

  const takeString = (field: "nickname" | "callPreference" | "birthday" | "defaultCity"): void => {
    const value = input[field];
    if (typeof value !== "string") return;
    patch[field] = value.trim().slice(0, USER_PROFILE_FIELD_MAX_LENGTH);
    hasField = true;
  };

  takeString("nickname");
  takeString("callPreference");
  takeString("birthday");
  takeString("defaultCity");

  if (isAllowedTimezoneValue(input.timezone)) {
    patch.timezone = input.timezone;
    hasField = true;
  }
  if (typeof input.gender === "string" && GENDERS.has(input.gender)) {
    patch.gender = input.gender;
    hasField = true;
  }

  return hasField ? patch : null;
}

// ── 「昔涟设置」section（cyrene）：写入 payload 校验 ─────────────────────

const STICKER_ID_MAX_LENGTH = 64;
const STICKER_TEXT_MAX_LENGTH = 200;
const STICKER_PHRASE_LIMIT = 50;
const STICKER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** cyrene save 动作（状态栏实时更新 / 表情包发送 / RAG 模型）可写字段（model settings 子集）。 */
export type NativeCyreneSavePatch = Partial<
  Pick<
    ModelSettings,
    | "runtimeSync"
    | "stickerEnabled"
    | "stickerSize"
    | "stickerSimilarityThreshold"
    | "embeddingDimensions"
    | "rerankerMode"
  >
>;

/**
 * cyrene save payload 校验：只保留合法字段（未知档位丢弃、阈值 clamp 0.3~0.9
 * 两位小数、embedding 维度 clamp 1~65536 取整）；无有效字段返回 null
 * （宿主静默忽略）。embeddingDimensions: null = 清空（留空自动探测）。
 */
export function sanitizeNativeCyreneSave(raw: Record<string, unknown> | null | undefined): NativeCyreneSavePatch | null {
  if (!raw || typeof raw !== "object") return null;
  const patch: NativeCyreneSavePatch = {};
  if (raw.runtimeSync === "off" || raw.runtimeSync === "local" || raw.runtimeSync === "llm") {
    patch.runtimeSync = raw.runtimeSync;
  }
  if (typeof raw.stickerEnabled === "boolean") patch.stickerEnabled = raw.stickerEnabled;
  if (raw.stickerSize === "small" || raw.stickerSize === "standard" || raw.stickerSize === "large") {
    patch.stickerSize = raw.stickerSize;
  }
  if (typeof raw.stickerSimilarityThreshold === "number" && Number.isFinite(raw.stickerSimilarityThreshold)) {
    patch.stickerSimilarityThreshold =
      Math.round(Math.min(0.9, Math.max(0.3, raw.stickerSimilarityThreshold)) * 100) / 100;
  }
  // RAG：embedding 维度（null = 清空 → 首次请求自动探测）
  if (raw.embeddingDimensions === null) {
    patch.embeddingDimensions = undefined;
  } else if (typeof raw.embeddingDimensions === "number" && Number.isFinite(raw.embeddingDimensions)) {
    const dimensions = Math.round(raw.embeddingDimensions);
    if (dimensions > 0) patch.embeddingDimensions = Math.min(65_536, dimensions);
  }
  // RAG：reranker 模式（写入后由宿主重新 initReranker）
  if (raw.rerankerMode === "standard" || raw.rerankerMode === "none") {
    patch.rerankerMode = raw.rerankerMode;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export interface NativeStickerAddPayload {
  sourcePath: string;
  id: string;
  description: string;
  phrases: string[];
}

export type NativeStickerAddResult =
  | { ok: true; payload: NativeStickerAddPayload }
  | { ok: false; error: string };

/**
 * cyrene add-sticker payload 校验（与渲染页添加表情包表单同口径）：
 * 图片路径 + 英文名称 + 描述 + 至少一条相近语义；文件复制/查重在宿主
 * sticker-storage 侧继续把关。
 */
export function sanitizeNativeStickerAdd(raw: Record<string, unknown> | null | undefined): NativeStickerAddResult {
  const sourcePath = typeof raw?.sourcePath === "string" ? raw.sourcePath.trim().slice(0, 1000) : "";
  if (!sourcePath) return { ok: false, error: "请先选择图片文件" };

  const id = typeof raw?.id === "string" ? raw.id.trim().slice(0, STICKER_ID_MAX_LENGTH) : "";
  if (!STICKER_ID_PATTERN.test(id)) {
    return { ok: false, error: "名称只能用英文字母、数字、下划线和连字符" };
  }

  const description = typeof raw?.description === "string"
    ? raw.description.trim().slice(0, STICKER_TEXT_MAX_LENGTH)
    : "";
  if (!description) return { ok: false, error: "请填写图片描述" };

  const phrases = Array.isArray(raw?.phrases)
    ? raw.phrases
        .filter((phrase): phrase is string => typeof phrase === "string")
        .map((phrase) => phrase.trim().slice(0, STICKER_TEXT_MAX_LENGTH))
        .filter((phrase) => phrase.length > 0)
        .slice(0, STICKER_PHRASE_LIMIT)
    : [];
  if (phrases.length === 0) return { ok: false, error: "请至少写一行相近语义" };

  return { ok: true, payload: { sourcePath, id, description, phrases } };
}