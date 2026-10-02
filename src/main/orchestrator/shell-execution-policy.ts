// ShellExecutionPolicy — 命令副作用分类器 + 灾难守卫
//
// 设计哲学：
// - Classifier（分类器）负责判断 effect → 仅用于 approval / UI / logging / 风险提示
// - Sandbox（沙箱）负责强制能力边界 → OS 级别兜底
// 绝不让 classifier 成为安全边界。
//
// 分类结果：
// - "read"：明确只读命令（git status, ls, echo 等）
// - "write"：明确有写副作用的命令（git commit, npm install, > redirect 等）
// - "unknown"：无法判断（node script.js, some-tool.cmd 等）
//
// 灾难守卫（best-effort 安全带，不是安全边界）：
// - isCatastrophicCommand() 拦截「不可逆 + 灾难范围 + 助手无正当理由」的操作：
//   磁盘/分区格式化、电源、引导/恢复/备份删除、整盘/系统目录递归删除、勒索软件惯用法、
//   下载即执行/常见混淆、持久化与防火墙关闭等。
// - 普通破坏性命令（rm 单个文件、git reset、apt remove）不在这里硬拦——交给沙箱/审批，
//   否则既误伤可用性，又制造「字符串过滤 = 安全」的虚假安全感。
// - 静态分析拦不住的东西（务必承认）：解释器内构造（node -e / eval / $'\x72\x6d' / base64 /
//   %VAR% 间接）、8.3 短名、UNC/ADS、跨调用的分步执行。这些只靠审批 + 沙箱兜底。

/** 命令副作用分类（仅用于 approval / UI / logging，不是安全边界） */
export type ShellEffect = "read" | "write" | "unknown";

// ── 明确只读的命令首词 ──────────────────────────────────

const READ_ONLY_FIRST_WORDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "fd",
  "echo", "pwd", "which", "where", "type", "file", "stat", "du",
  "df", "uname", "hostname", "date", "id", "whoami", "env",
  "sort", "uniq", "cut", "tr", "sed", "awk",
  "dir", "tree", "ver", "vol",  // Windows 只读内建
  // 注：find 不在此列——它有 -delete/-exec 等写参数，单独在下方分支处理
]);

/** git 只读子命令 */
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "status", "diff", "log", "show", "branch", "remote", "stash",
  "tag", "describe", "rev-parse", "ls-files", "ls-remote",
  "cat-file", "count-objects", "blame",
]);

/** git 写子命令 */
const WRITE_GIT_SUBCOMMANDS = new Set([
  "checkout", "reset", "rebase", "merge", "pull", "push",
  "commit", "add", "rm", "mv", "clean", "am", "apply",
  "cherry-pick", "revert", "init", "clone", "fetch", "archive",
]);

/** git branch 写参数 */
const GIT_BRANCH_WRITE_FLAGS = new Set(["-d", "-D", "-m", "-M", "-c", "-C"]);

/** git stash 写子命令 */
const GIT_STASH_WRITE_SUBCOMMANDS = new Set(["push", "pop", "drop", "clear", "apply", "create"]);

/** git remote 写子命令 */
const GIT_REMOTE_WRITE_SUBCOMMANDS = new Set(["add", "remove", "rename", "set-url", "prune", "update"]);

/** find 写参数 */
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok"]);

// ── 灾难命令守卫 ────────────────────────────────────────
//
// 分两层，互补：
//   1) HARD_BLOCK_COMMANDS：命令位置一级拦截。把命令按 shell 控制符切成段，每段跳过
//      包装器（cmd/bash/powershell/sudo/timeout ...）与其选项/数字参数，取首个「真命令」
//      的 basename 比对。可穿透 `a && format`、`C:\...\shutdown.exe`、`cmd /c format`。
//   2) HARD_BLOCK_PATTERNS：特征鲜明的灾难惯用法，对整串归一化文本做正则匹配。用于
//      命令名无法表达的场景（`rm -rf /`、`vssadmin delete shadows`、`curl | sh` 等）。

