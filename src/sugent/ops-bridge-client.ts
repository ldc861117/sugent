import crypto from "node:crypto";

export interface OpsBridgeConfig {
  enabled: boolean;
  baseUrl: string;
  nodeToken: string;
  nodeId: string;
  opsNodeId: string;
  stewardHubNodeId: string;
  weixinOwnerNodeId: string;
}

export interface WeixinSingleHolderVerdict {
  blocked: boolean;
  nodeId: string;
  ownerNodeId: string;
  reason?: string;
}

export interface OpsProjectPulseInput {
  projectKey: string;
  displayName?: string;
  aliases?: string[];
  tier: 0 | 1 | 2;
  status?: string;
  summary?: string;
  updatedAtIso: string;
  sessionCount: number;
  runningSessionCount: number;
  subagentCount: number;
  workspaceRoot?: string;
  runningSessions?: Array<{
    conversationId: string;
    title: string;
    stepCount: number;
    activeSubagentCount: number;
  }>;
}

export interface OpsPrunedProjectPulse {
  projectKey: string;
  codeName: string;
  tier: 0 | 1 | 2;
  updatedAtIso: string;
  sessionCount: number;
  runningSessionCount: number;
  subagentCount: number;
  displayName?: string;
  status?: string;
  sanitizedSummary?: string;
  aliases?: string[];
  runningSessions?: Array<{
    title: string;
    stepCount: number;
    activeSubagentCount: number;
  }>;
}

export interface OpsGovernanceDocInput {
  projectKey: string;
  tier: 0 | 1 | 2;
  docKind: "roadmap" | "plan" | "walkthrough" | "summary";
  title: string;
  summary: string;
  updatedAtIso?: string;
}

export interface OpsRemoteCommand {
  id: string;
  targetNodeId: string;
  action: string;
  title?: string;
  summary?: string;
  projectKey?: string;
  createdAtIso?: string;
}

export interface OpsInboxItem {
  id: string;
  title: string;
  summary?: string;
  targetNodeId?: string;
  commandAction?: string;
  projectKey?: string;
  requiresDashboardConfirm?: boolean;
  createdAtIso?: string;
}

export interface OpsRoadmapItemSummary {
  id: string;
  title: string;
  status: string;
  actor?: string;
}

export interface OpsRoadmapNodeSummary {
  id?: string;
  kind?: string;
  code?: string;
  title: string;
  status: string;
  marker?: string;
  progress?: {
    done?: number;
    inProgress?: number;
    todo?: number;
    blocked?: number;
    total?: number;
    pct?: number;
    codeDone?: number;
    codeTotal?: number;
    realDone?: number;
    realTotal?: number;
  };
  hasExitGate?: boolean;
  gates?: { entry?: string[]; exit?: string[] };
  items?: OpsRoadmapItemSummary[];
}

export interface OpsRepoPlanDocSummary {
  path: string;
  title: string;
  updatedAtIso?: string;
}

export interface OpsRepoGitSyncSummary {
  branch: string;
  dirtyCount: number;
  aheadCount: number;
  behindCount: number;
  unmergedRemoteBranches?: string[];
  needsAttention: boolean;
}

export interface OpsRepoTaskQueueItem {
  status: "in_progress" | "todo" | "blocked";
  phaseCode?: string;
  slug?: string;
  title: string;
  ac?: string;
}

export interface OpsRepoTasksSummary {
  totalLines: number;
  needsArchive: boolean;
  counts: {
    todo: number;
    inProgress: number;
    done: number;
    blocked: number;
    backlog: number;
  };
  activeItems: OpsRepoTaskQueueItem[];
}

