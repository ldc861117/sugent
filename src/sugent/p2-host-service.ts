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
import type { EntityKind, KGEdge, KGNode, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { LocalBudgetLedger } from "./local-budget.js";
import type { SugentModelCatalog } from "./model-catalog.js";
import { createP2GatewayHandlers } from "./p2-gateway-routes.js";
import type { ProviderRegistry } from "./provider-registry.js";

type ProviderEntry = ReturnType<ProviderRegistry["listProviders"]>[number];

export interface SyncMetaRecord {
  deviceId: string;
  lamportClock: number;
  lastSyncedAtIso: string | null;
}

export interface SugentP2HostServiceOptions {
  dataDir: string;
  providers: ProviderRegistry;
  modelCatalog: SugentModelCatalog;
  localBudgets: LocalBudgetLedger;
  knowledgeGraph: SugentKnowledgeGraph;
  getDefaultModel: () => string;
  getFetch: () => FetchLike;
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

export class SugentP2HostService {
  private readonly metaPath: string;
  private lastDiagnostics: ByokDiagnosticsReport | null = null;
  private lastSimulation: CostSandboxSimulation | null = null;

  constructor(private readonly opts: SugentP2HostServiceOptions) {
    this.metaPath = path.join(opts.dataDir, "sugent-kg", "sync-meta.json");
  }

  private readSyncMeta(): SyncMetaRecord {
    if (fs.existsSync(this.metaPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.metaPath, "utf8")) as Partial<SyncMetaRecord>;
        if (typeof parsed.deviceId === "string" && parsed.deviceId.trim()) {
          return {
            deviceId: parsed.deviceId,
            lamportClock:
              typeof parsed.lamportClock === "number" && Number.isFinite(parsed.lamportClock)
                ? Math.max(1, Math.floor(parsed.lamportClock))
                : 1,
            lastSyncedAtIso: typeof parsed.lastSyncedAtIso === "string" ? parsed.lastSyncedAtIso : null,
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

  private exportGraphSnapshot(): SyncableKnowledgeGraphSnapshot {
    const meta = this.readSyncMeta();
    const rawNodes = this.opts.knowledgeGraph.allNodes();
    const rawEdges = this.opts.knowledgeGraph.allEdges();

    const nodes: SyncableKGNode[] = rawNodes.map((n) => ({
      id: n.id,
      type: n.kind,
      label: n.name,
      properties: {
        summary: n.summary,
        tags: n.tags,
        reinforcements: n.reinforcements,
        ...(n.steps ? { steps: n.steps } : {}),
      },
      validFrom: n.updatedAt,
      supersededAt: null,
      updatedAt: n.updatedAt,
      lamportClock: meta.lamportClock,
    }));

    const edges: SyncableKGEdge[] = rawEdges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      relation: e.relation,
      weight: e.weight,
      validFrom: e.validFrom,
      supersededAt: e.supersededAt ?? null,
      updatedAt: e.supersededAt ?? e.validFrom,
      lamportClock: meta.lamportClock,
    }));

    return {
      lamportClock: meta.lamportClock,
      deviceId: meta.deviceId,
      nodes,
      edges,
    };
  }

  private applyGraphSnapshot(merged: SyncableKnowledgeGraphSnapshot): void {
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
        return {
          id: n.id,
          kind,
          name: n.label,
          summary: typeof props.summary === "string" ? props.summary : "",
          tags,
          reinforcements,
          ...(steps && steps.length > 0 ? { steps } : {}),
          updatedAt: n.updatedAt,
        };
      });

    const restoredEdges: KGEdge[] = merged.edges.map((e) => ({
      id: e.id,
      from: e.source,
      relation: e.relation,
      to: e.target,
      weight: e.weight ?? 1,
      source: "e2ee_sync",
      validFrom: e.validFrom,
      ...(e.supersededAt ? { supersededAt: e.supersededAt } : {}),
    }));

    this.opts.knowledgeGraph.replaceAll(restoredNodes, restoredEdges);
    const cur = this.readSyncMeta();
    this.writeSyncMeta({
      deviceId: cur.deviceId,
      lamportClock: merged.lamportClock,
      lastSyncedAtIso: new Date().toISOString(),
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
