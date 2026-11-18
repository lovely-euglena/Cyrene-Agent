/**
 * 外部资源安全设置（issue #192）
 *
 * 三层同意模型的持久化部分：默认拦截 → 临时同意（内存/会话，不落盘）→ 持久白名单（本文件）。
 * 主进程（settings-facade normalize / 持久化）与渲染端（拦截判定 / 设置窗）共用本定义。
 */

export interface SecuritySettings {
  /** 拦截聊天中的远程图片（http(s) img src），默认开；关闭=放行全部（回到旧行为） */
  chatRemoteImageBlockEnabled: boolean;
  /**
   * 允许 file:// 图片子资源。默认关：file:// 页面下 file:// 子资源默认可加载，
   * 放行等于允许模型输出探测本地路径（img onerror 侧信道），仅供离线资料场景手动开启。
   */
  chatFileImageAllowed: boolean;
  /** 始终允许的远程资源域（规范化 hostname，不含 www. 前缀），与临时同意的「始终允许此域」同一存储 */
  chatRemoteImageWhitelist: string[];
}

export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  chatRemoteImageBlockEnabled: true,
  chatFileImageAllowed: false,
  chatRemoteImageWhitelist: [],
};

/** 本地放行协议：主进程注册的白名单映射式协议（parse/resolve 限定根目录，见 protocols/bootstrap.ts） */
export const LOCAL_IMAGE_PROTOCOLS = ["local-sticker:", "moment-media:", "local-font:"] as const;

/** hostname 规范化：去协议/路径/端口/www 前缀，取小写。非法输入返回 null */
export function normalizeWhitelistDomain(raw: string): string | null {
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/\/.*$/, "");
  value = value.replace(/:\d+$/, "");
  if (!value || value.includes("/") || value.includes("@") || /\s/.test(value)) return null;
  if (value.startsWith("www.")) value = value.slice(4);
  if (!value.includes(".") && value !== "localhost") return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  return value;
}

/** 白名单数组规范化：逐项 normalizeWhitelistDomain，去重保序 */
export function normalizeWhitelistDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const host = normalizeWhitelistDomain(item);
    if (host && !seen.has(host)) {
      seen.add(host);
      out.push(host);
    }
  }
  return out;
}

export function normalizeSecuritySettings(raw: Partial<SecuritySettings> | undefined): SecuritySettings {
  const src = raw ?? {};
  return {
    chatRemoteImageBlockEnabled: typeof src.chatRemoteImageBlockEnabled === "boolean"
      ? src.chatRemoteImageBlockEnabled
      : DEFAULT_SECURITY_SETTINGS.chatRemoteImageBlockEnabled,
    chatFileImageAllowed: typeof src.chatFileImageAllowed === "boolean"
      ? src.chatFileImageAllowed
      : DEFAULT_SECURITY_SETTINGS.chatFileImageAllowed,
    chatRemoteImageWhitelist: normalizeWhitelistDomains(src.chatRemoteImageWhitelist),
  };
}
