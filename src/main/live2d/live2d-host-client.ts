/**
 * Live2D sidecar 客户端（#257 T5；与七 host 同构的 JSON 行协议薄客户端）。
 *
 * cyrene-live2d.exe 默认形态即协议宿主（无 mode 参数）：stdin 行帧 →
 * PetEngine（模型/行为/渲染/Win32 分层窗口）。本客户端只做 op 塑形与
 * 结果解包；窗口几何/行为语义全在侧车（web 轨语义逐式移植，见侧车源码）。
 *
 * 开关：LIVE2D_ENGINE=dotnet|web（resolveDotnetConfig().live2dEngine，
 * 默认 web）。exe 缺失时 resolveExe 返回 null → ensureStarted false，
 * 由桌宠门面回退 web 轨（铁律：内置化是增量不是替代）。
 *
 * 进程生命周期复用 LineHostClient（IKJSNF：代际守卫/超时强杀/订阅成对）。
 */
import { resolveDotnetConfig } from "../dotnet-backend/config";
import { LineHostClient } from "../dotnet-backend/host-clients";
import { secretsDataDir } from "../dotnet-backend/secrets-client";
import type { Live2DTarget } from "../../shared/live2d-actions";
import {
  LIVE2D_OPS,
  type Live2DBounds,
  type Live2DCaptureResult,
  type Live2DDiagnostics,
  type Live2DHitTestResult,
  type Live2DLoadResult,
  type Live2DPlayResult,
  type Live2DRenderOnceResult,
  type Live2DTickResult,
  type Live2DZoomResult,
} from "./live2d-host-protocol";

const LIVE2D_EXE_NAME = "cyrene-live2d.exe";

/** load 超时上限：Core 缺失时侧车会从官方源下载 SDK zip（SHA256 校验），
 *  慢网络下可达分钟级；其余 op 走默认 10s。 */
export const LIVE2D_LOAD_TIMEOUT_MS = 10 * 60_000;

/** Electron app 最小切片（纯函数注入，测试不经 require("electron")——
 *  vitest 下裸 require 不可靠，同 secretsDataDir 注入先例）。 */
export interface Live2DElectronAppSlice {
  isPackaged?: boolean;
  getAppPath: () => string;
}

/**
 * exe 解析（纯函数）：打包态 resources/live2d/；开发态 publish 优先、
 * 其次普通构建输出。缺失返回 null（门面据此回退 web 轨）。
 */
export function resolveLive2DExe(
  app: Live2DElectronAppSlice | undefined,
  resourcesPath: string | undefined,
): string | null {
  try {
    if (!app) return null;
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    if (app.isPackaged) {
      if (!resourcesPath) return null;
      const p = path.join(resourcesPath, "live2d", LIVE2D_EXE_NAME);
      return fs.existsSync(p) ? p : null;
    }
    const devRoot = path.join(
      app.getAppPath(), "dotnet", "live2d", "CyreneLive2D",
      "bin", "Release", "net10.0-windows",
    );
    const publish = path.join(devRoot, "win-x64", "publish", LIVE2D_EXE_NAME);
    if (fs.existsSync(publish)) return publish;
    const dev = path.join(devRoot, LIVE2D_EXE_NAME);
    return fs.existsSync(dev) ? dev : null;
  } catch {
    return null;
  }
}

export class Live2DHostClient extends LineHostClient {
  enabled(): boolean {
    return resolveDotnetConfig().live2dEngine === "dotnet";
  }

  constructor() {
    // 空 mode：侧车无 mode 参数（默认形态即宿主）
    super("", 10_000);
  }

