/**
 * B6 一致性测试框架——TS↔.NET 双轨语义等价对比（Linux 可全跑）。
 *
 * calculator：同一表达式集，TS evaluateExpression vs cyrene-smoke
 * （同源编译的 .NET Calculator），数值差 >1e-9 即 FAIL。
 * fs 三件：write_file（新建/覆盖/追加/空内容）输出 JSON 与落盘字节级对齐、
 * read_file 窗口语义对齐、list_dir 文本对齐（evidence 帧协议 v1）。
 * tool-host：list/call 帧序握手（fs 三件+calculator roundtrip）。
 * web_search：确定性校验路径双轨（引擎/key 经 config 帧注入，无网络）。
 * Linux 用 dotnet/smoke-host（冒烟壳）；Windows 优先 cyrene-native.exe。
 */
import { DUAL_TRACK_USER_DATA } from "./dual-track-env";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { evaluateExpression } from "../src/main/orchestrator/tools/builtin-tools/utility-tools";

const ROOT = path.join(__dirname, "..");
const SMOKE_DLL = path.join(ROOT, "dotnet", "smoke-host", "bin", "Release", "net10.0", "cyrene-smoke.dll");
const WIN_EXE = path.join(ROOT, "dotnet", "native-windows", "bin", "Release", "net10.0-windows", "win-x64", "publish", "cyrene-native.exe");

const EXPRESSIONS = [
  "1+2*3", "(1+2)*3", "2^3^2", "-3+5", "2*-3", "sqrt(16)",
  "max(1, 9, 3)", "2.5e2+1", "100/4/5", "10%3", "abs(-42)",
];

interface HostResult { ok: boolean; data?: unknown; error?: string }

function callSmokeTool(
  tool: string,
  args: Record<string, unknown>,
  extraFrames: Array<Record<string, unknown>> = [],
): Promise<HostResult> {
  return new Promise((resolve) => {
    const frames = [
      ...extraFrames.map((f) => JSON.stringify(f)),
      JSON.stringify({ op: "call", callId: "c1", tool, args }),
      JSON.stringify({ op: "shutdown" }),
    ].join("\n");
    const child = spawn("dotnet", [SMOKE_DLL, "--tool-host"], { stdio: ["pipe", "pipe", "inherit"], cwd: path.dirname(SMOKE_DLL) });
    let buf = "";
    child.stdout.on("data", (d) => { buf += d; });
    child.on("exit", () => {
      let out: HostResult = { ok: false, error: "no result frame" };
      for (const line of buf.split("\n")) {
        try {
          const f = JSON.parse(line);
          if (f.op === "result" && f.callId === "c1") {
            out = f.ok === false ? { ok: false, error: f.error } : { ok: true, data: f.data };
          }
        } catch { /* skip */ }
      }
      resolve(out);
    });
    child.stdin.write(frames);
    child.stdin.end();
  });
}

function parseCalcResult(data: unknown): number | null {
  // .NET calculator 返回 {value,expression}（JSON 字符串或已解析对象）
  if (typeof data === "number") return data;
  if (data && typeof data === "object" && "value" in (data as Record<string, unknown>)) {
    const v = (data as Record<string, unknown>).value;
    if (typeof v === "number") return v;
    if (typeof v === "string" && Number.isFinite(Number(v))) return Number(v);
  }
  if (typeof data === "string") {
    try {
      const j = JSON.parse(data) as { value?: unknown; result?: unknown; error?: string };
      const v = j.value ?? j.result;
      if (typeof v === "number") return v;
      if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
      return null;
    } catch {
      const t = data.trim();
      if (t !== "" && Number.isFinite(Number(t))) return Number(t);
      return null;
    }
  }
  return null;
}

// ── fs 三件双轨（evidence 帧协议 v1）─────────────────────────

type TsFsTool = (args: Record<string, unknown>, ctx?: Record<string, unknown>) => Promise<string>;

let tsToolsCache: Promise<Map<string, TsFsTool>> | null = null;

