// 跨语言下载清单契约（IKIH28）：TS 侧 model-status 探测目录必须与
// C# ModelDownloader 的 Repo/SubDir 对齐，否则「下载成功但探测不到」。
// 纯数据断言：只读 .cs 文本，不编译/不执行 C#。
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

const downloaderPath = path.join(
  process.cwd(),
  "dotnet",
  "native-windows",
  "ModelDownload",
  "ModelDownloader.cs",
);
const modelStatusPath = path.join(process.cwd(), "src", "main", "rag", "model-status.ts");
const embeddingPipelinePath = path.join(process.cwd(), "src", "main", "rag", "embedding-pipeline.ts");

/** C# 冻结 spec 表 → kind → { repo, subDir }。 */
function parseCsharpSpecs(source: string): Map<string, { repo: string; subDir: string }> {
  const specs = new Map<string, { repo: string; subDir: string }>();
  const pattern = /new\("([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    specs.set(match[1], { repo: match[2], subDir: match[3] });
  }
  return specs;
}

/** TS model-status.ts 的 PROJECT_SUB_PATHS 块 → modelId → 子路径。 */
function parseTsProjectSubPaths(source: string): Map<string, string> {
  const paths = new Map<string, string>();
  const block = source.match(/const PROJECT_SUB_PATHS[^{]*\{([\s\S]*?)\n\};/);
  if (!block) return paths;
  const pattern = /"([a-z0-9-]+)"\s*:\s*\[\s*"([^"]+)"\s*\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(block[1])) !== null) {
    paths.set(match[1], match[2]);
  }
  return paths;
}

/** TS embedding-pipeline.ts 的 LOCAL_MODELS → modelKey → hfName。 */
function parseTsHfNames(source: string): Map<string, string> {
  const names = new Map<string, string>();
  const pattern = /"?(bgem3|e5-small)"?:\s*\{\s*key:\s*"[^"]+",\s*hfName:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    names.set(match[1], match[2]);
  }
  return names;
}

/** C# kind → TS model-status modelId（与两侧注册表键的既有映射一致）。 */
const CSHARP_KIND_TO_TS_MODEL_ID: Record<string, string> = {
  bgem3: "embedding-bgem3",
  "e5-small": "embedding-e5-small",
  reranker: "reranker-standard",
  "reranker-v2-m3": "reranker-v2-m3",
};

describe("ModelDownloader.cs: 第二引擎下载规格", () => {
  const source = fs.readFileSync(downloaderPath, "utf8");

  it("e5-small：repo 与子目录均为 Xenova/multilingual-e5-small", () => {
    expect(source).toContain(
      'new("e5-small", "Xenova/multilingual-e5-small", "Xenova/multilingual-e5-small"',
    );
    expect(source).toContain('"e5-small" => E5Small');
  });

  it("bge-reranker-v2-m3：repo=onnx-community，子目录=bge-reranker-v2-m3", () => {
    expect(source).toContain(
      'new("reranker-v2-m3", "onnx-community/bge-reranker-v2-m3-ONNX", "bge-reranker-v2-m3"',
    );
    expect(source).toContain('"reranker-v2-m3" => RerankerV2M3');
  });

  it("既有条目（bgem3 / reranker）保持不变", () => {
    expect(source).toContain('new("bgem3", "Xenova/bge-m3", "Xenova/bge-m3"');
    expect(source).toContain('new("reranker", "Xenova/bge-reranker-base", "bge-reranker-base"');
    expect(source).toContain('"bgem3" => BgeM3');
    expect(source).toContain('"reranker" => Reranker');
  });
});

// P2-8③：TS 探测目录与 C# 下载落点的交叉断言（不修改 C# spec 表；
// 发现不一致时本测试失败，需先修 TS/C# 之一再更新本映射）。
describe("TS ↔ C# 目录映射交叉断言", () => {
  const csharp = parseCsharpSpecs(fs.readFileSync(downloaderPath, "utf8"));
  const tsSubPaths = parseTsProjectSubPaths(fs.readFileSync(modelStatusPath, "utf8"));
  const tsHfNames = parseTsHfNames(fs.readFileSync(embeddingPipelinePath, "utf8"));

  it("解析到四个模型（两侧口径完整）", () => {
    expect([...csharp.keys()].sort()).toEqual(["bgem3", "e5-small", "reranker", "reranker-v2-m3"]);
    expect([...tsSubPaths.keys()].sort()).toEqual([
      "embedding-bgem3",
      "embedding-e5-small",
      "reranker-standard",
      "reranker-v2-m3",
    ]);
  });

  it("每个模型的 C# SubDir 与 TS PROJECT_SUB_PATHS 一致", () => {
    for (const [kind, spec] of csharp) {
      const modelId = CSHARP_KIND_TO_TS_MODEL_ID[kind];
      expect(modelId, `C# kind ${kind} 缺 TS modelId 映射`).toBeDefined();
      expect(tsSubPaths.get(modelId), `${kind}: C# SubDir=${spec.subDir} 与 TS 不一致`).toBe(spec.subDir);
    }
  });

  it("embedding 模型的 C# Repo 与 TS LOCAL_MODELS.hfName 一致", () => {
    expect(csharp.get("bgem3")?.repo).toBe(tsHfNames.get("bgem3"));
    expect(csharp.get("e5-small")?.repo).toBe(tsHfNames.get("e5-small"));
    // reranker-v2-m3 的源为 onnx-community（与 Xenova 命名空间不同），只比对落点
  });
});
