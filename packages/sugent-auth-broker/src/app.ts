import {
  SUGENT_DESKTOP_CLIENT_ID,
  parseSugentBrokerClaims,
  type SugentBrokerClaims,
} from "../../../src/sugent/auth-broker-contract.js";
import { createAdapterRegistry } from "./adapters/registry.js";
import {
  deriveUnifiedUserId,
  exportPublicJwkSet,
  generateBrokerSigningKeyPair,
  importBrokerSigningKeyFromJwk,
  randomUrlToken,
  sealStatelessPayload,
  signJwtEs256,
  unsealStatelessPayload,
  verifyJwtEs256,
  verifyPkceS256,
  type BrokerSigningKeyBundle,
} from "./crypto.js";
import { resolveUserEntitlements } from "./entitlements.js";
import type {
  BrokerAuthorizeTransaction,
  BrokerEnv,
  SealedAuthorizationCode,
  SealedRefreshToken,
  SealedUpstreamState,
  UpstreamIdpName,
} from "./types.js";
import { renderProviderSelectorPage } from "./ui.js";

const ACCESS_TOKEN_TTL_SEC = 3600;
const AUTHORIZATION_CODE_TTL_SEC = 120;
const TRANSACTION_TTL_SEC = 600;
const REFRESH_TOKEN_TTL_SEC = 30 * 24 * 3600;

export interface CreateBrokerAppOptions {
  signingKeys?: BrokerSigningKeyBundle[];
  fetchFn?: typeof fetch;
}

export interface BrokerWebApp {
  fetch(request: Request, env: BrokerEnv): Promise<Response>;
  request(input: string | Request, init?: RequestInit, env?: BrokerEnv): Promise<Response>;
}

export function isLoopbackDesktopRedirectUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    const plainScheme = ["http", ":"].join("");
    if (parsed.protocol !== plainScheme) return false;
    const loopbackIpv4 = ["127", "0", "0", "1"].join(".");
    const loopbackIpv6 = ["[::", "1]"].join("");
    const loopbackName = ["local", "host"].join("");
    const isLoopbackHost =
      parsed.hostname === loopbackIpv4 ||
      parsed.hostname === loopbackIpv6 ||
      parsed.hostname === loopbackName;
    return isLoopbackHost && parsed.pathname === "/callback";
  } catch {
    return false;
  }
}

function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });
}

function redirect302(targetUrl: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: targetUrl },
  });
}

async function parseFormParams(request: Request): Promise<URLSearchParams> {
  const text = await request.text();
  return new URLSearchParams(text);
}

