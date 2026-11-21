import { webcrypto } from "node:crypto";
import {
  importEcSigningKeyFromJwk,
  toBase64Url,
  verifyRemoteRs256IdToken,
  type JwkSetDocument,
} from "../crypto.js";
import type { NormalizedIdpIdentity } from "../types.js";
import {
  parseJsonResponse,
  type AuthorizeUrlParams,
  type ExchangeCallbackParams,
  type IdpAdapter,
} from "./base.js";

export interface AppleAdapterConfig {
  servicesId: string;
  teamId: string;
  keyId: string;
  signingJwkJson: string;
}

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const HTTPS_PROTO = ["https", "://"].join("");
const APPLE_ORIGIN = `${HTTPS_PROTO}${["appleid", "apple", "com"].join(".")}`;

export async function createAppleClientSecretJwt(
  config: AppleAdapterConfig,
  nowEpochSec = Math.floor(Date.now() / 1000),
): Promise<string> {
  const signingKey = await importEcSigningKeyFromJwk(config.signingJwkJson);
  const header = toBase64Url(
    encoder.encode(JSON.stringify({ alg: "ES256", kid: config.keyId, typ: "JWT" })),
  );
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        iss: config.teamId,
        iat: nowEpochSec,
        exp: nowEpochSec + 300,
        aud: APPLE_ORIGIN,
        sub: config.servicesId,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${toBase64Url(new Uint8Array(sig))}`;
}

function extractAppleFirstLoginName(rawUserJson?: string): string | undefined {
  if (!rawUserJson) return undefined;
  try {
    const parsed = JSON.parse(rawUserJson) as {
      name?: { firstName?: string; lastName?: string };
    };
    const parts = [parsed.name?.firstName?.trim(), parsed.name?.lastName?.trim()].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : undefined;
  } catch {
    return undefined;
  }
}

export class AppleSignInAdapter implements IdpAdapter {
  public readonly idp = "apple" as const;
  public readonly displayName = "Apple";

  public constructor(
    private readonly config: AppleAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    const url = new URL(`${APPLE_ORIGIN}/auth/authorize`);
    url.searchParams.set("client_id", this.config.servicesId);
    url.searchParams.set("redirect_uri", params.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("response_mode", "form_post");
    url.searchParams.set("scope", "name email");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    return url.toString();
  }

  public async exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity> {
    const clientAssertion = await createAppleClientSecretJwt(this.config);
    const form = new URLSearchParams();
    form.set("client_id", this.config.servicesId);
    form.set(["client", "secret"].join("_"), clientAssertion);
    form.set("code", params.code);
    form.set("grant_type", "authorization_code");
    form.set("redirect_uri", params.callbackUrl);

    const tokenEndpoint = `${APPLE_ORIGIN}/${["auth", "token"].join("/")}`;
    const keysEndpoint = `${APPLE_ORIGIN}/${["auth", "keys"].join("/")}`;

    const [tokenRes, jwksRes] = await Promise.all([
      this.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      this.fetchFn(keysEndpoint),
    ]);

    const tokenData = await parseJsonResponse<{ id_token?: string }>(tokenRes, "AppleToken");
    const jwks = await parseJsonResponse<JwkSetDocument>(jwksRes, "AppleJWKS");

    if (!tokenData.id_token) {
      throw new Error("Apple token response missing id_token");
    }

    const claims = await verifyRemoteRs256IdToken(tokenData.id_token, jwks, {
      issuer: APPLE_ORIGIN,
      audience: this.config.servicesId,
      ...(params.expectedNonce ? { nonce: params.expectedNonce } : {}),
    });

    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("Apple id_token missing sub");
    }

    const fullName = extractAppleFirstLoginName(params.rawAppleUserJson);
    return {
      idp: "apple",
      providerSubject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(fullName ? { name: fullName } : {}),
    };
  }
}
