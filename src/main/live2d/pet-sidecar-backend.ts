/**
 * 桌宠 sidecar 门面（#257 T5）：把 window-manager 的桌宠控制面翻译成
 * live2d-host 协议 op。dotnet 轨下桌宠窗是侧车自管的 Win32 分层窗口
 * （非 BrowserWindow）——本门面跟踪 DIP 几何、落位拖拽、转发行为通道。
 *
 * 语义对齐 web 轨（铁律：内置化是增量不是替代）：
 *   - 显隐 = show/hide + resume/pause（web：PET_VISIBILITY_CHANGED 停帧）
 *   - 缩放 = 窗口尺寸 round(基准×zoom) + setZoom（web：setSize + PET_ZOOM）
 *   - 拖拽 = 侧车 dragStart/dragMove/dragEnd（屏幕物理像素）→ DIP 换算 →
 *     PetWindowMoveController（16ms 节流落位 + 结束持久化，与 web 同控制器）
 *   - 行为通道 = live2d:speech-prepare/mouth-start/mouth-stop/play-action
 *     （web 轨经 sendToPetWindow 转发渲染进程；dotnet 轨直达侧车）
 *
 * 加载失败（exe 缺失/Core 不可用/模型损坏）→ ensureReady 返回 false，
 * 由 window-manager 回退 web 轨。依赖全部注入，无头可测。
 */
import { IPC } from "../../shared/ipc-channels";
import type { Live2DTarget } from "../../shared/live2d-actions";
import { PetWindowMoveController } from "../pet-window-movement";
import {
  PET_WINDOW_BASE_HEIGHT,
  PET_WINDOW_BASE_WIDTH,
  type PetWindowSettingsSlice,
} from "../startup/create-pet-window";
import type { Live2DHostClient } from "./live2d-host-client";
import { LIVE2D_ERRORS, LIVE2D_EVENTS } from "./live2d-host-protocol";

export interface PetSidecarDeps {
  client: Live2DHostClient;
  /** 模型清单绝对路径（null = 模型缺失 → 回退 web 轨）。 */
  resolveModelPath: () => string | null;
  loadSettings: () => PetWindowSettingsSlice;
  persistPosition: (position: { x: number; y: number }) => void;
  /** 初始落位（保存坐标离屏判定/居中，与 createPetWindow 同逻辑）。 */
  resolveInitialPosition: (settings: PetWindowSettingsSlice, width: number, height: number) => { x: number; y: number };
  /** 窗口所在显示器的 DPI 缩放（拖拽物理像素 → DIP）。 */
  getDisplayScaleFactor: (bounds: { x: number; y: number; width: number; height: number }) => number;
  /** 位置变更通知（window-manager movedHandlers 等价）。 */
  onMoved?: (position: { x: number; y: number }) => void;
  /** Core 缺失时的许可同意弹窗（Live2D Proprietary License 合规闸门）。
   *  返回 true = 用户同意下载（带 coreDownloadConsent 重试 load）；
   *  false/未注入 = 不同意 → 回退 web 轨。 */
  confirmCoreDownload?: () => Promise<boolean>;
  log?: (message: string, error?: unknown) => void;
}

interface DragOrigin {
  screenX: number;
  screenY: number;
  x: number;
  y: number;
  scale: number;
}

export class PetSidecarBackend {
  private ready = false;
  private visible = false;
  private disposed = false;
  private starting: Promise<boolean> | null = null;
  private zoom = 1;
  private bounds = { x: 0, y: 0, width: PET_WINDOW_BASE_WIDTH, height: PET_WINDOW_BASE_HEIGHT };
  private dragOrigin: DragOrigin | null = null;
  private readonly moveController: PetWindowMoveController;
  private readonly listener: (frame: Record<string, unknown>) => void;

  constructor(private readonly deps: PetSidecarDeps) {
    this.moveController = new PetWindowMoveController(
      () => {
        if (!this.ready || this.disposed) return null;
        return {
          isDestroyed: () => !this.ready || this.disposed,
          getPosition: () => [this.bounds.x, this.bounds.y],
          setPosition: (x: number, y: number) => {
            this.bounds.x = x;
            this.bounds.y = y;
            this.fire(this.deps.client.setBounds({ ...this.bounds }));
            this.deps.onMoved?.({ x, y });
          },
        };
      },
      (position) => this.deps.persistPosition(position),
      (message, error) => this.log(message, error),
    );
    this.listener = (frame) => this.onEvent(frame);
    this.deps.client.addEventListener(this.listener);
  }

  /** 侧车进程当前是否可用（崩溃后 isAlive false → 调用方可回退 web 轨）。 */
  isReady(): boolean {
    return this.ready && !this.disposed && this.deps.client.isAlive();
  }

  isVisible(): boolean {
    return this.visible;
  }

  getPosition(): { x: number; y: number } {
    return { x: this.bounds.x, y: this.bounds.y };
  }

