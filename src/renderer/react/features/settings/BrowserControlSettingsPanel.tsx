import { useEffect, useState } from "react";
import { Alert, Button, Popconfirm, Select } from "antd";
import { Cookie, Globe, Search } from "lucide-react";
import { useTranslation } from "../../i18n";
import { BROWSER_SEARCH_ENGINES, type BrowserSearchEngine } from "../../../../shared/browser-search-engine";
import { Card } from "../../components/ui/Card";
import "./BrowserControlSettingsPanel.css";

export function BrowserControlSettingsPanel() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"cleared" | "failed" | "">("");
  const [engine, setEngine] = useState<BrowserSearchEngine>("bing");
  const [engineSaving, setEngineSaving] = useState(false);
  const [engineError, setEngineError] = useState(false);

  useEffect(() => {
    let disposed = false;
    void window.settings?.getGeneral()
      .then((config: unknown) => {
        if (disposed) return;
        const value = config && typeof config === "object" ? (config as Record<string, unknown>).browserSearchEngine : undefined;
        setEngine(typeof value === "string" && (BROWSER_SEARCH_ENGINES as readonly string[]).includes(value) ? value as BrowserSearchEngine : "bing");
      })
      .catch(() => { if (!disposed) setEngineError(true); });
    return () => { disposed = true; };
  }, []);

  async function changeEngine(next: BrowserSearchEngine) {
    if (engineSaving || next === engine) return;
    setEngineSaving(true);
    setEngineError(false);
    try {
      await window.settings?.saveGeneral({ browserSearchEngine: next });
      setEngine(next);
    } catch {
      setEngineError(true);
    } finally {
      setEngineSaving(false);
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
              <strong><Search size={16} />{t("settingsPage.browserControl.searchEngine")}</strong>
              <span>{t("settingsPage.browserControl.searchEngineDescription")}</span>
            </div>
            <Select<BrowserSearchEngine>
              className="cy-browser-control-page__engine"
              value={engine}
              disabled={engineSaving}
              aria-label={t("settingsPage.browserControl.searchEngine")}
              onChange={(value) => void changeEngine(value)}
              options={BROWSER_SEARCH_ENGINES.map((id) => ({ value: id, label: t(`settingsPage.browserControl.engine.${id}`) }))}
            />
          </div>
        </Card>
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
        {status === "cleared" && <Alert className="cy-browser-control-page__status" type="success" showIcon message={t("settingsPage.browserControl.cookiesCleared")} />}
        {status === "failed" && <Alert className="cy-browser-control-page__status" type="error" showIcon message={t("settingsPage.browserControl.clearCookiesFailed")} />}
      </section>
    </div>
  );
}