/** 加载 TS 轨工具（注册副作用在模块加载时完成；缓存避免重复注册）。host 不可用时 execute 自动回退 TS。 */
function loadTsTools(): Promise<Map<string, TsFsTool>> {
  tsToolsCache ??= (async () => {
    await import("../src/main/orchestrator/tools/fs-tools");
    const lifeTools = await import("../src/main/orchestrator/tools/life-tools");
    lifeTools.registerLifeTools();
    const searchTools = await import("../src/main/orchestrator/tools/search-text-tools");
    searchTools.registerSearchTextTool();
    const applyPatchTools = await import("../src/main/orchestrator/tools/apply-patch-tools");
    applyPatchTools.registerApplyPatchTool();
    const { toolRegistry } = await import("../src/main/orchestrator/tools/registry/tool-registry");
    const { downloadFileTool } = await import("../src/main/orchestrator/tools/builtin-tools/download-file-tool");
    if (!toolRegistry.getById("download_file")) toolRegistry.register(downloadFileTool);
    const map = new Map<string, TsFsTool>();
    for (const id of ["read_file", "write_file", "list_dir", "exchange_rate", "record_expense", "query_expense", "search_text", "str_replace", "apply_patch", "download_file"]) {
      const tool = toolRegistry.getById(id);
      if (tool) map.set(id, (args, ctx) => Promise.resolve(tool.execute(args, ctx as never)));
    }
    return map;
  })();
  return tsToolsCache;
}

function looseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}

/** write_file 可比投影：去掉两轨不同的绝对路径（临时目录），保留统计与证据。 */
function comparableWrite(parsed: unknown): unknown {
  const j = (parsed ?? {}) as Record<string, unknown> & {
    changes?: Array<Record<string, unknown>>;
  };
  return {
    success: j.success,
    tool: j.tool,
    append: j.append,
    exists: j.exists,
    sizeBytes: j.sizeBytes,
    writtenBytes: j.writtenBytes,
    changes: (j.changes ?? []).map((c) => ({
      kind: c.kind,
      insertions: c.insertions,
      deletions: c.deletions,
      truncated: c.truncated,
      diff: c.diff,
    })),
  };
}

/** read_file 可比投影（路径同理剔除）。 */
function comparableRead(parsed: unknown): unknown {
  const j = (parsed ?? {}) as Record<string, unknown>;
  return {
    startLine: j.startLine,
    endLine: j.endLine,
    totalLines: j.totalLines,
    content: j.content,
    truncated: j.truncated,
  };
}

