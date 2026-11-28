import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";
import type { SugentBrokerClaims } from "./auth-broker-contract.js";
import type { SkillGateStatus } from "./knowledge-graph.js";
import type { EpistemicJudgmentEntry } from "./silicon-identity-core.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";
import type {
  AtlasNodeKind,
  EpistemicStratum,
  GraphPlaneId,
  PrincipalId,
  SourceTrust,
} from "./stereoscopic-atlas.js";

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

export interface SyncableAtlasNode {
  id: string;
  plane: GraphPlaneId;
  stratum: EpistemicStratum;
  kind: AtlasNodeKind;
  name: string;
  summary: string;
  tags: string[];
  principalAcl: PrincipalId[];
  reinforcements: number;
  confidence: number;
  sourceTrust: SourceTrust;
  steps?: string[];
  skillGateStatus?: SkillGateStatus;
  updatedAt: string;
  supersededAt?: string | null;
  supersededBy?: string | null;
  archivedAt?: string | null;
  lamportClock: number;
}

export interface SyncableAtlasEdge {
  id: string;
  plane: GraphPlaneId;
  from: string;
  relation: string;
  to: string;
  weight: number;
  source: string;
  isMembraneEdge?: boolean;
  membranePolicy?: string | null;
  principalAcl?: PrincipalId[];
  validFrom: string;
  updatedAt: string;
  supersededAt?: string | null;
  lamportClock: number;
}

export interface SyncableMindJournalEntry extends EpistemicJudgmentEntry {
  lamportClock?: number;
}

export interface SyncableAtlasSnapshotV2 {
  version: 2;
  nodes: SyncableAtlasNode[];
  edges: SyncableAtlasEdge[];
  mindJournal?: {
    charterVersion: "1.0";
    updatedAt: string;
    entries: SyncableMindJournalEntry[];
  };
}