/** 命令位置一级拦截：不可逆、灾难范围、助手无正当理由的命令名（basename）。 */
const HARD_BLOCK_COMMANDS = new Set([
  // 磁盘 / 分区 / 格式化 / 原始设备
  "format", "diskpart", "mkfs", "fdisk", "sfdisk", "cfdisk", "parted",
  "mkswap", "wipefs", "dd",
  // 电源 / 会话
  "shutdown", "reboot", "halt", "poweroff", "logoff",
  "restart-computer", "stop-computer",
  // 引导 / 恢复 / 备份删除
  "bcdedit", "bootrec", "vssadmin", "wbadmin", "reagentc", "manage-bde", "bootcfg",
]);

/** 运行另一个命令的包装器：解析命令位置时跳过它们及其选项/数字参数。 */
const WRAPPER_COMMANDS = new Set([
  "cmd", "powershell", "pwsh", "sh", "bash", "zsh", "dash", "ksh", "wsl",
  "sudo", "doas", "runas", "env", "nohup", "nice", "time", "timeout", "xargs",
  "start", "command", "setsid",
]);

/**
 * 灾难惯用法（对归一化后的整串匹配：小写、去引号）。
 * 每条都要足够「特征鲜明」，避免把普通开发命令（rm node_modules、del *.log）误伤。
 */
