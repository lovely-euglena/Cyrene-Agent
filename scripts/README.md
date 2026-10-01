# 项目脚本

这些脚本是项目的构建、打包与验证入口；脚本源码需要提交到 Git。

| 目录 | 用途 | 常用入口 |
| --- | --- | --- |
| `build/` | 构建 CLI 与原生截图辅助程序 | `npm run build:cli`、`npm run build:screenshot-helper` |
| `packaging/` | 为 Windows 发布包准备外部依赖 | `npm run prepare:mingit` |
| `verify/` | 手动或自动验证构建产物及运行链路 | `npm run verify:screenshot-helper`、`npm run smoke:music` |
| `diagnostics/` | 临时诊断脚本；不属于日常打包链路 | 按文件注释单独执行 |

`packaging/prepare-mingit.mjs` 会根据 `vendor/mingit-manifest.json` 下载、校验并解压 MinGit 到 `resources/mingit/`。该目录是本地打包输入，已被 `.gitignore` 忽略。

模型安装脚本（本地模型，可选）：`install-bge-m3.ps1`（→ `models/Xenova/bge-m3/`）与
`install-bge-reranker.ps1`（→ `models/bge-reranker-base/`）；自动切源、断点续传，
详细步骤见 `docs/local-models.md`。

`npm run build:music-component` 使用固定版本的 PyInstaller 将网易云音乐 MCP 封装为 `dist/components/music/`。发布包会预置空的 `resources/components/music/` 目录；用户将整个 `music` 文件夹内容拖入其中即可使用。
