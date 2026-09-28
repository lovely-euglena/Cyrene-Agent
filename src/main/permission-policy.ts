/**
 * 权限档位的纯策略层。
 *
 * 不依赖 Electron、磁盘或 IPC，供 VerificationRunner 等执行核心复用，
 * 避免为了判断 allow/ask/deny 就初始化整个权限宿主。
 */
export type AgentFileAccessLevel =
  | "project-read-only"
  | "read-only"
  | "scoped"
  | "per-action"
  | "full";

export type ToolRiskLevel =
  | "safe"
  | "fs-read"
  | "fs-write"
  | "shell"
  | "network"
  | "input-control"
  /**
   * 工具未声明风险级时的内部兜底（仅宿主写入，插件不能主动声明）。
   * 语义上按“未知风险”处理：完全访问档放行、每次审批档询问、其余档拒绝，
   * 避免“缺省 = safe”成为审批旁路。
   */
  | "undeclared";

export function policyFor(
  level: AgentFileAccessLevel,
  risk: ToolRiskLevel,
): "allow" | "ask" | "deny" {
  if (risk === "safe") return "allow";

  // 未声明风险：不放行、不静默执行；只有用户显式选择完全访问档才放行。
  if (risk === "undeclared") {
    switch (level) {
      case "full":
        return "allow";
      case "per-action":
        return "ask";
      default:
        return "deny";
    }
  }

  // shell 的安全边界由沙箱兜底：所有档位都放行进 executeRunShell 的档位路由，
  // 由 buildFilesystemConfigForLevel + wrapWithSandbox 强制 fs 边界。
  // 不再用 policyFor 作为 shell 的准入闸门。
  if (risk === "shell") {
    switch (level) {
      case "project-read-only":
      case "read-only":
      case "scoped":
      case "full":
        return "allow";
      case "per-action":
        return "ask";
    }
  }

  switch (level) {
    case "project-read-only":
      // 档位控制的是沙箱 fs 配置（allowRead 限定项目根），不是工具准入。
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      return "ask";
    case "full":
      return "allow";
  }
}
