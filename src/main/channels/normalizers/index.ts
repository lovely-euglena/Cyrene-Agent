// 渠道归一化契约 v1 —— 纯函数集合（服务端/桌面共享 fixtures 的 TS 侧语义源）。
//
// 对应设计 docs/design/2026-10-05-server-channel.md §2.2/§8.1；
// C# 镜像见 dotnet/cyrene-core/Channels/**；双端 runner：
//   - TS：src/main/channels/contract-fixtures.test.ts
//   - C#：smoke-host --selftest channel-contract fixtures/channels
export * from "./ids";
export * from "./qq-text";
export * from "./qqbot";
export * from "./wechat";
export * from "./feishu";
export * from "./capability";