  /**
   * 拉起侧车并加载模型、应用设置。失败返回 false（调用方回退 web 轨）；
   * 加载失败时关停已 spawn 的进程，不留孤儿。
   */
  async ensureReady(showOnReady: boolean): Promise<boolean> {
    if (this.isReady()) return true;
    if (this.disposed) return false;
    if (this.starting) return this.starting;
    const starting = (async () => {
      const client = this.deps.client;
      if (!client.enabled()) return false;
      if (!(await client.ensureStarted())) return false;
      const modelPath = this.deps.resolveModelPath();
      if (!modelPath) {
        this.log("[Live2D] 模型清单缺失，回退 web 轨");
        await this.shutdownClient();
        return false;
      }
      try {
        await client.load(modelPath);
      } catch (error) {
        // Live2D 许可合规闸门：Core 缺失须先同意再下载（审计 #257 发现 2）
        if ((error as { errorCode?: string })?.errorCode === LIVE2D_ERRORS.coreConsent) {
          const consented = this.deps.confirmCoreDownload ? await this.deps.confirmCoreDownload() : false;
          if (consented) {
            try {
              await client.load(modelPath, { coreDownloadConsent: true });
              // 同意 + 重试成功 → 继续正常初始化（落到下方 settings 流程）
              return await this.finishReady(client, showOnReady);
            } catch (retryError) {
              this.log("[Live2D] Core 下载/加载失败（已同意），回退 web 轨:", retryError);
              await this.shutdownClient();
              return false;
            }
          }
          this.log("[Live2D] 未同意 Live2D Core 下载许可，回退 web 轨");
          await this.shutdownClient();
          return false;
        }
        this.log("[Live2D] 侧车加载失败，回退 web 轨:", error);
        await this.shutdownClient();
        return false;
      }

      return await this.finishReady(client, showOnReady);
    })();
    this.starting = starting;
    try {
      return await starting;
    } finally {
      this.starting = null;
    }
  }

  /** load 成功后的初始化（设置/几何/显隐）；同意重试成功路径复用。 */
  private async finishReady(client: Live2DHostClient, showOnReady: boolean): Promise<boolean> {
    const settings = this.deps.loadSettings();
    this.zoom = clampZoom(typeof settings.petZoom === "number" && settings.petZoom > 0 ? settings.petZoom : 1);
    const width = Math.round(PET_WINDOW_BASE_WIDTH * this.zoom);
    const height = Math.round(PET_WINDOW_BASE_HEIGHT * this.zoom);
    const pos = this.deps.resolveInitialPosition(settings, width, height);
    this.bounds = { x: pos.x, y: pos.y, width, height };
    await client.setBounds({ ...this.bounds });
    await client.setZoom(this.zoom);
    await client.setAlwaysOnTop(settings.petAlwaysOnTop !== false);

    this.ready = true;
    if (showOnReady) {
      this.visible = true;
      await client.show();
      await client.resume();
    } else {
      await client.pause();
    }
    return true;
  }

  // ── 窗口控制面（DIP） ─────────────────────────────────────

  show(): void {
    if (!this.isReady()) return;
    this.visible = true;
    this.fire(this.deps.client.show());
    this.fire(this.deps.client.resume());
  }

  hide(): void {
    if (!this.isReady()) return;
    this.visible = false;
    this.fire(this.deps.client.hide());
    this.fire(this.deps.client.pause());
  }

  setAlwaysOnTop(value: boolean): void {
    if (!this.isReady()) return;
    this.fire(this.deps.client.setAlwaysOnTop(value));
  }

  setInteractive(value: boolean): void {
    if (!this.isReady()) return;
    this.fire(this.deps.client.setInteractive(value));
  }

  setDragging(value: boolean): void {
    if (!this.isReady()) return;
    this.fire(this.deps.client.setDragging(value));
  }

  /** 缩放：窗口尺寸与模型同步缩放（web applyPetWindowZoom 同语义）。 */
  setZoom(zoom: number): void {
    if (!this.isReady()) return;
    this.zoom = clampZoom(zoom);
    this.bounds.width = Math.round(PET_WINDOW_BASE_WIDTH * this.zoom);
    this.bounds.height = Math.round(PET_WINDOW_BASE_HEIGHT * this.zoom);
    this.fire(this.deps.client.setBounds({ ...this.bounds }));
    this.fire(this.deps.client.setZoom(this.zoom));
  }

  moveRelative(dx: number, dy: number): void {
    this.moveController.moveRelative(dx, dy);
  }

  moveTo(x: number, y: number): void {
    this.moveController.queueAbsolute(x, y);
  }

  /** 拖拽结束：落位并持久化（web setPetWindowDragging(false) 同语义）。 */
  finishDragging(): void {
    this.moveController.finishDragging();
  }

  // ── 行为通道（web sendToPetWindow 的 dotnet 轨等价） ──────

