#!/usr/bin/env node
/**
 * Sugent 零依赖核心契约自检脚本 (scripts/verify-sugent.mjs)
 * 使用 Node.js 原生 node:assert/strict 验证编译后的 dist/src/sugent/ 模块，
 * 确保在任何沙箱或 CI 环境下都能秒级完成端到端回归验证。
 */
import assert from "node:assert/strict";
import {
  DEFAULT_ROLE_ROUTING,
  PersonalSourceRegistry,
  buildMagpieEnvOverrides,
  evaluatePersonalTrigger,
  resolveSugentGatewayConfig,
  selectModelForRole,
  shouldSuggestRulePromotion,
} from "../dist/src/sugent/index.js";

// 1. 默认网关模式与角色路由验证
{
  const cfg = resolveSugentGatewayConfig(undefined, {});
  assert.equal(cfg.mode, "modelflare");
  assert.equal(cfg.unlockSubscriptions, false);
  assert.equal(cfg.routing.assessor, DEFAULT_ROLE_ROUTING.assessor);
  assert.equal(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS, "1");
}

// 2. 外部网关解耦与本地订阅解锁验证
{
  const cfg = resolveSugentGatewayConfig(undefined, {
    SUGENT_GATEWAY_URL: "http://127.0.0.1:3425/v1",
    SUGENT_GATEWAY_KEY: "sk-local-magpie",
    SUGENT_UNLOCK_SUBSCRIPTIONS: "1",
    SUGENT_PRIVACY_MASKING: "1",
    SUGENT_MODEL_ASSESSOR: "deepseek/deepseek-chat",
    SUGENT_MODEL_EXECUTOR: "anthropic/claude-opus-4-6",
  });
  assert.equal(cfg.mode, "external");
  assert.equal(cfg.unlockSubscriptions, true);
  assert.equal(cfg.privacyMasking, true);
  assert.equal(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS, undefined);
  assert.equal(selectModelForRole(cfg, "assessor"), "deepseek/deepseek-chat");
  assert.equal(selectModelForRole(cfg, "executor"), "anthropic/claude-opus-4-6");
}

// 3. PersonalSourceRegistry 与 Intake -> Eval -> Ticket 门控验证
{
  const registry = new PersonalSourceRegistry();
  assert.equal(registry.listKinds().length, 3);

  // 3a. 陌生人消息拦截（不调用模型）
  const strangerTrigger = registry.ingest(
    "im_channel",
    "wx-default",
    {
      messageId: "m-stranger",
      channel: "weixin",
      conversationId: "c-1",
      senderId: "stranger-id",
      text: "hello",
    },
    ["owner-id"],
  );
  const strangerDecision = evaluatePersonalTrigger(strangerTrigger);
  assert.equal(strangerDecision.outcome, "ignore_noise");
  assert.equal(strangerDecision.reasonCode, "unlisted_sender");

  // 3b. 主人显式指令立项 + 同线程追问自动归并
  const ownerTrigger = registry.ingest(
    "im_channel",
    "wx-default",
    {
      messageId: "m-owner",
      channel: "weixin",
      conversationId: "c-owner",
      senderId: "owner-id",
      text: "帮我打开浏览器整理桌面账单",
    },
    ["owner-id"],
  );
  const actDecision = evaluatePersonalTrigger(ownerTrigger, { requiresComputerUse: true });
  assert.equal(actDecision.outcome, "accept_act");
  assert.equal(actDecision.recommendedRole, "computer_use");

  const followupDecision = evaluatePersonalTrigger(ownerTrigger, { activeTicketIdForThread: "ticket-100" });
  assert.equal(followupDecision.outcome, "attach_ticket");
  assert.equal(followupDecision.targetTicketId, "ticket-100");

  // 3c. 定时/GitHub 未点名事件走观察模式 -> 满 3 次提议转正
  const ghTrigger = registry.ingest(
    "github",
    "gh-sugent",
    {
      id: "ev-1",
      repo: "ldc861117/sugent",
      issueOrPrNumber: 1,
      senderLogin: "ldc861117",
      body: "upstream updated",
      mentionedAgent: false,
    },
    ["ldc861117"],
  );
  const ruleObserve = {
    id: "r-upstream",
    title: "每日同步双上游",
    sourceKind: "github",
    mode: "observe",
    verifiedObservations: 2,
    suggestPromoteAfter: 3,
  };
  const obsDecision = evaluatePersonalTrigger(ghTrigger, { matchingRules: [ruleObserve] });
  assert.equal(obsDecision.outcome, "accept_observe");
  assert.equal(shouldSuggestRulePromotion(ruleObserve), false);
  assert.equal(shouldSuggestRulePromotion({ ...ruleObserve, verifiedObservations: 3 }), true);
}

console.log("verify:sugent — 全部核心契约断言通过 (Gateway 解耦 / 四角色路由 / Intake-Eval-Ticket 状态机)");
