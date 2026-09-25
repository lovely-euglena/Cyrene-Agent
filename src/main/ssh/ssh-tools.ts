// SSH 托管工具（.NET --ssh-host 的薄代理）。
//
// 会话本体在 cyrene-native --ssh-host 进程里（有状态、keepalive、懒重连），
// 这里只负责：参数校验/档案名解析 → JSON 行调用 → 结果透传。
// 密码只经由 profiles.upsert 写入 .NET 侧（DPAPI 加密落盘），本层不持久化任何凭据。

import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

export interface SshHostCaller {
  (op: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
}

const SSH_MODES = ["learn", "code", "work"] as const;

interface SshProfileView {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: string;
  privateKeyPath?: string | null;
  hasPassword?: boolean;
  hasPassphrase?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampTimeout(value: unknown, fallback = 120_000): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), 1_000), 1_800_000);
}

async function listProfiles(call: SshHostCaller): Promise<SshProfileView[]> {
  const data = await call("profiles.list", {}, 15_000);
  return Array.isArray(data) ? (data as SshProfileView[]) : [];
}

/** 档案引用解析：id 精确匹配 > 名称忽略大小写 > 主机名忽略大小写。 */
async function resolveProfileId(call: SshHostCaller, reference: string): Promise<string> {
  const ref = reference.trim();
  const profiles = await listProfiles(call);
  const byId = profiles.find((p) => p.id === ref);
  if (byId) return byId.id;
  const lower = ref.toLowerCase();
  const byName = profiles.find((p) => (p.name ?? "").toLowerCase() === lower);
  if (byName) return byName.id;
  const byHost = profiles.find((p) => (p.host ?? "").toLowerCase() === lower);
  if (byHost) return byHost.id;
  const available = profiles.map((p) => p.name || p.host || p.id).join("、") || "（无）";
  throw new Error(`SSH 档案不存在：${ref}。当前可用：${available}`);
}

