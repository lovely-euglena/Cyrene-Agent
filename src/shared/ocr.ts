// OCR 前后端共享类型（主进程 + 设置渲染进程）。
//
// provider 抽象是为后续接入云服务商预留的：当前仅 local（Windows 内置 OCR）可用，
// cloud 为占位实现（设置页展示但不可选）。新增云厂商时扩展 OcrProviderId 白名单
// 与 src/main/ocr/ocr-registry.ts 的注册即可，无需改动工具与 UI 主流程。

/** OCR 服务商：off=关闭；local=本地（Windows.Media.Ocr）；cloud=云端（预留，未接入）。 */
export type OcrProviderId = "off" | "local" | "cloud";

/** 可选的识别语言（来自本地引擎的能力枚举）。 */
export interface OcrLanguageInfo {
  /** BCP-47 语言标签，如 zh-Hans-CN。 */
  tag: string;
  /** 展示名，如 简体中文(中国大陆)。 */
  name: string;
}

/** 设置页 OCR 面板状态。 */
export interface OcrStatus {
  /** 本地 OCR 侧车（CyreneOcr.exe）是否就位。 */
  localAvailable: boolean;
  /** 当前服务商（来自设置）。 */
  provider: OcrProviderId;
  /** 工具开关（来自设置）。 */
  enabled: boolean;
  /** 设置中选定的语言 tag；空字符串 = 自动。 */
  language: string;
  /** 本地引擎可识别的语言；本地不可用时为空数组。 */
  languages: OcrLanguageInfo[];
  /** 自动模式下实际会使用的语言（引擎解析结果），无法确定时为 null。 */
  defaultLanguage: string | null;
  /** 查询本地语言能力失败时的错误信息。 */
  error?: string;
}
