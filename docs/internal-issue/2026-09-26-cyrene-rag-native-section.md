# 昔涟设置：RAG / 文档导入迁移到 .NET 原生设置窗（阶段 2）

> 日期：2026-09-26 · 提交：`b8c2d575`（阶段 1「状态栏 + 表情包」见 `f30991c9`）
> 位置：WPF `dotnet/native-windows/SettingsWindow.Cyrene.cs` ·
> 旧版对照：`src/renderer/settings/index.html` `#cyrene-panel` 的 RAG 卡片 +
> `src/renderer/settings/rag/panel.ts`

## 0. 旧版控件 → 新实现对照

| 旧版控件 | 新实现 | 说明 |
|---|---|---|
| Embedding 模型卡（BGE-M3，`检测中...`） | 只读模型卡 + 安装状态 | 状态来自 `getModelInstallStatus()`（项目 models 目录优先、HF 缓存兜底；断档不回退） |
| Embedding 维度输入（仅 Cloud） | 数字输入 + clamp 校验 | 留空 = 自动探测（提交 `null` 清空）；1~65536 取整 |
| Rerank 重排序卡（bge-reranker-base / 关闭） | 可选模型卡（点击写 `rerankerMode`） | 写盘后宿主重新 `initReranker`；未安装自动降级 none |
| 当前模式（自动） | 有效档展示 | `standard` 未安装时显示「按关闭处理」 |
| 📖 模型安装说明 | `cyrene open-model-docs` | 宿主 `shell.openExternal` 同一文档（docs/local-models.md） |
| 删除缓存（modal 确认） | WPF 确认框 → `cyrene delete-embedding` | 只删 HF 缓存（`embedding-manager.deleteEmbeddingModel("bgem3")`），项目模型目录不受影响 |
| 检查更新（旧版假装「已是最新版本」） | `cyrene check-model-update` | 重推快照刷新状态 + **如实提示**：模型为手动安装，更新需按说明替换 |
| 下载镜像源（旧版仅 localStorage） | 通用设置 `ragDownloadMirror` | Electron 页与 WPF 同读同写；`EMBEDDING_DOWNLOAD` 未显式传参时用它 |

## 1. 数据 / 动作契约

**读方向**（`state.settings.cyrene`，`buildCyreneSectionSnapshot`）：

```ts
{
  runtimeSync, stickerEnabled, stickerSize, stickerSimilarityThreshold,   // 阶段 1
  embeddingModel: "bgem3",
  embeddingDimensions: number | null,   // null = 自动探测
  rerankerMode: "standard" | "none",
  embeddingInstalled: boolean,          // getModelInstallStatus()
  rerankerInstalled: boolean,
}
```

**写方向**：

- `cmd settings cyrene {verb:"save", payload}` —— `sanitizeNativeCyreneSave` 白名单：
  `runtimeSync / stickerEnabled / stickerSize / stickerSimilarityThreshold /
  embeddingDimensions / rerankerMode`；`rerankerMode` 变更触发宿主 `initReranker`。
- `settings.set {key:"ragDownloadMirror"}` —— 通用设置白名单（与渲染页 `saveGeneral` 同源）。

**动作**：`cyrene` → `save / open-sticker-manager / add-sticker /
open-model-docs / delete-embedding / check-model-update`（`NATIVE_SECTION_ACTIONS` 锁定，
契约测试扫描 `SettingsWindow.Cyrene.cs`）。

## 2. 不变量（后续改动必须保持）

1. **模型为手动安装**：本页不提供应用内下载；「检查更新」不得假装在线检查成功
   （诚实提示手动替换），旧版的假文案不再复刻。
2. 模型状态一律走 `getModelInstallStatus()`（`src/main/rag/model-status.ts`）：
   项目 `models/` 目录存在但不完整时**拒绝回退** HF 缓存，避免掩盖半包模型问题。
3. `rerankerMode` 写盘后必须重新 `initReranker`（与 `RERANKER_SET_MODE` IPC 同口径）；
   模型未安装时 `initReranker` 自动降级 `none`，UI 的「当前模式」按安装状态如实展示。
4. `embeddingDimensions`：`null` = 清空（自动探测）；数字 clamp 1~65536 取整
   （宿主 sanitize 与 `normalizeModelSettings` 双保险）。
5. 删除缓存只动 HF 缓存目录；不触碰项目 `models/`。
6. 镜像源**单一来源** = 通用设置 `ragDownloadMirror`；任何界面不得再写入
   localStorage `cyrene.rag.mirror`。

## 3. 验证

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run src/main/windows/native-settings-protocol.test.ts src/main/settings/
# 83 用例（协议锁 / sanitize 边界 / 快照投影）
npm test        # 全量 4016 通过 / 1 失败（Git Bash 环境用例，基线一致）
```

离屏渲染（临时钩子，验后已移除）：`embeddingInstalled=true / rerankerInstalled=false /
dimensions=1024 / mode=standard` 时，卡片、状态、有效模式、镜像源高亮均正确；
帧序列化验证：`save{embeddingDimensions:1024}`、`save{embeddingDimensions:null}`、
`save{rerankerMode:"none"}`、`check-model-update` 四类帧 JSON 正确。

## 4. 遗留

- 应用内一键下载模型（进度 / 取消 / 断点）未接入：旧版即手动安装；
  `EMBEDDING_DOWNLOAD`（含 `mirror` 参数）保留，当前只有镜像源偏好接线。
- 「文档导入检索」本身在**记忆** section：导入文档列表 +
  `imported_docs` 检索工具；本页只负责模型侧配置。
- 模型状态在设置快照推送时刷新；如手动替换模型文件，可在本页点「检查更新」
  重新体检（触发一次快照推送）。
