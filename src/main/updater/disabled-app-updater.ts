import type { AppUpdateState } from "../../shared/app-update";
import type { AppUpdateService } from "./app-update-service";

/** 检查更新功能屏蔽态（issue/#暂无稳定更新源）：
 *
 * electron-builder.yml 的 publish 仍指上游 Playa-Cyrene/Cyrene-Agent 的
 * GitHub Releases——fork 改造未拆分独立版本号，实机一旦"更新"即被上游
 * release 覆盖（七 host / 工具体系全部抹掉）。在拿到稳定更新源
 * （计划：S3 直链 generic provider）之前，装配层改用本 disabled 实现：
 *
 * - 状态恒为 not-available：设置页/头像菜单不出现更新按钮与徽标
 * - check/download/install 全部 no-op：手动触发也不发起任何网络请求
 * - scheduleStartupUpdateCheck 的装配点同步改为 no-op，不再轮询
 *
 * 恢复方式：default-dependencies.ts 里把 createDisabledAppUpdateService
 * 换回 createGitHubAppUpdateService 即可，UI/IPC/服务层零改动。
 */
export function createDisabledAppUpdateService(
  currentVersion: string,
  _isPackaged: boolean,
): AppUpdateService {
  const state: AppUpdateState = { phase: "not_available", currentVersion };
  return {
    getState: () => ({ ...state }),
    check: async () => ({ ...state }),
    download: async () => ({ ...state }),
    canInstall: () => false,
    install: () => false,
    onStateChanged: () => () => undefined,
  };
}
