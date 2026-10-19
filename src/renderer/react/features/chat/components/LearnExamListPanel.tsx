import { useCallback, useEffect, useRef, useState } from "react";
import type { LearnExamStatus, LearnExamView } from "../../../../../shared/learn-exam";
import "./LearnExamListPanel.css";

type LearnExamApi = {
  listByConversation: (conversationId: string) => Promise<LearnExamView[]>;
  onCreated: (callback: (event: { conversationId: string; examId: string }) => void) => () => void;
  onChanged: (callback: (event: { conversationId: string; examId: string }) => void) => () => void;
};

// 与 preload/index.ts learnExamApi / global.d.ts browserPanel 对齐；缺失时组件降级隐藏。
function learnExamApi(): LearnExamApi | undefined {
  return (window as typeof window & { learnExam?: LearnExamApi }).learnExam;
}

const STATUS_META: Readonly<Record<LearnExamStatus, { label: string; tone: string }>> = {
  draft: { label: "待作答", tone: "info" },
  submitted: { label: "已交卷", tone: "info" },
  grading: { label: "批改中", tone: "info" },
  grading_failed: { label: "批改失败", tone: "warn" },
  graded: { label: "已批改", tone: "done" },
};

function formatTime(ts: number): string {
  const date = new Date(ts);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hhmm : `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
}

interface Props {
  sessionId: string | undefined;
  /** 试卷打开后的回调（如收起面板），缺省仅开窗。 */
  onOpenExam?: () => void;
}

// 本会话试卷列表：自动开卷事件（ChatPage onCreated）之外的兜底入口——
// 出题完成时若切了会话/模式，事件守卫会吞掉开卷，这里按会话查询找回（issue #171）。
export function LearnExamListPanel({ sessionId, onOpenExam }: Props) {
  const [exams, setExams] = useState<LearnExamView[] | null>(null);
  const [open, setOpen] = useState(false);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const refresh = useCallback(async (conversationId: string | undefined) => {
    const api = learnExamApi();
    if (!conversationId || !api) return;
    const next = await api.listByConversation(conversationId).catch(() => null);
    if (sessionIdRef.current !== conversationId) return; // 会话已切走，丢弃过期结果
    setExams(next ?? []);
  }, []);

  useEffect(() => {
    void refresh(sessionId);
  }, [sessionId, refresh]);

  useEffect(() => {
    const api = learnExamApi();
    if (!api) return;
    // 不加 mode/会话守卫：出题完成时即使不在当前会话/模式，列表也刷新（兜底找回）。
    const offCreated = api.onCreated((event) => {
      if (event.conversationId === sessionIdRef.current) void refresh(sessionIdRef.current);
    });
    const offChanged = api.onChanged((event) => {
      if (event.conversationId === sessionIdRef.current) void refresh(sessionIdRef.current);
    });
    return () => { offCreated(); offChanged(); };
  }, [refresh]);

  if (!sessionId || exams === null) return null;
  const api = learnExamApi();

  function openExam(exam: LearnExamView): void {
    void (window as typeof window & { browserPanel?: { openExam?: (examId: string, conversationId: string) => Promise<boolean> } })
      .browserPanel?.openExam?.(exam.examId, exam.conversationId);
    onOpenExam?.();
  }

  return (
    <div className="learn-exam-list" data-open={open}>
      <button
        type="button"
        className="learn-exam-list__toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span>本会话试卷</span>
        <span className="learn-exam-list__count">{exams.length > 0 ? exams.length : ""}</span>
        <span className="learn-exam-list__chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        exams.length === 0 ? (
          <div className="learn-exam-list__empty">本会话暂无试卷，出题完成后会出现在这里。</div>
        ) : (
          <ul className="learn-exam-list__items">
            {exams.map((exam) => {
              const meta = STATUS_META[exam.status] ?? STATUS_META.draft;
              return (
                <li key={exam.examId}>
                  <button
                    type="button"
                    className="learn-exam-list__item"
                    onClick={() => openExam(exam)}
                    title={`${exam.title}（${meta.label}）`}
                  >
                    <span className={`learn-exam-list__badge is-${meta.tone}`}>{meta.label}</span>
                    <span className="learn-exam-list__title">{exam.title}</span>
                    <span className="learn-exam-list__meta">
                      {exam.questions.length}题 · {formatTime(exam.updatedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      )}
      {api === undefined && open && (
        <div className="learn-exam-list__empty">考试组件未就绪，请重启应用后重试。</div>
      )}
    </div>
  );
}
