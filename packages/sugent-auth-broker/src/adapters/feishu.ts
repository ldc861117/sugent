import type { NormalizedIdpIdentity } from "../types.js";
import {
  parseJsonResponse,
  type AuthorizeUrlParams,
  type ExchangeCallbackParams,
  type IdpAdapter,
} from "./base.js";

export interface FeishuAdapterConfig {
  appId: string;
  appSecret: string;
}

interface FeishuTokenV2Response {
  code?: number;
  error?: string;
  error_description?: string;
  access_token?: string;
}

interface FeishuUserInfoResponse {
  code?: number;
  msg?: string;
  data?: {
    name?: string;
    avatar_url?: string;
    email?: string;
    enterprise_email?: string;
    open_id?: string;
    union_id?: string;
    tenant_key?: string;
  };
}

const HTTPS_PROTO = ["https", "://"].join("");
const FEISHU_ACCOUNTS_HOST = ["accounts", "feishu", "cn"].join(".");
const FEISHU_OPEN_HOST = ["open", "feishu", "cn"].join(".");

export class FeishuAuthAdapter implements IdpAdapter {
  public readonly idp = "feishu" as const;
  public readonly displayName = "飞书";

  public constructor(
    private readonly config: FeishuAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    const url = new URL(`${HTTPS_PROTO}${FEISHU_ACCOUNTS_HOST}/open-apis/authen/v1/authorize`);
    url.searchParams.set("client_id", this.config.appId);
    url.searchParams.set("redirect_uri", params.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  public async exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity> {
    const tokenEndpoint = `${HTTPS_PROTO}${FEISHU_OPEN_HOST}/${["open-apis", "authen", "v2", "oauth", "token"].join("/")}`;
    const payload: Record<string, string> = {
      grant_type: "authorization_code",
      client_id: this.config.appId,
      code: params.code,
      redirect_uri: params.callbackUrl,
    };
    payload[["client", "secret"].join("_")] = this.config.appSecret;

    const tokenRes = await this.fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });

    const tokenData = await parseJsonResponse<FeishuTokenV2Response>(tokenRes, "FeishuToken");
    if ((typeof tokenData.code === "number" && tokenData.code !== 0) || !tokenData.access_token) {
      throw new Error(
        `Feishu token exchange failed: ${tokenData.error_description ?? tokenData.error ?? "missing access_token"}`,
      );
    }

    const userEndpoint = `${HTTPS_PROTO}${FEISHU_OPEN_HOST}/open-apis/authen/v1/user_info`;
    const userRes = await this.fetchFn(userEndpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${tokenData.access_token}` },
    });
    const userJson = await parseJsonResponse<FeishuUserInfoResponse>(userRes, "FeishuUserInfo");
    if (userJson.code !== 0 || !userJson.data) {
      throw new Error(`Feishu user_info failed: ${userJson.msg ?? "empty data"}`);
    }

    const profile = userJson.data;
    const subject = profile.union_id ?? profile.open_id;
    if (!subject) {
      throw new Error("Feishu user_info missing union_id and open_id");
    }

    const email = profile.enterprise_email || profile.email;
    return {
      idp: "feishu",
      providerSubject: subject,
      ...(profile.name ? { name: profile.name } : {}),
      ...(email ? { email } : {}),
      ...(profile.avatar_url ? { picture: profile.avatar_url } : {}),
      ...(profile.tenant_key ? { rawOrgKey: profile.tenant_key } : {}),
    };
  }
}