export interface OpsStewardProjectItem {
  projectKey: string;
  displayName?: string;
  nodeId?: string;
  nodes?: string[];
  tier?: 0 | 1 | 2;
  privacyTier?: 0 | 1 | 2;
  domain?: string;
  domainSource?: string;
  stage?: string;
  stageSource?: string;
  boardStatus?: string;
  boardStatusReason?: string;
  boardStatusSource?: string;
  autopilotHealth?: string;
  autopilotNote?: string;
  status?: string;
  sanitizedSummary?: string;
  updatedAtIso?: string;
  lastActiveAt?: string;
  executiveSummary?: {
    goalText?: string;
    progressText?: string;
    nextActionText?: string;
    updatedAt?: string;
  };
  statusCard?: {
    stageGoal?: string;
    landed?: string[];
    inflight?: Array<{ text: string; nodeId?: string; surface?: string; updatedAt?: string }>;
    nextActions?: string[];
    blockers?: string[];
    reviewState?: string;
    source?: string;
    updatedBy?: string;
    updatedAt?: string;
  };
  roadmapSummary?: {
    schemaVersion?: number;
    sourcePath?: string;
    title?: string;
    activeNodeId?: string;
    activeNode?: {
      id?: string;
      kind?: string;
      code?: string;
      title?: string;
      status?: string;
      progress?: {
        done?: number;
        total?: number;
        pct?: number;
        codeDone?: number;
        codeTotal?: number;
        realDone?: number;
        realTotal?: number;
      };
    };
    totals?: {
      done?: number;
      total?: number;
      pct?: number;
      codeDone?: number;
      codeTotal?: number;
      realDone?: number;
      realTotal?: number;
    };
    overallProgress?: {
      done?: number;
      inProgress?: number;
      todo?: number;
      blocked?: number;
      total?: number;
      pct?: number;
    };
    nodes?: OpsRoadmapNodeSummary[];
  };
  recentPlans?: OpsRepoPlanDocSummary[];
  gitSync?: OpsRepoGitSyncSummary;
  tasksSummary?: OpsRepoTasksSummary;
}

export interface OpsPublicConciergeItem {
  sessionId: string;
  id?: string;
  actorLabel?: string;
  actorName?: string;
  species?: string;
  axiomSlug?: string;
  intentSummary?: string;
  summary?: string;
  contactEmail?: string;
  matchedDomains?: string[];
  createdAt?: string;
}

export interface OpsPublicConciergeDecision {
  sessionId: string;
  action: "approve_reply" | "unlock" | "merge" | "decline" | "block";
  ownerReply?: string;
  branchDraft?: string;
}

export interface OpsHumanCommitmentSyncItem {
  id: string;
  projectKey?: string;
  projectName?: string;
  title: string;
  stage: string;
  actor?: string;
  direction?: "i_owe" | "waiting_for" | "expiring" | string;
  snoozeUntil?: string;
  dueAt?: string;
  roadmapItemId?: string;
  nextAiHint?: string;
  updatedAt: string;
}

export interface OpsCommitmentStatusUpdate {
  id: string;
  status: "open" | "snoozed" | "closed";
  updatedAt: string;
}

export interface OpsStewardPendingSnapshot {
  fetchedAtIso?: string;
  projects: OpsStewardProjectItem[];
  pendingInbox: OpsInboxItem[];
  humanCommitments?: OpsHumanCommitmentSyncItem[];
  publicConciergeQueue?: OpsPublicConciergeItem[];
  publicTopicDigest?: string;
  weeklyFocus?: string[];
  stageGoals?: string[];
}

export interface OpsStewardSyncInput {
  stageGoals?: string[];
  weeklyFocus?: string[];
  inboxItems?: OpsInboxItem[];
  approvedInboxIds?: string[];
  commands?: OpsRemoteCommand[];
  conciergeDecisions?: OpsPublicConciergeDecision[];
  commitmentUpdates?: OpsCommitmentStatusUpdate[];
}

const JWT_RENEW_LEAD_MS = 5 * 60_000;
const DEFAULT_JWT_TTL_SEC = 3600;
const LOCAL_PATH_REDACT_RE =
  /(?:\/Users|\/home|\/Volumes|\/private\/var|\/var\/folders|\/root|\/opt|[A-Za-z]:[\\/])[\\/A-Za-z0-9._~@-]+/g;

