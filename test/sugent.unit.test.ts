import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_ROUTING,
  buildMagpieEnvOverrides,
  evaluatePersonalTrigger,
  resolveSugentGatewayConfig,
  selectModelForRole,
  shouldSuggestRulePromotion,
  type PersonalTrigger,
  type ProactiveRulePolicy,
} from "../src/sugent/index.js";

describe("Sugent Gateway Decoupling & Tiered Model Routing", () => {
  it("defaults to modelflare mode when no override env vars are set", () => {
    const cfg = resolveSugentGatewayConfig(undefined, {});
    expect(cfg.mode).toBe("modelflare");
    expect(cfg.unlockSubscriptions).toBe(false);
    expect(cfg.routing.assessor).toBe(DEFAULT_ROLE_ROUTING.assessor);
    expect(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS).toBe("1");
  });

  it("switches to external gateway mode when SUGENT_GATEWAY_URL or AMB_MAGPIE_BASE_URL is provided", () => {
    const cfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_GATEWAY_URL: "http://127.0.0.1:3425/v1",
      SUGENT_GATEWAY_KEY: "sk-local-magpie",
    });
    expect(cfg.mode).toBe("external");
    expect(cfg.baseUrl).toBe("http://127.0.0.1:3425/v1");
    expect(cfg.apiKey).toBe("sk-local-magpie");
  });

  it("unlocks local subscriptions when SUGENT_UNLOCK_SUBSCRIPTIONS=1", () => {
    const cfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_UNLOCK_SUBSCRIPTIONS: "1",
      SUGENT_PRIVACY_MASKING: "1",
    });
    expect(cfg.mode).toBe("subscription");
    expect(cfg.unlockSubscriptions).toBe(true);
    expect(cfg.privacyMasking).toBe(true);
    expect(buildMagpieEnvOverrides(cfg).MAGPIE_NO_ACCOUNTS).toBeUndefined();
  });

  it("routes models by agent role (assessor vs executor vs computer_use)", () => {
    const cfg = resolveSugentGatewayConfig(undefined, {
      SUGENT_MODEL_ASSESSOR: "deepseek/deepseek-chat",
      SUGENT_MODEL_EXECUTOR: "anthropic/claude-opus-4-6",
      SUGENT_MODEL_COMPUTER_USE: "openai/gpt-5.4",
    });
    expect(selectModelForRole(cfg, "assessor")).toBe("deepseek/deepseek-chat");
    expect(selectModelForRole(cfg, "executor")).toBe("anthropic/claude-opus-4-6");
    expect(selectModelForRole(cfg, "computer_use")).toBe("openai/gpt-5.4");
    expect(selectModelForRole(cfg, "executor", "custom/override-model")).toBe("custom/override-model");
  });
});

describe("Sugent Autonomous Kernel Gate (Intake -> Eval -> Ticket)", () => {
  const baseTrigger: PersonalTrigger = {
    id: "trig-1",
    sourceKind: "im_channel",
    sourceInstanceId: "weixin-default",
    threadKey: "weixin:owner",
    senderId: "user-owner",
    addressedToAgent: true,
    fromAllowedSender: true,
    text: "帮我检查一下项目的单元测试状态",
    createdAt: "2026-11-01T22:00:00.000Z",
  };

  it("blocks unlisted senders immediately without invoking any model", () => {
    const decision = evaluatePersonalTrigger({ ...baseTrigger, fromAllowedSender: false });
    expect(decision.outcome).toBe("ignore_noise");
    expect(decision.reasonCode).toBe("unlisted_sender");
  });

  it("attaches owner follow-up messages to an active ticket on the same thread", () => {
    const decision = evaluatePersonalTrigger(baseTrigger, { activeTicketIdForThread: "ticket-42" });
    expect(decision.outcome).toBe("attach_ticket");
    expect(decision.targetTicketId).toBe("ticket-42");
    expect(decision.recommendedRole).toBe("executor");
  });

  it("accepts explicit owner requests and selects computer_use role when GUI action is needed", () => {
    const decision = evaluatePersonalTrigger(baseTrigger, { requiresComputerUse: true });
    expect(decision.outcome).toBe("accept_act");
    expect(decision.reasonCode).toBe("explicit_owner_request");
    expect(decision.recommendedRole).toBe("computer_use");
  });

  it("keeps unaddressed events in shadow observe mode until a proactive rule is promoted to act", () => {
    const unaddressed: PersonalTrigger = { ...baseTrigger, addressedToAgent: false };
    const observeRule: ProactiveRulePolicy = {
      id: "rule-gh-sync",
      title: "每日同步上游仓库变更",
      sourceKind: "schedule",
      mode: "observe",
      verifiedObservations: 2,
      suggestPromoteAfter: 3,
    };

    const obsDecision = evaluatePersonalTrigger(unaddressed, { matchingRules: [observeRule] });
    expect(obsDecision.outcome).toBe("accept_observe");
    expect(obsDecision.matchedRuleId).toBe("rule-gh-sync");
    expect(obsDecision.recommendedRole).toBe("assessor");
    expect(shouldSuggestRulePromotion(observeRule)).toBe(false);

    const readyToPromote: ProactiveRulePolicy = { ...observeRule, verifiedObservations: 3 };
    expect(shouldSuggestRulePromotion(readyToPromote)).toBe(true);

    const actRule: ProactiveRulePolicy = { ...observeRule, mode: "act" };
    const actDecision = evaluatePersonalTrigger(unaddressed, { matchingRules: [actRule] });
    expect(actDecision.outcome).toBe("accept_act");
    expect(actDecision.recommendedRole).toBe("executor");
  });
});
