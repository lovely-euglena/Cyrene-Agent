import { useEffect, useState } from "react";
import { Alert, Button, Modal, Radio, Spin } from "antd";
import { FileText, Hash, Music, RefreshCw, SlidersHorizontal, Terminal } from "lucide-react";
import {
  normalizeChatSocialContextEnabled,
  normalizeMobileMessageSegmentationMode,
  normalizeProactiveChatMode,
  normalizeProactiveDeliveryTarget,
  type MobileMessageSegmentationMode,
  type ProactiveChatMode,
  type ProactiveDeliveryTarget,
} from "../../../../shared/preferences";
import {
  DEFAULT_CUSTOM_STYLE,
  normalizeCustomStyleConfig,
  type CustomStyleConfig,
  type DiversityPreference,
  type RepetitionLevel,
} from "../../../../shared/style-sampling";
import { isProactiveDeliveryTargetSelectable } from "../../../../shared/proactive-delivery";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSegmented, SettingsSelect, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import { Card } from "../../components/ui/Card";

type Liveliness = "quiet" | "natural" | "lively";

/** WSL 发行版下拉里「跟随 WSL 默认」的哨兵值（Radix Select 不接受空字符串 item）。 */
const WSL_DEFAULT_DISTRO = "__default__";

interface PreferencesValues {
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  customStyle: CustomStyleConfig;
  proactiveChatMode: ProactiveChatMode;
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  momentsEnabled: boolean;
  cyreneMomentsPostingEnabled: boolean;
  cyreneMomentsReactionsEnabled: boolean;
  momentsCharacterReactionsEnabled: boolean;
  momentsLiveliness: Liveliness;
  chatSocialContextEnabled: boolean;
  citaEnabled: boolean;
  /** 截图后端：内置 / Snipaste（宿主切换截图服务实现）。 */
  screenshotBackend: "builtin" | "snipaste";
  /** Snipaste 可执行文件路径（后端为 snipaste 时必填）。 */
  snipastePath: string;
  /** Pandoc 可执行文件路径；空 = 自动探测 PATH（文档转换）。 */
  pandocPath: string;
  /** 本地音乐 Agent 权限档（工具 fail-closed；音乐窗口亦可改）。 */
  musicAgentAccess: "off" | "read" | "control" | "manage";
  /** 精确 token 统计开关（默认关闭；词表按需下载到本地缓存）。 */
  tokenStatsEnabled: boolean;
  /** tokenizer 下载源偏好（下载管理在 .NET 宿主内完成）。 */
  tokenStatsSource: "modelscope" | "hf-mirror" | "huggingface";
  /** WSL 命令执行开关（默认关闭）。 */
  wslEnabled: boolean;
  /** 默认 WSL 发行版名；空字符串 = 使用 WSL 默认发行版。 */
  wslDistro: string;
}

type ChannelStatus = Record<string, { phase?: string }>;

