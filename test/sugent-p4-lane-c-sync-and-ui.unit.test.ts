import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergeKnowledgeGraphSnapshots,
  openZeroKnowledgeEnvelope,
  type SyncableKnowledgeGraphSnapshot,
  type ZeroKnowledgeEnvelope,
} from "../src/sugent/e2ee-sync.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { createP2GatewayHandlers } from "../src/sugent/p2-gateway-routes.js";
import { SugentP2HostService } from "../src/sugent/p2-host-service.js";
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import type { LedgerSnapshot } from "../src/sugent/stewardship-ledger.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("Wave P4 Lane C: Lossless E2EE Sync & Workbench UI", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  function mkHost(fetchImpl: typeof fetch) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p4c-"));
    dirs.push(dir);
    const kg = new SugentKnowledgeGraph(path.join(dir, "sugent-kg"));
    const service = new SugentP2HostService({
      dataDir: dir,
      providers: new ProviderRegistry(dir),
      modelCatalog: new SugentModelCatalog(dir),
      localBudgets: new LocalBudgetLedger(dir),
      knowledgeGraph: kg,
      getDefaultModel: () => "deepseek-chat",
      getFetch: () => fetchImpl,
    });
    return { dir, kg, service };
  }

  function makeClaims(sub = "usr_p4c"): SugentBrokerClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: `${HTTPS_PROTO}auth.sugent.example`,
      sub,
      aud: "sugent-desktop",
      idp: "wechat",
      plan: "pro",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.example/v1`,
      iat: now,
      exp: now + 3600,
    };
  }

  it("preserves per-item Lamport clocks for unchanged items across pushSync batches", async () => {
    const bucket = new Map<string, string>();
    const mockFetch: typeof fetch = async (input, init) => {
      const k = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        bucket.set(k, String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const raw = bucket.get(k);
      return raw ? new Response(raw, { status: 200 }) : new Response("not found", { status: 404 });
    };
    const { dir, kg, service } = mkHost(mockFetch);
    kg.applyDelta({
      nodes: [
        { id: "n:stable", kind: "concept", name: "Stable", summary: "unchanged", tags: ["a"] },
        { id: "n:mutable", kind: "concept", name: "Mutable", summary: "v1", tags: ["b"] },
      ],
      edges: [],
    });

    const claims = makeClaims();
    const pass = "correct-horse-battery-staple-p4c";
    await service.pushSync({ claims, bearerToken: "tok", passphrase: pass });

    const env1 = JSON.parse([...bucket.values()][0]!) as ZeroKnowledgeEnvelope;
    const snap1 = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope: env1,
      passphrase: pass,
      expectedSubjectSub: claims.sub,
      expectedPayloadType: "knowledge-graph",
    }).payload;
    const stableClock1 = snap1.nodes.find((n) => n.id === "n:stable")?.lamportClock;
    const mutableClock1 = snap1.nodes.find((n) => n.id === "n:mutable")?.lamportClock;
    expect(stableClock1).toBe(2);
    expect(mutableClock1).toBe(2);

    kg.applyDelta({
      nodes: [{ id: "n:mutable", kind: "concept", name: "Mutable", summary: "v2", tags: ["b"] }],
      edges: [],
    });
    bucket.clear();
    await service.pushSync({ claims, bearerToken: "tok", passphrase: pass });

    const env2 = JSON.parse([...bucket.values()][0]!) as ZeroKnowledgeEnvelope;
    const snap2 = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope: env2,
      passphrase: pass,
      expectedSubjectSub: claims.sub,
      expectedPayloadType: "knowledge-graph",
    }).payload;
    expect(snap2.nodes.find((n) => n.id === "n:stable")?.lamportClock).toBe(2);
    expect(snap2.nodes.find((n) => n.id === "n:mutable")?.lamportClock).toBe(3);

    const meta = JSON.parse(fs.readFileSync(path.join(dir, "sugent-kg", "sync-meta.json"), "utf8"));
    expect(meta.itemDigests["node:n:stable"].clock).toBe(2);
    expect(meta.itemDigests["node:n:mutable"].clock).toBe(3);
  });
  it("round-trips skillGateStatus, provenanceSource, and stewardshipLedger via E2EE sync", async () => {
    const bucket = new Map<string, string>();
    const mockFetch: typeof fetch = async (input, init) => {
      const k = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        bucket.set(k, String(init?.body ?? ""));
        return new Response(null, { status: 200 });
      }
      const raw = bucket.get(k);
      return raw ? new Response(raw, { status: 200 }) : new Response("not found", { status: 404 });
    };

    const devA = mkHost(mockFetch);
    const devB = mkHost(mockFetch);
    let ledgerA: LedgerSnapshot = {
      version: 1,
      updatedAt: "2026-11-20T00:00:00Z",
      relationships: [
        {
          id: "rel-vip",
          partition: "work_project",
          subjectType: "key_contact",
          name: "Alex",
          roleTag: "client",
          trustTier: "L2_suspend_approval",
          verifiedObservations: 2,
          taboos: [],
          preferences: ["concise"],
          openFavors: [],
          updatedAt: "2026-11-20T00:00:00Z",
        },
      ],
      goals: [
        {
          id: "g1",
          partition: "work_project",
          title: "Launch P4",
          northStarCriterion: "All tests green",
          status: "active",
          lastProgressAt: "2026-11-20T00:00:00Z",
          stallThresholdDays: 7,
        },
      ],
      guardrails: [
        {
          id: "gr1",
          partition: "personal_life",
          kind: "tombstone",
          statement: "Never quote unverified price",
          enforcement: "warn_before_send",
          createdAt: "2026-11-20T00:00:00Z",
        },
      ],
      commitments: [],
      resources: [],
    };
    const importedBox: { value: LedgerSnapshot | null } = { value: null };
    devA.service.attachStewardshipLedgerPort({
      exportLedger: () => ledgerA,
      importLedger: (s) => { ledgerA = s; },
    });
    devB.service.attachStewardshipLedgerPort({
      exportLedger: () => importedBox.value ?? { version: 1, updatedAt: "2026-11-01T00:00:00Z", relationships: [], goals: [], guardrails: [], commitments: [], resources: [] },
      importLedger: (s) => { importedBox.value = s; },
    });

    devA.kg.applyDelta({
      nodes: [
        { id: "wf:deploy", kind: "workflow", name: "Deploy", summary: "Run checks", tags: ["ops"], steps: ["test", "build"], reinforcements: 4, skillGateStatus: "approved" },
        { id: "proj:x", kind: "project", name: "ProjX", summary: "Target", tags: [] },
      ],
      edges: [
        { from: "wf:deploy", relation: "targets", to: "proj:x", source: "steward_review", weight: 3 },
      ],
    });

    const claims = makeClaims();
    const pass = "correct-horse-battery-staple-p4c";
    await devA.service.pushSync({ claims, bearerToken: "tok", passphrase: pass });
    await devB.service.pullSync({ claims, bearerToken: "tok", passphrase: pass });

    const restoredNode = devB.kg.getNode("wf:deploy");
    expect(restoredNode?.skillGateStatus).toBe("approved");
    expect(restoredNode?.reinforcements).toBe(4);
    const restoredEdge = devB.kg.allEdges().find((e) => e.from === "wf:deploy" && e.to === "proj:x");
    expect(restoredEdge?.source).toBe("steward_review");
    expect(restoredEdge?.weight).toBe(3);
    expect(importedBox.value?.relationships[0]?.name).toBe("Alex");
    expect(importedBox.value?.guardrails[0]?.kind).toBe("tombstone");
  });
  it("merges reinforcements, edge weights/provenance, and ledger 5 arrays with max 3 active goals", () => {
    const mkGoal = (id: string, ts: string) => ({
      id,
      partition: "work_project" as const,
      title: id,
      northStarCriterion: "done",
      status: "active" as const,
      lastProgressAt: ts,
      stallThresholdDays: 7,
    });
    const local: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 5,
      deviceId: "dev-a",
      nodes: [
        { id: "n1", type: "workflow", label: "WF", properties: { reinforcements: 6 }, validFrom: "2026-11-10T00:00:00Z", supersededAt: null, updatedAt: "2026-11-10T00:00:00Z", lamportClock: 5 },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", relation: "uses", weight: 4, provenanceSource: "local_src", validFrom: "2026-11-10T00:00:00Z", supersededAt: null, updatedAt: "2026-11-10T00:00:00Z", lamportClock: 4 },
      ],
      stewardshipLedger: {
        version: 1,
        updatedAt: "2026-11-10T00:00:00Z",
        relationships: [],
        goals: [mkGoal("g1", "2026-11-01T00:00:00Z"), mkGoal("g2", "2026-11-05T00:00:00Z")],
        guardrails: [{ id: "gr1", partition: "personal_life", kind: "hard_redline", statement: "old", enforcement: "block_and_alert", createdAt: "2026-11-01T00:00:00Z" }],
        commitments: [],
        resources: [],
      },
    };
    const remote: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 7,
      deviceId: "dev-b",
      nodes: [
        { id: "n1", type: "workflow", label: "WF v2", properties: { reinforcements: 2 }, validFrom: "2026-11-10T00:00:00Z", supersededAt: null, updatedAt: "2026-11-12T00:00:00Z", lamportClock: 7 },
      ],
      edges: [
        { id: "e1", source: "n1", target: "n2", relation: "uses", weight: 2, provenanceSource: "remote_win", validFrom: "2026-11-10T00:00:00Z", supersededAt: null, updatedAt: "2026-11-12T00:00:00Z", lamportClock: 7 },
      ],
      stewardshipLedger: {
        version: 1,
        updatedAt: "2026-11-12T00:00:00Z",
        relationships: [],
        goals: [mkGoal("g3", "2026-11-08T00:00:00Z"), mkGoal("g4", "2026-11-12T00:00:00Z")],
        guardrails: [{ id: "gr1", partition: "personal_life", kind: "hard_redline", statement: "newer", enforcement: "block_and_alert", createdAt: "2026-11-11T00:00:00Z" }],
        commitments: [],
        resources: [],
      },
    };
    const merged = mergeKnowledgeGraphSnapshots(local, remote, "dev-a");
    expect(merged.nodes[0]?.label).toBe("WF v2");
    expect(merged.nodes[0]?.properties.reinforcements).toBe(6);
    expect(merged.edges[0]?.weight).toBe(4);
    expect(merged.edges[0]?.provenanceSource).toBe("remote_win");
    expect(merged.stewardshipLedger?.guardrails[0]?.statement).toBe("newer");
    const goalStatuses = Object.fromEntries((merged.stewardshipLedger?.goals ?? []).map((g) => [g.id, g.status]));
    expect(goalStatuses).toEqual({ g1: "paused", g2: "active", g3: "active", g4: "active" });
  });
  it("performs pull-before-put merge in handleSyncPush and falls back cleanly on unencrypted stubs", async () => {
    const claims = makeClaims("usr_merge_push");
    const pass = "correct-horse-battery-staple-p4c";
    let storedBlob = "";
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        storedBlob = String(init?.body ?? "");
        return new Response(JSON.stringify({ stored: true }), { status: 200 });
      }
      return storedBlob ? new Response(storedBlob, { status: 200 }) : new Response("not found", { status: 404 });
    };

    const snapRemote: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 3,
      deviceId: "dev-remote",
      nodes: [{ id: "n:remote", type: "concept", label: "RemoteFact", properties: {}, validFrom: "2026-11-10T00:00:00Z", supersededAt: null, updatedAt: "2026-11-10T00:00:00Z", lamportClock: 3 }],
      edges: [],
    };
    const remoteHandler = createP2GatewayHandlers({
      catalog: { getModelPricing: () => null },
      getKnowledgeGraphSnapshot: async () => snapRemote,
      applyKnowledgeGraphSnapshot: async () => {},
      fetchImpl,
      kdfIterations: 100_000,
    });
    await remoteHandler.handleSyncPush({ claims, bearerToken: "t", passphrase: pass });

    const appliedBox: { value: SyncableKnowledgeGraphSnapshot | null } = { value: null };
    const snapLocal: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 2,
      deviceId: "dev-local",
      nodes: [{ id: "n:local", type: "concept", label: "LocalFact", properties: {}, validFrom: "2026-11-11T00:00:00Z", supersededAt: null, updatedAt: "2026-11-11T00:00:00Z", lamportClock: 2 }],
      edges: [],
    };
    const localHandler = createP2GatewayHandlers({
      catalog: { getModelPricing: () => null },
      getKnowledgeGraphSnapshot: async () => snapLocal,
      applyKnowledgeGraphSnapshot: async (m) => { appliedBox.value = m; },
      fetchImpl,
      kdfIterations: 100_000,
    });
    const pushed = await localHandler.handleSyncPush({ claims, bearerToken: "t", passphrase: pass });
    expect(pushed.statusCode).toBe(200);
    expect(appliedBox.value?.nodes.map((n) => n.id).sort()).toEqual(["n:local", "n:remote"]);

    // Unencrypted / mock stub without v === 1 falls back cleanly to pushing local snapshot
    storedBlob = JSON.stringify({ stub: true, ok: true });
    const fallbackPush = await localHandler.handleSyncPush({ claims, bearerToken: "t", passphrase: pass });
    expect(fallbackPush.statusCode).toBe(200);
    expect(fallbackPush.body.data?.lamportClock).toBe(2);
  });

  it("wires concierge-drawer in ui/main.js, turnHistory in ui/companion.js, and P4 cards in jarvis-workbench.js", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const mainSrc = fs.readFileSync(path.join(root, "ui", "main.js"), "utf8");
    const compSrc = fs.readFileSync(path.join(root, "ui", "companion.js"), "utf8");
    const wbSrc = fs.readFileSync(path.join(root, "ui", "components", "jarvis-workbench.js"), "utf8");

    expect(mainSrc).toContain('import "./components/concierge-drawer.js"');
    expect(compSrc).toContain("turnHistory");
    expect(compSrc).toContain("history: turnHistory");
    expect(compSrc).toContain(".slice(-10)");

    expect(wbSrc).toContain("/steward/converse");
    expect(wbSrc).toContain("/steward/dropzone");
    expect(wbSrc).toContain("__openSugentConciergeDrawer");
    expect(wbSrc).toContain("groupDigests");
    expect(wbSrc).toContain("/steward/group-scribe/decide");
    expect(wbSrc).toContain("relationships");
    expect(wbSrc).toContain("guardrails");
    expect(wbSrc).toContain("/steward/guardrails");
    expect(wbSrc).toContain("trustKgStats");
    expect(wbSrc).toContain("atlasStats");
  });
});
