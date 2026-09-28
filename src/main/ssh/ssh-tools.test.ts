import { describe, expect, it, vi } from "vitest";
import { createSshTools } from "./ssh-tools";

const PROFILES = [
  {
    id: "p1",
    name: "NAS",
    host: "192.168.1.10",
    port: 22,
    username: "cyrene",
    authType: "password",
    hasPassword: true,
  },
];

function createHarness() {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const call = vi.fn(async (op: string, params: Record<string, unknown>) => {
    calls.push({ op, params });
    switch (op) {
      case "profiles.list":
        return PROFILES;
      case "status":
        return { sessions: [{ profileId: "p1", state: "ready", lastUsedAt: 1 }] };
      case "exec":
        return { exitCode: 0, stdout: "ok", stderr: "", truncated: false, timedOut: false, durationMs: 12 };
      case "open":
      case "close":
        return { profileId: params.profileId, state: "ready" };
      case "profiles.remove":
        return true;
      case "profiles.upsert":
        return { ...PROFILES[0], id: "p-new" };
      default:
        throw new Error(`unexpected op: ${op}`);
    }
  });
  const tools = createSshTools(call);
  const tool = (id: string) => {
    const found = tools.find((t) => t.id === id);
    if (!found) throw new Error(`tool not found: ${id}`);
    return found;
  };
  return { calls, call, tool };
}

describe("ssh-tools", () => {
  it("注册 5 个工具且风险/效果分类正确", () => {
    const { tool } = createHarness();
    expect(tool("ssh_profiles").risk).toBe("safe");
    expect(tool("ssh_exec").risk).toBe("shell");
    expect(tool("ssh_exec").effectKind).toBe("unknown");
    expect(tool("ssh_profile_save").risk).toBe("fs-write");
    expect(tool("ssh_open").risk).toBe("network");
  });

  it("ssh_profiles 返回档案与会话", async () => {
    const { tool } = createHarness();
    const output = JSON.parse(await tool("ssh_profiles").execute({}));
    expect(output.profiles[0].name).toBe("NAS");
    expect(output.sessions[0].state).toBe("ready");
  });

  it("ssh_exec 按名称解析档案并转发参数（超时钳制）", async () => {
    const { tool, calls } = createHarness();
    const output = JSON.parse(await tool("ssh_exec").execute({
      profile: "nas",
      command: "uptime",
      timeout_ms: 10,
    }));
    expect(output.exitCode).toBe(0);
    const exec = calls.find((c) => c.op === "exec");
    expect(exec?.params).toMatchObject({ profileId: "p1", command: "uptime", timeoutMs: 1000 });
  });

  it("ssh_exec 对未知档案返回结构化错误", async () => {
    const { tool } = createHarness();
    const output = JSON.parse(await tool("ssh_exec").execute({ profile: "nope", command: "ls" }));
    expect(output.errorCode).toBe("SSH_EXEC_FAILED");
    expect(String(output.stderr)).toContain("档案不存在");
  });

  it("ssh_profile_save remove 支持按名称解析", async () => {
    const { tool, calls } = createHarness();
    const text = await tool("ssh_profile_save").execute({ action: "remove", name: "NAS" });
    expect(text).toContain("已删除");
    expect(calls.find((c) => c.op === "profiles.remove")?.params).toMatchObject({ id: "p1" });
  });

  it("ssh_profile_save add 透传认证信息", async () => {
    const { tool, calls } = createHarness();
    const text = await tool("ssh_profile_save").execute({
      action: "add",
      name: "VPS",
      host: "10.0.0.5",
      username: "root",
      authType: "password",
      password: "secret",
    });
    expect(text).toContain("已保存");
    const upsert = calls.find((c) => c.op === "profiles.upsert");
    expect((upsert?.params.profile as Record<string, unknown>).password).toBe("secret");
    expect((upsert?.params.profile as Record<string, unknown>).host).toBe("10.0.0.5");
  });
});
