import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage, ChatSession } from "../../shared/chat-types";
import {
  collectChatExportAvatars,
  exportSessionsToDirectory,
  renderSessionHtml,
  renderSessionMarkdown,
  sanitizeFileName,
  uniqueFileName,
} from "./chat-export";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-chat-export-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m1",
    role: "user",
    content: "你好",
    at: Date.UTC(2026, 9, 2, 3, 4),
    ...overrides,
  };
}

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    title: "测试会话",
    identityId: null,
    messages: [makeMessage()],
    createdAt: 1_000,
    updatedAt: Date.UTC(2026, 9, 2, 5, 0),
    schemaVersion: 1,
    mode: "chat",
    ...overrides,
  };
}

describe("sanitizeFileName", () => {
  it("替换 Windows 非法字符并压缩空白", () => {
    expect(sanitizeFileName('a\\b/c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
    expect(sanitizeFileName("  多   空格  ")).toBe("多 空格");
  });

  it("空标题回退默认名，超长截断", () => {
    expect(sanitizeFileName("")).toBe("未命名会话");
    expect(sanitizeFileName("x".repeat(100))).toHaveLength(60);
  });
});

describe("uniqueFileName", () => {
  it("重名自动编号", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "a.html"), "x");
    fs.writeFileSync(path.join(dir, "a-2.html"), "x");
    expect(uniqueFileName(dir, "a", ".html")).toBe("a-3.html");
    expect(uniqueFileName(dir, "b", ".html")).toBe("b.html");
  });
});

describe("collectChatExportAvatars", () => {
  it("读取双方头像文件为 data URI", () => {
    const dir = makeTempDir();
    const userPath = path.join(dir, "avatar.png");
    const assistantPath = path.join(dir, "cyrene-avatar.jpg");
    fs.writeFileSync(userPath, Buffer.from([1, 2, 3]));
    fs.writeFileSync(assistantPath, Buffer.from([4, 5, 6]));
    const avatars = collectChatExportAvatars({ userAvatarPath: userPath, assistantAvatarPath: assistantPath });
    expect(avatars.user.startsWith("data:image/png;base64,")).toBe(true);
    expect(avatars.assistant.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("文件缺失时回退程序绘制头像", () => {
    const avatars = collectChatExportAvatars({ userAvatarPath: null, assistantAvatarPath: "Z:\\missing.png" });
    expect(avatars.user.startsWith("data:image/svg+xml,")).toBe(true);
    expect(avatars.assistant.startsWith("data:image/svg+xml,")).toBe(true);
  });
});

describe("renderSessionHtml", () => {
  it("渲染气泡、转义正文、内嵌图片附件与折叠块", () => {
    const dir = makeTempDir();
    const imagePath = path.join(dir, "shot.png");
    fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
    const session = makeSession({
      title: "<危险> 标题",
      messages: [
        makeMessage({
          content: "看这个 <b>标签</b>",
          channelSource: { channel: "wechat", senderName: "张三" },
          attachments: [{ kind: "image", name: "截图", filePath: imagePath, mime: "image/png", status: "done" }],
          sticker: "playful",
        }),
        makeMessage({
          id: "m2",
          role: "model",
          content: "收到",
          reasoningBlocks: [{ id: "r1", content: "先想一想" }],
          processMessages: [{ id: "p1", content: "正在处理" }],
          toolExecutions: [
            { id: "t1", name: "run_shell", displayName: "运行命令", status: "success", result: "ok", argsText: "echo hi" },
          ],
        }),
      ],
    });

    const html = renderSessionHtml(session, Date.UTC(2026, 9, 2, 6, 0));
    expect(html).toContain("&lt;危险&gt; 标题");
    expect(html).not.toContain("<危险>");
    expect(html).toContain("看这个 &lt;b&gt;标签&lt;/b&gt;");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("来自 微信 · 张三");
    expect(html).toContain("表情包：playful");
    expect(html).toContain("思考过程");
    expect(html).toContain("先想一想");
    expect(html).toContain("正在处理");
    expect(html).toContain("工具调用（1 次）");
    expect(html).toContain("运行命令");
    expect(html).toContain("echo hi");
    expect(html).toContain("msg-user");
    expect(html).toContain("msg-assistant");
    // 未传头像时用默认 SVG
    expect(html).toContain("data:image/svg+xml,");
  });

  it("空会话给出占位说明", () => {
    const html = renderSessionHtml(makeSession({ messages: [] }), 1);
    expect(html).toContain("（该会话没有消息）");
  });
});

describe("renderSessionMarkdown", () => {
  it("输出标题、消息段与折叠块", () => {
    const session = makeSession({
      title: "Markdown 会话",
      messages: [
        makeMessage({ content: "问题" }),
        makeMessage({
          id: "m2",
          role: "model",
          content: "回答",
          reasoning: "推理内容",
          toolExecutions: [{ id: "t1", name: "read_file", status: "error", result: "not found" }],
        }),
      ],
    });
    const md = renderSessionMarkdown(session, Date.UTC(2026, 9, 2, 6, 0));
    expect(md).toContain("# Markdown 会话");
    expect(md).toContain("- 消息数：2 条");
    expect(md).toContain("## 用户");
    expect(md).toContain("## 昔涟");
    expect(md).toContain("<details><summary>思考过程</summary>");
    expect(md).toContain("推理内容");
    expect(md).toContain("<details><summary>工具调用（1 次）</summary>");
    expect(md).toContain("read_file · 失败");
  });
});

describe("exportSessionsToDirectory", () => {
  it("HTML 落根目录、Markdown 落 markdown 子目录，重名自动编号", () => {
    const target = makeTempDir();
    const sessionA = makeSession({ id: "a", title: "同名" });
    const sessionB = makeSession({ id: "b", title: "同名" });
    const outcome = exportSessionsToDirectory({
      sessions: [sessionA, sessionB],
      formats: ["html", "markdown"],
      targetDir: target,
      exportedAt: Date.UTC(2026, 9, 2, 6, 0),
    });

    expect(outcome.errors).toEqual([]);
    expect(outcome.files).toHaveLength(4);
    const htmlFiles = outcome.files.filter((file) => file.name.endsWith(".html"));
    const mdFiles = outcome.files.filter((file) => file.name.endsWith(".md"));
    expect(htmlFiles.map((file) => file.name)).toEqual(["同名-20261002.html", "同名-20261002-2.html"]);
    expect(mdFiles.every((file) => file.path.includes(`${path.sep}markdown${path.sep}`))).toBe(true);
    for (const file of outcome.files) expect(fs.existsSync(file.path)).toBe(true);
    expect(fs.readFileSync(htmlFiles[0].path, "utf8")).toContain("<!DOCTYPE html>");
    expect(fs.readFileSync(mdFiles[0].path, "utf8")).toContain("# 同名");
  });

  it("空格式或空会话不产出文件", () => {
    const target = makeTempDir();
    expect(exportSessionsToDirectory({ sessions: [makeSession()], formats: [], targetDir: target }).files).toEqual([]);
    expect(exportSessionsToDirectory({ sessions: [], formats: ["html"], targetDir: target }).files).toEqual([]);
  });
});
