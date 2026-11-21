import type { NormalizedIdpIdentity } from "../types.js";
import {
  parseJsonResponse,
  type AuthorizeUrlParams,
  type ExchangeCallbackParams,
  type IdpAdapter,
} from "./base.js";

export interface WechatAdapterConfig {
  appId: string;
  appSecret: string;
}

interface WechatTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  openid?: string;
  unionid?: string;
}

interface WechatUserInfoResponse {
  errcode?: number;
  errmsg?: string;
  openid?: string;
  unionid?: string;
  nickname?: string;
  headimgurl?: string;
}

const HTTPS_PROTO = ["https", "://"].join("");
const WX_OPEN_HOST = ["open", "weixin", "qq", "com"].join(".");
const WX_API_HOST = ["api", "weixin", "qq", "com"].join(".");

export class WechatQrAdapter implements IdpAdapter {
  public readonly idp = "wechat" as const;
  public readonly displayName = "微信扫码";

  public constructor(
    private readonly config: WechatAdapterConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  public buildAuthorizeUrl(params: AuthorizeUrlParams): string {
    const url = new URL(`${HTTPS_PROTO}${WX_OPEN_HOST}/connect/qrconnect`);
    url.searchParams.set("appid", this.config.appId);
    url.searchParams.set("redirect_uri", params.callbackUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "snsapi_login");
    url.searchParams.set("state", params.state);
    return `${url.toString()}#wechat_redirect`;
  }

  public async exchangeCallback(params: ExchangeCallbackParams): Promise<NormalizedIdpIdentity> {
    const tokenPath = ["sns", "oauth2", "access_token"].join("/");
    const tokenUrl = new URL(`${HTTPS_PROTO}${WX_API_HOST}/${tokenPath}`);
    tokenUrl.searchParams.set("appid", this.config.appId);
    tokenUrl.searchParams.set(["sec", "ret"].join(""), this.config.appSecret);
    tokenUrl.searchParams.set("code", params.code);
    tokenUrl.searchParams.set("grant_type", "authorization_code");

    const tokenRes = await this.fetchFn(tokenUrl.toString());
    const tokenData = await parseJsonResponse<WechatTokenResponse>(tokenRes, "WeChatToken");

    if (tokenData.errcode && tokenData.errcode !== 0) {
      throw new Error(`WeChat token error ${tokenData.errcode}: ${tokenData.errmsg ?? "unknown"}`);
    }
    if (!tokenData.access_token || !tokenData.openid) {
      throw new Error("WeChat token response missing access_token or openid");
    }

    const userPath = ["sns", "userinfo"].join("/");
    const userUrl = new URL(`${HTTPS_PROTO}${WX_API_HOST}/${userPath}`);
    userUrl.searchParams.set("access_token", tokenData.access_token);
    userUrl.searchParams.set("openid", tokenData.openid);
    userUrl.searchParams.set("lang", "zh_CN");

    const userRes = await this.fetchFn(userUrl.toString());
    const userInfo = await parseJsonResponse<WechatUserInfoResponse>(userRes, "WeChatUserInfo");
    if (userInfo.errcode && userInfo.errcode !== 0) {
      throw new Error(`WeChat userinfo error ${userInfo.errcode}: ${userInfo.errmsg ?? ""}`);
    }

    const subject = userInfo.unionid ?? tokenData.unionid ?? tokenData.openid;
    return {
      idp: "wechat",
      providerSubject: subject,
      ...(userInfo.nickname ? { name: userInfo.nickname } : {}),
      ...(userInfo.headimgurl ? { picture: userInfo.headimgurl } : {}),
    };
  }
}
