import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Radio, Spin } from "antd";
import { BookOpen, Heart, Images } from "lucide-react";
import type { SettingsApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import { StickerManagerModal } from "./StickerManagerModal";
import { Card } from "../../components/ui/Card";

type RuntimeSync = "off" | "local" | "llm";
type StickerSize = "small" | "standard" | "large";
type Values = { runtimeSync: RuntimeSync; stickerEnabled: boolean; stickerSize: StickerSize; stickerSimilarityThreshold: number; embeddingDimensions?: number };
type Notice = { type: "success" | "error" | "info"; text: string };
type ExtendedSettingsApi = SettingsApi & { getRerankerStatus?: () => Promise<{ light: boolean; standard: boolean }> };

const defaults: Values = { runtimeSync: "off", stickerEnabled: true, stickerSize: "standard", stickerSimilarityThreshold: 0.55 };

function settingsApi(): ExtendedSettingsApi | undefined {
  return window.settings as unknown as ExtendedSettingsApi | undefined;
}

function readValues(config: Partial<Values>): Values {
  return {
    runtimeSync: config.runtimeSync === "local" || config.runtimeSync === "llm" ? config.runtimeSync : "off",
    stickerEnabled: config.stickerEnabled !== false,
    stickerSize: config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard",
    stickerSimilarityThreshold: typeof config.stickerSimilarityThreshold === "number" ? config.stickerSimilarityThreshold : 0.55,
    embeddingDimensions: typeof config.embeddingDimensions === "number" ? config.embeddingDimensions : undefined,
  };
}

export function CyreneSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(defaults);
  const [memoryMode, setMemoryMode] = useState<"vector" | "summary" | "off">("vector");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [embeddingInstalled, setEmbeddingInstalled] = useState<boolean | null>(null);
  const [rerankerInstalled, setRerankerInstalled] = useState<boolean | null>(null);
  const [rerankerMode, setRerankerMode] = useState(() => localStorage.getItem("cyrene.reranker.mode") === "none" ? "none" : "standard");
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

  /** 重新体检本地模型（embedding + reranker 安装状态）。 */
  function refreshModelStatus(): void {
    void settingsApi()?.getRerankerStatus?.().then((status) => setRerankerInstalled(status.standard)).catch(() => {});
    const modelConfig = (window as Window & { modelConfig?: { getModelInstallStatus?: () => Promise<{ embedding?: { bgem3?: boolean } }> } }).modelConfig;
    void modelConfig?.getModelInstallStatus?.().then((status) => setEmbeddingInstalled(Boolean(status.embedding?.bgem3))).catch(() => {});
  }

  useEffect(() => {
    let active = true;
    const api = settingsApi();
    if (!api) { setNotice({ type: "error", text: t("settingsPage.cyrene.unavailable") }); setLoading(false); return; }
    void api.getConfig().then((config) => { if (active) { setValues(readValues(config)); setMemoryMode(config.memoryMode === "summary" ? "summary" : config.memoryMode === "off" ? "off" : "vector"); setLoading(false); } }).catch(() => { if (active) { setNotice({ type: "error", text: t("settingsPage.cyrene.loadFailed") }); setLoading(false); } });
    void api.getRerankerStatus?.().then((status) => { if (active) setRerankerInstalled(status.standard); }).catch(() => {});
    void api.getGeneral().then((general) => {
      if (!active) return;
      setMirror((general as { ragDownloadMirror?: string } | undefined)?.ragDownloadMirror === "hf-mirror" ? "hf-mirror" : "official");
    }).catch(() => {});
    const modelConfig = (window as Window & { modelConfig?: { getModelInstallStatus?: () => Promise<{ embedding?: { bgem3?: boolean } }> } }).modelConfig;
    void modelConfig?.getModelInstallStatus?.().then((status) => { if (active) setEmbeddingInstalled(Boolean(status.embedding?.bgem3)); }).catch(() => {});
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

  async function selectReranker(mode: "standard" | "none") {
    const api = settingsApi();
    if (!api?.rerankerSetMode) return;
    try {
      const okay = await api.rerankerSetMode(mode);
      if (!okay) throw new Error("Reranker switch failed");
      localStorage.setItem("cyrene.reranker.mode", mode);
      setRerankerMode(mode);
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.rerankerFailed") }); }
  }

  async function selectEmbedding() {
    const api = settingsApi();
    if (!api?.embeddingSetModel) return;
    try {
      const result = await api.embeddingSetModel("bgem3");
      if (!result.ok) throw new Error(result.error);
      localStorage.setItem("cyrene.rag.model", "bgem3");
      setNotice({ type: "success", text: t("settingsPage.cyrene.embeddingSelected") });
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.embeddingFailed") }); }
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
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.threshold")}</strong><span>{t("settingsPage.cyrene.thresholdHint")}</span></div><div className="cy-settings-row__control cy-settings-slider"><SettingsSlider min={0.3} max={0.9} step={0.05} value={values.stickerSimilarityThreshold} ariaLabel={t("settingsPage.cyrene.threshold")} onChange={(value) => update("stickerSimilarityThreshold", value)} /><span>{values.stickerSimilarityThreshold.toFixed(2)}</span></div></div>
          <div className="cy-settings-row cy-cyrene-actions"><Button onClick={() => void openStickerManager()}>{t("settingsPage.cyrene.manageStickers")}</Button><Button onClick={openStickerDialog}>{t("settingsPage.cyrene.addSticker")}</Button></div>
        </Card>
      </section>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><BookOpen size={18} />{t("settingsPage.cyrene.retrievalTitle")}</h2><p>{t("settingsPage.cyrene.retrievalDescription")}</p></div>
        <Card>
          {memoryMode === "vector" && <>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingModel")}</strong><span>{t("settingsPage.cyrene.embeddingHint")}</span></div><Button className="cy-cyrene-model-choice" onClick={() => void selectEmbedding()}>BGE-M3 · {embeddingInstalled === null ? t("settingsPage.cyrene.unknown") : embeddingInstalled ? t("settingsPage.cyrene.installed") : t("settingsPage.cyrene.notInstalled")}</Button></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingDimensions")}</strong><span>{t("settingsPage.cyrene.embeddingDimensionsHint")}</span></div><SettingsInput className="cy-cyrene-dimensions" type="number" min={1} max={65536} value={values.embeddingDimensions ?? ""} placeholder={t("settingsPage.cyrene.autoDetect")} aria-label={t("settingsPage.cyrene.embeddingDimensions")} onChange={(event) => update("embeddingDimensions", event.target.value ? Number(event.target.value) : undefined)} /></div>
            <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.reranker")}</strong><span>{rerankerInstalled === null ? t("settingsPage.cyrene.unknown") : rerankerInstalled ? t("settingsPage.cyrene.installed") : t("settingsPage.cyrene.notInstalled")}</span></div><Radio.Group value={rerankerMode} optionType="button" buttonStyle="solid" onChange={(event) => void selectReranker(event.target.value as "standard" | "none")}><Radio.Button value="standard">bge-reranker-base</Radio.Button><Radio.Button value="none">{t("settingsPage.cyrene.off")}</Radio.Button></Radio.Group></div>
            <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.downloadMirror")}</strong><span>{t("settingsPage.cyrene.downloadMirrorHint")}</span></div><Radio.Group value={mirror} optionType="button" buttonStyle="solid" onChange={(event) => void selectMirror(event.target.value as "official" | "hf-mirror")}><Radio.Button value="official">{t("settingsPage.cyrene.mirrorOfficial")}</Radio.Button><Radio.Button value="hf-mirror">hf-mirror</Radio.Button></Radio.Group></div>
            <div className="cy-settings-row cy-cyrene-actions">
              <Button type="primary" loading={modelActionBusy === "open-model-downloader"} onClick={() => void runModelAction("open-model-downloader")}>{t("settingsPage.cyrene.downloadModel")}</Button>
              <Button loading={modelActionBusy === "open-dir"} onClick={() => void runModelAction("open-dir")}>{t("settingsPage.cyrene.openModelDir")}</Button>
              <Button loading={modelActionBusy === "open-docs"} onClick={() => void runModelAction("open-docs")}>{t("settingsPage.cyrene.openModelDocs")}</Button>
              <Button loading={modelActionBusy === "open-site"} onClick={() => void runModelAction("open-site")}>{t("settingsPage.cyrene.openModelSite")}</Button>
              <Button loading={modelActionBusy === "check-model-update"} onClick={() => void runModelAction("check-model-update")}>{t("settingsPage.cyrene.checkModelUpdate")}</Button>
              <Button danger loading={modelActionBusy === "delete-embedding"} onClick={() => void runModelAction("delete-embedding")}>{t("settingsPage.cyrene.deleteEmbedding")}</Button>
            </div>
          </>}
        </Card>
      </section>
      <div className="cy-settings-form-footer"><Button type="primary" loading={saving} onClick={() => void save()}>{t("settingsPage.cyrene.save")}</Button></div>
    </>}
    <Modal className="cy-settings-theme-modal" open={addOpen} title={t("settingsPage.cyrene.addSticker")} okText={t("settingsPage.cyrene.add")} cancelText={t("settingsPage.cyrene.cancel")} okButtonProps={{ loading: addBusy }} onOk={() => void addSticker()} onCancel={() => setAddOpen(false)} destroyOnHidden><div className="cy-cyrene-sticker-form">{addError && <Alert type="error" showIcon title={addError} />}<label><span>{t("settingsPage.cyrene.stickerFile")}</span><div className="cy-cyrene-sticker-file"><Button onClick={() => void pickStickerFile()}>{t("settingsPage.cyrene.chooseFile")}</Button><span>{pickedPath.split(/[\\/]/).pop() || t("settingsPage.cyrene.noFile")}</span></div></label><label><span>{t("settingsPage.cyrene.stickerId")}</span><SettingsInput value={stickerId} onChange={(event) => setStickerId(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerDescriptionField")}</span><SettingsInput value={stickerDescription} onChange={(event) => setStickerDescription(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerPhrases")}</span><Input.TextArea rows={3} value={stickerPhrases} onChange={(event) => setStickerPhrases(event.target.value)} /></label></div></Modal>
    <StickerManagerModal open={stickerManagerOpen} onClose={() => setStickerManagerOpen(false)} />
  </>;
}