const defaults: PreferencesValues = {
  mobileMessageSegmentation: "off",
  customStyle: DEFAULT_CUSTOM_STYLE,
  proactiveChatMode: "off",
  proactiveDeliveryTarget: "local",
  momentsEnabled: true,
  cyreneMomentsPostingEnabled: false,
  cyreneMomentsReactionsEnabled: true,
  momentsCharacterReactionsEnabled: true,
  momentsLiveliness: "quiet",
  chatSocialContextEnabled: false,
  citaEnabled: false,
  screenshotBackend: "builtin",
  snipastePath: "",
  pandocPath: "",
  musicAgentAccess: "read",
  tokenStatsEnabled: false,
  tokenStatsSource: "modelscope",
  wslEnabled: false,
  wslDistro: "",
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function readPreferences(value: unknown): PreferencesValues {
  const input = objectValue(value);
  const liveliness = input.momentsLiveliness;
  return {
    mobileMessageSegmentation: normalizeMobileMessageSegmentationMode(input.mobileMessageSegmentation),
    customStyle: normalizeCustomStyleConfig(input.customStyle),
    proactiveChatMode: normalizeProactiveChatMode(input.proactiveChatMode),
    proactiveDeliveryTarget: normalizeProactiveDeliveryTarget(input.proactiveDeliveryTarget),
    momentsEnabled: typeof input.momentsEnabled === "boolean" ? input.momentsEnabled : defaults.momentsEnabled,
    cyreneMomentsPostingEnabled: typeof input.cyreneMomentsPostingEnabled === "boolean" ? input.cyreneMomentsPostingEnabled : defaults.cyreneMomentsPostingEnabled,
    cyreneMomentsReactionsEnabled: typeof input.cyreneMomentsReactionsEnabled === "boolean" ? input.cyreneMomentsReactionsEnabled : defaults.cyreneMomentsReactionsEnabled,
    momentsCharacterReactionsEnabled: typeof input.momentsCharacterReactionsEnabled === "boolean" ? input.momentsCharacterReactionsEnabled : defaults.momentsCharacterReactionsEnabled,
    momentsLiveliness: liveliness === "natural" || liveliness === "lively" ? liveliness : "quiet",
    chatSocialContextEnabled: normalizeChatSocialContextEnabled(input.chatSocialContextEnabled),
    citaEnabled: input.citaEnabled === true,
    screenshotBackend: input.screenshotBackend === "snipaste" ? "snipaste" : "builtin",
    snipastePath: typeof input.snipastePath === "string" ? input.snipastePath : "",
    pandocPath: typeof input.pandocPath === "string" ? input.pandocPath : "",
    musicAgentAccess: input.musicAgentAccess === "off" || input.musicAgentAccess === "control" || input.musicAgentAccess === "manage"
      ? input.musicAgentAccess
      : "read",
    tokenStatsEnabled: input.tokenStatsEnabled === true,
    tokenStatsSource:
      input.tokenStatsSource === "hf-mirror" || input.tokenStatsSource === "huggingface"
        ? input.tokenStatsSource
        : "modelscope",
    wslEnabled: input.wslEnabled === true,
    wslDistro: typeof input.wslDistro === "string" ? input.wslDistro.trim() : "",
  };
}

function readChannelStatus(value: unknown): ChannelStatus {
  const input = objectValue(value);
  const output: ChannelStatus = {};
  for (const key of ["wechat", "feishu"]) {
    const item = objectValue(input[key]);
    output[key] = { phase: typeof item.phase === "string" ? item.phase : undefined };
  }
  return output;
}

export function PreferencesSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [channels, setChannels] = useState<ChannelStatus>({});
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleDraft, setStyleDraft] = useState<CustomStyleConfig>(DEFAULT_CUSTOM_STYLE);
  const [styleSaving, setStyleSaving] = useState(false);
  const [pandocDetecting, setPandocDetecting] = useState(false);
  const [pandocStatus, setPandocStatus] = useState("");
  const [wslExecutable, setWslExecutable] = useState<string | null>(null);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [wslDetecting, setWslDetecting] = useState(false);
  const [wslRestarting, setWslRestarting] = useState(false);
  const [wslRestartStatus, setWslRestartStatus] = useState("");

  useEffect(() => {
    let disposed = false;
    const api = window.settings;
    if (!api) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    void Promise.all([api.getGeneral(), api.channelsGetStatus().catch(() => ({}))])
      .then(([config, channelStatus]) => {
        if (disposed) return;
        const loaded = readPreferences(config);
        setValues(loaded);
        setChannels(readChannelStatus(channelStatus));
        setLoading(false);
        void runPandocDetect(loaded.pandocPath);
        void runWslDetect();
      })
      .catch(() => {
        if (disposed) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => { disposed = true; };
  }, []);

  function update<K extends keyof PreferencesValues>(key: K, value: PreferencesValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setStatus(t("settingsPage.preferences.unsaved"));
  }

  async function runPandocDetect(pandocPath: string) {
    const api = window.settings;
    if (!api?.detectPandoc) return;
    setPandocDetecting(true);
    try {
      const result = await api.detectPandoc(pandocPath.trim());
      setPandocStatus(result.ok
        ? t("settingsPage.preferences.pandocDetected", { version: result.version ?? "?" })
        : (result.error ?? t("settingsPage.preferences.pandocNotDetected")));
    } catch {
      setPandocStatus(t("settingsPage.preferences.pandocDetectFailed"));
    } finally {
      setPandocDetecting(false);
    }
  }

  async function runWslDetect() {
    const api = window.settings;
    if (!api?.detectWsl) return;
    setWslDetecting(true);
    try {
      const result = await api.detectWsl();
      setWslExecutable(result.executable ?? null);
      setWslDistros(Array.isArray(result.distros) ? result.distros : []);
    } catch {
      setWslExecutable(null);
      setWslDistros([]);
    } finally {
      setWslDetecting(false);
    }
  }

  async function runWslRestart() {
    const api = window.settings;
    if (!api?.restartWsl) return;
    setWslRestarting(true);
    setWslRestartStatus(t("settingsPage.preferences.wslRestarting"));
    try {
      const result = await api.restartWsl();
      setWslRestartStatus(result.ok ? t("settingsPage.preferences.wslRestartDone") : `${t("settingsPage.preferences.wslRestartFailed")}${result.error ? `：${result.error}` : ""}`);
      if (result.ok) await runWslDetect();
    } catch {
      setWslRestartStatus(t("settingsPage.preferences.wslRestartFailed"));
    } finally {
      setWslRestarting(false);
    }
  }

  async function savePreferences() {
    setSaving(true);
    setStatus(t("settingsPage.preferences.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const {
        citaEnabled,
        chatSocialContextEnabled,
        momentsEnabled,
        cyreneMomentsPostingEnabled,
        cyreneMomentsReactionsEnabled,
        momentsCharacterReactionsEnabled,
        momentsLiveliness,
        mobileMessageSegmentation,
        proactiveChatMode,
        proactiveDeliveryTarget,
        screenshotBackend,
        snipastePath,
        pandocPath,
        musicAgentAccess,
        tokenStatsEnabled,
        tokenStatsSource,
        wslEnabled,
        wslDistro,
      } = values;
      await window.settings.saveGeneral({
        citaEnabled,
        chatSocialContextEnabled,
        momentsEnabled,
        cyreneMomentsPostingEnabled,
        cyreneMomentsReactionsEnabled,
        momentsCharacterReactionsEnabled,
        momentsLiveliness,
        mobileMessageSegmentation,
        proactiveChatMode,
        proactiveDeliveryTarget,
        screenshotBackend,
        snipastePath: snipastePath.trim(),
        pandocPath: pandocPath.trim(),
        musicAgentAccess,
        tokenStatsEnabled,
        tokenStatsSource,
        wslEnabled,
        wslDistro: wslDistro.trim(),
      });
      setStatus(t("settingsPage.preferences.saved"));
    } catch {
      setStatus(t("settingsPage.preferences.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function openMusicWindow() {
    setStatus(t("settingsPage.preferences.musicOpening"));
    try {
      const ok = await window.settings?.openMusicWindow?.();
      setStatus(ok ? t("settingsPage.preferences.musicOpened") : t("settingsPage.preferences.musicOpenFailed"));
    } catch {
      setStatus(t("settingsPage.preferences.musicOpenFailed"));
    }
  }

  async function saveCustomStyle() {
    setStyleSaving(true);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const customStyle = normalizeCustomStyleConfig(styleDraft);
      await window.settings.saveGeneral({ customStyle });
      setValues((current) => ({ ...current, customStyle }));
      setStyleOpen(false);
      setStatus(t("settingsPage.preferences.customStyleSaved"));
    } catch {
      setStatus(t("settingsPage.preferences.saveFailed"));
    } finally {
      setStyleSaving(false);
    }
  }

  async function openCustomPrompt() {
    try {
      const result = objectValue(await window.settings?.openCustomStylePrompt());
      setStatus(result.ok === true
        ? t("settingsPage.preferences.promptOpened")
        : t("settingsPage.preferences.promptFailed"));
    } catch {
      setStatus(t("settingsPage.preferences.promptFailed"));
    }
  }

  function updateDiversity(driver: DiversityPreference["driver"]) {
    setStyleDraft((current) => ({
      ...current,
      diversity: driver === "model-default"
        ? { driver }
        : { driver, value: current.diversity.driver === driver ? current.diversity.value : driver === "temperature" ? 0.65 : 0.9 },
    }));
  }

  const diversity = styleDraft.diversity;
  const selectableTarget = (target: ProactiveDeliveryTarget) => isProactiveDeliveryTargetSelectable(target, channels[target]);
  const wslOptions = [
    { label: t("settingsPage.preferences.wslUseDefault"), value: WSL_DEFAULT_DISTRO },
    ...wslDistros.map((distro) => ({ label: distro, value: distro })),
  ];
  const wslStatus = wslExecutable === null
    ? t("settingsPage.preferences.wslNotDetected")
    : wslDistros.length === 0
      ? t("settingsPage.preferences.wslNoDistro")
      : t("settingsPage.preferences.wslDistroDescription");

  return (
    <>
      <h1>{t("settingsPage.preferences.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.preferences.description")}</p>
      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.preferences.loadFailed")} />}
      {loading ? <div className="cy-settings-loading"><Spin /></div> : (
        <>
          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><SlidersHorizontal size={18} />{t("settingsPage.preferences.messaging")}</h2><p>{t("settingsPage.preferences.messagingDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.mobileSegmentation")}</strong><span>{t("settingsPage.preferences.mobileSegmentationDescription")}</span></div>
                <SettingsSegmented value={values.mobileMessageSegmentation} options={[{ label: t("settingsPage.preferences.off"), value: "off" }, { label: t("settingsPage.preferences.on"), value: "on" }]} onChange={(value) => update("mobileMessageSegmentation", value as MobileMessageSegmentationMode)} />
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.customStyle")}</strong><span>{t("settingsPage.preferences.customStyleDescription")}</span></div>
                <div className="cy-settings-row__control cy-settings-button-group">
                  <Button onClick={() => { setStyleDraft(values.customStyle); setStyleOpen(true); }} icon={<SlidersHorizontal size={15} />}>{t("settingsPage.preferences.customStyleButton")}</Button>
                  <Button onClick={() => void openCustomPrompt()} icon={<FileText size={15} />}>{t("settingsPage.preferences.openPrompt")}</Button>
                </div>
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.proactiveChat")}</strong><span>{t("settingsPage.preferences.proactiveChatDescription")}</span></div>
                <SettingsSegmented value={values.proactiveChatMode} options={[{ label: t("settingsPage.preferences.off"), value: "off" }, { label: t("settingsPage.preferences.on"), value: "on" }]} onChange={(value) => update("proactiveChatMode", value as ProactiveChatMode)} />
              </div>
              {values.proactiveChatMode === "on" && <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.deliveryTarget")}</strong><span>{t("settingsPage.preferences.deliveryTargetDescription")}</span></div>
                <SettingsSegmented
                  value={values.proactiveDeliveryTarget}
                  options={([
                    { label: t("settingsPage.preferences.local"), value: "local" },
                    { label: t("settingsPage.preferences.wechat"), value: "wechat", disabled: !selectableTarget("wechat") },
                    { label: t("settingsPage.preferences.feishu"), value: "feishu", disabled: !selectableTarget("feishu") },
                  ])}
                  onChange={(value) => update("proactiveDeliveryTarget", value as ProactiveDeliveryTarget)}
                />
              </div>}
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2>{t("settingsPage.preferences.moments")}</h2><p>{t("settingsPage.preferences.momentsDescription")}</p></div>
            <Card>
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsEnabled")}</strong><span>{t("settingsPage.preferences.momentsEnabledDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsEnabled")} checked={values.momentsEnabled} onChange={(checked) => update("momentsEnabled", checked)} /></div>
              {values.momentsEnabled && <>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsPosting")}</strong><span>{t("settingsPage.preferences.momentsPostingDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsPosting")} checked={values.cyreneMomentsPostingEnabled} onChange={(checked) => update("cyreneMomentsPostingEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.momentsReactions")}</strong><span>{t("settingsPage.preferences.momentsReactionsDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.momentsReactions")} checked={values.cyreneMomentsReactionsEnabled} onChange={(checked) => update("cyreneMomentsReactionsEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.characterReactions")}</strong><span>{t("settingsPage.preferences.characterReactionsDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.characterReactions")} checked={values.momentsCharacterReactionsEnabled} onChange={(checked) => update("momentsCharacterReactionsEnabled", checked)} /></div>
                <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.liveliness")}</strong><span>{t("settingsPage.preferences.livelinessDescription")}</span></div><SettingsSegmented value={values.momentsLiveliness} options={[{ label: t("settingsPage.preferences.quiet"), value: "quiet" }, { label: t("settingsPage.preferences.natural"), value: "natural" }, { label: t("settingsPage.preferences.lively"), value: "lively" }]} onChange={(value) => update("momentsLiveliness", value as Liveliness)} /></div>
              </>}
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2>{t("settingsPage.preferences.context")}</h2><p>{t("settingsPage.preferences.contextDescription")}</p></div>
            <Card>
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.chatSocialContext")}</strong><span>{t("settingsPage.preferences.chatSocialContextDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.chatSocialContext")} checked={values.chatSocialContextEnabled} onChange={(checked) => update("chatSocialContextEnabled", checked)} /></div>
              <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.cita")}</strong><span>{t("settingsPage.preferences.citaDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.preferences.cita")} checked={values.citaEnabled} onChange={(checked) => update("citaEnabled", checked)} /></div>
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2>{t("settingsPage.preferences.screenshot")}</h2><p>{t("settingsPage.preferences.screenshotDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.screenshotBackend")}</strong><span>{t("settingsPage.preferences.screenshotBackendDescription")}</span></div>
                <SettingsSegmented value={values.screenshotBackend} options={[{ label: t("settingsPage.preferences.screenshotBuiltin"), value: "builtin" }, { label: "Snipaste", value: "snipaste" }]} onChange={(value) => update("screenshotBackend", value as "builtin" | "snipaste")} />
              </div>
              {values.screenshotBackend === "snipaste" && (
                <div className="cy-settings-row">
                  <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.snipastePath")}</strong><span>{t("settingsPage.preferences.snipastePathDescription")}</span></div>
                  <div className="cy-settings-row__control">
                    <SettingsInput value={values.snipastePath} placeholder="C:\\Program Files\\Snipaste\\Snipaste.exe" aria-label={t("settingsPage.preferences.snipastePath")} onChange={(event) => update("snipastePath", event.target.value)} />
                  </div>
                </div>
              )}
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><FileText size={18} />{t("settingsPage.preferences.documents")}</h2><p>{t("settingsPage.preferences.documentsDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.pandocPath")}</strong><span>{t("settingsPage.preferences.pandocPathDescription")}</span></div>
                <div className="cy-settings-row__control">
                  <SettingsInput value={values.pandocPath} placeholder="C:\\Program Files\\Pandoc\\pandoc.exe" aria-label={t("settingsPage.preferences.pandocPath")} onChange={(event) => update("pandocPath", event.target.value)} />
                </div>
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.pandocStatus")}</strong><span>{pandocStatus || t("settingsPage.preferences.pandocNotDetected")}</span></div>
                <div className="cy-settings-row__control cy-settings-button-group">
                  <Button loading={pandocDetecting} icon={<RefreshCw size={15} />} onClick={() => void runPandocDetect(values.pandocPath)}>{t("settingsPage.preferences.pandocDetect")}</Button>
                </div>
              </div>
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><Music size={18} />{t("settingsPage.preferences.music")}</h2><p>{t("settingsPage.preferences.musicDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.musicAgentAccess")}</strong><span>{t("settingsPage.preferences.musicAgentAccessDescription")}</span></div>
                <SettingsSegmented
                  value={values.musicAgentAccess}
                  options={[
                    { label: t("settingsPage.preferences.musicAccessOff"), value: "off" },
                    { label: t("settingsPage.preferences.musicAccessRead"), value: "read" },
                    { label: t("settingsPage.preferences.musicAccessControl"), value: "control" },
                    { label: t("settingsPage.preferences.musicAccessManage"), value: "manage" },
                  ]}
                  onChange={(value) => update("musicAgentAccess", value as PreferencesValues["musicAgentAccess"])}
                />
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.musicOpenWindow")}</strong><span>{t("settingsPage.preferences.musicOpenWindowDescription")}</span></div>
                <div className="cy-settings-row__control cy-settings-button-group">
                  <Button onClick={() => void openMusicWindow()}>{t("settingsPage.preferences.musicOpenWindow")}</Button>
                </div>
              </div>
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><Hash size={18} />{t("settingsPage.preferences.tokenStats")}</h2><p>{t("settingsPage.preferences.tokenStatsDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.tokenStatsEnabled")}</strong><span>{t("settingsPage.preferences.tokenStatsEnabledDescription")}</span></div>
                <SettingsSwitch checked={values.tokenStatsEnabled} ariaLabel={t("settingsPage.preferences.tokenStatsEnabled")} onChange={(checked) => update("tokenStatsEnabled", checked)} />
              </div>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.tokenStatsSource")}</strong><span>{t("settingsPage.preferences.tokenStatsSourceDescription")}</span></div>
                <SettingsSegmented
                  value={values.tokenStatsSource}
                  options={[
                    { label: "ModelScope", value: "modelscope" },
                    { label: "HF Mirror", value: "hf-mirror" },
                    { label: "HuggingFace", value: "huggingface" },
                  ]}
                  onChange={(value) => update("tokenStatsSource", value as PreferencesValues["tokenStatsSource"])}
                />
              </div>
            </Card>
          </section>

          <section className="cy-settings-section">
            <div className="cy-settings-section__heading"><h2><Terminal size={18} />{t("settingsPage.preferences.wsl")}</h2><p>{t("settingsPage.preferences.wslDescription")}</p></div>
            <Card>
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.wslEnabled")}</strong><span>{t("settingsPage.preferences.wslEnabledDescription")}</span></div>
                <SettingsSwitch checked={values.wslEnabled} ariaLabel={t("settingsPage.preferences.wslEnabled")} onChange={(checked) => update("wslEnabled", checked)} />
              </div>
              {values.wslEnabled && (
                <div className="cy-settings-row">
                  <div className="cy-settings-row__copy"><strong>{t("settingsPage.preferences.wslDistro")}</strong><span>{wslStatus}</span></div>
                  <div className="cy-settings-row__control cy-settings-button-group">
                    <SettingsSelect
                      value={values.wslDistro || WSL_DEFAULT_DISTRO}
                      options={wslOptions}
                      onChange={(value) => update("wslDistro", value === WSL_DEFAULT_DISTRO ? "" : value)}
                      ariaLabel={t("settingsPage.preferences.wslDistro")}
                      disabled={wslDistros.length === 0}
                    />
                    <Button loading={wslDetecting} icon={<RefreshCw size={15} />} onClick={() => void runWslDetect()}>{t("settingsPage.preferences.wslDetect")}</Button>
                  </div>
                </div>
              )}
              {values.wslEnabled && (
                <div className="cy-settings-row">
                  <div className="cy-settings-row__copy">
                    <strong>{t("settingsPage.preferences.wslRestart")}</strong>
                    <span>{wslRestartStatus || t("settingsPage.preferences.wslRestartDescription")}</span>
                  </div>
                  <div className="cy-settings-row__control cy-settings-button-group">
                    <Button loading={wslRestarting} icon={<RefreshCw size={15} />} onClick={() => void runWslRestart()}>{t("settingsPage.preferences.wslRestart")}</Button>
                  </div>
                </div>
              )}
            </Card>
          </section>

          <div className="cy-settings-preferences-actions">
            <div className="cy-settings-status" role="status" aria-live="polite">{status || t("settingsPage.preferences.unsaved")}</div>
            <Button type="primary" loading={saving} onClick={() => void savePreferences()}>{t("settingsPage.preferences.save")}</Button>
          </div>
        </>
      )}

      <Modal
        rootClassName="cy-settings-theme-modal"
        title={t("settingsPage.preferences.customStyleModalTitle")}
        open={styleOpen}
        onCancel={() => setStyleOpen(false)}
        footer={[
          <Button key="reset" onClick={() => setStyleDraft(DEFAULT_CUSTOM_STYLE)}>{t("settingsPage.preferences.reset")}</Button>,
          <Button key="cancel" onClick={() => setStyleOpen(false)}>{t("settingsPage.preferences.cancel")}</Button>,
          <Button key="save" type="primary" loading={styleSaving} onClick={() => void saveCustomStyle()}>{t("settingsPage.preferences.save")}</Button>,
        ]}
      >
        <div className="cy-settings-style-section">
          <strong>{t("settingsPage.preferences.diversity")}</strong>
          <Radio.Group value={diversity.driver} onChange={(event) => updateDiversity(event.target.value)} optionType="button" buttonStyle="solid">
            <Radio.Button value="model-default">{t("settingsPage.preferences.followModel")}</Radio.Button>
            <Radio.Button value="temperature">Temperature</Radio.Button>
            <Radio.Button value="top-p">Top-P</Radio.Button>
          </Radio.Group>
          {diversity.driver !== "model-default" && <div className="cy-settings-style-value">
            <SettingsSlider min={0} max={diversity.driver === "top-p" ? 1 : 2} step={0.01} value={diversity.value} ariaLabel={t("settingsPage.preferences.diversity")} onChange={(value) => setStyleDraft((current) => ({ ...current, diversity: { ...current.diversity, value } }))} />
            <SettingsInput type="number" min={0} max={diversity.driver === "top-p" ? 1 : 2} step={0.01} value={diversity.value} aria-label={t("settingsPage.preferences.diversity")} onChange={(event) => setStyleDraft((current) => ({ ...current, diversity: { ...current.diversity, value: Number(event.target.value || 0) } }))} />
          </div>}
        </div>
        <div className="cy-settings-style-section">
          <strong>{t("settingsPage.preferences.repetition")}</strong>
          <Radio.Group value={styleDraft.repetition} onChange={(event) => setStyleDraft((current) => ({ ...current, repetition: event.target.value as RepetitionLevel }))} optionType="button" buttonStyle="solid">
            <Radio.Button value="model-default">{t("settingsPage.preferences.followModel")}</Radio.Button>
            <Radio.Button value="light">{t("settingsPage.preferences.light")}</Radio.Button>
            <Radio.Button value="medium">{t("settingsPage.preferences.medium")}</Radio.Button>
            <Radio.Button value="strong">{t("settingsPage.preferences.strong")}</Radio.Button>
          </Radio.Group>
        </div>
      </Modal>
    </>
  );
}
