import { randomBytes, timingSafeEqual, webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type BrokerJsonWebKey = webcrypto.JsonWebKey;
export type BrokerCryptoKey = webcrypto.CryptoKey;

export interface BrokerSigningKeyBundle {
  kid: string;
  privateKey: BrokerCryptoKey;
  publicKey: BrokerCryptoKey;
  publicJwk: BrokerJsonWebKey & {
    kid: string;
    alg: "ES256";
    use: "sig";
    kty: "EC";
    crv: "P-256";
  };
}

export interface JwkSetDocument {
  keys: Array<BrokerJsonWebKey & { kid: string; alg?: string; use?: string }>;
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64Url(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, "base64url"));
}

export function randomUrlToken(byteLength = 24): string {
  return randomBytes(byteLength).toString("base64url");
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.byteLength !== bBuf.byteLength) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export async function generateBrokerSigningKeyPair(kid: string): Promise<BrokerSigningKeyBundle> {
  const pair = (await subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;

  const exportedPublic = (await subtle.exportKey("jwk", pair.publicKey)) as BrokerJsonWebKey;
  return {
    kid,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicJwk: {
      ...exportedPublic,
      kty: "EC",
      crv: "P-256",
      kid,
      alg: "ES256",
      use: "sig",
    },
  };
}

export async function importEcSigningKeyFromJwk(
  privateJwkJson: string,
): Promise<BrokerCryptoKey> {
  const jwk = JSON.parse(privateJwkJson) as BrokerJsonWebKey;
  return subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function importBrokerSigningKeyFromJwk(
  privateJwkJson: string,
  kid: string,
): Promise<BrokerSigningKeyBundle> {
  const jwk = JSON.parse(privateJwkJson) as BrokerJsonWebKey;
  const privateKey = await importEcSigningKeyFromJwk(privateJwkJson);
  const { d: _discardD, key_ops: _ops, ...pubFields } = jwk;
  const publicKey = await subtle.importKey(
    "jwk",
    { ...pubFields, key_ops: ["verify"] },
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );

  return {
    kid,
    privateKey,
    publicKey,
    publicJwk: {
      ...pubFields,
      kty: "EC",
      crv: "P-256",
      kid,
      alg: "ES256",
      use: "sig",
    },
  };
}

export async function exportPublicJwkSet(
  bundles: readonly BrokerSigningKeyBundle[],
): Promise<JwkSetDocument> {
  return {
    keys: bundles.map((b) => ({
      kty: b.publicJwk.kty,
      crv: b.publicJwk.crv,
      x: b.publicJwk.x,
      y: b.publicJwk.y,
      kid: b.publicJwk.kid,
      alg: b.publicJwk.alg,
      use: b.publicJwk.use,
    })),
  };
}

export async function signJwtEs256(
  payload: Record<string, unknown>,
  keyBundle: BrokerSigningKeyBundle,
): Promise<string> {
  const headerSegment = toBase64Url(
    encoder.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid: keyBundle.kid })),
  );
  const payloadSegment = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerSegment}.${payloadSegment}`;

  const signature = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyBundle.privateKey,
    encoder.encode(signingInput),
  );

  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyJwtEs256<T = Record<string, unknown>>(
  token: string,
  jwks: JwkSetDocument,
  expected: { issuer: string; audience: string; nowEpochSec?: number },
): Promise<T> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Invalid JWT format");
  }
  const header = JSON.parse(decoder.decode(fromBase64Url(parts[0]))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "ES256") {
    throw new Error(`Unsupported JWT alg "${String(header.alg)}", expected ES256`);
  }

  const matchedJwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!matchedJwk) {
    throw new Error(`No matching JWK found for kid "${String(header.kid)}"`);
  }

  const publicKey = await subtle.importKey(
    "jwk",
    matchedJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const isValid = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    fromBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!isValid) {
    throw new Error("JWT signature verification failed");
  }

  const payload = JSON.parse(decoder.decode(fromBase64Url(parts[1]))) as Record<string, unknown>;
  const now = expected.nowEpochSec ?? Math.floor(Date.now() / 1000);

  if (payload.iss !== expected.issuer) {
    throw new Error(`JWT issuer mismatch: expected "${expected.issuer}"`);
  }
  const audMatch =
    payload.aud === expected.audience ||
    (Array.isArray(payload.aud) && payload.aud.includes(expected.audience));
  if (!audMatch) {
    throw new Error(`JWT audience mismatch: expected "${expected.audience}"`);
  }
  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw new Error("JWT has expired");
  }

  return payload as T;
}

async function deriveAesGcmKey(masterKey: string, purpose: string): Promise<BrokerCryptoKey> {
  const keyMaterial = await subtle.digest(
    "SHA-256",
    encoder.encode(`${purpose}:${masterKey}`),
  );
  return subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function sealStatelessPayload<T>(
  data: T,
  masterKey: string,
  ttlSeconds: number,
): Promise<string> {
  const key = await deriveAesGcmKey(masterKey, "sugent-broker-seal-v1");
  const iv = new Uint8Array(randomBytes(12));

  const envelope = {
    v: 1,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    d: data,
  };
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(envelope)),
  );

  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function unsealStatelessPayload<T>(
  sealed: string,
  masterKey: string,
): Promise<T> {
  const parts = sealed.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Malformed sealed token");
  }
  const key = await deriveAesGcmKey(masterKey, "sugent-broker-seal-v1");
  const iv = fromBase64Url(parts[0]);
  const ciphertext = fromBase64Url(parts[1]);

  const plaintext = await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  const envelope = JSON.parse(decoder.decode(plaintext)) as {
    v: number;
    exp: number;
    d: T;
  };

  if (envelope.v !== 1 || typeof envelope.exp !== "number") {
    throw new Error("Invalid sealed envelope version");
  }
  if (envelope.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("Sealed payload has expired");
  }
  return envelope.d;
}

export async function computePkceS256Challenge(codeVerifier: string): Promise<string> {
  const digest = await subtle.digest("SHA-256", encoder.encode(codeVerifier));
  return toBase64Url(new Uint8Array(digest));
}

export async function verifyPkceS256(
  codeVerifier: string,
  expectedCodeChallenge: string,
): Promise<boolean> {
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }
  const computed = await computePkceS256Challenge(codeVerifier);
  return timingSafeEqualStrings(computed, expectedCodeChallenge);
}

export async function deriveUnifiedUserId(
  idp: string,
  providerSubject: string,
  masterKey: string,
): Promise<string> {
  const hmacKey = await subtle.importKey(
    "raw",
    encoder.encode(`sugent-sub-v1:${masterKey}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign(
    "HMAC",
    hmacKey,
    encoder.encode(`${idp}:${providerSubject}`),
  );
  return `usr_${toBase64Url(new Uint8Array(mac).slice(0, 24))}`;
}

