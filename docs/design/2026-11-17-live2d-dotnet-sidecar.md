# Live2D 渲染引擎 .NET sidecar 化（#257）

> 状态：T0–T5 已落地；T6 静态基准帧逐像素对照**沙箱 0.0065% / GPU 真机同卡 0.004%**
> （RTX 2080 Ti：web ANGLE/NVIDIA GL vs dotnet NVIDIA D3D11，远低于 2% 阈值）；
> 真机 selftest 302/0/2（当时计数；审核修复后当前 309/0/2）。动作/口型时序、多 DPI、内存/帧率/启动时延等
> 完整应用手动清单待后续。
> 分支：`issue/257-live2d`。双轨开关：`LIVE2D_ENGINE=dotnet|web`（默认 `web`）。

## 1. 目标与裁决

把桌宠 Live2D 渲染与行为引擎从 Electron renderer（pixi.js + pixi-live2d-display）
迁到 .NET 10 sidecar 独立进程，与 tool/mcp/rag/memory/voice 七 host 架构并轨：

- **内存**：桌宠渲染生命周期归 sidecar，Electron 只留控制面（web 轨隐藏延迟
  销毁渲染进程的止血方案在 dotnet 轨不再需要——sidecar 隐藏即停帧）。
- **抗崩**：渲染进程崩溃不连带 renderer；宿主超时重置 + 代际守卫复用
  LineHostClient（IKJSNF）。
- **类型红利**：行为/渲染逻辑进 C# 强类型 + 自测矩阵；TS 面只剩薄协议层
  （live2d-host-protocol.ts 契约镜像 + 契约扫描测试）。

**路线 A（纯托管）**：Cubism Core P/Invoke + 手写 D3D11 COM vtable interop +
JSON 格式自解析。零 NuGet、零 C++ 编译链。不链接官方 Framework（只读参考）。

## 2. 进程与分层

```
Electron 主进程                          cyrene-live2d.exe（.NET 10，WinExe）
┌─────────────────────────┐   stdin    ┌──────────────────────────────────┐
│ Live2DHostClient        │ ────────▶  │ Live2DHost（单线程消息泵）        │
│ （LineHostClient 子类）  │   stdout   │  ├ PetEngine（编排/协议 op）      │
│ PetSidecarBackend（门面）│ ◀────────  │  │  ├ Model/   CubismModel+清单   │
│ window-manager 双轨分支  │  JSON 行   │  │  ├ Motion/  motion3/exp3       │
└─────────────────────────┘            │  │  ├ Behavior/ 8 控制器          │
                                       │  │  ├ Rendering/ D3D11 渲染器     │
                                       │  │  └ Window/ 分层窗口+帧泵       │
                                       │  └ Core/ P/Invoke+下载器          │
                                       └──────────────────────────────────┘
```

侧车分层（`dotnet/live2d/CyreneLive2D/`）：

| 层 | 内容 | 可无头自测 |
| --- | --- | --- |
| `Core/` | ~40 个 csmXxx P/Invoke、对齐内存管理、CoreLibrary 探测、CoreDownloader（SHA256 pin） | 需 Core DLL |
| `Model/` | model3.json 清单、moc3 封装（参数/部件/drawable 枚举） | 需 Core DLL |
| `Motion/` | motion3 贝塞尔求值、淡入淡出、队列/优先级状态机、exp3 混合 | 部分纯逻辑 |
| `Behavior/` | focus/blink/mouth/speaking-motion/expression-reset/idle-fps/interaction/click-through | 纯逻辑（注入时钟/RNG） |
| `Rendering/` | 手写 D3D11 interop、HLSL、图集预乘、蒙版双 pass、混色、离屏回读 | 需 GPU |
| `Window/` | WS_EX_LAYERED + UpdateLayeredWindow、点击穿透、DIP↔物理、拖拽 | 需桌面会话 |
| `Host/` | JSON 行协议、契约常量、stdout 句柄复制 | ✓ |

### 关键工程事实

- **stdout 句柄复制**：Live2D Core DLL 加载（静态 CRT 初始化）会关闭/替换
  原始 stdout 句柄——`Console.OpenStandardOutput()` 在 load 之后写帧静默失败。
  宿主启动时 `DuplicateHandle` 复制一份独立句柄构建协议流（`Live2DHost.OpenRobustStdout`）。
