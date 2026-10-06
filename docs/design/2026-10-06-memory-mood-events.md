# 记忆与心情事件化（IKJK2O）——事件类型 · 重放规则 · 冲突演练

> 状态：设计定稿（2026-10-06）· 里程碑「云端昔涟：不落」Phase 2 · 关联 issue IKJK2O
> 契约扩展：同步协议 v0 → **v0.1**（`docs/specs/2026-10-04-sync-protocol-v0.md` 修订；本批 +`memory.write` / `mood.shift`）
> 前置：IKJK2H（v0 四类事件双端契约）；接线：IKJK2I（桌面导出器 / 物化视图，本批不做）

## 0. 结论与范围

**进本批（协议层，可独立验收）**

1. 新事件类型 `memory.write`（快照式 upsert + 墓碑删除）与 `mood.shift`：TS / C# / PHP 三实现校验、JSON Schema 镜像、双端 fixtures 锁定；
2. 幂等与重放规则 + 双端物化器（TS / C# 纯函数镜像）：确定性折叠 `{ memories, mood }`；
3. 冲突演练：双端离线分叉 → 交换事件 → 重放收敛一致的共享向量（`materialize-cases/`）；
4. 服务端接收与云同步 e2e（存储层类型无关，无需迁移）。

**不做（边界）**

- 桌面接线（`memoryStore` / `RuntimeStateService` → 事件发射）属 IKJK2I；本批不触碰 `src/main/memory/**` 与 `src/main/orchestrator/runtime-state-*`；
- L0/L1 profile 与端侧运行态字段（`triggerText` / `embedding` / `status` / `accessCount` / `keywords` / `sourceQuote` 等）不同步；
- PWA 记忆/心情视图；服务端自主主动消息调度（依赖本批完成，另批）。

## 1. 事件类型

### 1.1 `memory.write`（L2 记忆条目：快照式 upsert + 墓碑删除）

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `memoryId` | id，必填 | 记忆条目稳定 id（PMRS `L2Memory.id`） |
| `op` | `"upsert"` \| `"delete"`，必填 | upsert = 全量快照；delete = 墓碑 |
| `content` | string，op=upsert 必填 | 记忆正文 |
| `weight` | 安全整数 0–100，op=upsert 必填 | 权重快照（导出器整数化；§6 D6） |
| `pinned` | bool，可选（缺省 false） | 置顶快照；仅 op=upsert 可出现 |

- op=delete ⇒ `content` / `weight` / `pinned` **必须缺省**（出现即 `E_SYNC_PAYLOAD`）；
- 载荷闭合：未知键 → `E_SYNC_PAYLOAD`；`op` 枚举外 → `E_SYNC_PAYLOAD`；
- **`sessionId` 必须为保留命名空间 `__memory__`**（§1.3）。

示例（JSONL 行）：

```json
{"eventId":"mem-1","sessionId":"__memory__","type":"memory.write","lamport":5,"deviceId":"dev-a","seq":12,"ts":"2026-10-06T02:00:00.000Z","payload":{"memoryId":"l2_1759700000000_ab12","op":"upsert","content":"用户喜欢乌龙茶","weight":60,"pinned":true}}
```

PMRS op → 事件映射（导出器口径，IKJK2I 落地）：

| PMRS op | 事件 |
| --- | --- |
| `l2.add` | `memory.write` op=upsert（快照） |
| `l2.weight.update` / `l2.pin` / `l2.import-content` | `memory.write` op=upsert（最新快照） |
| `l2.delete` / 压缩 `deleteSummary` | `memory.write` op=delete（墓碑） |
| 其余（status/decay/merge/supersede/evidence…） | 不同步（端侧运行态 / 内部日志） |

### 1.2 `mood.shift`

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `feeling` | 九值枚举，必填 | `平静` `开心` `温柔` `激动` `撒娇` `担心` `难过` `感动` `害羞`（对齐 `RUNTIME_FEELINGS`） |

