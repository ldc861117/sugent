/**
 * 五维生命账本底座（Stewardship Ledger）
 * 统一承载关系信任阶梯、目标北极星、价值红线、双向承诺事项与个人数字资源，
 * 并在底层实施公私分区物理隔离与 SugentKnowledgeGraph 时效排他演化同步。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { looksSecret } from "../agent/memory.js";
import { shouldSuggestRulePromotion } from "./kernel.js";
import type { KGDelta, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { BotBudgetStatus, LocalBudgetLedger } from "./local-budget.js";

export const MAX_ACTIVE_GOALS = 3;
export const TRUST_PROMOTE_THRESHOLD = 3;

export type StewardshipErrorCode =
  | "GOAL_CAP_EXCEEDED"
  | "TRUST_PROMOTION_DENIED"
  | "ENTITY_NOT_FOUND"
  | "SECRET_REJECTED"
  | "INVALID_INPUT";

export class StewardshipLedgerError extends Error {
  readonly code: StewardshipErrorCode;

  constructor(code: StewardshipErrorCode, message: string) {
    super(message);
    this.name = "StewardshipLedgerError";
    this.code = code;
  }
}

export type ContextPartition = "personal_life" | "work_project" | "cowork_shared";
export type CallerAccessDomain = "owner_private" | "work_project" | "cowork_shared";
export type TrustTier =
  | "L0_record_only"
  | "L1_whisper_prompt"
  | "L2_suspend_approval"
  | "L3_shadow_autonomous";

export interface RelationshipProfile {
  id: string;
  partition: ContextPartition;
  subjectType: "owner_trust" | "key_contact";
  name: string;
  roleTag: string;
  trustTier: TrustTier;
  verifiedObservations: number;
  taboos: string[];
  preferences: string[];
  openFavors: string[];
  updatedAt: string;
}

export interface GoalNorthStar {
  id: string;
  partition: ContextPartition;
  title: string;
  northStarCriterion: string;
  status: "active" | "paused" | "achieved" | "superseded";
  targetDateIso?: string;
  lastProgressAt: string;
  stallThresholdDays: number;
}

export interface ValueGuardrail {
  id: string;
  partition: ContextPartition;
  kind: "hard_redline" | "tombstone" | "soft_taste";
  statement: string;
  enforcement: "block_and_alert" | "warn_before_send" | "style_hint";
  evidenceSource?: string;
  createdAt: string;
}

export interface CommitmentItem {
  id: string;
  partition: ContextPartition;
  direction: "i_owe" | "waiting_for" | "expiring";
  status: "open" | "snoozed" | "waiting_review" | "closed" | "superseded";
  summary: string;
  counterpartyOrRef: string;
  dueAt?: string;
  remindLeadDays?: number;
  updatedAt: string;
}

export interface ResourceEntry {
  id: string;
  partition: ContextPartition;
  kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
  title: string;
  localUriOrPath?: string;
  expiresAt?: string;
  metadata: Record<string, string | number | boolean>;
}

export interface LedgerSnapshot {
  version: 1;
  updatedAt: string;
  relationships: RelationshipProfile[];
  goals: GoalNorthStar[];
  guardrails: ValueGuardrail[];
  commitments: CommitmentItem[];
  resources: ResourceEntry[];
}

export interface LedgerQueryResult {
  relationships: RelationshipProfile[];
  goals: GoalNorthStar[];
  guardrails: ValueGuardrail[];
  commitments: CommitmentItem[];
  resources: ResourceEntry[];
  budgetStatus?: BotBudgetStatus;
}

export interface StewardshipLedgerOptions {
  dataDir: string;
  knowledgeGraph?: SugentKnowledgeGraph;
  budgetLedger?: LocalBudgetLedger;
  defaultBotId?: string;
}

export interface UpsertRelationshipInput {
  id?: string;
  partition: ContextPartition;
  subjectType?: "owner_trust" | "key_contact";
  name: string;
  roleTag?: string;
  trustTier?: TrustTier;
  verifiedObservations?: number;
  taboos?: string[];
  preferences?: string[];
  openFavors?: string[];
  ownerConfirmed?: boolean;
}

export interface UpsertGoalInput {
  id?: string;
  partition: ContextPartition;
  title: string;
  northStarCriterion: string;
  status?: GoalNorthStar["status"];
  targetDateIso?: string;
  lastProgressAt?: string;
  stallThresholdDays?: number;
}

export interface UpsertGoalOptions {
  supersedeGoalId?: string;
  makePrimaryInPartition?: boolean;
  nowIso?: string;
}

export interface AddGuardrailInput {
  id?: string;
  partition: ContextPartition;
  kind: ValueGuardrail["kind"];
  statement: string;
  enforcement?: ValueGuardrail["enforcement"];
  evidenceSource?: string;
}

export interface UpsertCommitmentInput {
  id?: string;
  partition: ContextPartition;
  direction: CommitmentItem["direction"];
  status?: CommitmentItem["status"];
  summary: string;
  counterpartyOrRef: string;
  dueAt?: string;
  remindLeadDays?: number;
}

export interface UpsertResourceInput {
  id?: string;
  partition: ContextPartition;
  kind: ResourceEntry["kind"];
  title: string;
  localUriOrPath?: string;
  expiresAt?: string;
  metadata?: Record<string, string | number | boolean>;
}

const VALID_PARTITIONS = new Set<ContextPartition>(["personal_life", "work_project", "cowork_shared"]);
const VALID_DOMAINS = new Set<CallerAccessDomain>(["owner_private", "work_project", "cowork_shared"]);
const VALID_TIERS = new Set<TrustTier>(["L0_record_only", "L1_whisper_prompt", "L2_suspend_approval", "L3_shadow_autonomous"]);
const VALID_GOAL_STATUSES = new Set<GoalNorthStar["status"]>(["active", "paused", "achieved", "superseded"]);
const VALID_GUARD_KINDS = new Set<ValueGuardrail["kind"]>(["hard_redline", "tombstone", "soft_taste"]);
const VALID_ENFORCEMENTS = new Set<ValueGuardrail["enforcement"]>(["block_and_alert", "warn_before_send", "style_hint"]);
const VALID_COMMIT_DIRS = new Set<CommitmentItem["direction"]>(["i_owe", "waiting_for", "expiring"]);
const VALID_COMMIT_STATUSES = new Set<CommitmentItem["status"]>(["open", "snoozed", "waiting_review", "closed", "superseded"]);
const VALID_RES_KINDS = new Set<ResourceEntry["kind"]>(["time_window", "personal_archive", "budget_cap", "specialist_agent"]);

function assertChoice<T extends string>(value: unknown, valid: ReadonlySet<T>, label: string): asserts value is T {
  if (typeof value !== "string" || !valid.has(value as T)) {
    throw new StewardshipLedgerError("INVALID_INPUT", `Invalid ${label}: ${String(value)}`);
  }
}

function assertNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StewardshipLedgerError("INVALID_INPUT", `${label} cannot be empty.`);
  }
  return value.trim();
}

function assertNoSecrets(texts: Array<string | undefined>, context: string): void {
  for (const text of texts) {
    if (typeof text === "string" && text.trim() && looksSecret(text)) {
      throw new StewardshipLedgerError("SECRET_REJECTED", `Refused secret-like content in ${context}.`);
    }
  }
}

function normalizeList(input: string[] | undefined, fallback: string[] = []): string[] {
  if (input === undefined) return [...fallback];
  return input.map((item) => String(item).trim()).filter(Boolean);
}

function sanitizeMetadata(meta?: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!meta) return out;
  for (const [k, v] of Object.entries(meta)) {
    const cleanKey = k.trim();
    if (!cleanKey) continue;
    if (typeof v === "string") {
      assertNoSecrets([v], `resource.metadata.${cleanKey}`);
      out[cleanKey] = v;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[cleanKey] = v;
    }
  }
  return out;
}

function makeId(prefix: string, explicitId?: string): string {
  const clean = explicitId?.trim();
  return clean || `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function allowedPartitions(domain: CallerAccessDomain): Set<ContextPartition> {
  assertChoice(domain, VALID_DOMAINS, "callerDomain");
  if (domain === "owner_private") return new Set(["personal_life", "work_project", "cowork_shared"]);
  if (domain === "work_project") return new Set(["work_project", "cowork_shared"]);
  return new Set(["cowork_shared"]);
}

function extractSearchTerms(query: string): string[] {
  const rawLower = query.toLowerCase().trim();
  if (!rawLower) return [];
  const terms = new Set<string>();
  const tokens = rawLower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’]+/).filter(Boolean);
  for (const tok of tokens) {
    for (const m of tok.match(/[a-z0-9_-]{2,}/g) ?? []) terms.add(m);
    const cjkClean = tok.replace(
      /(请问|帮我查一下|帮我查|查一下|找一下|看一下|一下|什么情况|是什么|怎么|情况|目前|现在|关于|能不能|可以|帮我|的|了|吗|呢|啊|吧)/g,
      " ",
    );
    for (const seg of cjkClean.split(/\s+/).filter(Boolean)) {
      const chars = Array.from(seg).filter((ch) => /\p{Script=Han}/u.test(ch));
      if (chars.length === 1) terms.add(chars[0]!);
      for (let i = 0; i + 1 < chars.length; i++) terms.add(chars[i]! + chars[i + 1]!);
    }
    if (terms.size === 0 && tok) terms.add(tok);
  }
  return Array.from(terms);
}

function scoreAndFilter<T>(items: T[], terms: string[], toHaystack: (item: T) => string): T[] {
  return items
    .map((item) => {
      const hay = toHaystack(item).toLowerCase();
      const score = terms.reduce((acc, term) => (hay.includes(term) ? acc + (term.length >= 2 ? 2 : 1) : acc), 0);
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

function parseTrustDirective(directiveText: string): TrustTier {
  if (/\bL0\b|L0_record_only/i.test(directiveText)) return "L0_record_only";
  if (/\bL1\b|L1_whisper_prompt/i.test(directiveText)) return "L1_whisper_prompt";
  if (/\bL2\b|L2_suspend_approval/i.test(directiveText)) return "L2_suspend_approval";
  if (/只记|不评|别评|静默记录/.test(directiveText)) return "L0_record_only";
  if (/提词|耳麦/.test(directiveText)) return "L1_whisper_prompt";
  if (/待批|挂起|暂停自动/.test(directiveText)) return "L2_suspend_approval";
  throw new StewardshipLedgerError("INVALID_INPUT", `Unrecognized owner trust directive: ${directiveText}`);
}

function defaultEnforcement(kind: ValueGuardrail["kind"]): ValueGuardrail["enforcement"] {
  if (kind === "hard_redline") return "block_and_alert";
  if (kind === "tombstone") return "warn_before_send";
  return "style_hint";
}

function cloneRelationship(r: RelationshipProfile): RelationshipProfile {
  return { ...r, taboos: [...r.taboos], preferences: [...r.preferences], openFavors: [...r.openFavors] };
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writeAtomicJson600(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  ensurePrivateDir(dir);
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup error */
    }
    throw err;
  }
}

