/**
 * 安全分区面板逻辑（#192）
 *
 * 三开关与白名单编辑器。保存走 window.settings.saveGeneral（settingsApi），
 * 与聊天窗占位卡「始终允许此域」同一持久化字段（shared/security-settings.ts）。
 */

import { normalizeWhitelistDomain } from "../../../shared/security-settings";
import { t } from "../i18n";

function showStatus(el: HTMLElement | null, text: string, ok = false): void {
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("is-ok", ok);
  el.dataset.visible = "true";
  window.setTimeout(() => {
    el.dataset.visible = "false";
  }, 1600);
}

async function patchSecurity(patch: Record<string, unknown>, statusEl: HTMLElement | null): Promise<void> {
  showStatus(statusEl, t("panel.security.status.applying"));
  try {
    await window.settings?.saveGeneral(patch);
    showStatus(statusEl, t("panel.security.status.applied"), true);
  } catch {
    showStatus(statusEl, t("panel.security.status.applying"));
  }
}

/** 初始化安全分区：拉取当前值填充控件并挂事件。settings.ts 切到该分区时调用。 */
export function initSecurityPanel(): void {
  const blockToggle = document.getElementById("security-block-remote-image") as HTMLInputElement | null;
  const fileToggle = document.getElementById("security-allow-file-image") as HTMLInputElement | null;
  const listEl = document.getElementById("security-whitelist-list");
  const inputEl = document.getElementById("security-whitelist-input") as HTMLInputElement | null;
  const addBtn = document.getElementById("security-whitelist-add");
  const statusEl = document.querySelector<HTMLElement>("#security-panel .settings-status");

  if (!blockToggle || !fileToggle || !listEl) return;

  const renderList = (domains: string[]): void => {
    listEl.textContent = "";
    if (domains.length === 0) {
      const empty = document.createElement("li");
      empty.className = "security-whitelist__empty";
      empty.textContent = t("panel.security.whitelist.empty");
      listEl.appendChild(empty);
      return;
    }
    for (const domain of domains) {
      const li = document.createElement("li");
      li.className = "security-whitelist__item";
      const name = document.createElement("span");
      name.textContent = domain;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "security-whitelist__remove";
      remove.textContent = t("panel.security.whitelist.remove");
      remove.addEventListener("click", () => {
        const next = domains.filter((d) => d !== domain);
        renderList(next);
        void patchSecurity({ chatRemoteImageWhitelist: next }, statusEl);
      });
      li.appendChild(name);
      li.appendChild(remove);
      listEl.appendChild(li);
    }
  };

  void window.settings?.getGeneral?.().then((raw) => {
    const settings = (raw ?? {}) as { chatRemoteImageBlockEnabled?: boolean; chatFileImageAllowed?: boolean; chatRemoteImageWhitelist?: string[] };
    blockToggle.checked = settings.chatRemoteImageBlockEnabled !== false;
    fileToggle.checked = settings.chatFileImageAllowed === true;
    renderList(Array.isArray(settings.chatRemoteImageWhitelist) ? settings.chatRemoteImageWhitelist : []);
  });

  blockToggle.addEventListener("change", () => {
    void patchSecurity({ chatRemoteImageBlockEnabled: blockToggle.checked }, statusEl);
  });
  fileToggle.addEventListener("change", () => {
    void patchSecurity({ chatFileImageAllowed: fileToggle.checked }, statusEl);
  });

  const addDomain = (): void => {
    if (!inputEl) return;
    const domain = normalizeWhitelistDomain(inputEl.value);
    if (!domain) {
      inputEl.value = "";
      return;
    }
    void window.settings?.getGeneral?.().then((raw) => {
      const current = ((raw ?? {}) as { chatRemoteImageWhitelist?: string[] }).chatRemoteImageWhitelist ?? [];
      if (current.includes(domain)) {
        inputEl.value = "";
        return;
      }
      const next = [...current, domain];
      renderList(next);
      void patchSecurity({ chatRemoteImageWhitelist: next }, statusEl);
      inputEl.value = "";
    });
  };

  addBtn?.addEventListener("click", addDomain);
  inputEl?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addDomain();
    }
  });
}
