# 内置工具 evidence 帧协议（写类工具变更载荷）v1

> **日期**：2026-10-03
> **状态**：已实施（T0，fs 三件接线随本协议落地）
> **关联 Issue**：[Ygwill/cyrene-agent#IKJK3V](https://gitee.com/ygwill/cyrene-agent/issues/IKJK3V)
> **关联文档**：`docs/dotnet-backend.md`（工具宿主）、`docs/dotnet-migration-decisions.md`（A1/A2）、
> 源码契约：`src/main/orchestrator/tools/registry/tool-evidence.ts`（TS）、
> `dotnet/native-windows/Tools/ToolEvidence.cs`（C#）。

---

## 1. 背景

写类工具（`write_file` / `str_replace` / `apply_patch` / 文档四件 / `ast_grep_replace` …）
的输出 JSON 里携带 `changes: ToolFileChange[]`，前端 Diff Review 卡片据此渲染
「文件 +x/-y」；`run-review-tracker` 另存 pre-mutation 基线，供运行后恢复/审查。

fs 三件下沉 ToolHost 时，若宿主只返回 `{path, bytes}`：

- `extractFileChangesFromOutput` 拿不到 `changes` → Diff Review 卡片消失；
- 覆盖防骤降、review 基线若留在 TS 而不执行 → 写坏文件无法审查。

因此本协议规定「.NET 写类工具如何把证据带回 TS」，作为后续写类工具迁移的统一契约。

## 2. 协议（不新增帧类型）

复用既有 ToolHost 帧：`{"op":"result","callId":..,"ok":true,"data": <工具输出>}`。

- `data` 仍是工具输出的完整字符串（与 TS 工具输出同构，直接回给模型）；
- **写类工具的 `data` JSON 必须包含 `changes: ToolFileChange[]`**，结构：

```jsonc
{
  "success": true, "tool": "write_file", "path": "C:\\…", "append": false,
  "exists": true, "sizeBytes": 29, "writtenBytes": 29,
  "changes": [{
    "file": "C:\\…",
    "kind": "added" | "modified" | "deleted" | "renamed",
    "insertions": 3, "deletions": 0,
    "diff": [{ "type": "add" | "remove" | "context" | "hunk", "text": "第一行" }],
    "truncated": true   // 仅裁剪时出现
  }]
}
```

- 上限与 TS `finalizeFileChanges` 完全一致：单文件 60 行 / 累计 200 行 / 单行 200 字符
  （C# 侧由 `ToolEvidence.Finalize` 实施）；
- TS 读取路径不变：`tool-round.ts` / `tool-dispatcher.ts` 的
  `extractFileChangesFromOutput(result.output)`，卡片渲染零改动。

## 3. 两轨职责划分（fs_write_file 为样板）

| 职责 | 归属 | 说明 |
| --- | --- | --- |
| 路径解析（相对路径→工作区/桌面） | TS 包装器 | `resolveWritePath`；宿主只接受已解析的绝对路径 |
| 覆盖防骤降（`checkOverwriteDrop`） | TS 包装器（预检） | 语义拒绝必须落盘前抛出，不因轨道切换改变 |
| review 基线（`captureBefore`） | TS 包装器 | 必须在宿主落盘**之前**；`captureBefore` 幂等 |
| 落盘（覆盖/追加/建父目录） | .NET | `FsTools.WriteFile`，UTF-8 无 BOM，与 TS `fs.writeFileSync/appendFileSync` 字节级等价 |
| `changes` / diff 证据 | .NET | `ToolEvidence`，与 `tool-evidence.ts` 同构同上限 |
| 回退（宿主不可用/超时/崩溃/错误载荷） | TS 包装器 | 整体回退 TS 原实现，行为零差异 |

宿主返回 `success:false` 的业务失败载荷视为「宿主轨失败」→ 回退 TS 复跑拿原错误语义
（错误码文案统一由 TS 侧产出，避免两轨错误面漂移）。

## 4. 验收与测试

- 单测：`src/main/orchestrator/tools/fs-tools-native.test.ts`（连线/回退/防骤降/基线时机）；
- C# 矩阵：`scripts/dotnet-tools-matrix.py`（新建/追加/覆盖三态 `changes` 断言，22/22）；
- 双轨等价：`scripts/dual-track-diff.ts` 新增 fs 段——write 输出投影 + 落盘字节级比较，
  read 分页窗口、list 文本对齐（CI `dotnet-backend` workflow 跑）；
- 回退路径由现有 `fs-tools.test.ts`（无宿主环境即全量回退）持续覆盖。

## 5. 未决与后续

- **取消与进度帧**：长任务（download / shell_job / 邮件）迁移前需补 AbortSignal 对应帧（Issue 跨领域项，另行设计）；
- **错误码透传**：当前 host 错误帧的 `errorCode` 在客户端被折叠为 message（回退 TS 兜底）；
  若后续写类工具需要「宿主态语义错误」不回退，需先补 `errorCode` 透传与分类；
- **其他写类工具**：`str_replace` / `apply_patch` / 文档四件 / `ast_grep_replace` 迁移时直接复用本契约
  （策略层留 TS、证据随 `data` 返回）。

## 6. 宿主事件帧（op:"event"）v1 —— weather_card 首用

对「工具执行中的非结果性通知」（天气卡片等），在既有 result 帧之外新增单向事件帧：

```jsonc
← {"op":"event","callId":"t12","kind":"weather_card","payload":{ /* 卡片数据 */ }}
← {"op":"result","callId":"t12","ok":true,"data":"{...}"}
```

- **发送**：宿主工具执行期间经 `ToolHost.EmitEvent(kind, payload)` 发出，先于 result 帧；
  `callId` 为当前调用，宿主单线程 + 串行闸门保证归属确定。
- **路由（TS）**：`NativeToolHost.handleFrame` 按 callId 找到在途调用，
  回调 `nativeFirst` 的 `options.onEvent(event)`（未注册回调则丢弃，不影响调用结果）。
- **回退语义**：只有 native 轨会发事件；宿主不可用时整体回退 TS 实现。
  同一轮调用内 native 事件帧与回退实现共享「一次发卡」去重标记（`cardEmitted`），
  避免「native 已发卡 → 看门狗边界失败 → 回退重发」双卡。
- **首用**：`weather`（成功与缓存命中两种情况都发卡片）；后续进度/通知类场景可复用。
