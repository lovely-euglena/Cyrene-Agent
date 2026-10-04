# 服务端四形态与能力声明 · 设计（IKJN70 / IKJN78）

> **日期**：2026-10-04
> **状态**：能力声明与一致性套件已实现（IKJN78）；CF 版已实现并通过部署实例验收（IKJN79，PR 待合并）；Git 版适配器已实现（IKJN7B）；PHP 按 IKJN7C 推进
> **关联**：RFC `docs/design/2026-10-03-cloud-cyrene-rfc.md`（不变式 / Q8）· 总决策 IKJN70 ·
> CF spike IKJN3W · 桌面端同步客户端 IKJK2I · PWA IKJK2L · 完整版运维 IKJK2N

## 0. 目标

把「服务端」从唯一实现变成**可替换的 remote 形态**（RFC 不变式：remote 随时可解绑），覆盖不同用户场景；
用「一套协议 + 能力声明 + 一致性套件」避免多实现契约漂移。

## 1. 四形态取舍矩阵

| 维度 | 完整版（.NET VPS） | CF 版 | PHP 空间版 | Git 仓库版 |
| --- | --- | --- | --- | --- |
| 设计目的 | 全功能参照；Phase 2 24/7 渠道/调度 | 免运维 / 免费 / 海外可达 | 国内虚拟主机场景 / 免运维 | 零服务器 / 数据版本化 |
| push / fetch / clone | 实时 | 实时 | 实时 | 批量（pull 周期，分钟级） |
| 游标 | 服务端插入序 | DO 插入序 | MySQL 自增序 | 每设备 append-only 分片 + 字节偏移（无全局游标） |
| 鉴权 | device token + master | 同左（TS 重写） | token 表 | 仓库权限（私库 + PAT/SSH） |
| 服务端生成 | 后台队列 + 重试 | 模型 API + DO alarm 重试 | push 内联尽力（可选 cron 排空） | 不做（桌面在线代生成） |
| PWA 托管 | 同源 | Workers 静态资产 | 同空间静态 | 不承诺（桌面优先） |
| 运维 / 备份 | systemd + 备份/监控（IKJK2N） | CF 面板 + 定期导出 | 空间商 + 导出脚本 | git 历史即备份 |
| 数据主权 | 自己机器 | 平台 | 空间商 | 自己仓库 |

取舍原则：**L1 同步核心全形态一致**；L2 鉴权/配对按平台能力落地；L3 生成按形态降级；L4 运维面各随平台。

## 2. 能力声明（`GET /v1/capabilities`）

公开只读（客户端在配对前就要用它降级 UI；不含敏感信息）。字段：

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `impl` | `dotnet-vps` / `cf-workers` / `php-shared` / `git-repo` | 形态标识 |
| `protocol` | `v0` | 协议版本 |
| `sync` / `clone` | bool | 同步核心能力 |
| `cursor` | `server` / `file-offset` | 增量游标语义 |
| `generation` | `realtime` / `inline` / `none` | 服务端生成档位 |
| `pairing` | `device-token` / `shared-secret` / `repo-credential` | 鉴权形态 |
| `pwa` | bool | 是否托管 PWA |
| `maxBatchBytes` | int | push 批上限 |

客户端降级：PWA 在 `generation: none` 不显示「等待回复」；`pwa: false` 不提示手机访问；
解析失败 / 老服务端（无端点）回退兼容默认（`realtime` / `pwa=true`，行为不变）。

## 3. 一致性套件与 profile（IKJN78）

- **本地 full**（默认）：全量检查（含生成闭环 / 限流阈值 / Host 白名单 / 日志脱敏 / Linux 权限 /
  裸 socket 上限探测）；
- **核心档**（`--profile core` 或 `--base-url URL --master-token TOKEN`）：对任意 HTTP 形态跑
  同步核心 + 配对令牌 + 能力声明 +（`pwa=true` 时）静态托管；事件/会话 id 带运行前缀，
  可对持久实例重复跑；
- **PWA e2e**：`--base-url / --master-token` 远端模式（不 spawn；`--expect-echo` 显式开启生成断言）；
- Git 版不走 HTTP 套件，走桌面端适配器测试（IKJN7B）。

