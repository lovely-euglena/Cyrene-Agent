# 原生设置二批：向量模型 / 时间控件 / 插件市场安装 / 插件卡折叠 / 桌宠进程回收

> 日期：2026-09-27 · 承接 `2026-09-27-settings-polish-batch.md`（同日第一批 UI 修复）
> 范围：设置窗「昔涟设置·RAG」/ 定时任务编辑器 / 插件管理窗 / 插件工具卡 / 桌宠窗口生命周期

## 0. 问题 → 处理

| # | 用户反馈 | 处理 |
|---|---|---|
| 1 | 向量模型安装说明做得不好；安装后需要刷新按钮；下载镜像源设置无法持久化 | ① 镜像源根因：宿主设置快照里**没有 `ragDownloadMirror`**，WPF 每次都按 `official` 回落 → 看着像「改了不保存」。快照补上该字段；② 「安装说明」改为**应用内弹窗**（下载源 / 所需文件 / 目标目录 / 完成后刷新 + 打开模型目录/下载站/刷新状态按钮）；③ 新增 **「🔄 刷新状态」**（重体检并如实报告缺少哪些文件）；④ 新增 `open-model-dir` / `open-model-site` 动作与 `docs/local-models.md` |
| 2 | 新建定时任务时间输入框太小；所有日期选择框太小太难看 | ① 新增 `TimePicker`（小时/分钟下拉，HH:mm 恒合法）替换 70px 小文本框；② `NativeTheme` 新增 **DatePicker 主题模板**（34 高、圆角 10、白底软描边、右侧日历图标、粉色焦点）；③ Calendar 统一主题（DayButton 32×30、圆角 7、hover 浅灰、选中粉底白字、今天粉描边、邻月淡显）；④ 用户信息「生日」取景器同款日历 |
| 3 | 插件市场点击安装插件静默失败 | **根因**：`PluginManagerWindow` 用 `SendCommand("plugins","install", id)`，id 落在帧的 `section` 字段，而宿主桥接只读 `frame.id` → 安装/启用/停用/卸载/打开窗口**全部静默 no-op**。修复：新增 `RequestRouter.SendPluginCommand`（id 正确进 `id` 字段）+ 宿主桥接兼容回退 `id ?? section`；并补即时反馈：安装开始推 `installing` 快照（按钮「安装中…」+ 底部状态），失败在市场上方显示**红色错误横幅** |
| 4 | 插件页面各个插件自己的设置无法折叠 | 设置窗「插件」工具卡配置区加 **▾/▸ 折叠按钮**（天气/高德/搜索/邮件/本地文件），折叠状态窗口生命周期内记忆（快照重建不丢） |
| 5 | 隐藏桌宠时要把桌宠的相关进程杀了 | 桌宠「隐藏」从 `hide()` 改为 **`destroy()`**（连同 Live2D 渲染进程一起结束）；显示（设置开关/托盘）按需**懒重建**并恢复置顶/缩放；启动时 `petVisible=false` 不建窗（省一个 0.5GB 级渲染进程） |

## 1. 向量模型 / RAG（问题 1）

- **镜像源持久化**（`core-bootstrap.ts` getSettingsSnapshot）：补 `ragDownloadMirror`。
  写入路径原本就通（`native-settings-protocol` 白名单 + `saveGeneralSettings`），
  只有读取方向缺字段 → UI 永远回落官方源。
- **安装说明弹窗**（`SettingsWindow.Cyrene.cs` → `ModelDocsDialog`）：
  1) 选择下载源（读取当前 `ragDownloadMirror`，提示 hf-mirror）；2) 需要的三个文件
  （`tokenizer.json` / `config.json` / `onnx/model_quantized.onnx`，强调相对路径）；3) 目标目录
  `<modelsDir>\Xenova\bge-m3\`（reranker：`bge-reranker-base\`）；4) 回来点「刷新状态」。
  按钮：📂 打开模型目录（`open-model-dir`，宿主建目录并 `shell.openPath`）、🌐 打开下载站
  （`open-model-site`，按镜像源打开 hf-mirror/官方模型页）、🔄 刷新状态、关闭。
- **刷新状态**（`check-model-update` 语义升级）：重体检后如实报告
  「BGE-M3 已安装」或「未安装（缺少 tokenizer.json、…）」。
- **快照**：`NativeCyreneSnapshot.modelsDir`（首选模型目录，弹窗展示）。

## 2. 时间 / 日期控件（问题 2）

- **`TimePicker`（新文件）**：小时 00-23 / 分钟 00-59 两个下拉 + 冒号，`Value` 恒合法
  （非法输入回落 08:00）。任务编辑器「时间」「一次性时间」全部换用；保存校验不再需要
  正则（旧 TimePattern 删除）。「间隔」数字框保持原样（非时间）。
- **`NativeTheme` 日期样式**（代码生成 XAML，注入窗口隐式样式）：
  - DatePicker：34 高、圆角 10、边框 `#D2D2D7`、聚焦粉描边、右侧日历图标（`Glyphs.CalendarSmall`
    几何）、弹层圆角 + 阴影；
  - Calendar / CalendarItem / CalendarDayButton / CalendarButton：字号 13.5、日格 32×30、
    圆角 7、hover `#F3F4F6`、选中 `#FF5B8A` 白字、今天粉描边、邻月 opacity 0.38；
  - **Calendar 的三个子样式通过 `Calendar.CalendarDayButtonStyle/CalendarButtonStyle/CalendarItemStyle`
    显式挂载**（Calendar 内部元素不吃窗口隐式样式；DatePicker 弹层通过 `CalendarStyle` 继承）。
  - 注意：`CalendarButton` **没有 `IsSelected` 属性**，用 `HasSelectedDays`（曾因此在运行时
    XamlReader 抛「Trigger 属性为 null」）。
