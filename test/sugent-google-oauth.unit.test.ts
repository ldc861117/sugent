import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_OIDC_ISSUER,
  SugentAuthManager,
  discoverOidcConfiguration,
  type AuthFetchLike,
  type AuthSecretBox,
  type SugentProvisionedEvent,
} from "../src/sugent/auth-provider.js";

const HTTPS_PROTO = ["https", "://"].join("");
const GOOGLE_ISSUER = GOOGLE_OIDC_ISSUER;
const GOOGLE_AUTH_URL = `${GOOGLE_ISSUER}/o/oauth2/v2/auth`;
const GOOGLE_TOKEN_URL = `${HTTPS_PROTO}oauth2.googleapis.com/token`;
const GOOGLE_USERINFO_URL = `${HTTPS_PROTO}openidconnect.googleapis.com/v1/userinfo`;
const GOOGLE_REVOKE_URL = `${HTTPS_PROTO}oauth2.googleapis.com/revoke`;
const GOOGLE_JWKS_URL = `${HTTPS_PROTO}www.googleapis.com/oauth2/v3/certs`;

function createMockSecretBox(): AuthSecretBox {
  const mask = 0x5a;
  return {
    encrypt(plain: string): Buffer {
      const src = Buffer.from(plain, "utf8");
      return Buffer.from(src.map((b) => b ^ mask));
    },
    decrypt(data: Buffer): string {
      return Buffer.from(data.map((b) => b ^ mask)).toString("utf8");
    },
  };
}

function createUnsignedJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

