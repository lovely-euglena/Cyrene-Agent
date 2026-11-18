export type ToolErrorCategory =
  | "transient"
  | "timeout"
  | "rate_limited"
  | "not_found"
  | "permission_denied"
  | "invalid_arguments"
  | "semantic_failure"
  | "partial_failure"
  | "fatal"
  | "runtime_safety"
  /** issue #139：配置错误——API key 未配置、模型未选、供应商地址错。修正动作在设置页。 */
  | "config_error"
  /** issue #139：环境缺失——依赖未安装（WSL/libreoffice/ocr）或版本不符。 */
  | "environment_missing";

export type ToolEffectState = "not_applied" | "unknown";

export class ToolExecutionError extends Error {
  readonly name = "ToolExecutionError";

  constructor(
    readonly code: string,
    message: string,
    readonly category: ToolErrorCategory,
    readonly retryable = false,
    readonly effectState: ToolEffectState = "not_applied",
    /**
     * issue #139 给模型的错误面：字段级修正建议（"query 不能为空，请提供搜索词"）。
     * 缺省时 formatter 按 category 落通用建议表。
     */
    readonly remediation?: string,
    /**
     * issue #139 给用户的错误面：可行动指引（"去 设置 → 工具 页配置搜索源"）。
     * UI 在失败卡片上追加展示；缺省时按 category 落默认指引表。
     */
    readonly actionHint?: string,
  ) {
    super(message);
  }
}
