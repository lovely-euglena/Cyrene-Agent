// OCR 设置面板：服务商选择（本地可用 / 云端预留）、语言、本地引擎状态。
//
// 写入走通用 settings:save-general（GeneralSettings 的 ocr* 字段）；只读状态
// （本地引擎可用性 + 语言列表）走 settings:ocr-get-status。

import type { OcrLanguageInfo, OcrStatus } from "../../../shared/ocr";
import { t } from "../i18n";
import {
  ocrCloudApiKeyInput,
  ocrCloudBaseUrlInput,
  ocrCloudModelInput,
  ocrEnabledInput,
  ocrEngineStatus,
  ocrLanguageSelect,
  ocrLocalSection,
  ocrProviderSelect,
} from "./dom";

function renderLanguages(languages: OcrLanguageInfo[], selected: string): void {
  if (!ocrLanguageSelect) return;
  ocrLanguageSelect.innerHTML = "";
  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = t("panel.ocr.languageAuto");
  ocrLanguageSelect.appendChild(auto);

  for (const lang of languages) {
    const option = document.createElement("option");
    option.value = lang.tag;
    option.textContent = `${lang.name}（${lang.tag}）`;
    ocrLanguageSelect.appendChild(option);
  }

  // 已选语言不在引擎列表里（换机器/未装语言包）时补一个占位项，避免被静默清空
  if (selected && !languages.some((lang) => lang.tag === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = selected;
    ocrLanguageSelect.appendChild(option);
  }
  ocrLanguageSelect.value = selected;
}

function renderStatus(status: OcrStatus | undefined): void {
  if (!ocrEngineStatus) return;
  if (!status) {
    ocrEngineStatus.textContent = "";
    return;
  }
  if (status.localAvailable) {
    const count = status.languages.length;
    const def = status.defaultLanguage ? `，默认 ${status.defaultLanguage}` : "";
    ocrEngineStatus.textContent = t("panel.ocr.engineReady", { count, default: def });
  } else if (status.error) {
    ocrEngineStatus.textContent = t("panel.ocr.engineError", { error: status.error });
  } else {
    ocrEngineStatus.textContent = t("panel.ocr.engineMissing");
  }
}

function renderVisibility(): void {
  const provider = ocrProviderSelect?.value ?? "local";
  const enabled = ocrEnabledInput?.checked ?? true;
  ocrLocalSection?.classList.toggle("is-hidden", provider === "cloud");
  if (ocrLanguageSelect) ocrLanguageSelect.disabled = !enabled;
  if (ocrProviderSelect) ocrProviderSelect.disabled = false;
  if (ocrEnabledInput) ocrEnabledInput.disabled = false;
}

async function saveOcrField(fields: Record<string, unknown>): Promise<void> {
  try {
    await window.settings?.saveGeneral?.(fields);
  } catch (err) {
    console.warn("[ocr] 保存 OCR 配置失败:", err);
  }
}

export async function loadOcrConfig(): Promise<void> {
  try {
    const [general, status] = await Promise.all([
      window.settings?.getGeneral?.(),
      window.settings?.getOcrStatus?.(),
    ]);
    const g = (general ?? {}) as Record<string, unknown>;
    const language = String(g.ocrLanguage ?? "");

    if (ocrEnabledInput) ocrEnabledInput.checked = g.ocrEnabled !== false;
    if (ocrProviderSelect) ocrProviderSelect.value = String(g.ocrProvider ?? "local");
    if (ocrCloudBaseUrlInput) ocrCloudBaseUrlInput.value = String(g.ocrCloudBaseUrl ?? "");
    if (ocrCloudApiKeyInput) ocrCloudApiKeyInput.value = String(g.ocrCloudApiKey ?? "");
    if (ocrCloudModelInput) ocrCloudModelInput.value = String(g.ocrCloudModel ?? "");

    renderLanguages(status?.languages ?? [], language);
    renderStatus(status);
    renderVisibility();
  } catch (err) {
    console.warn("[ocr] 加载 OCR 配置失败:", err);
    renderStatus(undefined);
  }
}

ocrEnabledInput?.addEventListener("change", () => {
  renderVisibility();
  void saveOcrField({ ocrEnabled: ocrEnabledInput.checked });
});

ocrProviderSelect?.addEventListener("change", () => {
  renderVisibility();
  void saveOcrField({ ocrProvider: ocrProviderSelect.value });
});

ocrLanguageSelect?.addEventListener("change", () => {
  void saveOcrField({ ocrLanguage: ocrLanguageSelect.value });
});
