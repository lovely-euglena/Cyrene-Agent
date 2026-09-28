# 原生窗口图标修复：设置导航"昔涟"缺图标 + 各 .NET 窗缺应用图标

> 日期：2026-09-26 · 范围：`dotnet/native-windows` + 导航图标生成器
> 产物生成：`node scripts/gen-settings-nav-icons.mjs`（`SettingsNavIcons.cs` 勿手改）

## 1. 现象与根因

| 现象 | 根因 |
|---|---|
| 设置页导航"昔涟设置"看不见图标 | 该导航用白色线稿头像（`cyrene-avatar-line-white.png`，纯白 255,255,255 + alpha）。旧 Electron 页在 pearl-white 主题会换成深色线稿 `cyrene-avatar-line.svg`；WPF 直接贴白图 → 浅色导航底上不可见 |
| 其它 .NET 窗口任务栏 / Alt+Tab 无图标 | 只有设置窗设了 `Window.Icon`；其余 WPF 窗与 WinForms 定时任务窗未设，回落到 `cyrene-native.exe` 自身（辅助 exe 无应用图标） |
| （附带）开发布局下图标永远解析失败 | `TrayHost.ResolveElectronExe` 的"开发布局"分支与 packaged 分支算的是同一个路径（复制粘贴漏改），dev 下拿不到 `Cyrene.exe` |

## 2. 修复

- **生成器** `scripts/gen-settings-nav-icons.mjs`：图片图标新增 `Tint` 标记；
  白稿（`-white.png`）在 WPF 以 `Rectangle + OpacityMask(ImageBrush)` 用导航
  前景色着色渲染——选中/悬停自动跟随高亮色，不需要第二份深色资源。
- **`AppIcons`**（`dotnet/native-windows/AppIcons.cs`）：从同级 `Cyrene.exe`
  提取关联图标，进程内缓存（WPF `ImageSource` / WinForms `Icon` 各一份）；
  失败返回 null，不影响窗口显示。
- **全部原生窗接入**：Settings / PluginManager / Sidebar / Splash / TaskEditor /
  StickerAddDialog / CustomStyleDialog（WPF）与 TasksWindow（WinForms）。
- **`TrayHost.ResolveElectronExe`**：dev 布局改为向上查找仓库根的
  `release/win-unpacked/Cyrene.exe`；打包布局（`resources/native-windows` →
  `../../Cyrene.exe`）不变。

## 3. 不变量

1. 导航图标产物由脚本生成；新增/改动 section 后必须重跑生成器。白稿类图片
   图标必须 `Tint`（直接贴白图在浅色底不可见——历史 bug）。
2. 新增原生窗口必须设置 `Icon = AppIcons.Image`（WinForms 用 `AppIcons.FormIcon`），
   这是任务栏 / Alt+Tab 图标来源。
3. `AppIcons` 解析失败必须静默（null），不得阻断窗口创建。

## 4. 验证

- 契约测试 `src/main/windows/settings-nav-icons.test.ts`：`AddSection` 集合 ⊆
  图标定义；图片图标资源必须存在；白稿必须 `Tint`。
- 离屏渲染（临时钩子，验后已移除）："昔涟设置"图标可见且随选中态着色；
  `windowIcon=set`（dev 布局经向上查找解析到 `release/win-unpacked/Cyrene.exe`）。
- `dotnet build -c Release` 0 错；全量 4030 通过 / 1 失败（Git Bash 环境用例，
  基线一致）。
