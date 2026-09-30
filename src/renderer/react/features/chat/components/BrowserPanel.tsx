import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LoaderCircle, RotateCw, Square, X } from "lucide-react";
import { useTranslation } from "../../../i18n";
import type { BrowserPanelState } from "../../../../../shared/browser-panel-types";
import "./BrowserPanel.css";

const EMPTY_STATE: BrowserPanelState = {
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  crashed: false,
};

export function BrowserPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const hostRef = useRef<HTMLDivElement>(null);
  const lastStateUrlRef = useRef("");
  const [state, setState] = useState(EMPTY_STATE);
  const [address, setAddress] = useState("");
  const [commandError, setCommandError] = useState("");

  useEffect(() => {
    const api = window.browserPanel;
    if (!api) return;
    let mounted = true;
    const unsubscribe = api.onStateChanged((next) => {
      if (!mounted) return;
      setState(next);
      if (next.url !== lastStateUrlRef.current) {
        lastStateUrlRef.current = next.url;
        setAddress(next.url);
      }
    });
    void api.getState().then((next) => {
      if (mounted && next) {
        setState(next);
        if (next.url !== lastStateUrlRef.current) {
          lastStateUrlRef.current = next.url;
          setAddress(next.url);
        }
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
      void api.setBounds(null);
    };
  }, []);

  useLayoutEffect(() => {
    const api = window.browserPanel;
    const host = hostRef.current;
    if (!api || !host || !active) {
      if (api) void api.setBounds(null);
      return;
    }
    const update = () => {
      const rect = host.getBoundingClientRect();
      void api.setBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    const inspector = host.closest(".cy-right-inspector");
    let frame = 0;
    const startedAt = performance.now();
    const trackEntranceAnimation = () => {
      update();
      if (performance.now() - startedAt < 260) frame = requestAnimationFrame(trackEntranceAnimation);
    };
    const onAnimationEnd = () => update();
    const observer = new ResizeObserver(update);
    observer.observe(host);
    inspector?.addEventListener("animationend", onAnimationEnd);
    window.addEventListener("resize", update);
    frame = requestAnimationFrame(trackEntranceAnimation);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      inspector?.removeEventListener("animationend", onAnimationEnd);
      window.removeEventListener("resize", update);
      void api.setBounds(null);
    };
  }, [active]);

  async function submitAddress(event: FormEvent) {
    event.preventDefault();
    setCommandError("");
    const result = await window.browserPanel?.navigate(address);
    if (!result?.ok) {
      setCommandError(result?.error === "unsupported_protocol"
        ? t("browserPanel.errors.unsupportedProtocol")
        : result?.error === "invalid_url"
          ? t("browserPanel.errors.invalidUrl")
          : t("browserPanel.errors.unavailable"));
    }
  }

  const pageError = state.error === "load_failed"
    ? t("browserPanel.errors.loadFailed")
    : state.error === "renderer_crashed"
      ? t("browserPanel.errors.rendererCrashed")
      : state.error === "unavailable"
        ? t("browserPanel.errors.unavailable")
        : state.error;

  return (
    <section className="cy-browser-panel" aria-label={t("browserPanel.title")}>
      <form className="cy-browser-panel__toolbar" onSubmit={(event) => void submitAddress(event)}>
        <button type="button" className="cy-browser-panel__icon" disabled={!state.canGoBack} aria-label={t("browserPanel.back")} onClick={() => void window.browserPanel?.goBack()}><ArrowLeft size={15} /></button>
        <button type="button" className="cy-browser-panel__icon" disabled={!state.canGoForward} aria-label={t("browserPanel.forward")} onClick={() => void window.browserPanel?.goForward()}><ArrowRight size={15} /></button>
        <button type="button" className="cy-browser-panel__icon" aria-label={state.loading ? t("browserPanel.stop") : t("browserPanel.reload")} onClick={() => void (state.loading ? window.browserPanel?.stop() : window.browserPanel?.reload())}>
          {state.loading ? <Square size={13} /> : <RotateCw size={14} />}
        </button>
        <input
          className="cy-browser-panel__address"
          aria-label={t("browserPanel.address")}
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={t("browserPanel.addressPlaceholder")}
          spellCheck={false}
          autoComplete="off"
        />
        <button className="cy-browser-panel__go" type="submit">{t("browserPanel.go")}</button>
      </form>
      <div className="cy-browser-panel__page-meta">
        <span className="cy-browser-panel__page-title" title={state.title || state.url}>{state.title || state.url || t("browserPanel.emptyTitle")}</span>
        {state.loading && <LoaderCircle size={13} className="cy-browser-panel__spinner" aria-label={t("browserPanel.loading")} />}
      </div>
      {pageError && <div className="cy-browser-panel__error" role="status"><span>{pageError}</span>{state.crashed && <button type="button" onClick={() => void window.browserPanel?.reload()}>{t("browserPanel.reload")}</button>}</div>}
      {commandError && <div className="cy-browser-panel__error" role="alert">{commandError}<button type="button" aria-label={t("common.close")} onClick={() => setCommandError("")}><X size={13} /></button></div>}
      <div className="cy-browser-panel__webview" ref={hostRef}>
        {!state.url && <div className="cy-browser-panel__empty">{t("browserPanel.emptyHint")}</div>}
      </div>
    </section>
  );
}
