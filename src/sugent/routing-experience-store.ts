import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type TaskArchetype =
  | "quick_chat_capture"
  | "tool_orchestration"
  | "long_doc_synthesis"
  | "deep_reasoning_plan"
  | "coding_and_review"
  | "vision_gui";

export const TASK_ARCHETYPES: readonly TaskArchetype[] = [
  "quick_chat_capture",
  "tool_orchestration",
  "long_doc_synthesis",
  "deep_reasoning_plan",
  "coding_and_review",
  "vision_gui",
] as const;

export type RoutingStrategyPreset = "quota_saver" | "balanced" | "quality_first";
export type RoutingOperatingMode = "auto" | "shadow" | "pinned";

export interface ExperienceCell {
  key: string;
  archetype: TaskArchetype;
  targetId: string;
  effectiveSamples: number;
  qualitySum: number;
  successCount: number;
  failureCount: number;
  toolErrorCount: number;
  escalationCount: number;
  userCorrectionCount: number;
  explicitRetryCount: number;
  ewmaTtftMs: number | null;
  ewmaLatencyMs: number | null;
  ewmaCostUsd: number;
  lastUsedAtMs: number;
  lastUpdatedAtMs: number;
}

export interface RoutingOutcomeEvent {
  decisionId: string;
  targetId: string;
  archetype: TaskArchetype;
  ok: boolean;
  ttftMs?: number;
  totalLatencyMs?: number;
  costUsd?: number;
  toolCallCount?: number;
  toolParseErrorCount?: number;
  emptyReply?: boolean;
  escalated?: boolean;
  signalSource:
    | "turn_complete"
    | "infra_fallback"
    | "quality_escalation"
    | "user_correction"
    | "explicit_retry_stronger"
    | "vibe_gate_pass"
    | "vibe_gate_fail";
  weight?: number;
  atMs?: number;
}
export interface RoutingPolicyRule {
  id: string;
  text: string;
  kind: "prefer" | "avoid" | "block" | "strategy" | "pin" | "mode";
  createdAtIso: string;
}

export interface RoutingPolicyState {
  version: 1;
  strategy: RoutingStrategyPreset;
  mode: RoutingOperatingMode;
  pinnedModel?: string;
  blockedModels: string[];
  archetypeBoosts: Partial<Record<TaskArchetype, Record<string, number>>>;
  rules: RoutingPolicyRule[];
  updatedAtIso: string;
}

export interface RecordedRouteDecision {
  decisionId: string;
  atIso: string;
  atMs: number;
  archetype: TaskArchetype;
  mode: RoutingOperatingMode;
  strategy: RoutingStrategyPreset;
  selectedTargetId: string;
  rawModelId: string;
  providerId: string;
  shadowRecommendedTargetId?: string;
  reasonSummary: string;
  score: number;
  fallbackTargets: string[];
  escalationTarget?: string;
  skippedCoolingModels: string[];
  escalatedFrom?: string;
  fallbackUsedFrom?: string;
  userTextPreview?: string;
}

export interface PosteriorEstimate {
  posteriorQuality: number;
  effectiveSamples: number;
  reliability: number;
  ewmaTtftMs: number | null;
  ewmaLatencyMs: number | null;
}

export interface ArchetypeLeaderboardEntry {
  targetId: string;
  posteriorQuality: number;
  samples: number;
  ewmaTtftMs: number | null;
}

const VALID_STRATEGIES = new Set<RoutingStrategyPreset>([
  "quota_saver",
  "balanced",
  "quality_first",
]);
const VALID_MODES = new Set<RoutingOperatingMode>(["auto", "shadow", "pinned"]);

function writeAtomic600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Ignore cleanup errors on failed atomic write.
    }
    throw err;
  }
}
function resolveRewardAndWeight(ev: RoutingOutcomeEvent): { reward: number; weight: number } {
  const w = ev.weight;
  if (ev.signalSource === "explicit_retry_stronger") return { reward: 0.05, weight: w ?? 3.0 };
  if (ev.signalSource === "user_correction") return { reward: 0.1, weight: w ?? 2.0 };
  if (ev.signalSource === "vibe_gate_pass") return { reward: 1.0, weight: w ?? 2.5 };
  if (ev.signalSource === "vibe_gate_fail") return { reward: 0.2, weight: w ?? 2.0 };
  if (ev.signalSource === "quality_escalation" || ev.emptyReply) return { reward: 0.15, weight: w ?? 1.5 };
  if (ev.signalSource === "infra_fallback" || !ev.ok) return { reward: 0.25, weight: w ?? 0.5 };
  const toolPenalty = Math.min(0.35, (ev.toolParseErrorCount ?? 0) * 0.2);
  return { reward: Math.max(0.1, 1.0 - toolPenalty), weight: w ?? 1.0 };
}

