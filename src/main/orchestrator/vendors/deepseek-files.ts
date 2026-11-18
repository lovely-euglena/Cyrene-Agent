/**
 * DeepSeek Files API 客户端与图像 files 通道（issue #205 / #207）。
 *
 * 规格来源（官方文档 2026-11-05 核实，api-docs.deepseek.com/guides/files_api.md 与
 * guides/vision.md，存档于 issue 评论）：
 * - POST /files：multipart，purpose 必须为 user_data；单文件 ≤64 MiB，10 分钟内完成
 * - expires_after[anchor]=created_at + expires_after[seconds]（3600-2592000，1h~30d）；
 *   两者都不传则永久有效（本实现默认 7 天，从源头抑制堆积——#207 源头策略）
 * - 配额：单用户 25 GiB / 10000 文件（GET /files 聚合水位）
 * - 引用块：{"type": "file", "file_id": "file-api-..."}（chat completions content part；
 *   file_id 引用单图上限 64 MiB，不受 32 MiB base64 内联限制，请求总图 200 MiB）
 * - 注意：Files API 仅收图片（JPEG/PNG/GIF/WebP）——文本大文档无此通道（context caching
 *   才是文本复用的官方路径），#205 原文"大文档上传"按规格修正为"图片 files 通道"
 */
import { createHash } from "node:crypto";

/** 请求 base_url 指向 DS 官方 API 才启用 files 通道（自建中转/代理不适用）。 */
export function isDeepSeekApiBase(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).host.toLowerCase();
    return host === "deepseek.com" || host === "api.deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

export const DS_DEFAULT_EXPIRES_SECONDS = 7 * 24 * 3600; // 7d（#207：源头抑制堆积）
/** 原始字节超过该阈值的 data URL 图片改走 file_id（32 MiB 内联限制留 8 MiB 余量）。 */
export const DS_FILE_INLINE_THRESHOLD_BYTES = 24 * 1024 * 1024;
const DS_QUOTA_BYTES = 25 * 1024 * 1024 * 1024; // 25 GiB
const DS_QUOTA_COUNT = 10000;

export interface DsFileEntry {
  id: string;
  filename: string;
  bytes: number;
}

export interface DsQuotaUsage {
  count: number;
  totalBytes: number;
  quotaBytes: number;
  quotaCount: number;
  byteUsage: number;
  countUsage: number;
}

const MIME_EXT: Record<string, string> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp",
};

function log(msg: string): void {
  console.log(`[deepseek-files] ${msg}`);
}

/** 解析 data URL 图片块 → { mime, bytes }；非 data URL 或非图片返回 undefined。 */
export function parseDataUrlImage(url: string): { mime: string; bytes: Buffer } | undefined {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  if (!m) return undefined;
  try {
    return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
  } catch {
    return undefined;
  }
}

/**
 * 上传图片到 DS Files API。multipart：file + purpose=user_data +
 * expires_after[anchor]=created_at + expires_after[seconds]（默认 7d，#207）。
 * 返回 file_id（file-api-...）。
 */
export async function createDeepSeekFile(
  baseUrl: string,
  apiKey: string,
  bytes: Buffer,
  filename: string,
  expiresSeconds: number = DS_DEFAULT_EXPIRES_SECONDS,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)]), filename);
  form.append("purpose", "user_data");
  form.append("expires_after[anchor]", "created_at");
  form.append("expires_after[seconds]", String(Math.min(Math.max(expiresSeconds, 3600), 2592000)));
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`DeepSeek files upload HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  const id = typeof data.id === "string" ? data.id : undefined;
  if (!id) throw new Error("DeepSeek files upload: response missing id");
  return id;
}

/** 列出 user_data 文件（全量分页聚合；DS 分页 limit 按 100，after 游标推进）。 */
export async function listDeepSeekFiles(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DsFileEntry[]> {
  const out: DsFileEntry[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const url = new URL(`${baseUrl.replace(/\/$/, "")}/files`);
    url.searchParams.set("purpose", "user_data");
    url.searchParams.set("limit", "100");
    url.searchParams.set("order", "desc");
    if (after) url.searchParams.set("after", after);
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`DeepSeek files list HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: Array<Record<string, unknown>>; has_more?: boolean };
    const items = Array.isArray(data.data) ? data.data : [];
    for (const it of items) {
      if (typeof it.id === "string" && typeof it.filename === "string") {
        out.push({ id: it.id, filename: it.filename, bytes: typeof it.bytes === "number" ? it.bytes : 0 });
      }
    }
    if (!data.has_more || items.length === 0) break;
    after = typeof items[items.length - 1]?.id === "string" ? String(items[items.length - 1].id) : undefined;
    if (!after) break;
  }
  return out;
}

/** 删除文件（#207 生命周期管理后续批次使用；本批暴露原语）。 */
export async function deleteDeepSeekFile(
  baseUrl: string,
  apiKey: string,
  fileId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return res.ok;
}

