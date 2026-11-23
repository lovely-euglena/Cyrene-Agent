# ！262 T6 真机回归测试表（qwen-bot PR 配套）

> 对应 PR ！262（Live2D 桌宠 .NET sidecar）。T6 沙箱基准已完成（web 0.0065% / 真机同卡 0.004%），
> 本表是**行为面真机回归**的执行矩阵。数据收集用 `scripts/live2d/collect-t6.mjs`（环境探测+逐项采集+JSONL/MD 落盘），
> 回填用 `scripts/live2d/eval-log.mjs`（兼容同一 JSONL）。

## 环境要求

- GPU 机器（DXGI 适配器选择依赖独显——见 T6-6）
- Windows 10/11，PerMonitorV2 感知
- `LIVE2D_ENGINE=dotnet` 打开双轨对照；web 轨默认对照基准

## 执行矩阵

| ID | 测试项 | 采集方式 | 判定/阈值 | 依赖 |
|---|---|---|---|---|
| T6-1 | 渲染像素一致性（web vs dotnet 同帧） | pixel-diff.mjs | diff_pct ≤ 0.5% | sidecar-capture + web-capture |
| T6-2 | 动作/口型时序（触发→首帧） | motion-probe.mjs（--run 机械执行） | 首帧 <200ms，循环无卡顿 | exe 运行 |
| T6-3 | 多 DPI 缩放（100/150/200%） | 手工三档+collect 登记偏差像素 | 命中区偏差 ≤2px | PerMonitorV2 |
| T6-4 | 内存与帧率（空转 10min） | 侧车 stderr 摘录→collect 登记 | ≥55fps，内存漂移 <30MB | exe 日志 |
| T6-5 | 点击穿透与拖拽（三分区） | 手工三分区点击→collect 登记 | 透明区穿透/模型区命中/边缘拖动 | 分层窗口 |
| T6-6 | DXGI 适配器选择 | stderr 首行 `[d3d11] adapter=` 摘录 | adapter=硬件名非 WARP | 多适配器机器可选 |

## 采集流程

```bash
# 1) 环境探测+全项登记（pending 项回填）
node scripts/live2d/collect-t6.mjs --env gpu1

# 2) 只跑可机械执行的项
node scripts/live2d/collect-t6.mjs --env gpu1 --items T6-2

# 3) 逐项回填（追加进同一 JSONL）
node scripts/live2d/eval-log.mjs --task T6-3 --action read --target 150dpi.md --result pass --note "偏差 1px"

# 4) 像素差（机械）
node scripts/live2d/eval-log.mjs --task T6-1 --action diff --note "对照" --diff web.png dotnet.png --threshold 0.5
```

## 通过标准

- 机械项（T6-1/2）：阈值内 pass
- 手工项（T6-3/4/5）：回填 pass 且无 P1 级现象
- 环境项（T6-6）：adapter 记录非 WARP（多适配器机器）
- 全部项 JSONL 齐全 → T6 关闭，PR 进入待复审