  protected resolveExe(): string | null {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const electron = require("electron");
      return resolveLive2DExe(electron.app, process.resourcesPath);
    } catch {
      return null;
    }
  }

  protected extraArgs(): string[] {
    // Core 自动下载落 dataDir/live2d-core/（userData；便携模式已重定向）
    return ["--data-dir", secretsDataDir()];
  }

  // ── 生命周期 ──────────────────────────────────────────────

  /** 加载模型（含 Core 解析）。Core 缺失时侧车回 E_CORE_CONSENT，须用户同意
   *  Live2D 许可后带 coreDownloadConsent=true 重试才下载（合规闸门）。
   *  失败错误码见 LIVE2D_ERRORS。 */
  async load(modelPath: string, opts?: { coreDownloadConsent?: boolean }): Promise<Live2DLoadResult> {
    return (await this.call(
      LIVE2D_OPS.load,
      { modelPath, ...(opts?.coreDownloadConsent ? { coreDownloadConsent: true } : {}) },
      LIVE2D_LOAD_TIMEOUT_MS,
    )) as Live2DLoadResult;
  }

  // ── 窗口控制面（DIP 坐标） ────────────────────────────────

  show(): Promise<unknown> { return this.call(LIVE2D_OPS.show, {}); }
  hide(): Promise<unknown> { return this.call(LIVE2D_OPS.hide, {}); }
  setBounds(bounds: Live2DBounds): Promise<unknown> { return this.call(LIVE2D_OPS.setBounds, { ...bounds }); }
  async setZoom(zoom: number): Promise<Live2DZoomResult> {
    return (await this.call(LIVE2D_OPS.setZoom, { zoom })) as Live2DZoomResult;
  }
  setAlwaysOnTop(value: boolean): Promise<unknown> { return this.call(LIVE2D_OPS.setAlwaysOnTop, { value }); }
  setInteractive(value: boolean): Promise<unknown> { return this.call(LIVE2D_OPS.setInteractive, { value }); }
  setDragging(value: boolean): Promise<unknown> { return this.call(LIVE2D_OPS.setDragging, { value }); }
  pause(): Promise<unknown> { return this.call(LIVE2D_OPS.pause, {}); }
  resume(): Promise<unknown> { return this.call(LIVE2D_OPS.resume, {}); }

  // ── 行为面（web 轨同语义） ────────────────────────────────

  async play(target: Live2DTarget): Promise<Live2DPlayResult> {
    return (await this.call(LIVE2D_OPS.play, { target })) as Live2DPlayResult;
  }
  speechPrepare(): Promise<unknown> { return this.call(LIVE2D_OPS.speechPrepare, {}); }
  mouthStart(durationMs: number): Promise<unknown> { return this.call(LIVE2D_OPS.mouthStart, { durationMs }); }
  mouthStop(): Promise<unknown> { return this.call(LIVE2D_OPS.mouthStop, {}); }

  // ── 诊断/测试面 ───────────────────────────────────────────

  async hitTest(x: number, y: number): Promise<Live2DHitTestResult> {
    return (await this.call(LIVE2D_OPS.hitTest, { x, y })) as Live2DHitTestResult;
  }
  async captureFrame(): Promise<Live2DCaptureResult> {
    return (await this.call(LIVE2D_OPS.captureFrame, {})) as Live2DCaptureResult;
  }
  async getDiagnostics(): Promise<Live2DDiagnostics> {
    return (await this.call(LIVE2D_OPS.getDiagnostics, {})) as Live2DDiagnostics;
  }
  setParameter(id: string, value: number): Promise<unknown> {
    return this.call(LIVE2D_OPS.setParameter, { id, value });
  }
  async renderOnce(width?: number, height?: number, zoom?: number): Promise<Live2DRenderOnceResult> {
    return (await this.call(LIVE2D_OPS.renderOnce, { width, height, zoom })) as Live2DRenderOnceResult;
  }
  async tick(dtMs: number): Promise<Live2DTickResult> {
    return (await this.call(LIVE2D_OPS.tick, { dtMs })) as Live2DTickResult;
  }
}

export const live2dHostClient = new Live2DHostClient();

let clientForTests: Live2DHostClient | null = null;

/** 测试注入口：替换单例（桌宠门面测试用桩客户端）。 */
export function __setLive2DHostClientForTests(client: Live2DHostClient | null): void {
  clientForTests = client;
}

/** 桌宠门面统一入口（可注入桩）。 */
export function activeLive2DClient(): Live2DHostClient {
  return clientForTests ?? live2dHostClient;
}