function appendJournal600(journalPath: string, event: Record<string, unknown>): void {
  ensurePrivateDir(path.dirname(journalPath));
  fs.appendFileSync(journalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(journalPath, 0o600);
}

/**
 * 五维生命账本管理类：提供关系信任演化、主目标并发上限门控、价值红线、承诺闭环与资源检索。
 */
export class StewardshipLedger {
  private readonly storeDir: string;
  private readonly ledgerPath: string;
  private readonly journalPath: string;
  private readonly knowledgeGraph?: SugentKnowledgeGraph;
  private readonly budgetLedger?: LocalBudgetLedger;
  private readonly defaultBotId: string;
  private updatedAt = new Date(0).toISOString();
  private readonly relationships = new Map<string, RelationshipProfile>();
  private readonly goals = new Map<string, GoalNorthStar>();
  private readonly guardrails = new Map<string, ValueGuardrail>();
  private readonly commitments = new Map<string, CommitmentItem>();
  private readonly resources = new Map<string, ResourceEntry>();

  constructor(options: string | StewardshipLedgerOptions) {
    const opts = typeof options === "string" ? { dataDir: options } : options;
    const cleanDataDir = assertNonEmpty(opts.dataDir, "dataDir");
    this.storeDir = path.join(cleanDataDir, "sugent-stewardship");
    this.ledgerPath = path.join(this.storeDir, "ledger.json");
    this.journalPath = path.join(this.storeDir, "ledger-journal.jsonl");
    this.knowledgeGraph = opts.knowledgeGraph;
    this.budgetLedger = opts.budgetLedger;
    this.defaultBotId = opts.defaultBotId?.trim() || "default";
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.ledgerPath)) return;
    const raw = fs.readFileSync(this.ledgerPath, "utf8").trim();
    if (!raw) return;
    const parsed = JSON.parse(raw) as Partial<LedgerSnapshot>;
    if (typeof parsed.updatedAt === "string") this.updatedAt = parsed.updatedAt;
    for (const r of parsed.relationships ?? []) if (r?.id) this.relationships.set(r.id, r);
    for (const g of parsed.goals ?? []) if (g?.id) this.goals.set(g.id, g);
    for (const v of parsed.guardrails ?? []) if (v?.id) this.guardrails.set(v.id, v);
    for (const c of parsed.commitments ?? []) if (c?.id) this.commitments.set(c.id, c);
    for (const r of parsed.resources ?? []) if (r?.id) this.resources.set(r.id, r);
  }

  private persist(nowIso: string, journalEvent: Record<string, unknown>, delta?: KGDelta): void {
    this.updatedAt = nowIso;
    const snapshot: LedgerSnapshot = {
      version: 1,
      updatedAt: this.updatedAt,
      relationships: Array.from(this.relationships.values()),
      goals: Array.from(this.goals.values()),
      guardrails: Array.from(this.guardrails.values()),
      commitments: Array.from(this.commitments.values()),
      resources: Array.from(this.resources.values()),
    };
    writeAtomicJson600(this.ledgerPath, snapshot);
    appendJournal600(this.journalPath, { at: nowIso, ...journalEvent });
    if (delta && this.knowledgeGraph) {
      this.knowledgeGraph.applyDelta(delta, nowIso);
    }
  }

  private buildRelationshipDelta(profile: RelationshipProfile): KGDelta {
    return {
      nodes: [
        {
          id: `rel:${profile.id}`,
          kind: "person",
          name: profile.name,
          summary: `${profile.roleTag} (${profile.partition}) [${profile.trustTier}]`,
          tags: ["ledger:relationship", `partition:${profile.partition}`, profile.subjectType],
        },
        {
          id: `tier:${profile.trustTier}`,
          kind: "concept",
          name: profile.trustTier,
          summary: `Stewardship trust tier ${profile.trustTier}`,
          tags: ["ledger:trust_tier"],
        },
      ],
      edges: [
        {
          from: `rel:${profile.id}`,
          relation: "has_trust_tier",
          to: `tier:${profile.trustTier}`,
          source: "stewardship_ledger",
          exclusive: true,
        },
      ],
    };
  }

  /** 新增或更新关系画像，默认保持 L0 观察阶梯并严格守卫 L3 晋升门槛。 */
  upsertRelationship(input: UpsertRelationshipInput, nowIso = new Date().toISOString()): RelationshipProfile {
    assertChoice(input.partition, VALID_PARTITIONS, "partition");
    const name = assertNonEmpty(input.name, "relationship.name");
    const roleTag = (input.roleTag ?? "").trim();
    assertNoSecrets([name, roleTag, ...(input.taboos ?? []), ...(input.preferences ?? []), ...(input.openFavors ?? [])], "relationship");

    const id = makeId("rel", input.id);
    const existing = this.relationships.get(id);
    const subjectType = input.subjectType ?? existing?.subjectType ?? "key_contact";
    if (subjectType !== "owner_trust" && subjectType !== "key_contact") {
      throw new StewardshipLedgerError("INVALID_INPUT", `Invalid subjectType: ${String(subjectType)}`);
    }
    const obsInput = input.verifiedObservations;
    if (obsInput !== undefined && (!Number.isFinite(obsInput) || obsInput < 0)) {
      throw new StewardshipLedgerError("INVALID_INPUT", "verifiedObservations must be a non-negative number.");
    }
    const verifiedObservations = obsInput !== undefined ? Math.trunc(obsInput) : (existing?.verifiedObservations ?? 0);
    const trustTier = input.trustTier ?? existing?.trustTier ?? "L0_record_only";
    assertChoice(trustTier, VALID_TIERS, "trustTier");
    if (input.trustTier === "L3_shadow_autonomous" && (verifiedObservations < TRUST_PROMOTE_THRESHOLD || input.ownerConfirmed !== true)) {
      throw new StewardshipLedgerError("TRUST_PROMOTION_DENIED", "Direct L3 assignment requires >= 3 observations and ownerConfirmed=true.");
    }
    const profile: RelationshipProfile = {
      id,
      partition: input.partition,
      subjectType,
      name,
      roleTag: roleTag || existing?.roleTag || "contact",
      trustTier,
      verifiedObservations,
      taboos: normalizeList(input.taboos, existing?.taboos),
      preferences: normalizeList(input.preferences, existing?.preferences),
      openFavors: normalizeList(input.openFavors, existing?.openFavors),
      updatedAt: nowIso,
    };
    this.relationships.set(id, profile);
    this.persist(nowIso, { op: "upsert_relationship", id, trustTier }, this.buildRelationshipDelta(profile));
    return cloneRelationship(profile);
  }

  /** 累加一次有效观察并借由内核规则判断是否达到建议晋升 L3 的阈值。 */
  recordVerifiedObservation(id: string, nowIso = new Date().toISOString()): { profile: RelationshipProfile; canSuggestPromotion: boolean } {
    const existing = this.relationships.get(assertNonEmpty(id, "relationship.id"));
    if (!existing) throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Relationship not found: ${id}`);
    const updated: RelationshipProfile = {
      ...existing,
      verifiedObservations: existing.verifiedObservations + 1,
      updatedAt: nowIso,
    };
    this.relationships.set(updated.id, updated);
    this.persist(nowIso, { op: "record_observation", id: updated.id, verifiedObservations: updated.verifiedObservations });
    const canSuggestPromotion = shouldSuggestRulePromotion({
      id: updated.id,
      title: updated.name,
      sourceKind: "im_channel",
      mode: updated.trustTier === "L3_shadow_autonomous" ? "act" : "observe",
      verifiedObservations: updated.verifiedObservations,
      suggestPromoteAfter: TRUST_PROMOTE_THRESHOLD,
    });
    return {
      profile: cloneRelationship(updated),
      canSuggestPromotion,
    };
  }

  /** 晋升信任等级，升至 L3 时强校验观察次数 >= 3 且主人显式确认。 */
  promoteTrustTier(
    id: string,
    targetTier: TrustTier,
    options: { ownerConfirmed?: boolean; nowIso?: string } = {},
  ): RelationshipProfile {
    assertChoice(targetTier, VALID_TIERS, "targetTier");
    const existing = this.relationships.get(assertNonEmpty(id, "relationship.id"));
    if (!existing) throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Relationship not found: ${id}`);
    if (targetTier === "L3_shadow_autonomous" && (existing.verifiedObservations < TRUST_PROMOTE_THRESHOLD || options.ownerConfirmed !== true)) {
      throw new StewardshipLedgerError("TRUST_PROMOTION_DENIED", "L3 promotion requires >= 3 verified observations and ownerConfirmed=true.");
    }
    const nowIso = options.nowIso ?? new Date().toISOString();
    const updated: RelationshipProfile = { ...existing, trustTier: targetTier, updatedAt: nowIso };
    this.relationships.set(updated.id, updated);
    this.persist(nowIso, { op: "promote_trust_tier", id: updated.id, targetTier }, this.buildRelationshipDelta(updated));
    return cloneRelationship(updated);
  }

  /** 将指定关系档案降级至保守阶梯，并更新知识图谱排他边。 */
  downgradeTrustTier(
    id: string,
    targetTier: TrustTier = "L1_whisper_prompt",
    reason?: string,
    nowIso = new Date().toISOString(),
  ): RelationshipProfile {
    assertChoice(targetTier, VALID_TIERS, "targetTier");
    if (targetTier === "L3_shadow_autonomous") {
      throw new StewardshipLedgerError("INVALID_INPUT", "Cannot downgrade trust tier to L3_shadow_autonomous.");
    }
    assertNoSecrets([reason], "downgrade.reason");
    const existing = this.relationships.get(assertNonEmpty(id, "relationship.id"));
    if (!existing) throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Relationship not found: ${id}`);
    const updated: RelationshipProfile = { ...existing, trustTier: targetTier, updatedAt: nowIso };
    this.relationships.set(updated.id, updated);
    this.persist(
      nowIso,
      { op: "downgrade_trust_tier", id: updated.id, targetTier, ...(reason ? { reason: reason.trim() } : {}) },
      this.buildRelationshipDelta(updated),
    );
    return cloneRelationship(updated);
  }

  /** 解析主人自然语言降级口令（只记/提词/待批/L0-L2）并即时切换信任等级。 */
  applyOwnerTrustDirective(id: string, directiveText: string, nowIso = new Date().toISOString()): RelationshipProfile {
    const clean = assertNonEmpty(directiveText, "directiveText");
    assertNoSecrets([clean], "trustDirective");
    const targetTier = parseTrustDirective(clean);
    return this.downgradeTrustTier(id, targetTier, clean, nowIso);
  }

  private appendGoalDelta(delta: KGDelta, goal: GoalNorthStar, makePrimary: boolean): void {
    delta.nodes = delta.nodes ?? [];
    delta.edges = delta.edges ?? [];
    delta.nodes.push(
      {
        id: `goal:${goal.id}`,
        kind: "concept",
        name: goal.title,
        summary: `${goal.northStarCriterion} [${goal.status}]`,
        tags: ["ledger:goal", `partition:${goal.partition}`, goal.status],
      },
      {
        id: `goal_status:${goal.status}`,
        kind: "concept",
        name: goal.status,
        summary: `Goal lifecycle status ${goal.status}`,
        tags: ["ledger:goal_status"],
      },
    );
    delta.edges.push({
      from: `goal:${goal.id}`,
      relation: "has_goal_status",
      to: `goal_status:${goal.status}`,
      source: "stewardship_ledger",
      exclusive: true,
    });
    if (makePrimary) {
      delta.nodes.push({
        id: `partition:${goal.partition}`,
        kind: "concept",
        name: goal.partition,
        summary: `Stewardship context partition ${goal.partition}`,
        tags: ["ledger:partition"],
      });
      delta.edges.push({
        from: `partition:${goal.partition}`,
        relation: "primary_focus",
        to: `goal:${goal.id}`,
        source: "stewardship_ledger",
        exclusive: true,
      });
    }
  }

  /** 新增或更新北极星目标，强制守卫活跃目标并发上限 <= 3，并同步排他状态与主焦点边。 */
  upsertGoal(input: UpsertGoalInput, options: UpsertGoalOptions = {}): GoalNorthStar {
    assertChoice(input.partition, VALID_PARTITIONS, "partition");
    const title = assertNonEmpty(input.title, "goal.title");
    const northStarCriterion = assertNonEmpty(input.northStarCriterion, "goal.northStarCriterion");
    assertNoSecrets([title, northStarCriterion, input.targetDateIso], "goal");

    const id = makeId("goal", input.id);
    const existing = this.goals.get(id);
    const status = input.status ?? existing?.status ?? "active";
    assertChoice(status, VALID_GOAL_STATUSES, "goal.status");
    const stallThresholdDays = input.stallThresholdDays ?? existing?.stallThresholdDays ?? 7;
    if (!Number.isFinite(stallThresholdDays) || stallThresholdDays < 0) {
      throw new StewardshipLedgerError("INVALID_INPUT", "stallThresholdDays must be a non-negative number.");
    }

    const supId = options.supersedeGoalId?.trim();
    if (supId && supId === id) {
      throw new StewardshipLedgerError("INVALID_INPUT", "supersedeGoalId cannot match target goal id.");
    }
    const supTarget = supId ? this.goals.get(supId) : undefined;
    if (supId && !supTarget) {
      throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Goal to supersede not found: ${supId}`);
    }

    if (status === "active") {
      const otherActive = Array.from(this.goals.values()).filter(
        (g) => g.status === "active" && g.id !== id && g.id !== supId,
      ).length;
      if (otherActive >= MAX_ACTIVE_GOALS) {
        throw new StewardshipLedgerError("GOAL_CAP_EXCEEDED", `Active goals capped at ${MAX_ACTIVE_GOALS}.`);
      }
    }

    const nowIso = options.nowIso ?? new Date().toISOString();
    const delta: KGDelta = { nodes: [], edges: [] };
    if (supTarget) {
      const superseded: GoalNorthStar = { ...supTarget, status: "superseded" };
      this.goals.set(superseded.id, superseded);
      this.appendGoalDelta(delta, superseded, false);
    }

    const targetDateIso = input.targetDateIso !== undefined ? input.targetDateIso.trim() || undefined : existing?.targetDateIso;
    const goal: GoalNorthStar = {
      id,
      partition: input.partition,
      title,
      northStarCriterion,
      status,
      ...(targetDateIso ? { targetDateIso } : {}),
      lastProgressAt: input.lastProgressAt?.trim() || existing?.lastProgressAt || nowIso,
      stallThresholdDays: Math.trunc(stallThresholdDays),
    };
    this.goals.set(id, goal);
    this.appendGoalDelta(delta, goal, Boolean(supTarget || options.makePrimaryInPartition));
    this.persist(nowIso, { op: "upsert_goal", id, status, ...(supId ? { supersededGoalId: supId } : {}) }, delta);
    return { ...goal };
  }

  /** 更新既有目标状态（重新激活时同样检查并发上限 <= 3）。 */
  updateGoalStatus(id: string, status: GoalNorthStar["status"], nowIso = new Date().toISOString()): GoalNorthStar {
    assertChoice(status, VALID_GOAL_STATUSES, "goal.status");
    const existing = this.goals.get(assertNonEmpty(id, "goal.id"));
    if (!existing) throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Goal not found: ${id}`);
    if (status === "active" && existing.status !== "active") {
      const otherActive = Array.from(this.goals.values()).filter((g) => g.status === "active" && g.id !== existing.id).length;
      if (otherActive >= MAX_ACTIVE_GOALS) {
        throw new StewardshipLedgerError("GOAL_CAP_EXCEEDED", `Active goals capped at ${MAX_ACTIVE_GOALS}.`);
      }
    }
    const updated: GoalNorthStar = { ...existing, status };
    this.goals.set(updated.id, updated);
    const delta: KGDelta = { nodes: [], edges: [] };
    this.appendGoalDelta(delta, updated, false);
    this.persist(nowIso, { op: "update_goal_status", id: updated.id, status }, delta);
    return { ...updated };
  }

  /** 添加价值护栏（硬红线 / 证伪墓碑 / 软品味）并同步为知识图谱 preference 节点。 */
  addGuardrail(input: AddGuardrailInput, nowIso = new Date().toISOString()): ValueGuardrail {
    assertChoice(input.partition, VALID_PARTITIONS, "partition");
    assertChoice(input.kind, VALID_GUARD_KINDS, "guardrail.kind");
    const statement = assertNonEmpty(input.statement, "guardrail.statement");
    const enforcement = input.enforcement ?? defaultEnforcement(input.kind);
    assertChoice(enforcement, VALID_ENFORCEMENTS, "guardrail.enforcement");
    const evidenceSource = input.evidenceSource?.trim() || undefined;
    assertNoSecrets([statement, evidenceSource], "guardrail");

    const id = makeId("guard", input.id);
    const existing = this.guardrails.get(id);
    const guardrail: ValueGuardrail = {
      id,
      partition: input.partition,
      kind: input.kind,
      statement,
      enforcement,
      ...(evidenceSource ? { evidenceSource } : {}),
      createdAt: existing?.createdAt ?? nowIso,
    };
    this.guardrails.set(id, guardrail);
    const delta: KGDelta = {
      nodes: [
        {
          id: `guard:${id}`,
          kind: "preference",
          name: `[${guardrail.kind}] ${statement.slice(0, 36)}`,
          summary: statement,
          tags: ["ledger:guardrail", guardrail.kind, guardrail.enforcement, `partition:${guardrail.partition}`],
        },
      ],
    };
    this.persist(nowIso, { op: "add_guardrail", id, kind: guardrail.kind }, delta);
    return { ...guardrail };
  }

  private buildCommitmentDelta(item: CommitmentItem): KGDelta {
    const edges = this.relationships.has(item.counterpartyOrRef)
      ? [{ from: `commit:${item.id}`, relation: "with_contact", to: `rel:${item.counterpartyOrRef}`, source: "stewardship_ledger" }]
      : [];
    return {
      nodes: [
        {
          id: `commit:${item.id}`,
          kind: "concept",
          name: item.summary.slice(0, 48),
          summary: `[${item.direction}/${item.status}] ${item.summary} (${item.counterpartyOrRef})`,
          tags: ["ledger:commitment", item.direction, item.status, `partition:${item.partition}`],
        },
      ],
      edges,
    };
  }

  /** 新增或更新未闭合承诺事项（I Owe / Waiting For / Expiring）。 */
  upsertCommitment(input: UpsertCommitmentInput, nowIso = new Date().toISOString()): CommitmentItem {
    assertChoice(input.partition, VALID_PARTITIONS, "partition");
    assertChoice(input.direction, VALID_COMMIT_DIRS, "commitment.direction");
    const summary = assertNonEmpty(input.summary, "commitment.summary");
    const counterpartyOrRef = assertNonEmpty(input.counterpartyOrRef, "commitment.counterpartyOrRef");
    assertNoSecrets([summary, counterpartyOrRef, input.dueAt], "commitment");

    const id = makeId("commit", input.id);
    const existing = this.commitments.get(id);
    const status = input.status ?? existing?.status ?? "open";
    assertChoice(status, VALID_COMMIT_STATUSES, "commitment.status");
    const remindLeadDays = input.remindLeadDays ?? existing?.remindLeadDays;
    if (remindLeadDays !== undefined && (!Number.isFinite(remindLeadDays) || remindLeadDays < 0)) {
      throw new StewardshipLedgerError("INVALID_INPUT", "remindLeadDays must be a non-negative number.");
    }
    const dueAt = input.dueAt !== undefined ? input.dueAt.trim() || undefined : existing?.dueAt;
    const item: CommitmentItem = {
      id,
      partition: input.partition,
      direction: input.direction,
      status,
      summary,
      counterpartyOrRef,
      ...(dueAt ? { dueAt } : {}),
      ...(remindLeadDays !== undefined ? { remindLeadDays: Math.trunc(remindLeadDays) } : {}),
      updatedAt: nowIso,
    };
    this.commitments.set(id, item);
    this.persist(nowIso, { op: "upsert_commitment", id, direction: item.direction, status }, this.buildCommitmentDelta(item));
    return { ...item };
  }

  /** 更新承诺事项状态并同步知识图谱。 */
  updateCommitmentStatus(
    id: string,
    status: CommitmentItem["status"],
    nowIso = new Date().toISOString(),
  ): CommitmentItem {
    assertChoice(status, VALID_COMMIT_STATUSES, "commitment.status");
    const existing = this.commitments.get(assertNonEmpty(id, "commitment.id"));
    if (!existing) throw new StewardshipLedgerError("ENTITY_NOT_FOUND", `Commitment not found: ${id}`);
    const updated: CommitmentItem = { ...existing, status, updatedAt: nowIso };
    this.commitments.set(updated.id, updated);
    this.persist(nowIso, { op: "update_commitment_status", id: updated.id, status }, this.buildCommitmentDelta(updated));
    return { ...updated };
  }

  /** 新增或更新个人数字资源条目（同步知识图谱时绝不将本地路径写入公开摘要）。 */
  upsertResource(input: UpsertResourceInput, nowIso = new Date().toISOString()): ResourceEntry {
    assertChoice(input.partition, VALID_PARTITIONS, "partition");
    assertChoice(input.kind, VALID_RES_KINDS, "resource.kind");
    const title = assertNonEmpty(input.title, "resource.title");
    assertNoSecrets([title, input.expiresAt], "resource");

    const id = makeId("res", input.id);
    const existing = this.resources.get(id);
    const localUriOrPath =
      input.localUriOrPath !== undefined ? input.localUriOrPath.trim() || undefined : existing?.localUriOrPath;
    const expiresAt = input.expiresAt !== undefined ? input.expiresAt.trim() || undefined : existing?.expiresAt;
    const metadata = input.metadata !== undefined ? sanitizeMetadata(input.metadata) : { ...(existing?.metadata ?? {}) };
    const entry: ResourceEntry = {
      id,
      partition: input.partition,
      kind: input.kind,
      title,
      ...(localUriOrPath ? { localUriOrPath } : {}),
      ...(expiresAt ? { expiresAt } : {}),
      metadata,
    };
    this.resources.set(id, entry);
    const delta: KGDelta = {
      nodes: [
        {
          id: `res:${id}`,
          kind: entry.kind === "specialist_agent" ? "tool" : "concept",
          name: entry.title,
          summary: `[${entry.kind}] ${entry.title}${entry.expiresAt ? ` (expires: ${entry.expiresAt})` : ""}`,
          tags: ["ledger:resource", entry.kind, `partition:${entry.partition}`],
        },
      ],
    };
    this.persist(nowIso, { op: "upsert_resource", id, kind: entry.kind }, delta);
    return { ...entry, metadata: { ...entry.metadata } };
  }

  /** 在调用域允许的分区内检索个人数字档案（personal_archive）。 */
  findArchiveResources(query: string, callerDomain: CallerAccessDomain = "owner_private"): ResourceEntry[] {
    const archives = this.snapshotForCaller(callerDomain).resources.filter((r) => r.kind === "personal_archive");
    const terms = extractSearchTerms(query);
    if (!terms.length) return archives;
    return scoreAndFilter(
      archives,
      terms,
      (r) =>
        `${r.id} ${r.title} ${r.localUriOrPath ?? ""} ${Object.entries(r.metadata)
          .map(([k, v]) => `${k} ${v}`)
          .join(" ")}`,
    );
  }

  /** 按调用方访问域实施物理分区隔离，返回只含授权分区的只读快照。 */
  snapshotForCaller(callerDomain: CallerAccessDomain = "owner_private"): LedgerSnapshot {
    const allowed = allowedPartitions(callerDomain);
    return {
      version: 1,
      updatedAt: this.updatedAt,
      relationships: Array.from(this.relationships.values())
        .filter((r) => allowed.has(r.partition))
        .map(cloneRelationship),
      goals: Array.from(this.goals.values())
        .filter((g) => allowed.has(g.partition))
        .map((g) => ({ ...g })),
      guardrails: Array.from(this.guardrails.values())
        .filter((v) => allowed.has(v.partition))
        .map((v) => ({ ...v })),
      commitments: Array.from(this.commitments.values())
        .filter((c) => allowed.has(c.partition))
        .map((c) => ({ ...c })),
      resources: Array.from(this.resources.values())
        .filter((res) => allowed.has(res.partition))
        .map((res) => ({ ...res, metadata: { ...res.metadata } })),
    };
  }

  /** 在隔离后的账本视图内执行中英文词元与双字切片检索；空查询返回活跃主目标与硬红线。 */
  queryContext(
    query: string,
    callerDomain: CallerAccessDomain = "owner_private",
    nowMs = Date.now(),
  ): LedgerQueryResult {
    const snapshot = this.snapshotForCaller(callerDomain);
    const terms = extractSearchTerms(query);
    const budgetStatus =
      this.budgetLedger && callerDomain !== "cowork_shared"
        ? this.budgetLedger.getBotBudgetStatus(this.defaultBotId, nowMs)
        : undefined;

    if (!terms.length) {
      return {
        relationships: [],
        goals: snapshot.goals.filter((g) => g.status === "active"),
        guardrails: snapshot.guardrails.filter((v) => v.kind === "hard_redline"),
        commitments: [],
        resources: [],
        ...(budgetStatus ? { budgetStatus } : {}),
      };
    }

    return {
      relationships: scoreAndFilter(
        snapshot.relationships,
        terms,
        (r) =>
          `${r.id} ${r.name} ${r.roleTag} ${r.trustTier} ${r.taboos.join(" ")} ${r.preferences.join(" ")} ${r.openFavors.join(" ")}`,
      ),
      goals: scoreAndFilter(snapshot.goals, terms, (g) => `${g.id} ${g.title} ${g.northStarCriterion} ${g.status}`),
      guardrails: scoreAndFilter(
        snapshot.guardrails,
        terms,
        (v) => `${v.id} ${v.kind} ${v.statement} ${v.enforcement} ${v.evidenceSource ?? ""}`,
      ),
      commitments: scoreAndFilter(
        snapshot.commitments,
        terms,
        (c) => `${c.id} ${c.direction} ${c.status} ${c.summary} ${c.counterpartyOrRef}`,
      ),
      resources: scoreAndFilter(
        snapshot.resources,
        terms,
        (r) =>
          `${r.id} ${r.kind} ${r.title} ${r.localUriOrPath ?? ""} ${Object.entries(r.metadata)
            .map(([k, val]) => `${k} ${val}`)
            .join(" ")}`,
      ),
      ...(budgetStatus ? { budgetStatus } : {}),
    };
  }

  /** 导出供 E2EE 跨端同步的脱敏快照（剥离与本机 OS 绑定的本地路径）。 */
  exportSnapshotForSync(): LedgerSnapshot {
    const snap = this.snapshotForCaller("owner_private");
    return {
      ...snap,
      resources: snap.resources.map((r) => {
        const { localUriOrPath: _strip, ...rest } = r;
        return { ...rest, metadata: { ...rest.metadata } };
      }),
    };
  }

  /** 合并远端同步来的五维生命账本快照并原子落盘，同步增量至知识图谱。 */
  mergeRemoteSnapshot(remote: LedgerSnapshot, nowIso = new Date().toISOString()): { merged: boolean } {
    if (!remote || remote.version !== 1) return { merged: false };
    const ts = (x: { updatedAt?: string; createdAt?: string; lastProgressAt?: string }): string =>
      String(x.updatedAt ?? x.createdAt ?? x.lastProgressAt ?? "");
    const mergeMap = <T extends { id: string }>(map: Map<string, T>, list: readonly T[] | undefined, cloneFn: (v: T) => T): void => {
      for (const item of list ?? []) {
        if (!item?.id) continue;
        const cur = map.get(item.id);
        if (!cur || ts(item as Record<string, string>) >= ts(cur as Record<string, string>)) {
          map.set(item.id, cloneFn(item));
        }
      }
    };
    mergeMap(this.relationships, remote.relationships, cloneRelationship);
    mergeMap(this.goals, remote.goals, (g) => ({ ...g }));
    mergeMap(this.guardrails, remote.guardrails, (v) => ({ ...v }));
    mergeMap(this.commitments, remote.commitments, (c) => ({ ...c }));
    for (const r of remote.resources ?? []) {
      if (!r?.id) continue;
      const cur = this.resources.get(r.id);
      if (!cur) this.resources.set(r.id, { ...r, metadata: { ...r.metadata } });
    }
    const activeGoals = Array.from(this.goals.values()).filter((g) => g.status === "active").sort((a, b) => b.lastProgressAt.localeCompare(a.lastProgressAt));
    for (const extra of activeGoals.slice(MAX_ACTIVE_GOALS)) {
      this.goals.set(extra.id, { ...extra, status: "paused" });
    }
    const delta: KGDelta = { nodes: [], edges: [] };
    for (const r of this.relationships.values()) {
      const d = this.buildRelationshipDelta(r);
      delta.nodes!.push(...(d.nodes ?? []));
      delta.edges!.push(...(d.edges ?? []));
    }
    for (const g of this.goals.values()) this.appendGoalDelta(delta, g, false);
    this.persist(nowIso, { op: "merge_remote_snapshot", remoteUpdatedAt: remote.updatedAt }, delta);
    return { merged: true };
  }
}
