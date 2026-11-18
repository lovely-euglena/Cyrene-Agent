#!/usr/bin/env node
/**
 * 双轨中帧参数数值对照（#257 动作态探针诊断工具）。
 * 用法：node scripts/live2d/param-compare.mjs <web-capture-stdout.json> <sidecar-params.json>
 * web 侧取 midParams（beforeModelUpdate 钩子 stash），dotnet 侧取 params
 * （getDiagnostics includeParameters 中帧快照）——同语义：全部行为写入完成、
 * coreModel.update/loadParameters 回滚前。
 */
import fs from "node:fs";

const [webPath, dotnetPath] = process.argv.slice(2);
const w = JSON.parse(fs.readFileSync(webPath, "utf8"));
const d = JSON.parse(fs.readFileSync(dotnetPath, "utf8"));
const wArr = w.midParams || w.params || [];
const wm = new Map(wArr.map((s) => { const i = s.indexOf("="); return [s.slice(0, i), parseFloat(s.slice(i + 1))]; }));
const rows = [];
for (const p of d.params || []) {
  const wv = wm.get(p.id);
  if (wv === undefined) { rows.push({ id: p.id, missing: true, delta: Infinity }); continue; }
  rows.push({ id: p.id, web: +wv.toFixed(6), dotnet: +p.value.toFixed(6), delta: +Math.abs(wv - p.value).toFixed(6) });
}
rows.sort((a, b) => b.delta - a.delta);
const over = rows.filter((r) => r.delta > 0.01);
console.log(JSON.stringify({
  webTime: w.elapsedTime, dotnetNowMs: d.nowMs,
  total: rows.length, over001: over.length,
  maxDelta: rows[0]?.delta ?? null,
  top: rows.slice(0, 25),
}, null, 1));