const HARD_BLOCK_PATTERNS: RegExp[] = [
  // POSIX 递归强删根 / 家目录 / WSL 挂载的 Windows 盘（不匹配普通绝对路径如 /tmp/x）
  /\brm\s+(?=[^&|;\n]*(?:-r\b|-rf\b|-fr\b|--recursive))(?=[^&|;\n]*(?:-f\b|-rf\b|-fr\b|--force))[^&|;\n]*\s+(?:\/(?:\*)?|~(?:\/\*)?|\$home(?:\/\*)?|\/mnt\/[a-z](?:\/\*)?)(?=\s|$)/,
  // WSL 下递归删除挂载盘里的 Windows 系统/用户目录
  /\brm\s+(?=[^&|;\n]*(?:-r\b|-rf\b|-fr\b|--recursive))(?=[^&|;\n]*(?:-f\b|-rf\b|-fr\b|--force))[^&|;\n]*\s+\/mnt\/[a-z]\/(?:windows|users|program files|programdata)(?=\/|\s|$)/,
  // 直接写块设备
  /\bdd\b[^\n]*\bof=\/dev\//,
  // fork 炸弹
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;\s*:/,
  // Windows 整盘 / 系统目录递归删除
  /\b(?:del|erase)(?:\.exe)?\b[^\n]*\/[fsq](?:\s|$)[^\n]*\b[a-z]:[\\/]/,
  /\b(?:del|erase)(?:\.exe)?\b[^\n]*\/[fsq](?:\s|$)[^\n]*\\(?:windows|users|program files|programdata)\b/,
  /\b(?:rd|rmdir)(?:\.exe)?\b[^\n]*\/s[^\n]*\b[a-z]:[\\/]/,
  /\b(?:rd|rmdir)(?:\.exe)?\b[^\n]*\/s[^\n]*\\(?:windows|users|program files|programdata)\b/,
  /\bremove-item\b(?=[^\n]*(?:-recurse\b|-r\b))(?=[^\n]*(?:-force\b|-fo\b))[^\n]*\b[a-z]:[\\/]/,
  // 勒索软件 / 备份删除 / 恢复破坏
  /\bvssadmin(?:\.exe)?\b[^\n]*\bdelete\b[^\n]*\bshadows?\b/,
  /\bwbadmin(?:\.exe)?\b[^\n]*\bdelete\b/,
  /\bwmic(?:\.exe)?\b[^\n]*shadowcopy[^\n]*delete/,
  /\bbcdedit(?:\.exe)?\b[^\n]*(?:recoveryenabled\s+no|ignoreallfailures)/,
  /\bcipher(?:\.exe)?\b[^\n]*\/w\b/,
  /\bmanage-bde(?:\.exe)?\b[^\n]*(?:-off|delete)/,
  /\bnvme(?:\.exe)?\b[^\n]*\bformat\b/,
  /\bhdparm\b[^\n]*--security-erase/,
  /\bbadblocks\b[^\n]*-w\b/,
  // 防火墙关闭
  /\bnetsh(?:\.exe)?\b[^\n]*advfirewall[^\n]*state\s+off/,
  /\bset-netfirewallprofile\b[^\n]*-enabled[^\n]*false/,
  // 注册表 / 账户破坏
  /\breg(?:\.exe)?\s+delete\s+(?:hklm|hkcr|hkey_local_machine|hkey_classes_root)\b/,
  /\bnet(?:\.exe)?\s+(?:user|localgroup)\b[^\n]*(?:\/add|\/delete|\/active:no|(?:\s+[^\s/]+\s+[^\s/]+))/,
  // 持久化（助手没有正当理由操纵系统任务/服务）
  /\bschtasks(?:\.exe)?\b[^\n]*\/create\b/,
  /\breg(?:\.exe)?\s+add\b[^\n]*\\(?:run|runonce)\b/,
  /\bsc(?:\.exe)?\s+(?:create|delete)\b/,
  /\bnew-service\b/,
  // 下载即执行 / 常见混淆（尽力而为；解释器内构造拦不住）
  /\b(?:curl|wget|iwr|invoke-webrequest)(?:\.exe)?\b[^\n]*\|\s*(?:ba|z|da|k)?sh\b/,
  /\b(?:curl|wget|iwr|invoke-webrequest)(?:\.exe)?\b[^\n]*\|\s*(?:powershell|pwsh|cmd)\b/,
  /\b(?:iwr|invoke-webrequest|downloadstring|downloadfile|net\.webclient)\b[^\n]*\biex\b/,
  /\biex\b[^\n]*(?:iwr|invoke-webrequest|downloadstring|downloadfile|net\.webclient)\b/,
  /\b(?:powershell|pwsh)\b[^\n]*-enc(?:odedcommand)?\b/,
  /\bcertutil(?:\.exe)?\b[^\n]*-(?:decode|urlcache)\b/,
  /\bmshta(?:\.exe)?\b/,
  /\brundll32(?:\.exe)?\b[^\n]*javascript:/,
  /\bregsvr32(?:\.exe)?\b[^\n]*\/i:https?:/,
  /\bbitsadmin(?:\.exe)?\b[^\n]*\/transfer\b/,
  /\bwmic(?:\.exe)?\b[^\n]*process[^\n]*call[^\n]*create/,
];