- 载荷闭合（单键）；`sessionId` 必须为 `__mood__`；
- 语义：心情状态快照（last-wins）。`status` / `expression` 为端侧瞬态 / 派生值，不同步。

示例：

```json
{"eventId":"mood-1","sessionId":"__mood__","type":"mood.shift","lamport":6,"deviceId":"dev-a","seq":13,"ts":"2026-10-06T02:00:01.000Z","payload":{"feeling":"开心"}}
```

### 1.3 保留命名空间

`__memory__` / `__mood__`：非会话事件的伪 `sessionId`（信封字段保持统一）。由校验器**强制**（fixtures 锁定）：不匹配 → `E_SYNC_PAYLOAD`。fetch / clone 可据此定向拉取；后续全局类事件按需扩展（v0.x）。

## 2. 幂等与重放规则

- **信封级（沿用 v0）**：`eventId` 首见幂等（重复丢弃）；规范序 `(lamport, deviceId 序数, seq)`；读取层（`readBatch`）完成去重 + 排序。
- **物化器**（纯函数；输入 = 去重 + 规范序后的事件）输出 `{ memories, mood }`：

| 事件 | 规则 |
| --- | --- |
| `memory.write` op=upsert | `memories[memoryId] = { content, weight, pinned }`（**后写覆盖**，按规范序） |
| `memory.write` op=delete | **sticky 墓碑**：标记删除并移除条目；其后（规范序更晚）同 id upsert **忽略（不复活）** |
| `mood.shift` | `mood = { feeling }`（后写覆盖） |
| 其它类型 | no-op（不参与本物化） |

- sticky 墓碑理由：PMRS 删除后重新添加会生成新 id（`l2_<ts>_<rand>`），同 id 复活在真实路径不出现；sticky 避免并发下「已删除记忆意外复活」。已否决备选：LWW 可复活（并发删除后另一端更晚 lamport 的 upsert 会复活记录，语义危险）。
- **确定性**：状态 = f(去重 + 规范排序后的集合)，与到达顺序无关；重复物化幂等；双端交换后集合相同 ⇒ 物化结果一致（RFC「离线分叉确定性收敛」）。
- 物化输出形状（供 fixtures 比较；被删除 / 未出现的条目不出现在 `memories`；无心情事件时 `mood: null`）：

```json
{
  "memories": { "<memoryId>": { "content": "…", "weight": 60, "pinned": false } },
  "mood": { "feeling": "开心" }
}
```

## 3. 冲突演练（共享向量）

- **读取契约**（`cases/`）：新增 `12-memory-mood.json`（合法批：乱序 → 规范排序）与 `13-memory-mood-payload-invalid.json`（`E_SYNC_PAYLOAD` 边界：缺字段 / delete 携带字段 / 未知键 / 枚举外 / 越界 weight / 命名空间不符等）。
- **物化契约**（`materialize-cases/`，本批新增）：输入 JSONL → `readBatch` → 物化 → 期望 `{ memories, mood }`（可选断言 `errors` / `droppedDuplicates`）。用例：

| 用例 | 演练点 |
| --- | --- |
| `01-memory-merge-last-wins` | 双端并发 upsert 同 id → 规范序后写覆盖 |
| `02-memory-delete-sticky` | 删除 vs 并发 upsert（含更晚 upsert）→ 不复活 |
| `03-memory-mixed-records` | 多记录混合 add/update/delete → 逐条收敛 |
| `04-mood-last-wins` | 双端心情交替 → 最后（规范序）生效 |
| `05-convergence-drill` | **双端离线分叉 → 交换 → 收敛**（乱序 + 重复事件，断言去重与最终状态） |
| `06-non-aux-ignored` | 会话类事件 no-op；非法行记 `errors` 不影响物化 |

- 双端执行：TS `npx vitest run src/main/sync`；C# `--selftest sync-materialize fixtures/sync-protocol/materialize-cases`。同套向量双端全绿即契约成立。

## 4. 实现清单

