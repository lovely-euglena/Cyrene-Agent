/**
 * B6 一致性测试框架——TS↔.NET 双轨语义等价对比（Linux 可全跑）。
 *
 * calculator：同一表达式集，TS evaluateExpression vs cyrene-smoke
 * （同源编译的 .NET Calculator），数值差 >1e-9 即 FAIL。
 * fs 三件：write_file（新建/覆盖/追加/空内容）输出 JSON 与落盘字节级对齐、
 * read_file 窗口语义对齐、list_dir 文本对齐（evidence 帧协议 v1）。
 * tool-host：list/call 帧序握手（fs 三件+calculator roundtrip）。
 * web_search：确定性校验路径双轨（引擎/key 经 config 帧注入，无网络）。
 * weather / plan_trip：确定性路径双轨（配置/缺参/未启用，无网络）。
 * git 八件：镜像仓库 + 本地 bare 远程（TS 纯回退实现 ↔ smoke host；commit/log/revert hash 归一）。
 * Linux 用 dotnet/smoke-host（冒烟壳）；Windows 优先 cyrene-native.exe。
 */
import { DUAL_TRACK_USER_DATA } from "./dual-track-env";
import { spawn, spawnSync } from "node:child_process";
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

// ── weather / plan_trip 双轨（确定性路径：配置/缺参/未启用，无网络）──

