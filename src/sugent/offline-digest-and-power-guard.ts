import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  deriveSyncKeyHierarchy,
  openZeroKnowledgeEnvelope,
  sealZeroKnowledgeEnvelope,
  type ZeroKnowledgeEnvelope,
} from "./e2ee-sync.js";
import type { ContextPartition, StewardshipLedger } from "./stewardship-ledger.js";

export type ActivePowerGuardMode = "prevent-app-suspension" | "prevent-display-sleep";
export type PowerGuardMode = "off" | ActivePowerGuardMode;

export interface PowerSaveBlockerDriver {
  start(type: ActivePowerGuardMode): number;
  stop(id: number): void;
  isStarted?(id: number): boolean;
}

export interface PowerGuardStatus {
  active: boolean;
  mode: PowerGuardMode;
  blockerId: number | null;
  expiresAtMs: number | null;
  headlessFallback: boolean;
}

export interface PowerSaveBlockerControllerOptions {
  driver?: PowerSaveBlockerDriver;
  maxDurationMs?: number;
  now?: () => number;
}

export interface EnablePowerGuardOptions {
  durationMs?: number;
  nowMs?: number;
}

export const DEFAULT_MAX_POWER_GUARD_DURATION_MS = 8 * 3600_000;
export const DEFAULT_OFFLINE_DUE_SOON_HOURS = 48;
export const MIN_OFFLINE_VAULT_KDF_ITERATIONS = 100_000;
export const DEFAULT_OFFLINE_VAULT_KDF_ITERATIONS = 100_000;
export const DEFAULT_MAX_PROCESSED_OFFLINE_TASKS = 10_000;

export const OFFLINE_VAULT_DIRNAME = "sugent-offline-vault";
export const PROCESSED_QUEUE_FILENAME = "processed-queue.json";

export const OFFLINE_DIGEST_SCHEMA_KIND = "sugent.offline_ledger_digest.v1" as const;
export const OFFLINE_QUEUED_TASK_SCHEMA_KIND = "sugent.offline_queued_task.v1" as const;

export type StewardshipLedgerReader = Pick<StewardshipLedger, "snapshotForCaller">;
export type StewardshipLedgerWriter = Pick<StewardshipLedger, "upsertCommitment">;

export interface OfflineDigestGoal {
  readonly id: string;
  readonly partition: ContextPartition;
  readonly title: string;
  readonly northStarCriterion: string;
  readonly status: string;
  readonly targetDateIso?: string;
}

export interface OfflineDigestCommitment {
  readonly id: string;
  readonly partition: ContextPartition;
  readonly direction: "i_owe" | "waiting_for" | "expiring";
  readonly status: string;
  readonly summary: string;
  readonly counterpartyOrRef: string;
  readonly dueAt?: string;
  readonly updatedAt: string;
  readonly isDueSoon: boolean;
}

export interface OfflineDigestRedline {
  readonly id: string;
  readonly partition: ContextPartition;
  readonly kind: "hard_redline" | "tombstone";
  readonly statement: string;
  readonly enforcement: string;
}

export interface OfflineDigestArchiveTitle {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly partition: ContextPartition;
}

export interface OfflineLedgerDigest {
  readonly kind: typeof OFFLINE_DIGEST_SCHEMA_KIND;
  readonly version: 1;
  readonly readOnly: true;
  readonly generatedAtIso: string;
  readonly ledgerUpdatedAtIso: string;
  readonly dueSoonHours: number;
  readonly goals: readonly OfflineDigestGoal[];
  readonly commitments: readonly OfflineDigestCommitment[];
  readonly redlines: readonly OfflineDigestRedline[];
  readonly archiveTitles: readonly OfflineDigestArchiveTitle[];
}

export interface BuildOfflineLedgerDigestOptions {
  nowIso?: string;
  dueSoonHours?: number;
  callerDomain?: "owner_private" | "work_project" | "cowork_shared";
}

export interface OfflineQueuedTask {
  taskId: string;
  summary: string;
  counterpartyOrRef: string;
  partition?: ContextPartition;
  direction?: "i_owe" | "waiting_for" | "expiring";
  dueAt?: string;
  createdAtIso: string;
}

export type OfflineQueuedTaskInput = Omit<OfflineQueuedTask, "createdAtIso"> & {
  createdAtIso?: string;
};

export interface SealDigestSnapshotParams {
  ledger: StewardshipLedgerReader;
  passphrase: string;
  subjectSub: string;
  orgId?: string;
  deviceId: string;
  lamportClock: number;
  nowIso?: string;
  dueSoonHours?: number;
}

