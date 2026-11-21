import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SugentAuthManager,
  SugentAuthVault,
  createPkcePair,
  discoverOidcConfiguration,
  refreshOidcTokens,
  revokeOidcToken,
  startLoopbackOidcLogin,
  type AuthFetchLike,
  type AuthSecretBox,
  type SugentProvisionedEvent,
} from "../src/sugent/auth-provider.js";

const HTTP_PROTO = ["http", "://"].join("");

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

function createAesGcmSecretBox(rawKey: Buffer = crypto.randomBytes(32)): AuthSecretBox {
  return {
    encrypt(plain: string): Buffer {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", rawKey, iv);
      const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, encrypted]);
    },
    decrypt(data: Buffer): string {
      const iv = data.subarray(0, 12);
      const tag = data.subarray(12, 28);
      const ciphertext = data.subarray(28);
      const decipher = crypto.createDecipheriv("aes-256-gcm", rawKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}

interface StoredAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string;
}

interface MockOidcIdp {
  readonly issuer: string;
  readonly fetchImpl: AuthFetchLike;
  readonly revokedTokens: Array<{ token: string; tokenTypeHint: string | null; clientId: string }>;
  readonly exchangedKeys: string[];
  tokenExpiresInSec: number;
  overrideTokenEndpointOrigin: string | null;
  includeRevocationEndpoint: boolean;
  includeUserInfoEndpoint: boolean;
  approveBrowser: (
    authorizationUrl: string,
    deliverCallback: (callbackUrl: string) => Promise<{ status: number; body: string }>,
  ) => Promise<{ status: number; body: string }>;
  close: () => Promise<void>;
}

