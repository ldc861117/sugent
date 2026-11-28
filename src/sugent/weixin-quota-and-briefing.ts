import * as crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { sealExternalEvent } from "./security-envelope.js";
import type { AtlasNode, StereoscopicAtlas } from "./stereoscopic-atlas.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";

export const COMPLIANCE_MODE = "forwarded_or_screenshot_only" as const;
export type WeixinBriefingComplianceMode = typeof COMPLIANCE_MODE;
export type WeixinProactiveUrgency = "normal" | "high" | "urgent";
export type WeixinChannelState = "connected" | "expired" | "disabled" | "error";

export interface WeixinAdaptiveQuotaGuardOptions {
  lowWatermark?: number;
  criticalWatermark?: number;
  maxBufferedPerPeer?: number;
}

export interface RouteProactivePushInput {
  peerId: string;
  title: string;
  body: string;
  urgency: WeixinProactiveUrgency;
  remainingQuota: number;
  channelState?: WeixinChannelState;
  nowIso?: string;
}

export type RouteProactivePushResult =
  | {
      action: "fallback_channel";
      fallbackChannel: "feishu";
      reason: "quota_exhausted_or_expired";
      alertText: string;
    }
  | {
      action: "buffered_low_quota";
      bufferedCount: number;
      remainingQuota: number;
    }
  | {
      action: "send_weixin_now";
      formattedText: string;
      remainingAfter: number;
    };

export interface FlushCoalescedDigestResult {
  flushedCount: number;
  digestText: string;
  action: "send_weixin_digest" | "fallback_channel";
}

export interface BufferedProactiveItem {
  peerId: string;
  title: string;
  body: string;
  urgency: WeixinProactiveUrgency;
  bufferedAtIso: string;
}

export interface ParsedForwardedTranscript {
  speakers: string[];
  primaryCounterparty: string;
  extractedNumbersAndTerms: string[];
  cleanedLines: string[];
}

export interface BuildThreeSecondForwardedBriefingInput {
  workspaceDir: string;
  ledger: Pick<StewardshipLedger, "queryContext">;
  atlas?: Pick<StereoscopicAtlas, "recallStereoscopic">;
  rawForwardedText: string;
  ownerName?: string;
  nowMs?: number;
  payload?: Record<string, unknown>;
}

export interface ThreeSecondForwardedBriefingResult {
  complianceMode: typeof COMPLIANCE_MODE;
  elapsedMs: number;
  counterparty: string;
  trustTier: string;
  envelopePath: string;
  recalledTaboos: string[];
  triggeredRedlines: string[];
  historicalFloorAnchors: string[];
  recalledAtlasRefs?: string[];
  copyableDrafts: {
    firmBoundary: string;
    collaborativeTradeoff: string;
  };
  threeLineSummary: [string, string, string];
}

const DEFAULT_OWNER_ALIASES = new Set(["我", "本人", "me", "self", "owner"]);

const NON_SPEAKER_LABELS = new Set([
  "图片ocr",
  "截图ocr",
  "ocr",
  "合并转发的聊天记录",
  "聊天记录",
  "群聊的聊天记录",
  "付款方式",
  "付款条件",
  "账期",
  "报价",
  "总价",
  "备注",
  "说明",
  "系统消息",
]);

function urgencyBadge(urgency: WeixinProactiveUrgency): string {
  if (urgency === "urgent") return "紧急";
  if (urgency === "high") return "高优";
  return "提醒";
}

function compactSingleLine(text: string, maxChars = 96): string {
  const norm = text.replace(/\s+/g, " ").trim();
  return norm.length <= maxChars ? norm : `${norm.slice(0, maxChars - 1)}…`;
}

export class WeixinAdaptiveQuotaGuard {
  public readonly lowWatermark: number;
  public readonly criticalWatermark: number;
  private readonly maxBufferedPerPeer: number;
  private readonly queues = new Map<string, BufferedProactiveItem[]>();

  public constructor(options: WeixinAdaptiveQuotaGuardOptions = {}) {
    const low = options.lowWatermark ?? 3;
    if (!Number.isFinite(low) || low < 0) {
      throw new RangeError(`Invalid lowWatermark: ${String(low)}`);
    }
    const critical =
      options.criticalWatermark !== undefined ? options.criticalWatermark : Math.min(1, low);
    if (!Number.isFinite(critical) || critical < 0 || critical > low) {
      throw new RangeError(`Invalid criticalWatermark: ${String(critical)}`);
    }
    this.lowWatermark = low;
    this.criticalWatermark = critical;
    this.maxBufferedPerPeer = Math.max(1, Math.trunc(options.maxBufferedPerPeer ?? 64));
  }