export interface SyncableKnowledgeGraphSnapshot {
  schemaVersion?: 1 | 2;
  lamportClock: number;
  deviceId: string;
  nodes: SyncableKGNode[];
  edges: SyncableKGEdge[];
  stewardshipLedger?: LedgerSnapshot;
  atlasSnapshot?: SyncableAtlasSnapshotV2;
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

function canonicalTieKey(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalTieKey).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([ka], [kb]) => ka.localeCompare(kb));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalTieKey(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function pickOrderedAtlasPair<T extends { lamportClock?: number; updatedAt: string }>(
  a: T,
  b: T,
): { winner: T; loser: T } {
  const clockA = a.lamportClock ?? 0;
  const clockB = b.lamportClock ?? 0;
  if (clockA !== clockB) {
    return clockA > clockB ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? { winner: a, loser: b } : { winner: b, loser: a };
  }
  return canonicalTieKey(a) >= canonicalTieKey(b)
    ? { winner: a, loser: b }
    : { winner: b, loser: a };
}

function mergeAtlasNodeRecords(a: SyncableAtlasNode, b: SyncableAtlasNode): SyncableAtlasNode {
  const { winner, loser } = pickOrderedAtlasPair(a, b);
  const supAtA = a.supersededAt || null;
  const supAtB = b.supersededAt || null;
  const mergedSupersededAt =
    supAtA && supAtB ? (supAtA <= supAtB ? supAtA : supAtB) : (supAtA ?? supAtB);

  const supByA = a.supersededBy || null;
  const supByB = b.supersededBy || null;
  let mergedSupersededBy: string | null = null;
  if (supByA && supByB) {
    if (supAtA && supAtB && supAtA !== supAtB) {
      mergedSupersededBy = supAtA < supAtB ? supByA : supByB;
    } else {
      mergedSupersededBy = winner.supersededBy || supByA;
    }
  } else {
    mergedSupersededBy = supByA ?? supByB;
  }

  const archA = a.archivedAt || null;
  const archB = b.archivedAt || null;
  const mergedArchivedAt =
    archA && archB ? (archA <= archB ? archA : archB) : (archA ?? archB);

  const tags = Array.from(new Set([...(winner.tags ?? []), ...(loser.tags ?? [])]));
  const principalAcl = winner.principalAcl?.length
    ? [...winner.principalAcl]
    : [...(loser.principalAcl ?? ["sugent_self", "owner:M"])];

  return {
    ...winner,
    tags,
    principalAcl,
    reinforcements: Math.max(a.reinforcements ?? 0, b.reinforcements ?? 0),
    supersededAt: mergedSupersededAt,
    supersededBy: mergedSupersededBy,
    archivedAt: mergedArchivedAt,
  };
}

function mergeAtlasEdgeRecords(a: SyncableAtlasEdge, b: SyncableAtlasEdge): SyncableAtlasEdge {
  const { winner, loser } = pickOrderedAtlasPair(a, b);
  const supAtA = a.supersededAt || null;
  const supAtB = b.supersededAt || null;
  const mergedSupersededAt =
    supAtA && supAtB ? (supAtA <= supAtB ? supAtA : supAtB) : (supAtA ?? supAtB);
  const validFrom =
    a.validFrom && b.validFrom
      ? a.validFrom <= b.validFrom
        ? a.validFrom
        : b.validFrom
      : winner.validFrom || loser.validFrom;

  return {
    ...winner,
    weight: Math.max(a.weight ?? 1, b.weight ?? 1),
    validFrom,
    supersededAt: mergedSupersededAt,
  };
}

function mergeMindJournalEntries(
  a: SyncableMindJournalEntry,
  b: SyncableMindJournalEntry,
): SyncableMindJournalEntry {
  const { winner, loser } = pickOrderedAtlasPair(a, b);

  let status = winner.status;
  let stratum = winner.stratum;
  if (a.status === "falsified" || b.status === "falsified") {
    status = "falsified";
    stratum = a.status === "falsified" ? a.stratum : b.stratum;
  } else if (a.status === "superseded" || b.status === "superseded") {
    status = "superseded";
  } else if (a.status === "crystallized" || b.status === "crystallized") {
    status = "crystallized";
    stratum = "crystallized_wisdom";
  }

  const supersededBy = winner.supersededBy || loser.supersededBy;
  const confirmations = Math.max(a.confirmations ?? 0, b.confirmations ?? 0);
  const contradictions = Math.max(a.contradictions ?? 0, b.contradictions ?? 0);
  const evidenceNotes = Array.from(
    new Set([...(loser.evidenceNotes ?? []), ...(winner.evidenceNotes ?? [])]),
  );
  const confidence =
    status === "falsified" && winner.status !== "falsified" && loser.status === "falsified"
      ? loser.confidence
      : winner.confidence;
  const hasClock = a.lamportClock !== undefined || b.lamportClock !== undefined;
  const maxClock = Math.max(a.lamportClock ?? 0, b.lamportClock ?? 0);

  return {
    ...winner,
    status,
    stratum,
    confidence,
    confirmations,
    contradictions,
    evidenceNotes,
    ...(supersededBy ? { supersededBy } : {}),
    ...(hasClock ? { lamportClock: maxClock } : {}),
  };
}

function inferPlaneFromLegacyId(
  id: string,
  kind: string,
  reinforcements: number,
): { plane: GraphPlaneId; stratum: EpistemicStratum; principalAcl: PrincipalId[] } {
  if (id.startsWith("self:")) {
    return {
      plane: "self_core",
      stratum: kind === "workflow" ? "crystallized_wisdom" : "digested_state",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (/^(?:rel|duo|crystal|peer):/.test(id)) {
    const sub = id.split(":")[1] || "default";
    const plane: GraphPlaneId = id.startsWith("peer:")
      ? `relational:peer:${sub}`
      : id.startsWith("rel:")
        ? `relational:${sub}`
        : `relational:duo:${sub}`;
    return {
      plane,
      stratum: id.startsWith("crystal:") ? "crystallized_wisdom" : "verified_fact",
      principalAcl: id.startsWith("peer:") ? ["owner:M", `peer:${sub}`] : ["sugent_self", "owner:M"],
    };
  }
  if (/^(?:proj|repo|cap|fde):/.test(id)) {
    const key = id.split(":")[1] || "default";
    return {
      plane: `domain_work:${key}`,
      stratum: kind === "workflow" ? "crystallized_wisdom" : "verified_fact",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  if (/^(?:wf|sim):/.test(id)) {
    return {
      plane: "meta_evolution",
      stratum:
        id.startsWith("wf:") && reinforcements >= 3
          ? "crystallized_wisdom"
          : id.startsWith("sim:")
            ? "digested_state"
            : "verified_fact",
      principalAcl: ["sugent_self", "owner:M"],
    };
  }
  return {
    plane: "owner_life",
    stratum: kind === "workflow" ? "crystallized_wisdom" : "verified_fact",
    principalAcl: ["owner:M"],
  };
}

function convertLegacyNodeToSyncableAtlas(n: SyncableKGNode): SyncableAtlasNode {
  const props = n.properties ?? {};
  const reinforcements =
    typeof props.reinforcements === "number" && Number.isFinite(props.reinforcements)
      ? props.reinforcements
      : 1;
  const cls = inferPlaneFromLegacyId(n.id, n.type, reinforcements);
  const tags = Array.isArray(props.tags) ? props.tags.map(String) : [];
  const steps = Array.isArray(props.steps) ? props.steps.map(String) : undefined;
  const rawGate = props.skillGateStatus;
  const skillGateStatus: SkillGateStatus | undefined =
    rawGate === "candidate" || rawGate === "approved" || rawGate === "rejected"
      ? rawGate
      : undefined;
  return {
    id: n.id,
    plane: cls.plane,
    stratum: cls.stratum,
    kind: (n.type || "concept") as AtlasNodeKind,
    name: n.label,
    summary: typeof props.summary === "string" ? props.summary : "",
    tags,
    principalAcl: cls.principalAcl,
    reinforcements,
    confidence: cls.stratum === "crystallized_wisdom" ? 0.92 : 0.82,
    sourceTrust: "legacy_import",
    ...(steps?.length ? { steps } : {}),
    ...(skillGateStatus ? { skillGateStatus } : {}),
    updatedAt: n.updatedAt,
    supersededAt: n.supersededAt ?? null,
    supersededBy: null,
    archivedAt: null,
    lamportClock: n.lamportClock,
  };
}

function mergeAtlasSnapshotsV2(
  local: SyncableKnowledgeGraphSnapshot,
  remote: SyncableKnowledgeGraphSnapshot,
): SyncableAtlasSnapshotV2 | undefined {
  if (!local.atlasSnapshot && !remote.atlasSnapshot) return undefined;

  const atlasNodeMap = new Map<string, SyncableAtlasNode>();
  for (const n of local.atlasSnapshot?.nodes ?? []) {
    atlasNodeMap.set(n.id, n);
  }
  for (const rn of remote.atlasSnapshot?.nodes ?? []) {
    const existing = atlasNodeMap.get(rn.id);
    atlasNodeMap.set(rn.id, existing ? mergeAtlasNodeRecords(existing, rn) : rn);
  }

  // Bridge v1-only nodes if one peer did not yet emit atlasSnapshot v2
  const v1Sides: SyncableKnowledgeGraphSnapshot[] = [];
  if (!local.atlasSnapshot) v1Sides.push(local);
  if (!remote.atlasSnapshot) v1Sides.push(remote);
  for (const v1Snap of v1Sides) {
    for (const v1Node of v1Snap.nodes) {
      const existing = atlasNodeMap.get(v1Node.id);
      if (!existing) {
        atlasNodeMap.set(v1Node.id, convertLegacyNodeToSyncableAtlas(v1Node));
      } else {
        const v1Reinf =
          typeof v1Node.properties?.reinforcements === "number" &&
          Number.isFinite(v1Node.properties.reinforcements)
            ? v1Node.properties.reinforcements
            : 0;
        const supAtExisting = existing.supersededAt || null;
        const supAtV1 = v1Node.supersededAt || null;
        const mergedSupAt =
          supAtExisting && supAtV1
            ? supAtExisting <= supAtV1
              ? supAtExisting
              : supAtV1
            : (supAtExisting ?? supAtV1);
        atlasNodeMap.set(v1Node.id, {
          ...existing,
          reinforcements: Math.max(existing.reinforcements, v1Reinf),
          supersededAt: mergedSupAt,
        });
      }
    }
  }

  const atlasEdgeMap = new Map<string, SyncableAtlasEdge>();
  for (const e of local.atlasSnapshot?.edges ?? []) {
    atlasEdgeMap.set(e.id, e);
  }
  for (const re of remote.atlasSnapshot?.edges ?? []) {
    const existing = atlasEdgeMap.get(re.id);
    atlasEdgeMap.set(re.id, existing ? mergeAtlasEdgeRecords(existing, re) : re);
  }
  for (const v1Snap of v1Sides) {
    for (const v1Edge of v1Snap.edges) {
      const existing = atlasEdgeMap.get(v1Edge.id);
      if (!existing) {
        const fromN = atlasNodeMap.get(v1Edge.source);
        const toN = atlasNodeMap.get(v1Edge.target);
        const crossPlane = Boolean(fromN && toN && fromN.plane !== toN.plane);
        atlasEdgeMap.set(v1Edge.id, {
          id: v1Edge.id,
          plane: fromN?.plane ?? toN?.plane ?? "owner_life",
          from: v1Edge.source,
          relation: v1Edge.relation,
          to: v1Edge.target,
          weight: v1Edge.weight ?? 1,
          source: v1Edge.provenanceSource || "e2ee_sync",
          ...(crossPlane ? { isMembraneEdge: true } : {}),
          validFrom: v1Edge.validFrom,
          updatedAt: v1Edge.updatedAt,
          supersededAt: v1Edge.supersededAt ?? null,
          lamportClock: v1Edge.lamportClock,
        });
      } else {
        const supAtExisting = existing.supersededAt || null;
        const supAtV1 = v1Edge.supersededAt || null;
        const mergedSupAt =
          supAtExisting && supAtV1
            ? supAtExisting <= supAtV1
              ? supAtExisting
              : supAtV1
            : (supAtExisting ?? supAtV1);
        atlasEdgeMap.set(v1Edge.id, {
          ...existing,
          weight: Math.max(existing.weight, v1Edge.weight ?? 1),
          supersededAt: mergedSupAt,
        });
      }
    }
  }

  const localMind = local.atlasSnapshot?.mindJournal;
  const remoteMind = remote.atlasSnapshot?.mindJournal;
  let mindJournal: SyncableAtlasSnapshotV2["mindJournal"] | undefined;
  if (localMind || remoteMind) {
    const mindMap = new Map<string, SyncableMindJournalEntry>();
    for (const entry of localMind?.entries ?? []) {
      mindMap.set(entry.id, entry);
    }
    for (const rEntry of remoteMind?.entries ?? []) {
      const existing = mindMap.get(rEntry.id);
      mindMap.set(rEntry.id, existing ? mergeMindJournalEntries(existing, rEntry) : rEntry);
    }
    const entries = Array.from(mindMap.values()).sort(
      (x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id),
    );
    const maxEntryUpdated = entries.reduce((acc, e) => (e.updatedAt > acc ? e.updatedAt : acc), "");
    const updatedAt =
      [localMind?.updatedAt ?? "", remoteMind?.updatedAt ?? "", maxEntryUpdated]
        .filter(Boolean)
        .sort()
        .pop() || new Date().toISOString();
    mindJournal = {
      charterVersion: "1.0",
      updatedAt,
      entries,
    };
  }

  return {
    version: 2,
    nodes: Array.from(atlasNodeMap.values()).sort((x, y) => x.id.localeCompare(y.id)),
    edges: Array.from(atlasEdgeMap.values()).sort((x, y) => x.id.localeCompare(y.id)),
    ...(mindJournal ? { mindJournal } : {}),
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
  const atlasSnapshot = mergeAtlasSnapshotsV2(local, remote);

  return {
    ...(atlasSnapshot ? { schemaVersion: 2 as const } : {}),
    lamportClock: nextLamport,
    deviceId: mergingDeviceId,
    nodes,
    edges,
    ...(stewardshipLedger ? { stewardshipLedger } : {}),
    ...(atlasSnapshot ? { atlasSnapshot } : {}),
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
