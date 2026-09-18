// ── 通用工具三件套：calculator / now / clipboard ──────────────────
// 背景审查结论（2026-09）：工具面存在三个高频缺口——
//   1. calculator：模型心算不可靠，数值问题必须给确定计算器；
//   2. now：模型无实时时钟，时间问题/定时类对话全靠猜；
//   3. clipboard：桌面助手的自然交互（读剪贴板上下文/整理后写回）。
//
// 注册方式同其他 builtin 工具：导出常量，由 built-in-tools.ts facade
// 统一 register（保证目录顺序）。
//
// calculator 的求值器是手写递归下降 parser（tokenizer + 白名单函数表），
// 全程无 eval/Function——工具入参不可信，不能开动态执行口子。

import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { nativeFirst } from "../native-tool-host";

// ── calculator：安全数学表达式求值 ─────────────────────────────

interface CalcToken {
  kind: "num" | "op" | "lp" | "rp" | "fn" | "comma";
  value: string;
}

function tokenize(src: string): CalcToken[] {
  const tokens: CalcToken[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j])) j++;
      // 科学计数法：123e4 / 1.5e-3（e 前必须是完整数字）
      if (j < src.length && (src[j] === "e" || src[j] === "E")) {
        let k = j + 1;
        if (k < src.length && (src[k] === "+" || src[k] === "-")) k++;
        if (k < src.length && /[0-9]/.test(src[k])) {
          k++;
          while (k < src.length && /[0-9]/.test(src[k])) k++;
          j = k;
        }
      }
      // 支持十六进制 0x 前缀
      if (c === "0" && (src[i + 1] === "x" || src[i + 1] === "X")) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F_]/.test(src[j])) j++;
      }
      tokens.push({ kind: "num", value: src.slice(i, j).replace(/_/g, "") });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[a-zA-Z_0-9]/.test(src[j])) j++;
      tokens.push({ kind: "fn", value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ("+-*/%^".includes(c)) {
      // ** 幂运算拆成两个 ^ 同义
      if (c === "*" && src[i + 1] === "*") { tokens.push({ kind: "op", value: "^" }); i += 2; continue; }
      tokens.push({ kind: "op", value: c });
      i++;
      continue;
    }
    if (c === "(") { tokens.push({ kind: "lp", value: c }); i++; continue; }
    if (c === ")") { tokens.push({ kind: "rp", value: c }); i++; continue; }
    if (c === ",") { tokens.push({ kind: "comma", value: c }); i++; continue; }
    throw new Error(`无法识别的字符 "${c}"（位置 ${i}）`);
  }
  return tokens;
}

const FUNCS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt, abs: Math.abs, ln: Math.log, log: Math.log10, log2: Math.log2,
  exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin,
  acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
  pow: (a, b) => Math.pow(a, b),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

class CalcParser {
  private pos = 0;
  constructor(private readonly tokens: CalcToken[]) {}

  parse(): number {
    const v = this.expr();
    if (this.pos < this.tokens.length) throw new Error("表达式结尾有多余内容");
    return v;
  }

  // expr := term (('+'|'-') term)*
  private expr(): number {
    let v = this.term();
    for (let p = this.peek(); p != null && p.kind === "op" && (p.value === "+" || p.value === "-"); p = this.peek()) {
      const op = this.next().value;
      const r = this.term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  // term := unary (('*'|'/'|'%') unary)*
  private term(): number {
    let v = this.unary();
    for (let p = this.peek(); p != null && p.kind === "op" && ["*", "/", "%"].includes(p.value); p = this.peek()) {
      const op = this.next().value;
      const r = this.unary();
      if (op === "*") v = v * r;
      else if (r === 0) throw new Error("除数为零");
      else if (op === "/") v = v / r;
      else v = v % r;
    }
    return v;
  }

  // unary := ('-'|'+') unary | power
  private unary(): number {
    const t = this.peek();
    if (t?.kind === "op" && t.value === "-") { this.next(); return -this.unary(); }
    if (t?.kind === "op" && t.value === "+") { this.next(); return this.unary(); }
    return this.power();
  }

  // power := atom ('^' unary)?   （右结合）
  private power(): number {
    const base = this.atom();
    if (this.peek()?.kind === "op" && this.peek()!.value === "^") {
      this.next();
      return Math.pow(base, this.unary());
    }
    return base;
  }

  // atom := num | const | fn '(' args ')' | '(' expr ')'
  private atom(): number {
    const t = this.next();
    if (!t) throw new Error("表达式不完整");
    if (t.kind === "num") {
      const v = Number(t.value);
      if (Number.isNaN(v)) throw new Error(`非法数字 ${t.value}`);
      return v;
    }
    if (t.kind === "lp") {
      const v = this.expr();
      const close = this.next();
      if (close?.kind !== "rp") throw new Error("缺少右括号");
      return v;
    }
    if (t.kind === "fn") {
      const name = t.value;
      if (name in CONSTS) return CONSTS[name];
      const fn = FUNCS[name];
      if (!fn) throw new Error(`未知函数或常量 "${name}"`);
      const open = this.next();
      if (open?.kind !== "lp") throw new Error(`函数 ${name} 后需要括号`);
      const args: number[] = [];
      if (this.peek()?.kind !== "rp") {
        args.push(this.expr());
        while (this.peek()?.kind === "comma") { this.next(); args.push(this.expr()); }
      }
      const close = this.next();
      if (close?.kind !== "rp") throw new Error(`函数 ${name} 缺少右括号`);
      return fn(...args);
    }
    throw new Error(`意外的符号 "${t.value}"`);
  }

  private peek(): CalcToken | undefined { return this.tokens[this.pos]; }
  private next(): CalcToken { const t = this.tokens[this.pos++]; if (!t) throw new Error("表达式在运算符后意外结束"); return t; }
}

/** 求值数学表达式（白名单 tokenizer + 递归下降，无 eval）。 */
export function evaluateExpression(src: string): number {
  const tokens = tokenize(src);
  if (tokens.length === 0) throw new Error("表达式为空");
  return new CalcParser(tokens).parse();
}

export const calculatorTool: ToolDefinition = {
  id: "calculator",
  name: "数学计算",
  description:
    "精确计算数学表达式。何时用：任何算术/数值问题（模型心算不可靠，涉及金额、日期差、单位换算必须用本工具）。" +
    "支持：+ - * / % ^（幂）、括号、函数 sqrt/abs/ln/log/log2/exp/floor/ceil/round/sin/cos/tan/" +
    "asin/acos/atan/sinh/cosh/tanh/min/max/pow、常量 pi/e/tau，逗号分隔多参数（min(1,2,3)）。" +
    "示例：\"(1+0.05)^10 - 1\"、\"sqrt(2)*2^10\"。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {
      expression: { type: "string", description: "数学表达式，如 \"(1+0.05)^10\"" },
    },
    required: ["expression"],
  },
  execute: async (args: Record<string, unknown>) => {
    return nativeFirst("calculator", args, calcExecute);
  },
};

