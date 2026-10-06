# fixtures/sync-protocol —— 同步协议 v0 双端测试向量

「云端昔涟」同步协议 v0（v0.1 扩展：+`memory.write` / `mood.shift`）的**共享契约**：
同一套 `cases/*.json` 同时被 TS 读取器（`src/main/sync/sync-protocol.ts`）与 C# 读取器
（`dotnet/cyrene-core/Sync/SyncProtocolV0.cs`）执行，结果必须逐字段一致；
`materialize-cases/*.json` 同时被双端物化器（TS / C#）执行，物化结果必须一致。

- 字段级规范：`docs/specs/2026-10-04-sync-protocol-v0.md`（v0.1 修订）
- 批次设计：`docs/design/2026-10-06-memory-mood-events.md`（IKJK2O）
- JSON Schema（规范镜像，非执行器）：`schema/sync-event-v0.schema.json`

## case 文件格式（读取契约）

```json
{
  "name": "用例名",
  "description": "可选：补充说明",
  "input": "JSONL 文本（\\n 分隔）",
  "expect": {
    "events": ["按规范排序后的事件 eventId"],
    "errors": [{ "index": 0, "code": "E_SYNC_ENVELOPE" }],
    "droppedDuplicates": ["重复被丢弃的 eventId"],
    "truncatedTail": false
  }
}
```

`expect` 除 `events` 外均可省略（默认空 / false）；`index` 为 0 基物理行号（含被跳过的空白行）。

## materialize-case 文件格式（物化契约）

```json
{
  "name": "用例名",
  "description": "可选：补充说明",
  "input": "JSONL 文本（\\n 分隔）",
  "expect": {
    "memories": { "<memoryId>": { "content": "…", "weight": 60, "pinned": false } },
    "mood": { "feeling": "开心" },
    "errors": [{ "index": 4, "code": "E_SYNC_PAYLOAD" }],
    "droppedDuplicates": ["aa", "bb"]
  }
}
```

- 执行链：`readBatch(input)` → 断言 `errors` / `droppedDuplicates`（给出时）→ 物化器折叠 `events` → 深比较 `{ memories, mood }`（`mood` 可为 `null`；被删除 / 未出现的条目不出现在 `memories`）。
- 物化规则（幂等与重放、sticky 墓碑等）见设计稿 §2。

## 双端执行

```bash
# TS（vitest；读取 + 物化）
npx vitest run src/main/sync

# C#（冒烟壳；cwd 为仓库根）
dotnet build dotnet/smoke-host -c Release
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-protocol fixtures/sync-protocol/cases
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-materialize fixtures/sync-protocol/materialize-cases
```
