# 同步协议 v0（事件模型 · Schema · 双端测试向量）

> 状态：**v0 定稿**（2026-10-04，IKJK2H 批次）· 里程碑「云端昔涟：不落」Phase 1 前置
> 关联：RFC `docs/design/2026-10-03-cloud-cyrene-rfc.md` §3–§4；事件源 CTA
> `docs/design/2026-09-21-cta-conversation-transcript-architecture-design.md`
> 可执行契约：`fixtures/sync-protocol/`（TS `src/main/sync/sync-protocol.ts`
> ⇄ C# `dotnet/cyrene-core/Sync/SyncProtocolV0.cs`，同一套 fixtures 双端全绿即契约成立）
> 规范镜像：`fixtures/sync-protocol/schema/sync-event-v0.schema.json`（非执行器）

---

## 0. 范围

- v0 只承载 **Phase 1 文本聊天**所需事件：`session.create` / `message.append` /
  `turn_rewind` / `tombstone`；`memory.*` / `mood.shift` 等属 Phase 2（类型扩展按 v0.x 修订）。
- 本规范定：**事件信封 + 四类载荷 + 读取语义（容错/去重/排序）+ 错误码 + 测试向量**。
- HTTP 路由、游标（`since`）、push/fetch/clone 细节属 IKJK2I（导出器/客户端）与
  IKJK2J（服务端），不在此定义。
- 传输形态：**JSONL**（一行一事件，UTF-8）。push 批与 fetch 响应都按本读取语义解析。

## 1. 事件信封

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `eventId` | id，必填 | 幂等主键；CTA 映射 = `entryId` |
| `sessionId` | id，必填 | 会话标识；CTA = conversationId |
| `type` | 枚举，必填 | v0 四类；未知 → `E_SYNC_TYPE` |
| `lamport` | 安全整数 ≥0，必填 | 端侧逻辑时钟（生成端自增） |
| `deviceId` | id，必填 | 端设备（配对签发） |
| `seq` | 安全整数 ≥0，必填 | 端侧单调序号 |
| `ts` | ISO UTC，必填 | `YYYY-MM-DDTHH:mm:ss.sssZ`（毫秒精度、仅 `Z`） |
| `payload` | object，必填 | 按 `type`（见 §2） |
| `prevHash` / `hash` | 64 位小写 hex，可选 | 哈希链预留；**v0 不校验链式关系**（Q3 待定稿） |

- **id 规则**：非空、长度 ≤200（UTF-16 码元）、不含 C0 控制符（U+0000–U+001F）与 U+007F。
- **安全整数**：0 ≤ n ≤ 2⁵³−1；载体为 JSON number（`1.0` 与 `1` 等价）。
- **闭合校验**：信封未知键 → `E_SYNC_ENVELOPE`；各类型载荷未知键 → `E_SYNC_PAYLOAD`。

## 2. 载荷（按 type）

### 2.1 `session.create`

```json
{ "title": "会话标题（≤200，可为空串）", "createdAt": "2026-10-04T02:00:00.000Z" }
```

映射：CTA 会话元数据（标题/创建时间）。未知键 = `E_SYNC_PAYLOAD`。

### 2.2 `message.append`

```json
{
  "role": "user" | "assistant",
  "text": "消息正文",
  "turnId": "user 必填（rewind 锚点）；assistant 可省",
  "presentation": { "patchRevision": 1, "patch": { "content": "…", "processMessages": ["…"] } }
}
```

- `role=user` ⇒ `turnId` 必填；`role=assistant` ⇒ `turnId` 可选。
- **`presentation`（Q1 拍板：patch 随事件携带）**：`patchRevision` 为 ≥1 整数；
  `patch` 为非空对象，键必须属于 CTA presentation patch 白名单（16 键，见下）。
  **值形状由 CTA TS 侧写入路径负责**；C#/服务端仅做键集合校验并透传（回放给 PWA 直接渲染）。
- 白名单：`content` `reasoning` `reasoningBlocks` `processMessages` `agentRounds`
  `taskDelegations` `channelSource` `sticker` `toolExecutions` `runActivity`
  `runSnapshot` `ttsCacheKey` `ttsCacheVersion` `musicCard` `contextUsage` `delta`。
- **Phase 1 只做文本**：附件、工具条目不同步（导出器过滤 `tool_result` 等；见 §4）。

### 2.3 `turn_rewind`

```json
{
  "anchorUserTurnId": "被编辑/重生成的 user 回合",
  "disposition": "keep_user" | "replace_user",
  "reason": "edit" | "regenerate",
  "replacementUser": { "text": "替换后的用户文本" },
  "revision": 2
}
```