export function resolveOpsBridgeConfig(
  env: Record<string, string | undefined> = process.env,
): OpsBridgeConfig {
  const baseUrl = String(env.OPS_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const nodeToken = String(env.OPS_NODE_TOKEN ?? "").trim();
  const nodeId = String(env.SUGENT_NODE_ID ?? "").trim() || "local-mac";
  const opsNodeId = String(env.OPS_NODE_ID ?? "").trim() || nodeId;
  const explicitHub = String(env.SUGENT_STEWARD_HUB_NODE ?? "").trim();
  const explicitWxOwner = String(env.SUGENT_WEIXIN_OWNER_NODE ?? "").trim();
  const stewardHubNodeId = explicitHub || explicitWxOwner || "gce-hub";
  const weixinOwnerNodeId = explicitWxOwner || "gce-hub";
  return {
    enabled: Boolean(baseUrl && nodeToken),
    baseUrl,
    nodeToken,
    nodeId,
    opsNodeId,
    stewardHubNodeId,
    weixinOwnerNodeId,
  };
}

/**
 * 微信 iLink 单持有者守卫：
 * - 单机离线模式（既未设置 `SUGENT_WEIXIN_OWNER_NODE` 也未配置 `OPS_BASE_URL`）保持放行，不破坏单机用户体验；
 * - 一旦显式声明 `SUGENT_WEIXIN_OWNER_NODE` 或启用多节点 `OPS_BASE_URL` 舰队模式（默认 `gce-hub` 持有微信），
 *   任何 `nodeId !== ownerNodeId` 的节点禁止启动微信长轮询或发起扫码绑定，防止两处抢消费 `getupdates` 导致丢消息。
 */
export function evaluateWeixinSingleHolderGuard(
  env: Record<string, string | undefined> = process.env,
  nodeIdOverride?: string,
): WeixinSingleHolderVerdict {
  const explicitOwner = String(env.SUGENT_WEIXIN_OWNER_NODE ?? "").trim();
  const hasFleetBase = Boolean(String(env.OPS_BASE_URL ?? "").trim());
  const nodeId = (nodeIdOverride ?? String(env.SUGENT_NODE_ID ?? "").trim()) || "local-mac";
  if (!explicitOwner && !hasFleetBase) {
    return { blocked: false, nodeId, ownerNodeId: nodeId };
  }
  const ownerNodeId = explicitOwner || "gce-hub";
  if (nodeId === ownerNodeId) {
    return { blocked: false, nodeId, ownerNodeId };
  }
  return {
    blocked: true,
    nodeId,
    ownerNodeId,
    reason: `微信通道已锁定由常驻节点「${ownerNodeId}」独占持有（当前节点：${nodeId}），本机保持只读防抢消息。`,
  };
}

function sanitizeSummaryText(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(LOCAL_PATH_REDACT_RE, "[local-path]").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, 280) : undefined;
}

export function pruneProjectPulseForTier(input: OpsProjectPulseInput): OpsPrunedProjectPulse {
  const codeHash = crypto.createHash("sha256").update(input.projectKey).digest("hex").slice(0, 8);
  const base: OpsPrunedProjectPulse = {
    projectKey: input.tier === 0 ? `tier0:${codeHash}` : input.projectKey,
    codeName: `proj-${codeHash}`,
    tier: input.tier,
    updatedAtIso: input.updatedAtIso,
    sessionCount: input.sessionCount,
    runningSessionCount: input.runningSessionCount,
    subagentCount: input.subagentCount,
  };
  if (input.tier === 0) {
    return base;
  }
  const sanitizedDisplayName = sanitizeSummaryText(input.displayName);
  const sanitizedSummary = sanitizeSummaryText(input.summary);
  const tier1: OpsPrunedProjectPulse = {
    ...base,
    ...(sanitizedDisplayName ? { displayName: sanitizedDisplayName } : {}),
    ...(input.status ? { status: sanitizeSummaryText(input.status) } : {}),
    ...(sanitizedSummary ? { sanitizedSummary } : {}),
  };
  if (input.tier === 1) {
    return tier1;
  }
  const sanitizedAliases = input.aliases
    ?.map((a) => sanitizeSummaryText(a))
    .filter((a): a is string => Boolean(a));
  return {
    ...tier1,
    ...(sanitizedAliases?.length ? { aliases: sanitizedAliases } : {}),
    ...(input.runningSessions
      ? {
          runningSessions: input.runningSessions.slice(0, 8).map((s) => ({
            title: sanitizeSummaryText(s.title) ?? "session",
            stepCount: s.stepCount,
            activeSubagentCount: s.activeSubagentCount,
          })),
        }
      : {}),
  };
}