- **单线程消息泵**：stdin 读取线程 → ConcurrentQueue；主线程排空 op → 窗口帧泵
  （消息分发/光标轮询/tick/render/present）→ Sleep(1ms 渲染态 / 10ms 空闲)。
  `timeBeginPeriod(1)` 保证帧节拍。stdin EOF → 退出（防孤儿）。
- **坐标空间**：引擎内部全 DIP（与 web 轨一致）；窗口壳按 PerMonitorV2 换算
  物理像素。渲染分辨率 = 物理像素，zoom×dpiScale 保持模型 DIP 尺寸恒定
  （DPR=1 时与 web 轨逐像素一致）。
- **像素管线**：渲染回读预乘 BGRA（顶行在前）= 32bpp BI_RGB 顶向下 DIB 字节序
  → 直接 memcpy → `UpdateLayeredWindow(ULW_ALPHA, AC_SRC_ALPHA)`。无转换无翻转。

## 3. 协议（与七 host 同构）

C# 事实源：`Host/Live2DContracts.cs`；TS 镜像：`src/main/live2d/live2d-host-protocol.ts`；
双向契约扫描：`live2d-contract.test.ts`（任一侧漂移即 CI 红）。

帧形态：

```
→ {"op":"load","callId":"c1","modelPath":"..."}
← {"op":"ready"}
← {"op":"result","callId":"c1","ok":true,"data":{...}}
← {"op":"result","callId":"c1","ok":false,"error":"...","errorCode":"E_..."}
← {"op":"event","name":"hit","payload":{...}}
```

请求 op：`load / show / hide / setBounds / setZoom / setAlwaysOnTop / play /
speechPrepare / mouthStart / mouthStop / setDragging / setInteractive /
pause / resume / hitTest / captureFrame / getDiagnostics / setParameter /
renderOnce / tick / shutdown`。

事件：`loaded / loadFailed(预留) / hit / miss / interactive / dragStart /
dragMove / dragEnd / frameStats`。

错误码：`E_CORE_MISSING / E_CORE_DOWNLOAD / E_MODEL_LOAD / E_NOT_LOADED /
E_BAD_ARGS / E_RENDER / E_WINDOW / E_INTERNAL`。

诊断 op（`tick {dtMs}` 确定性推进、`setParameter`、`renderOnce`、`captureFrame`）
供 T6 像素对照与自测使用。NaN/±Infinity 序列化为 null（对齐 JSON.stringify）。
可空字段 null 时省略（WhenWritingNull）——TS 镜像对应字段为可选。

## 4. 双轨开关与回退

`LIVE2D_ENGINE=dotnet|web`（env > ./config/cyrene.conf > 默认 web；
解析入口 `resolveDotnetConfig().live2dEngine`，任务书指定开关名不带 CYRENE_ 前缀）。

- **web 轨**：代码路径原样保留（BrowserWindow + pixi.js + pld）。铁律：
  内置化是增量不是替代。
- **dotnet 轨**：window-manager 桌宠控制面路由到 `PetSidecarBackend` 门面；
  桌宠窗是侧车自管的 Win32 分层窗口（无 BrowserWindow、无渲染进程）。
- **回退**：exe 缺失 / 开关关闭 / Core 不可用 / 模型加载失败 →
  `ensureReady` 返回 false → 一次性回退 web 轨（同进程不反复重试），
  已 spawn 的侧车进程关停不留孤儿。

门面语义对齐（`src/main/live2d/pet-sidecar-backend.ts`）：

| web 轨 | dotnet 轨 |
| --- | --- |
| BrowserWindow show/hide + PET_VISIBILITY_CHANGED 停帧 | show/hide + resume/pause |
| setSize(round(基准×zoom)) + PET_ZOOM | setBounds + setZoom（0.5–2 clamp） |
| setAlwaysOnTop("screen-saver") | HWND_TOPMOST（Win32 等价） |
| setIgnoreMouseEvents | setInteractive（WS_EX_TRANSPARENT 覆盖） |
| renderer 拖拽 → WINDOW_MOVE_TO → PetWindowMoveController | 侧车 dragStart/dragMove/dragEnd（物理 px）→ DIP 换算 → 同一 PetWindowMoveController（16ms 节流+持久化） |
| sendToPetWindow(live2d:*) → renderer | sendChannel → speechPrepare/mouthStart/mouthStop/play |
| capturePage → dataURL | captureFrame → PNG base64 → dataURL / NativeImage |

