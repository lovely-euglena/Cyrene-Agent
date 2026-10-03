# Cyrene-Agent 文档索引

> 本目录是仓库的文档中心。根 [README.md](../README.md)（[English](../README.en.md)）面向使用者与贡献者；
> 这里按「现行 / 设计 / 记录 / 历史」四类组织全部文档，避免旧设计稿被误读为当前行为。
> 最近整理：2026-10-03。

## 状态口径

| 标记 | 含义 |
| --- | --- |
| **现行** | 描述当前代码行为，随代码一起维护 |
| **设计** | 方案与决策记录；是否已实现以文内「状态」行为准 |
| **记录** | 问题排查 / 批次工作记录，主要用于追溯 |
| **历史** | 写作时刻的快照，不代表现状 |

## 推荐阅读路径

- **初次接手 / 运维排障**：[handover.md](./handover.md)（历史快照，注意口径）→ [build-guide.md](./build-guide.md) → [dotnet-backend.md](./dotnet-backend.md)
- **理解 Agent 架构**：根 README「CyreneHarness 核心引擎」→ [multi-agent-architecture.md](./multi-agent-architecture.md) → [design/2026-09-21-cta-conversation-transcript-architecture-design.md](./design/2026-09-21-cta-conversation-transcript-architecture-design.md)
- **使用功能**：根 README → [user-guide/](./user-guide/)
- **开发插件**：[plugins/plugin-dev-guide.md](./plugins/plugin-dev-guide.md)（教程）→ [plugins/plugin-authoring.md](./plugins/plugin-authoring.md)（API 规范）→ [plugins/dotnet-plugins.md](./plugins/dotnet-plugins.md)（.NET 轨）
- **参与贡献**：[.github/CONTRIBUTING.md](../.github/CONTRIBUTING.md)（核心模块需先开 Issue 讨论）

## 根级文档

| 文档 | 状态 | 说明 |
| --- | --- | --- |
| [handover.md](./handover.md) | 历史（2026-09-24 快照） | 前任维护者交接：仓库布局 / 双轨开关 / 铁律 / 测试矩阵 / 发版 / 已知坑 |
| [build-guide.md](./build-guide.md) | 现行 | Linux 交叉构建 Windows 便携版：环境 / 构建 / 分卷上传 / 常见坑 |
| [dotnet-backend.md](./dotnet-backend.md) | 现行 | .NET 七 host 进程地图、实测矩阵、安全加固 |
| [dotnet-migration-decisions.md](./dotnet-migration-decisions.md) | 现行 | .NET 迁移 A1–A19 决策记录 |
| [multi-agent-architecture.md](./multi-agent-architecture.md) | 现行 | 多 Agent 编排（Plan B：编排下沉 .NET，循环复用 TS CyreneHarness） |
| [local-models.md](./local-models.md) | 现行 | 本地模型（BGE-M3 等）的一键下载 / 放置与许可 |
| [cloud-storage.md](./cloud-storage.md) | 设计 | 云存储工具设计文档 |
| [bug-report-20260926.md](./bug-report-20260926.md) | 记录 | 2026-09-26 问题报告 |
| [CONTRIBUTORS.md](./CONTRIBUTORS.md) | 现行 | 贡献者名单 |

## 目录导航

### user-guide/ — 用户指南（现行）

- [feishu.md](./user-guide/feishu.md) — 飞书私聊接入（约 10 分钟）
- [napcat-onebot.md](./user-guide/napcat-onebot.md) — QQ / NapCat（OneBot 11）接入
- [qqbot-official.md](./user-guide/qqbot-official.md) — QQ 官方机器人开放平台接入
- [learn-mode.md](./user-guide/learn-mode.md) — Learn 模式使用说明（Obsidian Vault）

### plugins/ — 插件开发（现行）

