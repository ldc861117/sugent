/**
 * Sugent 个人自治状态机桥接核（Autonomous Kernel Bridge）
 *
 * 将 dsh-superagent-prototype 的注意力经济学原则（000-philosophy.md）与 Intake -> Eval -> Ticket 门控逻辑，
 * 桥接到个人多渠道宿主中，并融合 M2.1 确定性内核与 TTL 级联跳数熔断机制。
 *
 * 架构纯度铁律（由单元测试静态门禁强制守护）：
 * - 零外部网络请求、零文件系统 I/O、零系统时钟读取、零随机数调用；
 * - 零具体模型供应商或聊天平台产品名硬编码；
 * - 给定相同的 Trigger + GateContext，永远计算出完全一致的 EvalDecision。
 */
import { RULE_SUGGEST_AFTER } from "../tasks/rules.js";
import type { EvalDecision, PersonalTrigger, ProactiveRulePolicy } from "./types.js";

/** 默认最大级联唤醒跳数上限（超过 8 跳自动熔断停止派活，防止多规则/多智能体死循环互叫） */
export const DEFAULT_MAX_HOPS = 8;

export interface GateContext {
  /** 当前活跃且订阅了该 Thread 的 Ticket ID（若存在，则后续人类消息直接归入该 Ticket） */
  activeTicketIdForThread?: string;
  /** 匹配的个人主动规则列表 */
  matchingRules?: ProactiveRulePolicy[];
  /** 是否需要桌面 GUI 操控能力 */
  requiresComputerUse?: boolean;
  /** 可选自定义跳数熔断上限（默认 DEFAULT_MAX_HOPS = 8） */
  maxHops?: number;
}

function normalizeHopCount(hopCount: number | undefined): number {
  if (hopCount === undefined || !Number.isFinite(hopCount)) return 0;
  return Math.max(0, Math.trunc(hopCount));
}

function normalizeMaxHops(maxHops: number | undefined): number {
  if (maxHops === undefined || !Number.isFinite(maxHops) || maxHops < 1) {
    return DEFAULT_MAX_HOPS;
  }
  return Math.trunc(maxHops);
}

/**
 * 评估单条外部或聊天触发器（Intake -> Eval Gate）：
 * 1. 未授权发送者一律拦截（只听主人的，绝不消耗模型 Token）；
 * 2. TTL 级联跳数检查：若 `hopCount > maxHops`（默认 > 8 跳），立即触发 `halt_circuit_breaker` 熔断止损并要求告警；
 * 3. 如果该对话线程已有活跃 Ticket 且是主人发来的后续消息，直接归入该 Ticket（`attach_ticket`）；
 * 4. 如果主人显式向智能体下达指令，直接立项执行（`accept_act`）；
 * 5. 如果是未点名的背景事件/群消息/定时源，必须匹配已写明的规则：
 *    - 规则处于 `act` 模式 -> 立项执行（`accept_act`）
 *    - 规则处于 `observe` 模式 -> 影子观察记录（`accept_observe`，只记 `would` 不发消息不改外部状态）
 *    - 无匹配规则或规则关闭 -> 静默忽略（`ignore_noise`）
 */
export function evaluatePersonalTrigger(trigger: PersonalTrigger, ctx: GateContext = {}): EvalDecision {
  const hopCount = normalizeHopCount(trigger.hopCount);
  const maxHops = normalizeMaxHops(ctx.maxHops);

  if (!trigger.fromAllowedSender) {
    return {
      triggerId: trigger.id,
      outcome: "ignore_noise",
      reasonCode: "unlisted_sender",
      reasonText: "Sender is not in the owner/allowed list; ignored without invoking model.",
      recommendedRole: "assessor",
      hopCount,
      maxHops,
    };
  }

  if (hopCount > maxHops) {
    return {
      triggerId: trigger.id,
      outcome: "halt_circuit_breaker",
      reasonCode: "hop_limit_exceeded",
      reasonText: `Trigger hop count (${hopCount}) exceeded circuit breaker limit (${maxHops}); dispatch halted.`,
      recommendedRole: "assessor",
      hopCount,
      maxHops,
      requiresOwnerAlert: true,
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
      hopCount,
      maxHops,
    };
  }

  if (trigger.addressedToAgent) {
    return {
      triggerId: trigger.id,
      outcome: "accept_act",
      reasonCode: "explicit_owner_request",
      reasonText: "Owner explicitly addressed the agent; authorized to open a Ticket and act.",
      recommendedRole: ctx.requiresComputerUse ? "computer_use" : "executor",
      hopCount,
      maxHops,
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
      hopCount,
      maxHops,
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
      hopCount,
      maxHops,
    };
  }

  return {
    triggerId: trigger.id,
    outcome: "accept_observe",
    reasonCode: "proactive_rule_observe",
    reasonText: `Matched rule "${activeRule.title}" in observe mode; recording shadow action only.`,
    matchedRuleId: activeRule.id,
    recommendedRole: "assessor",
    hopCount,
    maxHops,
  };
}

/**
 * 计算下游派生事件（包括智能体交回的链式事件、延迟复查 `later` 或跨角色转交）的下一跳元数据。
 * 遵循 TTL 铁律：层数单调递增，经过人工提问或延迟复查也不自动清零，智能体无法自行篡改归零。
 */
export function deriveChildTriggerHop(
  parent: Pick<PersonalTrigger, "id" | "hopCount" | "originTriggerId">,
): { hopCount: number; originTriggerId: string } {
  const currentHop = normalizeHopCount(parent.hopCount);
  const originTriggerId =
    typeof parent.originTriggerId === "string" && parent.originTriggerId.trim()
      ? parent.originTriggerId.trim()
      : parent.id;
  return {
    hopCount: currentHop + 1,
    originTriggerId,
  };
}

/**
 * 仅允许由人类主人显式调用的跳数链重置函数（例如主人在查看熔断卡片确认无风险后手动重启新一轮）。
 */
export function resetHopChainByOwner<T extends PersonalTrigger>(trigger: T, ownerActorId: string): T {
  const actor = String(ownerActorId ?? "").trim();
  if (!actor) {
    throw new Error("Owner actor identifier is required to reset hop chain.");
  }
  return {
    ...trigger,
    hopCount: 0,
    originTriggerId: trigger.id,
    meta: {
      ...(trigger.meta ?? {}),
      hopResetByOwner: actor,
    },
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
