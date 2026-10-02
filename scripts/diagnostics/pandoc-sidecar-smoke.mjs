// Pandoc 文档转换链路冒烟（.NET 文档组件 cyrene-embed）：
//   1. 构造临时 .rst / .docx 样例（docx 用 jszip 生成最小 OOXML 包）
//   2. spawn cyrene-embed serve（首次加载 embedding 模型，较慢）
//   3. 发 doc-import 请求（带 pandocPath）→ 断言转换后的文本
//   4. 发无效 pandocPath 请求 → 断言可操作错误文案
//
// 用法：node scripts/diagnostics/pandoc-sidecar-smoke.mjs [pandocPath]
//   未显式传参时按 PATH / %LOCALAPPDATA%\Programs\Pandoc 探测；找不到则跳过真实转换断言。

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSZip from "jszip";

const root = process.cwd();
const exeName = process.platform === "win32" ? "cyrene-embed.exe" : "cyrene-embed";
const modelDir = path.join(root, "models", "Xenova", "bge-m3");

function firstExisting(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
}

const sidecarExe = firstExisting([
  process.env.CYRENE_EMBED_EXE,
  path.join(root, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", exeName),
  path.join(root, "dotnet", "embedding-sidecar", "bin", "Debug", "net10.0", exeName),
  path.join(root, "dotnet", "embedding-sidecar", "bin", "Release", "net10.0", "win-x64", "publish", exeName),
]);
if (!sidecarExe) {
  console.error("[FAIL] 找不到 cyrene-embed，可先 dotnet build -c Release dotnet/embedding-sidecar");
  process.exit(1);
}
if (!fs.existsSync(modelDir)) {
  console.error(`[FAIL] 找不到 embedding 模型目录：${modelDir}`);
  process.exit(1);
}

const pandocPath = firstExisting([
  process.argv[2],
  process.env.PANDOC_PATH,
  process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Pandoc", "pandoc.exe")
    : "/usr/bin/pandoc",
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "", "Pandoc", "pandoc.exe")
    : "/usr/local/bin/pandoc",
]);
if (!pandocPath) {
  console.log("[SKIP] 未检测到 Pandoc（可传参：node scripts/diagnostics/pandoc-sidecar-smoke.mjs <pandoc.exe>）");
  process.exit(0);
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-pandoc-smoke-"));
const ragDataDir = path.join(workDir, "rag-data");
fs.mkdirSync(ragDataDir, { recursive: true });

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`[PASS] ${name}`);
  } else {
    fail += 1;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 样例文件 ──
const rstPath = path.join(workDir, "sample.rst");
fs.writeFileSync(rstPath, "标题\n====\n\nhello **world**\n", "utf8");

const docxPath = path.join(workDir, "sample.docx");
const zip = new JSZip();
zip.file(
  "[Content_Types].xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
);
zip.folder("_rels").file(
  ".rels",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
);
zip.folder("word").file(
  "document.xml",
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>昔涟文档转换冒烟 OK</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
);
fs.writeFileSync(docxPath, await zip.generateAsync({ type: "nodebuffer" }));

// ── sidecar 帧协议 ──
const child = spawn(sidecarExe, ["serve", modelDir], { stdio: ["pipe", "pipe", "inherit"] });
let buffered = Buffer.alloc(0);
child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
});
const waitForData = () => new Promise((resolve) => child.stdout.once("data", resolve));

function writeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const prefix = Buffer.alloc(4);
  prefix.writeInt32LE(json.length);
  child.stdin.write(prefix);
  child.stdin.write(json);
}

async function readFrame() {
  while (true) {
    if (buffered.length >= 4) {
      const len = buffered.readInt32LE(0);
      if (buffered.length >= 4 + len) {
        const header = JSON.parse(buffered.subarray(4, 4 + len).toString("utf8"));
        buffered = buffered.subarray(4 + len);
        return header;
      }
    }
    await waitForData();
  }
}

let nextId = 1;
async function docImport(filePath, pandoc) {
  const id = nextId++;
  writeFrame({ id, op: "doc-import", filePath, ragDataDir, pandocPath: pandoc });
  while (true) {
    const frame = await readFrame();
    if (frame.id === id) return frame;
    // id=0 的 progress 通知帧：跳过
  }
}

const timeout = setTimeout(() => {
  console.error("[FAIL] 冒烟超时（120s）");
  child.kill();
  process.exit(1);
}, 120_000);

try {
  // ready 帧
  const ready = await readFrame();
  check("sidecar ready", ready.id === 0 && ready.op === "ready", JSON.stringify(ready));

  const rst = await docImport(rstPath, pandocPath);
  check("rst → text", rst.kind === "text", JSON.stringify(rst));
  check("rst 内容正确", String(rst.text ?? "").includes("hello **world**"));

  const docx = await docImport(docxPath, pandocPath);
  check("docx → text", docx.kind === "text", JSON.stringify(docx));
  check("docx 内容正确", String(docx.text ?? "").includes("昔涟文档转换冒烟 OK"));

  const invalid = await docImport(docxPath, path.join(workDir, "missing", "pandoc.exe"));
  check("无效路径 → unsupported", invalid.kind === "unsupported", JSON.stringify(invalid));
  check("无效路径文案可操作", String(invalid.reason ?? "").includes("Pandoc"), String(invalid.reason ?? ""));
} catch (error) {
  fail += 1;
  console.error("[FAIL] 冒烟异常：", error);
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      child.kill();
      resolve();
    }, 3_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
  });
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
  } catch {
    // 文件仍被占用：临时目录留给系统清理
  }
}

console.log(`[pandoc-sidecar-smoke] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
