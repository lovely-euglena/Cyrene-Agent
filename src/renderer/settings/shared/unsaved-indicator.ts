/**
 * 设置页「有未保存的更改」标题提醒。
 *
 * 各面板的脏状态散落在 `.save-status` 文本框里（多数走 shared/save-status.ts，
 * 少数面板如 TTS 直接写 textContent）。这里统一侦测：任一 `.save-status`
 * 显示「有未保存的更改」→ 点亮标题栏（settings-nav__brand）的「未保存」徽标；
 * 全部保存后自动熄灭。
 *
 * 实现：MutationObserver 观察 body 子树变化，无需各面板显式上报。
 */
import { subscribeLocaleChanged, t } from "../i18n";

const STATUS_SELECTOR = ".save-status";
const BADGE_ID = "settings-unsaved-badge";

/** 脏态判定：状态条文本等于 i18n 的「有未保存的更改」 */
export function hasUnsavedChanges(root: ParentNode = document): boolean {
  const dirty = t("settings.status.dirty").trim();
  if (!dirty) return false;
  return Array.from(root.querySelectorAll<HTMLElement>(STATUS_SELECTOR)).some(
    (el) => (el.textContent ?? "").trim() === dirty,
  );
}

/** 按当前脏状态刷新标题徽标（缺徽标时静默跳过，不干扰设置页自身逻辑） */
export function refreshUnsavedIndicator(root: ParentNode = document): void {
  const badge = root.querySelector<HTMLElement>(`#${BADGE_ID}`);
  if (!badge) return;
  const dirty = hasUnsavedChanges(root);
  badge.hidden = !dirty;
  badge.title = dirty ? t("settings.status.dirty") : "";
}

/** 安装全局侦测（返回卸载函数，主要供测试用） */
export function installUnsavedIndicator(): () => void {
  refreshUnsavedIndicator();
  const observer = new MutationObserver(() => refreshUnsavedIndicator());
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  const unsubscribeLocale = subscribeLocaleChanged(() => refreshUnsavedIndicator());
  return () => {
    observer.disconnect();
    unsubscribeLocale();
  };
}