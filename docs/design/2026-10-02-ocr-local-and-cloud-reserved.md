# 本地 OCR 接入与云端预留接口（2026-10-02）

## 背景

此前项目没有 OCR 能力：图片理解走 `read_image` → 视觉模型（VLM，联网、依赖用户配置）。
本次接入**本地 OCR**（离线、免费、毫秒级），并在设置页与代码层为后续**云服务商 OCR**
预留接口（本次不实现）。

## 架构

```
工具 ocr_image（src/main/orchestrator/tools/builtin-tools/ocr-image-tool.ts）
  └─ runOcr()（src/main/ocr/ocr-registry.ts）
       ├─ 读 GeneralSettings：ocrEnabled / ocrProvider / ocrLanguage
       ├─ provider 抽象（src/main/ocr/ocr-provider.ts）
       │    ├─ local：LocalOcrProvider → spawn CyreneOcr.exe（一次性 JSON 协议）
       │    └─ cloud：CloudOcrProvider（占位：isAvailable=false，recognize 抛 OCR_CLOUD_NOT_IMPLEMENTED）
       └─ 返回 OcrResult { text, lines(词级坐标), language, provider, durationMs }
```

### 本地引擎：`dotnet/ocr-sidecar`（CyreneOcr.exe）

- 基于 **Windows.Media.Ocr**（系统内置，无模型文件、无网络依赖；识别语言取决于系统已装的
  OCR 语言包）。
- 一次性进程，stdout 单行 JSON：
  - `--ocr --image <path> [--lang <tag>] [--positions]`
  - `--list-languages`（设置页语言列表）
- 透明 PNG 会先合成到白底（否则透明区被引擎视为黑色，深色文字不可读）；像素访问绕过
  CsWinRT 投影，用 `IWinRTObject.NativeObject.ThisPtr` + 手工 QI `IMemoryBufferByteAccess`。
- 打包：`resources/ocr/CyreneOcr.exe`（TFM `net10.0-windows10.0.19041.0`，framework-dependent）。

### 设置页（Electron 设置 → OCR 设置）

- 启用开关、服务商下拉（`本地` 可选；`云端服务商` 禁用占位）、本地语言选择、
  本地引擎就绪状态（语言枚举）。
- 云端 Base URL / API Key / 模型字段以**禁用态**展示，作为后续接入的配置入口。
- 只读状态走 `settings:ocr-get-status`；写入走通用 `settings:save-general`
  （GeneralSettings 的 `ocr*` 字段）。

## 后续接入云端 OCR 的步骤

1. 实现 `CloudOcrProvider.recognize()`（HTTP 调用 + 鉴权 + 错误码映射），
   `isAvailable()` 依据 `ocrCloudBaseUrl / ocrCloudApiKey` 判定。
2. 如引入多家厂商：扩展 `OcrProviderId` 白名单（`src/shared/ocr.ts`）与
   `ocr-registry.ts` 注册；设置页下拉放开对应选项、启用云端字段。
3. `ocrProvider` 设置归一化白名单（`settings-facade.ts`）同步扩展。
4. 工具与 UI 主流程无需改动。

## 已知边界

- 仅 Windows：依赖 Windows.Media.Ocr；非 Windows/缺少语言包时工具返回
  `OCR_ENGINE_UNAVAILABLE` 或 `OCR_LANG_UNAVAILABLE`。
- 旋转/艺术字/竖排文本识别一般；需要版面理解（表格、公式）时仍应走 `read_image`。
- 云端未接入前 `ocrProvider=cloud` 会如实报错（`OCR_CLOUD_NOT_IMPLEMENTED`）。