function extractArchetypes(lower: string): TaskArchetype[] {
  const archetypes: TaskArchetype[] = [];
  if (/(写代码|代码|开发|编程|review|coding)/.test(lower)) archetypes.push("coding_and_review");
  if (/(长文|文档|报告|复盘|总结|阅读)/.test(lower)) archetypes.push("long_doc_synthesis");
  if (/(规划|方案|架构|决策|推理)/.test(lower)) archetypes.push("deep_reasoning_plan");
  if (/(闲聊|记一笔|记账|备忘|待办)/.test(lower)) archetypes.push("quick_chat_capture");
  if (/(工具|调度|耳麦)/.test(lower)) archetypes.push("tool_orchestration");
  if (/(看图|截图|视觉|桌面)/.test(lower)) archetypes.push("vision_gui");
  return archetypes;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findModelMatches(clauseLower: string, knownTargetIds: string[]): Array<{ targetId: string; pos: number }> {
  const sorted = [...knownTargetIds].sort((a, b) => b.length - a.length);
  const hits: Array<{ targetId: string; pos: number }> = [];
  for (const tid of sorted) {
    const bare = (tid.includes("/") ? tid.slice(tid.indexOf("/") + 1) : tid).toLowerCase();
    for (const token of [tid.toLowerCase(), bare]) {
      if (!token) continue;
      const re = new RegExp(`(?<![a-z0-9._/-])${escapeRegex(token)}(?![a-z0-9._/-])`, "i");
      const m = re.exec(clauseLower);
      if (m) {
        hits.push({ targetId: tid, pos: m.index });
        break;
      }
    }
  }
  return hits;
}

type ModelActionKind = "block" | "avoid" | "prefer" | "pin";

function detectActionForPosition(clauseLower: string, pos: number): ModelActionKind | null {
  const patterns: Array<[ModelActionKind, RegExp]> = [
    ["block", /(?:禁止|禁用|拉黑|别用|不要用|\b(?:block|never)\b)/g],
    ["avoid", /(?:少用|尽量不用|避开|\b(?:avoid|deprioritize)\b)/g],
    ["prefer", /(?:优先|首选|多用|\b(?:preferred|prefer)\b)/g],
    ["pin", /(?:固定|锁定|只用|\bpin\b)/g],
  ];
  const prefix = clauseLower.slice(0, pos);
  let best: { kind: ModelActionKind; end: number } | null = null;
  for (const [kind, re] of patterns) {
    for (const m of prefix.matchAll(re)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!best || end > best.end) best = { kind, end };
    }
  }
  if (best) return best.kind;
  for (const [kind, re] of patterns) {
    re.lastIndex = 0;
    if (re.test(clauseLower)) return kind;
  }
  return null;
}

/**
 * Persists time-decayed Bayesian routing experience and NL policy state
 * strictly under `<dataDir>/sugent-routing/` with atomic `0o600` writes.
 */
export class RoutingExperienceStore {
  private readonly expPath: string;
  private readonly policyPath: string;
  private readonly nowMs: () => number;
  private readonly halfLifeDays: number;
  private readonly priorStrength: number;
  private cells = new Map<string, ExperienceCell>();
  private recentDecisions: RecordedRouteDecision[] = [];
  private policy: RoutingPolicyState;

  constructor(opts: {
    dataDir: string;
    nowMs?: () => number;
    halfLifeDays?: number;
    priorStrength?: number;
  }) {
    const dir = path.join(opts.dataDir, "sugent-routing");
    this.expPath = path.join(dir, "routing-experience.json");
    this.policyPath = path.join(dir, "routing-policy.json");
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.halfLifeDays = opts.halfLifeDays ?? 14;
    this.priorStrength = opts.priorStrength ?? 5;
    this.policy = {
      version: 1,
      strategy: "balanced",
      mode: "auto",
      blockedModels: [],
      archetypeBoosts: {},
      rules: [],
      updatedAtIso: new Date(this.nowMs()).toISOString(),
    };
    this.load();
  }

  private decayFactor(elapsedMs: number): number {
    if (elapsedMs <= 0) return 1;
    const elapsedDays = elapsedMs / 86_400_000;
    return Math.exp((-Math.LN2 * elapsedDays) / this.halfLifeDays);
  }