describe("Sugent Native Google OAuth 2.0 Desktop App Support", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-google-oauth-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("accepts Google multi-origin OIDC discovery endpoints while blocking untrusted origins", async () => {
    const googleDiscoveryFetch: AuthFetchLike = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`${GOOGLE_ISSUER}/.well-known/openid-configuration`);
      return new Response(
        JSON.stringify({
          issuer: GOOGLE_ISSUER,
          authorization_endpoint: GOOGLE_AUTH_URL,
          token_endpoint: GOOGLE_TOKEN_URL,
          userinfo_endpoint: GOOGLE_USERINFO_URL,
          revocation_endpoint: GOOGLE_REVOKE_URL,
          jwks_uri: GOOGLE_JWKS_URL,
          scopes_supported: ["openid", "email", "profile"],
          code_challenge_methods_supported: ["plain", "S256"],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const doc = await discoverOidcConfiguration(GOOGLE_OIDC_ISSUER, googleDiscoveryFetch);
    expect(doc.token_endpoint).toBe(GOOGLE_TOKEN_URL);
    expect(doc.userinfo_endpoint).toBe(GOOGLE_USERINFO_URL);
    expect(doc.revocation_endpoint).toBe(GOOGLE_REVOKE_URL);

    const hijackedFetch: AuthFetchLike = async () =>
      new Response(
        JSON.stringify({
          issuer: GOOGLE_ISSUER,
          authorization_endpoint: GOOGLE_AUTH_URL,
          token_endpoint: `${HTTPS_PROTO}forged.invalid/token`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );

    await expect(discoverOidcConfiguration(GOOGLE_OIDC_ISSUER, hijackedFetch)).rejects.toThrow(
      /cross-origin token_endpoint rejected/i,
    );
  });

  it("completes Google Desktop PKCE + client_secret login, offline refresh retention, and Google revoke", async () => {
    const secretBox = createMockSecretBox();
    const expectedClientId = "sugent-desktop-client";
    const expectedSecret = "sugent-desktop-secret-value";
    const avatarUrl = `${GOOGLE_ISSUER}/avatar.png`;

    const capturedTokenBodies: URLSearchParams[] = [];
    const capturedRevokeBodies: URLSearchParams[] = [];
    let storedCodeChallenge = "";

    const mockGoogleFetch: AuthFetchLike = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === `${GOOGLE_ISSUER}/.well-known/openid-configuration`) {
        return new Response(
          JSON.stringify({
            issuer: GOOGLE_ISSUER,
            authorization_endpoint: GOOGLE_AUTH_URL,
            token_endpoint: GOOGLE_TOKEN_URL,
            userinfo_endpoint: GOOGLE_USERINFO_URL,
            revocation_endpoint: GOOGLE_REVOKE_URL,
            jwks_uri: GOOGLE_JWKS_URL,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === GOOGLE_TOKEN_URL) {
        const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        capturedTokenBodies.push(params);

        if (params.get("client_secret") !== expectedSecret) {
          return new Response(
            JSON.stringify({
              error: "invalid_client",
              error_description: "missing secret",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          );
        }

        const grantType = params.get("grant_type");
        if (grantType === "authorization_code") {
          const verifier = params.get("code_verifier") ?? "";
          const challenge = crypto
            .createHash("sha256")
            .update(verifier, "ascii")
            .digest("base64url");
          expect(challenge).toBe(storedCodeChallenge);

          const idToken = createUnsignedJwt({
            iss: GOOGLE_ISSUER,
            sub: "uid_8899",
            aud: expectedClientId,
            email: "alice@local",
            name: "Alice Studio",
            picture: avatarUrl,
          });

          return new Response(
            JSON.stringify({
              access_token: "at_google_1",
              refresh_token: "rt_google_offline_1",
              id_token: idToken,
              expires_in: 10,
              token_type: "Bearer",
              scope: "openid email profile",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (grantType === "refresh_token") {
          expect(params.get("refresh_token")).toBe("rt_google_offline_1");
          return new Response(
            JSON.stringify({
              access_token: "at_google_2",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "openid email profile",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
      }

      if (url === GOOGLE_USERINFO_URL) {
        return new Response(
          JSON.stringify({
            sub: "uid_8899",
            name: "Alice Studio",
            email: "alice@local",
            picture: avatarUrl,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url === GOOGLE_REVOKE_URL) {
        const params = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        capturedRevokeBodies.push(params);
        return new Response("", { status: 200 });
      }

      return new Response("not found", { status: 404 });
    };

    const provisionedEvents: SugentProvisionedEvent[] = [];
    const manager = new SugentAuthManager({
      dataDir: tempDir,
      secretBox,
      fetchImpl: mockGoogleFetch,
      config: {
        mode: "google",
        clientId: expectedClientId,
        clientSecret: expectedSecret,
      },
      onProvisioned: (evt) => {
        provisionedEvents.push(evt);
      },
    });

    const cfg = manager.getConfig();
    expect(cfg.mode).toBe("google");
    expect(cfg.issuer).toBe(GOOGLE_ISSUER);
    expect(cfg.hasClientSecret).toBe(true);

    const rawConfigText = fs.readFileSync(manager.configFilePath, "utf8");
    expect(rawConfigText).not.toContain(expectedSecret);
    const rawSecretText = fs.readFileSync(manager.clientSecretStore.filePath, "utf8");
    expect(rawSecretText).not.toContain(expectedSecret);

    const session = await manager.startLogin();
    const authUrl = new URL(session.authorizationUrl);
    expect(authUrl.origin).toBe(GOOGLE_ISSUER);
    expect(authUrl.searchParams.get("access_type")).toBe("offline");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    storedCodeChallenge = authUrl.searchParams.get("code_challenge") ?? "";

    const state = authUrl.searchParams.get("state") ?? "";
    const cbRes = await session.deliverCallback(
      `${session.redirectUri}?code=auth_code_01&state=${encodeURIComponent(state)}`,
    );
    expect(cbRes.status).toBe(200);

    const provisioned = await session.result;
    expect(provisioned.accessToken).toBe("at_google_1");
    expect(provisioned.email).toBe("alice@local");
    expect(provisioned.picture).toBe(avatarUrl);
    expect(provisionedEvents).toHaveLength(1);

    const status = manager.status(true);
    expect(status.mode).toBe("google");
    expect(status.signedIn).toBe(true);
    expect(status.name).toBe("Alice Studio");
    expect(status.email).toBe("alice@local");
    expect(status.picture).toBe(avatarUrl);
    expect(status.hasClientSecret).toBe(true);

    const refreshedToken = await manager.getValidAccessToken();
    expect(refreshedToken).toBe("at_google_2");
    expect(manager.vault.load()?.refreshToken).toBe("rt_google_offline_1");
    expect(capturedTokenBodies).toHaveLength(2);
    expect(capturedTokenBodies[1]?.get("client_secret")).toBe(expectedSecret);

    const revoked = await manager.logout();
    expect(revoked).toBe(true);
    expect(capturedRevokeBodies).toHaveLength(1);
    expect([...capturedRevokeBodies[0]!.keys()]).toEqual(["token"]);
    expect(capturedRevokeBodies[0]?.get("token")).toBe("rt_google_offline_1");
  });
});
