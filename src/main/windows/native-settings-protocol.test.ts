// native 设置窗写入协议测试：
//   1. 宿主侧白名单/取值校验（sanitize*）
//   2. 跨语言契约回归：C# SettingsWindow.cs 实际写入的键必须全部落在
//      宿主白名单内；RequestRouter.cs 的 settings.set 白名单必须与
//      NATIVE_GENERAL_SETTING_KEYS 完全一致。
//      （历史 bug：C# 写 autoStart/trayResident/theme，宿主白名单是
//       launchAtLogin/uiTheme → 除 petVisible 外全部静默丢弃。）

import * as fs from "fs";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  ELECTRON_ONLY_SETTINGS_SECTIONS,
  NATIVE_GENERAL_SETTING_KEYS,
  NATIVE_SECTION_ACTIONS,
  NATIVE_SETTINGS_SECTIONS,
  NATIVE_USER_PROFILE_FIELDS,
  sanitizeNativeGeneralSetting,
  sanitizeNativeUserProfile,
  shouldOpenSettingsInElectron,
} from "./native-settings-protocol";

const settingsWindowCs = fs.readFileSync(
  fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.cs", import.meta.url)),
  "utf8",
);
const requestRouterCs = fs.readFileSync(
  fileURLToPath(new URL("../../../dotnet/native-windows/RequestRouter.cs", import.meta.url)),
  "utf8",
);
const bridgeTs = fs.readFileSync(
  fileURLToPath(new URL("./native-windows-bridge.ts", import.meta.url)),
  "utf8",
);
const settingsSectionCs = [
  settingsWindowCs,
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Api.cs", import.meta.url)),
    "utf8",
  ),
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Memory.cs", import.meta.url)),
    "utf8",
  ),
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Tasks.cs", import.meta.url)),
    "utf8",
  ),
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Preferences.cs", import.meta.url)),
    "utf8",
  ),
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Runtime.cs", import.meta.url)),
    "utf8",
  ),
  fs.readFileSync(
    fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.Tokens.cs", import.meta.url)),
    "utf8",
  ),
].join("\n");

