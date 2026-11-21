import { createHash } from "node:crypto";
import type { ConciergeChatType } from "./concierge-envelope.js";

export type OutboundIdentityMode = "explicit_assistant" | "owner_approved_proxy";

export type GuardrailCode =
  | "G1_ANTI_IMPERSONATION"
  | "G2_GROUP_SILENCE_LOCK"
  | "G3_CROSS_PEER_LEAK"
  | "G4_INJECTION_OR_REDLINE"
  | "G5_CONFIRM_HASH_MISMATCH";

export type RedLineDomain =
  | "pricing_commitment"
  | "contract_terms"
  | "payment_transfer"
  | "emotional_conflict"
  | "privacy_pii"
  | "unknown_domain";

export interface InboundRedLineInspection {
  promptInjectionSuspected: boolean;
  matchedDomains: RedLineDomain[];
  requiresSuspendApproval: boolean;
}

export interface OutboundGuardrailInput {
  mode: OutboundIdentityMode;
  chatType: ConciergeChatType;
  peerId: string;
  ownerDisplayName: string;
  body: string;
  crossPeerCanaryTokens: readonly string[];
}

export interface OutboundGuardrailVerdict {
  allowed: boolean;
  violatedGuardrail?: GuardrailCode;
  reason?: string;
  finalBody: string;
  confirmHash: string;
  requiresDoubleConfirm: boolean;
}

const PROMPT_INJECTION_PATTERNS: readonly RegExp[] = [
  /忽略(?:之前|以上|所有|前面).{0,12}(?:指令|规则|提示|设定)/i,
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/i,
  /(?:system\s*prompt|系统提示词|开发者模式|越狱|jailbreak)/i,
  /(?:上个客户|其他客户|别的客户).{0,15}(?:底价|怎么收费|收费|费用|价位|价格|多少钱|预算|定金|尾款|报价|合同|名单)/i,
];

const RED_LINE_RULES: ReadonlyArray<{ domain: RedLineDomain; pattern: RegExp }> = [
  {
    domain: "pricing_commitment",
    pattern: /(?:底价|最低价|打折|折扣|优惠|便宜点|多少钱|报价|预算|减免|抹零|[一二三四五六七八九]折)/i,
  },
  {
    domain: "contract_terms",
    pattern: /(?:合同|协议|条款|违约金|保密协议|NDA|盖章|法务|排他|知识产权|赔偿责任)/i,
  },
  {
    domain: "payment_transfer",
    pattern: /(?:转账|收款|打款|账号|银行卡|对公账户|开发票|退费|退款|定金|尾款|付款码)/i,
  },
  {
    domain: "emotional_conflict",
    pattern: /(?:投诉|差评|骗子|太慢了|极其不满|起诉|律师函|曝光|退钱|糊弄|违约)/i,
  },
  {
    domain: "privacy_pii",
    pattern: /(?:家庭住址|身份证|私人手机|私下发我|个人行程|定位发我|别的客户是谁)/i,
  },
];

const IMPERSONATION_PATTERNS: readonly RegExp[] = [
  /我是.{0,8}本人/,
  /本人亲自回复/,
  /我不是(?:机器人|助理|AI)/i,
];

const INTERNAL_LEAK_PATTERN = /\.context\/event-[a-zA-Z0-9_-]+\.md/i;
const MONETARY_COMMITMENT_PATTERN =
  /(?:¥|￥|RMB|USD|\$)\s*\d[\d,.]*|\d+(?:,\d{3})*(?:\.\d+)?\s*(?:元|万|块)/i;

export function formatAssistantBadge(ownerDisplayName: string): string {
  return `[由 ${ownerDisplayName.trim()} 的数字助理 Sugent 协办]`;
}

export function stampAssistantBadge(body: string, ownerDisplayName: string): string {
  const badge = formatAssistantBadge(ownerDisplayName);
  const trimmed = body.trim();
  if (trimmed.includes(badge)) {
    return trimmed;
  }
  return `${trimmed}\n— ${badge}`;
}

