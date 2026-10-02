# Pandoc 文档转换接入规划

> 2026-10-02 · 状态：已实施（P1，转换实现位于 .NET 文档组件）· 关联：`cyrene-embed` / `file-ingest` / `document-index-worker` / 设置页
>
> 实施口径修订（用户指令「新模块尽量用 .NET」）：转换/探测/清洗的唯一实现放在
> `dotnet/embedding-sidecar/PandocConverter.cs`（文档导入默认链路 sidecar 内）；
> TS 侧只保留扩展名路由、设置传参与 UI 胶水，不再新增转换模块。

## 1. 现状（已核对）

文档处理有两条链路，判定与读取口径不一致，接入时要同时改：

| 链路 | 入口 | 行为 |
| --- | --- | --- |
| 拖入判定 | `src/main/rag/file-ingest.ts` `describePendingAttachment()` | 图片 → image；文本扩展名/无扩展名 → document；其余 → unsupported（带原因） |
| 小文本 | `file-ingest.ts` `ingestOneFile()` | 文本 ≤ 30K 字符直接内联（`kind:"text"`），超限走 RAG 索引 |
| 大文本/索引 | `src/main/rag/document-index-worker.ts` `prepareFile()` | **独立 worker 线程**里读文件、切块、embedding；`ingestOneFile` 是另一条批量/目录链路 |
| 显式拒绝 | 两条链路的 `UNSUPPORTED_EXTS` | 含 `.pdf/.doc/.docx/.xls/.xlsx/.ppt/.pptx`、压缩包、媒体、二进制 |

- 目前没有任何 pandoc 引用；本机未安装 pandoc（`winget` 可用，便于后续实测）。
- worker 由 `new Worker(__filename)` 启动，主线程设置无法直接读取，需要随任务消息注入。

## 2. 能力矩阵：pandoc 能读什么

以 `pandoc --list-input-formats` 运行时探测为准（不同版本能力不同），扩展名 → reader 映射建议：

| 类别 | 扩展名 | reader | 结论 |
| --- | --- | --- | --- |
| Word 现代格式 | `.docx` | docx | ✅ P1 |
| OpenDocument | `.odt` | odt | ✅ P1 |
| 富文本 | `.rtf` | rtf（pandoc 3.1+） | ✅ P1（低版本自动回退提示） |
| 电子书 | `.epub` `.fb2` | epub / fb2 | ✅ P1 |
| Jupyter | `.ipynb` | ipynb | ✅ P1 |
| 排版/标记 | `.tex` `.latex` `.rst` `.org` `.opml` `.dbk` `.docbook` `.textile` `.t2t` `.asciidoc` `.adoc` `.typ` `.djot` `.muse` `.mdoc` `.icml` `.jats` `.wiki` `.creole` | latex / rst / org / opml / docbook / textile / t2t / asciidoc / typst / djot / muse / mdoc / icml / jats / mediawiki / creole | ✅ P1（按探测结果逐个放行） |
| 已是文本路径 | `.md` `.html` `.csv` `.tsv` `.bib` `.json` `.xml` … | — | 保持现状，pandoc 不接管 |
| PDF | `.pdf` | ❌ 无 reader | P2：pdftotext(poppler) / pdfjs-dist；扫描件走 OCR |
| 旧 Office | `.doc` `.xls` `.ppt` | ❌ 无 reader | P2：检测 LibreOffice headless（可选） |
| 表格 | `.xlsx` `.xls` | ❌ | P2：项目已有 `exceljs`，可自研表格→Markdown |
| 演示 | `.pptx` | ❌ | P2：JS 解析或 LibreOffice |
| 压缩包/媒体/可执行 | `.zip` `.7z` `.mp3` `.mp4` `.exe` … | ❌ | 保持不支持 |

结论：**pandoc 覆盖的是「Office 现代文档 + 标记/排版/电子书」，不是 PDF 与旧二进制 Office**。规划上把 P1 范围明确为 pandoc 能读的格式，其余进 P2 另找引擎，避免「装了 pandoc 却打不开 PDF」的预期落差。

## 3. 架构设计

### 3.1 核心模块 `dotnet/embedding-sidecar/PandocConverter.cs`（.NET，唯一转换实现）