口型时长仍由主进程 TS 计算（聊天 max(500,剩余)/max(2000,字数×180)，
通话 −800ms 提前量），侧车只收 `mouthStart {durationMs}`——与 web 轨同语义。

## 5. 行为移植保真（T4，不重调参）

逐文件对照 `src/renderer/live2d/*` 与 pld 源码移植，隐含语义全部保留：

- **帧序**（pld Cubism4InternalModel.update 逐帧对齐）：idleFps → focus 插值 →
  motions → SaveParameters → expressions → focus 写入 → breath → physics →
  pose → 钩子（口型/眨眼/秋千恢复/表情回正）→ model.Update → LoadParameters。
- **focus**：窗口点→单位圆（cos atan2, −sin atan2）怪癖保留；中心→(1,0)；
  EPSILON=0.01 / MAX_SPEED=40÷7.5 / ACCEL=1÷150（dt ms）。
- **blink**：自定义控制器帧末覆盖眼参数（pld 原装 CubismEyeBlink 净效果等价，
  不重复实现）；哨兵 −1。
- **mouth-sync**：180ms _toggle 0.15–0.85±rand×0.18，τ=70ms，dt clamp 100ms，
  关闭 <0.02 脱离，5min 上限。
- **speaking-motion**：Tick3「荡秋千（待机）」fallback idx3；stop → StopAllMotions +
  350ms easeOutCubic 恢复 Param32/13/14（全 |v|<0.001 跳过）。
- **physics**：逐式对照 native CubismPhysics.cpp 与 CubismWebFramework
  cubismphysics.ts（两者一致）；6 处怪癖保留（direction.Y 用新 X、X→Y 原地旋转、
  NormalizeParameterValue 符号翻转除非 isInverted、TranslationScale 未解析、
  Create 清零 Gravity.Y、DestinationParameterIndex 懒解析）。
  AirResistance=5 / MaximumWeight=100 / MovementThreshold=0.001 / MaxDeltaTime=5；
  固定步长 1/Fps + 剩余时间插值。
- **expression-reset**：3min「表情回正」；expressions 持久（fade 1.0s）。
- **idle-fps**：60 → 24@60s → 12@300s，5s 活动看门狗。
- **真实时间计时器**：expression-reset / idle-fps 的时间基 = 宿主 Stopwatch
  真实时间（`PetEngine.RealTimeMsProvider`），与 web 轨 setInterval /
  performance.now() 对齐——暂停期（隐藏/拖拽）计时不冻结，恢复后首帧即按
  真实经过时间回正/定档。其余行为时钟（_nowMs）暂停期冻结（dt 不累计）。
- **interaction**：5px 阈值 touch×4；Cyrene 9 个命中区全为表情伪动作；
  重复设置同一表情返回 false。
- **click-through**：alpha≥10 命中，50ms 光标轮询，幂等翻转 + interactive 事件。
- **baseScale**：恒对基准 400×500 计算（zoom 不变性）；Cyrene 4200×3500 →
  baseScale≈0.095238。

## 6. License 与 Core 分发

Live2D Proprietary：开发免费；个人/小规模企业发布豁免 Publication License。
**Core/Framework 二进制不随仓再分发**：

- 运行时下载器（`CoreDownloader`）：官方源
  `https://cubism.live2d.com/sdk-native/bin/CubismSdkForNative-5-r.4.zip`，
  SHA256 pin `BC39C444…2A906`，断点续传，落 `{dataDir}/live2d-core/Live2DCubismCore.dll`。
  **版本锁定 5-r.4 = Core 5.1.0**：与 web 轨内置 JS Core 同版本，保证两轨顶点求值
  逐像素一致（5-r.5=Core 6.0.1 引入非刚性形变差，且 pld 不兼容 Core 6）。
- 探测序（`CoreLibrary`）：env `CYRENE_CUBISM_CORE_DLL` → dataDir/live2d-core →
  模型目录(+core/) → exe 目录(+live2d-core/) → PATH。用户可自备 DLL。
- **许可同意闸门**（审计 #1362 发现 2）：官方下载页要求先同意 Live2D
  Proprietary License，程序化下载不能绕过同意动作。load 帧带可选
  `coreDownloadConsent`：Core 缺失且未同意 → `E_CORE_CONSENT`（不下载）；
  Electron 门面捕获后弹同意窗（window-manager `confirmCoreDownload`，含许可
  链接），同意 → 带 `coreDownloadConsent=true` 重试 load 触发下载；拒绝/
  下载失败 → 回退 web 轨。Core 落盘后后续加载不再弹窗（已安装即已同意）。
