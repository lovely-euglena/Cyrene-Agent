/**
 * 远程资源放行判定与临时同意状态机（issue #192）
 *
 * 三层同意模型：
 *  - 默认拦截：未获同意的 http(s) 远程图片不加载（渲染占位卡片）
 *  - 临时同意（本文件，不落盘）：本次允许（精确 URL，内存）/ 本会话允许（域，应用运行期）
 *  - 持久白名单：设置持久化（shared/security-settings.ts，设置窗编辑）
 *
 * 纯状态机不依赖 DOM，契约测试见 remote-resource-policy.test.ts。
 */

import { LOCAL_IMAGE_PROTOCOLS, normalizeWhitelistDomain } from "../../../../../shared/security-settings";

/** 远程资源判定结果：local=主进程白名单协议直接放行；allowed=白名单/已同意；blocked=待占位 */
export interface RemoteImagePolicyInput {
  blockEnabled: boolean;
  fileImageAllowed: boolean;
  whitelist: readonly string[];
}

export type RemoteImageVerdict = "local" | "allowed" | "blocked";

export function extractDomain(src: string): string {
  try {
    return new URL(src).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** img src 判定：主进程映射协议 → local；file:// → 看 fileImageAllowed；白名单/已同意/关闭拦截 → allowed；其余 → blocked */
export function judgeRemoteImage(src: string, input: RemoteImagePolicyInput, grants: ConsentGrants): RemoteImageVerdict {
  if (isLocalProtocol(src)) return "local";
  if (src.startsWith("file://")) return input.fileImageAllowed ? "allowed" : "blocked";
  // 相对路径/内联数据：无外呼风险，直接放行
  if (!/^https?:\/\//i.test(src)) return "allowed";
  if (!input.blockEnabled) return "allowed";
  const domain = extractDomain(src);
  if (input.whitelist.includes(domain)) return "allowed";
  if (grants.isGranted(src, domain)) return "allowed";
  return "blocked";
}

function isLocalProtocol(src: string): boolean {
  return (LOCAL_IMAGE_PROTOCOLS as readonly string[]).some((protocol) => src.startsWith(protocol) || src.startsWith(`/${protocol}`));
}

/** 临时同意状态机：oneShot=精确 URL（本次）；session=域（应用运行期）；持久白名单在设置里，不在此处 */
export interface ConsentGrants {
  grantOneShot(url: string): void;
  grantSession(domain: string): void;
  revokeSession(domain: string): void;
  isGranted(url: string, domain: string): boolean;
  /** 会话级授权清单（占位卡片批量操作/调试展示用），仅运行期 */
  sessionDomains(): readonly string[];
}

export function createConsentGrants(): ConsentGrants {
  const oneShot = new Set<string>();
  const session = new Set<string>();
  return {
    grantOneShot(url) {
      oneShot.add(url);
    },
    grantSession(domain) {
      const host = normalizeWhitelistDomain(domain) ?? domain;
      session.add(host);
    },
    revokeSession(domain) {
      session.delete(normalizeWhitelistDomain(domain) ?? domain);
    },
    isGranted(url, domain) {
      if (oneShot.has(url)) return true;
      return session.has(domain);
    },
    sessionDomains() {
      return [...session];
    },
  };
}