```csharp
InputExts: Dictionary<string,string>        // ext → pandoc reader 名（与 TS PANDOC_EXTS 同源）
IsPandocExt(ext) / GetReader(ext)
ResolveExecutable(customPath)               // 文件直接用；目录拼 pandoc(.exe)；空查 PATH
Probe(exe): ProbeResult?                    // --version + --list-input-formats，按 exe+mtime 缓存
ConvertFile(filePath, pandocPath, isCancelled, timeoutMs)
  → { Ok, Text(清洗后 markdown), Reason(可展示中文), Code }
CleanMarkdown(text): (Text, Truncated)
```

CLI 入口（`cyrene-embed`）：

- `verify-pandoc [pandocPath]`：纯函数 + 真实转换自检（无 pandoc 时 SKIP，退出码 0）；
- `pandoc-probe [pandocPath]`：设置页检测，stdout 输出 JSON（ok/exe/version/formats 或 error）。

转换调用约定：

- `ProcessStartInfo`（UseShellExecute=false，不经 shell），argv 里不出现用户文件路径，内容走 stdin；
- args：`--from=<reader> --to=markdown --wrap=none --extract-media=<临时目录>`；
- 优先 `--sandbox`（pandoc ≥ 2.15 限制 reader IO），遇到 "Unrecognized option" 自动去掉重试一次；
- 超时 60s、stdout 上限 8MB、取消回调 → `Kill(entireProcessTree: true)`；
- 临时目录 `%TEMP%/cyrene-pandoc-<guid>`，`finally` 删除（媒体文件不落地保留）。

TS 侧胶水（非转换实现）：

- `file-ingest.ts`：`PANDOC_EXTS` 路由表（与 C# 同源注释）+ `isPandocExt`；
- `document-import-sidecar.ts`：从 general settings 读 `pandocPath`，随 doc-import 帧下发；
- `settings-ipc.ts`：`SETTINGS_PANDOC_DETECT` → spawn sidecar `pandoc-probe`。

### 3.2 格式清洗（需要，规则固定）

pandoc 输出是给人看的 Markdown，直接喂模型会有噪音，统一清洗：

1. 删除图片引用与 data URI：`![alt](...)` → `[图片] alt`（或整行删除），`--extract-media` 产出的文件不保留；
2. 删除空链接/引用锚点、pandoc 属性块 `{.class #id}`；
3. 原始 HTML：保留可见文本、去标签（pandoc 已做大部分，兜底一次）；
4. 折叠 3+ 连续空行为 2，去控制字符；
5. 保留标题/列表/表格/脚注（Markdown 结构对 LLM 可读）；
6. 输出上限 4M 字符，超出截断并附「已截断」说明；清洗后为空 → `kind:"empty"`。

### 3.3 集成点（两链路同改）

| 位置 | 改动 |
| --- | --- |
| `describePendingAttachment` | pandoc 扩展名 → `kind:"document"`；其余维持 unsupported |
| `file-ingest.ts` | `UNSUPPORTED_EXTS` 移除 `.docx`；新增 `PANDOC_EXTS` 路由表；`ingestOneFile` 的 pandoc 分支明确指向 .NET 文档组件（该工具函数非生产链路） |
| `document-import-sidecar.ts`（默认链路） | doc-import 帧携带 `pandocPath`（设置读取）；转换在 sidecar `DocImporter` 内完成 |
| `dotnet/embedding-sidecar/DocImporter.cs` | pandoc ext → `PandocConverter.ConvertFile` → 清洗文本走既有 text/indexed 流程；`UnsupportedExts` 移除 `.docx` |
| `document-index-worker.ts`（无组件回退链路） | pandoc ext → unsupported 并提示需要 .NET 文档组件（该链路无转换能力） |
| `default-dependencies.ts` | 无结构变化；sidecar 可用时天然走转换链路 |

### 3.4 设置

- `GeneralSettings` 新增 `pandocPath: string`（默认 `""` = 自动探测 PATH），与 `snipastePath` 同模式。
- 设置页（Electron React「偏好设置」）新增「文档转换」分组：路径输入 + 检测状态
  （已检测到 Pandoc 3.x / 未检测到 / 自定义路径无效）+ 「重新检测」按钮；
  检测走 `SETTINGS_PANDOC_DETECT` → sidecar `pandoc-probe`（不加载 embedding 模型）。
- `native-settings-protocol.ts` 白名单加 `pandocPath`（WPF 偏好页同步显示，做法照 Snipaste）。
- i18n：`settingsPage.preferences.pandoc*` / `documents*` 三语（zh-CN/en/ja-JP）。

