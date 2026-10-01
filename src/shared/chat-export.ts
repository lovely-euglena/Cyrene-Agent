// 聊天记录导出：主进程 / preload / 渲染端共用的请求与结果形状。
//
// 设计要点：
// - 导出由主进程执行：会话消息在 v2 轨迹存储里，渲染端没有全量多会话数据；
// - 目录选择在主进程弹系统框（与插件行为一致，取消时 canceled=true 静默返回）；
// - files 里的路径是绝对路径，渲染端只允许用 revealExportPath 定位这些文件。

export type ChatExportFormat = "html" | "markdown";

export interface ChatExportRequest {
  sessionIds: string[];
  formats: ChatExportFormat[];
}

export interface ChatExportFile {
  /** 文件名（含扩展名）。 */
  name: string;
  /** 导出文件的绝对路径。 */
  path: string;
  sessionId: string;
}

export interface ChatExportError {
  sessionId: string;
  /** 会话标题（读取失败时为 id）。 */
  title: string;
  error: string;
}

export type ChatExportResponse =
  | { ok: true; dir: string; files: ChatExportFile[]; errors: ChatExportError[] }
  | { ok: false; canceled?: boolean; error?: string };

export const CHAT_EXPORT_FORMATS: readonly ChatExportFormat[] = ["html", "markdown"];
