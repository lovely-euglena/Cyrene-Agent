# 「插件」设置页迁移到原生设置窗（工具配置）

> 日期：2026-09-26 · 范围：Electron `plugins` 面板 → WPF「插件」section
> 关联：`2026-09-26-native-settings-migration-final.md`（当时按用户要求未迁，本次补上）

## 0. 旧页内容 → 新实现

| 旧控件 | 新实现 | 说明 |
|---|---|---|
| 天气查询（开关 + 天气源 + 高德 Key） | 工具卡：开关 / 源档位 / Key（源=amap 时显示） | Key 与出行共用 `amapKey` |
| 高德出行（开关 + 高德 Key） | 工具卡：开关 / Key | |
| 联网搜索（开关 + 引擎档位 + 各引擎 Key） | 工具卡：开关 / 引擎档位 / 对应 Key 单行 | 切换引擎重推快照后重建 |
| 邮件发送（开关 + SMTP 全字段） | 工具卡：开关 / 主机 / 端口 / SSL / 发件邮箱 / 授权码 / 发件人 | 端口非法回读原值 |
| 本地文件（权限四档胶囊 + 说明） | 工具卡：四档档位组 + 档位说明 | `full` 需 5 秒延迟确认 |
| Playwright 开关 | 工具卡：开关 | 宿主同步 Playwright MCP |
| 添加插件（命令 + 名称两步输入） | 「添加 MCP Server」按钮 → 单弹窗（命令 + 名称） | 复用 `mcp-manager.addMcpServer` |
| —（旧页无）| 「管理已安装插件」按钮 → .NET 插件管理窗 | 已装/市场/限额在管理窗 |
| 第三方插件设置面板（iframe） | 保持 Electron 承载（管理窗 openPanel） | WPF 无法宿主插件 iframe |
| 音乐工具卡 | 不迁（旧页 HTML 无 TS 接线，属插件面板/音乐组件） | |

## 1. 数据 / 动作

- **快照**：`state.settings.plugins`（`buildPluginsSectionSnapshot`）= 内置工具字段
  （weather*/amapKey/travelEnabled/playwrightMcpEnabled/search*/email*）+ `permissionLevel`。
- **动作**：`NATIVE_SECTION_ACTIONS.plugins = ["save", "set-permission-level", "add-mcp-server"]`
  （契约测试扫描 C# 锁定）。
- **保存不走 `settings.set`**：必须走 plugins `save`，复用 `TTS_SAVE_SETTINGS` 的副作用
  （`syncVolcanoSearchMcp` / `syncPlaywrightMcp`），且经 `sanitizeNativePluginsSave` 白名单。
- `parseCommandLine` 迁至 `src/shared/parse-command-line.ts`（渲染端 `shared/parse.ts` re-export
  保持旧路径兼容），主进程 `add-mcp-server` 解析命令用。
- `permission.ts` 新增 `applyLevel()`（IPC 与 native 动作共用同一校验/持久化）。

## 2. 行为口径（不变量）

1. 内置工具字段保存必须走 `plugins save`（触发 MCP 同步副作用）；不得走 `settings.set`。
2. 权限档位 `full` 必须延迟 5 秒确认；切换失败由快照回读刷新 UI（`RefreshSection`）。
3. 搜索开关语义：关闭 = `searchEngine: "off"`（修正旧页勾选框因无 off 选项而无法真正关闭的问题）。
4. 第三方插件 iframe 面板与音乐组件保持 Electron 承载；已装插件/市场/限额仍在 .NET 插件管理窗。
5. `plugins` section 已是 native：`AddSection(native:true)` 与 `IsNativeSection` 门禁必须
   同步（契约测试会拦漂移）。

## 3. 验证

- 契约测试：plugins 动作锁定、`sanitizeNativePluginsSave` 白名单（枚举回落/密钥裁剪/端口范围）、
  快照投影（非法枚举回落、空档位回落 read-only）。
- 离屏渲染（临时钩子，验后已移除）：天气（高德+Key）/出行/搜索（博查+Key）/邮件（全字段）/
  本地文件四档/Playwright/操作入口全部正确。
- 帧序列化：`plugins save {weatherEnabled:true}`、`plugins set-permission-level {level}`
  带 `requestId`（回执通道）。
- `dotnet build -c Release` / `tsc` 0 错；全量 **4040 通过 / 1 失败**（Git Bash 基线用例）；
  `release\win-unpacked` 重打包 + 产物冒烟。

## 4. 遗留（有意）

- 音乐工具卡：旧页 HTML 无 TS 接线，仍由插件面板/音乐组件承载。
- 第三方插件 iframe 设置面板：Electron 承载（管理窗 `openPanel`）。
- 已装插件列表/插件市场/存储与内存限额：.NET 插件管理窗（原有能力）。
