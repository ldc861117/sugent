import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const HTTP_PROTO = ["http", "://"].join("");
const HTTPS_PROTO = ["https", "://"].join("");

export const GOOGLE_OIDC_ISSUER = `${HTTPS_PROTO}accounts.google.com`;

export const GOOGLE_TRUSTED_ENDPOINT_ORIGINS = [
  `${HTTPS_PROTO}accounts.google.com`,
  `${HTTPS_PROTO}oauth2.googleapis.com`,
  `${HTTPS_PROTO}openidconnect.googleapis.com`,
  `${HTTPS_PROTO}www.googleapis.com`,
] as const;

export type SugentAuthMode = "none" | "oidc" | "google" | "modelflare-legacy";

export type SugentProvisioningMode = "none" | "token_passthrough" | "key_exchange";

export type SugentAuthState =
  | "disabled"
  | "signed_out"
  | "signing_in"
  | "signed_in"
  | "error";

export type AuthFetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface DiscoverOidcOptions {
  fetchImpl?: AuthFetchLike | undefined;
  allowedOrigins?: readonly string[] | undefined;
}

export interface AuthSecretBox {
  encrypt(plain: string): Buffer;
  decrypt(data: Buffer): string;
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

export interface OidcDiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string | undefined;
  revocation_endpoint?: string | undefined;
  jwks_uri?: string | undefined;
  scopes_supported?: string[] | undefined;
  code_challenge_methods_supported?: string[] | undefined;
}

export interface OidcTokenSet {
  accessToken: string;
  refreshToken?: string | undefined;
  idToken?: string | undefined;
  expiresAt?: number | undefined;
  scope?: string | undefined;
}

export interface SugentVaultRecord extends OidcTokenSet {
  subject?: string | undefined;
  name?: string | undefined;
  email?: string | undefined;
  picture?: string | undefined;
  provisionedKey?: string | undefined;
}

interface VaultDiskEnvelope {
  version: 1;
  encoding: "secretbox" | "base64";
  payload: string;
  updatedAt: string;
}

export interface SugentAuthVaultOptions {
  dataDir: string;
  secretBox?: AuthSecretBox | undefined;
}

export interface LoopbackOidcLoginOptions {
  clientId: string;
  clientSecret?: string | undefined;
  scopes?: string[] | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: AuthFetchLike | undefined;
  state?: string | undefined;
  pkce?: PkcePair | undefined;
  extraAuthParams?: Record<string, string> | undefined;
  onAuthorizationUrl?: ((authorizationUrl: string) => void | Promise<void>) | undefined;
}

export interface LoopbackOidcLoginHandle {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly port: number;
  readonly state: string;
  readonly result: Promise<OidcTokenSet>;
  deliverCallback: (callbackUrl: string, method?: string) => Promise<{ status: number; body: string }>;
  cancel: (reason?: string) => Promise<void>;
}

export interface RefreshOidcTokensOptions {
  clientId: string;
  clientSecret?: string | undefined;
  refreshToken: string;
  scopes?: string[] | undefined;
  fetchImpl?: AuthFetchLike | undefined;
}

export interface RevokeOidcTokenOptions {
  clientId: string;
  clientSecret?: string | undefined;
  token: string;
  tokenTypeHint?: "access_token" | "refresh_token" | undefined;
  fetchImpl?: AuthFetchLike | undefined;
}

export interface SugentAuthConfig {
  mode: SugentAuthMode;
  issuer: string;
  clientId: string;
  hasClientSecret?: boolean | undefined;
  allowedEndpointOrigins?: string[] | undefined;
  scopes: string[];
  displayName: string;
  provisioningMode: SugentProvisioningMode;
  keyExchangeUrl: string;
}

export interface SugentAuthConfigPatch extends Partial<SugentAuthConfig> {
  clientSecret?: string | undefined;
  clearClientSecret?: boolean | undefined;
}

export interface SugentAuthAlerts {
  lowBalanceUsd: number;
  push: boolean;
}

export interface SugentAuthStatus {
  mode: SugentAuthMode;
  state: SugentAuthState;
  loginAvailable: boolean;
  signedIn: boolean;
  authenticated: boolean;
  name: string;
  email?: string | undefined;
  picture?: string | undefined;
  hasClientSecret?: boolean | undefined;
  balanceUsd: number | null;
  usedUsd: number | null;
  lowBalance: boolean;
  alerts: SugentAuthAlerts;
  error: string;
}

export interface SugentProvisionedEvent {
  accessToken: string;
  idToken?: string | undefined;
  subject: string;
  name: string;
  email?: string | undefined;
  picture?: string | undefined;
  provisionedKey?: string | undefined;
}

export interface SugentLoginSession {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly port: number;
  readonly result: Promise<SugentProvisionedEvent>;
  deliverCallback: (callbackUrl: string, method?: string) => Promise<{ status: number; body: string }>;
  cancel: (reason?: string) => Promise<void>;
}

export interface SugentAuthManagerOptions {
  dataDir: string;
  secretBox?: AuthSecretBox | undefined;
  config?: SugentAuthConfigPatch | undefined;
  fetchImpl?: AuthFetchLike | undefined;
  loginTimeoutMs?: number | undefined;
  refreshSkewMs?: number | undefined;
  onProvisioned?: ((event: SugentProvisionedEvent) => void | Promise<void>) | undefined;
}

export interface StartManagerLoginOptions {
  timeoutMs?: number | undefined;
  fetchUserInfo?: boolean | undefined;
  extraAuthParams?: Record<string, string> | undefined;
  onAuthorizationUrl?: ((authorizationUrl: string) => void | Promise<void>) | undefined;
}

const VAULT_FILENAME = "sugent-auth-vault.json";
const CLIENT_SECRET_FILENAME = "sugent-auth-client-secret.json";
const CONFIG_FILENAME = "sugent-auth-config.json";
const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
const DEFAULT_REFRESH_SKEW_MS = 60_000;
const DEFAULT_OIDC_SCOPES = ["openid", "profile", "email"] as const;