- 任务编辑器 `_onceDate.CalendarStyle`、用户信息生日 `Calendar.Style` 都指向统一主题。

## 3. 插件市场安装（问题 3）

### 根因

`PluginManagerWindow` 的所有单插件动作走 `RequestRouter.SendCommand(kind, action, id)`，
而该方法的第三个参数是 **`section`**；宿主 `native-windows-bridge` 的插件分支只读
`frame.id` → `pluginAction(action, undefined)` → `if (action === "install" && id)` 不成立
→ 悄无声息地什么都不做（按钮点完弹回「安装」，无任何提示）。

### 修复

1. `RequestRouter.SendPluginCommand(action, id)`：帧里显式携带 `id`；管理窗 6 处调用点全换。
2. 宿主桥接兼容：`targetId = frame.id（非空）?? frame.section`（旧 exe 也能工作）。
3. **即时反馈**（`default-dependencies.ts`）：
   - 开始安装：`nativeInstallingIds = [id]` + 推快照（`installing` 字段）→ 按钮「安装中…」+
     底部「正在安装：…」；
   - 完成/失败：清空 + `notice` 推送；失败在**市场列表顶部显示红框横幅**（底部小字容易被忽略）。
   - `buildPluginSnapshot()` 新增 `installing` 字段。
4. WPF 市场卡按 `_installing` 渲染「安装中…」并禁用。

## 4. 插件工具卡折叠（问题 4）

- `MakeToolCard(..., collapseKey)`：有 key 的卡片头部加 ▾/▸ 按钮，切换 `bodyPanel.Visibility`；
  折叠集合 `_collapsedToolCards` 存在 `SettingsWindow` 实例上（key：weather/travel/search/email/file）。
- TTS/ASR 的 `MakeToolCard` 调用不传 key → 保持原样（不折叠）。
- 折叠状态在快照重建后按 key 恢复。

## 5. 桌宠进程回收（问题 5）

- `window-manager.ts`：
  - `hidePetWindow()` → `destroy()`（结束桌宠渲染进程；closed 回调清 `petWindow` + live2d 生命周期）；
  - `showPetWindow()` → 无窗口时 `ensurePetWindow(true)` 懒重建（`ready-to-show` 才显示，不闪空窗）；
  - `togglePetWindow()` → 可见销毁 / 不可见重建；
  - `ensurePetWindow()` 重建后恢复 `petAlwaysOnTop`（settings slice 新增该字段）并在 ready 后补发
    `PET_ZOOM`（窗口创建尺寸仍按 `petZoom`）。
- `core-bootstrap.ts`：ready/closed 生命周期接线提前到设置应用之前；`petVisible=false` 启动**不建窗**。
- 取舍：隐藏期间 `sendToPetWindow`（贴图/动作）与 `capturePetWindow` 变成 no-op —— 隐藏时本就不可见/不动作。

## 6. 不变量（后续改动必须保持）

1. `NativeTheme` 新增任何「容器型控件子元素样式」（Calendar 日格这类）必须显式挂到宿主控件的
   `xxxStyle` 属性，不能只靠窗口隐式资源。
2. 原生窗 → 宿主的单实体命令必须把实体 id 放进帧的 `id` 字段（`SendPluginCommand`），
   `section` 只用于导航定位。
3. 桌宠隐藏 = 销毁；任何「显示桌宠」入口都必须走 `showPetWindow()`（懒重建），
   不得直接 `createPetWindow` 后假设可见。
4. 设置快照新增字段时，必须同时确认 WPF 读方向（`GetX(...)`）与写入白名单
   （`native-settings-protocol`）都在同一份契约里 —— `ragDownloadMirror` 就是只写没读的教训。
5. 时间/日期类输入用 `TimePicker` / 主题 `DatePicker`，不要回退到小文本框。

## 7. 验证

- 单测：`window-manager.test.ts`（隐藏销毁/懒重建/置顶缩放恢复）、桥接 `section` 回退、
  `core-bootstrap`（隐藏不建窗）、`native-settings-sections`（modelsDir）、协议动作集合
  （open-model-dir/open-model-site）。
- 离屏渲染（临时钩子，已移除）：任务编辑器（DatePicker + TimePicker）、DatePicker 弹层日历、
  独立 Calendar、模型安装说明弹窗、设置窗插件段（折叠按钮）全部正常，无 XamlParse 异常。
- `dotnet build -c Release` / `tsc -p tsconfig.main.json` 0 错；全量测试与打包冒烟见提交记录。
