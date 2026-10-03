# 密钥等敏感信息分阶段迁移 .NET 保存处理

> **日期**：2026-10-03
> **状态**：设计草案（讨论中，未实施）
> **关联 Issue**：[Ygwill/cyrene-agent#IKJLB2](https://gitee.com/ygwill/cyrene-agent/issues/IKJLB2)
> **结论先行**：分两阶段。
> **Phase 1（本次规划）**：在 `cyrene-native` 增加 DPAPI（CurrentUser）加密的统一密钥库宿主，
> 把模型 / 视觉 / TTS / ASR 的密钥全部迁入 .NET 保存；TS 侧仅在组装请求时经本地帧协议
> 取用，不再持久化任何密钥；渲染进程不再拿到明文。**Phase 2（是否做、何时做，Issue 讨论）**：
> 把 LLM 请求处理整体下沉 .NET。过渡期内铁律 **B1（密钥不落 .NET）仍有效**，本设计通过后
> B1 标注为「拟迁移」，Phase 1 落地并稳定后再正式改写。
> **关联**：`docs/handover.md`（铁律 B1）、`docs/dotnet-backend.md`（B1 落实位）、
> `docs/dotnet-migration-decisions.md`（A20）、`docs/design/2026-10-02-cloud-storage-tool-design.md`（DPAPI 先例）。

---

## 1. 背景与问题

### 1.1 现状盘点（密钥在哪儿、什么形态）

| 存储位置 | 字段 | 现形态 | 说明 |
| --- | --- | --- | --- |
| `model-settings.json` | `perProvider[provider].apiKey`、`modelProfiles[].apiKey`、顶层 `apiKey`（镜像） | **明文 JSON** | 所有模型厂商 key；多档案各自一份 |
| `model-settings.json` | `vision.apiKey` | **明文 JSON** | 独立视觉模型 key |
| `model-settings.json` | `memoryApiKey`（预留字段，当前 UI 未暴露） | **明文 JSON** | 专用记忆模型配置预留 |
| `general-settings.json` | `ttsMinimaxKey`、`ttsCustomCloudApiKey`、`ttsMimoKey`、`ttsMosslandKey` | **明文 JSON** | TTS 各引擎 key |
| `general-settings.json` | `asrAliyunAppKey`、`asrAliyunAccessKeyId`、`asrAliyunAccessKeySecret`、`asrMinimaxKey` | **明文 JSON** | ASR 各引擎凭据 |
| 设置 IPC 快照 | `snapshot.config.apiKey / vision.apiKey …` | **明文进渲染进程** | `native-settings-sections.ts` 等 |
| SSH / 云存储档案 | 密码 / 口令 / 密钥 | 已 DPAPI（CurrentUser）加密 | `dotnet/native-windows/Ssh/SshProfileStore.cs`、`Storage/StorageProfileStore.cs`（`dpapi:` / `plain:` 前缀约定） |

### 1.2 问题

1. **明文落盘**：用户目录/同步盘/备份被拷贝、截图、日志打印时密钥直接泄露；
2. **渲染进程可见**：设置页快照可拿到明文 key（XSS/供应链插件拿到 IPC 即可外带）；
3. **策略不统一**：SSH/云存储已按「秘密只落 .NET + DPAPI」执行，模型/语音却仍是明文；
4. **B1 边界不完整**：B1 只约束「.NET 进程不接触密钥」，但没有约束 TS 明文持久化——而密钥最常泄露的是静态形态，不是进程内存。

## 2. 目标与非目标

### 2.1 目标（Phase 1）

- **静态加密**：密钥统一由 .NET 侧 DPAPI（`DataProtectionScope.CurrentUser`）加密保存，不引入新依赖（net10.0-windows 自带）。
- **唯一事实源**：密钥只在 .NET 密钥库一份；TS 不再持久化明文（现有 JSON 字段清空 + 备份）。
- **按需取用**：TS 请求组装时经本地帧协议 `secret.get` 取用，内存即用即弃，不写回任何配置文件。
- **渲染进程隔离**：设置页只拿 `hasKey` + 掩码值；保存走「输入新值 → .NET」单向通道。
- **可迁移、可回退**：首次启动一次性导入现有明文并清痕；开关/备份/失败策略明确。
- **零行为回归**：各业务读取密钥的语义不变（同样的字段、同样的时机），只有「从哪读」变化。

### 2.2 非目标（Phase 1 不做）

- 不做 Phase 2 的厂商请求处理下沉（vendors 层仍在 TS）；
- 不做跨设备云同步、密钥分享、多用户隔离；
- 不引入 passphrase/主密码模式（列为开放问题，防止范围膨胀）；
- 不改 B10 便携语义（data-dir 规则复用）。

## 3. 可复用资产

| 资产 | 位置 | 复用方式 |
| --- | --- | --- |
| DPAPI 约定 | `SshProfileStore.cs` / `StorageProfileStore.cs`（`dpapi:` 前缀、CurrentUser、不可用降级 `plain:`） | 密钥库沿用同一加密约定与错误口径 |
| 宿主帧骨架 | `LineHostClient`（`src/main/dotnet-backend/host-clients.ts`）、各 host `--*-host` stdio JSON 行协议 | `--secrets-host` 直接复用：ready 握手、callId 应答、超时/崩溃回退 |
| 开关解析 | `src/main/dotnet-backend/config.ts`（env > conf > 默认，0/1 直切） | 新增 `CYRENE_SECRETS_HOST`，默认随迁移批次切换 |
| 便携 data-dir | `HostConfig.cs` / `app.getPath("userData")` 重定向 | 密钥库文件落 data-dir，便携自动生效 |
| 打包 | `electron-builder.yml` `extraResources` 收 native publish 目录 | 无需改打包配置 |

## 4. Phase 1 方案

### 4.1 总体架构

```
设置页（渲染进程，只见掩码）
   │ IPC（不回传明文）
Electron 主进程（TS：settings / vendors / tts / asr）
   │ secret.get / put / delete / list / import
   │ stdio JSON 行协议（本地进程）
cyrene-native --secrets-host（.NET）
   │ DPAPI CurrentUser 加解密
   └─ <data-dir>/secrets.vault.json（仅密文）
```

- **密钥不进渲染进程**：设置页编辑框空 = 不修改；输入新值 = `secret.put`，只在 IPC 载荷里单向传输一次。
- **密钥不落 TS 盘**：`model-settings.json` / `general-settings.json` 的密钥字段迁移后写为空/占位；运行时取用不发日志、不 dump。
- **密钥不落 .NET 日志**：`secret.*` 帧不回显 value，错误码脱敏。

### 4.2 密钥库宿主（`--secrets-host`）

| op | 载荷 | 说明 |
| --- | --- | --- |
| `secret.get` | `key` | 返回明文（仅本帧；不缓存到盘） |
| `secret.put` | `key, value` | DPAPI 加密后落盘；空 value 保留旧值（对齐 SSH/存储「空秘密保留旧值」约定） |
| `secret.delete` | `key` | 删除并落盘 |
| `secret.list` | — | 只返回 key 名与 `updatedAt`，**绝不返回 value** |
| `secret.import` | `entries[{key,value}]` | 一次性迁移用；逐条加密，全部成功才答复 ok |
| `shutdown` | — | 退出 |

- **key 命名空间**：`model:<profileId|provider>`、`vision:default`、`memory:default`、`tts:minimax`、`tts:custom-cloud`、`tts:mimo`、`tts:mossland`、`asr:aliyun:*`、`asr:minimax`（实现时定稿）。
- **落盘格式**：`{ "version": 1, "entries": { "<key>": "dpapi:<base64>" } }`；临时文件 + `rename` 原子写，保留 `.bak`。
- **DPAPI 不可用**：Phase 1 **不允许降级明文**（与 SSH/存储档案不同——那是兼容手编的历史路径）。返回明确错误码，由上层提示用户，阻止保存密钥明文。

### 4.3 迁移与清痕（一次性）

1. 启动时探测：开关开启且密钥库为空 → 进入迁移；
2. 读取 `model-settings.json` / `general-settings.json` 中全部明文字段 → `secret.import`；
3. 逐条回读校验（`secret.get` 比对）；
4. 校验通过后：源文件备份 `.secrets-migration.bak`，密钥字段置空写回；
5. 迁移日志只记 key 名与条数，不记 value；
6. 幂等：密钥库非空则跳过导入，避免旧值覆盖新值（对齐 memory-host 的导入语义）。

### 4.4 TS 接入点

| 模块 | 改动 |
| --- | --- |
| `src/main/settings/model-settings.ts` | 读写走 vault；`apiKey` 字段在 JSON 中不再承载明文；`loadVisionConfig` / `resolveModelSettingsProfile` 对调用方保持同形接口（内部按需 get） |
| `src/main/settings/general-settings.ts` | `tts*Key` / `asr*` 字段同策略 |
| `src/main/settings/settings-ipc.ts`、`native-settings-sections.ts` | 快照改 `hasKey` + 掩码；保存路径接 vault |
| `src/main/tts/*`、`src/main/asr/*` | 引擎入参处按需 get（保持现有函数签名，key 仍是内存字符串） |
| `src/main/orchestrator/vendors/*`、`agent-process-manager.ts` | 无需改动——键仍由 TS 主进程持有并只在请求时使用（与 B1 兼容的过渡形态） |

### 4.5 失败与回退

| 场景 | 行为 |
| --- | --- |
| 迁移前：host 不可用 / exe 缺失 / 开关关 | 回退旧明文读取路径 + 启动告警；不阻断使用（与双轨回退一致） |
| 迁移后：host 不可用 | **硬失败**（报错引导），不回退明文——已清痕，回退只会把密钥重新写进 JSON |
| DPAPI 解密失败（换机器 / 用户变化） | 明确错误 + 引导重新录入；`.bak` 只恢复文件不恢复明文 |
| 设置页保存失败 | IPC 返回错误，界面提示；不静默丢弃用户输入 |

## 5. Phase 2（待议，不在本批实施）

把厂商请求处理下沉 .NET（vendors 适配器 / 流式解析 / 重试），届时密钥不出 .NET 进程，
B1 正式废止。触发条件与代价：

- 触发条件：Phase 1 稳定运行；出现「密钥绝不能进 TS 内存」的硬需求（如合规/多用户服务化）；
- 代价：vendors 3,453 行 + 流式协议逐调用桥 + 行为一致性回归，参考 Plan B 对 Harness 的评估口径；
- 备选：密钥由 .NET 保管但请求仍在 TS 的「凭证经纪」形态（即 Phase 1 终态）可能长期够用。

## 6. 安全属性

- **保护**：静态泄露（备份 / 同步盘 / 文件被拷）、误进渲染进程、日志泄露、源码库误提交。
- **不保护**：运行内存被调试/转储、同一 Windows 账户下的恶意进程、用户主动导出明文。
- **便携模式**：DPAPI CurrentUser 与 Windows 用户绑定，便携盘换机器后密文不可解 ——
  需重新录入（现有 SSH/存储档案同此限制）。是否提供 passphrase 加密的跨机方案列为开放问题。

## 7. 影响面清单

新增：`--secrets-host` 宿主、TS `secrets-client`、密钥库文件与开关。
修改：`model-settings.ts`、`general-settings.ts`、`settings-ipc.ts`、`native-settings-sections.ts`、
`tts/*`、`asr/*`、`dotnet-backend/config.ts`、`handover.md` / `dotnet-backend.md`（B1 标注）、决策记录 A20。
测试：迁移往返、幂等、DPAPI 失败路径、并发 put、清痕后 grep 无明文、设置页掩码契约。

## 8. 验收与测试计划

| # | 用例 | 期望 |
| --- | --- | --- |
| 1 | 已有明文配置首次启动 | 全部导入 + 源字段清空 + `.bak` 存在 + grep 源文件无 key 明文 |
| 2 | 二次启动 | 跳过导入，读数一致 |
| 3 | `secret.list` | 只有 key 名/时间，无 value |
| 4 | host 缺失（迁移前） | 旧路径可读，告警一次 |
| 5 | host 缺失（迁移后） | 明确报错，不写明文 |
| 6 | 设置页读取 | 只回掩码/hasKey；输入框留空保存不覆盖旧值 |
| 7 | 各引擎真实调用（模型/TTS/ASR） | 行为与迁移前一致（冒烟） |
| 8 | 便携模式 | vault 落 ./data；换机器解密失败有引导 |
| 9 | 并发 put / 崩溃恢复 | 原子写不损坏；`.bak` 可用 |

## 9. 开放问题（Issue 讨论待定）

1. **宿主形态**：独立 `--secrets-host`，还是并入规划中的 `--backend` 合并宿主？
2. **首批范围**：模型 key 先行，还是模型 + TTS/ASR 一次性迁完？
3. **渲染进程契约**：`hasKey` + 掩码会改动设置快照结构，需要前后端同批改（涉及 WPF 原生设置窗）；
4. **便携跨机器**：接受「重新录入」，还是要做 passphrase 模式？
5. **Phase 2**：是否需要、何时做；B1 的最终处置时点；
6. **备份/导出**：是否提供显式加密封装导出（换机迁移用），以及是否允许用户导出明文（需二次确认）。
