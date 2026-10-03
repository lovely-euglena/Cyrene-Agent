# git 工具下沉 .NET — 设计与决策（IKJLIL）

- 状态：已交付（8 工具 + 外围 + 测试全绿；残项见 §5）
- 关联：Issue #IKJLIL；删除的影子实现 `a76cd452` / `697388bc`（raw git 直通，未接线，不复活）
- 基线：`issue/IKJK3V-tool-dotnet-migration`（ToolHost 串行闸门 / 取消链路 / evidence v1 已就绪）

## 1. 决策：系统 git 子进程（对齐 GitService），不引入 libgit2sharp

| 维度 | 子进程 git CLI（采纳） | libgit2sharp（放弃） |
| --- | --- | --- |
| 语义等价 | 与现实现同命令、同解析（simple-git 也是 CLI 封装） | status/diff/log 语义与 git CLI 有差异，需要大量对齐工作 |
| 测试基建 | matrix/dual-track 可直接跑真实 git；本机与 CI 均可用 | 需额外依赖与版本矩阵 |
| 打包体积 | 0（复用系统 git / 随包 mingit） | +数 MB 原生库 |
| 凭证 | 完全沿用系统 git 的凭据链（helper/环境），与 B1 边界天然一致 | 需要在 .NET 内实现认证回调，触碰密钥边界 |
| 结论 | **采纳** | 否 |

## 2. 架构：TS 策略层 + C# 执行层（nativeFirst 同一模式）

```
TS 工具（git-tools.ts）── nativeFirst("git_xxx", 内部参数) ──> ToolHost(GitTools.cs) ──> git CLI
        │ 失败/不可用/取消                                                    │
        └────────────── 回退 GitService（simple-git）原实现 <────────────────┘
```

**信任边界**：所有外部输入（workspaceRoot / git 路径 / 身份）由 TS 包装器从 `ToolContext` 与 `GitService`
取可信值后注入内部参数（`__cyreneRoot` / `__gitCommand` / `__gitSource` / `__gitVersion` /
`__gitIsolated` / `__gitIdentity` / `__sessionId`），模型参数里不可见也不被采用。

**GitService 外围责任划分**：
- 可执行探测（系统 → 随包 mingit + `GIT_CONFIG_NOSYSTEM=1` / `GIT_CONFIG_GLOBAL=NUL` 隔离）：
  仍由 TS `resolveGitExecutable` 完成（装配层缓存），native 调用时注入；C# 不做二次探测。
- 会话绑定（conversationId ↔ workspaceRoot）：TS `ToolContext` 解析后注入；C# 无会话状态。
- 并发/串行化：ToolHost 本身单线程 + NativeToolHost 串行闸门，天然串行；`maxConcurrentProcesses:1` 语义保持。
- 提交身份（设置项）：`GitService.getCommitIdentity()` 注入；C# 仅在 commit 的 `-c user.name/user.email` 使用。

**命令与解析**：逐条对齐 simple-git 3.36 的实际命令（`status --porcelain -b -u --null`、
`diff --stat=4096`、`branch -v`、`-c core.abbrev=40 commit -m`、`push --verbose --porcelain` 等），
解析器按 simple-git 源码逐字移植；输出 JSON 键序、错误语义与 TS 工具一致。

**取消**：沿用 ToolHost 方案——在途取消杀 host，AbortError 上抛不回退；已知限制：kill 只终止
宿主进程，长耗时的 git 子进程可能短暂孤儿化（后续如需要可用 Windows Job Object 兜底）。

**evidence（git_diff）**：沿用 evidence 帧协议 v1；C# 侧按 `diff --git` 分段 + `parseUnifiedPatch` 移植 +
`ToolEvidence.Finalize`（60/200/200）产出 `changes`，review 卡片不受影响。

## 3. 凭证边界（B1 / A20）

- 过渡期（当前）：push 完全走系统 git 的凭据链（credential helper / 环境变量），**不向 .NET 传递任何凭证**；
  随包 mingit 的隔离 env（NOSYSTEM/NUL）也一并保持——认证行为与 TS 现状逐字一致。
- A20 密钥库落地后：如引入托管凭据注入，走「TS 组装、宿主内存传递、不落盘」通道，并在此文档追加方案；
  当前实现不预埋任何明文凭证路径。
- 明确不做：不将 token/密码写入 git remote URL、不写 .NET 侧凭据文件、不在命令行回显凭证。

## 4. 测试策略

- **matrix（C# 直连，真实 git）**：临时仓库跑 init/status/diff/commit/log/switch/revert/push（本地 bare 远程）
  + not_repository / 校验失败 / 证据行序断言。
- **dual-track（TS↔NET 等价）**：镜像仓库 + 相同内部参数；输出逐字比对（commit/log 的 hash 归一化）；
  落盘/仓库状态快照比对；系统 git 环境变量（GIT_AUTHOR_*/GIT_COMMITTER_*）固定身份保证确定性。
- **单测**：`git-tools-native.test.ts`（wiring：内部参数注入、回退、取消不回退）；`git-tools.test.ts` 保持。

## 5. 分批

1. **T0（已交付）**：本设计稿 + C# `GitTools.cs`（runner + 解析器 + 8 工具）+
   ToolHost 路由 + TS 接线 + matrix/dual-track 基建。验证：matrix 79/79（git +23）、
   dual-track git 29/29（含截断/staged/路径限定/混合变更/错误路径）、
   `vitest src/main/orchestrator/tools` 446 passed、tsc 0 错误。
2. **残项（后续批次）**：冲突拒提交与空仓库 push 失败路径的 dual-track 用例；
   无凭据远端场景（T2 凭证复核）；A20 密钥库接入时更新 §3。
