import type { SettingsSection } from "../../features/settings/AppearanceSettingsPage";

export type SettingsDestination =
  | { kind: "settings"; section: SettingsSection }
  | { kind: "scheduledTasks" };

const SECTION_MAP: Record<string, SettingsSection> = {
  appearance: "appearance",
  preferences: "preferences",
  api: "models",
  "api-advanced": "models",
  models: "models",
  tokens: "usage",
  usage: "usage",
  general: "general",
  plugins: "tools",
  tools: "tools",
  music: "preferences",
  toolToggle: "toolToggle",
  memory: "memory",
  cyrene: "cyrene",
  skill: "skill",
  subagents: "subagents",
  asr: "asr",
  tts: "tts",
  mcp: "mcp",
  channels: "channels",
  disclaimer: "disclaimer",
  // fork 旧 section 名 → 聊天窗设置页落点（2026-10 入口统一后，
  // 主进程可能带着这些历史 section 进来；不能落错页）
  user: "general", // 个人资料在头像菜单的用户资料弹窗维护
  about: "general", // 版本 / 更新在「常规」；运行信息不再单独成页
  portable: "general", // 便携模式 / 数据目录在「常规」
  cache: "general", // 缓存目录在「常规」
  runtime: "models", // 旧「高级设置」（请求超时 / 工具并发）
};

export function resolveSettingsDestination(section?: string): SettingsDestination {
  if (section === "tasks") return { kind: "scheduledTasks" };
  const destinationSection = SECTION_MAP[section ?? ""] ?? "appearance";
  return { kind: "settings", section: destinationSection };
}
