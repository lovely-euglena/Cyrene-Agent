/**
 * Harness step runner —— 把 orchestrator step 映射成一次真实 CyreneHarness 运行。
 *
 * 与 harness-adapter 的关系：
 * - harness-adapter 服务 AG-UI/聊天 UI 单会话运行，重（run-store/review/plan/AGUI）；
 * - 本模块服务 agent-orchestrator 的会话 worker，薄：环境（供应商配置、工具、
 *   提示词层、权限、工具输出存储）由调用方按会话解析注入，循环本体完全复用。
 *
 * 本模块不 import electron：生产装配由上层（后续接线）提供环境解析器，
 * 也可以先在测试里注入 fake 环境验证装配语义。
 */

import type { VendorConfig } from "../vendors/types";
import type { ChatMessage } from "../vendors/types";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import type { ToolContext } from "../tools/registry/tool-context";
import type { PromptLayers } from "../prompt-layers";
import { runCyreneHarness } from "../harness";
import type { AgentState, HarnessConfig, HarnessInput } from "../harness";
import type { OrchestratorStepFrame } from "./protocol";
import type {
  HarnessSessionWorkerOptions,
  SessionStepExecutionRequest,
  SessionStepExecutionResult,
} from "./harness-session-worker";

/** 单个会话一步运行所需的宿主环境。 */
export interface HarnessStepEnvironment {
  vendorConfig: VendorConfig;
  /** 已按会话工具白名单过滤过的工具集合。 */
  tools: ToolDefinition[];
  /** 稳定提示词分层；systemPrompt 缺省时取 promptLayers.stablePrefix。 */
  promptLayers: PromptLayers;
  systemPrompt?: string;
  toolContext?: ToolContext;
  checkPermission?: HarnessInput["checkPermission"];
  toolOutputStore?: HarnessInput["toolOutputStore"];
  executionLedger?: HarnessInput["executionLedger"];
  taskExecutor?: HarnessInput["taskExecutor"];
  requestUserClarification?: HarnessInput["requestUserClarification"];
  includeInteractiveTools?: boolean;
  planState?: HarnessInput["planState"];
  /** 覆盖 Harness 默认配置（并发/上下文窗口/超时等）。 */
  config?: Partial<HarnessConfig>;
}

export type HarnessStepEnvironmentResolver = (
  step: OrchestratorStepFrame,
) => HarnessStepEnvironment | Promise<HarnessStepEnvironment>;

/**
 * 构造注入 HarnessSessionWorker 的 runStep：
 * - 环境按 step 解析（每个会话可有独立供应商/工具/提示词）；
 * - 通过 onCheckpoint 捕获终态 transcript 与 AgentState，供下一步续跑；
 * - Harness 事件直通 worker 的 emit（上层再转 step.event 帧）。
 */
export function createHarnessStepRunner(
  resolveEnvironment: HarnessStepEnvironmentResolver,
): HarnessSessionWorkerOptions["runStep"] {
  return async function runHarnessStep(
    request: SessionStepExecutionRequest,
  ): Promise<SessionStepExecutionResult> {
    const environment = await resolveEnvironment(request.step);
    // checkpoint 回调是活引用：先同步快照，再交给下一步；避免运行期继续变更。
    let messages: ChatMessage[] = request.messages;
    let state: AgentState | undefined = request.state;
    let sawCheckpoint = false;

    const result = await runCyreneHarness({
      systemPrompt: environment.systemPrompt ?? environment.promptLayers.stablePrefix,
      promptLayers: environment.promptLayers,
      messages: request.messages,
      runId: `${request.step.callId}:${request.step.stepId}`,
      ...(request.state ? { initialState: request.state } : {}),
      tools: environment.tools,
      vendorConfig: environment.vendorConfig,
      ...(environment.config ? { config: environment.config } : {}),
      signal: request.signal,
      onEvent: request.emit,
      onCheckpoint: (checkpoint) => {
        messages = checkpoint.messages;
        state = checkpoint.state;
        sawCheckpoint = true;
      },
      ...(environment.toolContext ? { toolContext: environment.toolContext } : {}),
      ...(environment.checkPermission ? { checkPermission: environment.checkPermission } : {}),
      ...(environment.toolOutputStore ? { toolOutputStore: environment.toolOutputStore } : {}),
      ...(environment.executionLedger ? { executionLedger: environment.executionLedger } : {}),
      ...(environment.taskExecutor ? { taskExecutor: environment.taskExecutor } : {}),
      ...(environment.includeInteractiveTools !== undefined
        ? { includeInteractiveTools: environment.includeInteractiveTools }
        : {}),
      ...(environment.planState !== undefined ? { planState: environment.planState } : {}),
      ...(environment.requestUserClarification
        ? { requestUserClarification: environment.requestUserClarification }
        : {}),
    });

    return {
      result,
      messages: sawCheckpoint ? messages : request.messages,
      state: state ?? result.finalState,
    };
  };
}
