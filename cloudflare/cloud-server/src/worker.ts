/**
 * CF 版 Worker 入口（IKJN79）：路由 / 能力声明 / PWA 静态托管 / 转发 CloudStore。
 *
 * - /v1/capabilities：公开只读（客户端配对前用于降级 UI）；
 * - /healthz 与 /v1/*：转发到单租户 DO（鉴权 / 限流 / 同步 / 配对 / 生成都在 DO 内）；
 * - 其余路径：PWA 静态资产（Workers 静态资产 + Worker 统一缓存头 / CSP）。
 */
import { generationEnabled, MAX_PUSH_BODY_BYTES, type Env } from "./env";

export { CloudStore } from "./store";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "manifest-src 'self'; worker-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (!hostAllowed(url, env)) {
      return Response.json({ code: "E_HOST_NOT_ALLOWED" }, { status: 421 });
    }

    // 能力声明（公开只读；与 .NET /v1/capabilities 字段对齐，impl=cf-workers）
    if (path === "/v1/capabilities" && request.method === "GET") {
      return Response.json({
        impl: "cf-workers",
        protocol: "v0",
        sync: true,
        clone: true,
        cursor: "server",
        generation: generationEnabled(env) ? "realtime" : "none",
        pairing: "device-token",
        pwa: true, // 静态资产随部署打包（构建：npm run assets:build）；未构建时静态 404
        maxBatchBytes: MAX_PUSH_BODY_BYTES,
      });
    }

    if (path === "/healthz" || path.startsWith("/v1/")) {
      // push 请求体硬上限快检（无 Content-Length 的 chunked 由 DO 读取后复查）
      if (path === "/v1/sync/push" && request.method === "POST") {
        const contentLength = request.headers.get("content-length");
        if (contentLength !== null && Number(contentLength) > MAX_PUSH_BODY_BYTES) {
          return Response.json({ code: "E_SYNC_BATCH_TOO_LARGE" }, { status: 413 });
        }
      }
      const stub = env.CLOUD_STORE.get(env.CLOUD_STORE.idFromName("global"));
      return stub.fetch(request);
    }

    return serveStatic(request, env);
  },
} satisfies ExportedHandler<Env>;

/** 域名白名单（CLOUD_ALLOWED_HOSTS；空 = 不限制；回环豁免；421 = E_HOST_NOT_ALLOWED）。 */
function hostAllowed(url: URL, env: Env): boolean {
  const allowed = (env.CLOUD_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);
  if (allowed.length === 0) return true;
  const host = url.hostname.toLowerCase();
  if (isLoopbackHost(host)) return true;
  return allowed.includes(host);
}

function isLoopbackHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost")
  );
}

/** 静态资产：缓存策略与 .NET 静态托管一致（assets/ 长缓存，其余 no-cache；HTML 附 CSP）。 */
async function serveStatic(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const asset = await env.ASSETS.fetch(request);
  if (asset.status !== 200) return asset;
  const headers = new Headers(asset.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Cache-Control",
    url.pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  if ((headers.get("Content-Type") ?? "").includes("text/html")) {
    headers.set("Content-Security-Policy", CSP);
  }
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}