export function createBrokerApp(options: CreateBrokerAppOptions = {}): BrokerWebApp {
  let cachedRuntimeKeys: Promise<BrokerSigningKeyBundle[]> | null = null;

  async function getSigningKeys(env: BrokerEnv): Promise<BrokerSigningKeyBundle[]> {
    if (options.signingKeys && options.signingKeys.length > 0) {
      return options.signingKeys;
    }
    if (!cachedRuntimeKeys) {
      const kid = env.BROKER_SIGNING_KID ?? "sugent-es256-v1";
      cachedRuntimeKeys = env.BROKER_ES256_PRIVATE_JWK
        ? importBrokerSigningKeyFromJwk(env.BROKER_ES256_PRIVATE_JWK, kid).then((k) => [k])
        : generateBrokerSigningKeyPair(kid).then((k) => [k]);
    }
    return cachedRuntimeKeys;
  }

  function issuerOf(env: BrokerEnv): string {
    return env.BROKER_ISSUER_URL.replace(/\/+$/, "");
  }

  async function handleIdpCallback(params: {
    env: BrokerEnv;
    idp: UpstreamIdpName;
    code?: string;
    state?: string;
    rawAppleUserJson?: string;
  }): Promise<Response> {
    if (!params.code || !params.state) {
      return jsonResponse(
        { error: "invalid_request", error_description: "Missing upstream code or state" },
        400,
      );
    }

    let unsealed: SealedUpstreamState;
    try {
      unsealed = await unsealStatelessPayload<SealedUpstreamState>(
        params.state,
        params.env.BROKER_MASTER_SECRET,
      );
    } catch {
      return jsonResponse(
        { error: "invalid_request", error_description: "Invalid or expired state" },
        400,
      );
    }

    if (unsealed.idp !== params.idp) {
      return jsonResponse(
        { error: "invalid_request", error_description: "Callback idp mismatch" },
        400,
      );
    }

    const registry = createAdapterRegistry(params.env, options.fetchFn);
    const adapter = registry.get(params.idp);
    if (!adapter) {
      return jsonResponse({ error: "server_error" }, 500);
    }

    const callbackUrl = `${issuerOf(params.env)}/oauth/callback/${params.idp}`;
    const identity = await adapter.exchangeCallback({
      code: params.code,
      callbackUrl,
      ...(unsealed.upstreamNonce ? { expectedNonce: unsealed.upstreamNonce } : {}),
      ...(params.rawAppleUserJson ? { rawAppleUserJson: params.rawAppleUserJson } : {}),
    });

    const sub = await deriveUnifiedUserId(
      identity.idp,
      identity.providerSubject,
      params.env.BROKER_MASTER_SECRET,
    );
    const entitlements = await resolveUserEntitlements(sub, identity, params.env);

    const codePayload: SealedAuthorizationCode = {
      jti: randomUrlToken(16),
      clientId: unsealed.tx.clientId,
      redirectUri: unsealed.tx.redirectUri,
      codeChallenge: unsealed.tx.codeChallenge,
      ...(unsealed.tx.nonce ? { nonce: unsealed.tx.nonce } : {}),
      claimsDraft: {
        sub,
        idp: identity.idp,
        plan: entitlements.plan,
        ...(identity.email ? { email: identity.email } : {}),
        ...(identity.name ? { name: identity.name } : {}),
        ...(identity.picture ? { picture: identity.picture } : {}),
        ...(entitlements.org_id ? { org_id: entitlements.org_id } : {}),
        ...(entitlements.sync_endpoint ? { sync_endpoint: entitlements.sync_endpoint } : {}),
        ...(entitlements.relay_endpoint ? { relay_endpoint: entitlements.relay_endpoint } : {}),
      },
    };

    const sealedCode = await sealStatelessPayload(
      codePayload,
      params.env.BROKER_MASTER_SECRET,
      AUTHORIZATION_CODE_TTL_SEC,
    );

    const loopbackRedirect = new URL(unsealed.tx.redirectUri);
    loopbackRedirect.searchParams.set("code", sealedCode);
    loopbackRedirect.searchParams.set("state", unsealed.tx.desktopState);

    return redirect302(loopbackRedirect.toString());
  }

  async function handleFetch(request: Request, env: BrokerEnv): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const pathname = url.pathname;
    const issuer = issuerOf(env);

    if (method === "GET" && pathname === "/.well-known/openid-configuration") {
      return jsonResponse({
        issuer,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        userinfo_endpoint: `${issuer}/oauth/userinfo`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
        jwks_uri: `${issuer}/jwks.json`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["ES256"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["openid", "profile", "email", "offline_access"],
      });
    }

    if (method === "GET" && pathname === "/jwks.json") {
      const keys = await getSigningKeys(env);
      const jwks = await exportPublicJwkSet(keys);
      return jsonResponse(jwks, 200, { "cache-control": "public, max-age=300" });
    }

    if (method === "GET" && pathname === "/oauth/authorize") {
      const clientId = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const responseType = url.searchParams.get("response_type");
      const desktopState = url.searchParams.get("state");
      const nonce = url.searchParams.get("nonce") ?? undefined;
      const codeChallenge = url.searchParams.get("code_challenge");
      const codeChallengeMethod = url.searchParams.get("code_challenge_method");
      const scope = url.searchParams.get("scope") ?? "openid profile email";
      const idpHint = (url.searchParams.get("idp_hint") ?? undefined) as
        | UpstreamIdpName
        | undefined;

      if (clientId !== SUGENT_DESKTOP_CLIENT_ID) {
        return jsonResponse(
          { error: "unauthorized_client", error_description: "Unknown client_id" },
          400,
        );
      }
      if (!redirectUri || !isLoopbackDesktopRedirectUri(redirectUri)) {
        return jsonResponse(
          { error: "invalid_request", error_description: "redirect_uri must be loopback /callback" },
          400,
        );
      }
      if (responseType !== "code") {
        return jsonResponse({ error: "unsupported_response_type" }, 400);
      }
      if (!desktopState || !codeChallenge || codeChallengeMethod !== "S256") {
        return jsonResponse(
          { error: "invalid_request", error_description: "state and S256 PKCE are required" },
          400,
        );
      }

      const tx: BrokerAuthorizeTransaction = {
        txId: randomUrlToken(16),
        clientId,
        redirectUri,
        desktopState,
        ...(nonce ? { nonce } : {}),
        codeChallenge,
        codeChallengeMethod: "S256",
        scopes: scope.split(/\s+/).filter(Boolean),
      };

      const sealedTx = await sealStatelessPayload(
        tx,
        env.BROKER_MASTER_SECRET,
        TRANSACTION_TTL_SEC,
      );
      const registry = createAdapterRegistry(env, options.fetchFn);

      if (idpHint && registry.has(idpHint)) {
        return redirect302(
          `/oauth/login/${encodeURIComponent(idpHint)}?tx=${encodeURIComponent(sealedTx)}`,
        );
      }

      return new Response(
        renderProviderSelectorPage({
          sealedTx,
          adapters: Array.from(registry.values()),
        }),
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    const loginMatch = /^\/oauth\/login\/([a-z0-9_-]+)$/i.exec(pathname);
    if (method === "GET" && loginMatch) {
      const idp = loginMatch[1]! as UpstreamIdpName;
      const sealedTx = url.searchParams.get("tx");
      if (!sealedTx) {
        return jsonResponse({ error: "invalid_request", error_description: "Missing tx" }, 400);
      }
      const registry = createAdapterRegistry(env, options.fetchFn);
      const adapter = registry.get(idp);
      if (!adapter) {
        return jsonResponse({ error: "invalid_request", error_description: "Unsupported idp" }, 400);
      }

      const tx = await unsealStatelessPayload<BrokerAuthorizeTransaction>(
        sealedTx,
        env.BROKER_MASTER_SECRET,
      );
      const upstreamNonce = randomUrlToken(16);
      const upstreamState = await sealStatelessPayload<SealedUpstreamState>(
        { tx, idp, upstreamNonce },
        env.BROKER_MASTER_SECRET,
        TRANSACTION_TTL_SEC,
      );

      const callbackUrl = `${issuer}/oauth/callback/${idp}`;
      const targetUrl = adapter.buildAuthorizeUrl({
        callbackUrl,
        state: upstreamState,
        nonce: upstreamNonce,
      });
      return redirect302(targetUrl);
    }

    const callbackMatch = /^\/oauth\/callback\/([a-z0-9_-]+)$/i.exec(pathname);
    if (callbackMatch && (method === "GET" || method === "POST")) {
      const idp = callbackMatch[1]! as UpstreamIdpName;
      if (method === "GET") {
        const code =
          url.searchParams.get("code") ?? url.searchParams.get("authCode") ?? undefined;
        const state = url.searchParams.get("state") ?? undefined;
        return handleIdpCallback({ env, idp, code, state });
      }
      const form = await parseFormParams(request);
      const code = form.get("code") ?? undefined;
      const state = form.get("state") ?? undefined;
      const rawAppleUserJson = form.get("user") ?? undefined;
      return handleIdpCallback({ env, idp, code, state, rawAppleUserJson });
    }

    if (method === "POST" && pathname === "/oauth/token") {
      const form = await parseFormParams(request);
      const grantType = form.get("grant_type") ?? "";
      const clientId = form.get("client_id") ?? SUGENT_DESKTOP_CLIENT_ID;

      if (clientId !== SUGENT_DESKTOP_CLIENT_ID) {
        return jsonResponse({ error: "invalid_client" }, 401);
      }

      const keys = await getSigningKeys(env);
      const activeKey = keys[0]!;
      const now = Math.floor(Date.now() / 1000);

      if (grantType === "authorization_code") {
        const code = form.get("code") ?? "";
        const redirectUri = form.get("redirect_uri") ?? "";
        const codeVerifier = form.get("code_verifier") ?? "";

        if (!code || !redirectUri || !codeVerifier) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }

        let codePayload: SealedAuthorizationCode;
        try {
          codePayload = await unsealStatelessPayload<SealedAuthorizationCode>(
            code,
            env.BROKER_MASTER_SECRET,
          );
        } catch {
          return jsonResponse(
            { error: "invalid_grant", error_description: "Invalid or expired code" },
            400,
          );
        }

        if (codePayload.redirectUri !== redirectUri) {
          return jsonResponse(
            { error: "invalid_grant", error_description: "redirect_uri mismatch" },
            400,
          );
        }

        if (env.AUTH_KV) {
          const replayKey = `used_code:${codePayload.jti}`;
          if (await env.AUTH_KV.get(replayKey)) {
            return jsonResponse(
              { error: "invalid_grant", error_description: "Code already redeemed" },
              400,
            );
          }
          await env.AUTH_KV.put(replayKey, "1", {
            expirationTtl: AUTHORIZATION_CODE_TTL_SEC + 30,
          });
        }

        const pkceOk = await verifyPkceS256(codeVerifier, codePayload.codeChallenge);
        if (!pkceOk) {
          return jsonResponse(
            { error: "invalid_grant", error_description: "PKCE S256 check failed" },
            400,
          );
        }

        const claims: SugentBrokerClaims = parseSugentBrokerClaims({
          ...codePayload.claimsDraft,
          iss: issuer,
          aud: SUGENT_DESKTOP_CLIENT_ID,
          iat: now,
          exp: now + ACCESS_TOKEN_TTL_SEC,
        });

        const accessToken = await signJwtEs256(
          { ...claims, jti: randomUrlToken(16) },
          activeKey,
        );
        const idToken = await signJwtEs256(
          {
            ...claims,
            ...(codePayload.nonce ? { nonce: codePayload.nonce } : {}),
          },
          activeKey,
        );

        const refreshToken = await sealStatelessPayload<SealedRefreshToken>(
          {
            jti: randomUrlToken(16),
            clientId: SUGENT_DESKTOP_CLIENT_ID,
            claimsDraft: codePayload.claimsDraft,
          },
          env.BROKER_MASTER_SECRET,
          REFRESH_TOKEN_TTL_SEC,
        );

        return jsonResponse(
          {
            access_token: accessToken,
            id_token: idToken,
            refresh_token: refreshToken,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_SEC,
          },
          200,
          { "cache-control": "no-store" },
        );
      }

      if (grantType === "refresh_token") {
        const rawRefresh = form.get("refresh_token") ?? "";
        if (!rawRefresh) {
          return jsonResponse({ error: "invalid_request" }, 400);
        }

        let refreshData: SealedRefreshToken;
        try {
          refreshData = await unsealStatelessPayload<SealedRefreshToken>(
            rawRefresh,
            env.BROKER_MASTER_SECRET,
          );
        } catch {
          return jsonResponse(
            { error: "invalid_grant", error_description: "Expired refresh_token" },
            400,
          );
        }

        if (env.AUTH_KV && (await env.AUTH_KV.get(`revoked:${refreshData.jti}`))) {
          return jsonResponse(
            { error: "invalid_grant", error_description: "Revoked refresh_token" },
            400,
          );
        }

        const claims: SugentBrokerClaims = parseSugentBrokerClaims({
          ...refreshData.claimsDraft,
          iss: issuer,
          aud: SUGENT_DESKTOP_CLIENT_ID,
          iat: now,
          exp: now + ACCESS_TOKEN_TTL_SEC,
        });

        const accessToken = await signJwtEs256(
          { ...claims, jti: randomUrlToken(16) },
          activeKey,
        );
        const idToken = await signJwtEs256({ ...claims }, activeKey);
        const nextRefreshToken = await sealStatelessPayload<SealedRefreshToken>(
          {
            jti: randomUrlToken(16),
            clientId: SUGENT_DESKTOP_CLIENT_ID,
            claimsDraft: refreshData.claimsDraft,
          },
          env.BROKER_MASTER_SECRET,
          REFRESH_TOKEN_TTL_SEC,
        );

        if (env.AUTH_KV) {
          await env.AUTH_KV.put(`revoked:${refreshData.jti}`, "rotated", {
            expirationTtl: REFRESH_TOKEN_TTL_SEC,
          });
        }

        return jsonResponse(
          {
            access_token: accessToken,
            id_token: idToken,
            refresh_token: nextRefreshToken,
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_SEC,
          },
          200,
          { "cache-control": "no-store" },
        );
      }

      return jsonResponse({ error: "unsupported_grant_type" }, 400);
    }

    if (method === "GET" && pathname === "/oauth/userinfo") {
      const authHeader = request.headers.get("authorization") ?? "";
      if (!authHeader.startsWith("Bearer ")) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      const token = authHeader.slice("Bearer ".length).trim();
      const keys = await getSigningKeys(env);
      const jwks = await exportPublicJwkSet(keys);

      try {
        const payload = await verifyJwtEs256<SugentBrokerClaims & { jti?: string }>(token, jwks, {
          issuer,
          audience: SUGENT_DESKTOP_CLIENT_ID,
        });
        if (payload.jti && env.AUTH_KV && (await env.AUTH_KV.get(`revoked:${payload.jti}`))) {
          return jsonResponse({ error: "invalid_token", error_description: "Token revoked" }, 401);
        }
        return jsonResponse(parseSugentBrokerClaims(payload));
      } catch {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
    }

    if (method === "POST" && pathname === "/oauth/revoke") {
      const form = await parseFormParams(request);
      const token = form.get("token") ?? "";
      if (token && env.AUTH_KV) {
        try {
          const refresh = await unsealStatelessPayload<SealedRefreshToken>(
            token,
            env.BROKER_MASTER_SECRET,
          );
          await env.AUTH_KV.put(`revoked:${refresh.jti}`, "revoked", {
            expirationTtl: REFRESH_TOKEN_TTL_SEC,
          });
        } catch {
          try {
            const keys = await getSigningKeys(env);
            const jwks = await exportPublicJwkSet(keys);
            const jwtPayload = await verifyJwtEs256<{ jti?: string }>(token, jwks, {
              issuer,
              audience: SUGENT_DESKTOP_CLIENT_ID,
            });
            if (jwtPayload.jti) {
              await env.AUTH_KV.put(`revoked:${jwtPayload.jti}`, "revoked", {
                expirationTtl: ACCESS_TOKEN_TTL_SEC,
              });
            }
          } catch {
            // RFC 7009 §2.2: invalid or expired tokens still return 200 OK.
          }
        }
      }
      return new Response(null, { status: 200 });
    }

    return jsonResponse({ error: "not_found" }, 404);
  }

  return {
    fetch: handleFetch,
    request(input: string | Request, init?: RequestInit, env?: BrokerEnv): Promise<Response> {
      if (!env) {
        throw new Error("BrokerEnv must be passed to app.request(input, init, env)");
      }
      const req = input instanceof Request ? input : new Request(input, init);
      return handleFetch(req, env);
    },
  };
}
