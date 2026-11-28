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
import type {
  SyncableAtlasEdge,
  SyncableAtlasNode,
  SyncableAtlasSnapshotV2,
  SyncableKGEdge,
  SyncableKGNode,
  SyncableKnowledgeGraphSnapshot,
  SyncableMindJournalEntry,
} from "./e2ee-sync.js";
import type { EntityKind, KGEdge, KGNode, SkillGateStatus, SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { LocalBudgetLedger } from "./local-budget.js";
import type { SugentModelCatalog } from "./model-catalog.js";
import { createP2GatewayHandlers } from "./p2-gateway-routes.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { EpistemicJudgmentEntry } from "./silicon-identity-core.js";
import type {
  AtlasEdge,
  AtlasEdgeInput,
  AtlasNode,
  AtlasNodeInput,
  StereoscopicAtlas,
} from "./stereoscopic-atlas.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";

type ProviderEntry = ReturnType<ProviderRegistry["listProviders"]>[number];

export interface StewardshipLedgerSyncPort {
  exportLedger: () => LedgerSnapshot;
  importLedger: (snap: LedgerSnapshot) => void;
}

export interface AtlasMindSyncPort {
  exportAtlas: () => { nodes: AtlasNode[]; edges: AtlasEdge[] };
  importAtlas: (snapshot: { nodes: AtlasNode[]; edges: AtlasEdge[] }) => void;
  exportMindJournal?: () => EpistemicJudgmentEntry[];
  importMindJournal?: (entries: EpistemicJudgmentEntry[]) => void;
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
  atlasPort?: AtlasMindSyncPort;
}

function buildCalibratedLessonsFromEntries(entries: readonly EpistemicJudgmentEntry[], limit = 6): string[] {
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i]!;
    if (e.status === "falsified") {
      const lastNote = e.evidenceNotes[e.evidenceNotes.length - 1];
      out.push(
        `[避坑/${e.topicKey}] 「${e.hypothesis}」已被证伪${lastNote ? `（${lastNote}）` : ""}`,
      );
    } else if (e.status === "crystallized") {
      out.push(`[结晶/${e.topicKey}] ${e.hypothesis}`);
    }
  }
  return out;
}

