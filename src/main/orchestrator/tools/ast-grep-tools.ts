// ast-grep 工具 — 基于 AST 的结构化代码搜索与重写
//
// 与文本级工具（Grep/Edit）和语义级工具（lsp）互补：
// - 语法级匹配：pattern 就是普通代码，$$$ 通配任意节点、$$ 单节点、$VAR 捕获
//   例：pattern "console.log($$$ARGS)" 匹配所有 console.log 调用（不会误伤注释/字符串里的同名文本）
// - 不区分语义：同名标识符一律匹配，精确到符号的改名请用 lsp 工具
//
// 安全约束：
// - 工作区根目录限制（路径逃逸检测）
// - ast_grep_replace 默认 dryRun=true 只预览，dryRun=false 才写文件
// - commitEdits 是字符串级编辑，未匹配区域原样保留 → EOL（CRLF/LF）天然保留

import * as fs from "fs";
import * as path from "path";
import { parse, type Edit, type SgNode } from "@ast-grep/napi";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import type { ToolDiffLine, ToolFileChange } from "../../../shared/chat-types";
import { finalizeFileChanges } from "./registry/tool-evidence";
import { app } from "electron";
import { getRunReviewTracker } from "../review/run-review-tracker";
import { withNativeFirst, isNativeFailurePayload, nativeToolHost, stripInternalArgs } from "./native-tool-host";
import { resolveDotnetConfig } from "../../dotnet-backend/config";
import { isAbortError } from "../../abort-utils";

const LOG_PREFIX = "[AstGrep]";

// ── native 轨（.NET ToolHost + 随包 ast-grep CLI）─────────
/** native 轨看门狗：≥ C# CLI 超时（30s）。 */
const AST_GREP_NATIVE_TIMEOUT_MS = 60_000;

/**
 * 解析随包 ast-grep CLI 可执行文件（平台包；找不到返回 null → 走 TS napi 实现）。
 * 支持范围 = @ast-grep/cli 官方平台包矩阵：win32 x64/ia32/arm64、darwin x64/arm64、
 * linux glibc x64/arm64。未覆盖架构（如 linux musl——官方无 musl 包）解析失败后
 * 静默回退 TS，不崩溃。
 */
export function resolveAstGrepCommand(): string | null {
  try {
    const cliDir = path.dirname(require.resolve("@ast-grep/cli/package.json"));
    const platformPkg = process.platform === "win32"
      ? (process.arch === "arm64" ? "@ast-grep/cli-win32-arm64-msvc"
        : process.arch === "ia32" ? "@ast-grep/cli-win32-ia32-msvc"
        : "@ast-grep/cli-win32-x64-msvc")
      : process.platform === "darwin"
        ? (process.arch === "arm64" ? "@ast-grep/cli-darwin-arm64" : "@ast-grep/cli-darwin-x64")
        : (process.arch === "arm64" ? "@ast-grep/cli-linux-arm64-gnu" : "@ast-grep/cli-linux-x64-gnu");
    const exeName = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
    const resolved = require.resolve(`${platformPkg}/${exeName}`, { paths: [cliDir] });
    // 打包态 asar 虚拟路径 → app.asar.unpacked 真实路径：独立进程 .NET
    // Process.Start 无法执行 asar 内文件（对照 sandbox-exec.ts / sync-mcp-builtin.ts）。
    const unpacked = toUnpackedAsarPath(resolved);
    return fs.existsSync(unpacked) ? unpacked : null;
  } catch {
    return null; // 平台包缺失（可选依赖被裁）→ TS napi 轨
  }
}

