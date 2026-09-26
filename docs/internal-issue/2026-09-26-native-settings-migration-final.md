# 原生设置页迁移收尾（一次性补完）

> 日期：2026-09-26 · 范围：除 TTS / ASR / 插件 / 渠道（按用户要求保持 Electron）外的
> 全部 section 逐项对齐旧版渲染页
> 关联：`2026-09-26-cyrene-rag-native-section.md`、`2026-09-26-native-window-icons-fix.md`

## 0. 本次补完的缺口（旧页为事实源）

| section | 缺口 | 处理 |
|---|---|---|
| 通用 | 清空聊天记录（缺失） | 新动作 `general: clear-chat-history`（宿主 chats-store 串行删除）+ WPF 确认框 |
| 通用 | 语言档位组（缺失） | 只读档位组：中文选中 / EN·日文·韩语禁用占位 |
| 通用 | section 无状态行 | 注册 `MakeSectionStatus("general")`，宿主 notice 可就地显示 |
| 通用 | GPU Internals 行内链接（缺失） | 新动作 `general: open-gpu-internals`（复用 Electron `chrome://gpu` 窗口） |
| 外观 | 「布局」卡（缺失） | 多窗口（选中）/ 单窗口（SOON）静态卡 |
| 外观 | 「聊天背景」SOON 占位（缺失） | 禁用占位行 |
| 外观 | 字体「恢复默认」未按状态隐藏 | 仅 `uiFont.kind=custom` 显示 |
| 外观 | 旧版入口按钮 | 移除（布局/设置全部原生；runtime/tokens 同） |
| 高级设置 | 两个超时输入缺「↻ 重置为默认」 | 补小按钮（默认 60s） |
| 偏好设置 | CITA「语义认知方式」显隐相反 | 改为常显，仅「本地语义模型」禁用占位 |
| 偏好设置 | 自定义风格采样切 driver 数值框为空 | 数值框恒带值（默认 0.65），保存不再被空值拦截 |
| 记忆 | L0/L1 缺「只读 → 编辑/取消」两态 | 默认禁用；编辑解锁；保存等回执；取消回滚快照 |
| 记忆 | 空态/占位文案缺失 | L2/导入/回顾两行空态；L0/L1 输入「未设置」占位 |
| 记忆 | 读取失败只显示一条总行 | 按块显示「片段/导入知识/回顾读取失败」 |
| 记忆 | Obsidian 无进行中态与内联提示 | 按钮禁用 +「绑定中…/同步中…」；卡片内 hint（含文件数/时间，跨重建保留） |
| 定时任务 | 编辑器保存失败仍关窗、丢输入 | 保存等回执：成功才关窗；失败保持打开并显示错误（保存中禁用按钮） |
| 定时任务 | 运行历史被截断 160 字 | 完整显示（与旧页一致） |
| Token | 缓存统计口径缺失 | 「模型未提供缓存统计/暂无数据」、部分覆盖标注、命中率「已统计 N / M 次请求」 |
| Token | 请求数覆盖率 | 显示 `N / M`（有 usage 回执 / 总请求） |
| Token | tooltip / 空态 / 日均 | tooltip 补缓存命中/未命中/创建/请求与周几；无数据空态；柱图上方「日均 X」 |
| Token | 单模型环形图不可见（真 bug） | 100% 扇区 sweep=360° 的 ArcSegment 起点==终点退化成空路径 → 改画整圆 |
| 免责声明 | 贡献者链接丢 from 参数 | 补 `?from=2026%2F5%2F30` |
| 偏好设置 | 主动消息渠道可用性不实时刷新 | `broadcastChannelsStatus()` 同步重推 native 设置快照 |

## 1. 协议新增：section 动作结果回执

「成功才收尾」的交互（任务编辑器保存、记忆保存/Obsidian 动作）需要结果，原先动作帧是单向的。

- **native → 宿主**：`cmd` 帧新增可选 `requestId`（`RequestRouter.SendSettingsAction` 的
  `onResult` 重载自动带上；15s 无响应按失败回调，避免卡窗）。
- **宿主 → native**：`state.settings-action-result`
  `{requestId, kind, action, ok, error?, data?}`（`NativeWindowsClient.pushSettingsActionResult`）。
- **宿主分发**：`native-windows-bridge` 的 `completeAction` 统一把 section 动作返回值
  （同步或 Promise，`{ok,error?,data?}`）回执；未带 `requestId` 的动作保持旧单向语义。
- **数据**：vault-bind/export/sync 回执带 `fileCount`（内联提示用）；取消返回 `canceled`。

## 2. 不变量（后续改动必须保持）

1. 需要「成功才收尾」的交互必须走回执，不得乐观关闭（任务编辑器即此模式）。
2. **失败不得重推快照覆盖用户输入**：`memory save-l0/l1` 仅成功时推快照；失败时 WPF
   保持编辑态并就地报错。
3. Token 缓存统计口径：`cacheUsageRequests<=0 → 暂无数据 / 模型未提供缓存统计`；
   `cacheUsageRequests < requests →（部分）`；命中率格式「N.N%（已统计 X / M 次请求）」。
4. 单模型 100% 的环形图必须用整圆几何（ArcSegment 360° 会退化成空路径）。
5. `general: clear-chat-history / open-gpu-internals` 为 native 动作白名单一部分
   （契约测试扫描 C# 锁定）。
6. legacy 入口只保留在 Electron-only section（tts/asr/plugins/channels）。

## 3. 验证

- 契约/快照测试：`general` 动作锁定、Token 快照新字段（weekday/cacheCreation/
  attemptedRequests/cacheUsageRequests + totals）、导航图标契约；修复用户资料契约测试
  扫描源（`SettingsWindow.User.cs`，并行提交里写入调用已迁出主文件）。
- `dotnet build -c Release` / `tsc` 0 错；全量 **4038 通过 / 1 失败**（Git Bash 环境用例，
  基线一致）。
- 离屏渲染（临时钩子，验后已移除）：通用 / 外观 / Token / 记忆 / 高级设置 / 偏好六段
  布局与新增控件正确；Token 环形图（单模型）修复后可见；回执帧
  `{"action":"memory","verb":"save-l0","requestId":1}` 序列化正确。
- `release\win-unpacked` 重打包 + 产物冒烟（记录于提交信息）。

## 4. 仍未迁（有意保留）

- TTS / ASR / 插件 / 渠道：用户指定保持 Electron。
- 与设置页无关的在途项：应用内模型下载（RAG）、worker 子进程化、会话持久化等。
