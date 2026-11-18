/**
 * issue #147：桌宠气泡控制器。
 *
 * - 回复 delta 流式渲染（PET_BUBBLE_TEXT），2000 字上限防长回复撑爆；
 * - TEXT_MESSAGE_END / RUN_FINISHED 后 8s 自动淡出；hover 期间保持，移开续倒计时；
 * - 点击气泡 → 聚焦聊天主窗（PET_BUBBLE_FOCUS_CHAT）；× 关闭本次显示；
 * - click-through 协调：气泡可见且指针在气泡内时强制窗口可交互
 *   （ClickThroughController 按模型像素判定，气泡是 DOM 覆盖层不在其采样内）。
 *
 * 纯 DOM 控制器（pet 窗非 React），无框架依赖。
 */
export class PetBubbleController {
  private static readonly MAX_CHARS = 2000;
  private static readonly AUTO_DISMISS_MS = 8000;

  private readonly root: HTMLElement;
  private readonly text: HTMLElement;
  private readonly closeBtn: HTMLElement;
  private readonly setInteractive: (interactive: boolean) => void;

  private charCount = 0;
  private dismissTimer: number | null = null;
  private hoverCount = 0;
  private disposed = false;

  constructor(input: {
    root: HTMLElement;
    setInteractive: (interactive: boolean) => void;
  }) {
    this.root = input.root;
    this.setInteractive = input.setInteractive;
    this.text = this.root.querySelector(".pet-bubble__text") as HTMLElement;
    this.closeBtn = this.root.querySelector(".pet-bubble__close") as HTMLElement;

    this.root.addEventListener("mouseenter", () => {
      this.hoverCount++;
      this.cancelDismiss();
      this.setInteractive(true);
    });
    this.root.addEventListener("mouseleave", () => {
      this.hoverCount = Math.max(0, this.hoverCount - 1);
      if (this.hoverCount === 0) {
        this.setInteractive(false);
        if (!this.root.hidden) this.scheduleDismiss();
      }
    });
    this.closeBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.hide();
    });
    this.root.addEventListener("click", () => {
      window.cyrenePetBubble?.focusChat();
    });
  }

  /** 收到回复 delta：显示气泡并追加文本。 */
  appendDelta(delta: string): void {
    if (this.disposed || !delta) return;
    if (this.root.hidden) {
      this.root.hidden = false;
      this.root.classList.remove("is-fading");
      this.charCount = 0;
      this.text.textContent = "";
    }
    this.cancelDismiss();
    if (this.charCount < PetBubbleController.MAX_CHARS) {
      const room = PetBubbleController.MAX_CHARS - this.charCount;
      this.text.textContent += delta.length > room ? delta.slice(0, room) + "…" : delta;
      this.charCount = Math.min(PetBubbleController.MAX_CHARS, this.charCount + delta.length);
      this.text.scrollTop = this.text.scrollHeight; // 跟随滚动到底
    }
  }

  /** 回复终态：开始自动淡出倒计时。 */
  finish(): void {
    if (this.disposed || this.root.hidden) return;
    if (this.hoverCount > 0) return; // hover 中不打扰
    this.scheduleDismiss();
  }

  hide(): void {
    this.cancelDismiss();
    this.root.hidden = true;
    this.text.textContent = "";
    this.charCount = 0;
    this.setInteractive(false);
  }

  dispose(): void {
    this.disposed = true;
    this.hide();
  }

  private scheduleDismiss(): void {
    this.cancelDismiss();
    this.dismissTimer = window.setTimeout(() => {
      this.root.classList.add("is-fading");
      this.dismissTimer = window.setTimeout(() => this.hide(), 700); // 过渡后收
    }, PetBubbleController.AUTO_DISMISS_MS);
  }

  private cancelDismiss(): void {
    if (this.dismissTimer !== null) {
      window.clearTimeout(this.dismissTimer);
      this.dismissTimer = null;
    }
    this.root.classList.remove("is-fading");
  }
}
