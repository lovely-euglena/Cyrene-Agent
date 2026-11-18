# Live2D 双轨验收工具链（#257 T6）

零依赖脚本（Node ≥ 20；web 截帧另需仓库 Electron 与 `dist/renderer`）。
验收口径：同模型同参数各渲一帧，`diff_pct < 2%`（差异像素占比，通道容差 8/255）。
**diff_pct 一律由 `pixel-diff.mjs` 产出，result 一律取测试退出码**（issue 评论 4 采集原则）。

## 脚本一览

| 脚本 | 作用 |
| --- | --- |
| `pixel-diff.mjs` | PNG 逐像素 diff（内置 8-bit PNG 解码器，零依赖）；`--selftest` 自验证 |
| `sidecar-capture.mjs` | dotnet 侧取帧：走生产 JSON 行协议（load/tick/setParameter/captureFrame）；`--diag-only` 无 GPU 可跑；`--warmup N` play 前预热、`--params-out` 中帧参数快照 |
| `web-capture.cjs` | web 侧取帧：`npx electron` 起 400×500 透明桌宠窗，冻结 ticker（清零 deltaTime）+ 参数回默认 + 裸 core update + 单帧渲染；`--extract` 软件 GL 下 readPixels 读回；drive 模式（`--play/--warmup/--ticks`，等号形态传参）确定性推进 + 中帧参数 stash |
| `eval-log.mjs` | 测评 JSONL 落盘（`docs/eval/257-live2d.jsonl`）：`--run` 取退出码、`--diff` 取脚本 diff_pct |
| `motion-probe.mjs` | 动作态双轨探针：28 对矩阵编排（5 真实 motion3 ×4 时刻 + 4 表情 ×2 时刻）+ 逐对 eval-log 落盘（target=可直接执行的完整命令）+ 汇总 `docs/eval/257-motion-probe-summary.json` |
| `diff-heatmap.mjs` | 差异分布可视化（热图 + bbox + delta 分桶 + 行列直方图），定位系统偏差 vs 局部噪声 |
| `param-compare.mjs` | 双轨中帧参数数值对照（web midParams vs dotnet includeParameters），隔离行为层差异 |

侧车另有免 Node 的取帧形态：`cyrene-live2d.exe --render-test --model-dir <dir> --out dotnet.png [--params k=v,...]`。

动作态探针需 Electron（`npx electron` 或 `CYRENE_ELECTRON_EXE` 指向任意 Electron 二进制；
本仓未装 electron 时用后者）与 Core DLL（`CYRENE_CUBISM_CORE_DLL`，许可闸门不程序化下载）：

```bash
$env:CYRENE_CUBISM_CORE_DLL = "<Core r.4 dll>"
$env:CYRENE_ELECTRON_EXE = "<electron.exe>"        # 可选；缺省取仓库 node_modules
node scripts/live2d/motion-probe.mjs [--only Wink] [--skip-log] [--out-dir <dir>]
```

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
npx electron scripts/live2d/web-capture.cjs --extract --out web.png
#    软件 GL（无 GPU/沙箱）加：--no-sandbox --enable-unsafe-swiftshader --disable-gpu
#    --force-device-scale-factor=1（强制 DPR=1 → 400×500 物理像素）

# 3. 逐像素对照（diff_pct 脚本产出；exit 0 = pass < 2%）
node scripts/live2d/pixel-diff.mjs web.png dotnet.png --out diff.json

# 4. 落盘测评记录（result 取退出码，diff_pct 取脚本 JSON）
node scripts/live2d/eval-log.mjs --task T6 --action diff --note "静态基准对照" --diff web.png dotnet.png
```

带参数对照：两侧同传 `--params ParamAngleX=15,ParamEyeLOpen=0.5`。动作/表情态对照已由
`motion-probe.mjs` 落地（2026-11-18，28 对全 pass，max diff_pct 0.517%）：双轨同确定性
时间轴（load → t=0 重置 → warmup 60 帧 → play → M 帧 → 截帧），逐对 eval-log 落盘 +
汇总 `docs/eval/257-motion-probe-summary.json`；差异形态用 `diff-heatmap.mjs` 看热图、
数值残差用 `param-compare.mjs` 对照中帧参数（53 参数 max 1.6e-4，物理浮点噪声级）。

## 沙箱验证状态（静态 + 动作态均已达成）

开发沙箱（WARP 软件渲染 + 软件 WebGL）**已完成静态基准帧逐像素对照：
diff_pct=0.0065%**（13/200000 px，远低于 2% 阈值），无需 GPU 真机。
`--selftest` **309** PASS/0 FAIL/2 SKIP（当前计数；2026-11-17 真机轮当时 302，
审核修复 +7 断言后为 309）。

动作态探针（软件适配器同口径：web SwiftShader / dotnet WARP）：**28 对全 pass，
max 0.517%**（5 真实 motion3 ×4 时刻 + 4 表情 ×2 时刻；多数 0.004–0.01% 静态级，
个别 0.1–0.5% 为移动手部/发丝边缘物理/AA 噪声）。

达成要点（详见设计文档 §10「逐像素对齐」）：
- **Core 版本锁定 5-r.4 = Core 5.1.0**，与 web 轨内置 JS Core 同版本（顶点求值
  一致）。`CoreDownloader` 已 pin r.4 URL/SHA256；`csmGetRenderOrders` 经
  `CoreLibrary` 函数指针兼容 Core 5 旧名 `csmGetDrawableRenderOrders`。
- 图集 CPU mip 链、主 RT 4× MSAA、256 蒙版图集低精度路径完整移植。
- **HLSL 矩阵 `row_major`**（缺则蒙版 clipPos 读错、虹膜被裁）。
- web 取帧冻结修复（清零 deltaTime + 裸 core update 保留脏标志）+ `--extract`
  软件 GL readPixels。

沙箱 web 基准帧采集命令（仓库根，需 `dist/renderer` + 基线 Electron）：

```bash
electron.exe --no-sandbox --enable-unsafe-swiftshader --disable-gpu \
  --force-device-scale-factor=1 scripts/live2d/web-capture.cjs --extract --out web.png
```

沙箱可跑：`pixel-diff --selftest`、`sidecar-capture --diag-only`（协议链路）、
C# `--selftest`/`--render-test`、TS 单测、上述 web 截帧 + 逐像素对照。
动作/口型时序、多 DPI、内存/帧率/启动时延等仍需 GPU 真机。

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
