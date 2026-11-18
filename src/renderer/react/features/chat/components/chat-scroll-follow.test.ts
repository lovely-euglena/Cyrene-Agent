// 滚动跟随状态机契约测试（issue #175）：
// 上滚锁 / 回底解 / 流式贴底 / 高度补偿锚定 / 会话切换重置。
// 纯状态机测试，el 用 fake 对象模拟 scrollHeight/scrollTop/clientHeight。
import { describe, expect, it } from "vitest";
import { createScrollFollowController, takeContentGrew, type ScrollFollowElement } from "./chat-scroll-follow";

function fakeEl(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollFollowElement {
  return { scrollTop, scrollHeight, clientHeight };
}

describe("createScrollFollowController", () => {
  it("初态为跟随", () => {
    expect(createScrollFollowController().isFollowing()).toBe(true);
  });

  it("wheel 向上滚动锁定跟随，回到底部解锁", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, false);
    expect(c.isFollowing()).toBe(false);
    // 阅读中回到底部附近 → 恢复跟随
    const nearBottom = c.onScroll(fakeEl(900, 1000, 120)); // distance = -20（越界钳制在底部）
    expect(nearBottom).toBe(true);
    expect(c.isFollowing()).toBe(true);
  });

  it("wheel 在顶部向上滚（橡皮筋）不锁定", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, true);
    expect(c.isFollowing()).toBe(true);
  });

  it("wheel 向下滚不改变跟随状态", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, false);
    c.onWheel(200, false);
    expect(c.isFollowing()).toBe(false);
  });

  it("流式增高把距离拉大但未上滚时，跟随状态不被误判（跟丢根因防御）", () => {
    const c = createScrollFollowController();
    // 内容增高后距底 300px，但用户从未上滚——跟随必须保持
    const nearBottom = c.onScroll(fakeEl(100, 1400, 1000)); // distance = 300
    expect(nearBottom).toBe(false);
    expect(c.isFollowing()).toBe(true);
  });

  it("跟随中内容增高 → 贴底", () => {
    const c = createScrollFollowController();
    const el = fakeEl(100, 1400, 1000);
    expect(c.onContentGrew(el, 300)).toBe(true);
    expect(el.scrollTop).toBe(1400);
  });

  it("阅读中内容增高 → scrollTop 同额补偿锚定视口", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, false);
    const el = fakeEl(400, 1400, 1000);
    expect(c.onContentGrew(el, 250)).toBe(true);
    expect(el.scrollTop).toBe(650);
  });

  it("阅读中高度无增长/收缩 → 不移动滚动位置", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, false);
    const el = fakeEl(400, 1400, 1000);
    expect(c.onContentGrew(el, 0)).toBe(false);
    expect(el.scrollTop).toBe(400);
    expect(c.onContentGrew(el, -50)).toBe(false);
    expect(el.scrollTop).toBe(400);
  });

  it("reset 恢复跟随（会话切换语义）", () => {
    const c = createScrollFollowController();
    c.onWheel(-120, false);
    c.reset();
    expect(c.isFollowing()).toBe(true);
    const el = fakeEl(0, 800, 1000);
    c.onContentGrew(el, 800);
    expect(el.scrollTop).toBe(800);
  });
});

describe("takeContentGrew", () => {
  it("返回与上次基线的增量并更新基线（双通道共用不重复补偿）", () => {
    const ref = { current: 1000 };
    const el = fakeEl(0, 1300, 1000);
    expect(takeContentGrew(el, ref)).toBe(300);
    expect(ref.current).toBe(1300);
    // ResizeObserver 与 items effect 先后触发同一段增量，第二次为 0
    expect(takeContentGrew(el, ref)).toBe(0);
  });
});
