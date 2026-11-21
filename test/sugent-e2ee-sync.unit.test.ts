import { describe, expect, it } from "vitest";
import {
  ZeroKnowledgeSyncClient,
  assertBrokerSyncEntitlement,
  deriveSyncKeyHierarchy,
  mergeKnowledgeGraphSnapshots,
  openZeroKnowledgeEnvelope,
  sanitizeConfigSnapshotForSync,
  sealZeroKnowledgeEnvelope,
  type SyncableKnowledgeGraphSnapshot,
} from "../src/sugent/e2ee-sync.js";
import { createP2GatewayHandlers } from "../src/sugent/p2-gateway-routes.js";
import { buildByokSyncViewModel } from "../src/sugent/byok-sync-viewmodel.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("P2 Zero-Knowledge E2EE Sync, CRDT Merge & Gateway Handlers", () => {
  const TEST_ITERS = 100_000;
  const nowSec = Math.floor(Date.now() / 1000);

  it("seals/opens AES-256-GCM envelope with AAD binding and strips plaintext BYOK keys", () => {
    const keys = deriveSyncKeyHierarchy({
      passphrase: "correct-horse-battery-staple-2026",
      kdfIterations: TEST_ITERS,
    });
    const env = sealZeroKnowledgeEnvelope({
      plaintextPayload: { nodes: [{ id: "n1", label: "TopSecretDeal" }], edges: [] },
      keyHierarchy: keys,
      subjectSub: "usr_opc_01",
      payloadType: "knowledge-graph",
      lamportClock: 5,
      deviceId: "mac-studio",
    });

    expect(JSON.stringify(env)).not.toContain("TopSecretDeal");

    const opened = openZeroKnowledgeEnvelope<{ nodes: Array<{ label: string }> }>({
      envelope: env,
      passphrase: "correct-horse-battery-staple-2026",
      expectedSubjectSub: "usr_opc_01",
      expectedPayloadType: "knowledge-graph",
    });
    expect(opened.payload.nodes[0]?.label).toBe("TopSecretDeal");

    // Tampered lamportClock fails AAD verification
    expect(() =>
      openZeroKnowledgeEnvelope({
        envelope: { ...env, lamportClock: 1 },
        passphrase: "correct-horse-battery-staple-2026",
        expectedSubjectSub: "usr_opc_01",
        expectedPayloadType: "knowledge-graph",
      }),
    ).toThrow(/AAD|authentication/i);

    // Sanitizer strips apiKey by default
    const sanitized = sanitizeConfigSnapshotForSync(
      { openai: { baseUrl: `${HTTPS_PROTO}api.openai.com/v1`, apiKey: "tok-proj-demo-999" } },
      { includeEncryptedApiKeys: false },
    );
    expect(JSON.stringify(sanitized)).not.toContain("tok-proj-demo-999");
  });

  it("merges KG snapshots commutatively, gates free tier on managed sync, and wires gateway + viewmodel", async () => {
    const snapA: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 10,
      deviceId: "dev-a",
      nodes: [
        {
          id: "n-price",
          type: "fact",
          label: "Tier v1",
          properties: {},
          validFrom: "2026-01-01T00:00:00Z",
          supersededAt: "2026-11-10T00:00:00Z",
          updatedAt: "2026-11-10T00:00:00Z",
          lamportClock: 10,
        },
      ],
      edges: [],
    };
    const snapB: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 9,
      deviceId: "dev-b",
      nodes: [
        {
          id: "n-price",
          type: "fact",
          label: "Tier v1",
          properties: {},
          validFrom: "2026-01-01T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-09T00:00:00Z",
          lamportClock: 9,
        },
        {
          id: "n-lead",
          type: "contact",
          label: "Client CTO",
          properties: {},
          validFrom: "2026-11-11T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-11T00:00:00Z",
          lamportClock: 9,
        },
      ],
      edges: [],
    };

    const ab = mergeKnowledgeGraphSnapshots(snapA, snapB, "dev-a");
    const ba = mergeKnowledgeGraphSnapshots(snapB, snapA, "dev-a");
    expect(ab.nodes).toEqual(ba.nodes);
    expect(ab.nodes.find((n) => n.id === "n-price")?.supersededAt).toBe("2026-11-10T00:00:00Z");

    const freeClaims: SugentBrokerClaims = {
      iss: `${HTTPS_PROTO}auth.sugent.app`,
      sub: "usr_free_001",
      aud: "sugent-desktop",
      idp: "wechat",
      plan: "free",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/v1`,
      exp: nowSec + 3600,
      iat: nowSec,
    };
    expect(() => assertBrokerSyncEntitlement(freeClaims, nowSec)).toThrow(/SYNC_PLAN_UPGRADE_REQUIRED/);

    let storedBlob = "";
    const syncClient = new ZeroKnowledgeSyncClient({
      kdfIterations: TEST_ITERS,
      fetchImpl: async (_u, init) => {
        if (init?.method === "PUT") {
          storedBlob = String(init.body);
          return new Response(null, { status: 200 });
        }
        return new Response(storedBlob, { status: 200 });
      },
    });

    const proClaims: SugentBrokerClaims = { ...freeClaims, sub: "usr_pro_001", plan: "pro" };
    await syncClient.pushKnowledgeGraph({
      claims: proClaims,
      bearerToken: "mock-token",
      passphrase: "opc-sovereign-vault-key",
      snapshot: snapB,
    });
    expect(storedBlob).not.toContain("Client CTO");

    const pulled = await syncClient.pullAndMergeKnowledgeGraph({
      claims: proClaims,
      bearerToken: "mock-token",
      passphrase: "opc-sovereign-vault-key",
      localSnapshot: snapA,
    });
    expect(pulled.mergedSnapshot.nodes).toHaveLength(2);

    const handlers = createP2GatewayHandlers({
      catalog: { getModelPricing: () => ({ inputCostPer1M: 0.3, outputCostPer1M: 1.2 }) },
      getKnowledgeGraphSnapshot: async () => snapA,
      applyKnowledgeGraphSnapshot: async () => {},
      kdfIterations: TEST_ITERS,
    });
    const freePush = await handlers.handleSyncPush({
      claims: freeClaims,
      bearerToken: "t",
      passphrase: "opc-sovereign-vault-key",
    });
    expect(freePush.statusCode).toBe(403);

    const vm = buildByokSyncViewModel({ diagnostics: null, simulation: null, claims: proClaims });
    expect(vm.syncEntitlementState).toBe("unlocked-pro");
  });
});

