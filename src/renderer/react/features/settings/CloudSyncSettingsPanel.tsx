// 云端同步（IKJK2I）设置面板：连接配置 / 配对 / 状态与动作。
//
// 数据来源：preload settingsApi.sync*（IPC 常量见 shared/ipc-channels.ts；
// 读取类直接返回快照，动作类统一返回 SyncOpResult<T>）。
// 约定：
//   - token 只在保存时下发明文；输入留空 + 保存 = 保留原值，清除走「清除 token」；
//   - 挂载时加载 config + status，并订阅 onSyncChanged 广播刷新；
//   - 异步 / 错误展示模式对齐 ChannelsSettingsPanel 与 DataStorageSettings。

import { useCallback, useEffect, useState } from "react";
import { Alert, Button, Spin, Tag } from "antd";
import { Activity, KeyRound, Link2, RefreshCw, Unlink } from "lucide-react";
import type {
  SyncConfigPublic,
  SyncOpResult,
  SyncPairCodeResult,
  SyncPairInput,
  SyncSaveConfigInput,
  SyncStatus,
} from "../../../../shared/sync-types";
import { SettingsInput, SettingsPasswordInput, SettingsSwitch } from "../../components/ui/SettingsControls";
import { Card } from "../../components/ui/Card";
import { useTranslation } from "../../i18n";

type BusyKey = "" | "save" | "clearToken" | "pair" | "pairCode" | "sync" | "unpair";

interface Feedback {
  type: "info" | "error";
  text: string;
}

