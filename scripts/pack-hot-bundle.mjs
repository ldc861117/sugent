#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSignedHotBundle, generateHotBundleKeyPair } from "../dist/src/sugent/hot-bundle-slots.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = String(pkg.version || "0.1.0");
let gitHead = "nogit";
try {
  gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: rootDir, encoding: "utf8" }).trim() || "nogit";
} catch { /* ignore */ }

const outPath = path.resolve(rootDir, argOf("--out") || path.join("release", `sugent-hot-${version}-${gitHead}.sgbundle.gz`));
const keyPath = argOf("--key");
let privateKeyPem = process.env.SUGENT_HOT_SIGN_PRIVATE_KEY || undefined;
let publicKeyPem = process.env.SUGENT_HOT_SIGN_PUBLIC_KEY || undefined;
if (!privateKeyPem && keyPath && fs.existsSync(path.resolve(keyPath))) {
  privateKeyPem = fs.readFileSync(path.resolve(keyPath), "utf8");
}
if (!privateKeyPem && args.includes("--ephemeral-key")) {
  const kp = generateHotBundleKeyPair();
  privateKeyPem = kp.privateKeyPem;
  publicKeyPem = kp.publicKeyPem;
}

const { buffer, manifest, signatureBase64 } = createSignedHotBundle({
  sourceRoot: rootDir,
  version,
  gitHead,
  privateKeyPem,
  publicKeyPem,
});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, buffer);
console.log(JSON.stringify({ ok: true, outPath, bytes: buffer.length, bundleId: manifest.bundleId, files: manifest.files.length, signed: Boolean(signatureBase64) }, null, 2));