- load 时 Core 缺失且指定 dataDir 且已同意 → 下载后重试；否则 E_CORE_MISSING /
  E_CORE_CONSENT / E_CORE_DOWNLOAD（Electron 回退 web 轨）。

## 7. 构建与打包

```bash
pnpm run build:live2d   # dotnet publish -c Release -r win-x64 /p:SelfContained=false
pnpm run package:win:dir  # 已含 build:live2d
```

- framework-dependent：用户需 .NET 10 Desktop Runtime（与 native-windows/voice 同）。
- electron-builder extraResources：publish → `resources/live2d/`
  （目录名锁定：live2d-host-client.ts 打包态按此找 exe）。
- 开发态 exe 解析：`dotnet/live2d/CyreneLive2D/bin/Release/net10.0-windows/`
  下 publish 优先，其次普通构建输出。
- 模型不打进安装包之外的独立流程：vite public 拷贝（dist/renderer/models/cyrene/），
  与 web 轨同源。

## 8. 测试矩阵

- **C# 自测**：`cyrene-live2d.exe --selftest`（309 项；无 Core 176 项；
  GPU/桌面缺失优雅 SKIP）。`--core-smoke / --gpu-smoke / --render-test` 诊断模式。
- **TS 单测**：契约扫描（live2d-contract.test.ts）、客户端（live2d-host-client.test.ts）、
  门面（pet-sidecar-backend.test.ts）、双轨接线（window-manager-sidecar.test.ts）、
  开关（config.test.ts）。
- **T6 像素对照**：同模型同参数驱动 web/dotnet 各渲一帧，
  脚本逐像素 diff（容差 <2%，diff_pct 必须脚本产出）。工具链已落地
  （`scripts/live2d/`，见 §10）。**沙箱 0.0065%**（web 软件 WebGL vs dotnet WARP）；
  **GPU 真机同卡 0.004%**（RTX 2080 Ti，web ANGLE/NVIDIA GL vs dotnet NVIDIA D3D11）。
  渲染管线修复见 §10「渲染管线修复」「逐像素对齐」「真机验证」。
  动作/口型时序、多 DPI、内存/帧率等完整应用手动清单待后续。

## 9. 已知差异与后续

- 置顶级别：Electron "screen-saver" vs Win32 HWND_TOPMOST（语义近似，
  全屏应用之上的行为略有差异）。
- dotnet 轨无桌宠 BrowserWindow → `onPetWindowReady` 不触发，
  live2dWindowLifecycle 诊断为空（侧车诊断走 getDiagnostics op）。
- mouth-sync 直读 CyreneVoice PCM（同域化）为后续优化项，已单开 #265
  （审计 #1362 发现 1）；当前沿用主进程计算时长 + mouthStart 语义（与 web 轨一致）。
- 物理 stabilization 已实现未接线（web 轨未启用，保真优先）。
- 辅助文件去留：`Rendering/Matrix2D.cs` 为纯矩阵逻辑自测基准（自测引用，
  渲染热路径走 shader 矩阵，保留作回归基准）；`dotnet/live2d/probe/gpu-probe.cs`
  为 T2 期一次性诊断脚本（vtable 槽位实证），不参与构建，保留作 interop
  核对参考；两者均非生产路径。
- **web 轨两处潜在 bug（动作态探针发现，#266 / #267 跟进；本 PR 不改 web 轨）**：
  ① motion 文件名含 `#`（`动作#6_*.motion3.json`）被 file:// XHR 解析为 URL
  fragment → 路径截断、真动作加载失败（#266；dotnet 磁盘读取不受影响）；②
  `buildMotionIndexMap`/`buildHitAreaDefs` 读 `json.Motions`（实际在
  `FileReferences.Motions`）恒空 → `playAction` 的动作目标全落 expression 回退、
  真动作永不播放（#267）。当前命中区全为表情伪动作（名称恰匹配）、秋千走 speaking-motion
  直连（Tick3_3 无 `#`），故生产被掩盖；LLM playAction 真动作在 web 轨实为死路。