export interface OpenDigestSnapshotParams {
  envelope: ZeroKnowledgeEnvelope;
  passphrase: string;
  expectedSubjectSub: string;
}

export interface EnqueueEncryptedOfflineTaskParams {
  task: OfflineQueuedTaskInput;
  passphrase: string;
  subjectSub: string;
  orgId?: string;
  mobileDeviceId: string;
  lamportClock: number;
  nowIso?: string;
}

export interface DrainOfflineTaskQueueParams {
  envelopes: readonly ZeroKnowledgeEnvelope[];
  passphrase: string;
  expectedSubjectSub: string;
  ledger: StewardshipLedgerWriter;
  nowIso?: string;
}

export interface DrainOfflineTaskQueueResult {
  ingestedCount: number;
  skippedDuplicateCount: number;
  committedIds: string[];
}

export interface E2eeOfflineDigestVaultOptions {
  dataDir: string;
  kdfIterations?: number;
  maxProcessedIds?: number;
}

interface SealedOfflineQueuedTaskPayload extends OfflineQueuedTask {
  kind: typeof OFFLINE_QUEUED_TASK_SCHEMA_KIND;
  version: 1;
}

interface ProcessedQueueDiskRecord {
  version: 1;
  updatedAtIso: string;
  processedTaskIds: string[];
}

const VALID_PARTITIONS = new Set<ContextPartition>([
  "personal_life",
  "work_project",
  "cowork_shared",
]);

const VALID_DIRECTIONS = new Set<"i_owe" | "waiting_for" | "expiring">([
  "i_owe",
  "waiting_for",
  "expiring",
]);

const ALLOWED_ARCHIVE_TITLE_KEYS = new Set(["id", "kind", "title", "partition"]);

function createHeadlessPowerSaveBlockerDriver(): PowerSaveBlockerDriver {
  let nextBlockerId = 0;
  const startedIds = new Set<number>();
  return {
    start(_type: ActivePowerGuardMode): number {
      nextBlockerId += 1;
      startedIds.add(nextBlockerId);
      return nextBlockerId;
    },
    stop(id: number): void {
      startedIds.delete(id);
    },
    isStarted(id: number): boolean {
      return startedIds.has(id);
    },
  };
}