  public getBufferedCount(peerId: string): number {
    return this.queues.get(peerId.trim())?.length ?? 0;
  }

  public routeProactivePush(input: RouteProactivePushInput): RouteProactivePushResult {
    const peerId = input.peerId.trim();
    if (!peerId) throw new Error("peerId must be a non-empty string");
    const title = input.title.trim() || "未命名通知";
    const body = input.body.trim();
    const badge = urgencyBadge(input.urgency);

    const channelUnavailable =
      input.channelState !== undefined && input.channelState !== "connected";
    const quotaExhausted = !Number.isFinite(input.remainingQuota) || input.remainingQuota <= 0;

    if (channelUnavailable || quotaExhausted) {
      const reasonText = channelUnavailable
        ? `微信通道状态=${input.channelState}`
        : `微信 iLink 主动配额已耗尽(${input.remainingQuota})`;
      return {
        action: "fallback_channel",
        fallbackChannel: "feishu",
        reason: "quota_exhausted_or_expired",
        alertText: [`【微信降级转飞书 · ${badge}】${title}`, body, `原因：${reasonText}`]
          .filter(Boolean)
          .join("\n"),
      };
    }

    if (input.remainingQuota <= this.lowWatermark && input.urgency !== "urgent") {
      const list = this.queues.get(peerId) ?? [];
      list.push({
        peerId,
        title,
        body,
        urgency: input.urgency,
        bufferedAtIso: input.nowIso ?? new Date().toISOString(),
      });
      if (list.length > this.maxBufferedPerPeer) {
        list.splice(0, list.length - this.maxBufferedPerPeer);
      }
      this.queues.set(peerId, list);
      return {
        action: "buffered_low_quota",
        bufferedCount: list.length,
        remainingQuota: input.remainingQuota,
      };
    }

    const remainingAfter = input.remainingQuota - 1;
    const footer =
      input.remainingQuota <= this.criticalWatermark
        ? `\n（⚠️ iLink 主动配额临界：本条发出后剩余 ${remainingAfter} 条，回复任意消息可刷新窗口）`
        : input.remainingQuota <= this.lowWatermark
          ? `\n（提示：iLink 低配额保护中，本条紧急直达后剩余 ${remainingAfter} 条）`
          : "";

    return {
      action: "send_weixin_now",
      formattedText: [`【${badge}】${title}`, body].filter(Boolean).join("\n") + footer,
      remainingAfter,
    };
  }

  public flushCoalescedDigest(peerId: string, remainingQuota: number): FlushCoalescedDigestResult {
    const key = peerId.trim();
    if (!key) throw new Error("peerId must be a non-empty string");
    const hasQuota = Number.isFinite(remainingQuota) && remainingQuota > 0;
    const action = hasQuota ? "send_weixin_digest" : "fallback_channel";
    const items = this.queues.get(key);
    if (!items || items.length === 0) {
      this.queues.delete(key);
      return { flushedCount: 0, digestText: "", action };
    }
    const lines = [
      `【低配额折叠简报 · ${items.length} 项】`,
      ...items.map(
        (it, idx) =>
          `${idx + 1}. ${it.urgency === "high" ? "[高优] " : ""}${it.title}${it.body ? ` — ${compactSingleLine(it.body)}` : ""}`,
      ),
    ];
    this.queues.delete(key);
    return {
      flushedCount: items.length,
      digestText: lines.join("\n"),
      action,
    };
  }
}