/** fs 三件 TS↔.NET 双轨对比；返回失败数。仅在 smoke host 可用时调用。 */
async function runFsDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] fs ${name}`);
    else { failed++; console.log(`[FAIL] fs ${name} —— ${detail}`); }
  };

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "fs-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "fs-dual-net-"));
  try {
    const tsTools = await loadTsTools();
    const tsWrite = tsTools.get("write_file");
    if (!tsWrite) { check("TS 轨 write_file 已注册", false); return failed; }

    const writeCases: Array<{ name: string; pre?: string; args: (dir: string) => Record<string, unknown> }> = [
      { name: "write 新建文件", args: (d) => ({ path: path.join(d, "new.txt"), content: "第一行\n第二行" }) },
      { name: "write 覆盖写 modified+diff", pre: "旧一\n旧二", args: (d) => ({ path: path.join(d, "over.txt"), content: "新一\n新二\n新三" }) },
      { name: "write 追加写补换行", pre: "首行\n次行", args: (d) => ({ path: path.join(d, "app.txt"), content: "追加", append: true }) },
      { name: "write 空内容", args: (d) => ({ path: path.join(d, "empty.txt"), content: "" }) },
      { name: "write 子目录自动创建", args: (d) => ({ path: path.join(d, "a", "b", "c.txt"), content: "x" }) },
    ];

    for (const c of writeCases) {
      const tsArgs = c.args(tsHome);
      const netArgs = c.args(netHome);
      const tsFile = String(tsArgs.path);
      const netFile = String(netArgs.path);
      if (c.pre !== undefined) {
        mkdirSync(path.dirname(tsFile), { recursive: true });
        mkdirSync(path.dirname(netFile), { recursive: true });
        writeFileSync(tsFile, c.pre);
        writeFileSync(netFile, c.pre);
      }
      const tsOut = looseJson(await tsWrite(tsArgs));
      const host = await callSmokeTool("fs_write_file", netArgs);
      if (!host.ok) { check(c.name, false, `host error: ${host.error}`); continue; }
      const netOut = looseJson(String(host.data ?? ""));
      const outSame = JSON.stringify(comparableWrite(tsOut)) === JSON.stringify(comparableWrite(netOut));
      const tsBytes = existsSync(tsFile) ? readFileSync(tsFile) : null;
      const netBytes = existsSync(netFile) ? readFileSync(netFile) : null;
      const bytesSame = !!tsBytes && !!netBytes && Buffer.compare(tsBytes, netBytes) === 0;
      check(
        c.name,
        outSame && bytesSame,
        `outSame=${outSame} bytesSame=${bytesSame} ts=${JSON.stringify(comparableWrite(tsOut))} net=${JSON.stringify(comparableWrite(netOut))}`,
      );
    }

    const tsRead = tsTools.get("read_file");
    if (tsRead) {
      const tsReadOut = looseJson(await tsRead({ path: path.join(tsHome, "new.txt"), startLine: 2, maxLines: 1 }));
      const host = await callSmokeTool("fs_read_file", { path: path.join(netHome, "new.txt"), startLine: 2, maxLines: 1 });
      const netReadOut = host.ok ? looseJson(String(host.data ?? "")) : null;
      check(
        "read 分页窗口",
        JSON.stringify(comparableRead(tsReadOut)) === JSON.stringify(comparableRead(netReadOut)),
        `ts=${JSON.stringify(comparableRead(tsReadOut))} net=${JSON.stringify(comparableRead(netReadOut))}`,
      );
    }

    const tsList = tsTools.get("list_dir");
    if (tsList) {
      const tsListOut = await tsList({ path: tsHome });
      const host = await callSmokeTool("fs_list_dir", { path: netHome });
      const netListOut = host.ok ? String(host.data ?? "").split(netHome).join(tsHome) : null;
      check("list_dir 文本对齐", tsListOut === netListOut, `ts=${JSON.stringify(tsListOut)} net=${JSON.stringify(netListOut)}`);
    }
  } finally {
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

/** 生活类工具双轨（exchange_rate + expense）。外网不可达且双侧一致时按 SKIP，避免网络抖动误报。 */
async function runLifeDualTrack(): Promise<number> {
  let failed = 0;
  const tsTools = await loadTsTools();

  // ── exchange_rate ──────────────────────────────────────
  const tsExchange = tsTools.get("exchange_rate");
  if (!tsExchange) {
    console.log("[FAIL] life exchange_rate：TS 轨未注册");
    failed++;
  } else {
    const args = { from: "USD", to: "CNY", amount: 100 };
    const configFrames = [{ op: "config", timezone: "Asia/Shanghai", dateLocale: "zh-CN" }];
    let tsOut = "";
    let tsThrew = false;
    try {
      tsOut = await tsExchange(args);
    } catch (error) {
      tsThrew = true;
      tsOut = "[错误] " + (error instanceof Error ? error.message : String(error));
    }
    const host = await callSmokeTool("exchange_rate", args, configFrames);
    const netOut = host.ok ? String(host.data ?? "") : "";

    const tsFailed = tsThrew || tsOut.includes("汇率查询失败");
    const netFailed = !host.ok || netOut.includes("汇率查询失败");
    if (tsFailed && netFailed) {
      // 打印双侧错误便于识别"DNS vs 超时"等非同一原因导致的假一致
      console.log(`[SKIP] life exchange_rate（双侧失败，TS: ${tsOut.slice(0, 120)} | NET: ${netOut.slice(0, 120)}）`);
    } else if (tsOut === netOut) {
      console.log("[PASS] life exchange_rate 双轨输出一致");
    } else {
      failed++;
      console.log(`[FAIL] life exchange_rate:\n  TS =${tsOut}\n  NET=${netOut}`);
    }
  }

  // ── expense（record/query）：TS userData 由 dual-track-env 隔离 ──
  const tsRecord = tsTools.get("record_expense");
  const tsQuery = tsTools.get("query_expense");
  if (!tsRecord || !tsQuery) {
    console.log("[FAIL] life expense：TS 轨未注册");
    return failed + 1;
  }
  const netDataDir = mkdtempSync(path.join(os.tmpdir(), "dual-track-expense-"));
  const configFrames = [
    { op: "config", dataDir: netDataDir, timezone: "Asia/Shanghai", dateLocale: "zh-CN" },
  ];
  try {
    const recordCases: Array<{ name: string; args: Record<string, unknown>; netArgs: Record<string, unknown> }> = [
      { name: "record 餐饮", args: { amount: 12.5, category: "餐饮", note: "午饭" }, netArgs: { amount: 12.5, category: "餐饮", note: "午饭" } },
      { name: "record 交通", args: { amount: 40.5, category: "交通", note: "打车" }, netArgs: { amount: 40.5, category: "交通", note: "打车" } },
      // 数字字符串：JS Number() 语义双轨等价（模型偶发把金额写成字符串）
      { name: "record 字符串金额", args: { amount: "7.5", category: "娱乐", note: "电影" }, netArgs: { amount: "7.5", category: "娱乐", note: "电影" } },
      { name: "record 非法字符串金额", args: { amount: "abc" }, netArgs: { amount: "abc" } },
      { name: "record 负数拒绝", args: { amount: -1 }, netArgs: { amount: -1 } },
    ];
    for (const c of recordCases) {
      const tsOut = await tsRecord(c.args);
      const host = await callSmokeTool("record_expense", c.netArgs, configFrames);
      const netOut = host.ok ? String(host.data ?? "") : "";
      if (tsOut === netOut) console.log(`[PASS] life ${c.name}`);
      else {
        failed++;
        console.log(`[FAIL] life ${c.name}:\n  TS =${tsOut}\n  NET=${netOut}`);
      }
    }
    for (const q of [
      { name: "query 汇总", args: { days: 30, summary: true } },
      { name: "query 明细", args: {} },
      // 字符串天数：JS Number() 语义双轨等价
      { name: "query 字符串天数", args: { days: "30", summary: true } },
    ]) {
      const tsOut = await tsQuery(q.args);
      const host = await callSmokeTool("query_expense", q.args, configFrames);
      const netOut = host.ok ? String(host.data ?? "") : "";
      if (tsOut === netOut) console.log(`[PASS] life ${q.name}`);
      else {
        failed++;
        console.log(`[FAIL] life ${q.name}:\n  TS =${tsOut}\n  NET=${netOut}`);
      }
    }
    // 账本结构对比（ts 为各自的写入时刻，必然不同；其余逐字段一致）
    const stripTs = (raw: string): unknown =>
      (JSON.parse(raw) as Array<Record<string, unknown>>).map(({ ts: _ts, ...rest }) => rest);
    const tsStore = stripTs(readFileSync(path.join(DUAL_TRACK_USER_DATA, "expenses.json"), "utf8"));
    const netStore = stripTs(readFileSync(path.join(netDataDir, "expenses.json"), "utf8"));
    if (JSON.stringify(tsStore) === JSON.stringify(netStore)) {
      console.log("[PASS] life expense 账本结构一致");
    } else {
      failed++;
      console.log(`[FAIL] life expense 账本结构不一致:\n  TS =${JSON.stringify(tsStore)}\n  NET=${JSON.stringify(netStore)}`);
    }
  } finally {
    rmSync(netDataDir, { recursive: true, force: true });
  }
  return failed;
}

/** search_text 双轨：镜像工作区 + 相同入参，输出逐字段对比（matches 排序后比）。 */
async function runSearchDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] search ${name}`);
    else { failed++; console.log(`[FAIL] search ${name} —— ${detail}`); }
  };

  const tsWorkspace = mkdtempSync(path.join(os.tmpdir(), "search-dual-ts-"));
  const netWorkspace = mkdtempSync(path.join(os.tmpdir(), "search-dual-net-"));
  const seed = (root: string): void => {
    mkdirSync(path.join(root, "src"), { recursive: true });
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    writeFileSync(path.join(root, "src", "a.ts"), "hello world\nconst x = 1;\nHELLO again\n");
    writeFileSync(path.join(root, "src", "b.py"), "hello python\n");
    writeFileSync(path.join(root, "node_modules", "c.js"), "hello dependency\n");
  };
  try {
    seed(tsWorkspace);
    seed(netWorkspace);
    const tsTools = await loadTsTools();
    const tsSearch = tsTools.get("search_text");
    if (!tsSearch) { check("TS 轨已注册", false); return failed; }

    const cases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "literal 大小写不敏感 + 上下文", args: { query: "hello", contextLines: 1 } },
      { name: "regex 模式", args: { query: "he.*o", mode: "regex", caseSensitive: true } },
      { name: "glob 过滤 *.ts", args: { query: "hello", fileGlobs: ["*.ts"] } },
      { name: "未命中 message", args: { query: "zzz-not-exist" } },
      { name: "路径逃逸拒绝", args: { query: "hello", paths: ["../outside"] } },
      // 字符串数字：JS Number() 语义（与第 1 组输出应逐字段一致）
      { name: "字符串数值参数", args: { query: "hello", contextLines: "1", maxMatches: "3" } },
    ];
    for (const c of cases) {
      const tsOut = JSON.parse(await tsSearch(c.args, { resolvedWorkspaceRoot: tsWorkspace })) as Record<string, unknown>;
      const host = await callSmokeTool("search_text", { ...c.args, __cyreneWorkspaceRoot: netWorkspace });
      const netOut = host.ok ? (JSON.parse(String(host.data ?? "")) as Record<string, unknown>) : {};
      const sortMatches = (v: unknown): unknown =>
        (v as Array<Record<string, unknown>>).slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const tsCmp = { ...tsOut, matches: sortMatches(tsOut.matches ?? []) };
      const netCmp = { ...netOut, matches: sortMatches(netOut.matches ?? []) };
      check(
        c.name,
        JSON.stringify(tsCmp) === JSON.stringify(netCmp),
        `ts=${JSON.stringify(tsCmp)} net=${JSON.stringify(netCmp)}`,
      );
    }
  } finally {
    rmSync(tsWorkspace, { recursive: true, force: true });
    rmSync(netWorkspace, { recursive: true, force: true });
  }
  return failed;
}

