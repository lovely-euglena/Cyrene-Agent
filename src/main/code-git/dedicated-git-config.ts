import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * 独立 Git 配置文件（IKJMO8）：应用自管的 `<userData>/git/config`。
 *
 * - 优先级（低 → 高）：全局配置副本（「一键复制」快照） → 实时 include 用户全局配置
 *   （凭据 helper 等） → Cyrene 身份/初始化覆盖（永远最后生效）；
 * - 开关打开时（默认开），所有 git 调用经 `GIT_CONFIG_GLOBAL` 指向本文件
 *   （TS 客户端 env / native 内部参数 `__gitConfigGlobal` / C# RunGit env）；
 * - 开关关闭时本文件不被使用，行为维持原状（内置 git NUL 隔离、系统 git 跟随全局）。
 */

const SNAPSHOT_BEGIN = "# ── BEGIN GLOBAL SNAPSHOT（一键复制，勿手改）──";
const SNAPSHOT_END = "# ── END GLOBAL SNAPSHOT ──";

export interface DedicatedGitConfigInputs {
  userDataDir: string;
  name: string;
  email: string;
  /** 全局配置副本：undefined = 保留文件内既有快照；null = 明确无快照；字符串 = 新快照 */
  snapshot?: string | null;
}

export interface CopyGlobalResult {
  ok: boolean;
  /** 实际复制到的全局配置文件路径 */
  copied: string[];
  /** 独立配置文件路径 */
  path: string;
  message?: string;
}

export function dedicatedGitConfigPath(userDataDir: string): string {
  return path.join(userDataDir, "git", "config");
}

/** 用户全局配置文件候选（git 默认读取位置；不存在的会被 include 静默忽略）。 */
export function globalGitConfigCandidates(homeDir: string = os.homedir()): string[] {
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return [
    path.join(homeDir, ".gitconfig"),
    ...(xdg ? [path.join(xdg, "git", "config")] : []),
    path.join(homeDir, ".config", "git", "config"),
  ];
}

/** 从既有文件内容中提取「一键复制」快照（无则 null）。 */
export function extractSnapshot(content: string): string | null {
  const begin = content.indexOf(SNAPSHOT_BEGIN);
  const end = content.indexOf(SNAPSHOT_END);
  if (begin < 0 || end < 0 || end <= begin) return null;
  const body = content.slice(begin + SNAPSHOT_BEGIN.length, end).trim();
  return body.length > 0 ? body : null;
}

/** 渲染独立配置文件内容（确定性、可测）。 */
export function renderDedicatedGitConfig(inputs: DedicatedGitConfigInputs): string {
  const lines: string[] = [
    "# ═══ Cyrene 独立 Git 配置（应用自动维护，手改会在下次保存设置时被覆盖）═══",
    "# 开关：设置 → 通用 → Git 提交身份 → 「使用独立 Git 配置文件」",
    "# 优先级（低 → 高）：全局配置副本（一键复制） → 实时 include 用户全局配置 → Cyrene 身份/初始化",
    `# 生成时间：${new Date().toISOString()}`,
    "",
  ];
  if (inputs.snapshot && inputs.snapshot.trim().length > 0) {
    lines.push(SNAPSHOT_BEGIN, inputs.snapshot.trim(), SNAPSHOT_END, "");
  }
  lines.push(
    "# ── 用户全局配置（实时继承：凭据 helper 等；文件不存在时 git 静默忽略）──",
    "[include]",
    "\tpath = ~/.gitconfig",
    "[include]",
    "\tpath = ~/.config/git/config",
    "",
    "# ── Cyrene 覆盖（设置 → Git 提交身份）──",
    "[user]",
    `\tname = ${quoteConfigValue(inputs.name)}`,
    `\temail = ${quoteConfigValue(inputs.email)}`,
    "[init]",
    "\tdefaultBranch = main",
    "",
  );
  return lines.join("\n");
}

/** 生成/刷新独立配置文件；snapshot 未提供时保留文件内既有快照。返回文件路径。 */
export function syncDedicatedGitConfig(inputs: DedicatedGitConfigInputs): string {
  const filePath = dedicatedGitConfigPath(inputs.userDataDir);
  let snapshot = inputs.snapshot;
  if (snapshot === undefined) {
    snapshot = readSnapshotFromFile(filePath);
  }
  writeDedicatedGitConfig(filePath, { ...inputs, snapshot: snapshot ?? null });
  return filePath;
}

/** 「一键复制」：把用户全局配置文件内容复制进独立配置文件（快照，可重复刷新）。 */
export function copyGlobalConfigToDedicated(
  inputs: { userDataDir: string; name: string; email: string },
  homeDir: string = os.homedir(),
): CopyGlobalResult {
  const filePath = dedicatedGitConfigPath(inputs.userDataDir);
  const copied: string[] = [];
  const parts: string[] = [];
  for (const candidate of globalGitConfigCandidates(homeDir)) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, "utf8").trim();
      if (content.length === 0) continue;
      copied.push(candidate);
      parts.push(`# 源：${candidate}\n${content}`);
    } catch {
      // 单个文件不可读不影响其余候选
    }
  }
  if (copied.length === 0) {
    return { ok: false, copied, path: filePath, message: "未找到可读取的用户全局 Git 配置文件" };
  }
  writeDedicatedGitConfig(filePath, { ...inputs, snapshot: parts.join("\n\n") });
  return { ok: true, copied, path: filePath };
}

function writeDedicatedGitConfig(filePath: string, inputs: DedicatedGitConfigInputs): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, renderDedicatedGitConfig(inputs), "utf8");
}

function readSnapshotFromFile(filePath: string): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return extractSnapshot(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/** git config 值安全引用：统一双引号并转义 `\` 与 `"`（避免 #/; 被当作注释）。 */
function quoteConfigValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