export function computeOutboundConfirmHash(
  peerId: string,
  normalizedBody: string,
  mode: OutboundIdentityMode,
): string {
  return createHash("sha256")
    .update(`${mode}::${peerId}::${normalizedBody.trim()}`, "utf8")
    .digest("hex")
    .slice(0, 8);
}

function _baseInspectInboundRedLines(
  rawPeerText: string,
  assessorMarkedUnknown = false,
): InboundRedLineInspection {
  const promptInjectionSuspected = PROMPT_INJECTION_PATTERNS.some((re) => re.test(rawPeerText));
  const matched = new Set<RedLineDomain>();

  for (const rule of RED_LINE_RULES) {
    if (rule.pattern.test(rawPeerText)) {
      matched.add(rule.domain);
    }
  }
  if (assessorMarkedUnknown) {
    matched.add("unknown_domain");
  }

  const matchedDomains = [...matched];
  return {
    promptInjectionSuspected,
    matchedDomains,
    requiresSuspendApproval: promptInjectionSuspected || matchedDomains.length > 0,
  };
}

export function enforceOutboundGuardrails(input: OutboundGuardrailInput): OutboundGuardrailVerdict {
  if (input.chatType === "group") {
    return {
      allowed: false,
      violatedGuardrail: "G2_GROUP_SILENCE_LOCK",
      reason: "Group chat outbound messages are physically locked; route digest to notifyOwner only.",
      finalBody: "",
      confirmHash: "",
      requiresDoubleConfirm: false,
    };
  }

  if (input.mode === "explicit_assistant") {
    if (IMPERSONATION_PATTERNS.some((re) => re.test(input.body))) {
      return {
        allowed: false,
        violatedGuardrail: "G1_ANTI_IMPERSONATION",
        reason: "Explicit assistant draft attempted first-person human owner impersonation.",
        finalBody: "",
        confirmHash: "",
        requiresDoubleConfirm: false,
      };
    }
  }

  const finalBody =
    input.mode === "explicit_assistant"
      ? stampAssistantBadge(input.body, input.ownerDisplayName)
      : input.body.trim();

  if (INTERNAL_LEAK_PATTERN.test(finalBody)) {
    return {
      allowed: false,
      violatedGuardrail: "G3_CROSS_PEER_LEAK",
      reason: "Internal .context security envelope path detected in outbound payload.",
      finalBody: "",
      confirmHash: "",
      requiresDoubleConfirm: false,
    };
  }

  for (const canary of input.crossPeerCanaryTokens) {
    if (canary && finalBody.includes(canary)) {
      return {
        allowed: false,
        violatedGuardrail: "G3_CROSS_PEER_LEAK",
        reason: `Cross-peer confidential token blocked: ${canary}`,
        finalBody: "",
        confirmHash: "",
        requiresDoubleConfirm: false,
      };
    }
  }

  const confirmHash = computeOutboundConfirmHash(input.peerId, finalBody, input.mode);
  const requiresDoubleConfirm = MONETARY_COMMITMENT_PATTERN.test(finalBody);

  return {
    allowed: true,
    finalBody,
    confirmHash,
    requiresDoubleConfirm,
  };
}

const COMMERCIAL_QUOTE_REDLINE_RE =
  /(怎么收费|收费标准|收费|费用|价位|价格|单价|总价|多少钱|报价|底价|折扣|优惠|让利|预算|定金|订金|尾款|发票|税点|合同|签约|违约金|赔偿|退款|打款|转账|汇款|收款)/i;

export function inspectInboundRedLines(
  ...args: Parameters<typeof _baseInspectInboundRedLines>
): ReturnType<typeof _baseInspectInboundRedLines> {
  const base = _baseInspectInboundRedLines(...args);
  const rawText = String(args[0] ?? "");
  if (COMMERCIAL_QUOTE_REDLINE_RE.test(rawText)) {
    const tag = "pricing_inquiry" as ReturnType<typeof _baseInspectInboundRedLines>["matchedDomains"][number];
    const matchedDomains = base.matchedDomains.includes(tag)
      ? base.matchedDomains
      : [...base.matchedDomains, tag];
    return {
      ...base,
      requiresSuspendApproval: true,
      matchedDomains,
    };
  }
  return base;
}
