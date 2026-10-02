// 从应用图标 PNG 生成 assets/tray-icon.ico（多尺寸 PNG 条目，Vista+ 兼容）。
//
// 用途：electron-builder `win.icon` 读取该 ico 写入 Cyrene.exe；WPF 原生窗
// （AppIcons.cs）与分离托盘（TrayHost.LoadInitialIcon）都从 exe 提取关联图标，
// 因此换图标时改这里即可同时覆盖 exe / 任务栏 / 原生窗。
//
// 用法：node scripts/build/tray-icon.mjs [源 PNG]
//   默认源：assets/icon-presets/cyrene-sticker.png（与托盘/窗口预设同图）
//   产物：  assets/tray-icon.ico（覆盖写入）
//
// 设计：每个尺寸单独从源图缩放后编码为 PNG 条目（不存 BMP 位图），
// 与仓库现有 ico 格式一致；Windows 10/11 与 electron-builder 均支持。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");
const sourcePath = path.resolve(
  repoRoot,
  process.argv[2] ?? path.join("assets", "icon-presets", "cyrene-sticker.png"),
);
const outputPath = path.join(repoRoot, "assets", "tray-icon.ico");

// Windows 图标标准尺寸；16/32/48 用于托盘与任务栏，256 用于资源管理器大图标
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`源图不存在：${sourcePath}`);
  }
  const entries = [];
  for (const size of SIZES) {
    const png = await sharp(sourcePath)
      .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    entries.push({ size, png });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directorySize = 16 * entries.length;
  let offset = 6 + directorySize;
  const directory = Buffer.alloc(directorySize);
  entries.forEach((entry, index) => {
    const base = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // width（256 记 0）
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1); // height
    directory.writeUInt8(0, base + 2); // 调色板色数
    directory.writeUInt8(0, base + 3); // reserved
    directory.writeUInt16LE(1, base + 4); // color planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  fs.writeFileSync(outputPath, Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]));
  console.log(
    `[tray-icon] ${path.relative(repoRoot, sourcePath)} → assets/tray-icon.ico `
    + `(${SIZES.join("/")}, ${(fs.statSync(outputPath).size / 1024).toFixed(0)} KB)`,
  );
}

main().catch((error) => {
  console.error(`[tray-icon] 失败：${error.message}`);
  process.exit(1);
});