async function startMockOidcIdp(): Promise<MockOidcIdp> {
  const authCodes = new Map<string, StoredAuthCode>();
  const validRefreshTokens = new Set<string>();
  const validAccessTokens = new Set<string>();
  const revokedTokens: Array<{ token: string; tokenTypeHint: string | null; clientId: string }> =
    [];
  const exchangedKeys: string[] = [];

  let issuer = `${HTTP_PROTO}127.0.0.1:48123`;
  let tokenCounter = 0;

  const state = {
    tokenExpiresInSec: 3600,
    overrideTokenEndpointOrigin: null as string | null,
    includeRevocationEndpoint: true,
    includeUserInfoEndpoint: true,
  };

  const handleIdpRequest = async (
    method: string,
    rawUrl: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> => {
    const reqUrl = new URL(rawUrl, issuer);
    const jsonResp = (status: number, payload: unknown) => ({
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    if (method === "GET" && reqUrl.pathname === "/.well-known/openid-configuration") {
      const tokenBase = state.overrideTokenEndpointOrigin ?? issuer;
      const doc: Record<string, unknown> = {
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${tokenBase}/oauth/token`,
        jwks_uri: `${issuer}/oauth/jwks.json`,
        scopes_supported: ["openid", "profile", "email"],
        code_challenge_methods_supported: ["S256"],
      };
      if (state.includeUserInfoEndpoint) {
        doc.userinfo_endpoint = `${issuer}/oauth/userinfo`;
      }
      if (state.includeRevocationEndpoint) {
        doc.revocation_endpoint = `${issuer}/oauth/revoke`;
      }
      return jsonResp(200, doc);
    }

    if (method === "GET" && reqUrl.pathname === "/oauth/authorize") {
      const clientId = reqUrl.searchParams.get("client_id") ?? "";
      const redirectUri = reqUrl.searchParams.get("redirect_uri") ?? "";
      const oauthState = reqUrl.searchParams.get("state") ?? "";
      const codeChallenge = reqUrl.searchParams.get("code_challenge") ?? "";
      const codeChallengeMethod = reqUrl.searchParams.get("code_challenge_method") ?? "";
      const scope = reqUrl.searchParams.get("scope") ?? "openid";

      if (!clientId || !redirectUri || !oauthState || codeChallengeMethod !== "S256") {
        return jsonResp(400, { error: "invalid_request" });
      }

      const code = `code_${crypto.randomBytes(12).toString("hex")}`;
      authCodes.set(code, {
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
      });

      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("code", code);
      callbackUrl.searchParams.set("state", oauthState);

      return {
        status: 302,
        headers: { location: callbackUrl.toString() },
        body: "",
      };
    }

    if (method === "POST" && reqUrl.pathname === "/oauth/token") {
      const params = new URLSearchParams(rawBody);
      const grantType = params.get("grant_type");

      if (grantType === "authorization_code") {
        const code = params.get("code") ?? "";
        const redirectUri = params.get("redirect_uri") ?? "";
        const clientId = params.get("client_id") ?? "";
        const codeVerifier = params.get("code_verifier") ?? "";

        const stored = authCodes.get(code);
        authCodes.delete(code);

        if (!stored || stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
          return jsonResp(400, { error: "invalid_grant", error_description: "Code mismatch" });
        }

        const computedChallenge = crypto
          .createHash("sha256")
          .update(codeVerifier, "ascii")
          .digest("base64url");

        if (computedChallenge !== stored.codeChallenge) {
          return jsonResp(400, {
            error: "invalid_grant",
            error_description: "PKCE S256 verification failed",
          });
        }

        tokenCounter += 1;
        const accessToken = `at_initial_${tokenCounter}`;
        const refreshToken = `rt_initial_${tokenCounter}`;
        validAccessTokens.add(accessToken);
        validRefreshTokens.add(refreshToken);

        const idToken = createUnsignedJwt({
          iss: issuer,
          sub: "emp_0042",
          aud: clientId,
          preferred_username: "alice.jwt",
          email: "alice@local",
        });

        return jsonResp(200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: state.tokenExpiresInSec,
          scope: stored.scope,
        });
      }

      if (grantType === "refresh_token") {
        const refreshToken = params.get("refresh_token") ?? "";
        const clientId = params.get("client_id") ?? "";
        if (!clientId || !validRefreshTokens.has(refreshToken)) {
          return jsonResp(400, { error: "invalid_grant", error_description: "Invalid refresh" });
        }

        validRefreshTokens.delete(refreshToken);
        tokenCounter += 1;
        const nextAccessToken = `at_refreshed_${tokenCounter}`;
        const nextRefreshToken = `rt_rotated_${tokenCounter}`;
        validAccessTokens.add(nextAccessToken);
        validRefreshTokens.add(nextRefreshToken);

        const idToken = createUnsignedJwt({
          iss: issuer,
          sub: "emp_0042",
          aud: clientId,
          name: "Alice Chen",
        });

        return jsonResp(200, {
          access_token: nextAccessToken,
          refresh_token: nextRefreshToken,
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
          scope: params.get("scope") ?? "openid profile email",
        });
      }

      return jsonResp(400, { error: "unsupported_grant_type" });
    }

    if (method === "GET" && reqUrl.pathname === "/oauth/userinfo") {
      const authHeader = headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!validAccessTokens.has(token)) {
        return jsonResp(401, { error: "invalid_token" });
      }
      return jsonResp(200, {
        sub: "emp_0042",
        name: "Alice Chen",
        preferred_username: "alice",
        email: "alice@local",
      });
    }

    if (method === "POST" && reqUrl.pathname === "/oauth/revoke") {
      const params = new URLSearchParams(rawBody);
      const token = params.get("token") ?? "";
      const tokenTypeHint = params.get("token_type_hint");
      const clientId = params.get("client_id") ?? "";
      revokedTokens.push({ token, tokenTypeHint, clientId });
      validRefreshTokens.delete(token);
      validAccessTokens.delete(token);
      return { status: 200, headers: {}, body: "" };
    }

    if (method === "POST" && reqUrl.pathname === "/gateway/key-exchange") {
      const authHeader = headers.authorization ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (!validAccessTokens.has(token)) {
        return jsonResp(401, { error: "unauthorized" });
      }
      const key = `sgk_emp_${exchangedKeys.length + 1}`;
      exchangedKeys.push(key);
      return jsonResp(200, { apiKey: key });
    }

    return jsonResp(404, { error: "not_found" });
  };

  let realTcpBound = false;
  const server = http.createServer((req, res) => {
    void (async () => {
      let rawBody = "";
      req.setEncoding("utf8");
      for await (const chunk of req) {
        rawBody += chunk;
      }
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") lowerHeaders[k.toLowerCase()] = v;
      }
      const out = await handleIdpRequest(req.method ?? "GET", req.url ?? "/", lowerHeaders, rawBody);
      res.writeHead(out.status, { ...out.headers, Connection: "close" });
      res.end(out.body);
    })();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const addr = server.address();
    if (addr && typeof addr !== "string") {
      issuer = `${HTTP_PROTO}127.0.0.1:${addr.port}`;
      realTcpBound = true;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EPERM") {
      throw err;
    }
  }

  const fetchImpl: AuthFetchLike = async (input, init) => {
    if (realTcpBound) {
      return globalThis.fetch(input, init);
    }
    const urlStr = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const hdrs: Record<string, string> = {};
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        hdrs[k.toLowerCase()] = v;
      });
    }
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const out = await handleIdpRequest(method, urlStr, hdrs, bodyStr);
    return new Response(out.body, { status: out.status, headers: out.headers });
  };

  const approveBrowser = async (
    authorizationUrl: string,
    deliverCallback: (callbackUrl: string) => Promise<{ status: number; body: string }>,
  ): Promise<{ status: number; body: string }> => {
    if (realTcpBound) {
      const browserRes = await fetch(authorizationUrl, { redirect: "follow" });
      return { status: browserRes.status, body: await browserRes.text() };
    }
    const authResp = await handleIdpRequest("GET", authorizationUrl, {}, "");
    if (authResp.status !== 302 || !authResp.headers.location) {
      return { status: authResp.status, body: authResp.body };
    }
    return deliverCallback(authResp.headers.location);
  };

  return {
    get issuer() {
      return issuer;
    },
    fetchImpl,
    revokedTokens,
    exchangedKeys,
    get tokenExpiresInSec() {
      return state.tokenExpiresInSec;
    },
    set tokenExpiresInSec(val: number) {
      state.tokenExpiresInSec = val;
    },
    get overrideTokenEndpointOrigin() {
      return state.overrideTokenEndpointOrigin;
    },
    set overrideTokenEndpointOrigin(val: string | null) {
      state.overrideTokenEndpointOrigin = val;
    },
    get includeRevocationEndpoint() {
      return state.includeRevocationEndpoint;
    },
    set includeRevocationEndpoint(val: boolean) {
      state.includeRevocationEndpoint = val;
    },
    get includeUserInfoEndpoint() {
      return state.includeUserInfoEndpoint;
    },
    set includeUserInfoEndpoint(val: boolean) {
      state.includeUserInfoEndpoint = val;
    },
    approveBrowser,
    close: async () => {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

describe("Sugent OAuth / OIDC Decoupled Auth Provider (Task 4)", () => {
  let tempDir: string;
  let mockIdp: MockOidcIdp | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-auth-test-"));
  });

  afterEach(async () => {
    if (mockIdp) {
      await mockIdp.close();
      mockIdp = undefined;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults to sovereign 'none' mode with zero network requests and loginAvailable === false", async () => {
    const fetchSpy = vi.fn(
      async (_input: string | URL, _init?: RequestInit): Promise<Response> => {
        throw new Error("Unexpected network request in 'none' mode");
      },
    );
    const manager = new SugentAuthManager({
      dataDir: tempDir,
      fetchImpl: fetchSpy,
    });

    expect(manager.getConfig().mode).toBe("none");

    const loopbackStatus = manager.status(true);
    expect(loopbackStatus).toEqual({
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
    });

    const remoteStatus = manager.status(false);
    expect(remoteStatus.loginAvailable).toBe(false);
    expect(remoteStatus.state).toBe("disabled");

    expect(await manager.getValidAccessToken()).toBeNull();
    expect(await manager.logout()).toBe(false);
    await expect(manager.startLogin()).rejects.toThrow(/unavailable/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("persists vault credentials atomically with 0o600 base64 or SecretBox encryption and supports clear()", () => {
    const base64Vault = new SugentAuthVault(tempDir);
    base64Vault.save({
      accessToken: "test-vault-at-01",
      refreshToken: "test-vault-rt-01",
      subject: "user-1",
      name: "Sovereign User",
    });

    const stats = fs.statSync(base64Vault.filePath);
    if (process.platform !== "win32") {
      expect(stats.mode & 0o777).toBe(0o600);
    }

    const rawBase64Disk = fs.readFileSync(base64Vault.filePath, "utf8");
    expect(rawBase64Disk).not.toContain("test-vault-at-01");
    expect(base64Vault.load()?.accessToken).toBe("test-vault-at-01");

    base64Vault.clear();
    expect(fs.existsSync(base64Vault.filePath)).toBe(false);
    expect(base64Vault.load()).toBeNull();

    const secretBox = createAesGcmSecretBox();
    const encryptedVault = new SugentAuthVault({ dataDir: tempDir, secretBox });
    encryptedVault.save({
      accessToken: "sealed-vault-at-02",
      refreshToken: "sealed-rt",
    });

    const withoutBox = new SugentAuthVault(tempDir);
    expect(() => withoutBox.load()).toThrow(/SecretBox is required/i);
    expect(encryptedVault.load()?.accessToken).toBe("sealed-vault-at-02");

    encryptedVault.clear();
    expect(encryptedVault.load()).toBeNull();
  });

  it("rejects forged cross-origin token_endpoint and issuer mismatches in discoverOidcConfiguration", async () => {
    mockIdp = await startMockOidcIdp();
    mockIdp.overrideTokenEndpointOrigin = `${HTTP_PROTO}127.0.0.1:59999`;

    await expect(
      discoverOidcConfiguration(mockIdp.issuer, mockIdp.fetchImpl),
    ).rejects.toThrow(/cross-origin token_endpoint rejected/i);

    const expectedOrigin = mockIdp.issuer;
    const mismatchedIssuerFetch: AuthFetchLike = async () =>
      new Response(
        JSON.stringify({
          issuer: `${HTTP_PROTO}127.0.0.1:58888`,
          authorization_endpoint: `${expectedOrigin}/oauth/authorize`,
          token_endpoint: `${expectedOrigin}/oauth/token`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await expect(
      discoverOidcConfiguration(expectedOrigin, mismatchedIssuerFetch),
    ).rejects.toThrow(/issuer mismatch/i);
  });

  it("enforces timing-safe state verification, rejects utm_* parameters, and supports cancel() / timeout", async () => {
    mockIdp = await startMockOidcIdp();
    const discovery = await discoverOidcConfiguration(mockIdp.issuer, mockIdp.fetchImpl);

    await expect(
      startLoopbackOidcLogin(discovery, {
        clientId: "sugent-cli",
        fetchImpl: mockIdp.fetchImpl,
        extraAuthParams: { utm_source: "modelflare" },
      }),
    ).rejects.toThrow(/utm_source.*prohibited/i);

    const badStateLogin = await startLoopbackOidcLogin(discovery, {
      clientId: "sugent-cli",
      fetchImpl: mockIdp.fetchImpl,
    });

    const badCallbackRes = await badStateLogin.deliverCallback(
      `${badStateLogin.redirectUri}?code=any_code&state=forged_state_value`,
    );
    expect(badCallbackRes.status).toBe(400);
    await expect(badStateLogin.result).rejects.toThrow(/state mismatch/i);

    const cancelledLogin = await startLoopbackOidcLogin(discovery, {
      clientId: "sugent-cli",
      fetchImpl: mockIdp.fetchImpl,
    });
    await cancelledLogin.cancel("User aborted");
    await expect(cancelledLogin.result).rejects.toThrow(/User aborted/i);

    const timedOutLogin = await startLoopbackOidcLogin(discovery, {
      clientId: "sugent-cli",
      fetchImpl: mockIdp.fetchImpl,
      timeoutMs: 40,
    });
    await expect(timedOutLogin.result).rejects.toThrow(/timed out/i);
  });

  it("completes full OIDC PKCE S256 login without utm_source, triggers onProvisioned, auto-refreshes expiring tokens, and revokes on logout", async () => {
    mockIdp = await startMockOidcIdp();
    mockIdp.tokenExpiresInSec = 10;

    const provisionedEvents: SugentProvisionedEvent[] = [];
    const secretBox = createAesGcmSecretBox();

    const manager = new SugentAuthManager({
      dataDir: tempDir,
      secretBox,
      fetchImpl: mockIdp.fetchImpl,
      config: {
        mode: "oidc",
        issuer: mockIdp.issuer,
        clientId: "sugent-desktop-client",
        scopes: ["openid", "profile", "email"],
        provisioningMode: "key_exchange",
        keyExchangeUrl: `${mockIdp.issuer}/gateway/key-exchange`,
      },
      onProvisioned: (evt) => {
        provisionedEvents.push(evt);
      },
    });

    expect(manager.status(true).loginAvailable).toBe(true);
    expect(manager.status(false).loginAvailable).toBe(false);
    expect(manager.status(true).state).toBe("signed_out");

    const pkceSample = createPkcePair();
    expect(pkceSample.codeChallengeMethod).toBe("S256");
    expect(pkceSample.codeVerifier.length).toBeGreaterThanOrEqual(43);

    const loginSession = await manager.startLogin();
    expect(manager.status(true).state).toBe("signing_in");

    const parsedAuthUrl = new URL(loginSession.authorizationUrl);
    expect(loginSession.authorizationUrl).not.toContain("utm_source");
    for (const key of parsedAuthUrl.searchParams.keys()) {
      expect(key.toLowerCase().startsWith("utm_")).toBe(false);
    }
    expect(parsedAuthUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsedAuthUrl.searchParams.get("client_id")).toBe("sugent-desktop-client");
    expect(parsedAuthUrl.searchParams.get("redirect_uri")).toBe(loginSession.redirectUri);

    const browserRes = await mockIdp.approveBrowser(
      loginSession.authorizationUrl,
      loginSession.deliverCallback,
    );
    expect(browserRes.status).toBe(200);

    const provisioned = await loginSession.result;
    expect(provisioned.accessToken).toBe("at_initial_1");
    expect(provisioned.subject).toBe("emp_0042");
    expect(provisioned.name).toBe("Alice Chen");
    expect(provisioned.provisionedKey).toBe("sgk_emp_1");

    expect(provisionedEvents).toHaveLength(1);
    expect(provisionedEvents[0]).toMatchObject({
      accessToken: "at_initial_1",
      subject: "emp_0042",
      name: "Alice Chen",
      provisionedKey: "sgk_emp_1",
    });

    const signedInStatus = manager.status(true);
    expect(signedInStatus).toEqual({
      mode: "oidc",
      state: "signed_in",
      loginAvailable: true,
      signedIn: true,
      authenticated: true,
      name: "Alice Chen",
      balanceUsd: null,
      usedUsd: null,
      lowBalance: false,
      alerts: { lowBalanceUsd: 0, push: false },
      error: "",
    });

    const persistedConfigRaw = fs.readFileSync(manager.configFilePath, "utf8");
    expect(persistedConfigRaw).not.toContain("at_initial_1");
    expect(persistedConfigRaw).not.toContain("rt_initial_1");
    expect(JSON.parse(persistedConfigRaw)).toMatchObject({
      mode: "oidc",
      issuer: mockIdp.issuer,
      clientId: "sugent-desktop-client",
      displayName: "Alice Chen",
      provisioningMode: "key_exchange",
    });

    const validToken = await manager.getValidAccessToken();
    expect(validToken).toBe("at_refreshed_2");

    const discovery = await discoverOidcConfiguration(mockIdp.issuer, mockIdp.fetchImpl);
    const rotatedAgain = await refreshOidcTokens(discovery, {
      clientId: "sugent-desktop-client",
      refreshToken: "rt_rotated_2",
      fetchImpl: mockIdp.fetchImpl,
    });
    expect(rotatedAgain.accessToken).toBe("at_refreshed_3");
    expect(rotatedAgain.refreshToken).toBe("rt_rotated_3");

    manager.vault.save({
      ...rotatedAgain,
      subject: "emp_0042",
      name: "Alice Chen",
    });

    const wasRevoked = await manager.logout();
    expect(wasRevoked).toBe(true);
    expect(mockIdp.revokedTokens).toEqual([
      {
        token: "rt_rotated_3",
        tokenTypeHint: "refresh_token",
        clientId: "sugent-desktop-client",
      },
    ]);
    expect(fs.existsSync(manager.vault.filePath)).toBe(false);
    expect(manager.status(true).signedIn).toBe(false);
    expect(manager.status(true).state).toBe("signed_out");
  });

  it("falls back to JWT claims when userinfo_endpoint is absent, degrades gracefully without revocation_endpoint, and supports modelflare-legacy compatibility mode", async () => {
    mockIdp = await startMockOidcIdp();
    mockIdp.includeUserInfoEndpoint = false;
    mockIdp.includeRevocationEndpoint = false;

    expect(
      await revokeOidcToken(
        { revocation_endpoint: undefined },
        { clientId: "sugent-cli", token: "dummy", fetchImpl: mockIdp.fetchImpl },
      ),
    ).toBe(false);

    const manager = new SugentAuthManager({
      dataDir: tempDir,
      fetchImpl: mockIdp.fetchImpl,
      config: {
        mode: "oidc",
        issuer: mockIdp.issuer,
        clientId: "sugent-cli",
        provisioningMode: "token_passthrough",
      },
    });

    const session = await manager.startLogin();
    const res = await mockIdp.approveBrowser(session.authorizationUrl, session.deliverCallback);
    expect(res.status).toBe(200);

    const provisioned = await session.result;
    expect(provisioned.subject).toBe("emp_0042");
    expect(provisioned.name).toBe("alice.jwt");

    const revoked = await manager.logout();
    expect(revoked).toBe(false);
    expect(manager.status(true).signedIn).toBe(false);

    manager.configure({ mode: "modelflare-legacy" });
    manager.vault.save({ accessToken: "legacy_tok_1", name: "Legacy Account" });
    expect(manager.status(true).mode).toBe("modelflare-legacy");
    expect(manager.status(true).loginAvailable).toBe(false);
    expect(manager.status(true).signedIn).toBe(true);
    expect(await manager.getValidAccessToken()).toBe("legacy_tok_1");
    await manager.logout();
    expect(manager.status(true).signedIn).toBe(false);
  });
});
