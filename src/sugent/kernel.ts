/**
 * Sugent 个人自治状态机桥接核（Autonomous Kernel Bridge）
 *
 * 将 dsh-superagent-prototype 的注意力经济学原则（000-philosophy.md）与 Intake -> Eval -> Ticket 门控逻辑，
 * 桥接到 AnyModelBot 的个人多渠道宿主中。
 *
 * 核心原则：
 * > "Take as little human attention as possible, and give as much value as possible."
 */
import { RULE_SUGGEST_AFTER } from "../tasks/rules.js";
import type { EvalDecision, PersonalTrigger, ProactiveRulePolicy } from "./types.js";

export interface GateContext {
  /** 当前活跃且订阅了该 Thread 的 Ticket ID（若存在，则后续人类消息直接归入该 Ticket） */
  activeTicketIdForThread?: string;
  /** 匹配的个人主动规则列表 */
  matchingRules?: ProactiveRulePolicy[];
  /** 是否需要桌面 GUI 操控能力 */
  requiresComputerUse?: boolean;
}

/**
 * 评估单条外部或聊天触发器（Intake -> Eval Gate）：
 * 1. 未授权发送者一律拦截（只听主人的，绝不消耗模型 Token）；
 * 2. 如果该对话线程已有活跃 Ticket 且是主人发来的后续消息，直接归入该 Ticket（`attach_ticket`）；
 * 3. 如果主人显式向智能体下达指令，直接立项执行（`accept_act`）；
 * 4. 如果是未点名的背景事件/群消息/定时源，必须匹配已写明的规则：
 *    - 规则处于 `act` 模式 -> 立项执行（`accept_act`）
 *    - 规则处于 `observe` 模式 -> 影子观察记录（`accept_observe`，只记 `would` 不发消息不改外部状态）
 *    - 无匹配规则或规则关闭 -> 静默忽略（`ignore_noise`）
 */
export function evaluatePersonalTrigger(trigger: PersonalTrigger, ctx: GateContext = {}): EvalDecision {
  if (!trigger.fromAllowedSender) {
    return {
      triggerId: trigger.id,
      outcome: "ignore_noise",
      reasonCode: "unlisted_sender",
      reasonText: "Sender is not in the owner/allowed list; ignored without invoking model.",
      recommendedRole: "assessor",
    };
  }

  if (ctx.activeTicketIdForThread && trigger.addressedToAgent) {
    return {
      triggerId: trigger.id,
      outcome: "attach_ticket",
      reasonCode: "thread_followup",
      reasonText: `Routed human follow-up to active ticket ${ctx.activeTicketIdForThread}.`,
      targetTicketId: ctx.activeTicketIdForThread,
      recommendedRole: ctx.requiresComputerUse ? "computer_use" : "executor",
    };
  }

  if (trigger.addressedToAgent) {
    return {
      triggerId: trigger.id,
      outcome: "accept_act",
      reasonCode: "explicit_owner_request",
      reasonText: "Owner explicitly addressed the agent; authorized to open a Ticket and act.",
      recommendedRole: ctx.requiresComputerUse ? "computer_use" : "executor",
    };
  }

  const activeRule = (ctx.matchingRules ?? []).find((r) => r.mode !== "off");
  if (!activeRule) {
    return {
      triggerId: trigger.id,
      outcome: "ignore_noise",
      reasonCode: "no_matching_rule",
      reasonText: "Unaddressed event matched no active proactive rule; staying quiet.",
      recommendedRole: "assessor",
    };
  }

  if (activeRule.mode === "act") {
    return {
      triggerId: trigger.id,
      outcome: "accept_act",
      reasonCode: "proactive_rule_act",
      reasonText: `Matched active rule "${activeRule.title}" in act mode.`,
      matchedRuleId: activeRule.id,
      recommendedRole: ctx.requiresComputerUse ? "computer_use" : "executor",
    };
  }

  return {
    triggerId: trigger.id,
    outcome: "accept_observe",
    reasonCode: "proactive_rule_observe",
    reasonText: `Matched rule "${activeRule.title}" in observe mode; recording shadow action only.`,
    matchedRuleId: activeRule.id,
    recommendedRole: "assessor",
  };
}

/**
 * 判断一条处于"观察模式（observe）"的主动规则是否已经积累了足够多的成功验证次数，
 * 可以在「需要你（Needs You）」面板中向主人提议转正为自动执行（act）。
 */
export function shouldSuggestRulePromotion(rule: ProactiveRulePolicy): boolean {
  if (rule.mode !== "observe") return false;
  const threshold = rule.suggestPromoteAfter > 0 ? rule.suggestPromoteAfter : RULE_SUGGEST_AFTER;
  return rule.verifiedObservations >= threshold;
}
