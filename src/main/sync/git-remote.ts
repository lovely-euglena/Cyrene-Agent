/**
 * 桌面端 Git 仓库 remote 适配器（IKJN7B）。
 *
 * 形态定位（docs/design/2026-10-04-cloud-server-forms.md §4.3）：
 * - 每设备 append-only 分片 `events-<deviceId>.jsonl`，字节偏移增量读取（无全局游标）；
 * - push = 追加分片 + commit + push；fetch = pull + 读各分片新行；
 * - 合并 = eventId 幂等 + 规范序并集（`mergeSyncEvents`，与协议读取共用比较器）；
 * - 鉴权 = 仓库权限（私库 + PAT/SSH，经 remoteUrl 传入；错误信息统一脱敏，不外泄 URL）；
 * - 无服务端生成、无 PWA（桌面在线代生成）。
 *
 * 一致性策略（保守，不重写任何远端历史）：
 * - pull 用 `--rebase`（重放本地未推送提交）；失败一律 `rebase --abort` 后抛错；
 * - 强制推送（远端历史重写）后：分片前缀哈希失配或文件收缩 → 该分片回退全量重读，
 *   下游按 eventId 幂等并集，不丢不重；
 * - 半截尾行（写入中断）：读取只到最后一个换行；本设备追加前先修剪半截尾（自愈）；
 * - push 非原子（追加 → 提交 → 推送）：提交失败回滚本次追加（文件 + 暂存区）；无新事件
 *   或同批重试时先自愈——补提交未提交改动、补推未推送提交（不依赖下一次新事件顺带补完）；
 * - `.gitattributes` 固定 `*.jsonl -text`：文件已有但缺规则时自动追加（禁用行尾转换，保偏移语义）。
 *
 * 外部进程与取消：
 * - 所有 git 调用带无输出超时（`timeoutMs`，默认 120s；simple-git timeout.block）；
 * - 可经 `signal`（AbortSignal）取消（simple-git abort 插件）；
 * - 默认注入隔离环境：`GIT_CONFIG_NOSYSTEM=1` + 专用 `GIT_CONFIG_GLOBAL`（`<dir>/.git/cyrene-sync.gitconfig`）
 *   + `GIT_TERMINAL_PROMPT=0`（隔离用户全局配置与凭证提示；`env` 传入则完全覆盖默认）；
 * - simple-git 3.36 对可执行外部程序的 env/config 键默认拦截；本适配器按 argv-parser 全集显式放行
 *   对应 `unsafe` 开关（env 来源为可信进程环境），避免宿主 `PAGER` / `GIT_*` 键导致调用失败；
 * - 隔离全局配置会一并停用用户 `credential.helper`：HTTPS 鉴权走 `remoteUrl` 内联 PAT，SSH 走 agent
 *   （`SSH_AUTH_SOCK` 等进程 env 仍继承）——接线（IKJK2I）时需确认 token 路径已覆盖。
 *
 * 错误可重试分级（`GitRemoteError.code`）：
 * - 可重试：`git`（网络 / 未知）、`timeout`（无输出超时）、`push_rejected`（重推仍被拒）；
 * - 需处理：`conflict`（本地与远端分叉且无法自动重放）、`aborted`（调用方取消）、`invalid_config`。
 *
 * 错误行号语义：`fetch` / `clone` 的 `errors[].index` 为**分片文件内 0 基物理行号**
 * （与协议 `SyncReadError.index` 同口径，可跨次读取映射回文件位置）。
 *
 * 本模块是纯适配器（不接线 UI、不落盘同步状态）：fetchState（每分片 {offset, prefixHash}）
 * 由调用方持有并回传；桌面端同步客户端（IKJK2I）后续接入。
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { compareSyncEvents, readSyncBatch, type SyncErrorCode, type SyncEventV0 } from "./sync-protocol";

export const SYNC_SHARD_PREFIX = "events-";
export const SYNC_SHARD_SUFFIX = ".jsonl";
const DEFAULT_BRANCH = "main";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_AUTHOR = { name: "cyrene-sync", email: "sync@cyrene.local" };
const GITATTRIBUTES_RULE = "*.jsonl -text";
const GITATTRIBUTES_CONTENT = `# 同步分片按字节偏移读取：禁用行尾转换（CRLF 会破坏偏移语义）\n${GITATTRIBUTES_RULE}\n`;
const GLOBAL_CONFIG_FILE = "cyrene-sync.gitconfig";
const REMOTE_REF_MISSING = /couldn't find remote ref|could not find remote ref|no such ref|not our ref/i;
const NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]/i;
const CONFLICT_LIKE = /conflict|could not apply|could not pop/i;
const TIMEOUT_LIKE = /timed? ?out|timeout|killed/i;

export interface GitRemoteConfig {
  /** 本地工作副本目录（不存在则创建；空目录 + remoteUrl 时 clone）。 */
  dir: string;
  /** 本设备 id（分片文件名 `events-<deviceId>.jsonl`；限 `[A-Za-z0-9._-]`）。 */
  deviceId: string;
  /** 远端 URL（http(s)/ssh/git/file / 本地路径 / scp 风格；缺省 = 纯本地模式）。 */
  remoteUrl?: string;
  /** 分支（默认 main；不允许前导 `-` / `..` / 尾斜杠）。 */
  branch?: string;
  /** 提交身份（默认 cyrene-sync / sync@cyrene.local）。 */
  author?: { name?: string; email?: string };
  /** git 可执行文件（默认 "git"；应用内传解析结果，含内置 git）。 */
  gitBinary?: string;
  /** git 子进程环境；缺省注入隔离环境（NOSYSTEM + 专用 GLOBAL + 禁终端提示）。 */
  env?: NodeJS.ProcessEnv;
  /** 单条 git 命令无输出超时（毫秒；默认 120000）。 */
  timeoutMs?: number;
  /** 取消信号（外部中止入口；中止后错误码为 `aborted`）。 */
  signal?: AbortSignal;
}

