import { FolderOpenOutlined, SearchOutlined } from "@ant-design/icons";
import { Button, Checkbox, Input, Modal, Spin } from "antd";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n";
import { chatStore } from "../pages/chat-page-bridge";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { ChatExportError, ChatExportFile, ChatExportFormat } from "../../../../../shared/chat-export";
import "./ChatExportDialog.css";

interface ChatExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** 打开时预勾选的会话（右键发起）；打开后用户可继续多选。 */
  preselectedIds?: string[];
}

interface ExportResultState {
  dir: string;
  files: ChatExportFile[];
  errors: ChatExportError[];
}

const MODE_LABEL_KEYS: Record<ConversationMode, string> = {
  chat: "chatExport.modeChat",
  work: "chatExport.modeWork",
  code: "chatExport.modeCode",
  learn: "chatExport.modeLearn",
};

/** 毫秒时间戳 → YYYY-MM-DD HH:mm。 */
function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 聊天记录导出弹窗：搜索 + 多选会话 + HTML/Markdown 格式，主进程弹目录框写文件。
 * 右键任意会话打开时预勾选该会话；列表来自全量存档（跨模式可导）。
 */
export function ChatExportDialog({ open, onClose, preselectedIds }: ChatExportDialogProps) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formatHtml, setFormatHtml] = useState(true);
  const [formatMarkdown, setFormatMarkdown] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<ExportResultState | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // 预选数组按内容做依赖键：父组件每次渲染都传新数组时避免重复重置
  const preselectedKey = (preselectedIds ?? []).join("\u0000");

  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setSelected(new Set(preselectedKey ? preselectedKey.split("\u0000") : []));
    setFormatHtml(true);
    setFormatMarkdown(false);
    setResult(null);
    setActionError(null);
    setLoading(true);
    setLoadError(null);

    let cancelled = false;
    const api = chatStore();
    if (!api) {
      setLoading(false);
      setLoadError(t("chatExport.loadFailed"));
      return;
    }
    void api.list()
      .then((items) => {
        if (cancelled) return;
        setSessions([...items].sort((a, b) => b.updatedAt - a.updatedAt));
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
        setLoadError(t("chatExport.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectedKey, t]);

  const visibleSessions = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return sessions;
    return sessions.filter((session) => (session.title || "").toLowerCase().includes(key));
  }, [sessions, keyword]);

  const allVisibleSelected = visibleSessions.length > 0
    && visibleSessions.every((session) => selected.has(session.id));
  const hasFormat = formatHtml || formatMarkdown;
  const canExport = selected.size > 0 && hasFormat && !exporting;

  function toggleSession(sessionId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const session of visibleSessions) next.delete(session.id);
      } else {
        for (const session of visibleSessions) next.add(session.id);
      }
      return next;
    });
  }

  async function handleExport() {
    const api = chatStore();
    if (!api || !canExport) return;
    const formats: ChatExportFormat[] = [];
    if (formatHtml) formats.push("html");
    if (formatMarkdown) formats.push("markdown");

    setExporting(true);
    setActionError(null);
    setResult(null);
    try {
      const response = await api.exportChats({ sessionIds: [...selected], formats });
      if (response.ok) {
        setResult({ dir: response.dir, files: response.files, errors: response.errors });
      } else if (!response.canceled) {
        setActionError(response.error ?? t("chatExport.errorUnknown"));
      }
      // canceled：用户取消目录选择，静默返回
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  async function reveal(filePath: string) {
    const api = chatStore();
    if (!api) return;
    await api.revealExportPath(filePath).catch(() => undefined);
  }

  return (
    <Modal
      className="cy-chat-export"
      open={open}
      title={t("chatExport.title")}
      onCancel={exporting ? undefined : onClose}
      maskClosable={!exporting}
      destroyOnHidden
      width={560}
      footer={(
        <div className="cy-chat-export__footer">
          <div className="cy-chat-export__formats">
            <Checkbox
              checked={formatHtml}
              onChange={(event) => setFormatHtml(event.target.checked)}
              disabled={exporting}
            >
              HTML
            </Checkbox>
            <Checkbox
              checked={formatMarkdown}
              onChange={(event) => setFormatMarkdown(event.target.checked)}
              disabled={exporting}
            >
              Markdown
            </Checkbox>
          </div>
          <div className="cy-chat-export__footer-actions">
            <Button onClick={onClose} disabled={exporting}>{t("common.cancel")}</Button>
            <Button type="primary" disabled={!canExport} loading={exporting} onClick={() => void handleExport()}>
              {exporting ? t("chatExport.exporting") : t("chatExport.export", { n: selected.size })}
            </Button>
          </div>
        </div>
      )}
    >
      <p className="cy-chat-export__hint">{t("chatExport.subtitle")}</p>
      <div className="cy-chat-export__toolbar">
        <Input
          allowClear
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t("chatExport.searchPlaceholder")}
          prefix={<SearchOutlined className="cy-chat-export__search-icon" />}
        />
        <Button size="small" disabled={visibleSessions.length === 0 || exporting} onClick={toggleAllVisible}>
          {allVisibleSelected ? t("chatExport.clearAll") : t("chatExport.selectAll")}
        </Button>
        <span className="cy-chat-export__count">{t("chatExport.selectedCount", { n: selected.size })}</span>
      </div>

      <div className="cy-chat-export__list" role="listbox" aria-multiselectable="true">
        {loading && (
          <div className="cy-chat-export__state"><Spin size="small" /> {t("chatExport.loading")}</div>
        )}
        {!loading && loadError && <div className="cy-chat-export__state is-error">{loadError}</div>}
        {!loading && !loadError && sessions.length === 0 && (
          <div className="cy-chat-export__state">{t("chatExport.empty")}</div>
        )}
        {!loading && !loadError && sessions.length > 0 && visibleSessions.length === 0 && (
          <div className="cy-chat-export__state">{t("chatExport.noMatch")}</div>
        )}
        {!loading && !loadError && visibleSessions.map((session) => {
          const checked = selected.has(session.id);
          return (
            <div
              key={session.id}
              role="option"
              aria-selected={checked}
              className={`cy-chat-export__row${checked ? " is-selected" : ""}`}
              onClick={() => toggleSession(session.id)}
            >
              <Checkbox
                checked={checked}
                onClick={(event) => event.stopPropagation()}
                onChange={() => toggleSession(session.id)}
              />
              <div className="cy-chat-export__row-main">
                <div className="cy-chat-export__row-title">
                  {session.title || t("sidebar.defaultSessionTitle")}
                </div>
                <div className="cy-chat-export__row-sub">
                  <span>{t("chatExport.messageCount", { n: session.messageCount })}</span>
                  <span>{formatTime(session.updatedAt)}</span>
                  {session.workspaceDisplayName && (
                    <span className="cy-chat-export__ws" title={session.workspaceRoot ?? ""}>
                      {session.workspaceDisplayName}
                    </span>
                  )}
                </div>
              </div>
              <div className="cy-chat-export__tags">
                <span className={`cy-chat-export__tag is-${session.mode}`}>
                  {t(MODE_LABEL_KEYS[session.mode] ?? "chatExport.modeChat")}
                </span>
                {session.purpose === "proactive-chat" && (
                  <span className="cy-chat-export__tag is-proactive">{t("chatExport.proactive")}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {actionError && <div className="cy-chat-export__action-error">{actionError}</div>}

      {result && (
        <div className={`cy-chat-export__result${result.errors.length > 0 ? " is-error" : " is-ok"}`}>
          <div className="cy-chat-export__result-head">
            {result.files.length > 0
              ? t("chatExport.done", { n: result.files.length })
              : t("chatExport.noFiles")}
          </div>
          {result.files.length > 0 && (
            <div className="cy-chat-export__files">
              {result.files.map((file) => (
                <div key={file.path} className="cy-chat-export__file">
                  <span className="cy-chat-export__file-name" title={file.path}>{file.name}</span>
                  <button type="button" className="cy-chat-export__reveal" onClick={() => void reveal(file.path)}>
                    <FolderOpenOutlined /> {t("chatExport.reveal")}
                  </button>
                </div>
              ))}
            </div>
          )}
          {result.errors.length > 0 && (
            <div className="cy-chat-export__errors">
              <div>{t("chatExport.failedCount", { n: result.errors.length })}</div>
              {result.errors.map((error, index) => (
                <div key={`${error.sessionId}-${index}`} className="cy-chat-export__file">
                  <span className="cy-chat-export__file-name">{error.title}</span>
                  <span>{error.error}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
