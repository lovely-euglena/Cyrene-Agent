import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(fileURLToPath(new URL("./ChatExportDialog.tsx", import.meta.url)), "utf8");

const localeFiles = ["zh-CN", "en", "ja-JP"] as const;
const locales = localeFiles.map((name) => ({
  name,
  json: JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../../i18n/${name}.json`, import.meta.url)), "utf8")) as Record<string, unknown>,
}));

function readKey(json: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => {
    if (!node || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[part];
  }, json);
}

describe("ChatExportDialog", () => {
  it("通过 chatStore 桥接导出/定位，不直接触碰 IPC 或浏览器弹窗", () => {
    expect(source).toContain("chatStore()");
    expect(source).toContain("exportChats");
    expect(source).toContain("revealExportPath");
    expect(source).not.toContain("ipcRenderer");
    expect(source).not.toContain("window.confirm");
    expect(source).not.toContain("window.prompt");
    expect(source).not.toContain("Modal.confirm");
  });

  it("导出相关 i18n key 在三个语言包中齐全", () => {
    const staticKeys = [...source.matchAll(/t\("(chatExport\.[A-Za-z]+)"/g)].map((match) => match[1]);
    const keys = new Set([
      ...staticKeys,
      // MODE_LABEL_KEYS 的动态映射值
      "chatExport.modeChat",
      "chatExport.modeWork",
      "chatExport.modeCode",
      "chatExport.modeLearn",
    ]);
    expect(keys.size).toBeGreaterThan(10);
    for (const locale of locales) {
      for (const key of keys) {
        expect(readKey(locale.json, key), `${locale.name} 缺少 ${key}`).toBeTruthy();
      }
    }
  });
});
