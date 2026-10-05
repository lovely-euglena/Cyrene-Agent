# 定时任务后台常驻化：调度下沉 .NET（tray 承载 + 按需拉起 Electron）

- 状态：实施中（分支 `issue/IKJK51`）
- 关联：Gitee IKJK51（[P2] 定时任务后台常驻化）
- 拍板记录：托盘菜单拆两项——「隐藏窗口」（调度继续常驻）/「完全退出」（停调度 + 退托盘；Electron 在线则一并退出）

## 1. 目标与边界

把「后台常驻的调度部分」下沉到 .NET 常驻托盘进程：定时器 + 任务存储 + 排期 + 历史；
**执行仍留 Electron**（B1 密钥、B2 审批铁律不变）。应用全退后到点触发时，由托盘按需拉起
`Cyrene.exe --scheduled-task <id>` 执行并回报历史。

不做：不搬 `CyreneAgent` / harness / 工具 / 权限 / 会话；不搬 LLM 密钥；不做 Windows 服务；
不改任务/历史文件格式（`scheduled-tasks.json`、`scheduled-tasks-history.jsonl` 原样）。

## 2. 架构总览

```
┌─ cyrene-native --tray（常驻，单一写者）───────────────┐
│  SchedulerStore（tasks JSON + history JSONL）          │
│  SchedulerEngine（单 timer / 1h 封顶 / 逾期归一）       │
│  named pipe "cyrene-tray"：sched.* CRUD/回执 + 事件     │
└───────▲────────────────────────────┬───────────────────┘
        │ sched.snapshot/…/report    │ event: sched.fire / sched.changed
        │                            ▼
┌─ Electron 在线 ────────────────────────────────┐   ┌─ Electron 不在 ──┐
│ scheduler-host-client（镜像 + 动作代理）        │   │ Process.Start    │
│ 收到 sched.fire → scheduler-runner 执行 →       │   │ Cyrene.exe       │
│   sched.report 回写历史；通知走现有 toast        │   │ --scheduled-task │
└────────────────────────────────────────────────┘   │ headless 最小 core│
                                                      └──────────────────┘
```

- **单写者**：host 模式激活期间，任务与历史文件由托盘独占写入；Electron 的一切读写经管道
  代理（`sched.report` / `sched.*`）。回退模式下（host 不可用）TS scheduler 恢复本地直写。
- **触发路径**：Electron 已连接 → `sched.fire` 事件交现有 `scheduler-runner`；未连接 →
  托盘 `Process.Start` headless Electron（带 `--scheduled-history <histId>` 复用历史 id）。
- **通知**：在线走现有 toast；离线由托盘 `tray.notify` 气泡。

## 3. C# 核心（`dotnet/cyrene-core/Scheduler/`）

| 文件 | 内容 |
| --- | --- |
| `SchedulerModels.cs` | `ScheduleKind` / `ScheduleConfig` / `ScheduledTask` / `NewScheduledTaskInput` / `ScheduledTaskPatch` / `ScheduledTaskHistoryEntry` / `SchedulerRunResult`（字段与 `src/main/scheduler/types.ts` 一一对应） |
| `ScheduleCalculator.cs` | 7 种排期 + 逾期归一（逐行对照 `schedule-calculator.ts`） |
| `SchedulerStore.cs` | 加载/校验/归一 + CRUD + 历史 JSONL（每任务 50 / 总 1000）+ `Changed` 事件 |
| `SchedulerEngine.cs` | 单 timer（1h 封顶）/ 逾期归一 / 先推进再派发 / running 去重 / `FireNow` |
| `SchedulerJson.cs` | 共享 `JsonSerializerOptions`（Web defaults）+ ISO 工具 |

契约：
- **时间**：DTO 中一律保留 ISO 字符串（与 TS 字节级一致，含 `toISOString()` 的
  `yyyy-MM-ddTHH:mm:ss.fffZ` 输出），计算器用 `DateTimeOffset` + 本地时区墙钟语义；
  月份/闰年非法组合「跳过不夹取」与 TS 一致。
- **JSON**：`JsonSerializerDefaults.Web`（camelCase）；任务文件 `{ "tasks": [...] }`。
- **引擎语义**（与 TS 对齐）：`NormalizeOverdueTasks`（once 逾期 → 写 `skipped/"missed while
  app was closed"` 历史 + 停用）；`FireDueTasks` 先 `updateTask({nextFireAt,lastFiredAt})`
  再并发执行；`runCount` 由 `lastFiredAt` 隐式 +1；`maxRuns/endAt/once` 边界一致。
