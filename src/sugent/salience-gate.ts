/**
 * 零 LLM 认知显著性门控与结构增量计算（src/sugent/salience-gate.ts）
 *
 * 严格遵守内核纯度铁律：
 * - 零文件 I/O、零网络请求、零系统时钟读取、零随机数调用；
 * - 零模型供应商或即时通信平台名称硬编码；
 * - 介于零 Token 哈希探针与轻量评估器之间，识别纯时间戳抖动与无实质语义增量，
 *   低于动态阈值时直接产出 0 Token 确定性摘要（templateDigest）落盘，不唤醒模型。
 */
import type { BotBudgetStatus } from "./local-budget.js";
import type { CadenceBudgetState } from "./proactive-cadence.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";
import type { PersonalTrigger } from "./types.js";

export type SalienceBand = "NOISE" | "NOTICE" | "IMPORTANT" | "CRITICAL";

export type SalienceRoute =
  | "drop_noise"
  | "fast_template_digest"
  | "wake_assessor"
  | "fast_escalate_owner";

export interface EventWorldDelta {
  key: string;
  addedKeys: string[];
  removedKeys: string[];
  changedFields: Array<{ field: string; from?: unknown; to?: unknown }>;
  magnitude: number;
  elapsedMsSinceLastSeen: number;
}

export interface SalienceInput {
  trigger: Pick<PersonalTrigger, "id" | "sourceKind" | "text" | "threadKey" | "createdAt" | "meta">;
  delta: EventWorldDelta;
  ledger: Pick<LedgerSnapshot, "goals" | "commitments" | "guardrails">;
  budgetStatus?: Pick<BotBudgetStatus, "enabled" | "lowReserve" | "exhausted">;
  cadenceState: Pick<CadenceBudgetState, "quietHoursActive">;
  expectedOutcomeMatch?: number;
  nowIso: string;
}

export interface SalienceVerdict {
  score: number;
  effectiveThreshold: number;
  band: SalienceBand;
  route: SalienceRoute;
  templateDigest?: string;
  matchedGoalIds: string[];
  breakdown: {
    goalAlignment: number;
    predictionError: number;
    novelty: number;
    deadlineUrgency: number;
  };
}

const VOLATILE_TIMESTAMP_KEYS = new Set([
  "updatedat",
  "updatedatiso",
  "checkedat",
  "checkedatiso",
  "timestamp",
  "scannedat",
  "scannedatiso",
  "lastmodified",
  "lastmodifiedtime",
  "heartbeatat",
  "lastseenat",
]);

function isVolatileKey(keyPath: string): boolean {
  const leaf = keyPath.split(".").pop() ?? keyPath;
  return VOLATILE_TIMESTAMP_KEYS.has(leaf.toLowerCase());
}

