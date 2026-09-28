# API 导航图标修复 + 邮件收信能力 + 审批/选择卡链路修复

> 日期：2026-09-27 · 范围：设置窗导航图标 / 邮件工具（SMTP 发信 + IMAP 收信）/ 工具审批链路
> 关联：`2026-09-27-settings-polish-batch.md`（同日前批 UI 修复）

## 0. 问题 → 处理

| # | 用户反馈 | 处理 |
|---|---|---|
| 1 | 设置页 API 导航图标「钥匙的圆不见了」 | 导航图标生成脚本补 `<circle>` → 圆弧路径转换（此前只处理 `<path>`/`<rect>`），重新生成 `SettingsNavIcons.cs`：`api`（钥匙圆环）与 `user`（头像头圆）恢复；同步 `user` 的 SectionMeta（脚本为事实源） |
| 2 | 内置邮箱加完整收信能力 | 新增 IMAP 收信链路：设置加 `emailImapHost/Port/Secure`（认证复用邮箱账号/授权码），新增工具 `email_list` / `email_read` / `email_mark`；WPF 与 Electron 设置页均有对应字段 |
| 3 | 发邮件失败，检查审批链路，顺便看其它工具/插件 | 根因：`send_email` 的确认卡（legacy `requestUserChoice`）发出的事件**不带 runId**，被渲染端 `RunEventGate` 当作串会话事件丢弃 → 卡片不显示 → 60s 超时按默认值 `cancel` → 「用户取消发送」。修复：`requestUserChoice` 增加 context（runId/threadId）并贯通发送/清卡事件与工具调用；同时把「权限拒绝原因」透传给模型；审计了其它工具/插件（见 §2） |

## 1. 导航图标（问题 1）

- `scripts/gen-settings-nav-icons.mjs`：`<circle cx/cy/r>` → `M(cx-r) cy A r r 0 1 1 (cx+r) cy A r r 0 1 1 (cx-r) cy Z`。
- 重新生成后 diff 仅三行：`user` 几何补头圆、`api` 几何补钥匙圆环、`user` 标题/说明与脚本对齐（我的信息）。
- 图标仍由「脚本生成 + 契约测试」约束，勿手改生成文件。

## 2. 审批 / 卡片链路（问题 3）

### 根因与修复

1. **legacy 选择卡无 runId（发邮件失败的直接原因）**
   - `user-choice.ts`：`requestUserChoice(question, options, default, context?: {runId, threadId})`；
     发送回调与超时 dismiss 回调都带 context；pending 记录 runId（供 `cancelPendingChoicesForRun` 清理）。
   - `bootstrap-config.ts`：`cyrene.choice` / `cyrene.choice.dismiss` 事件带 `runId`。
   - `email-tools.ts`：`executeSendEmail(args, ctx)` 把 `ctx.runId` 透传进确认卡。
2. **权限拒绝原因不透传**
   - 新增 `HarnessPermissionDecision { allowed, reason? }`；`tool-runtime` 返回带 reason 的决定
     （计划只读拦截 / 工具未注册 / `checkPermission` 的原因）；
   - `tool-dispatcher` 拒绝消息改为 `工具 "x" 被权限系统拒绝：<原因>`——模型能直接看到
     「当前档位「只读」不允许此操作……请到设置提升档位」，不用干巴巴重试。
   - `boolean` 返回兼容旧签名（子任务、测试不受影响）。

### 审计结论（其它工具 / 插件是否有类似问题）

| 链路 | 状态 |
|---|---|
| `send_email` 确认卡（legacy `requestUserChoice`） | **唯一无 runId 的卡片发送方**，已修复（全仓 grep 确认） |
| `ask_user` / 计划审批卡（`requestUserClarification` + agui-bridge） | 事件自带 `threadId/runId`，正常 |
| 天气卡（`cyrene.weather`） | 工具上下文带 runId，正常 |
| 权限审批卡（`PERMISSION_APPROVAL_REQUEST`） | 走独立 IPC；按 `request.runId` 路由会话，找不到会话时 10s 幂等重播，结算广播清卡，正常 |
| 插件工具 | `ctx.registerTool` 要求显式 risk；未声明 → `undeclared`：只读/指定目录档拒绝、每次审批档询问、完全访问放行（设计如此）。此前拒绝原因不透明，本次已透传给模型 |
| MCP 工具（添加的 MCP Server） | 无 annotations 且无 `effectKindOverrides` → `undeclared`，同上；如需放行请在 MCP 配置里加 override 或提升档位 |
| 定时任务触发需审批/确认的工具 | 无聊天窗口时选择卡无人可答 → 超时按默认值（发信默认取消）；审批无窗口直接拒绝。行为偏保守，未改 |

## 3. 邮件收信能力（问题 2）

- **依赖**：`imapflow`（IMAP 客户端）+ `mailparser`（MIME 解析）+ `@types/mailparser`（dev）。
- **设置（GeneralSettings）**：
  - `emailImapHost`（默认空 = 不收信）、`emailImapPort`（默认 993）、`emailImapSecure`（默认 true）；
  - 认证复用 `emailSmtpUser` / `emailSmtpPass`（同一邮箱账号 + 授权码），UI 文案已说明。
  - 白名单：`sanitizeNativePluginsSave`（host 裁剪 500、port 1~65535、secure 布尔）；
    快照：`buildPluginsSectionSnapshot` 新增三字段；WPF 插件页邮件卡与 Electron 插件面板同步加字段。
- **工具（work 模式，risk=network）**：
  - `email_list`：folder（默认 INBOX）/ limit（1~50，默认 10）/ unreadOnly / search（主题+发件人客户端过滤）；
    返回 uid、已读/未读、时间、发件人、主题。
  - `email_read`：uid + folder + markSeen（默认 true）；返回主题/收发件人/时间/附件名/纯文本正文
    （4000 字截断）；`source` → `simpleParser` 解析。
  - `email_mark`：uid + folder + seen（默认 true），标已读/未读。
  - 连接/操作失败与未配置都返回可展示的中文字符串（不抛异常）；每次执行新建连接，配置即时生效。

## 4. 不变量（后续改动必须保持）

1. run 内工具发任何 CUSTOM 卡片事件必须带 `runId`（渲染端 `RunEventGate` 按 run 过滤；
   缺 runId = 卡片被静默丢弃）。新增卡片发送方一律走带 context 的回调。
2. `requestUserChoice` 的发送与 dismiss 必须成对带同一 context；超时结算不能让卡片变僵尸。
3. 权限拒绝必须带可操作 reason（档位提示/未注册/计划只读），不得只回「被拒绝」。
4. 邮件收信认证与发信共用账号/授权码；IMAP 未配置时收信工具返回配置指引，不影响发信。
5. 导航图标只改 `scripts/gen-settings-nav-icons.mjs` 后重新生成，勿手改 `SettingsNavIcons.cs`。

## 5. 验证

- 单测：email-tools 18 例（发信参数/确认卡 runId/收信列表/读信/标记/未配置/连接失败）；
  user-choice 新增 runId 透传用例；native-settings-protocol 新增 IMAP 白名单用例；
  native-settings-sections 插件快照新增 IMAP 字段断言。
- `dotnet build -c Release` / `tsc -p tsconfig.main.json` / `npm run build:renderer` 0 错。
- 全量测试与打包冒烟见提交记录。