export interface OpsBridgeClientOptions {
  baseUrl?: string;
  nodeToken?: string;
  nodeId?: string;
  opsNodeId?: string;
  stewardHubNodeId?: string;
  fetchImpl?: typeof fetch;
  getFetch?: () => typeof fetch;
  nowMs?: () => number;
}

export class OpsBridgeClient {
  readonly baseUrl: string;
  readonly nodeId: string;
  readonly opsNodeId: string;
  readonly stewardHubNodeId: string;
  private readonly nodeToken: string;
  private readonly nowMsFn: () => number;
  private readonly getFetchFn: () => typeof fetch;
  private cachedJwt?: { token: string; expiresAtMs: number };
  private authInflight?: Promise<{ ok: boolean; token?: string; error?: string }>;
  private readonly ackedCommandIds = new Set<string>();

  constructor(opts: OpsBridgeClientOptions = {}) {
    this.baseUrl = String(opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.nodeToken = String(opts.nodeToken ?? "").trim();
    this.nodeId = String(opts.nodeId ?? "").trim() || "local-mac";
    this.opsNodeId = String(opts.opsNodeId ?? "").trim() || this.nodeId;
    this.stewardHubNodeId = String(opts.stewardHubNodeId ?? "").trim() || "gce-hub";
    this.nowMsFn = opts.nowMs ?? (() => Date.now());
    this.getFetchFn = opts.getFetch ?? (() => opts.fetchImpl ?? globalThis.fetch);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.nodeToken);
  }

  isStewardHub(): boolean {
    return this.nodeId === this.stewardHubNodeId;
  }