## 4. UI 行为

- 未安装 pandoc：拖入 `.docx` 时不再笼统「暂不支持」，而是「需要安装 Pandoc 才能读取此格式（设置 → 文档转换）」，并保留 unsupported 状态。
- 转换成功：附件状态可显示「已转换（Pandoc）」；失败原因沿用现有 `attachment.reason` 展示。
- 转换耗时随大文档增长，进度提示复用现有 `reading` 阶段（可在其中标注 converting）。

## 5. 测试计划

- .NET 自检：`cyrene-embed verify-pandoc [pandocPath]` —— 扩展名路由 / 版本解析 /
  清洗规则（图片/属性/空行/上限/空结果）/ 路径解析；本机有 pandoc 时追加真实
  `.rst` 转换、无效路径文案、取消中止（无 pandoc 时 SKIP，不阻塞 CI）。
- 端到端冒烟：`node scripts/diagnostics/pandoc-sidecar-smoke.mjs` —— 真实 sidecar 协议
  + 真实 pandoc：`.rst`/`.docx`（jszip 现场构造 OOXML）→ `kind:"text"` 内容断言；
  无效路径 → unsupported 可操作文案。
- TS 单测：`file-ingest` 路由（`.docx` → document / `isPandocExt` / 非生产链路文案）、
  `native-settings-protocol` 白名单与归一化、i18n key 门禁、core-bootstrap 快照字段。
- 回归：文本/图片路径与全量 vitest 不回归；sidecar 无 pandoc 时既有格式不受影响。

## 6. 分阶段

- **P1（pandoc 主体）**：converter 模块 + 两链路接入 + 设置字段/UI（Electron + WPF 白名单）+ 清洗 + 测试。
- **P2（pandoc 之外）**：PDF（poppler/`pdfjs-dist`，扫描件接 OCR）、xlsx（exceljs）、pptx、旧 Office（可选 LibreOffice 探测）。
- **P3（增强）**：文档内嵌图片抽取后走本地 OCR、转换缓存命中率展示、失败样本回收。

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 用户未安装 pandoc | 设置页一键检测 + 明确安装指引（winget / 官网），不阻塞其它格式 |
| pandoc 版本差异（rtf/typst/djot 等） | 以 `--list-input-formats` 运行时能力表为准，缺 reader 的格式回退 unsupported 并提示升级 |
| 恶意/超大文档 | 输入 ≤ 50MB、输出 ≤ 4M 字符、60s 超时、`--sandbox`、不传路径只走 stdin |
| worker 线程内 spawn 取消 | 取消信号 → kill 子进程并回收临时目录；队列层已有 cancel 通道 |
| 两条链路行为漂移 | converter 模块单一实现，`file-ingest` 与 worker 都调用它，测试同时覆盖 |

## 8. 验收口径（P1）

1. 安装 pandoc 后，拖入 `.docx/.odt/.rtf/.epub/.ipynb` 等格式能进入正常文档流程（小文件内联、大文件索引）；
2. 未安装/路径错误时给出可操作的错误文案，设置页能检测与保存自定义路径；
3. 转换文本无 base64/图片噪音，表格与标题结构保留；
4. 取消索职能中止转换子进程，临时目录无残留；
5. 既有文本/图片路径与全部测试不回归。

## 9. 实施记录（2026-10-02）

- 核心：`dotnet/embedding-sidecar/PandocConverter.cs`（解析/探测/转换/清洗）、
  `PandocSelfTest.cs`（`verify-pandoc`）、`PandocProbeCommand.cs`（`pandoc-probe`）；
  `DocImporter.cs` 接入 pandoc 分支；`Program.cs` doc-import 帧新增 `pandocPath`。
- TS：`file-ingest.ts` 路由与 `PANDOC_EXTS`；`document-import-sidecar.ts` 下发 `pandocPath`；
  `document-index-worker.ts` 回退提示；设置字段/IPC/React UI/WPF 行/三语 i18n。
- 验证：本机安装 Pandoc 3.12（winget，user scope）后
  `verify-pandoc` 27/27、`pandoc-sidecar-smoke.mjs` 7/7（rst + 真实 docx OOXML）。
- 已知边界：无 sidecar 的 worker 回退路径不提供转换（默认链路 sidecar 恒可用，打包态内置）；
  `.pdf/.xls/.ppt` 等仍按 §2 进入 P2。
