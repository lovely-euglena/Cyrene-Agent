import fs from "node:fs";
import { decodePng, encodePng } from "./pixel-diff.mjs";

const [aPath, bPath, outPath] = process.argv.slice(2);
const a = decodePng(fs.readFileSync(aPath));
const b = decodePng(fs.readFileSync(bPath));
if (a.width !== b.width || a.height !== b.height) throw new Error("size mismatch");
const w = a.width, h = a.height;
const heat = new Uint8Array(w * h * 4);
let count = 0, sum = 0, maxD = 0;
let minX = w, maxX = 0, minY = h, maxY = 0;
const rowHist = new Array(h).fill(0);
const colHist = new Array(w).fill(0);
const deltaBuckets = { "1-8": 0, "9-16": 0, "17-32": 0, "33-64": 0, "65-128": 0, "129-255": 0 };
let bothTransparent = 0, alphaOnly = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const aa = a.rgba[i + 3], ba = b.rgba[i + 3];
    let d = 0;
    if (aa === 0 && ba === 0) { bothTransparent++; }
    else {
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.rgba[i + c] - b.rgba[i + c]));
      if (aa === 0 || ba === 0) alphaOnly++;
    }
    sum += d; maxD = Math.max(maxD, d);
    if (d > 8) {
      count++;
      rowHist[y]++; colHist[x]++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (d <= 16) deltaBuckets["9-16"]++;
      else if (d <= 32) deltaBuckets["17-32"]++;
      else if (d <= 64) deltaBuckets["33-64"]++;
      else if (d <= 128) deltaBuckets["65-128"]++;
      else deltaBuckets["129-255"]++;
    } else if (d > 0) deltaBuckets["1-8"]++;
    // 热图：差异放大 4 倍，红通道；背景灰
    const v = Math.min(255, d * 4);
    heat[i] = v; heat[i + 1] = d > 8 ? 0 : 40; heat[i + 2] = d > 8 ? 0 : 40; heat[i + 3] = 255;
  }
}
fs.writeFileSync(outPath, encodePng(w, h, heat));
const topRows = rowHist.map((n, y) => [y, n]).sort((p, q) => q[1] - p[1]).slice(0, 8);
const topCols = colHist.map((n, x) => [x, n]).sort((p, q) => q[1] - p[1]).slice(0, 8);
console.log(JSON.stringify({
  diffPixels: count, pct: +(count / (w * h) * 100).toFixed(3), meanDelta: +(sum / (w * h)).toFixed(3), maxD,
  bbox: count ? { minX, maxX, minY, maxY } : null,
  bothTransparent, alphaOnly, deltaBuckets, topRows, topCols,
}, null, 1));