// 本地 OCR 服务商：调用 CyreneOcr.exe（Windows.Media.Ocr 一次性侧车）。
//
// 协议：stdout 单行 JSON。诊断信息在 stderr。
//   成功 {"ok":true,"text":...,"language":...,"durationMs":...,"lineCount":...,"lines":[...]}
//   失败 {"ok":false,"error":...,"message":...}

import { spawn } from "node:child_process";
import type { OcrLanguageInfo, OcrProviderId } from "../../shared/ocr";
import { clampOcrTimeoutMs, OCR_DEFAULT_TIMEOUT_MS } from "./ocr-config";
import { resolveOcrSidecarPath } from "./ocr-sidecar-path";
import type { OcrProvider } from "./ocr-provider";
import { OcrError, type OcrLine, type OcrRequest, type OcrResult, type OcrWordBox } from "./types";

interface SidecarSuccess {
  ok: true;
  text?: unknown;
  language?: unknown;
  durationMs?: unknown;
  lineCount?: unknown;
  lines?: unknown;
}

interface SidecarFailure {
  ok: false;
  error?: unknown;
  message?: unknown;
}

export type SidecarResult = SidecarSuccess | SidecarFailure;

interface SidecarLanguageResult {
  ok: true;
  languages?: unknown;
  default?: unknown;
}

/** stdout 里取最后一行可解析 JSON（协议行之外的杂音容忍丢弃）。 */
export function parseSidecarResult(stdout: string): SidecarResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") return parsed as SidecarResult;
    } catch {
      // 继续找上一行
    }
  }
  return null;
}

function toStringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toLanguageList(value: unknown): OcrLanguageInfo[] {
  if (!Array.isArray(value)) return [];
  const out: OcrLanguageInfo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const tag = toStringOr((item as { tag?: unknown }).tag).trim();
    if (!tag) continue;
    out.push({ tag, name: toStringOr((item as { name?: unknown }).name, tag) });
  }
  return out;
}

function toLines(value: unknown): OcrLine[] {
  if (!Array.isArray(value)) return [];
  const out: OcrLine[] = [];
  for (const line of value) {
    if (!line || typeof line !== "object") continue;
    const rawWords = (line as { words?: unknown }).words;
    const words: OcrWordBox[] = [];
    if (Array.isArray(rawWords)) {
      for (const w of rawWords) {
        if (!w || typeof w !== "object") continue;
        words.push({
          text: toStringOr((w as { text?: unknown }).text),
          x: Number((w as { x?: unknown }).x) || 0,
          y: Number((w as { y?: unknown }).y) || 0,
          width: Number((w as { width?: unknown }).width) || 0,
          height: Number((w as { height?: unknown }).height) || 0,
        });
      }
    }
    out.push({ text: toStringOr((line as { text?: unknown }).text), words });
  }
  return out;
}

export class LocalOcrProvider implements OcrProvider {
  readonly id: OcrProviderId = "local";

  constructor(private readonly timeoutMs: number = OCR_DEFAULT_TIMEOUT_MS) {}

  isAvailable(): boolean {
    return resolveOcrSidecarPath() !== null;
  }

  async listLanguages(): Promise<OcrLanguageInfo[]> {
    return (await this.listLanguagesDetailed()).languages;
  }

  /** 语言列表 + 自动模式默认语言（设置页展示用）。 */
  async listLanguagesDetailed(): Promise<{ languages: OcrLanguageInfo[]; defaultLanguage: string | null }> {
    const exe = this.requireExe();
    const stdout = await runSidecar(exe, ["--list-languages"], this.timeoutMs);
    const parsed = parseSidecarResult(stdout) as SidecarLanguageResult | { ok: false; message?: unknown } | null;
    if (!parsed || parsed.ok !== true) {
      const message = parsed && "message" in parsed ? toStringOr(parsed.message) : "语言枚举失败";
      throw new OcrError("OCR_LIST_LANGUAGES_FAILED", message);
    }
    const defaultLanguage = toStringOr((parsed as SidecarLanguageResult).default).trim() || null;
    return { languages: toLanguageList((parsed as SidecarLanguageResult).languages), defaultLanguage };
  }

  async recognize(request: OcrRequest): Promise<OcrResult> {
    const exe = this.requireExe();
    const args = ["--ocr", "--image", request.imagePath];
    const language = request.language?.trim();
    if (language) args.push("--lang", language);
    if (request.withPositions) args.push("--positions");

    const stdout = await runSidecar(exe, args, this.timeoutMs);
    const parsed = parseSidecarResult(stdout);
    if (!parsed) {
      throw new OcrError("OCR_NO_RESULT", "OCR 引擎未返回结果");
    }
    if (parsed.ok !== true) {
      throw new OcrError(toStringOr(parsed.error, "OCR_FAILED"), toStringOr(parsed.message, "OCR 识别失败"));
    }

    return {
      text: toStringOr(parsed.text),
      lines: toLines(parsed.lines),
      language: toStringOr(parsed.language),
      provider: "local",
      durationMs: Number(parsed.durationMs) || 0,
    };
  }

  private requireExe(): string {
    const exe = resolveOcrSidecarPath();
    if (!exe) {
      throw new OcrError("OCR_ENGINE_UNAVAILABLE", "本地 OCR 引擎未安装（缺少 CyreneOcr.exe）");
    }
    return exe;
  }
}

interface SidecarOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  spawnError?: string;
  timedOut?: boolean;
}

/** 运行一次性侧车并收集 stdout/stderr。 */
function runSidecar(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(exe, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const finish = (outcome: SidecarOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome.timedOut) {
        reject(new OcrError("OCR_TIMEOUT", `OCR 识别超时（${clampOcrTimeoutMs(timeoutMs)}ms）`));
        return;
      }
      if (outcome.spawnError) {
        reject(new OcrError("OCR_ENGINE_START_FAILED", `无法启动 OCR 引擎: ${outcome.spawnError}`));
        return;
      }
      if (outcome.stdout.trim()) {
        resolve(outcome.stdout);
        return;
      }
      const detail = outcome.stderr.trim().slice(0, 300);
      reject(new OcrError(
        "OCR_NO_RESULT",
        `OCR 引擎无输出${detail ? ` (${detail})` : ""}${outcome.exitCode !== 0 ? ` exit=${outcome.exitCode}` : ""}`,
      ));
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ stdout, stderr, exitCode: null, timedOut: true });
    }, clampOcrTimeoutMs(timeoutMs));

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ stdout, stderr, exitCode: null, spawnError: error.message }));
    child.on("exit", (code) => finish({ stdout, stderr, exitCode: code }));
  });
}