/** calculator 的 TS 实现（native 轨回退路径）。 */
function calcExecute(args: Record<string, unknown>): string {
  const expression = String(args.expression ?? "");
  const value = evaluateExpression(expression);
  return `${expression} = ${value}`;
}

// ── now：当前时间 ─────────────────────────────────────────────

let timezoneGetter: (() => string | undefined) | null = null;
/** 注入用户时区（built-in-tools.ts 启动时接线，避免循环依赖）。 */
export function setUtilityTimezoneConfig(tzGetter: () => string | undefined): void {
  timezoneGetter = tzGetter;
}

export const nowTool: ToolDefinition = {
  id: "now",
  name: "当前时间",
  description:
    "获取当前准确时间。何时用：任何涉及\"现在/今天/几点\"的问题、定时提醒规划、时间戳换算、" +
    "文件/日志时间解读——模型没有实时时钟，不要凭参数猜。返回 ISO 8601 + 用户时区本地格式 + 星期。" +
    "参数 format 可选：default（人读，默认）/ iso（2026-01-01T00:00:00+08:00）/ epoch（毫秒时间戳）。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {
      format: { type: "string", description: "default=本地人读（默认）；iso=ISO 8601；epoch=Unix 毫秒" },
    },
    required: [],
  },
  execute: async (args: Record<string, unknown>) => {
    return nativeFirst("now", args, nowExecute);
  },
};

/** now 的 TS 实现（native 轨回退路径）。 */
function nowExecute(args: Record<string, unknown>): string {
  const tz = timezoneGetter?.() || "Asia/Shanghai";
  const now = new Date();
  const format = String(args.format ?? "default");
  if (format === "epoch") return String(now.getTime());
  if (format === "iso") return now.toISOString();
  const local = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(now);
  // 前段给人看，尾附机器可读 JSON（模型做进一步换算/比较用）
  return `${local}（时区 ${tz}）\n${JSON.stringify({ now: now.getTime(), iso: now.toISOString(), timezone: tz })}`;
}

// ── clipboard：剪贴板读写 ─────────────────────────────────────

// Electron clipboard 惰性加载（单测环境无 electron）
type ClipboardModule = {
  readText(): string;
  writeText(text: string): void;
};
let clipboardLoader: (() => ClipboardModule) | null = null;
/** 注入 electron clipboard（built-in-tools.ts 启动时接线）。 */
export function setUtilityClipboardConfig(loader: () => ClipboardModule): void {
  clipboardLoader = loader;
}

const CLIPBOARD_READ_LIMIT = 10_000;

export const clipboardTool: ToolDefinition = {
  id: "clipboard",
  name: "剪贴板",
  description:
    "读写系统剪贴板文本。何时用：用户说\"看看我复制的内容/帮我处理剪贴板里的...\"（action=read）；" +
    "用户要\"把结果放到剪贴板/我直接粘贴\"（action=write，会覆盖当前剪贴板内容）。" +
    "read 返回文本（超过 10000 字符截断）；write 后返回确认。非文本内容（图片等）不支持。",
  enabled: true,
  risk: "input-control",
  effectKind: "external_side_effect",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "read=读剪贴板（默认）；write=写入 text 字段内容" },
      text: { type: "string", description: "action=write 时要写入的文本" },
    },
    required: ["action"],
  },
  execute: async (args: Record<string, unknown>) => {
    return nativeFirst("clipboard", args, clipboardExecute);
  },
};

/** clipboard 的 TS 实现（native 轨回退路径）。 */
function clipboardExecute(args: Record<string, unknown>): string {
  if (!clipboardLoader) throw new Error("剪贴板不可用（运行环境未注入）");
  const clipboard = clipboardLoader();
  const action = String(args.action ?? "read");
  if (action === "read") {
    const text = clipboard.readText();
    if (!text) return "（剪贴板为空或不含文本）";
    if (text.length > CLIPBOARD_READ_LIMIT) {
      return text.slice(0, CLIPBOARD_READ_LIMIT) + `\n…（已截断，共 ${text.length} 字符）`;
    }
    return text;
  }
  if (action === "write") {
    const text = String(args.text ?? "");
    clipboard.writeText(text);
    return `已写入剪贴板（${text.length} 字符）`;
  }
  throw new Error(`未知 action "${action}"（支持 read/write）`);
}