  private load(): void {
    try {
      if (fs.existsSync(this.expPath)) {
        const parsed = JSON.parse(fs.readFileSync(this.expPath, "utf8")) as {
          cells?: ExperienceCell[];
          recentDecisions?: RecordedRouteDecision[];
        };
        for (const c of parsed.cells ?? []) {
          if (c?.key) this.cells.set(c.key, c);
        }
        this.recentDecisions = (parsed.recentDecisions ?? []).slice(0, 60);
      }
      if (fs.existsSync(this.policyPath)) {
        const p = JSON.parse(fs.readFileSync(this.policyPath, "utf8")) as Partial<RoutingPolicyState>;
        this.policy = {
          ...this.policy,
          ...p,
          version: 1,
          blockedModels: Array.isArray(p.blockedModels) ? p.blockedModels : [],
          archetypeBoosts: p.archetypeBoosts ?? {},
          rules: Array.isArray(p.rules) ? p.rules : [],
        };
      }
    } catch {
      // Ignore corrupt cache files and rebuild cleanly.
    }
  }

  private saveExp(): void {
    writeAtomic600(this.expPath, {
      version: 1,
      cells: Array.from(this.cells.values()),
      recentDecisions: this.recentDecisions.slice(0, 60),
    });
  }

  private savePolicy(): void {
    this.policy.updatedAtIso = new Date(this.nowMs()).toISOString();
    writeAtomic600(this.policyPath, this.policy);
  }

  recordOutcome(ev: RoutingOutcomeEvent): ExperienceCell {
    const atMs = ev.atMs ?? this.nowMs();
    const key = `${ev.archetype}::${ev.targetId}`;
    const prev = this.cells.get(key) ?? {
      key,
      archetype: ev.archetype,
      targetId: ev.targetId,
      effectiveSamples: 0,
      qualitySum: 0,
      successCount: 0,
      failureCount: 0,
      toolErrorCount: 0,
      escalationCount: 0,
      userCorrectionCount: 0,
      explicitRetryCount: 0,
      ewmaTtftMs: null,
      ewmaLatencyMs: null,
      ewmaCostUsd: 0,
      lastUsedAtMs: atMs,
      lastUpdatedAtMs: atMs,
    };
    const decay = this.decayFactor(atMs - prev.lastUpdatedAtMs);
    const { reward, weight } = resolveRewardAndWeight(ev);
    const next: ExperienceCell = {
      ...prev,
      effectiveSamples: prev.effectiveSamples * decay + weight,
      qualitySum: prev.qualitySum * decay + reward * weight,
      successCount: prev.successCount + (ev.ok ? 1 : 0),
      failureCount: prev.failureCount + (ev.ok ? 0 : 1),
      toolErrorCount: prev.toolErrorCount + (ev.toolParseErrorCount ?? 0),
      escalationCount:
        prev.escalationCount + (ev.escalated || ev.signalSource === "quality_escalation" ? 1 : 0),
      userCorrectionCount:
        prev.userCorrectionCount + (ev.signalSource === "user_correction" ? 1 : 0),
      explicitRetryCount:
        prev.explicitRetryCount + (ev.signalSource === "explicit_retry_stronger" ? 1 : 0),
      ewmaTtftMs:
        ev.ttftMs !== undefined
          ? prev.ewmaTtftMs === null
            ? ev.ttftMs
            : prev.ewmaTtftMs * 0.75 + ev.ttftMs * 0.25
          : prev.ewmaTtftMs,
      ewmaLatencyMs:
        ev.totalLatencyMs !== undefined
          ? prev.ewmaLatencyMs === null
            ? ev.totalLatencyMs
            : prev.ewmaLatencyMs * 0.75 + ev.totalLatencyMs * 0.25
          : prev.ewmaLatencyMs,
      ewmaCostUsd:
        ev.costUsd !== undefined ? prev.ewmaCostUsd * 0.75 + ev.costUsd * 0.25 : prev.ewmaCostUsd,
      lastUsedAtMs: Math.max(prev.lastUsedAtMs, atMs),
      lastUpdatedAtMs: Math.max(prev.lastUpdatedAtMs, atMs),
    };
    this.cells.set(key, next);
    this.saveExp();
    return { ...next };
  }

