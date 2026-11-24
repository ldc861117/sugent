import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const SUGENT_SHELL_ABI_VERSION = 1;
export const BUNDLE_FORMAT_VERSION = 1;

export type HotSlotId = "a" | "b";
export type HotBootSlot = HotSlotId | "factory";

export interface HotBundleFileEntry {
  relPath: string;
  sha256: string;
  mode?: number;
  contentBase64: string;
}

export interface HotBundleManifest {
  formatVersion: 1;
  bundleId: string;
  version: string;
  gitHead?: string;
  createdAtIso: string;
  minShellAbiVersion: number;
  entryRelPath: string;
  uiRelDir: string;
  files: Array<{ relPath: string; sha256: string; size: number }>;
}

export interface SignedHotBundleEnvelope {
  manifest: HotBundleManifest;
  signatureBase64?: string;
  publicKeyPem?: string;
  files: HotBundleFileEntry[];
}

export interface HotBundleSlotMeta {
  slot: HotSlotId;
  bundleId: string;
  version: string;
  gitHead?: string;
  entryRelPath: string;
  uiRelDir: string;
  installedAtIso: string;
  quarantined?: boolean;
  quarantineReason?: string;
}

export interface HotBundleSlotState {
  version: 1;
  activeSlot: HotSlotId | null;
  pendingSlot: HotSlotId | null;
  previousGoodSlot: HotSlotId | null;
  trustedPublicKeys: string[];
  slots: Partial<Record<HotSlotId, HotBundleSlotMeta>>;
  updatedAtIso: string;
}

function writeJsonAtomic600(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}
function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalizeJson(v)).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(rec[k])}`).join(",")}}`;
}

export function assertSafeBundleRelPath(relPath: string): string {
  const norm = String(relPath ?? "").replace(/\\/g, "/");
  if (!norm || norm.includes("\0") || norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) {
    throw new Error(`Unsafe bundle path: ${relPath}`);
  }
  const parts = norm.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) {
    throw new Error(`Path traversal rejected in bundle: ${relPath}`);
  }
  return parts.join("/");
}

export function generateHotBundleKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function walkIncludeFiles(rootDir: string, relRoot: string, out: string[]): void {
  const full = path.join(rootDir, relRoot);
  if (!fs.existsSync(full)) return;
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) return;
  if (st.isFile()) {
    out.push(relRoot.replace(/\\/g, "/"));
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(full).sort()) {
    if (name === ".tsbuildinfo" || name.endsWith(".map")) continue;
    walkIncludeFiles(rootDir, path.posix.join(relRoot.replace(/\\/g, "/"), name), out);
  }
}