async function runWeatherTravelDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] ${name}`);
    else { failed++; console.log(`[FAIL] ${name} —— ${detail}`); }
  };

  const { clearWeatherCaches, setWeatherConfig, weatherTool } = await import(
    "../src/main/orchestrator/tools/builtin-tools/weather-tool"
  );
  const travelTools = await import("../src/main/orchestrator/tools/travel-tools");
  travelTools.registerTravelTools();
  const { toolRegistry } = await import("../src/main/orchestrator/tools/registry/tool-registry");
  const planTrip = toolRegistry.getById("plan_trip") as
    | { execute: (args: Record<string, unknown>, ctx?: unknown) => Promise<string> }
    | undefined;

  // weather：TS 经 setWeatherConfig 注入读取器；NET 经 config 帧
  const weatherCases: Array<{
    name: string;
    ts: () => void;
    host: Record<string, unknown>;
    args: Record<string, unknown>;
    expected: string;
  }> = [
    {
      name: "weather 未启用",
      ts: () => setWeatherConfig(() => "北京", () => "open-meteo", () => "", undefined, () => false),
      host: { city: "北京", source: "open-meteo", amapKey: "", enabled: false, language: "zh" },
      args: {},
      expected: "[错误] 天气查询功能未启用，请在设置里开启",
    },
    {
      name: "weather 无城市",
      ts: () => setWeatherConfig(() => "", () => "open-meteo", () => ""),
      host: { city: "", source: "open-meteo", amapKey: "", enabled: true, language: "zh" },
      args: {},
      expected: "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。",
    },
    {
      name: "weather 未知源",
      ts: () => setWeatherConfig(() => "", () => "bogus", () => ""),
      host: { city: "", source: "bogus", amapKey: "", enabled: true, language: "zh" },
      args: { city: "上海" },
      expected: "[错误] 未知的天气源\"bogus\"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。",
    },
    {
      name: "weather 高德缺 key",
      ts: () => setWeatherConfig(() => "", () => "amap", () => ""),
      host: { city: "", source: "amap", amapKey: "", enabled: true, language: "zh" },
      args: { city: "上海" },
      expected: "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。",
    },
  ];

  for (const c of weatherCases) {
    clearWeatherCaches();
    c.ts();
    let tsOut = "";
    try {
      tsOut = await weatherTool.execute(c.args, undefined);
    } catch (error) {
      tsOut = `ERR:${error instanceof Error ? error.message : String(error)}`;
    }
    const host = await callSmokeTool("weather", c.args, [{ op: "config", weather: c.host }]);
    const netOut = host.ok ? String(host.data ?? "") : `ERR:${host.error}`;
    check(c.name, tsOut === c.expected && netOut === c.expected, `ts=${tsOut} net=${netOut}`);
  }

  // plan_trip：TS 经 setTravelConfig 注入；NET 经 config 帧
  if (!planTrip) {
    check("plan_trip 已注册", false);
    return failed;
  }
  const { setTravelConfig } = travelTools;
  const travelCases: Array<{
    name: string;
    ts: () => void;
    host: Record<string, unknown>;
    args: Record<string, unknown>;
    expected: string;
  }> = [
    {
      name: "plan_trip 未启用",
      ts: () => setTravelConfig(() => "k", () => false),
      host: { amapKey: "k", enabled: false },
      args: { origin: "A", destination: "B" },
      expected: "[错误] 出行工具未启用，请在设置里开启",
    },
    {
      name: "plan_trip 缺 key",
      ts: () => setTravelConfig(() => ""),
      host: { amapKey: "", enabled: true },
      args: { origin: "A", destination: "B" },
      expected: "[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。",
    },
    {
      name: "plan_trip 缺起点",
      ts: () => setTravelConfig(() => "k"),
      host: { amapKey: "k", enabled: true },
      args: { destination: "B" },
      expected: "[错误] 请提供起点和终点",
    },
  ];

  for (const c of travelCases) {
    c.ts();
    let tsOut = "";
    try {
      tsOut = await planTrip.execute(c.args, undefined);
    } catch (error) {
      tsOut = `ERR:${error instanceof Error ? error.message : String(error)}`;
    }
    const host = await callSmokeTool("plan_trip", c.args, [{ op: "config", travel: c.host }]);
    const netOut = host.ok ? String(host.data ?? "") : `ERR:${host.error}`;
    check(c.name, tsOut === c.expected && netOut === c.expected, `ts=${tsOut} net=${netOut}`);
  }
  return failed;
}

// ── fetch_url 双轨（本地 HTTP fixture；raw 逐字、markdown 归一投影）──
//
// 库替代（Turndown → ReverseMarkdown）无法逐字节一致，双轨按"归一投影"比对：
//  - 列表项缩进宽度（Turndown 4 列 vs ReverseMarkdown 1 列）与行尾空白归一；
//  - 表格：Turndown 核心不支持表格（拍平为文本块），ReverseMarkdown 输出 GFM 管道表——
//    显式断言该已知差异（两者都保留单元格文字，NET 结构更完整），防未来静默漂移；
//  - 正文容器路径（article ≥200 字）严格比对；整页回退路径的 <title> 差异见 FetchUrlTool.cs 头注释。

/** fetch_url markdown 归一投影：列表缩进宽度 + 行尾空白。 */
function normalizeFetchMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .map((line) => line.replace(/^(\s*)([-*+])\s{1,4}/, "$1$2 "))
    .map((line) => line.replace(/^(\s*)(\d+\.)\s{1,4}/, "$1$2 "))
    .join("\n");
}

async function runFetchUrlDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] fetch_url ${name}`);
    else { failed++; console.log(`[FAIL] fetch_url ${name} —— ${detail}`); }
  };

  const filler = "填充文字".repeat(30); // 120 字：保证 article 正文稳定 ≥200 字阈值（走正文容器路径）
  const page = `<!doctype html><html><head><title>Fixture</title><style>.x{}</style><script>var a=1;</script></head>
<body><nav>导航链接 首页</nav><header>页头</header>
<article><h1>大标题</h1>
<p>这是正文段落，包含<strong>加粗</strong>与<em>斜体</em>以及<a href="https://example.com/x">链接</a>。${filler}</p>
<ul><li>项目一</li><li>项目二</li></ul>
<pre><code>const x = 1;</code></pre>
<p>结尾段落：${filler}</p>
</article><footer>页脚</footer><aside>侧栏</aside></body></html>`;
  const tablePage = `<!doctype html><html><body><article><h1>表格页</h1>
<p>${filler}</p>
<table><thead><tr><th>列A</th><th>列B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>
<p>${filler}</p></article></body></html>`;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/page.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(page);
    } else if (url === "/table.html") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(tablePage);
    } else {
      res.statusCode = 404;
      res.end("nope");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // 强制 TS 轨：临时关闭 toolHost 并重置配置缓存，确保比对的是 TS 原实现而非 native 转发
  const prevEnv = process.env.CYRENE_TOOL_HOST;
  process.env.CYRENE_TOOL_HOST = "0";
  try {
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    const { fetchUrlTool } = await import("../src/main/orchestrator/tools/builtin-tools/fetch-url-tool");
    const tsFetch = (args: Record<string, unknown>): Promise<string> => fetchUrlTool.execute(args, undefined);

    // 1. markdown（正文容器路径）：归一投影比对
    const tsMd = await tsFetch({ url: `${base}/page.html` });
    const netMdHost = await callSmokeTool("fetch_url", { url: `${base}/page.html` });
    const netMd = String(netMdHost.data ?? "");
    check("markdown 归一投影（标题/段落/列表/代码块）",
      normalizeFetchMarkdown(tsMd) === normalizeFetchMarkdown(netMd),
      `ts=${JSON.stringify(normalizeFetchMarkdown(tsMd).slice(0, 220))} net=${JSON.stringify(normalizeFetchMarkdown(netMd).slice(0, 220))}`);

    // 2. raw：逐字比对
    const tsRaw = await tsFetch({ url: `${base}/page.html`, format: "raw" });
    const netRawHost = await callSmokeTool("fetch_url", { url: `${base}/page.html`, format: "raw" });
    const netRaw = String(netRawHost.data ?? "");
    check("raw 逐字（原文不转换）", tsRaw === netRaw, `ts=${JSON.stringify(tsRaw.slice(0, 160))} net=${JSON.stringify(netRaw.slice(0, 160))}`);

    // 3. 404：错误文案逐字
    const ts404 = await tsFetch({ url: `${base}/missing` });
    const net404Host = await callSmokeTool("fetch_url", { url: `${base}/missing` });
    check("404 错误文案", ts404 === String(net404Host.data ?? "") && ts404.startsWith("[错误] HTTP 404"), `ts=${ts404} net=${net404Host.data}`);

    // 4. 非法协议：校验文案逐字
    const tsBad = await tsFetch({ url: "ftp://example.com/x" });
    const netBadHost = await callSmokeTool("fetch_url", { url: "ftp://example.com/x" });
    check("非法协议拒绝文案", tsBad === String(netBadHost.data ?? ""), `ts=${tsBad} net=${netBadHost.data}`);

    // 5. 表格：已知库差异显式断言（都保留单元格文字；NET 输出 GFM 管道表，TS 拍平）
    const tsTable = await tsFetch({ url: `${base}/table.html` });
    const netTableHost = await callSmokeTool("fetch_url", { url: `${base}/table.html` });
    const netTable = String(netTableHost.data ?? "");
    check("表格已知差异（TS 拍平 / NET GFM 管道表，均保留文字）",
      tsTable.includes("列A") && tsTable.includes("列B") && !tsTable.includes("| 列A |")
      && netTable.includes("| 列A |") && netTable.includes("| 列B |"),
      `ts=${JSON.stringify(tsTable.slice(0, 200))} net=${JSON.stringify(netTable.slice(0, 200))}`);
  } finally {
    server.close();
    if (prevEnv === undefined) delete process.env.CYRENE_TOOL_HOST;
    else process.env.CYRENE_TOOL_HOST = prevEnv;
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
  }
  return failed;
}

// ── 文档四件双轨（write_markdown / write_excel / write_word / write_pdf）──
//
// 库替代（exceljs→ClosedXML、docx→Open XML SDK、pdfkit→QuestPDF）无法逐字节一致：
//  - write_markdown：结果 JSON 投影（success/tool/append/changes）+ 落盘字节逐字节；
//  - write_excel：exceljs 读回两文件比对投影（值/数字格式/列宽容差 ±1/主题色/冻结/筛选）；
//  - write_word：JSZip（经 exceljs 传递依赖解析）抽 word/document.xml，比对段落文本 +
//    run 属性（字体/字号/颜色/加粗/段落间距）；
//  - write_pdf：结果文案 + 文件签名；.NET 侧文本提取（smoke-host --pdf-text）断言标题/段落
//    （pdfkit 无读回能力，TS 侧不做文本提取——内容校验由 .NET 侧承担，已在决策文档注明）。