  getPosterior(
    archetype: TaskArchetype,
    targetId: string,
    priorQuality: number,
    atMs = this.nowMs(),
  ): PosteriorEstimate {
    const cell = this.cells.get(`${archetype}::${targetId}`);
    if (!cell) {
      return {
        posteriorQuality: priorQuality,
        effectiveSamples: 0,
        reliability: 1.0,
        ewmaTtftMs: null,
        ewmaLatencyMs: null,
      };
    }
    const decay = this.decayFactor(atMs - cell.lastUpdatedAtMs);
    const nEff = cell.effectiveSamples * decay;
    const sumEff = cell.qualitySum * decay;
    const posteriorQuality = (this.priorStrength * priorQuality + sumEff) / (this.priorStrength + nEff);
    const total = Math.max(1, cell.successCount + cell.failureCount);
    return {
      posteriorQuality,
      effectiveSamples: nEff,
      reliability: (3 + cell.successCount) / (3 + total),
      ewmaTtftMs: cell.ewmaTtftMs,
      ewmaLatencyMs: cell.ewmaLatencyMs,
    };
  }

  getTotalArchetypeSamples(archetype: TaskArchetype, atMs = this.nowMs()): number {
    let sum = 0;
    for (const c of this.cells.values()) {
      if (c.archetype === archetype) sum += c.effectiveSamples * this.decayFactor(atMs - c.lastUpdatedAtMs);
    }
    return sum;
  }

  recordDecision(rec: RecordedRouteDecision): void {
    this.recentDecisions.unshift(rec);
    if (this.recentDecisions.length > 60) this.recentDecisions.length = 60;
    this.saveExp();
  }

  updateDecisionOutcome(
    decisionId: string,
    patch: Partial<
      Pick<
        RecordedRouteDecision,
        "selectedTargetId" | "rawModelId" | "escalatedFrom" | "fallbackUsedFrom" | "reasonSummary"
      >
    >,
  ): void {
    const hit = this.recentDecisions.find((d) => d.decisionId === decisionId);
    if (hit) {
      Object.assign(hit, patch);
      this.saveExp();
    }
  }

  getRecentDecisions(limit = 20): RecordedRouteDecision[] {
    return this.recentDecisions.slice(0, limit);
  }

  getDecision(decisionId: string): RecordedRouteDecision | undefined {
    return this.recentDecisions.find((d) => d.decisionId === decisionId);
  }

  getLeaderboardByArchetype(atMs = this.nowMs()): Record<TaskArchetype, ArchetypeLeaderboardEntry[]> {
    const out = Object.fromEntries(
      TASK_ARCHETYPES.map((a) => [a, [] as ArchetypeLeaderboardEntry[]]),
    ) as Record<TaskArchetype, ArchetypeLeaderboardEntry[]>;
    for (const c of this.cells.values()) {
      const p = this.getPosterior(c.archetype, c.targetId, 0.75, atMs);
      out[c.archetype].push({
        targetId: c.targetId,
        posteriorQuality: Number(p.posteriorQuality.toFixed(3)),
        samples: Number(p.effectiveSamples.toFixed(1)),
        ewmaTtftMs: p.ewmaTtftMs !== null ? Math.round(p.ewmaTtftMs) : null,
      });
    }
    for (const a of TASK_ARCHETYPES) {
      out[a].sort((x, y) => y.posteriorQuality - x.posteriorQuality).splice(5);
    }
    return out;
  }

  getPolicy(): RoutingPolicyState {
    return {
      ...this.policy,
      blockedModels: [...this.policy.blockedModels],
      rules: [...this.policy.rules],
      archetypeBoosts: structuredClone(this.policy.archetypeBoosts),
    };
  }

  updatePolicy(patch: {
    strategy?: RoutingStrategyPreset;
    mode?: RoutingOperatingMode;
    pinnedModel?: string | null;
    blockedModels?: string[];
    unblockModel?: string;
    resetBoosts?: boolean;
  }): RoutingPolicyState {
    if (patch.strategy && VALID_STRATEGIES.has(patch.strategy)) this.policy.strategy = patch.strategy;
    if (patch.mode && VALID_MODES.has(patch.mode)) this.policy.mode = patch.mode;
    if (patch.pinnedModel !== undefined) {
      this.policy.pinnedModel = patch.pinnedModel ? patch.pinnedModel.trim() : undefined;
    }
    if (Array.isArray(patch.blockedModels)) {
      this.policy.blockedModels = Array.from(
        new Set(patch.blockedModels.map((x) => x.trim()).filter(Boolean)),
      );
    }
    if (patch.unblockModel) {
      this.policy.blockedModels = this.policy.blockedModels.filter((x) => x !== patch.unblockModel);
    }
    if (patch.resetBoosts) {
      this.policy.archetypeBoosts = {};
      this.policy.rules = [];
    }
    this.savePolicy();
    return this.getPolicy();
  }

