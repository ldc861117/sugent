import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import type { SugentBrokerClaims } from "./auth-broker-contract.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";

export type { SugentBrokerClaims } from "./auth-broker-contract.js";

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SyncPayloadType = "knowledge-graph" | "config-snapshot" | "byok-vault";

export interface SyncKeyHierarchy {
  kdfSaltB64: string;
  kdfIterations: number;
  keyFingerprint: string;
  kgKek: Buffer;
  vaultKek: Buffer;
}

export interface ZeroKnowledgeEnvelope {
  v: 1;
  alg: "PBKDF2-HKDF-SHA256+A256GCM";
  kdf: {
    saltB64: string;
    iterations: number;
  };
  keyFingerprint: string;
  sub: string;
  orgId?: string;
  deviceId: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
  createdAtIso: string;
  wrappedDek: {
    ivB64: string;
    ciphertextB64: string;
    tagB64: string;
  };
  payload: {
    ivB64: string;
    ciphertextB64: string;
    tagB64: string;
  };
}

export interface SyncableKGNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  validFrom: string;
  validUntil?: string | null;
  supersededAt: string | null;
  updatedAt: string;
  lamportClock: number;
}

export interface SyncableKGEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight?: number;
  provenanceSource?: string;
  validFrom: string;
  validUntil?: string | null;
  supersededAt: string | null;
  updatedAt: string;
  lamportClock: number;
}

export interface SyncableKnowledgeGraphSnapshot {
  lamportClock: number;
  deviceId: string;
  nodes: SyncableKGNode[];
  edges: SyncableKGEdge[];
  stewardshipLedger?: LedgerSnapshot;
}

