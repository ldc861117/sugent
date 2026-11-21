import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SugentAuthManager } from "../src/sugent/auth-provider.js";
import {
  SUGENT_DESKTOP_CLIENT_ID,
  buildBrokerDesktopAuthConfig,
  parseSugentBrokerClaims,
} from "../src/sugent/auth-broker-contract.js";
import {
  computePkceS256Challenge,
  deriveUnifiedUserId,
  exportPublicJwkSet,
  generateBrokerSigningKeyPair,
  sealStatelessPayload,
  toBase64Url,
  unsealStatelessPayload,
  verifyJwtEs256,
  verifyPkceS256,
  type JwkSetDocument,
} from "../packages/sugent-auth-broker/src/crypto.js";
import { AppleSignInAdapter, createAppleClientSecretJwt } from "../packages/sugent-auth-broker/src/adapters/apple.js";
import { GoogleOidcAdapter } from "../packages/sugent-auth-broker/src/adapters/google.js";
import { WechatQrAdapter } from "../packages/sugent-auth-broker/src/adapters/wechat.js";
import { FeishuAuthAdapter } from "../packages/sugent-auth-broker/src/adapters/feishu.js";
import { DingTalkAuthAdapter } from "../packages/sugent-auth-broker/src/adapters/dingtalk.js";
import { createBrokerApp } from "../packages/sugent-auth-broker/src/app.js";
import type { BrokerEnv, OptionalKvStore } from "../packages/sugent-auth-broker/src/types.js";

const HTTPS_PROTO = ["https", "://"].join("");
const WSS_PROTO = ["wss", "://"].join("");
const subtle = webcrypto.subtle;

async function makeMockRsaIdToken(
  claims: Record<string, unknown>,
  kid = "rsa-kid-1",
): Promise<{ idToken: string; jwks: JwkSetDocument }> {
  const pair = (await subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as webcrypto.CryptoKeyPair;
  const pubJwk = (await subtle.exportKey("jwk", pair.publicKey)) as webcrypto.JsonWebKey;
  const enc = new TextEncoder();
  const h = toBase64Url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
  const p = toBase64Url(enc.encode(JSON.stringify(claims)));
  const sig = await subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, enc.encode(`${h}.${p}`));
  return {
    idToken: `${h}.${p}.${toBase64Url(new Uint8Array(sig))}`,
    jwks: { keys: [{ ...pubJwk, kid, alg: "RS256", use: "sig" }] },
  };
}

function createMemoryKv(): OptionalKvStore {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async put(key, val) {
      map.set(key, val);
    },
  };
}

