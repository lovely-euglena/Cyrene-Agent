// @vitest-environment jsdom

// 云端同步面板基础用例：加载 / 保存 token 语义 / 动作错误展示 / 广播刷新 / 配对码。
// 渲染方式对齐 ChannelsSettingsMigration.test.ts（createElement + mock window.settings）。

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncConfigPublic, SyncStatus } from "../../../../shared/sync-types";
import { setUiLocale, t } from "../../i18n";
import { CloudSyncSettingsPanel } from "./CloudSyncSettingsPanel";

Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});

const roots: Root[] = [];

const baseConfig: SyncConfigPublic = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8787",
  deviceName: "测试桌面",
  hasToken: true,
  deviceId: "desk-0123456789ab",
  serverDeviceId: "dev_test",
};

const baseStatus: SyncStatus = {
  enabled: true,
  configured: true,
  baseUrl: "http://127.0.0.1:8787",
  hasToken: true,
  deviceId: "desk-0123456789ab",
  serverDeviceId: "dev_test",
  syncing: false,
  lastSyncAt: "2026-10-06T08:00:00.000Z",
  lastError: null,
  pendingCount: 3,
  cursor: "cursor-1",
  localEventCount: 12,
  remoteEventCount: 5,
};

async function renderPanel(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(createElement(CloudSyncSettingsPanel)); });
  return host;
}

function buttonByText(host: ParentNode, text: string): HTMLButtonElement | undefined {
  const normalize = (value: string) => value.replace(/\s+/gu, "");
  return Array.from(host.querySelectorAll("button")).find((button) => normalize(button.textContent ?? "") === normalize(text));
}

/** 受控 input：绕过 React 的 value 追踪，模拟真实输入 */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  delete (window as Window & { settings?: unknown }).settings;
  // 语言是 i18next 全局单例，用例改过后必须还原（等切换完成再进入下一用例）
  await act(async () => { setUiLocale("zh-CN"); await flush(); });
  vi.restoreAllMocks();
});

