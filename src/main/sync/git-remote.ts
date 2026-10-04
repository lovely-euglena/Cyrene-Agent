/**
 * 桌面端 Git 仓库 remote 适配器（IKJN7B）。
 *
 * 形态定位（docs/design/2026-10-04-cloud-server-forms.md §4.3）：
 * - 每设备 append-only 分片 `events-<deviceId>.jsonl`，字节偏移增量读取（无全局游标）；
 * - push = 追加分片 + commit + push；fetch = pull + 读各分片新行；
 * - 合并 = eventId 幂等 + 规范序并集（`mergeSyncEvents`）；
 * - 鉴权 = 仓库权限（私库 + PAT/SSH，经 remoteUrl 传入，不外泄日志）；
 * - 无服务端生成、无 PWA（桌面在线代生成）。
 *
 * 一致性策略（保守，不重写任何远端历史）：
 * - pull 用 `--rebase`（重放本地未推送提交）；失败/冲突一律 `rebase --abort` + 抛错；
 * - 强制推送（远端历史重写）后：分片前缀哈希失配或文件收缩 → 该分片回退全量重读，
 *   下游按 eventId 幂等并集，不丢不重；
 * - 半截尾行（写入中断）：读取只到最后一个换行；本设备追加前先修剪半截尾（自愈）；
 * - `.gitattributes` 固定 `*.jsonl -text`：禁用行尾转换（CRLF 会破坏字节偏移语义）。
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
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import simpleGit, { type SimpleGit } from "simple-git";
import { readSyncBatch, type SyncEventV0 } from "./sync-protocol";

export const SYNC_SHARD_PREFIX = "events-";
export const SYNC_SHARD_SUFFIX = ".jsonl";
const DEFAULT_BRANCH = "main";
const DEFAULT_AUTHOR = { name: "cyrene-sync", email: "sync@cyrene.local" };
const GITATTRIBUTES_CONTENT =
  "# 同步分片按字节偏移读取：禁用行尾转换（CRLF 会破坏偏移语义）\n*.jsonl -text\n";
const REMOTE_REF_MISSING = /couldn't find remote ref|could not find remote ref|no such ref|not our ref/i;
const NON_FAST_FORWARD = /non-fast-forward|fetch first|\[rejected\]/i;

export interface GitRemoteConfig {
  /** 本地工作副本目录（不存在则创建；空目录 + remoteUrl 时 clone）。 */
  dir: string;
  /** 本设备 id（分片文件名 `events-<deviceId>.jsonl`；限 `[A-Za-z0-9._-]`）。 */
  deviceId: string;
  /** 远端 URL（https+PAT / SSH；缺省 = 纯本地模式，push 仅提交）。 */
  remoteUrl?: string;
  /** 分支（默认 main）。 */
  branch?: string;
  /** 提交身份（默认 cyrene-sync / sync@cyrene.local）。 */
  author?: { name?: string; email?: string };
  /** git 可执行文件（默认 "git"；应用内传解析结果，含内置 git）。 */
  gitBinary?: string;
  /** git 子进程环境（内置 git 的隔离 env 等）。 */
  env?: NodeJS.ProcessEnv;
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
  /** 是否执行了远端 push（纯本地模式为 false）。 */
  pushed: boolean;
  /** 本次提交 hash（无新事件时为 null）。 */
  commit: string | null;
}

export interface GitFetchOutcome {
  /** 各分片本次读到的新事件（分片内已校验/去重/规范序；跨分片合并由调用方做）。 */
  events: SyncEventV0[];
  /** 新的读取位点（原样回传即可）。 */
  state: FetchState;
  /** 因历史重写/文件收缩而回退全量重读的分片 deviceId。 */
  reread: string[];
  /** 坏行上报（deviceId + 读取块内 0 基行号）。 */
  errors: Array<{ deviceId: string; index: number; code: string }>;
}

export interface GitCloneOutcome {
  /** 全部分片合并后的事件（eventId 幂等 + 规范序）。 */
  events: SyncEventV0[];
  state: FetchState;
}