- [plugin-dev-guide.md](./plugins/plugin-dev-guide.md) — 教程版，面向社群开发者
- [plugin-authoring.md](./plugins/plugin-authoring.md) — Runtime Plugin API v1 规范
- [dotnet-plugins.md](./plugins/dotnet-plugins.md) — .NET 插件轨（双轨制第二轨）

### design/ — 设计与方案

> 实现状态以文内状态行为准。近期重点：
> [2026-09-26-agent-orchestration-plan-b.md](./design/2026-09-26-agent-orchestration-plan-b.md)（多 Agent 编排机制 v1；子 Agent 接入接口已就绪、生产未接线）・
> [2026-09-21-cta-conversation-transcript-architecture-design.md](./design/2026-09-21-cta-conversation-transcript-architecture-design.md)（CTA 会话轨迹）・
> [2026-09-22-no-auto-resend-and-interruption-context-design.md](./design/2026-09-22-no-auto-resend-and-interruption-context-design.md)（取消自动续跑与中断进上下文）・
> 2026-10-02 批次（本地音乐播放器 / OCR / shell 命令守卫 / token 统计 / Pandoc / 聊天导出 / 云存储）・2026-10-03 模型一键下载窗・密钥迁移 .NET 设计草案・云端昔涟 RFC（架构章节先行）・LLM 服务化（.NET 作业 + 轮询）设计草案・写类工具 evidence 帧协议 v1（fs 三件接线落地）。

<details>
<summary>全部 55 篇 + 2 个子目录（按时间序）</summary>