/** 归一化整串：小写、去引号（保留反斜杠/正斜杠）。 */
function normalizeCommand(command: string): string {
  return command.toLowerCase().replace(/["'`]/g, "");
}

/** 归一化单个 token：去首尾引号/括号/标点、取 basename、去常见脚本扩展名、小写。 */
function normalizeToken(token: string): string {
  const stripped = token
    .trim()
    .replace(/^[`("'[{]+/, "")
    .replace(/[`)"'\]};,]+$/, "");
  const basename = stripped.replace(/^.*[\\/]/, "");
  return basename
    .replace(/\.(?:exe|com|bat|cmd|ps1|sh|bash|zsh|py|js|vbs|lnk|scr|msi)$/i, "")
    .toLowerCase();
}

/** 按 shell 控制符切段（引号内的分隔符也会切，属可接受的近似）。 */
function splitCommandSegments(command: string): string[] {
  return command.split(/&&|\|\||[;|&\n\r()`]/);
}

/** 取一段命令的「命令位置」名：跳过包装器与选项/数字参数后的首个真命令 basename。 */
function commandPositionName(segment: string): string | null {
  const tokens = segment.trim().replace(/^[`(]+/, "").split(/\s+/).filter(Boolean);
  for (const token of tokens) {
    const raw = token.trim().replace(/^[`(]+/, "");
    if (!raw) continue;
    // 先判选项/数字：普通 token 才取 basename（否则 cmd 的 /c 会被当成路径取成 "c"）
    if (raw.startsWith("-") || /^\d+$/.test(raw) || /^\/[a-z]$/i.test(raw)) continue;
    const name = normalizeToken(token);
    if (!name) continue;
    if (WRAPPER_COMMANDS.has(name)) continue;
    return name;
  }
  return null;
}

/** 命令位置名是否属于灾难命令（含 mkfs.ext4 这类「基名 + 文件系统后缀」）。 */
function isHardBlockedName(name: string): boolean {
  return HARD_BLOCK_COMMANDS.has(name) || name.startsWith("mkfs.");
}

/**
 * 灾难命令检测（best-effort）。命中即无条件拒绝，与权限档位无关。
 * 拦不住混淆/解释器构造——那由审批与沙箱兜底，见文件头。
 */
export function isCatastrophicCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;

  const normalized = normalizeCommand(trimmed);
  if (HARD_BLOCK_PATTERNS.some((pattern) => pattern.test(normalized))) return true;

  for (const segment of splitCommandSegments(trimmed)) {
    const name = commandPositionName(segment);
    if (name && isHardBlockedName(name)) return true;
  }
  return false;
}

// ── WSL 管理命令守卫 ────────────────────────────────────
// AI 只允许「在发行版内执行命令」与「查看已安装发行版」；安装/卸载/删除/关停/改默认
// 等发行版管理操作一律拒绝。wsl.exe 的安装/删除操作在 shell:"wsl" 主路径上结构不可达
// （argv 由主进程构造），但 cmd/bash 模式可以直接调 wsl.exe，故这里做字符串兜底：
// 只要命令里出现独立的 wsl/wsl.exe token 且带任一管理 flag，就拦截（含 `cmd /c wsl ...` 绕道）。
const WSL_MANAGEMENT_FLAGS = new Set([
  "--install", "--uninstall", "--unregister",
  "--manage", "--delete", "--move", "--resize",
  "--shutdown", "--terminate", "-t",
  "--import", "--export", "--mount", "--unmount",
  "--set-default", "--set-version",
]);

/** 是否出现 wsl.exe 的发行版管理命令（含经 cmd/bash 调用的绕道）。 */
export function isWslManagementCommand(command: string): boolean {
  const lower = command.trim().toLowerCase();
  if (!lower) return false;
  // wsl / wsl.exe 必须是独立 token（可带路径前缀），避免误伤 "awslogs" 之类
  if (!/(^|[\s\\/[(])wsl(\.exe)?\b/.test(lower)) return false;
  const tokens = lower.split(/[\s|;&()]+/);
  return tokens.some((token) => WSL_MANAGEMENT_FLAGS.has(token));
}

// ── 副作用分类器 ────────────────────────────────────────

/**
 * 分类命令行字符串的副作用。
 *
 * **仅用于 approval / UI / logging / 风险提示，不是安全边界。**
 * 沙箱才是最终裁判：哪怕 classifier 误判为 read，沙箱也会阻止写操作。
 *
 * @param command 完整命令行字符串（如 "git status | findstr TODO"）
 * @returns "read" | "write" | "unknown"
 */
export function classifyShellEffect(command: string): ShellEffect {
  const trimmed = command.trim();
  if (!trimmed) return "unknown";

  // ── 1. 检查 shell 操作符 → write ──
  // 重定向 (> >> <)、管道 (|)、命令连接 (&& || & ;) 中只要出现就视为 write
  // 因为管道后段可能写文件，重定向明确写文件
  if (/[<>]/.test(trimmed) || /\|/.test(trimmed) || /(&&|\|\||[&;])/.test(trimmed)) {
    // 但纯读管道如 "git status | findstr xxx" 实际是 read——
    // 保守起见仍标 write，让 sandbox 兜底；per-action 档会触发审批
    // 代价是 read-only 档跑不了管道，但安全侧失优于功能侧失
    return "write";
  }

  // ── 2. 取首词分析 ──
  const tokens = trimmed.split(/\s+/);
  const firstToken = tokens[0].toLowerCase();
  const basename = firstToken.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const rest = tokens.slice(1).map((t) => t.toLowerCase());

  // ── 3. 只读命令首词 ──
  if (READ_ONLY_FIRST_WORDS.has(basename)) return "read";

  // ── 4. Git 命令 ──
  if (basename === "git") {
    const subcommand = rest[0];
    if (!subcommand) return "unknown";

    if (subcommand === "branch") {
      if (rest.some((a) => GIT_BRANCH_WRITE_FLAGS.has(a))) return "write";
      return "read";
    }
    if (subcommand === "stash") {
      const stashSub = rest[1];
      if (stashSub && GIT_STASH_WRITE_SUBCOMMANDS.has(stashSub)) return "write";
      return "read";
    }
    if (subcommand === "remote") {
      const remoteSub = rest[1];
      if (remoteSub && GIT_REMOTE_WRITE_SUBCOMMANDS.has(remoteSub)) return "write";
      return "read";
    }
    if (WRITE_GIT_SUBCOMMANDS.has(subcommand)) return "write";
    if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return "read";
    return "unknown";
  }

  // ── 5. find 命令 ──
  if (basename === "find") {
    if (rest.some((a) => FIND_WRITE_FLAGS.has(a))) return "write";
    return "read";
  }

  // ── 6. npm/yarn/pnpm ──
  if (["npm", "yarn", "pnpm", "npx"].includes(basename)) {
    const sub = rest[0];
    if (!sub) return "unknown";
    // install / create / publish / run（可能写）→ write
    const WRITE_SUBS = new Set(["install", "i", "add", "remove", "uninstall", "publish",
      "create", "init", "run", "run-script", "ci", "update", "audit", "fix"]);
    if (WRITE_SUBS.has(sub)) return "write";
    // list / ls / view / info / outdated / why → read
    const READ_SUBS = new Set(["list", "ls", "view", "info", "outdated", "why", "config", "prefix", "root"]);
    if (READ_SUBS.has(sub)) return "read";
    return "unknown";
  }

  // ── 7. 其他已知开发工具 ──
  if (["node", "python", "python3", "py", "ruby", "go", "cargo", "rustc",
       "gcc", "g++", "cl", "msbuild", "tsc", "eslint", "prettier",
       "pip", "pip3", "cargo", "docker", "kubectl"].includes(basename)) {
    // 这些工具可能做任何事——交给沙箱
    return "unknown";
  }

  // ── 8. 未知命令 ──
  return "unknown";
}

// ── 工具执行前策略守卫（保留，供 tool-registry 使用）────────

export interface ExecutionPolicyDecision {
  allowed: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * 执行前策略守卫：在工具实际执行前检查是否允许。
 * 覆盖 Plan 和 Direct 模式。
 */
export function checkExecutionPolicy(
  effectKind: string,
  verificationPolicy: string,
  toolId: string,
): ExecutionPolicyDecision {
  if (effectKind === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_TOOL_EFFECT",
      message: `工具 ${toolId} 的 effectKind 为 unknown，系统无法确定工具效果类型，拒绝执行。请为该工具配置 effectKind。`,
    };
  }

  if (effectKind === "mutation" && verificationPolicy === "unknown") {
    return {
      allowed: false,
      errorCode: "E_UNKNOWN_VERIFICATION_POLICY",
      message: `工具 ${toolId} 的 verificationPolicy 为 unknown，系统无法确定验证策略，拒绝执行。请为该工具配置 verificationPolicy 或 verificationPolicyResolver。`,
    };
  }

  return { allowed: true };
}
