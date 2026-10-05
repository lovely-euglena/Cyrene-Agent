// native/WPF「昔涟设置」的 embedding 模型切换流程（从 default-dependencies 的
// cyreneAction save 分支拆出，依赖注入便于单测「结构化回执」契约）。
//
// 关键契约（复审 P1-1 / P2-3）：
//   - 失败回执（reject / 动态 import 失败 / ok:false）必须带结构化 data：
//     WPF 只在 data 含 rebuildRequired 或 embeddingSwitchFailed 时才处理，
//     仅推设置快照会因 cyrene 源（快照节点原文）未变被 ApplySettings 去重跳过；
//   - ok 路径先 saveModelSettings 落盘，再 best-effort 收尾（对账/贴纸索引），
//     避免「已生效切换 + 收尾期间退出 → 设置不落盘」。
//
// 放在 settings 层（import type 取 ModelSettings）；rag 侧只引 finalize 纯函数。

import { finalizeEmbeddingModelSwitch, type EmbeddingSwitchFinalizeDeps } from "../rag/embedding-switch-finalize";
import type { EmbeddingSwitchAction, EmbeddingSwitchResult } from "../rag";
import type { EmbeddingModelKey, ModelSettings } from "./model-settings";

/** 设置窗 section 反馈回调（nativeNotice 的子集）。 */
export type NativeNoticeFn = (
  section: string,
  level: "ok" | "error" | "info",
  text: string,
  data?: Record<string, unknown>,
) => void;

export interface NativeEmbeddingSwitchDeps {
  switchEmbeddingModel: (modelKey: string, action?: EmbeddingSwitchAction) => Promise<EmbeddingSwitchResult>;
  /** 切换成功后的统一收尾（用户记忆对账 + 贴纸索引失效/重建）。 */
  finalize: EmbeddingSwitchFinalizeDeps;
  saveModelSettings: (settings: Partial<ModelSettings>) => unknown;
  broadcastModelChanged: () => void;
  pushSettingsSnapshotToNative: () => void;
  nativeNotice: NativeNoticeFn;
}

/**
 * reject 回退（复审 P1-1）：与 ok:false 路径同口径带结构化 data——
 * WPF ApplyNotice 只在 data 含 embeddingSwitchFailed 时 RefreshSection("cyrene")，
 * 卡片才会从乐观选中回退到实际档位。动态 import 失败与流程内抛错共用本函数。
 */
export function notifyEmbeddingSwitchRejected(
  notice: NativeNoticeFn,
  error: unknown,
  embeddingModel: string,
): void {
  notice(
    "cyrene",
    "error",
    `嵌入模型切换失败：${error instanceof Error ? error.message : String(error)}`,
    { embeddingSwitchFailed: true, embeddingModel },
  );
}

/**
 * 执行一次 native/WPF embedding 模型切换（含迁移确认后的 rebuild/clear）。
 * 所有失败都转成结构化回执，不向调用方抛出。
 */
export async function runNativeEmbeddingSwitch(
  modelKey: EmbeddingModelKey,
  action: EmbeddingSwitchAction | undefined,
  settingsPatch: Partial<ModelSettings>,
  deps: NativeEmbeddingSwitchDeps,
): Promise<void> {
  try {
    const result = await deps.switchEmbeddingModel(modelKey, action);
    if (!result.ok) {
      const hint = result.requires === "rebuild"
        ? "旧索引需要重建（备份后全量重嵌入）或清空后才能切换，请确认迁移方式"
        : result.requires === "clear"
          ? "旧索引元数据需要清空确认后才能切换"
          : result.error ?? "未知错误";
      // rebuild-required：带结构化 data 回传，WPF 弹确认后带 embeddingModelAction 重发；
      // 其它失败也回传模型键，WPF 据此撤销卡片乐观选中
      deps.nativeNotice(
        "cyrene",
        "error",
        `嵌入模型切换未生效：${hint}`,
        result.reason === "rebuild-required"
          ? {
              rebuildRequired: true,
              embeddingModel: modelKey,
              requires: result.requires ?? "rebuild",
            }
          : { embeddingSwitchFailed: true, embeddingModel: modelKey },
      );
      return;
    }
    // P2-3（复审）：先落盘设置，再 best-effort 收尾——收尾三步均不会抛错，
    // 但设置先写可避免「模型已切换、进程在收尾期间退出导致设置未落盘」。
    deps.saveModelSettings({ ...settingsPatch, embeddingModel: modelKey });
    // 与渲染端 IPC 成功路径同口径收尾（P1-4）：用户记忆对账 + 贴纸索引
    // 失效/重建（否则重启前贴纸匹配用旧模型向量算余弦）
    await finalizeEmbeddingModelSwitch(deps.finalize);
    deps.broadcastModelChanged();
    deps.pushSettingsSnapshotToNative();
    deps.nativeNotice(
      "cyrene",
      "ok",
      `嵌入模型已切换（重建 ${result.rebuiltEntries ?? 0} 条，清空 ${result.clearedEntries} 条）`,
    );
  } catch (err) {
    notifyEmbeddingSwitchRejected(deps.nativeNotice, err, modelKey);
    // 失败时快照通常无变化（被 section 源去重跳过），结构化回执负责触发重建；
    // 保留推送以覆盖「设置已部分写入后才抛错」的场景。
    deps.pushSettingsSnapshotToNative();
  }
}