/** 打包态 asar 虚拟路径 → app.asar.unpacked 真实磁盘路径（asarUnpack 后独立进程才可执行）。 */
export function toUnpackedAsarPath(p: string): string {
  const asarSep = `${path.sep}app.asar${path.sep}`;
  return p.includes(asarSep) ? p.replace(asarSep, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

/**
 * native 参数组装：参数校验（与 parseCommonArgs 同）通过 + CLI 可解析 + 有工作区时返回
 * native 参数（注入 __cyreneWorkspaceRoot / __astGrepCommand）；否则返回 null → TS 原实现。
 * 模型 args 里的 `__` 键先统一剥离（信任边界 §2.3），可信注入随后覆盖。
 */
function buildAstGrepNativeArgs(
  args: Record<string, unknown>,
  ctx?: ToolContext,
  isReplace = false,
): Record<string, unknown> | null {
  try {
    parseCommonArgs(args);
  } catch {
    return null;
  }
  const workspaceRoot = ctx?.resolvedWorkspaceRoot;
  if (!workspaceRoot) return null;
  const command = resolveAstGrepCommand();
  if (!command) return null;
  return {
    ...stripInternalArgs(args),
    ...(isReplace ? { rewrite: String(args.rewrite ?? "") } : {}),
    __cyreneWorkspaceRoot: workspaceRoot,
    __astGrepCommand: command,
  };
}

/**
 * ast_grep_replace native 优先：dryRun 单次调用；正式写入时先预演一遍拿变更清单
 * 以捕获 review 基线（native 写入前，与 TS 原实现的 captureBefore 时序对齐），再正式调用。
 * 任何失败整体回退 TS；取消原样上抛。
 */
async function executeAstGrepReplaceNativeFirst(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  if (!resolveDotnetConfig().toolHost) return executeAstGrepReplace(args, ctx);
  const nativeArgs = buildAstGrepNativeArgs(args, ctx, true);
  if (nativeArgs === null) return executeAstGrepReplace(args, ctx);
  try {
    if (ctx?.runId && args.dryRun === false) {
      const planResult = await nativeToolHost.call(
        "ast_grep_replace",
        { ...nativeArgs, dryRun: true },
        AST_GREP_NATIVE_TIMEOUT_MS,
        ctx.signal,
      );
      if (planResult !== null) {
        const planText = typeof planResult === "string" ? planResult : JSON.stringify(planResult);
        if (!isNativeFailurePayload(planText)) {
          const plan = JSON.parse(planText) as { planned?: Array<{ file: string }> };
          const tracker = getRunReviewTracker(app.getPath("userData"));
          const root = String(nativeArgs.__cyreneWorkspaceRoot);
          for (const p of plan.planned ?? []) {
            tracker.captureBefore(ctx.runId, path.resolve(root, p.file), p.file);
          }
        }
      }
    }
    const result = await nativeToolHost.call("ast_grep_replace", nativeArgs, AST_GREP_NATIVE_TIMEOUT_MS, ctx?.signal);
    if (result !== null) {
      const text = typeof result === "string" ? result : JSON.stringify(result);
      if (!isNativeFailurePayload(text)) return text;
      console.warn(LOG_PREFIX, "ast_grep_replace native 返回错误载荷，回退 TS:", text.slice(0, 200));
    }
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.warn(LOG_PREFIX, "ast_grep_replace native 轨失败回退 TS:", error instanceof Error ? error.message : error);
  }
  return executeAstGrepReplace(args, ctx);
}

// ── 语言映射 ──────────────────────────────────────────────

/** 扩展名（小写，含点）→ ast-grep 语言名 */
const EXTENSION_TO_LANG: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "Tsx",
  ".mts": "TypeScript",
  ".cts": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "Jsx",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".json": "Json",
  ".yaml": "Yaml",
  ".yml": "Yaml",
  ".css": "Css",
  ".html": "Html",
  ".c": "C",
  ".h": "C",
  ".cpp": "Cpp",
  ".cc": "Cpp",
  ".hpp": "Cpp",
};

/** 支持的语言名（用于参数校验与工具描述） */
const SUPPORTED_LANGUAGES = Array.from(new Set(Object.values(EXTENSION_TO_LANG))).sort();

/** 语言名 → 可处理的扩展名集合（language 参数过滤用） */
const LANG_TO_EXTENSIONS: Record<string, Set<string>> = {};
for (const [ext, lang] of Object.entries(EXTENSION_TO_LANG)) {
  (LANG_TO_EXTENSIONS[lang] ??= new Set()).add(ext);
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "release", "build", "out",
  ".next", ".nuxt", "target", "vendor", "__pycache__", ".venv", "venv",
  // git worktree 镜像目录：内容是工作区旧副本，匹配结果会误导后续修改决策
  ".worktrees", "worktrees",
]);

const MAX_FILES = 500;
const MAX_MATCHES_DEFAULT = 50;

// ── 路径安全 ──────────────────────────────────────────────

function isWithinWorkspace(filePath: string, workspaceRoot: string): boolean {
  const resolved = path.resolve(workspaceRoot, filePath);
  const normalizedRoot = path.normalize(workspaceRoot);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + path.sep);
}

