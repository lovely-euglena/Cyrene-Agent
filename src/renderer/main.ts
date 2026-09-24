import { Live2DManager } from "./live2d/manager";
import "./ui/theme";
import { InteractionController } from "./live2d/interaction";
import { MouseFocusController } from "./live2d/focus";
import { ExpressionResetController } from "./live2d/expression-reset";
import { MouthSyncController } from "./live2d/mouth-sync";
import { SpeakingMotionController } from "./live2d/speaking-motion";
// OpenerBubbleController 已被移除（主动开口子系统整体删除）。
import { ClickThroughController } from "./live2d/click-through";
import { Live2DRendererLifecycleTracker } from "./live2d/lifecycle-diagnostics";
import { resolveDragCalibration } from "./pet-drag-calibration";
import { resolveAsset } from "../shared/renderer-base";

const canvas = document.getElementById("live2d-canvas") as HTMLCanvasElement;
if (!canvas) throw new Error("Canvas #live2d-canvas not found");

if (!window.cyrene) {
  (window as unknown as { cyrene: unknown }).cyrene = {
    minimize: () => {},
    hide: () => {},
    quit: () => {},
    setInteractive: (_: boolean) => Promise.resolve(),
    moveBy: (_dx: number, _dy: number) => {},
    moveTo: (_x: number, _y: number) => {},
    setDragging: (_isDragging: boolean) => {},
    captureFrame: () => Promise.resolve(null),
    getCursorPosition: () => Promise.resolve(null),
    onPetZoom: (_cb: (zoom: number) => void) => () => {},
    onPetVisibilityChanged: (_cb: (visible: boolean) => void) => () => {},
  };
}

declare global {
  interface Window {
    live2dSpeech?: {
      onPrepare: (callback: () => void) => () => void;
      onMouthStart: (callback: (payload: { durationMs: number }) => void) => () => void;
      onMouthStop: (callback: () => void) => () => void;
    };
    live2dAction?: {
      onPlayAction: (callback: (target: import("../shared/live2d-actions").Live2DTarget) => void) => () => void;
    };
  }
}

let interaction: InteractionController | null = null;
let focus: MouseFocusController | null = null;
let expressionReset: ExpressionResetController | null = null;
let mouthSync: MouthSyncController | null = null;
let speakingMotion: SpeakingMotionController | null = null;
let clickThrough: ClickThroughController | null = null;
let petZoomOff: (() => void) | null = null;
let petVisibilityOff: (() => void) | null = null;
let petVisible = true;
let live2dSpeechOffs: Array<() => void> = [];
const live2dLifecycle = new Live2DRendererLifecycleTracker();

function trackSubscription(label: string, off: () => void): () => void {
  return live2dLifecycle.track("subscription", label, off);
}

function addTrackedEventListener(
  target: EventTarget,
  label: string,
  type: string,
  listener: EventListenerOrEventListenerObject,
): void {
  target.addEventListener(type, listener);
  live2dLifecycle.track("listener", label, () => target.removeEventListener(type, listener));
}

