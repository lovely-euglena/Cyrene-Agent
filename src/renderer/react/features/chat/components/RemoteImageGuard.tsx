/**
 * 聊天远程图片拦截守卫（#192）
 *
 * components.img 覆写入口：白名单/已同意 → 原样渲染 img（外呼）
 *                          被拦 → 占位卡片（来源域 + 三档同意按钮），不渲染 <img> 标签，零外呼。
 * 设置读取走 security-settings-store（保存广播即时生效）；同意状态机为模块级单例（应用运行期）。
 */

import { useCallback, useState, type ReactNode } from "react";
import { judgeRemoteImage, createConsentGrants, extractDomain, type ConsentGrants } from "./remote-resource-policy";
import { useSecuritySettings } from "./security-settings-store";
import { useTranslation } from "../../../i18n";
import "./RemoteImageGuard.css";

/** 同意状态为应用运行期单例：会话级授权跨聊天会话保留（对齐浏览器"本会话"语义） */
export const consentGrants: ConsentGrants = createConsentGrants();

export function RemoteImageGuard({ src, alt, children }: { src?: string; alt?: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const security = useSecuritySettings();
  const [failed, setFailed] = useState(false);
  // 授权动作后的强制重渲染信号（store 未变时占位→img 的切换靠它；nonce 作 img key 重建元素）
  const [grantNonce, setGrantNonce] = useState(0);

  const verdict = src
    ? judgeRemoteImage(src, { blockEnabled: security.chatRemoteImageBlockEnabled, fileImageAllowed: security.chatFileImageAllowed, whitelist: security.chatRemoteImageWhitelist }, consentGrants)
    : "blocked";
  const domain = src ? extractDomain(src) : "";

  const allowOnce = useCallback(() => {
    if (src) consentGrants.grantOneShot(src);
    setFailed(false);
    setGrantNonce((value) => value + 1);
  }, [src]);
  const allowSession = useCallback(() => {
    if (domain) consentGrants.grantSession(domain);
    setFailed(false);
    setGrantNonce((value) => value + 1);
  }, [domain]);
  const allowPersistent = useCallback(() => {
    if (!domain) return;
    void window.chat?.saveGeneral?.({ chatRemoteImageWhitelist: [...new Set([...security.chatRemoteImageWhitelist, domain])] });
    // 白名单保存走广播回流；此处立即本地授权兜底（广播未及时到达时占位也消失）
    consentGrants.grantSession(domain);
    setFailed(false);
    setGrantNonce((value) => value + 1);
  }, [domain, security.chatRemoteImageWhitelist]);

  if (verdict === "blocked" || !src) {
    return (
      <span className="cy-remote-image-guard" data-remote-image="blocked" role="figure" aria-label={t("security.remoteImageBlockedLabel")}>
        <span className="cy-remote-image-guard__icon" aria-hidden="true">🔒</span>
        <span className="cy-remote-image-guard__meta">
          <span className="cy-remote-image-guard__title">{t("security.remoteImageBlocked")}</span>
          {domain ? <span className="cy-remote-image-guard__domain">{domain}</span> : null}
        </span>
        <span className="cy-remote-image-guard__actions">
          <button type="button" className="cy-remote-image-guard__btn" onClick={allowOnce}>{t("security.allowOnce")}</button>
          <button type="button" className="cy-remote-image-guard__btn" onClick={allowSession}>{t("security.allowSession")}</button>
          {domain ? (
            <button type="button" className="cy-remote-image-guard__btn cy-remote-image-guard__btn--primary" onClick={allowPersistent}>
              {t("security.allowPersistent")}
            </button>
          ) : null}
        </span>
        {children}
      </span>
    );
  }

  if (failed && verdict !== "local") {
    // 已放行但加载失败：保留 alt 的轻量降级（不显示破图图标）
    return (
      <span className="cy-remote-image-guard cy-remote-image-guard--failed" data-remote-image="error">
        {alt || t("security.imageFailed")}
      </span>
    );
  }

  // 放行：原样渲染。grantNonce 作 key 授权后重建元素；referrerPolicy=no-referrer 不向图源泄露页面来源。
  return (
    <img
      key={grantNonce}
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="cy-message-image"
      onError={() => setFailed(true)}
    />
  );
}