- [2026-08-08-cyreneHarnessloopdesign.md](./design/2026-08-08-cyreneHarnessloopdesign.md)
- [2026-08-09-cyreneHarness-construction-plan.md](./design/2026-08-09-cyreneHarness-construction-plan.md)
- [2026-08-09-cyrene-harness-construction-status.md](./design/2026-08-09-cyrene-harness-construction-status.md)
- [2026-08-09-cyrene-harness-current-status.md](./design/2026-08-09-cyrene-harness-current-status.md)
- [2026-08-09-cyreneHarness-design-review.md](./design/2026-08-09-cyreneHarness-design-review.md)
- [2026-08-12-code-git-live-refresh-construction-plan.md](./design/2026-08-12-code-git-live-refresh-construction-plan.md)
- [2026-08-25-harness-parallel-scheduling-optimization-plan.md](./design/2026-08-25-harness-parallel-scheduling-optimization-plan.md)
- [2026-08-29-gamebot-p0-construction-plan.md](./design/2026-08-29-gamebot-p0-construction-plan.md)
- [2026-08-30-main-process-composition-root-construction-plan.md](./design/2026-08-30-main-process-composition-root-construction-plan.md)
- [2026-08-30-main-process-composition-root-redesign.md](./design/2026-08-30-main-process-composition-root-redesign.md)
- [2026-09-03-bilinote-video-notes-design-reference.md](./design/2026-09-03-bilinote-video-notes-design-reference.md)
- [2026-09-03-chatpage-refactor-design.md](./design/2026-09-03-chatpage-refactor-design.md)
- [2026-09-03-chatpage-refactor-regression-checklist.md](./design/2026-09-03-chatpage-refactor-regression-checklist.md)
- [2026-09-03-learn-mode-upgrade-construction-plan.md](./design/2026-09-03-learn-mode-upgrade-construction-plan.md)
- [2026-09-04-moments-social-feed-design.md](./design/2026-09-04-moments-social-feed-design.md)
- [2026-09-06-moments-character-social-enhancement-design.md](./design/2026-09-06-moments-character-social-enhancement-design.md)
- [2026-09-07-moments-mention-reply-and-liveliness-design.md](./design/2026-09-07-moments-mention-reply-and-liveliness-design.md)
- [2026-09-09-attention-toast-center-design.md](./design/2026-09-09-attention-toast-center-design.md)
- [2026-09-11-minecraft-goal-harness-headless-design.md](./design/2026-09-11-minecraft-goal-harness-headless-design.md)
- [2026-09-13-tool-display-name-chinese-design.md](./design/2026-09-13-tool-display-name-chinese-design.md)
- [2026-09-15-agent-execution-master-plan.md](./design/2026-09-15-agent-execution-master-plan.md)
- [2026-09-15-dsh-right-panel-diff-comparison.md](./design/2026-09-15-dsh-right-panel-diff-comparison.md)
- [2026-09-15-live-candidate-answer-construction-plan.md](./design/2026-09-15-live-candidate-answer-construction-plan.md)
- [2026-09-15-message-queue-dsh-reference.md](./design/2026-09-15-message-queue-dsh-reference.md)
- [2026-09-15-right-panel-ide-layout-design.md](./design/2026-09-15-right-panel-ide-layout-design.md)
- [2026-09-15-runtime-unified-view-rework-design.md](./design/2026-09-15-runtime-unified-view-rework-design.md)
- [2026-09-15-vision-image-pipeline-review.md](./design/2026-09-15-vision-image-pipeline-review.md)
- [2026-09-15-vision-image-router-redesign.md](./design/2026-09-15-vision-image-router-redesign.md)
- [2026-09-15-workspace-open-files-review-design.md](./design/2026-09-15-workspace-open-files-review-design.md)
- [2026-09-21-cta-conversation-transcript-architecture-design.md](./design/2026-09-21-cta-conversation-transcript-architecture-design.md)
- [2026-09-22-no-auto-resend-and-interruption-context-design.md](./design/2026-09-22-no-auto-resend-and-interruption-context-design.md)
- [2026-09-23-plan-approval-in-run-design.md](./design/2026-09-23-plan-approval-in-run-design.md)
- [2026-09-23-plan-mode-permission-and-state-design.md](./design/2026-09-23-plan-mode-permission-and-state-design.md)
- [2026-09-24-zcode-sidebar-construction-plan.md](./design/2026-09-24-zcode-sidebar-construction-plan.md)
- [2026-09-25-classic-dark-pink-theme-design.md](./design/2026-09-25-classic-dark-pink-theme-design.md)
- [2026-09-26-agent-orchestration-plan-b.md](./design/2026-09-26-agent-orchestration-plan-b.md)
- [2026-09-26-rag-backend-dotnet-migration.md](./design/2026-09-26-rag-backend-dotnet-migration.md)
- [2026-09-26-vectorstore-sqlite-evaluation.md](./design/2026-09-26-vectorstore-sqlite-evaluation.md)
- [2026-10-02-chat-export-embed-design.md](./design/2026-10-02-chat-export-embed-design.md)
- [2026-10-02-cloud-storage-tool-design.md](./design/2026-10-02-cloud-storage-tool-design.md)
- [2026-10-02-local-music-player-design.md](./design/2026-10-02-local-music-player-design.md)
- [2026-10-02-ocr-local-and-cloud-reserved.md](./design/2026-10-02-ocr-local-and-cloud-reserved.md)
- [2026-10-02-pandoc-document-integration-plan.md](./design/2026-10-02-pandoc-document-integration-plan.md)
- [2026-10-02-shell-command-guard.md](./design/2026-10-02-shell-command-guard.md)
- [2026-10-02-token-stats-integration.md](./design/2026-10-02-token-stats-integration.md)
- [2026-10-03-model-download-window.md](./design/2026-10-03-model-download-window.md)
- [2026-10-03-secrets-migration-to-dotnet.md](./design/2026-10-03-secrets-migration-to-dotnet.md)
- [2026-10-03-cloud-cyrene-rfc.md](./design/2026-10-03-cloud-cyrene-rfc.md)
- [2026-10-03-llm-service-dotnet-job-polling.md](./design/2026-10-03-llm-service-dotnet-job-polling.md)
- [2026-10-03-tool-evidence-frame-protocol.md](./design/2026-10-03-tool-evidence-frame-protocol.md)
- [gamebot-Honkai-Star-Rail.md](./design/gamebot-Honkai-Star-Rail.md)
- [plugin-marketplace.md](./design/plugin-marketplace.md)
- [react-frontend-visual-guidelines.md](./design/react-frontend-visual-guidelines.md)
- [snowluma-plugin.md](./design/snowluma-plugin.md)
- [zcode-sidebar-migration.md](./design/zcode-sidebar-migration.md)
- [2026-08-09-harness-runtime-boundary/](./design/2026-08-09-harness-runtime-boundary/) — Harness 运行边界（实施计划 2 篇）
- [plugin-system/](./design/plugin-system/) — 插件系统（架构 / 实施计划 / 进度 3 篇）