/** 单分片读取位点：offset = 已读字节数（始终落在行边界），prefixHash = sha256(bytes[0..offset))。 */
export interface ShardState {
  offset: number;
  prefixHash: string;
}

/** 各分片读取位点（deviceId → state）；由调用方持有并跨调用回传。 */
export type FetchState = Record<string, ShardState>;

export interface GitPushOutcome {
  /** 本次新追加的事件数。 */
  appended: number;
  /** 因 eventId 已在本设备分片中存在而跳过的事件数。 */
  skipped: number;
  /** 本次是否执行了远端 push（含自愈补推；纯本地模式为 false）。 */
  pushed: boolean;
  /** 本次（或自愈补提交）的提交 hash；无提交时为 null。 */
  commit: string | null;
}

export interface GitFetchOutcome {
  /** 各分片本次读到的新事件（分片内已校验/去重/规范序；跨分片合并由调用方做）。 */
  events: SyncEventV0[];
  /** 新的读取位点（原样回传即可）。 */
  state: FetchState;
  /** 因历史重写/文件收缩而回退全量重读的分片 deviceId。 */
  reread: string[];
  /** 坏行上报（deviceId + 分片文件内 0 基物理行号）。 */
  errors: Array<{ deviceId: string; index: number; code: SyncErrorCode }>;
}

export interface GitCloneOutcome {
  /** 全部分片合并后的事件（eventId 幂等 + 规范序）。 */
  events: SyncEventV0[];
  state: FetchState;
  /** 坏行上报（与 fetch 同口径）。 */
  errors: Array<{ deviceId: string; index: number; code: SyncErrorCode }>;
}

export class GitRemoteError extends Error {
  constructor(
    readonly code: "invalid_config" | "conflict" | "push_rejected" | "timeout" | "aborted" | "git",
    message: string,
  ) {
    super(message);
    this.name = "GitRemoteError";
  }
}

export class GitRepoRemote {
  private gitClient: SimpleGit | null = null;
  private initialized = false;

