---
name: sugent-delivery
description: Safe self-hosting maintenance and label-driven PR delivery workflow (deliver-review and deliver) for Sugent. Enforces main-branch-only trusted rules, zero local PR code checkout, isolated worktree upstream sync, and post-deploy HTTPS health verification.
---

# Sugent 安全自举维护与 PR 自动交付规范 (M1.5 SOP)

处理 GitHub Pull Request 交付或每日双上游同步巡检时，严格执行以下四条安全铁律：

## 1. 主干唯一受信（Main-Branch-Only Policy）
- 审查标准、合并策略与健康检查地址只允许从 `main`（或 `origin/main`）读取（调用 `parseTrustedDeliveryPolicy`）。
- 严禁读取或信任外来 PR 分支中修改的交付配置或门禁脚本。

## 2. 外来 PR 零检出与数据物理隔离（Zero Untrusted Checkout）
- **严禁**在宿主机检出或直接执行外来 PR 分支代码。
- 一律通过 `sealPrReviewMaterials()` 将 PR 标题、描述与只读 Unified Diff 封装至只读 `.context/event-pr-<n>.md`（权限 `0400`）后再开始代码审查。
- 所有外部命令必须通过独立参数数组（经 `assertSafeDeliveryCommandVector` 校验）调用。

## 3. 标签驱动双流状态机（`deliver-review` vs `deliver`）
- **`deliver-review`（只审不合）**：基于只读 Diff 完成正确性、安全围栏与架构一致性审查，评论审查结论后直接结束。
- **`deliver`（审代码 -> 等 CI -> 合并 -> 核验版本）**：
  1. 核验当前 PR `headSha` 与已审 `reviewedHeadSha` 完全一致（若期间有新提交立即中止重审）；
  2. 涉及 `requires_approval` 路径或非白名单作者时，必须输出 `suspend_approval` 回执挂起等待主人拍板；
  3. 若 CI 仍在运行，输出带 `later` 的回执零消耗释放进程，定时唤醒复查；
  4. 合并并触发部署后，调用 `verifyPostDeployHealth()` 校验生产 HTTPS 健康接口返回的已部署版本/SHA，不一致立即推卡告警。

## 4. 每日双上游隔离工作树巡检
- 先以零 Token 探针检查 `upstream-amb/master` 与 `upstream-dsh/main` 是否有新提交，无增量直接退出（0 Token）。
- 有增量时通过 `buildIsolatedUpstreamSyncPlan()` 在独立临时 `git worktree` 中合并并跑通 `npm run verify:sugent`，严禁直接污染主工作区。