| 面 | 改动 |
| --- | --- |
| TS 契约 | `src/main/sync/sync-protocol.ts`：`SYNC_EVENT_TYPES` + `validatePayload` 两 case（含命名空间校验） |
| TS 物化 | 新 `src/main/sync/memory-mood-materializer.ts`（纯函数 `materializeMemoryMood`）+ 测试（读 `materialize-cases/`） |
| C# 契约 | `dotnet/cyrene-core/Sync/SyncProtocolV0.cs`：`EventTypes` + `ValidatePayload` 两 case |
| C# 物化 | 新 `dotnet/cyrene-core/Sync/MemoryMoodMaterializer.cs`（镜像）+ smoke-host 新 `--selftest sync-materialize` |
| PHP 契约 | `php/cloud-server/lib/protocol.php`：类型表 + 校验分支（回放 no-op 不变） |
| 服务端 | EventStore 无需迁移；push/fetch 自动支持；生成触发**不**新增（保持仅 user message / turn_rewind）；capabilities 不变（兼容性见 §5） |
| 其它 fold | `DialogEngine.Replay` / PWA `materializer.ts` / CF `replay.ts` / PHP `dialog.php`：新类型 no-op（聊天分支不受影响） |
| 镜像 / 文档 | schema 镜像 + fixtures README + spec v0.1 + 决策记录 |
| e2e | `scripts/dotnet-cloud-sync-test.py`：新类型 push/fetch 收敛用例 |

## 5. 兼容与灰度

- 旧校验器拒绝新类型（`E_SYNC_TYPE`）；旧客户端（PWA 缓存 / sync-client）丢弃并前进游标 → 新类型静默不可见，无数据损坏。
- 升级顺序建议：服务端 → 桌面 / PWA；单用户自建场景下灰度风险可接受。
- `06-unknown-type.json` 继续锁定「未知类型拒绝」语义（`memory.append` 仍为未知示例）。

## 6. 决策记录（本批）

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 两个类型（`memory.write` / `mood.shift`）而非 `memory.*` 多类型 | 与 issue / RFC 命名一致；upsert/delete 用 op 区分，避免类型爆炸 |
| D2 | 状态迁移（全量快照）而非增量 diff | 折叠简单、天然幂等；重量级字段（triggerText 等）不进事件 |
| D3 | sticky 墓碑（删除后同 id 不复活） | 并发删除安全性；PMRS 重新添加生成新 id |
| D4 | 保留伪 sessionId `__memory__` / `__mood__` 并强制 | 信封保持统一；fetch/clone 定向拉取；fixtures 可锁定 |
| D5 | 物化器为纯函数、双端镜像、输入假定已去重 + 排序 | 与 `readBatch` 职责分层；双端物化一致性可测 |
| D6 | `weight` 取安全整数 0–100 | 协议既有数值风格；避免浮点格式化差异；导出器整数化 |
| D7 | L0/L1 与端侧运行态字段不同步 | 控制收敛面；后续按需 v0.x |

## 7. 验证与验收对照

| issue 验收 | 对应证据 |
| --- | --- |
| 事件类型定义（含 tombstone） | §1 + spec v0.1 + fixtures 12/13 + schema 镜像 |
| 幂等与重放规则 | §2 + materialize-cases 01–04 / 06 + 双端物化器测试 |
| 双端离线分叉交换后物化一致 | materialize-cases 05（乱序 + 重复）+ 双端执行（TS / C#）全绿 + 云同步 e2e |

验证命令（本批）：

```bash
npx tsc -p tsconfig.main.json --noEmit
npx vitest run src/main/sync src/pwa
dotnet build dotnet/smoke-host -c Release
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-protocol fixtures/sync-protocol/cases
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest sync-materialize fixtures/sync-protocol/materialize-cases
dotnet build dotnet/cloud-server -c Release
python scripts/dotnet-cloud-sync-test.py
php php/cloud-server/tests/run.php   # 有 PHP 环境时
```