  applyNaturalLanguageDirective(
    text: string,
    knownTargetIds: string[],
  ): { matched: boolean; summary: string; policy: RoutingPolicyState } {
    const raw = text.trim();
    const lower = raw.toLowerCase();
    const notes: string[] = [];
    const nowIso = new Date(this.nowMs()).toISOString();
    const globalScopes = extractArchetypes(lower);
    const defaultScopes = globalScopes.length > 0 ? globalScopes : [...TASK_ARCHETYPES];

    if (/(省配额|省钱|节流|quota_saver)/.test(lower)) {
      this.policy.strategy = "quota_saver";
      notes.push("切换策略为「省配额」");
    } else if (/(质量优先|旗舰优先|quality_first)/.test(lower)) {
      this.policy.strategy = "quality_first";
      notes.push("切换策略为「质量优先」");
    } else if (/(平衡策略|均衡策略|balanced)/.test(lower)) {
      this.policy.strategy = "balanced";
      notes.push("切换策略为「平衡」");
    }
    if (/(影子模式|仅观察|shadow)/.test(lower)) {
      this.policy.mode = "shadow";
      notes.push("切换为影子观察模式");
    } else if (/(自动模式|开启自动路由)/.test(lower)) {
      this.policy.mode = "auto";
      notes.push("切换为全自动路由");
    }

    const clauses = lower.split(/[,，;；。\n]+/).map((s) => s.trim()).filter(Boolean);
    for (const clause of clauses) {
      const clauseScopes = extractArchetypes(clause);
      const scopes = clauseScopes.length > 0 ? clauseScopes : defaultScopes;
      for (const { targetId: tid, pos } of findModelMatches(clause, knownTargetIds)) {
        const action = detectActionForPosition(clause, pos);
        if (action === "block") {
          if (!this.policy.blockedModels.includes(tid)) this.policy.blockedModels.push(tid);
          this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "block", createdAtIso: nowIso });
          notes.push(`已拉黑 ${tid}`);
        } else if (action === "avoid") {
          for (const a of scopes) {
            const cur = this.policy.archetypeBoosts[a]?.[tid] ?? 0;
            (this.policy.archetypeBoosts[a] ??= {})[tid] = Math.max(-0.35, cur - 0.18);
          }
          this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "avoid", createdAtIso: nowIso });
          notes.push(`在 ${scopes.join(",")} 中降低 ${tid} 权重`);
        } else if (action === "prefer") {
          for (const a of scopes) {
            const cur = this.policy.archetypeBoosts[a]?.[tid] ?? 0;
            (this.policy.archetypeBoosts[a] ??= {})[tid] = Math.min(0.35, cur + 0.18);
          }
          this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "prefer", createdAtIso: nowIso });
          notes.push(`在 ${scopes.join(",")} 中优先 ${tid}`);
        } else if (action === "pin") {
          this.policy.mode = "pinned";
          this.policy.pinnedModel = tid;
          this.policy.rules.push({ id: `rule-${crypto.randomBytes(3).toString("hex")}`, text: raw, kind: "pin", createdAtIso: nowIso });
          notes.push(`已锁定默认模型 ${tid}`);
        }
      }
    }
    if (notes.length > 0) this.savePolicy();
    return { matched: notes.length > 0, summary: notes.join("；"), policy: this.getPolicy() };
  }

  detectImplicitUserCorrection(
    prev: { userText: string; atMs: number },
    nextUserText: string,
    atMs = this.nowMs(),
  ): boolean {
    if (atMs - prev.atMs > 90_000 || atMs < prev.atMs) return false;
    if (
      /(不对|重来|重新来|没读全|乱说|换.*模型|太水|不行|漏了|不是这个|答非所问|try again|wrong|incomplete)/i.test(
        nextUserText,
      )
    ) {
      return true;
    }
    const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}]/gu, "");
    const a = norm(prev.userText);
    const b = norm(nextUserText);
    if (a.length < 4 || b.length < 4) return false;
    const bigrams = (s: string) =>
      new Set(Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2)));
    const sa = bigrams(a);
    const sb = bigrams(b);
    let inter = 0;
    for (const g of sa) if (sb.has(g)) inter += 1;
    return inter / Math.max(1, sa.size + sb.size - inter) >= 0.65;
  }
}