export async function verifyRemoteRs256IdToken(
  idToken: string,
  jwks: JwkSetDocument,
  expected: { issuer: string | readonly string[]; audience: string; nonce?: string },
): Promise<Record<string, unknown>> {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Malformed upstream id_token");
  }
  const header = JSON.parse(decoder.decode(fromBase64Url(parts[0]))) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== "RS256") {
    throw new Error(`Expected RS256 upstream id_token, received "${String(header.alg)}"`);
  }

  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    throw new Error(`Upstream JWKS missing kid "${String(header.kid)}"`);
  }

  const rsaKey = await subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await subtle.verify(
    "RSASSA-PKCS1-v1_5",
    rsaKey,
    fromBase64Url(parts[2]),
    encoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) {
    throw new Error("Upstream RS256 id_token signature invalid");
  }

  const claims = JSON.parse(decoder.decode(fromBase64Url(parts[1]))) as Record<string, unknown>;
  const allowedIssuers = Array.isArray(expected.issuer) ? expected.issuer : [expected.issuer];
  if (typeof claims.iss !== "string" || !allowedIssuers.includes(claims.iss)) {
    throw new Error(`Upstream id_token issuer mismatch: ${String(claims.iss)}`);
  }

  const audValid =
    claims.aud === expected.audience ||
    (Array.isArray(claims.aud) && claims.aud.includes(expected.audience));
  if (!audValid) {
    throw new Error(`Upstream id_token audience mismatch: ${String(claims.aud)}`);
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp <= now) {
    throw new Error("Upstream id_token expired");
  }
  if (expected.nonce && claims.nonce !== expected.nonce) {
    throw new Error("Upstream id_token nonce mismatch");
  }

  return claims;
}
