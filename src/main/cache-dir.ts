/**
 * 缓存目录统一解析（数据/缓存分离）。
 *
 * 铁律：凡"可丢弃可重建"的运行产物（模型下载、TTS 音频、渠道媒体、
 * 插件市场包、字体缓存）一律落本模块解析的目录；会话/设置/记忆/贴纸等
 * 用户数据仍走 userData。便携模式下缓存默认挂程序目录旁 cache/（随程序
 * 搬移、可整体删除重建），不占数据目录；用户可用设置项改到任意盘。
 *
 * 解析优先级：settings.cacheDirOverride（绝对路径）> 便携模式 <installRoot>/cache
 * > Electron 系统缓存目录（Windows: %LOCALAPPDATA%/cyrene-native/Cache）。
 */

import { app } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadGeneralSettings } from "./settings/settings-facade";
import { getPortableDataLocationStatus } from "./portable/portable-runtime";

let overrideCacheRoot: string | null | undefined;

/** 启动后热切换（settings 变更处理器调用）；undefined = 尚未读取。 */
export function setCacheDirOverride(dir: string | null): void {
  overrideCacheRoot = dir && dir.trim() ? path.resolve(dir.trim()) : null;
}

/** 当前生效的缓存根目录（不创建目录；写入方用 resolveCacheSubdir 落子目录）。 */
export function resolveCacheDir(): string {
  if (overrideCacheRoot === undefined) {
    const saved = (loadGeneralSettings() as { cacheDirOverride?: string }).cacheDirOverride;
    setCacheDirOverride(saved ?? null);
  }
  if (overrideCacheRoot) return overrideCacheRoot;
  try {
    const status = getPortableDataLocationStatus();
    if (status.enabled) return path.join(status.installRoot, "cache");
  } catch {
    // 便携状态不可用时退系统默认（启动极早期/测试环境）
  }
  // Electron 43 无 getPath("cache")（44 才引入）：按 Windows 标准布局反拼
  // %LOCALAPPDATA%/<appName>/Cache，与 Electron 44 语义/位置一致。
  // 加固：测试/极早期环境里 electron mock 可能没有 app（属性访问即抛），
  // 此时退回系统临时目录下的确定性路径，绝不 throw（否则 import 链上的
  // 模块级调用会把整个测试文件拖崩）。
  try {
    const appData = app.getPath("appData");
    const appName = typeof app.getName === "function" ? app.getName() : "cyrene-native";
    return path.join(appData, "..", "Local", appName, "Cache");
  } catch {
    return path.join(os.tmpdir(), "cyrene-cache");
  }
}

/** 缓存根下的命名子目录（确保存在）。 */
export function resolveCacheSubdir(name: string): string {
  const dir = path.join(resolveCacheDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * HuggingFace 模型缓存根（Xenova/bge-m3 等，数 GB 大头）。
 * 下载器（embedding-manager）、状态检测（model-status）、运行时加载
 * （embedding-pipeline 的 cache_dir）共用本根，保证"下载到哪、就从哪加载"。
 * 目录布局保持 huggingface-cli 兼容：<root>/Xenova/<model>/。
 */
export function hfModelCacheDir(): string {
  // override 模式下直接用 override 根下的 huggingface/，与系统默认布局对齐
  const dir = path.join(resolveCacheDir(), "huggingface");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
