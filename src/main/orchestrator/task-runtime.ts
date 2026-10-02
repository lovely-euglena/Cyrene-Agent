import { DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS, type TaskAccessMode, type TaskSession, type TaskSessionStatus, type TaskSubagentType, type TaskTraceRecord, type TaskTranscriptMessage } from "../../shared/task-session";
import { TaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTraceEvent } from "./task-events";
import { getTaskAgentProfile, resolveTaskTools } from "./task-profiles";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { AgentState, HarnessConfig, HarnessEvent, HarnessInput, HarnessResult } from "./harness/types";
import type { HarnessStepEnvironment } from "./agent-orchestration/step-runner";
import type { TaskOrchestrationInput, TaskOrchestrationOutcome } from "./agent-orchestration/task-orchestrator-runner";
import { resolveHostStepTimeoutMs } from "./agent-orchestration/protocol";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { VendorConfig, ChatMessage } from "./vendors/types";
import type { ToolContext } from "./tools/registry/tool-context";
import { taskCharacterLeasePool, type TaskCharacterLeasePool } from "../tasks/task-character-pool";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadGeneralSettings } from "../settings/settings-facade";
import { listSavedModelProfiles, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import type { TaskDelegationPresentation } from "../../shared/task-session";
import type { RunCapabilities } from "./run-capabilities";
import type { PromptLayers } from "./prompt-layers";
import type { ToolOutputStore } from "./harness/tool-output/tool-output-store";

const TASK_TRACE_CHECKPOINT_INTERVAL_MS = 500;
const TASK_TRACE_LIMIT = 2_000;

function appendTaskTraceRecord(trace: TaskTraceRecord[], next: TaskTraceRecord): void {
  const previous = trace.at(-1);
  const canMergeDelta = (next.kind === "candidate" || next.kind === "reasoning")
    && next.phase === "delta"
    && previous?.kind === next.kind
    && previous.phase === "delta"
    && previous.label === next.label
    && previous.roundId === next.roundId;
  if (canMergeDelta && previous) {
    previous.content = `${previous.content ?? ""}${next.content ?? ""}`;
    previous.at = next.at;
  } else {
    trace.push(next);
  }
  if (trace.length > TASK_TRACE_LIMIT) trace.splice(0, trace.length - TASK_TRACE_LIMIT);
}

export interface TaskExecuteRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  companionId: string;
  accessMode?: TaskAccessMode;
  maxParallelToolCalls?: number;
  taskId?: string;
}

export interface TaskExecuteResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
}

export interface TaskCloseRequest {
  companionId: string;
}

export interface TaskCloseResult {
  taskId: string;
  companionId: string;
  status: "closed";
}

export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./cyrene-agent").CyreneRunOptions["permissionMode"];
  toolOutputStore?: ToolOutputStore;
}

/**
 * 注入接口：子 Agent 经 agent-orchestrator 编排执行（接口层，生产未接线）。
 * 不注入时 Task 走原有 TS Harness 直跑；注入后仅当开关/exe 就绪才走编排，
 * 首个 step 前故障由 runner 返回 used:false 回退直跑。
 */
export type TaskOrchestratedRunner = (
  input: TaskOrchestrationInput,
) => Promise<TaskOrchestrationOutcome>;

function taskStatus(result: HarnessResult): { status: Exclude<TaskSessionStatus, "running" | "interrupted">; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}

