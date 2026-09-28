import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PROMPTS_DIR = fileURLToPath(new URL("../../../prompts/", import.meta.url));

function walk(dir: string, accept: (fileName: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (accept(entry.name)) out.push(full);
  }
  return out;
}

const relPath = (file: string): string => path.relative(PROMPTS_DIR, file).split(path.sep).join("/");

const ALL_MD = walk(PROMPTS_DIR, (name) => name.endsWith(".md")).sort();

/** 允许为空的模板文件：运行时拷贝到 userData 由用户填写（styles/custom/custom.md）。 */
const EMPTY_ALLOWED = new Set(["styles/custom/custom.md"]);

/** 不要求以 Markdown 标题开头的文件（cita 是纯 JSON 服务提示词，直接以角色声明开头）。 */
const HEADING_EXEMPT = new Set([...EMPTY_ALLOWED, "cita_system.md"]);

/** 去掉 YAML frontmatter，返回正文。 */
function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/** 明确禁止的残留：编辑器占位、作者批注、未替换变量与待办标记。 */
const RESIDUE_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["未替换的模板占位符 {{...}}", /\{\{[^{}]+\}\}/],
  ["作者批注【新增】", /【新增】/],
  ["作者批注【设定校准】", /【设定校准】/],
  ["作者批注「建议正文」", /建议正文/],
  ["作者批注「口径混乱」", /口径混乱/],
  ["编辑器占位符「请输入文本」", /请输入文本/],
  ["编辑器残留「（官方加粗）」", /（官方加粗）/],
  ["编辑器残留 StarRail.Character", /StarRail\.Character/],
  ["待办标记 TODO/FIXME", /\b(?:TODO|FIXME)\b/],
];

/** 核心提示词必须保留的条款（防误删/防静默改坏）。 */
const REQUIRED_CLAUSES: Record<string, readonly string[]> = {
  "soul.md": ["避免生成的伪人格", "背景与记忆边界", "不进行情绪勒索"],
  "chat_system.md": ["上下文与事实边界", "禁止行为"],
  "work_system.md": ["外部内容与指令隔离", "禁止行为"],
  "code_system.md": ["工作区事实原则", "执行适配"],
  "learn_system.md": ["事实优先原则", "禁止行为"],
  "tool_usage.md": ["真实性纪律", "Skill 使用规范"],
  "cyrene_harness.md": ["Function Calling 边界", "任务正确性 > 信息清晰 > 昔涟风格"],
  "tone-rules.md": ["## 句式禁止", "## 回复边界"],
};

describe("prompts lint", () => {
  it("discovers the prompt bundle", () => {
    expect(ALL_MD.length).toBeGreaterThan(20);
  });

  it("has no residue or unresolved placeholders", () => {
    const problems: string[] = [];
    for (const file of ALL_MD) {
      if (EMPTY_ALLOWED.has(relPath(file))) continue;
      const content = fs.readFileSync(file, "utf8");
      for (const [label, pattern] of RESIDUE_PATTERNS) {
        if (pattern.test(content)) problems.push(`${relPath(file)}: ${label}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("uses consistent line endings and no BOM", () => {
    const problems: string[] = [];
    for (const file of ALL_MD) {
      const content = fs.readFileSync(file, "utf8");
      if (content.charCodeAt(0) === 0xfeff) problems.push(`${relPath(file)}: 含 BOM`);
      if (/\r(?!\n)/.test(content)) problems.push(`${relPath(file)}: 存在孤立 CR`);
    }
    expect(problems).toEqual([]);
  });

  it("starts every non-empty prompt with a markdown heading", () => {
    const problems: string[] = [];
    for (const file of ALL_MD) {
      const rel = relPath(file);
      if (HEADING_EXEMPT.has(rel)) continue;
      const content = stripFrontmatter(fs.readFileSync(file, "utf8"));
      const firstLine = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
      if (!/^#{1,6}\s/.test(firstLine.trim())) problems.push(`${rel}: 首个非空行不是标题`);
    }
    expect(problems).toEqual([]);
  });

  it("keeps required clauses in core prompts", () => {
    const problems: string[] = [];
    for (const [rel, clauses] of Object.entries(REQUIRED_CLAUSES)) {
      const content = fs.readFileSync(path.join(PROMPTS_DIR, rel), "utf8");
      for (const clause of clauses) {
        if (!content.includes(clause)) problems.push(`${rel}: 缺少「${clause}」`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("keeps worldbook entries well-formed", () => {
    const files = walk(path.join(PROMPTS_DIR, "worldbook"), (name) => name.endsWith(".md"));
    // _glossary.md 是称谓映射，不参与触发/注入，属已知特例。
    const knownInert = new Set(["_glossary.md"]);
    const requiredMeta: ReadonlyArray<readonly [string, RegExp]> = [
      ["触发词", /^-\s*触发词\s*[：:]/],
      ["常驻", /^-\s*常驻\s*[：:]/],
      ["内在价值", /^-\s*(?:内在价值|初始分|intrinsic_value)\s*[：:]/],
      ["优先级", /^-\s*优先级\s*[：:]/],
    ];
    const isMetaLine = (line: string): boolean => /^-\s*(?:触发词|常驻|内在价值|初始分|intrinsic_value|优先级|连带触发词|连带触发|link_triggers)\s*[：:]/.test(line);

    const problems: string[] = [];
    for (const file of files) {
      if (knownInert.has(path.basename(file))) continue;
      let title = "";
      let meta: string[] = [];
      let body: string[] = [];
      const validate = (): void => {
        if (!title) return;
        for (const [label, pattern] of requiredMeta) {
          if (!meta.some((line) => pattern.test(line))) {
            problems.push(`${relPath(file)} · ${title}: 缺少「${label}」`);
          }
        }
        if (body.join("\n").trim().length === 0) {
          problems.push(`${relPath(file)} · ${title}: 正文为空`);
        }
      };
      for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith("## ")) {
          validate();
          title = trimmed.slice(3).trim();
          meta = [];
          body = [];
        } else if (title) {
          if (trimmed === "---") continue;
          if (isMetaLine(trimmed)) meta.push(trimmed);
          else body.push(line);
        }
      }
      validate();
    }
    expect(problems).toEqual([]);
  });

  it("keeps moments persona cards parseable", () => {
    const dir = path.join(PROMPTS_DIR, "moments_personas");
    // _header 是共享注入头；昔涟由主对话链路承载，不是朋友圈角色卡。
    const exempt = new Set(["_header.md", "昔涟.md"]);
    const problems: string[] = [];
    for (const file of walk(dir, (name) => name.endsWith(".md"))) {
      const base = path.basename(file);
      if (exempt.has(base)) continue;
      const frontmatter = fs.readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!frontmatter) {
        problems.push(`${base}: 缺少 frontmatter`);
        continue;
      }
      for (const field of ["comment", "like"]) {
        if (!new RegExp(`^${field}\\s*:\\s*\\S`, "m").test(frontmatter[1])) {
          problems.push(`${base}: frontmatter 缺少 ${field}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