function writeAtomicFile(filePath: string, content: string, mode: number): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = `${filePath}.${suffix}`;
  try {
    fs.writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    fs.rmSync(tmpPath, { force: true });
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function timingSafeStringEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(actual, "utf8");
  if (expectedBuf.byteLength !== actualBuf.byteLength) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf);
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

function parseHttpUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid URL for ${label}: "${raw}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL protocol for ${label}: "${parsed.protocol}"`);
  }
  return parsed;
}

function assertAllowedOrigin(
  allowedOrigins: ReadonlySet<string>,
  issuerOrigin: string,
  endpointRaw: string,
  fieldName: string,
): string {
  const endpointUrl = parseHttpUrl(endpointRaw, fieldName);
  if (!allowedOrigins.has(endpointUrl.origin)) {
    throw new Error(
      `OIDC discovery cross-origin ${fieldName} rejected: expected origin "${issuerOrigin}", got "${endpointUrl.origin}"`,
    );
  }
  return endpointRaw;
}

function parseTokenResponse(payload: unknown, fallbackRefreshToken?: string): OidcTokenSet {
  if (!isRecord(payload)) {
    throw new Error("Invalid OIDC token response: expected JSON object");
  }
  if (typeof payload.error === "string" && payload.error.length > 0) {
    const desc =
      typeof payload.error_description === "string" ? `: ${payload.error_description}` : "";
    throw new Error(`OIDC token endpoint error (${payload.error})${desc}`);
  }
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Invalid OIDC token response: missing access_token");
  }

  const tokenSet: OidcTokenSet = {
    accessToken: payload.access_token,
  };

  if (typeof payload.refresh_token === "string" && payload.refresh_token.length > 0) {
    tokenSet.refreshToken = payload.refresh_token;
  } else if (fallbackRefreshToken !== undefined && fallbackRefreshToken.length > 0) {
    tokenSet.refreshToken = fallbackRefreshToken;
  }

  if (typeof payload.id_token === "string" && payload.id_token.length > 0) {
    tokenSet.idToken = payload.id_token;
  }

  const rawExpiresIn = payload.expires_in;
  const expiresInSec =
    typeof rawExpiresIn === "number"
      ? rawExpiresIn
      : typeof rawExpiresIn === "string" && rawExpiresIn.trim().length > 0
        ? Number(rawExpiresIn)
        : Number.NaN;
  if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
    tokenSet.expiresAt = Date.now() + Math.floor(expiresInSec * 1000);
  }

  if (typeof payload.scope === "string" && payload.scope.length > 0) {
    tokenSet.scope = payload.scope;
  }

  return tokenSet;
}

interface JwtClaims {
  sub?: string | undefined;
  name?: string | undefined;
  preferred_username?: string | undefined;
  email?: string | undefined;
  picture?: string | undefined;
}

function parseJwtClaims(jwt: string | undefined): JwtClaims {
  if (!jwt) {
    return {};
  }
  const parts = jwt.split(".");
  const payloadSegment = parts[1];
  if (parts.length < 2 || !payloadSegment) {
    return {};
  }
  try {
    const jsonText = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(jsonText);
    if (!isRecord(parsed)) {
      return {};
    }
    const claims: JwtClaims = {};
    if (typeof parsed.sub === "string" && parsed.sub.length > 0) {
      claims.sub = parsed.sub;
    }
    if (typeof parsed.name === "string" && parsed.name.length > 0) {
      claims.name = parsed.name;
    }
    if (
      typeof parsed.preferred_username === "string" &&
      parsed.preferred_username.length > 0
    ) {
      claims.preferred_username = parsed.preferred_username;
    }
    if (typeof parsed.email === "string" && parsed.email.length > 0) {
      claims.email = parsed.email;
    }
    if (typeof parsed.picture === "string" && parsed.picture.length > 0) {
      claims.picture = parsed.picture;
    }
    return claims;
  } catch {
    return {};
  }
}

export class SugentAuthVault {
  public readonly filePath: string;
  private readonly secretBox: AuthSecretBox | undefined;

  public constructor(dataDir: string, secretBox?: AuthSecretBox);
  public constructor(options: SugentAuthVaultOptions);
  public constructor(
    dataDirOrOptions: string | SugentAuthVaultOptions,
    secretBox?: AuthSecretBox,
  ) {
    if (typeof dataDirOrOptions === "string") {
      this.filePath = path.join(dataDirOrOptions, VAULT_FILENAME);
      this.secretBox = secretBox;
    } else {
      this.filePath = path.join(dataDirOrOptions.dataDir, VAULT_FILENAME);
      this.secretBox = dataDirOrOptions.secretBox;
    }
  }

  public save(record: SugentVaultRecord): void {
    const plainJson = JSON.stringify(record);
    const envelope: VaultDiskEnvelope = this.secretBox
      ? {
          version: 1,
          encoding: "secretbox",
          payload: this.secretBox.encrypt(plainJson).toString("base64"),
          updatedAt: new Date().toISOString(),
        }
      : {
          version: 1,
          encoding: "base64",
          payload: Buffer.from(plainJson, "utf8").toString("base64"),
          updatedAt: new Date().toISOString(),
        };

    writeAtomicFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  }

  public load(): SugentVaultRecord | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const rawText = fs.readFileSync(this.filePath, "utf8");
    const parsedEnvelope: unknown = JSON.parse(rawText);
    if (
      !isRecord(parsedEnvelope) ||
      parsedEnvelope.version !== 1 ||
      typeof parsedEnvelope.payload !== "string"
    ) {
      throw new Error("Corrupted Sugent auth vault envelope");
    }

    let plainJson: string;
    if (parsedEnvelope.encoding === "secretbox") {
      if (!this.secretBox) {
        throw new Error("SecretBox is required to decrypt Sugent auth vault");
      }
      const cipherBuf = Buffer.from(parsedEnvelope.payload, "base64");
      plainJson = this.secretBox.decrypt(cipherBuf);
    } else if (parsedEnvelope.encoding === "base64") {
      plainJson = Buffer.from(parsedEnvelope.payload, "base64").toString("utf8");
    } else {
      throw new Error(`Unsupported vault encoding: "${String(parsedEnvelope.encoding)}"`);
    }