## 4. 各形态要点

### 4.1 完整版（已实现）

能力声明 `impl=dotnet-vps`；`generation` 随 `CLOUD_LLM_API_KEY` 动态；PWA 同源托管；运维见 IKJK2N。

### 4.2 CF 版（IKJN79）

- TS 复用 `src/main/sync/sync-protocol.ts` 校验器；DO SQLite 承载事件表（spike IKJN3W 已验证协议子集 7/7）；
- 注意：自定义域证书覆盖（4 级子域需独立子 zone / 已覆盖域名）；Bot Fight Mode 对脚本 UA 的 403/1010；
- 生成走模型 API + DO alarm 重试；静态资产用 Workers 静态托管。

### 4.3 Git 版（IKJN7B，桌面端；适配器已实现）

- `src/main/sync/git-remote.ts`（`GitRepoRemote`）：每设备 `events-<deviceId>.jsonl` append-only 分片 +
  字节偏移增量；`.gitattributes` 固定 `*.jsonl -text`（禁用行尾转换，保字节偏移语义）；
- push = 追加分片 + commit + push；fetch = pull `--rebase` + 读新行；合并 = eventId 幂等 +
  规范序并集（`mergeSyncEvents`）；无生成 / 无 PWA；
- 保守合并：pull 失败/冲突一律中止（不 force、不重写远端历史）；强制推送（历史重写）后
  前缀哈希失配 / 文件收缩 → 该分片回退全量重读；半截尾行只读到最后一个换行（本设备追加前自愈修剪）；
- 鉴权 = 仓库权限（私库 + PAT/SSH，经 `remoteUrl` 传入，不外泄日志；init 错误同样脱敏并覆盖
  URL 变形）；状态由调用方持有（`FetchState` 每分片 `{offset, prefixHash}`，模块不落盘额外状态）；
- 失败路径：git 调用带无输出超时（`timeoutMs`）与取消（`signal`）；提交失败回滚追加（文件 + 暂存区）；
  无新事件 / 同批重试自愈（补提交 / 补推送）；默认隔离用户全局 git 配置与终端凭证提示；
  错误码可重试分级（git / timeout / push_rejected 可重试，conflict / aborted / invalid_config 需处理）；
- 适配器测试（独立 bare 远端 + 双工作副本）：收敛 / 离线分叉 / 强推恢复 / 半截行 / 幂等 /
  纯本地 / 行尾规则 / 收缩重读 / 追加自愈 / 坏行物理行号 / init 脱敏 / 提交回滚 / 未推送自愈 /
  参数校验 / 同设备冲突，**17/17**；桌面端接线（事件导出器 / 物化视图）属 IKJK2I，后续接入。

### 4.4 PHP 版（IKJN7C）

- 单文件/小套件实现 L1+L2；MySQL 自增序 = 服务端游标；
- 生成：push 内联尽力（`max_execution_time` 内），失败挂起 + 可选 cron 排空 + 桌面兜底；
- 便携 PHP 环境本地验证（无真实空间）。

## 5. 验证（IKJN78 批次，Windows 本地）

- 本地 full 云冒烟：**54/54**（含 3 项能力声明检查）；
- 核心档（本地实例）：**35/35**；远端核心档与本地核心档同一函数（CF 批次将直接对部署实例跑）；
- PWA 单测：**39/39**（含能力解析/降级 6 项）；e2e（Edge 通道）：**11/11**（含能力声明检查）。

### IKJN7B 批次（Git 版适配器）

- 适配器测试 **17/17**（独立 bare 远端 + 双工作副本：收敛 / 离线分叉 / 强推恢复 / 半截行 / 幂等 /
  纯本地 / 行尾规则 / 收缩重读 / 追加自愈 / 坏行物理行号 / init 脱敏 / 提交回滚 / 未推送自愈 /
  参数校验 / 同设备冲突）；
- 组合回归：`vitest run src/main/sync src/pwa` **68/68**；`tsc main` / `tsc preload` /
  `tsc renderer` 三端 0 错误。
