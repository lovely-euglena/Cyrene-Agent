# fixtures/sync-protocol —— 同步协议 v0 双端测试向量

「云端昔涟」同步协议 v0 的**共享契约**：同一套 `cases/*.json` 同时被
TS 读取器（`src/main/sync/sync-protocol.ts`）与 C# 读取器
（`dotnet/cyrene-core/Sync/SyncProtocolV0.cs`）执行，结果必须逐字段一致。

- 字段级规范：`docs/specs/2026-10-04-sync-protocol-v0.md`
- JSON Schema（规范镜像，非执行器）：`schema/sync-event-v0.schema.json`

## case 文件格式

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

## 双端执行

```bash
# TS（vitest）
npx vitest run src/main/sync

# C#（冒烟壳；cwd 为仓库根）
dotnet build dotnet/smoke-host -c Release
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-protocol fixtures/sync-protocol/cases
```
