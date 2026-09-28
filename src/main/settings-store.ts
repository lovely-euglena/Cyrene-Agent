import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface UserProfile {
  nickname: string;
  callPreference: string;
  birthday: string;
  timezone: string;
  avatarPath: string;
  /** 默认城市（用于天气等需要地理定位的工具，没填则模型会问用户） */
  defaultCity: string;
  /** 性别：secret(保密) | male(男) | female(女) */
  gender: string;
}

export const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: "",
  callPreference: "",
  birthday: "",
  timezone: "Asia/Shanghai",
  avatarPath: "",
  defaultCity: "",
  gender: "secret",
};

export function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json");
}

export function getGeneralSettingsPath(): string {
  return path.join(app.getPath("userData"), "app-settings.json");
}

export function getUserProfilePath(): string {
  return path.join(app.getPath("userData"), "user-profile.json");
}

export function getAvatarPath(): string {
  return path.join(app.getPath("userData"), "avatar.png");
}

export function getRagStorePath(): string {
  return path.join(app.getPath("userData"), "rag-data", "memory-store.json");
}

export function getStickerSettingsPath(): string {
  return path.join(app.getPath("userData"), "sticker-settings.json");
}

/**
 * 头像读为 data URL（不存在/读取失败返回 null）。
 * 设置窗（Electron 渲染页）与 native 设置窗快照共用；native 侧再解 base64 显示。
 */
export function loadAvatarDataUrl(): string | null {
  try {
    const avatarPath = getAvatarPath();
    if (!fs.existsSync(avatarPath)) return null;
    const buf = fs.readFileSync(avatarPath);
    const ext = path.extname(avatarPath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  } catch {
    return null;
  }
}

export function loadUserProfile(): UserProfile {
  try {
    const filePath = getUserProfilePath();
    if (!fs.existsSync(filePath)) return DEFAULT_USER_PROFILE;
    return { ...DEFAULT_USER_PROFILE, ...JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<UserProfile> };
  } catch {
    return DEFAULT_USER_PROFILE;
  }
}

export function saveUserProfile(profile: Partial<UserProfile>): UserProfile {
  const existing = loadUserProfile();
  const merged = { ...existing, ...profile };
  const filePath = getUserProfilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