const manager = new Live2DManager({
  canvas,
  width: window.innerWidth,
  height: window.innerHeight,
  modelPath: resolveAsset("models/cyrene/Cyrene.model3.json"),
  onLoad: () => {
    console.log("[Cyrene] Model loaded");
    const model = manager.getModel();
    if (!model) return;

    expressionReset = new ExpressionResetController(model);
    mouthSync = new MouthSyncController(model);
    speakingMotion = new SpeakingMotionController(model);
    const speechOffs: Array<() => void> = [];
    speechOffs.push(
      trackSubscription("live2dSpeech:onPrepare", window.live2dSpeech?.onPrepare(() => {
        void expressionReset?.resetNow();
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {})),
      trackSubscription("live2dSpeech:onMouthStart", window.live2dSpeech?.onMouthStart((payload) => {
        mouthSync?.start(Number(payload.durationMs ?? 0));
        speakingMotion?.start();
      }) ?? (() => {})),
      trackSubscription("live2dSpeech:onMouthStop", window.live2dSpeech?.onMouthStop(() => {
        mouthSync?.stop();
        speakingMotion?.stop();
      }) ?? (() => {})),
    );
    // LLM-driven action bridge: when Main sends a resolved Live2DTarget, play it.
    speechOffs.push(
      trackSubscription("live2dAction:onPlayAction", window.live2dAction?.onPlayAction((target) => {
        void manager.playAction(target);
      }) ?? (() => {})),
    );
    live2dSpeechOffs = speechOffs;
    interaction = new InteractionController(canvas, model, manager.getHitAreaDefs(), {
      onTrigger: (area) => {
        expressionReset?.restart();
        console.log("[Cyrene] hit", area.name, "->", area.group + ":" + area.motionName);
      },
      onMiss: (area) =>
        console.warn("[Cyrene] hit", area.name, "has no resolvable motion"),
    });

    focus = new MouseFocusController(canvas, model);
    focus.focusCenter(true);

    clickThrough = new ClickThroughController(canvas, manager, {
      onInteractive: (interactive) => {
        // 鼠标扫过窗面（无论命中模型与否）都是活跃信号 → 回满帧率
        manager.markActivity();
        void window.cyrene.setInteractive(interactive);
      },
    });

    // Apply the persisted zoom on load and track future changes. The main
    // process has already resized the window to base × zoom; this rescales
    // the model to match.
    petZoomOff = trackSubscription("cyrene:onPetZoom", window.cyrene.onPetZoom((zoom) => manager.applyZoom(zoom)));
    petVisibilityOff = trackSubscription("cyrene:onPetVisibilityChanged", window.cyrene.onPetVisibilityChanged((visible) => {
      petVisible = visible;
      if (!visible) {
        clickThrough?.pause();
        focus?.pause();
        manager.pause();
        return;
      }
      if (!isDragging) {
        manager.resume();
        focus?.resume();
        clickThrough?.resume();
      }
    }));

    // 启动竞态修复：主进程在渲染进程就绪前发的 PET_ZOOM 事件会被丢弃。
    // 注册监听后主动从磁盘读一次 petZoom 并应用，确保重启后模型大小生效。
    window.settings?.getGeneral().then((cfg) => {
      if (cfg?.petZoom && cfg.petZoom !== 1) {
        manager.applyZoom(cfg.petZoom);
      }
    }).catch(() => { /* 设置读取失败不影响加载 */ });

    (window as unknown as { __cyrene: unknown }).__cyrene = {
      manager,
      interaction,
      focus,
      expressionReset,
      resetExpression: () => expressionReset?.resetNow(),
      getLive2DDiagnostics: () => ({
        resources: manager.getResourceMetrics(),
        lifecycle: live2dLifecycle.getDiagnostics(),
        controllers: {
          interaction: interaction !== null,
          focus: focus !== null,
          expressionReset: expressionReset !== null,
          mouthSync: mouthSync !== null,
          speakingMotion: speakingMotion !== null,
          clickThrough: clickThrough !== null,
        },
        petVisible,
        isDragging,
      }),
    };
  },
  onError: (err) => {
    console.error("[Cyrene] Failed to load model:", err);
  },
});

manager.init();

addTrackedEventListener(window, "window:resize", "resize", () => {
  manager.resize(window.innerWidth, window.innerHeight);
  focus?.focusCenter(true);
});

window.addEventListener("beforeunload", () => {
  expressionReset?.dispose();
  expressionReset = null;
  for (const off of live2dSpeechOffs) off();
  live2dSpeechOffs = [];
  mouthSync?.dispose();
  mouthSync = null;
  speakingMotion?.dispose();
  speakingMotion = null;
  focus?.dispose();
  focus = null;
  clickThrough?.dispose();
  clickThrough = null;
  petZoomOff?.();
  petZoomOff = null;
  petVisibilityOff?.();
  petVisibilityOff = null;
  interaction?.dispose();
  interaction = null;
  manager.dispose();
  live2dLifecycle.disposeAll();
});

let isDragging = false;
let dragOffsetX = 0;
let dragOffsetY = 0;
let pendingPosition: { x: number; y: number } | null = null;
let rafId: number | null = null;
let dragOverlay: HTMLImageElement | null = null;
let dragToken = 0;
// 拖动抖动修复：
//   1) pointerId 过滤——setInteractive(true) 的 IPC 往返延迟窗口内，
//      move 走「穿透 forward 合成事件」路径；落地后走 capture 路径。
//      两条路径在 DPI≠100% 时的 screenX 单位可能不同（Chromium Windows
//      已知差异），双流交替 = 目标位置交替 = 左下↔右上抖动。只信
//      setPointerCapture 成功的那个 pointerId。
//   2) 自适应单位系数 k——screenX 是物理像素还是 DIP 在不同 Chromium
//      版本/缩放设置下不一致，硬编码 DPR 换算不可靠。拖动首个反馈帧用
//      「同一条命令」实测校准：命令目标 vs 该命令产生的窗口实际位置
//      （窗口尚未响应命令时不校准，见 pet-drag-calibration.ts）。
let dragPointerId = -1;
let dragUnitScale = 1;
let dragBaseScreen = { x: 0, y: 0 };
let dragBaseWin = { x: 0, y: 0 };
let dragCalibrated = false;
let dragLastSent: {
  /** 命令的窗口目标位置 */
  x: number;
  y: number;
  /** 命令下发时的窗口基准/指针基准（校准重设时取同一命令的基准对） */
  baseWinX: number;
  baseWinY: number;
  baseScreenX: number;
  baseScreenY: number;
} | null = null;

let dragOverlayUrl: string | null = null;

function clearDragOverlay(): void {
  if (dragOverlay) {
    dragOverlay.remove();
    dragOverlay = null;
  }
  if (dragOverlayUrl) {
    URL.revokeObjectURL(dragOverlayUrl);
    dragOverlayUrl = null;
  }
  canvas.style.visibility = "";
}

function captureCanvasBlob(): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      // preserveDrawingBuffer is enabled, so the last rendered frame is
      // readable even after the PIXI ticker has been paused.
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch (err) {
      console.warn("[Cyrene] canvas.toBlob failed", err);
      resolve(null);
    }
  });
}