export function createSshTools(call: SshHostCaller): ToolDefinition[] {
  const sshProfilesTool: ToolDefinition = {
    id: "ssh_profiles",
    name: "SSH 服务器列表",
    description:
      "列出已配置的 SSH 服务器档案与当前会话状态（不返回密码）。\n\n" +
      "何时用：\n" +
      "- 用户说「看看配了哪些服务器」「连一下我的 NAS」前，先确认档案名称\n" +
      "- 执行 ssh_exec 前不确定用哪个档案\n\n" +
      "不要用于：\n" +
      "- 本机命令（那是 run_shell）\n" +
      "- 增删改档案（那是 ssh_profile_save）\n\n" +
      "参数：无。返回档案的 id / 名称 / 主机 / 用户名 / 认证方式与活跃会话。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    verificationPolicy: "none",
    modes: [...SSH_MODES],
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      try {
        const profiles = await listProfiles(call);
        const status = await call("status", {}, 15_000);
        return JSON.stringify({
          profiles: profiles.map((p) => ({
            id: p.id,
            name: p.name,
            host: p.host,
            port: p.port,
            username: p.username,
            authType: p.authType,
            privateKeyPath: p.privateKeyPath ?? undefined,
            hasPassword: p.hasPassword === true,
          })),
          sessions: (status as { sessions?: unknown } | null)?.sessions ?? [],
        });
      } catch (error) {
        return JSON.stringify({ error: errorMessage(error) });
      }
    },
  };

  const sshProfileSaveTool: ToolDefinition = {
    id: "ssh_profile_save",
    name: "保存 SSH 档案",
    description:
      "新增 / 修改 / 删除 SSH 服务器档案（密码经 DPAPI 加密后保存在本机，仅当前用户可解）。\n\n" +
      "何时用：\n" +
      "- 用户说「帮我加一个 SSH：主机 xxx，用户名 yyy」\n" +
      "- 用户要修改端口 / 换密钥 / 删掉某台服务器\n\n" +
      "不要用于：\n" +
      "- 只是想连或执行命令（用 ssh_open / ssh_exec）\n" +
      "- 用户没明确要求保存凭据时，不要把密码写进档案\n\n" +
      "参数：action（add/update/remove，必填）；add/update 需要 host、username 与认证信息；\n" +
      "认证：authType=password 时传 password；authType=privateKey 时传 privateKeyPath（可选 passphrase）。\n" +
      "update/remove 用 id 或 name 指定目标（可先调 ssh_profiles 查）。",
    enabled: true,
    risk: "fs-write",
    effectKind: "mutation",
    verificationPolicy: "none",
    modes: [...SSH_MODES],
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "add / update / remove", enum: ["add", "update", "remove"] },
        id: { type: "string", description: "档案 id（update/remove 可用；add 时省略）" },
        name: { type: "string", description: "展示名；update/remove 也可用它指定目标" },
        host: { type: "string", description: "主机名或 IP（add/update 必填）" },
        port: { type: "number", description: "端口，默认 22" },
        username: { type: "string", description: "登录用户名（add/update 必填）" },
        authType: { type: "string", description: "password（默认）或 privateKey", enum: ["password", "privateKey"] },
        password: { type: "string", description: "登录密码（authType=password）" },
        privateKeyPath: { type: "string", description: "私钥文件绝对路径（authType=privateKey）" },
        passphrase: { type: "string", description: "私钥口令（可选）" },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args.action ?? "").trim();
      try {
        if (action === "remove") {
          const reference = String(args.id ?? args.name ?? "").trim();
          if (!reference) return "删除失败：需要提供 id 或 name";
          const profileId = await resolveProfileId(call, reference);
          await call("profiles.remove", { id: profileId }, 15_000);
          return `已删除 SSH 档案：${reference}`;
        }
        if (action !== "add" && action !== "update") {
          return "参数无效：action 必须是 add / update / remove";
        }
        const host = String(args.host ?? "").trim();
        const username = String(args.username ?? "").trim();
        if (!host || !username) return "参数无效：add/update 需要 host 与 username";
        const nameArg = typeof args.name === "string" ? args.name.trim() : "";
        let id = typeof args.id === "string" ? args.id.trim() : "";
        if (!id && nameArg) {
          const existing = (await listProfiles(call)).find((p) => p.name.toLowerCase() === nameArg.toLowerCase());
          if (existing) id = existing.id;
        }
        const profile: Record<string, unknown> = {
          id: id || undefined,
          name: nameArg || undefined,
          host,
          port: typeof args.port === "number" ? args.port : Number(args.port) || 22,
          username,
          authType: args.authType === "privateKey" ? "privateKey" : "password",
          privateKeyPath: typeof args.privateKeyPath === "string" ? args.privateKeyPath.trim() : undefined,
        };
        if (typeof args.password === "string" && args.password) profile.password = args.password;
        if (typeof args.passphrase === "string" && args.passphrase) profile.passphrase = args.passphrase;
        const saved = (await call("profiles.upsert", { profile }, 15_000)) as SshProfileView | null;
        return `已保存 SSH 档案：${saved?.name ?? host}（id=${saved?.id ?? "?"}，${host}:${profile.port}，${profile.authType}）`;
      } catch (error) {
        return `保存失败：${errorMessage(error)}`;
      }
    },
  };

  const sshOpenTool: ToolDefinition = {
    id: "ssh_open",
    name: "建立 SSH 连接",
    description:
      "打开（或复用）一个托管 SSH 会话。会话由宿主保持：keepalive、断线后下次调用自动重连。\n\n" +
      "何时用：\n" +
      "- 准备在远端主机上执行命令前，先建连接（不先建也行，ssh_exec 会懒连接）\n" +
      "- 用户明确说「连上服务器」\n\n" +
      "不要用于：\n" +
      "- 只需要查档案（ssh_profiles）\n\n" +
      "参数：profile（必填，档案 id / 名称 / 主机名，可先调 ssh_profiles 查）。",
    enabled: true,
    risk: "network",
    effectKind: "read",
    verificationPolicy: "none",
    modes: [...SSH_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称或主机名" },
      },
      required: ["profile"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      if (!reference) return "连接失败：需要 profile 参数";
      try {
        const profileId = await resolveProfileId(call, reference);
        await call("open", { profileId }, 45_000);
        return `已连接：${reference}`;
      } catch (error) {
        return `连接失败：${errorMessage(error)}`;
      }
    },
  };

  const sshExecTool: ToolDefinition = {
    id: "ssh_exec",
    name: "远程执行命令",
    description:
      "在托管 SSH 会话里执行一条命令（远端主机上运行）。会话保持连接，同档案命令串行执行。\n\n" +
      "何时用：\n" +
      "- 用户要求在某台服务器上跑命令 / 看文件 / 重启服务\n" +
      "- 需要在远端部署、查日志、看磁盘\n\n" +
      "不要用于：\n" +
      "- 本机命令（run_shell）\n" +
      "- 交互式命令（vim/top 等需要 TTY 的程序——这里是非交互 exec 通道）\n\n" +
      "安全说明：远端命令不受本机沙箱约束，只受权限审批把关；破坏性操作（rm/覆盖配置/重启）\n" +
      "请先与用户确认。超时后命令可能仍在远端运行（结果里会标 timedOut=true）。\n\n" +
      "参数：profile（必填，档案 id/名称/主机名）；command（必填）；\n" +
      "cwd（可选，远端工作目录，会以 cd 前缀注入）；timeout_ms（可选，1000–1800000，默认 120000）。",
    enabled: true,
    risk: "shell",
    effectKind: "unknown",
    verificationPolicy: "none",
    modes: [...SSH_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称或主机名" },
        command: { type: "string", description: "要执行的命令（非交互）" },
        cwd: { type: "string", description: "远端工作目录（可选）" },
        timeout_ms: { type: "number", description: "执行上限毫秒数（1000–1800000，默认 120000）" },
      },
      required: ["profile", "command"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      const command = String(args.command ?? "").trim();
      if (!reference || !command) return JSON.stringify({ error: "参数无效：需要 profile 与 command" });
      const timeoutMs = clampTimeout(args.timeout_ms);
      try {
        const profileId = await resolveProfileId(call, reference);
        const result = await call(
          "exec",
          {
            profileId,
            command,
            cwd: typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined,
            timeoutMs,
          },
          timeoutMs + 15_000,
        );
        return JSON.stringify({ profile: profileId, ...(result as Record<string, unknown>) });
      } catch (error) {
        return JSON.stringify({
          profile: reference,
          errorCode: "SSH_EXEC_FAILED",
          stderr: errorMessage(error),
          stdout: "",
        });
      }
    },
  };

  const sshCloseTool: ToolDefinition = {
    id: "ssh_close",
    name: "关闭 SSH 会话",
    description:
      "关闭指定档案的托管 SSH 会话（下次调用会自动重连）。\n\n" +
      "何时用：\n" +
      "- 用户说「断开连接」「别一直连着」\n" +
      "- 排查连接异常时重置会话\n\n" +
      "参数：profile（必填，档案 id / 名称 / 主机名）。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    verificationPolicy: "none",
    modes: [...SSH_MODES],
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "档案 id、名称或主机名" },
      },
      required: ["profile"],
    },
    execute: async (args) => {
      const reference = String(args.profile ?? "").trim();
      if (!reference) return "断开失败：需要 profile 参数";
      try {
        const profileId = await resolveProfileId(call, reference);
        await call("close", { profileId }, 15_000);
        return `已断开：${reference}`;
      } catch (error) {
        return `断开失败：${errorMessage(error)}`;
      }
    },
  };

  return [sshProfilesTool, sshProfileSaveTool, sshOpenTool, sshExecTool, sshCloseTool];
}

/** 默认实例：懒加载 .NET 宿主客户端（避免测试/启动期拉起子进程）。 */
export const sshTools = createSshTools(async (op, params, timeoutMs) => {
  const { nativeSshHost } = await import("./native-ssh-host");
  return nativeSshHost.call(op, params, timeoutMs);
});
