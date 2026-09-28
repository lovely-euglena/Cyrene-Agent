# 原生设置三批：折叠按钮 / 模型目录入口 / 高级设置卡片 / 便携模式迁移

> 日期：2026-09-27 · 承接 `2026-09-27-native-polish-batch-2.md`
> 范围：设置窗「插件」工具卡、「昔涟设置·RAG」、「高级设置」、便携模式（前后端）

## 0. 问题 → 处理

| # | 反馈 | 处理 |
|---|---|---|
| 1 | 工具未启用时折叠按钮应隐藏；按钮偏小 | 折叠按钮改为**仅在工具启用时显示**（collapseKey 传 null 隐藏）；尺寸 28→36px、字号 13→16 |
| 2 | 模型页面要能打开模型文件夹 | 「模型操作」行新增 **📂 打开模型目录**（复用已有 `cyrene open-model-dir`；弹窗内入口保留） |
| 3 | 高级设置没有卡片风格 | `BuildRuntimeSection` 改为 `MakePanelHeading` + BlockMark 分组（请求与等待 / 工具执行）+ `CardifySubBlocks` |
| 4 | 便携模式应支持相对路径；且未迁移到 .NET 设置窗 | ① 后端支持相对路径（按程序目录解析、相对输入原样存指针文件）；② 通用 section「数据与存储」卡原生启停/目录/应用，迁移/覆盖确认与目录选择全在 WPF；不再跳旧版 Electron 页 |

## 1. 折叠按钮与模型目录入口

- `SettingsWindow.Plugins.cs`：`MakeToolCard` 的 collapseKey 由调用点按启用态传入
  （`GetBool(plugins, "...Enabled") ? "weather" : null`），禁用卡不再出现无意义的折叠钮；
  折叠钮 36×36 / 16px（原 28×28 / 13px）。
- `SettingsWindow.Cyrene.cs`：模型操作行 = 安装说明 / 刷新状态 / **打开模型目录** / 删除缓存；
  行容器加 10px 右边距，避免最后一个按钮被滚动条裁切（便携行同样处理）。

## 2. 高级设置卡片化

- 图标 `Glyphs.Gear` + 标题/副标题（对齐其它 section 的 `MakePanelHeading`）。
- 卡片 1「请求与等待」：模型请求超时（秒，可空=默认 60）、询问等待时间（秒）。
- 卡片 2「工具执行」：工具并发数（1–8） + 保存设置按钮。

## 3. 便携模式

### 3.1 相对路径（后端，`src/main/portable/`）

- `applyPortableDataLocation`：
  - 输入**相对路径按程序目录解析**（`path.resolve(status.installRoot, input)`）——
    旧实现 `path.resolve(input)` 会按进程 cwd 解析（打包版 cwd 不确定）；
  - 拒绝把数据目录设为程序目录本身（相对 `.` 也会被兜住）；
  - 存储值：默认便携目录固定 `"data"`；**用户输入相对路径时原样存相对值**（程序整体搬移后仍有效）；
    绝对输入存绝对路径。
- `readPortableConfig` 返回值新增 `storedValue`（指针文件原始值），
  `PortableDataLocationStatus` 新增 `displayDir`：设置页回显相对值（"data"）而不是解析后的绝对路径；
  Electron 设置页同步用 `displayDir ?? dataDir ?? suggestedDir` 回显。

### 3.2 .NET 设置窗原生编辑

- 快照：`getSettingsSnapshot` 新增顶层 `portable` 节点（`CoreDependencies.getPortableStatus?` 注入，
  默认依赖实现 = `getPortableDataLocationStatus()`）。
- 动作：新增 section 白名单 `portable: ["apply"]`；宿主桥接新增 `case "portable"`；
  `default-dependencies` 的 `portableAction` 调 `applyPortableChange`（从 portable-ipc 抽出，
  Electron IPC 与 native 动作共用），结果走通用 section 状态行，成功路径 800ms 后重启应用。
- `PortableApplyRequest` 扩展 `migrationChoice` / `overwrite`：
  **WPF 已完成的确认随请求下发，宿主不再重复弹 Electron 框**；旧 Electron 页不带这些字段时行为不变。
- WPF「数据与存储」卡：便携模式开关、数据目录输入（相对路径提示）+ 浏览…
  （`Microsoft.Win32.OpenFolderDialog`，.NET 8+ 原生文件夹选择器）、当前生效目录提示、应用并重启；
  迁移/覆盖用 `PortableConfirmDialog`（标题栏 + 说明 + 可配置按钮组，同步 ShowDialog 返回按钮下标）。
- WPF 本地校验：installRoot 缺失/路径非法/目标=程序目录本身直接提示；目标目录非空且选择迁移时弹覆盖确认。

## 4. 契约与不变量

1. `NATIVE_SECTION_ACTIONS.portable = ["apply"]`（契约测试锁定 kind/verb 与 C# `SendSettingsAction` 同步）。
2. 便携模式相对路径的基准是**程序目录**（指针文件所在目录），不是进程 cwd；
   相对输入必须原样存相对值（否则「随程序搬移」失效）。
3. 原生设置窗需要用户决策的流程（迁移/覆盖）一律用 WPF 弹窗收集，再随动作 payload 下发；
   宿主侧确认框只作为 Electron 旧页/缺字段时的兜底。
4. 工具卡折叠钮只在配置区存在（工具已启用）时出现；禁用态隐藏，避免空折叠。
5. WPF 动作行贴右时留 ≥10px 余量（滚动条会吃掉最右按钮的边缘）。

## 5. 验证

- 单测：`portable-*` 31 例（新增：相对解析/相对存储/安装根拒绝/native 预选跳过确认）；
  桥接 `portable` 动作透传；协议动作集合；core-bootstrap 快照。
- 离屏渲染（临时钩子，已移除）：通用页便携块（相对值 "data" 回显、开关、应用按钮）、
  高级设置两张卡片、插件页（禁用卡无折叠钮 / 启用卡 36px 折叠钮）、昔涟设置底部
  （安装说明/刷新状态/打开模型目录）、便携确认弹窗（三按钮）。
- `dotnet build -c Release` / `tsc -p tsconfig.main.json` 0 错；全量测试与打包冒烟见提交记录。
