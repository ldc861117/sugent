import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SugentBrokerClaims } from "./auth-broker-contract.js";
import {
  type ByokDiagnosticsReport,
  type ByokProbeTarget,
  type CostSandboxSimulation,
  type FetchLike,
  type SugentAgentRole,
  type SugentProviderId,
  type WorkloadPresetId,
} from "./byok-diagnostics.js";
import { buildByokSyncViewModel, type ByokSyncViewModel } from "./byok-sync-viewmodel.js";
import type { SyncableKGEdge, SyncableKGNode, SyncableKnowledgeGraphSnapshot } from "./e2ee-sync.js";
import type { EntityKind, KGEdge, KGNode, SkillGateStatus, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { LocalBudgetLedger } from "./local-budget.js";
import type { SugentModelCatalog } from "./model-catalog.js";
import { createP2GatewayHandlers } from "./p2-gateway-routes.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";

type ProviderEntry = ReturnType<ProviderRegistry["listProviders"]>[number];

export interface StewardshipLedgerSyncPort {
  exportLedger: () => LedgerSnapshot;
  importLedger: (snap: LedgerSnapshot) => void;
}

export interface SyncMetaRecord {
  deviceId: string;
  lamportClock: number;
  lastSyncedAtIso: string | null;
  itemDigests?: Record<string, { clock: number; sig: string }>;
}

export interface SugentP2HostServiceOptions {
  dataDir: string;
  providers: ProviderRegistry;
  modelCatalog: SugentModelCatalog;
  localBudgets: LocalBudgetLedger;
  knowledgeGraph: SugentKnowledgeGraph;
  getDefaultModel: () => string;
  getFetch: () => FetchLike;
  ledgerPort?: StewardshipLedgerSyncPort;
}

const VALID_PROVIDER_IDS = new Set<SugentProviderId>([
  "openai",
  "anthropic",
  "deepseek",
  "gemini",
  "openrouter",
  "ollama",
  "cowork",
  "custom-openai",
  "gemini-web2api",
]);

const VALID_ENTITY_KINDS = new Set<EntityKind>([
  "person",
  "project",
  "repo",
  "preference",
  "workflow",
  "tool",
  "concept",
]);

function mapStoredPresetToByokId(preset: string, id: string): SugentProviderId {
  if (VALID_PROVIDER_IDS.has(preset as SugentProviderId)) {
    return preset as SugentProviderId;
  }
  if (VALID_PROVIDER_IDS.has(id as SugentProviderId)) {
    return id as SugentProviderId;
  }
  return "custom-openai";
}

function resolveRoleForProvider(
  prov: ProviderEntry,
  routing: Record<SugentAgentRole, string>,
): SugentAgentRole {
  const roles: SugentAgentRole[] = ["executor", "assessor", "computerUse", "steward"];
  for (const role of roles) {
    const spec = routing[role] || "";
    if (spec.startsWith(`${prov.id}/`)) {
      return role;
    }
  }
  return prov.id === "ollama" || prov.id === "deepseek" ? "assessor" : "executor";
}

function normalizeItemDigests(
  raw: unknown,
): Record<string, { clock: number; sig: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { clock: number; sig: string }> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const rec = v as Partial<{ clock: number; sig: string }> | null;
    if (
      rec &&
      typeof rec.clock === "number" &&
      Number.isFinite(rec.clock) &&
      typeof rec.sig === "string"
    ) {
      out[k] = { clock: Math.max(1, Math.floor(rec.clock)), sig: rec.sig };
    }
  }
  return out;
}

function digestSyncPayload(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 24);
}

export class SugentP2HostService {
  private readonly metaPath: string;
  private lastDiagnostics: ByokDiagnosticsReport | null = null;
  private lastSimulation: CostSandboxSimulation | null = null;
  private ledgerPort?: StewardshipLedgerSyncPort;

  constructor(private readonly opts: SugentP2HostServiceOptions) {
    this.metaPath = path.join(opts.dataDir, "sugent-kg", "sync-meta.json");
    this.ledgerPort = opts.ledgerPort;
  }

  attachStewardshipLedgerPort(port: StewardshipLedgerSyncPort): void {
    this.ledgerPort = port;
  }

