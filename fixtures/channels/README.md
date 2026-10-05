# fixtures/channels —— 渠道消息契约 v1 双端测试向量

「云端昔涟」服务端渠道层（Phase 2 渠道批）的**共享契约**：同一套 `cases/*.json` 同时被
TS 归一化实现（`src/main/channels/normalizers/**`）与 C# 实现
（`dotnet/cyrene-core/Channels/**`）执行，结果必须逐字段一致（`expect` 的键必须精确匹配，
缺省键必须缺省）。

- 设计：`docs/design/2026-10-05-server-channel.md` §2.2（类型镜像）/ §2.4（事件 id）/ §8（契约与测试）
- JSON Schema（规范镜像，非执行器）：`schema/channel-contract-v1.schema.json`
- TS 语义源：`src/main/channels/normalizers/**`（行为对齐桌面 `src/main/channels/adapters/*`）

当前 `cases/` 共 **52** 个用例（初始 42 + 微信评审修正 2 + 飞书评审修正 7 + 飞书 R2 边界 1）。

## 双端执行

```bash
# TS（vitest）
npx vitest run src/main/channels

# C#（冒烟壳；cwd 为仓库根）
dotnet build dotnet/smoke-host -c Release
dotnet dotnet/smoke-host/bin/Release/net10.0/cyrene-smoke.dll --selftest channel-contract fixtures/channels
```

### schema 校验（draft-07）

```bash
npx --yes ajv-cli@5 validate -s fixtures/channels/schema/channel-contract-v1.schema.json -d "fixtures/channels/cases/*.json"
```

schema 为规范镜像（非执行器）：全量 cases 必须通过，语义执行仍以双端 runner 为准。
schema 不依赖 `format` 扩展——`clientId` 的 UUID 形态用 draft-07 `pattern` 锁定，保证上面命令无需
`ajv-formats` 即可直接跑通。

## case 文件格式

```json
{
  "name": "用例名",
  "kind": "inbound | outbound | derived-ids | text-split | capability",
  "channel": "wechat | feishu | qqbot",
  "input": { "...见下..." },
  "expect": { "...见下..." }
}
```

### kind = inbound

`input = { "raw": <平台原始 payload>, "now": "<ISO-8601 UTC 毫秒，可选>" }`；
`now` 仅作时间戳缺省兜底（缺省 = `1970-01-01T00:00:00.000Z`，保证确定性）。

| channel | `raw` 形状 |
| --- | --- |
| wechat | iLink `WireMessage`（snake_case + `item_list`；`message_type !== 1` 返回 null） |
| feishu | 已解密的 v2 事件 envelope（`header.event_type == "im.message.receive_v1"`；仅 `chat_type=p2p`） |
| qqbot | `{ "type": "<Dispatch 事件名>", "data": { ...事件体... } }` |

`expect = { "message": <IncomingMessage \| null>, "media": [<媒体描述符>] }`：

- `message`：规范化 `IncomingMessage`；过滤/忽略场景为 `null`；
  `at` 显式给出（wechat/feishu 优先平台时间戳，缺省用 `now`；qqbot 优先 `timestamp`）。
  `_raw` 不进契约（TS runner 剥离；C# 模型不携带）；
- `media`：适配器下载/转写用的中间描述符（`message.attachments` 由下载后填充，不在本层）；
  - wechat：`{kind: image|voice|file|video, fileName, extension, analyzable, media?{encrypt_query_param,aes_key,encrypt_type?,full_url?}, sampleRate?}`
    （与桌面 `inbound-media.ts` 的 `describeInboundWechatMedia` 一致）；
  - feishu：`{kind: image|file|audio|video, fileKey, fileName?, duration?}`；
  - qqbot：恒为 `[]`（URL 直接进 `message.attachments`，与桌面 `normalizeQqBotEvent` 一致）。

### kind = outbound

`input = { "message": <OutgoingMessage>, ...渠道参数 }`：

| channel | 渠道参数 | `expect` |
| --- | --- | --- |
| wechat | `contextToken`, `clientId`（UUID 固定值）, `uploads{filePath→CDNMedia}`, `voices{filePath→{media,playtime,sampleRate,encodeType}}` | `{ "requests": [<sendmessage 请求体>], "error"?: string }` |
| feishu | `receiveIdType?`, `uploads{filePath→{image_key?,file_key?}}`, `durations{filePath→ms}` | `{ "receiveIdType": "open_id"\|"chat_id", "requests": [<im/v1/messages body>], "error"?: string }` |
| qqbot | `messageId`, `msgSeqUsed?`, `seqLimit?` | `{ "requests": [<被动回复请求体>], "error"?: string }` |

- `client_id` 真机为随机 UUID，fixtures 注入固定值后逐字段比对（格式见 schema `pattern`，UUID 形态）；
- `error` 仅在实际失败时出现（缺上传结果、缺 filePath、超限等），`requests` 保持空数组。

### kind = derived-ids