export function deriveSyncKeyHierarchy(params: {
  passphrase: string;
  saltB64?: string;
  kdfIterations?: number;
}): SyncKeyHierarchy {
  const normalizedPassphrase = params.passphrase.normalize("NFKC").trim();
  if (normalizedPassphrase.length < 12) {
    throw new Error("E2EE sync passphrase must be at least 12 characters.");
  }

  const iterations = params.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be >= ${MIN_PBKDF2_ITERATIONS}.`);
  }

  const salt = params.saltB64
    ? Buffer.from(params.saltB64, "base64url")
    : randomBytes(SALT_BYTES);

  const masterKey = pbkdf2Sync(normalizedPassphrase, salt, iterations, KEY_BYTES, "sha256");

  const kgKek = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:kg-kek", "utf8"), KEY_BYTES),
  );
  const vaultKek = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:vault-kek", "utf8"), KEY_BYTES),
  );
  const fingerprintBytes = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:key-check", "utf8"), 16),
  );
  masterKey.fill(0);

  return {
    kdfSaltB64: salt.toString("base64url"),
    kdfIterations: iterations,
    keyFingerprint: fingerprintBytes.toString("hex"),
    kgKek,
    vaultKek,
  };
}

function buildCanonicalAad(meta: {
  v: 1;
  sub: string;
  orgId?: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: meta.v,
      sub: meta.sub,
      orgId: meta.orgId ?? null,
      payloadType: meta.payloadType,
      lamportClock: meta.lamportClock,
    }),
    "utf8",
  );
}

function aes256GcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { ivB64: string; ciphertextB64: string; tagB64: string } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ivB64: iv.toString("base64url"),
    ciphertextB64: ciphertext.toString("base64url"),
    tagB64: tag.toString("base64url"),
  };
}

function aes256GcmDecrypt(
  key: Buffer,
  box: { ivB64: string; ciphertextB64: string; tagB64: string },
  aad: Buffer,
): Buffer {
  const iv = Buffer.from(box.ivB64, "base64url");
  const tag = Buffer.from(box.tagB64, "base64url");
  if (iv.byteLength !== GCM_IV_BYTES || tag.byteLength !== GCM_TAG_BYTES) {
    throw new Error("Invalid AES-256-GCM IV or authentication tag length.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const ciphertext = Buffer.from(box.ciphertextB64, "base64url");
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sealZeroKnowledgeEnvelope<T>(params: {
  plaintextPayload: T;
  keyHierarchy: SyncKeyHierarchy;
  subjectSub: string;
  orgId?: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
  deviceId: string;
}): ZeroKnowledgeEnvelope {
  const aad = buildCanonicalAad({
    v: 1,
    sub: params.subjectSub,
    ...(params.orgId ? { orgId: params.orgId } : {}),
    payloadType: params.payloadType,
    lamportClock: params.lamportClock,
  });

  const dek = randomBytes(KEY_BYTES);
  const kek =
    params.payloadType === "byok-vault" ? params.keyHierarchy.vaultKek : params.keyHierarchy.kgKek;

  try {
    const wrappedDek = aes256GcmEncrypt(kek, dek, aad);
    const serialized = Buffer.from(JSON.stringify(params.plaintextPayload), "utf8");
    const encryptedPayload = aes256GcmEncrypt(dek, serialized, aad);

    return {
      v: 1,
      alg: "PBKDF2-HKDF-SHA256+A256GCM",
      kdf: {
        saltB64: params.keyHierarchy.kdfSaltB64,
        iterations: params.keyHierarchy.kdfIterations,
      },
      keyFingerprint: params.keyHierarchy.keyFingerprint,
      sub: params.subjectSub,
      ...(params.orgId ? { orgId: params.orgId } : {}),
      deviceId: params.deviceId,
      payloadType: params.payloadType,
      lamportClock: params.lamportClock,
      createdAtIso: new Date().toISOString(),
      wrappedDek,
      payload: encryptedPayload,
    };
  } finally {
    dek.fill(0);
  }
}

export function openZeroKnowledgeEnvelope<T>(params: {
  envelope: ZeroKnowledgeEnvelope;
  passphrase: string;
  expectedSubjectSub: string;
  expectedPayloadType: SyncPayloadType;
}): { lamportClock: number; deviceId: string; payload: T } {
  const { envelope } = params;
  if (envelope.sub !== params.expectedSubjectSub) {
    throw new Error(
      `Envelope subject mismatch: expected ${params.expectedSubjectSub}, got ${envelope.sub}`,
    );
  }
  if (envelope.payloadType !== params.expectedPayloadType) {
    throw new Error(
      `Envelope payloadType mismatch: expected ${params.expectedPayloadType}, got ${envelope.payloadType}`,
    );
  }

  const keys = deriveSyncKeyHierarchy({
    passphrase: params.passphrase,
    saltB64: envelope.kdf.saltB64,
    kdfIterations: envelope.kdf.iterations,
  });

  if (keys.keyFingerprint !== envelope.keyFingerprint) {
    throw new Error("Invalid E2EE passphrase or mismatched key fingerprint.");
  }

  const aad = buildCanonicalAad({
    v: envelope.v,
    sub: envelope.sub,
    ...(envelope.orgId ? { orgId: envelope.orgId } : {}),
    payloadType: envelope.payloadType,
    lamportClock: envelope.lamportClock,
  });

  const kek = envelope.payloadType === "byok-vault" ? keys.vaultKek : keys.kgKek;
  let dek: Buffer | null = null;
  try {
    dek = aes256GcmDecrypt(kek, envelope.wrappedDek, aad);
    const plaintextBytes = aes256GcmDecrypt(dek, envelope.payload, aad);
    return {
      lamportClock: envelope.lamportClock,
      deviceId: envelope.deviceId,
      payload: JSON.parse(plaintextBytes.toString("utf8")) as T,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`E2EE envelope AAD/authentication verification failed: ${detail}`);
  } finally {
    dek?.fill(0);
    keys.kgKek.fill(0);
    keys.vaultKek.fill(0);
  }
}

const SECRET_FIELD_PATTERN = /^(api[_-]?key|secret[_-]?key|access[_-]?token|authorization)$/i;

function stripSecretsRecursively(
  value: unknown,
  collectedSecrets: Record<string, string>,
  pathPrefix = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      stripSecretsRecursively(item, collectedSecrets, `${pathPrefix}[${idx}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    const cleanObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (SECRET_FIELD_PATTERN.test(k) && typeof v === "string" && v.length > 0) {
        collectedSecrets[nextPath] = v;
        continue;
      }
      cleanObj[k] = stripSecretsRecursively(v, collectedSecrets, nextPath);
    }
    return cleanObj;
  }
  return value;
}

