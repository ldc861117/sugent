import type { NormalizedIdpIdentity, UpstreamIdpName } from "../types.js";

export interface AuthorizeUrlParams {
  callbackUrl: string;
  state: string;
  nonce: string;
}

export interface ExchangeCallbackParams {
  code: string;
  callbackUrl: string;
  expectedNonce?: string;
  rawAppleUserJson?: string;
}

export interface IdpAdapter {
  readonly idp: UpstreamIdpName;
  readonly displayName: string;
  buildAuthorizeUrl(params: AuthorizeUrlParams): string;
  exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity>;
}

export async function parseJsonResponse<T>(res: Response, providerLabel: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${providerLabel} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${providerLabel} returned invalid JSON payload`);
  }
}