describe("CloudSyncSettingsPanel", () => {
  it("挂载时加载配置与状态，并渲染同步快照", async () => {
    const syncGetConfig = vi.fn().mockResolvedValue(baseConfig);
    const syncGetStatus = vi.fn().mockResolvedValue(baseStatus);
    const onSyncChanged = vi.fn(() => () => {});
    Object.assign(window, { settings: { syncGetConfig, syncGetStatus, onSyncChanged } });

    const host = await renderPanel();

    expect(syncGetConfig).toHaveBeenCalledTimes(1);
    expect(syncGetStatus).toHaveBeenCalledTimes(1);
    expect(onSyncChanged).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(t("settingsPage.cloud.title"));
    expect(host.querySelector<HTMLInputElement>(`input[aria-label='${t("settingsPage.cloud.connection.baseUrl")}']`)?.value).toBe(baseConfig.baseUrl);
    expect(host.textContent).toContain("3"); // pendingCount
    expect(host.textContent).toContain("12 / 5"); // 本地 / 远端事件
    expect(host.textContent).toContain("desk-0123456789ab / dev_test");
  });

  it("保存时仅在填写 token 时下发 token；留空保存保留原值", async () => {
    const syncSaveConfig = vi.fn().mockResolvedValue({ ok: true, data: baseConfig });
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => baseStatus,
        onSyncChanged: () => () => {},
        syncSaveConfig,
      },
    });
    const host = await renderPanel();

    await act(async () => { buttonByText(host, t("settingsPage.cloud.connection.save"))!.click(); await flush(); });
    expect(syncSaveConfig).toHaveBeenNthCalledWith(1, {
      enabled: true,
      baseUrl: baseConfig.baseUrl,
      deviceName: baseConfig.deviceName,
    });

    const tokenInput = host.querySelector<HTMLInputElement>(`input[aria-label='${t("settingsPage.cloud.connection.accessToken")}']`)!;
    await act(async () => { typeInto(tokenInput, "tok-secret"); });
    await act(async () => { buttonByText(host, t("settingsPage.cloud.connection.save"))!.click(); await flush(); });
    expect(syncSaveConfig).toHaveBeenNthCalledWith(2, {
      enabled: true,
      baseUrl: baseConfig.baseUrl,
      deviceName: baseConfig.deviceName,
      token: "tok-secret",
    });
    // 保存成功后清空 token 草稿（不会把明文回显到输入框）
    expect((host.querySelector<HTMLInputElement>(`input[aria-label='${t("settingsPage.cloud.connection.accessToken")}']`) as HTMLInputElement).value).toBe("");
  });

  it("动作失败时展示 error.message 与 error.code", async () => {
    const syncNow = vi.fn().mockResolvedValue({ ok: false, error: { code: "network", message: "连接服务器失败" } });
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => baseStatus,
        onSyncChanged: () => () => {},
        syncNow,
      },
    });
    const host = await renderPanel();

    await act(async () => { buttonByText(host, t("settingsPage.cloud.status.syncNow"))!.click(); await flush(); });
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain(t("settingsPage.cloud.errorCode", { message: "连接服务器失败", code: "network" }));
  });

  it("lastError 为 oversize_event 时展示超限指引文案", async () => {
    const oversizeStatus: SyncStatus = {
      ...baseStatus,
      lastError: { code: "oversize_event", message: "事件 loc-1 超过单事件上限（10 MiB）" },
    };
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => oversizeStatus,
        onSyncChanged: () => () => {},
      },
    });
    const host = await renderPanel();

    expect(host.textContent).toContain("oversize_event");
    // 字面量断言：key 漏翻时 t() 会回显 key，不能作为唯一依据
    expect(host.textContent).toContain("超出服务端单事件上限");
    expect(host.textContent).toContain(t("settingsPage.cloud.status.oversizeEventHint"));
  });

  it("其他 lastError 不展示超限指引文案", async () => {
    const networkStatus: SyncStatus = {
      ...baseStatus,
      lastError: { code: "network", message: "连接服务器失败" },
    };
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => networkStatus,
        onSyncChanged: () => () => {},
      },
    });
    const host = await renderPanel();

    expect(host.textContent).toContain(t("settingsPage.cloud.errorCode", { message: "连接服务器失败", code: "network" }));
    expect(host.textContent).not.toContain("超出服务端单事件上限");
    expect(host.textContent).not.toContain(t("settingsPage.cloud.status.oversizeEventHint"));
  });

  it("收到 onSyncChanged 广播后刷新配置与状态", async () => {
    let notify: (() => void) | null = null;
    const syncGetStatus = vi.fn().mockResolvedValue(baseStatus);
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus,
        onSyncChanged: (callback: () => void) => { notify = callback; return () => {}; },
      },
    });
    await renderPanel();
    expect(syncGetStatus).toHaveBeenCalledTimes(1);

    await act(async () => { notify?.(); await flush(); });
    expect(syncGetStatus).toHaveBeenCalledTimes(2);
  });

  it("生成配对码后展示 XXXX-XXXX 与到期时间", async () => {
    const syncPairCode = vi.fn().mockResolvedValue({
      ok: true,
      data: { code: "ABCD-EF12", expiresAt: "2026-10-06T09:00:00.000Z" },
    });
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => baseStatus,
        onSyncChanged: () => () => {},
        syncPairCode,
      },
    });
    const host = await renderPanel();

    await act(async () => { buttonByText(host, t("settingsPage.cloud.pairing.generate"))!.click(); await flush(); });
    expect(syncPairCode).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("ABCD-EF12");
    expect(host.textContent).toContain(t("settingsPage.cloud.pairing.expiresAt", { time: new Date("2026-10-06T09:00:00.000Z").toLocaleString() }));
  });

  it("切换 UI 语言后按对应语言渲染（en）", async () => {
    Object.assign(window, {
      settings: {
        syncGetConfig: async () => baseConfig,
        syncGetStatus: async () => baseStatus,
        onSyncChanged: () => () => {},
      },
    });
    const host = await renderPanel();

    await act(async () => { setUiLocale("en"); await flush(); });
    expect(host.textContent).toContain("Cloud"); // 英文资源字面量：语言切换失败时不会误判为通过
    expect(host.textContent).toContain(t("settingsPage.cloud.title"));
    expect(host.textContent).toContain(t("settingsPage.cloud.connection.enable"));
    expect(buttonByText(host, t("settingsPage.cloud.status.syncNow"))).toBeDefined();
  });
});
