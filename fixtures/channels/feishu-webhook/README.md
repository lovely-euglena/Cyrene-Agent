# fixtures/channels/feishu-webhook —— 飞书 webhook 回放向量

`channel-selftest feishu` 的 webhook 回放输入（非双端契约；契约 fixtures 在
`fixtures/channels/cases/`）。每个 case 用固定的 Verification Token / Encrypt Key / 时钟
走一遍 `FeishuWebhookProcessor`（`processInline=true`，同步观测事件处理结果）。

- 设计：`docs/design/2026-10-05-server-channel.md` §6.2（事件接收）/ §8.3（飞书测试矩阵）
- 实现：`dotnet/cloud-server/Channels/Adapters/Feishu/FeishuWebhookProcessor.cs`
- 生成：AES-256-CBC（key = SHA-256(EncryptKey)、IV = 密文前 16 字节、PKCS7）与
  `sha256(timestamp + nonce + encryptKey + body)` 由 Node `crypto` 独立实现生成（跨实现向量）；
  加密解密的官方向量见 `FeishuSelfTest`（`P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=` + `test key` → `hello world`）。

## case 格式

```json
{
  "name": "用例名",
  "config": {
    "verificationToken": "cyrene-test-token",
    "encryptKey": "cyrene-test-encrypt-key | null",
    "now": "2026-10-05T08:00:00.000Z"
  },
  "requests": [
    {
      "timestamp": "Unix 秒字符串（签名/新鲜度输入）",
      "nonce": "随机串（签名输入）",
      "signature": "sha256 hex | null",
      "body": "原始请求体字符串（签名以它为输入；加密时为 {\"encrypt\":\"...\"}）"
    }
  ],
  "expect": [
    {
      "status": 200,
      "body": { "…响应 JSON 的期望子集（键存在即须相等）…" }
    }
  ]
}
```

- `expect[i].body` 为**子集匹配**：只校验列出的键（如 `challenge` / `code` / `duplicate` /
  `messageId` / `text` / `media`）；`textContains` 为子串断言（附件路径随临时目录变化）。
- 事件处理为同步（`processInline=true`）：`duplicate` / `ignored` / `media` 可精确断言；
  `media` = 下载成功并注入 attachments 的数量。
- 资源下载由自测内 fake `HttpMessageHandler` 提供（无网络）。
