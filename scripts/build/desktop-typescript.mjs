import { build } from "esbuild";
import { copyFileSync, cpSync, globSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.argv[2];
if (target !== "main" && target !== "preload") {
  throw new Error("Usage: node scripts/build/desktop-typescript.mjs <main|preload>");
}

const configPath = path.join(repoRoot, `tsconfig.${target}.json`);
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));

const parsed = ts.parseJsonConfigFileContent(config, ts.sys, repoRoot, undefined, configPath);
if (parsed.errors.length > 0) {
  throw new Error(parsed.errors.map((issue) => ts.flattenDiagnosticMessageText(issue.messageText, "\n")).join("\n"));
}

const entryPoints = parsed.fileNames.filter((file) => /\.[cm]?tsx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file));
const outDir = parsed.options.outDir;
if (target === "main") rmSync(path.join(outDir, "plugins"), { recursive: true, force: true });

await build({
  entryPoints,
  outbase: parsed.options.rootDir,
  outdir: outDir,
  bundle: false,
  platform: "node",
  target: "es2022",
  format: "cjs",
  // 打包态（asar）内 Node ESM loader 不可用：相对无扩展名 import() 真实运行时报
  // ERR_MODULE_NOT_FOUND；带扩展名的 asar 路径报 ERR_UNSUPPORTED_ESM_URL_SCHEME
  // （2026-10-07 发行版 c2s 实测：sync-service / index keyring 等 ~30 处动态导入
  // 全部静默失效）。强制降级为 require()（CJS，asar 补丁生效），与静态导入一致。
  supported: { "dynamic-import": false },
  sourcemap: true,
  tsconfig: configPath,
  logLevel: "warning",
});

// 回归断言：编译产物不允许残留动态 import()（打包态必炸；本断言防止未来配置回退）。
{
  const violations = [];
  for (const file of entryPoints) {
    const relative = path.relative(parsed.options.rootDir, file).replace(/\.[cm]?tsx?$/, ".js");
    const output = path.join(outDir, relative);
    let source;
    try {
      source = readFileSync(output, "utf8");
    } catch {
      continue;
    }
    const matches = source.match(/(?:^|[^\w.$])import\s*\(\s*["'`]/g);
    if (matches) violations.push(`${relative}（${matches.length} 处）`);
  }
  if (violations.length > 0) {
    throw new Error(`[desktop] 编译产物残留动态 import()，打包态无法加载：\n  ${violations.join("\n  ")}`);
  }
}

// tsc also copies imported JSON files. Keep their relative paths for runtime require().
for (const dir of target === "main" ? ["main", "shared"] : ["preload", "shared"]) {
  const sourceDir = path.join(repoRoot, "src", dir);
  for (const relative of globSync("**/*.json", { cwd: sourceDir })) {
    const destination = path.join(outDir, dir, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(path.join(sourceDir, relative), destination);
  }
}

if (target === "main") {
  cpSync(path.join(repoRoot, "src", "plugins"), path.join(outDir, "plugins"), {
    recursive: true,
    filter: (source) => statSync(source).isDirectory() ||
      source.endsWith("manifest.json") ||
      source.endsWith("manifest.schema.json") ||
      source.endsWith("native-import.cjs"),
  });
  cpSync(path.join(repoRoot, "src", "main", "plugin-panel"), path.join(outDir, "plugin-panel"), { recursive: true });
}

console.log(`[desktop] built ${entryPoints.length} ${target} TypeScript files`);
