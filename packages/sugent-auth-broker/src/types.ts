import type {
  SugentBrokerClaims,
  SugentIdpType,
  SugentPlanTier,
} from "../../../src/sugent/auth-broker-contract.js";

export interface OptionalKvStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface BrokerEnv {
  BROKER_ISSUER_URL: string;
  BROKER_MASTER_SECRET: string;
  BROKER_SIGNING_KID?: string;
  BROKER_ES256_PRIVATE_JWK?: string;
  DEFAULT_SYNC_ENDPOINT?: string;
  DEFAULT_RELAY_ENDPOINT?: string;
  ENTITLEMENT_RULES_JSON?: string;

  WECHAT_APP_ID?: string;
  WECHAT_APP_SECRET?: string;

  APPLE_SERVICES_ID?: string;
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_PRIVATE_KEY_JWK?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;

  FEISHU_APP_ID?: string;
  FEISHU_APP_SECRET?: string;

  DINGTALK_CLIENT_ID?: string;
  DINGTALK_CLIENT_SECRET?: string;

  AUTH_KV?: OptionalKvStore;
}

export type UpstreamIdpName = Exclude<SugentIdpType, "oidc">;

export interface NormalizedIdpIdentity {
  idp: UpstreamIdpName;
  providerSubject: string;
  email?: string;
  name?: string;
  picture?: string;
  rawOrgKey?: string;
}

export interface BrokerAuthorizeTransaction {
  txId: string;
  clientId: string;
  redirectUri: string;
  desktopState: string;
  nonce?: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scopes: string[];
}

export interface SealedUpstreamState {
  tx: BrokerAuthorizeTransaction;
  idp: UpstreamIdpName;
  upstreamNonce: string;
}

export interface SealedAuthorizationCode {
  jti: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  nonce?: string;
  claimsDraft: Omit<SugentBrokerClaims, "iat" | "exp" | "iss" | "aud">;
}

export interface SealedRefreshToken {
  jti: string;
  clientId: string;
  claimsDraft: Omit<SugentBrokerClaims, "iat" | "exp" | "iss" | "aud">;
}

export interface EntitlementSnapshot {
  plan: SugentPlanTier;
  org_id?: string;
  sync_endpoint?: string;
  relay_endpoint?: string;
}
