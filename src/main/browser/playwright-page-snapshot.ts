import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runInNewContext } from "node:vm";
import type { WebContents } from "electron";

const PLAYWRIGHT_WORLD_ID = 9876;
const PLAYWRIGHT_GLOBAL = "__cyrenePlaywrightInjected";
const GENERATED_SOURCE_ASSIGNMENT = /\bsource\d+\s*=\s*/g;

export interface RuntimePageElement {
  ref: string;
  description: string;
  tag: string;
  href?: string;
  context?: string;
  bounds: [number, number, number, number];
  inViewport: boolean;
  disabled: boolean;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
}

export interface RuntimeSnapshot {
  ariaSnapshot: string;
  elements: RuntimePageElement[];
  totalReferences: number;
  note: string;
}

let injectedSourceCache: string | undefined;
const initializedContents = new WeakSet<WebContents>();

function readStringLiteralEnd(source: string, start: number): number {
  const quote = source[start];
  if (quote !== "'" && quote !== '"') {
    throw new Error("Playwright generated source is not a string literal");
  }
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return index + 1;
  }
  throw new Error("Playwright generated source string is unterminated");
}

/**
 * Playwright does not publicly export its injected selector runtime. Read the generated
 * runtime from the exact installed playwright-core package and verify its expected API.
 */
function getPlaywrightInjectedSource(): string {
  if (injectedSourceCache) return injectedSourceCache;

  const packageJsonPath = require.resolve("playwright-core/package.json");
  const bundlePath = join(dirname(packageJsonPath), "lib", "coreBundle.js");
  const bundle = readFileSync(bundlePath, "utf8");
  GENERATED_SOURCE_ASSIGNMENT.lastIndex = 0;
  let assignment: RegExpExecArray | null;
  while ((assignment = GENERATED_SOURCE_ASSIGNMENT.exec(bundle))) {
    const start = assignment.index + assignment[0].length;
    const quote = bundle[start];
    // coreBundle.js also has ordinary assignments such as `source = this.value`.
    // Only generated source payloads are string literals.
    if (quote !== "'" && quote !== '"') continue;
    const end = readStringLiteralEnd(bundle, start);
    const literal = bundle.slice(start, end);
    // The injected selector runtime is hundreds of KB; skip smaller unrelated source literals.
    if (literal.length < 100_000) continue;
    let decoded: unknown;
    try {
      decoded = runInNewContext(literal, Object.create(null), { timeout: 1_000 });
    } catch {
      continue;
    }
    if (typeof decoded !== "string") continue;
    if (
      decoded.includes("module.exports = __toCommonJS(injectedScript_exports)") &&
      decoded.includes("ariaSnapshot(node, options)")
    ) {
      injectedSourceCache = decoded;
      return decoded;
    }
  }
  throw new Error("Unable to find the Playwright injected selector runtime in playwright-core");
}

function buildInitializationScript(): string {
  const source = getPlaywrightInjectedSource();
  const options = JSON.stringify({
    browserName: "chromium",
    customEngines: [],
    isUnderTest: false,
    sdkLanguage: "javascript",
    stableRafCount: 1,
    testIdAttributeName: "data-testid",
  });
  return `(() => {
    try {
      const runtimeExports = (() => {
        const module = {};
        ${source}
        return module.exports;
      })();
      if (typeof runtimeExports?.InjectedScript !== "function") {
        throw new Error("Playwright InjectedScript export is unavailable");
      }
      // This generated bundle exports a factory that returns the class.
      const InjectedScript = runtimeExports.InjectedScript();
      if (typeof InjectedScript !== "function") {
        throw new Error("Playwright InjectedScript factory returned no constructor");
      }
      globalThis.${PLAYWRIGHT_GLOBAL} = new InjectedScript(globalThis, ${options});
      return true;
    } catch (error) {
      return {
        __cyrenePlaywrightError: {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          stack: String(error?.stack || ""),
        },
      };
    }
  })()`;
}

