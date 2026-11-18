/**
 * 对话滚动跟随状态机（issue #175：滚动跟随改进）
 *
 * 三个症状的统一根因与对策：
 * 1. 流式输出时用户上滚阅读历史，新内容把视口强拉回底 —— 原非虚拟路径
 *    `Bubble.List autoScroll`（antd 内建）无条件跟底，不问用户意图。
 *    → wheel 向上滚动即锁定「不跟随」，手动回底（< NEAR_BOTTOM_PX）才恢复。
 * 2. 流式内容增高把距离拉大，纯距离判定把用户误判为「已离开底部」而跟丢。
 *    → 跟随状态只由用户动作翻转（上滚锁 / 回底解），内容增高不参与判定，
 *      跟随中直接贴底即可。
 * 3. 图片 / 代码块等异步渲染完成后容器高度突增，视口位置被顶走。
 *    → 高度变化时：跟随中 → 贴底；阅读中 → scrollTop 补偿同额增量（锚定视口，
 *      与增高发生在视口上方还是下方无关）。
 *
 * 纯状态机、不依赖 DOM，契约测试见 chat-scroll-follow.test.ts。
 */

export const SCROLL_NEAR_BOTTOM_PX = 100;

/** 最小滚动面接口（容器元素的可测子集） */
export interface ScrollFollowElement {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollFollowController {
  /** wheel：向上滚（deltaY<0）且不在顶部 → 锁定不跟随；下滚与顶部橡皮筋不改变状态 */
  onWheel(deltaY: number, atTop: boolean): void;
  /** scroll：更新近底判定；回底自动恢复跟随。返回是否近底（底部按钮可见性取反使用） */
  onScroll(el: ScrollFollowElement): boolean;
  /**
   * 内容高度变化（流式渲染 / 图片与代码块异步加载）：跟随中 → 贴底；
   * 阅读中且高度增长 → scrollTop 补偿锚定视口。返回是否移动了滚动位置。
   */
  onContentGrew(el: ScrollFollowElement, grewBy: number): boolean;
  /** 会话切换等场景：重置为跟随 */
  reset(): void;
  isFollowing(): boolean;
}

export function createScrollFollowController(): ScrollFollowController {
  let following = true;
  return {
    onWheel(deltaY: number, atTop: boolean) {
      // 顶部继续上滚是边缘橡皮筋，不是「我要看历史」的意图
      if (deltaY < 0 && !atTop) following = false;
    },
    onScroll(el: ScrollFollowElement) {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const nearBottom = distance < SCROLL_NEAR_BOTTOM_PX;
      if (nearBottom) following = true;
      return nearBottom;
    },
    onContentGrew(el: ScrollFollowElement, grewBy: number) {
      if (following) {
        el.scrollTop = el.scrollHeight;
        return true;
      }
      if (grewBy > 0) {
        // scrollHeight 增量与 scrollTop 同额补偿 = 视口相对内容不动
        el.scrollTop += grewBy;
        return true;
      }
      return false;
    },
    reset() {
      following = true;
    },
    isFollowing() {
      return following;
    },
  };
}

/**
 * 同步容器内容高度基线并返回增量。items 渲染 effect 与 ResizeObserver 回调
 * 共用，保证两个通道先后触发时只对同一段增量各处理一次（贴底幂等，补偿不叠加）。
 */
export function takeContentGrew(el: ScrollFollowElement, lastScrollHeightRef: { current: number }): number {
  const grewBy = el.scrollHeight - lastScrollHeightRef.current;
  lastScrollHeightRef.current = el.scrollHeight;
  return grewBy;
}