- **插件任务**：C# 不计算授权指纹（TS 侧维护不变量）；启用口径 = `pluginUserEnabled &&
  approvalFingerprint 非空`；到点运行与否由 `CanRun` 委托决定（离线/插件未运行 → skip +
  写 `skipped/"plugin not running"` 历史，与 TS 一致）。
- **测试**：`dotnet/smoke-host --selftest scheduler`（Linux 可跑），把 TS 现有
  `schedule-calculator/scheduler-store/scheduler-engine` 测试向量逐条移植为断言。

## 4. 管道协议扩展（`cyrene-tray`，JSON 行 + `\n`）

兼容原则：现有帧（`tray.ready/icon/notify/tooltip`、`{op:"cmd",action}`）原样保留；
新增帧全部可选 `id`，有 `id` 必回 `{op:"reply", id, ok, error?, data?}`。

Electron → Tray：

| op | 载荷 | 回执 data |
| --- | --- | --- |
| `sched.snapshot` | — | `{tasks:[…]}` |
| `sched.add` | `{input}` | task 对象 |
| `sched.update` | `{taskId, patch}` | task 对象 |
| `sched.toggle` | `{taskId, enabled}` | task 对象 |
| `sched.delete` | `{taskId}` | bool |
| `sched.delete-owner` | `{pluginId}` | count |
| `sched.history` | `{taskId, limit}` | entries 数组 |
| `sched.report` | `{entry}`（同 id 覆盖，running→终态） | — |
| `sched.plugin-state` | `{running:{pluginId:bool}}` | — |
| `sched.mode` | `{enabled}`（托盘调度启用/停用协商） | — |

Tray → Electron：
- `{op:"event", name:"sched.fire", data:{taskId, scheduledFireAt}}`（到点；在线时）
- `{op:"event", name:"sched.changed", data:{tasks:[…]}}`（任何写操作/排期推进后）
- 既有 `{op:"cmd", action}` 不变（quit/drag-mode 等）。

动作代理约定：TS 侧沿用 `scheduler-actions` 的插件授权转换（`authorizePluginTaskUpdatePatch`
/ `pluginTaskTogglePatch`）后再下发 `sched.update/toggle`——指纹语义完全留在 TS。

## 5. Electron 侧

- `src/main/scheduler/host-client.ts`：仿 `tray-detached` 的命名管道客户端；**带自动重连**；
  连接后 `sched.snapshot` 建立镜像；`sched.changed` 刷新镜像并触发既有广播。
- 双轨开关：`CYRENE_SCHEDULER_HOST`（`config.ts`，默认 0）。开启且宿主可达 → host 模式；
  否则（exe 缺失 / 管道不可用 / 开关关）→ 现有 TS scheduler 原样回退（启动期判定 + 运行期
  管道重连；重连失败按「宿主不在」处理）。
- host 模式子系统：`store` 换镜像实现（`getTasks/recordHistory→sched.report/…`），
  `engine.start/stop` 为 no-op，`fireNow` 走本地 runner（校验对镜像做）；
  `broadcastSchedulerChanged` 与 native 快照继续复用（数据源换镜像）。
- 收到 `sched.fire` → 复用 `scheduler-runner` 执行（历史经 `sched.report`）；
  `canRunTask` 状态经 `sched.plugin-state` 同步给托盘。
- headless：`Cyrene.exe --scheduled-task <id> [--scheduled-history <histId>]`——最小 core
  启动（不建窗口/托盘），连管道取任务，跑 runner，回报历史 + `tray.notify`，退出。
- 托盘自启：登录项注册改为 `cyrene-native --tray --data-dir <userData>`（安装器
  「开机自启」勾选沿用 `installer-options.json` 链路；开关关闭/exe 缺失回退 Electron
  登录项）。**Electron 不主动拉起托盘**（避免双调度）——托盘未运行时启动期回退 TS scheduler。

## 6. 托盘退出语义（拍板结果）

菜单拆两项：
- **隐藏窗口**（新增）：`SendCmd("hide-windows")` → Electron 隐藏全部应用窗口；
  托盘与调度继续常驻。
- **完全退出**（原「退出」）：停调度（engine.Stop()）→ `SendCmd("quit")` 受控退出
  Electron → 杀 sibling helpers → 托盘退出。

## 7. 迁移与容错

- 旧 `scheduled-tasks.json` / history 由 C# 加载器直接读取（同格式即迁移，无需转换）；
  归一规则与 TS `normalizeLoadedTask` 一致（旧插件任务停用、无工作区用户任务停用等）。
- 首启（托盘）加载后立即持久化一次归一结果，保证两侧口径一致。
- 回退零数据丢失：host 不可用时 TS 原样接管同一文件；C# 引擎「先推进再派发」保证崩溃
  窗口内不重复触发（磁盘 nextFireAt 已前进）。
- 单实例：托盘加 `Mutex` 守护（现状仅靠管道占用拒绝，双托盘会双调度）。

## 8. 覆盖范围（本 PR 对应 issue 任务）

- [x] C# 移植 calculator/types/store/engine + `--selftest scheduler`（Linux 可跑）
- [x] tray 集成：timer + 单写者 + 历史压缩 + 退出语义（菜单拆项）
- [x] 管道协议（CRUD / fire / 变更事件 / 回执）与 `scheduler-host-client`
- [x] `--scheduled-task` headless 路径（最小 core / runner / 回写历史 / 通知）
- [x] 双轨开关与启动期回退
- [x] 插件任务离线语义（skip 记历史；指纹校验仍在 TS）
- [x] 启动注册（Electron ensure-spawn + 登录项改指 `--tray`）
- [x] 打包确认（`native-windows` 已随包）+ 冒烟脚本接入（`dotnet-smoke-linux.py` 增加
  `--selftest scheduler`，CI `dotnet-backend.yml` 覆盖）
