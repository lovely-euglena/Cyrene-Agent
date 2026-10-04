import { defineConfig } from "vite";
import { resolve } from "node:path";

// PWA 构建（IKJK2L）：产物默认进 cloud-server 的 wwwroot，随 dotnet publish / Docker 构建进镜像。
// - CYRENE_PWA_OUT_DIR：Docker 构建阶段等场景覆盖产物目录（默认 ../../dotnet/cloud-server/wwwroot）；
// - dev：/v1 与 /healthz 代理到本机 cloud-server（先起服务：dotnet run 或发布产物直跑）。
const outDir = process.env.CYRENE_PWA_OUT_DIR
  ? resolve(process.env.CYRENE_PWA_OUT_DIR)
  : resolve(import.meta.dirname, "../../dotnet/cloud-server/wwwroot");

export default defineConfig({
  base: "./",
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    proxy: {
      "/v1": "http://127.0.0.1:7789",
      "/healthz": "http://127.0.0.1:7789",
    },
  },
});
