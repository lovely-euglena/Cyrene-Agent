# 实机内存基线：进程分布、桌宠/聊天回收效果与优化建议

> 日期：2026-09-27 · 环境：Windows / `release\win-unpacked`（Electron 43.1.0 + Chromium 150，.NET 10 原生窗）
> 复现：`node scripts/mem-probe.mjs <release>\win-unpacked\Cyrene.exe`（约 70s，4 个阶段）
> 口径：**私有工作集（private working set）**= 任务管理器“内存”列；WS = 工作集（含共享 DLL，多进程加总会重复计算）。

## 0. 本机环境（重要前提）

- GPU：**Microsoft Basic Render Driver**（无可用独显/核显驱动，通常出现在 VM/RDP 场景）。
- Chromium 特性状态：`rasterization=disabled_software`、`gpu_compositing=disabled_software`、`webgl=unavailable_software`。
- 但桌宠 Live2D 实际拿到了 **WebGL2**：`ANGLE (Microsoft, Microsoft Basic Render Driver, D3D11)`（软件 D3D11/WARP）。
- 对照实验：强制 `--disable-gpu --enable-unsafe-swiftshader`（= 设置里“禁用 GPU 加速”档）
  → WebGL 变 SwiftShader（Vulkan Subzero），内存**不降反升**（GPU 进程私有 393→462MB）。
  **结论：本机不要为了省内存去关 GPU 加速。**
- 配置：`petVisible=true / petZoom=1 / disableGpuElectron=false / sidebarVisible=true / tasksVisible=true`；
  插件运行时与 embedding sidecar 启动时不常驻（符合设计）。
- 测量时机器上另有 vite dev server 等无关 node 进程，已从汇总中排除。

## 1. 四阶段实测（私有工作集 / WS，MB）

| 进程 | ① 仅桌宠（启动 18s） | ② +聊天窗 | ③ 桌宠隐藏后 | ④ 聊天关闭后 |
|---|---:|---:|---:|---:|
| Electron 主进程 | 190 / 266 | 190 / 274 | 190 / 273 | 190 / 266 |
| GPU 进程 | 386 / 690 | 386 / 736 | 384 / 453 | 384 / 439 |
| Network Service | 6.7 / 37 | 6.7 / 38 | 6.7 / 38 | 6.7 / 38 |
| 桌宠渲染进程（Live2D） | 138 / 458 | 138 / 452 | — | — |
| 聊天渲染进程 | — | **165 / 316** | 165 / 302 | — |
| cyrene-native（WPF 全部原生窗） | 100 / 181 | 100 / 181 | 100 / 181 | 100 / 181 |
| cyrene-screenshot（热键 helper） | 10.6 / 31.5 | 10.6 / 31.5 | 10.6 / 31.5 | 10.6 / 31.5 |
| **合计** | **832 / 1664** | **997 / 2029** | **856 / 1278** | **691 / 956** |

峰值（同一次运行内）：桌宠渲染进程 WS **1.22GB**（Live2D 首次加载）、GPU 进程 WS 942MB、主进程 WS 325MB。

## 2. 关键发现

1. **桌宠是最大的可回收项，且本批 destroy-on-hide 实锤有效**：
   隐藏桌宠后私有 −140MB、WS −750MB（渲染进程 452MB + GPU 侧纹理 283MB WS）。
   以前 hide 只隐藏窗口，这 ~750MB 会一直挂着。
2. **聊天窗“关即释放”**：私有 −165MB、WS −300MB；`window-all-closed` 不退出（宿主/托盘驻留），
   所以“关掉聊天留桌宠/托盘”的内存路径是成立的。
3. **GPU 进程 ~390MB 私有是本机最大的固定成本**，与窗口数量几乎无关（全关后 WS 439MB）。
   这是无 GPU 环境全软件光栅的基线，不是应用代码泄漏；有独显机器会明显更低。
4. **主进程 190MB 私有 / 490MB commit / JS 堆仅 48MB**：大头是 Chromium/Node 运行时与已加载模块，
   不是用户数据。
5. **原生 WPF 宿主**：`serve` 空载 6MB；打开设置窗冲到 ~126MB，加插件管理窗后 GC 回 ~109MB，
   **关窗后不回落**（109MB 常驻）。设置段本身已是懒构建（首开只建当前段），
   说明成本主要在 WPF/模板首解析 + 已构建视觉树。
6. 小项正常：Network Service 6.7MB；截图 helper 10.6MB（全局热键刚需）；
   插件运行时/embedding sidecar 不常驻（按需）。

## 3. 优化建议（按性价比排序）

### A. 已有收益（本批，保持）
- 桌宠隐藏 = 销毁窗口（含渲染进程）；显示懒重建。**用户只要隐藏桌宠就能省 ~750MB WS。**
- 聊天窗按需加载 + 可关闭回收；插件运行时默认关；embedding sidecar 空闲自动退出。