- **focus onLoad 怪癖已忠实移植**（`FocusBehavior.MapWindowPointAtLoad`）：pld
  `Live2DModel.focus` 恒 `toModelPosition(skipUpdate:true)`，onLoad `focusCenter(true)`
  时模型尚未首帧渲染 → `worldTransform` 仍单位矩阵（`localTransform` 亦单位，
  Cyrene Layout 空）→ 窗口中心直接按 `originalWidth/Height`(4200×3500) 归一化得
  固定偏心目标 (-0.726, 0.688)，**并非 (1,0)**；运行时（首帧后）worldTransform
  已更新 → 真实布局反演 → 窗口中心 (1,0)。dotnet 区分 load/运行时两态对齐
  （探针实证 identity 假设重算与 web target 全精度一致）。

## 10. T6 验收（沙箱 0.0065% / GPU 真机同卡 0.004%）

### 渲染管线修复（沙箱真渲染验证，2026-11-17）

早期 `CreateInputLayout` 返回 E_INVALIDARG（HARDWARE/WARP 皆然）曾被误判为
沙箱环境缺陷。GPU 真机探针复现同样错误后，对照 Wine `d3d11.idl` 与 pld
`cubism4.es.js` 逐条排查，确认是三个代码 bug，修复后沙箱 WARP 渲染出完整角色
（`--render-test` 47770 不透明像素——最终对齐口径，角色初完整阶段为 43669；
`--selftest` 309 PASS/0 FAIL/2 SKIP——当前计数，含审核修复新增断言）：

1. **输入布局语义名**：HLSL `: TEXCOORD0` 编译后的输入签名是 `"TEXCOORD"` +
   索引 0；布局误写 `"TEXCOORD0"` 导致签名匹配失败 → E_INVALIDARG。
   改为 `"TEXCOORD"`（`SemanticIndex=0`）。vtable 槽位本身经核对全部正确
   （`ID3D11Device : IUnknown`，无 DeviceChild 前缀；PrivateData 在尾部 34-36）。
2. **蒙版分组语义**：原实现把「被蒙版的 drawable」当作蒙版组成员，且做依赖
   拓扑排序（Cyrene 模型自依赖 → 误报环）。web 轨低精度路径（pld 默认
   `_useHighPrecisionMask=false`）的 `_clippingIdList` 是**蒙版形状本身**
   （`drawableMasks[i]`），按创建序绘制、不处理嵌套蒙版。已对齐：组成员=
   蒙版形状，创建序，无嵌套。
3. **UV 的 V 翻转**：Cubism Core 的 drawable UV 原点在左下（GL 约定），D3D11
   纹理顶行序上传（v=0=顶行）需在 VS 内 `uv.y = 1 - uv.y`。不翻转时部件采样到
   图集透明 padding → 画面碎片；翻转后角色完整。

### 逐像素对齐（沙箱达成，2026-11-17，diff_pct 0.55% → 0.0065%）

角色完整后仍有 ~12% 差异，逐层定位并修复以下根因（web 基准帧亦在沙箱用
软件 WebGL 采集，无需 GPU 真机即可对照）：

1. **Core 版本对齐**：web 轨内置 JS Core = 5.1.0（0x05010000），侧车原用
   5-r.5 = Core 6.0.1，顶点求值存在非刚性形变差（参数完全一致仍 ±3px）。
   升级 web Core 到 6 不可行（pld `doDrawModel` 抛 TypeError）。故侧车降级
   固定 **5-r.4 = Core 5.1.0**。`csmGetRenderOrders` 为 Core 6 新名，Core 5
   名 `csmGetDrawableRenderOrders`——`CoreLibrary` 函数指针探测兼容两名。
2. **图集 mip 链**：pixi 默认 `mipmap=POW2`（图集 8192² 为 2 的幂）→ web 缩小
   时用三线性 mip 滤波。侧车原 MipLevels=1 → 发丝/翅膀内部色差。改为 CPU
   生成完整 mip 链（2×2 box，+2 舍入）逐层 `UpdateSubresource` 上传——不依赖
   `GenerateMips`（沙箱 D3D11 其为 no-op），也避开「初始数据+多层 mip」创建
   限制（沙箱拒绝该组合，E_INVALIDARG）。
3. **主 RT 4× MSAA**：web `antialias:true`。侧车主缓冲改 4× MSAA，读回前
   `ResolveSubresource` 到非 MSAA 纹理（沙箱探针实证 MSAA+Resolve 可用）。
