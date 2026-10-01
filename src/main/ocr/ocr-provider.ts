// OCR 服务商抽象 —— 为云端接入预留的统一接口。
//
// 新增服务商：实现本接口 → 在 ocr-registry.ts 注册 → 在 shared/ocr.ts 的
// OcrProviderId 白名单与设置页下拉里补充选项。工具与设置主流程无需改动。

import type { OcrLanguageInfo, OcrProviderId } from "../../shared/ocr";
import type { OcrRequest, OcrResult } from "./types";

export interface OcrProvider {
  readonly id: OcrProviderId;
  /** 当前实现是否可用（本地：侧车 exe 就位；云：端点/密钥配置完整）。 */
  isAvailable(): boolean;
  /** 可识别的语言列表；实现不限定语言时返回空数组。 */
  listLanguages(): Promise<OcrLanguageInfo[]>;
  /** 执行识别；失败抛 OcrError（稳定错误码）。 */
  recognize(request: OcrRequest): Promise<OcrResult>;
}
