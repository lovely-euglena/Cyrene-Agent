/**
 * Electron 主进程入口 —— 应用组合根（Composition Root）。
 *
 * 此文件只表达应用生命周期：创建 Application、绑定 Electron 生命周期、
 * 在 ready 前完成同步预配置，并在主进程就绪后按
 * shell → core → background 阶段启动。全部业务子系统的装配位于
 * application/default-dependencies.ts；启动编排位于 application/application.ts。
 */

import { app } from "electron";
import { createApplication } from "./application/application";
import { createDefaultApplicationDependencies } from "./application/default-dependencies";
import { registerPluginPanelScheme } from "./plugin-panel-protocol";
import { installGlobalNavigationGuard } from "./windows/external-link";

// 打包版双击启动时 stdout/stderr 管道可能不存在或中途关闭，
// 此时任何 console.log 写入都会抛异步 EPIPE 并升级成 uncaughtException 弹错误框
// （如 mcp-adapter connectMcpServer 的连接日志）。在入口最顶部挂 error 监听器
// 静默兜底：日志丢弃无害，业务不受影响。
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") return;
    throw err;
  });
}

// 插件设置面板协议：scheme 特权必须在 app.ready 之前注册（Electron 硬性要求）
registerPluginPanelScheme();

// 便携模式（阶段 9 L1/L8）：CYRENE_PORTABLE=1 → userData 重定向到 exe
// 同级 ./data，且不可写直接致命退出（不静默回退 %APPDATA%——铁律 B10：
// 不写注册表/系统目录，卸载=删目录）。必须发生在任何 userData 消费前。
{
  const { resolveDotnetConfig } = require("./dotnet-backend/config") as
    typeof import("./dotnet-backend/config");
  const { app: electronApp } = require("electron") as typeof import("electron");
  if (resolveDotnetConfig().portable) {
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const dataDir = path.join(path.dirname(electronApp.getPath("exe")), "data");
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.accessSync(dataDir, fs.constants.W_OK);
    } catch (error) {
      console.error(`[Portable] 数据目录不可写: ${dataDir}`, error);
      electronApp.exit(1);
    }
    electronApp.setPath("userData", dataDir);
    console.log(`[Portable] userData -> ${dataDir}`);
  }
}

// 全局导航兜底（上游 2026-09-24 合并）：阻止任何窗口的页面内导航
// （含拖放文件跳转 file://），http(s) 外链转交系统浏览器。
// 必须在任何窗口创建之前注册。
installGlobalNavigationGuard();

const application = createApplication(createDefaultApplicationDependencies());

application.installLifecycleHandlers();
application.prepareBeforeReady();

if (application.isPrimaryProcess()) {
  void app.whenReady()
    .then(() => application.start())
    .catch((error) => application.handleFatalStartup(error));
}
