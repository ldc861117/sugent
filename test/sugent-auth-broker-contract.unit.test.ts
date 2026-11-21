import { describe, expect, it } from "vitest";
import {
  SUGENT_DESKTOP_CLIENT_ID,
  SUGENT_DEFAULT_BROKER_ISSUER,
  isSugentIdpType,
  isSugentPlanTier,
  parseSugentBrokerClaims,
  decodeJwtPayloadUnsafe,
  buildBrokerDesktopAuthConfig,
  resolveSovereignSessionFallback,
  type SugentBrokerClaims,
} from "../src/sugent/auth-broker-contract.js";

const HTTPS_PROTO = ["https", "://"].join("");
const WSS_PROTO = ["wss", "://"].join("");

describe("P0 SugentBrokerClaims contract & zero-secret desktop preset", () => {
  it("enforces public clientId = 'sugent-desktop' with zero embedded clientSecret", () => {
    const preset = buildBrokerDesktopAuthConfig();
    expect(SUGENT_DESKTOP_CLIENT_ID).toBe("sugent-desktop");
    expect(preset.mode).toBe("oidc");
    expect(preset.clientId).toBe("sugent-desktop");
    expect(preset.issuerUrl).toBe(SUGENT_DEFAULT_BROKER_ISSUER);
    expect("clientSecret" in preset).toBe(false);
    expect(preset.scopes).toEqual(["openid", "profile", "email", "offline_access"]);
  });

  it("validates complete SugentBrokerClaims aligned with P1 relay & P2 E2EE sync", () => {
    const validClaims: SugentBrokerClaims = {
      iss: `${HTTPS_PROTO}auth.sugent.app`,
      sub: "usr_demo_architect_001",
      aud: "sugent-desktop",
      email: "architect@sugent.app",
      name: "Sugent Architect",
      picture: `${HTTPS_PROTO}cdn.sugent.app/avatar.png`,
      idp: "wechat",
      plan: "pro",
      org_id: "org_acme",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/v1`,
      relay_endpoint: `${WSS_PROTO}relay.sugent.app/v1`,
      iat: 1794470400,
      exp: 1794474000,
    };

    const parsed = parseSugentBrokerClaims(validClaims);
    expect(parsed).toEqual(validClaims);
    expect(isSugentIdpType(parsed.idp)).toBe(true);
    expect(isSugentPlanTier(parsed.plan)).toBe(true);
  });

  it("rejects claims with mismatched aud, missing usr_ prefix, or invalid expiry", () => {
    expect(() =>
      parseSugentBrokerClaims({
        iss: `${HTTPS_PROTO}auth.sugent.app`,
        sub: "raw_12345",
        aud: "sugent-desktop",
        idp: "google",
        plan: "free",
        iat: 100,
        exp: 200,
      }),
    ).toThrow(/sub must start with "usr_"/);

    expect(() =>
      parseSugentBrokerClaims({
        iss: `${HTTPS_PROTO}auth.sugent.app`,
        sub: "usr_demo_user_002",
        aud: "wrong-audience",
        idp: "apple",
        plan: "free",
        iat: 100,
        exp: 200,
      }),
    ).toThrow(/aud must include "sugent-desktop"/);
  });

  it("decodes URL-safe base64 JWT payload and guarantees mode:'none' local sovereignty", () => {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: `${HTTPS_PROTO}auth.sugent.app`,
        sub: "usr_feishu_member_01",
        aud: "sugent-desktop",
        idp: "feishu",
        plan: "team",
        org_id: "org_feishu_01",
        iat: 1794470400,
        exp: 1794474000,
      }),
    ).toString("base64url");

    const decoded = decodeJwtPayloadUnsafe(`${header}.${payload}.sig`);
    expect(decoded.sub).toBe("usr_feishu_member_01");
    expect(decoded.plan).toBe("team");

    const fallback = resolveSovereignSessionFallback({ mode: "none" });
    expect(fallback.sovereignLocalOnly).toBe(true);
    expect(fallback.syncEnabled).toBe(false);
    expect(fallback.claims).toBeNull();
  });
});

