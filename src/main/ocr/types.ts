// OCR 主进程内部类型。

import type { OcrLanguageInfo, OcrProviderId } from "../../shared/ocr";

export type { OcrLanguageInfo, OcrProviderId };

/** 词级命中框（像素坐标，原点在图片左上角）。 */
export interface OcrWordBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 行级结果。 */
export interface OcrLine {
  text: string;
  words: OcrWordBox[];
}

/** 识别结果。 */
export interface OcrResult {
  text: string;
  lines: OcrLine[];
  /** 实际使用的语言 tag。 */
  language: string;
  provider: OcrProviderId;
  durationMs: number;
}

/** 识别请求。 */
export interface OcrRequest {
  /** 图片绝对路径。 */
  imagePath: string;
  /** 语言 tag；缺省/空 = 自动。 */
  language?: string;
  /** 是否返回词级坐标。 */
  withPositions?: boolean;
}

/** OCR 领域错误：code 为稳定的错误码，供工具与 UI 映射文案。 */
export class OcrError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OcrError";
  }
}
