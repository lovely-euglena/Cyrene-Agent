import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "antd";
import { ChatPage } from "../../features/chat/pages/ChatPage";
import { AppearanceSettingsPage, type SettingsSection } from "../../features/settings/AppearanceSettingsPage";
import { resolveSettingsDestination } from "./settingsNavigation";
import { useTranslation } from "../../i18n";
import { hasUnsavedChanges } from "../../features/settings/unsaved-guard";
import "./AppRouter.css";

export function AppRouter() {
  const { t } = useTranslation();
  const i18nGuard = {
    title: t("settingsPage.unsavedGuard.title"),
    content: t("settingsPage.unsavedGuard.content"),
    leave: t("settingsPage.unsavedGuard.leave"),
    stay: t("settingsPage.unsavedGuard.stay"),
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [scheduledTasksNavigation, setScheduledTasksNavigation] = useState(0);

  // issue #226：离开设置视图前的未保存确认（默认开，通用设置可关）。
  // 开关现查 general config——守卫是低频路径，不值得为其常驻订阅。
  const guardTextRef = useRef(i18nGuard);
  guardTextRef.current = i18nGuard;
  const leaveGuard = useCallback((action: () => void) => {
    void (async () => {
      let guardEnabled = true;
      try {
        const general = await window.settings?.getGeneral() as { unsavedGuardEnabled?: boolean } | undefined;
        guardEnabled = general?.unsavedGuardEnabled !== false;
      } catch { /* 读不到按默认开启处理 */ }
      if (!guardEnabled || !hasUnsavedChanges()) {
        action();
        return;
      }
      const text = guardTextRef.current;
      Modal.confirm({
        title: text.title,
        content: text.content,
        okText: text.leave,
        cancelText: text.stay,
        onOk: action,
      });
    })();
  }, []);

  useEffect(() => window.settings?.onSwitchSection?.((requestedSection) => {
    const destination = resolveSettingsDestination(requestedSection);
    if (destination.kind === "scheduledTasks") {
      leaveGuard(() => {
        setSettingsOpen(false);
        setScheduledTasksNavigation((revision) => revision + 1);
      });
      return;
    }
    leaveGuard(() => {
      setSettingsSection(destination.section);
      setSettingsOpen(true);
    });
  }), [leaveGuard]);

  const openSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, []);

  return (
    <div className="cy-app-router">
      <div
        className={`cy-app-router__view ${settingsOpen ? "is-hidden" : ""}`}
        aria-hidden={settingsOpen}
        inert={settingsOpen}
      >
        <ChatPage onOpenSettings={openSettings} scheduledTasksNavigation={scheduledTasksNavigation} />
      </div>
      {settingsOpen && (
        <div className="cy-app-router__view">
          <AppearanceSettingsPage
            section={settingsSection}
            onSelectSection={(next) => leaveGuard(() => setSettingsSection(next))}
            onBackToWorkspace={() => leaveGuard(() => setSettingsOpen(false))}
          />
        </div>
      )}
    </div>
  );
}