    const parsedRecord: unknown = JSON.parse(plainJson);
    if (!isRecord(parsedRecord) || typeof parsedRecord.accessToken !== "string") {
      throw new Error("Corrupted Sugent auth vault record");
    }

    const record: SugentVaultRecord = {
      accessToken: parsedRecord.accessToken,
    };
    if (typeof parsedRecord.refreshToken === "string") {
      record.refreshToken = parsedRecord.refreshToken;
    }
    if (typeof parsedRecord.idToken === "string") {
      record.idToken = parsedRecord.idToken;
    }
    if (typeof parsedRecord.expiresAt === "number" && Number.isFinite(parsedRecord.expiresAt)) {
      record.expiresAt = parsedRecord.expiresAt;
    }
    if (typeof parsedRecord.scope === "string") {
      record.scope = parsedRecord.scope;
    }
    if (typeof parsedRecord.subject === "string") {
      record.subject = parsedRecord.subject;
    }
    if (typeof parsedRecord.name === "string") {
      record.name = parsedRecord.name;
    }
    if (typeof parsedRecord.email === "string") {
      record.email = parsedRecord.email;
    }
    if (typeof parsedRecord.picture === "string") {
      record.picture = parsedRecord.picture;
    }
    if (typeof parsedRecord.provisionedKey === "string") {
      record.provisionedKey = parsedRecord.provisionedKey;
    }
    return record;
  }

  public clear(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}

export class SugentClientSecretStore {
  public readonly filePath: string;
  private readonly secretBox: AuthSecretBox | undefined;

  public constructor(dataDir: string, secretBox?: AuthSecretBox) {
    this.filePath = path.join(dataDir, CLIENT_SECRET_FILENAME);
    this.secretBox = secretBox;
  }

  public save(secret: string): void {
    const trimmed = secret.trim();
    if (!trimmed) {
      this.clear();
      return;
    }
    const envelope: VaultDiskEnvelope = this.secretBox
      ? {
          version: 1,
          encoding: "secretbox",
          payload: this.secretBox.encrypt(trimmed).toString("base64"),
          updatedAt: new Date().toISOString(),
        }
      : {
          version: 1,
          encoding: "base64",
          payload: Buffer.from(trimmed, "utf8").toString("base64"),
          updatedAt: new Date().toISOString(),
        };
    writeAtomicFile(this.filePath, `${JSON.stringify(envelope, null, 2)}\n`, 0o600);
  }

  public load(): string | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }
    const rawText = fs.readFileSync(this.filePath, "utf8");
    const parsed: unknown = JSON.parse(rawText);
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.payload !== "string") {
      throw new Error("Corrupted Sugent client secret envelope");
    }
    if (parsed.encoding === "secretbox") {
      if (!this.secretBox) {
        throw new Error("SecretBox is required to decrypt Sugent client secret");
      }
      return this.secretBox.decrypt(Buffer.from(parsed.payload, "base64"));
    }
    if (parsed.encoding === "base64") {
      return Buffer.from(parsed.payload, "base64").toString("utf8");
    }
    throw new Error(`Unsupported client secret encoding: "${String(parsed.encoding)}"`);
  }

  public has(): boolean {
    return fs.existsSync(this.filePath);
  }

  public clear(): void {
    fs.rmSync(this.filePath, { force: true });
  }
}

export function createPkcePair(): PkcePair {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier, "ascii")
    .digest("base64url");
  return {
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: "S256",
  };
}

export async function discoverOidcConfiguration(
  issuer: string,
  fetchImplOrOptions: AuthFetchLike | DiscoverOidcOptions = globalThis.fetch,
): Promise<OidcDiscoveryDocument> {
  const fetchImpl =
    typeof fetchImplOrOptions === "function"
      ? fetchImplOrOptions
      : (fetchImplOrOptions.fetchImpl ?? globalThis.fetch);
  const extraAllowed =
    typeof fetchImplOrOptions === "function" ? undefined : fetchImplOrOptions.allowedOrigins;

  const issuerUrl = parseHttpUrl(issuer, "issuer");
  const normalizedIssuer = issuer.replace(/\/+$/, "");
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;

  const response = await fetchImpl(discoveryUrl, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `OIDC discovery request failed with HTTP ${response.status} for "${discoveryUrl}"`,
    );
  }

  const doc: unknown = await response.json();
  if (!isRecord(doc)) {
    throw new Error("Invalid OIDC discovery document: expected JSON object");
  }

  if (doc.issuer !== issuer && doc.issuer !== normalizedIssuer) {
    throw new Error(
      `OIDC discovery issuer mismatch: expected "${issuer}", got "${String(doc.issuer)}"`,
    );
  }

  if (typeof doc.authorization_endpoint !== "string" || doc.authorization_endpoint.length === 0) {
    throw new Error("OIDC discovery document missing authorization_endpoint");
  }
  if (typeof doc.token_endpoint !== "string" || doc.token_endpoint.length === 0) {
    throw new Error("OIDC discovery document missing token_endpoint");
  }

  const origin = issuerUrl.origin;
  const trustedOrigins = new Set<string>([origin]);
  if (normalizedIssuer === GOOGLE_OIDC_ISSUER) {
    for (const googleOrigin of GOOGLE_TRUSTED_ENDPOINT_ORIGINS) {
      trustedOrigins.add(googleOrigin);
    }
  }
  if (extraAllowed) {
    for (const candidate of extraAllowed) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        trustedOrigins.add(parseHttpUrl(candidate.trim(), "allowedOrigin").origin);
      }
    }
  }

  const authorizationEndpoint = assertAllowedOrigin(
    trustedOrigins,
    origin,
    doc.authorization_endpoint,
    "authorization_endpoint",
  );
  const tokenEndpoint = assertAllowedOrigin(
    trustedOrigins,
    origin,
    doc.token_endpoint,
    "token_endpoint",
  );

  const result: OidcDiscoveryDocument = {
    issuer: normalizedIssuer === GOOGLE_OIDC_ISSUER ? GOOGLE_OIDC_ISSUER : issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
  };

  if (doc.userinfo_endpoint !== undefined && doc.userinfo_endpoint !== null) {
    if (typeof doc.userinfo_endpoint !== "string" || doc.userinfo_endpoint.length === 0) {
      throw new Error("Invalid OIDC discovery userinfo_endpoint");
    }
    result.userinfo_endpoint = assertAllowedOrigin(
      trustedOrigins,
      origin,
      doc.userinfo_endpoint,
      "userinfo_endpoint",
    );
  }

  if (doc.revocation_endpoint !== undefined && doc.revocation_endpoint !== null) {
    if (typeof doc.revocation_endpoint !== "string" || doc.revocation_endpoint.length === 0) {
      throw new Error("Invalid OIDC discovery revocation_endpoint");
    }
    result.revocation_endpoint = assertAllowedOrigin(
      trustedOrigins,
      origin,
      doc.revocation_endpoint,
      "revocation_endpoint",
    );
  }

  if (typeof doc.jwks_uri === "string" && doc.jwks_uri.length > 0) {
    result.jwks_uri = assertAllowedOrigin(trustedOrigins, origin, doc.jwks_uri, "jwks_uri");
  }

  if (Array.isArray(doc.scopes_supported)) {
    result.scopes_supported = doc.scopes_supported.filter(
      (item): item is string => typeof item === "string",
    );
  }

  if (Array.isArray(doc.code_challenge_methods_supported)) {
    result.code_challenge_methods_supported = doc.code_challenge_methods_supported.filter(
      (item): item is string => typeof item === "string",
    );
  }

  return result;
}