function assertFiniteTimestampMs(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite timestamp in milliseconds`);
  }
  return value;
}

function parseIsoTimestamp(iso: unknown, label: string): number {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    throw new RangeError(`${label} must be a non-empty ISO-8601 timestamp string`);
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new RangeError(`${label} is not a valid ISO-8601 timestamp: ${iso}`);
  }
  return ms;
}

function assertNonEmptyTrimmed(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertValidLamportClock(clock: number): number {
  if (!Number.isSafeInteger(clock) || clock < 0) {
    throw new RangeError("lamportClock must be a non-negative safe integer");
  }
  return clock;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeAtomicPrivateFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // ignore non-posix fs
    }
  }
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(tmpPath, 0o600);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

export class PowerSaveBlockerController {
  public readonly maxDurationMs: number;
  public readonly headlessFallback: boolean;
  private readonly driver: PowerSaveBlockerDriver;
  private readonly nowFn: () => number;
  private mode: PowerGuardMode = "off";
  private blockerId: number | null = null;
  private expiresAtMs: number | null = null;

  public constructor(options: PowerSaveBlockerControllerOptions = {}) {
    const ceiling = options.maxDurationMs ?? DEFAULT_MAX_POWER_GUARD_DURATION_MS;
    if (!Number.isFinite(ceiling) || ceiling <= 0) {
      throw new RangeError("maxDurationMs must be a positive finite number");
    }
    this.maxDurationMs = ceiling;
    this.nowFn = options.now ?? (() => Date.now());
    if (options.driver) {
      this.driver = options.driver;
      this.headlessFallback = false;
    } else {
      this.driver = createHeadlessPowerSaveBlockerDriver();
      this.headlessFallback = true;
    }
  }

  public enable(mode: PowerGuardMode, opts?: EnablePowerGuardOptions): PowerGuardStatus {
    const nowMs = assertFiniteTimestampMs(opts?.nowMs ?? this.nowFn(), "nowMs");
    if (mode === "off") return this.disable(nowMs);
    if (mode !== "prevent-app-suspension" && mode !== "prevent-display-sleep") {
      throw new RangeError(`Unsupported PowerGuardMode: ${String(mode)}`);
    }
    const requested = opts?.durationMs ?? this.maxDurationMs;
    if (Number.isNaN(requested) || requested <= 0) {
      throw new RangeError("durationMs must be a positive number");
    }
    const effectiveMs = Math.min(requested, this.maxDurationMs);
    this.releaseActiveBlocker();
    const id = this.driver.start(mode);
    this.mode = mode;
    this.blockerId = id;
    this.expiresAtMs = nowMs + effectiveMs;
    return this.snapshotStatus();
  }

  public disable(nowMs?: number): PowerGuardStatus {
    if (nowMs !== undefined) assertFiniteTimestampMs(nowMs, "nowMs");
    this.releaseActiveBlocker();
    return this.snapshotStatus();
  }

  public checkAutoExpire(nowMs?: number): boolean {
    const now = assertFiniteTimestampMs(nowMs ?? this.nowFn(), "nowMs");
    if (this.blockerId === null) return false;
    if (this.driver.isStarted && !this.driver.isStarted(this.blockerId)) {
      this.mode = "off";
      this.blockerId = null;
      this.expiresAtMs = null;
      return true;
    }
    if (this.expiresAtMs !== null && now >= this.expiresAtMs) {
      this.releaseActiveBlocker();
      return true;
    }
    return false;
  }

  public getStatus(nowMs?: number): PowerGuardStatus {
    this.checkAutoExpire(nowMs);
    return this.snapshotStatus();
  }

  private releaseActiveBlocker(): void {
    if (this.blockerId !== null) {
      try {
        this.driver.stop(this.blockerId);
      } finally {
        this.blockerId = null;
        this.mode = "off";
        this.expiresAtMs = null;
      }
    } else {
      this.mode = "off";
      this.expiresAtMs = null;
    }
  }

  private snapshotStatus(): PowerGuardStatus {
    return {
      active: this.blockerId !== null,
      mode: this.mode,
      blockerId: this.blockerId,
      expiresAtMs: this.expiresAtMs,
      headlessFallback: this.headlessFallback,
    };
  }
}

export function buildOfflineLedgerDigest(
  ledger: StewardshipLedgerReader,
  opts: BuildOfflineLedgerDigestOptions = {},
): OfflineLedgerDigest {
  const generatedAtIso = opts.nowIso ?? new Date().toISOString();
  const nowMs = parseIsoTimestamp(generatedAtIso, "nowIso");
  const dueSoonHours = opts.dueSoonHours ?? DEFAULT_OFFLINE_DUE_SOON_HOURS;
  if (!Number.isFinite(dueSoonHours) || dueSoonHours < 0) {
    throw new RangeError("dueSoonHours must be a non-negative finite number");
  }
  const dueWindowMs = dueSoonHours * 3600_000;
  const snap = ledger.snapshotForCaller(opts.callerDomain ?? "owner_private");

  const goals: OfflineDigestGoal[] = snap.goals
    .filter((g) => g.status === "active")
    .map((g) =>
      Object.freeze({
        id: g.id,
        partition: g.partition,
        title: g.title,
        northStarCriterion: g.northStarCriterion,
        status: g.status,
        ...(g.targetDateIso ? { targetDateIso: g.targetDateIso } : {}),
      }),
    );

  const commitments: OfflineDigestCommitment[] = snap.commitments
    .filter((c) => c.status === "open")
    .map((c) => {
      let isDueSoon = false;
      if (c.dueAt) {
        const dueMs = Date.parse(c.dueAt);
        if (!Number.isNaN(dueMs)) {
          isDueSoon = dueMs - nowMs <= dueWindowMs;
        }
      }
      return Object.freeze({
        id: c.id,
        partition: c.partition,
        direction: c.direction,
        status: c.status,
        summary: c.summary,
        counterpartyOrRef: c.counterpartyOrRef,
        ...(c.dueAt ? { dueAt: c.dueAt } : {}),
        updatedAt: c.updatedAt,
        isDueSoon,
      });
    });

  const redlines: OfflineDigestRedline[] = snap.guardrails
    .filter(
      (gr): gr is typeof gr & { kind: "hard_redline" | "tombstone" } =>
        gr.kind === "hard_redline" || gr.kind === "tombstone",
    )
    .map((gr) =>
      Object.freeze({
        id: gr.id,
        partition: gr.partition,
        kind: gr.kind,
        statement: gr.statement,
        enforcement: gr.enforcement,
      }),
    );

  const archiveTitles: OfflineDigestArchiveTitle[] = snap.resources.map((r) =>
    Object.freeze({
      id: r.id,
      kind: r.kind,
      title: r.title,
      partition: r.partition,
    }),
  );

  return Object.freeze({
    kind: OFFLINE_DIGEST_SCHEMA_KIND,
    version: 1 as const,
    readOnly: true as const,
    generatedAtIso,
    ledgerUpdatedAtIso: snap.updatedAt,
    dueSoonHours,
    goals: Object.freeze(goals),
    commitments: Object.freeze(commitments),
    redlines: Object.freeze(redlines),
    archiveTitles: Object.freeze(archiveTitles),
  });
}

export class E2eeOfflineDigestVault {
  private readonly queueFilePath: string;
  private readonly kdfIterations: number;
  private readonly maxProcessedIds: number;
  private readonly processedIds: string[] = [];
  private readonly processedSet = new Set<string>();

  public constructor(options: string | E2eeOfflineDigestVaultOptions) {
    const opts = typeof options === "string" ? { dataDir: options } : options;
    const dataDir = assertNonEmptyTrimmed(opts.dataDir, "dataDir");
    const iterations = opts.kdfIterations ?? DEFAULT_OFFLINE_VAULT_KDF_ITERATIONS;
    if (!Number.isSafeInteger(iterations) || iterations < MIN_OFFLINE_VAULT_KDF_ITERATIONS) {
      throw new RangeError(`kdfIterations must be >= ${MIN_OFFLINE_VAULT_KDF_ITERATIONS}`);
    }
    this.kdfIterations = iterations;
    this.maxProcessedIds = Math.max(16, opts.maxProcessedIds ?? DEFAULT_MAX_PROCESSED_OFFLINE_TASKS);
    this.queueFilePath = path.join(dataDir, OFFLINE_VAULT_DIRNAME, PROCESSED_QUEUE_FILENAME);
    this.loadProcessedIds();
  }

  private loadProcessedIds(): void {
    if (!fs.existsSync(this.queueFilePath)) return;
    const raw = JSON.parse(fs.readFileSync(this.queueFilePath, "utf8")) as Partial<ProcessedQueueDiskRecord>;
    if (!Array.isArray(raw.processedTaskIds)) {
      throw new Error("Corrupted processed offline queue file");
    }
    for (const id of raw.processedTaskIds) {
      if (typeof id === "string" && id.trim() && !this.processedSet.has(id)) {
        this.processedSet.add(id);
        this.processedIds.push(id);
      }
    }
  }

  private saveProcessedIds(nowIso: string): void {
    const payload: ProcessedQueueDiskRecord = {
      version: 1,
      updatedAtIso: nowIso,
      processedTaskIds: [...this.processedIds],
    };
    writeAtomicPrivateFile(this.queueFilePath, `${JSON.stringify(payload, null, 2)}\n`);
  }

  public sealDigestSnapshot(params: SealDigestSnapshotParams): ZeroKnowledgeEnvelope {
    assertValidLamportClock(params.lamportClock);
    const digest = buildOfflineLedgerDigest(params.ledger, {
      ...(params.nowIso ? { nowIso: params.nowIso } : {}),
      ...(params.dueSoonHours !== undefined ? { dueSoonHours: params.dueSoonHours } : {}),
    });
    const keys = deriveSyncKeyHierarchy({
      passphrase: params.passphrase,
      kdfIterations: this.kdfIterations,
    });
    try {
      return sealZeroKnowledgeEnvelope({
        plaintextPayload: digest,
        keyHierarchy: keys,
        subjectSub: assertNonEmptyTrimmed(params.subjectSub, "subjectSub"),
        ...(params.orgId ? { orgId: params.orgId } : {}),
        payloadType: "config-snapshot",
        lamportClock: params.lamportClock,
        deviceId: assertNonEmptyTrimmed(params.deviceId, "deviceId"),
      });
    } finally {
      keys.kgKek.fill(0);
      keys.vaultKek.fill(0);
    }
  }

  public openDigestSnapshot(params: OpenDigestSnapshotParams): OfflineLedgerDigest {
    const opened = openZeroKnowledgeEnvelope<unknown>({
      envelope: params.envelope,
      passphrase: params.passphrase,
      expectedSubjectSub: params.expectedSubjectSub,
      expectedPayloadType: "config-snapshot",
    });
    if (!isPlainRecord(opened.payload) || opened.payload.kind !== OFFLINE_DIGEST_SCHEMA_KIND) {
      throw new Error("Envelope payload is not a valid OfflineLedgerDigest");
    }
    const archives = Array.isArray(opened.payload.archiveTitles) ? opened.payload.archiveTitles : [];
    for (const entry of archives) {
      if (!isPlainRecord(entry) || Object.keys(entry).some((k) => !ALLOWED_ARCHIVE_TITLE_KEYS.has(k))) {
        throw new Error("Forged or unsafe archiveTitles entry in OfflineLedgerDigest");
      }
    }
    return opened.payload as unknown as OfflineLedgerDigest;
  }

  public enqueueEncryptedOfflineTask(
    params: EnqueueEncryptedOfflineTaskParams,
  ): ZeroKnowledgeEnvelope {
    assertValidLamportClock(params.lamportClock);
    const taskId = assertNonEmptyTrimmed(params.task.taskId, "task.taskId").replace(
      /[^A-Za-z0-9._-]+/g,
      "-",
    );
    const summary = assertNonEmptyTrimmed(params.task.summary, "task.summary");
    const counterpartyOrRef = assertNonEmptyTrimmed(
      params.task.counterpartyOrRef,
      "task.counterpartyOrRef",
    );
    const partition = params.task.partition ?? "personal_life";
    if (!VALID_PARTITIONS.has(partition)) {
      throw new RangeError(`Invalid partition: ${String(partition)}`);
    }
    const direction = params.task.direction ?? "i_owe";
    if (!VALID_DIRECTIONS.has(direction)) {
      throw new RangeError(`Invalid direction: ${String(direction)}`);
    }
    const createdAtIso = params.task.createdAtIso ?? params.nowIso ?? new Date().toISOString();
    parseIsoTimestamp(createdAtIso, "createdAtIso");

    const payload: SealedOfflineQueuedTaskPayload = {
      kind: OFFLINE_QUEUED_TASK_SCHEMA_KIND,
      version: 1,
      taskId,
      summary,
      counterpartyOrRef,
      partition,
      direction,
      ...(params.task.dueAt ? { dueAt: params.task.dueAt } : {}),
      createdAtIso,
    };

    const keys = deriveSyncKeyHierarchy({
      passphrase: params.passphrase,
      kdfIterations: this.kdfIterations,
    });
    try {
      return sealZeroKnowledgeEnvelope({
        plaintextPayload: payload,
        keyHierarchy: keys,
        subjectSub: assertNonEmptyTrimmed(params.subjectSub, "subjectSub"),
        ...(params.orgId ? { orgId: params.orgId } : {}),
        payloadType: "config-snapshot",
        lamportClock: params.lamportClock,
        deviceId: assertNonEmptyTrimmed(params.mobileDeviceId, "mobileDeviceId"),
      });
    } finally {
      keys.kgKek.fill(0);
      keys.vaultKek.fill(0);
    }
  }

  public drainOfflineTaskQueueOnWake(
    params: DrainOfflineTaskQueueParams,
  ): DrainOfflineTaskQueueResult {
    const nowIso = params.nowIso ?? new Date().toISOString();
    parseIsoTimestamp(nowIso, "nowIso");
    if (params.envelopes.length === 0) {
      return { ingestedCount: 0, skippedDuplicateCount: 0, committedIds: [] };
    }

    // Pre-validate and decrypt all envelopes transactionally before mutating ledger
    const decoded = params.envelopes.map((envelope, index) => {
      const opened = openZeroKnowledgeEnvelope<unknown>({
        envelope,
        passphrase: params.passphrase,
        expectedSubjectSub: params.expectedSubjectSub,
        expectedPayloadType: "config-snapshot",
      });
      if (
        !isPlainRecord(opened.payload) ||
        opened.payload.kind !== OFFLINE_QUEUED_TASK_SCHEMA_KIND
      ) {
        throw new Error("Invalid offline queued task envelope payload");
      }
      const task = opened.payload as unknown as SealedOfflineQueuedTaskPayload;
      return { lamportClock: opened.lamportClock, index, task };
    });

    decoded.sort((a, b) => a.lamportClock - b.lamportClock || a.index - b.index);

    let ingestedCount = 0;
    let skippedDuplicateCount = 0;
    const committedIds: string[] = [];

    for (const { task } of decoded) {
      if (this.processedSet.has(task.taskId)) {
        skippedDuplicateCount += 1;
        continue;
      }
      const commitmentId = `offline-${task.taskId}`;
      const created = params.ledger.upsertCommitment(
        {
          id: commitmentId,
          partition: task.partition ?? "personal_life",
          direction: task.direction ?? "i_owe",
          status: "open",
          summary: task.summary,
          counterpartyOrRef: task.counterpartyOrRef,
          ...(task.dueAt ? { dueAt: task.dueAt } : {}),
        },
        nowIso,
      );
      this.processedSet.add(task.taskId);
      this.processedIds.push(task.taskId);
      while (this.processedIds.length > this.maxProcessedIds) {
        const evicted = this.processedIds.shift();
        if (evicted) this.processedSet.delete(evicted);
      }
      ingestedCount += 1;
      committedIds.push(created.id);
    }

    this.saveProcessedIds(nowIso);
    return { ingestedCount, skippedDuplicateCount, committedIds };
  }
}