  async authenticate(force = false): Promise<{ ok: boolean; token?: string; skipped?: boolean; error?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, error: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const now = this.nowMsFn();
    if (!force && this.cachedJwt && this.cachedJwt.expiresAtMs - now > JWT_RENEW_LEAD_MS) {
      return { ok: true, token: this.cachedJwt.token };
    }
    if (!force && this.authInflight) {
      return this.authInflight;
    }

    const run = async (): Promise<{ ok: boolean; token?: string; error?: string }> => {
      try {
        const f = this.getFetchFn();
        const res = await f(`${this.baseUrl}/api/ops/node/auth`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.nodeToken}`,
          },
          body: JSON.stringify({ nodeId: this.opsNodeId, nodeToken: this.nodeToken, token: this.nodeToken }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          return { ok: false, error: `AUTH_HTTP_${res.status}` };
        }
        const json = (await res.json()) as {
          bridgeJwt?: string;
          token?: string;
          jwt?: string;
          expiresAt?: string;
          expiresInSec?: number;
          expiresIn?: number;
          expiresAtMs?: number;
        };
        const jwt = String(json.bridgeJwt ?? json.token ?? json.jwt ?? "").trim();
        if (!jwt) return { ok: false, error: "EMPTY_AUTH_JWT" };
        const parsedExpiresIso = typeof json.expiresAt === "string" ? Date.parse(json.expiresAt) : Number.NaN;
        const ttlSec = Number(json.expiresInSec ?? json.expiresIn ?? DEFAULT_JWT_TTL_SEC);
        const expiresAtMs =
          typeof json.expiresAtMs === "number" && Number.isFinite(json.expiresAtMs)
            ? json.expiresAtMs
            : Number.isFinite(parsedExpiresIso) && parsedExpiresIso > this.nowMsFn()
              ? parsedExpiresIso
              : this.nowMsFn() + (Number.isFinite(ttlSec) && ttlSec > 60 ? ttlSec * 1_000 : DEFAULT_JWT_TTL_SEC * 1_000);
        this.cachedJwt = { token: jwt, expiresAtMs };
        return { ok: true, token: jwt };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      } finally {
        this.authInflight = undefined;
      }
    };

    this.authInflight = run();
    return this.authInflight;
  }

  private async authedJson<T extends Record<string, unknown>>(
    subpath: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ ok: boolean; status?: number; data?: T; skipped?: boolean; reason?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const auth1 = await this.authenticate(false);
    if (!auth1.ok || !auth1.token) {
      return { ok: false, reason: auth1.error ?? "AUTH_FAILED" };
    }

    const doFetch = async (jwt: string) => {
      const f = this.getFetchFn();
      return f(`${this.baseUrl}${subpath}`, {
        method: init.method,
        headers: {
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          authorization: `Bearer ${jwt}`,
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    };

    try {
      let res = await doFetch(auth1.token);
      if (res.status === 401) {
        this.cachedJwt = undefined;
        const auth2 = await this.authenticate(true);
        if (!auth2.ok || !auth2.token) {
          return { ok: false, status: 401, reason: auth2.error ?? "REAUTH_FAILED" };
        }
        res = await doFetch(auth2.token);
      }
      if (!res.ok) {
        return { ok: false, status: res.status, reason: `HTTP_${res.status}` };
      }
      const text = await res.text();
      const data = (text ? JSON.parse(text) : {}) as T;
      return { ok: true, status: res.status, data };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  async pushPulse(
    projects: readonly OpsProjectPulseInput[],
    extra: { atIso?: string } = {},
  ): Promise<{ ok: boolean; skipped?: boolean; prunedCount?: number; reason?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const pruned = projects.map(pruneProjectPulseForTier);
    const atIso = extra.atIso ?? new Date(this.nowMsFn()).toISOString();
    const res = await this.authedJson("/api/ops/bridge/pulse", {
      method: "POST",
      body: { nodeId: this.opsNodeId, atIso, projects: pruned },
    });
    return { ok: res.ok, prunedCount: pruned.length, ...(res.reason ? { reason: res.reason } : {}) };
  }

  async pushSync(
    docs: readonly OpsGovernanceDocInput[],
    extra: { atIso?: string } = {},
  ): Promise<{ ok: boolean; skipped?: boolean; sentCount?: number; reason?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const tier2Only = docs
      .filter((d) => d.tier === 2)
      .map((d) => ({
        projectKey: d.projectKey,
        docKind: d.docKind,
        title: sanitizeSummaryText(d.title) ?? d.title.slice(0, 120),
        summary: sanitizeSummaryText(d.summary) ?? "",
        updatedAtIso: d.updatedAtIso ?? new Date(this.nowMsFn()).toISOString(),
      }));
    const atIso = extra.atIso ?? new Date(this.nowMsFn()).toISOString();
    const res = await this.authedJson("/api/ops/bridge/sync", {
      method: "POST",
      body: { nodeId: this.opsNodeId, atIso, docs: tier2Only },
    });
    return { ok: res.ok, sentCount: tier2Only.length, ...(res.reason ? { reason: res.reason } : {}) };
  }

  async pullCommands(): Promise<{ ok: boolean; skipped?: boolean; commands: OpsRemoteCommand[]; reason?: string }> {
    const res = await this.authedJson<{ commands?: OpsRemoteCommand[] }>(
      `/api/ops/bridge/commands?nodeId=${encodeURIComponent(this.opsNodeId)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      return { ok: false, ...(res.skipped ? { skipped: true } : {}), commands: [], ...(res.reason ? { reason: res.reason } : {}) };
    }
    const commands = Array.isArray(res.data?.commands) ? res.data.commands : [];
    return { ok: true, commands };
  }

  async ackCommand(
    commandId: string,
    payload: { status: "completed" | "failed" | "accepted"; summary?: string; force?: boolean },
  ): Promise<{ ok: boolean; skipped?: boolean; idempotent?: boolean; reason?: string }> {
    const cleanId = String(commandId ?? "").trim();
    if (!cleanId) return { ok: false, reason: "EMPTY_COMMAND_ID" };
    const cacheKey = `${cleanId}:${payload.status}`;
    if (!payload.force && (payload.status === "completed" || payload.status === "accepted") && this.ackedCommandIds.has(cacheKey)) {
      return { ok: true, idempotent: true };
    }
    const res = await this.authedJson(`/api/ops/bridge/commands/${encodeURIComponent(cleanId)}/ack`, {
      method: "POST",
      body: {
        nodeId: this.opsNodeId,
        status: payload.status,
        ...(payload.summary ? { summary: sanitizeSummaryText(payload.summary) } : {}),
        ackedAtIso: new Date(this.nowMsFn()).toISOString(),
      },
    });
    if (res.ok || res.status === 409) {
      if (payload.status === "completed" || payload.status === "accepted") {
        this.ackedCommandIds.add(cacheKey);
        if (this.ackedCommandIds.size > 500) {
          const oldest = this.ackedCommandIds.values().next().value;
          if (oldest) this.ackedCommandIds.delete(oldest);
        }
      }
      return { ok: true, ...(res.status === 409 ? { idempotent: true } : {}) };
    }
    return { ok: false, ...(res.skipped ? { skipped: true } : {}), ...(res.reason ? { reason: res.reason } : {}) };
  }

  async fetchFleetSnapshot(): Promise<{
    ok: boolean;
    skipped?: boolean;
    snapshot?: OpsStewardPendingSnapshot;
    reason?: string;
  }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    const res = await this.authedJson<Record<string, unknown>>(
      `/api/ops/bridge/steward-pending?nodeId=${encodeURIComponent(this.opsNodeId)}`,
      { method: "GET" },
    );
    if (!res.ok) {
      return { ok: false, ...(res.reason ? { reason: res.reason } : {}) };
    }
    const raw = res.data ?? {};
    const rawInbox = Array.isArray(raw.pendingInbox)
      ? raw.pendingInbox
      : Array.isArray(raw.pendingItems)
        ? raw.pendingItems
        : Array.isArray(raw.workItems)
          ? raw.workItems
          : Array.isArray(raw.items)
            ? raw.items
            : [];
    const publicConciergeQueue: OpsPublicConciergeItem[] | undefined = Array.isArray(raw.publicConciergeQueue)
      ? raw.publicConciergeQueue
          .map((entry): OpsPublicConciergeItem | null => {
            if (!entry || typeof entry !== "object") return null;
            const rec = entry as Record<string, unknown>;
            const sessionId = String(rec.sessionId ?? rec.id ?? "").trim();
            if (!sessionId) return null;
            return {
              sessionId,
              ...(typeof rec.id === "string" ? { id: rec.id } : {}),
              ...(typeof rec.actorLabel === "string" ? { actorLabel: rec.actorLabel } : {}),
              ...(typeof rec.actorName === "string" ? { actorName: rec.actorName } : {}),
              ...(typeof rec.species === "string" ? { species: rec.species } : {}),
              ...(typeof rec.axiomSlug === "string" ? { axiomSlug: rec.axiomSlug } : {}),
              ...(typeof rec.intentSummary === "string" ? { intentSummary: rec.intentSummary } : {}),
              ...(typeof rec.summary === "string" ? { summary: rec.summary } : {}),
              ...(typeof rec.contactEmail === "string" ? { contactEmail: rec.contactEmail } : {}),
              ...(Array.isArray(rec.matchedDomains)
                ? { matchedDomains: rec.matchedDomains.filter((d): d is string => typeof d === "string") }
                : {}),
              ...(typeof rec.createdAt === "string" ? { createdAt: rec.createdAt } : {}),
            };
          })
          .filter((entry): entry is OpsPublicConciergeItem => entry !== null)
      : undefined;
    const humanCommitments: OpsHumanCommitmentSyncItem[] | undefined = Array.isArray(raw.humanCommitments)
      ? raw.humanCommitments
          .map((entry): OpsHumanCommitmentSyncItem | null => {
            if (!entry || typeof entry !== "object") return null;
            const rec = entry as Record<string, unknown>;
            const id = String(rec.id ?? "").trim();
            const title = String(rec.title ?? "").trim();
            if (!id || !title) return null;
            return {
              id,
              title,
              stage: String(rec.stage ?? "needs_you"),
              updatedAt: String(rec.updatedAt ?? new Date(this.nowMsFn()).toISOString()),
              ...(typeof rec.projectKey === "string" ? { projectKey: rec.projectKey } : {}),
              ...(typeof rec.projectName === "string" ? { projectName: rec.projectName } : {}),
              ...(typeof rec.actor === "string" ? { actor: rec.actor } : {}),
              ...(typeof rec.direction === "string" ? { direction: rec.direction } : {}),
              ...(typeof rec.snoozeUntil === "string" ? { snoozeUntil: rec.snoozeUntil } : {}),
              ...(typeof rec.dueAt === "string" ? { dueAt: rec.dueAt } : {}),
              ...(typeof rec.roadmapItemId === "string" ? { roadmapItemId: rec.roadmapItemId } : {}),
              ...(typeof rec.nextAiHint === "string" ? { nextAiHint: rec.nextAiHint } : {}),
            };
          })
          .filter((entry): entry is OpsHumanCommitmentSyncItem => entry !== null)
      : undefined;
    const snapshot: OpsStewardPendingSnapshot = {
      fetchedAtIso: new Date(this.nowMsFn()).toISOString(),
      projects: Array.isArray(raw.projects) ? (raw.projects as OpsStewardProjectItem[]) : [],
      pendingInbox: rawInbox as OpsInboxItem[],
      ...(humanCommitments !== undefined ? { humanCommitments } : {}),
      ...(publicConciergeQueue !== undefined ? { publicConciergeQueue } : {}),
      ...(typeof raw.publicTopicDigest === "string" ? { publicTopicDigest: raw.publicTopicDigest } : {}),
      ...(Array.isArray(raw.weeklyFocus) ? { weeklyFocus: raw.weeklyFocus.map(String) } : {}),
      ...(Array.isArray(raw.stageGoals) ? { stageGoals: raw.stageGoals.map(String) } : {}),
    };
    return { ok: true, snapshot };
  }

  async stewardPending(): Promise<{
    ok: boolean;
    skipped?: boolean;
    snapshot?: OpsStewardPendingSnapshot;
    reason?: string;
  }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    if (!this.isStewardHub()) {
      return { ok: false, reason: "NOT_STEWARD_HUB_NODE" };
    }
    return this.fetchFleetSnapshot();
  }

  async stewardSync(
    payload: OpsStewardSyncInput,
  ): Promise<{ ok: boolean; skipped?: boolean; reason?: string }> {
    if (!this.isConfigured()) {
      return { ok: false, skipped: true, reason: "OPS_BRIDGE_UNCONFIGURED" };
    }
    if (!this.isStewardHub()) {
      return { ok: false, reason: "NOT_STEWARD_HUB_NODE" };
    }
    const res = await this.authedJson("/api/ops/bridge/steward-sync", {
      method: "POST",
      body: {
        nodeId: this.opsNodeId,
        atIso: new Date(this.nowMsFn()).toISOString(),
        ...payload,
      },
    });
    return { ok: res.ok, ...(res.reason ? { reason: res.reason } : {}) };
  }
}
