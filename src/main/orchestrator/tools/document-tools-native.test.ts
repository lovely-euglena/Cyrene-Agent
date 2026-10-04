/**
 * document-tools native 轨接线测试（IKJK3V T2 库替代批）：
 *  - prepare → native 调用参数（路径 / 主题 / 看门狗）：write_excel / write_word / write_pdf / write_markdown
 *  - native 可用：结果原样透传
 *  - native 故障 / 业务失败载荷：回退 TS 原实现（文件真实落盘）
 *  - write_markdown 覆盖防骤降：语义拒绝抛错，不触达 native、不改文件
 *  - 取消（AbortError）原样上抛，不回退重跑
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmpDir: string;

// 内存版注册表：真实执行 register → execute 链路，不污染全局
const registry = new Map<string, Record<string, unknown>>();
vi.mock("./registry/tool-registry", () => ({
  toolRegistry: {
    register: (tool: Record<string, unknown>) => void registry.set(tool.id as string, tool),
    getById: (id: string) => registry.get(id),
    getEnabledTools: () => [...registry.values()],
  },
}));

vi.mock("electron", () => ({
  app: { getPath: (_name: string) => tmpDir },
}));

vi.mock("../../external-content-paths", () => ({
  findSkillPath: (_skillId: string, _sub: string) => null,
}));

import { nativeToolHost } from "./native-tool-host";
import { registerDocumentTools } from "./document-tools";

registerDocumentTools();

function getTool(id: string): {
  execute: (args: Record<string, unknown>, ctx?: { runId?: string; resolvedWorkspaceRoot?: string }) => Promise<string>;
} {
  const tool = registry.get(id) as never;
  if (!tool) throw new Error(`工具未注册：${id}`);
  return tool;
}

const nativeMocks = {
  calls: [] as Array<{ tool: string; args: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal }>,
  result: null as string | null,
  error: null as Error | null,
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-tools-native-"));
  nativeMocks.calls = [];
  nativeMocks.result = null;
  nativeMocks.error = null;
  vi.spyOn(nativeToolHost, "call").mockImplementation(
    async (tool: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal) => {
      nativeMocks.calls.push({ tool, args, timeoutMs, signal });
      if (nativeMocks.error) throw nativeMocks.error;
      return nativeMocks.result;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const DEFAULT_EXCEL_THEME = {
  headerFill: "FF1F4E79", headerFont: "FFFFFFFF", headerBorder: "FF1F4E79",
  zebraFill: "FFF2F2F2", borderColor: "FFBFBFBF",
};

describe("文档四件 native 轨", () => {
  it("write_excel：注入路径 + 默认主题，看门狗 30s，结果透传", async () => {
    nativeMocks.result = `[write_excel] 已生成：${path.join(tmpDir, "报表.xlsx")}`;
    const out = await getTool("write_excel").execute(
      { filename: "报表.xlsx", sheets: [{ name: "S1", headers: ["a"], rows: [[1]] }] },
      {},
    );
    expect(out).toBe(nativeMocks.result);
    expect(nativeMocks.calls).toHaveLength(1);
    const call = nativeMocks.calls[0];
    expect(call.tool).toBe("write_excel");
    expect(call.timeoutMs).toBe(30_000);
    expect(call.args.path).toBe(path.join(tmpDir, "报表.xlsx"));
    expect(call.args.sheets).toEqual([{ name: "S1", headers: ["a"], rows: [[1]] }]);
    expect(call.args.theme).toEqual(DEFAULT_EXCEL_THEME);
  });

  it("write_word：注入路径 + 默认商务主题（6 位色 / 半磅字号 / 行距）", async () => {
    nativeMocks.result = "[write_word] 已生成：x.docx";
    await getTool("write_word").execute(
      { filename: "报告.docx", title: "标题", paragraphs: ["段落一"] },
      {},
    );
    const call = nativeMocks.calls[0];
    expect(call.tool).toBe("write_word");
    expect(call.timeoutMs).toBe(30_000);
    expect(call.args.path).toBe(path.join(tmpDir, "报告.docx"));
    expect(call.args.title).toBe("标题");
    expect(call.args.paragraphs).toEqual(["段落一"]);
    expect(call.args.theme).toEqual({
      titleColor: "1F4E79", titleSize: 28, titleFont: "微软雅黑",
      bodyFont: "微软雅黑", bodySize: 24, bodyColor: "333333",
      lineSpacing: 360, headingColor: "1F4E79",
    });
  });

  it("write_pdf：注入路径 + 标题/段落，看门狗 30s", async () => {
    nativeMocks.result = "[write_pdf] 已生成：x.pdf";
    await getTool("write_pdf").execute(
      { filename: "合同.pdf", title: "合同", paragraphs: ["条款"] },
      {},
    );
    const call = nativeMocks.calls[0];
    expect(call.tool).toBe("write_pdf");
    expect(call.timeoutMs).toBe(30_000);
    expect(call.args).toEqual({
      path: path.join(tmpDir, "合同.pdf"),
      title: "合同",
      paragraphs: ["条款"],
    });
  });

  it("write_markdown：注入路径/内容/append，看门狗 15s，结果 JSON 透传", async () => {
    nativeMocks.result = JSON.stringify({ success: true, tool: "write_markdown", path: "x.md", append: false, changes: [] });
    const out = await getTool("write_markdown").execute({ filename: "笔记.md", content: "# 标题" }, {});
    expect(JSON.parse(out).tool).toBe("write_markdown");
    const call = nativeMocks.calls[0];
    expect(call.tool).toBe("write_markdown");
    expect(call.timeoutMs).toBe(15_000);
    expect(call.args).toEqual({ path: path.join(tmpDir, "笔记.md"), content: "# 标题", append: false });
  });

  it("native 故障：回退 TS 实现并真实落盘", async () => {
    nativeMocks.error = new Error("host down");
    const out = await getTool("write_markdown").execute({ filename: "回退.md", content: "回退内容" }, {});
    expect(JSON.parse(out).success).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "回退.md"), "utf8")).toBe("回退内容");
  });

  it("业务失败载荷（success:false）：回退 TS 实现", async () => {
    nativeMocks.result = JSON.stringify({ success: false, errorCode: "E_X", error: "boom" });
    const out = await getTool("write_excel").execute(
      { filename: "回退.xlsx", sheets: [{ name: "S1", headers: ["a"], rows: [[1]] }] },
      {},
    );
    expect(out).toContain("[write_excel] 已生成：");
    expect(fs.existsSync(path.join(tmpDir, "回退.xlsx"))).toBe(true);
  });

  it("write_markdown 覆盖防骤降：拒绝抛错，不触达 native、文件原样", async () => {
    const target = path.join(tmpDir, "大文件.md");
    fs.writeFileSync(target, Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"), "utf8");
    await expect(
      getTool("write_markdown").execute({ filename: "大文件.md", content: "短" }, {}),
    ).rejects.toThrow(/覆盖写被拒绝/);
    expect(nativeMocks.calls).toHaveLength(0);
    expect(fs.readFileSync(target, "utf8")).toContain("line 59");
  });

  it("取消（AbortError）：原样上抛，不回退", async () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    nativeMocks.error = err;
    await expect(
      getTool("write_excel").execute({ filename: "取消.xlsx", sheets: [{ name: "S1", headers: ["a"], rows: [] }] }, {}),
    ).rejects.toThrow("aborted");
    expect(fs.existsSync(path.join(tmpDir, "取消.xlsx"))).toBe(false);
  });

  it("校验不通过（filename 非法）：不触达 native，走 TS 错误文案", async () => {
    const out = await getTool("write_excel").execute({ filename: "报表.csv", sheets: [] }, {});
    expect(out).toContain("必须是 .xlsx 结尾");
    expect(nativeMocks.calls).toHaveLength(0);
  });
});
