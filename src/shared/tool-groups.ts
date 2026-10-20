/**
 * 工具分组规则（#187）——**shared 单一事实源**：设置页（renderer 分组折叠）
 * 与模型侧工具目录（buildToolCatalog 按组分节）共用同一规则表，不漂移。
 *
 * 组序 = 本文件定义序（other 恒最后）；新工具自动落 "other"。
 */

export type ToolGroupKey =
  | "music"
  | "ssh"
  | "storage"
  | "memory"
  | "knowledge"
  | "email"
  | "network"
  | "system"
  | "other";

/** 组名（中文常量）：模型侧 catalog 直接使用（LLM 中文语境）；设置页另有 i18n key。 */
export const TOOL_GROUP_LABELS: Readonly<Record<ToolGroupKey, string>> = {
  music: "音乐",
  ssh: "SSH 远程",
  storage: "云存储",
  memory: "记忆",
  knowledge: "知识库",
  email: "邮件",
  network: "网络与抓取",
  system: "系统与文件",
  other: "其他",
};

const TOOL_GROUP_RULES: ReadonlyArray<{ key: ToolGroupKey; exact?: ReadonlySet<string>; prefix?: readonly string[] }> = [
  { key: "music", prefix: ["music_"] },
  { key: "ssh", prefix: ["ssh_"] },
  { key: "storage", prefix: ["cloud_"] },
  { key: "memory", exact: new Set(["user_memory", "read_memory", "write_memory", "recall_history"]) },
  { key: "knowledge", prefix: ["wiki_", "knowledge_"] },
  { key: "email", prefix: ["email_"] },
  { key: "network", exact: new Set(["web_search", "fetch_url", "download_file", "read_image_url", "weather"]) },
  { key: "system", exact: new Set(["run_shell", "shell_job", "ocr_image", "clipboard", "calculator", "now", "install_mcp_server", "run_verification"]) },
];

/** 工具 id → 组。规则表唯一出口，两端不各写一份。 */
export function groupOfTool(toolId: string): ToolGroupKey {
  for (const rule of TOOL_GROUP_RULES) {
    if (rule.exact?.has(toolId)) return rule.key;
    if (rule.prefix?.some((p) => toolId.startsWith(p))) return rule.key;
  }
  return "other";
}

export interface ToolGroupSection<T> {
  key: ToolGroupKey;
  tools: T[];
}

/** 泛型分组：组序=规则序（other 恒最后）；组内保持传入顺序（调用方决定排序）。 */
export function groupByToolGroup<T extends { id: string }>(tools: readonly T[]): Array<ToolGroupSection<T>> {
  const buckets = new Map<ToolGroupKey, T[]>();
  for (const tool of tools) {
    const key = groupOfTool(tool.id);
    const list = buckets.get(key) ?? [];
    list.push(tool);
    buckets.set(key, list);
  }
  const sections: Array<ToolGroupSection<T>> = [];
  for (const rule of TOOL_GROUP_RULES) {
    const list = buckets.get(rule.key);
    if (list?.length) sections.push({ key: rule.key, tools: list });
  }
  const other = buckets.get("other");
  if (other?.length) sections.push({ key: "other", tools: other });
  return sections;
}