/** 经 exceljs 的依赖树解析 jszip（项目未直接依赖 zip 库；pnpm 隔离布局下用 paths 解析）。 */
function loadJsZip(): { loadAsync(data: Buffer): Promise<{ file(name: string): { async(type: string): Promise<string> } | null }> } {
  const requireFn = require as unknown as ((id: string) => unknown) & { resolve(id: string, opts?: { paths?: string[] }): string };
  const jszipPath = requireFn.resolve("jszip", { paths: [requireFn.resolve("exceljs")] });
  return requireFn(jszipPath) as never;
}

/**
 * xlsx 投影读取（JSZip + 前缀归一 + 正则）：同时兼容 exceljs（无前缀）与
 * ClosedXML（x: 前缀）两种写法。exceljs 的读取器只认无前缀标签，读不了
 * ClosedXML 输出（WorkbookXform 按精确 tag 匹配），故不依赖读取库。
 * 投影：sheet 名 / 单元格（值 + 数字格式）/ 列宽 / 冻结 / 自动筛选。
 */
async function readXlsxProjection(file: string): Promise<Record<string, unknown>> {
  const JSZip = loadJsZip();
  const zip = await JSZip.loadAsync(readFileSync(file));
  const read = async (name: string): Promise<string> => {
    const entry = zip.file(name);
    const xml = entry ? await entry.async("string") : "";
    // 去元素前缀（<x:foo> → <foo>），属性前缀（r:id / mc:*）不动
    return xml.replace(/<\/?x:/g, (m) => (m.startsWith("</") ? "</" : "<"));
  };

  const workbook = await read("xl/workbook.xml");
  const sheet = workbook.match(/<sheet[^>]*name="([^"]*)"/)?.[1] ?? "";

  const sharedXml = await read("xl/sharedStrings.xml");
  const sharedStrings = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));

  const stylesXml = await read("xl/styles.xml");
  const numFmtMap = new Map<number, string>();
  for (const m of stylesXml.matchAll(/<numFmt[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g)) {
    numFmtMap.set(Number(m[1]), m[2]);
  }
  const builtinNumFmt: Record<number, string> = {
    0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
    9: "0%", 10: "0.00%", 14: "mm-dd-yy", 49: "@",
  };
  const cellXfsXml = stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const styleNumFmtIds = [...cellXfsXml.matchAll(/<xf[^>]*numFmtId="(\d+)"/g)].map((m) => Number(m[1]));
  const numFmtOf = (styleIdx: number): string => {
    const id = styleNumFmtIds[styleIdx] ?? 0;
    const code = numFmtMap.get(id) ?? builtinNumFmt[id] ?? "";
    return code === "General" ? "" : code;
  };

  const sheetXml = await read("xl/worksheets/sheet1.xml");
  const cells: Array<{ addr: string; value: unknown; numFmt: string }> = [];
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"(?:[^>]*\bs="(\d+)")?[^>]*?(?:\bt="(\w+)")?[^>]*>([\s\S]*?)<\/c>/g)) {
    const addr = m[1];
    const styleIdx = m[2] !== undefined ? Number(m[2]) : 0;
    const type = m[3] ?? "n";
    const raw = m[4].match(/<v>([^<]*)<\/v>/)?.[1];
    let value: unknown = null;
    if (type === "s" && raw !== undefined) value = sharedStrings[Number(raw)] ?? "";
    else if (type === "inlineStr") value = [...m[4].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("");
    else if (raw !== undefined) value = Number(raw);
    cells.push({ addr, value, numFmt: numFmtOf(styleIdx) });
  }

  const widths: Record<number, number> = {};
  for (const m of sheetXml.matchAll(/<col[^>]*min="(\d+)"[^>]*max="(\d+)"[^>]*width="([\d.]+)"/g)) {
    for (let i = Number(m[1]); i <= Number(m[2]); i++) widths[i] = Number(m[3]);
  }
  const frozen = /<pane[^>]*ySplit="1"/.test(sheetXml);
  const autoFilter = sheetXml.match(/<autoFilter ref="([^"]*)"/)?.[1] ?? null;
  const solidFills = [...stylesXml.matchAll(/patternType="solid"[^>]*>\s*<fgColor rgb="([0-9A-Fa-f]{8})"/g)]
    .map((m) => m[1].toUpperCase()).sort();

  return { sheet, cells, widths, frozen, autoFilter, solidFills };
}

/** 列宽逐列比较（ClosedXML 写入 width 含 0.71 字符内边距，容差 ±1）。 */
function widthsClose(tsWidths: Record<number, number>, netWidths: Record<number, number>): boolean {
  const keys = new Set([...Object.keys(tsWidths), ...Object.keys(netWidths)].map(Number));
  for (const key of keys) {
    const a = tsWidths[key];
    const b = netWidths[key];
    if (a === undefined || b === undefined) return false;
    if (Math.abs(a - b) > 1) return false;
  }
  return true;
}

async function readDocxProjection(file: string): Promise<unknown> {
  const JSZip = loadJsZip();
  const zip = await JSZip.loadAsync(readFileSync(file));
  const entry = zip.file("word/document.xml");
  const xml = entry ? await entry.async("string") : "";
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => {
    const p = m[0];
    const texts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => t[1]);
    const rpr = p.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? "";
    return {
      text: texts.join(""),
      bold: /<w:b\s*\/>/.test(rpr),
      sz: rpr.match(/<w:sz w:val="(\d+)"/)?.[1] ?? null,
      color: rpr.match(/<w:color w:val="([0-9A-Fa-f]{6})"/)?.[1] ?? null,
      fonts: [...rpr.matchAll(/w:(?:ascii|eastAsia|hAnsi)="([^"]+)"/g)].map((m) => m[1]).sort().join(","),
      after: p.match(/<w:spacing[^>]*w:after="(\d+)"/)?.[1] ?? null,
      line: p.match(/<w:spacing[^>]*w:line="(\d+)"/)?.[1] ?? null,
    };
  });
}

