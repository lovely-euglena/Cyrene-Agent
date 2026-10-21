// 渲染管线端到端回归（#192）：真渲染 StreamdownMessageContent（不 mock streamdown），
// 断言 sanitize 扩展与 RemoteImageGuard 拦截的协同行为：
//   - http(s) 远程图：不产 <img> 标签（零外呼），渲染占位卡
//   - local-sticker://（白名单映射协议）：进占位卡以外的正常渲染路径（src 保留）
//   - file:///：sanitize 层剥离（默认 fileImageAllowed=false → 占位卡）
//   - javascript: href 仍被默认白名单剥掉（sanitize 收紧不得放松既有安全）
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@ant-design/x", () => ({
  Bubble: { List: () => null },
  CodeHighlighter: () => null,
  Think: () => null,
  ThoughtChain: () => null,
}));
vi.mock("../../../../../shared/renderer-base", () => ({ resolveAsset: (path: string) => path }));
vi.mock("./StreamdownMessageContent.css", () => ({}));
vi.mock("./RemoteImageGuard.css", () => ({}));
vi.mock("./file-icon-assets", () => ({
  FILE_ICON_URLS: { default: "default-url" },
  FILE_NAME_MAP: {},
  FILE_EXT_MAP: {},
}));
vi.mock("./MermaidBlock", () => ({ MermaidBlock: () => null }));
vi.mock("./SvgCardBlock", () => ({ SvgCardBlock: () => null }));
vi.mock("../pages/chat-page-bridge", () => ({ chatStore: {} }));

let dom: JSDOM;
let host: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  const scope = globalThis as typeof globalThis & {
    document?: Document;
    window?: Window & typeof globalThis;
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  scope.document = dom.window.document;
  scope.window = dom.window as unknown as Window & typeof globalThis;
  Object.defineProperty(scope, "navigator", {
    value: dom.window.navigator,
    configurable: true,
    writable: true,
  });
  scope.IS_REACT_ACT_ENVIRONMENT = true;
  host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
});

afterEach(() => {
  root?.unmount();
  root = null;
});

async function renderContent(content: string): Promise<string> {
  const { StreamdownMessageContent } = await import("./StreamdownMessageContent");
  root = createRoot(host);
  root.render(createElement(StreamdownMessageContent, { content, streaming: false }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  return host.innerHTML;
}

describe("StreamdownMessageContent 远程图片拦截", () => {
  it("http(s) 远程图渲染占位卡，不产生 <img>（零外呼）", async () => {
    const html = await renderContent("![x](https://evil.example.com/pixel.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain("evil.example.com");
    expect(html).toContain("cy-remote-image-guard");
  });

  it("白名单映射协议 src 经 sanitize 放行后进入守卫（local 分支渲染 img）", async () => {
    const html = await renderContent("![s](local-sticker://pack1/sticker.png)");
    // 走 judgeRemoteImage 的 local 分支 → 渲染 img（jsdom 不真正发起网络请求）
    expect(html).toContain("<img");
    expect(html).toContain("local-sticker://pack1/sticker.png");
  });

  it("file:// 默认被 sanitize 剥离（不渲染 img、路径不进 DOM）", async () => {
    const html = await renderContent("![f](file:///C:/Users/secret.png)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("C:/Users/secret.png");
  });

  it("javascript: href 仍被剥（扩展 src 协议不放松既有安全）", async () => {
    const html = await renderContent("[click](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("普通 http(s) 链接渲染为锚点（href 不受 src 协议扩展影响）", async () => {
    const html = await renderContent("[site](https://example.com/page)");
    expect(html).toContain('href="https://example.com/page"');
  });
});
