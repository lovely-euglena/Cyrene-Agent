import { app, BrowserWindow, shell } from "electron";
import type { WebContents } from "electron";
import { isDev } from "../env";

const internalNavigationContents = new WeakSet<WebContents>();

/** Allow an explicitly managed embedded browser to handle HTTP(S) navigation itself. */
export function allowInternalNavigation(contents: WebContents): void {
  internalNavigationContents.add(contents);
}

/**
 * 处理外部 URL：非 http(s) 拒绝，开发环境 localhost:5173 也拒绝（避免调试时误开）。
 * 返回 true 表示已拦截并转交给系统浏览器。
 */
export function openExternalUrl(url: string): boolean {
  if (!url.startsWith("http://") && !url.startsWith("https://")) return false;
  if (isDev && url.startsWith("http://localhost:5173")) return false;
  void shell.openExternal(url);
  return true;
}

/**
 * 为 BrowserWindow 挂载外链拦截：
 *  - setWindowOpenHandler：拦截新窗口/外部链接
 *  - will-navigate：拦截页面内导航
 */
export function attachExternalLinkHandler(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    return openExternalUrl(url) ? { action: "deny" } : { action: "allow" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (openExternalUrl(url)) {
      event.preventDefault();
    }
  });
}

/**
 * 全局导航兜底（云端线上游 09-24 引入）：任何窗口（含未来新增）的页面内
 * 导航一律阻止，http(s) 外链转交系统浏览器。覆盖拖文件误跳 file:// 等场景。
 * 应用入口调用一次即可，与 attachExternalLinkHandler 并存：
 *  - attach：窗口创建时局部拦截（create-aux-windows 使用）
 *  - installGlobal：入口全局兜底（index.ts 使用），避免新窗口漏挂
 * 安全边界：
 *  - loadURL/loadFile 等程序化加载不触发 will-navigate，正常加载不受影响；
 *  - will-navigate 只针对主 frame，插件面板 sandbox iframe 不受影响。
 */
export function installGlobalNavigationGuard(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openExternalUrl(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (internalNavigationContents.has(contents)) return;
      event.preventDefault();
      openExternalUrl(url);
    });
  });
}
