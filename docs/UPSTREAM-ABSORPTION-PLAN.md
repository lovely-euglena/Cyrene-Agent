# 上游吸收计划（UPSTREAM-ABSORPTION-PLAN）

> 云端线 · 上游 Playa-0v0 → ygwill/cyrene-agent 移植工作台账。
> 流程：上游发版 → 裁决（跟/不跟/观望）→ 拆 issue → 分批移植 → PR。工作流细则见 skills/SKILL-upstream-absorption。

## v1.3.2 / v1.3.3 批次（2026-10-08 裁决，已完成移植待合并）

| 分支 | 内容 | PR | 状态 |
|---|---|---|---|
| absorb/v1.3.2-fix-batch1 | 默认档案模型切换修复 + 主题令牌补全 | #31 | 已发待审 |
| absorb/v1.3.2-fix-batch2 | 取消请求历史防御 + 会话标题防覆盖 | #32 | 已发待审 |
| absorb/v1.3.3-haiku-5-5 | Claude Haiku 5.5 适配 | #33 | 已发待审 |

不跟项（10-08 裁决）：moments SQLite、模型执行统一（观望）；天气卡片、版本号 bump。

## 待办

- [ ] 16 个吸收 issue（IKK0VS~IKK0X2）逐个核销状态
- [ ] 后续上游发版照此流程：先写 PR 文案归档 tmp/pr_archive.md 再发
