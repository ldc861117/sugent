import type { BrokerEnv, UpstreamIdpName } from "../types.js";
import type { IdpAdapter } from "./base.js";
import { WechatQrAdapter } from "./wechat.js";
import { AppleSignInAdapter } from "./apple.js";
import { GoogleOidcAdapter } from "./google.js";
import { FeishuAuthAdapter } from "./feishu.js";
import { DingTalkAuthAdapter } from "./dingtalk.js";

export function createAdapterRegistry(
  env: BrokerEnv,
  fetchFn: typeof fetch = fetch,
): Map<UpstreamIdpName, IdpAdapter> {
  const map = new Map<UpstreamIdpName, IdpAdapter>();

  if (env.WECHAT_APP_ID && env.WECHAT_APP_SECRET) {
    map.set(
      "wechat",
      new WechatQrAdapter(
        { appId: env.WECHAT_APP_ID, appSecret: env.WECHAT_APP_SECRET },
        fetchFn,
      ),
    );
  }
  if (
    env.APPLE_SERVICES_ID &&
    env.APPLE_TEAM_ID &&
    env.APPLE_KEY_ID &&
    env.APPLE_PRIVATE_KEY_JWK
  ) {
    map.set(
      "apple",
      new AppleSignInAdapter(
        {
          servicesId: env.APPLE_SERVICES_ID,
          teamId: env.APPLE_TEAM_ID,
          keyId: env.APPLE_KEY_ID,
          signingJwkJson: env.APPLE_PRIVATE_KEY_JWK,
        },
        fetchFn,
      ),
    );
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    map.set(
      "google",
      new GoogleOidcAdapter(
        { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        fetchFn,
      ),
    );
  }
  if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
    map.set(
      "feishu",
      new FeishuAuthAdapter(
        { appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET },
        fetchFn,
      ),
    );
  }
  if (env.DINGTALK_CLIENT_ID && env.DINGTALK_CLIENT_SECRET) {
    map.set(
      "dingtalk",
      new DingTalkAuthAdapter(
        { clientId: env.DINGTALK_CLIENT_ID, clientSecret: env.DINGTALK_CLIENT_SECRET },
        fetchFn,
      ),
    );
  }

  return map;
}
