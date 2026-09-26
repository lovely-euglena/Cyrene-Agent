// 便携模式设置行：状态展示、目录选择、应用变更。
// 事件绑定发生在模块导入时（与 preferences/panel.ts 同风格）；状态加载由
// settings.ts 调用 loadPortableStatus()。应用变更的迁移/覆盖询问由主进程用
// 原生对话框完成，确认后应用会自动重启。

import { t } from "../i18n";
import {
  portableApplyBtn,
  portableDirBrowseBtn,
  portableDirInput,
  portableDirRow,
  portableHint,
  portableModeEnabledInput,
} from "./dom";
import type { PortableDataLocationStatus } from "../../../shared/portable-mode";

let currentStatus: PortableDataLocationStatus | null = null;

function setHint(text: string, isError = false): void {
  portableHint.textContent = text;
  portableHint.classList.toggle("is-error", isError);
}

function renderCurrentHint(): void {
  if (!currentStatus) return;
  setHint(t("panel.general.portable.current", { dir: currentStatus.effectiveDataDir }));
}

function renderPortableDirRow(): void {
  portableDirRow.hidden = !portableModeEnabledInput.checked;
}

export async function loadPortableStatus(): Promise<void> {
  try {
    const status = await window.settings?.getPortableStatus?.();
    if (!status) return;
    currentStatus = status;
    portableModeEnabledInput.checked = status.enabled;
    portableDirInput.value = status.dataDir ?? status.suggestedDir;
    renderPortableDirRow();
    renderCurrentHint();
  } catch {
    setHint(t("panel.general.portable.loadFailed"), true);
  }
}

portableModeEnabledInput.addEventListener("change", () => {
  renderPortableDirRow();
});

portableDirBrowseBtn.addEventListener("click", async () => {
  try {
    const picked = await window.settings?.pickPortableDir?.();
    if (picked) portableDirInput.value = picked;
  } catch {
    setHint(t("panel.general.portable.pickFailed"), true);
  }
});

portableApplyBtn.addEventListener("click", async () => {
  if (!window.settings?.applyPortableMode) {
    setHint(t("panel.general.portable.unavailable"), true);
    return;
  }
  portableApplyBtn.disabled = true;
  setHint(t("panel.general.portable.applying"));
  try {
    const result = await window.settings.applyPortableMode({
      enabled: portableModeEnabledInput.checked,
      dir: portableDirInput.value.trim(),
    });
    if (result.status === "applied") {
      setHint(
        t(
          result.migrated
            ? "panel.general.portable.appliedMigrated"
            : "panel.general.portable.appliedSwitched",
        ),
      );
      // 主进程即将重启应用：不再恢复按钮，避免重启窗口期重复点击。
      return;
    }
    if (result.status === "cancelled") {
      setHint(t("panel.general.portable.cancelled"));
    } else if (result.status === "noop") {
      setHint(t("panel.general.portable.noop"));
    } else {
      setHint(t("panel.general.portable.failed", { error: result.error }), true);
    }
  } catch (error) {
    setHint(
      t("panel.general.portable.failed", {
        error: error instanceof Error ? error.message : String(error),
      }),
      true,
    );
  }
  portableApplyBtn.disabled = false;
});