  constructor(private readonly config: GitRemoteConfig) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(config.deviceId)) {
      throw new GitRemoteError("invalid_config", "deviceId 只能包含字母/数字/._-（1-64 字符）");
    }
    if (config.remoteUrl !== undefined && !isValidRemoteUrl(config.remoteUrl)) {
      throw new GitRemoteError(
        "invalid_config",
        "remoteUrl 仅支持 http(s)/ssh/git/file / 本地路径 / scp 风格，且不得以 - 开头、含空白或 :: 协议形式",
      );
    }
    const branch = config.branch?.trim();
    if (branch !== undefined && branch !== "" && !isValidBranch(branch)) {
      throw new GitRemoteError("invalid_config", "branch 含非法字符（不允许前导 - / .. / 尾斜杠 / .lock）");
    }
    if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)) {
      throw new GitRemoteError("invalid_config", "timeoutMs 必须为正数（毫秒）");
    }
  }

  /** simple-git 实例（惰性创建：构造时目录可能尚不存在）。 */
  private get git(): SimpleGit {
    if (this.gitClient === null) {
      mkdirSync(this.config.dir, { recursive: true });
      const client = simpleGit({
        baseDir: this.config.dir,
        binary: this.config.gitBinary ?? "git",
        maxConcurrentProcesses: 1,
        config: buildGitConfig(this.config.dir, this.config.author),
        timeout: { block: this.timeoutMs },
        // simple-git 默认拦截可执行外部程序的 env/config 键（来源不可信假设）。本适配器的
        // env 来自应用进程 / 调用方（可信），且隔离配置路径由本适配器构造；命令均非交互。
        // 开关覆盖 @simple-git/argv-parser 的 env 键全集（避免宿主 PAGER / GIT_* 等键导致全部调用失败）：
        unsafe: {
          allowUnsafeConfigPaths: true, // GIT_CONFIG_GLOBAL / GIT_CONFIG_NOSYSTEM / GIT_EXEC_PATH / PREFIX
          allowUnsafeConfigEnvCount: true, // GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* / GIT_CONFIG_VALUE_*
          allowUnsafeEditor: true, // EDITOR / GIT_EDITOR / GIT_SEQUENCE_EDITOR（命令均带 -m / 非交互）
          allowUnsafePager: true, // PAGER / GIT_PAGER（子进程 stdout 为管道，不会实际分页）
          allowUnsafeDiffExternal: true, // GIT_EXTERNAL_DIFF（本适配器只跑 --name-only，不触发内容 diff）
          allowUnsafeGitProxy: true, // GIT_PROXY_COMMAND（仅 git:// 传输使用）
          allowUnsafeTemplateDir: true, // GIT_TEMPLATE_DIR（init/clone 模板目录）
          allowUnsafeSshCommand: true, // GIT_SSH / GIT_SSH_COMMAND（SSH remote 依赖）
          allowUnsafeAskPass: true, // GIT_ASKPASS / SSH_ASKPASS（凭证助手）
        },
        ...(this.config.signal !== undefined ? { abort: this.config.signal } : {}),
      });
      client.env(this.config.env ?? defaultIsolationEnv(this.config.dir));
      this.gitClient = client;
    }
    return this.gitClient;
  }

  private get timeoutMs(): number {
    return this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get dir(): string {
    return this.config.dir;
  }

  get deviceId(): string {
    return this.config.deviceId;
  }

  get shardName(): string {
    return `${SYNC_SHARD_PREFIX}${this.config.deviceId}${SYNC_SHARD_SUFFIX}`;
  }

  private get shardPath(): string {
    return path.join(this.config.dir, this.shardName);
  }

  private get branch(): string {
    return this.config.branch?.trim() || DEFAULT_BRANCH;
  }

  /** 初始化工作副本（幂等）：clone/init、分支对齐、`.gitattributes`、origin、隔离配置。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.config.dir, { recursive: true });
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      if (this.config.remoteUrl) {
        // 空远端亦可 clone（无 refs 时仅建立 origin/HEAD）；目标目录须为空
        await this.runGit(["clone", this.config.remoteUrl, "."], "clone");
      } else {
        await this.runGit(["init", "-b", this.branch], "init");
      }
    }
    const current = (await this.runGit(["branch", "--show-current"], "branch")).trim();
    if (current !== this.branch) {
      const exists = (await this.runGit(["branch", "--list", this.branch], "branch")).trim().length > 0;
      await this.runGit(exists ? ["checkout", this.branch] : ["checkout", "-b", this.branch], "checkout");
    }
    if (this.config.remoteUrl) {
      const remotes = await this.git.getRemotes(true).catch(() => []);
      const origin = remotes.find((remote) => remote.name === "origin");
      if (!origin) await this.runGit(["remote", "add", "origin", this.config.remoteUrl], "remote add");
      else if (origin.refs?.fetch !== this.config.remoteUrl) {
        await this.runGit(["remote", "set-url", "origin", this.config.remoteUrl], "remote set-url");
      }
    }
    if (this.config.env === undefined) {
      // 专用全局配置落盘（隔离用户 ~/.gitconfig；文件不存在时 git 视为空配置）
      const globalConfigPath = path.join(this.config.dir, ".git", GLOBAL_CONFIG_FILE);
      if (!existsSync(globalConfigPath)) {
        mkdirSync(path.dirname(globalConfigPath), { recursive: true });
        writeFileSync(globalConfigPath, "# cyrene-sync 专用全局配置（隔离用户全局 git 配置）\n", "utf8");
      }
    }
    const attributesPath = path.join(this.config.dir, ".gitattributes");
    const currentAttributes = existsSync(attributesPath) ? readFileSync(attributesPath, "utf8") : null;
    let attributesChanged = false;
    if (currentAttributes === null) {
      writeFileSync(attributesPath, GITATTRIBUTES_CONTENT, "utf8");
      attributesChanged = true;
    } else if (!hasShardAttributeRule(currentAttributes)) {
      const separator = currentAttributes.endsWith("\n") || currentAttributes.length === 0 ? "" : "\n";
      writeFileSync(
        attributesPath,
        `${currentAttributes}${separator}# 由 cyrene-sync 追加：分片按字节偏移读取\n${GITATTRIBUTES_RULE}\n`,
        "utf8",
      );
      attributesChanged = true;
    }
    if (attributesChanged) {
      await this.runGit(["add", "--", ".gitattributes"], "add");
      const staged = (await this.runGit(["diff", "--cached", "--name-only"], "diff")).trim();
      if (staged.length > 0) {
        await this.runGit(["commit", "-m", "chore(sync): 分片行尾规则（*.jsonl -text）"], "commit");
      }
    }
    this.initialized = true;
  }

  /** push：追加本设备分片 → commit → （有远端时）pull --rebase + push；失败自愈见文件头。 */
  async push(events: readonly SyncEventV0[]): Promise<GitPushOutcome> {
    await this.init();
    const existing = this.readExistingEventIds(this.shardPath);
    const fresh = events.filter((event) => !existing.has(event.eventId));
    const skipped = events.length - fresh.length;
    if (fresh.length === 0) {
      // 无新事件：先自愈（补提交未提交改动 / 补推未推送提交），避免悬挂状态滞留
      const healed = await this.healPendingState();
      return { appended: 0, skipped, pushed: healed.pushed, commit: healed.commit };
    }
    const previousBytes = existsSync(this.shardPath) ? readFileSync(this.shardPath) : null;
    this.appendShard(this.shardPath, fresh);
    try {
      await this.git.raw(["add", "--", this.shardName]);
      await this.git.raw(["commit", "-m", `sync(${this.config.deviceId}): +${fresh.length} events`]);
    } catch (error) {
      // 提交失败：回滚本次追加（文件 + 暂存区），避免留下悬挂未提交行
      await this.git.raw(["reset", "--", this.shardName]).catch(() => undefined);
      if (previousBytes === null) rmSync(this.shardPath, { force: true });
      else writeFileSync(this.shardPath, previousBytes);
      throw this.toGitError(error, "commit");
    }
    const commit = (await this.git.raw(["rev-parse", "HEAD"])).trim();
    let pushed = false;
    if (this.config.remoteUrl) {
      await this.pullThenPush();
      pushed = true;
    }
    return { appended: fresh.length, skipped, pushed, commit };
  }

  /** fetch：pull + 读各分片自上次位点起的新行（跨分片合并由调用方做）。 */
  async fetch(state: FetchState = {}): Promise<GitFetchOutcome> {
    await this.init();
    if (this.config.remoteUrl) await this.pullOnly();
    const nextState: FetchState = { ...state };
    const events: SyncEventV0[] = [];
    const errors: GitFetchOutcome["errors"] = [];
    const reread: string[] = [];
    for (const { deviceId, file } of this.listShards()) {
      const bytes = readFileSync(file);
      const stored = state[deviceId];
      let offset = stored?.offset ?? 0;
      const prefixHash = offset > 0 ? sha256Hex(bytes.subarray(0, offset)) : null;
      if (offset > bytes.length || (prefixHash !== null && prefixHash !== stored?.prefixHash)) {
        // 历史重写 / 文件收缩：回退全量重读（下游 eventId 幂等，不丢不重）
        offset = 0;
        reread.push(deviceId);
      }
      const end = Math.max(offset, lastNewlineEnd(bytes));
      const chunk = bytes.subarray(offset, end);
      if (chunk.length > 0) {
        const batch = readSyncBatch(chunk.toString("utf8"));
        events.push(...batch.events);
        const lineBase = countNewlines(bytes.subarray(0, offset));
        for (const error of batch.errors) {
          errors.push({ deviceId, index: lineBase + error.index, code: error.code });
        }
      }
      nextState[deviceId] = { offset: end, prefixHash: sha256Hex(bytes.subarray(0, end)) };
    }
    return { events, state: nextState, reread, errors };
  }

  /** clone：pull + 全量读取所有分片，返回合并后的事件、全新位点与坏行清单。 */
  async clone(): Promise<GitCloneOutcome> {
    await this.init();
    if (this.config.remoteUrl) await this.pullOnly();
    const lists: SyncEventV0[][] = [];
    const state: FetchState = {};
    const errors: GitCloneOutcome["errors"] = [];
    for (const { deviceId, file } of this.listShards()) {
      const bytes = readFileSync(file);
      const end = lastNewlineEnd(bytes);
      const batch = readSyncBatch(bytes.subarray(0, end).toString("utf8"));
      lists.push(batch.events);
      for (const error of batch.errors) errors.push({ deviceId, index: error.index, code: error.code });
      state[deviceId] = { offset: end, prefixHash: sha256Hex(bytes.subarray(0, end)) };
    }
    return { events: mergeSyncEvents(...lists), state, errors };
  }

  // ── 远端同步（保守） ──

  /** pull --rebase：远端缺分支（空仓库）视为无事；其余失败一律中止后抛错（分级见文件头）。 */
  private async pullOnly(): Promise<void> {
    try {
      await this.git.raw(["pull", "--rebase", "origin", this.branch]);
    } catch (error) {
      const message = this.sanitize(errorText(error));
      if (REMOTE_REF_MISSING.test(message)) return;
      await this.git.raw(["rebase", "--abort"]).catch(() => undefined);
      if (CONFLICT_LIKE.test(message)) {
        throw new GitRemoteError("conflict", `pull 分叉无法自动重放（已保守中止，未重写任何历史）：${message}`);
      }
      throw this.toGitError(error, "pull");
    }
  }

  private async pullThenPush(): Promise<void> {
    await this.pullOnly();
    try {
      await this.git.raw(["push", "origin", this.branch]);
    } catch (error) {
      const message = this.sanitize(errorText(error));
      if (!NON_FAST_FORWARD.test(message)) throw this.toGitError(error, "push");
      // 竞态（pull 后远端又被推进）：再 pull --rebase 一次并重推；仍失败则保守放弃
      await this.pullOnly();
      try {
        await this.git.raw(["push", "origin", this.branch]);
      } catch (retry) {
        throw new GitRemoteError("push_rejected", `push 被拒（已重试一次）：${this.sanitize(errorText(retry))}`);
      }
    }
  }

  /**
   * 自愈：补提交未提交的分片改动；有远端时补推未推送提交。
   * 覆盖 push 半途失败场景（commit 失败回滚后不会悬挂；推送失败留下的本地提交在此补推）。
   */
  private async healPendingState(): Promise<{ pushed: boolean; commit: string | null }> {
    let commit: string | null = null;
    // 先按 appendShard 同规则修剪半截尾行，避免自愈把未完成行固化进历史
    this.trimPartialTail(this.shardPath);
    const status = (await this.git.raw(["status", "--porcelain", "--", this.shardName])).trim();
    if (status.length > 0) {
      await this.runGit(["add", "--", this.shardName], "add");
      await this.runGit(["commit", "-m", `sync(${this.config.deviceId}): 补提交（自愈）`], "commit");
      commit = (await this.git.raw(["rev-parse", "HEAD"])).trim();
    }
    if (!this.config.remoteUrl) return { pushed: false, commit };
    const ahead = await this.countUnpushedCommits();
    if (ahead > 0) {
      await this.pullThenPush();
      return { pushed: true, commit: commit ?? (await this.git.raw(["rev-parse", "HEAD"])).trim() };
    }
    return { pushed: false, commit };
  }

  private async countUnpushedCommits(): Promise<number> {
    try {
      const output = await this.git.raw(["rev-list", "--count", `origin/${this.branch}..HEAD`]);
      return Number(output.trim()) || 0;
    } catch {
      // origin/<branch> 尚不存在（首次推送前）：有本地提交即视为待推送
      const head = await this.git.raw(["rev-parse", "--verify", "HEAD"]).catch(() => "");
      return head.trim().length > 0 ? 1 : 0;
    }
  }

  // ── 分片文件 ──

  private appendShard(shardPath: string, events: readonly SyncEventV0[]): void {
    this.trimPartialTail(shardPath);
    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    appendFileSync(shardPath, Buffer.from(text, "utf8"));
  }

  /** 修剪半截尾行（写入中断自愈：只保留到最后一个换行）；返回是否发生修剪。 */
  private trimPartialTail(shardPath: string): boolean {
    if (!existsSync(shardPath)) return false;
    const bytes = readFileSync(shardPath);
    const end = lastNewlineEnd(bytes);
    if (end < bytes.length) {
      writeFileSync(shardPath, bytes.subarray(0, end));
      return true;
    }
    return false;
  }

  private readExistingEventIds(shardPath: string): Set<string> {
    const ids = new Set<string>();
    if (!existsSync(shardPath)) return ids;
    const bytes = readFileSync(shardPath);
    const end = lastNewlineEnd(bytes);
    if (end === 0) return ids;
    for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const value = JSON.parse(trimmed) as { eventId?: unknown };
        if (typeof value?.eventId === "string") ids.add(value.eventId);
      } catch {
        // 坏行忽略：读取路径会统一校验并上报
      }
    }
    return ids;
  }

  private listShards(): Array<{ deviceId: string; file: string }> {
    const shards: Array<{ deviceId: string; file: string }> = [];
    for (const name of readdirSync(this.config.dir)) {
      if (!name.startsWith(SYNC_SHARD_PREFIX) || !name.endsWith(SYNC_SHARD_SUFFIX)) continue;
      const deviceId = name.slice(SYNC_SHARD_PREFIX.length, -SYNC_SHARD_SUFFIX.length);
      if (!deviceId) continue;
      const file = path.join(this.config.dir, name);
      if (!statSync(file).isFile()) continue;
      shards.push({ deviceId, file });
    }
    return shards.sort((left, right) => ordinalCompare(left.deviceId, right.deviceId));
  }

  // ── 错误与脱敏 ──

  /** 执行 git 命令并把失败统一转成脱敏的 GitRemoteError（action 为人类可读动作名）。 */
  private async runGit(args: string[], action: string): Promise<string> {
    try {
      return await this.git.raw(args);
    } catch (error) {
      throw this.toGitError(error, `git ${action}`);
    }
  }

  /** 失败分类：aborted / timeout / git（可重试分级见文件头）。 */
  private toGitError(error: unknown, action: string): GitRemoteError {
    const message = this.sanitize(errorText(error));
    if (this.config.signal?.aborted) {
      return new GitRemoteError("aborted", `${action} 已取消：${message}`);
    }
    if (TIMEOUT_LIKE.test(message)) {
      return new GitRemoteError("timeout", `${action} 超时（${this.timeoutMs}ms 无输出）：${message}`);
    }
    return new GitRemoteError("git", `${action} 失败：${message}`);
  }

  /** 脱敏：覆盖 remoteUrl 及其常见变形（尾斜杠 / 去 scheme），避免 URL 进入错误信息与日志。 */
  private sanitize(message: string): string {
    const url = this.config.remoteUrl;
    if (!url) return message;
    const variants = new Set<string>([url]);
    const trimmed = url.replace(/\/+$/u, "");
    if (trimmed.length > 0) variants.add(trimmed);
    const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "");
    if (withoutScheme.length > 0 && withoutScheme !== trimmed) variants.add(withoutScheme);
    let result = message;
    for (const variant of variants) {
      result = result.split(variant).join("<remote>");
    }
    return result;
  }
}