async function showDragOverlay(token: number): Promise<void> {
  const blob = await captureCanvasBlob();
  if (!blob || token !== dragToken || !isDragging) return;

  const url = URL.createObjectURL(blob);
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  img.draggable = false;
  img.style.position = "fixed";
  img.style.inset = "0";
  img.style.width = "100vw";
  img.style.height = "100vh";
  img.style.objectFit = "contain";
  img.style.pointerEvents = "none";
  img.style.userSelect = "none";
  img.style.zIndex = "10";

  img.onload = () => {
    if (token !== dragToken || !isDragging) {
      URL.revokeObjectURL(url);
      return;
    }
    dragOverlay?.remove();
    dragOverlay = img;
    dragOverlayUrl = url;
    document.body.appendChild(img);
    canvas.style.visibility = "hidden";
  };
  img.onerror = () => URL.revokeObjectURL(url);
}

function scheduleMoveTo(screenX: number, screenY: number): void {
  if (!Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
  if (!Number.isFinite(dragOffsetX) || !Number.isFinite(dragOffsetY)) return;
  pendingPosition = {
    x: screenX - dragOffsetX,
    y: screenY - dragOffsetY,
  };
  if (rafId === null) {
    rafId = requestAnimationFrame(flushMove);
  }
}

function flushMove(): void {
  rafId = null;
  if (pendingPosition) {
    window.cyrene.moveTo(pendingPosition.x, pendingPosition.y);
    pendingPosition = null;
  }
}

function cancelPendingMove(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  pendingPosition = null;
}

function finishDrag(): void {
  isDragging = false;
  dragToken += 1;
  dragLastSent = null;
  cancelPendingMove();
  clearDragOverlay();
  if (petVisible) {
    manager.resume();
    focus?.resume();
  }
  window.cyrene.setDragging(false);
  if (petVisible) clickThrough?.resume();
}

// Click-through is driven per-pixel by ClickThroughController on pointermove.
// We only need enter/leave to bookend the cursor's stay in the window:
// entering hands control to the controller, leaving the window entirely
// means there's nothing to capture (and no move will fire), so pass through.
addTrackedEventListener(canvas, "canvas:pointerenter", "pointerenter", () => {
  clickThrough?.resume();
});

addTrackedEventListener(canvas, "canvas:pointercancel", "pointercancel", () => {
  if (isDragging) finishDrag();
});

addTrackedEventListener(canvas, "canvas:pointerleave", "pointerleave", () => {
  if (isDragging) return;
  void window.cyrene.setInteractive(false);
});

addTrackedEventListener(canvas, "canvas:pointerdown", "pointerdown", (e) => {
  const event = e as PointerEvent;
  if (isDragging) return;
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return;
  if (!Number.isFinite(window.screenX) || !Number.isFinite(window.screenY)) return;
  isDragging = true;
  dragToken += 1;
  const token = dragToken;
  dragPointerId = event.pointerId;
  dragCalibrated = false;
  dragUnitScale = 1;
  dragLastSent = null;
  dragBaseScreen = { x: event.screenX, y: event.screenY };
  dragBaseWin = { x: window.screenX, y: window.screenY };
  dragOffsetX = event.screenX - window.screenX;
  dragOffsetY = event.screenY - window.screenY;
  console.info(
    `[PetDrag] down screen=(${event.screenX},${event.screenY}) win=(${window.screenX},${window.screenY}) dpr=${window.devicePixelRatio}`,
  );
  cancelPendingMove();
  clickThrough?.pause();
  focus?.pause(true);
  manager.pause();
  void window.cyrene.setInteractive(true);
  window.cyrene.setDragging(true);
  try {
    (event.target as Element).setPointerCapture(event.pointerId);
  } catch {}
  void showDragOverlay(token);
});

addTrackedEventListener(canvas, "canvas:pointermove", "pointermove", (e) => {
  const event = e as PointerEvent;
  if (!isDragging) return;
  // 双流过滤：只信 capture 的 pointerId（forward 合成的 move 不驱动拖动）
  if (dragPointerId !== -1 && event.pointerId !== dragPointerId) return;

  // 单位校准：只在「同一条命令」上测量——命令目标 vs 该命令产生的实际
  // 窗口位置；窗口尚未响应命令时不校准、不重设基准（避免误判成单位差
  // 把 k 钳到 0.25，出现"拖动跟不上"）。
  if (!dragCalibrated && dragLastSent) {
    const result = resolveDragCalibration({
      lastTarget: { x: dragLastSent.x, y: dragLastSent.y },
      baseWin: { x: dragLastSent.baseWinX, y: dragLastSent.baseWinY },
      actual: { x: window.screenX, y: window.screenY },
    });
    if (result.kind === "matched") {
      dragCalibrated = true;
    } else if (result.kind === "rescale") {
      dragUnitScale = result.unitScale;
      // 以同一命令重设基准对：窗口取实际落位，指针取该命令的基准 screen，
      // 当前帧位移照常累加（不丢帧）
      dragBaseWin = { x: window.screenX, y: window.screenY };
      dragBaseScreen = { x: dragLastSent.baseScreenX, y: dragLastSent.baseScreenY };
      dragCalibrated = true;
      console.info(`[PetDrag] calibrate k=${dragUnitScale.toFixed(3)}`);
    }
  }

  const dx = (event.screenX - dragBaseScreen.x) * dragUnitScale;
  const dy = (event.screenY - dragBaseScreen.y) * dragUnitScale;
  scheduleMoveTo(dragBaseWin.x + dx + dragOffsetX, dragBaseWin.y + dy + dragOffsetY);
  dragLastSent = {
    x: dragBaseWin.x + dx,
    y: dragBaseWin.y + dy,
    baseWinX: dragBaseWin.x,
    baseWinY: dragBaseWin.y,
    baseScreenX: dragBaseScreen.x,
    baseScreenY: dragBaseScreen.y,
  };
});

addTrackedEventListener(canvas, "canvas:pointerup", "pointerup", (e) => {
  const event = e as PointerEvent;
  if (!isDragging) return;
  if (dragPointerId !== -1 && event.pointerId !== dragPointerId) return;
  dragPointerId = -1;
  console.info(`[PetDrag] up win=(${window.screenX},${window.screenY}) k=${dragUnitScale.toFixed(3)}`);
  // up 的落点与 move 同坐标系（Δ×k + 基准），避免最后一次跳变
  const dx = (event.screenX - dragBaseScreen.x) * dragUnitScale;
  const dy = (event.screenY - dragBaseScreen.y) * dragUnitScale;
  scheduleMoveTo(dragBaseWin.x + dx + dragOffsetX, dragBaseWin.y + dy + dragOffsetY);
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  flushMove();
  finishDrag();

  try {
    (event.target as Element).releasePointerCapture(event.pointerId);
  } catch {}

  const rect = canvas.getBoundingClientRect();
  const outside =
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom;
  if (outside) void window.cyrene.setInteractive(false);
});
