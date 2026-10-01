# Pandoc 文档转换接入规划

> 2026-10-02 · 状态：规划（待实施）· 关联：`file-ingest` / `document-index-worker` / 设置页

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

### 3.1 新模块 `src/main/rag/document-converter.ts`（不依赖 electron，主线程/worker 共用）

```ts
PANDOC_INPUT_EXTS: ReadonlyMap<string, string>   // ext → pandoc reader 名
isPandocExt(ext): boolean
resolvePandocExecutable(customPath: string): string | null
  // 自定义路径：文件直接用；目录则拼 pandoc(.exe)
  // 空：PATH 探测（where/which 语义，Windows 补 .exe），失败返回 null
probePandoc(exe): { version: string; inputFormats: Set<string> } | null
  // pandoc --version + --list-input-formats，按 exe+mtime 缓存
convertWithPandoc({ exe, reader, filePath, signal, timeoutMs }):
  { ok: true; markdown: string } | { ok: false; reason: string }
cleanConvertedMarkdown(text): string
```

转换调用约定：

- `spawn(exe, args, { stdio: ["pipe","pipe","pipe"], windowsHide: true })`，**不经过 shell**；
- 文件内容走 stdin（`--from=<reader>`），argv 里不出现用户文件路径，避免参数注入与沙箱外读；
- args：`--from=<reader> --to=markdown --wrap=none --extract-media=<临时目录>`；
- 优先 `--sandbox`（pandoc ≥ 2.15 限制 reader IO），遇到 "Unrecognized option" 自动去掉重试；
- 超时 60s、stdout 上限（如 8MB）、取消信号 → kill 子进程；
- 临时目录 `os.tmpdir()/cyrene-pandoc-<random>`，`finally` 删除（媒体文件不落地保留）。

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
| `describePendingAttachment` | pandoc 扩展名 → `kind:"document"`（可加 `converter:"pandoc"` 标记）；其余维持 unsupported |
| `file-ingest.ts` | `UNSUPPORTED_EXTS` 移除 pandoc 扩展名；`ingestOneFile` 在二进制判定前插入转换分支，转换结果按 30K 阈值走 text/indexed |
| `document-index-worker.ts` | `prepareFile` 改 async：pandoc ext → 转换 → 继续走 text/prepared-indexed；`WorkerStartMessage` 增加 `pandocPath`；取消消息触发 kill |
| `document-index-worker.ts` runner deps | 主线程 `createDefaultRunnerDependencies` 注入 `getPandocPath: () => settings.pandocPath`，随 start 消息下发 |
| `default-dependencies.ts` | 无结构变化；设置读取沿用现有 facade |

### 3.4 设置

- `GeneralSettings` 新增 `pandocPath: string`（默认 `""` = 自动探测 PATH），与 `snipastePath` 同模式。
- 设置页（Electron）新增一行「文档转换（Pandoc）」：路径输入 + 检测状态
  （已检测到 Pandoc 3.x / 未检测到 / 自定义路径无效）+ 「重新检测」按钮；
  放「偏好」或「通用」的「数据与存储」附近，二选一实施时按现有分组就近。
- `native-settings-protocol.ts` 白名单加 `pandocPath`（WPF 偏好页同步显示，做法照 Snipaste）。
- i18n：`panel.preferences.pandoc.*` 三语（zh-CN/en/ja-JP）。

## 4. UI 行为

- 未安装 pandoc：拖入 `.docx` 时不再笼统「暂不支持」，而是「需要安装 Pandoc 才能读取此格式（设置 → 文档转换）」，并保留 unsupported 状态。
- 转换成功：附件状态可显示「已转换（Pandoc）」；失败原因沿用现有 `attachment.reason` 展示。
- 转换耗时随大文档增长，进度提示复用现有 `reading` 阶段（可在其中标注 converting）。

## 5. 测试计划

- 单测（不依赖真实 pandoc，注入假 spawn）：
  - 扩展名路由、`resolvePandocExecutable`（自定义文件/目录/空）、版本与 reader 能力解析缓存；
  - args/stdin 构造、`--sandbox` 回退、超时、取消 kill；
  - 清洗规则（图片/属性/空行/上限/空结果）。
- 集成（本机安装 pandoc 后跑）：docx/odt/rtf/epub 样例转换 → 小文件内联与大文件索引两条路径；worker 取消。
- 回归：`file-ingest.test.ts` 中 `.docx` 从 unsupported 改为转换路径；worker 测试新增转换分支。

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