  sendChannel(channel: string, payload?: unknown): void {
    if (!this.isReady()) return;
    switch (channel) {
      case IPC.LIVE2D_SPEECH_PREPARE:
        this.fire(this.deps.client.speechPrepare());
        break;
      case IPC.LIVE2D_MOUTH_START: {
        const durationMs = Number((payload as { durationMs?: number } | undefined)?.durationMs ?? 0);
        this.fire(this.deps.client.mouthStart(durationMs));
        break;
      }
      case IPC.LIVE2D_MOUTH_STOP:
        this.fire(this.deps.client.mouthStop());
        break;
      case IPC.LIVE2D_PLAY_ACTION:
        if (payload) this.fire(this.deps.client.play(payload as Live2DTarget));
        break;
      case IPC.PET_VISIBILITY_CHANGED:
        if (payload === true) {
          this.visible = true;
          this.fire(this.deps.client.resume());
        } else {
          this.visible = false;
          this.fire(this.deps.client.pause());
        }
        break;
      case IPC.PET_ZOOM:
        this.setZoom(Number(payload));
        break;
      default:
        // 其余通道面向渲染进程（dotnet 轨无桌宠 renderer），忽略
        break;
    }
  }

  // ── 诊断 ──────────────────────────────────────────────────

  /** PNG dataURL（web capturePetWindowFrame 同形态）；失败 null。 */
  async captureFrame(): Promise<string | null> {
    if (!this.isReady()) return null;
    try {
      const frame = await this.deps.client.captureFrame();
      return `data:image/png;base64,${frame.png}`;
    } catch (error) {
      this.log("[Live2D] captureFrame 失败:", error);
      return null;
    }
  }

  async getDiagnostics(): Promise<unknown> {
    if (!this.isReady()) return { ready: false };
    try {
      return await this.deps.client.getDiagnostics();
    } catch (error) {
      return { ready: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.ready = false;
    this.deps.client.removeEventListener(this.listener);
    this.moveController.dispose();
    await this.shutdownClient();
  }

  // ── 内部 ──────────────────────────────────────────────────

  private onEvent(frame: Record<string, unknown>): void {
    if (frame.op !== "event" || this.disposed) return;
    const payload = (frame.payload ?? {}) as Record<string, unknown>;
    switch (frame.name) {
      case LIVE2D_EVENTS.dragStart: {
        // 拖拽起点：屏幕物理像素 + 当前 DIP 位置 + 显示器缩放
        this.dragOrigin = {
          screenX: Number(payload.screenX ?? 0),
          screenY: Number(payload.screenY ?? 0),
          x: this.bounds.x,
          y: this.bounds.y,
          scale: this.deps.getDisplayScaleFactor({ ...this.bounds }) || 1,
        };
        break;
      }
      case LIVE2D_EVENTS.dragMove: {
        const origin = this.dragOrigin;
        if (!origin) return;
        const dx = (Number(payload.screenX ?? 0) - origin.screenX) / origin.scale;
        const dy = (Number(payload.screenY ?? 0) - origin.screenY) / origin.scale;
        this.moveController.queueAbsolute(origin.x + dx, origin.y + dy);
        break;
      }
      case LIVE2D_EVENTS.dragEnd:
        this.dragOrigin = null;
        this.moveController.finishDragging();
        break;
      default:
        // hit/miss/interactive/frameStats/loaded：行为在侧车内部闭环，
        // 主进程仅诊断消费（getDiagnostics），无需转发
        break;
    }
  }

  private fire(promise: Promise<unknown>): void {
    promise.catch((error) => this.log("[Live2D] 侧车调用失败:", error));
  }

  private async shutdownClient(): Promise<void> {
    try {
      await this.deps.client.shutdown();
    } catch {
      /* 进程已退出 */
    }
  }

  private log(message: string, error?: unknown): void {
    if (this.deps.log) this.deps.log(message, error);
    else console.warn(message, error);
  }
}

function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1;
  return Math.min(2, Math.max(0.5, zoom));
}

/**
 * 模型清单定位（纯函数，Electron app 切片注入——vitest 下裸 require("electron")
 * 不可靠，同 secretsDataDir 注入先例）。web 轨同源资源（vite public 拷贝）：
 *   打包态 = dist/renderer/models/cyrene/（vite build 产物）
 *   开发态 = src/renderer/public/models/cyrene/（vite dev 直接伺服）
 */
export function resolveLive2DModelPathFrom(
  app: { isPackaged?: boolean; getAppPath: () => string } | undefined,
): string | null {
  try {
    if (!app) return null;
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const appPath = app.getAppPath();
    const candidates = app.isPackaged
      ? [path.join(appPath, "dist", "renderer", "models", "cyrene", "Cyrene.model3.json")]
      : [
          path.join(appPath, "src", "renderer", "public", "models", "cyrene", "Cyrene.model3.json"),
          path.join(appPath, "dist", "renderer", "models", "cyrene", "Cyrene.model3.json"),
        ];
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return null;
  } catch {
    return null;
  }
}

/** 生产入口（Electron 主进程）。 */
export function resolveLive2DModelPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    return resolveLive2DModelPathFrom(electron.app);
  } catch {
    return null;
  }
}
