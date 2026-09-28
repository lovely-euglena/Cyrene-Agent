import { describe, expect, it } from "vitest";
import { resolveDragCalibration } from "./pet-drag-calibration";

describe("resolveDragCalibration（桌宠拖动单位系数校准）", () => {
  it("命令与落地一致 → matched（结束校准，k 不变）", () => {
    const result = resolveDragCalibration({
      lastTarget: { x: 120, y: 80 },
      baseWin: { x: 100, y: 60 },
      actual: { x: 120, y: 80 },
    });
    expect(result).toEqual({ kind: "matched" });
  });

  it("窗口尚未响应命令（仍在基准位）→ defer，绝不把 k 压到下限", () => {
    const result = resolveDragCalibration({
      lastTarget: { x: 140, y: 100 },
      baseWin: { x: 100, y: 60 },
      // 命令还没生效：窗口仍在基准位
      actual: { x: 100, y: 60 },
    });
    expect(result).toEqual({ kind: "defer" });
  });

  it("命令已生效但落地与命令不符 → 按同命令位移比修正（如物理像素 1.25x → k=0.8）", () => {
    const result = resolveDragCalibration({
      lastTarget: { x: 200, y: 160 },
      baseWin: { x: 100, y: 60 },
      // 命令走 100/100px，实际只走了 80/80px（单位差 1/1.25）
      actual: { x: 180, y: 140 },
    });
    expect(result).toEqual({ kind: "rescale", unitScale: 0.8 });
  });

  it("位移太小无法测量 → defer（保持原 k）", () => {
    const result = resolveDragCalibration({
      lastTarget: { x: 104, y: 60 },
      baseWin: { x: 100, y: 60 },
      // 命令只走了 4px（< 8px 阈值）且落地有偏差：测不出有效比例 → 不校准
      actual: { x: 101, y: 60 },
    });
    expect(result).toEqual({ kind: "defer" });
  });

  it("单轴可测量时只按该轴计算", () => {
    const result = resolveDragCalibration({
      lastTarget: { x: 200, y: 62 },
      baseWin: { x: 100, y: 60 },
      actual: { x: 150, y: 61 },
    });
    expect(result).toEqual({ kind: "rescale", unitScale: 0.5 });
  });

  it("修正值钳制在 [0.25, 3]", () => {
    const tiny = resolveDragCalibration({
      lastTarget: { x: 200, y: 60 },
      baseWin: { x: 100, y: 60 },
      actual: { x: 101, y: 60 },
    });
    expect(tiny).toEqual({ kind: "rescale", unitScale: 0.25 });

    const huge = resolveDragCalibration({
      lastTarget: { x: 120, y: 60 },
      baseWin: { x: 100, y: 60 },
      actual: { x: 400, y: 60 },
    });
    expect(huge).toEqual({ kind: "rescale", unitScale: 3 });
  });
});