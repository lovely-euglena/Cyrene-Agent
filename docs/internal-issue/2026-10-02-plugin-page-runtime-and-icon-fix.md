# 插件页运行时未启用报错与桌面图标未生效修复

> 日期：2026-10-02 · 范围：`src/plugins/runtime-shell.ts`（新增）、`default-dependencies`、
> `PluginModePanel`（React 插件页）、`uiIcon` 迁移、图标资源
> 关联：`2026-09-26-plugins-section-native-migration.md`、
> `2026-09-26-plugin-market-load-and-search-fix.md`、`4b418212`（贴纸预设）

## 1. 现象与根因

| 现象 | 根因 |
|---|---|
| 插件页报 `Error invoking remote method 'plugins:list': No handler registered`，导入 ZIP 不可用 | `pluginRuntimeEnabled` 默认关（省内存），插件管理 IPC（list/import/…）只在运行时启动后注册；React 插件页直接调用，没有 WPF 管理窗的「未启用」提示条与启用按钮 |
| 启用插件运行时重启后又变回未启用 | WPF 管理窗动态启停只启动/停止，未写回 `pluginRuntimeEnabled`（与 `f7961e07` 提交说明不符） |
| 运行期停用再启用会在市场/面板通道上重复 `handle` 抛错 | `PluginManager.stop()` 只注销管理通道；市场/面板通道由 `startPluginRuntime` 直接注册，未随停用清理；`installPluginPanelProtocol` 重复 `handle` 同 scheme |
| 托盘/窗口图标仍是旧「晴光」而不是新贴纸图 | 旧版本默认图标「晴光」在任意设置保存时被写死进 `app-settings.json`；`4b418212` 只改了默认值，存量配置的 `uiIcon: "cyrene-sun"` 仍然生效 |

## 2. 修复

### 2.1 插件运行时管理壳（`src/plugins/runtime-shell.ts`，新增）

- 常驻 IPC（运行时未启用也可用）：`plugins:get-runtime-state`、
  `plugins:set-runtime-enabled`（`options.persist=false` 仅本次运行）、
  `plugins:get-limits` / `plugins:set-limits`（与 WPF 设置页同口径，0 = 不限）。
- 条件互斥注册：未启用时 `plugins:list` 回退空清单；启用时先移除回退再由
  `PluginManager.start()` 注册正式实现；停用时 `manager.stop()` 后清掉市场/面板
  通道、置空市场服务引用并恢复回退。
- 启用/停用默认写回 `pluginRuntimeEnabled`（记忆开关）；管理窗
  `enable-runtime` / `disable-runtime` 动作改为共用同一实现。

### 2.2 React 插件页（`PluginModePanel`）

- 未启用：列表页顶部琥珀提示条 +「启用插件运行时」（记忆）与「仅本次启用」；
  刷新/导入按钮禁用，市场页显示专属空态（不发市场请求）。
- 新增「设置」视图：运行时状态（运行中·已记住 / 仅本次 / 未启用）与资源限制
  表单（对应 WPF 管理窗「设置」页），三语 i18n 补齐。

### 2.3 桌面图标旧默认迁移

- `GeneralSettings` 新增 `uiIconChosen`：显式写 `uiIcon` 的入口（渲染端
  `SETTINGS_SAVE_GENERAL`、WPF `setSetting`）置位；未显式选择过的旧配置中
  `cyrene-sun` 跟随当前默认（贴纸）。
- `assets/icon-presets/cyrene-sticker.png` 等三份资源替换为
  `Cyrene-Agent-Icon.png` 的 512² 压缩版（105 KB，原 1536²/2.9 MB）；
  `assets/tray-icon.ico` 由新脚本 `scripts/build/tray-icon.mjs` 重新生成
  （16/24/32/48/64/128/256，PNG 条目，57 KB）。

## 3. 不变量

1. 插件管理页在运行时未启用时必须可打开：`plugins:list` 永不 `No handler registered`；
   启用/停用切换不得因通道重复注册抛错。
2. 运行时启停遵循用户选择：默认关；「启用插件运行时」写回设置并在下次启动生效，
   「仅本次启用」不写回；WPF 管理窗与 React 页行为一致。
3. 资源限制校验与钳制只在一处（组合根设置写入前），渲染端不得自行裁剪后直写。
4. `uiIcon` 迁移只作用于「从未显式选择」的旧默认「晴光」；用户显式选择过的
   绮梦/晴光/贴纸一律保留。

## 4. 验证

- 新增 `runtime-shell.test.ts`（8 例）：回退注册/启用（记忆与仅本次）/失败清理/
  停用清理/资源限制钳制/参数校验。
- `PluginModePanel.test.ts` 新增 4 例：未启用提示条与记忆启用、仅本次启用、
  市场专属空态、设置视图读写限额；`ipc-contract` 对 `PLUGINS_LIST` 条件互斥
  注册留白（注册点数固定 2）。
- `settings-facade.test.ts` 新增图标迁移用例；`plugin-panel-protocol.test.ts`
  新增运行期重装先 `unhandle` 用例。
- 验证记录：三处 tsc（main/renderer/preload）0 错；相关面 569 例通过；
  重新打包 `release/win-unpacked` 后产物冒烟。