export function parseForwardedChatTranscript(
  rawText: string,
  ownerAliases?: readonly string[],
): ParsedForwardedTranscript {
  const ownerSet = new Set(DEFAULT_OWNER_ALIASES);
  for (const alias of ownerAliases ?? []) {
    if (alias?.trim()) ownerSet.add(alias.trim().toLowerCase());
  }

  const cleanedLines: string[] = [];
  const speakers: string[] = [];
  const speakerCounts = new Map<string, number>();

  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^\[(?:合并转发的聊天记录|聊天记录|群聊的聊天记录|转发的聊天记录)\]$/.test(trimmed)) continue;
    if (/^[=—─\-~]{2,}.*[=—─\-~]{0,}$/.test(trimmed)) continue;

    const ocrStripped = trimmed.replace(/^\[(?:图片OCR|截图OCR|OCR)\]\s*/i, "").trim();
    if (!ocrStripped) continue;
    cleanedLines.push(ocrStripped);

    const m = /^([A-Za-z0-9\u4e00-\u9fa5·_-]{1,16})\s*[:：]\s*(.+)$/.exec(ocrStripped);
    if (m?.[1]) {
      const candidate = m[1].trim();
      const lower = candidate.toLowerCase();
      if (!NON_SPEAKER_LABELS.has(lower)) {
        if (!speakers.includes(candidate)) speakers.push(candidate);
        if (!ownerSet.has(lower)) {
          speakerCounts.set(candidate, (speakerCounts.get(candidate) ?? 0) + 1);
        }
      }
    }
  }

  let primaryCounterparty = "";
  let bestCount = 0;
  for (const [sp, count] of speakerCounts.entries()) {
    if (count > bestCount) {
      bestCount = count;
      primaryCounterparty = sp;
    }
  }
  if (!primaryCounterparty) {
    const honorific = /([\u4e00-\u9fa5]{1,3}(?:总|工|经理|主任|院长|厂长|老师))/.exec(
      cleanedLines.join(" "),
    );
    primaryCounterparty = honorific?.[1] ?? speakers.find((s) => !ownerSet.has(s.toLowerCase())) ?? "外部联系人";
  }

  const termSet = new Set<string>();
  const joined = cleanedLines.join("\n");
  const regexes = [
    /(?:账期|月结|验收后账期|验收后|票到)\s*\d+\s*(?:天|日|个月|月)/g,
    /\d+\s*(?:天|日)\s*账期/g,
    /\bNet\s*\d+\b/gi,
    /\d+(?:\.\d+)?\s*(?:万|万元|元|k|w)/gi,
    /(?:零首付|0首付|驻场包干|无限连带责任|背靠背)/g,
  ];
  for (const re of regexes) {
    for (const hit of joined.match(re) ?? []) {
      termSet.add(hit.trim());
    }
  }

  return {
    speakers,
    primaryCounterparty,
    extractedNumbersAndTerms: Array.from(termSet),
    cleanedLines,
  };
}

