// browser-search-engine —— 地址栏搜索回退的引擎选择（issue #142 追加：设置项化，2026-10-28 TA 指令）。
//
// 默认 bing（国内可达性最好）；引擎列表可扩展，模板用 {q} 占位。

export const BROWSER_SEARCH_ENGINES = ["bing", "google", "baidu", "duckduckgo"] as const;

export type BrowserSearchEngine = (typeof BROWSER_SEARCH_ENGINES)[number];

export const DEFAULT_BROWSER_SEARCH_ENGINE: BrowserSearchEngine = "bing";

/** 引擎 → 搜索结果页 URL（q 已 encodeURIComponent）。未知引擎回退默认。 */
export function buildSearchUrl(engine: BrowserSearchEngine | undefined, query: string): string {
  const templates: Record<BrowserSearchEngine, string> = {
    bing: "https://www.bing.com/search?q=",
    google: "https://www.google.com/search?q=",
    baidu: "https://www.baidu.com/s?wd=",
    duckduckgo: "https://duckduckgo.com/?q=",
  };
  const key = engine && (BROWSER_SEARCH_ENGINES as readonly string[]).includes(engine) ? engine : DEFAULT_BROWSER_SEARCH_ENGINE;
  return `${templates[key]}${encodeURIComponent(query)}`;
}

/** settings normalize 用：非法值回退默认。 */
export function normalizeBrowserSearchEngine(value: unknown): BrowserSearchEngine {
  return typeof value === "string" && (BROWSER_SEARCH_ENGINES as readonly string[]).includes(value)
    ? value as BrowserSearchEngine
    : DEFAULT_BROWSER_SEARCH_ENGINE;
}
