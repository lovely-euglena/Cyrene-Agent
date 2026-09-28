/**
 * Live2D 桌宠拖动：单位系数（k）校准。
 *
 * 背景：renderer 的 `event.screenX` 与 `window.screenX`/主进程窗口坐标在不同
 * Chromium 版本/缩放下可能不是同一单位（物理像素 vs DIP），需要实测系数 k
 * 把指针位移换算成窗口位移。
 *
 * 关键正确性要求（旧实现的两个坑）：
 *   1) 必须用「同一条命令」对比：命令目标位置 vs 该命令产生的实际窗口位置。
 *      旧实现拿「本次事件的期望位置」比「上一条命令的落地位置」，天然差一帧，
 *      会把正常环境误判成单位不一致。
 *   2) 窗口尚未响应命令（实际位置仍等于下发时的基准）时必须判为 defer——
 *      旧实现此时算出比值 0，把 k 钳到下限 0.25，导致拖动只有 1/4 速度
 *      （"拖动距离跟不上鼠标"）。
 */
export interface DragCalibrationInput {
  /** 最近一次下发的窗口目标位置（命令） */
  lastTarget: { x: number; y: number };
  /** 下发该命令时的窗口基准位置 */
  baseWin: { x: number; y: number };
  /** 当前读到的窗口实际位置 */
  actual: { x: number; y: number };
}

export type DragCalibrationResult =
  /** 命令与落地一致：当前环境无单位差，结束校准 */
  | { kind: "matched" }
  /** 窗口尚未响应命令或位移太小：本帧不校准（继续正常拖动） */
  | { kind: "defer" }
  /** 命令已生效但落地与命令不符：按同命令位移比修正 k */
  | { kind: "rescale"; unitScale: number };

const MATCH_TOLERANCE_PX = 2;
const MIN_MEASURE_PX = 8;
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;

export function resolveDragCalibration(input: DragCalibrationInput): DragCalibrationResult {
  const cmdDX = input.lastTarget.x - input.baseWin.x;
  const cmdDY = input.lastTarget.y - input.baseWin.y;

  if (
    Math.abs(input.actual.x - input.lastTarget.x) <= MATCH_TOLERANCE_PX &&
    Math.abs(input.actual.y - input.lastTarget.y) <= MATCH_TOLERANCE_PX
  ) {
    return { kind: "matched" };
  }

  // 窗口还停在基准位（命令尚未生效）→ 不能据此算 k
  if (input.actual.x === input.baseWin.x && input.actual.y === input.baseWin.y) {
    return { kind: "defer" };
  }

  // 同一命令下：实际位移 / 命令位移 = 真实单位系数；只统计可测量轴
  const candidates: number[] = [];
  if (Math.abs(cmdDX) >= MIN_MEASURE_PX) {
    candidates.push((input.actual.x - input.baseWin.x) / cmdDX);
  }
  if (Math.abs(cmdDY) >= MIN_MEASURE_PX) {
    candidates.push((input.actual.y - input.baseWin.y) / cmdDY);
  }
  if (candidates.length === 0) return { kind: "defer" };

  const average = candidates.reduce((sum, value) => sum + value, 0) / candidates.length;
  return {
    kind: "rescale",
    unitScale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, average)),
  };
}