export function sanitizeConfigSnapshotForSync<T extends Record<string, unknown>>(
  rawConfig: T,
  options: {
    includeEncryptedApiKeys: boolean;
    keyHierarchy?: SyncKeyHierarchy;
    subjectSub?: string;
    orgId?: string;
    lamportClock?: number;
    deviceId?: string;
  },
): {
  publicConfig: Record<string, unknown>;
  encryptedCredentialsVault: ZeroKnowledgeEnvelope | null;
} {
  const extractedSecrets: Record<string, string> = {};
  const publicConfig = stripSecretsRecursively(rawConfig, extractedSecrets) as Record<
    string,
    unknown
  >;

  if (!options.includeEncryptedApiKeys || Object.keys(extractedSecrets).length === 0) {
    return { publicConfig, encryptedCredentialsVault: null };
  }

  if (!options.keyHierarchy || !options.subjectSub || !options.deviceId) {
    throw new Error(
      "keyHierarchy, subjectSub, and deviceId are required when includeEncryptedApiKeys is true.",
    );
  }

  const encryptedCredentialsVault = sealZeroKnowledgeEnvelope({
    plaintextPayload: extractedSecrets,
    keyHierarchy: options.keyHierarchy,
    subjectSub: options.subjectSub,
    ...(options.orgId ? { orgId: options.orgId } : {}),
    payloadType: "byok-vault",
    lamportClock: options.lamportClock ?? 1,
    deviceId: options.deviceId,
  });

  return { publicConfig, encryptedCredentialsVault };
}

export function assertBrokerSyncEntitlement(
  claims: SugentBrokerClaims,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
  clockSkewToleranceSeconds = 60,
): void {
  if (claims.exp + clockSkewToleranceSeconds <= nowEpochSeconds) {
    throw new Error("SYNC_AUTH_TOKEN_EXPIRED: Sugent Broker token has expired.");
  }
  if (claims.plan !== "pro" && claims.plan !== "team") {
    throw new Error(
      "SYNC_PLAN_UPGRADE_REQUIRED: Zero-knowledge cloud sync requires a Sugent Pro or Team subscription.",
    );
  }
  if (!claims.sync_endpoint) {
    throw new Error("SYNC_ENDPOINT_MISSING: Broker claims did not include a sync_endpoint.");
  }
}

function pickWinningRecord<
  T extends {
    id: string;
    lamportClock: number;
    updatedAt: string;
    supersededAt: string | null;
  },
>(a: T, b: T): T {
  const mergedSupersededAt =
    a.supersededAt && b.supersededAt
      ? a.supersededAt <= b.supersededAt
        ? a.supersededAt
        : b.supersededAt
      : (a.supersededAt ?? b.supersededAt);

  let winner: T;
  if (a.lamportClock !== b.lamportClock) {
    winner = a.lamportClock > b.lamportClock ? a : b;
  } else if (a.updatedAt !== b.updatedAt) {
    winner = a.updatedAt > b.updatedAt ? a : b;
  } else {
    const hashA = JSON.stringify(a);
    const hashB = JSON.stringify(b);
    winner = hashA >= hashB ? a : b;
  }

  return {
    ...winner,
    supersededAt: mergedSupersededAt,
  };
}

function mergeNodeRecords(a: SyncableKGNode, b: SyncableKGNode): SyncableKGNode {
  const merged = pickWinningRecord(a, b);
  const aReinf = typeof a.properties?.reinforcements === "number" && Number.isFinite(a.properties.reinforcements)
    ? a.properties.reinforcements
    : undefined;
  const bReinf = typeof b.properties?.reinforcements === "number" && Number.isFinite(b.properties.reinforcements)
    ? b.properties.reinforcements
    : undefined;
  if (aReinf === undefined && bReinf === undefined) return merged;
  return {
    ...merged,
    properties: {
      ...(merged.properties ?? {}),
      reinforcements: Math.max(aReinf ?? 0, bReinf ?? 0),
    },
  };
}

