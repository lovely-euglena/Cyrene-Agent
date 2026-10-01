// OCR 侧车（CyreneOcr.exe）路径解析：环境变量覆盖 → 打包态 → 开发态。
//
// 与 native-windows/embed/voice 侧车的定位策略保持一致。

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

let cached: string | null | undefined;

/** 打包态资源目录名（electron-builder extraResources → resources/ocr）。 */
const PACKAGED_DIR = "ocr";
const EXE_NAME = "CyreneOcr.exe";
const DEV_TFM = "net10.0-windows10.0.19041.0";

/**
 * 解析本地 OCR 侧车 exe；未就位返回 null（调用方按「引擎不可用」处理）。
 *
 * 探测顺序：
 *   1. 环境变量 CYRENE_OCR_EXE（排障/自定义构建）
 *   2. 打包态：<resources>/ocr/CyreneOcr.exe
 *   3. 开发态：dotnet/ocr-sidecar/bin/{Debug,Release}/<tfm>/CyreneOcr.exe
 */
export function resolveOcrSidecarPath(): string | null {
  if (cached !== undefined) return cached;
  try {
    const envPath = process.env.CYRENE_OCR_EXE?.trim();
    if (envPath && fs.existsSync(envPath)) {
      cached = envPath;
      return envPath;
    }

    if (app.isPackaged) {
      const packaged = path.join(process.resourcesPath, PACKAGED_DIR, EXE_NAME);
      if (fs.existsSync(packaged)) {
        cached = packaged;
        return packaged;
      }
    } else {
      for (const cfg of ["Debug", "Release"]) {
        const dev = path.join(
          app.getAppPath(), "dotnet", "ocr-sidecar", "bin", cfg, DEV_TFM, EXE_NAME,
        );
        if (fs.existsSync(dev)) {
          cached = dev;
          return dev;
        }
      }
    }
  } catch {
    /* 非 Electron 环境（单测）：探测失败按不可用处理 */
  }
  cached = null;
  return null;
}

/** 清空路径缓存（测试隔离用）。 */
export function resetOcrSidecarPathCache(): void {
  cached = undefined;
}