function parseQuotedPriceWan(lines: readonly string[]): number | null {
  const text = lines.join(" ");
  const preferred =
    /(?:便宜到|降到|总价|预算|报价|做到|给到)\s*(\d+(?:\.\d+)?)\s*(?:万元|万|w\b)/i.exec(text) ??
    /(\d+(?:\.\d+)?)\s*(?:万元|万|w\b)/i.exec(text);
  if (preferred?.[1]) {
    const val = Number(preferred[1]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  return null;
}

function parseRequestedDays(lines: readonly string[]): number | null {
  const text = lines.join(" ");
  const dayMatch = /(?:账期|月结|验收后账期|Net)\s*(\d+)\s*(?:天|日)?/i.exec(text);
  if (dayMatch?.[1]) {
    const days = Number(dayMatch[1]);
    if (Number.isFinite(days) && days > 0) return days;
  }
  return null;
}

function isBriefingAllowedAtlasPlane(plane: string): boolean {
  return (
    plane === "self_core" ||
    plane === "owner_life" ||
    plane === "domain_work" ||
    plane.startsWith("domain_work:") ||
    plane === "relational:peer" ||
    plane.startsWith("relational:peer:")
  );
}

function extractAtlasFloorWan(text: string): number | null {
  const explicitWan =
    /(?:底价|底线|最低价|单价底线|核算底线|不得低于|不低于)\s*(?:为|是|:|：)?\s*(\d+(?:\.\d+)?)\s*(?:万元|万|w\b)/i.exec(
      text,
    );
  if (explicitWan?.[1]) {
    const val = Number(explicitWan[1]);
    if (Number.isFinite(val) && val > 0) return val;
  }
  const explicitYuan =
    /(?:底价|底线|最低价|单价底线|核算底线)\s*(?:为|是|:|：)?\s*(\d{4,})\s*元/i.exec(text);
  if (explicitYuan?.[1]) {
    const val = Number(explicitYuan[1]) / 10_000;
    if (Number.isFinite(val) && val > 0) return val;
  }
  if (/(?:底价|底线|最低价)/.test(text)) {
    const fallback = /(?<!(?:对方|期望|压价|降到|便宜到)\s*)(\d+(?:\.\d+)?)\s*(?:万元|万)/i.exec(text);
    if (fallback?.[1]) {
      const val = Number(fallback[1]);
      if (Number.isFinite(val) && val > 0) return val;
    }
  }
  return null;
}

function extractAtlasPaymentDayCap(text: string): number | null {
  const explicitCap =
    /(?:账期(?:上限|红线|不得超过|不超过|控制在|最多|上限为)|上限|最高账期|(?:不得超过|不超过)\s*(?:Net\s*)?)\s*(\d+)\s*天/i.exec(
      text,
    );
  if (explicitCap?.[1]) {
    const days = Number(explicitCap[1]);
    if (Number.isFinite(days) && days > 0) return days;
  }
  const netOrTerm = /(?<!超限\s*)(?:标准账期|结算账期|Net)\s*(\d+)\s*天?/i.exec(text);
  if (netOrTerm?.[1]) {
    const days = Number(netOrTerm[1]);
    if (Number.isFinite(days) && days > 0) return days;
  }
  return null;
}

function extractPeerTaboosFromAtlasSummary(summary: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string) => {
    const clean = s.trim();
    if (clean.length < 2 || seen.has(clean)) return;
    seen.add(clean);
    out.push(clean);
  };
  const explicit = /(?:忌讳|禁忌|taboos?)\s*[:：]\s*([^；;\n]+?)(?=\s*[；;]?\s*(?:偏好|喜好|preferences?)\s*[:：]|$)/i.exec(
    summary,
  );
  if (explicit?.[1]) {
    for (const part of explicit[1].split(/[/、，,；;]+/)) push(part);
  }
  const clauses =
    summary.match(
      /(?:切忌提及|切忌|切勿|严禁|忌提|忌谈|忌口|不要承诺|不要提|别提|禁止提及|禁止|不谈|不提)[^；;，,。/\n（）()]{1,28}/g,
    ) ?? [];
  for (const c of clauses) push(c);
  return out;
}

function sanitizeBriefingDraftAgainstTaboos(draft: string, taboos: readonly string[]): string {
  let out = draft;
  for (const raw of taboos) {
    const trimmed = raw.trim();
    if (trimmed.length >= 2 && out.includes(trimmed)) {
      out = out.split(trimmed).join("相关细节");
    }
    const core = trimmed
      .replace(/^(?:切忌提及|切忌|切勿|严禁|忌讳|禁忌|忌提|忌谈|忌|不要承诺|不要提|不要|别提|禁止提及|禁止)+/, "")
      .trim();
    if (core.length >= 3 && !/^(?:驻场包干|零首付|账期)$/.test(core) && out.includes(core)) {
      out = out.split(core).join("相关事项");
    }
  }
  return out;
}

const SELF_CORE_NEGOTIATION_RE =
  /(?:账期|净账期|月结|net\s*\d*|报价|底价|底线|降价|压价|打折|折扣|让步|妥协|违约|赔偿|连带|首付|预付|定金|尾款|驻场|包干|背靠背|合同|商务|谈判)/i;

export function buildThreeSecondForwardedBriefing(
  input: BuildThreeSecondForwardedBriefingInput,
): ThreeSecondForwardedBriefingResult {
  const t0 = performance.now();
  const parsed = parseForwardedChatTranscript(
    input.rawForwardedText,
    input.ownerName ? [input.ownerName] : undefined,
  );
  const counterparty = parsed.primaryCounterparty;
  const eventId = `wx-fwd-${crypto.randomBytes(4).toString("hex")}`;

  const sealed = sealExternalEvent({
    workspaceDir: input.workspaceDir,
    source: "weixin_forwarded",
    eventType: "forwarded_chat_briefing",
    eventId,
    title: `WeChat Forwarded Chat (${counterparty})`,
    body: parsed.cleanedLines.join("\n"),
    payload: {
      ...(input.payload ?? {}),
      counterparty,
      extractedTerms: parsed.extractedNumbersAndTerms,
    },
    privilegedFieldMode: "strip",
  });

  const queries = [counterparty, ...parsed.extractedNumbersAndTerms.slice(0, 4), "账期 底价"];
  const relMap = new Map<string, ReturnType<typeof input.ledger.queryContext>["relationships"][number]>();
  const guardMap = new Map<string, ReturnType<typeof input.ledger.queryContext>["guardrails"][number]>();
  const resMap = new Map<string, ReturnType<typeof input.ledger.queryContext>["resources"][number]>();

  for (const q of queries) {
    const ctx = input.ledger.queryContext(q, "owner_private");
    for (const r of ctx.relationships) relMap.set(r.id, r);
    for (const g of ctx.guardrails) guardMap.set(g.id, g);
    for (const res of ctx.resources) resMap.set(res.id, res);
  }

  const matchedRel =
    Array.from(relMap.values()).find((r) => r.name === counterparty || counterparty.includes(r.name)) ??
    Array.from(relMap.values())[0];
  const trustTier = matchedRel?.trustTier ?? "L0_record_only";
  const recalledTaboos = matchedRel ? [...matchedRel.taboos] : [];
  const pushTabooDedup = (taboo: string) => {
    const clean = taboo.trim();
    if (clean && !recalledTaboos.includes(clean)) recalledTaboos.push(clean);
  };

  const historicalFloorAnchors: string[] = [];
  const pushAnchorDedup = (anchor: string) => {
    const clean = anchor.trim();
    if (clean && !historicalFloorAnchors.includes(clean)) historicalFloorAnchors.push(clean);
  };
  let floorPriceWan: number | null = null;
  let maxPaymentDays: number | null = null;

  for (const res of resMap.values()) {
    const metaCp = typeof res.metadata.counterparty === "string" ? res.metadata.counterparty : "";
    if (metaCp && metaCp !== counterparty && !res.title.includes(counterparty)) continue;

    if (typeof res.metadata.floorPriceWan === "number") {
      floorPriceWan = res.metadata.floorPriceWan;
      pushAnchorDedup(`${res.title}：历史底价 ${res.metadata.floorPriceWan} 万`);
    } else if (typeof res.metadata.floorPrice === "number") {
      floorPriceWan = res.metadata.floorPrice / 10_000;
      pushAnchorDedup(`${res.title}：历史底价 ${res.metadata.floorPrice} 元`);
    }
    if (typeof res.metadata.maxPaymentDays === "number") {
      maxPaymentDays = res.metadata.maxPaymentDays;
    }
  }

  const triggeredRedlines: string[] = [];
  const pushRedlineDedup = (line: string) => {
    const clean = line.trim();
    if (clean && !triggeredRedlines.includes(clean)) triggeredRedlines.push(clean);
  };

  const fullCleanText = parsed.cleanedLines.join(" ");
  const quotedWan = parseQuotedPriceWan(parsed.cleanedLines);
  const reqDays = parseRequestedDays(parsed.cleanedLines);

  const recalledAtlasRefSet = new Set<string>();
  const atlasDomainRedlines: string[] = [];
  const atlasSelfTombstoneRedlines: string[] = [];
  const atlasOwnerGuardrails: AtlasNode[] = [];

  if (input.atlas) {
    const atlasQueries = Array.from(
      new Set(
        [
          `${counterparty} ${parsed.extractedNumbersAndTerms.slice(0, 4).join(" ")}`.trim(),
          counterparty !== "外部联系人" ? counterparty : "",
          "合同 审校 账期 底价 红线 墓碑",
        ].filter(Boolean),
      ),
    );
    const atlasNodeMap = new Map<string, AtlasNode>();
    for (const aq of atlasQueries) {
      const recalled = input.atlas.recallStereoscopic(aq, {
        callerPrincipals: ["sugent_self", "owner:M"],
        maxNodes: 12,
      });
      for (const node of recalled.nodes) {
        if (!isBriefingAllowedAtlasPlane(node.plane)) continue;
        if (!atlasNodeMap.has(node.id)) atlasNodeMap.set(node.id, node);
      }
    }

    const hasNamedCounterparty = Boolean(counterparty && counterparty !== "外部联系人");
    for (const node of atlasNodeMap.values()) {
      const nodeText = `${node.name} ${node.summary} ${node.tags.join(" ")}`;
      const cpMatched =
        hasNamedCounterparty &&
        (nodeText.includes(counterparty) || (node.name.length >= 2 && counterparty.includes(node.name)));

      if (node.plane.startsWith("domain_work:")) {
        const reviewedCpMatch = /^合同审校\s+([^\s(（）]+)/.exec(node.name);
        const reviewedCp = reviewedCpMatch?.[1]?.trim() ?? "";
        const belongsToOtherCounterparty =
          Boolean(reviewedCp) &&
          hasNamedCounterparty &&
          reviewedCp !== counterparty &&
          !counterparty.includes(reviewedCp) &&
          !reviewedCp.includes(counterparty);

        if (!belongsToOtherCounterparty) {
          if (floorPriceWan === null) {
            const extractedFloor = extractAtlasFloorWan(nodeText);
            if (extractedFloor !== null) floorPriceWan = extractedFloor;
          }
          if (maxPaymentDays === null) {
            const extractedCap = extractAtlasPaymentDayCap(nodeText);
            if (extractedCap !== null) maxPaymentDays = extractedCap;
          }
          if (
            node.id.startsWith("contract:review:") ||
            node.plane === "domain_work:contract-guard" ||
            /(?:底价|底线|账期|合同|审校|报价)/.test(nodeText)
          ) {
            pushAnchorDedup(`[domain_work] ${node.name}：${node.summary}`);
            recalledAtlasRefSet.add(node.id);
          }
        }

        const isBlockOrTombstone =
          node.kind === "tombstone" ||
          node.kind === "guardrail" ||
          node.tags.includes("block") ||
          /\(block\)|拦截|超限|违约|零首付|破底价/i.test(nodeText);
        const riskTermOverlap =
          (reqDays !== null && /账期|Net/i.test(nodeText)) ||
          (quotedWan !== null && /底价|底线|报价/.test(nodeText)) ||
          (/零首付|0首付/.test(fullCleanText) && /零首付|首付/.test(nodeText)) ||
          (/连带|背靠背|驻场/.test(fullCleanText) && /连带|背靠背|驻场/.test(nodeText));

        if (isBlockOrTombstone && (!belongsToOtherCounterparty || cpMatched || riskTermOverlap)) {
          atlasDomainRedlines.push(`历史合同审校红线（${node.name}）：${node.summary}`);
          recalledAtlasRefSet.add(node.id);
        }
        continue;
      }

      if (node.plane === "self_core") {
        const isTombstone =
          node.kind === "tombstone" ||
          node.id.startsWith("self:tombstone:") ||
          node.tags.includes("epistemic_tombstone");
        if (isTombstone && (cpMatched || SELF_CORE_NEGOTIATION_RE.test(nodeText))) {
          atlasSelfTombstoneRedlines.push(`[硅基墓碑预警] ${node.name}：${node.summary}`);
          recalledAtlasRefSet.add(node.id);
        }
        continue;
      }

      if (node.plane === "relational:peer" || node.plane.startsWith("relational:peer:")) {
        if (cpMatched || node.id.includes(counterparty)) {
          const peerTaboos = extractPeerTaboosFromAtlasSummary(node.summary);
          for (const t of peerTaboos) pushTabooDedup(t);
          if (peerTaboos.length > 0 || cpMatched) {
            recalledAtlasRefSet.add(node.id);
          }
        }
        continue;
      }

      if (node.plane === "owner_life" && (node.kind === "guardrail" || node.kind === "tombstone")) {
        atlasOwnerGuardrails.push(node);
      }
    }
  }

  if (floorPriceWan !== null && quotedWan !== null && quotedWan < floorPriceWan) {
    pushRedlineDedup(`报价破底价红线：对方期望 ${quotedWan} 万 < 历史底价 ${floorPriceWan} 万`);
  }

  let paymentDaysRedlineTriggered = false;
  for (const gr of guardMap.values()) {
    if (gr.kind !== "hard_redline" && gr.kind !== "tombstone") continue;
    const grDaysMatch = /(\d+)\s*天/.exec(gr.statement);
    const limitDays = grDaysMatch?.[1] ? Number(grDaysMatch[1]) : maxPaymentDays;
    if (limitDays && reqDays && reqDays > limitDays) {
      pushRedlineDedup(`账期超限红线：对方要求 ${reqDays} 天 > 红线 ${limitDays} 天（${gr.statement}）`);
      paymentDaysRedlineTriggered = true;
    }
    if (/零首付/.test(gr.statement) && /零首付|0首付/.test(fullCleanText)) {
      pushRedlineDedup(`首付红线触发：${gr.statement}`);
    }
  }
  for (const og of atlasOwnerGuardrails) {
    const grDaysMatch = /(\d+)\s*天/.exec(og.summary);
    const limitDays = grDaysMatch?.[1] ? Number(grDaysMatch[1]) : maxPaymentDays;
    if (!paymentDaysRedlineTriggered && limitDays && reqDays && reqDays > limitDays) {
      pushRedlineDedup(`账期超限红线：对方要求 ${reqDays} 天 > 红线 ${limitDays} 天（${og.summary}）`);
      paymentDaysRedlineTriggered = true;
      recalledAtlasRefSet.add(og.id);
    }
    if (/零首付/.test(og.summary) && /零首付|0首付/.test(fullCleanText)) {
      pushRedlineDedup(`首付红线触发：${og.summary}`);
      recalledAtlasRefSet.add(og.id);
    }
  }
  if (!paymentDaysRedlineTriggered && maxPaymentDays !== null && reqDays !== null && reqDays > maxPaymentDays) {
    pushRedlineDedup(`账期超限红线：对方要求 ${reqDays} 天 > 历史上限 ${maxPaymentDays} 天`);
  }

  for (const rl of atlasDomainRedlines) pushRedlineDedup(rl);
  for (const rl of atlasSelfTombstoneRedlines) pushRedlineDedup(rl);

  for (const taboo of recalledTaboos) {
    const core = taboo.replace(/^(?:切忌提及|切忌|不要承诺|禁止|切勿|忌提|忌)/, "").trim();
    if (core.length >= 2 && fullCleanText.includes(core)) {
      pushRedlineDedup(`触碰客户沟通禁忌：${taboo}`);
    }
  }

  if (/ignore\s+previous\s+instructions|忽略.*指令/i.test(fullCleanText)) {
    pushRedlineDedup("安全信封拦截：检测到转发文本内嵌提示词注入企图，已物理隔离剥离");
  }

  const anchorPriceLabel = floorPriceWan !== null ? `${floorPriceWan} 万` : "核定标准报价";
  const anchorDaysLabel = maxPaymentDays !== null ? `${maxPaymentDays} 天内` : "标准里程碑首付+验收结清";

  const rawFirmBoundary = `${counterparty}您好，方案范围我们已仔细核对。按本项目的交付深度与质量标准，核算底线为 ${anchorPriceLabel}，结算方式需保持首付启动且账期控制在 ${anchorDaysLabel}，实在无法按零首付或超长账期立项，还请理解。`;
  const rawCollaborativeTradeoff = `${counterparty}您好，理解咱们预算与流程上的考量。如果希望往您的目标预算靠拢，我们可以把一期范围收敛为核心诊断模块（精简现场非标定制工时），按标准首付与 ${anchorDaysLabel} 账期快速跑通首期见效，您看这样是否更稳妥？`;
  const firmBoundary = sanitizeBriefingDraftAgainstTaboos(rawFirmBoundary, recalledTaboos);
  const collaborativeTradeoff = sanitizeBriefingDraftAgainstTaboos(rawCollaborativeTradeoff, recalledTaboos);

  const elapsedMs = Math.max(1, Math.round((performance.now() - t0) * 100) / 100);
  const threeLineSummary: [string, string, string] = [
    `对象与阶梯：${counterparty}（${trustTier}）· 耗时 ${elapsedMs}ms（合规转发只读模式）`,
    triggeredRedlines.length > 0
      ? `红线预警（${triggeredRedlines.length} 项）：${triggeredRedlines.slice(0, 2).join("；")}`
      : "红线核验：未触发历史底价与账期硬红线",
    historicalFloorAnchors.length > 0
      ? `历史锚点：${historicalFloorAnchors[0]}；已生成双版本可复制回复话术`
      : "历史锚点：暂无专属底价单，已按全局价值护栏生成回复话术",
  ];

  return {
    complianceMode: COMPLIANCE_MODE,
    elapsedMs,
    counterparty,
    trustTier,
    envelopePath: sealed.envelope.absoluteFilePath,
    recalledTaboos,
    triggeredRedlines,
    historicalFloorAnchors,
    ...(input.atlas ? { recalledAtlasRefs: Array.from(recalledAtlasRefSet) } : {}),
    copyableDrafts: {
      firmBoundary,
      collaborativeTradeoff,
    },
    threeLineSummary,
  };
}

export interface IngestForwardedBriefingInput {
  workspaceDir: string;
  ledger: Pick<StewardshipLedger, "queryContext" | "snapshotForCaller" | "upsertCommitment" | "upsertResource">;
  atlas?: Pick<StereoscopicAtlas, "recallStereoscopic">;
  rawForwardedText: string;
  ownerName?: string;
  autoRecordToLedger?: boolean;
  nowIso?: string;
}

export interface IngestForwardedBriefingResult {
  briefing: ThreeSecondForwardedBriefingResult;
  recordedCommitments: ReturnType<StewardshipLedger["upsertCommitment"]>[];
  recordedResource?: ReturnType<StewardshipLedger["upsertResource"]>;
  deduplicated: boolean;
}

const FORWARDED_COMMITMENT_CUE_RE =
  /(?:明天|明日|后天|下周|本周|这周|周[一二三四五六日天末]|星期[一二三四五六日天]|月底|今天内|下班前|尽快|\d+\s*(?:天|工作日)|答应|承诺|安排|发给|发你|发您|同步|提交|补齐|确认|核对|对齐|盖章|打款|付款)/;

export function ingestForwardedBriefingToLedger(
  input: IngestForwardedBriefingInput,
): IngestForwardedBriefingResult {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const parsedNowMs = Date.parse(nowIso);
  const nowMs = Number.isFinite(parsedNowMs) ? parsedNowMs : Date.now();

  const briefing = buildThreeSecondForwardedBriefing({
    workspaceDir: input.workspaceDir,
    ledger: input.ledger,
    ...(input.atlas ? { atlas: input.atlas } : {}),
    rawForwardedText: input.rawForwardedText,
    ...(input.ownerName ? { ownerName: input.ownerName } : {}),
    nowMs,
  });

  if (input.autoRecordToLedger === false) {
    return {
      briefing,
      recordedCommitments: [],
      deduplicated: false,
    };
  }

  const ownerSet = new Set(DEFAULT_OWNER_ALIASES);
  if (input.ownerName?.trim()) ownerSet.add(input.ownerName.trim().toLowerCase());
  const parsed = parseForwardedChatTranscript(
    input.rawForwardedText,
    input.ownerName ? [input.ownerName] : undefined,
  );
  const canonicalTranscript = parsed.cleanedLines.join("\n");
  const hash12 = crypto.createHash("sha256").update(canonicalTranscript, "utf8").digest("hex").slice(0, 12);
  const archiveId = `res-fwd-${hash12}`;

  const existing = input.ledger
    .snapshotForCaller("owner_private")
    .resources.find((r) => r.id === archiveId || r.metadata.fingerprint === hash12);
  if (existing) {
    return {
      briefing,
      recordedCommitments: [],
      recordedResource: existing,
      deduplicated: true,
    };
  }

  const recordedCommitments: ReturnType<StewardshipLedger["upsertCommitment"]>[] = [];
  parsed.cleanedLines.forEach((line, idx) => {
    const spMatch = /^([A-Za-z0-9\u4e00-\u9fa5·_-]{1,16})\s*[:：]\s*(.+)$/.exec(line);
    const speaker = spMatch?.[1]?.trim() ?? "";
    const body = (spMatch?.[2] ?? line).trim();
    if (!body || !FORWARDED_COMMITMENT_CUE_RE.test(body)) return;

    const isOwner = speaker
      ? ownerSet.has(speaker.toLowerCase())
      : /^(?:我(?:们|这边)?|本人)/.test(body);
    const direction: "i_owe" | "waiting_for" = isOwner ? "i_owe" : "waiting_for";
    const actorLabel = isOwner ? "我方跟进" : `${speaker || briefing.counterparty}承诺`;
    const cmt = input.ledger.upsertCommitment(
      {
        id: `cmt-fwd-${hash12}-${direction}-${idx}`,
        partition: "work_project",
        direction,
        status: "open",
        summary: compactSingleLine(`${actorLabel}：${body}`, 140),
        counterpartyOrRef: briefing.counterparty,
      },
      nowIso,
    );
    recordedCommitments.push(cmt);
  });

  const recordedResource = input.ledger.upsertResource(
    {
      id: archiveId,
      partition: "work_project",
      kind: "personal_archive",
      title: `微信转发沟通记录 · ${briefing.counterparty}`,
      localUriOrPath: briefing.envelopePath,
      metadata: {
        source: "weixin_forwarded",
        counterparty: briefing.counterparty,
        extractedTerms: parsed.extractedNumbersAndTerms.join(", ").slice(0, 200),
        fingerprint: hash12,
      },
    },
    nowIso,
  );

  return {
    briefing,
    recordedCommitments,
    recordedResource,
    deduplicated: false,
  };
}
