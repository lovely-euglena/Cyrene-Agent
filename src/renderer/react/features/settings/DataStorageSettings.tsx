// 通用设置「数据与存储」子块：便携模式（数据目录） + 缓存目录。
//
// 与 WPF 通用 section 的 BuildPortableBlock / BuildCacheDirBlock 同语义：
//   - 便携模式：开关 + 目录（支持相对路径，相对程序目录）+ 浏览 + 应用并重启；
//     迁移/覆盖确认由宿主弹原生对话框（applyPortableMode 不带预选决定）。
//   - 缓存目录：覆盖路径（空 = 跟随默认策略）+ 浏览 + 应用（重启换根）。
// 数据来源：settings:portable-* / settings:cache-* IPC（宿主 portable-ipc / cache-ipc）。

import { useEffect, useState } from "react";
import { Button } from "antd";
import { Database } from "lucide-react";
import type { PortableDataLocationStatus } from "../../../../shared/portable-mode";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSwitch } from "../../components/ui/SettingsControls";
import { Card } from "../../components/ui/Card";

interface CacheDirStatus {
  effectiveDir: string;
  override: string | null;
  portableActive: boolean;
}

export function DataStorageSettings() {
  const { t } = useTranslation();
  const [portableStatus, setPortableStatus] = useState<PortableDataLocationStatus | null>(null);
  const [portableEnabled, setPortableEnabled] = useState(false);
  const [portableDir, setPortableDir] = useState("");
  const [portableBusy, setPortableBusy] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<CacheDirStatus | null>(null);
  const [cacheDir, setCacheDir] = useState("");
  const [cacheBusy, setCacheBusy] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let active = true;
    void window.settings?.getPortableStatus?.().then((value) => {
      if (!active || !value) return;
      setPortableStatus(value);
      setPortableEnabled(value.enabled);
      // 相对值原样回显（如 "data"）；无配置回显默认便携目录
      setPortableDir(value.displayDir ?? value.dataDir ?? value.suggestedDir);
    }).catch(() => { /* 状态不可用时保持默认展示 */ });
    void window.settings?.getCacheDirStatus?.().then((value) => {
      if (!active || !value) return;
      setCacheStatus(value);
      setCacheDir(value.override ?? "");
    }).catch(() => { /* 同上 */ });
    return () => { active = false; };
  }, []);

  async function pickPortableDir(): Promise<void> {
    try {
      const picked = await window.settings?.pickPortableDir?.();
      if (picked) setPortableDir(picked);
    } catch {
      setStatus(t("settingsPage.storage.pickFailed"));
    }
  }

  async function applyPortable(): Promise<void> {
    if (!window.settings?.applyPortableMode || portableBusy) return;
    setPortableBusy(true);
    setStatus(t("settingsPage.storage.portableApplying"));
    try {
      const result = await window.settings.applyPortableMode({ enabled: portableEnabled, dir: portableDir });
      if (result.status === "applied") setStatus(t("settingsPage.storage.portableApplied", { dir: result.targetDir }));
      else if (result.status === "noop") setStatus(t("settingsPage.storage.portableNoop"));
      else if (result.status === "cancelled") setStatus(t("settingsPage.storage.portableCancelled"));
      else setStatus(result.error || t("settingsPage.saveFailed"));
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setPortableBusy(false);
    }
  }

  async function pickCacheDir(): Promise<void> {
    try {
      const picked = await window.settings?.pickCacheDir?.();
      if (picked) setCacheDir(picked);
    } catch {
      setStatus(t("settingsPage.storage.pickFailed"));
    }
  }

  async function applyCacheDir(): Promise<void> {
    if (!window.settings?.setCacheDir || cacheBusy) return;
    setCacheBusy(true);
    try {
      const result = await window.settings.setCacheDir(cacheDir.trim());
      setStatus(
        result?.changed
          ? t("settingsPage.storage.cacheApplied")
          : t("settingsPage.storage.cacheNoop"),
      );
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setCacheBusy(false);
    }
  }

  return (
    <section className="cy-settings-section">
      <div className="cy-settings-section__heading">
        <h2><Database size={18} />{t("settingsPage.storage.title")}</h2>
        <p>{t("settingsPage.storage.description")}</p>
      </div>
      <Card>
        <div className="cy-settings-row">
          <div className="cy-settings-row__copy">
            <strong>{t("settingsPage.storage.portableMode")}</strong>
            <span>{t("settingsPage.storage.portableModeDescription")}</span>
          </div>
          <SettingsSwitch
            ariaLabel={t("settingsPage.storage.portableMode")}
            checked={portableEnabled}
            onChange={setPortableEnabled}
          />
        </div>
        {portableEnabled && (
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>{t("settingsPage.storage.portableDir")}</strong>
              <span>{t("settingsPage.storage.portableDirDescription")}</span>
              {portableStatus && (
                <span className="cy-settings-general__notice">
                  {t("settingsPage.storage.portableEffective", { dir: portableStatus.effectiveDataDir })}
                </span>
              )}
            </div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <SettingsInput
                value={portableDir}
                placeholder={portableStatus?.suggestedDir ?? ""}
                aria-label={t("settingsPage.storage.portableDir")}
                onChange={(event) => setPortableDir(event.target.value)}
              />
              <Button onClick={() => void pickPortableDir()}>{t("settingsPage.storage.browse")}</Button>
              <Button type="primary" loading={portableBusy} onClick={() => void applyPortable()}>
                {t("settingsPage.storage.applyRestart")}
              </Button>
            </div>
          </div>
        )}
        <div className="cy-settings-row">
          <div className="cy-settings-row__copy">
            <strong>{t("settingsPage.storage.cacheDir")}</strong>
            <span>{t("settingsPage.storage.cacheDirDescription")}</span>
            {cacheStatus && (
              <span className="cy-settings-general__notice">
                {t("settingsPage.storage.cacheEffective", { dir: cacheStatus.effectiveDir })}
              </span>
            )}
          </div>
          <div className="cy-settings-row__control cy-settings-button-group">
            <SettingsInput
              value={cacheDir}
              placeholder={cacheStatus?.effectiveDir ?? ""}
              aria-label={t("settingsPage.storage.cacheDir")}
              onChange={(event) => setCacheDir(event.target.value)}
            />
            <Button onClick={() => void pickCacheDir()}>{t("settingsPage.storage.browse")}</Button>
            <Button loading={cacheBusy} onClick={() => void applyCacheDir()}>
              {t("settingsPage.storage.apply")}
            </Button>
          </div>
        </div>
        {status && (
          <div className="cy-settings-row">
            <span className="cy-settings-general__notice" role="status" aria-live="polite">{status}</span>
          </div>
        )}
      </Card>
    </section>
  );
}