/** str_replace 双轨：相同文件镜像 + 相同入参，输出（路径归一化）+ 文件字节对比。 */
async function runStrReplaceDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] str_replace ${name}`);
    else { failed++; console.log(`[FAIL] str_replace ${name} —— ${detail}`); }
  };

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "srepl-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "srepl-dual-net-"));
  /** 把 TS 结果里出现的 TS 目录替换成 NET 目录（结构级），使两侧可直接比对。 */
  const replacePaths = (value: unknown, fromDir: string, toDir: string): unknown => {
    if (typeof value === "string") return value.split(fromDir).join(toDir);
    if (Array.isArray(value)) return value.map((v) => replacePaths(v, fromDir, toDir));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = replacePaths(v, fromDir, toDir);
      return out;
    }
    return value;
  };

  const cases: Array<{
    name: string;
    content: string;
    args: (dir: string) => Record<string, unknown>;
    expectSuccess: boolean;
  }> = [
    {
      name: "精确单处替换",
      content: "# 标题\n\n正文段落。\n",
      args: (d) => ({ file_path: path.join(d, "a.md"), old_string: "正文段落。", new_string: "修改后的正文。" }),
      expectSuccess: true,
    },
    {
      name: "空白归一化 + 缩进对齐",
      content: "function f() {\n    const x = 1;\n    return x;\n}\n",
      args: (d) => ({ file_path: path.join(d, "b.ts"), old_string: "const x = 1;\nreturn x;", new_string: "const x = 2;\nreturn x * 2;" }),
      expectSuccess: true,
    },
    {
      name: "批量 edits 顺序应用",
      content: "alpha\nbeta\ngamma\n",
      args: (d) => ({
        file_path: path.join(d, "c.txt"),
        edits: [
          { old_string: "alpha", new_string: "ALPHA" },
          { old_string: "gamma", new_string: "GAMMA" },
        ],
      }),
      expectSuccess: true,
    },
    {
      name: "CRLF 文件 EOL 归一化",
      content: "line1\r\nline2\r\nline3\r\n",
      args: (d) => ({ file_path: path.join(d, "d.txt"), old_string: "line2\nline3", new_string: "line2\nLINE3" }),
      expectSuccess: true,
    },
    {
      name: "多处匹配 diagnostic",
      content: "dup\ndup\ndup\n",
      args: (d) => ({ file_path: path.join(d, "e.txt"), old_string: "dup", new_string: "x" }),
      expectSuccess: false,
    },
    {
      name: "未找到 nearestMatch 诊断",
      content: "close enough text\nother\n",
      args: (d) => ({ file_path: path.join(d, "f.txt"), old_string: "close enouqh text", new_string: "x" }),
      expectSuccess: false,
    },
    {
      name: "参数缺失 INVALID_INPUT",
      content: "x\n",
      args: (d) => ({ file_path: path.join(d, "g.txt") }),
      expectSuccess: false,
    },
    {
      name: "空文件播种（old_string 空）",
      content: "",
      args: (d) => ({ file_path: path.join(d, "h.txt"), old_string: "", new_string: "种子内容\n" }),
      expectSuccess: true,
    },
  ];

  try {
    const tsTools = await loadTsTools();
    const tsStrReplace = tsTools.get("str_replace");
    if (!tsStrReplace) { check("TS 轨已注册", false); return failed + 1; }

    for (const c of cases) {
      const tsFile = String(c.args(tsHome).file_path);
      const netFile = String(c.args(netHome).file_path);
      writeFileSync(tsFile, c.content);
      writeFileSync(netFile, c.content);

      const tsOut = await tsStrReplace(c.args(tsHome));
      const host = await callSmokeTool("str_replace", c.args(netHome));
      const netOut = host.ok ? String(host.data ?? "") : "";
      const tsParsed = replacePaths(JSON.parse(tsOut), tsHome, netHome);
      const same = JSON.stringify(tsParsed) === JSON.stringify(JSON.parse(netOut));

      const tsBytes = readFileSync(tsFile);
      const netBytes = readFileSync(netFile);
      const bytesSame = Buffer.compare(tsBytes, netBytes) === 0;
      const wrote = (JSON.parse(netOut) as { success?: boolean }).success === true;
      check(
        c.name,
        same && bytesSame && (c.expectSuccess ? wrote : !wrote),
        `outSame=${same} bytesSame=${bytesSame} ts=${tsOut.slice(0, 200)} net=${netOut.slice(0, 200)}`,
      );
    }
  } finally {
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

/** apply_patch 双轨：镜像工作区 + 相对路径补丁（两侧同文本），输出逐字对比 + 落盘/结构快照对比。 */
async function runApplyPatchDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] apply_patch ${name}`);
    else { failed++; console.log(`[FAIL] apply_patch ${name} —— ${detail}`); }
  };

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "ap-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "ap-dual-net-"));
  const readIfExists = (p: string): string | null => {
    try { return readFileSync(p, "utf8"); } catch { return null; }
  };

  interface ApCase {
    name: string;
    setup: (dir: string) => void;
    patch: string;
    expectSuccess: boolean;
    snapshot: (dir: string) => Record<string, string | null>;
  }

  const cases: ApCase[] = [
    {
      name: "更新+新增多 hunk",
      setup: (d) => writeFileSync(path.join(d, "a.txt"), "alpha\nbeta\ngamma\n"),
      patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n alpha\n-beta\n+BETA\n gamma\n*** Add File: sub/new.txt\n+hello\n+world\n*** End Patch",
      expectSuccess: true,
      snapshot: (d) => ({
        a: readIfExists(path.join(d, "a.txt")),
        added: readIfExists(path.join(d, "sub", "new.txt")),
      }),
    },
    {
      name: "Move to 更新并移动",
      setup: (d) => writeFileSync(path.join(d, "m.txt"), "m1\nm2\n"),
      patch: "*** Begin Patch\n*** Update File: m.txt\n*** Move to: moved/m.txt\n@@\n-m1\n+M1\n*** End Patch",
      expectSuccess: true,
      snapshot: (d) => ({
        from: readIfExists(path.join(d, "m.txt")),
        to: readIfExists(path.join(d, "moved", "m.txt")),
      }),
    },
    {
      name: "CRLF 文件保留 EOL",
      setup: (d) => writeFileSync(path.join(d, "w.txt"), "one\r\ntwo\r\nthree\r\n"),
      patch: "*** Begin Patch\n*** Update File: w.txt\n@@\n one\n-two\n+TWO\n three\n*** End Patch",
      expectSuccess: true,
      snapshot: (d) => ({ w: readIfExists(path.join(d, "w.txt")) }),
    },
    {
      name: "删除文件",
      setup: (d) => writeFileSync(path.join(d, "del.txt"), "x\ny\n"),
      patch: "*** Begin Patch\n*** Delete File: del.txt\n*** End Patch",
      expectSuccess: true,
      snapshot: (d) => ({ del: readIfExists(path.join(d, "del.txt")) }),
    },
    {
      name: "上下文不匹配（全不执行）",
      setup: (d) => writeFileSync(path.join(d, "a.txt"), "alpha\n"),
      patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-nope\n+X\n*** End Patch",
      expectSuccess: false,
      snapshot: (d) => ({ a: readIfExists(path.join(d, "a.txt")) }),
    },
    {
      name: "新增已存在拒绝",
      setup: (d) => writeFileSync(path.join(d, "a.txt"), "alpha\n"),
      patch: "*** Begin Patch\n*** Add File: a.txt\n+z\n*** End Patch",
      expectSuccess: false,
      snapshot: (d) => ({ a: readIfExists(path.join(d, "a.txt")) }),
    },
    {
      name: "路径逃逸拒绝",
      setup: () => { /* 无文件 */ },
      patch: "*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch",
      expectSuccess: false,
      snapshot: () => ({}),
    },
    {
      name: "事务原子性（含失败 hunk 全不执行）",
      setup: (d) => writeFileSync(path.join(d, "a.txt"), "alpha\nbeta\n"),
      patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n beta\n+BETA\n*** Add File: ../escape2.txt\n+z\n*** End Patch",
      expectSuccess: false,
      snapshot: (d) => ({ a: readIfExists(path.join(d, "a.txt")) }),
    },
    {
      name: "非补丁文本拒绝",
      setup: () => { /* 无文件 */ },
      patch: "not a patch",
      expectSuccess: false,
      snapshot: () => ({}),
    },
  ];

  try {
    const tsTools = await loadTsTools();
    const tsApplyPatch = tsTools.get("apply_patch");
    if (!tsApplyPatch) { check("TS 轨已注册", false); return failed + 1; }

    for (const [idx, c] of cases.entries()) {
      const tsCaseDir = path.join(tsHome, String(idx));
      const netCaseDir = path.join(netHome, String(idx));
      mkdirSync(tsCaseDir, { recursive: true });
      mkdirSync(netCaseDir, { recursive: true });
      c.setup(tsCaseDir);
      c.setup(netCaseDir);

      const tsOut = await tsApplyPatch({ patch: c.patch }, { resolvedWorkspaceRoot: tsCaseDir });
      const host = await callSmokeTool("apply_patch", { patch: c.patch, __cyreneRoot: netCaseDir });
      const netOut = host.ok ? String(host.data ?? "") : "";

      // 相对路径 + relaxed 编码：两轨输出应逐字一致
      const sameOut = tsOut === netOut;
      const snapSame = JSON.stringify(c.snapshot(tsCaseDir)) === JSON.stringify(c.snapshot(netCaseDir));
      const success = (JSON.parse(tsOut) as { success?: boolean }).success === true;

      check(
        c.name,
        sameOut && snapSame && success === c.expectSuccess,
        `outSame=${sameOut} snapSame=${snapSame} ts=${tsOut.slice(0, 200)} net=${netOut.slice(0, 200)}`,
      );
    }
  } finally {
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

/** download_file 双轨：本地 HTTP 服务 + 相同入参，输出文案与落盘字节对比。 */
async function runDownloadDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] download ${name}`);
    else { failed++; console.log(`[FAIL] download ${name} —— ${detail}`); }
  };

  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0xff]);
  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/img.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(payload);
    } else if (url === "/noext") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("plain text body");
    } else if (url === "/unknown") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.end("data");
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "dl-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "dl-dual-net-"));
  try {
    const tsTools = await loadTsTools();
    const tsDownload = tsTools.get("download_file");
    if (!tsDownload) { check("TS 轨已注册", false); return failed + 1; }

    const cases: Array<{ name: string; args: Record<string, unknown>; saved: string | null }> = [
      { name: "显式 filename 图片落盘", args: { url: `${base}/img.png`, filename: "img.png" }, saved: "img.png" },
      { name: "Content-Type 补扩展名", args: { url: `${base}/noext` }, saved: "download.txt" },
      { name: "404 错误文案", args: { url: `${base}/missing` }, saved: null },
      { name: "危险后缀拒绝（不走网络）", args: { url: `${base}/img.png`, filename: "evil.exe" }, saved: null },
      { name: "脚本类后缀拒绝 .hta", args: { url: `${base}/img.png`, filename: "evil.hta" }, saved: null },
      { name: "脚本类后缀拒绝 .js", args: { url: `${base}/img.png`, filename: "evil.js" }, saved: null },
      { name: "未知 Content-Type 且无扩展名", args: { url: `${base}/unknown` }, saved: null },
    ];
    for (const c of cases) {
      const tsOut = await tsDownload(c.args, { resolvedWorkspaceRoot: tsHome });
      const host = await callSmokeTool("download_file", { ...c.args, __cyreneRoot: netHome });
      const netOut = host.ok ? String(host.data ?? "") : "";
      const tsNorm = tsOut.split(tsHome).join(netHome);
      let bytesSame = true;
      if (c.saved) {
        try {
          bytesSame = Buffer.compare(readFileSync(path.join(tsHome, c.saved)), readFileSync(path.join(netHome, c.saved))) === 0;
        } catch (error) {
          bytesSame = false;
        }
      }
      check(c.name, tsNorm === netOut && bytesSame, `ts=${tsNorm} net=${netOut} bytesSame=${bytesSame}`);
    }
  } finally {
    server.close();
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

// ── web_search 双轨（确定性校验路径：off / 缺 key / 空 query / 未知引擎）──

async function runWebSearchDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] web_search ${name}`);
    else { failed++; console.log(`[FAIL] web_search ${name} —— ${detail}`); }
  };

  const { clearWebSearchCache, setSearchConfig, webSearchTool } = await import(
    "../src/main/orchestrator/tools/builtin-tools/web-search-tool"
  );
  const cases: Array<{
    name: string;
    engine: string;
    keys?: { bocha?: string; tavily?: string; anySearch?: string };
    query: string;
    expected: string;
  }> = [
    { name: "未启用", engine: "off", query: "test", expected: "E_SEARCH_NOT_ENABLED" },
    { name: "缺 key", engine: "bocha", query: "test", expected: "E_SEARCH_KEY_MISSING" },
    { name: "空 query", engine: "bocha", keys: { bocha: "k" }, query: "   ", expected: "E_SEARCH_QUERY_EMPTY" },
    { name: "未知引擎", engine: "no-such", query: "test", expected: "E_SEARCH_ENGINE_NOT_SUPPORTED:no-such" },
  ];

  for (const c of cases) {
    clearWebSearchCache();
    setSearchConfig(
      () => c.engine,
      () => c.keys?.bocha ?? "",
      () => c.keys?.tavily ?? "",
      () => c.keys?.anySearch ?? "",
    );
    let tsError = "";
    try {
      await webSearchTool.execute({ query: c.query }, undefined);
    } catch (error) {
      tsError = error instanceof Error ? error.message : String(error);
    }
    const configFrame = {
      op: "config",
      webSearch: {
        engine: c.engine,
        bochaKey: c.keys?.bocha ?? "",
        tavilyKey: c.keys?.tavily ?? "",
        anySearchKey: c.keys?.anySearch ?? "",
      },
    };
    const host = await callSmokeTool("web_search", { query: c.query }, [configFrame]);
    const netError = host.ok ? "" : String(host.error ?? "");
    check(c.name, tsError === c.expected && netError === c.expected, `ts=${tsError} net=${netError}`);
  }
  return failed;
}

