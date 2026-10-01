import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

// vi.hoisted：mock 安装前计算隔离路径（参考 model-status.test.ts 的同款做法）
const { ISOLATED_ROOT, ISOLATED_HOME } = vi.hoisted(() => {
  const pathMod = require("path") as typeof import("path");
  const root = pathMod.join(
    process.env.TEMP || process.env.TMP || "/tmp",
    `cyrene-embedding-manager-test-${process.pid}`,
  );
  return { ISOLATED_ROOT: root, ISOLATED_HOME: pathMod.join(root, "home") };
});

vi.mock("os", async () => {
  const realOs = await vi.importActual<typeof import("os")>("os");
  return {
    ...realOs,
    homedir: () => ISOLATED_HOME,
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => ISOLATED_ROOT,
    // cache-dir.ts：<appData>/../Local/<appName>/Cache
    getPath: () => ISOLATED_ROOT + "/appdata",
    getName: () => "cyrene-test",
    isPackaged: false,
  },
}));

import { deleteEmbeddingModel } from "./embedding-manager";

/** HF 缓存里的 Xenova 根（cache-dir 解析结果）。 */
const HF_CACHE_XENOVA = path.join(ISOLATED_ROOT, "Local", "cyrene-test", "Cache", "huggingface", "Xenova");

/** 造一个「三件套齐全」的假模型目录。 */
function makeModelDir(...parts: string[]): string {
  const dir = path.join(...parts);
  fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  fs.writeFileSync(path.join(dir, "onnx", "model_quantized.onnx"), "stub");
  return dir;
}

const ORIGINAL_CWD = process.cwd();

beforeEach(() => {
  // Windows 上删除 cwd 会失败：先切回原目录再清理隔离树
  process.chdir(ORIGINAL_CWD);
  if (fs.existsSync(ISOLATED_ROOT)) {
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  }
  fs.mkdirSync(ISOLATED_ROOT, { recursive: true });
  fs.mkdirSync(ISOLATED_HOME, { recursive: true });
  process.chdir(ISOLATED_ROOT);
  delete process.env.CYRENE_MODELS_DIR;
});

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  if (fs.existsSync(ISOLATED_ROOT)) {
    fs.rmSync(ISOLATED_ROOT, { recursive: true, force: true });
  }
  delete process.env.CYRENE_MODELS_DIR;
});

describe("deleteEmbeddingModel", () => {
  it("removes the project-side install (cwd/models/Xenova/bge-m3) and reports the path", () => {
    const dir = makeModelDir(ISOLATED_ROOT, "models", "Xenova", "bge-m3");
    const removed = deleteEmbeddingModel("bgem3");
    expect(fs.existsSync(dir)).toBe(false);
    expect(removed).toContain(dir);
  });

  it("removes the HF cache install too", () => {
    const dir = makeModelDir(HF_CACHE_XENOVA, "bge-m3");
    const removed = deleteEmbeddingModel("bgem3");
    expect(fs.existsSync(dir)).toBe(false);
    expect(removed).toContain(dir);
  });

  it("cleans every candidate root (CYRENE_MODELS_DIR + cwd + HF cache)", () => {
    const override = path.join(ISOLATED_ROOT, "override-models");
    process.env.CYRENE_MODELS_DIR = override;
    const fromOverride = makeModelDir(override, "Xenova", "bge-m3");
    const fromCwd = makeModelDir(ISOLATED_ROOT, "models", "Xenova", "bge-m3");
    const fromHf = makeModelDir(HF_CACHE_XENOVA, "bge-m3");

    const removed = deleteEmbeddingModel("bgem3");

    for (const dir of [fromOverride, fromCwd, fromHf]) {
      expect(fs.existsSync(dir)).toBe(false);
      expect(removed).toContain(dir);
    }
    expect(removed).toHaveLength(3);
  });

  it("is a no-op (no throw, nothing reported) when no install exists", () => {
    fs.mkdirSync(path.join(ISOLATED_ROOT, "models"), { recursive: true });
    const removed = deleteEmbeddingModel("bgem3");
    expect(removed).toEqual([]);
  });

  it("rejects unknown model keys", () => {
    expect(() => deleteEmbeddingModel("nope")).toThrow("Unknown model");
  });
});
