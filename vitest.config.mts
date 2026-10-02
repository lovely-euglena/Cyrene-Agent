import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/plugins/**/*.test.ts",
      "src/main/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/cli/**/*.test.ts",
      "skills/**/tests/**/*.test.ts",
      "scripts/cline-poc/**/*.test.ts",
      "packages/*/src/**/*.test.ts",
    ],
    // 单 fork 单 worker，避免 Windows 下 libuv fs-event 断言崩溃
    pool: "forks",
    singleFork: true,
    maxWorkers: 1,
    minWorkers: 1,
    // 明确禁用 watch/cache，减少 fs 事件
    watch: false,
    cache: false,
    fileParallelism: false,
    // 单测禁用 .NET sidecar：环境上 exe 存在时会真的拉起 776MB 进程，
    // 且检索结果依赖本机模型/词表，必须走确定性本地实现
    env: {
      CYRENE_EMBED_SIDECAR: "0",
    },
  },
});
