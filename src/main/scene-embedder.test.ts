import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { SCENE_EXAMPLES, SCENE_LABELS } from "./scene-embedder";

const REFERENCES_DIR = fileURLToPath(new URL("../../skills/cyrene-original-voice/references/", import.meta.url));

/** 允许没有专属样本文件的场景（仅注入通用语气规则）。 */
const NO_SAMPLE_ALLOWED = new Set(["daily"]);

describe("scene embedder alignment", () => {
  it("has anchors and a label for every scene", () => {
    for (const [scene, examples] of Object.entries(SCENE_EXAMPLES)) {
      expect(examples.length, scene).toBeGreaterThanOrEqual(6);
      expect(new Set(examples).size, scene).toBe(examples.length);
      expect(SCENE_LABELS[scene], scene).toBeTruthy();
    }
  });

  it("keeps labels and scenes in one-to-one correspondence", () => {
    expect(Object.keys(SCENE_LABELS).sort()).toEqual(Object.keys(SCENE_EXAMPLES).sort());
  });

  it("maps reference sample files to known scenes", () => {
    const files = fs.readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md"));
    const problems: string[] = [];
    for (const file of files) {
      const scene = file.replace(/\.md$/, "");
      if (!(scene in SCENE_EXAMPLES)) problems.push(`样本文件没有对应场景: ${file}`);
    }
    for (const scene of Object.keys(SCENE_EXAMPLES)) {
      if (!files.includes(`${scene}.md`) && !NO_SAMPLE_ALLOWED.has(scene)) {
        problems.push(`场景缺少样本文件: ${scene}.md`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps reference sample files usable", () => {
    for (const file of fs.readdirSync(REFERENCES_DIR).filter((name) => name.endsWith(".md"))) {
      const content = fs.readFileSync(path.join(REFERENCES_DIR, file), "utf8");
      expect(content.includes("> 「"), file).toBe(true);
    }
  });
});
