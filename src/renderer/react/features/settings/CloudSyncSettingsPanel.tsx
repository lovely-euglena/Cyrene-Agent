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

type BusyKey = "" | "save" | "clearToken" | "pair" | "pairCode" | "sync" | "unpair";

interface Feedback {
  type: "info" | "error";
  text: string;
}

/** ISO 时间 → 本地可读文本（非法值原样回显，不抛错） */
function formatDateTime(value: string | null): string {
  if (!value) return "从未";
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? value : time.toLocaleString();
}

/** 动作类错误统一文案：message + 稳定 code，便于用户报障 / 分支判断 */
function errorText(error: { code: string; message: string }): string {
  return `${error.message}（${error.code}）`;
}

export function CloudSyncSettingsPanel() {
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
      if (!silent) setFeedback({ type: "error", text: error instanceof Error ? error.message : "加载云端同步配置失败。" });
    }
  }, [api, applyConfig]);

  useEffect(() => {
    let active = true;
    if (!api?.syncGetConfig || !api.syncGetStatus) {
      setLoading(false);
      setFeedback({ type: "error", text: "云端同步接口不可用。" });
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
        setFeedback({ type: "error", text: errorText(result.error) });
        return null;
      }
      setFeedback({ type: "info", text: successText });
      await load(true);
      return result.data;
    } catch (error) {
      setFeedback({ type: "error", text: error instanceof Error ? error.message : "操作失败，请稍后重试。" });
      return null;
    } finally {
      setBusy("");
    }
  }, [load]);

  const saveConnection = () => {
    if (!api?.syncSaveConfig) return;
    const input: SyncSaveConfigInput = {
      enabled: enabledDraft,
      baseUrl: baseUrlDraft.trim(),
      deviceName: deviceNameDraft.trim(),
    };
    // 输入了 token 才下发；留空保存不覆盖原值（清除走下方按钮）
    if (tokenDraft.trim()) input.token = tokenDraft.trim();
    void runAction("save", () => api.syncSaveConfig!(input), "已保存。").then((saved) => {
      if (saved) setTokenDraft("");
    });
  };

  const clearToken = () => {
    if (!api?.syncSaveConfig) return;
    void runAction("clearToken", () => api.syncSaveConfig!({ clearToken: true }), "已清除访问令牌。");
  };

  const redeemPairCode = () => {
    if (!api?.syncPair) return;
    const code = pairCodeDraft.trim().toUpperCase();
    if (!code) {
      setFeedback({ type: "error", text: "请输入配对码。" });
      return;
    }
    const input: SyncPairInput = { code };
    const baseUrl = baseUrlDraft.trim();
    const deviceName = deviceNameDraft.trim();
    if (baseUrl) input.baseUrl = baseUrl;
    if (deviceName) input.deviceName = deviceName;
    void runAction("pair", () => api.syncPair!(input), "配对成功。").then((paired) => {
      if (paired) setPairCodeDraft("");
    });
  };

  const generatePairCode = () => {
    if (!api?.syncPairCode) return;
    void runAction("pairCode", () => api.syncPairCode!(), "已生成配对码，请在手机端兑换。").then((data) => {
      if (data) setGeneratedCode(data);
    });
  };

  const syncNow = () => {
    if (api?.syncNow) void runAction("sync", () => api.syncNow!(), "同步完成。");
  };

  const unpair = () => {
    if (api?.syncUnpair) void runAction("unpair", () => api.syncUnpair!(), "已解除配对，重新配对后会继续同步历史事件。");
  };

  const anyBusy = busy !== "";
  const lastError = status?.lastError ?? null;
  const connectionText = !status
    ? "未知"
    : status.syncing
      ? "同步中…"
      : status.lastError
        ? "异常"
        : status.configured
          ? "就绪"
          : "未配置";

  return <>
    <h1>云端</h1>
    <p className="cy-settings-intro">把本机对话同步到云端服务器，手机端可与桌面接力；令牌加密存储，仅在保存时下发明文。</p>
    {feedback && <Alert className="cy-settings-alert" type={feedback.type} showIcon message={feedback.text} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Link2 size={18} />连接</h2><p>服务器地址与设备身份；保存后生效。</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>启用云端同步</strong><span>关闭时桌面行为与现状完全一致。</span></div>
            <SettingsSwitch ariaLabel="启用云端同步" checked={enabledDraft} onChange={setEnabledDraft} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>服务器地址</strong><span>云端同步服务根地址，例如 http://192.168.1.10:8787。</span></div>
            <SettingsInput value={baseUrlDraft} placeholder="http://..." aria-label="服务器地址" onChange={(event) => setBaseUrlDraft(event.target.value)} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>设备名</strong><span>手机端显示的设备名称。</span></div>
            <SettingsInput value={deviceNameDraft} placeholder="我的桌面" aria-label="设备名" onChange={(event) => setDeviceNameDraft(event.target.value)} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong>访问令牌（高级）</strong>
              <span>{config?.hasToken ? "已保存令牌；输入留空保存不会覆盖原值。" : "可选：直接填写服务器主令牌，适合运维场景。"}</span>
            </div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <SettingsPasswordInput value={tokenDraft} placeholder={config?.hasToken ? "已保存（留空不修改）" : "粘贴令牌"} autoComplete="new-password" showLabel="显示令牌" hideLabel="隐藏令牌" aria-label="访问令牌" onChange={(event) => setTokenDraft(event.target.value)} />
              {config?.hasToken && <Button danger loading={busy === "clearToken"} disabled={anyBusy && busy !== "clearToken"} onClick={clearToken}>清除 token</Button>}
              <Button type="primary" loading={busy === "save"} disabled={anyBusy && busy !== "save"} onClick={saveConnection}>保存</Button>
            </div>
          </div>
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><KeyRound size={18} />配对</h2><p>用服务器配对码兑换令牌，或为手机生成一次性配对码。</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>兑换配对码</strong><span>在服务器生成配对码后在此兑换（XXXX-XXXX）。</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <SettingsInput value={pairCodeDraft} placeholder="XXXX-XXXX" aria-label="配对码" onChange={(event) => setPairCodeDraft(event.target.value.toUpperCase())} />
              <Button type="primary" loading={busy === "pair"} disabled={!pairCodeDraft.trim() || (anyBusy && busy !== "pair")} onClick={redeemPairCode}>兑换</Button>
            </div>
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>生成配对码</strong><span>为手机端生成一次性配对码；需要已配对桌面。</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <Button loading={busy === "pairCode"} disabled={!config?.hasToken || (anyBusy && busy !== "pairCode")} onClick={generatePairCode}>生成配对码</Button>
            </div>
          </div>
          {generatedCode && (
            <div className="cy-settings-row">
              <div className="cy-settings-row__copy">
                <strong style={{ fontFamily: "monospace", fontSize: 18, letterSpacing: "0.08em" }}>{generatedCode.code}</strong>
                <span>到期时间：{formatDateTime(generatedCode.expiresAt)}；一次性使用。</span>
              </div>
              <Tag color="processing">待兑换</Tag>
            </div>
          )}
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Activity size={18} />状态</h2><p>同步进度与最近一次结果（只读快照）。</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>连接状态</strong><span>{connectionText}</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              <Button icon={<RefreshCw size={15} aria-hidden="true" />} loading={busy === "sync"} disabled={!status?.configured || (anyBusy && busy !== "sync")} onClick={syncNow}>立即同步</Button>
              <Button danger icon={<Unlink size={15} aria-hidden="true" />} loading={busy === "unpair"} disabled={!status?.hasToken || (anyBusy && busy !== "unpair")} onClick={unpair}>解除配对</Button>
            </div>
          </div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>启用状态</strong><span>{status?.enabled ? "已启用" : "未启用"}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>配置状态</strong><span>{status?.configured ? "已配置服务器与令牌" : "未配置"}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>上次同步</strong><span>{formatDateTime(status?.lastSyncAt ?? null)}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>待推送事件</strong><span>{status?.pendingCount ?? 0}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>拉取游标</strong><span>{status?.cursor ?? "尚未拉取"}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>本地 / 远端事件</strong><span>{status ? `${status.localEventCount} / ${status.remoteEventCount}` : "—"}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>协议设备 / 服务器设备</strong><span>{status ? `${status.deviceId ?? "—"} / ${status.serverDeviceId ?? "未配对"}` : "—"}</span></div></div>
          {lastError && (
            <div className="cy-settings-row">
              <Alert className="cy-settings-alert" type="error" showIcon message={errorText(lastError)} />
            </div>
          )}
        </Card>
      </section>
    </>}
  </>;
}