/** 归一化展示路径：反斜杠 → 正斜杠，去掉开头 "./"，根目录归为空串 */
function toDisplayPath(relPath: string): string {
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized === "." || normalized === "./") return "";
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

// ── 文件收集 ──────────────────────────────────────────────

interface CollectedFile {
  /** 相对工作区路径（正斜杠，用于展示） */
  relPath: string;
  absPath: string;
  lang: string;
}

/**
 * 递归收集可解析的源码文件。
 * language 指定时只收集该语言扩展名；未指定时收集所有支持的语言。
 */
function collectFiles(
  workspaceRoot: string,
  inputPaths: string[],
  language?: string,
): { files: CollectedFile[]; skipped: string[] } {
  const langExts = language ? LANG_TO_EXTENSIONS[language] : undefined;
  const files: CollectedFile[] = [];
  const skipped: string[] = [];

  const walk = (absDir: string, relDir: string): void => {
    if (files.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      skipped.push(relDir);
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const lang = EXTENSION_TO_LANG[ext];
        if (!lang) continue;
        if (langExts && !langExts.has(ext)) continue;
        files.push({ relPath: rel, absPath: abs, lang });
      }
    }
  };

  for (const inputPath of inputPaths) {
    const abs = path.resolve(workspaceRoot, inputPath);
    if (!isWithinWorkspace(abs, workspaceRoot)) {
      skipped.push(inputPath);
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      skipped.push(inputPath);
      continue;
    }
    if (stat.isDirectory()) {
      walk(abs, toDisplayPath(inputPath));
    } else {
      const ext = path.extname(abs).toLowerCase();
      const lang = EXTENSION_TO_LANG[ext];
      if (!lang || (langExts && !langExts.has(ext))) {
        skipped.push(inputPath);
        continue;
      }
      files.push({
        relPath: toDisplayPath(inputPath),
        absPath: abs,
        lang,
      });
    }
  }

  return { files, skipped };
}

// ── 单文件搜索/重写 ──────────────────────────────────────

interface SingleMatch {
  line: number; // 1-based
  column: number; // 1-based
  endLine: number;
  text: string;
}

function searchOneFile(source: string, lang: string, pattern: string): SingleMatch[] {
  const ast = parse(lang, source);
  const nodes = ast.root().findAll(pattern);
  return nodes.map((node) => {
    const range = node.range();
    return {
      line: range.start.line + 1,
      column: range.start.column + 1,
      endLine: range.end.line + 1,
      text: node.text(),
    };
  });
}

/**
 * 展开 rewrite 模板中的元变量（napi 的 replace 是纯字面替换，元变量需手动展开）。
 * - `$$$NAME`（多捕获）→ 用源文本切片重建（保留原始分隔符/空白；napi 捕获含分隔节点，
 *   直接 join 会重复逗号：`$$$A` 捕获 `"a", x` 时 join(", ") 得到 `"a", ,, x`——与 ast-grep CLI 不一致）
 * - `$NAME`（单捕获）→ 节点文本；未捕获时替换为空串
 */
function expandRewrite(match: SgNode, rewrite: string, source: string): string {
  let result = rewrite.replace(/\$\$\$([A-Z][A-Z0-9_]*)/g, (_all, name: string) => {
    const nodes = match.getMultipleMatches(name);
    if (nodes.length === 0) return "";
    return source.slice(nodes[0].range().start.index, nodes[nodes.length - 1].range().end.index);
  });
  result = result.replace(/\$([A-Z][A-Z0-9_]*)/g, (_all, name: string) => {
    const node = match.getMatch(name);
    return node ? node.text() : "";
  });
  return result;
}

interface ReplaceResult {
  newSource: string;
  diffLines: ToolDiffLine[];
  insertions: number;
  deletions: number;
}

