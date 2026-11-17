# Live2D 双轨验收工具链（#257 T6）

零依赖脚本（Node ≥ 20；web 截帧另需仓库 Electron 与 `dist/renderer`）。
验收口径：同模型同参数各渲一帧，`diff_pct < 2%`（差异像素占比，通道容差 8/255）。
**diff_pct 一律由 `pixel-diff.mjs` 产出，result 一律取测试退出码**（issue 评论 4 采集原则）。

## 脚本一览

| 脚本 | 作用 |
| --- | --- |
| `pixel-diff.mjs` | PNG 逐像素 diff（内置 8-bit PNG 解码器，零依赖）；`--selftest` 自验证 |
| `sidecar-capture.mjs` | dotnet 侧取帧：走生产 JSON 行协议（load/tick/setParameter/captureFrame）；`--diag-only` 无 GPU 可跑 |
| `web-capture.cjs` | web 侧取帧：`npx electron` 起 400×500 透明桌宠窗，冻结 ticker + 参数回默认 + 单帧渲染 |
| `eval-log.mjs` | 测评 JSONL 落盘（`docs/eval/257-live2d.jsonl`）：`--run` 取退出码、`--diff` 取脚本 diff_pct |

侧车另有免 Node 的取帧形态：`cyrene-live2d.exe --render-test --model-dir <dir> --out dotnet.png [--params k=v,...]`。

## GPU 机器验收流程

前置：.NET 10 Desktop Runtime（或 self-contained publish）、Node ≥ 20、
Core DLL（env `CYRENE_CUBISM_CORE_DLL` 指向 DLL，或放模型目录，或 `--data-dir` 让侧车自动下载）。

```bash
# 0. 工具链自验证（无需 GPU）
node scripts/live2d/pixel-diff.mjs --selftest

# 1. dotnet 侧帧（默认参数 = 静态基准）
node scripts/live2d/sidecar-capture.mjs --out dotnet.png
#    或免 Node：cyrene-live2d.exe --render-test --out dotnet.png

# 2. web 侧帧（先 pnpm run build:renderer）
npx electron scripts/live2d/web-capture.cjs --out web.png

# 3. 逐像素对照（diff_pct 脚本产出；exit 0 = pass < 2%）
node scripts/live2d/pixel-diff.mjs web.png dotnet.png --out diff.json

# 4. 落盘测评记录（result 取退出码，diff_pct 取脚本 JSON）
node scripts/live2d/eval-log.mjs --task T6 --action diff --note "静态基准对照" --diff web.png dotnet.png
```

带参数/动作的对照：两侧同传 `--params ParamAngleX=15,ParamEyeLOpen=0.5`；
动作序列用 `sidecar-capture.mjs --play expression:墨镜 --ticks 60`，web 侧
`--no-freeze --wait <ms>` 近似（行为层时序对照属 T6 后续项，静态帧先行）。

## 沙箱限制说明

开发沙箱 D3D11 `CreateInputLayout` 返回 E_INVALIDARG（HARDWARE/WARP 皆然），
渲染类用例只能在真机跑。沙箱可跑：`pixel-diff --selftest`、
`sidecar-capture --diag-only`（协议链路）、C# `--selftest`（渲染项 SKIP）、TS 单测。
