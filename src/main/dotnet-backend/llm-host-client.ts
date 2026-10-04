/**
 * llm 作业宿主客户端（Phase 2 / H3 TS 侧）。
 *
 * cyrene-native --llm-host：TS 提交 wire 请求（去鉴权），.NET 注入鉴权 +
 * 发送 + 流式解析 + 事件缓冲；本客户端按 cursor 轮询取归一化事件。
 *
 * 超时纪律（issue「关键施工注意」）：LineHostClient 调用超时即杀宿主——
 * 本客户端 timeout=30s 须远大于 poll waitMs（5s），poll 空返回即回。
 */
import { resolveDotnetConfig } from "./config";
import { type LlmPollResult, type LlmSubmitPayload } from "./llm-host-protocol";
import { LineHostClient } from "./host-clients";
import { secretsDataDir } from "./secrets-client";

export class LlmHostClient extends LineHostClient {
  enabled(): boolean {
    return resolveDotnetConfig().llmHost;
  }
  constructor() {
    super("--llm-host", 30_000);
  }
  protected extraArgs(): string[] {
    return ["--data-dir", secretsDataDir()];
  }

  /** 提交作业；lane 满载等业务失败 → reject（E_LLM_HOST_*）。 */
  async submit(payload: LlmSubmitPayload): Promise<string> {
    const r = (await this.call("llm.submit", payload as unknown as Record<string, unknown>)) as {
      data?: { jobId: string };
    };
    return r.data?.jobId ?? "";
  }
  async poll(jobId: string, cursor: number, waitMs = 5_000, maxEvents = 500): Promise<LlmPollResult> {
    const r = (await this.call("llm.poll", { jobId, cursor, waitMs, maxEvents })) as {
      data?: LlmPollResult;
    };
    // 复审提示项：缺 data = 协议异常，如实报错（不静默回退默认值掩盖漂移）
    if (!r.data) throw new Error("llm-host poll 响应缺 data（协议漂移？）");
    return r.data;
  }
  async cancel(jobId: string): Promise<void> {
    await this.call("llm.cancel", { jobId });
  }
  async status(): Promise<{ jobs: number; running: number; queued: number; secrets: boolean }> {
    const r = (await this.call("llm.status", {})) as {
      data?: { jobs: number; running: number; queued: number; secrets: boolean };
    };
    return r.data ?? { jobs: 0, running: 0, queued: 0, secrets: false };
  }
}

export const llmHostClient = new LlmHostClient();