4. **蒙版图集低精度路径完整移植**：原侧车每组建全尺寸 RT；web 用单张
   256×256 RGBA 图集（pld `maskBufferCount=1`）+ `setupLayoutBounds` 网格
   布局 + RGBA 通道打包 + `matrixForMask`/`matrixForDraw` 矩阵链 + 单元格
   `isInside` 裁剪。已逐项对齐。另复现 pld `calcClippedDrawTotalBounds` 的
   `Number.MIN_VALUE` 语义（全负坐标组上界撑到 ≈0）。D3D 行序适配：masked
   PS 采样 `maskUv.y = 1 - clipPos.y/w`。
5. **HLSL 矩阵必须 `row_major`**（关键）：CPU 按行主序上传（`mul(行向量,M)`，
   平移在 [12]/[13]）。HLSL 默认列主序打包把 `maskMatrix` 读错 → `clipPos`
   退化为模型坐标 → 蒙版 `isInside` 全 0 → 虹膜被裁（眼睛闭合）。身体因用
   反转蒙版掩盖了错误。加 `row_major` 后 diff 0.55% → **0.0065%**（13px AA 噪声）。
6. **web 取帧冻结污染修复**（`web-capture.cjs`）：`Live2DModel._render` 在
   `deltaTime≠0` 时调 `internalModel.update`，行为层写参数→`csmUpdateModel`→
   `loadParameters` 恢复参数值，造成「参数=默认、顶点=行为态」隐蔽污染；
   冻结时清零 `model.deltaTime`。又 `cm.update()` 内部 `resetDynamicFlags`
   使 pld 跳过蒙版重绘、沿用陈旧蒙版 FBO；改用裸 `cm._model.update()` 保留
   脏标志强制重绘。软件 GL（`--disable-gpu`）下 `capturePage` 不合成 WebGL
   层，改 `--extract` 同任务 render+readPixels 读回（预乘 RGBA，与侧车
   PngCodec 语义一致）。

### 口径

- **静态基准帧**：双方都不跑行为层（呼吸/眨眼/物理/注视），默认参数各渲一帧。
  web 轨 `PET_RENDER_MAX_DPR=1` → 400×500 CSS 像素即物理像素，与侧车
  render-test 默认尺寸逐像素可比。
- **diff_pct** = 差异像素 / 总像素 × 100。差异像素定义：R/G/B/A 四通道
  绝对差最大值 > 8/255（容忍 AA/浮点舍入/纹理滤波噪声）；双透明像素
  （A 均为 0）跳过颜色比较。**阈值 diff_pct < 2%**。
- **采集原则**（issue 评论 4）：diff_pct 必须由脚本产出；result 以测试
  退出码为准。`eval-log.mjs` 机械执行：`--run` 取子进程退出码，
  `--diff` 解析 pixel-diff.mjs 的 stdout JSON。

### 工具链（`scripts/live2d/`，零依赖）

| 脚本 | 作用 |
| --- | --- |
| `pixel-diff.mjs` | PNG 逐像素 diff（内置 8-bit PNG 解码器，全 5 种 filter）；`--selftest` 6 项自验证 |
| `sidecar-capture.mjs` | dotnet 侧取帧：走生产 JSON 行协议（load/setBounds/setZoom/setParameter/play/tick/captureFrame）；`--diag-only` 无 GPU 可跑协议链路；`--warmup N` play 前预热、`--params-out` 中帧参数快照（getDiagnostics includeParameters） |
| `web-capture.cjs` | web 侧取帧：`npx electron` 起同规格透明桌宠窗，冻结 ticker（清零 deltaTime）+ 参数回默认 + 裸 core update（保留脏标志）+ 单帧渲染；`--extract` 软件 GL 下 readPixels 读回；drive 模式（`--play/--warmup/--ticks`，等号形态传参）t=0 重置 + 确定性推进 + 中帧 stash |
| `eval-log.mjs` | 测评 JSONL 落盘 `docs/eval/257-live2d.jsonl`（ts/task/action/target/result/diff_pct/note） |
| `motion-probe.mjs` | 动作态探针：28 对矩阵编排（双轨同时间轴）+ 逐对 eval-log 落盘 + 汇总 `docs/eval/257-motion-probe-summary.json` |
| `diff-heatmap.mjs` | 差异分布可视化（热图 + bbox + delta 分桶 + 行列直方图），定位系统偏差 vs 局部噪声 |
| `param-compare.mjs` | 双轨中帧参数数值对照（web midParams vs dotnet includeParameters），隔离行为层差异 |