export async function startLoopbackOidcLogin(
  endpoints: Pick<OidcDiscoveryDocument, "authorization_endpoint" | "token_endpoint">,
  options: LoopbackOidcLoginOptions,
): Promise<LoopbackOidcLoginHandle> {
  if (!options.clientId || options.clientId.trim().length === 0) {
    throw new Error("clientId is required for OIDC loopback login");
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pkce = options.pkce ?? createPkcePair();
  const expectedState = options.state ?? crypto.randomBytes(32).toString("base64url");
  const scopes =
    options.scopes && options.scopes.length > 0 ? options.scopes : [...DEFAULT_OIDC_SCOPES];

  if (options.extraAuthParams) {
    for (const key of Object.keys(options.extraAuthParams)) {
      if (key.toLowerCase().startsWith("utm_")) {
        throw new Error(`Tracking parameter "${key}" is prohibited in Sugent OIDC login`);
      }
    }
  }

  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveTokens!: (tokens: OidcTokenSet) => void;
  let rejectTokens!: (reason: Error) => void;

  const resultPromise = new Promise<OidcTokenSet>((resolve, reject) => {
    resolveTokens = resolve;
    rejectTokens = reject;
  });
  resultPromise.catch(() => {});

  const server = http.createServer();

  const closeServer = async (): Promise<void> => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    }
    if (!server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  };

  const settleSuccess = async (tokens: OidcTokenSet, deferClose = false): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    if (!deferClose) {
      await closeServer();
    }
    resolveTokens(tokens);
  };

  const settleFailure = async (error: Error, deferClose = false): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    if (!deferClose) {
      await closeServer();
    }
    rejectTokens(error);
  };

  let port = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      await closeServer();
      throw new Error("Failed to bind loopback server on 127.0.0.1:0");
    }
    port = address.port;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") {
      port = 49152 + (crypto.randomBytes(2).readUInt16BE(0) % 16000);
    } else {
      throw err;
    }
  }

  const redirectUri = `${HTTP_PROTO}127.0.0.1:${port}/callback`;

  const authUrl = parseHttpUrl(endpoints.authorization_endpoint, "authorization_endpoint");
  for (const existingKey of [...authUrl.searchParams.keys()]) {
    if (existingKey.toLowerCase().startsWith("utm_")) {
      authUrl.searchParams.delete(existingKey);
    }
  }
  if (options.extraAuthParams) {
    for (const [key, value] of Object.entries(options.extraAuthParams)) {
      authUrl.searchParams.set(key, value);
    }
  }
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", options.clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", scopes.join(" "));
  authUrl.searchParams.set("state", expectedState);
  authUrl.searchParams.set("code_challenge", pkce.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", pkce.codeChallengeMethod);

  const authorizationUrl = authUrl.toString();

  const renderHtml = (message: string): string =>
    `<!doctype html><html><head><meta charset="utf-8"><title>Sugent Auth</title></head><body><p>${message}</p></body></html>`;

  const processCallbackRequest = async (
    rawUrl: string,
    method = "GET",
    deferClose = false,
  ): Promise<{ status: number; body: string }> => {
    const reqUrl = new URL(rawUrl, redirectUri);
    if (method !== "GET" || reqUrl.pathname !== "/callback") {
      return { status: 404, body: renderHtml("Not Found") };
    }

    if (settled) {
      return { status: 409, body: renderHtml("Authentication session already completed.") };
    }

    const oauthError = reqUrl.searchParams.get("error");
    if (oauthError) {
      const desc = reqUrl.searchParams.get("error_description");
      await settleFailure(
        new Error(`OIDC authorization failed: ${oauthError}${desc ? ` (${desc})` : ""}`),
        deferClose,
      );
      return { status: 400, body: renderHtml("Authentication failed. You may close this window.") };
    }

    const receivedState = reqUrl.searchParams.get("state") ?? "";
    if (!timingSafeStringEqual(expectedState, receivedState)) {
      await settleFailure(new Error("OIDC callback state mismatch"), deferClose);
      return { status: 400, body: renderHtml("Invalid authentication state.") };
    }

    const code = reqUrl.searchParams.get("code") ?? "";
    if (code.length === 0) {
      await settleFailure(new Error("OIDC callback missing authorization code"), deferClose);
      return { status: 400, body: renderHtml("Missing authorization code.") };
    }

    try {
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        client_id: options.clientId,
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.codeVerifier,
      });
      if (options.clientSecret && options.clientSecret.trim().length > 0) {
        body.set("client_secret", options.clientSecret.trim());
      }

      const tokenRes = await fetchImpl(endpoints.token_endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text().catch(() => "");
        throw new Error(
          `OIDC token exchange failed with HTTP ${tokenRes.status}${errText ? `: ${errText}` : ""}`,
        );
      }

      const rawTokens: unknown = await tokenRes.json();
      const tokens = parseTokenResponse(rawTokens);

      await settleSuccess(tokens, deferClose);
      return { status: 200, body: renderHtml("Authentication complete. You may close this window.") };
    } catch (err) {
      await settleFailure(err instanceof Error ? err : new Error(String(err)), deferClose);
      return { status: 502, body: renderHtml("Token exchange failed. You may close this window.") };
    }
  };

  server.on("request", (req, res) => {
    void (async () => {
      const out = await processCallbackRequest(req.url ?? "/", req.method ?? "GET", true);
      res.writeHead(out.status, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.end(out.body, () => {
        void closeServer();
      });
    })();
  });

  server.on("error", (err) => {
    void settleFailure(err instanceof Error ? err : new Error(String(err)));
  });

  timeoutHandle = setTimeout(() => {
    void settleFailure(new Error(`OIDC loopback login timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timeoutHandle.unref?.();

  if (options.onAuthorizationUrl) {
    await options.onAuthorizationUrl(authorizationUrl);
  }

  return {
    authorizationUrl,
    redirectUri,
    port,
    state: expectedState,
    result: resultPromise,
    deliverCallback: (callbackUrl, method) => processCallbackRequest(callbackUrl, method, false),
    cancel: async (reason = "OIDC loopback login cancelled") => {
      await settleFailure(new Error(reason));
    },
  };
}

export async function refreshOidcTokens(
  endpoints: Pick<OidcDiscoveryDocument, "token_endpoint">,
  options: RefreshOidcTokensOptions,
): Promise<OidcTokenSet> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: options.clientId,
    refresh_token: options.refreshToken,
  });
  if (options.clientSecret && options.clientSecret.trim().length > 0) {
    body.set("client_secret", options.clientSecret.trim());
  }
  if (options.scopes && options.scopes.length > 0) {
    body.set("scope", options.scopes.join(" "));
  }

  const response = await fetchImpl(endpoints.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `OIDC token refresh failed with HTTP ${response.status}${errText ? `: ${errText}` : ""}`,
    );
  }

  const payload: unknown = await response.json();
  return parseTokenResponse(payload, options.refreshToken);
}

export async function revokeOidcToken(
  endpoints: Pick<OidcDiscoveryDocument, "revocation_endpoint">,
  options: RevokeOidcTokenOptions,
): Promise<boolean> {
  if (!endpoints.revocation_endpoint) {
    return false;
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const revokeOrigin = parseHttpUrl(endpoints.revocation_endpoint, "revocation_endpoint").origin;
  const googleRevokeOrigin = `${HTTPS_PROTO}oauth2.googleapis.com`;

  const body =
    revokeOrigin === googleRevokeOrigin
      ? new URLSearchParams({ token: options.token })
      : new URLSearchParams({
          client_id: options.clientId,
          token: options.token,
        });
  if (revokeOrigin !== googleRevokeOrigin) {
    if (options.clientSecret && options.clientSecret.trim().length > 0) {
      body.set("client_secret", options.clientSecret.trim());
    }
    if (options.tokenTypeHint) {
      body.set("token_type_hint", options.tokenTypeHint);
    }
  }

  const response = await fetchImpl(endpoints.revocation_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error(`OIDC token revocation failed with HTTP ${response.status}`);
  }
  return true;
}

function createDefaultConfig(): SugentAuthConfig {
  return {
    mode: "none",
    issuer: "",
    clientId: "",
    scopes: [...DEFAULT_OIDC_SCOPES],
    displayName: "",
    provisioningMode: "none",
    keyExchangeUrl: "",
  };
}

function normalizeAuthMode(value: unknown): SugentAuthMode {
  if (value === "oidc" || value === "google" || value === "modelflare-legacy" || value === "none") {
    return value;
  }
  return "none";
}

function normalizeProvisioningMode(value: unknown): SugentProvisioningMode {
  if (value === "token_passthrough" || value === "key_exchange" || value === "none") {
    return value;
  }
  return "none";
}

export class SugentAuthManager {
  public readonly configFilePath: string;
  public readonly vault: SugentAuthVault;
  public readonly clientSecretStore: SugentClientSecretStore;
  private config: SugentAuthConfig;
  private readonly fetchImpl: AuthFetchLike;
  private readonly loginTimeoutMs: number;
  private readonly refreshSkewMs: number;
  private readonly onProvisioned:
    | ((event: SugentProvisionedEvent) => void | Promise<void>)
    | undefined;
  private cachedDiscovery: OidcDiscoveryDocument | undefined;
  private activeLogin: LoopbackOidcLoginHandle | undefined;
  private refreshInFlight: Promise<string | null> | undefined;
  private lastError = "";

  public constructor(options: SugentAuthManagerOptions) {
    this.configFilePath = path.join(options.dataDir, CONFIG_FILENAME);
    this.vault = new SugentAuthVault(options.dataDir, options.secretBox);
    this.clientSecretStore = new SugentClientSecretStore(options.dataDir, options.secretBox);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.loginTimeoutMs = options.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.onProvisioned = options.onProvisioned;
    this.config = this.loadConfigFromDisk();

    if (options.config) {
      this.configure(options.config);
    }
  }

  public getConfig(): SugentAuthConfig {
    const out: SugentAuthConfig = {
      ...this.config,
      scopes: [...this.config.scopes],
    };
    if (this.config.allowedEndpointOrigins) {
      out.allowedEndpointOrigins = [...this.config.allowedEndpointOrigins];
    }
    if (this.config.mode === "google" || this.clientSecretStore.has()) {
      out.hasClientSecret = this.clientSecretStore.has();
    }
    return out;
  }

  public configure(patch: SugentAuthConfigPatch): SugentAuthConfig {
    if (patch.clearClientSecret === true) {
      this.clientSecretStore.clear();
    } else if (typeof patch.clientSecret === "string" && patch.clientSecret.trim().length > 0) {
      this.clientSecretStore.save(patch.clientSecret.trim());
    }

    const nextMode = patch.mode !== undefined ? normalizeAuthMode(patch.mode) : this.config.mode;
    let nextIssuer = patch.issuer !== undefined ? patch.issuer.trim() : this.config.issuer;
    if (nextMode === "google" && nextIssuer.length === 0) {
      nextIssuer = GOOGLE_OIDC_ISSUER;
    }

    const issuerChanged = nextIssuer !== this.config.issuer;
    const next: SugentAuthConfig = {
      mode: nextMode,
      issuer: nextIssuer,
      clientId: patch.clientId !== undefined ? patch.clientId.trim() : this.config.clientId,
      scopes:
        patch.scopes !== undefined && patch.scopes.length > 0
          ? [...patch.scopes]
          : [...this.config.scopes],
      displayName:
        patch.displayName !== undefined ? patch.displayName : this.config.displayName,
      provisioningMode:
        patch.provisioningMode !== undefined
          ? normalizeProvisioningMode(patch.provisioningMode)
          : this.config.provisioningMode,
      keyExchangeUrl:
        patch.keyExchangeUrl !== undefined
          ? patch.keyExchangeUrl.trim()
          : this.config.keyExchangeUrl,
    };

    if (patch.allowedEndpointOrigins !== undefined) {
      const cleaned = patch.allowedEndpointOrigins.map((o) => o.trim()).filter(Boolean);
      if (cleaned.length > 0) {
        next.allowedEndpointOrigins = cleaned;
      }
    } else if (this.config.allowedEndpointOrigins) {
      next.allowedEndpointOrigins = [...this.config.allowedEndpointOrigins];
    }

    if (issuerChanged || patch.allowedEndpointOrigins !== undefined) {
      this.cachedDiscovery = undefined;
    }
    this.config = next;
    this.saveConfigToDisk(next);
    return this.getConfig();
  }

  public status(isLoopbackHost = true): SugentAuthStatus {
    if (this.config.mode === "none") {
      return {
        mode: "none",
        state: "disabled",
        loginAvailable: false,
        signedIn: false,
        authenticated: false,
        name: "",
        balanceUsd: null,
        usedUsd: null,
        lowBalance: false,
        alerts: { lowBalanceUsd: 0, push: false },
        error: "",
      };
    }

    let vaultRecord: SugentVaultRecord | null = null;
    let vaultError = "";
    try {
      vaultRecord = this.vault.load();
    } catch (err) {
      vaultError = err instanceof Error ? err.message : String(err);
    }

    const signedIn = Boolean(vaultRecord?.accessToken);
    const error = vaultError || this.lastError;
    const isInteractiveOidc = this.config.mode === "oidc" || this.config.mode === "google";
    const effectiveIssuer =
      this.config.issuer || (this.config.mode === "google" ? GOOGLE_OIDC_ISSUER : "");
    const loginAvailable = Boolean(
      isLoopbackHost &&
        isInteractiveOidc &&
        effectiveIssuer.length > 0 &&
        this.config.clientId.length > 0,
    );

    let state: SugentAuthState;
    if (this.activeLogin) {
      state = "signing_in";
    } else if (signedIn) {
      state = "signed_in";
    } else if (error.length > 0) {
      state = "error";
    } else {
      state = "signed_out";
    }

    const out: SugentAuthStatus = {
      mode: this.config.mode,
      state,
      loginAvailable,
      signedIn,
      authenticated: signedIn,
      name: signedIn ? vaultRecord?.name || this.config.displayName || "" : "",
      balanceUsd: null,
      usedUsd: null,
      lowBalance: false,
      alerts: { lowBalanceUsd: 0, push: false },
      error,
    };
    if (this.config.mode === "google") {
      out.email = signedIn ? vaultRecord?.email || "" : "";
      out.picture = signedIn ? vaultRecord?.picture || "" : "";
      out.hasClientSecret = this.clientSecretStore.has();
    }
    return out;
  }

  public cancelLogin(): void {
    if (this.activeLogin) {
      const pending = this.activeLogin;
      this.activeLogin = undefined;
      void pending.cancel("Login cancelled");
    }
  }

  public async startLogin(options?: StartManagerLoginOptions): Promise<SugentLoginSession> {
    if (this.config.mode !== "oidc" && this.config.mode !== "google") {
      throw new Error(`OIDC login is unavailable when mode is "${this.config.mode}"`);
    }
    const effectiveIssuer =
      this.config.issuer || (this.config.mode === "google" ? GOOGLE_OIDC_ISSUER : "");
    if (!effectiveIssuer || !this.config.clientId) {
      throw new Error("OIDC issuer and clientId must be configured before starting login");
    }

    if (this.activeLogin) {
      await this.activeLogin.cancel("Superseded by a new OIDC login attempt");
      this.activeLogin = undefined;
    }

    this.lastError = "";
    const discovery = await this.getDiscovery();
    const clientSecret = this.clientSecretStore.load() ?? undefined;
    let priorRefreshToken: string | undefined;
    try {
      priorRefreshToken = this.vault.load()?.refreshToken;
    } catch {
      priorRefreshToken = undefined;
    }

    const mergedExtraParams: Record<string, string> = {};
    if (this.config.mode === "google") {
      mergedExtraParams.access_type = "offline";
      if (!priorRefreshToken) {
        mergedExtraParams.prompt = "consent";
      }
    }
    if (options?.extraAuthParams) {
      Object.assign(mergedExtraParams, options.extraAuthParams);
    }

    const handle = await startLoopbackOidcLogin(discovery, {
      clientId: this.config.clientId,
      clientSecret,
      scopes: this.config.scopes,
      timeoutMs: options?.timeoutMs ?? this.loginTimeoutMs,
      fetchImpl: this.fetchImpl,
      extraAuthParams: Object.keys(mergedExtraParams).length > 0 ? mergedExtraParams : undefined,
      onAuthorizationUrl: options?.onAuthorizationUrl,
    });

    this.activeLogin = handle;

    const completionPromise = (async (): Promise<SugentProvisionedEvent> => {
      try {
        const tokens = await handle.result;
        if (!tokens.refreshToken && priorRefreshToken) {
          tokens.refreshToken = priorRefreshToken;
        }
        const identity = await this.resolveIdentity(
          discovery,
          tokens,
          options?.fetchUserInfo ?? true,
        );
        const provisionedKey = await this.exchangeProvisionedKeyIfNeeded(tokens, identity);

        const vaultRecord: SugentVaultRecord = {
          ...tokens,
          subject: identity.subject,
          name: identity.name,
        };
        if (identity.email !== undefined) {
          vaultRecord.email = identity.email;
        }
        if (identity.picture !== undefined) {
          vaultRecord.picture = identity.picture;
        }
        if (provisionedKey !== undefined) {
          vaultRecord.provisionedKey = provisionedKey;
        }
        this.vault.save(vaultRecord);

        if (identity.name !== this.config.displayName) {
          this.configure({ displayName: identity.name });
        }

        const provisionedEvent: SugentProvisionedEvent = {
          accessToken: tokens.accessToken,
          subject: identity.subject,
          name: identity.name,
        };
        if (identity.email !== undefined) {
          provisionedEvent.email = identity.email;
        }
        if (identity.picture !== undefined) {
          provisionedEvent.picture = identity.picture;
        }
        if (tokens.idToken !== undefined) {
          provisionedEvent.idToken = tokens.idToken;
        }
        if (provisionedKey !== undefined) {
          provisionedEvent.provisionedKey = provisionedKey;
        }

        if (this.onProvisioned) {
          await this.onProvisioned(provisionedEvent);
        }

        this.lastError = "";
        return provisionedEvent;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        if (this.activeLogin === handle) {
          this.activeLogin = undefined;
        }
      }
    })();
    completionPromise.catch(() => {});

    return {
      authorizationUrl: handle.authorizationUrl,
      redirectUri: handle.redirectUri,
      port: handle.port,
      result: completionPromise,
      deliverCallback: handle.deliverCallback,
      cancel: handle.cancel,
    };
  }

  public async getValidAccessToken(): Promise<string | null> {
    if (this.config.mode === "none") {
      return null;
    }

    const record = this.vault.load();
    if (!record || !record.accessToken) {
      return null;
    }

    const now = Date.now();
    const needsRefresh =
      record.expiresAt !== undefined && now + this.refreshSkewMs >= record.expiresAt;

    if (!needsRefresh) {
      return record.accessToken;
    }

    const refreshToken = record.refreshToken;
    const canRefresh = this.config.mode === "oidc" || this.config.mode === "google";
    if (!canRefresh || !refreshToken) {
      return record.expiresAt !== undefined && now >= record.expiresAt
        ? null
        : record.accessToken;
    }

    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }

    this.refreshInFlight = (async (): Promise<string | null> => {
      try {
        const discovery = await this.getDiscovery();
        const clientSecret = this.clientSecretStore.load() ?? undefined;
        const refreshed = await refreshOidcTokens(discovery, {
          clientId: this.config.clientId,
          clientSecret,
          refreshToken,
          scopes: this.config.scopes,
          fetchImpl: this.fetchImpl,
        });

        const updatedRecord: SugentVaultRecord = {
          ...record,
          accessToken: refreshed.accessToken,
        };
        if (refreshed.refreshToken !== undefined) {
          updatedRecord.refreshToken = refreshed.refreshToken;
        }
        if (refreshed.idToken !== undefined) {
          updatedRecord.idToken = refreshed.idToken;
        }
        if (refreshed.expiresAt !== undefined) {
          updatedRecord.expiresAt = refreshed.expiresAt;
        } else {
          delete updatedRecord.expiresAt;
        }
        if (refreshed.scope !== undefined) {
          updatedRecord.scope = refreshed.scope;
        }

        this.vault.save(updatedRecord);
        this.lastError = "";
        return updatedRecord.accessToken;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
      } finally {
        this.refreshInFlight = undefined;
      }
    })();

    return this.refreshInFlight;
  }

  public async logout(): Promise<boolean> {
    if (this.activeLogin) {
      const pending = this.activeLogin;
      this.activeLogin = undefined;
      await pending.cancel("Logged out");
    }

    let record: SugentVaultRecord | null = null;
    try {
      record = this.vault.load();
    } catch {
      record = null;
    }

    let revoked = false;
    try {
      const canRevoke = this.config.mode === "oidc" || this.config.mode === "google";
      const effectiveIssuer =
        this.config.issuer || (this.config.mode === "google" ? GOOGLE_OIDC_ISSUER : "");
      if (
        canRevoke &&
        record &&
        effectiveIssuer.length > 0 &&
        this.config.clientId.length > 0
      ) {
        const tokenToRevoke = record.refreshToken ?? record.accessToken;
        const tokenTypeHint: "refresh_token" | "access_token" = record.refreshToken
          ? "refresh_token"
          : "access_token";
        if (tokenToRevoke) {
          const discovery = await this.getDiscovery();
          const clientSecret = this.clientSecretStore.load() ?? undefined;
          revoked = await revokeOidcToken(discovery, {
            clientId: this.config.clientId,
            clientSecret,
            token: tokenToRevoke,
            tokenTypeHint,
            fetchImpl: this.fetchImpl,
          });
        }
      }
    } finally {
      this.vault.clear();
      this.lastError = "";
      if (this.config.displayName !== "") {
        this.configure({ displayName: "" });
      }
    }

    return revoked;
  }

  private async getDiscovery(): Promise<OidcDiscoveryDocument> {
    const effectiveIssuer =
      this.config.issuer || (this.config.mode === "google" ? GOOGLE_OIDC_ISSUER : "");
    if (this.cachedDiscovery && this.cachedDiscovery.issuer === effectiveIssuer) {
      return this.cachedDiscovery;
    }
    const doc = await discoverOidcConfiguration(effectiveIssuer, {
      fetchImpl: this.fetchImpl,
      allowedOrigins: this.config.allowedEndpointOrigins,
    });
    this.cachedDiscovery = doc;
    return doc;
  }

  private async resolveIdentity(
    discovery: OidcDiscoveryDocument,
    tokens: OidcTokenSet,
    fetchUserInfo: boolean,
  ): Promise<{
    subject: string;
    name: string;
    email?: string | undefined;
    picture?: string | undefined;
  }> {
    const jwtClaims = parseJwtClaims(tokens.idToken ?? tokens.accessToken);
    const userInfoClaims: JwtClaims = {};

    if (fetchUserInfo && discovery.userinfo_endpoint) {
      const res = await this.fetchImpl(discovery.userinfo_endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${tokens.accessToken}`,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        const rawUserInfo: unknown = await res.json();
        if (isRecord(rawUserInfo)) {
          if (typeof rawUserInfo.sub === "string" && rawUserInfo.sub.length > 0) {
            userInfoClaims.sub = rawUserInfo.sub;
          }
          if (typeof rawUserInfo.name === "string" && rawUserInfo.name.length > 0) {
            userInfoClaims.name = rawUserInfo.name;
          }
          if (
            typeof rawUserInfo.preferred_username === "string" &&
            rawUserInfo.preferred_username.length > 0
          ) {
            userInfoClaims.preferred_username = rawUserInfo.preferred_username;
          }
          if (typeof rawUserInfo.email === "string" && rawUserInfo.email.length > 0) {
            userInfoClaims.email = rawUserInfo.email;
          }
          if (typeof rawUserInfo.picture === "string" && rawUserInfo.picture.length > 0) {
            userInfoClaims.picture = rawUserInfo.picture;
          }
        }
      }
    }

    if (jwtClaims.sub && userInfoClaims.sub && jwtClaims.sub !== userInfoClaims.sub) {
      throw new Error("OIDC userinfo subject does not match ID token subject");
    }

    const subject = userInfoClaims.sub ?? jwtClaims.sub ?? "";
    const email = userInfoClaims.email ?? jwtClaims.email;
    const picture = userInfoClaims.picture ?? jwtClaims.picture;
    const name =
      userInfoClaims.name ??
      userInfoClaims.preferred_username ??
      userInfoClaims.email ??
      jwtClaims.name ??
      jwtClaims.preferred_username ??
      jwtClaims.email ??
      subject;

    return { subject, name, email, picture };
  }

  private async exchangeProvisionedKeyIfNeeded(
    tokens: OidcTokenSet,
    identity: { subject: string; name: string },
  ): Promise<string | undefined> {
    if (
      this.config.provisioningMode !== "key_exchange" ||
      this.config.keyExchangeUrl.length === 0
    ) {
      return undefined;
    }

    const exchangeUrl = parseHttpUrl(this.config.keyExchangeUrl, "keyExchangeUrl");
    const response = await this.fetchImpl(exchangeUrl.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        idToken: tokens.idToken,
        subject: identity.subject,
        name: identity.name,
      }),
    });

    if (!response.ok) {
      throw new Error(`OIDC key exchange failed with HTTP ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      throw new Error("Invalid OIDC key exchange response: expected JSON object");
    }
    const candidate = payload.apiKey ?? payload.key ?? payload.token;
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw new Error("Invalid OIDC key exchange response: missing apiKey");
    }
    return candidate;
  }

  private loadConfigFromDisk(): SugentAuthConfig {
    const defaults = createDefaultConfig();
    if (!fs.existsSync(this.configFilePath)) {
      return defaults;
    }
    try {
      const rawText = fs.readFileSync(this.configFilePath, "utf8");
      const parsed: unknown = JSON.parse(rawText);
      if (!isRecord(parsed)) {
        return defaults;
      }
      const loaded: SugentAuthConfig = {
        mode: normalizeAuthMode(parsed.mode),
        issuer: typeof parsed.issuer === "string" ? parsed.issuer : defaults.issuer,
        clientId: typeof parsed.clientId === "string" ? parsed.clientId : defaults.clientId,
        scopes:
          Array.isArray(parsed.scopes) && parsed.scopes.length > 0
            ? parsed.scopes.filter((s): s is string => typeof s === "string")
            : defaults.scopes,
        displayName:
          typeof parsed.displayName === "string" ? parsed.displayName : defaults.displayName,
        provisioningMode: normalizeProvisioningMode(parsed.provisioningMode),
        keyExchangeUrl:
          typeof parsed.keyExchangeUrl === "string"
            ? parsed.keyExchangeUrl
            : defaults.keyExchangeUrl,
      };
      if (Array.isArray(parsed.allowedEndpointOrigins)) {
        const origins = parsed.allowedEndpointOrigins.filter(
          (o): o is string => typeof o === "string" && o.trim().length > 0,
        );
        if (origins.length > 0) {
          loaded.allowedEndpointOrigins = origins;
        }
      }
      return loaded;
    } catch {
      return defaults;
    }
  }

  private saveConfigToDisk(config: SugentAuthConfig): void {
    const serializable: Record<string, unknown> = {
      mode: config.mode,
      issuer: config.issuer,
      clientId: config.clientId,
      scopes: config.scopes,
      displayName: config.displayName,
      provisioningMode: config.provisioningMode,
      keyExchangeUrl: config.keyExchangeUrl,
    };
    if (config.allowedEndpointOrigins && config.allowedEndpointOrigins.length > 0) {
      serializable.allowedEndpointOrigins = config.allowedEndpointOrigins;
    }
    writeAtomicFile(this.configFilePath, `${JSON.stringify(serializable, null, 2)}\n`, 0o600);
  }
}