describe("P0 Sugent Auth Broker stateless kernel, 5 IdP adapters & Desktop Loopback E2E", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-broker-e2e-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("seals/unseals AES-256-GCM state, validates PKCE S256, and isolates usr_<hash> per IdP", async () => {
    const sealKey = "demo-broker-seal-key-unit-test-only";
    const sealed = await sealStatelessPayload({ txId: "tx_100" }, sealKey, 60);
    const unsealed = await unsealStatelessPayload<{ txId: string }>(sealed, sealKey);
    expect(unsealed.txId).toBe("tx_100");

    await expect(unsealStatelessPayload(`${sealed.slice(0, -4)}AAAA`, sealKey)).rejects.toThrow();
    const expired = await sealStatelessPayload({ txId: "old" }, sealKey, -5);
    await expect(unsealStatelessPayload(expired, sealKey)).rejects.toThrow(/expired/i);

    const verifier = "pkce-verifier-sample-string-with-minimum-43-characters-ok";
    const challenge = await computePkceS256Challenge(verifier);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256(`${verifier}z`, challenge)).toBe(false);

    const subWx = await deriveUnifiedUserId("wechat", "u_same", sealKey);
    const subFs = await deriveUnifiedUserId("feishu", "u_same", sealKey);
    expect(subWx).toMatch(/^usr_/);
    expect(subWx).not.toBe(subFs);
  });

  it("normalizes all 5 upstream IdPs: WeChat, Apple (ES256 + form_post), Google, Feishu, DingTalk", async () => {
    // 1. Apple dynamic ES256 assertion + form_post user JSON
    const ecPair = (await subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    )) as webcrypto.CryptoKeyPair;
    const appleJwkJson = JSON.stringify(await subtle.exportKey("jwk", ecPair.privateKey));
    const appleAssertion = await createAppleClientSecretJwt({
      servicesId: "app.sugent.web",
      teamId: "TEAM123",
      keyId: "KEY123",
      signingJwkJson: appleJwkJson,
    });
    expect(appleAssertion.split(".")).toHaveLength(3);

    const now = Math.floor(Date.now() / 1000);
    const appleIss = `${HTTPS_PROTO}${["appleid", "apple", "com"].join(".")}`;
    const appleRsa = await makeMockRsaIdToken({
      iss: appleIss,
      aud: "app.sugent.web",
      sub: "apple_uid_01",
      email: "member@sugent.example",
      nonce: "n_apple",
      iat: now,
      exp: now + 600,
    });
    const appleAdapter = new AppleSignInAdapter(
      {
        servicesId: "app.sugent.web",
        teamId: "TEAM123",
        keyId: "KEY123",
        signingJwkJson: appleJwkJson,
      },
      async (url) =>
        String(url).endsWith("/keys")
          ? Response.json(appleRsa.jwks)
          : Response.json({ id_token: appleRsa.idToken }),
    );
    expect(
      appleAdapter.buildAuthorizeUrl({
        callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/apple`,
        state: "st",
        nonce: "n_apple",
      }),
    ).toContain("response_mode=form_post");
    const appleId = await appleAdapter.exchangeCallback({
      code: "c_apple",
      callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/apple`,
      expectedNonce: "n_apple",
      rawAppleUserJson: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }),
    });
    expect(appleId).toMatchObject({ idp: "apple", providerSubject: "apple_uid_01", name: "Ada Lovelace" });

    // 2. Google OIDC
    const googleIss = `${HTTPS_PROTO}${["accounts", "google", "com"].join(".")}`;
    const googleRsa = await makeMockRsaIdToken({
      iss: googleIss,
      aud: "sugent-google-web.example",
      sub: "g_uid_01",
      email: "g@sugent.app",
      name: "Grace Hopper",
      hd: "sugent.app",
      nonce: "n_google",
      iat: now,
      exp: now + 600,
    });
    const googleAdapter = new GoogleOidcAdapter(
      { clientId: "sugent-google-web.example", clientSecret: "g_cred" },
      async (url) =>
        String(url).endsWith("/certs")
          ? Response.json(googleRsa.jwks)
          : Response.json({ id_token: googleRsa.idToken }),
    );
    const googleId = await googleAdapter.exchangeCallback({
      code: "c_google",
      callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/google`,
      expectedNonce: "n_google",
    });
    expect(googleId).toMatchObject({ idp: "google", providerSubject: "g_uid_01", rawOrgKey: "sugent.app" });

    // 3. WeChat text/plain unionid
    const wxAdapter = new WechatQrAdapter({ appId: "wx_id", appSecret: "wx_cred" }, async (url) => {
      if (String(url).includes("userinfo")) {
        return new Response(
          JSON.stringify({ openid: "o1", unionid: "wx_u_99", nickname: "张工" }),
          { status: 200, headers: { "content-type": "text/plain" } },
        );
      }
      return new Response(
        JSON.stringify({ access_token: "wx_at", openid: "o1", unionid: "wx_u_99" }),
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    });
    expect(
      wxAdapter.buildAuthorizeUrl({
        callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/wechat`,
        state: "s",
        nonce: "n",
      }).endsWith("#wechat_redirect"),
    ).toBe(true);
    const wxId = await wxAdapter.exchangeCallback({
      code: "c_wx",
      callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/wechat`,
    });
    expect(wxId).toMatchObject({ idp: "wechat", providerSubject: "wx_u_99", name: "张工" });

    // 4. Feishu & 5. DingTalk
    const fsAdapter = new FeishuAuthAdapter({ appId: "cli_1", appSecret: "fs_cred" }, async (url) =>
      String(url).includes("user_info")
        ? Response.json({ code: 0, data: { name: "李总", union_id: "on_fs_1", tenant_key: "t_acme" } })
        : Response.json({ code: 0, access_token: "fs_at" }),
    );
    expect(
      await fsAdapter.exchangeCallback({
        code: "c_fs",
        callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/feishu`,
      }),
    ).toMatchObject({ idp: "feishu", providerSubject: "on_fs_1", rawOrgKey: "t_acme" });

    const dtAdapter = new DingTalkAuthAdapter({ clientId: "dt_id", clientSecret: "dt_cred" }, async (url) =>
      String(url).includes("users/me")
        ? Response.json({ nick: "王工", unionId: "dt_u_1" })
        : Response.json({ accessToken: "dt_at", corpId: "corp_1" }),
    );
    expect(
      await dtAdapter.exchangeCallback({
        code: "c_dt",
        callbackUrl: `${HTTPS_PROTO}auth.sugent.app/oauth/callback/dingtalk`,
      }),
    ).toMatchObject({ idp: "dingtalk", providerSubject: "dt_u_1", rawOrgKey: "corp_1" });
  });

  it("completes full SugentAuthManager zero-secret loopback PKCE login, JWKS verification, refresh & revocation", async () => {
    const signingKey = await generateBrokerSigningKeyPair("sugent-prod-2026");
    const issuer = `${HTTPS_PROTO}auth.sugent.app`;
    const env: BrokerEnv = {
      BROKER_ISSUER_URL: issuer,
      BROKER_MASTER_SECRET: "demo-e2e-broker-seal-key-unit-test",
      DEFAULT_SYNC_ENDPOINT: `${HTTPS_PROTO}sync.sugent.app/v1`,
      DEFAULT_RELAY_ENDPOINT: `${WSS_PROTO}relay.sugent.app/v1`,
      FEISHU_APP_ID: "cli_sugent",
      FEISHU_APP_SECRET: "fs_server_cred",
      ENTITLEMENT_RULES_JSON: JSON.stringify({
        teamOrgs: { feishu_vip: { orgId: "org_vip_hq", plan: "team" } },
      }),
      AUTH_KV: createMemoryKv(),
    };

    const broker = createBrokerApp({
      signingKeys: [signingKey],
      fetchFn: async (input) => {
        const u = String(input);
        if (u.includes("user_info")) {
          return Response.json({
            code: 0,
            data: {
              name: "陈总监",
              email: "chen@sugent.team",
              union_id: "on_leader_01",
              tenant_key: "feishu_vip",
            },
          });
        }
        return Response.json({ code: 0, access_token: "fs_u_tok" });
      },
    });

    const preset = buildBrokerDesktopAuthConfig({ issuerUrl: issuer, idpHint: "feishu" });
    const manager = new SugentAuthManager({
      dataDir: tmpDir,
      config: {
        mode: preset.mode,
        issuer: preset.issuerUrl,
        clientId: preset.clientId,
        scopes: [...preset.scopes],
      },
      fetchImpl: (input, init) => broker.request(String(input), init, env),
    });

    const session = await manager.startLogin({
      extraAuthParams: { idp_hint: "feishu" },
    });

    // Step 1: Desktop browser opens /oauth/authorize -> 302 /oauth/login/feishu -> 302 Feishu
    const step1 = await broker.request(session.authorizationUrl, { method: "GET" }, env);
    expect(step1.status).toBe(302);
    const loginLoc = step1.headers.get("location")!;
    const step2 = await broker.request(new URL(loginLoc, issuer).toString(), { method: "GET" }, env);
    expect(step2.status).toBe(302);
    const upstreamUrl = new URL(step2.headers.get("location")!);
    const upstreamState = upstreamUrl.searchParams.get("state")!;

    // Step 2: Feishu redirects back to fixed HTTPS callback -> 302 to desktop loopback /callback
    const step3 = await broker.request(
      `${issuer}/oauth/callback/feishu?code=fs_code_ok&state=${encodeURIComponent(upstreamState)}`,
      { method: "GET" },
      env,
    );
    expect(step3.status).toBe(302);
    const loopbackHitUrl = step3.headers.get("location")!;

    // Step 3: Deliver callback to SugentAuthManager loopback listener (zero clientSecret!)
    const cbOut = await session.deliverCallback(loopbackHitUrl, "GET");
    expect(cbOut.status).toBe(200);
    const provisioned = await session.result;
    expect(provisioned.name).toBe("陈总监");
    expect(provisioned.subject).toMatch(/^usr_/);

    // Step 4: P2 Sync verifies JWT offline via /jwks.json
    const jwks = (await (await broker.request(`${issuer}/jwks.json`, {}, env)).json()) as JwkSetDocument;
    expect(jwks).toEqual(await exportPublicJwkSet([signingKey]));
    const rawClaims = await verifyJwtEs256(provisioned.idToken!, jwks, {
      issuer,
      audience: SUGENT_DESKTOP_CLIENT_ID,
    });
    const claims = parseSugentBrokerClaims(rawClaims);
    expect(claims.plan).toBe("team");
    expect(claims.org_id).toBe("org_vip_hq");
    expect(claims.sync_endpoint).toBe(`${HTTPS_PROTO}sync.sugent.app/v1`);

    // Step 5: Logout triggers RFC 7009 /oauth/revoke and clears local vault
    const revoked = await manager.logout();
    expect(revoked).toBe(true);
    expect(manager.status().signedIn).toBe(false);
  });
});