export class GitRemoteError extends Error {
  constructor(
    readonly code: "invalid_config" | "conflict" | "push_rejected" | "git",
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
      });
      if (this.config.env) client.env(this.config.env);
      this.gitClient = client;
    }
    return this.gitClient;
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

  /** 初始化工作副本（幂等）：clone/init、分支对齐、`.gitattributes`、origin。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    mkdirSync(this.config.dir, { recursive: true });
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      if (this.config.remoteUrl) {
        // 空远端亦可 clone（无 refs 时仅建立 origin/HEAD）；目标目录须为空
        await this.git.raw(["clone", this.config.remoteUrl, "."]);
      } else {
        await this.git.raw(["init", "-b", this.branch]);
      }
    }
    const current = (await this.git.raw(["branch", "--show-current"])).trim();
    if (current !== this.branch) {
      const exists = (await this.git.raw(["branch", "--list", this.branch])).trim().length > 0;
      await this.git.raw(exists ? ["checkout", this.branch] : ["checkout", "-b", this.branch]);
    }
    if (this.config.remoteUrl) {
      const remotes = await this.git.getRemotes(true).catch(() => []);
      const origin = remotes.find((remote) => remote.name === "origin");
      if (!origin) await this.git.raw(["remote", "add", "origin", this.config.remoteUrl]);
      else if (origin.refs?.fetch !== this.config.remoteUrl) {
        await this.git.raw(["remote", "set-url", "origin", this.config.remoteUrl]);
      }
    }
    const attributesPath = path.join(this.config.dir, ".gitattributes");
    if (!existsSync(attributesPath)) {
      writeFileSync(attributesPath, GITATTRIBUTES_CONTENT, "utf8");
      await this.git.raw(["add", "--", ".gitattributes"]);
      const staged = (await this.git.raw(["diff", "--cached", "--name-only"])).trim();
      if (staged.length > 0) {
        await this.git.raw(["commit", "-m", "chore(sync): 分片行尾规则（*.jsonl -text）"]);
      }
    }
    this.initialized = true;
  }

  /** push：追加本设备分片 → commit → （有远端时）pull --rebase + push。 */
  async push(events: readonly SyncEventV0[]): Promise<GitPushOutcome> {
    await this.init();
    if (events.length === 0) return { appended: 0, skipped: 0, pushed: false, commit: null };
    const existing = this.readExistingEventIds(this.shardPath);
    const fresh = events.filter((event) => !existing.has(event.eventId));
    const skipped = events.length - fresh.length;
    if (fresh.length === 0) return { appended: 0, skipped, pushed: false, commit: null };
    this.appendShard(this.shardPath, fresh);
    await this.git.raw(["add", "--", this.shardName]);
    await this.git.raw(["commit", "-m", `sync(${this.config.deviceId}): +${fresh.length} events`]);
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
        for (const error of batch.errors) errors.push({ deviceId, index: error.index, code: error.code });
      }
      nextState[deviceId] = { offset: end, prefixHash: sha256Hex(bytes.subarray(0, end)) };
    }
    return { events, state: nextState, reread, errors };
  }

  /** clone：pull + 全量读取所有分片，返回合并后的事件与全新位点。 */
  async clone(): Promise<GitCloneOutcome> {
    await this.init();
    if (this.config.remoteUrl) await this.pullOnly();
    const lists: SyncEventV0[][] = [];
    const state: FetchState = {};
    for (const { deviceId, file } of this.listShards()) {
      const bytes = readFileSync(file);
      const end = lastNewlineEnd(bytes);
      lists.push(readSyncBatch(bytes.subarray(0, end).toString("utf8")).events);
      state[deviceId] = { offset: end, prefixHash: sha256Hex(bytes.subarray(0, end)) };
    }
    return { events: mergeSyncEvents(...lists), state };
  }

  // ── 远端同步（保守） ──

  /** pull --rebase：远端缺分支（空仓库）视为无事；其余失败一律中止并抛错。 */
  private async pullOnly(): Promise<void> {
    try {
      await this.git.raw(["pull", "--rebase", "origin", this.branch]);
    } catch (error) {
      const message = this.sanitize(errorText(error));
      if (REMOTE_REF_MISSING.test(message)) return;
      await this.git.raw(["rebase", "--abort"]).catch(() => undefined);
      throw new GitRemoteError("conflict", `pull 失败（已保守中止，未重写任何历史）：${message}`);
    }
  }

  private async pullThenPush(): Promise<void> {
    await this.pullOnly();
    try {
      await this.git.raw(["push", "origin", this.branch]);
    } catch (error) {
      const message = this.sanitize(errorText(error));
      if (!NON_FAST_FORWARD.test(message)) {
        throw new GitRemoteError("git", `push 失败：${message}`);
      }
      // 竞态（pull 后远端又被推进）：再 pull --rebase 一次并重推；仍失败则保守放弃
      await this.pullOnly();
      try {
        await this.git.raw(["push", "origin", this.branch]);
      } catch (retry) {
        throw new GitRemoteError(
          "push_rejected",
          `push 被拒（已重试一次）：${this.sanitize(errorText(retry))}`,
        );
      }
    }
  }

  // ── 分片文件 ──

  private appendShard(shardPath: string, events: readonly SyncEventV0[]): void {
    if (existsSync(shardPath)) {
      // 自愈：上次写入中断留下半截尾行 → 先修剪到最后一个换行
      const bytes = readFileSync(shardPath);
      const end = lastNewlineEnd(bytes);
      if (end < bytes.length) writeFileSync(shardPath, bytes.subarray(0, end));
    }
    const text = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    appendFileSync(shardPath, Buffer.from(text, "utf8"));
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

  private sanitize(message: string): string {
    const url = this.config.remoteUrl;
    return url ? message.split(url).join("<remote>") : message;
  }
}

/** 合并（eventId 幂等：首见胜出）+ 规范序 (lamport, deviceId Ordinal, seq)。 */
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
  return merged.sort(
    (left, right) =>
      left.lamport - right.lamport || ordinalCompare(left.deviceId, right.deviceId) || left.seq - right.seq,
  );
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

/** 最后一个换行后的字节位置（0 = 无完整行）；半截尾行不计入。 */
function lastNewlineEnd(bytes: Uint8Array): number {
  const index = bytes.lastIndexOf(0x0a);
  return index < 0 ? 0 : index + 1;
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
