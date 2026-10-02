import { loadGeneralSettings } from "../../../settings/settings-facade";
import { loadModelSettings } from "../../../settings/model-settings";
import type { GeneralSettings } from "../../../settings/general-settings";
import { registerEmailTools } from "../email-tools";
import { registerDocumentTools } from "../document-tools";
// fs-tools / built-in-tools 仍依赖模块加载副作用，先集中在此，后续可继续显式化
import "../fs-tools";
import { registerLifeTools, setTranslateConfig } from "../life-tools";
import { registerMomentsTools } from "../moments-tools";
import { registerRecallHistoryTool } from "../history-tools";
import { registerWikiMemoryTools } from "../wiki-memory-tools";
import { registerSearchTextTool } from "../search-text-tools";
import { registerApplyPatchTool } from "../apply-patch-tools";
import { registerAstGrepTools } from "../ast-grep-tools";
import { toolRegistry } from "./tool-registry";
import { registerTravelTools } from "../travel-tools";
import { registerZCodeFileTools } from "../zcode-file-tools";
import type { GitService } from "../../../code-git/git-service";
import { registerCodeGitTools } from "../git-tools";
import type { LspManager } from "../../../lsp/manager";
import { registerLspTool } from "../lsp-tool";
import "../built-in-tools";
import { ocrImageTool } from "../builtin-tools/ocr-image-tool";

export function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
  // OCR：开关 + 服务商（off 关闭；local/cloud 开启，cloud 未接入时执行期如实报错）
  toolRegistry.setEnabled("ocr_image", settings.ocrEnabled !== false && settings.ocrProvider !== "off");
}

export function registerAllTools(deps: { codeGitService: GitService; lspManager: LspManager }): void {
  registerCodeGitTools(deps.codeGitService, toolRegistry);
  registerLspTool(deps.lspManager, toolRegistry);
  registerSearchTextTool();
  registerApplyPatchTool();
  registerAstGrepTools();
  registerRecallHistoryTool();
  registerWikiMemoryTools();
  registerDocumentTools();

  setTranslateConfig(() => {
    const s = loadModelSettings();
    return s.apiKey
      ? { provider: s.provider, baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey, explicitTransport: s.explicitTransport }
      : null;
  });
  registerLifeTools();
  registerZCodeFileTools({
    read: toolRegistry.getById("read_file")!,
    readImage: toolRegistry.getById("read_image")!,
    write: toolRegistry.getById("write_file")!,
    edit: toolRegistry.getById("str_replace")!,
    grep: toolRegistry.getById("search_text")!,
  });
  registerMomentsTools();

  registerTravelTools();
  registerEmailTools();

  // 本地 OCR：读图取字（服务商抽象见 src/main/ocr/，设置页可切换/预留云端）
  toolRegistry.register(ocrImageTool);

  syncBuiltInToolToggles(loadGeneralSettings());
}