/** 返回重写后的全文与 diff 证据；无匹配返回 null */
function replaceOneFile(
  source: string,
  lang: string,
  pattern: string,
  rewrite: string,
): ReplaceResult | null {
  const ast = parse(lang, source);
  const root = ast.root();
  const matches = root.findAll(pattern);
  if (matches.length === 0) return null;

  // 先按起点排序，保证 edits 与 matches 的配对关系在去重时不错乱
  matches.sort((a, b) => a.range().start.index - b.range().start.index);
  const edits: Edit[] = matches.map((m) => m.replace(expandRewrite(m, rewrite, source)));

  // 重叠编辑去重：嵌套匹配（外层语句 + 内层表达式同时命中）会产生重叠区间，
  // commitEdits 对重叠编辑行为未定义。按起点排序后跳过被前一个覆盖的编辑，保留最外层。
  const nonOverlapping: Edit[] = [];
  const keptMatches: SgNode[] = [];
  let lastEnd = -1;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (edit.startPos < lastEnd) continue; // 被上一个编辑覆盖
    nonOverlapping.push(edit);
    keptMatches.push(matches[i]);
    lastEnd = edit.endPos;
  }

  const diffLines: ToolDiffLine[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const match of keptMatches) {
    for (const text of match.text().split("\n")) {
      diffLines.push({ type: "remove", text });
      deletions++;
    }
    const expanded = expandRewrite(match, rewrite, source);
    for (const text of expanded.split("\n")) {
      diffLines.push({ type: "add", text });
      insertions++;
    }
  }

  return {
    newSource: root.commitEdits(nonOverlapping),
    diffLines,
    insertions,
    deletions,
  };
}

// ── 参数解析 ──────────────────────────────────────────────

interface CommonArgs {
  pattern: string;
  language?: string;
  paths?: string[];
}

function parseCommonArgs(args: Record<string, unknown>): CommonArgs {
  const pattern = String(args.pattern ?? "").trim();
  if (!pattern) throw new Error("pattern 参数不能为空");
  let language: string | undefined;
  if (args.language !== undefined) {
    language = String(args.language);
    if (!SUPPORTED_LANGUAGES.includes(language)) {
      throw new Error(
        `不支持的语言 "${language}"。支持：${SUPPORTED_LANGUAGES.join(", ")}`,
      );
    }
  }
  let paths: string[] | undefined;
  if (args.paths !== undefined) {
    if (!Array.isArray(args.paths) || args.paths.some((p) => typeof p !== "string")) {
      throw new Error("paths 必须是字符串数组");
    }
    paths = args.paths as string[];
  }
  return { pattern, language, paths };
}

/** 把 pattern 编译错误转成用户可读信息 */
function friendlyPatternError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `pattern 无效：${message}`;
}

// ── 工具执行器：ast_grep_search ───────────────────────────

async function executeAstGrepSearch(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const workspaceRoot = ctx?.resolvedWorkspaceRoot;
  if (!workspaceRoot) {
    return JSON.stringify({ success: false, matches: [], errors: ["未绑定工作区，无法执行代码搜索"] });
  }

  let common: CommonArgs;
  try {
    common = parseCommonArgs(args);
  } catch (err) {
    return JSON.stringify({ success: false, matches: [], errors: [String(err instanceof Error ? err.message : err)] });
  }

  const maxMatches = Number.isInteger(args.maxMatches) && (args.maxMatches as number) >= 1
    ? (args.maxMatches as number)
    : MAX_MATCHES_DEFAULT;

  const { files, skipped } = collectFiles(workspaceRoot, common.paths ?? ["."], common.language);

  const matches: (SingleMatch & { file: string })[] = [];
  const errors: string[] = [];
  let filesWithMatches = 0;
  let truncated = false;

  try {
    for (const file of files) {
      if (matches.length >= maxMatches) { truncated = true; break; }
      let source: string;
      try {
        source = fs.readFileSync(file.absPath, "utf8");
      } catch {
        skipped.push(file.relPath);
        continue;
      }
      try {
        const found = searchOneFile(source, file.lang, common.pattern);
        if (found.length > 0) filesWithMatches++;
        for (const m of found) {
          if (matches.length >= maxMatches) { truncated = true; break; }
          matches.push({ ...m, file: file.relPath });
        }
      } catch (err) {
        // 单文件解析失败（如语法错误）不中断整体搜索
        errors.push(`${file.relPath}: ${friendlyPatternError(err)}`);
      }
    }
  } catch (err) {
    return JSON.stringify({ success: false, matches: [], errors: [friendlyPatternError(err)] });
  }

  console.log(LOG_PREFIX, `search "${common.pattern.slice(0, 40)}" → ${matches.length} 处 / ${filesWithMatches} 个文件`);

  return JSON.stringify({
    success: true,
    pattern: common.pattern,
    language: common.language ?? "auto",
    scannedFiles: files.length,
    filesWithMatches,
    matchCount: matches.length,
    truncated,
    matches,
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}),
    ...(errors.length > 0 ? { parseErrors: errors.slice(0, 10) } : {}),
  });
}

// ── 工具执行器：ast_grep_replace ──────────────────────────

