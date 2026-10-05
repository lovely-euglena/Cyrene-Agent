import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Radio, Spin } from "antd";
import { BookOpen, Heart, Images } from "lucide-react";
import type { ModelSettings, SettingsApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import { StickerManagerModal } from "./StickerManagerModal";
import { Card } from "../../components/ui/Card";

type RuntimeSync = "off" | "local" | "llm";
type StickerSize = "small" | "standard" | "large";
type EmbeddingModelKey = "bgem3" | "e5-small";
type RerankerMode = "standard" | "v2-m3" | "none";
type Values = { runtimeSync: RuntimeSync; stickerEnabled: boolean; stickerSize: StickerSize; stickerMatchMode: "embedding" | "text"; stickerSimilarityThreshold: number; embeddingDimensions?: number };
type Notice = { type: "success" | "error" | "info"; text: string };
type InstallStatus = {
  embedding: { bgem3: boolean; e5: boolean };
  reranker: { standard: boolean; v2m3: boolean };
};
type SwitchPrompt = { model: EmbeddingModelKey; requires: "rebuild" | "clear" };
type ExtendedSettingsApi = SettingsApi & {
  getRerankerStatus?: () => Promise<{ standard: boolean; "v2-m3": boolean }>;
};

const defaults: Values = { runtimeSync: "off", stickerEnabled: true, stickerSize: "standard", stickerMatchMode: "embedding", stickerSimilarityThreshold: 0.55 };

function settingsApi(): ExtendedSettingsApi | undefined {
  return window.settings as unknown as ExtendedSettingsApi | undefined;
}

function embeddingLabel(model: EmbeddingModelKey): string {
  return model === "e5-small" ? "Multilingual-E5-Small" : "BGE-M3";
}

function rerankerLabel(mode: RerankerMode): string {
  return mode === "v2-m3" ? "bge-reranker-v2-m3" : mode === "standard" ? "bge-reranker-base" : "";
}

function readEmbeddingModel(value: unknown): EmbeddingModelKey {
  return value === "e5-small" ? "e5-small" : "bgem3";
}

function readRerankerMode(value: unknown): RerankerMode {
  return value === "none" || value === "v2-m3" ? value : "standard";
}

function readValues(config: Partial<Values>): Values {
  return {
    runtimeSync: config.runtimeSync === "local" || config.runtimeSync === "llm" ? config.runtimeSync : "off",
    stickerEnabled: config.stickerEnabled !== false,
    stickerSize: config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard",
    stickerMatchMode: config.stickerMatchMode === "text" ? "text" : "embedding",
    stickerSimilarityThreshold: typeof config.stickerSimilarityThreshold === "number" ? config.stickerSimilarityThreshold : 0.55,
    embeddingDimensions: typeof config.embeddingDimensions === "number" ? config.embeddingDimensions : undefined,
  };
}

export function CyreneSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(defaults);
  const [memoryMode, setMemoryMode] = useState<ModelSettings["memoryMode"]>("vector");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [installStatus, setInstallStatus] = useState<InstallStatus | null>(null);
  const [embeddingModel, setEmbeddingModel] = useState<EmbeddingModelKey>(() => readEmbeddingModel(localStorage.getItem("cyrene.rag.model")));
  const [rerankerMode, setRerankerMode] = useState<RerankerMode>(() => readRerankerMode(localStorage.getItem("cyrene.reranker.mode")));
  /** 索引迁移确认（rebuild-required 时出现）：重建 / 清空 / 取消 */
  const [switchPrompt, setSwitchPrompt] = useState<SwitchPrompt | null>(null);
  /** 模型切换进行中："" | "switch"（直接切换）| "rebuild" | "clear"（迁移动作） */
  const [switchBusy, setSwitchBusy] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [stickerManagerOpen, setStickerManagerOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [pickedPath, setPickedPath] = useState("");
  const [stickerId, setStickerId] = useState("");
  const [stickerDescription, setStickerDescription] = useState("");
  const [stickerPhrases, setStickerPhrases] = useState("");
  // RAG 下载镜像（general.ragDownloadMirror；与 native 昔涟 section 同键）
  const [mirror, setMirror] = useState<"official" | "hf-mirror">("official");
  // 模型操作进行中的 verb（按钮 loading；同时只允许一个操作）
  const [modelActionBusy, setModelActionBusy] = useState("");

  /** 重新体检本地模型（bgem3 / e5-small / 两个 reranker 的安装状态）。 */
  function refreshModelStatus(): void {
    const modelConfig = (window as Window & {
      modelConfig?: {
        getModelInstallStatus?: () => Promise<{
          embedding?: { bgem3?: boolean; "e5-small"?: boolean };
          reranker?: { standard?: boolean; "v2-m3"?: boolean };
        }>;
      };
    }).modelConfig;
    void modelConfig?.getModelInstallStatus?.().then((status) => {
      setInstallStatus({
        embedding: { bgem3: Boolean(status.embedding?.bgem3), e5: Boolean(status.embedding?.["e5-small"]) },
        reranker: { standard: Boolean(status.reranker?.standard), v2m3: Boolean(status.reranker?.["v2-m3"]) },
      });
    }).catch(() => {});
  }

  useEffect(() => {
    let active = true;
    const api = settingsApi();
    if (!api) { setNotice({ type: "error", text: t("settingsPage.cyrene.unavailable") }); setLoading(false); return; }
    void api.getConfig().then((config) => {
      if (!active) return;
      setValues(readValues(config));
      setMemoryMode(config.memoryMode === "summary" || config.memoryMode === "wiki" || config.memoryMode === "off" ? config.memoryMode : "vector");
      const model = readEmbeddingModel(config.embeddingModel);
      setEmbeddingModel(model);
      localStorage.setItem("cyrene.rag.model", model);
      const reranker = readRerankerMode(config.rerankerMode);
      setRerankerMode(reranker);
      localStorage.setItem("cyrene.reranker.mode", reranker);
      setLoading(false);
    }).catch(() => { if (active) { setNotice({ type: "error", text: t("settingsPage.cyrene.loadFailed") }); setLoading(false); } });
    void api.getGeneral().then((general) => {
      if (!active) return;
      setMirror((general as { ragDownloadMirror?: string } | undefined)?.ragDownloadMirror === "hf-mirror" ? "hf-mirror" : "official");
    }).catch(() => {});
    const modelConfig = (window as Window & {
      modelConfig?: {
        getModelInstallStatus?: () => Promise<{
          embedding?: { bgem3?: boolean; "e5-small"?: boolean };
          reranker?: { standard?: boolean; "v2-m3"?: boolean };
        }>;
      };
    }).modelConfig;
    void modelConfig?.getModelInstallStatus?.().then((status) => {
      if (!active) return;
      setInstallStatus({
        embedding: { bgem3: Boolean(status.embedding?.bgem3), e5: Boolean(status.embedding?.["e5-small"]) },
        reranker: { standard: Boolean(status.reranker?.standard), v2m3: Boolean(status.reranker?.["v2-m3"]) },
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [t]);

  function update<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setNotice(null);
    if (key === "runtimeSync") settingsApi()?.previewRuntimeSync(value as RuntimeSync);
  }

  async function save() {
    const api = settingsApi();
    if (!api) return;
    setSaving(true);
    try {
      await api.saveConfig({ ...values, embeddingDimensions: values.embeddingDimensions && values.embeddingDimensions > 0 ? Math.min(65536, Math.round(values.embeddingDimensions)) : undefined });
      setNotice({ type: "success", text: t("settingsPage.cyrene.saved") });
    } catch {
      try {
        const persisted = await api.getConfig();
        setValues(readValues(persisted));
      } catch { /* keep the current form if config reload also fails */ }
      setNotice({ type: "error", text: t("settingsPage.cyrene.saveFailed") });
    }
    finally { setSaving(false); }
  }

  async function openStickerManager() {
    setStickerManagerOpen(true);
  }

  async function pickStickerFile() {
    try {
      const path = await settingsApi()?.stickerPickFile?.();
      if (!path) return;
      setPickedPath(path);
      if (!stickerId) setStickerId((path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, ""));
    } catch { setAddError(t("settingsPage.cyrene.pickFailed")); }
  }

  async function addSticker() {
    const api = settingsApi();
    const id = stickerId.trim();
    const description = stickerDescription.trim();
    const phrases = stickerPhrases.split("\n").map((part) => part.trim()).filter(Boolean);
    if (!pickedPath || !/^[a-zA-Z0-9_-]+$/.test(id) || !description || !phrases.length) {
      setAddError(t("settingsPage.cyrene.stickerInvalid"));
      return;
    }
    if (!api?.stickerAdd) return;
    setAddError("");
    setAddBusy(true);
    try {
      const result = await api.stickerAdd({ sourcePath: pickedPath, id, description, phrases });
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error("Sticker add failed");
      setAddOpen(false);
      setPickedPath(""); setStickerId(""); setStickerDescription(""); setStickerPhrases("");
      setNotice({ type: "success", text: t("settingsPage.cyrene.stickerAdded") });
    } catch { setAddError(t("settingsPage.cyrene.stickerAddFailed")); }
    finally { setAddBusy(false); }
  }

  function openStickerDialog() {
    setPickedPath("");
    setStickerId("");
    setStickerDescription("");
    setStickerPhrases("");
    setAddError("");
    setAddOpen(true);
  }

  async function selectReranker(mode: RerankerMode) {
    const api = settingsApi();
    if (!api?.rerankerSetMode || mode === rerankerMode || switchBusy) return;
    try {
      const okay = await api.rerankerSetMode(mode);
      if (!okay) throw new Error("Reranker switch failed");
      localStorage.setItem("cyrene.reranker.mode", mode);
      setRerankerMode(mode);
      setNotice({ type: "success", text: t("settingsPage.cyrene.rerankerSelected", { name: mode === "none" ? t("settingsPage.cyrene.off") : rerankerLabel(mode) }) });
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.rerankerFailed") }); }
  }

  /** Embedding 切换：无 action 先试；rebuild-required → 弹迁移确认，选动作后带 action 重发。 */
  async function selectEmbedding(model: EmbeddingModelKey) {
    if (model === embeddingModel || switchBusy) return;
    await runEmbeddingSwitch(model);
  }

  async function runEmbeddingSwitch(model: EmbeddingModelKey, action?: "rebuild" | "clear") {
    const api = settingsApi();
    if (!api?.embeddingSetModel || switchBusy) return;
    setSwitchBusy(action ?? "switch");
    try {
      const result = await api.embeddingSetModel(model, action);
      if (!result.ok) {
        if (result.reason === "rebuild-required") {
          setSwitchPrompt({ model, requires: result.requires ?? "rebuild" });
          return;
        }
        throw new Error(result.error ?? "Embedding switch failed");
      }
      localStorage.setItem("cyrene.rag.model", model);
      setEmbeddingModel(model);
      setSwitchPrompt(null);
      refreshModelStatus();
      const detail = result.rebuiltEntries
        ? ` ${t("settingsPage.cyrene.rebuildDone", { count: result.rebuiltEntries })}`
        : result.clearedEntries
          ? ` ${t("settingsPage.cyrene.clearDone", { count: result.clearedEntries })}`
          : "";
      setNotice({ type: "success", text: t("settingsPage.cyrene.embeddingSelected", { name: embeddingLabel(model) }) + detail });
    } catch {
      setSwitchPrompt(null);
      setNotice({ type: "error", text: t("settingsPage.cyrene.embeddingFailed") });
    } finally {
      setSwitchBusy("");
    }
  }

  /** 迁移确认按钮：带 action 重发（保留弹窗 loading，成功后由 runEmbeddingSwitch 关闭）。 */
  async function confirmEmbeddingSwitch(action: "rebuild" | "clear") {
    const prompt = switchPrompt;
    if (!prompt || switchBusy) return;
    await runEmbeddingSwitch(prompt.model, action);
  }

  /** RAG 下载镜像：即时保存（general.ragDownloadMirror；与 native 同键）。 */
  async function selectMirror(value: "official" | "hf-mirror") {
    if (value === mirror) return;
    const previous = mirror;
    setMirror(value);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({ ragDownloadMirror: value });
      setNotice({ type: "success", text: t("settingsPage.cyrene.mirrorSaved") });
    } catch {
      setMirror(previous);
      setNotice({ type: "error", text: t("settingsPage.cyrene.saveFailed") });
    }
  }

  /** RAG 模型操作入口：删除缓存先 antd Modal 二次确认（渲染端禁用浏览器 confirm）。 */
  function runModelAction(verb: "open-docs" | "open-dir" | "open-site" | "open-model-downloader" | "check-model-update" | "delete-embedding"): void {
    if (modelActionBusy) return;
    if (verb === "delete-embedding") {
      Modal.confirm({
        title: t("settingsPage.cyrene.deleteEmbedding"),
        content: t("settingsPage.cyrene.deleteEmbeddingConfirm"),
        okText: t("settingsPage.cyrene.deleteEmbedding"),
        okButtonProps: { danger: true },
        cancelText: t("settingsPage.cyrene.cancel"),
        onOk: () => executeModelAction(verb),
      });
      return;
    }
    void executeModelAction(verb);
  }

  /** RAG 模型操作执行：打开目录/说明/下载站、体检、删除缓存（宿主 settings:cyrene-model-action）。 */
  async function executeModelAction(verb: "open-docs" | "open-dir" | "open-site" | "open-model-downloader" | "check-model-update" | "delete-embedding"): Promise<void> {
    const api = window.settings;
    if (!api?.cyreneModelAction || modelActionBusy) return;
    setModelActionBusy(verb);
    try {
      const result = await api.cyreneModelAction(verb);
      setNotice(result.ok
        ? { type: "success", text: result.message ?? t("settingsPage.cyrene.modelActionDone") }
        : { type: "error", text: result.error ?? t("settingsPage.cyrene.modelActionFailed") });
      if (verb === "check-model-update" || verb === "delete-embedding") refreshModelStatus();
    } catch {
      setNotice({ type: "error", text: t("settingsPage.cyrene.modelActionFailed") });
    } finally {
      setModelActionBusy("");
    }
  }

  /** 安装状态文案（embedding 按模型；reranker 按档位）。 */
  function embeddingStatusText(key: EmbeddingModelKey): string {
    if (!installStatus) return t("settingsPage.cyrene.unknown");
    return installStatus.embedding[key === "e5-small" ? "e5" : "bgem3"]
      ? t("settingsPage.cyrene.installed")
      : t("settingsPage.cyrene.notInstalled");
  }

  function rerankerStatusText(key: "standard" | "v2-m3"): string {
    if (!installStatus) return t("settingsPage.cyrene.unknown");
    return installStatus.reranker[key === "v2-m3" ? "v2m3" : "standard"]
      ? t("settingsPage.cyrene.installed")
      : t("settingsPage.cyrene.notInstalled");
  }

  return <>
    <h1>{t("settingsPage.cyrene.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.cyrene.description")}</p>
    {notice && <Alert className="cy-settings-alert" showIcon type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><Heart size={18} />{t("settingsPage.cyrene.runtimeTitle")}</h2><p>{t("settingsPage.cyrene.runtimeDescription")}</p></div>
        <Card><div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.runtimeMode")}</strong><span>{t("settingsPage.cyrene.runtimeHint")}</span></div><Radio.Group value={values.runtimeSync} optionType="button" buttonStyle="solid" onChange={(event) => update("runtimeSync", event.target.value as RuntimeSync)}><Radio.Button value="off">{t("settingsPage.cyrene.off")}</Radio.Button><Radio.Button value="local">{t("settingsPage.cyrene.local")}</Radio.Button><Radio.Button value="llm">{t("settingsPage.cyrene.llm")}</Radio.Button></Radio.Group></div>{values.runtimeSync === "llm" && <div className="cy-settings-row cy-cyrene-note">{t("settingsPage.cyrene.llmCost")}</div>}</Card>
      </section>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><Images size={18} />{t("settingsPage.cyrene.stickerTitle")}</h2><p>{t("settingsPage.cyrene.stickerDescription")}</p></div>
        <Card><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.stickerEnabled")}</strong><span>{t("settingsPage.cyrene.stickerEnabledHint")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.cyrene.stickerEnabled")} checked={values.stickerEnabled} onChange={(checked) => update("stickerEnabled", checked)} /></div>
          <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.stickerSize")}</strong></div><Radio.Group value={values.stickerSize} optionType="button" buttonStyle="solid" onChange={(event) => update("stickerSize", event.target.value as StickerSize)}><Radio.Button value="small">{t("settingsPage.cyrene.small")}</Radio.Button><Radio.Button value="standard">{t("settingsPage.cyrene.standard")}</Radio.Button><Radio.Button value="large">{t("settingsPage.cyrene.large")}</Radio.Button></Radio.Group></div>
          <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.stickerMatchMode")}</strong><span>{t("settingsPage.cyrene.stickerMatchModeHint")}</span></div><Radio.Group value={values.stickerMatchMode} optionType="button" buttonStyle="solid" onChange={(event) => update("stickerMatchMode", event.target.value as "embedding" | "text")}><Radio.Button value="embedding">{t("settingsPage.cyrene.stickerMatchEmbedding")}</Radio.Button><Radio.Button value="text">{t("settingsPage.cyrene.stickerMatchText")}</Radio.Button></Radio.Group></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.threshold")}</strong><span>{t("settingsPage.cyrene.thresholdHint")}</span></div><div className="cy-settings-row__control cy-settings-slider"><SettingsSlider min={0.3} max={0.9} step={0.05} value={values.stickerSimilarityThreshold} ariaLabel={t("settingsPage.cyrene.threshold")} onChange={(value) => update("stickerSimilarityThreshold", value)} /><span>{values.stickerSimilarityThreshold.toFixed(2)}</span></div></div>
          <div className="cy-settings-row cy-cyrene-actions"><Button onClick={() => void openStickerManager()}>{t("settingsPage.cyrene.manageStickers")}</Button><Button onClick={openStickerDialog}>{t("settingsPage.cyrene.addSticker")}</Button></div>
        </Card>
      </section>
      {memoryMode === "vector" && <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><BookOpen size={18} />{t("settingsPage.cyrene.retrievalTitle")}</h2><p>{t("settingsPage.cyrene.retrievalDescription")}</p></div>
        <Card>
            <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingModel")}</strong><span>{t("settingsPage.cyrene.embeddingHint")}</span></div><Radio.Group value={embeddingModel} optionType="button" buttonStyle="solid" disabled={switchBusy !== ""} onChange={(event) => void selectEmbedding(event.target.value as EmbeddingModelKey)}><Radio.Button value="bgem3">BGE-M3 · 1024 · {embeddingStatusText("bgem3")}</Radio.Button><Radio.Button value="e5-small">E5-Small · 384 · {embeddingStatusText("e5-small")}</Radio.Button></Radio.Group></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingDimensions")}</strong><span>{embeddingModel === "e5-small" ? t("settingsPage.cyrene.e5DimensionsHint") : t("settingsPage.cyrene.embeddingDimensionsHint")}</span></div><SettingsInput className="cy-cyrene-dimensions" type="number" min={1} max={65536} disabled={embeddingModel === "e5-small"} value={embeddingModel === "e5-small" ? 384 : values.embeddingDimensions ?? ""} placeholder={t("settingsPage.cyrene.autoDetect")} aria-label={t("settingsPage.cyrene.embeddingDimensions")} onChange={(event) => update("embeddingDimensions", event.target.value ? Number(event.target.value) : undefined)} /></div>
            <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.reranker")}</strong><span>{rerankerMode === "none" ? t("settingsPage.cyrene.noModelNeeded") : rerankerStatusText(rerankerMode)}</span></div><Radio.Group value={rerankerMode} optionType="button" buttonStyle="solid" disabled={switchBusy !== ""} onChange={(event) => void selectReranker(event.target.value as RerankerMode)}><Radio.Button value="standard">bge-reranker-base · {rerankerStatusText("standard")}</Radio.Button><Radio.Button value="v2-m3">bge-reranker-v2-m3 · {rerankerStatusText("v2-m3")}</Radio.Button><Radio.Button value="none">{t("settingsPage.cyrene.off")}</Radio.Button></Radio.Group></div>
            <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.downloadMirror")}</strong><span>{t("settingsPage.cyrene.downloadMirrorHint")}</span></div><Radio.Group value={mirror} optionType="button" buttonStyle="solid" onChange={(event) => void selectMirror(event.target.value as "official" | "hf-mirror")}><Radio.Button value="official">{t("settingsPage.cyrene.mirrorOfficial")}</Radio.Button><Radio.Button value="hf-mirror">hf-mirror</Radio.Button></Radio.Group></div>
            <div className="cy-settings-row cy-cyrene-actions">
              <Button type="primary" loading={modelActionBusy === "open-model-downloader"} onClick={() => void runModelAction("open-model-downloader")}>{t("settingsPage.cyrene.downloadModel")}</Button>
              <Button loading={modelActionBusy === "open-dir"} onClick={() => void runModelAction("open-dir")}>{t("settingsPage.cyrene.openModelDir")}</Button>
              <Button loading={modelActionBusy === "open-docs"} onClick={() => void runModelAction("open-docs")}>{t("settingsPage.cyrene.openModelDocs")}</Button>
              <Button loading={modelActionBusy === "open-site"} onClick={() => void runModelAction("open-site")}>{t("settingsPage.cyrene.openModelSite")}</Button>
              <Button loading={modelActionBusy === "check-model-update"} onClick={() => void runModelAction("check-model-update")}>{t("settingsPage.cyrene.checkModelUpdate")}</Button>
              <Button danger loading={modelActionBusy === "delete-embedding"} onClick={() => void runModelAction("delete-embedding")}>{t("settingsPage.cyrene.deleteEmbedding")}</Button>
            </div>
        </Card>
      </section>}
      <div className="cy-settings-form-footer"><Button type="primary" loading={saving} onClick={() => void save()}>{t("settingsPage.cyrene.save")}</Button></div>
    </>}
    <Modal className="cy-settings-theme-modal" open={addOpen} title={t("settingsPage.cyrene.addSticker")} okText={t("settingsPage.cyrene.add")} cancelText={t("settingsPage.cyrene.cancel")} okButtonProps={{ loading: addBusy }} onOk={() => void addSticker()} onCancel={() => setAddOpen(false)} destroyOnHidden><div className="cy-cyrene-sticker-form">{addError && <Alert type="error" showIcon title={addError} />}<label><span>{t("settingsPage.cyrene.stickerFile")}</span><div className="cy-cyrene-sticker-file"><Button onClick={() => void pickStickerFile()}>{t("settingsPage.cyrene.chooseFile")}</Button><span>{pickedPath.split(/[\\/]/).pop() || t("settingsPage.cyrene.noFile")}</span></div></label><label><span>{t("settingsPage.cyrene.stickerId")}</span><SettingsInput value={stickerId} onChange={(event) => setStickerId(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerDescriptionField")}</span><SettingsInput value={stickerDescription} onChange={(event) => setStickerDescription(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerPhrases")}</span><Input.TextArea rows={3} value={stickerPhrases} onChange={(event) => setStickerPhrases(event.target.value)} /></label></div></Modal>
    <StickerManagerModal open={stickerManagerOpen} onClose={() => setStickerManagerOpen(false)} />
    <Modal
      open={switchPrompt !== null}
      title={t("settingsPage.cyrene.migrateTitle")}
      onCancel={() => { if (!switchBusy) setSwitchPrompt(null); }}
      maskClosable={false}
      destroyOnHidden
      footer={[
        <Button key="cancel" disabled={switchBusy !== ""} onClick={() => setSwitchPrompt(null)}>{t("settingsPage.cyrene.cancel")}</Button>,
        <Button key="clear" danger disabled={switchBusy !== ""} loading={switchBusy === "clear"} onClick={() => void confirmEmbeddingSwitch("clear")}>{t("settingsPage.cyrene.migrateClear")}</Button>,
        <Button key="rebuild" type="primary" disabled={switchBusy !== ""} loading={switchBusy === "rebuild"} onClick={() => void confirmEmbeddingSwitch("rebuild")}>{t("settingsPage.cyrene.migrateRebuild")}</Button>,
      ]}
    >
      <p>{switchPrompt?.requires === "clear" ? t("settingsPage.cyrene.migrateClearHint") : t("settingsPage.cyrene.migrateRebuildHint")}</p>
      {switchBusy === "rebuild" && <p>{t("settingsPage.cyrene.migrateRebuildRunning")}</p>}
    </Modal>
  </>;
}
