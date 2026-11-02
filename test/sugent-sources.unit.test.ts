import { describe, expect, it } from "vitest";
import { PersonalSourceRegistry, evaluatePersonalTrigger } from "../src/sugent/index.js";

describe("PersonalSourceRegistry & End-to-End Trigger Normalization", () => {
  it("normalizes GitHub events and routes unmentioned comments through proactive rules", () => {
    const registry = new PersonalSourceRegistry();
    const trigger = registry.ingest(
      "github",
      "gh-main",
      {
        id: "evt-101",
        repo: "ldc861117/sugent",
        issueOrPrNumber: 1,
        senderLogin: "ldc861117",
        body: "CI failed on macOS build",
        mentionedAgent: false,
      },
      ["ldc861117"],
    );

    expect(trigger.threadKey).toBe("github:ldc861117/sugent#1");
    expect(trigger.fromAllowedSender).toBe(true);
    expect(trigger.addressedToAgent).toBe(false);

    const decision = evaluatePersonalTrigger(trigger, {
      matchingRules: [
        {
          id: "rule-ci-watch",
          title: "监控本仓库 CI 状态",
          sourceKind: "github",
          mode: "observe",
          verifiedObservations: 1,
          suggestPromoteAfter: 3,
        },
      ],
    });
    expect(decision.outcome).toBe("accept_observe");
    expect(decision.matchedRuleId).toBe("rule-ci-watch");
  });

  it("normalizes IM channel direct messages from owner as explicit act requests", () => {
    const registry = new PersonalSourceRegistry();
    const trigger = registry.ingest(
      "im_channel",
      "weixin-1",
      {
        messageId: "msg-99",
        channel: "weixin",
        conversationId: "conv-owner",
        senderId: "wxid_owner",
        text: "帮我拉取两个上游项目的最新更新并跑一遍测试",
        isDirectOrMention: true,
      },
      ["wxid_owner"],
    );

    const decision = evaluatePersonalTrigger(trigger);
    expect(decision.outcome).toBe("accept_act");
    expect(decision.reasonCode).toBe("explicit_owner_request");
  });
});