export function createAtlasMindSyncPort(params: {
  atlas: StereoscopicAtlas;
  mindJournalPath?: string;
  onMindJournalImported?: () => void;
}): AtlasMindSyncPort {
  const { atlas, mindJournalPath, onMindJournalImported } = params;

  const exportAtlas = (): { nodes: AtlasNode[]; edges: AtlasEdge[] } => {
    const snap = atlas.snapshot();
    return {
      nodes: snap.nodes.map((n) => ({
        ...n,
        tags: [...n.tags],
        principalAcl: [...n.principalAcl],
        ...(n.steps ? { steps: [...n.steps] } : {}),
      })),
      edges: snap.edges.map((e) => ({
        ...e,
        ...(e.principalAcl ? { principalAcl: [...e.principalAcl] } : {}),
      })),
    };
  };

  const importAtlas = (snapshot: { nodes: AtlasNode[]; edges: AtlasEdge[] }): void => {
    const maybeLossless = atlas as unknown as {
      importLosslessSnapshot?: (snap: { nodes: AtlasNode[]; edges: AtlasEdge[] }) => void;
    };
    if (typeof maybeLossless.importLosslessSnapshot === "function") {
      maybeLossless.importLosslessSnapshot(snapshot);
      return;
    }

    const fallbackNow = new Date().toISOString();
    const nodesByUpdatedAt = new Map<string, AtlasNode[]>();
    for (const n of snapshot.nodes) {
      const ts = n.updatedAt || fallbackNow;
      const bucket = nodesByUpdatedAt.get(ts) ?? [];
      bucket.push(n);
      nodesByUpdatedAt.set(ts, bucket);
    }

    for (const [ts, batch] of nodesByUpdatedAt.entries()) {
      const inputs: AtlasNodeInput[] = batch.map((n) => {
        const existing = atlas.getNode(n.id);
        const reinfDelta = Math.max(0, n.reinforcements - (existing?.reinforcements ?? 0));
        return {
          id: n.id,
          plane: n.plane,
          stratum: n.stratum,
          kind: n.kind,
          name: n.name,
          summary: n.summary,
          tags: [...n.tags],
          principalAcl: [...n.principalAcl],
          reinforcements: reinfDelta,
          confidence: n.confidence,
          sourceTrust: n.sourceTrust,
          ...(n.steps?.length ? { steps: [...n.steps] } : {}),
          ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
          ...(n.archivedAt ? { archivedAt: n.archivedAt } : {}),
        };
      });
      atlas.applyDelta({ nodes: inputs }, ts);
    }

    const activeEdges = snapshot.edges.filter((e) => !e.supersededAt);
    const supersededEdges = snapshot.edges.filter((e) => Boolean(e.supersededAt));

    const toEdgeInput = (e: AtlasEdge): AtlasEdgeInput => ({
      plane: e.plane,
      from: e.from,
      relation: e.relation,
      to: e.to,
      weight: e.weight,
      source: e.source,
      ...(e.isMembraneEdge ? { isMembraneEdge: true } : {}),
      ...(e.membranePolicy ? { membranePolicy: e.membranePolicy } : {}),
      ...(e.principalAcl?.length ? { principalAcl: [...e.principalAcl] } : {}),
    });

    for (const e of activeEdges) {
      if (!atlas.getEdge(e.id) && e.validFrom && e.validFrom !== e.updatedAt) {
        atlas.applyDelta({ edges: [toEdgeInput(e)] }, e.validFrom);
      }
    }

    const edgesByUpdatedAt = new Map<string, AtlasEdgeInput[]>();
    for (const e of activeEdges) {
      const ts = e.updatedAt || e.validFrom || fallbackNow;
      const bucket = edgesByUpdatedAt.get(ts) ?? [];
      bucket.push(toEdgeInput(e));
      edgesByUpdatedAt.set(ts, bucket);
    }
    for (const [ts, edgeBatch] of edgesByUpdatedAt.entries()) {
      atlas.applyDelta({ edges: edgeBatch }, ts);
    }

    const nodeSnapById = new Map(snapshot.nodes.map((n) => [n.id, n]));
    for (const se of supersededEdges) {
      if (!atlas.getEdge(se.id)) {
        try {
          atlas.applyDelta({ edges: [toEdgeInput(se)] }, se.validFrom || se.supersededAt!);
        } catch {
          continue;
        }
      }
      if (atlas.getEdge(se.id) && !atlas.getEdge(se.id)!.supersededAt) {
        atlas.removeEdge(se.id, se.supersededAt!);
        const targetSnap = nodeSnapById.get(se.to);
        if (targetSnap && !targetSnap.supersededAt && atlas.getNode(se.to)?.supersededAt) {
          atlas.applyDelta(
            {
              nodes: [
                {
                  id: targetSnap.id,
                  plane: targetSnap.plane,
                  stratum: targetSnap.stratum,
                  kind: targetSnap.kind,
                  name: targetSnap.name,
                  summary: targetSnap.summary,
                  tags: [...targetSnap.tags],
                  principalAcl: [...targetSnap.principalAcl],
                  reinforcements: 0,
                  confidence: targetSnap.confidence,
                  sourceTrust: targetSnap.sourceTrust,
                  ...(targetSnap.steps?.length ? { steps: [...targetSnap.steps] } : {}),
                  ...(targetSnap.skillGateStatus ? { skillGateStatus: targetSnap.skillGateStatus } : {}),
                  ...(targetSnap.archivedAt ? { archivedAt: targetSnap.archivedAt } : {}),
                },
              ],
            },
            targetSnap.updatedAt || fallbackNow,
          );
        }
      }
    }

    for (const n of snapshot.nodes) {
      if (n.supersededAt) {
        atlas.supersedeNode(n.id, n.supersededBy ?? undefined, n.supersededAt);
      } else if (n.archivedAt && !atlas.getNode(n.id)?.archivedAt) {
        atlas.archiveNode(n.id, n.archivedAt);
      }
    }
  };

  if (!mindJournalPath) {
    return { exportAtlas, importAtlas };
  }

  const exportMindJournal = (): EpistemicJudgmentEntry[] => {
    if (!fs.existsSync(mindJournalPath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(mindJournalPath, "utf8")) as {
        entries?: EpistemicJudgmentEntry[];
      };
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries
        .filter(
          (e) => e && typeof e.id === "string" && typeof e.topicKey === "string" && typeof e.hypothesis === "string",
        )
        .map((e) => ({ ...e, evidenceNotes: Array.isArray(e.evidenceNotes) ? [...e.evidenceNotes] : [] }));
    } catch {
      return [];
    }
  };

  const importMindJournal = (entries: EpistemicJudgmentEntry[]): void => {
    const dir = path.dirname(mindJournalPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const counts = { sandbox: 0, crystallized: 0, falsified: 0, superseded: 0 };
    const cleanEntries = entries.map((e) => {
      counts[e.status] = (counts[e.status] ?? 0) + 1;
      return {
        id: e.id,
        topicKey: e.topicKey,
        surface: e.surface,
        hypothesis: e.hypothesis,
        rationale: e.rationale,
        status: e.status,
        stratum: e.stratum,
        confidence: e.confidence,
        confirmations: e.confirmations,
        contradictions: e.contradictions,
        evidenceNotes: Array.isArray(e.evidenceNotes) ? [...e.evidenceNotes] : [],
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        ...(e.supersededBy ? { supersededBy: e.supersededBy } : {}),
      };
    });
    const updatedAt =
      cleanEntries[cleanEntries.length - 1]?.updatedAt ?? new Date().toISOString();
    const payload = {
      charterVersion: "1.0" as const,
      updatedAt,
      counts,
      entries: cleanEntries,
      calibratedLessons: buildCalibratedLessonsFromEntries(cleanEntries, 6),
    };
    const tmp = `${mindJournalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, mindJournalPath);
    onMindJournalImported?.();
  };

  return {
    exportAtlas,
    importAtlas,
    exportMindJournal,
    importMindJournal,
  };
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
  private atlasPort?: AtlasMindSyncPort;

  constructor(private readonly opts: SugentP2HostServiceOptions) {
    this.metaPath = path.join(opts.dataDir, "sugent-kg", "sync-meta.json");
    this.ledgerPort = opts.ledgerPort;
    this.atlasPort = opts.atlasPort;
  }

  attachStewardshipLedgerPort(port: StewardshipLedgerSyncPort): void {
    this.ledgerPort = port;
  }

  attachAtlasSyncPort(port: AtlasMindSyncPort): void {
    this.atlasPort = port;
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
      ...(n.supersededAt ? { supersededAt: n.supersededAt } : {}),
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

  private buildAtlasNodeDigest(n: AtlasNode): string {
    return digestSyncPayload({
      id: n.id,
      plane: n.plane,
      stratum: n.stratum,
      kind: n.kind,
      name: n.name,
      summary: n.summary,
      tags: n.tags,
      principalAcl: n.principalAcl,
      reinforcements: n.reinforcements,
      confidence: n.confidence,
      sourceTrust: n.sourceTrust,
      steps: n.steps ?? null,
      skillGateStatus: n.skillGateStatus ?? null,
      updatedAt: n.updatedAt,
      supersededAt: n.supersededAt ?? null,
      supersededBy: n.supersededBy ?? null,
      archivedAt: n.archivedAt ?? null,
    });
  }

  private buildAtlasEdgeDigest(e: AtlasEdge): string {
    return digestSyncPayload({
      id: e.id,
      plane: e.plane,
      from: e.from,
      relation: e.relation,
      to: e.to,
      weight: e.weight,
      source: e.source,
      isMembraneEdge: Boolean(e.isMembraneEdge),
      membranePolicy: e.membranePolicy ?? null,
      principalAcl: e.principalAcl ?? null,
      validFrom: e.validFrom,
      updatedAt: e.updatedAt,
      supersededAt: e.supersededAt ?? null,
    });
  }

  private buildMindEntryDigest(m: EpistemicJudgmentEntry): string {
    return digestSyncPayload({
      id: m.id,
      topicKey: m.topicKey,
      surface: m.surface,
      hypothesis: m.hypothesis,
      rationale: m.rationale,
      status: m.status,
      stratum: m.stratum,
      confidence: m.confidence,
      confirmations: m.confirmations,
      contradictions: m.contradictions,
      evidenceNotes: m.evidenceNotes,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      supersededBy: m.supersededBy ?? null,
    });
  }

  private exportGraphSnapshot(): SyncableKnowledgeGraphSnapshot {
    const meta = this.readSyncMeta();
    const prevDigests = meta.itemDigests ?? {};
    const rawNodes = this.opts.knowledgeGraph.allNodes();
    const rawEdges = this.opts.knowledgeGraph.allEdges();

    const nodeSigs = rawNodes.map((n) => ({ n, key: `node:${n.id}`, sig: this.buildNodeDigest(n) }));
    const edgeSigs = rawEdges.map((e) => ({ e, key: `edge:${e.id}`, sig: this.buildEdgeDigest(e) }));

    const exportedAtlas = this.atlasPort?.exportAtlas();
    const exportedMind = this.atlasPort?.exportMindJournal?.();
    const atlasNodeSigs = (exportedAtlas?.nodes ?? []).map((n) => ({
      n,
      key: `atlas:node:${n.id}`,
      sig: this.buildAtlasNodeDigest(n),
    }));
    const atlasEdgeSigs = (exportedAtlas?.edges ?? []).map((e) => ({
      e,
      key: `atlas:edge:${e.id}`,
      sig: this.buildAtlasEdgeDigest(e),
    }));
    const mindSigs = (exportedMind ?? []).map((m) => ({
      m,
      key: `mind:${m.id}`,
      sig: this.buildMindEntryDigest(m),
    }));

    const dirty =
      nodeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig) ||
      edgeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig) ||
      atlasNodeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig) ||
      atlasEdgeSigs.some((x) => prevDigests[x.key]?.sig !== x.sig) ||
      mindSigs.some((x) => prevDigests[x.key]?.sig !== x.sig);

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
        supersededAt: n.supersededAt ?? null,
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

    let atlasSnapshot: SyncableAtlasSnapshotV2 | undefined;
    if (this.atlasPort && exportedAtlas) {
      const syncAtlasNodes: SyncableAtlasNode[] = atlasNodeSigs.map(({ n, key, sig }) => {
        const prev = prevDigests[key];
        const clock = prev && prev.sig === sig ? prev.clock : snapshotClock;
        nextDigests[key] = { clock, sig };
        return {
          id: n.id,
          plane: n.plane,
          stratum: n.stratum,
          kind: n.kind,
          name: n.name,
          summary: n.summary,
          tags: [...n.tags],
          principalAcl: [...n.principalAcl],
          reinforcements: n.reinforcements,
          confidence: n.confidence,
          sourceTrust: n.sourceTrust,
          ...(n.steps?.length ? { steps: [...n.steps] } : {}),
          ...(n.skillGateStatus ? { skillGateStatus: n.skillGateStatus } : {}),
          updatedAt: n.updatedAt,
          supersededAt: n.supersededAt ?? null,
          supersededBy: n.supersededBy ?? null,
          archivedAt: n.archivedAt ?? null,
          lamportClock: clock,
        };
      });

      const syncAtlasEdges: SyncableAtlasEdge[] = atlasEdgeSigs.map(({ e, key, sig }) => {
        const prev = prevDigests[key];
        const clock = prev && prev.sig === sig ? prev.clock : snapshotClock;
        nextDigests[key] = { clock, sig };
        return {
          id: e.id,
          plane: e.plane,
          from: e.from,
          relation: e.relation,
          to: e.to,
          weight: e.weight,
          source: e.source,
          ...(e.isMembraneEdge ? { isMembraneEdge: true } : {}),
          membranePolicy: e.membranePolicy ?? null,
          ...(e.principalAcl?.length ? { principalAcl: [...e.principalAcl] } : {}),
          validFrom: e.validFrom,
          updatedAt: e.updatedAt,
          supersededAt: e.supersededAt ?? null,
          lamportClock: clock,
        };
      });

      let mindJournal: SyncableAtlasSnapshotV2["mindJournal"] | undefined;
      if (exportedMind !== undefined) {
        const syncMindEntries: SyncableMindJournalEntry[] = mindSigs.map(({ m, key, sig }) => {
          const prev = prevDigests[key];
          const clock = prev && prev.sig === sig ? prev.clock : snapshotClock;
          nextDigests[key] = { clock, sig };
          return {
            ...m,
            evidenceNotes: [...m.evidenceNotes],
            lamportClock: clock,
          };
        });
        const maxUpdatedAt = syncMindEntries.reduce(
          (acc, entry) => (entry.updatedAt > acc ? entry.updatedAt : acc),
          "",
        );
        mindJournal = {
          charterVersion: "1.0",
          updatedAt: maxUpdatedAt || new Date().toISOString(),
          entries: syncMindEntries,
        };
      }

      atlasSnapshot = {
        version: 2,
        nodes: syncAtlasNodes,
        edges: syncAtlasEdges,
        ...(mindJournal ? { mindJournal } : {}),
      };
    }

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
      ...(atlasSnapshot ? { schemaVersion: 2 as const } : {}),
      lamportClock: snapshotClock,
      deviceId: meta.deviceId,
      nodes,
      edges,
      ...(stewardshipLedger ? { stewardshipLedger } : {}),
      ...(atlasSnapshot ? { atlasSnapshot } : {}),
    };
  }

  private applyGraphSnapshot(merged: SyncableKnowledgeGraphSnapshot): void {
    const itemDigests: Record<string, { clock: number; sig: string }> = {};
    const atlasTombstonedIds = new Map<string, string>();
    if (merged.atlasSnapshot) {
      for (const an of merged.atlasSnapshot.nodes) {
        const deadTs = an.supersededAt || an.archivedAt;
        if (deadTs) {
          atlasTombstonedIds.set(an.id, deadTs);
        }
      }
    }

    const restoredNodes: KGNode[] = merged.nodes.map((n) => {
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
      const effectiveSupersededAt = n.supersededAt || atlasTombstonedIds.get(n.id);
      const node: KGNode = {
        id: n.id,
        kind,
        name: n.label,
        summary: typeof props.summary === "string" ? props.summary : "",
        tags,
        reinforcements,
        ...(steps && steps.length > 0 ? { steps } : {}),
        ...(skillGateStatus ? { skillGateStatus } : {}),
        ...(effectiveSupersededAt ? { supersededAt: effectiveSupersededAt } : {}),
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

    if (merged.atlasSnapshot && this.atlasPort) {
      const nodeClocks = new Map<string, number>();
      const restoredAtlasNodes: AtlasNode[] = merged.atlasSnapshot.nodes.map((sn) => {
        const clock =
          typeof sn.lamportClock === "number" && sn.lamportClock > 0
            ? sn.lamportClock
            : merged.lamportClock;
        nodeClocks.set(sn.id, clock);
        return {
          id: sn.id,
          plane: sn.plane,
          stratum: sn.stratum,
          kind: sn.kind,
          name: sn.name,
          summary: sn.summary,
          tags: Array.isArray(sn.tags) ? sn.tags.map(String) : [],
          principalAcl: Array.isArray(sn.principalAcl) && sn.principalAcl.length > 0
            ? [...sn.principalAcl]
            : ["sugent_self", "owner:M"],
          reinforcements:
            typeof sn.reinforcements === "number" && Number.isFinite(sn.reinforcements)
              ? sn.reinforcements
              : 1,
          confidence:
            typeof sn.confidence === "number" && Number.isFinite(sn.confidence)
              ? sn.confidence
              : 0.8,
          sourceTrust: sn.sourceTrust || "owner_confirmed",
          ...(sn.steps?.length ? { steps: [...sn.steps] } : {}),
          ...(sn.skillGateStatus ? { skillGateStatus: sn.skillGateStatus } : {}),
          updatedAt: sn.updatedAt,
          ...(sn.supersededAt ? { supersededAt: sn.supersededAt } : {}),
          ...(sn.supersededBy ? { supersededBy: sn.supersededBy } : {}),
          ...(sn.archivedAt ? { archivedAt: sn.archivedAt } : {}),
        };
      });

      const edgeClocks = new Map<string, number>();
      const restoredAtlasEdges: AtlasEdge[] = merged.atlasSnapshot.edges.map((se) => {
        const clock =
          typeof se.lamportClock === "number" && se.lamportClock > 0
            ? se.lamportClock
            : merged.lamportClock;
        edgeClocks.set(se.id, clock);
        return {
          id: se.id,
          plane: se.plane,
          from: se.from,
          relation: se.relation,
          to: se.to,
          weight: typeof se.weight === "number" && Number.isFinite(se.weight) ? se.weight : 1,
          source: se.source || "e2ee_sync",
          ...(se.isMembraneEdge ? { isMembraneEdge: true } : {}),
          ...(se.membranePolicy ? { membranePolicy: se.membranePolicy } : {}),
          ...(se.principalAcl?.length ? { principalAcl: [...se.principalAcl] } : {}),
          validFrom: se.validFrom,
          updatedAt: se.updatedAt,
          ...(se.supersededAt ? { supersededAt: se.supersededAt } : {}),
        };
      });

      this.atlasPort.importAtlas({ nodes: restoredAtlasNodes, edges: restoredAtlasEdges });

      const postImportAtlas = this.atlasPort.exportAtlas();
      for (const n of postImportAtlas.nodes) {
        itemDigests[`atlas:node:${n.id}`] = {
          clock: nodeClocks.get(n.id) ?? merged.lamportClock,
          sig: this.buildAtlasNodeDigest(n),
        };
      }
      for (const e of postImportAtlas.edges) {
        itemDigests[`atlas:edge:${e.id}`] = {
          clock: edgeClocks.get(e.id) ?? merged.lamportClock,
          sig: this.buildAtlasEdgeDigest(e),
        };
      }

      if (merged.atlasSnapshot.mindJournal && this.atlasPort.importMindJournal) {
        const mindClocks = new Map<string, number>();
        const restoredMindEntries: EpistemicJudgmentEntry[] =
          merged.atlasSnapshot.mindJournal.entries.map((me) => {
            const clock =
              typeof me.lamportClock === "number" && me.lamportClock > 0
                ? me.lamportClock
                : merged.lamportClock;
            mindClocks.set(me.id, clock);
            const { lamportClock: _ignoredClock, ...entry } = me;
            return {
              ...entry,
              evidenceNotes: Array.isArray(entry.evidenceNotes) ? [...entry.evidenceNotes] : [],
            };
          });
        this.atlasPort.importMindJournal(restoredMindEntries);
        const postImportMind = this.atlasPort.exportMindJournal
          ? this.atlasPort.exportMindJournal()
          : restoredMindEntries;
        for (const m of postImportMind) {
          itemDigests[`mind:${m.id}`] = {
            clock: mindClocks.get(m.id) ?? merged.lamportClock,
            sig: this.buildMindEntryDigest(m),
          };
        }
      }
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
