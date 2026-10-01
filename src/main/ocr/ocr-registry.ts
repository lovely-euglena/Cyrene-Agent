// OCR 服务商注册表 + 基于设置的解析 + 设置页状态查询。
//
// 当前内置 local（Windows 内置 OCR，可用）与 cloud（预留，未接入）两个 provider。
// 新增云厂商时在此注册并扩展 OcrProviderId 白名单即可。

import type { OcrLanguageInfo, OcrProviderId, OcrStatus } from "../../shared/ocr";
import { loadGeneralSettings } from "../settings/settings-facade";
import { CloudOcrProvider } from "./cloud-ocr-provider";
import { LocalOcrProvider } from "./local-ocr-provider";
import type { OcrProvider } from "./ocr-provider";
import { OcrError, type OcrRequest, type OcrResult } from "./types";

const providers = new Map<OcrProviderId, OcrProvider>();
let bootstrapped = false;

/** 注册 provider（测试可调用以注入替身）。 */
export function registerOcrProvider(provider: OcrProvider): void {
  providers.set(provider.id, provider);
}

export function getOcrProvider(id: OcrProviderId): OcrProvider | undefined {
  ensureProviders();
  return providers.get(id);
}

function ensureProviders(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  registerOcrProvider(new LocalOcrProvider());
  registerOcrProvider(new CloudOcrProvider());
}

/** 仅测试用：清空并允许重新注册内置 provider。 */
export function resetOcrProvidersForTest(): void {
  providers.clear();
  bootstrapped = false;
}

/** 设置里的 provider → 实例；off 或未知返回 null。 */
export function resolveOcrProviderFromSettings(
  settings: { ocrProvider?: OcrProviderId } = loadGeneralSettings(),
): OcrProvider | null {
  ensureProviders();
  const id = settings.ocrProvider ?? "off";
  if (id === "off") return null;
  return providers.get(id) ?? null;
}

/**
 * 执行 OCR：按设置选择 provider，校验启用状态与可用性后识别。
 * 语言默认取设置中的 ocrLanguage（空 = 自动）。
 */
export async function runOcr(request: OcrRequest): Promise<OcrResult> {
  const settings = loadGeneralSettings();
  if (!settings.ocrEnabled) {
    throw new OcrError("OCR_DISABLED", "OCR 未在设置中启用");
  }
  const provider = resolveOcrProviderFromSettings(settings);
  if (!provider) {
    throw new OcrError("OCR_PROVIDER_UNAVAILABLE", "未配置 OCR 服务商，请在设置中开启");
  }
  if (!provider.isAvailable()) {
    throw new OcrError("OCR_ENGINE_UNAVAILABLE", providerUnavailableMessage(provider.id));
  }
  return provider.recognize({
    ...request,
    language: request.language?.trim() || settings.ocrLanguage || undefined,
  });
}

function providerUnavailableMessage(id: OcrProviderId): string {
  if (id === "local") return "本地 OCR 引擎未安装（缺少 CyreneOcr.exe）";
  if (id === "cloud") return "云端 OCR 尚未接入";
  return `OCR 服务商不可用: ${id}`;
}

/** 设置页 OCR 面板状态：本地可用性 + 语言列表 + 当前配置。 */
export async function getOcrStatus(): Promise<OcrStatus> {
  const settings = loadGeneralSettings();
  const local = getOcrProvider("local") as LocalOcrProvider | undefined;
  const localAvailable = local?.isAvailable() ?? false;

  let languages: OcrLanguageInfo[] = [];
  let defaultLanguage: string | null = null;
  let error: string | undefined;
  if (localAvailable && local) {
    try {
      const detailed = await local.listLanguagesDetailed();
      languages = detailed.languages;
      defaultLanguage = detailed.defaultLanguage;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    localAvailable,
    provider: settings.ocrProvider,
    enabled: settings.ocrEnabled,
    language: settings.ocrLanguage,
    languages,
    defaultLanguage,
    error,
  };
}