async function runDocumentDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] document ${name}`);
    else { failed++; console.log(`[FAIL] document ${name} —— ${detail}`); }
  };

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "doc-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "doc-dual-net-"));

  const prevEnv = process.env.CYRENE_TOOL_HOST;
  process.env.CYRENE_TOOL_HOST = "0";
  try {
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    const docTools = await import("../src/main/orchestrator/tools/document-tools");
    docTools.registerDocumentTools();
    const { toolRegistry } = await import("../src/main/orchestrator/tools/registry/tool-registry");
    const runTs = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = toolRegistry.getById(id);
      if (!tool) throw new Error(`TS 工具未注册: ${id}`);
      return tool.execute(args, { resolvedWorkspaceRoot: tsHome } as never);
    };
    const normalize = (text: string): string => text.split(tsHome).join(netHome);

    // 1. write_markdown：新建 / 追加 / 覆盖（结果投影 + 落盘字节）
    {
      const cases: Array<{ name: string; args: Record<string, unknown>; path: string }> = [
        { name: "新建", args: { filename: "笔记.md", content: "第一行\n第二行" }, path: "笔记.md" },
        { name: "追加", args: { filename: "笔记.md", content: "第三行", append: true }, path: "笔记.md" },
        { name: "覆盖", args: { filename: "覆盖.md", content: "a\nb\nc" }, path: "覆盖.md" },
      ];
      for (const c of cases) {
        const tsOut = await runTs("write_markdown", c.args);
        const host = await callSmokeTool("write_markdown", { path: path.join(netHome, c.path), content: c.args.content, append: c.args.append ?? false });
        const netOut = String(host.data ?? "");
        const proj = (text: string): unknown => {
          const j = JSON.parse(text) as Record<string, unknown>;
          return {
            success: j.success, tool: j.tool, append: j.append,
            changes: (j.changes as Array<Record<string, unknown>>).map((ch) => ({
              kind: ch.kind, insertions: ch.insertions, deletions: ch.deletions, diff: ch.diff,
            })),
          };
        };
        const bytesSame = Buffer.compare(readFileSync(path.join(tsHome, c.path)), readFileSync(path.join(netHome, c.path))) === 0;
        check(`write_markdown ${c.name}（投影 + 字节）`,
          JSON.stringify(proj(tsOut)) === JSON.stringify(proj(netOut)) && bytesSame,
          `ts=${JSON.stringify(proj(tsOut)).slice(0, 180)} net=${JSON.stringify(proj(netOut)).slice(0, 180)} bytes=${bytesSame}`);
      }
    }

    // 2. write_excel：读回投影（值/数字格式/列宽 ±1/主题色/冻结/筛选/边框）
    {
      const args = {
        filename: "成绩.xlsx",
        sheets: [{ name: "成绩", headers: ["姓名", "分数", "比率"], rows: [["张三", 95, 0.5], ["李四", 1200, 0.25]] }],
      };
      const tsOut = await runTs("write_excel", args);
      const host = await callSmokeTool("write_excel", {
        path: path.join(netHome, "成绩.xlsx"),
        sheets: args.sheets,
        theme: { headerFill: "FF1F4E79", headerFont: "FFFFFFFF", headerBorder: "FF1F4E79", zebraFill: "FFF2F2F2", borderColor: "FFBFBFBF" },
      });
      const netOut = String(host.data ?? "");
      const tsProj = await readXlsxProjection(path.join(tsHome, "成绩.xlsx"));
      const netProj = await readXlsxProjection(path.join(netHome, "成绩.xlsx"));
      const tsWidths = tsProj.widths as Record<number, number>;
      const netWidths = netProj.widths as Record<number, number>;
      const widthsOk = widthsClose(tsWidths, netWidths);
      const sameExceptWidths = JSON.stringify({ ...tsProj, widths: null }) === JSON.stringify({ ...netProj, widths: null });
      check("write_excel 投影（值/数字格式/主题色/冻结/筛选 + 列宽容差 ±1）",
        normalize(tsOut) === netOut && sameExceptWidths && widthsOk,
        `result=${normalize(tsOut) === netOut} proj=${sameExceptWidths} widths=${widthsOk} ts=${JSON.stringify(tsProj).slice(0, 260)} net=${JSON.stringify(netProj).slice(0, 260)}`);
    }

    // 3. write_word：抽 document.xml 比对段落文本 + run 属性
    {
      const args = { filename: "报告.docx", title: "季度报告", paragraphs: ["第一段正文。", "第二段正文。"] };
      const tsOut = await runTs("write_word", args);
      const host = await callSmokeTool("write_word", {
        path: path.join(netHome, "报告.docx"),
        title: args.title,
        paragraphs: args.paragraphs,
        theme: { titleColor: "1F4E79", titleSize: 28, titleFont: "微软雅黑", bodyFont: "微软雅黑", bodySize: 24, bodyColor: "333333", lineSpacing: 360, headingColor: "1F4E79" },
      });
      const netOut = String(host.data ?? "");
      const tsProj = await readDocxProjection(path.join(tsHome, "报告.docx"));
      const netProj = await readDocxProjection(path.join(netHome, "报告.docx"));
      check("write_word 段落文本 + run 属性（字体/字号/颜色/加粗/间距）",
        normalize(tsOut) === netOut && JSON.stringify(tsProj) === JSON.stringify(netProj),
        `ts=${JSON.stringify(tsProj).slice(0, 260)} net=${JSON.stringify(netProj).slice(0, 260)}`);
    }

    // 4. write_pdf：结果文案 + 签名 + .NET 文本提取
    // 注意：TS 轨 pdfkit 与本机 msyh.ttc 不兼容（既有问题：fontkit 集合对象无 createSubset，
    // doc.text() 抛错）——该环境下跳过 TS 侧生成比对，只校验 .NET 轨；QuestPDF 正确支持
    // TTC（迁移顺带修复）。Linux（无 CJK 字体）中文断言仅在 Windows 跑。
    {
      const args = { filename: "合同.pdf", title: "PDF Report 合作协议", paragraphs: ["Alpha 甲方：示例公司", "Beta 乙方：测试公司"] };
      let tsOut: string | null = null;
      try {
        tsOut = await runTs("write_pdf", args);
      } catch (error) {
        console.log(`[INFO] document write_pdf TS 轨生成失败（已知 msyh.ttc/pdfkit 兼容问题），仅校验 .NET 轨: ${error instanceof Error ? error.message : error}`);
      }
      const host = await callSmokeTool("write_pdf", { path: path.join(netHome, "合同.pdf"), title: args.title, paragraphs: args.paragraphs });
      const netOut = String(host.data ?? "");
      const netSig = readFileSync(path.join(netHome, "合同.pdf")).subarray(0, 5).toString() === "%PDF-";
      const tsSig = tsOut === null ? true : readFileSync(path.join(tsHome, "合同.pdf")).subarray(0, 5).toString() === "%PDF-";
      const probe = spawnSync("dotnet", [SMOKE_DLL, "--pdf-text", path.join(netHome, "合同.pdf")], { encoding: "utf-8", cwd: path.dirname(SMOKE_DLL) });
      const pdfText = probe.stdout ?? "";
      const asciiOk = pdfText.includes("PDF Report") && pdfText.includes("Alpha") && pdfText.includes("Beta");
      const cjkOk = process.platform !== "win32"
        || (pdfText.includes("合作协议") && pdfText.includes("甲方：示例公司") && pdfText.includes("乙方：测试公司"));
      check("write_pdf 文案 + 签名 + 文本提取（标题/段落）",
        (tsOut === null || normalize(tsOut) === netOut) && netSig && tsSig && asciiOk && cjkOk,
        `result=${tsOut === null ? "ts-skip" : normalize(tsOut) === netOut} sig=${netSig} tsSig=${tsSig} text=${JSON.stringify(pdfText.slice(0, 160))}`);
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CYRENE_TOOL_HOST;
    else process.env.CYRENE_TOOL_HOST = prevEnv;
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

// ── 邮件四件双轨（确定性校验路径：配置缺失/参数非法，无网络）──
//
// IMAP/SMTP 快乐路径依赖 fake 服务器（矩阵侧已覆盖 C# 轨）；双轨比对校验文案与
// 回退契约：TS（getter 注入）↔ .NET（config 帧注入）在校验失败时逐字一致。

async function runEmailDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] email ${name}`);
    else { failed++; console.log(`[FAIL] email ${name} —— ${detail}`); }
  };

  const prevEnv = process.env.CYRENE_TOOL_HOST;
  process.env.CYRENE_TOOL_HOST = "0";
  try {
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    const emailTools = await import("../src/main/orchestrator/tools/email-tools");
    emailTools.registerEmailTools();
    const { toolRegistry } = await import("../src/main/orchestrator/tools/registry/tool-registry");
    const runTs = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = toolRegistry.getById(id);
      if (!tool) throw new Error(`TS 工具未注册: ${id}`);
      return tool.execute(args, undefined as never);
    };
    const inject = (cfg: Record<string, unknown>): void => {
      emailTools.setEmailConfig(
        () => cfg.enabled as boolean,
        () => cfg.host as string,
        () => cfg.port as number,
        () => cfg.secure as boolean,
        () => cfg.user as string,
        () => cfg.pass as string,
        () => cfg.fromName as string,
        () => cfg.imapHost as string,
        () => cfg.imapPort as number,
        () => cfg.imapSecure as boolean,
      );
    };
    const netCfg = (cfg: Record<string, unknown> | null): Record<string, unknown> | null => cfg === null ? null : {
      enabled: cfg.enabled, smtpHost: cfg.host ?? "", smtpPort: cfg.port ?? 465, smtpSecure: cfg.secure ?? true,
      user: cfg.user ?? "", pass: cfg.pass ?? "", fromName: cfg.fromName ?? "",
      imapHost: cfg.imapHost ?? "", imapPort: cfg.imapPort ?? 993, imapSecure: cfg.imapSecure ?? true,
    };

    const full = {
      enabled: true, host: "smtp.example.com", port: 465, secure: true, user: "u@example.com", pass: "p",
      fromName: "C", imapHost: "imap.example.com", imapPort: 993, imapSecure: true,
    };
    const cases: Array<{ name: string; tool: string; args: Record<string, unknown>; cfg: Record<string, unknown>; expected: string }> = [
      { name: "email_list 未启用", tool: "email_list", args: {}, cfg: { enabled: false },
        expected: "[错误] 邮件功能未启用，请在设置里开启" },
      { name: "email_list 缺 IMAP 主机", tool: "email_list", args: {}, cfg: { ...full, imapHost: "" },
        expected: "[错误] IMAP 未配置：请在设置 → 插件 → 邮件 填写 IMAP 服务器（收信与发信共用邮箱与授权码）" },
      { name: "email_list 缺凭据", tool: "email_list", args: {}, cfg: { ...full, user: "" },
        expected: "[错误] IMAP 配置不完整：缺少发件邮箱/授权码（收信与发信共用）" },
      { name: "email_read 缺 uid", tool: "email_read", args: {}, cfg: full,
        expected: "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）" },
      { name: "email_mark 缺 uid", tool: "email_mark", args: { uid: 0 }, cfg: full,
        expected: "[错误] 缺少有效的邮件 uid（先用 email_list 获取 uid）" },
      { name: "send_email 未启用", tool: "send_email", args: { to: ["a@b.com"], subject: "s", body: "b" }, cfg: { enabled: false },
        expected: "[错误] 邮件功能未启用，请在设置里开启" },
      { name: "send_email SMTP 配置不完整", tool: "send_email", args: { to: ["a@b.com"], subject: "s", body: "b" }, cfg: { ...full, host: "" },
        expected: "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码" },
      { name: "send_email 空收件人", tool: "send_email", args: { to: [], subject: "s", body: "b" }, cfg: full,
        expected: "[错误] 收件人列表为空" },
      { name: "send_email 收件人无效", tool: "send_email", args: { to: ["bad"], subject: "s", body: "b" }, cfg: full,
        expected: "[错误] 收件人邮箱无效：bad" },
      { name: "send_email 主题为空", tool: "send_email", args: { to: ["a@b.com"], subject: " ", body: "b" }, cfg: full,
        expected: "[错误] 邮件主题不能为空" },
      { name: "send_email 正文为空", tool: "send_email", args: { to: ["a@b.com"], subject: "s", body: "" }, cfg: full,
        expected: "[错误] 邮件正文不能为空" },
      { name: "send_email 附件不存在", tool: "send_email", args: { to: ["a@b.com"], subject: "s", body: "b", attachments: ["C:/definitely/not/exists-xyz.txt"] }, cfg: full,
        expected: "[错误] 附件不存在：C:/definitely/not/exists-xyz.txt" },
    ];
    for (const c of cases) {
      inject(c.cfg);
      const tsOut = await runTs(c.tool, c.args);
      const host = await callSmokeTool(c.tool, c.args, [{ op: "config", email: netCfg(c.cfg) }]);
      const netOut = String(host.data ?? "");
      check(c.name, tsOut === c.expected && netOut === c.expected, `ts=${tsOut} net=${netOut} expected=${c.expected}`);
    }
  } finally {
    if (prevEnv === undefined) delete process.env.CYRENE_TOOL_HOST;
    else process.env.CYRENE_TOOL_HOST = prevEnv;
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
  }
  return failed;
}