/** 提取 C# 源码中所有 SetSetting("key&quot;, ...) 的键名 */
function extractCsWriteKeys(source: string): string[] {
  return [...source.matchAll(/SetSetting\("([A-Za-z]+)"/g)].map((m) => m[1]);
}

/** 提取 C# 源码中所有 SetUserProfile("field&quot;, ...) 的字段名 */
function extractCsUserProfileFields(source: string): string[] {
  return [...source.matchAll(/SetUserProfile\("([A-Za-z]+)"/g)].map((m) => m[1]);
}

/** 提取 C# 设置窗 AddSection("id&quot;, ...) 的 section id */
function extractCsSections(source: string): string[] {
  return [...source.matchAll(/AddSection\("([^"]+)"/g)].map((m) => m[1]);
}

/** 提取 AddSection("id", ..., native: false, ...) 的非原生 section（走 Electron 占位/入口） */
function extractCsLegacySections(source: string): string[] {
  return [...source.matchAll(/AddSection\("([^"]+)",\s*"[^"]*",\s*native:\s*false/g)].map((m) => m[1]);
}

/** 提取 IsNativeSection 表达式里的 section 字面量（懒构建门禁，漂移会落占位页） */
function extractCsNativeSectionGate(source: string): string[] {
  const match = source.match(/IsNativeSection\(string id\)\s*\n?\s*=>([^;]+);/);
  if (!match) throw new Error("SettingsWindow.cs 未找到 IsNativeSection 表达式");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** 提取 RequestRouter.cs 中 settings.set 白名单集合 */
function extractCsAllowedSet(source: string): string[] {
  const match = source.match(/new HashSet<string>\s*\{([^}]*)\}/);
  if (!match) throw new Error("RequestRouter.cs 未找到 HashSet 白名单");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("sanitizeNativeGeneralSetting", () => {
  it("放行布尔键（launchAtLogin/petVisible/petAlwaysOnTop/toastSoundEnabled）", () => {
    expect(sanitizeNativeGeneralSetting("launchAtLogin", true)).toEqual({ launchAtLogin: true });
    expect(sanitizeNativeGeneralSetting("petVisible", false)).toEqual({ petVisible: false });
    expect(sanitizeNativeGeneralSetting("petAlwaysOnTop", true)).toEqual({ petAlwaysOnTop: true });
    expect(sanitizeNativeGeneralSetting("toastSoundEnabled", false)).toEqual({ toastSoundEnabled: false });
  });

  it("windowCornerRadius 归一化（clamp 0–40 取整，字符串数字也接受）", () => {
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", 18.6)).toEqual({ windowCornerRadius: 19 });
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", -2)).toEqual({ windowCornerRadius: 0 });
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", 99)).toEqual({ windowCornerRadius: 40 });
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", "12")).toEqual({ windowCornerRadius: 12 });
  });

  it("uiTheme 归一化（当前恒 pearl-white，保留键前向兼容）", () => {
    expect(sanitizeNativeGeneralSetting("uiTheme", "rose-dark")).toEqual({ uiTheme: "pearl-white" });
    expect(sanitizeNativeGeneralSetting("uiTheme", 42)).toBeNull();
  });

  it("language 仅接受 zh-CN", () => {
    expect(sanitizeNativeGeneralSetting("language", "zh-CN")).toEqual({ language: "zh-CN" });
    expect(sanitizeNativeGeneralSetting("language", "en-US")).toBeNull();
  });

  it("类型不符/未知键/历史键名一律拒绝", () => {
    expect(sanitizeNativeGeneralSetting("petVisible", "yes")).toBeNull();
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", "")).toBeNull();
    expect(sanitizeNativeGeneralSetting("windowCornerRadius", Number.NaN)).toEqual({ windowCornerRadius: 24 });
    expect(sanitizeNativeGeneralSetting("unknownKey", true)).toBeNull();
    // 历史键名（一期 bug 源头）：必须继续保持拒绝
    expect(sanitizeNativeGeneralSetting("autoStart", true)).toBeNull();
    expect(sanitizeNativeGeneralSetting("trayResident", true)).toBeNull();
    expect(sanitizeNativeGeneralSetting("theme", "rose-dark")).toBeNull();
  });

  it("白名单键集合锁定（读方向快照键 uiTheme/language 仍在；集合变化需同步 C#）", () => {
    expect([...NATIVE_GENERAL_SETTING_KEYS]).toEqual([
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
      "disableGpuElectron",
      "gitCommitAuthorName",
      "gitCommitAuthorEmail",
      "sidebarVisible",
      "tasksVisible",
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
    ]);
  });

  it("偏好设置（preferences）键：归一化 / 类型校验", () => {
    expect(sanitizeNativeGeneralSetting("screenshotBackend", "snipaste")).toEqual({ screenshotBackend: "snipaste" });
    expect(sanitizeNativeGeneralSetting("screenshotBackend", "other")).toBeNull();
    expect(sanitizeNativeGeneralSetting("snipastePath", "  C:/tools/Snipaste.exe  ")).toEqual({
      snipastePath: "C:/tools/Snipaste.exe",
    });
    expect(sanitizeNativeGeneralSetting("mobileMessageSegmentation", "on")).toEqual({
      mobileMessageSegmentation: "on",
    });
    expect(sanitizeNativeGeneralSetting("mobileMessageSegmentation", "yes")).toEqual({
      mobileMessageSegmentation: "off",
    });
    expect(sanitizeNativeGeneralSetting("proactiveChatMode", "on")).toEqual({ proactiveChatMode: "on" });
    expect(sanitizeNativeGeneralSetting("proactiveDeliveryTarget", "feishu")).toEqual({
      proactiveDeliveryTarget: "feishu",
    });
    expect(sanitizeNativeGeneralSetting("proactiveDeliveryTarget", "sms")).toEqual({
      proactiveDeliveryTarget: "local",
    });
    expect(sanitizeNativeGeneralSetting("momentsLiveliness", "lively")).toEqual({ momentsLiveliness: "lively" });
    expect(sanitizeNativeGeneralSetting("momentsLiveliness", "chaos")).toBeNull();
    expect(sanitizeNativeGeneralSetting("momentsEnabled", true)).toEqual({ momentsEnabled: true });
    expect(sanitizeNativeGeneralSetting("citaEnabled", "yes")).toBeNull();
    // customStyle：只收对象，交给共享归一化（非法档位回落默认 / 数值 clamp）
    expect(sanitizeNativeGeneralSetting("customStyle", null)).toBeNull();
    expect(sanitizeNativeGeneralSetting("customStyle", "temperature")).toBeNull();
    expect(sanitizeNativeGeneralSetting("customStyle", {
      diversity: { driver: "temperature", value: 9 },
      repetition: "strong",
    })).toEqual({
      customStyle: { diversity: { driver: "temperature", value: 2 }, repetition: "strong" },
    });
  });
});

describe("sanitizeNativeUserProfile", () => {
  it("只保留白名单字段并 trim", () => {
    const patch = sanitizeNativeUserProfile({
      nickname: "  小昔  ",
      callPreference: "主人",
      birthday: "2001-02-03",
      defaultCity: "上海",
      timezone: "Asia/Tokyo",
      gender: "female",
      avatarPath: "C:/evil.png", // 不在白名单：头像路径只能由宿主文件框产生
      unknown: "x",
    });
    expect(patch).toEqual({
      nickname: "小昔",
      callPreference: "主人",
      birthday: "2001-02-03",
      defaultCity: "上海",
      timezone: "Asia/Tokyo",
      gender: "female",
    });
  });

  it("时区必须命中共享白名单，性别必须为三档之一", () => {
    expect(sanitizeNativeUserProfile({ timezone: "Mars/Olympus" })).toBeNull();
    expect(sanitizeNativeUserProfile({ timezone: "Asia/Taipei" })).toEqual({ timezone: "Asia/Taipei" });
    expect(sanitizeNativeUserProfile({ gender: "other" })).toBeNull();
    expect(sanitizeNativeUserProfile({ gender: "secret" })).toEqual({ gender: "secret" });
  });

  it("无有效字段（非对象/空对象/全非法）返回 null", () => {
    expect(sanitizeNativeUserProfile(null)).toBeNull();
    expect(sanitizeNativeUserProfile("nickname")).toBeNull();
    expect(sanitizeNativeUserProfile({})).toBeNull();
    expect(sanitizeNativeUserProfile({ nickname: 42, timezone: "bad" })).toBeNull();
  });

  it("字段长度截断到 200（防御异常长输入穿过帧协议）", () => {
    const long = "x".repeat(500);
    const patch = sanitizeNativeUserProfile({ nickname: long });
    expect(patch?.nickname).toHaveLength(200);
  });

  it("字段集合锁定", () => {
    expect([...NATIVE_USER_PROFILE_FIELDS]).toEqual([
      "nickname",
      "callPreference",
      "birthday",
      "defaultCity",
      "timezone",
      "gender",
    ]);
  });
});

describe("跨语言契约：C# 设置窗 ↔ 宿主白名单", () => {
  it("SettingsWindow(*).cs 写入的所有 general 键都在宿主白名单内", () => {
    const csKeys = new Set(extractCsWriteKeys(settingsSectionCs));
    expect(csKeys.size).toBeGreaterThan(0);
    for (const key of csKeys) {
      expect(NATIVE_GENERAL_SETTING_KEYS).toContain(key);
    }
  });

  it("SettingsWindow.cs 不再写历史键名（autoStart/trayResident/theme）", () => {
    const csKeys = extractCsWriteKeys(settingsWindowCs);
    expect(csKeys).not.toContain("autoStart");
    expect(csKeys).not.toContain("trayResident");
    expect(csKeys).not.toContain("theme");
  });

  it("RequestRouter.cs settings.set 白名单与 NATIVE_GENERAL_SETTING_KEYS 完全一致", () => {
    expect(new Set(extractCsAllowedSet(requestRouterCs))).toEqual(new Set(NATIVE_GENERAL_SETTING_KEYS));
  });

  it("SettingsWindow.cs 用户资料写入字段都在宿主白名单内（含时区/性别）", () => {
    const fields = new Set(extractCsUserProfileFields(settingsWindowCs));
    expect(fields.size).toBeGreaterThan(0);
    for (const field of fields) {
      expect(NATIVE_USER_PROFILE_FIELDS).toContain(field);
    }
    // avatarPath 只能由宿主文件框产生，native 不得直接写路径
    expect(fields).not.toContain("avatarPath");
  });

  it("C# 发送的 cmd 动作都有宿主处理（死按钮回归：open-legacy/openChannels/plugins open）", () => {
    // 扫描设置窗与 RequestRouter 里的 SendCommand("kind", "action") 调用
    const sources = [settingsWindowCs, requestRouterCs];
    const actions = new Set<string>();
    for (const source of sources) {
      for (const match of source.matchAll(/SendCommand\("([^"]+)",\s*"([^"]+)"/g)) {
        actions.add(match[2]);
      }
    }
    expect(actions.size).toBeGreaterThan(0);
    for (const action of actions) {
      // 宿主 switch 必须有对应 case（动作名在桥接开关中唯一；kind 区分由 case 内部处理）
      expect(bridgeTs).toContain(`case "${action}"`);
    }
  });

  it("渠道按钮走 openChannels（而非 open-legacy channels）", () => {
    expect(settingsWindowCs).toContain('SendCommand("settings", "openChannels")');
  });
});

describe("设置窗路由裁决 shouldOpenSettingsInElectron", () => {
  it("无 section（通用入口）→ WPF", () => {
    expect(shouldOpenSettingsInElectron()).toBe(false);
    expect(shouldOpenSettingsInElectron(undefined)).toBe(false);
  });

  it("channels / tts / asr → Electron（保持弹页面）", () => {
    for (const section of ELECTRON_ONLY_SETTINGS_SECTIONS) {
      expect(shouldOpenSettingsInElectron(section)).toBe(true);
    }
  });

  it("WPF 认识的 section（含新迁 disclaimer/api-advanced/preferences）→ WPF", () => {
    for (const section of ["general", "appearance", "user", "about", "api", "api-advanced", "disclaimer", "memory", "plugins", "tasks", "tokens", "preferences"]) {
      expect(shouldOpenSettingsInElectron(section)).toBe(false);
    }
  });

  it("Electron 专属 section（cyrene）→ Electron", () => {
    for (const section of ["cyrene", "unknown-section"]) {
      expect(shouldOpenSettingsInElectron(section)).toBe(true);
    }
  });

  it("C# 设置窗 section 集合与 NATIVE_SETTINGS_SECTIONS 完全一致（路由不会落错页）", () => {
    const csSections = extractCsSections(settingsWindowCs);
    expect(csSections.length).toBeGreaterThan(0);
    expect(new Set(csSections)).toEqual(new Set(NATIVE_SETTINGS_SECTIONS));
  });

  it("IsNativeSection 门禁与 AddSection(native:true) 集合一致（漂移会落旧版占位页）", () => {
    const legacy = new Set(extractCsLegacySections(settingsWindowCs));
    const expectedNative = NATIVE_SETTINGS_SECTIONS.filter((section) => !legacy.has(section));
    expect(new Set(extractCsNativeSectionGate(settingsWindowCs))).toEqual(new Set(expectedNative));
  });
});

describe("section 动作契约（cmd settings <kind> verb）", () => {
  it("C# SendSettingsAction 的 kind/verb 都在白名单内", () => {
    const calls = [...settingsSectionCs.matchAll(/SendSettingsAction\("([a-z]+)",\s*"([a-z0-9-]+)"/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [, kind, verb] of calls) {
      expect(Object.keys(NATIVE_SECTION_ACTIONS)).toContain(kind);
      const verbs = NATIVE_SECTION_ACTIONS[kind as keyof typeof NATIVE_SECTION_ACTIONS] as readonly string[];
      expect(verbs).toContain(verb);
    }
  });

  it("各 section 动作集合锁定（宿主 switch 与 C# 同步）", () => {
    expect([...NATIVE_SECTION_ACTIONS.api]).toEqual(["save", "test", "test-vision", "set-default-profile", "delete-profile"]);
    expect([...NATIVE_SECTION_ACTIONS.preferences]).toEqual(["open-prompt"]);
    expect([...NATIVE_SECTION_ACTIONS.memory]).toEqual([
      "save-l0",
      "save-l1",
      "delete-doc",
      "vault-bind",
      "vault-unbind",
      "vault-export",
      "vault-sync",
      "vault-auto-sync",
    ]);
    expect([...NATIVE_SECTION_ACTIONS.scheduler]).toEqual(["add", "update", "toggle", "fire", "delete", "history"]);
  });
});