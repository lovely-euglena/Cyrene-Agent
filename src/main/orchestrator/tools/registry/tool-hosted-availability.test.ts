import { afterEach, describe, expect, it } from "vitest";
import { toolRegistry, setHostedToolAvailabilityForTest } from "./tool-registry";
// 副作用 import：built-in-tools 顶层完成全部注册（与 snapshot 测试同模式）
import "../built-in-tools";

/** #162 工具瘦身①：SSH/云存储/音乐三组托管工具的可用性过滤。
 * 未配置宿主/曲库时整组从 prompt（目录+schema）消失；配置后恢复。 */

const GROUPS: Record<string, string[]> = {
  ssh: ["ssh_profiles", "ssh_profile_save", "ssh_open", "ssh_exec", "ssh_close"],
  storage: ["cloud_profiles", "cloud_profile_save", "cloud_read", "cloud_download", "cloud_upload", "cloud_manage"],
  music: ["music_library", "music_now_playing", "music_play", "music_manage"],
};

function visibleIds(): Set<string> {
  return new Set(toolRegistry.getEnabledTools().map((t) => t.id));
}

afterEach(() => setHostedToolAvailabilityForTest(null));

describe("hosted tool availability（#162）", () => {
  it("默认态（无宿主/无曲库）：三组工具全部不可见", () => {
    const ids = visibleIds();
    for (const tools of Object.values(GROUPS)) {
      for (const id of tools) expect(ids.has(id), id).toBe(false);
    }
  });

  it("配置恢复：override 置真后整组回到目录，其他组仍隐藏", () => {
    setHostedToolAvailabilityForTest({ ssh: true });
    const ids = visibleIds();
    for (const id of GROUPS.ssh) expect(ids.has(id), id).toBe(true);
    for (const id of [...GROUPS.storage, ...GROUPS.music]) expect(ids.has(id), id).toBe(false);
  });

  it("组内粒度：隐藏按组生效，组外工具不受影响（run_shell 仍在）", () => {
    setHostedToolAvailabilityForTest(null);
    const ids = visibleIds();
    expect(ids.has("run_shell")).toBe(true);
    expect(ids.has("ssh_exec")).toBe(false);
  });

  it("mode 过滤链同样生效（getEnabledToolsForMode 与总目录一致）", () => {
    setHostedToolAvailabilityForTest({ storage: true });
    const work = new Set(toolRegistry.getEnabledToolsForMode("work").map((t) => t.id));
    expect(work.has("cloud_profiles")).toBe(true);
    expect(work.has("ssh_exec")).toBe(false);
  });
});
