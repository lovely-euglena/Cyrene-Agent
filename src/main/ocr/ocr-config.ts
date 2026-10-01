// OCR 侧车超时策略（本地识别通常 <1s，超大图/首启也远小于上限）。

export const OCR_DEFAULT_TIMEOUT_MS = 60_000;
export const OCR_MIN_TIMEOUT_MS = 2_000;
export const OCR_MAX_TIMEOUT_MS = 10 * 60_000;

export function clampOcrTimeoutMs(value: number): number {
  if (!Number.isFinite(value)) return OCR_DEFAULT_TIMEOUT_MS;
  return Math.max(OCR_MIN_TIMEOUT_MS, Math.min(OCR_MAX_TIMEOUT_MS, Math.round(value)));
}
