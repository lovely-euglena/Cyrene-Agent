import { describe, expect, it, vi } from "vitest";
import { createDisabledAppUpdateService } from "./disabled-app-updater";

/** 屏蔽态更新服务契约：状态恒 not_available、全 no-op、零网络请求。
 * 装配点切换（createGitHubAppUpdateService ↔ createDisabledAppUpdateService）
 * 依赖本契约不变。 */
describe("createDisabledAppUpdateService", () => {
  it("初始与 check/download 后状态恒为 not_available，版本回显", async () => {
    const service = createDisabledAppUpdateService("9.9.9-fork", false);
    expect(service.getState()).toEqual({ phase: "not_available", currentVersion: "9.9.9-fork" });
    expect(await service.check()).toEqual({ phase: "not_available", currentVersion: "9.9.9-fork" });
    expect(await service.download()).toEqual({ phase: "not_available", currentVersion: "9.9.9-fork" });
  });

  it("install 被拒（canInstall=false），onStateChanged 返回可安全调用的反注册函数", () => {
    const service = createDisabledAppUpdateService("9.9.9-fork", true);
    expect(service.canInstall()).toBe(false);
    expect(service.install()).toBe(false);
    const dispose = service.onStateChanged(vi.fn());
    expect(() => dispose()).not.toThrow();
  });
});
