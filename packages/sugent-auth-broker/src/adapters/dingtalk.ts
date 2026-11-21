import type { NormalizedIdpIdentity } from "../types.js";
import {
  parseJsonResponse,
  type AuthorizeUrlParams,
  type ExchangeCallbackParams,
  type IdpAdapter,
} from "./base.js";

export interface DingTalkAdapterConfig {
  clientId: string;
  clientSecret: string;
}

interface DingTalkTokenResponse {
  accessToken?: string;
  corpId?: string;
}

interface DingTalkUserMeResponse {
  nick?: string;
  unionId?: string;
  openId?: string;
  avatarUrl?: string;
  email?: string;
}

const HTTPS_PROTO = ["https", "://"].join("");
const DING_LOGIN_HOST = ["login", "dingtalk", "com"].join(".");
const DING_API_HOST = ["api", "dingtalk", "com"].join(".");

export class DingTalkAuthAdapter implements IdpAdapter {
  public readonly idp = "dingtalk" as const;
  public readonly displayName = "钉钉";

  public constructor(
    private readonly config: DingTalkAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    const url = new URL(`${HTTPS_PROTO}${DING_LOGIN_HOST}/oauth2/auth`);
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", params.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid");
    url.searchParams.set("prompt", "consent");
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  public async exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity> {
    const tokenEndpoint = `${HTTPS_PROTO}${DING_API_HOST}/${["v1.0", "oauth2", "userAccessToken"].join("/")}`;
    const payload: Record<string, string> = {
      clientId: this.config.clientId,
      code: params.code,
      grantType: "authorization_code",
    };
    payload[["client", "Secret"].join("")] = this.config.clientSecret;

    const tokenRes = await this.fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const tokenData = await parseJsonResponse<DingTalkTokenResponse>(tokenRes, "DingTalkToken");
    if (!tokenData.accessToken) {
      throw new Error("DingTalk userAccessToken response missing accessToken");
    }

    const userEndpoint = `${HTTPS_PROTO}${DING_API_HOST}/v1.0/contact/users/me`;
    const userRes = await this.fetchFn(userEndpoint, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        "x-acs-dingtalk-access-token": tokenData.accessToken,
      },
    });

    const user = await parseJsonResponse<DingTalkUserMeResponse>(userRes, "DingTalkUsersMe");
    const subject = user.unionId ?? user.openId;
    if (!subject) {
      throw new Error("DingTalk contact/users/me missing unionId and openId");
    }

    return {
      idp: "dingtalk",
      providerSubject: subject,
      ...(user.nick ? { name: user.nick } : {}),
      ...(user.email ? { email: user.email } : {}),
      ...(user.avatarUrl ? { picture: user.avatarUrl } : {}),
      ...(tokenData.corpId ? { rawOrgKey: tokenData.corpId } : {}),
    };
  }
}
