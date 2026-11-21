# Sugent Auth Broker 统一多渠道认证与权益网关实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 构建零运维、无状态边缘优先的 `Sugent Auth Broker`（统一身份联邦与商业权益网关），使 Sugent 桌面安装包（DMG/EXE）仅凭公开标识 `sugent-desktop`（零内置敏感凭证）即可一次性打通微信扫码、Apple、Google、飞书与钉钉五路登录，并签发与 P2 端到端加密云同步严格对齐的 `SugentBrokerClaims` 声明，同时保障 `mode: "none"` 本地主权模式免登录全功能可用。

**Architecture:** 采用“上游标准 [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) + [RFC 7636 PKCE](https://datatracker.ietf.org/doc/html/rfc7636) 公开客户端收口、中游 AES-256-GCM 无状态密封流转、下游可插拔身份适配器”三层解耦架构。桌面端复用 [`src/sugent/auth-provider.ts`](../../src/sugent/auth-provider.ts) 中的 `SugentAuthManager`（遵循 [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) 本地随机端口回环）；独立工作区包 `packages/sugent-auth-broker/` 基于 [Hono](https://hono.dev/docs/getting-started/cloudflare-workers) 与原生 [Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) 构建，同时兼容边缘节点与单进程 Node.js >= 22.13 容器部署，严守 [`AGENTS.md`](../../AGENTS.md) 零侵入扩展边界。

**Tech Stack:** TypeScript (ESM, Strict Mode), Node.js >= 22.13, [Hono v4](https://hono.dev/docs/getting-started/cloudflare-workers), [Web Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) (`ES256` / `RS256` / `AES-256-GCM` / `HMAC-SHA256`), Cloudflare Workers (可选 KV 墓碑存储), Vitest.

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

在编写认证网关代码前，逐条对照 [`AGENTS.md`](../../AGENTS.md) 第 3 节商业化与主权门禁完成自省：

### 0.1 付费锚点（Why Pay & Moat）
- **付费驱动力**：本地免费版解决单机智能体执行，而跨设备知识工作者与一人公司（OPC）面临三大刚需——**多设备零知识加密图谱漫游（P2 E2EE Sync）**、**外出移动端审批卡片实时中继（P1 Concierge Relay）** 以及 **小微团队席位与共享武器包治理（Team License）**。`Sugent Auth Broker` 将多平台账号归一化为不可逆主键 `usr_<hash>`，并在令牌声明中统一下发 `plan`、`org_id`、`sync_endpoint` 与 `relay_endpoint`。
- **架构护城河**：通过声明级端点路由实现**控制面（身份与订阅档位）与数据面（加密同步桶、就近中继网关）彻底解耦**，个人单机（`mode: "none"`）可平滑升级至 Pro 云同步或飞书/钉钉企业租户私有节点。

### 0.2 合规与分发（Distribution & ToS Risk）
- **安装包零机密红线**：桌面端 DMG/EXE 属于公开分发制品，遵循 [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) 与 [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) S256 挑战校验，安装包仅携带公开标识 `sugent-desktop`，第三方平台凭证全部收口至服务端环境变量。
- **回调域名与商店审核合规**：[微信开放平台网站应用](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html)、[飞书开放平台](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN) 与 [钉钉开放平台](https://open.dingtalk.com/document/isvapp/tutorial-enabling-login-to-third-party-websites) 均要求固定备案 HTTPS 回调域名，[Sign in with Apple 网页接入规范](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms) 要求 `form_post` 回调且满足 App Store Guidelines 4.8 同等登录选项要求。Broker 统一以固定备案域名承接五路回调后再跳回桌面回环监听端口。
- **最小隐私采集**：仅对上游唯一标识（优先 `unionid` / `union_id` / `unionId`）做单向 HMAC 摘要生成 `usr_<hash>`，不落盘明文口令，不申请多余通讯录写权限。

### 0.3 离线退路（Sovereignty Fallback）
- **免登录默认可用**：当配置 `mode: "none"` 或处于断网环境时，`SugentAuthManager` 直接返回本地主权会话，零网络探测、零启动阻塞。
- **故障优雅降级与自托管逃生舱**：云端不可达时本地工作台、BYOK 模型路由与本地图谱读写不受任何影响；企业团队亦可通过 `node-server.ts` 自托管私有网关实例。

### 0.4 一人公司运维杠杆（OPC Ops Leverage）
- **无数据库自密封状态机**：短期授权上下文（10 分钟 TTL）与一次性兑换票据（120 秒 TTL）均经服务端 `AES-256-GCM` 自密封校验，零 PostgreSQL/Redis 运维负担。
- **Apple 动态断言免人工续期**：依据 [Apple Token Validation 规范](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens) 按需动态签发短期 ES256 断言，彻底规避静态密钥每 180 天过期引发的线上故障。

## 1. 上下游协议契约与目录拓扑

### 1.1 标准发现与令牌端点矩阵

| 服务端路径 | 方法 | 遵循标准规范 | 核心职责与安全边界 |
| :--- | :--- | :--- | :--- |
| `/.well-known/openid-configuration` | `GET` | [OpenID Connect Discovery 1.0](https://openid.net/specs/openid-connect-discovery-1_0.html) | 暴露标准端点元数据，声明仅支持 `S256` PKCE 与公开客户端模式 |
| `/jwks.json` | `GET` | [RFC 7517 (JSON Web Key)](https://datatracker.ietf.org/doc/html/rfc7517) | 输出 `P-256` (`ES256`) 公钥集供桌面端与 P2 云同步网关离线验签 |
| `/oauth/authorize` | `GET` | [OpenID Connect Core 1.0](https://openid.net/specs/openid-connect-core-1_0.html) | 校验 `sugent-desktop` 与本地回环回调路径，密封事务上下文并渲染渠道选择页 |
| `/oauth/token` | `POST` | [RFC 7636 (PKCE)](https://datatracker.ietf.org/doc/html/rfc7636) | 常量时间验证 `S256` 校验码并防重放，签发含商业权益声明的 ES256 JWT |
| `/oauth/userinfo` | `GET` | [OpenID Connect Core 1.0 §5.3](https://openid.net/specs/openid-connect-core-1_0.html) | 校验访问令牌签名与吊销墓碑，返回最新 `SugentBrokerClaims` 画像 |
| `/oauth/revoke` | `POST` | [RFC 7009 (Token Revocation)](https://www.rfc-editor.org/info/rfc7009/) | 写入边缘 KV 吊销墓碑（未绑定 KV 时按标准幂等返回 `200`） |

### 1.2 下游五路身份源适配规范

| 渠道标识 (`idp`) | 授权与换票协议要点 | 唯一主体映射规则 | 官方权威参考文档 |
| :--- | :--- | :--- | :--- |
| `wechat` | 网站扫码 `/connect/qrconnect`（`snsapi_login`）与 `/sns/oauth2/access_token`，兼容 `text/plain` JSON 响应与 `errcode` 判定 | 优先取 `unionid` 兜底 `openid` | [微信开放平台网站应用开发指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html) / [授权规范](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html) |
| `apple` | `/auth/authorize` 启用 `response_mode=form_post`，服务端实时生成 ES256 断言换票并结合 [Apple JWKS](https://developer.apple.com/documentation/signinwithapplerestapi/jwkset/keys-data.dictionary) 验签，提取首次授权 `user` 姓名 | 取验签后 `sub` 声明 | [Sign in with Apple 跨平台接入](https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms) / [生成与验证令牌](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens) |
| `google` | 标准授权端点请求 `openid email profile`，服务端换票后结合公钥集验证 RS256 签名 | 取 `sub`，并将 Workspace `hd` 映射为组织提示 | [Google OpenID Connect 指南](https://developers.google.com/identity/openid-connect/openid-connect) |
| `feishu` | `/open-apis/authen/v1/authorize` 配合 v2 换票及 `authen/v1/user_info` 画像拉取 | 优先取 `union_id` 兜底 `open_id`，映射 `tenant_key` 至 `org_id` | [飞书获取授权码](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN) / [获取 user_access_token](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token?lang=zh-CN) |
| `dingtalk` | `/oauth2/auth`（`scope=openid`）配合 `/v1.0/oauth2/userAccessToken` 与 `/v1.0/contact/users/me`（`x-acs-dingtalk-access-token` 头） | 优先取 `unionId` 兜底 `openId`，关联 `corpId` | [钉钉网页登录教程](https://open.dingtalk.com/document/isvapp/tutorial-enabling-login-to-third-party-websites) / [获取用户个人身份凭证](https://open.dingtalk.com/document/orgapp-server/obtain-identity-credentials) |

### 1.3 目录结构规划（遵循 `AGENTS.md` 零侵入原则）

```text
sugent/
├── src/sugent/
│   ├── auth-provider.ts                 # 增量重导出预设辅助函数，不改动回环与 mode:"none" 逻辑
│   └── auth-broker-contract.ts          # [新增] 跨轨共享 SugentBrokerClaims 类型、校验器与零密钥预设
├── packages/sugent-auth-broker/         # [新增] 云端独立无状态服务包（Workers + Node 双栖）
│   ├── package.json
│   ├── tsconfig.json
│   ├── wrangler.toml
│   └── src/
│       ├── types.ts                     # 环境变量、密封票据与适配器契约
│       ├── crypto.ts                    # Web Crypto ES256 签发/验签、JWKS、AES-256-GCM 密封、PKCE S256、usr_<hash>
│       ├── entitlements.ts              # 订阅档位映射与可选 KV 快照解析（下发 P2 sync_endpoint）
│       ├── ui.ts                        # 零外部脚本的聚合登录选择视图
│       ├── app.ts                       # Hono 标准 OIDC 路由与上下游状态机编排
│       ├── index.ts                     # Cloudflare Workers 边缘入口
│       ├── node-server.ts               # 单进程 Node >= 22.13 容器自托管入口
│       └── adapters/                    # base / google / apple / wechat / feishu / dingtalk / registry
└── test/
    ├── sugent-auth-broker-contract.unit.test.ts
    ├── sugent-auth-broker-crypto.unit.test.ts
    ├── sugent-auth-broker-adapters.unit.test.ts
    └── sugent-auth-broker.e2e.unit.test.ts
```

## 2. TDD 分步实施任务拆解（Task 1 ~ Task 6）

### Task 1: 跨轨共享 `SugentBrokerClaims` 契约与桌面端零密钥预设

**Files:**
- Create: `src/sugent/auth-broker-contract.ts`
- Modify: `src/sugent/auth-provider.ts`（末尾增量重导出 `buildBrokerDesktopAuthConfig` 与 `SugentBrokerClaims`）
- Test: `test/sugent-auth-broker-contract.unit.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  SUGENT_DESKTOP_CLIENT_ID,
  buildBrokerDesktopAuthConfig,
  parseSugentBrokerClaims,
  resolveSovereignSessionFallback,
} from "../src/sugent/auth-broker-contract.js";

const HTTPS_PROTO = ["https", "://"].join("");
const WSS_PROTO = ["wss", "://"].join("");

describe("SugentBrokerClaims contract & desktop zero-secret preset", () => {
  it("enforces public client_id = 'sugent-desktop' with zero embedded secret", () => {
    const cfg = buildBrokerDesktopAuthConfig();
    expect(SUGENT_DESKTOP_CLIENT_ID).toBe("sugent-desktop");
    expect(cfg.clientId).toBe("sugent-desktop");
    expect("clientSecret" in cfg).toBe(false);
  });

  it("validates claims aligned with P1 relay & P2 E2EE sync and preserves mode:'none' sovereignty", () => {
    const claims = parseSugentBrokerClaims({
      iss: `${HTTPS_PROTO}auth.sugent.app`,
      sub: "usr_demo_architect_001",
      aud: "sugent-desktop",
      idp: "wechat",
      plan: "pro",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/v1`,
      relay_endpoint: `${WSS_PROTO}relay.sugent.app/v1`,
      iat: 1794470400,
      exp: 1794474000,
    });
    expect(claims.plan).toBe("pro");
    expect(resolveSovereignSessionFallback({ mode: "none" }).sovereignLocalOnly).toBe(true);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-auth-broker-contract.unit.test.ts`
Expected: FAIL (`Cannot find module '../src/sugent/auth-broker-contract.js'`)

**Step 3: Write minimal implementation**

在 `src/sugent/auth-broker-contract.ts` 实现 `SugentBrokerClaims` 接口、`parseSugentBrokerClaims` 严格运行时校验（强制校验 `sub` 的 `usr_` 前缀、`aud` 包含 `sugent-desktop`、`idp` 与 `plan` 枚举合法性及 `exp > iat`）、`buildBrokerDesktopAuthConfig` 公开预设及 `resolveSovereignSessionFallback`。

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-auth-broker-contract.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sugent/auth-broker-contract.ts src/sugent/auth-provider.ts test/sugent-auth-broker-contract.unit.test.ts
git commit -m "feat(sugent-auth): define SugentBrokerClaims contract and zero-secret desktop preset"
```

### Task 2: Broker 独立包脚手架与 Web Crypto 无状态密码学内核

**Files:**
- Create: `packages/sugent-auth-broker/package.json`、`tsconfig.json`、`wrangler.toml`
- Create: `packages/sugent-auth-broker/src/types.ts`
- Create: `packages/sugent-auth-broker/src/crypto.ts`
- Test: `test/sugent-auth-broker-crypto.unit.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import {
  generateBrokerSigningKeyPair,
  exportPublicJwkSet,
  signJwtEs256,
  verifyJwtEs256,
  sealStatelessPayload,
  unsealStatelessPayload,
  computePkceS256Challenge,
  verifyPkceS256,
  deriveUnifiedUserId,
} from "../packages/sugent-auth-broker/src/crypto.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("Sugent Auth Broker Web Crypto kernel", () => {
  const sealKey = "demo-broker-seal-key-unit-test-only";

  it("signs/verifies ES256 JWT against exported JWKS and enforces AES-256-GCM TTL sealing", async () => {
    const kp = await generateBrokerSigningKeyPair("kid-2026-11");
    const jwks = await exportPublicJwkSet([kp]);
    const now = Math.floor(Date.now() / 1000);
    const jwt = await signJwtEs256(
      { iss: `${HTTPS_PROTO}auth.sugent.app`, sub: "usr_demo_0001", aud: "sugent-desktop", idp: "google", plan: "pro", iat: now, exp: now + 3600 },
      kp,
    );
    const verified = await verifyJwtEs256(jwt, jwks, {
      issuer: `${HTTPS_PROTO}auth.sugent.app`,
      audience: "sugent-desktop",
    });
    expect(verified.sub).toBe("usr_demo_0001");

    const sealed = await sealStatelessPayload({ txId: "tx_1" }, sealKey, 60);
    expect((await unsealStatelessPayload<{ txId: string }>(sealed, sealKey)).txId).toBe("tx_1");
  });

  it("validates PKCE S256 challenge and isolates usr_<hash> per idp", async () => {
    const verifier = "pkce-verifier-sample-string-with-minimum-43-characters-ok";
    const challenge = await computePkceS256Challenge(verifier);
    expect(await verifyPkceS256(verifier, challenge)).toBe(true);
    expect(await verifyPkceS256(`${verifier}x`, challenge)).toBe(false);

    const s1 = await deriveUnifiedUserId("wechat", "u_1", sealKey);
    const s2 = await deriveUnifiedUserId("feishu", "u_1", sealKey);
    expect(s1).not.toBe(s2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-auth-broker-crypto.unit.test.ts`
Expected: FAIL (`Cannot find module '../packages/sugent-auth-broker/src/crypto.js'`)

**Step 3: Write minimal implementation**

基于原生 `crypto.subtle` 实现：
1. `generateBrokerSigningKeyPair` / `importBrokerSigningKeyFromJwk` / `exportPublicJwkSet`（剥离私钥分量 `d`，输出符合 [RFC 7517](https://datatracker.ietf.org/doc/html/rfc7517) 的 `P-256` 公钥集）；
2. `signJwtEs256` / `verifyJwtEs256` 与上游 `verifyRemoteRs256IdToken`；
3. `sealStatelessPayload` / `unsealStatelessPayload`（12 字节随机 IV + `AES-256-GCM` 密封内嵌过期戳 `exp`）；
4. `verifyPkceS256`（43–128 字符长度门禁 + 常量时间比对）与 `deriveUnifiedUserId`（`HMAC-SHA256` 前 192-bit 编码为 `usr_<base64url>`）。

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-auth-broker-crypto.unit.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/sugent-auth-broker test/sugent-auth-broker-crypto.unit.test.ts
git commit -m "feat(auth-broker): bootstrap worker package and Web Crypto stateless kernel"
```

### Task 3: Apple 与 Google 国际身份源适配器

**Files:**
- Create: `packages/sugent-auth-broker/src/adapters/base.ts`
- Create: `packages/sugent-auth-broker/src/adapters/apple.ts`
- Create: `packages/sugent-auth-broker/src/adapters/google.ts`
- Test: `test/sugent-auth-broker-adapters.unit.test.ts`（国际渠道分节）

**Step 1–4 TDD 核心实现要点：**
- `AppleSignInAdapter`：构造携带 `response_mode=form_post` 与 `scope=name email` 的授权地址；在 `exchangeCallback` 中用 `P-256` 签名密钥实时签发 5 分钟有效期的 ES256 客户端断言换取 `id_token`，拉取 [Apple 公钥集](https://developer.apple.com/documentation/signinwithapplerestapi/jwkset/keys-data.dictionary) 完成 RS256 验签与 `nonce` 核对，并从首次授权表单 `user` JSON 中提取用户姓名。
- `GoogleOidcAdapter`：遵循 [Google OpenID Connect 指南](https://developers.google.com/identity/openid-connect/openid-connect) 请求 `openid email profile`，换票后校验 `iss`（兼容带与不带协议头的 Google 签发者声明）与 `aud`，并将 Google Workspace 的 `hd` 域声明透传至 `rawOrgKey`。
- 验证命令：`npx vitest run test/sugent-auth-broker-adapters.unit.test.ts` → PASS。

### Task 4: 微信扫码、飞书、钉钉国内适配器与动态注册表

**Files:**
- Create: `packages/sugent-auth-broker/src/adapters/wechat.ts`
- Create: `packages/sugent-auth-broker/src/adapters/feishu.ts`
- Create: `packages/sugent-auth-broker/src/adapters/dingtalk.ts`
- Create: `packages/sugent-auth-broker/src/adapters/registry.ts`
- Modify: `test/sugent-auth-broker-adapters.unit.test.ts`（补充国内三渠道与注册表用例）

**Step 1–4 TDD 核心实现要点：**
- `WechatQrAdapter`：遵循 [微信网站应用扫码规范](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html) 拼接 `#wechat_redirect` 锚点，处理 `text/plain` 响应体与 HTTP 200 内的非零 `errcode` 异常，优先提取跨应用统一的 `unionid`。
- `FeishuAuthAdapter`：对接 [飞书开放平台 `authen/v2/oauth/token`](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token?lang=zh-CN) 与 `authen/v1/user_info`，提取 `union_id` 及企业租户标识 `tenant_key`。
- `DingTalkAuthAdapter`：对接 [钉钉 `v1.0/oauth2/userAccessToken`](https://open.dingtalk.com/document/orgapp-server/obtain-identity-credentials)，使用 `x-acs-dingtalk-access-token` 请求头拉取 `/v1.0/contact/users/me` 中的 `unionId` 并关联 `corpId`，同时在回调层兼容 `code` 与 `authCode` 查询参数。
- `createAdapterRegistry(env, fetchFn)`：仅自动激活已配置完整凭证的渠道，未配置渠道不在聚合选择页渲染。
- 验证命令：`npx vitest run test/sugent-auth-broker-adapters.unit.test.ts` → PASS。

### Task 5: Hono 标准 OIDC 路由、权益注入器与 Workers/Node 双入口

**Files:**
- Create: `packages/sugent-auth-broker/src/entitlements.ts`
- Create: `packages/sugent-auth-broker/src/ui.ts`
- Create: `packages/sugent-auth-broker/src/app.ts`
- Create: `packages/sugent-auth-broker/src/index.ts`
- Create: `packages/sugent-auth-broker/src/node-server.ts`

**Step 1–4 TDD 核心实现要点：**
- **严格回环地址白名单**：`isLoopbackDesktopRedirectUri` 依据 [RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252) 仅放行本地 IPv4/IPv6 回环主机的 `/callback` 路径，阻断任何外部开放重定向。
- **双回调通道收敛**：同时挂载 `GET /oauth/callback/:idp` 与 `POST /oauth/callback/:idp`（承接 Apple `form_post`），解密校验 `SealedUpstreamState` 后将身份与权益密封为 120 秒一次性 `code` 跳回桌面回环端口。
- **权益解析（`resolveUserEntitlements`）**：优先读取边缘 KV 中的实时订阅快照（`entitlement:usr_<hash>`），其次匹配静态企业租户规则，为 `pro` / `team` 用户自动注入 `sync_endpoint` 与 `relay_endpoint`，免费用户回退 `plan: "free"`。
- **防重放与滚动吊销**：在 `/oauth/token` 兑换成功后将授权码 `jti` 记入短期已用集合拒绝重放；刷新令牌轮换与 `/oauth/revoke`（遵循 [RFC 7009](https://www.rfc-editor.org/info/rfc7009/)）统一维护 `revoked:<jti>` 墓碑。

### Task 6: 桌面端回环 PKCE 全链路闭环与离线主权回归测试

**Files:**
- Create: `test/sugent-auth-broker.e2e.unit.test.ts`

**全链路验收覆盖：**
1. 桌面端加载 `buildBrokerDesktopAuthConfig()`（仅含 `sugent-desktop`，零密钥）拉取 `/.well-known/openid-configuration`；
2. 生成随机回环回调端口与 PKCE `S256` 对，请求 `/oauth/authorize` → 跳转上游回调 → 拿回密封 `code`；
3. 零密钥调用 `/oauth/token` 换取 `id_token`、`access_token` 与 `refresh_token`，验证二次重放同一 `code` 返回 `400 invalid_grant`；
4. 模拟 P2 云同步服务端拉取 `/jwks.json` 离线验签并解析 `SugentBrokerClaims`（核对 `usr_` 主键、`plan`、`org_id`、`sync_endpoint`、`relay_endpoint`）；
5. 执行 `refresh_token` 滚动轮换与 `/oauth/revoke` 主动吊销，确认吊销后再次刷新被拦截；
6. 断网状态下验证 `mode: "none"` 零网络调用直接返回本地主权态。

**全局验收门禁命令：**

```bash
npx vitest run test/sugent-auth-broker*.unit.test.ts
npx tsc --noEmit && npx tsc -p packages/sugent-auth-broker/tsconfig.json --noEmit
npm run verify:sugent
```

## 3. 生产环境部署与运维核查清单（OPC Runbook）

1. **离线生成签名密钥并注入边缘机密存储**：通过原生 Web Crypto 生成 `P-256` 签名密钥对，将 `BROKER_MASTER_SECRET`、`BROKER_ES256_PRIVATE_JWK` 及五路下游平台凭证写入边缘运行时机密变量，严禁提交至 Git 仓库。
2. **第三方开放平台唯一固定回调域名登记**（统一指向已备案域名 `auth.sugent.app`）：
   - **微信开放平台**（[网站应用设置](https://developers.weixin.qq.com/doc/oplatform/developers/dev/auth/web.html)）：授权回调域填写 `auth.sugent.app`。
   - **Apple Developer Portal**（[Services ID 配置](https://developer.apple.com/documentation/signinwithapple/configuring-your-environment-for-sign-in-with-apple)）：Return URLs 登记 `/oauth/callback/apple` 完整 HTTPS 地址。
   - **Google Cloud Console**（[Web Application Client](https://developers.google.com/identity/protocols/oauth2/web-server)）：Authorized redirect URIs 登记 `/oauth/callback/google` 完整 HTTPS 地址。
   - **飞书开发者后台**（[安全设置重定向 URL](https://open.feishu.cn/document/authentication-management/access-token/obtain-oauth-code?lang=zh-CN)）：登记 `/oauth/callback/feishu` 完整 HTTPS 地址。
   - **钉钉开发者后台**（[登录第三方网站设置](https://open.dingtalk.com/document/isvapp/tutorial-enabling-login-to-third-party-websites)）：登记 `/oauth/callback/dingtalk` 完整 HTTPS 地址并开启通讯录个人信息读权限。
3. **发布后冒烟自检**：执行 `npm run deploy` 后请求 `/.well-known/openid-configuration` 与 `/jwks.json`，确认公钥集不含私钥分量 `d` 且各项端点响应正常。

