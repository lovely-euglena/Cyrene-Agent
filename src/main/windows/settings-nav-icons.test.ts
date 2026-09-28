/**
 * 设置导航图标（生成产物）回归：
 *   1. SettingsWindow.cs 每个 AddSection(id) 在 SettingsNavIcons.cs 都能找到图标
 *      （几何或图片）——缺定义时导航项会空一块（历史问题：cyrene 漏图标）；
 *   2. 图片图标引用 dotnet/native-windows/Assets 下真实存在的资源；
 *   3. 单色白稿必须标记 Tint（直接贴白图在浅色导航底上不可见）。
 * 产物由脚本生成，勿手改：node scripts/gen-settings-nav-icons.mjs
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsWindowCs = fs.readFileSync(
  fileURLToPath(new URL("../../../dotnet/native-windows/SettingsWindow.cs", import.meta.url)),
  "utf8",
);
const navIconsCs = fs.readFileSync(
  fileURLToPath(new URL("../../../dotnet/native-windows/SettingsNavIcons.cs", import.meta.url)),
  "utf8",
);

/** 取生成文件里某个字典的 [{ key: 定义行 }]（截到字典结尾的 `};`）。 */
function extractDictEntries(source: string, marker: string): Map<string, string> {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`缺少字典: ${marker}`);
  const end = source.indexOf("};", start);
  const body = source.slice(start, end);
  const entries = new Map<string, string>();
  for (const match of body.matchAll(/\["([^"]+)"\] = ([^\n]+),/g)) {
    entries.set(match[1], match[2].trim());
  }
  return entries;
}

const geometryIcons = extractDictEntries(navIconsCs, "GeometryIcons = new()");
const imageIcons = extractDictEntries(navIconsCs, "ImageIcons = new()");

describe("设置导航图标（生成产物契约）", () => {
  it("SettingsWindow 每个 AddSection 都有图标定义", () => {
    const sections = [...settingsWindowCs.matchAll(/AddSection\("([^"]+)"/g)].map((match) => match[1]);
    expect(sections.length).toBeGreaterThan(10);
    for (const section of sections) {
      const hasIcon = geometryIcons.has(section) || imageIcons.has(section);
      expect(hasIcon, `section 缺导航图标: ${section}`).toBe(true);
    }
  });

  it("图片图标引用真实资源；单色白稿必须标记 Tint", () => {
    expect(imageIcons.size).toBeGreaterThan(0);
    for (const [section, spec] of imageIcons) {
      const path = spec.match(/"([^"]+)"/)?.[1];
      expect(path, `图片图标路径异常: ${section}`).toBeTruthy();
      const asset = fileURLToPath(
        new URL(`../../../dotnet/native-windows/Assets/${path}`, import.meta.url),
      );
      expect(fs.existsSync(asset), `图标资源缺失: ${path}（${section}）`).toBe(true);
      if (path!.endsWith("-white.png")) {
        expect(spec, `白稿图标必须 Tint（浅色底不可见）: ${section}`).toContain("true");
      }
    }
  });
});
