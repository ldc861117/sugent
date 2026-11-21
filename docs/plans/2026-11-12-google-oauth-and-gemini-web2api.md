# Google OAuth 改造与 gemini-web2api-go 深度兼容实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Sugent 现有的 Modelflare 专属账户 OAuth 改造为原生兼容 [Google OAuth 2.0 桌面端流程](https://developers.google.com/identity/protocols/oauth2/native-app)（回环 PKCE + 多域名 OIDC 发现 + 桌面端 `client_secret` 加密存储），并在模型网关、上下文压缩管家、Base64 多模态产物解包与 MCP 工具层完整兼容 [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go)（v4.28+）。

**Architecture:** 严格遵守 [`AGENTS.md`](../../AGENTS.md) 零侵入扩展原则，将身份平面与算力反代平面正交解耦：(1) 在身份层升级 [`src/sugent/auth-provider.ts`](../../src/sugent/auth-provider.ts) 与 [`src/account/oauth.ts`](../../src/account/oauth.ts)，修复 [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) 跨子域端点（`accounts.google.com` vs `oauth2.googleapis.com` / `openidconnect.googleapis.com`）被同源校验误杀、[Google OAuth 2.0 桌面端应用](https://developers.google.com/identity/protocols/oauth2/native-app) 强制要求 `client_secret` 以及首次授权需传 `access_type=offline` 的三大协议差异；(2) 在算力层扩展 [`src/sugent/provider-registry.ts`](../../src/sugent/provider-registry.ts)、[`src/sugent/model-catalog.ts`](../../src/sugent/model-catalog.ts) 并新增 `src/sugent/gemini-web2api.ts`，针对 [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go) 实现 `/v1/chat/completions` + `/v1/responses` 双协议映射、36k Token 安全上下文墙（规避网页端 130 KB–160 KB UTF-8 截断墙）、Cookie 池档位自动探测、生图生曲 Base64 产物落盘解包及 `/mcp` 工具桥接。

**Tech Stack:** TypeScript (ESM, Node >= 22.13), Vitest, Preact + htm, [yetone/magpie](https://github.com/yetone/magpie) 本地网关, [zexadev/gemini-web2api-go](https://github.com/zexadev/gemini-web2api-go), [Google OAuth 2.0 for Desktop Apps (RFC 8252)](https://developers.google.com/identity/protocols/oauth2/native-app).

---

## 一、并行波次与文件隔离拓扑

- **Wave 1（三路完全并行，无文件重叠）**：
  - **Task 1（Google OAuth 协议内核）**：修改 `src/sugent/auth-provider.ts`，新建 `test/sugent-google-oauth.unit.test.ts`。
  - **Task 3（Web2API 预设与 36k 安全目录）**：修改 `src/sugent/provider-registry.ts`、`src/sugent/model-catalog.ts`，新建 `test/sugent-gemini-web2api-catalog.unit.test.ts`。
  - **Task 4（Web2API 探针、媒体解包与 MCP 描述器）**：新建 `src/sugent/gemini-web2api.ts`，修改 `src/sugent/index.ts`，新建 `test/sugent-gemini-web2api-adapter.unit.test.ts`。
- **Wave 2（宿主与 REST API 集成）**：
  - **Task 2 & Task 5**：修改 `src/account/oauth.ts`、`src/app.ts`、`src/web/server.ts`，新建 `test/sugent-auth-api-google.unit.test.ts` 与 `test/sugent-gemini-web2api-api.unit.test.ts`。
- **Wave 3（前端 UI 改造与全量门禁验收）**：
  - **Task 6**：修改 `ui/components/provider-settings.js`、`ui/screens/onboarding.js`、`ui/screens/account.js`、`ui/locales/*`、`package.json`、`.env.example`，执行 `npm run test:sugent` 与 `npm run verify:sugent`。
