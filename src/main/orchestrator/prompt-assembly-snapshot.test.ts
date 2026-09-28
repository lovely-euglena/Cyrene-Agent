import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { buildModePrompt } from "./mode-prompt-profile";
import type { ConversationMode } from "../../shared/chat-types";

const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts/", import.meta.url));

function loadRepoPrompt(filename: string): string {
  const filePath = path.join(PROMPTS_DIR, filename);
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
}

function topHeadings(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,2}\s/.test(line));
}

const MODES: readonly ConversationMode[] = ["chat", "work", "learn", "code"];

/** 不经 buildModePrompt 组装、由各自链路单独加载的提示词。 */
const STANDALONE_PROMPTS = [
  "cyrene_harness.md",
  "tool_usage.md",
  "phone_system.md",
  "phone_identity.md",
  "phone_style.md",
  "cita_system.md",
] as const;

describe("mode prompt assembly snapshot", () => {
  for (const mode of MODES) {
    it(`assembles the ${mode} persona prompt from stable sources`, () => {
      const loaded: string[] = [];
      const prompt = buildModePrompt(mode, (filename) => {
        loaded.push(filename);
        return loadRepoPrompt(filename);
      });

      expect(loaded).not.toHaveLength(0);
      expect(new Set(loaded).size).toBe(loaded.length);
      expect(prompt).toContain("\n\n---\n\n");

      // 快照只记录加载顺序、章节结构与体量，不锁死具体措辞。
      expect({
        mode,
        loaded,
        chars: prompt.length,
        headings: topHeadings(prompt),
      }).toMatchSnapshot();
    });
  }

  it("keeps standalone prompt sizes visible", () => {
    const report = STANDALONE_PROMPTS.map((file) => {
      const content = loadRepoPrompt(file);
      return { file, chars: content.length, headings: topHeadings(content) };
    });

    expect(report.every((entry) => entry.chars > 0)).toBe(true);
    expect(report).toMatchSnapshot();
  });
});
