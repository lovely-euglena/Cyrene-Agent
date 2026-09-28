import type { ConversationMode } from "../../shared/chat-types";
import { loadPromptFile } from "../prompts/prompt-loader";
import { buildGoldenDescendantsPrompt } from "../tasks/task-character-pool";

export type PromptLoader = (filename: string) => string;

// 人格来源：chat 模式通过 MODE_FILES 加载 soul.md（完整人格）。
// work / learn / code 模式不加载 soul.md，其人格由 cyrene_harness.md 的精简人设承载
// （见 harness/adapter/prompt-builder.ts：非 chat 模式追加 harnessPersona）。
// 修改人格设定时，注意这两处来源需要保持一致。
const MODE_FILES: Record<ConversationMode, readonly string[]> = {
  chat: ["chat_system.md", "chat_identity.md", "soul.md", "canon_quotes.md"],
  work: ["work_system.md", "work_identity.md", "work_remark.md", "canon_quotes_lite.md"],
  learn: ["learn_system.md", "learn_identity.md", "canon_quotes.md"],
  code: ["code_system.md", "code_identity.md", "code_remark.md", "canon_quotes_lite.md"],
};

export function buildModePrompt(mode: ConversationMode, load: PromptLoader = loadPromptFile): string {
  const goldenDescendants = mode === "work" || mode === "code"
    ? buildGoldenDescendantsPrompt()
    : "";
  return [...MODE_FILES[mode].map(load), goldenDescendants].filter(Boolean).join("\n\n---\n\n");
}
