import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const fontsDir = resolve(__dirname, "../public/fonts");
const css = readFileSync(resolve(__dirname, "fonts.css"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(fontsDir, "manifest.json"), "utf8"));

describe("随包代码字体", () => {
  it("仅从本地加载现有的 400 和 500 字重", () => {
    expect(css).not.toMatch(/@import|https?:|local\(/);
    const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map((match) => match[1]);
    expect(faces).toHaveLength(2);
    for (const [index, weight] of [400, 500].entries()) {
      expect(faces[index]).toContain('font-family: "JetBrains Mono"');
      expect(faces[index]).toContain(`font-weight: ${weight};`);
      expect(faces[index]).toContain("font-display: swap;");
      expect(faces[index]).toContain(`/fonts/${manifest.fonts[index].file}`);
    }
  });

  it("保留固定来源、原始字体和完整版权许可", () => {
    expect(manifest.license).toBe("OFL-1.1");
    expect(manifest.fonts.map((font: { weight: number }) => font.weight)).toEqual([400, 500]);
    for (const file of manifest.files) {
      const bytes = readFileSync(resolve(fontsDir, file.file));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256.toLowerCase());
    }
    for (const font of manifest.fonts) {
      expect(font.source.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(font.source.url).toContain(`/${font.source.commit}/fonts/webfonts/${font.file}`);
      expect(readFileSync(resolve(fontsDir, font.file)).subarray(0, 4).toString()).toBe("wOF2");
    }
    const license = readFileSync(resolve(fontsDir, "JetBrainsMono-OFL.txt"), "utf8");
    expect(license).toContain("Copyright 2020 The JetBrains Mono Project Authors");
    expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(license).toContain("TERMINATION");
    expect(license).toContain("DISCLAIMER");
  });
});