/** 编排终态 → 任务结算（与 taskStatus 的直跑语义对齐）。 */
function taskStatusFromOrchestration(
  outcome: Extract<TaskOrchestrationOutcome, { used: true }>,
): { status: Exclude<TaskSessionStatus, "running" | "interrupted">; error?: { code: string; message: string } } {
  if (outcome.status === "cancelled") return { status: "cancelled" };
  if (outcome.status === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (outcome.status === "failed") {
    return {
      status: "failed",
      error: { code: "TASK_RUNTIME_ERROR", message: outcome.error || outcome.finalAnswer || "子任务运行失败" },
    };
  }
  return { status: "completed" };
}

export function buildChildPromptLayers(
  parent: TaskRuntimeParentContext,
  profilePrompt: string,
  accessMode: TaskAccessMode = "write",
): PromptLayers {
  const workspace = parent.resolvedWorkspaceRoot
    ? `可信工作目录：${parent.resolvedWorkspaceRoot}`
    : "当前没有绑定工作目录。";
  return {
    stablePrefix: [
      profilePrompt,
      accessMode === "read_only"
        ? "本任务处于只读模式：只检查和读取信息，不修改文件、仓库或外部状态。你可用的工具也已按只读能力限制。"
        : "本任务允许按指令执行写入；若同一轮存在并行委派，只读子任务可并行，写入子任务会排队串行执行。",
    ].join("\n"),
    sessionPrefix: `${workspace}\n会话模式：${parent.mode}`,
    mode: parent.mode,
  };
}

function stripCharacterPromptFrontmatter(prompt: string): string {
  return prompt.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
}

function buildCharacterTaskPrompt(companionId: string): string {
  const personaEnabled = loadGeneralSettings().taskCharacterPersonaEnabled;
  const taskSystem = personaEnabled
    ? loadPromptFile("task/task_system.md")
    : loadPromptFile("task/task_system_nonesoul.md");
  const character = personaEnabled
    ? stripCharacterPromptFrontmatter(loadPromptFile(`task/${companionId}.md`))
    : "";
  const taskSystemPath = personaEnabled ? "task/task_system.md" : "task/task_system_nonesoul.md";
  if (!taskSystem) console.warn(`[TaskRuntime] Missing task system prompt: prompts/${taskSystemPath}`);
  if (personaEnabled && !character) console.warn(`[TaskRuntime] Missing character task prompt: prompts/task/${companionId}.md`);
  return [taskSystem, character].filter(Boolean).join("\n\n");
}

function resolveTaskModel(parentVendorConfig: VendorConfig): {
  vendorConfig: VendorConfig;
  contextWindowTokens?: number;
} {
  const settings = loadGeneralSettings();
  const profileId = settings.taskModelProfileId;
  const model = settings.taskModel;
  if (!profileId || !model) return { vendorConfig: parentVendorConfig };

  const modelSettings = loadModelSettings();
  const profile = listSavedModelProfiles(modelSettings).find((candidate) => candidate.id === profileId);
  if (!profile) return { vendorConfig: parentVendorConfig };
  const availableModels = profile.models?.length ? profile.models : [profile.model];
  if (!availableModels.includes(model)) return { vendorConfig: parentVendorConfig };

  const expanded = resolveModelSettingsProfile(modelSettings, profileId);
  const modelOption = profile.modelOptions?.[model];
  return {
    vendorConfig: {
      ...parentVendorConfig,
      provider: expanded.provider,
      baseUrl: expanded.baseUrl,
      model,
      apiKey: expanded.apiKey,
      explicitTransport: expanded.explicitTransport,
      reasoning: expanded.reasoning,
      manualReasoning: modelOption?.manualReasoning,
    },
    contextWindowTokens: modelOption?.contextWindowTokens
      ?? profile.contextWindowTokens
      ?? modelSettings.contextWindowTokens,
  };
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
  characterPool?: Pick<TaskCharacterLeasePool, "acquire">;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
  /** 编排接口（可选）：注入后按开关/回退规则尝试经 agent-orchestrator 执行。 */
  runOrchestrated?: TaskOrchestratedRunner;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult> {
  const runHarness = input.runHarness ?? runCyreneHarness;
  const characterPool = input.characterPool ?? taskCharacterLeasePool;
  return async (request) => {
    const profile = getTaskAgentProfile(request.subagentType);
    const lease = characterPool.acquire(input.parent.parentConversationId, request.companionId);
    let session: TaskSession;
    // 编排 seed：resume 前快照历史（resume 会追加本轮 prompt，进了 seed 会与
    // worker 组装的 user 消息重复）；新建任务 seed 为空。
    let seedMessages: ChatMessage[] = [];
    let seedState: AgentState | undefined;
    try {
      const previous = request.taskId
        ? null
        : input.store.findOpenByCompanion(input.parent.parentConversationId, request.companionId);
      const taskId = request.taskId ?? previous?.id;
      if (taskId) {
        const before = input.store.get(taskId);
        seedMessages = (before?.messages ?? []) as ChatMessage[];
        seedState = { todoItems: before?.todoItems ?? [], uncertainEffects: [] };
        session = input.store.resume(taskId, {
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          subagentType: request.subagentType,
          prompt: request.prompt,
          companionId: request.companionId,
        });
      } else {
        session = input.store.create({
          parentConversationId: input.parent.parentConversationId,
          parentRunId: input.parent.parentRunId,
          description: request.description,
          prompt: request.prompt,
          subagentType: request.subagentType,
          companionId: request.companionId,
          mode: input.parent.mode,
          resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
        });
      }
    } catch (error) {
      lease.release();
      throw error;
    }

    const toolContext: ToolContext = {
      userQuery: request.prompt,
      conversationId: input.parent.parentConversationId,
      runId: session.childRunId,
      signal: input.parent.signal,
      resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
      mode: input.parent.mode,
      allowedSkillIds: input.parent.capabilities?.skillIds,
      permissionMode: input.parent.permissionMode,
    };

    const presentation = {
      invocationId: session.childRunId,
      taskId: session.id,
      description: request.description,
      nickname: lease.nickname,
      assetFileName: lease.assetFileName,
    };
    let taskTrace = session.trace;
    let pendingTaskTrace: TaskTraceRecord[] = [];
    let taskTraceDirty = false;
    let taskTraceFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushTaskTrace = () => {
      if (taskTraceFlushTimer !== undefined) {
        clearTimeout(taskTraceFlushTimer);
        taskTraceFlushTimer = undefined;
      }
      for (const record of pendingTaskTrace) appendTaskTraceRecord(taskTrace, record);
      if (pendingTaskTrace.length > 0) {
        pendingTaskTrace = [];
        taskTraceDirty = true;
      }
      if (!taskTraceDirty) return;
      input.store.checkpoint(session.id, { trace: taskTrace });
      taskTraceDirty = false;
    };
    const scheduleTaskTraceFlush = () => {
      if (taskTraceFlushTimer !== undefined) return;
      taskTraceFlushTimer = setTimeout(() => {
        taskTraceFlushTimer = undefined;
        try {
          flushTaskTrace();
        } catch (error) {
          // Retain the dirty in-memory trace; the next batch or terminal flush retries it.
          console.error("[TaskRuntime] trace checkpoint failed", error);
        }
      }, TASK_TRACE_CHECKPOINT_INTERVAL_MS);
    };
    input.onLifecycle?.({ ...presentation, status: "running" });

    try {
      const combinedTaskPrompt = buildCharacterTaskPrompt(request.companionId);
      const promptLayers = buildChildPromptLayers(input.parent, combinedTaskPrompt, request.accessMode ?? "write");
      const taskModel = resolveTaskModel(input.parent.vendorConfig);
      const tools = resolveTaskTools(profile, input.parent.tools, request.accessMode ?? "write");
      const harnessConfig: Partial<HarnessConfig> = {
        totalTimeoutMs: profile.timeoutMs,
        maxParallelToolCalls: request.maxParallelToolCalls ?? DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS,
        ...(taskModel.contextWindowTokens ? { contextWindowTokens: taskModel.contextWindowTokens } : {}),
      };
      let activeRoundId: string | undefined;
      const onHarnessEvent = (event: HarnessEvent) => {
        if (event.type === "round_start") activeRoundId = event.roundId;
        const trace = projectTaskTraceEvent(event);
        if (trace) {
          if (event.type !== "round_start" && event.type !== "round_end" && activeRoundId) {
            trace.roundId = activeRoundId;
          }
          pendingTaskTrace.push(trace);
          scheduleTaskTraceFlush();
        }
        if (event.type === "round_end") activeRoundId = undefined;
      };
      const onHarnessCheckpoint: NonNullable<HarnessInput["onCheckpoint"]> = (checkpoint) => {
        input.store.checkpoint(session.id, {
          messages: checkpoint.messages as TaskTranscriptMessage[],
          todoItems: checkpoint.state.todoItems,
        });
      };
      const resolveStepEnvironment = ({ signal }: { signal: AbortSignal }): HarnessStepEnvironment => ({
        vendorConfig: taskModel.vendorConfig,
        tools,
        promptLayers,
        systemPrompt: promptLayers.stablePrefix,
        toolContext: { ...toolContext, signal },
        checkPermission: input.parent.checkPermission,
        toolOutputStore: input.parent.toolOutputStore,
        includeInteractiveTools: input.parent.includeInteractiveTools,
        config: harnessConfig,
        onCheckpoint: onHarnessCheckpoint,
      });

      // 编排路径（接口层，默认未注入）：首个 step 前故障回退直跑；一旦执行过
      // step（副作用不可假设幂等）则按终态结算，绝不回退。
      if (input.runOrchestrated) {
        const sessionId = `${session.id}:${session.childRunId}`;
        const outcome = await input.runOrchestrated({
          taskId: session.id,
          sessionId,
          groupId: sessionId,
          role: request.subagentType,
          message: request.prompt,
          seed: {
            messages: seedMessages,
            ...(seedState ? { state: seedState } : {}),
          },
          stepTimeoutMs: resolveHostStepTimeoutMs(profile.timeoutMs),
          resolveEnvironment: resolveStepEnvironment,
          onEvent: onHarnessEvent,
          ...(input.parent.signal ? { signal: input.parent.signal } : {}),
        });
        if (outcome.used) {
          flushTaskTrace();
          const mapped = taskStatusFromOrchestration(outcome);
          input.store.checkpoint(session.id, {
            status: mapped.status,
            resultText: outcome.finalAnswer ?? "",
            ...(outcome.finalState ? { todoItems: outcome.finalState.todoItems } : {}),
            ...(mapped.error ? { error: mapped.error } : {}),
            completedAt: Date.now(),
          });
          input.onLifecycle?.({ ...presentation, status: mapped.status });
          return { taskId: session.id, status: mapped.status, text: outcome.finalAnswer ?? "" };
        }
        console.warn(`[TaskRuntime] 编排执行不可用，回退直跑 Harness：${outcome.reason}`);
      }

      const result = await runHarness({
        systemPrompt: promptLayers.stablePrefix,
        promptLayers,
        messages: session.messages as ChatMessage[],
        tools,
        vendorConfig: taskModel.vendorConfig,
        config: harnessConfig,
        initialState: {
          todoItems: session.todoItems,
          uncertainEffects: [],
        },
        signal: input.parent.signal,
        toolContext,
        toolOutputStore: input.parent.toolOutputStore,
        checkPermission: input.parent.checkPermission,
        includeInteractiveTools: input.parent.includeInteractiveTools,
        onEvent: onHarnessEvent,
        onCheckpoint: onHarnessCheckpoint,
      });
      flushTaskTrace();
      const mapped = taskStatus(result);
      input.store.checkpoint(session.id, {
        status: mapped.status,
        resultText: result.finalAnswer,
        todoItems: result.finalState.todoItems,
        ...(mapped.error ? { error: mapped.error } : {}),
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: mapped.status });
      return { taskId: session.id, status: mapped.status, text: result.finalAnswer };
    } catch (error) {
      try {
        flushTaskTrace();
      } catch (traceError) {
        console.error("[TaskRuntime] final trace checkpoint failed", traceError);
      }
      const message = error instanceof Error ? error.message : String(error);
      input.store.checkpoint(session.id, {
        status: input.parent.signal?.aborted ? "cancelled" : "failed",
        error: { code: input.parent.signal?.aborted ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message },
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: input.parent.signal?.aborted ? "cancelled" : "failed" });
      throw error;
    } finally {
      if (taskTraceFlushTimer !== undefined) clearTimeout(taskTraceFlushTimer);
      lease.release();
    }
  };
}

export function createTaskCloser(input: {
  store: TaskSessionStore;
  parentConversationId: string;
}): (request: TaskCloseRequest) => TaskCloseResult {
  return ({ companionId }) => {
    const session = input.store.closeByCompanion(input.parentConversationId, companionId);
    return { taskId: session.id, companionId, status: "closed" };
  };
}