### B. 建议做（本地可控、收益明确）
1. **桌宠渲染省内存**：
   - 把 Live2D canvas 的 devicePixelRatio 钳到 1.0（当前 400×503 CSS → 500×629 后备 = 1.25×），
     预计省 20% 纹理/GPU 侧内存；
   - 评估关闭抗锯齿/降低纹理过滤（Live2D WebGL 上下文参数）；
   - 若 Live2D 支持，提供“低功耗模式”（低帧率/静态帧），把稳态 138MB/458MB 再压一档。
2. **聊天窗空闲回收**：最小化/失焦 N 分钟后销毁窗口（激活时重建），把 165MB 私有从“长期可回收”变成“自动回收”；
   顺带 `webPreferences.spellcheck=false`（渲染进程拼写字典与检查器有常驻开销，聊天无此需求）。
3. **原生宿主关窗归还内存**：`SettingsWindow.Close()` / `PluginManagerWindow.Close()` 时清空 section 视觉树引用，
   关闭后触发 `GC.Collect(2, GCCollectionMode.Optimized)`（重窗口低频操作，代价可接受），
   把 ~109MB 常驻压回；同时把 NativeTheme 全量样式解析拆到各 section 首用时（首窗打开的一次性 ~120MB 峰值）。
4. **主进程瘦身**：做一次 V8 heap snapshot 找未懒加载的重模块（orchestrator/MCP/文档索引/渠道适配等），
   目标 20-50MB；Electron 44 升级（B5 待办）自带 Chromium 侧改善。
5. **不要做的事**：为省内存关闭 GPU 加速（本机实测反升）；压缩 Network Service/截图 helper（已很小）。

### C. 观测口径（避免误判）
- 用**私有工作集**做进度指标，WS 加总会把共享 DLL 重复计算；
- 测量前确认没有 dev server 等无关 node 进程；
- 桌宠/聊天窗口的销毁-重建会带来短时 JS 堆与 WPF 峰值（如 1.2GB WS 的 Live2D 加载峰值），
  看稳态而不是峰值。

## 4. 跟进实施（2026-09-27 晚，已验证）

| 项 | 改动 | 实测效果 |
|---|---|---|
| 桌宠渲染 DPR 钳制 | `src/renderer/live2d/manager.ts` `PET_RENDER_MAX_DPR = 1`；click-through 的 CSS→buffer 换算改为按实际绘制缓冲比例推导（不再直接用 devicePixelRatio） | 桌宠 canvas 后备缓冲 500×629 → **400×503**（端到端实测），预计纹理/GPU 侧 −20% |
| 聊天窗空闲回收 | 新增 `src/main/windows/chat-idle-reclaim.ts`：最小化满 15 分钟（`CYRENE_CHAT_IDLE_RECLAIM_MS` 可覆盖）销毁窗口；恢复/聚焦取消计时；`create-aux-windows.ts` 挂接 + 聊天窗 `spellcheck:false` | 端到端：最小化后窗口与渲染进程销毁（聊天私有 −165MB / WS −316MB），再激活自动重建并加载（新 PID） |
| 设置窗关闭归还内存 | `SettingsWindow.Close()`：先断 section 视觉树引用 + GC，再 `SetProcessWorkingSetSize(-1,-1)` trim 工作集 | 宿主关窗后私有工作集 **108.5MB → 8.6MB**、WS 200.6 → 27.1MB（commit 120MB 不变，属 standby 页，可换回） |

实施过程中的两个关键认知（已写进不变量）：
1. **WPF 这 100MB 不是托管内存**：实测关窗时托管堆仅 ~5MB，`GC.Collect` 基本无效；
   大头是 WPF 非托管渲染/字体缓存 → 必须 trim 工作集才能让任务管理器数字下降。
2. **回收计时不能在页面加载中开始**：激活链 `openReactChatWindow` 是
   `await load() → show()/focus()`；若在 load 完成前最小化，收尾的 `show()` 会把窗口
   拉回来并取消计时（E2E 曾复现）。真实用户场景（加载完成后才手动最小化）不受影响。

## 5. 不变量

1. 内存基线测量必须注明 GPU 状态（有/无独显结论完全不同）。
2. 桌宠隐藏=销毁、显示=懒重建（见 `2026-09-27-native-polish-batch-2.md`）不得回退成 hide。
3. 新增常驻进程 / 常驻窗口前先对照本基线，评估私有工作集增量。
4. 聊天窗回收计时只认「最小化」且必须能被打断（restore/focus/show 取消）；
   不要在加载完成前启动计时（激活链收尾 show 会还原窗口）。
5. WPF 宿主关窗后的内存归还依赖工作集 trim，不要指望 `GC.Collect`
   （托管堆不是大头）；trim 后 commit 不降是正常的（standby 页按需换回）。
6. 桌宠渲染的 DPR 钳制与 click-through 坐标换算必须同源（按实际绘制缓冲比例推导）。