侧车免 Node 取帧：`cyrene-live2d.exe --render-test --out dotnet.png [--params k=v,...]`。
GPU 机器完整流程见 `scripts/live2d/README.md`。

### 真机验证（云 GPU RTX 2080 Ti，2026-11-17）

沙箱无 GPU 暴露不出的两个真机问题，本轮修复：

7. **多适配器默认适配器是软件**（根因 7，决定性）：云桌面/无头独显机器
   DXGI `adapter[0]` = Microsoft Basic Render Driver（虚拟显示，专用显存 0），
   独显在 `[1]`。`D3D11CreateDevice(NULL, HARDWARE)` 静默落在软件适配器——
   Chromium/ANGLE 同样默认选它（`glRenderer` 诊断实证）。修复：
   `D3D11Device.Create` 先 `CreateDXGIFactory1` + `EnumAdapters1`（vtable 12）
   + `GetDesc`（vtable 8），显式选首个 `DedicatedVideoMemory > 0` 适配器
   （指定适配器时 driverType 必须 `UNKNOWN(0)`），保留原「默认硬件 → WARP」
   回退链；stderr 输出 `[d3d11] adapter=<name>` 作证据。修复后侧车落在
   RTX 2080 Ti（featureLevel 11_0）。
8. **assets 模型清单陈旧副本**：`assets/models/cyrene/Cyrene.model3.json`
   `Groups: []`（e5b43d4b 眨眼/口型重构只改了 public 规范副本），致
   `--selftest --model-dir assets/...` 两项 FAIL（`model3.groups.eyeBlink/lipSync`）。
   生产侧车与 web 轨同源 public/dist（含 Groups），不受影响；assets 副本
   无任何代码引用，同步规范副本消除陷阱（两副本唯一差异即 Groups）。

web 侧同卡强制：Chromium 的 `--gpu-vendor-id/--gpu-device-id` 在本 Electron
无效；改用 OS 级 GPU 偏好（`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`
`GpuPreference=2;`，等价 Windows 图形设置「高性能」）→ DXGI 按进程重排
适配器序，ANGLE 落 NVIDIA（验证后已清理注册表项）。`web-capture.cjs` diag
新增 `glRenderer`（`WEBGL_debug_renderer_info`）记录实际 GPU。

**真机对照矩阵**（400×500，容差 8/255，阈值 2%，均脚本产出）：

| 口径 | web 设备 | dotnet 设备 | diff_pct |
| --- | --- | --- | --- |
| 同卡严格 | NVIDIA GL（ANGLE D3D11） | NVIDIA D3D11 | **0.004%**（8px） |
| 同软件适配器 | Basic Render Driver | Basic Render Driver | 0.0045%（9px） |
| 跨设备 | Basic Render Driver | NVIDIA D3D11 | 0.008%（16px） |
| 沙箱（前轮） | SwiftShader 软件 GL | WARP | 0.0065%（13px） |

真机 selftest（NVIDIA）：PASS=302 FAIL=0 SKIP=2（当时计数；审核修复 +7 项
断言后当前 309 项，见 §8）。SKIP 为 pose.fade/
interaction.motionFire 条件项，与 GPU 无关）。差异像素均为 AA 边缘噪声。

### 动作态探针（2026-11-18，28 对全 pass，max 0.517%）

T6 静态基准帧口径的增量：双方跑**同一动作/表情、同一确定性时间轴**，补上动作/
表情态的逐像素对照。协议：`load → t=0 重置 → warmup 60 帧 → play → 推进 M 帧 →
截帧 → diff`（dt=1000/60ms）。矩阵 = 5 个真实 motion3 动作 ×4 时刻（0.25/0.5/1.0/
1.33s）+ 4 个代表表情 ×2 时刻（fade 完成/稳态）= **28 对**。

**确定性对齐依据**（pld 源码实证）：

- **时间基**：pld 动作/表情时间基 = `Live2DModel.elapsedTime`（dt 累积）；
  `startMotion` 的 `performance.now()` 参数被忽略，`startTime` 首次 update 惰性
  设定 → 与侧车 `_nowMs` tick 累积逐帧同序，无需patch 真实时钟。
- **眨眼**：web `BlinkController` 用 `Math.random`（跨轨不可复现）→ 晚注册
  `beforeModelUpdate` 钩子强制 eyes=1；侧车首眨间隔 ≥2500ms，总虚拟时长
  (60+M)×16.67ms ≤2333ms（M≤80）保证双轨 eyes=1 同态。
