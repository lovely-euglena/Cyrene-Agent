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
