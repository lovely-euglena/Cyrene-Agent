# 工具区 token 基线（#164）

> 口径：tokens = ceil(chars/4)（近似值，门禁只依赖同口径相对变化）。
> catalog 层 = buildToolCatalog 真实提示文本；schema 层 = function calling tools 数组结构化 JSON。
> all-hosted = SSH/云存储/音乐三组托管工具强制可见（等价实机全配置）。MCP 组合待 MCP mock 基建后补。

> 基线表由 `npx tsx scripts/tool-token-baseline.ts --write` 生成；门禁阈值见 tool-token-baseline.test.ts（超限 = 基线 × 1.05）。

| mode |undefined
