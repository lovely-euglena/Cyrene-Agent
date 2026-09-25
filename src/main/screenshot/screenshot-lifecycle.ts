import * as path from "node:path";
import * as fs from "fs";
import { spawn } from "node:child_process";
import { trackChildProcess } from "../child-processes";
import { app, BrowserWindow, clipboard, globalShortcut, nativeImage } from "electron";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import { ElectronScreenshotHelperClient } from "./helper-client";
import { resolveScreenshotHelperPath } from "./helper-path";
import {
  createScreenshotService,
  validateScreenshotInsert,
  type ScreenshotBackendKind,
  type ScreenshotInsertData,
  type ScreenshotService,
} from "./screenshot-service";
import { detectSnipasteExecutable } from "./snipaste-detect";
import { SnipasteScreenshotClient, SwitchableScreenshotClient } from "./snipaste-client";
import { NativeSnipasteCaptureClient } from "./native-snipaste-client";
import type { ScreenshotHelperClient } from "./helper-client";
import { isNativeWindowsEnabled, resolveNativeWindowsExe } from "../windows/native-windows-host";

export type { ScreenshotService };

export interface ScreenshotLifecycleOptions {
  initialHotkey: string;
  /** 初始截图后端（缺省 builtin）。 */
  initialBackend?: ScreenshotBackendKind;
  /** Snipaste.exe 路径；空 = 自动检测。 */
  initialSnipastePath?: string;
  getReactChatWindow: () => BrowserWindow | null;
  capturePetWindow: () => Promise<Electron.NativeImage | null>;
  /** 传入共享 scope 以便退出时统一注销；缺省时使用独立 scope。 */
  ipc?: IpcScope;
}

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

function getScreenshotDirectory(): string {
  return path.join(app.getPath("userData"), "screenshots");
}

/**
 * 确保 helper 的输出目录存在。
 * WIC InitializeFromFilename 不会创建父目录：目录缺失时打开 `<uuid>.png.tmp`
 * 直接报 0x80070003（ERROR_PATH_NOT_FOUND）。mkdir recursive 幂等，重复调用无害。
 */
async function ensureScreenshotDirectory(directory: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { recursive: true });
  } catch (error) {
    console.error("[Screenshot] 创建截图目录失败:", directory, error);
  }
}

async function saveScreenshotPasteTemp(
  base64: string,
  _mime: string,
): Promise<{ filePath: string }> {
  const raw = Buffer.from(base64, "base64");
  if (raw.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error("SCREENSHOT_TOO_LARGE");
  }
  const image = nativeImage.createFromBuffer(raw);
  if (image.isEmpty()) {
    throw new Error("INVALID_SCREENSHOT_IMAGE");
  }
  const screenshotDirectory = getScreenshotDirectory();
  await fs.promises.mkdir(screenshotDirectory, { recursive: true });
  const filePath = path.join(screenshotDirectory, `${randomUUID()}.png`);
  await fs.promises.writeFile(filePath, image.toPNG());
  return { filePath };
}

