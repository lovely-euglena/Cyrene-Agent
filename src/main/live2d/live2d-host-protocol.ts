/**
 * live2d-host 线协议契约（TS 侧事实镜像，#257 T5）。
 *
 * C# 事实源：dotnet/live2d/CyreneLive2D/Host/Live2DContracts.cs——两侧字符串
 * 必须逐字一致，一致性由 live2d-contract.test.ts 扫描 C# 源码锁定
 * （同 llm-host-protocol / native-settings-protocol 先例）。
 * 任一侧改动必须同批同步，否则 CI 红。
 *
 * 帧形态（与七 host 同构）：
 *   → {"op":"load","callId":"c1","modelPath":"..."}
 *   ← {"op":"ready"}
 *   ← {"op":"result","callId":"c1","ok":true,"data":{...}}
 *   ← {"op":"result","callId":"c1","ok":false,"error":"...","errorCode":"E_..."}
 *   ← {"op":"event","name":"hit","payload":{...}}
 *
 * 注意：C# HostIo 序列化 WhenWritingNull——可空字段为 null 时整段省略，
 * 故 TS 侧可空载荷字段一律可选（?:）而非 | null。
 */
import type { Live2DTarget } from "../../shared/live2d-actions";

export type { Live2DTarget };

export const LIVE2D_OPS = {
  // 请求
  load: "load",
  show: "show",
  hide: "hide",
  setBounds: "setBounds",
  setZoom: "setZoom",
  setAlwaysOnTop: "setAlwaysOnTop",
  play: "play",
  speechPrepare: "speechPrepare",
  mouthStart: "mouthStart",
  mouthStop: "mouthStop",
  setDragging: "setDragging",
  setInteractive: "setInteractive",
  pause: "pause",
  resume: "resume",
  hitTest: "hitTest",
  captureFrame: "captureFrame",
  getDiagnostics: "getDiagnostics",
  setParameter: "setParameter",
  renderOnce: "renderOnce",
  /** 诊断/测试：确定性推进一帧（T6 对照）。 */
  tick: "tick",
  shutdown: "shutdown",
  // 响应帧 op
  ready: "ready",
  result: "result",
} as const;

export const LIVE2D_EVENTS = {
  loaded: "loaded",
  /** 预留：加载失败当前走 result 错误帧（errorCode），此事件名已在 C# 契约登记。 */
  loadFailed: "loadFailed",
  hit: "hit",
  miss: "miss",
  interactive: "interactive",
  dragStart: "dragStart",
  dragMove: "dragMove",
  dragEnd: "dragEnd",
  frameStats: "frameStats",
} as const;

export const LIVE2D_ERRORS = {
  coreMissing: "E_CORE_MISSING",
  coreDownload: "E_CORE_DOWNLOAD",
  modelLoad: "E_MODEL_LOAD",
  notLoaded: "E_NOT_LOADED",
  badArgs: "E_BAD_ARGS",
  render: "E_RENDER",
  window: "E_WINDOW",
  internal: "E_INTERNAL",
} as const;

// ── 载荷形态（C# 匿名对象 camelCase 序列化） ─────────────────

/** load result.data（PetEngine.HandleLoad）。 */
export interface Live2DLoadResult {
  coreVersion: string;
  corePath: string;
  mocVersion: string;
  parameters: number;
  parts: number;
  drawables: number;
  canvasWidth: number;
  canvasHeight: number;
  pixelsPerUnit: number;
  motionGroups: string[];
  expressions: string[];
  hitAreas: string[];
}

/** setBounds 请求（DIP 坐标，主进程窗口语义）。 */
export interface Live2DBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** play 请求 target（与 shared/live2d-actions 同源）。 */
export interface Live2DPlayRequest {
  target: Live2DTarget;
}

/** play result.data：重复设置同一表情等场景返回 false。 */
export interface Live2DPlayResult {
  played: boolean;
}

/** setZoom result.data（侧车 clamp 0.5–2 后的实际值）。 */
export interface Live2DZoomResult {
  zoom: number;
}

/** hitTest result.data（窗口 DIP 坐标 → 命中区域名列表）。 */
export interface Live2DHitTestResult {
  areas: string[];
  x: number;
  y: number;
}

/** captureFrame result.data（PNG base64，拖拽快照/T6 对照）。 */
export interface Live2DCaptureResult {
  width: number;
  height: number;
  png: string;
}

/** renderOnce result.data（离屏渲染统计，无 PNG 回传）。 */
export interface Live2DRenderOnceResult {
  width: number;
  height: number;
  opaquePixels: number;
  maskGroups: number;
}

/** tick result.data。 */
export interface Live2DTickResult {
  nowMs: number;
}

/** getDiagnostics result.data（PetEngine.GetDiagnostics；可空段省略）。 */
export interface Live2DDiagnostics {
  loaded: boolean;
  coreVersion?: string;
  corePath?: string;
  modelDir?: string;
  parameters: number;
  drawables: number;
  nowMs: number;
  paused: boolean;
  dragging: boolean;
  interactiveOverride: boolean;
  zoom: number;
  winW: number;
  winH: number;
  idleFps: number;
  motion?: {
    playing: boolean;
    currentGroup?: string;
    currentIndex?: number;
  };
  expression?: string;
  controllers?: {
    physics: boolean;
    pose: boolean;
    breath: boolean;
    mouthActive: boolean;
    swingRestoring: boolean;
    focusX: number;
    focusY: number;
  };
}

// ── 事件载荷（event 帧 payload 段） ──────────────────────────

export interface Live2DLoadedPayload {
  modelPath: string;
}

export interface Live2DHitPayload {
  areas: string[];
  x: number;
  y: number;
}

export interface Live2DMissPayload {
  area: string;
}

export interface Live2DInteractivePayload {
  value: boolean;
}

/** dragStart/dragMove：屏幕物理像素（主进程落位用）。 */
export interface Live2DDragPayload {
  screenX: number;
  screenY: number;
}

export interface Live2DFrameStatsPayload {
  fps: number;
  frameMs: number;
}
