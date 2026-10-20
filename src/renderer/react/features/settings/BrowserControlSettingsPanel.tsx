import { useEffect, useState } from "react";
import { Alert, Button, Popconfirm } from "antd";
import { Shield } from "lucide-react";
import { SettingsSwitch } from "../../components/ui/SettingsControls";
import { Cookie, Globe } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Card } from "../../components/ui/Card";
import "./BrowserControlSettingsPanel.css";

export function BrowserControlSettingsPanel() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"cleared" | "failed" | "">("");
  // 广告拦截设置（#143）：enabled 开关 + 白名单（逗号/换行分隔域名）
  const [adblockEnabled, setAdblockEnabled] = useState(true);
  const [allowlistText, setAllowlistText] = useState("");
  const [adblockLoaded, setAdblockLoaded] = useState(false);
  const [adblockSaving, setAdblockSaving] = useState(false);

  useEffect(() => {
    if (!window.settings || adblockLoaded) return;
    void window.settings.getGeneral().then((general) => {
      const raw = general as { adblockEnabled?: boolean; adblockAllowlist?: string };
      setAdblockEnabled(raw.adblockEnabled !== false);
      setAllowlistText(raw.adblockAllowlist ?? "");
      setAdblockLoaded(true);
    }).catch(() => undefined);
  }, [adblockLoaded]);

  async function saveAdblock(nextEnabled: boolean, nextAllowlist: string): Promise<void> {
    if (!window.settings || adblockSaving) return;
    setAdblockSaving(true);
    try {
      await window.settings.saveGeneral({ adblockEnabled: nextEnabled, adblockAllowlist: nextAllowlist });
      setAdblockEnabled(nextEnabled);
      setAllowlistText(nextAllowlist);
    } catch {
      /* 保存失败静默：下次打开设置页重读 */
    } finally {
      setAdblockSaving(false);
    }
  }

  async function clearCookies() {
    if (!window.browserPanel || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await window.browserPanel.clearCookies();
      setStatus(result.ok ? "cleared" : "failed");
    } catch {
      setStatus("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cy-browser-control-page">
      <h1>{t("settingsPage.browserControl.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.browserControl.description")}</p>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading">
          <h2><Globe size={18} />{t("settingsPage.browserControl.sectionTitle")}</h2>
          <p>{t("settingsPage.browserControl.sectionDescription")}</p>
        </div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong><Cookie size={16} />{t("settingsPage.browserControl.clearCookies")}</strong>
              <span>{t("settingsPage.browserControl.clearCookiesDescription")}</span>
            </div>
            <Popconfirm
              title={t("settingsPage.browserControl.confirmTitle")}
              description={t("settingsPage.browserControl.confirmDescription")}
              okText={t("settingsPage.browserControl.clearCookies")}
              cancelText={t("common.cancel")}
              onConfirm={() => void clearCookies()}
            >
              <Button danger loading={busy} disabled={!window.browserPanel}>
                {t("settingsPage.browserControl.clearCookies")}
              </Button>
            </Popconfirm>
          </div>
        </Card>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong><Shield size={16} />{t("settingsPage.browserControl.adblockTitle")}</strong>
              <span>{t("settingsPage.browserControl.adblockDescription")}</span>
            </div>
            <SettingsSwitch
              ariaLabel={t("settingsPage.browserControl.adblockTitle")}
              checked={adblockEnabled}
              disabled={adblockSaving}
              onChange={(checked) => void saveAdblock(checked, allowlistText)}
            />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>{t("settingsPage.browserControl.adblockAllowlist")}</strong>
              <span>{t("settingsPage.browserControl.adblockAllowlistDescription")}</span>
            </div>
            <div className="cy-settings-row__control cy-settings-tools__field">
              <input
                className="cy-settings-input"
                value={allowlistText}
                placeholder={t("settingsPage.browserControl.adblockAllowlistPlaceholder")}
                disabled={adblockSaving}
                onChange={(event) => setAllowlistText(event.target.value)}
              />
              <Button
                disabled={adblockSaving || !adblockLoaded}
                onClick={() => void saveAdblock(adblockEnabled, allowlistText)}
              >
                {t("settingsPage.tools.save")}
              </Button>
            </div>
          </div>
        </Card>
        {status === "cleared" && <Alert className="cy-browser-control-page__status" type="success" showIcon message={t("settingsPage.browserControl.cookiesCleared")} />}
        {status === "failed" && <Alert className="cy-browser-control-page__status" type="error" showIcon message={t("settingsPage.browserControl.clearCookiesFailed")} />}
      </section>
    </div>
  );
}