function mergeEdgeRecords(a: SyncableKGEdge, b: SyncableKGEdge): SyncableKGEdge {
  const merged = pickWinningRecord(a, b);
  return {
    ...merged,
    weight: Math.max(a.weight ?? 1, b.weight ?? 1),
  };
}

function ledgerRecordTs(item: Record<string, unknown>): string {
  for (const k of ["updatedAt", "createdAt", "lastProgressAt"]) {
    if (typeof item[k] === "string" && item[k]) return item[k] as string;
  }
  return "";
}

function mergeLedgerArray<T extends { id: string }>(localArr: T[], remoteArr: T[]): T[] {
  const map = new Map<string, T>();
  for (const item of localArr) map.set(item.id, item);
  for (const rItem of remoteArr) {
    const existing = map.get(rItem.id);
    if (!existing) {
      map.set(rItem.id, rItem);
      continue;
    }
    const tsA = ledgerRecordTs(existing as unknown as Record<string, unknown>);
    const tsB = ledgerRecordTs(rItem as unknown as Record<string, unknown>);
    const winner = tsA !== tsB
      ? (tsA > tsB ? existing : rItem)
      : (JSON.stringify(existing) >= JSON.stringify(rItem) ? existing : rItem);
    map.set(rItem.id, winner);
  }
  return Array.from(map.values()).sort((x, y) => x.id.localeCompare(y.id));
}

function mergeStewardshipLedgers(
  local: LedgerSnapshot | undefined,
  remote: LedgerSnapshot | undefined,
): LedgerSnapshot | undefined {
  if (!local && !remote) return undefined;
  const goals = mergeLedgerArray(local?.goals ?? [], remote?.goals ?? []);
  const active = goals.filter((g) => g.status === "active");
  if (active.length > 3) {
    const keepIds = new Set(
      [...active]
        .sort((a, b) => b.lastProgressAt.localeCompare(a.lastProgressAt) || b.id.localeCompare(a.id))
        .slice(0, 3)
        .map((g) => g.id),
    );
    for (const g of goals) {
      if (g.status === "active" && !keepIds.has(g.id)) g.status = "paused";
    }
  }
  const updatedAt = [local?.updatedAt ?? "", remote?.updatedAt ?? ""].sort().pop() || new Date().toISOString();
  return {
    version: 1,
    updatedAt,
    relationships: mergeLedgerArray(local?.relationships ?? [], remote?.relationships ?? []),
    goals,
    guardrails: mergeLedgerArray(local?.guardrails ?? [], remote?.guardrails ?? []),
    commitments: mergeLedgerArray(local?.commitments ?? [], remote?.commitments ?? []),
    resources: mergeLedgerArray(local?.resources ?? [], remote?.resources ?? []),
  };
}

export function mergeKnowledgeGraphSnapshots(
  local: SyncableKnowledgeGraphSnapshot,
  remote: SyncableKnowledgeGraphSnapshot,
  mergingDeviceId: string,
): SyncableKnowledgeGraphSnapshot {
  const nextLamport = Math.max(local.lamportClock, remote.lamportClock) + 1;

  const nodeMap = new Map<string, SyncableKGNode>();
  for (const node of local.nodes) nodeMap.set(node.id, node);
  for (const rNode of remote.nodes) {
    const existing = nodeMap.get(rNode.id);
    nodeMap.set(rNode.id, existing ? mergeNodeRecords(existing, rNode) : rNode);
  }

  const edgeMap = new Map<string, SyncableKGEdge>();
  for (const edge of local.edges) edgeMap.set(edge.id, edge);
  for (const rEdge of remote.edges) {
    const existing = edgeMap.get(rEdge.id);
    edgeMap.set(rEdge.id, existing ? mergeEdgeRecords(existing, rEdge) : rEdge);
  }

  const nodes = Array.from(nodeMap.values()).sort((x, y) => x.id.localeCompare(y.id));
  const edges = Array.from(edgeMap.values()).sort((x, y) => x.id.localeCompare(y.id));
  const stewardshipLedger = mergeStewardshipLedgers(local.stewardshipLedger, remote.stewardshipLedger);

  return {
    lamportClock: nextLamport,
    deviceId: mergingDeviceId,
    nodes,
    edges,
    ...(stewardshipLedger ? { stewardshipLedger } : {}),
  };
}