export function initializeScreenshotService(
  options: ScreenshotLifecycleOptions,
): ScreenshotService {
  const { getReactChatWindow, capturePetWindow } = options;
  const ipc = options.ipc ?? createIpcScope();
  const screenshotDirectory = getScreenshotDirectory();

  const validateInsert = (data: ScreenshotInsertData): ScreenshotInsertData => {
    let previewImage: Electron.NativeImage | null = null;
    const validated = validateScreenshotInsert(
      data,
      screenshotDirectory,
      (filePath) => {
        previewImage = nativeImage.createFromPath(filePath);
        return previewImage;
      },
    );
    if (!validated) {
      throw new Error(`INVALID_SCREENSHOT_RESULT:${data.filePath}`);
    }
    // React 开发预览运行在 http://，Chromium 会拦截 file:// 图片。
    // 截图体积有限，直接回传 data URL，旧 Chat 与 React 都能稳定显示。
    return {
      ...validated,
      previewUrl: previewImage ? (previewImage as Electron.NativeImage).toDataURL() : validated.previewUrl,
    };
  };

  const builtinClient = new ElectronScreenshotHelperClient({
    spawnImpl: (command, args) => {
      const child = spawn(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      trackChildProcess(child, "cyrene-screenshot");
      return child;
    },
    resolveHelperPath: () =>
      resolveScreenshotHelperPath({
        isPackaged: app.isPackaged,
        appPath: app.getAppPath(),
        resourcesPath: process.resourcesPath,
        envOverride: process.env.CYRENE_SCREENSHOT_HELPER_PATH,
      }),
    screenshotDirectory,
    logger: console,
  });

  // Snipaste 后端：探测（设置路径 > 环境变量 > PATH > 常见目录 > 注册表）+
  // 剪贴板差值判定；后端切换由 SwitchableScreenshotClient 承载。
  let snipastePath = options.initialSnipastePath ?? "";
  let cachedSnipasteExecutable: string | null = null;
  let snipasteDetectInFlight: Promise<string | null> | null = null;
  const resolveSnipasteExecutable = (): Promise<string | null> => {
    if (cachedSnipasteExecutable) return Promise.resolve(cachedSnipasteExecutable);
    if (!snipasteDetectInFlight) {
      snipasteDetectInFlight = detectSnipasteExecutable(snipastePath)
        .then((resolved) => {
          cachedSnipasteExecutable = resolved;
          return resolved;
        })
        .finally(() => {
          snipasteDetectInFlight = null;
        });
    }
    return snipasteDetectInFlight;
  };
  const snipasteClient = new SnipasteScreenshotClient({
    resolveExecutable: resolveSnipasteExecutable,
    screenshotDirectory,
    readClipboardPng: () => {
      const image = clipboard.readImage();
      return image.isEmpty() ? null : image.toPNG();
    },
    spawnImpl: (command, args) => {
      const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
      trackChildProcess(child, "snipaste");
      return child;
    },
    logger: console,
  });
  // .NET 主通道：cyrene-native --snipaste-capture；不可用时回退上面这套 TS 存档实现。
  const nativeSnipasteClient = new NativeSnipasteCaptureClient({
    resolveNativeExe: () => (isNativeWindowsEnabled() ? resolveNativeWindowsExe() : null),
    getSnipastePath: () => snipastePath,
    screenshotDirectory,
    logger: console,
  });
  const pickSnipasteClient = (): ScreenshotHelperClient =>
    isNativeWindowsEnabled() && resolveNativeWindowsExe() ? nativeSnipasteClient : snipasteClient;
  let activeSnipasteClient = pickSnipasteClient();
  const client = new SwitchableScreenshotClient(
    options.initialBackend === "snipaste" ? activeSnipasteClient : builtinClient,
  );

  // 启动即建目录 + 记录实际输出目录（排查 0x80070003 类路径问题）。
  void ensureScreenshotDirectory(screenshotDirectory);
  console.log("[Screenshot] helper output-dir =", screenshotDirectory);

  const service = createScreenshotService({
    client,
    registerShortcut: (accelerator, callback) =>
      globalShortcut.register(accelerator, callback),
    unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
    sendInsert: (data) => {
      const validated = validateInsert(data);
      const reactChatWindow = getReactChatWindow();
      if (reactChatWindow && !reactChatWindow.isDestroyed()) {
        reactChatWindow.webContents.send(IPC.SCREENSHOT_INSERT, validated);
      }
    },
  });

  ipc.handle(IPC.SCREENSHOT_START, async (event) => {
    // 请求前兜底重建目录：清理软件可能删掉 AppData 下的子目录，
    // helper 的 WIC 编码不会自建父目录（0x80070003）。
    await ensureScreenshotDirectory(screenshotDirectory);
    return service.startFromChatButton((data) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.SCREENSHOT_INSERT, validateInsert(data));
      }
    });
  });
  ipc.handle(IPC.SCREENSHOT_SAVE_TEMP, (_event, base64: string, mime: string) =>
    saveScreenshotPasteTemp(base64, mime),
  );
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_START, () => {
    service.suspendHotkey();
    return true;
  });
  ipc.handle(IPC.SCREENSHOT_HOTKEY_CAPTURE_END, () => {
    service.resumeHotkey();
    return true;
  });

  ipc.handle("debug:screenshot", async () => {
    const image = await capturePetWindow();
    if (!image) return null;
    const png = image.toPNG();
    const outPath = path.join(app.getPath("temp"), "cyrene-screenshot.png");
    fs.writeFileSync(outPath, png);
    return outPath;
  });

  service.init(options.initialHotkey);
  return {
    ...service,
    applyBackend(backend: ScreenshotBackendKind, nextSnipastePath: string) {
      snipastePath = nextSnipastePath ?? "";
      cachedSnipasteExecutable = null;
      snipasteDetectInFlight = null;
      activeSnipasteClient = pickSnipasteClient();
      client.setActive(backend === "snipaste" ? activeSnipasteClient : builtinClient);
      console.log(
        "[Screenshot] backend =",
        backend,
        backend === "snipaste"
          ? `${activeSnipasteClient === nativeSnipasteClient ? "native" : "ts"}${snipastePath ? ` path=${snipastePath}` : " (auto-detect)"}`
          : "",
      );
      return { ok: true };
    },
  };
}