const SNAPSHOT_SCRIPT = `(() => {
  try {
  const injected = globalThis.${PLAYWRIGHT_GLOBAL};
  const root = document.body || document.documentElement;
  if (!injected || !root) throw new Error("Playwright snapshot runtime is unavailable");

  const snapshot = injected.ariaSnapshot(root, { mode: "ai" });
  const refs = new Map();
  const elements = [];
  const lines = String(snapshot || "").split("\\n");
  const seen = new Set();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  for (const line of lines) {
    const match = line.match(/\\[ref=([^\\]]+)\\]/);
    if (!match || seen.has(match[1])) continue;
    const ref = match[1];
    seen.add(ref);
    let element;
    try {
      const selector = injected.parseSelector("aria-ref=" + ref);
      element = injected.querySelectorAll(selector, root)[0];
    } catch {
      continue;
    }
    if (!element) continue;

    refs.set(ref, element);
    const rect = element.getBoundingClientRect();
    const tag = element.localName || "";
    const href = element instanceof HTMLAnchorElement ? element.href : "";
    const contextContainer = element.closest("tr,[role='row'],li,[role='listitem'],article,[role='article'],[role='dialog']");
    const contextText = contextContainer && contextContainer !== element
      ? String(contextContainer.innerText || "").replace(/\\s+/g, " ").trim()
      : "";
    const attributes = {};
    for (const name of ["aria-label", "aria-labelledby", "title", "alt", "placeholder", "type", "name", "href", "data-testid"]) {
      const value = element.getAttribute?.(name);
      if (value) attributes[name] = String(value);
    }

    elements.push({
      ref,
      description: line.trim().replace(/^[-*]\\s*/, "").replace(/\\s*\\[ref=[^\\]]+\\]/, ""),
      tag,
      ...(href && /^https?:/i.test(href) ? { href } : {}),
      ...(contextText ? { context: contextText } : {}),
      bounds: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
      inViewport: rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0,
      disabled: Boolean(element.disabled || element.getAttribute?.("aria-disabled") === "true"),
      ...(element.id ? { id: String(element.id) } : {}),
      classes: Array.from(element.classList || []).map((name) => String(name)),
      attributes,
    });
  }

  elements.sort((left, right) => Number(Boolean(right.inViewport)) - Number(Boolean(left.inViewport)));
  globalThis.__cyreneBrowserRefs = refs;
  return {
    ariaSnapshot: String(snapshot || ""),
    elements,
    totalReferences: elements.length,
    note: "ariaSnapshot 是 Playwright 原始语义树；ref 与树中的编号对应。elements 保存位置、属性和 CSS class 等补充信息。",
  };
  } catch (error) {
    return {
      __cyrenePlaywrightError: {
        name: String(error?.name || "Error"),
        message: String(error?.message || error),
        stack: String(error?.stack || ""),
      },
    };
  }
})()`;

function wrapRuntimeScript(script: string): string {
  return `(() => {
    try {
      const run = new Function("return (" + ${JSON.stringify(script)} + ");");
      return run();
    } catch (error) {
      return {
        __cyrenePlaywrightError: {
          name: String(error?.name || "Error"),
          message: String(error?.message || error),
          stack: String(error?.stack || ""),
        },
      };
    }
  })()`;
}

function throwIfRuntimeError(stage: string, result: unknown): void {
  if (!result || typeof result !== "object") return;
  const runtimeError = (result as {
    __cyrenePlaywrightError?: { name?: string; message?: string; stack?: string };
  }).__cyrenePlaywrightError;
  if (!runtimeError) return;
  const detail = [runtimeError.name, runtimeError.message].filter(Boolean).join(": ");
  const stack = runtimeError.stack ? `\n${runtimeError.stack}` : "";
  throw new Error(`Playwright ${stage} 脚本异常：${detail}${stack}`);
}

export function resetPlaywrightPageSnapshot(contents: WebContents): void {
  initializedContents.delete(contents);
}

export async function capturePlaywrightPageSnapshot(contents: WebContents): Promise<RuntimeSnapshot> {
  if (!initializedContents.has(contents)) {
    const initialization = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
      { code: wrapRuntimeScript(buildInitializationScript()) },
    ]);
    throwIfRuntimeError("初始化", initialization);
    initializedContents.add(contents);
  }
  const snapshot = await contents.executeJavaScriptInIsolatedWorld(PLAYWRIGHT_WORLD_ID, [
    { code: wrapRuntimeScript(SNAPSHOT_SCRIPT) },
  ]);
  throwIfRuntimeError("页面快照", snapshot);
  const result = snapshot as Partial<RuntimeSnapshot> | null;
  if (!result || typeof result.ariaSnapshot !== "string" || !Array.isArray(result.elements)
    || typeof result.totalReferences !== "number") {
    throw new Error("Playwright 页面快照脚本没有返回有效快照");
  }
  return result as RuntimeSnapshot;
}
