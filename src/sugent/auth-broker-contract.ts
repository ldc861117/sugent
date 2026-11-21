/**
 * 跨轨道共享认证与商业权益声明契约（P0 Auth Broker <-> Desktop <-> P1 Relay <-> P2 Cloud Sync）
 */

const HTTPS_PROTO = ["https", "://"].join("");

export const SUGENT_DESKTOP_CLIENT_ID = "sugent-desktop" as const;
export const SUGENT_DEFAULT_BROKER_ISSUER = `${HTTPS_PROTO}auth.sugent.app`;

export const SUGENT_IDP_TYPES = [
  "wechat",
  "apple",
  "google",
  "feishu",
  "dingtalk",
  "oidc",
] as const;

export type SugentIdpType = (typeof SUGENT_IDP_TYPES)[number];

export const SUGENT_PLAN_TIERS = ["free", "pro", "team"] as const;

export type SugentPlanTier = (typeof SUGENT_PLAN_TIERS)[number];

export interface SugentBrokerClaims {
  iss: string;
  sub: string;
  aud: string;
  email?: string;
  name?: string;
  picture?: string;
  idp: "wechat" | "apple" | "google" | "feishu" | "dingtalk" | "oidc";
  plan: "free" | "pro" | "team";
  org_id?: string;
  sync_endpoint?: string;
  relay_endpoint?: string;
  exp: number;
  iat: number;
}

export interface SugentDesktopBrokerAuthPreset {
  readonly mode: "oidc";
  readonly issuerUrl: string;
  readonly clientId: typeof SUGENT_DESKTOP_CLIENT_ID;
  readonly scopes: readonly string[];
  readonly idpHint?: Exclude<SugentIdpType, "oidc">;
}

export interface SovereignLocalState {
  readonly mode: "none";
  readonly authenticated: false;
  readonly sovereignLocalOnly: true;
  readonly syncEnabled: false;
  readonly claims: null;
}

export function isSugentIdpType(value: unknown): value is SugentIdpType {
  return typeof value === "string" && (SUGENT_IDP_TYPES as readonly string[]).includes(value);
}

export function isSugentPlanTier(value: unknown): value is SugentPlanTier {
  return typeof value === "string" && (SUGENT_PLAN_TIERS as readonly string[]).includes(value);
}

export function parseSugentBrokerClaims(raw: unknown): SugentBrokerClaims {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid SugentBrokerClaims: payload must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.iss !== "string" || obj.iss.trim().length === 0) {
    throw new Error("Invalid SugentBrokerClaims: iss must be a non-empty string");
  }
  if (typeof obj.sub !== "string" || !/^usr_[a-zA-Z0-9_-]{8,64}$/.test(obj.sub)) {
    throw new Error('Invalid SugentBrokerClaims: sub must start with "usr_" followed by hash');
  }

  const audMatches =
    obj.aud === SUGENT_DESKTOP_CLIENT_ID ||
    (Array.isArray(obj.aud) && obj.aud.includes(SUGENT_DESKTOP_CLIENT_ID));
  if (!audMatches) {
    throw new Error('Invalid SugentBrokerClaims: aud must include "sugent-desktop"');
  }

  if (!isSugentIdpType(obj.idp)) {
    throw new Error(`Invalid SugentBrokerClaims: unsupported idp "${String(obj.idp)}"`);
  }
  if (!isSugentPlanTier(obj.plan)) {
    throw new Error(`Invalid SugentBrokerClaims: unsupported plan "${String(obj.plan)}"`);
  }
  if (typeof obj.iat !== "number" || !Number.isFinite(obj.iat)) {
    throw new Error("Invalid SugentBrokerClaims: iat must be a finite epoch number");
  }
  if (typeof obj.exp !== "number" || !Number.isFinite(obj.exp) || obj.exp <= obj.iat) {
    throw new Error("Invalid SugentBrokerClaims: exp must be a finite number greater than iat");
  }

  const claims: SugentBrokerClaims = {
    iss: obj.iss,
    sub: obj.sub,
    aud: SUGENT_DESKTOP_CLIENT_ID,
    idp: obj.idp,
    plan: obj.plan,
    iat: obj.iat,
    exp: obj.exp,
  };

  if (typeof obj.email === "string" && obj.email.length > 0) claims.email = obj.email;
  if (typeof obj.name === "string" && obj.name.length > 0) claims.name = obj.name;
  if (typeof obj.picture === "string" && obj.picture.length > 0) claims.picture = obj.picture;
  if (typeof obj.org_id === "string" && obj.org_id.length > 0) claims.org_id = obj.org_id;
  if (typeof obj.sync_endpoint === "string" && obj.sync_endpoint.length > 0) {
    claims.sync_endpoint = obj.sync_endpoint;
  }
  if (typeof obj.relay_endpoint === "string" && obj.relay_endpoint.length > 0) {
    claims.relay_endpoint = obj.relay_endpoint;
  }

  return claims;
}

export function decodeJwtPayloadUnsafe(jwt: string): SugentBrokerClaims {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("Malformed JWT string: expected 3 dot-separated segments");
  }
  const jsonText = Buffer.from(parts[1], "base64url").toString("utf8");
  return parseSugentBrokerClaims(JSON.parse(jsonText));
}

export function buildBrokerDesktopAuthConfig(options?: {
  issuerUrl?: string;
  idpHint?: Exclude<SugentIdpType, "oidc">;
}): SugentDesktopBrokerAuthPreset {
  return {
    mode: "oidc",
    issuerUrl: (options?.issuerUrl ?? SUGENT_DEFAULT_BROKER_ISSUER).replace(/\/+$/, ""),
    clientId: SUGENT_DESKTOP_CLIENT_ID,
    scopes: ["openid", "profile", "email", "offline_access"],
    ...(options?.idpHint ? { idpHint: options.idpHint } : {}),
  };
}

export function resolveSovereignSessionFallback(config: { mode: "none" }): SovereignLocalState {
  return {
    mode: config.mode,
    authenticated: false,
    sovereignLocalOnly: true,
    syncEnabled: false,
    claims: null,
  };
}