// ── ast_grep 双轨（共享 fixture 工作区；TS napi ↔ .NET CLI JSON）──
//
// 显式有序 paths 规避目录枚举顺序差异；输出 JSON 逐字比对（路径为相对路径，两侧一致）；
// 改写落盘后字节级比对。CLI 平台包缺失时跳过（TS 侧仍可运行）。

async function runAstGrepDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] ast_grep ${name}`);
    else { failed++; console.log(`[FAIL] ast_grep ${name} —— ${detail}`); }
  };

  const tsHome = mkdtempSync(path.join(os.tmpdir(), "sg-dual-ts-"));
  const netHome = mkdtempSync(path.join(os.tmpdir(), "sg-dual-net-"));
  for (const home of [tsHome, netHome]) {
    mkdirSync(path.join(home, "src"), { recursive: true });
    writeFileSync(path.join(home, "src", "a.ts"), 'console.log("a", x);\nconst y = 1;\nconsole.log(y);\n', "utf8");
    writeFileSync(path.join(home, "src", "b.ts"), 'function f() { console.log("b"); }\n', "utf8");
  }

  const prevEnv = process.env.CYRENE_TOOL_HOST;
  process.env.CYRENE_TOOL_HOST = "0";
  try {
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    const sgTools = await import("../src/main/orchestrator/tools/ast-grep-tools");
    sgTools.registerAstGrepTools();
    const { toolRegistry } = await import("../src/main/orchestrator/tools/registry/tool-registry");
    const cli = sgTools.resolveAstGrepCommand();
    if (!cli) {
      console.log("[SKIP] ast_grep 双轨（ast-grep CLI 平台包未安装）");
      return 0;
    }
    const runTs = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = toolRegistry.getById(id);
      if (!tool) throw new Error(`TS 工具未注册: ${id}`);
      return tool.execute(args, { resolvedWorkspaceRoot: tsHome } as never);
    };
    const runNet = async (id: string, args: Record<string, unknown>): Promise<string> => {
      const host = await callSmokeTool(id, { ...args, __cyreneWorkspaceRoot: netHome, __astGrepCommand: cli });
      return String(host.data ?? "");
    };

    const searchCases: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "search 多捕获（$$$，2 文件 3 处）", args: { pattern: "console.log($$$A)", paths: ["src/a.ts", "src/b.ts"] } },
      { name: "search 单捕获（$A）", args: { pattern: "console.log($A)", paths: ["src/a.ts", "src/b.ts"] } },
      { name: "search 限定路径/语言", args: { pattern: "console.log($$$A)", paths: ["src/a.ts"], language: "TypeScript" } },
      { name: "search 无匹配", args: { pattern: "zzz_no_match", paths: ["src/a.ts", "src/b.ts"] } },
      { name: "search maxMatches 截断", args: { pattern: "console.log($$$A)", paths: ["src/a.ts", "src/b.ts"], maxMatches: 1 } },
      { name: "search 非法语言（校验）", args: { pattern: "x", language: "Bogus", paths: ["src/a.ts"] } },
      { name: "search 空 pattern（校验）", args: { pattern: "", paths: ["src/a.ts"] } },
      { name: "search 路径逃逸跳过", args: { pattern: "x", paths: ["../escape"] } },
    ];
    for (const c of searchCases) {
      const tsOut = await runTs("ast_grep_search", c.args);
      const netOut = await runNet("ast_grep_search", c.args);
      check(c.name, tsOut === netOut, `ts=${tsOut.slice(0, 200)} net=${netOut.slice(0, 200)}`);
    }

    // replace dryRun：完整输出（含 diff 证据）逐字比对
    const dryArgs = { pattern: "console.log($$$A)", rewrite: "logger.info($$$A)", dryRun: true, paths: ["src/a.ts", "src/b.ts"] };
    const tsDry = await runTs("ast_grep_replace", dryArgs);
    const netDry = await runNet("ast_grep_replace", dryArgs);
    check("replace dryRun（含 $$$ 展开 diff 证据）", tsDry === netDry, `ts=${tsDry.slice(0, 260)} net=${netDry.slice(0, 260)}`);

    // replace 写入：输出 + 落盘字节
    const writeArgs = { pattern: "console.log($$$A)", rewrite: "logger.info($$$A)", dryRun: false, paths: ["src/a.ts", "src/b.ts"] };
    const tsWrite = await runTs("ast_grep_replace", writeArgs);
    const netWrite = await runNet("ast_grep_replace", writeArgs);
    const bytesSame = ["src/a.ts", "src/b.ts"].every((rel) =>
      Buffer.compare(readFileSync(path.join(tsHome, rel)), readFileSync(path.join(netHome, rel))) === 0);
    check("replace 写入（输出 + 落盘字节）", tsWrite === netWrite && bytesSame,
      `ts=${tsWrite.slice(0, 200)} net=${netWrite.slice(0, 200)} bytes=${bytesSame}`);
  } finally {
    if (prevEnv === undefined) delete process.env.CYRENE_TOOL_HOST;
    else process.env.CYRENE_TOOL_HOST = prevEnv;
    const { resetDotnetConfigCache } = await import("../src/main/dotnet-backend/config");
    resetDotnetConfigCache();
    rmSync(tsHome, { recursive: true, force: true });
    rmSync(netHome, { recursive: true, force: true });
  }
  return failed;
}

// ── git 八件双轨（真实镜像仓库 + 本地 bare 远程；commit/log/revert hash 归一）──

/** 递归排序 key 的稳定序列化（与两轨 JSON 键序无关）。 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}

/** hash 归一：镜像仓库的 commit hash 不同，仅比较形态与其余字段。 */
function normalizeGitHashes(value: unknown): unknown {
  return sortJson(JSON.parse(JSON.stringify(value).replace(/[0-9a-f]{7,40}/g, "<hash>")));
}

async function runGitDualTrack(): Promise<number> {
  let failed = 0;
  const check = (name: string, ok: boolean, detail = ""): void => {
    if (ok) console.log(`[PASS] git ${name}`);
    else { failed++; console.log(`[FAIL] git ${name} —— ${detail}`); }
  };
  const clip = (value: unknown): string => (JSON.stringify(value) ?? "undefined").slice(0, 240);
  const same = (name: string, tsValue: unknown, netValue: unknown): void => {
    check(name, stableJson(tsValue) === stableJson(netValue), `ts=${clip(tsValue)} net=${clip(netValue)}`);
  };

  const { probeGitExecutable } = await import("../src/main/code-git/git-executable");
  const version = await probeGitExecutable("git");
  if (!version) { console.log("[SKIP] git 双轨（未检测到系统 git）"); return 0; }

  const { createGitService } = await import("../src/main/code-git/git-service");
  const { createCodeGitTools } = await import("../src/main/orchestrator/tools/git-tools");

  const sessionId = "git-dual-session";
  const plainSession = "git-dual-plain";
  const identity = { name: "Dual", email: "dual@cyrene.test" };
  const sessions = new Map<string, string>();
  const roots: string[] = [];
  const mkHome = (prefix: string): string => {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
  };
  const tsHome = mkHome("git-dual-ts-");
  const netHome = mkHome("git-dual-net-");
  const tsPlain = mkHome("git-dual-ts-plain-");
  const netPlain = mkHome("git-dual-net-plain-");
  sessions.set(sessionId, tsHome);
  sessions.set(plainSession, tsPlain);

  try {
    const service = createGitService({
      getSession: (id) => {
        const workspaceRoot = sessions.get(id);
        return workspaceRoot
          ? { mode: "code" as const, workspaceBinding: { workspaceRoot, displayName: "dual", boundAt: 0 } }
          : null;
      },
      resolveExecutable: async () => ({ command: "git", source: "system" as const, version }),
      getCommitIdentity: () => identity,
    });
    const tools = new Map(createCodeGitTools(service).map((tool) => [tool.id, tool] as const));
    const tsRunIn = async (session: string, id: string, args: Record<string, unknown>): Promise<string> => {
      const tool = tools.get(id);
      if (!tool) throw new Error(`TS 轨缺少工具：${id}`);
      return tool.execute(args, {
        userQuery: "dual",
        conversationId: session,
        resolvedWorkspaceRoot: sessions.get(session),
        mode: "code",
      } as never);
    };
    const tsRun = (id: string, args: Record<string, unknown>): Promise<string> => tsRunIn(sessionId, id, args);

    const netRunIn = (home: string, id: string, args: Record<string, unknown>, session = sessionId) => callSmokeTool(id, {
      ...args,
      __cyreneRoot: home,
      __sessionId: session,
      __gitCommand: "git",
      __gitSource: "system",
      __gitVersion: version,
      __gitIdentity: identity,
    });
    const netRun = (id: string, args: Record<string, unknown>) => netRunIn(netHome, id, args);
    const netData = (host: HostResult): unknown => {
      if (!host.ok) throw new Error(`host error: ${host.error}`);
      return typeof host.data === "string" ? looseJson(host.data) : host.data;
    };
    const gitCli = (dir: string, args: string[]): void => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${String(result.stderr).trim()}`);
    };
    const seed = (home: string): void => {
      writeFileSync(path.join(home, "a.txt"), "alpha\nbeta\ngamma\n");
      mkdirSync(path.join(home, "sub"), { recursive: true });
      writeFileSync(path.join(home, "sub", "b.txt"), "one\ntwo\n");
    };

    // init + 本地提交身份（revert 需要；两侧同值保证确定性）
    same("git_init（空目录）", await tsRun("git_init", {}), netData(await netRun("git_init", {})));
    for (const home of [tsHome, netHome]) {
      gitCli(home, ["config", "user.name", identity.name]);
      gitCli(home, ["config", "user.email", identity.email]);
    }

    seed(tsHome); seed(netHome);
    same("git_status 未提交（untracked + 空分支列表）", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    same("git_diff 无 HEAD 视为空", looseJson(await tsRun("git_diff", {})), netData(await netRun("git_diff", {})));

    const tsCommit1 = await tsRun("git_commit", { message: "initial commit", paths: ["a.txt", "sub/b.txt"] });
    const netCommit1 = netData(await netRun("git_commit", { message: "initial commit", paths: ["a.txt", "sub/b.txt"] }));
    check(
      "git_commit #1 形态（40 位 hash）",
      /^已创建提交 [0-9a-f]{40}$/.test(tsCommit1) && /^已创建提交 [0-9a-f]{40}$/.test(String(netCommit1)),
      `${tsCommit1} | ${String(netCommit1)}`,
    );
    check("git_commit #1 输出等价（hash 归一）",
      stableJson(normalizeGitHashes(tsCommit1)) === stableJson(normalizeGitHashes(String(netCommit1))));

    same("git_status 提交后（干净 + branches）", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    same("git_log #1（hash 归一）", normalizeGitHashes(looseJson(await tsRun("git_log", {}))), normalizeGitHashes(netData(await netRun("git_log", {}))));

    // 工作区变更：staged rename + unstaged modify + untracked 新文件
    for (const home of [tsHome, netHome]) {
      gitCli(home, ["mv", "sub/b.txt", "sub/r.txt"]);
      writeFileSync(path.join(home, "a.txt"), "alpha\nBETA\ngamma\n");
      writeFileSync(path.join(home, "c.txt"), "new file\nline2\n");
    }
    same("git_status 混合变更（renamed/modified/added）", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    same("git_diff 工作区（patch/perFile/changes）", looseJson(await tsRun("git_diff", {})), netData(await netRun("git_diff", {})));
    same("git_diff --staged（rename 已暂存）", looseJson(await tsRun("git_diff", { staged: true })), netData(await netRun("git_diff", { staged: true })));
    same("git_diff paths 限定", looseJson(await tsRun("git_diff", { paths: ["a.txt"] })), netData(await netRun("git_diff", { paths: ["a.txt"] })));
    same("git_diff maxPatchLines=1（截断）", looseJson(await tsRun("git_diff", { maxPatchLines: 1 })), netData(await netRun("git_diff", { maxPatchLines: 1 })));

    const tsCommit2 = await tsRun("git_commit", { message: "second commit", paths: ["a.txt", "sub/r.txt"] });
    const netCommit2 = netData(await netRun("git_commit", { message: "second commit", paths: ["a.txt", "sub/r.txt"] }));
    check("git_commit #2 输出等价（hash 归一）",
      stableJson(normalizeGitHashes(tsCommit2)) === stableJson(normalizeGitHashes(String(netCommit2))));
    const tsHash2 = tsCommit2.split(" ").pop() ?? "";
    const netHash2 = String(netCommit2).split(" ").pop() ?? "";
    same("git_log #2（全量 + maxCount=1 + path 过滤）",
      [normalizeGitHashes(looseJson(await tsRun("git_log", {}))),
        normalizeGitHashes(looseJson(await tsRun("git_log", { maxCount: 1 }))),
        normalizeGitHashes(looseJson(await tsRun("git_log", { path: "a.txt" })))],
      [normalizeGitHashes(netData(await netRun("git_log", {}))),
        normalizeGitHashes(netData(await netRun("git_log", { maxCount: 1 }))),
        normalizeGitHashes(netData(await netRun("git_log", { path: "a.txt" })))]);

    // 分支
    same("git_switch_branch 创建 feat", await tsRun("git_switch_branch", { branch: "feat", create: true }), netData(await netRun("git_switch_branch", { branch: "feat", create: true })));
    same("git_status feat 分支（列表排序）", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    same("git_switch_branch 切回 main", await tsRun("git_switch_branch", { branch: "main" }), netData(await netRun("git_switch_branch", { branch: "main" })));

    // revert（对 HEAD/second commit 反向；各自 hash 前缀；输出 hash 归一等价）
    same("git_revert（hash 归一）",
      normalizeGitHashes(await tsRun("git_revert", { commit: tsHash2.slice(0, 12) })),
      normalizeGitHashes(netData(await netRun("git_revert", { commit: netHash2.slice(0, 12) }))));
    same("git_log revert 后", normalizeGitHashes(looseJson(await tsRun("git_log", {}))), normalizeGitHashes(netData(await netRun("git_log", {}))));

    // push（各自 bare 远程；建立跟踪 + 已跟踪两条路径）
    const tsRemote = path.join(mkHome("git-dual-rts-"), "remote.git");
    const netRemote = path.join(mkHome("git-dual-rnet-"), "remote.git");
    for (const bare of [tsRemote, netRemote]) {
      const init = spawnSync("git", ["init", "--bare", bare], { encoding: "utf-8" });
      if (init.status !== 0) throw new Error(`git init --bare 失败：${String(init.stderr).trim()}`);
    }
    gitCli(tsHome, ["remote", "add", "origin", tsRemote]);
    gitCli(netHome, ["remote", "add", "origin", netRemote]);
    same("git_push 建立跟踪", await tsRun("git_push", {}), netData(await netRun("git_push", {})));
    same("git_status 跟踪 origin/main", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    for (const home of [tsHome, netHome]) writeFileSync(path.join(home, "d.txt"), "push me\n");
    await tsRun("git_commit", { message: "third commit", paths: ["d.txt"] });
    await netData(await netRun("git_commit", { message: "third commit", paths: ["d.txt"] }));
    same("git_status ahead=1（未推送）", looseJson(await tsRun("git_status", {})), netData(await netRun("git_status", {})));
    same("git_push 已跟踪", await tsRun("git_push", {}), netData(await netRun("git_push", {})));

    // 非仓库
    same("git_status 非仓库（not_repository）",
      looseJson(await tsRunIn(plainSession, "git_status", {})),
      netData(await netRunIn(netPlain, "git_status", {}, plainSession)));

    // 错误路径：双侧都必须失败
    const expectBothFail = async (name: string, id: string, args: Record<string, unknown>): Promise<void> => {
      let tsFailed = false;
      try { await tsRun(id, args); } catch { tsFailed = true; }
      const host = await netRun(id, args);
      check(name, tsFailed && !host.ok, `tsFailed=${tsFailed} net=${JSON.stringify(host).slice(0, 160)}`);
    };
    await expectBothFail("非法分支名双侧拒绝", "git_switch_branch", { branch: "bad..name" });
    await expectBothFail("空 ref 双侧拒绝", "git_diff", { ref: "" });
    await expectBothFail("非法 revert hash 双侧拒绝", "git_revert", { commit: "xyz" });
    await expectBothFail("非法 paths 类型双侧拒绝", "git_commit", { message: "x", paths: "a.txt" });
    const noIdentity = await callSmokeTool("git_commit", {
      message: "x", paths: ["a.txt"], __cyreneRoot: netHome, __sessionId: sessionId,
      __gitCommand: "git", __gitSource: "system", __gitVersion: version,
    });
    check("git_commit 无身份 → E_GIT_IDENTITY", noIdentity.ok === false, JSON.stringify(noIdentity).slice(0, 160));
  } finally {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
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
    // weather / plan_trip 双轨（确定性路径）
    if (useSmoke) failures += await runWeatherTravelDualTrack();
    else console.log("[SKIP] weather/plan_trip 双轨（仅 smoke dll 轨支持）");
    // fetch_url 双轨（本地 HTTP fixture；raw 逐字 / markdown 归一投影）
    if (useSmoke) failures += await runFetchUrlDualTrack();
    else console.log("[SKIP] fetch_url 双轨（仅 smoke dll 轨支持）");
    // 文档四件双轨（write_markdown/excel/word/pdf；读回投影比对）
    if (useSmoke) failures += await runDocumentDualTrack();
    else console.log("[SKIP] 文档四件双轨（仅 smoke dll 轨支持）");
    // 邮件四件双轨（校验路径；IMAP/SMTP 快乐路径由矩阵 fake 服务器覆盖）
    if (useSmoke) failures += await runEmailDualTrack();
    else console.log("[SKIP] 邮件四件双轨（仅 smoke dll 轨支持）");
    // ast_grep 双轨（TS napi ↔ .NET CLI；共享 fixture 工作区）
    if (useSmoke) failures += await runAstGrepDualTrack();
    else console.log("[SKIP] ast_grep 双轨（仅 smoke dll 轨支持）");
    // git 八件双轨（镜像仓库 + 本地 bare 远程）
    if (useSmoke) failures += await runGitDualTrack();
    else console.log("[SKIP] git 双轨（仅 smoke dll 轨支持）");
  }

  console.log(failures === 0 ? "dual-track-diff: PASS" : `dual-track-diff: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