`input = { channel, chatId, messageId?, at, text, anchorEventId, intentId }`，
`expect` 固定六键：`sessionId / userTurnId / assistantTurnId / userEventId / assistantEventId / proactiveEventId`。

冻结规则（与桌面逐字一致；§2.4）：

```text
sessionId        = "channel:" + channel + ":" + sha256hex(channel + ":" + chatId)[0..16]
turnSource       = messageId（非空）否则 `${at.getTime()}:${text}`，换行（\r\n+）压成单行空格
userTurnId       = channel + ":" + chatId + ":" + turnSource + ":user"
assistantTurnId  = 同上 + ":assistant"
userEventId      = "ch-" + channel + "-" + sha256hex(channel + ":" + chatId + ":" + turnSource)[0..32]
assistantEventId = "gen-" + sha256hex(sessionId + ":" + anchorEventId)[0..32]
proactiveEventId = "proactive-" + sha256hex(sessionId + ":" + intentId)[0..32]
```

（sha256hex = UTF-8 输入、小写 hex；`[0..N]` 为前缀截断。`at.getTime()` = Unix 毫秒。）

### kind = text-split

`input = { text, limit? }`，`expect = { "parts": [...] }`：

- `wechat` / `feishu`：桌面 `splitTextBySentenceBreaks`（`src/shared/message-segmentation.ts`）同口径，`limit` = maxParts（默认 10）；
- `qqbot`：桌面 `splitQqText`（`src/main/channels/normalizers/qq-text.ts`）同口径，`limit` = maxCodepoints（默认 1500）。

### kind = capability

`input = { channel }`，`expect` = 服务端冻结能力表（§2.2）。

## 本轮契约修正（2026-10-05 R1 评审；冻结规则不变）

- **飞书出站私聊缺省 `receive_id_type=chat_id`**：dispatcher 的 TargetId 恒为 chatId（`oc_`），
  `outbound-feishu-text` / `outbound-feishu-group-receive-id` 锁定缺省口径；需要 `open_id` 时必须显式
  覆盖（`outbound-feishu-receive-id-override`，输入 `receiveIdType`）；
- **边界向量**：微信 `message_type` 严格 `==1`（`1.5` 与字符串 `"1"` 两条对齐 TS）；飞书 `content`
  非字符串时按 JS `String()` 语义（array/number/object 三条）；飞书音频 `duration` 非整数原值保留
  （入/出站各一条）；飞书 video `image_key` 空串保留（出站一条）；
- **webhook 回放**：`feishu-webhook/`（非双端契约，供 `channel-selftest feishu`）锁定 challenge
  明文/加密、坏签名、越界时间戳（`E_FEISHU_TIMESTAMP`）、密文文本/图片、群忽略、重投去重。

## 本轮契约修正（2026-10-05 R2 评审；冻结规则不变）

- **runner 布尔比较（P1-5）**：`DeepCompare` 补 `True/False` 显式比较——此前布尔字段落入
  `default` 被视为相等，capability 8 个开关、微信媒体 `analyzable` 的单侧漂移无法被 CI 发现；
  smoke-host runner 增加「人为改错布尔必须失败」的负向自检探针（`BooleanCompareSelfCheck`）；
- **飞书时间戳越界（P2-2）**：C# `FeishuNormalizer` 对超出 `DateTimeOffset` 范围的毫秒数不再抛
  异常丢事件，按无效时间戳返回 null → 回退 `now`；新增 `inbound-feishu-timestamp-nonfinite`
  双端向量（`1e400` 两端都判非有限、回退 `now`）与 `feishu-webhook/huge-event-timestamp.json`
  回放（20 位毫秒数事件仍 200 且正文可见）。

## 已知超纲差异（未入向量；双端不承诺逐字一致）

- 飞书出站 video：`uploads[*].image_key` 显式 `null` 时 TS 输出 `"image_key":null`，C# 省略该键
  （`string?` 语义）；向量只锁「键存在（含空串）保留」。生产路径 uploads 由各端生成，不应出现显式 null；
- 飞书入站 `content` 为 number 时：C# 取 JSON 原始字面量（`GetRawText`），JS 用 `String(number)` 数值
  格式化——`1.0` / `1e21` 等形态不同（普通整数 `123` 已锁）；
- 飞书入站时间戳超出 C# `DateTimeOffset` 范围（如 19 位毫秒数）：C# 视作无效回退 `now`（事件不丢）；
  TS `new Date(ms)` 可表示范围为 ±8.64e15——越界为 Invalid Date（契约序列化 `null`），未越界但年份
  >9999 时输出 5 位年份 ISO（schema `isoUtcMs` 不允许）。双端只锁「非有限值回退 `now`」与非丢事件
  （`inbound-feishu-timestamp-nonfinite` / `feishu-webhook/huge-event-timestamp.json`）。

## 破坏性修改

字段/枚举/id 规则的破坏性修改必须同时改 TS 类型、C# record、schema、fixtures，
双端 runner 全绿才算契约成立。
