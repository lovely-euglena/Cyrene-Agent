/** 云端昔涟手机 PWA 入口（IKJK2L）。 */
import "./styles.css";
import { boot } from "./ui/app";

const root = document.getElementById("app");
if (root) {
  boot(root);
}

// Service Worker：仅安全上下文注册（https / localhost）；失败不影响主流程。
if ("serviceWorker" in navigator) {
  const secure =
    location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1";
  if (secure) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {
        // 离线壳降级为普通页面缓存
      });
    });
  }
}