- **物理/呼吸初态**：web 加载后自动 ticker 已走数帧，激发了 `delay=1` 的无阻尼
  自由粒子（头发/双腿/秋千），初态相位差会永久保留 → 重建 physics rig 回静止
  初态（与侧车 load 即静止同起点）；呼吸时钟 web 显式清零、侧车从 0 起 → 相位同步。
- **注视**：load 即 `focusCenter(instant)` → 双轨同移植 onLoad 怪癖（见 §9）。

**根因定位**：初跑全 28 对均匀 6.7–8.7%（含简单表情）= 系统偏差，非动作引擎差。
热图集中于发丝/叶冠/翅膀边缘 → 中帧参数对照（侧车 `getDiagnostics
includeParameters` 中帧快照 + web `beforeModelUpdate` stash；`loadParameters` 每帧
回滚 transient 写入，故帧末快照无意义，须中帧）隔离出 **focus 漂移**：web
(-0.726, 0.688) vs dotnet (1,0)，AngleX/Y/Z/EyeBall 差异全由其解释。物理输出
Param19–30 对齐 ~1e-4（物理移植忠实）。`MapWindowPointAtLoad` 修复后全 pass，
53 参数最大残差 1.6e-4（物理浮点噪声）。

**结果**（软件适配器同口径：web SwiftShader / dotnet WARP；容差 8/255，阈值 2%）：

| 动作/表情 | 时刻数 | max diff_pct |
| --- | --- | --- |
| 动作#6:动作回正（0.5s） | 4 | 0.0085% |
| 动作#6:Wink~（3s） | 4 | 0.0365% |
| 动作#6:我可爱吧~（4s） | 4 | **0.517%** |
| 动作#6:笑一笑吧~（3s） | 4 | 0.2585% |
| Tick3:荡秋千（待机）（60.333s 早期） | 4 | 0.011% |
| expression:墨镜 | 2 | 0.0065% |
| expression:圈圈眼 | 2 | 0.1245% |
| expression:星星眼 | 2 | 0.008% |
| expression:拽秋千1 | 2 | 0.004% |

多数 0.004–0.01%（静态级）；个别 0.1–0.5% 为特定帧移动手部/发丝边缘的物理/AA
噪声（热图局部小簇，无 129–255 大差异桶，非结构偏移）。28 对经 `eval-log.mjs
--diff` 落盘 JSONL（result 取退出码、diff_pct 取脚本输出），汇总
`docs/eval/257-motion-probe-summary.json`。

**探针侧 web bug 绕行**（不改生产代码，#266 / #267 跟进，见 §9）：① resolveURL 补丁
编码 `#`→`%23`；② 直驱 `model.motion(group,index)`（索引取 `mm.definitions`，
绕过恒空的 motionIndexMap）。表情-only 伪动作双轨一致 played=false（忠实），
探针用真文件动作 + kind=expression。

### 当前状态

| 项 | 状态 |
| --- | --- |
| 工具链自验证（编解码往返/0%/1%/5%/容差/尺寸守卫） | ✅ 6/6（沙箱） |
| 协议链路（load→setParam→tick×120→diagnostics→shutdown） | ✅ nowMs=2000 精确（沙箱） |
| C# 自测矩阵（含 Core） | ✅ PASS=309 FAIL=0 SKIP=2（最新，含审核修复断言；真机轮当时 302） |
| T5 TS 单测（7 文件） | ✅ 55/55（运行时=顶层静态 it/test 55，无 it.each；含许可闸门 4 场景） |
| dotnet 静态基准帧渲染（沙箱 WARP） | ✅ 角色完整，47770 不透明像素 |
| dotnet 静态基准帧渲染（真机 NVIDIA） | ✅ adapter=RTX 2080 Ti，RENDER_TEST_OK |
| 静态基准帧逐像素对照（diff_pct < 2%） | ✅ 沙箱 **0.0065%** / 真机同卡 **0.004%**（四口径全 pass，见上表） |
| 动作态探针逐像素对照（28 对，diff_pct < 2%） | ✅ 全 pass，max **0.517%**（软件适配器同口径；focus onLoad 怪癖移植后，见上节） |
| 真机 selftest（NVIDIA） | ✅ PASS=302 FAIL=0 SKIP=2（当时计数，当前 309 项） |
| 口型时序对照、多 DPI、内存/帧率/启动时延对照表 | ⏳ T6 后续（完整应用手动清单） |