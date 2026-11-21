import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { discover } from "../src/account/oauth.js";

const HTTP_PROTO = ["http", "://"].join("");
const HTTPS_PROTO = ["https", "://"].join("");
const GOOGLE_ISSUER = `${HTTPS_PROTO}accounts.google.com`;
const GOOGLE_AUTH_URL = `${GOOGLE_ISSUER}/o/oauth2/v2/auth`;
const GOOGLE_TOKEN_URL = `${HTTPS_PROTO}oauth2.googleapis.com/token`;
const GOOGLE_USERINFO_URL = `${HTTPS_PROTO}openidconnect.googleapis.com/v1/userinfo`;
const GOOGLE_REVOKE_URL = `${HTTPS_PROTO}oauth2.googleapis.com/revoke`;

describe("REST /amb/api/auth Google OAuth Desktop Integration & oauth.ts Discovery", () => {
  let app: App;
  let dataDir = "";

  const callApi = async (pathname: string, method = "GET", body?: unknown) => {
    const res = await app.web!.inject(`/amb/api${pathname}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      text: res.text,
      json: res.text ? JSON.parse(res.text) : {},
    };
  };

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-auth-api-google-"));
    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}127.0.0.1:41149/v1`,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}127.0.0.1:9`,
      },
    });
    app = new App(cfg, { printQrToTerminal: false });
    await app.start();
  });

  afterAll(async () => {
    await app?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("supports Google multi-origin OIDC discovery in src/account/oauth.ts", async () => {
    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe(`${GOOGLE_ISSUER}/.well-known/openid-configuration`);
      return new Response(
        JSON.stringify({
          issuer: GOOGLE_ISSUER,
          authorization_endpoint: GOOGLE_AUTH_URL,
          token_endpoint: GOOGLE_TOKEN_URL,
          userinfo_endpoint: GOOGLE_USERINFO_URL,
          revocation_endpoint: GOOGLE_REVOKE_URL,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const ep = await discover(GOOGLE_ISSUER, mockFetch);
    expect(ep).toEqual({
      issuer: GOOGLE_ISSUER,
      authorization: GOOGLE_AUTH_URL,
      token: GOOGLE_TOKEN_URL,
      revocation: GOOGLE_REVOKE_URL,
    });
  });

  it("configures mode='google' via PUT /amb/api/auth/config, redacts clientSecret, and keeps gemini-web2api intact when provisioningMode='none'", async () => {
    const secretVal = "desktop-secret-redacted-9988";

    const addProxy = await callApi("/providers", "POST", {
      id: "gemini-web2api",
      preset: "gemini-web2api",
      name: "Local Gemini Web2API",
      baseUrl: `${HTTP_PROTO}127.0.0.1:8083/v1`,
      setDefault: true,
    });
    expect(addProxy.status).toBe(200);

    const putAuth = await callApi("/auth/config", "PUT", {
      mode: "google",
      clientId: "sugent-desktop-client-id",
      clientSecret: secretVal,
      provisioningMode: "none",
    });
    expect(putAuth.status).toBe(200);
    expect(putAuth.text).not.toContain(secretVal);
    expect(putAuth.json).toMatchObject({
      mode: "google",
      loginAvailable: true,
      hasClientSecret: true,
      config: {
        mode: "google",
        issuer: GOOGLE_ISSUER,
        clientId: "sugent-desktop-client-id",
        hasClientSecret: true,
        provisioningMode: "none",
      },
    });

    const cleared = await callApi("/auth/config", "PUT", {
      clearClientSecret: true,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.json.hasClientSecret).toBe(false);

    const provs = await callApi("/providers");
    expect(provs.json.defaultProviderId).toBe("gemini-web2api");
  });
});