/** 合并（eventId 幂等：首见胜出）+ 规范序（与协议读取共用比较器，避免漂移）。 */
export function mergeSyncEvents(...lists: ReadonlyArray<readonly SyncEventV0[]>): SyncEventV0[] {
  const seen = new Set<string>();
  const merged: SyncEventV0[] = [];
  for (const list of lists) {
    for (const event of list) {
      if (seen.has(event.eventId)) continue;
      seen.add(event.eventId);
      merged.push(event);
    }
  }
  return merged.sort(compareSyncEvents);
}

// ── 模块级辅助 ──

function buildGitConfig(dir: string, author: GitRemoteConfig["author"]): string[] {
  const name = author?.name?.trim() || DEFAULT_AUTHOR.name;
  const email = author?.email?.trim() || DEFAULT_AUTHOR.email;
  const forward = dir.replace(/\\/g, "/");
  return [
    `safe.directory=${dir}`,
    `safe.directory=${forward}`,
    `user.name=${name}`,
    `user.email=${email}`,
  ];
}

/** 默认隔离环境：屏蔽系统/用户全局 git 配置与终端凭证提示（`env` 传入则完全覆盖默认）。 */
function defaultIsolationEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, ".git", GLOBAL_CONFIG_FILE),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function hasShardAttributeRule(content: string): boolean {
  return content.split(/\r?\n/u).some((line) => /^\s*\*\.jsonl\s+-text\s*$/u.test(line));
}

function isValidRemoteUrl(url: string): boolean {
  // 拒绝：空 / 前导 -（选项注入）/ 空白（含空格路径不受支持——如需要请传自定义 gitBinary 方案）/
  // transport::address 形式（如 ext::<cmd> 可执行任意命令；IPv6 字面量不受影响）
  if (url.length === 0 || url.startsWith("-") || /[\s\u0000-\u001f]/u.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*::/iu.test(url)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    return /^(https?|ssh|git|file):\/\//iu.test(url);
  }
  return true; // 本地路径 / scp 风格（git@host:path）
}

function isValidBranch(branch: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u.test(branch)) return false;
  return !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
}

/** 最后一个换行后的字节位置（0 = 无完整行）；半截尾行不计入。 */
function lastNewlineEnd(bytes: Uint8Array): number {
  const index = bytes.lastIndexOf(0x0a);
  return index < 0 ? 0 : index + 1;
}

function countNewlines(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0x0a) count++;
  }
  return count;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