async function executeAstGrepReplace(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const workspaceRoot = ctx?.resolvedWorkspaceRoot;
  if (!workspaceRoot) {
    return JSON.stringify({ success: false, changed: [], errors: ["未绑定工作区，无法执行代码改写"] });
  }

  let common: CommonArgs;
  try {
    common = parseCommonArgs(args);
  } catch (err) {
    return JSON.stringify({ success: false, changed: [], errors: [String(err instanceof Error ? err.message : err)] });
  }

  const rewrite = String(args.rewrite ?? "");
  const dryRun = args.dryRun !== false; // 默认 true 只预览

  const { files, skipped } = collectFiles(workspaceRoot, common.paths ?? ["."], common.language);

  interface PlannedChange {
    file: string;
    matchCount: number;
    preview?: string;
  }
  const planned: PlannedChange[] = [];
  const errors: string[] = [];
  const changes: ToolFileChange[] = [];
  /** 本轮调用的待写入内容：absPath → 新文本（局部变量，并发调用互不干扰） */
  const pendingWrites = new Map<string, string>();

  // 阶段 1：对所有文件计算编辑（dryRun 与正式执行共用）
  for (const file of files) {
    let source: string;
    try {
      source = fs.readFileSync(file.absPath, "utf8");
    } catch {
      skipped.push(file.relPath);
      continue;
    }
    try {
      const before = searchOneFile(source, file.lang, common.pattern);
      if (before.length === 0) continue;
      const result = replaceOneFile(source, file.lang, common.pattern, rewrite);
      if (result === null || result.newSource === source) continue;
      planned.push({
        file: file.relPath,
        matchCount: before.length,
        ...(planned.length < 3
          ? { preview: `${file.relPath}: ${before.length} 处，示例 → ${before[0].text.slice(0, 80)}` }
          : {}),
      });
      changes.push({
        file: file.relPath,
        kind: "modified",
        insertions: result.insertions,
        deletions: result.deletions,
        diff: result.diffLines,
      });
      pendingWrites.set(file.absPath, result.newSource);
    } catch (err) {
      errors.push(`${file.relPath}: ${friendlyPatternError(err)}`);
    }
  }

  const totalMatches = planned.reduce((sum, p) => sum + p.matchCount, 0);
  const evidence = finalizeFileChanges(changes);

  if (dryRun) {
    console.log(LOG_PREFIX, `replace(dryRun) "${common.pattern.slice(0, 40)}" → ${planned.length} 文件 ${totalMatches} 处`);
    return JSON.stringify({
      success: true,
      dryRun: true,
      pattern: common.pattern,
      rewrite,
      filesToChange: planned.length,
      totalMatches,
      planned: planned.map((p) => ({ file: p.file, matchCount: p.matchCount })),
      changes: evidence,
      ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}),
      ...(errors.length > 0 ? { parseErrors: errors.slice(0, 10) } : {}),
      note: "这是预览。确认无误后用 dryRun: false 重新调用以实际写入。",
    });
  }

  // Review 基线捕获：在批量写入之前保存 pre-mutation baseline
  if (ctx?.runId) {
    const tracker = getRunReviewTracker(app.getPath("userData"));
    for (const absPath of pendingWrites.keys()) {
      const relPath = absPath.slice(workspaceRoot.length + 1).replaceAll("\\", "/");
      tracker.captureBefore(ctx.runId, absPath, relPath);
    }
  }

  // 阶段 2：统一写入（任一写入异常继续写其余，错误汇总返回）
  const changed: string[] = [];
  for (const [absPath, content] of pendingWrites) {
    try {
      fs.writeFileSync(absPath, content, "utf8");
      changed.push(absPath.slice(workspaceRoot.length + 1).replaceAll("\\", "/"));
    } catch (err) {
      errors.push(`${absPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  pendingWrites.clear();

  console.log(LOG_PREFIX, `replace "${common.pattern.slice(0, 40)}" → 写入 ${changed.length} 个文件`);

  return JSON.stringify({
    success: errors.length === 0,
    dryRun: false,
    pattern: common.pattern,
    rewrite,
    changedFiles: changed.length,
    totalMatches,
    changed,
    changes: evidence,
    ...(skipped.length > 0 ? { skipped: skipped.slice(0, 20) } : {}),
    ...(errors.length > 0 ? { errors: errors.slice(0, 10) } : {}),
  });
}

// ── 注册 ──────────────────────────────────────────────────

const PATTERN_SYNTAX_DOC =
  "pattern 语法：写一段普通代码作为模板。$VAR 匹配并捕获单个节点，$$ 匹配单个任意节点，$$$ 匹配任意数量节点（含零）。\n" +
  "例：\n" +
  '- "console.log($$$ARGS)" 匹配所有 console.log 调用\n' +
  '- "function $NAME($$$) { $$$ }" 匹配所有函数声明\n' +
  'rewrite 中可引用捕获的 $VAR。';

const LANGUAGES_DOC = `支持的语言：${SUPPORTED_LANGUAGES.join("、")}（language 不传时按文件扩展名自动识别）`;

export function registerAstGrepTools(): void {
  toolRegistry.register(withNativeFirst({
    id: "ast_grep_search",
    name: "AST 代码搜索",
    description:
      "用 AST 结构模式在代码中搜索（语法级，非文本匹配）。\n\n" +
      "何时用：\n" +
      "- 找某种代码结构（所有 console.log 调用、所有 new Error(...)、某种 API 用法模式）\n" +
      "- 文本搜索会误伤注释/字符串里的同名内容时\n" +
      "- 重构前先摸清影响面\n\n" +
      "不要用于：\n" +
      "- 纯文本搜索（用 Grep）\n" +
      "- 找符号定义/引用（用 lsp 的 workspaceSymbol/findReferences，语义级更精确）\n\n" +
      PATTERN_SYNTAX_DOC + "\n\n" +
      LANGUAGES_DOC + "\n\n" +
      "参数：pattern（必填），paths（可选，相对工作区的文件/目录，默认全工作区），language（可选），maxMatches（可选，默认 50）。",
    enabled: true,
    risk: "fs-read",
    modes: ["code", "work"],
    effectKind: "read" as const,
    verificationPolicy: "none" as const,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST 模式（一段普通代码作模板，$$$/$$/$VAR 为通配符）" },
        paths: { type: "array", items: { type: "string" }, description: "相对工作区的文件或目录列表，默认 [\".\"]" },
        language: { type: "string", enum: SUPPORTED_LANGUAGES, description: "限定语言；不传则按扩展名自动识别" },
        maxMatches: { type: "number", description: "最多返回匹配数，默认 50" },
      },
      required: ["pattern"],
    },
    execute: executeAstGrepSearch,
  }, "ast_grep_search", (args, ctx) => buildAstGrepNativeArgs(args, ctx), AST_GREP_NATIVE_TIMEOUT_MS, true));

  toolRegistry.register({
    id: "ast_grep_replace",
    name: "AST 批量改写",
    description:
      "用 AST 结构模式批量改写代码（语法级，保持未匹配区域原样、保留换行符）。\n\n" +
      "何时用：\n" +
      "- 同一代码模式的大量机械改写（API 迁移、错误调用规范化、测试断言格式统一）\n" +
      "- 文本替换会误伤注释/字符串时\n\n" +
      "不要用于：\n" +
      "- 单文件单处修改（用 Edit 更直接）\n" +
      "- 精确改名某个符号（用 lsp rename 语义级改名，ast-grep 不区分同名符号）\n" +
      "- 复杂多行结构调整（用 Edit）\n\n" +
      "流程：先 dryRun=true（默认）预览影响面，确认后 dryRun=false 写入。\n\n" +
      PATTERN_SYNTAX_DOC + "\n\n" +
      LANGUAGES_DOC + "\n\n" +
      "参数：pattern（必填），rewrite（必填，替换模板），paths（可选），language（可选），dryRun（可选，默认 true 只预览）。",
    enabled: true,
    risk: "fs-write",
    modes: ["code", "work"],
    effectKind: "mutation" as const,
    verificationPolicy: "code" as const,
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "AST 模式（一段普通代码作模板）" },
        rewrite: { type: "string", description: "替换模板，可引用 pattern 中捕获的 $VAR" },
        paths: { type: "array", items: { type: "string" }, description: "相对工作区的文件或目录列表，默认 [\".\"]" },
        language: { type: "string", enum: SUPPORTED_LANGUAGES, description: "限定语言" },
        dryRun: { type: "boolean", description: "true=只预览不写文件（默认），false=实际写入" },
      },
      required: ["pattern", "rewrite"],
    },
    execute: executeAstGrepReplaceNativeFirst,
  });

  console.log(LOG_PREFIX, "已注册：ast_grep_search / ast_grep_replace");
}