/** ISO 时间 → 本地可读文本（非法值原样回显，不抛错） */
function formatDateTime(value: string | null, t: (key: string) => string): string {
  if (!value) return t("settingsPage.cloud.never");
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

/** 动作类错误统一文案：message + 稳定 code，便于用户报障 / 分支判断 */
function errorText(error: { code: string; message: string }, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t("settingsPage.cloud.errorCode", { message: error.message, code: error.code });
}

export function CloudSyncSettingsPanel() {
  const { t } = useTranslation();
  const api = window.settings;
  const [config, setConfig] = useState<SyncConfigPublic | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<BusyKey>("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  // 连接表单草稿：保存时一次性提交（token 留空 = 保留原值）
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [baseUrlDraft, setBaseUrlDraft] = useState("");
  const [deviceNameDraft, setDeviceNameDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  // 配对：兑换输入 / 最近生成的配对码
  const [pairCodeDraft, setPairCodeDraft] = useState("");
  const [generatedCode, setGeneratedCode] = useState<SyncPairCodeResult | null>(null);

  const applyConfig = useCallback((next: SyncConfigPublic) => {
    setConfig(next);
    setEnabledDraft(next.enabled);
    setBaseUrlDraft(next.baseUrl);
    setDeviceNameDraft(next.deviceName);
  }, []);

  /** 拉取配置 + 状态；silent 用于广播刷新（失败不打断当前反馈） */
  const load = useCallback(async (silent = false) => {
    if (!api?.syncGetConfig || !api.syncGetStatus) return;
    try {
      const [nextConfig, nextStatus] = await Promise.all([api.syncGetConfig(), api.syncGetStatus()]);
      applyConfig(nextConfig);
      setStatus(nextStatus);
    } catch (error) {
      if (!silent) setFeedback({ type: "error", text: error instanceof Error ? error.message : t("settingsPage.cloud.loadFailed") });
    }
  }, [api, applyConfig, t]);

  useEffect(() => {
    let active = true;
    if (!api?.syncGetConfig || !api.syncGetStatus) {
      setLoading(false);
      setFeedback({ type: "error", text: t("settingsPage.cloud.unavailable") });
      return;
    }
    void load().finally(() => { if (active) setLoading(false); });
    const unsubscribe = api.onSyncChanged?.(() => { void load(true); });
    return () => { active = false; if (typeof unsubscribe === "function") unsubscribe(); };
  }, [api, load]);

  /** 动作类统一入口：SyncOpResult / 异常 / busy / 成功后刷新配置与状态 */
  const runAction = useCallback(async <T,>(
    key: BusyKey,
    action: () => Promise<SyncOpResult<T>>,
    successText: string,
  ): Promise<T | null> => {
    setBusy(key);
    setFeedback(null);
    try {
      const result = await action();
      if (!result.ok) {
        setFeedback({ type: "error", text: errorText(result.error, t) });
        return null;
      }
      setFeedback({ type: "info", text: successText });
      await load(true);
      return result.data;
    } catch (error) {
      setFeedback({ type: "error", text: error instanceof Error ? error.message : t("settingsPage.cloud.actionFailed") });
      return null;
    } finally {
      setBusy("");
    }
  }, [load, t]);

  const saveConnection = () => {
    if (!api?.syncSaveConfig) return;
    const input: SyncSaveConfigInput = {
      enabled: enabledDraft,
      baseUrl: baseUrlDraft.trim(),
      deviceName: deviceNameDraft.trim(),
    };
    // 输入了 token 才下发；留空保存不覆盖原值（清除走下方按钮）
    if (tokenDraft.trim()) input.token = tokenDraft.trim();
    void runAction("save", () => api.syncSaveConfig!(input), t("settingsPage.cloud.connection.saved")).then((saved) => {
      if (saved) setTokenDraft("");
    });
  };

  const clearToken = () => {
    if (!api?.syncSaveConfig) return;
    void runAction("clearToken", () => api.syncSaveConfig!({ clearToken: true }), t("settingsPage.cloud.connection.tokenCleared"));
  };

  const redeemPairCode = () => {
    if (!api?.syncPair) return;
    const code = pairCodeDraft.trim().toUpperCase();
    if (!code) {
      setFeedback({ type: "error", text: t("settingsPage.cloud.pairing.codeRequired") });
      return;
    }
    const input: SyncPairInput = { code };
    const baseUrl = baseUrlDraft.trim();
    const deviceName = deviceNameDraft.trim();
    if (baseUrl) input.baseUrl = baseUrl;
    if (deviceName) input.deviceName = deviceName;
    void runAction("pair", () => api.syncPair!(input), t("settingsPage.cloud.pairing.paired")).then((paired) => {
      if (paired) setPairCodeDraft("");
    });
  };

  const generatePairCode = () => {
    if (!api?.syncPairCode) return;
    void runAction("pairCode", () => api.syncPairCode!(), t("settingsPage.cloud.pairing.codeGenerated")).then((data) => {
      if (data) setGeneratedCode(data);
    });
  };

  const syncNow = () => {
    if (api?.syncNow) void runAction("sync", () => api.syncNow!(), t("settingsPage.cloud.status.syncDone"));
  };

  const unpair = () => {
    if (api?.syncUnpair) void runAction("unpair", () => api.syncUnpair!(), t("settingsPage.cloud.status.unpaired"));
  };

  const anyBusy = busy !== "";
  const lastError = status?.lastError ?? null;
  const connectionText = !status
    ? t("settingsPage.cloud.status.unknown")
    : status.syncing
      ? t("settingsPage.cloud.status.syncing")
      : status.lastError
        ? t("settingsPage.cloud.status.abnormal")
        : status.configured
          ? t("settingsPage.cloud.status.ready")
          : t("settingsPage.cloud.status.unconfigured");

  return <>
    <h1>{t("settingsPage.cloud.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.cloud.description")}</p>
    {feedback && <Alert className="cy-settings-alert" type={feedback.type} showIcon message={feedback.text} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Link2 size={18} />{t("settingsPage.cloud.connection.title")}</h2><p>{t("settingsPage.cloud.connection.description")}</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.connection.enable")}</strong><span>{t("settingsPage.cloud.connection.enableHint")}</span></div>
            <SettingsSwitch ariaLabel={t("settingsPage.cloud.connection.enable")} checked={enabledDraft} onChange={setEnabledDraft} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.connection.baseUrl")}</strong><span>{t("settingsPage.cloud.connection.baseUrlHint")}</span></div>
            <SettingsInput value={baseUrlDraft} placeholder="http://..." aria-label={t("settingsPage.cloud.connection.baseUrl")} onChange={(event) => setBaseUrlDraft(event.target.value)} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.connection.deviceName")}</strong><span>{t("settingsPage.cloud.connection.deviceNameHint")}</span></div>
            <SettingsInput value={deviceNameDraft} placeholder={t("settingsPage.cloud.connection.deviceNamePlaceholder")} aria-label={t("settingsPage.cloud.connection.deviceName")} onChange={(event) => setDeviceNameDraft(event.target.value)} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>{t("settingsPage.cloud.connection.token")}</strong>
              <span>{config?.hasToken ? t("settingsPage.cloud.connection.tokenSavedHint") : t("settingsPage.cloud.connection.tokenHint")}</span>
            </div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <SettingsPasswordInput value={tokenDraft} placeholder={config?.hasToken ? t("settingsPage.cloud.connection.tokenSavedPlaceholder") : t("settingsPage.cloud.connection.tokenPlaceholder")} autoComplete="new-password" showLabel={t("settingsPage.cloud.connection.showToken")} hideLabel={t("settingsPage.cloud.connection.hideToken")} aria-label={t("settingsPage.cloud.connection.accessToken")} onChange={(event) => setTokenDraft(event.target.value)} />
              {config?.hasToken && <Button danger loading={busy === "clearToken"} disabled={anyBusy && busy !== "clearToken"} onClick={clearToken}>{t("settingsPage.cloud.connection.clearToken")}</Button>}
              <Button type="primary" loading={busy === "save"} disabled={anyBusy && busy !== "save"} onClick={saveConnection}>{t("settingsPage.cloud.connection.save")}</Button>
            </div>
          </div>
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><KeyRound size={18} />{t("settingsPage.cloud.pairing.title")}</h2><p>{t("settingsPage.cloud.pairing.description")}</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.pairing.redeem")}</strong><span>{t("settingsPage.cloud.pairing.redeemHint")}</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <SettingsInput value={pairCodeDraft} placeholder="XXXX-XXXX" aria-label={t("settingsPage.cloud.pairing.code")} onChange={(event) => setPairCodeDraft(event.target.value.toUpperCase())} />
              <Button type="primary" loading={busy === "pair"} disabled={!pairCodeDraft.trim() || (anyBusy && busy !== "pair")} onClick={redeemPairCode}>{t("settingsPage.cloud.pairing.redeemAction")}</Button>
            </div>
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.pairing.generate")}</strong><span>{t("settingsPage.cloud.pairing.generateHint")}</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <Button loading={busy === "pairCode"} disabled={!config?.hasToken || (anyBusy && busy !== "pairCode")} onClick={generatePairCode}>{t("settingsPage.cloud.pairing.generate")}</Button>
            </div>
          </div>
          {generatedCode && (
            <div className="cy-settings-row">
              <div className="cy-settings-row__copy">
                <strong style={{ fontFamily: "monospace", fontSize: 18, letterSpacing: "0.08em" }}>{generatedCode.code}</strong>
                <span>{t("settingsPage.cloud.pairing.expiresAt", { time: formatDateTime(generatedCode.expiresAt, t) })}</span>
              </div>
              <Tag color="processing">{t("settingsPage.cloud.pairing.pending")}</Tag>
            </div>
          )}
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Activity size={18} />{t("settingsPage.cloud.status.title")}</h2><p>{t("settingsPage.cloud.status.description")}</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.connection")}</strong><span>{connectionText}</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <Button icon={<RefreshCw size={15} aria-hidden="true" />} loading={busy === "sync"} disabled={!status?.configured || (anyBusy && busy !== "sync")} onClick={syncNow}>{t("settingsPage.cloud.status.syncNow")}</Button>
              <Button danger icon={<Unlink size={15} aria-hidden="true" />} loading={busy === "unpair"} disabled={!status?.hasToken || (anyBusy && busy !== "unpair")} onClick={unpair}>{t("settingsPage.cloud.status.unpair")}</Button>
            </div>
          </div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.enableState")}</strong><span>{status?.enabled ? t("settingsPage.cloud.status.enabled") : t("settingsPage.cloud.status.disabled")}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.configState")}</strong><span>{status?.configured ? t("settingsPage.cloud.status.configured") : t("settingsPage.cloud.status.unconfigured")}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.lastSync")}</strong><span>{formatDateTime(status?.lastSyncAt ?? null, t)}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.pendingEvents")}</strong><span>{status?.pendingCount ?? 0}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.cursor")}</strong><span>{status?.cursor ?? t("settingsPage.cloud.status.cursorEmpty")}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.eventCounts")}</strong><span>{status ? `${status.localEventCount} / ${status.remoteEventCount}` : "—"}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cloud.status.devices")}</strong><span>{status ? `${status.deviceId ?? "—"} / ${status.serverDeviceId ?? t("settingsPage.cloud.status.serverUnpaired")}` : "—"}</span></div></div>
          {lastError && (
            <div className="cy-settings-row">
              {/* 单事件超限会阻塞整批推送：补一句可操作指引（删除/缩短源消息后重试） */}
              <Alert
                className="cy-settings-alert"
                type="error"
                showIcon
                message={errorText(lastError, t)}
                description={lastError.code === "oversize_event" ? t("settingsPage.cloud.status.oversizeEventHint") : undefined}
              />
            </div>
          )}
        </Card>
      </section>
    </>}
  </>;
}
