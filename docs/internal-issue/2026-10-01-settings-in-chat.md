# 设置进聊天窗：入口统一 + fork 设置项补齐（2026-10-01）

> 触发：上游（Playa-0v0）把设置面板并入工作区 React 界面（`src/renderer/react/features/settings`），
> 删除独立设置窗入口。fork 决策：**跟上游一致——设置入口默认进聊天窗内设置页**；
> WPF（.NET）设置窗与旧 Electron 设置页保留为回退路径（native 起不来 / 聊天窗加载失败）。

## 1. 入口统一（默认全部进聊天窗内设置页）

统一入口实现：`openSettingsEntry(section, { openInChat, openFallback })`（`src/main/windows/settings-router.ts`）
——默认 `windowManager.openSettings(section)`（聊天窗壳 + `settings:switch-section`）；同步/异步失败回退
`openSettingsWindow`（WPF 裁决，channels / 未知 section → Electron）。

改动接线：

| 入口 | 位置 | 现在 |
|---|---|---|
| 托盘「设置」（含分离托盘） | `shell-bootstrap.ts` activate.settings | `windowManager.openSettings` |
| 状态栏 / 任务窗 / 聊天窗内 `sidebar:open-settings` | `window-system-ipc.ts` | 同上 |
| 头像菜单等 `settings:request-switch-section` | `window-system-ipc.ts` | 同上 |
| native 状态栏「设置」「切换模型」 | `default-dependencies.ts`（native 桥动作） | 同上 |
| 聊天窗齿轮 | `AppRouter.tsx`（窗口内） | 直接渲染内嵌设置页（本就在聊天窗） |
| 兜底 | `settings-router.openSettingsWindow` | WPF；channels/未知 → Electron；native 失败 → Electron |

section → React 页落点：`src/renderer/react/app/routing/settingsNavigation.ts`（`SECTION_MAP`）。
fork 旧 section 补映射：`user/about/portable/cache → general`、`runtime → models`、`tasks → 日程面板`、
`music → tools + 音乐弹窗`。

## 2. 能力补齐（React 设置页原先缺的 fork 设置）

不补齐就会出现「入口切走后，旧 WPF 独有设置在应用里找不到」的回归，因此本批一并迁入 React：

| 面板 | 新增 |
|---|---|
| 通用 | 状态栏/日程栏开关；**数据与存储**（便携模式/数据目录（支持相对路径）+ 缓存目录，浏览/应用）；聊天记录（清空全部会话）；Git 提交身份（作者名/邮箱） |
| 外观 | 界面字体（导入/恢复默认 + 当前字体显示）；消息行距（1.2–2.0）；昔涟回复气泡开关 |
| 偏好 | 截图方式（内置/Snipaste）与 Snipaste 路径 |
| 昔涟 | 模型下载镜像（官方/hf-mirror）；模型操作（打开模型目录/安装说明/下载站/刷新状态/删除缓存） |

新增宿主通道：

- `settings:cache-get/pick-dir/set` 暴露到 preload（`getCacheDirStatus/pickCacheDir/setCacheDir`）。
- `settings:cyrene-model-action`（verb：`open-docs/open-dir/open-site/check-model-update/delete-embedding`）：
  与 native `cyreneAction` 共用 `runCyreneModelAction`（default-dependencies），避免两套实现漂移。

## 3. 界面字体应用恢复

上游 2026-09-27 的「固定界面字体为系统默认」删除了渲染端应用逻辑（只留存储 + WPF 按钮），
fork 保留该功能，本批恢复：`src/renderer/ui/theme.ts` 消费 `cyreneFont`（get/onChanged）→
注入 `@font-face`（`local-font://<fileName>`）+ 覆写 `--rb-font-ui`；恢复默认时移除样式与变量。
React 页 CSP `font-src` 放行 `local-font:`（协议处理器白名单文件名，仅映射 userData/ui-fonts/）。

## 4. 不变量（改动前必读）

1. **入口默认进聊天窗**；回退链 `openSettingsEntry → openSettingsWindow → Electron` 不得断（防「点了没反应」）。
2. React 设置页**不认识的新 section** 必须补 `SECTION_MAP`，否则落 `appearance`（静默落错页）。
3. 设置项落盘一律走 `saveGeneral`（general 键）或专用 IPC；新增专用能力要 **preload + shared/ipc-channels + host** 三段同步。
4. native 与渲染端共用的模型操作用 `runCyreneModelAction`；改行为要一起改（native notice 与 IPC 返回同源）。
5. 界面字体依赖 `local-font:` CSP 与 `local-font://` 协议；改 CSP/协议时要三处（vite CSP、preload、main bootstrap）对齐。
6. WPF 设置窗代码保留但**不再是默认入口**；其 section 动作白名单（`NATIVE_SECTION_ACTIONS`）契约测试继续有效。
7. **设置定位必须走 `reactChatSettingsSection` 队列**：`windowManager.openSettings` 等的是 ready-to-show，
   早于 React 挂载 `onSwitchSection` 监听；直接 `send` 冷启动会丢帧（现象=「点设置没反应」）。
   未 ready 挂起、`CHATS_REACT_READY` 冲发；窗口新建/关闭要 `reset`（防旧 section 回放）。
8. 渲染端**禁用浏览器 `alert/confirm`**（`default-dialogs-regression` 扫描）；二次确认用 antd `Modal.confirm`。

## 5. 验证

- 单测：`settings-router`（openSettingsEntry 成功/失败回退）、`shell-bootstrap`（settings 激活进聊天窗 + 回退）、
  `settingsNavigation`（fork section 落点）、`window-manager`（设置定位挂起/直发两态）、i18n 资源三语言一致性；
  `tsc`（main/preload/renderer）0 错。
- E2E：`node scripts/diagnostics/settings-in-chat-smoke.mjs`（需先 `npm run build`）——
  inspector 驱动 `sidebar:open-settings` → 断言聊天窗内设置页 17 个导航项、逐 section 关键文案、
  滚动截图、界面字体 apply/reset、渲染端 0 console error；dev 连跑 3 次冷启动全绿。
  注意脚本先等「core-ready 门」（桌宠窗）= 对齐真实入口的激活代理排队语义；少了这道门
  会绕过 core 阶段直接开窗，渲染端 bootstrap 撞上未注册的 chats IPC（打包版必现假阴性）。
- 打包版：`node scripts/diagnostics/settings-in-chat-smoke.mjs --exe release/win-unpacked/Cyrene.exe` 全绿
  （`release/win-unpacked` 已重打，2026-10-01 18:46）。
- native 侧未改动（WPF 窗保留为回退）。

## 6. 遗留 / 说明

- `chatParaSpacing`（旧 Electron「段落间距」）未迁 React：React 聊天不消费该键（只有 `--cy-chat-line-height` /
  assistantBubble）；WPF 里的滑条保留但不再作为默认入口。
- 「用户信息」仍由聊天窗头像菜单的 `UserProfileDialog` 维护（不单独成 section）；`about` 并入「常规」（版本/更新）。
- WPF 设置窗、旧 Electron 设置页未删除，作为回退与排障入口保留。
