/*
 * 云端昔涟 PWA Service Worker（IKJK2L；复审后调整）。
 * 策略：
 * - 导航请求（mode=navigate）：network-first——重新部署后首个在线导航即取到新 index.html
 *   （升级即时生效，消除「旧壳引用已下架哈希资源」的白屏窗口）；离线回退缓存壳；
 * - 其余同源 GET：缓存优先 + 后台刷新（assets/ 为内容哈希不可变；manifest/icon 等后台跟进）；
 * - /v1/*、/healthz：一律网络直通（事件数据不进 SW 缓存，避免过期数据冒充同步结果）。
 * 缓存名带版本：activate 时清理旧版本。
 */
const CACHE = "cyrene-pwa-shell-v2";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function cachePut(request, response) {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/v1/") ||
    url.pathname === "/healthz"
  ) {
    return;
  }
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => cachePut(event.request, response))
        .catch(() =>
          caches
            .match(event.request)
            .then((cached) => cached ?? caches.match("./"))
            .then((cached) => cached ?? Response.error()),
        ),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => cachePut(event.request, response))
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