export interface ZeroKnowledgeSyncClientOptions {
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  kdfIterations?: number;
}

export class ZeroKnowledgeSyncClient {
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly kdfIterations: number;

  constructor(options: ZeroKnowledgeSyncClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.kdfIterations = options.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS;
  }

  private buildObjectUrl(claims: SugentBrokerClaims, objectName: string): string {
    const base = (claims.sync_endpoint ?? "").replace(/\/+$/, "");
    const namespace =
      claims.plan === "team" && claims.org_id
        ? `orgs/${encodeURIComponent(claims.org_id)}`
        : `users/${encodeURIComponent(claims.sub)}`;
    return `${base}/${namespace}/${objectName}`;
  }

  async pushKnowledgeGraph(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
    snapshot: SyncableKnowledgeGraphSnapshot;
  }): Promise<{ uploadedAtIso: string; keyFingerprint: string; lamportClock: number }> {
    assertBrokerSyncEntitlement(params.claims);

    const keyHierarchy = deriveSyncKeyHierarchy({
      passphrase: params.passphrase,
      kdfIterations: this.kdfIterations,
    });

    try {
      const envelope = sealZeroKnowledgeEnvelope({
        plaintextPayload: params.snapshot,
        keyHierarchy,
        subjectSub: params.claims.sub,
        ...(params.claims.org_id ? { orgId: params.claims.org_id } : {}),
        payloadType: "knowledge-graph",
        lamportClock: params.snapshot.lamportClock,
        deviceId: params.snapshot.deviceId,
      });

      const targetUrl = this.buildObjectUrl(params.claims, "knowledge-graph.e2ee.json");
      const res = await this.fetchImpl(targetUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${params.bearerToken}`,
          "x-sugent-lamport-clock": String(envelope.lamportClock),
        },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error(`Zero-knowledge blob upload failed with HTTP ${res.status}`);
      }

      return {
        uploadedAtIso: envelope.createdAtIso,
        keyFingerprint: envelope.keyFingerprint,
        lamportClock: envelope.lamportClock,
      };
    } finally {
      keyHierarchy.kgKek.fill(0);
      keyHierarchy.vaultKek.fill(0);
    }
  }

  async pullAndMergeKnowledgeGraph(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
    localSnapshot: SyncableKnowledgeGraphSnapshot;
  }): Promise<{
    remoteFound: boolean;
    mergedSnapshot: SyncableKnowledgeGraphSnapshot;
  }> {
    assertBrokerSyncEntitlement(params.claims);

    const targetUrl = this.buildObjectUrl(params.claims, "knowledge-graph.e2ee.json");
    const res = await this.fetchImpl(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.bearerToken}`,
      },
    });

    if (res.status === 404) {
      return {
        remoteFound: false,
        mergedSnapshot: params.localSnapshot,
      };
    }
    if (!res.ok) {
      throw new Error(`Zero-knowledge blob download failed with HTTP ${res.status}`);
    }

    const envelope = (await res.json()) as ZeroKnowledgeEnvelope;
    if (!envelope || typeof envelope !== "object" || envelope.v !== 1) {
      throw new Error("E2EE_UNENCRYPTED_STUB: Remote blob is missing envelope version v=1.");
    }
    const opened = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope,
      passphrase: params.passphrase,
      expectedSubjectSub: params.claims.sub,
      expectedPayloadType: "knowledge-graph",
    });

    const mergedSnapshot = mergeKnowledgeGraphSnapshots(
      params.localSnapshot,
      opened.payload,
      params.localSnapshot.deviceId,
    );

    return {
      remoteFound: true,
      mergedSnapshot,
    };
  }
}
