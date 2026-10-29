import type { ToolErrorCategory } from "./tool-execution-error";

/**
 * issue #139：工具错误的两面包。
 *
 * - 模型面（formatToolErrorForModel）：结构化文本（code + category + retryable +
 *   原因 + 修正建议），随 tool result 进 transcript——模型能自纠重试而不是盲试；
 * - 用户面（resolveActionHint）：可行动指引（"去设置页配置 X"），UI 失败卡片展示。
 *
 * 分类默认建议表：工具抛错未带 remediation/actionHint 时兜底（参照 WSL 探测
 * 三档文案 IKKNG7 的思路——每类错误给模型一条可执行的下一步）。
 */

/** category → 给模型的通用修正建议（兜底表）。 */
const MODEL_REMEDIATION_BY_CATEGORY: Record<ToolErrorCategory, string> = {
  transient: "临时故障（网络抖动/服务端 5xx）。可原样重试一次；连续失败再换方案。",
  timeout: "执行超时，副作用可能已发生（effectState=unknown）。先检查结果是否已生效，再决定重试或缩小任务范围。",
  rate_limited: "触发限流。等待约 30-60 秒再试，或减少单次请求的数据量。",
  not_found: "目标不存在。检查路径/ID/名称是否拼写正确、是否已被移动或删除。",
  permission_denied: "权限不足。检查目标是否在允许的目录范围内，或向用户申请提升权限档位。",
  invalid_arguments: "参数校验失败。对照工具 schema 逐字段检查类型与必填项，修正后重新调用。",
  semantic_failure: "业务规则不满足。阅读错误原因，调整调用内容（如缩小范围、修正格式）后再试。",
  partial_failure: "部分成功。查看结果中的成功/失败明细，只对失败项重试或修正。",
  fatal: "不可恢复错误。停止重试，向用户如实说明失败原因。",
  runtime_safety: "安全沙箱拦截。该操作被策略禁止（只读模式/高危命令黑名单），换用允许的方式达成目标。",
  config_error: "配置缺失或错误。检查错误信息指出的配置项——通常需要用户在设置页补配后才能使用该工具；可建议用户操作并等待确认。",
  environment_missing: "运行环境依赖缺失。提示用户安装缺失的依赖（见错误详情），或改用不依赖该环境的替代工具。",
};

/** category → 给用户的默认指引（兜底表）。 */
const ACTION_HINT_BY_CATEGORY: Record<ToolErrorCategory, string> = {
  transient: "稍后重试；若持续失败请检查网络。",
  timeout: "任务较大或网络较慢，可重试或缩小任务范围。",
  rate_limited: "请求太频繁，请稍等一分钟再试。",
  not_found: "请检查目标文件/路径是否正确。",
  permission_denied: "在 设置 → 工具 中调整权限档位后重试。",
  invalid_arguments: "参数有误，请调整后重试。",
  semantic_failure: "请查看失败原因并调整请求内容。",
  partial_failure: "部分内容未成功，可对失败部分重试。",
  fatal: "该功能遇到错误，请查看日志或反馈问题。",
  runtime_safety: "该操作被安全策略拦截；如确需执行请在 设置 → 工具 调整权限。",
  config_error: "请到 设置 → 工具 完成对应服务的配置。",
  environment_missing: "请安装缺失的依赖后重试（详见错误信息）。",
};

/**
 * 模型面：结构化错误文本。进 transcript 的 tool result 就用这段，
 * 替代裸 message——模型拿到 code/category/retryable + 修正建议可自纠。
 */
export function formatToolErrorForModel(input: {
  code: string;
  category: ToolErrorCategory;
  message: string;
  retryable: boolean;
  effectState?: string;
  remediation?: string;
}): string {
  const lines = [
    "[工具错误]",
    `code=${input.code}`,
    `category=${input.category}`,
    `retryable=${input.retryable ? "true" : "false"}`,
  ];
  if (input.effectState && input.effectState !== "not_applied") {
    lines.push(`effectState=${input.effectState}`);
  }
  lines.push(`原因: ${input.message}`);
  lines.push(`修正建议: ${input.remediation ?? MODEL_REMEDIATION_BY_CATEGORY[input.category]}`);
  return lines.join("\n");
}

/** 用户面：actionHint 解析（显式 > category 默认表）。 */
export function resolveActionHint(
  category: ToolErrorCategory,
  actionHint?: string,
): string {
  return actionHint ?? ACTION_HINT_BY_CATEGORY[category];
}