async function main(): Promise<void> {
  let failures = 0;
  const useSmoke = existsSync(SMOKE_DLL);
  const useWin = process.platform === "win32" && existsSync(WIN_EXE);
  console.log(`[dual-track] host: ${useWin ? "cyrene-native.exe" : useSmoke ? "smoke dll (Linux)" : "none"}`);

  if (!useSmoke && !useWin) {
    console.log("[SKIP] 无可用 .NET host——仅跑 TS 基线");
  } else {
    // calculator 双轨逐表达式 diff
    for (const expr of EXPRESSIONS) {
      let tsValue: number;
      try { tsValue = evaluateExpression(expr); } catch { continue; }  // TS 拒绝的表达式跳过（子集语义）
      const host = useWin ? null : await callSmokeTool("calculator", { expression: expr });
      if (useWin) { console.log(`[INFO] win exe 轨待 Windows 机跑`); break; }
      const netValue = parseCalcResult(host?.data ?? null);
      if (netValue === null) { failures++; console.log(`[FAIL] ${expr}: .NET 轨无值 (${JSON.stringify(host?.data)}), TS=${tsValue}`); continue; }
      const same = Math.abs(netValue - tsValue) < 1e-9 || Math.abs(netValue - tsValue) / Math.max(Math.abs(tsValue), 1) < 1e-9;
      if (same) console.log(`[PASS] ${expr} = ${tsValue}`);
      else { failures++; console.log(`[FAIL] ${expr}: TS=${tsValue} .NET=${netValue}`); }
    }
    // tool-host 握手
    const r = await callSmokeTool("calculator", { expression: "1+1" });
    if (parseCalcResult(r.data) !== null) console.log("[PASS] tool-host call 帧序");
    else if (useWin) console.log("[SKIP] smoke 帧序（win 轨）");
    else { failures++; console.log("[FAIL] tool-host call 帧序"); }
    // fs 三件双轨（evidence 帧协议 v1）
    if (useSmoke) failures += await runFsDualTrack();
    else console.log("[SKIP] fs 双轨（仅 smoke dll 轨支持）");
    // 生活类工具双轨（exchange_rate + expense）
    if (useSmoke) failures += await runLifeDualTrack();
    else console.log("[SKIP] life 双轨（仅 smoke dll 轨支持）");
    // 搜索工具双轨（search_text）
    if (useSmoke) failures += await runSearchDualTrack();
    else console.log("[SKIP] search 双轨（仅 smoke dll 轨支持）");
    // 精确替换双轨（str_replace）
    if (useSmoke) failures += await runStrReplaceDualTrack();
    else console.log("[SKIP] str_replace 双轨（仅 smoke dll 轨支持）");
    // 结构化补丁双轨（apply_patch）
    if (useSmoke) failures += await runApplyPatchDualTrack();
    else console.log("[SKIP] apply_patch 双轨（仅 smoke dll 轨支持）");
    // 下载双轨（download_file，本地 HTTP 服务）
    if (useSmoke) failures += await runDownloadDualTrack();
    else console.log("[SKIP] download 双轨（仅 smoke dll 轨支持）");
    // web_search 双轨（config 帧注入的确定性校验路径）
    if (useSmoke) failures += await runWebSearchDualTrack();
    else console.log("[SKIP] web_search 双轨（仅 smoke dll 轨支持）");
  }

  console.log(failures === 0 ? "dual-track-diff: PASS" : `dual-track-diff: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
