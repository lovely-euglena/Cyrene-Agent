import { describe, expect, it } from "vitest";
import { createStorageTools, type StorageHostCaller } from "./storage-tools";

const PROFILES = [
  {
    id: "p1",
    name: "NAS",
    protocol: "sftp",
    host: "192.168.1.10",
    port: 22,
    username: "cyrene",
    rootPath: "/data",
    hasPassword: true,
  },
  {
    id: "p2",
    name: "MinIO",
    protocol: "s3",
    bucket: "demo",
    endpoint: "http://127.0.0.1:9000",
    rootPath: "backup",
    hasAccessKey: true,
  },
];

class FakeHostError extends Error {
  errorCode: string;
  retryable: boolean;

  constructor(errorCode: string, message: string, retryable = false) {
    super(message);
    this.errorCode = errorCode;
    this.retryable = retryable;
  }
}

interface RecordedCall {
  op: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

function createHarness() {
  const calls: RecordedCall[] = [];
  // 注意：不要在 mock 实现里 throw（vitest 会记为测试失败）——用普通函数 + 显式分支
  const call: StorageHostCaller = async (op, params, timeoutMs) => {
    calls.push({ op, params, timeoutMs });
    switch (op) {
      case "profiles.list":
        return PROFILES;
      case "status":
        return { sessions: [{ profileId: "p1", state: "ready", lastUsedAt: 1 }] };
      case "read":
        if (params.path === "missing.txt") throw new FakeHostError("STORAGE_NOT_FOUND", "远端不存在：missing.txt");
        return { kind: "text", path: params.path ?? "", text: "hello", size: 5, truncated: false };
      case "download":
        return { path: params.path, localPath: params.localPath, bytes: 5 };
      case "write":
        return { path: params.path, bytes: 5 };
      case "mkdir":
        return { path: params.path };
      case "delete":
        return { deleted: params.paths, failed: [] };
      case "move":
      case "copy":
        return { from: params.from, to: params.to };
      case "profiles.upsert": {
        const profile = params.profile as { name?: string } | undefined;
        return { ...PROFILES[0], id: "p-new", name: profile?.name ?? "x" };
      }
      case "profiles.remove":
        return true;
      case "profiles.test":
        return { ok: true, latencyMs: 12 };
      default:
        throw new Error(`unexpected op: ${op}`);
    }
  };
  const tools = createStorageTools(call);
  const tool = (id: string) => {
    const found = tools.find((t) => t.id === id);
    if (!found) throw new Error(`tool not found: ${id}`);
    return found;
  };
  return { calls, call, tool };
}

describe("storage-tools", () => {
  it("注册 6 个工具且风险/效果分类正确", () => {
    const { tool } = createHarness();
    expect(tool("cloud_profiles").risk).toBe("safe");
    expect(tool("cloud_profiles").effectKind).toBe("read");
    expect(tool("cloud_profile_save").risk).toBe("fs-write");
    expect(tool("cloud_profile_save").effectKind).toBe("mutation");
    expect(tool("cloud_read").risk).toBe("network");
    expect(tool("cloud_read").effectKind).toBe("read");
    expect(tool("cloud_download").risk).toBe("fs-write");
    expect(tool("cloud_upload").risk).toBe("fs-write");
    expect(tool("cloud_manage").risk).toBe("fs-write");
    for (const id of ["cloud_profiles", "cloud_profile_save", "cloud_read", "cloud_download", "cloud_upload", "cloud_manage"]) {
      expect(tool(id).modes).toEqual(["learn", "code", "work"]);
    }
  });

  it("cloud_profiles 返回档案与会话（结构化成功）", async () => {
    const { tool } = createHarness();
    const output = JSON.parse(await tool("cloud_profiles").execute({}));
    expect(output.success).toBe(true);
    expect(output.profiles[0].name).toBe("NAS");
    expect(output.sessions[0].state).toBe("ready");
  });

  it("cloud_read 按名称解析档案并转发参数", async () => {
    const { tool, calls } = createHarness();
    const output = JSON.parse(await tool("cloud_read").execute({
      profile: "nas",
      path: "notes/a.txt",
      maxBytes: 1024,
      maxEntries: 10,
    }));
    expect(output.success).toBe(true);
    expect(output.text).toBe("hello");
    const read = calls.find((c) => c.op === "read");
    expect(read?.params).toMatchObject({ profileId: "p1", path: "notes/a.txt", maxBytes: 1024, maxEntries: 10 });
  });

  it("cloud_read 对未知档案返回结构化错误", async () => {
    const { tool } = createHarness();
    const output = JSON.parse(await tool("cloud_read").execute({ profile: "nope", path: "a" }));
    expect(output.success).toBe(false);
    expect(String(output.message)).toContain("档案不存在");
  });

  it("cloud_read 透传宿主 errorCode", async () => {
    const { tool } = createHarness();
    const output = JSON.parse(await tool("cloud_read").execute({ profile: "nas", path: "missing.txt" }));
    expect(output.success).toBe(false);
    expect(output.errorCode).toBe("STORAGE_NOT_FOUND");
  });

  it("cloud_download 钳制超时并转发覆盖开关", async () => {
    const { tool, calls } = createHarness();
    const output = JSON.parse(await tool("cloud_download").execute({
      profile: "nas",
      path: "big.bin",
      localPath: "D:\\tmp\\big.bin",
      overwrite: true,
      timeout_ms: 10,
    }));
    expect(output.success).toBe(true);
    const download = calls.find((c) => c.op === "download");
    expect(download?.params).toMatchObject({ profileId: "p1", overwrite: true });
    expect(download?.timeoutMs).toBe(1_000 + 15_000);
  });

  it("cloud_upload：content/localPath 二选一校验", async () => {
    const { tool, calls } = createHarness();
    const both = JSON.parse(await tool("cloud_upload").execute({
      profile: "nas",
      path: "a.txt",
      content: "x",
      localPath: "D:\\a.txt",
    }));
    expect(both.success).toBe(false);
    const none = JSON.parse(await tool("cloud_upload").execute({ profile: "nas", path: "a.txt" }));
    expect(none.success).toBe(false);

    const ok = JSON.parse(await tool("cloud_upload").execute({
      profile: "nas",
      path: "a.txt",
      content: "hello",
      createParents: false,
    }));
    expect(ok.success).toBe(true);
    const write = calls.find((c) => c.op === "write");
    expect(write?.params).toMatchObject({ profileId: "p1", content: "hello", createParents: false, overwrite: false });
  });

  it("cloud_manage：mkdir 默认递归 / delete 需显式 recursive", async () => {
    const { tool, calls } = createHarness();
    const mkdir = JSON.parse(await tool("cloud_manage").execute({ profile: "nas", action: "mkdir", path: "a/b" }));
    expect(mkdir.success).toBe(true);
    expect(calls.find((c) => c.op === "mkdir")?.params).toMatchObject({ path: "a/b", recursive: true });

    const del = JSON.parse(await tool("cloud_manage").execute({
      profile: "nas",
      action: "delete",
      paths: ["a/b", ""],
    }));
    expect(del.success).toBe(true);
    const deleteCall = calls.find((c) => c.op === "delete");
    expect(deleteCall?.params).toMatchObject({ paths: ["a/b"], recursive: false });
  });

  it("cloud_manage：move 需要 from/to", async () => {
    const { tool, calls } = createHarness();
    const bad = JSON.parse(await tool("cloud_manage").execute({ profile: "nas", action: "move", from: "a" }));
    expect(bad.success).toBe(false);
    const ok = JSON.parse(await tool("cloud_manage").execute({
      profile: "nas",
      action: "move",
      from: "a",
      to: "b",
      overwrite: true,
    }));
    expect(ok.success).toBe(true);
    expect(calls.find((c) => c.op === "move")?.params).toMatchObject({ from: "a", to: "b", overwrite: true });
  });

  it("cloud_profile_save：remove 按名称解析；add 透传 fromSshProfile；test 触发自检", async () => {
    const { tool, calls } = createHarness();
    const removed = await tool("cloud_profile_save").execute({ action: "remove", name: "nas" });
    expect(String(removed)).toContain("已删除");
    expect(calls.find((c) => c.op === "profiles.remove")?.params).toMatchObject({ id: "p1" });

    const saved = await tool("cloud_profile_save").execute({
      action: "add",
      name: "新 NAS",
      protocol: "sftp",
      fromSshProfile: "home-nas",
      test: true,
    });
    expect(String(saved)).toContain("连接测试通过");
    const upsert = calls.find((c) => c.op === "profiles.upsert");
    expect(upsert?.params.fromSshProfile).toBe("home-nas");
    expect(calls.some((c) => c.op === "profiles.test")).toBe(true);
  });
});
