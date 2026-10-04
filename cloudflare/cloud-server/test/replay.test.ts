import { describe, expect, it } from "vitest";
import type { SyncEventV0 } from "../../../src/main/sync/sync-protocol";
import { replayBranch, trimContext } from "../src/replay";

function event(
  eventId: string,
  type: SyncEventV0["type"],
  payload: Record<string, unknown>,
  overrides: Partial<SyncEventV0> = {},
): SyncEventV0 {
  return {
    eventId,
    sessionId: "s1",
    type,
    lamport: 1,
    deviceId: "dev-a",
    seq: 1,
    ts: "2026-10-04T03:00:00.000Z",
    payload,
    ...overrides,
  };
}

const user = (id: string, turnId: string, text = "你好") =>
  event(id, "message.append", { role: "user", text, turnId });
const assistant = (id: string, turnId: string, text = "回复") =>
  event(id, "message.append", { role: "assistant", text, turnId });

describe("replayBranch", () => {
  it("基础对话：user/assistant 顺序保留，锚点 = 事件 id", () => {
    const branch = replayBranch([user("e1", "t1"), assistant("e2", "t1")]);
    expect(branch.map((item) => [item.role, item.anchorEventId])).toEqual([
      ["user", "e1"],
      ["assistant", "e2"],
    ]);
  });

  it("keep_user 重生成：裁掉锚点之后的尾，锚点改为回退事件", () => {
    const branch = replayBranch([
      user("e1", "t1"),
      assistant("e2", "t1"),
      event("e3", "turn_rewind", { anchorUserTurnId: "t1", disposition: "keep_user", reason: "regenerate" }),
    ]);
    expect(branch).toHaveLength(1);
    expect(branch[0]).toMatchObject({ role: "user", text: "你好", turnId: "t1", anchorEventId: "e3" });
  });

  it("replace_user 编辑：连锚点一起替换，其后全部裁掉", () => {
    const branch = replayBranch([
      user("e1", "t1", "旧文本"),
      assistant("e2", "t1"),
      event("e3", "turn_rewind", {
        anchorUserTurnId: "t1",
        disposition: "replace_user",
        reason: "edit",
        replacementUser: { text: "新文本" },
        revision: 2,
      }),
    ]);
    expect(branch).toHaveLength(1);
    expect(branch[0]).toMatchObject({ role: "user", text: "新文本", turnId: "t1", anchorEventId: "e3" });
  });

  it("tombstone：移除目标轮及其后连续 assistant", () => {
    const branch = replayBranch([
      user("e1", "t1"),
      assistant("e2", "t1"),
      user("e3", "t2"),
      assistant("e4", "t2"),
      event("e5", "tombstone", { targetUserTurnId: "t1", reason: "pending_withdrawn" }),
    ]);
    expect(branch.map((item) => item.anchorEventId)).toEqual(["e3", "e4"]);
  });

  it("裁剪后索引重建：旧轮 id 不再命中", () => {
    const branch = replayBranch([
      user("e1", "t1"),
      assistant("e2", "t1"),
      event("e3", "turn_rewind", { anchorUserTurnId: "t1", disposition: "keep_user", reason: "regenerate" }),
      event("e4", "turn_rewind", { anchorUserTurnId: "t9", disposition: "keep_user", reason: "regenerate" }),
    ]);
    expect(branch).toHaveLength(1);
    expect(branch[0].anchorEventId).toBe("e3");
  });
});

describe("trimContext", () => {
  it("预算内不动", () => {
    const context = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ];
    expect(trimContext(context, 100)).toHaveLength(2);
  });

  it("超预算从最旧丢起，保留 system 与最后一条", () => {
    const context = [
      { role: "system", content: "sys" },
      { role: "user", content: "a".repeat(50) },
      { role: "assistant", content: "b".repeat(50) },
      { role: "user", content: "最新" },
    ];
    const originalLength = context.length;
    const trimmed = trimContext(context, 60);
    expect(trimmed[0].role).toBe("system");
    expect(trimmed[trimmed.length - 1].content).toBe("最新");
    expect(trimmed.length).toBeLessThan(originalLength);
  });
});