/** 配额水位聚合（#207：已用/25 GiB、x/10000）。 */
export function aggregateQuota(files: DsFileEntry[]): DsQuotaUsage {
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  const count = files.length;
  return {
    count,
    totalBytes,
    quotaBytes: DS_QUOTA_BYTES,
    quotaCount: DS_QUOTA_COUNT,
    byteUsage: totalBytes / DS_QUOTA_BYTES,
    countUsage: count / DS_QUOTA_COUNT,
  };
}

export interface PreparedFilesResult {
  /** 转换发生时返回替换后的请求；无变化返回 undefined（调用方保留原请求）。 */
  request?: { messages?: Array<Record<string, unknown>> };
  uploaded: number;
  reused: number;
  fallback: number;
}

/**
 * 大图预处理：遍历 messages，DS 通道 + data URL 图片原始字节超阈值 →
 * hash 去重（filename = sha256 前 16 hex + 扩展名，同名复用既有 file_id）→
 * 上传换 {"type":"file","file_id"} 引用块；失败逐块回退 base64 并留痕。
 */
export async function prepareDeepSeekFileImages(
  request: { messages?: Array<Record<string, unknown>> },
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  expiresSeconds: number = DS_DEFAULT_EXPIRES_SECONDS,
): Promise<PreparedFilesResult> {
  if (!isDeepSeekApiBase(baseUrl)) return { uploaded: 0, reused: 0, fallback: 0 };
  const messages = request.messages;
  if (!Array.isArray(messages)) return { uploaded: 0, reused: 0, fallback: 0 };

  const result: PreparedFilesResult = { uploaded: 0, reused: 0, fallback: 0 };
  let touched = false;
  const nextMessages = await Promise.all(messages.map(async (msg) => {
    const content = msg.content;
    if (!Array.isArray(content)) return msg;
    const nextContent = await Promise.all(content.map(async (block) => {
      if (!block || typeof block !== "object") return block;
      const b = block as Record<string, unknown>;
      if (b.type !== "image_url") return block;
      const image = b.image_url as { url?: unknown } | undefined;
      const url = typeof image?.url === "string" ? image.url : undefined;
      if (!url) return block;
      const parsed = parseDataUrlImage(url);
      if (!parsed || parsed.bytes.byteLength <= DS_FILE_INLINE_THRESHOLD_BYTES) return block;
      const hash = createHash("sha256").update(parsed.bytes).digest("hex").slice(0, 16);
      const filename = hash + (MIME_EXT[parsed.mime] ?? ".png");
      try {
        // hash 去重：先查远端同名（DS 无按 filename 过滤，分页本地比对——
        // user_data 文件数通常不大；10000 上限场景走水位预警提示清理）。
        // 去重查询失败不阻断上传——跳过去重直接传（比放弃 files 通道好）。
        let fileId: string | undefined;
        try {
          const existing = (await listDeepSeekFiles(baseUrl, apiKey, fetchImpl))
            .find((f) => f.filename === filename);
          if (existing) {
            fileId = existing.id;
            result.reused += 1;
            log(`dedup hit: ${filename} → ${fileId}`);
          }
        } catch (error) {
          log(`dedup lookup failed, upload anyway: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!fileId) {
          fileId = await createDeepSeekFile(baseUrl, apiKey, parsed.bytes, filename, expiresSeconds, fetchImpl);
          result.uploaded += 1;
          log(`uploaded: ${filename} (${(parsed.bytes.byteLength / 1024 / 1024).toFixed(1)} MiB) → ${fileId}`);
        }
        touched = true;
        return { type: "file", file_id: fileId };
      } catch (error) {
        result.fallback += 1;
        log(`upload FAILED, fallback to inline base64 (${(parsed.bytes.byteLength / 1024 / 1024).toFixed(1)} MiB): ${error instanceof Error ? error.message : String(error)}`);
        return block;
      }
    }));
    return touched || nextContent !== content ? { ...msg, content: nextContent } : msg;
  }));
  // 水位日志（上传/复用发生时才查；#207 DebugMode；自动删除与设置页 UI 留下批）
  if (result.uploaded > 0 || result.reused > 0) {
    try {
      const files = await listDeepSeekFiles(baseUrl, apiKey, fetchImpl);
      const quota = aggregateQuota(files);
      log(`quota: ${quota.count}/${quota.quotaCount} files, ${(quota.totalBytes / 1024 / 1024 / 1024).toFixed(2)}/${(quota.quotaBytes / 1024 / 1024 / 1024).toFixed(0)} GiB (${(quota.byteUsage * 100).toFixed(1)}%)`);
      if (quota.byteUsage >= 0.8 || quota.countUsage >= 0.8) {
        log(`WARNING: DS files quota >= 80% — 建议清理（自动删除策略留下批）`);
      }
    } catch { /* 水位查询失败不影响请求 */ }
  }
  return touched ? { ...result, request: { ...request, messages: nextMessages } } : result;
}
