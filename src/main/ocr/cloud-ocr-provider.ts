// 云端 OCR 服务商 —— 预留接口，当前未接入。
//
// 设置页会展示云服务商选项（禁用态）。后续接入时：
//   1. 在此实现 recognize()（HTTP 调用、鉴权、错误码映射）；
//   2. isAvailable() 依据 GeneralSettings.ocrCloudBaseUrl / ocrCloudApiKey 判定；
//   3. 在设置页启用对应选项，并按需扩展 OcrProviderId 白名单。

import type { OcrLanguageInfo, OcrProviderId } from "../../shared/ocr";
import type { OcrProvider } from "./ocr-provider";
import { OcrError, type OcrRequest, type OcrResult } from "./types";

export class CloudOcrProvider implements OcrProvider {
  readonly id: OcrProviderId = "cloud";

  isAvailable(): boolean {
    return false;
  }

  async listLanguages(): Promise<OcrLanguageInfo[]> {
    return [];
  }

  async recognize(_request: OcrRequest): Promise<OcrResult> {
    throw new OcrError("OCR_CLOUD_NOT_IMPLEMENTED", "云端 OCR 尚未接入，敬请期待");
  }
}