  private readSyncMeta(): SyncMetaRecord {
    if (fs.existsSync(this.metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as Partial<SyncMetaRecord>;
        if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
          const itemDigests = normalizeItemDigests(parsed.itemDigests);
          return {
            deviceId: parsed.deviceId,
            lamportClock:
              typeof parsed.lamportClock === "number" && Number.isFinite(parsed.lamportClock)
                ? Math.max(1, Math.floor(parsed.lamportClock))
                : 1,
            lastSyncedAtIso: typeof parsed.lastSyncedAtIso === "string" ? parsed.lastSyncedAtIso : null,
            ...(itemDigests ? { itemDigests } : {}),
          };
        }
      } catch {
        // Re-seed corrupted sync metadata cleanly.
      }
    }
    const fresh: SyncMetaRecord = {
      deviceId: `dev_${crypto.randomBytes(6).toString("hex")}`,
      lamportClock: 1,
      lastSyncedAtIso: null,
    };
    this.writeSyncMeta(fresh);
    return fresh;
  }

  private writeSyncMeta(meta: SyncMetaRecord): void {
    const dir = path.dirname(this.metaPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.metaPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.metaPath);
  }

  private buildNodeDigest(n: KGNode): string {
    return digestSyncPayload({
      id: n.id,
      kind: n.kind,
      name: n.name,
      summary: n.summary,
      tags: n.tags,
      reinforcements: n.reinforcements,
      steps: n.steps ?? null,
      skillGateStatus: n.skillGateStatus ?? null,
      updatedAt: n.updatedAt,
    });
  }

  private buildEdgeDigest(e: KGEdge): string {
    const updatedAt = (e as KGEdge & { updatedAt?: string }).updatedAt ?? e.supersededAt ?? e.validFrom;
    return digestSyncPayload({
      id: e.id,
      from: e.from,
      to: e.to,
      relation: e.relation,
      weight: e.weight,
      source: e.source,
      validFrom: e.validFrom,
      supersededAt: e.supersededAt ?? null,
      updatedAt,
    });
  }

  private exportGraphSnapshot(): SyncableKnowledgeGraphSnapshot {
    const meta = this.readSyncMeta();
    const prevDigests = meta.itemDigests ?? {};
    const rawNodes = this.opts.knowledgeGraph.allNodes();
    const rawEdges = this.opts.knowledgeGraph.allEdges();

    const nodeSigs = rawNodes.map((n) => ({ n, key: `node:${n.id}`, sig: this.buildNodeDigest(n) }));
    const edgeSigs = rawEdges.map((e) => ({ e, key: `edge:${e.id}`, sig: this.buildEdgeDigest(e) }));
    const dirty =
      nodeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig) ||
      edgeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig);
    const snapshotClock = dirty ? meta.lamportClock + 1 : meta.lamportClock;
    const nextDigests: Record<string, { clock: number; sig: string }> = {};

    const nodes: SyncableKGNode[] = nodeSigs.map(({ n, key, sig }) => {
      const prev = prevDigests[key];
      const clock = prev && prev.sig === sig ? prev.clock : snapshotClock;
      nextDigests[key] = { clock, sig };
      return {
        id: n.id,
        type: n.kind,
        label: n.name,
        properties: {
          summary: n.summary,
          tags: n.tags,
          reinforcements: n.reinforcements,
          ...(n.steps ? { steps: n.steps } : {}),
          ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
        },
        validFrom: n.updatedAt,
        supersededAt: null,
        updatedAt: n.updatedAt,
        lamportClock: clock,
      };
    });

    const edges: SyncableKGEdge[] = edgeSigs.map(({ e, key, sig }) => {
      const prev = prevDigests[key];
      const clock = prev && prev.sig === sig ? prev.clock : snapshotClock;
      nextDigests[key] = { clock, sig };
      const updatedAt = (e as KGEdge & { updatedAt?: string }).updatedAt ?? e.supersededAt ?? e.validFrom;
      return {
        id: e.id,
        source: e.from,
        target: e.to,
        relation: e.relation,
        weight: e.weight,
        provenanceSource: e.source,
        validFrom: e.validFrom,
        supersededAt: e.supersededAt ?? null,
        updatedAt,
        lamportClock: clock,
      };
    });

    if (dirty) {
      this.writeSyncMeta({
        deviceId: meta.deviceId,
        lamportClock: snapshotClock,
        lastSyncedAtIso: meta.lastSyncedAtIso,
        itemDigests: nextDigests,
      });
    }
    const stewardshipLedger = this.ledgerPort?.exportLedger();
    return {
      lamportClock: snapshotClock,
      deviceId: meta.deviceId,
      nodes,
      edges,
      ...(stewardshipLedger ? { stewardshipLedger } : {}),
    };
  }

  private applyGraphSnapshot(merged: SyncableKnowledgeGraphSnapshot): void {
    const itemDigests: Record<string, { clock: number; sig: string }> = {};
    const restoredNodes: KGNode[] = merged.nodes
      .filter((n) => !n.supersededAt)
      .map((n) => {
        const props = n.properties ?? {};
        const kind: EntityKind = VALID_ENTITY_KINDS.has(n.type as EntityKind)
          ? (n.type as EntityKind)
          : "concept";
        const tags = Array.isArray(props.tags) ? props.tags.map(String) : [];
        const steps = Array.isArray(props.steps) ? props.steps.map(String) : undefined;
        const reinforcements =
          typeof props.reinforcements === "number" && Number.isFinite(props.reinforcements)
            ? props.reinforcements
            : 1;
        const rawGate = props.skillGateStatus;
        const skillGateStatus: SkillGateStatus | undefined =
          rawGate === "candidate" || rawGate === "approved" || rawGate === "rejected"
            ? rawGate
            : undefined;
        const node: KGNode = {
          id: n.id,
          kind,
          name: n.label,
          summary: typeof props.summary === "string" ? props.summary : "",
          tags,
          reinforcements,
          ...(steps && steps.length > 0 ? { steps } : {}),
          ...(skillGateStatus ? { skillGateStatus } : {}),
          updatedAt: n.updatedAt,
        };
        itemDigests[`node:${node.id}`] = {
          clock: typeof n.lamportClock === "number" && n.lamportClock > 0 ? n.lamportClock : merged.lamportClock,
          sig: this.buildNodeDigest(node),
        };
        return node;
      });

    const restoredEdges: KGEdge[] = merged.edges.map((e) => {
      const edge: KGEdge = {
        id: e.id,
        from: e.source,
        relation: e.relation,
        to: e.target,
        weight: e.weight ?? 1,
        source: e.provenanceSource || "e2ee_sync",
        validFrom: e.validFrom,
        ...(e.supersededAt ? { supersededAt: e.supersededAt } : {}),
      };
      itemDigests[`edge:${edge.id}`] = {
        clock: typeof e.lamportClock === "number" && e.lamportClock > 0 ? e.lamportClock : merged.lamportClock,
        sig: this.buildEdgeDigest(edge),
      };
      return edge;
    });

    this.opts.knowledgeGraph.replaceAll(restoredNodes, restoredEdges);
    if (merged.stewardshipLedger && this.ledgerPort) {
      this.ledgerPort.importLedger(merged.stewardshipLedger);
    }
    const cur = this.readSyncMeta();
    this.writeSyncMeta({
      deviceId: cur.deviceId,
      lamportClock: merged.lamportClock,
      lastSyncedAtIso: new Date().toISOString(),
      itemDigests,
    });
  }

  private createHandlers() {
    return createP2GatewayHandlers({
      catalog: this.opts.modelCatalog,
      getBudgetLedger: () => {
        const status = this.opts.localBudgets.getBotBudgetStatus("default");
        return {
          monthlyCapUsd: status.enabled ? status.limitUsd : null,
          currentMonthSpentUsd: status.usedUsd,
        };
      },
      getKnowledgeGraphSnapshot: async () => this.exportGraphSnapshot(),
      applyKnowledgeGraphSnapshot: async (merged) => this.applyGraphSnapshot(merged),
      fetchImpl: (input, init) => this.opts.getFetch()(input, init),
    });
  }

  async runDiagnostics(params?: {
    providerId?: string;
    timeoutMs?: number;
    probeCapabilities?: boolean;
    claims?: SugentBrokerClaims | null;
  }) {
    const routing = this.opts.providers.routing;
    const list = this.opts.providers
      .listProviders()
      .filter((p) => p.enabled && (!params?.providerId || p.id === params.providerId));

    const targets: ByokProbeTarget[] = list.map((p) => ({
      providerId: mapStoredPresetToByokId(p.preset, p.id),
      role: resolveRoleForProvider(p, routing),
      baseUrl: p.baseUrl,
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
      modelId: p.defaultModel || p.models?.[0] || "gpt-4.1-mini",
      ...(params?.probeCapabilities ? { probeCapabilities: true } : {}),
    }));

    const handlers = this.createHandlers();
    const res = await handlers.handleByokDiagnostics({
      targets,
      ...(params?.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
    });
    const report = res.body.data ?? null;
    this.lastDiagnostics = report;

    const providerStatuses: Record<string, unknown> = {};
    list.forEach((prov, idx) => {
      const hit = report?.results[idx];
      if (hit) {
        providerStatuses[prov.id] = hit;
      }
    });

    const viewModel: ByokSyncViewModel = buildByokSyncViewModel({
      diagnostics: report,
      simulation: this.lastSimulation,
      claims: params?.claims ?? null,
    });

    return {
      ok: true,
      report,
      providerStatuses,
      viewModel,
    };
  }

  async simulateCostSandbox(params?: {
    preset?: WorkloadPresetId;
    activeDaysPerMonth?: number;
    promptCacheHitRatio?: number;
    roleModels?: Partial<Record<SugentAgentRole, string>>;
    claims?: SugentBrokerClaims | null;
  }) {
    const fallbackModel =
      this.opts.getDefaultModel() ||
      this.opts.providers.routing.executor ||
      "claude-sonnet-4-20250514";
    const r = this.opts.providers.routing;
    const roleModels: Record<SugentAgentRole, string> = {
      assessor: params?.roleModels?.assessor || r.assessor || "deepseek-chat",
      executor: params?.roleModels?.executor || r.executor || fallbackModel,
      computerUse: params?.roleModels?.computerUse || r.computerUse || fallbackModel,
      steward: params?.roleModels?.steward || r.steward || "deepseek-chat",
    };

    const handlers = this.createHandlers();
    const res = await handlers.handleCostSandbox({
      roleModels,
      ...(params?.preset ? { preset: params.preset } : {}),
      ...(params?.activeDaysPerMonth !== undefined
        ? { activeDaysPerMonth: params.activeDaysPerMonth }
        : {}),
      ...(params?.promptCacheHitRatio !== undefined
        ? { promptCacheHitRatio: params.promptCacheHitRatio }
        : {}),
    });
    const simulation = res.body.data!;
    this.lastSimulation = simulation;

    const viewModel = buildByokSyncViewModel({
      diagnostics: this.lastDiagnostics,
      simulation,
      claims: params?.claims ?? null,
    });

    return {
      ok: true,
      simulation,
      viewModel,
    };
  }

  getSyncStatus(claims: SugentBrokerClaims | null = null) {
    const meta = this.readSyncMeta();
    return {
      deviceId: meta.deviceId,
      lamportClock: meta.lamportClock,
      lastSyncedAtIso: meta.lastSyncedAtIso,
      nodeCount: this.opts.knowledgeGraph.allNodes().length,
      edgeCount: this.opts.knowledgeGraph.allEdges().length,
      viewModel: buildByokSyncViewModel({
        diagnostics: this.lastDiagnostics,
        simulation: this.lastSimulation,
        claims,
      }),
    };
  }

  async pushSync(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
  }) {
    const handlers = this.createHandlers();
    const res = await handlers.handleSyncPush(params);
    if (res.statusCode === 200 && res.body.data) {
      const cur = this.readSyncMeta();
      this.writeSyncMeta({
        deviceId: cur.deviceId,
        lamportClock: res.body.data.lamportClock,
        lastSyncedAtIso: res.body.data.uploadedAtIso,
        ...(cur.itemDigests ? { itemDigests: cur.itemDigests } : {}),
      });
    }
    return res;
  }

  async pullSync(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
  }) {
    const handlers = this.createHandlers();
    return handlers.handleSyncPull(params);
  }
}