</details>

### internal-issue/ — 问题与批次记录（记录）

> 最近：
> [2026-10-03-task-orchestrator-interface.md](./internal-issue/2026-10-03-task-orchestrator-interface.md)（子 Agent 编排接口层交付）・
> [2026-10-02-plugin-page-runtime-and-icon-fix.md](./internal-issue/2026-10-02-plugin-page-runtime-and-icon-fix.md)・
> [2026-10-01-settings-in-chat.md](./internal-issue/2026-10-01-settings-in-chat.md)。
> `perf/` 为压测 / 性能探针产物（JSON / PNG），非文档。

<details>
<summary>全部 28 篇（按时间序）</summary>

- [2026-08-25-harness-parallel-scheduling-known-issues.md](./internal-issue/2026-08-25-harness-parallel-scheduling-known-issues.md)
- [2026-08-26-image-context-screenshot-known-issues.md](./internal-issue/2026-08-26-image-context-screenshot-known-issues.md)
- [2026-08-26-maxtoken-model-switch-glm53-known-issues.md](./internal-issue/2026-08-26-maxtoken-model-switch-glm53-known-issues.md)
- [2026-08-27-runshell-hang-glm53-reasoning-known-issues.md](./internal-issue/2026-08-27-runshell-hang-glm53-reasoning-known-issues.md)
- [2026-09-05-minimax-m3-write-markdown-param-loss-report.md](./internal-issue/2026-09-05-minimax-m3-write-markdown-param-loss-report.md)
- [2026-09-05-tool-mode-override-env-context-leak.md](./internal-issue/2026-09-05-tool-mode-override-env-context-leak.md)
- [2026-09-06-shell-output-truncation-timeout-known-issues.md](./internal-issue/2026-09-06-shell-output-truncation-timeout-known-issues.md)
- [2026-09-09-architecture-review-verification-known-issues.md](./internal-issue/2026-09-09-architecture-review-verification-known-issues.md)
- [2026-09-10-proactive-chat-user-report-unconfirmed.md](./internal-issue/2026-09-10-proactive-chat-user-report-unconfirmed.md)
- [2026-09-17-chat-renderer-performance-known-issues.md](./internal-issue/2026-09-17-chat-renderer-performance-known-issues.md)
- [2026-09-20-cross-run-context-discontinuity-report.md](./internal-issue/2026-09-20-cross-run-context-discontinuity-report.md)
- [2026-09-20-harness-recovery-orphan-tool-result-400-construction.md](./internal-issue/2026-09-20-harness-recovery-orphan-tool-result-400-construction.md)
- [2026-09-20-harness-recovery-orphan-tool-result-400-report.md](./internal-issue/2026-09-20-harness-recovery-orphan-tool-result-400-report.md)
- [2026-09-26-cyrene-rag-native-section.md](./internal-issue/2026-09-26-cyrene-rag-native-section.md)
- [2026-09-26-native-settings-migration-final.md](./internal-issue/2026-09-26-native-settings-migration-final.md)
- [2026-09-26-native-window-icons-fix.md](./internal-issue/2026-09-26-native-window-icons-fix.md)
- [2026-09-26-p1-hardening-batch.md](./internal-issue/2026-09-26-p1-hardening-batch.md)
- [2026-09-26-plugin-market-load-and-search-fix.md](./internal-issue/2026-09-26-plugin-market-load-and-search-fix.md)
- [2026-09-26-plugins-section-native-migration.md](./internal-issue/2026-09-26-plugins-section-native-migration.md)
- [2026-09-26-voice-sections-native-migration.md](./internal-issue/2026-09-26-voice-sections-native-migration.md)
- [2026-09-27-api-icon-email-receive-and-approval-fixes.md](./internal-issue/2026-09-27-api-icon-email-receive-and-approval-fixes.md)
- [2026-09-27-memory-baseline.md](./internal-issue/2026-09-27-memory-baseline.md)
- [2026-09-27-native-polish-batch-2.md](./internal-issue/2026-09-27-native-polish-batch-2.md)
- [2026-09-27-native-settings-batch-3.md](./internal-issue/2026-09-27-native-settings-batch-3.md)
- [2026-09-27-settings-polish-batch.md](./internal-issue/2026-09-27-settings-polish-batch.md)
- [2026-10-01-settings-in-chat.md](./internal-issue/2026-10-01-settings-in-chat.md)
- [2026-10-02-plugin-page-runtime-and-icon-fix.md](./internal-issue/2026-10-02-plugin-page-runtime-and-icon-fix.md)
- [2026-10-03-task-orchestrator-interface.md](./internal-issue/2026-10-03-task-orchestrator-interface.md)

