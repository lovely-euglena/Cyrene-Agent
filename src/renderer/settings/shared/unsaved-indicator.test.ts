// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { t } from "../i18n";
import {
  hasUnsavedChanges,
  installUnsavedIndicator,
  refreshUnsavedIndicator,
} from "./unsaved-indicator";

const DIRTY = t("settings.status.dirty");

function setupDom(): void {
  document.body.innerHTML = [
    '<div class="settings-nav__brand">',
    '  <span data-i18n="nav.brand">昔涟</span>',
    '  <span class="settings-nav__unsaved" id="settings-unsaved-badge" hidden>',
    '    <span class="settings-nav__unsaved-dot"></span>',
    '    <span class="settings-nav__unsaved-text">未保存</span>',
    "  </span>",
    "</div>",
    '<div class="save-status" id="sec-a">等待保存</div>',
    '<div class="save-status" id="sec-b"></div>',
  ].join("");
}

const badge = (): HTMLElement => document.getElementById("settings-unsaved-badge") as HTMLElement;
const secA = (): HTMLElement => document.getElementById("sec-a") as HTMLElement;
const secB = (): HTMLElement => document.getElementById("sec-b") as HTMLElement;

describe("unsaved-indicator（标题未保存提醒）", () => {
  beforeEach(setupDom);
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("任一状态条为脏态时点亮，全部保存后熄灭", () => {
    secA().textContent = DIRTY;
    refreshUnsavedIndicator();
    expect(badge().hidden).toBe(false);

    secA().textContent = "已保存";
    refreshUnsavedIndicator();
    expect(badge().hidden).toBe(true);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it("多个状态条：只要还有脏态就保持点亮", () => {
    secA().textContent = "已保存";
    secB().textContent = DIRTY;
    refreshUnsavedIndicator();
    expect(badge().hidden).toBe(false);
  });

  it("MutationObserver 自动响应文本变化（无需手动刷新）", async () => {
    const uninstall = installUnsavedIndicator();
    expect(badge().hidden).toBe(true);

    secB().textContent = DIRTY;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badge().hidden).toBe(false);

    secB().textContent = "已保存";
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(badge().hidden).toBe(true);
    uninstall();
  });

  it("缺徽标时不抛错（例如其它宿主复用该模块）", () => {
    document.getElementById("settings-unsaved-badge")?.remove();
    expect(() => refreshUnsavedIndicator()).not.toThrow();
  });
});