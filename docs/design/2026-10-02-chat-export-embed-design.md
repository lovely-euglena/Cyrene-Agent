# 聊天记录导出嵌入主程序（chat-export 原生版）

> 2026-10-02 · 状态：已实现并验证

## 背景

插件市场里的 `chat-export`（聊天记录导出 v1.0.0）是纯用户侧插件：自开
`nodeIntegration` 窗口，直接读 `userData/cyrene-chats/sessions/<id>.json` 的
`messages` 字段，渲染 HTML / Markdown。

当前主程序会话存储是 **schema v2**：`sessions/<id>.json` 只剩元数据，正式消息
在会话轨迹（transcript journal）里，由 `ConversationSessionMigration
.loadComposedSession()` 组合。插件直读 `messages` 会导出空会话，因此把功能
**原生嵌入主程序**，数据源改为轨迹组合结果。

## 架构

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 共享类型 | `src/shared/chat-export.ts` | `ChatExportRequest` / `ChatExportResponse` / 格式枚举 |
| 主进程渲染与落盘 | `src/main/chats/chat-export.ts` | HTML / Markdown 渲染、头像收集、文件名清洗、写文件；不依赖 electron，便于单测 |
| IPC | `src/main/chats/chats-ipc.ts` | `CHATS_EXPORT`：弹目录框 → `loadComposedSession` 组合 v2 消息 → 写文件；`CHATS_EXPORT_REVEAL`：只放行本次导出登记过的路径 |
| 桥接 | `src/preload/index.ts`、`chat-page-bridge.ts` | `exportChats` / `revealExportPath` |
| 渲染层 | `ChatExportDialog.tsx` + `.css`、`ConversationSidebar.tsx` | 右键「导出对话…」打开弹窗：搜索、多选、HTML/Markdown、结果列表可定位文件 |
| i18n | `react/i18n/{zh-CN,en,ja-JP}.json` | `chatExport.*` 三语齐全 |

## 行为

- **HTML**：自包含单文件，聊天气泡布局；双方头像以 data URI 注入 CSS 一次；
  图片附件 base64 内嵌（文件缺失显示占位）；思考过程 / 工具调用折叠展示；
  渠道来源、表情包、工作区与时间范围写入页头。
- **Markdown**：正文 + `<details>` 折叠思考与工具；图片附件只保留文件名标注；
  与插件一致，输出到所选目录的 `markdown/` 子目录。
- **头像**：用户 `userData/avatar.png`、昔涟优先 `userData/cyrene-avatar.*`，
  回退打包内置 `dist/renderer/avatars/cyrene-avatar.png`，再回退程序绘制 SVG。
- **文件命名**：标题清洗 Windows 非法字符 + `YYYYMMDD`，重名自动 `-2`、`-3`；
  单个会话失败只记入 `errors`，不中断其它会话。
- **安全**：导出全程只读聊天存档；渲染端只能通过 `CHATS_EXPORT_REVEAL` 定位
  本次导出返回的路径（主进程内存白名单，重启即失效）。

## 与插件的关系

原生版覆盖并取代插件在 v2 存储上的能力；插件保留在市场中，兼容尚未迁移
v2 的旧版本。后续插件如需继续维护，建议改用宿主 `conversations` 服务
（`api.ts` 的 `PluginConversationsService`）而不是直读存档文件。

## 测试

- `src/main/chats/chat-export.test.ts`：文件名清洗/编号、头像回退、HTML 转义与
  附件内嵌、折叠块、Markdown 结构、批量导出与重名编号。
- `src/main/chats/chats-ipc.test.ts`：`CHATS_EXPORT` 组合轨迹消息导出两类文件、
  缺失会话记入 errors、`CHATS_EXPORT_REVEAL` 白名单放行/拒绝、空入参拒绝。
- `src/renderer/react/features/chat/components/ChatExportDialog.test.ts`：
  走桥接 API、不触碰 IPC/浏览器弹窗、`chatExport.*` 三语 key 齐全。

## 已知边界

- 导出进行中的会话时，读取的是轨迹已落盘部分；未结算的流式片段可能缺失。
- 超大会话按全量读入内存渲染，与插件行为一致；如遇极端体量再考虑分页流式。
- 压缩标记等仅存在于 UI 投影的条目不会进入导出（轨迹里本就没有）。