function stableJson(val: unknown): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val !== "object") return JSON.stringify(val);
  if (Array.isArray(val)) return `[${val.map(stableJson).join(",")}]`;
  const rec = val as Record<string, unknown>;
  const keys = Object.keys(rec).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(",")}}`;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === "object" && !Array.isArray(val);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tokenizeText(text: string): string[] {
  const out = new Set<string>();
  const lower = String(text ?? "").toLowerCase().trim();
  if (!lower) return [];
  for (const part of lower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’/\\_-]+/).filter(Boolean)) {
    for (const ascii of part.match(/[a-z0-9]{2,}/g) ?? []) out.add(ascii);
    const han = Array.from(part).filter((ch) => /\p{Script=Han}/u.test(ch));
    if (han.length === 1) out.add(han[0]!);
    for (let i = 0; i + 1 < han.length; i++) out.add(han[i]! + han[i + 1]!);
  }
  return Array.from(out);
}

function textOverlapScore(a: string, b: string): number {
  const ta = tokenizeText(a);
  if (ta.length === 0) return 0;
  const tbSet = new Set(tokenizeText(b));
  const bLower = b.toLowerCase();
  let hits = 0;
  for (const tok of ta) {
    if (tbSet.has(tok) || bLower.includes(tok)) hits++;
  }
  return clamp01(hits / Math.min(ta.length, 4));
}

function diffRecords(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  prefix: string,
  addedKeys: string[],
  removedKeys: string[],
  changedFields: Array<{ field: string; from?: unknown; to?: unknown }>,
): number {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  let inspectedLeaves = 0;
  for (const k of keys) {
    const fieldPath = prefix ? `${prefix}.${k}` : k;
    if (isVolatileKey(fieldPath)) continue;
    const hasPrev = Object.prototype.hasOwnProperty.call(prev, k);
    const hasNext = Object.prototype.hasOwnProperty.call(next, k);
    if (!hasPrev && hasNext) {
      addedKeys.push(fieldPath);
      inspectedLeaves++;
      continue;
    }
    if (hasPrev && !hasNext) {
      removedKeys.push(fieldPath);
      inspectedLeaves++;
      continue;
    }
    const pv = prev[k];
    const nv = next[k];
    if (isPlainObject(pv) && isPlainObject(nv)) {
      inspectedLeaves += diffRecords(pv, nv, fieldPath, addedKeys, removedKeys, changedFields);
      continue;
    }
    inspectedLeaves++;
    if (stableJson(pv) !== stableJson(nv)) {
      changedFields.push({ field: fieldPath, from: pv, to: nv });
    }
  }
  return inspectedLeaves;
}

export function computeEventDelta(
  prevPayload: Record<string, unknown> | undefined,
  nextPayload: Record<string, unknown>,
  key: string,
  elapsedMs: number,
): EventWorldDelta {
  const addedKeys: string[] = [];
  const removedKeys: string[] = [];
  const changedFields: Array<{ field: string; from?: unknown; to?: unknown }> = [];
  const safeElapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;

  if (!prevPayload) {
    for (const k of Object.keys(nextPayload ?? {})) {
      if (!isVolatileKey(k)) addedKeys.push(k);
    }
    return {
      key,
      addedKeys,
      removedKeys,
      changedFields,
      magnitude: addedKeys.length > 0 ? 1 : 0,
      elapsedMsSinceLastSeen: safeElapsed,
    };
  }

  const leafCount = diffRecords(prevPayload, nextPayload ?? {}, "", addedKeys, removedKeys, changedFields);
  const diffCount = addedKeys.length + removedKeys.length + changedFields.length;
  const magnitude = leafCount > 0 ? clamp01(diffCount / Math.max(1, Math.min(leafCount, 5))) : 0;
  return { key, addedKeys, removedKeys, changedFields, magnitude, elapsedMsSinceLastSeen: safeElapsed };
}

function computeUrgencyScore(input: SalienceInput): number {
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isFinite(nowMs)) return 0;
  let best = 0;
  for (const item of input.ledger.commitments ?? []) {
    if (item.status === "closed" || item.status === "superseded" || !item.dueAt) continue;
    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    const hoursLeft = (dueMs - nowMs) / 3_600_000;
    const rel = textOverlapScore(input.trigger.text, `${item.summary} ${item.counterpartyOrRef}`);
    if (hoursLeft <= 0) best = Math.max(best, rel > 0 ? 1 : 0.7);
    else if (hoursLeft <= 24) best = Math.max(best, rel > 0 ? 0.95 : 0.55);
    else if (hoursLeft <= 72) best = Math.max(best, rel > 0 ? 0.7 : 0.35);
  }
  if (/(?:紧急|告警|宕机|崩|失败|阻断|urgent|critical|error|failed|outage)/i.test(input.trigger.text)) {
    best = Math.max(best, 0.85);
  }
  return clamp01(best);
}

function buildTemplateDigest(input: SalienceInput): string {
  const fields = [
    ...input.delta.addedKeys.map((k) => `+${k}`),
    ...input.delta.changedFields.map((c) => `${c.field}`),
    ...input.delta.removedKeys.map((k) => `-${k}`),
  ].slice(0, 3);
  const summary = String(input.trigger.text ?? "").replace(/\s+/g, " ").trim().slice(0, 64) || input.delta.key;
  return fields.length > 0
    ? `[0-token digest] (${input.trigger.sourceKind}) ${summary} [Δ:${fields.join(",")}]`
    : `[0-token digest] (${input.trigger.sourceKind}) ${summary}`;
}

export function scoreEventSalience(input: SalienceInput): SalienceVerdict {
  const matchedGoalIds: string[] = [];
  let goalAlignment = 0;
  for (const goal of input.ledger.goals ?? []) {
    if (goal.status !== "active") continue;
    const overlap = textOverlapScore(input.trigger.text, `${goal.title} ${goal.northStarCriterion}`);
    if (overlap > 0) {
      matchedGoalIds.push(goal.id);
      goalAlignment = Math.max(goalAlignment, Math.min(1, 0.4 + overlap * 0.6));
    }
  }

  const predictionError = clamp01(1 - clamp01(input.expectedOutcomeMatch ?? 1));
  const novelty = clamp01(input.delta.magnitude);
  const deadlineUrgency = computeUrgencyScore(input);

  const score = clamp01(
    goalAlignment * 0.35 +
      predictionError * 0.30 +
      novelty * 0.20 +
      deadlineUrgency * 0.15,
  );

  let threshold = 0.35;
  if (input.budgetStatus?.lowReserve) threshold += 0.15;
  if (input.cadenceState.quietHoursActive) threshold += 0.20;
  const effectiveThreshold = Math.max(0.30, Math.min(0.90, threshold));

  const breakdown = { goalAlignment, predictionError, novelty, deadlineUrgency };

  if (novelty === 0 && predictionError <= 0.1 && deadlineUrgency < 0.7) {
    return { score, effectiveThreshold, band: "NOISE", route: "drop_noise", matchedGoalIds, breakdown };
  }
  if (score >= 0.80 || deadlineUrgency >= 0.90) {
    return { score, effectiveThreshold, band: "CRITICAL", route: "fast_escalate_owner", matchedGoalIds, breakdown };
  }
  if (score >= effectiveThreshold) {
    return {
      score,
      effectiveThreshold,
      band: score >= 0.60 ? "IMPORTANT" : "NOTICE",
      route: "wake_assessor",
      matchedGoalIds,
      breakdown,
    };
  }
  return {
    score,
    effectiveThreshold,
    band: score >= 0.20 ? "NOTICE" : "NOISE",
    route: "fast_template_digest",
    templateDigest: buildTemplateDigest(input),
    matchedGoalIds,
    breakdown,
  };
}