export function createSignedHotBundle(input: {
  sourceRoot: string;
  version: string;
  gitHead?: string;
  minShellAbiVersion?: number;
  entryRelPath?: string;
  uiRelDir?: string;
  includePaths?: string[];
  privateKeyPem?: string;
  publicKeyPem?: string;
}): { buffer: Buffer; manifest: HotBundleManifest; signatureBase64?: string } {
  const root = path.resolve(input.sourceRoot);
  const includes = input.includePaths ?? ["dist", "ui", "package.json"];
  const relFiles: string[] = [];
  for (const inc of includes) walkIncludeFiles(root, assertSafeBundleRelPath(inc), relFiles);
  const uniqueRel = Array.from(new Set(relFiles)).sort();
  if (uniqueRel.length === 0) throw new Error("No files collected for hot bundle");
  const files: HotBundleFileEntry[] = [];
  const manifestFiles: HotBundleManifest["files"] = [];
  for (const rel of uniqueRel) {
    const buf = fs.readFileSync(path.join(root, rel));
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    files.push({ relPath: rel, sha256, contentBase64: buf.toString("base64") });
    manifestFiles.push({ relPath: rel, sha256, size: buf.length });
  }
  const createdAtIso = new Date().toISOString();
  const manifest: HotBundleManifest = {
    formatVersion: 1,
    bundleId: `hb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    version: input.version,
    ...(input.gitHead ? { gitHead: input.gitHead } : {}),
    createdAtIso,
    minShellAbiVersion: input.minShellAbiVersion ?? SUGENT_SHELL_ABI_VERSION,
    entryRelPath: assertSafeBundleRelPath(input.entryRelPath ?? "dist/src/sugent/hot-core-entry.js"),
    uiRelDir: assertSafeBundleRelPath(input.uiRelDir ?? "ui"),
    files: manifestFiles,
  };
  let signatureBase64: string | undefined;
  if (input.privateKeyPem) {
    const sig = crypto.sign(null, Buffer.from(canonicalizeJson(manifest), "utf8"), input.privateKeyPem);
    signatureBase64 = sig.toString("base64");
  }
  const envelope: SignedHotBundleEnvelope = {
    manifest,
    ...(signatureBase64 ? { signatureBase64 } : {}),
    ...(input.publicKeyPem ? { publicKeyPem: input.publicKeyPem } : {}),
    files,
  };
  const buffer = zlib.gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"), { level: 6 });
  return { buffer, manifest, ...(signatureBase64 ? { signatureBase64 } : {}) };
}

export function verifyHotBundleArchive(
  buffer: Buffer,
  opts: { shellAbiVersion?: number; trustedPublicKeys?: string[]; allowUnsigned?: boolean } = {},
): { ok: true; envelope: SignedHotBundleEnvelope } | { ok: false; errorCode: string; reason: string } {
  let envelope: SignedHotBundleEnvelope;
  try {
    envelope = JSON.parse(zlib.gunzipSync(buffer).toString("utf8")) as SignedHotBundleEnvelope;
  } catch (err) {
    return { ok: false, errorCode: "GZIP_DECODE_FAILED", reason: err instanceof Error ? err.message : String(err) };
  }
  const manifest = envelope?.manifest;
  if (!manifest || manifest.formatVersion !== BUNDLE_FORMAT_VERSION || !Array.isArray(manifest.files) || !Array.isArray(envelope.files)) {
    return { ok: false, errorCode: "INVALID_FORMAT", reason: "Bundle manifest or files array is missing or unsupported." };
  }
  const hostAbi = opts.shellAbiVersion ?? SUGENT_SHELL_ABI_VERSION;
  if (typeof manifest.minShellAbiVersion !== "number" || manifest.minShellAbiVersion > hostAbi) {
    return { ok: false, errorCode: "ABI_MISMATCH", reason: `Bundle requires shell ABI >= ${manifest.minShellAbiVersion}, host is ${hostAbi}.` };
  }
  try {
    assertSafeBundleRelPath(manifest.entryRelPath);
    assertSafeBundleRelPath(manifest.uiRelDir);
    for (const f of manifest.files) assertSafeBundleRelPath(f.relPath);
    for (const f of envelope.files) assertSafeBundleRelPath(f.relPath);
  } catch (err) {
    return { ok: false, errorCode: "UNSAFE_PATH", reason: err instanceof Error ? err.message : String(err) };
  }
  if (envelope.files.length !== manifest.files.length) {
    return { ok: false, errorCode: "HASH_MISMATCH", reason: "Manifest file count does not match payload file count." };
  }
  const expectedMap = new Map(manifest.files.map((f) => [f.relPath, f]));
  const seen = new Set<string>();
  for (const entry of envelope.files) {
    const exp = expectedMap.get(entry.relPath);
    if (!exp || seen.has(entry.relPath)) return { ok: false, errorCode: "HASH_MISMATCH", reason: `Unexpected or duplicate file: ${entry.relPath}` };
    seen.add(entry.relPath);
    const raw = Buffer.from(entry.contentBase64, "base64");
    const actualSha = crypto.createHash("sha256").update(raw).digest("hex");
    if (actualSha !== exp.sha256 || actualSha !== entry.sha256 || raw.length !== exp.size) {
      return { ok: false, errorCode: "HASH_MISMATCH", reason: `SHA-256 or size mismatch for ${entry.relPath}` };
    }
  }
  const keys = (opts.trustedPublicKeys ?? []).filter(Boolean);
  if (keys.length > 0 || !opts.allowUnsigned) {
    if (!envelope.signatureBase64) return { ok: false, errorCode: "SIGNATURE_REQUIRED", reason: "Missing Ed25519 manifest signature." };
    const payload = Buffer.from(canonicalizeJson(manifest), "utf8");
    const sig = Buffer.from(envelope.signatureBase64, "base64");
    const verified = keys.some((pem) => {
      try { return crypto.verify(null, payload, pem, sig); } catch { return false; }
    });
    if (!verified) return { ok: false, errorCode: "SIGNATURE_INVALID", reason: "Ed25519 signature did not verify against any trusted public key." };
  }
  return { ok: true, envelope };
}
export function defaultHotBundleState(nowIso = new Date().toISOString()): HotBundleSlotState {
  return { version: 1, activeSlot: null, pendingSlot: null, previousGoodSlot: null, trustedPublicKeys: [], slots: {}, updatedAtIso: nowIso };
}

export function readHotBundleState(dataDir: string): HotBundleSlotState {
  const filePath = path.join(path.resolve(dataDir), "bundles", "state.json");
  try {
    if (!fs.existsSync(filePath)) return defaultHotBundleState();
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<HotBundleSlotState>;
    return {
      version: 1,
      activeSlot: parsed.activeSlot === "a" || parsed.activeSlot === "b" ? parsed.activeSlot : null,
      pendingSlot: parsed.pendingSlot === "a" || parsed.pendingSlot === "b" ? parsed.pendingSlot : null,
      previousGoodSlot: parsed.previousGoodSlot === "a" || parsed.previousGoodSlot === "b" ? parsed.previousGoodSlot : null,
      trustedPublicKeys: Array.isArray(parsed.trustedPublicKeys) ? parsed.trustedPublicKeys.filter((k): k is string => typeof k === "string") : [],
      slots: parsed.slots && typeof parsed.slots === "object" ? parsed.slots : {},
      updatedAtIso: typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : new Date().toISOString(),
    };
  } catch {
    return defaultHotBundleState();
  }
}

export function hasVerifiedActiveOrPendingSlot(dataDir: string): boolean {
  const s = readHotBundleState(dataDir);
  return Boolean(s.pendingSlot || s.activeSlot);
}

export class HotBundleSlotManager {
  readonly bundlesDir: string;
  readonly statePath: string;
  private state: HotBundleSlotState;

  constructor(private readonly dataDir: string, opts?: { trustedPublicKeys?: string[]; hostNodeModulesDir?: string }) {
    this.bundlesDir = path.join(path.resolve(dataDir), "bundles");
    this.statePath = path.join(this.bundlesDir, "state.json");
    this.state = readHotBundleState(dataDir);
    if (opts?.trustedPublicKeys?.length) {
      for (const k of opts.trustedPublicKeys) this.trustPublicKey(k);
    }
    this.hostNodeModulesDir = opts?.hostNodeModulesDir;
  }

  private readonly hostNodeModulesDir?: string;

  private save(): void {
    this.state.updatedAtIso = new Date().toISOString();
    writeJsonAtomic600(this.statePath, this.state);
  }

  getState(): HotBundleSlotState {
    return structuredClone(this.state);
  }

  slotDir(slot: HotSlotId): string {
    return path.join(this.bundlesDir, `slot-${slot}`);
  }

  trustPublicKey(publicKeyPem: string): void {
    const trimmed = publicKeyPem.trim();
    if (!trimmed || this.state.trustedPublicKeys.includes(trimmed)) return;
    this.state.trustedPublicKeys.push(trimmed);
    this.save();
  }
  resolveBootTarget(fallback: { entryPath: string; uiDir: string; buildId?: string }): {
    slot: HotBootSlot; isPending: boolean; entryPath: string; uiDir: string; bundleId?: string; version?: string;
  } {
    const pick = (slotId: HotSlotId | null): { meta: HotBundleSlotMeta; entryPath: string; uiDir: string } | undefined => {
      if (!slotId) return undefined;
      const meta = this.state.slots[slotId];
      if (!meta || meta.quarantined) return undefined;
      const root = this.slotDir(slotId);
      const entryPath = path.resolve(root, meta.entryRelPath);
      const uiDir = path.resolve(root, meta.uiRelDir);
      if (!fs.existsSync(entryPath) || !fs.existsSync(uiDir)) return undefined;
      return { meta, entryPath, uiDir };
    };
    const p = pick(this.state.pendingSlot);
    if (p) return { slot: p.meta.slot, isPending: true, entryPath: p.entryPath, uiDir: p.uiDir, bundleId: p.meta.bundleId, version: p.meta.version };
    const a = pick(this.state.activeSlot);
    if (a) return { slot: a.meta.slot, isPending: false, entryPath: a.entryPath, uiDir: a.uiDir, bundleId: a.meta.bundleId, version: a.meta.version };
    return { slot: "factory", isPending: false, entryPath: path.resolve(fallback.entryPath), uiDir: path.resolve(fallback.uiDir), ...(fallback.buildId ? { bundleId: fallback.buildId } : {}) };
  }

  stageBundleBuffer(
    buffer: Buffer,
    opts: { allowUnsigned?: boolean; trustedPublicKeys?: string[]; shellAbiVersion?: number; hostNodeModulesDir?: string } = {},
  ): { ok: boolean; slot?: HotSlotId; manifest?: HotBundleManifest; errorCode?: string; reason?: string } {
    const trusted = Array.from(new Set([...this.state.trustedPublicKeys, ...(opts.trustedPublicKeys ?? [])]));
    const check = verifyHotBundleArchive(buffer, { ...opts, trustedPublicKeys: trusted });
    if (!check.ok) return { ok: false, errorCode: check.errorCode, reason: check.reason };
    const { manifest, files } = check.envelope;
    const targetSlot: HotSlotId = this.state.activeSlot === "a" ? "b" : "a";
    const finalDir = this.slotDir(targetSlot);
    const stageDir = path.join(this.bundlesDir, `.staging-${targetSlot}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`);
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    try {
      for (const f of files) {
        const dest = path.resolve(stageDir, f.relPath);
        if (!dest.startsWith(stageDir + path.sep)) throw new Error(`Path escaped staging dir: ${f.relPath}`);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest, Buffer.from(f.contentBase64, "base64"));
      }
      const nmSrc = opts.hostNodeModulesDir ?? this.hostNodeModulesDir;
      const nmDest = path.join(stageDir, "node_modules");
      if (nmSrc && !nmSrc.includes(".asar") && fs.existsSync(nmSrc) && !fs.existsSync(nmDest)) {
        fs.symlinkSync(nmSrc, nmDest, "junction");
      }
      if (fs.existsSync(finalDir)) fs.rmSync(finalDir, { recursive: true, force: true });
      fs.renameSync(stageDir, finalDir);
    } catch (err) {
      fs.rmSync(stageDir, { recursive: true, force: true });
      return { ok: false, errorCode: "EXTRACT_FAILED", reason: err instanceof Error ? err.message : String(err) };
    }
    this.state.pendingSlot = targetSlot;
    this.state.slots[targetSlot] = {
      slot: targetSlot, bundleId: manifest.bundleId, version: manifest.version, ...(manifest.gitHead ? { gitHead: manifest.gitHead } : {}),
      entryRelPath: manifest.entryRelPath, uiRelDir: manifest.uiRelDir, installedAtIso: new Date().toISOString(),
    };
    this.save();
    return { ok: true, slot: targetSlot, manifest };
  }
  commitPendingSlot(): { ok: boolean; activeSlot?: HotSlotId } {
    if (!this.state.pendingSlot) return { ok: false };
    const promoted = this.state.pendingSlot;
    if (this.state.activeSlot && this.state.activeSlot !== promoted) {
      this.state.previousGoodSlot = this.state.activeSlot;
    }
    this.state.activeSlot = promoted;
    this.state.pendingSlot = null;
    this.save();
    return { ok: true, activeSlot: promoted };
  }

  rollbackPendingSlot(reason: string): { ok: boolean; activeSlot: HotSlotId | null; quarantinedBundleId?: string } {
    const bad = this.state.pendingSlot;
    if (!bad) return { ok: false, activeSlot: this.state.activeSlot };
    const meta = this.state.slots[bad];
    if (meta) {
      meta.quarantined = true;
      meta.quarantineReason = reason;
    }
    this.state.pendingSlot = null;
    this.save();
    return { ok: true, activeSlot: this.state.activeSlot, ...(meta ? { quarantinedBundleId: meta.bundleId } : {}) };
  }

  rollbackToPrevious(): { ok: boolean; activeSlot: HotSlotId | null; reason?: string } {
    const prev = this.state.previousGoodSlot;
    if (!prev || prev === this.state.activeSlot || !this.state.slots[prev] || this.state.slots[prev]?.quarantined) {
      return { ok: false, activeSlot: this.state.activeSlot, reason: "NO_PREVIOUS_HEALTHY_SLOT" };
    }
    const oldActive = this.state.activeSlot;
    this.state.activeSlot = prev;
    this.state.previousGoodSlot = oldActive;
    this.state.pendingSlot = null;
    this.save();
    return { ok: true, activeSlot: prev };
  }

  resetToFactoryGolden(): HotBundleSlotState {
    this.state.activeSlot = null;
    this.state.pendingSlot = null;
    this.save();
    return this.getState();
  }
}