- `replace_user` ⇒ `replacementUser` 与 `revision`（≥1）**必填**；
  `keep_user` ⇒ 两者**必须缺省**（出现即 `E_SYNC_PAYLOAD`）。
- 映射：CTA `turn_rewind`（CTA 里 revision 在信封上，同步侧移入载荷）。
- 锚点解析沿用 CTA 语义：`anchorUserTurnId` 指向活动视图中该 turnId 下 revision 最大的
  user 条目；弯曲点之后的消息在投影中失效、重渲染。

### 2.4 `tombstone`

```json
{ "targetUserTurnId": "被撤回的 pending user 回合", "reason": "pending_withdrawn" }
```

映射：CTA `turn_tombstone`（待发消息撤回）。后续删除语义扩展 enum 时按 v0.x 修订。

## 3. 读取语义（`readBatch`）

同一段 JSONL 在 TS 与 C# 必须产出**逐字段一致**的结果 `{ events, errors, droppedDuplicates, truncatedTail }`：

1. 去首 BOM；按 `\n` 切行；行首尾空白（含 `\r`）裁掉；全空白行跳过（**仍占物理行号**）。
2. 逐行 JSON 解析：
   - 失败且为**末条非空行** ⇒ 视为半截批：修剪、`truncatedTail=true`、**不记错误**
     （调用方应从上一游标重拉）；
   - 失败且在中间 ⇒ `errors += { index, E_SYNC_BAD_JSON }`。
3. 校验（错误码优先级 `ENVELOPE > TYPE > PAYLOAD`）；每事件至多记一个错误。
4. **幂等去重**：`eventId` 首见生效（按输入序），重复进 `droppedDuplicates`。
5. **规范排序**：`(lamport, deviceId 序数比较, seq)`；全同键保持输入序（稳定排序）。
   该全序即 RFC §4.2「离线分叉确定性收敛」的排序依据。
6. 输出：`events`（去重+排序后）、`errors`（输入序）、`droppedDuplicates`、`truncatedTail`。

## 4. 与 CTA 的映射与决议

| CTA 条目 | 同步 v0 |
| --- | --- |
| `user` 条目 | `message.append`（role=user） |
| `assistant` 条目 | `message.append`（role=assistant；presentation 随行） |
| `turn_rewind` | `turn_rewind` |
| `turn_tombstone` | `tombstone` |
| `compaction_checkpoint` | **不同步**（Q1-a：服务端/手机不需要压缩态，重放原始历史即可） |
| `tool_result` / `tool_started` / `task_state` / `effect_resolution` / `interruption` / `backfill_boundary` / `presentation_patch` / `delivery_receipt` | v0 不同步（导出器过滤；工具历史留在桌面） |

- **Q1 拍板记录（按 RFC 建议落地，可回退）**：compaction checkpoint 不外同步；
  presentation patch 随事件携带。v0 尚未上线，翻转成本低，如需变更走 v0.x 修订。
- 服务端生成事件（IKJK2M DialogLoop）同样以本协议写回：`eventId` 为幂等键，
  重试不产生重复消息（RFC §4.2）。

## 5. 错误码

| code | 含义 |
| --- | --- |
| `E_SYNC_BAD_JSON` | 行非合法 JSON（非末条） |
| `E_SYNC_ENVELOPE` | 信封非法（非对象 / 未知键 / 字段形状） |
| `E_SYNC_TYPE` | `type` 不在 v0 四类 |
| `E_SYNC_PAYLOAD` | 载荷非法（未知键 / 字段级规则） |

## 6. 双端实现与验证

- TS：`src/main/sync/sync-protocol.ts`（`validateSyncEvent` / `readSyncBatch`）
- C#：`dotnet/cyrene-core/Sync/SyncProtocolV0.cs`（`ValidateEvent` / `ReadBatch`）
- fixtures：`fixtures/sync-protocol/cases/`（11 组：正常 / 乱序 / 重复 / 半截 / 坏行 /
  未知类型 / 信封非法 / 载荷非法 / presentation / 空白行 / 空输入）

```bash
npx vitest run src/main/sync
dotnet build dotnet/smoke-host -c Release
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-protocol fixtures/sync-protocol/cases
```

CI：`dotnet-backend` 工作流同时跑 C# 契约自测与 TS vitest（双端同套 fixtures）。

## 7. 开放项（后续批次）

- **哈希链**（Q3）：`prevHash` / `hash` 的组织方式与必填时机在 IKJK2J 定稿后收紧；
- **HTTP 细节**：push/fetch/clone、游标推进、错误码到 HTTP 状态映射（IKJK2I/J）；
- **类型扩展策略**：Phase 2 新增 `memory.*` / `mood.shift` 等按 v0.x 修订 + 增补 fixtures；
- **附件 / 工具条目同步范围**：由 IKJK2I 导出器决定过滤边界。
