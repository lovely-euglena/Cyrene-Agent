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

## 真机手动验收清单（T6 其余项）

以 `LIVE2D_ENGINE=dotnet` 启动应用（env 或 `config/cyrene.conf`），对照 web 轨逐项过：

| 项 | 操作 | 期望 |
| --- | --- | --- |
| 首帧 | 启动到桌宠可见 | 模型 upright/居中，无花屏黑边（TTFF 记录） |
| 点击穿透 | 鼠标扫过模型透明区/不透明区 | 透明区穿透到桌面，不透明区可交互（alpha≥10 语义） |
| 命中表情 | 点击 9 个命中区 | 触发对应表情伪动作；重复点同一区不重播 |
| 拖拽 | 按住模型拖动 | 跟手无抖动，松手落位持久化（重启恢复） |
| 缩放 | 设置 0.5×/1×/2× | 窗口与模型同步缩放，clamp 生效 |
| 置顶 | 开关置顶 | 与非全屏应用层级正确（HWND_TOPMOST） |
| 多 DPI | 跨 100%/150% 显示器拖动 | 尺寸恒定（DIP 语义），无模糊/跳变 |
| 显隐 | 托盘隐藏/显示 | 隐藏停帧（CPU 回落），显示恢复 |
| 口型 | 触发聊天 TTS | mouthStart 时长语义与 web 轨一致 |
| 回退 | 移走 exe 或 Core 后启动 | 一次性回退 web 轨，无孤儿进程 |
| 内存/帧率 | 任务管理器 + getDiagnostics | 记录对照表（sidecar vs web 渲染进程） |

失败项按 issue 评论 4 落 JSONL（`eval-log.mjs --run` 或手工 `--result fail` + note 标注失败模式）。
