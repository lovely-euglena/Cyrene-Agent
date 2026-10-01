// ── 工具：ocr_image ─────────────────────────────────────────
// 本地 OCR：从图片文件中提取文字，不经过云端、不依赖视觉模型。
//
// 与 read_image 的分工：
// - ocr_image：要"原文字"，本地引擎（Windows.Media.Ocr）离线识别，快、免费、可给坐标
// - read_image：要"理解/描述画面"，交给视觉模型（在线）
//
// 服务商可切换（设置 → OCR）：当前仅 local 可用，cloud 为预留接口。
// provider 抽象见 src/main/ocr/，本文件只做参数校验与结果排版。

import * as fs from "fs";
import * as path from "path";
import type { ToolDefinition } from "../registry/tool-registry";
import type { OcrResult } from "../../../ocr/types";

const LOG_PREFIX = "[OcrImageTool]";
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

/** 可重试的错误码（引擎临时故障/超时/无结果）；配置/文件类错误重试无意义。 */
const RETRYABLE_OCR_CODES = new Set([
  "OCR_TIMEOUT",
  "OCR_NO_RESULT",
  "OCR_ENGINE_START_FAILED",
  "OCR_FAILED",
]);

function ensureAbsolute(p: string): string | null {
  if (!p) return null;
  if (!path.isAbsolute(p)) return null;
  return path.normalize(p);
}

function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

function humanBytes(n: number): string {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / 1024 / 1024).toFixed(1) + "MB";
}

function formatResult(result: OcrResult, withPositions: boolean): string {
  const text = result.text.trim();
  const header = `[OCR·本地] 语言 ${result.language || "未知"} · 耗时 ${result.durationMs}ms`;
  if (!text) {
    return `${header}\n（未识别到文字）`;
  }

  if (!withPositions) {
    return `${header}\n\n${result.text}`;
  }

  // 坐标模式：逐行 + 词级命中框（原点图片左上角，单位像素）
  const coordinateHint = "坐标原点在图片左上角，单位像素（x,y,宽×高）";
  const lines = result.lines.map((line, index) => {
    const words = line.words
      .map((w) => `${w.text}(${Math.round(w.x)},${Math.round(w.y)},${Math.round(w.width)}×${Math.round(w.height)})`)
      .join(" ");
    return `行${index + 1}: ${line.text}${words ? `\n  ${words}` : ""}`;
  });
  return `${header}\n${coordinateHint}\n\n${lines.join("\n")}`;
}

async function executeOcrImage(args: Record<string, unknown>): Promise<string> {
  const raw = String(args.path || "").trim();
  const filePath = ensureAbsolute(raw);
  if (!filePath) {
    return "[错误] path 必须是绝对路径";
  }

  const stat = safeStat(filePath);
  if (!stat) {
    return "[错误] 文件不存在或无法访问: " + filePath;
  }
  if (!stat.isFile()) {
    return "[错误] 不是文件: " + filePath;
  }
  if (stat.size > IMAGE_MAX_BYTES) {
    return "[错误] 图片过大（>" + humanBytes(IMAGE_MAX_BYTES) + "），当前 " + humanBytes(stat.size);
  }

  const withPositions = args.positions === true || String(args.positions) === "true";
  const language = typeof args.lang === "string" ? args.lang.trim() : "";

  try {
    const { runOcr } = await import("../../../ocr/ocr-registry");
    console.log(LOG_PREFIX, "ocr_image:", filePath, "lang=" + (language || "auto"), "positions=" + withPositions);
    const result = await runOcr({ imagePath: filePath, language: language || undefined, withPositions });
    return formatResult(result, withPositions);
  } catch (err) {
    const code = typeof (err as { code?: unknown })?.code === "string"
      ? (err as { code: string }).code
      : "OCR_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    console.log(LOG_PREFIX, "ocr_image 失败:", code, message);
    // 结构化失败：执行边界按 success:false 标记失败并透出 errorCode
    return JSON.stringify({
      success: false,
      errorCode: code,
      error: message,
      retryable: RETRYABLE_OCR_CODES.has(code),
    });
  }
}

export const ocrImageTool: ToolDefinition = {
  id: "ocr_image",
  name: "本地 OCR 识别",
  description:
    "用本地 OCR 引擎从图片中提取文字（离线、不经过云端、不依赖视觉模型），返回识别到的原文。" +
    "识别语言取决于系统已安装的 OCR 语言包，可在设置 → OCR 中切换。\n\n" +
    "何时用：\n" +
    "- 用户要“提取图片/截图里的文字”“把图里的字读出来”，要的是原文\n" +
    "- 需要文字位置时传 positions=true（返回每行/每词的像素坐标）\n" +
    "- 未配置视觉模型，但只想拿到图里的文字\n\n" +
    "不要用于：\n" +
    "- 需要理解/描述画面内容、回答关于图片的问题 → read_image（视觉模型）\n" +
    "- 读文本文件 → read_file\n" +
    "- 网络图片 → 先用 download_file 下载到本地再调用\n\n" +
    "参数：path (必填，绝对路径)；lang (可选，语言标签如 zh-Hans-CN，默认跟随设置)；positions (可选，是否返回坐标，默认 false)。",
  enabled: true,
  risk: "fs-read",
  modes: ["learn", "code", "work"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  isConcurrencySafe: () => true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "图片文件绝对路径（png/jpg/jpeg/bmp/gif/webp/tiff 等）" },
      lang: { type: "string", description: "识别语言标签，如 zh-Hans-CN / en-US；留空 = 自动（跟随设置/系统）" },
      positions: { type: "boolean", description: "是否返回文字坐标（行/词级像素命中框），默认 false" },
    },
    required: ["path"],
  },
  execute: executeOcrImage,
};
