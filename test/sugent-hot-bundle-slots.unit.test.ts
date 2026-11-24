import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  HotBundleSlotManager,
  SUGENT_SHELL_ABI_VERSION,
  createSignedHotBundle,
  generateHotBundleKeyPair,
  verifyHotBundleArchive,
  type SignedHotBundleEnvelope,
} from "../src/sugent/hot-bundle-slots.js";

describe("L3 Signed Hot Bundle Slots (Ed25519 + SHA-256 + A/B Rollback)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function makeSrcTree(versionTag: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-hb-src-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, "dist", "src", "sugent"), { recursive: true });
    fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sugent", version: versionTag }));
    fs.writeFileSync(path.join(dir, "dist", "src", "sugent", "hot-core-entry.js"), `export const VER = "${versionTag}";\n`);
    fs.writeFileSync(path.join(dir, "ui", "index.html"), `<h1>${versionTag}</h1>`);
    return dir;
  }

  it("rejects tampered files, invalid signatures, Zip-Slip paths, and incompatible ABI versions", () => {
    const kp = generateHotBundleKeyPair();
    const otherKp = generateHotBundleKeyPair();
    const src = makeSrcTree("0.1.16");
    const { buffer } = createSignedHotBundle({ sourceRoot: src, version: "0.1.16", privateKeyPem: kp.privateKeyPem, publicKeyPem: kp.publicKeyPem });

    expect(verifyHotBundleArchive(buffer, { trustedPublicKeys: [kp.publicKeyPem] }).ok).toBe(true);
    expect(verifyHotBundleArchive(buffer, { trustedPublicKeys: [otherKp.publicKeyPem] }).ok).toBe(false);
    expect(verifyHotBundleArchive(buffer, { trustedPublicKeys: [kp.publicKeyPem], shellAbiVersion: 0 }).ok).toBe(false);
    expect(verifyHotBundleArchive(createSignedHotBundle({ sourceRoot: src, version: "0.1.16", minShellAbiVersion: SUGENT_SHELL_ABI_VERSION + 5, privateKeyPem: kp.privateKeyPem }).buffer, { trustedPublicKeys: [kp.publicKeyPem] })).toMatchObject({ ok: false, errorCode: "ABI_MISMATCH" });

    const env = JSON.parse(zlib.gunzipSync(buffer).toString("utf8")) as SignedHotBundleEnvelope;
    env.files[0]!.contentBase64 = Buffer.from("tampered!").toString("base64");
    expect(verifyHotBundleArchive(zlib.gzipSync(Buffer.from(JSON.stringify(env))), { trustedPublicKeys: [kp.publicKeyPem] })).toMatchObject({ ok: false, errorCode: "HASH_MISMATCH" });

    const slipEnv = JSON.parse(zlib.gunzipSync(buffer).toString("utf8")) as SignedHotBundleEnvelope;
    slipEnv.manifest.files[0]!.relPath = "../evil.js";
    slipEnv.files[0]!.relPath = "../evil.js";
    expect(verifyHotBundleArchive(zlib.gzipSync(Buffer.from(JSON.stringify(slipEnv))), { allowUnsigned: true })).toMatchObject({ ok: false, errorCode: "UNSAFE_PATH" });
  });

  it("rotates A/B slots, commits healthy pending slot, quarantines broken pending slot, and supports rollback + factory reset", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-hb-data-"));
    dirs.push(dataDir);
    const kp = generateHotBundleKeyPair();
    const mgr = new HotBundleSlotManager(dataDir, { trustedPublicKeys: [kp.publicKeyPem] });
    const fallback = { entryPath: "/factory/hot-core-entry.js", uiDir: "/factory/ui", buildId: "factory-v0" };

    expect(mgr.resolveBootTarget(fallback).slot).toBe("factory");

    const b1 = createSignedHotBundle({ sourceRoot: makeSrcTree("0.1.16"), version: "0.1.16", privateKeyPem: kp.privateKeyPem });
    const s1 = mgr.stageBundleBuffer(b1.buffer);
    expect(s1).toMatchObject({ ok: true, slot: "a" });
    expect(mgr.resolveBootTarget(fallback)).toMatchObject({ slot: "a", isPending: true, version: "0.1.16" });
    expect(mgr.commitPendingSlot()).toEqual({ ok: true, activeSlot: "a" });

    const b2 = createSignedHotBundle({ sourceRoot: makeSrcTree("0.1.17"), version: "0.1.17", privateKeyPem: kp.privateKeyPem });
    const s2 = mgr.stageBundleBuffer(b2.buffer);
    expect(s2).toMatchObject({ ok: true, slot: "b" });
    expect(mgr.resolveBootTarget(fallback)).toMatchObject({ slot: "b", isPending: true, version: "0.1.17" });

    // Simulate failed boot on slot B -> auto quarantine & rollback to slot A
    expect(mgr.rollbackPendingSlot("boot_timeout")).toMatchObject({ ok: true, activeSlot: "a", quarantinedBundleId: b2.manifest.bundleId });
    expect(mgr.resolveBootTarget(fallback)).toMatchObject({ slot: "a", isPending: false, version: "0.1.16" });

    // Stage & commit healthy v0.1.18 on slot B, then rollback to previous (A) and reset to factory
    const b3 = createSignedHotBundle({ sourceRoot: makeSrcTree("0.1.18"), version: "0.1.18", privateKeyPem: kp.privateKeyPem });
    expect(mgr.stageBundleBuffer(b3.buffer)).toMatchObject({ ok: true, slot: "b" });
    expect(mgr.commitPendingSlot()).toEqual({ ok: true, activeSlot: "b" });
    expect(mgr.rollbackToPrevious()).toEqual({ ok: true, activeSlot: "a" });
    expect(mgr.resetToFactoryGolden().activeSlot).toBeNull();
    expect(mgr.resolveBootTarget(fallback).slot).toBe("factory");
  });
});
