// 内置高危工具 — 给 agent 装上 fetch_url / run_shell / install_mcp_server 三件武器
// 全部走权限网关：fetch_url=network, run_shell=shell, install_mcp_server=fs-write
//
// 工具实现已按工具拆分到 builtin-tools/ 子目录（纯搬移，逻辑未改）。本文件保留为
// facade / composition root：re-export 公共 API，并按原 built-in-tools.ts 的注册顺序
// 显式 toolRegistry.register 各工具常量——顺序 = registry 插入顺序 = 工具目录 prompt
// 生成顺序，由源码顺序显式保证，不依赖 import 求值顺序。
// 门禁：built-in-tools.snapshot.test.ts（注册顺序 + 模型可见字段 + 拒绝路径协议）。

export { setUserTimezoneConfig, currentUserTimezone } from "./builtin-tools/timezone";
export { setWeatherConfig, type WeatherCardData } from "./builtin-tools/weather-tool";
export { setUtilityTimezoneConfig, setUtilityClipboardConfig } from "./builtin-tools/utility-tools";
export { setSearchConfig } from "./builtin-tools/web-search-tool";

import { toolRegistry } from "./registry/tool-registry";
import { logger, LogTag } from "../../logger";
import { createPlayLive2DActionTool } from "./builtin-tools/play-live2d-action";
import { weatherTool } from "./builtin-tools/weather-tool";
import { calculatorTool, nowTool, clipboardTool } from "./builtin-tools/utility-tools";
import { webSearchTool } from "./builtin-tools/web-search-tool";
import { fetchUrlTool } from "./builtin-tools/fetch-url-tool";
import { downloadFileTool } from "./builtin-tools/download-file-tool";
import { readImageUrlTool } from "./builtin-tools/read-image-url-tool";
import { installMcpServerTool } from "./builtin-tools/install-mcp-tool";
import { runVerificationTool } from "./builtin-tools/run-verification-tool";
import { runShellTool } from "./builtin-tools/run-shell-tool";
import { shellJobTool } from "./builtin-tools/shell-job-tool";
import { sshTools } from "../../ssh/ssh-tools";
import { storageTools } from "../../cloud-storage/storage-tools";
import { musicTools } from "../../music/music-tools";

let sendToLive2DWindow: (channel: string, payload?: unknown) => void = () => {};
export function setLive2dWindowSender(sender: typeof sendToLive2DWindow): void {
  sendToLive2DWindow = sender;
}

// ── 注册（顺序 = 原 built-in-tools.ts 的字面顺序，勿重排）─────────────
// 注：.NET 轨接线在各工具自己的 execute 内完成（calculator/now/clipboard 的
// nativeFirst、fs 三件的 nativeFirstFs）；原 native-tool-router 白名单是死代码，
// 2026-10-03 随 fs 接线清理删除。
toolRegistry.register(calculatorTool);
toolRegistry.register(nowTool);
toolRegistry.register(clipboardTool);
toolRegistry.register(fetchUrlTool);
toolRegistry.register(downloadFileTool);
toolRegistry.register(readImageUrlTool);
toolRegistry.register(runShellTool);
// run_shell 的后台配套工具：紧跟其后注册，工具目录里相邻展示
toolRegistry.register(shellJobTool);
// SSH 托管工具：会话在 cyrene-native --ssh-host，与本地 shell 相邻展示
for (const tool of sshTools) toolRegistry.register(tool);
// 云存储托管工具：连接在 cyrene-native --storage-host，紧随 SSH 展示
for (const tool of storageTools) toolRegistry.register(tool);
toolRegistry.register(runVerificationTool);
toolRegistry.register(installMcpServerTool);
logger.info(LogTag.BuiltinTools, "registered: fetch_url / download_file / run_shell / install_mcp_server");
toolRegistry.register(weatherTool);
toolRegistry.register(webSearchTool);
toolRegistry.register(createPlayLive2DActionTool({ sendToLive2DWindow }));
// 本地音乐工具：播放器在 cyrene-native（MusicService），权限档 musicAgentAccess
for (const tool of musicTools) toolRegistry.register(tool);