</details>

### specs/ — 规格草案（设计）

- [2026-08-08-dmae-v5-upgrade-and-l2-working-memory.md](./specs/2026-08-08-dmae-v5-upgrade-and-l2-working-memory.md) — DMAE v5 升级与 L2 工作记忆
- [2026-09-03-channel-conversation-binding.md](./specs/2026-09-03-channel-conversation-binding.md) — 渠道会话绑定
- [2026-09-27-main-model-provider-error-map.md](./specs/2026-09-27-main-model-provider-error-map.md) — 主模型厂商错误映射
- [2026-09-27-main-model-provider-error-notice.md](./specs/2026-09-27-main-model-provider-error-notice.md) — 主模型厂商错误提示

### references/ — 参考资料（现行）

- [vendor-errors/README.md](./references/vendor-errors/README.md) — 厂商错误知识库入口（Last verified 2026-09-27）
- `vendor-errors/` 下按厂商分文件：claude-anthropic / deepseek / doubao-seed / gemini / glm / grok-xai / kimi / mimo / minimax / openai-gpt / qwen

### refactor/ — 早期重构计划（历史）

- [2026-08-31-agui-bridge-refactor.md](./refactor/2026-08-31-agui-bridge-refactor.md)
- [2026-08-31-build-options-refactor.md](./refactor/2026-08-31-build-options-refactor.md)
- [2026-08-31-harness-adapter-refactor.md](./refactor/2026-08-31-harness-adapter-refactor.md)
- [2026-09-09-channels-dispatcher-refactor-plan.md](./refactor/2026-09-09-channels-dispatcher-refactor-plan.md)
- [2026-09-14-dependency-audit-baseline.md](./refactor/2026-09-14-dependency-audit-baseline.md)
- [2026-09-14-engineering-governance-plan.md](./refactor/2026-09-14-engineering-governance-plan.md)

### superpowers/ — 上游工作流文档（历史）

> `plans/` 执行计划 9 篇 + `specs/` 设计稿 8 篇，与 `docs/refactor/` 同期，保留作参考。

### image/ — 文档图片资源

> README 截图、Harness 示意图、收款码等静态资源，非文档。

## 维护约定

- 新增 `design/`、`internal-issue/` 文档使用 `YYYY-MM-DD-主题.md` 命名，头部写明状态与关联文档。
- 代码行为变化时同步更新「现行」文档的状态行；设计稿落地后回文内标注状态。
- 新增入口级文档时，在本索引与根 README「文档导航」登记；目录全量清单随下次整理刷新。
