import { describe, expect, it } from "vitest";
import { groupByToolGroup, groupOfTool, TOOL_GROUP_LABELS } from "./tool-groups";

/** #187 分组规则（shared 单一事实源）：设置页与模型侧 catalog 共用。 */
describe("tool-groups", () => {
  it("前缀/精确映射：音乐/SSH/云存储/记忆/知识库/邮件/网络/系统", () => {
    expect(groupOfTool("music_play")).toBe("music");
    expect(groupOfTool("ssh_exec")).toBe("ssh");
    expect(groupOfTool("cloud_read")).toBe("storage");
    expect(groupOfTool("user_memory")).toBe("memory");
    expect(groupOfTool("write_memory")).toBe("memory");
    expect(groupOfTool("wiki_search")).toBe("knowledge");
    expect(groupOfTool("knowledge_search")).toBe("knowledge");
    expect(groupOfTool("email_read")).toBe("email");
    expect(groupOfTool("web_search")).toBe("network");
    expect(groupOfTool("fetch_url")).toBe("network");
    expect(groupOfTool("run_shell")).toBe("system");
    expect(groupOfTool("shell_job")).toBe("system");
  });

  it("未知前缀落 other（新工具自动归组）", () => {
    expect(groupOfTool("future_tool")).toBe("other");
    expect(groupOfTool("some_new_thing")).toBe("other");
  });

  it("组序=规则定义序，other 恒最后；空组不出现", () => {
    const sections = groupByToolGroup([
      { id: "run_shell" },
      { id: "music_play" },
      { id: "brand_new_tool" },
      { id: "ssh_exec" },
    ]);
    expect(sections.map((s) => s.key)).toEqual(["music", "ssh", "system", "other"]);
    expect(sections.every((s) => s.tools.length > 0)).toBe(true);
  });

  it("组内保持传入顺序（catalog 用注册序；设置页调用方先排字母序）", () => {
    const sections = groupByToolGroup([{ id: "music_play" }, { id: "music_library" }]);
    expect(sections[0].tools.map((t) => t.id)).toEqual(["music_play", "music_library"]);
  });

  it("组名覆盖全组（中文常量供模型侧 catalog）", () => {
    for (const key of ["music", "ssh", "storage", "memory", "knowledge", "email", "network", "system", "other"] as const) {
      expect(TOOL_GROUP_LABELS[key]).toBeTruthy();
    }
  });
});
