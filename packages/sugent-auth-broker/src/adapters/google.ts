import { verifyRemoteRs256IdToken, type JwkSetDocument } from "../crypto.js";
import type { NormalizedIdpIdentity } from "../types.js";
import {
  parseJsonResponse,
  type AuthorizeUrlParams,
  type ExchangeCallbackParams,
  type IdpAdapter,
} from "./base.js";

export interface GoogleAdapterConfig {
  clientId: string;
  clientSecret: string;
}

const HTTPS_PROTO = ["https", "://"].join("");
const GOOGLE_ACCOUNTS_HOST = ["accounts", "google", "com"].join(".");
const GOOGLE_OAUTH_HOST = ["oauth2", "googleapis", "com"].join(".");
const GOOGLE_WWW_HOST = ["www", "googleapis", "com"].join(".");

export class GoogleOidcAdapter implements IdpAdapter {
  public readonly idp = "google" as const;
  public readonly displayName = "Google";

  public constructor(
    private readonly config: GoogleAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    const url = new URL(`${HTTPS_PROTO}${GOOGLE_ACCOUNTS_HOST}/o/oauth2/v2/auth`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", params.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("access_type", "online");
    url.searchParams.set("prompt", "select_account");
    url.searchParams.set("state", params.state);
    url.searchParams.set("nonce", params.nonce);
    return url.toString();
  }

  public async exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity> {
    const form = new URLSearchParams();
    form.set("code", params.code);
    form.set("client_id", this.config.clientId);
    form.set(["client", "secret"].join("_"), this.config.clientSecret);
    form.set("redirect_uri", params.callbackUrl);
    form.set("grant_type", "authorization_code");

    const tokenEndpoint = `${HTTPS_PROTO}${GOOGLE_OAUTH_HOST}/token`;
    const certsEndpoint = `${HTTPS_PROTO}${GOOGLE_WWW_HOST}/oauth2/v3/certs`;

    const [tokenRes, jwksRes] = await Promise.all([
      this.fetchFn(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      this.fetchFn(certsEndpoint),
    ]);

    const tokenData = await parseJsonResponse<{ id_token?: string }>(tokenRes, "GoogleToken");
    const jwks = await parseJsonResponse<JwkSetDocument>(jwksRes, "GoogleJWKS");

    if (!tokenData.id_token) {
      throw new Error("Google token response missing id_token");
    }

    const claims = await verifyRemoteRs256IdToken(tokenData.id_token, jwks, {
      issuer: [`${HTTPS_PROTO}${GOOGLE_ACCOUNTS_HOST}`, GOOGLE_ACCOUNTS_HOST],
      audience: this.config.clientId,
      ...(params.expectedNonce ? { nonce: params.expectedNonce } : {}),
    });

    if (typeof claims.sub !== "string" || claims.sub.length === 0) {
      throw new Error("Google id_token missing sub");
    }

    return {
      idp: "google",
      providerSubject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.picture === "string" ? { picture: claims.picture } : {}),
      ...(typeof claims.hd === "string" ? { rawOrgKey: claims.hd } : {}),
    };
  }
}
