/**
 * fs 三件 native 轨接线测试（evidence 帧协议 v1 + 回退语义）。
 *
 * 覆盖：
 *  - host 可用：read_file / list_dir / write_file 走 ToolHost，输出原样透传
 *  - host 故障 / 业务失败载荷：回退 TS 原实现（读真实盘、真实报错语义）
 *  - 写类预检（覆盖防骤降）与 review 基线留在 TS，语义拒绝不触达 host
 *  - toolHost 开关=0：完全不触达 host
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const nativeMocks = vi.hoisted(() => ({
  call: vi.fn(),
  captureBefore: vi.fn(),
}));

vi.mock("./native-tool-host", () => ({
  nativeToolHost: { call: nativeMocks.call },
}));

vi.mock("../../dotnet-backend/config", () => ({
  resolveDotnetConfig: vi.fn(() => ({ toolHost: true })),
}));

vi.mock("../review/run-review-tracker", () => ({
  getRunReviewTracker: vi.fn(() => ({ captureBefore: nativeMocks.captureBefore })),
}));

// Mock toolRegistry 避免副作用
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: vi.fn(),
    getById: vi.fn(),
    getEnabledTools: vi.fn(() => []),
  },
}));

// electron mock：desktop / userData 都指向临时目录
vi.mock("electron", () => ({
  app: {
    getPath: (_name: string) => tmpDir,
  },
}));

vi.mock("../vision-captioner", () => ({
  captionImage: vi.fn(),
}));

import "./fs-tools";
import { toolRegistry } from "./registry/tool-registry";
import { nativeToolHost } from "./native-tool-host";
import { resolveDotnetConfig } from "../../dotnet-backend/config";

const registeredTools = new Map(
  vi.mocked(toolRegistry.register).mock.calls.map(([tool]) => [tool.id, tool]),
);

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-tools-native-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.mocked(resolveDotnetConfig).mockReturnValue({ toolHost: true } as never);
  nativeMocks.call.mockReset();
  nativeMocks.captureBefore.mockReset();
});

describe("fs native 轨 · 只读三件", () => {
  it("read_file：host 可用时走 ToolHost 并原样返回 data", async () => {
    nativeMocks.call.mockResolvedValue('{"path":"C:\\\\x.txt","content":"native 12"}');
    const out = await registeredTools.get("read_file")!.execute({ path: "C:\\x.txt" });
    expect(out).toBe('{"path":"C:\\\\x.txt","content":"native 12"}');
    expect(nativeMocks.call).toHaveBeenCalledWith("fs_read_file", { path: "C:\\x.txt" }, undefined);
  });

  it("read_file：host 故障时回退 TS（真实读盘）", async () => {
    const file = path.join(tmpDir, "a.txt");
    fs.writeFileSync(file, "来自 TS");
    nativeMocks.call.mockRejectedValue(new Error("host 崩了"));
    const out = JSON.parse(await registeredTools.get("read_file")!.execute({ path: file }));
    expect(out.content).toContain("来自 TS");
    expect(out.totalLines).toBe(1);
  });

  it("read_file：host 业务失败载荷回退 TS 错误语义（FILE_NOT_FOUND）", async () => {
    nativeMocks.call.mockResolvedValue('{"success":false,"errorCode":"E_FS_NOT_FOUND","retryable":true}');
    const out = JSON.parse(
      await registeredTools.get("read_file")!.execute({ path: path.join(tmpDir, "nope.txt") }),
    );
    expect(out.success).toBe(false);
    expect(out.errorCode).toBe("FILE_NOT_FOUND");
    expect(out.retryable).toBe(true);
  });

  it("list_dir：文本输出（非 JSON）原样返回", async () => {
    nativeMocks.call.mockResolvedValue("dir: C:\\x\ncount: 0\n");
    const out = await registeredTools.get("list_dir")!.execute({ path: "C:\\x" });
    expect(out).toContain("count: 0");
    expect(nativeMocks.call).toHaveBeenCalledWith("fs_list_dir", { path: "C:\\x" }, undefined);
  });

  it("toolHost 开关=0 时不触达 host", async () => {
    const file = path.join(tmpDir, "off.txt");
    fs.writeFileSync(file, "ts");
    vi.mocked(resolveDotnetConfig).mockReturnValue({ toolHost: false } as never);
    const out = JSON.parse(await registeredTools.get("read_file")!.execute({ path: file }));
    expect(out.content).toContain("ts");
    expect(nativeMocks.call).not.toHaveBeenCalled();
  });
});

describe("fs native 轨 · write_file", () => {
  function writeTool() {
    return registeredTools.get("write_file")!;
  }

  it("native 成功：预检 + 基线在 TS，落盘证据由 host 返回且不重复落盘", async () => {
    const target = path.join(tmpDir, "w.txt");
    const nativePayload = JSON.stringify({
      success: true,
      tool: "write_file",
      path: target,
      append: false,
      exists: true,
      sizeBytes: 1,
      writtenBytes: 1,
      changes: [{ file: target, kind: "added", insertions: 1, deletions: 0, diff: [{ type: "add", text: "x" }] }],
    });
    nativeMocks.call.mockResolvedValue(nativePayload);

    const out = JSON.parse(await writeTool().execute({ path: target, content: "x" }, { runId: "r1" }));

    expect(out).toEqual(JSON.parse(nativePayload));
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("r1", target);
    expect(nativeMocks.call).toHaveBeenCalledWith("fs_write_file", {
      path: target,
      content: "x",
      append: false,
      createDirs: true,
    });
    // native 轨职责已转移：TS 侧不落盘（由 host 完成）
    expect(fs.existsSync(target)).toBe(false);
  });

  it("覆盖防骤降在预检拦截：不触达 host、不写基线、文件原样", async () => {
    const target = path.join(tmpDir, "big.txt");
    const original = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    fs.writeFileSync(target, original);

    await expect(writeTool().execute({ path: target, content: "半截内容" }, { runId: "r2" }))
      .rejects.toMatchObject({
        code: "E_OVERWRITE_DROP_BLOCKED",
        category: "runtime_safety",
        retryable: false,
        effectState: "not_applied",
      });
    expect(nativeMocks.call).not.toHaveBeenCalled();
    expect(nativeMocks.captureBefore).not.toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf8")).toBe(original);
  });

  it("native 失败回退 TS：真实落盘、changes 证据保留", async () => {
    const target = path.join(tmpDir, "fallback.txt");
    nativeMocks.call.mockRejectedValue(new Error("host 崩了"));

    const out = JSON.parse(await writeTool().execute({ path: target, content: "hello" }, { runId: "r3" }));

    expect(out.success).toBe(true);
    expect(out.changes[0]).toMatchObject({ file: target, kind: "added", insertions: 1, deletions: 0 });
    expect(fs.readFileSync(target, "utf8")).toBe("hello");
    // 基线必须在任何一轨落盘之前捕获
    expect(nativeMocks.captureBefore).toHaveBeenCalledWith("r3", target);
  });

  it("host 业务失败载荷回退 TS（写入失败不吞错）", async () => {
    const target = path.join(tmpDir, "io-fail.txt");
    nativeMocks.call.mockResolvedValue('{"success":false,"errorCode":"E_FS_IO","error":"写入失败","retryable":true}');

    const out = JSON.parse(await writeTool().execute({ path: target, content: "ok" }));

    expect(out.success).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("ok");
  });
});
