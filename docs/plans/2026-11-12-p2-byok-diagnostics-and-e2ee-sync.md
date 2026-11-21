# BYOK 连通性测速沙盘与零知识端到端加密同步实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在严格遵循 [`AGENTS.md`](../../AGENTS.md) 零侵入原则的前提下，交付 100% 本地免登录可用的商业级 BYOK 多供应商连通性测速诊断与四角色月度成本沙盘，以及基于 `SugentBrokerClaims` 与端侧信封加密的零知识（Zero-Knowledge）知识图谱云同步引擎。

**Architecture:** 新增核心逻辑全部收敛于 [`src/sugent/`](../../src/sugent/) 独立命名空间，单元测试收敛于 `test/sugent-*.unit.test.ts`。支柱 A 复用 [`src/sugent/provider-registry.ts`](../../src/sugent/provider-registry.ts)、[`src/sugent/model-catalog.ts`](../../src/sugent/model-catalog.ts) 与 `LocalBudgetLedger`，通过带并发信号量与 `AbortSignal` 超时控制的无副作用探针采集连接耗时、首字节延迟（TTFT）及 [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) / [Tool Calling](https://developers.openai.com/api/docs/guides/tools) 能力矩阵，并结合四角色日均负载计算“小模型守门 + 大模型攻坚”的月度美元净节省额；支柱 B 基于 [Node.js 原生 `node:crypto` 模块](https://nodejs.org/api/crypto.html) 构建 `PBKDF2-HMAC-SHA256`（[RFC 8018](https://www.rfc-editor.org/info/rfc8018/)）+ `HKDF-SHA256`（[RFC 5869](https://www.rfc-editor.org/info/rfc5869/)）+ `AES-256-GCM`（[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)）双层信封加密，配合单调递增 `lamportClock` 与 `supersededAt` 时效墓碑实现 [`src/sugent/knowledge-graph.ts`](../../src/sugent/knowledge-graph.ts) 跨设备无冲突确定性合并（CRDT），使云端对象存储仅持有不可解密的密文 Blob。

**Tech Stack:** TypeScript 5.x (ESM), Node.js >= 22.13 (`node:crypto`, `node:perf_hooks`, 原生 `fetch`), Vitest, Preact, [Cloudflare R2 S3 兼容存储接口](https://developers.cloudflare.com/r2/api/s3/api/) / [WebDAV (RFC 4918)](https://www.rfc-editor.org/info/rfc4918/)。

## 0. 商业策略自省四问（AGENTS.md 强制门禁）

在编写任何一行代码前，本规划逐项通过 [`AGENTS.md`](../../AGENTS.md) 商业化与主权架构门禁审查：

1. **付费锚点与漏斗分工是什么？**
   - **免费口碑引流层（支柱 A）**：BYOK 八大供应商连通性测速探针与四角色（`assessor | executor | computerUse | steward`）月度成本沙盘 **100% 免登录、零门槛开放**。重度开发者与一人公司（OPC）首次打开工作台即可一键揪出失效代理、高延迟节点与不支持 Tool Calling 的模型，并直观看到将高频初筛/巡检交给轻量模型后每月省下的 API 开支，形成自传播口碑。
   - **高毛利订阅转化层（支柱 B）**：当用户在主力 Mac 上沉淀了高价值的 `SugentKnowledgeGraph` 时效商业记忆与多角色编排配置后，跨设备（工作室台式机 + 随身笔记本）无缝接力成为刚需。校验 [JWT (RFC 7519)](https://www.rfc-editor.org/info/rfc7519/) 声明 `SugentBrokerClaims.plan`（`"pro" | "team"`）解锁官方托管边缘零知识云同步，实现高留存订阅变现。
2. **合规边界与隐私红线如何保障？**
   - **明文凭证零触网**：配置快照序列化器内置硬编码脱敏门禁（Sanitization Gate），默认彻底剥离所有明文 `apiKey`、`Authorization` 请求头与私密 Token；仅当用户显式勾选“跨端同步加密凭证保险箱”并确认独立主口令时，才以独立域分离密钥 `VAULT_KEK` 进行二次信封密封。
   - **身份与数据彻底解耦**：兼容 P0 锁定的 `SugentBrokerClaims`（覆盖国内 `wechat | feishu | dingtalk` 与海外 `apple | google | oidc`），服务端仅验证签名与 `sub` / `org_id` 配额，完全不接触端侧主口令（Passphrase）与明文图谱，天然规避跨境个人隐私与企业商业机密托管合规风险。
3. **本地数字主权与离线退路是什么？**
   - **断网照常运转**：无外网或未登录 `Sugent Auth Broker` 时，本地 Ollama / 局域网端点测速、基于本地 `SugentModelCatalog` 费率表的成本沙盘、`LocalBudgetLedger` 记账与本地 `SugentKnowledgeGraph` 读写全部正常运转，绝不弹出强制登录遮罩。
   - **反锁定退出机制**：加密信封采用开放 JSON + Base64URL 自描述格式（二进制布局对齐浏览器标准 [MDN Web Crypto API (`SubtleCrypto`)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)）。用户随时可将密文或解密快照导出至本地文件，或将同步端点指向自托管的 [WebDAV (RFC 4918)](https://www.rfc-editor.org/info/rfc4918/) / 私有 S3 存储桶，订阅到期后本地数据分毫无损。
4. **一人公司（OPC）运维杠杆有多高？**
   - **零状态计算 + 零出口带宽费存储**：由于加解密、密钥派生与 `KGNode` / `KGEdge` 的 CRDT 图谱合并全部在用户桌面端 Node.js 进程完成，云端无需维护图数据库或合并队列，仅需无状态边缘 Worker 签发 [Cloudflare R2 S3 兼容预签名 URL](https://developers.cloudflare.com/r2/api/s3/api/) 存取静态密文对象。单付费用户图谱快照压缩后通常低于 2 MB，基础设施边际成本极低，且即使存储桶遭意外泄漏，攻击者面对 [NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final) 认证密文也无法还原任何字节。

## 1. 密码学协议与现有代码契约对齐规范

### 1.1 权威密码学标准基线

| 密码学组件 | 采用算法与参数规格 | 权威规范依据 | 安全目标与工程约束 |
| :--- | :--- | :--- | :--- |
| **主密钥派生 (Passphrase KDF)** | `PBKDF2-HMAC-SHA256`，随机盐 `16 Bytes`，生产迭代 `600,000` 次，输出 `32 Bytes` 主密钥 `MK` | [RFC 8018 (PKCS #5 v2.1)](https://www.rfc-editor.org/info/rfc8018/)、[NIST SP 800-132](https://csrc.nist.gov/pubs/sp/800/132/final)、[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) | 抵御针对端侧同步口令的 GPU/ASIC 离线暴力猜解；单元测试支持显式注入最小合规测试迭代阈值以兼顾 CI 速度 |
| **子密钥域分离 (Subkey Expansion)** | `HKDF-SHA256`，按用途绑定独立 `info` 上下文标签，输出 `32 Bytes` 密钥加密密钥 `KEK` | [RFC 5869 (HKDF)](https://www.rfc-editor.org/info/rfc5869/)、[Node.js `crypto.hkdfSync`](https://nodejs.org/api/crypto.html) | 严格隔离图谱同步密钥（`sugent:e2ee:v1:kg-kek`）、可选凭证箱密钥（`sugent:e2ee:v1:vault-kek`）与指纹校验密钥（`sugent:e2ee:v1:key-check`） |
| **带认证信封加密 (AEAD Envelope)** | 随机生成单次 `32 Bytes` 数据密钥 `DEK`，`AES-256-GCM`、`96-bit (12 Bytes)` 随机 IV、强制 `128-bit (16 Bytes)` Auth Tag | [NIST SP 800-38D (GCM)](https://csrc.nist.gov/pubs/sp/800/38/d/final)、[MDN SubtleCrypto.encrypt()](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt) | 每次快照生成全新 `DEK` + 全新 `96-bit` IV，从根源消除多设备并发写入时的 GCM Nonce 碰撞风险；解密时强制 `authTagLength: 16` 阻断截断攻击 |
| **关联认证数据绑定 (AAD Binding)** | 将 `{ v, sub, orgId, payloadType, lamportClock }` 规范化序列化后注入 `cipher.setAAD()` | [NIST SP 800-38D Section 5.2.1.1](https://csrc.nist.gov/pubs/sp/800/38/d/final)、[Node.js `Cipheriv.setAAD`](https://nodejs.org/api/crypto.html) | 防止恶意存储节点跨用户替换密文（Cross-Tenant Replay）、跨类型混淆（Blob Type Confusion）或篡改外层 `lamportClock` 版本号诱导降级 |
| **身份与商业鉴权声明** | `SugentBrokerClaims` 标准字段（`iss`, `sub`, `aud`, `idp`, `plan`, `org_id`, `sync_endpoint`, `relay_endpoint`, `exp`, `iat`） | [RFC 7519 (JSON Web Token)](https://www.rfc-editor.org/info/rfc7519/) | 客户端执行本地时钟偏移容忍校验与 `plan` 门禁预检；同步网关仅凭 Bearer Token 校验桶路径配额，不持有任何解密材料 |

### 1.2 现有模块对接清单（零侵入契约）

- **`src/sugent/provider-registry.ts`**：读取已注册供应商与四角色绑定映射（`assessor | executor | computerUse | steward`），绝不修改上游核心运行时文件。
- **`src/sugent/model-catalog.ts`**：读取模型的百万 Token 输入单价（`inputCostPer1M`）、输出单价（`outputCostPer1M`）、缓存命中单价（`cachedInputCostPer1M`）、上下文窗口（`contextWindow`）及能力声明标签。
- **`LocalBudgetLedger`（预算账本接口）**：读取历史日均角色调用 Token 统计（若新装机无历史流水，则无缝回退至沙盘内置的三档 OPC 典型负载预设）以及月度预算上限告警阈值。
- **`src/sugent/knowledge-graph.ts`**：对接 `KGNode` 与 `KGEdge` 数据结构（含时效字段 `validFrom`、`validUntil`、`supersededAt`、`updatedAt`），通过纯函数适配器导入/导出图谱快照并执行确定性 CRDT 合并。

## 2. TDD 分步实施拆解（Task 1 ~ Task 6）

### Task 1: BYOK 多供应商并发健康探针与能力嗅探引擎

**Files:**
- Create: `src/sugent/byok-diagnostics.ts`
- Test: `test/sugent-byok-diagnostics.unit.test.ts`

**Step 1: Write the failing test**

创建 `test/sugent-byok-diagnostics.unit.test.ts`，覆盖八大供应商探针路由构造、TTFT 延迟采集、[OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) / [Tool Calling](https://developers.openai.com/api/docs/guides/tools) 能力嗅探与精准错误诊断码映射：

```ts
import { describe, expect, it } from "vitest";
import {
  runByokDiagnostics,
  type ByokProbeTarget,
  type FetchLike,
} from "../src/sugent/byok-diagnostics.js";

const HTTP_PROTO = ["http", "://"].join("");
const HTTPS_PROTO = ["https", "://"].join("");
const LOOPBACK_HOST = ["127", "0", "0", "1"].join(".");

describe("BYOK Connectivity & Capability Diagnostics", () => {
  it("probes multiple providers concurrently and captures TTFT + capabilities", async () => {
    const targets: ByokProbeTarget[] = [
      {
        providerId: "openai",
        role: "executor",
        baseUrl: `${HTTPS_PROTO}api.openai.com/v1`,
        apiKey: "tok-live-valid",
        modelId: "gpt-4.1",
        probeCapabilities: true,
      },
      {
        providerId: "ollama",
        role: "steward",
        baseUrl: `${HTTP_PROTO}${LOOPBACK_HOST}:11434`,
        modelId: "qwen2.5:7b",
        probeCapabilities: true,
      },
    ];

    const mockFetch: FetchLike = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes("api.openai.com/v1/responses")) {
        expect(init?.headers).toMatchObject({
          Authorization: "Bearer tok-live-valid",
        });
        return new Response(
          JSON.stringify({
            id: "resp_01",
            output: [{ type: "function_call", name: "ping_probe", arguments: "{}" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes(`${LOOPBACK_HOST}:11434/api/tags`)) {
        return new Response(
          JSON.stringify({
            models: [{ name: "qwen2.5:7b" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (urlStr.includes(`${LOOPBACK_HOST}:11434/v1/chat/completions`)) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  tool_calls: [{ id: "call_1", function: { name: "ping_probe", arguments: "{}" } }],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    };

    const report = await runByokDiagnostics(targets, {
      fetchImpl: mockFetch,
      timeoutMs: 3000,
      concurrency: 4,
    });

    expect(report.results).toHaveLength(2);
    const openaiRes = report.results.find((r) => r.providerId === "openai")!;
    expect(openaiRes.status).toBe("healthy");
    expect(openaiRes.diagnosticCode).toBe("OK");
    expect(openaiRes.ttftMs).toBeGreaterThanOrEqual(0);
    expect(openaiRes.capabilities.responsesApi).toBe(true);
    expect(openaiRes.capabilities.toolCalling).toBe(true);

    const ollamaRes = report.results.find((r) => r.providerId === "ollama")!;
    expect(ollamaRes.status).toBe("healthy");
    expect(ollamaRes.capabilities.toolCalling).toBe(true);
  });

  it("maps 401/403, 402, and network timeouts to deterministic diagnostic codes", async () => {
    const targets: ByokProbeTarget[] = [
      {
        providerId: "anthropic",
        role: "executor",
        baseUrl: `${HTTPS_PROTO}api.anthropic.com/v1`,
        apiKey: "tok-ant-expired",
        modelId: "claude-sonnet-4",
      },
      {
        providerId: "deepseek",
        role: "assessor",
        baseUrl: `${HTTPS_PROTO}api.deepseek.com/v1`,
        apiKey: "tok-ds-quota",
        modelId: "deepseek-chat",
      },
      {
        providerId: "custom-openai",
        role: "computerUse",
        baseUrl: `${HTTPS_PROTO}unreachable.local/v1`,
        apiKey: "tok-custom",
        modelId: "ui-tars-72b",
      },
    ];

    const mockFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("anthropic.com")) {
        return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
          status: 401,
        });
      }
      if (u.includes("deepseek.com")) {
        return new Response(
          JSON.stringify({ error: { code: "insufficient_quota", message: "Insufficient Balance" } }),
          { status: 402 },
        );
      }
      const timeoutErr = new Error("The operation was aborted due to timeout");
      timeoutErr.name = "TimeoutError";
      throw timeoutErr;
    };

    const report = await runByokDiagnostics(targets, {
      fetchImpl: mockFetch,
      timeoutMs: 500,
    });

    expect(report.results[0]?.diagnosticCode).toBe("AUTH_INVALID_KEY");
    expect(report.results[1]?.diagnosticCode).toBe("QUOTA_EXCEEDED");
    expect(report.results[2]?.diagnosticCode).toBe("TIMEOUT");
    expect(report.summary.unhealthyCount).toBe(3);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-byok-diagnostics.unit.test.ts`
Expected: FAIL with `Cannot find module '../src/sugent/byok-diagnostics.js'`

**Step 3: Write minimal implementation**

创建 `src/sugent/byok-diagnostics.ts`，实现支持多供应商协议头适配、并发池控制、首字节耗时（TTFT）与完整诊断码映射的探针核心：

```ts
import { performance } from "node:perf_hooks";

export type SugentProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "gemini"
  | "openrouter"
  | "ollama"
  | "cowork"
  | "custom-openai"
  | "gemini-web2api";

export type SugentAgentRole = "assessor" | "executor" | "computerUse" | "steward";

export type ByokDiagnosticCode =
  | "OK"
  | "MISSING_API_KEY"
  | "AUTH_INVALID_KEY"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "MODEL_NOT_FOUND"
  | "TLS_HANDSHAKE_FAILED"
  | "ENDPOINT_UNREACHABLE"
  | "TIMEOUT"
  | "UPSTREAM_SERVER_ERROR";

export interface ByokProbeTarget {
  providerId: SugentProviderId;
  role: SugentAgentRole;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  probeCapabilities?: boolean;
}

export interface ByokCapabilityMatrix {
  chatCompletions: boolean;
  toolCalling: boolean;
  responsesApi: boolean;
}

export interface ByokProbeResult {
  providerId: SugentProviderId;
  role: SugentAgentRole;
  modelId: string;
  endpointTested: string;
  status: "healthy" | "degraded" | "unhealthy";
  diagnosticCode: ByokDiagnosticCode;
  httpStatus: number | null;
  ttftMs: number | null;
  totalLatencyMs: number;
  capabilities: ByokCapabilityMatrix;
  remediationHint: string;
}

export interface ByokDiagnosticsReport {
  checkedAtIso: string;
  results: ByokProbeResult[];
  summary: {
    total: number;
    healthyCount: number;
    degradedCount: number;
    unhealthyCount: number;
    fastestExecutorMs: number | null;
  };
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ByokDiagnosticsOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  concurrency?: number;
}

const KEYLESS_ALLOWED_PROVIDERS = new Set<SugentProviderId>([
  "ollama",
  "custom-openai",
  "gemini-web2api",
]);

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function buildAuthHeaders(providerId: SugentProviderId, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (!apiKey) {
    return headers;
  }
  if (providerId === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (providerId === "gemini") {
    headers["x-goog-api-key"] = apiKey;
    return headers;
  }
  headers["Authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function classifyHttpFailure(status: number, bodyText: string): {
  code: ByokDiagnosticCode;
  hint: string;
} {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    return {
      code: "AUTH_INVALID_KEY",
      hint: "API Key 鉴权被拒绝，请核查密钥拼写、组织权限或是否已吊销。",
    };
  }
  if (
    status === 402 ||
    (status === 429 && (lower.includes("insufficient_quota") || lower.includes("balance")))
  ) {
    return {
      code: "QUOTA_EXCEEDED",
      hint: "供应商账户余额或月度配额已耗尽，请充值或切换备用供应商。",
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      hint: "触发供应商 RPM/TPM 速率限制，建议降低并发或为守门员分配独立渠道。",
    };
  }
  if (status === 404) {
    return {
      code: "MODEL_NOT_FOUND",
      hint: "目标模型 ID 或 API 路径不存在，请检查 baseUrl 是否遗漏 /v1 或模型是否已下线。",
    };
  }
  return {
    code: "UPSTREAM_SERVER_ERROR",
    hint: `上游网关返回 HTTP ${status}，请稍后重试或检查反代网关状态。`,
  };
}

function classifyNetworkError(err: unknown): {
  code: ByokDiagnosticCode;
  hint: string;
} {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  if (name === "TimeoutError" || name === "AbortError" || msg.includes("timeout")) {
    return {
      code: "TIMEOUT",
      hint: "连接或首字节响应超时，请检查本地代理规则、防火墙或更换低延迟接入点。",
    };
  }
  if (msg.includes("cert") || msg.includes("tls") || msg.includes("ssl")) {
    return {
      code: "TLS_HANDSHAKE_FAILED",
      hint: "TLS 证书校验失败，请检查自定义网关 HTTPS 证书链或企业抓包根证书配置。",
    };
  }
  return {
    code: "ENDPOINT_UNREACHABLE",
    hint: "无法建立 TCP/DNS 连接，请确认本地服务端口已启动且域名可解析。",
  };
}

async function probeSingleTarget(
  target: ByokProbeTarget,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<ByokProbeResult> {
  const base = normalizeBaseUrl(target.baseUrl);
  const startedAt = performance.now();

  if (!target.apiKey && !KEYLESS_ALLOWED_PROVIDERS.has(target.providerId)) {
    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: base,
      status: "unhealthy",
      diagnosticCode: "MISSING_API_KEY",
      httpStatus: null,
      ttftMs: null,
      totalLatencyMs: 0,
      capabilities: { chatCompletions: false, toolCalling: false, responsesApi: false },
      remediationHint: "尚未配置该云端供应商的 API Key。",
    };
  }

  const headers = buildAuthHeaders(target.providerId, target.apiKey);
  const capabilities: ByokCapabilityMatrix = {
    chatCompletions: false,
    toolCalling: false,
    responsesApi: false,
  };

  let primaryEndpoint = `${base}/models`;
  let primaryInit: RequestInit = {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (target.providerId === "ollama") {
    primaryEndpoint = `${base.replace(/\/v1$/, "")}/api/tags`;
  } else if (target.providerId === "anthropic") {
    primaryEndpoint = `${base}/messages`;
    primaryInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  } else if (target.providerId === "gemini") {
    primaryEndpoint = `${base}/models/${encodeURIComponent(target.modelId)}`;
  } else if (
    target.probeCapabilities &&
    (target.providerId === "openai" ||
      target.providerId === "cowork" ||
      target.providerId === "gemini-web2api")
  ) {
    primaryEndpoint = `${base}/responses`;
    primaryInit = {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: target.modelId,
        max_output_tokens: 16,
        input: "Invoke ping_probe if available.",
        tools: [
          {
            type: "function",
            name: "ping_probe",
            description: "Connectivity health probe",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  }

  try {
    const res = await fetchImpl(primaryEndpoint, primaryInit);
    const ttftMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const bodyText = await res.text();
    const totalLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;

    if (!res.ok) {
      const failure = classifyHttpFailure(res.status, bodyText);
      return {
        providerId: target.providerId,
        role: target.role,
        modelId: target.modelId,
        endpointTested: primaryEndpoint,
        status: "unhealthy",
        diagnosticCode: failure.code,
        httpStatus: res.status,
        ttftMs,
        totalLatencyMs,
        capabilities,
        remediationHint: failure.hint,
      };
    }

    capabilities.chatCompletions = true;
    if (primaryEndpoint.endsWith("/responses")) {
      capabilities.responsesApi = true;
      if (bodyText.includes("function_call") || bodyText.includes("ping_probe")) {
        capabilities.toolCalling = true;
      }
    } else if (target.probeCapabilities) {
      const toolEndpoint =
        target.providerId === "ollama"
          ? `${base.replace(/\/v1$/, "")}/v1/chat/completions`
          : `${base}/chat/completions`;
      try {
        const toolRes = await fetchImpl(toolEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: target.modelId,
            max_tokens: 16,
            messages: [{ role: "user", content: "Call ping_probe." }],
            tools: [
              {
                type: "function",
                function: {
                  name: "ping_probe",
                  parameters: { type: "object", properties: {} },
                },
              },
            ],
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (toolRes.ok) {
          const toolJson = await toolRes.text();
          capabilities.toolCalling =
            toolJson.includes("tool_calls") || toolJson.includes("ping_probe");
        }
      } catch {
        // Keep base probe healthy even if optional tool-calling probe is unsupported
      }
    }

    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: primaryEndpoint,
      status: ttftMs > 2500 ? "degraded" : "healthy",
      diagnosticCode: "OK",
      httpStatus: res.status,
      ttftMs,
      totalLatencyMs,
      capabilities,
      remediationHint:
        ttftMs > 2500
          ? "连通正常但首字节延迟偏高（超过 2.5s），建议将该节点调整为非实时后台角色。"
          : "连通性与鉴权状态正常。",
    };
  } catch (err) {
    const totalLatencyMs = Math.round((performance.now() - startedAt) * 100) / 100;
    const failure = classifyNetworkError(err);
    return {
      providerId: target.providerId,
      role: target.role,
      modelId: target.modelId,
      endpointTested: primaryEndpoint,
      status: "unhealthy",
      diagnosticCode: failure.code,
      httpStatus: null,
      ttftMs: null,
      totalLatencyMs,
      capabilities,
      remediationHint: failure.hint,
    };
  }
}

export async function runByokDiagnostics(
  targets: readonly ByokProbeTarget[],
  options: ByokDiagnosticsOptions = {},
): Promise<ByokDiagnosticsReport> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 6000;
  const concurrency = Math.max(1, options.concurrency ?? 4);

  const results: ByokProbeResult[] = new Array(targets.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < targets.length) {
      const index = cursor++;
      const target = targets[index];
      if (target) {
        results[index] = await probeSingleTarget(target, fetchImpl, timeoutMs);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(1, targets.length)) }, () => worker()),
  );

  const healthyCount = results.filter((r) => r.status === "healthy").length;
  const degradedCount = results.filter((r) => r.status === "degraded").length;
  const unhealthyCount = results.filter((r) => r.status === "unhealthy").length;
  const executorLatencies = results
    .filter((r) => r.role === "executor" && r.ttftMs !== null)
    .map((r) => r.ttftMs as number);

  return {
    checkedAtIso: new Date().toISOString(),
    results,
    summary: {
      total: results.length,
      healthyCount,
      degradedCount,
      unhealthyCount,
      fastestExecutorMs: executorLatencies.length > 0 ? Math.min(...executorLatencies) : null,
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-byok-diagnostics.unit.test.ts`
Expected: PASS (2 tests passed)

**Step 5: Commit**

```bash
git add src/sugent/byok-diagnostics.ts test/sugent-byok-diagnostics.unit.test.ts
git commit -m "feat(sugent): add concurrent BYOK connectivity and capability diagnostics"
```

### Task 2: 四角色月度美元成本沙盘模拟器（对接 `SugentModelCatalog` 与 `LocalBudgetLedger`）

**Files:**
- Modify: `src/sugent/byok-diagnostics.ts`
- Modify: `test/sugent-byok-diagnostics.unit.test.ts`

**Step 1: Write the failing test**

在 `test/sugent-byok-diagnostics.unit.test.ts` 追加四角色月度成本沙盘测试，验证“小模型守门（`assessor` / `steward`）+ 大模型攻坚（`executor` / `computerUse`）”相对于全量使用旗舰大模型的净节省额与预算超支预警：

```ts
import {
  simulateMonthlyRoleCosts,
  type CatalogPricingReader,
  type BudgetLedgerSnapshot,
} from "../src/sugent/byok-diagnostics.js";

describe("Four-Role Monthly Cost Sandbox Simulator", () => {
  const mockCatalog: CatalogPricingReader = {
    getModelPricing(modelId: string) {
      const table: Record<
        string,
        { inputCostPer1M: number; outputCostPer1M: number; cachedInputCostPer1M?: number }
      > = {
        "deepseek-chat": { inputCostPer1M: 0.27, outputCostPer1M: 1.1, cachedInputCostPer1M: 0.07 },
        "claude-sonnet-4": {
          inputCostPer1M: 3.0,
          outputCostPer1M: 15.0,
          cachedInputCostPer1M: 0.3,
        },
        "gpt-4.1-mini": { inputCostPer1M: 0.4, outputCostPer1M: 1.6, cachedInputCostPer1M: 0.1 },
        "qwen2.5:7b": { inputCostPer1M: 0, outputCostPer1M: 0 },
      };
      return table[modelId] ?? null;
    },
  };

  it("quantifies monthly USD savings of small-model gating vs all-flagship baseline", () => {
    const ledger: BudgetLedgerSnapshot = {
      monthlyCapUsd: 60,
      currentMonthSpentUsd: 12.5,
    };

    const simulation = simulateMonthlyRoleCosts({
      roleModels: {
        assessor: "deepseek-chat",
        executor: "claude-sonnet-4",
        computerUse: "gpt-4.1-mini",
        steward: "qwen2.5:7b",
      },
      preset: "opc-standard",
      activeDaysPerMonth: 26,
      promptCacheHitRatio: 0.4,
      catalog: mockCatalog,
      ledger,
    });

    expect(simulation.monthlyTotalUsd).toBeGreaterThan(0);
    expect(simulation.allFlagshipBaselineUsd).toBeGreaterThan(simulation.monthlyTotalUsd);
    expect(simulation.monthlySavingsUsd).toBeCloseTo(
      simulation.allFlagshipBaselineUsd - simulation.monthlyTotalUsd,
      4,
    );
    expect(simulation.savingsRatio).toBeGreaterThan(0.5);
    expect(simulation.roleBreakdown.steward.monthlyUsd).toBe(0);
    expect(simulation.budgetHealth.projectedExceedsCap).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-byok-diagnostics.unit.test.ts`
Expected: FAIL with `simulateMonthlyRoleCosts is not exported`

**Step 3: Write minimal implementation**

在 `src/sugent/byok-diagnostics.ts` 中追加与 `SugentModelCatalog` 和 `LocalBudgetLedger` 解耦对齐的契约接口与四角色成本沙盘计算器：

```ts
export interface ModelPricingSpec {
  inputCostPer1M: number;
  outputCostPer1M: number;
  cachedInputCostPer1M?: number;
  contextWindow?: number;
}

export interface CatalogPricingReader {
  getModelPricing(modelId: string): ModelPricingSpec | null;
}

export interface RoleDailyWorkload {
  dailyTasks: number;
  avgInputTokensPerTask: number;
  avgOutputTokensPerTask: number;
}

export type WorkloadPresetId = "solo-light" | "opc-standard" | "heavy-autopilot";

export interface BudgetLedgerSnapshot {
  monthlyCapUsd: number | null;
  currentMonthSpentUsd: number;
  observedDailyWorkload?: Partial<Record<SugentAgentRole, RoleDailyWorkload>>;
}

export interface CostSandboxInput {
  roleModels: Record<SugentAgentRole, string>;
  preset?: WorkloadPresetId;
  customWorkload?: Partial<Record<SugentAgentRole, RoleDailyWorkload>>;
  activeDaysPerMonth?: number;
  promptCacheHitRatio?: number;
  catalog: CatalogPricingReader;
  ledger?: BudgetLedgerSnapshot;
}

export interface RoleCostBreakdown {
  role: SugentAgentRole;
  modelId: string;
  monthlyInputTokens: number;
  monthlyOutputTokens: number;
  monthlyUsd: number;
}

export interface CostSandboxSimulation {
  activeDaysPerMonth: number;
  promptCacheHitRatio: number;
  roleBreakdown: Record<SugentAgentRole, RoleCostBreakdown>;
  monthlyTotalUsd: number;
  allFlagshipBaselineUsd: number;
  monthlySavingsUsd: number;
  savingsRatio: number;
  budgetHealth: {
    monthlyCapUsd: number | null;
    currentMonthSpentUsd: number;
    projectedExceedsCap: boolean;
    remainingRunwayUsd: number | null;
  };
}

export const WORKLOAD_PRESETS: Record<
  WorkloadPresetId,
  Record<SugentAgentRole, RoleDailyWorkload>
> = {
  "solo-light": {
    assessor: { dailyTasks: 60, avgInputTokensPerTask: 1500, avgOutputTokensPerTask: 250 },
    executor: { dailyTasks: 12, avgInputTokensPerTask: 12000, avgOutputTokensPerTask: 2200 },
    computerUse: { dailyTasks: 6, avgInputTokensPerTask: 8000, avgOutputTokensPerTask: 800 },
    steward: { dailyTasks: 48, avgInputTokensPerTask: 2000, avgOutputTokensPerTask: 300 },
  },
  "opc-standard": {
    assessor: { dailyTasks: 180, avgInputTokensPerTask: 2000, avgOutputTokensPerTask: 300 },
    executor: { dailyTasks: 35, avgInputTokensPerTask: 18000, avgOutputTokensPerTask: 3200 },
    computerUse: { dailyTasks: 20, avgInputTokensPerTask: 10000, avgOutputTokensPerTask: 1000 },
    steward: { dailyTasks: 120, avgInputTokensPerTask: 2500, avgOutputTokensPerTask: 400 },
  },
  "heavy-autopilot": {
    assessor: { dailyTasks: 500, avgInputTokensPerTask: 2400, avgOutputTokensPerTask: 350 },
    executor: { dailyTasks: 90, avgInputTokensPerTask: 24000, avgOutputTokensPerTask: 4500 },
    computerUse: { dailyTasks: 60, avgInputTokensPerTask: 14000, avgOutputTokensPerTask: 1200 },
    steward: { dailyTasks: 360, avgInputTokensPerTask: 3000, avgOutputTokensPerTask: 500 },
  },
};

function computeTokenCostUsd(
  pricing: ModelPricingSpec,
  inputTokens: number,
  outputTokens: number,
  cacheRatio: number,
): number {
  const clampedCache = Math.min(1, Math.max(0, cacheRatio));
  const cachedRate = pricing.cachedInputCostPer1M ?? pricing.inputCostPer1M;
  const uncachedInput = inputTokens * (1 - clampedCache);
  const cachedInput = inputTokens * clampedCache;

  const inputUsd =
    (uncachedInput / 1_000_000) * pricing.inputCostPer1M +
    (cachedInput / 1_000_000) * cachedRate;
  const outputUsd = (outputTokens / 1_000_000) * pricing.outputCostPer1M;
  return Math.round((inputUsd + outputUsd) * 10000) / 10000;
}

export function simulateMonthlyRoleCosts(input: CostSandboxInput): CostSandboxSimulation {
  const days = Math.max(1, Math.min(31, input.activeDaysPerMonth ?? 26));
  const cacheRatio = Math.min(0.95, Math.max(0, input.promptCacheHitRatio ?? 0.35));
  const basePreset = WORKLOAD_PRESETS[input.preset ?? "opc-standard"];
  const roles: SugentAgentRole[] = ["assessor", "executor", "computerUse", "steward"];

  const executorPricing = input.catalog.getModelPricing(input.roleModels.executor) ?? {
    inputCostPer1M: 3.0,
    outputCostPer1M: 15.0,
  };

  const roleBreakdown = {} as Record<SugentAgentRole, RoleCostBreakdown>;
  let monthlyTotalUsd = 0;
  let allFlagshipBaselineUsd = 0;

  for (const role of roles) {
    const workload =
      input.customWorkload?.[role] ??
      input.ledger?.observedDailyWorkload?.[role] ??
      basePreset[role];

    const monthlyInputTokens = workload.dailyTasks * workload.avgInputTokensPerTask * days;
    const monthlyOutputTokens = workload.dailyTasks * workload.avgOutputTokensPerTask * days;
    const modelId = input.roleModels[role];
    const pricing = input.catalog.getModelPricing(modelId) ?? {
      inputCostPer1M: 0,
      outputCostPer1M: 0,
    };

    const monthlyUsd = computeTokenCostUsd(
      pricing,
      monthlyInputTokens,
      monthlyOutputTokens,
      cacheRatio,
    );
    const flagshipUsd = computeTokenCostUsd(
      executorPricing,
      monthlyInputTokens,
      monthlyOutputTokens,
      cacheRatio,
    );

    roleBreakdown[role] = {
      role,
      modelId,
      monthlyInputTokens,
      monthlyOutputTokens,
      monthlyUsd,
    };
    monthlyTotalUsd += monthlyUsd;
    allFlagshipBaselineUsd += flagshipUsd;
  }

  monthlyTotalUsd = Math.round(monthlyTotalUsd * 100) / 100;
  allFlagshipBaselineUsd = Math.round(allFlagshipBaselineUsd * 100) / 100;
  const monthlySavingsUsd = Math.max(
    0,
    Math.round((allFlagshipBaselineUsd - monthlyTotalUsd) * 100) / 100,
  );
  const savingsRatio =
    allFlagshipBaselineUsd > 0
      ? Math.round((monthlySavingsUsd / allFlagshipBaselineUsd) * 10000) / 10000
      : 0;

  const monthlyCapUsd = input.ledger?.monthlyCapUsd ?? null;
  const currentMonthSpentUsd = input.ledger?.currentMonthSpentUsd ?? 0;

  return {
    activeDaysPerMonth: days,
    promptCacheHitRatio: cacheRatio,
    roleBreakdown,
    monthlyTotalUsd,
    allFlagshipBaselineUsd,
    monthlySavingsUsd,
    savingsRatio,
    budgetHealth: {
      monthlyCapUsd,
      currentMonthSpentUsd,
      projectedExceedsCap: monthlyCapUsd !== null ? monthlyTotalUsd > monthlyCapUsd : false,
      remainingRunwayUsd:
        monthlyCapUsd !== null
          ? Math.round((monthlyCapUsd - currentMonthSpentUsd) * 100) / 100
          : null,
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-byok-diagnostics.unit.test.ts`
Expected: PASS (3 tests passed)

**Step 5: Commit**

```bash
git add src/sugent/byok-diagnostics.ts test/sugent-byok-diagnostics.unit.test.ts
git commit -m "feat(sugent): add four-role monthly USD cost sandbox simulator"
```

### Task 3: 零知识端到端加密（E2EE）信封引擎与明文 API Key 防泄漏门禁

**Files:**
- Create: `src/sugent/e2ee-sync.ts`
- Test: `test/sugent-e2ee-sync.unit.test.ts`

**Step 1: Write the failing test**

创建 `test/sugent-e2ee-sync.unit.test.ts`，验证符合 [RFC 8018](https://www.rfc-editor.org/info/rfc8018/)、`HKDF-SHA256`（[RFC 5869](https://www.rfc-editor.org/info/rfc5869/)）与 `AES-256-GCM`（[NIST SP 800-38D](https://csrc.nist.gov/pubs/sp/800/38/d/final)）的双层信封加解密、AAD 防跨租户/防时钟篡改校验，以及明文 BYOK API Key 自动剥离与可选独立信封保护：

```ts
import { describe, expect, it } from "vitest";
import {
  deriveSyncKeyHierarchy,
  sealZeroKnowledgeEnvelope,
  openZeroKnowledgeEnvelope,
  sanitizeConfigSnapshotForSync,
} from "../src/sugent/e2ee-sync.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("Zero-Knowledge E2EE Envelope & Secret Sanitization", () => {
  const TEST_KDF_ITERATIONS = 100_000;

  it("seals and opens knowledge graph payload with PBKDF2 + HKDF + AES-256-GCM envelope", () => {
    const keys = deriveSyncKeyHierarchy({
      passphrase: "correct-horse-battery-staple-opc-2026",
      kdfIterations: TEST_KDF_ITERATIONS,
    });

    const payload = {
      nodes: [{ id: "n1", label: "ClientAlpha", validFrom: "2026-11-01T00:00:00Z" }],
      edges: [],
    };

    const envelope = sealZeroKnowledgeEnvelope({
      plaintextPayload: payload,
      keyHierarchy: keys,
      subjectSub: "usr_opc_001",
      payloadType: "knowledge-graph",
      lamportClock: 7,
      deviceId: "macbook-pro-m4",
    });

    const rawSerialized = JSON.stringify(envelope);
    expect(rawSerialized).not.toContain("ClientAlpha");

    const opened = openZeroKnowledgeEnvelope<typeof payload>({
      envelope,
      passphrase: "correct-horse-battery-staple-opc-2026",
      expectedSubjectSub: "usr_opc_001",
      expectedPayloadType: "knowledge-graph",
    });

    expect(opened.lamportClock).toBe(7);
    expect(opened.payload.nodes[0]?.label).toBe("ClientAlpha");
  });

  it("rejects tampered lamportClock or cross-tenant subject replay via GCM AAD tag failure", () => {
    const keys = deriveSyncKeyHierarchy({
      passphrase: "strong-passphrase-for-aad-test",
      kdfIterations: TEST_KDF_ITERATIONS,
    });

    const envelope = sealZeroKnowledgeEnvelope({
      plaintextPayload: { secret: "top-secret-deal" },
      keyHierarchy: keys,
      subjectSub: "usr_victim",
      payloadType: "knowledge-graph",
      lamportClock: 12,
      deviceId: "mac-studio",
    });

    const downgradedEnvelope = { ...envelope, lamportClock: 3 };
    expect(() =>
      openZeroKnowledgeEnvelope({
        envelope: downgradedEnvelope,
        passphrase: "strong-passphrase-for-aad-test",
        expectedSubjectSub: "usr_victim",
        expectedPayloadType: "knowledge-graph",
      }),
    ).toThrow(/authentication|integrity|AAD/i);

    expect(() =>
      openZeroKnowledgeEnvelope({
        envelope,
        passphrase: "strong-passphrase-for-aad-test",
        expectedSubjectSub: "usr_attacker",
        expectedPayloadType: "knowledge-graph",
      }),
    ).toThrow(/subject mismatch/i);
  });

  it("strips plaintext BYOK API keys by default and only seals them under VAULT_KEK when explicitly enabled", () => {
    const rawProviderSettings = {
      roles: { assessor: "deepseek:deepseek-chat", executor: "openai:gpt-4.1" },
      providers: {
        openai: { baseUrl: `${HTTPS_PROTO}api.openai.com/v1`, apiKey: "tok-proj-demo-123" },
        deepseek: { baseUrl: `${HTTPS_PROTO}api.deepseek.com/v1`, apiKey: "tok-ds-demo-456" },
      },
    };

    const sanitizedDefault = sanitizeConfigSnapshotForSync(rawProviderSettings, {
      includeEncryptedApiKeys: false,
    });

    expect(JSON.stringify(sanitizedDefault)).not.toContain("tok-proj-demo-123");
    expect(JSON.stringify(sanitizedDefault)).not.toContain("tok-ds-demo-456");
    expect(sanitizedDefault.encryptedCredentialsVault).toBeNull();

    const keys = deriveSyncKeyHierarchy({
      passphrase: "vault-master-passphrase",
      kdfIterations: TEST_KDF_ITERATIONS,
    });

    const sanitizedWithVault = sanitizeConfigSnapshotForSync(rawProviderSettings, {
      includeEncryptedApiKeys: true,
      keyHierarchy: keys,
      subjectSub: "usr_opc_001",
      lamportClock: 1,
      deviceId: "macbook-pro",
    });

    expect(JSON.stringify(sanitizedWithVault.publicConfig)).not.toContain("tok-proj-demo-123");
    expect(sanitizedWithVault.encryptedCredentialsVault?.payloadType).toBe("byok-vault");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-e2ee-sync.unit.test.ts`
Expected: FAIL with `Cannot find module '../src/sugent/e2ee-sync.js'`

**Step 3: Write minimal implementation**

创建 `src/sugent/e2ee-sync.ts` 第一部分，基于 [Node.js `node:crypto`](https://nodejs.org/api/crypto.html) 实现零第三方依赖的密钥层次派生、双层 AEAD 信封与 BYOK 凭证脱敏门禁：

```ts
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  pbkdf2Sync,
  randomBytes,
} from "node:crypto";

export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SyncPayloadType = "knowledge-graph" | "config-snapshot" | "byok-vault";

export interface SyncKeyHierarchy {
  kdfSaltB64: string;
  kdfIterations: number;
  keyFingerprint: string;
  kgKek: Buffer;
  vaultKek: Buffer;
}

export interface ZeroKnowledgeEnvelope {
  v: 1;
  alg: "PBKDF2-HKDF-SHA256+A256GCM";
  kdf: {
    saltB64: string;
    iterations: number;
  };
  keyFingerprint: string;
  sub: string;
  orgId?: string;
  deviceId: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
  createdAtIso: string;
  wrappedDek: {
    ivB64: string;
    ciphertextB64: string;
    tagB64: string;
  };
  payload: {
    ivB64: string;
    ciphertextB64: string;
    tagB64: string;
  };
}

export function deriveSyncKeyHierarchy(params: {
  passphrase: string;
  saltB64?: string;
  kdfIterations?: number;
}): SyncKeyHierarchy {
  const normalizedPassphrase = params.passphrase.normalize("NFKC").trim();
  if (normalizedPassphrase.length < 12) {
    throw new Error("E2EE sync passphrase must be at least 12 characters.");
  }

  const iterations = params.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS;
  if (iterations < MIN_PBKDF2_ITERATIONS) {
    throw new Error(`PBKDF2 iterations must be >= ${MIN_PBKDF2_ITERATIONS}.`);
  }

  const salt = params.saltB64
    ? Buffer.from(params.saltB64, "base64url")
    : randomBytes(SALT_BYTES);

  const masterKey = pbkdf2Sync(normalizedPassphrase, salt, iterations, KEY_BYTES, "sha256");

  const kgKek = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:kg-kek", "utf8"), KEY_BYTES),
  );
  const vaultKek = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:vault-kek", "utf8"), KEY_BYTES),
  );
  const fingerprintBytes = Buffer.from(
    hkdfSync("sha256", masterKey, salt, Buffer.from("sugent:e2ee:v1:key-check", "utf8"), 16),
  );
  masterKey.fill(0);

  return {
    kdfSaltB64: salt.toString("base64url"),
    kdfIterations: iterations,
    keyFingerprint: fingerprintBytes.toString("hex"),
    kgKek,
    vaultKek,
  };
}

function buildCanonicalAad(meta: {
  v: 1;
  sub: string;
  orgId?: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
}): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: meta.v,
      sub: meta.sub,
      orgId: meta.orgId ?? null,
      payloadType: meta.payloadType,
      lamportClock: meta.lamportClock,
    }),
    "utf8",
  );
}

function aes256GcmEncrypt(
  key: Buffer,
  plaintext: Buffer,
  aad: Buffer,
): { ivB64: string; ciphertextB64: string; tagB64: string } {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ivB64: iv.toString("base64url"),
    ciphertextB64: ciphertext.toString("base64url"),
    tagB64: tag.toString("base64url"),
  };
}

function aes256GcmDecrypt(
  key: Buffer,
  box: { ivB64: string; ciphertextB64: string; tagB64: string },
  aad: Buffer,
): Buffer {
  const iv = Buffer.from(box.ivB64, "base64url");
  const tag = Buffer.from(box.tagB64, "base64url");
  if (iv.byteLength !== GCM_IV_BYTES || tag.byteLength !== GCM_TAG_BYTES) {
    throw new Error("Invalid AES-256-GCM IV or authentication tag length.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const ciphertext = Buffer.from(box.ciphertextB64, "base64url");
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function sealZeroKnowledgeEnvelope<T>(params: {
  plaintextPayload: T;
  keyHierarchy: SyncKeyHierarchy;
  subjectSub: string;
  orgId?: string;
  payloadType: SyncPayloadType;
  lamportClock: number;
  deviceId: string;
}): ZeroKnowledgeEnvelope {
  const aad = buildCanonicalAad({
    v: 1,
    sub: params.subjectSub,
    orgId: params.orgId,
    payloadType: params.payloadType,
    lamportClock: params.lamportClock,
  });

  const dek = randomBytes(KEY_BYTES);
  const kek =
    params.payloadType === "byok-vault" ? params.keyHierarchy.vaultKek : params.keyHierarchy.kgKek;

  try {
    const wrappedDek = aes256GcmEncrypt(kek, dek, aad);
    const serialized = Buffer.from(JSON.stringify(params.plaintextPayload), "utf8");
    const encryptedPayload = aes256GcmEncrypt(dek, serialized, aad);

    return {
      v: 1,
      alg: "PBKDF2-HKDF-SHA256+A256GCM",
      kdf: {
        saltB64: params.keyHierarchy.kdfSaltB64,
        iterations: params.keyHierarchy.kdfIterations,
      },
      keyFingerprint: params.keyHierarchy.keyFingerprint,
      sub: params.subjectSub,
      orgId: params.orgId,
      deviceId: params.deviceId,
      payloadType: params.payloadType,
      lamportClock: params.lamportClock,
      createdAtIso: new Date().toISOString(),
      wrappedDek,
      payload: encryptedPayload,
    };
  } finally {
    dek.fill(0);
  }
}

export function openZeroKnowledgeEnvelope<T>(params: {
  envelope: ZeroKnowledgeEnvelope;
  passphrase: string;
  expectedSubjectSub: string;
  expectedPayloadType: SyncPayloadType;
}): { lamportClock: number; deviceId: string; payload: T } {
  const { envelope } = params;
  if (envelope.sub !== params.expectedSubjectSub) {
    throw new Error(
      `Envelope subject mismatch: expected ${params.expectedSubjectSub}, got ${envelope.sub}`,
    );
  }
  if (envelope.payloadType !== params.expectedPayloadType) {
    throw new Error(
      `Envelope payloadType mismatch: expected ${params.expectedPayloadType}, got ${envelope.payloadType}`,
    );
  }

  const keys = deriveSyncKeyHierarchy({
    passphrase: params.passphrase,
    saltB64: envelope.kdf.saltB64,
    kdfIterations: envelope.kdf.iterations,
  });

  if (keys.keyFingerprint !== envelope.keyFingerprint) {
    throw new Error("Invalid E2EE passphrase or mismatched key fingerprint.");
  }

  const aad = buildCanonicalAad({
    v: envelope.v,
    sub: envelope.sub,
    orgId: envelope.orgId,
    payloadType: envelope.payloadType,
    lamportClock: envelope.lamportClock,
  });

  const kek = envelope.payloadType === "byok-vault" ? keys.vaultKek : keys.kgKek;
  let dek: Buffer | null = null;
  try {
    dek = aes256GcmDecrypt(kek, envelope.wrappedDek, aad);
    const plaintextBytes = aes256GcmDecrypt(dek, envelope.payload, aad);
    return {
      lamportClock: envelope.lamportClock,
      deviceId: envelope.deviceId,
      payload: JSON.parse(plaintextBytes.toString("utf8")) as T,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`E2EE envelope AAD/authentication verification failed: ${detail}`);
  } finally {
    dek?.fill(0);
    keys.kgKek.fill(0);
    keys.vaultKek.fill(0);
  }
}

const SECRET_FIELD_PATTERN = /^(api[_-]?key|secret[_-]?key|access[_-]?token|authorization)$/i;

function stripSecretsRecursively(
  value: unknown,
  collectedSecrets: Record<string, string>,
  pathPrefix = "",
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, idx) =>
      stripSecretsRecursively(item, collectedSecrets, `${pathPrefix}[${idx}]`),
    );
  }
  if (value !== null && typeof value === "object") {
    const cleanObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = pathPrefix ? `${pathPrefix}.${k}` : k;
      if (SECRET_FIELD_PATTERN.test(k) && typeof v === "string" && v.length > 0) {
        collectedSecrets[nextPath] = v;
        continue;
      }
      cleanObj[k] = stripSecretsRecursively(v, collectedSecrets, nextPath);
    }
    return cleanObj;
  }
  return value;
}

export function sanitizeConfigSnapshotForSync<T extends Record<string, unknown>>(
  rawConfig: T,
  options: {
    includeEncryptedApiKeys: boolean;
    keyHierarchy?: SyncKeyHierarchy;
    subjectSub?: string;
    orgId?: string;
    lamportClock?: number;
    deviceId?: string;
  },
): {
  publicConfig: Record<string, unknown>;
  encryptedCredentialsVault: ZeroKnowledgeEnvelope | null;
} {
  const extractedSecrets: Record<string, string> = {};
  const publicConfig = stripSecretsRecursively(rawConfig, extractedSecrets) as Record<
    string,
    unknown
  >;

  if (!options.includeEncryptedApiKeys || Object.keys(extractedSecrets).length === 0) {
    return { publicConfig, encryptedCredentialsVault: null };
  }

  if (!options.keyHierarchy || !options.subjectSub || !options.deviceId) {
    throw new Error(
      "keyHierarchy, subjectSub, and deviceId are required when includeEncryptedApiKeys is true.",
    );
  }

  const encryptedCredentialsVault = sealZeroKnowledgeEnvelope({
    plaintextPayload: extractedSecrets,
    keyHierarchy: options.keyHierarchy,
    subjectSub: options.subjectSub,
    orgId: options.orgId,
    payloadType: "byok-vault",
    lamportClock: options.lamportClock ?? 1,
    deviceId: options.deviceId,
  });

  return { publicConfig, encryptedCredentialsVault };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-e2ee-sync.unit.test.ts`
Expected: PASS (3 tests passed)

**Step 5: Commit**

```bash
git add src/sugent/e2ee-sync.ts test/sugent-e2ee-sync.unit.test.ts
git commit -m "feat(sugent): implement PBKDF2-HKDF-AES256GCM zero-knowledge envelope and key sanitizer"
```

### Task 4: `SugentBrokerClaims` 套餐门禁、时效知识图谱 CRDT 合并与云端同步客户端

**Files:**
- Modify: `src/sugent/e2ee-sync.ts`
- Modify: `test/sugent-e2ee-sync.unit.test.ts`

**Step 1: Write the failing test**

在 `test/sugent-e2ee-sync.unit.test.ts` 追加针对 `SugentBrokerClaims` 商业套餐门禁、`KGNode` / `KGEdge` 时效图谱确定性 CRDT 合并（满足交换律、幂等律与 `supersededAt` 墓碑优先）以及端到端拉取-合并-推送闭环的单元测试：

```ts
import {
  assertBrokerSyncEntitlement,
  mergeKnowledgeGraphSnapshots,
  ZeroKnowledgeSyncClient,
  type SugentBrokerClaims,
  type SyncableKnowledgeGraphSnapshot,
} from "../src/sugent/e2ee-sync.js";

describe("SugentBrokerClaims Gate & Deterministic KnowledgeGraph CRDT Sync", () => {
  const nowSec = Math.floor(Date.now() / 1000);

  it("blocks free plan on managed broker sync while permitting pro and team plans", () => {
    const freeClaims: SugentBrokerClaims = {
      iss: `${HTTPS_PROTO}auth.sugent.app`,
      sub: "usr_free_01",
      aud: "sugent-desktop",
      idp: "wechat",
      plan: "free",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/v1/blobs`,
      exp: nowSec + 3600,
      iat: nowSec - 60,
    };

    expect(() => assertBrokerSyncEntitlement(freeClaims, nowSec)).toThrow(
      /SYNC_PLAN_UPGRADE_REQUIRED/,
    );

    const proClaims: SugentBrokerClaims = {
      ...freeClaims,
      sub: "usr_pro_01",
      plan: "pro",
    };
    expect(() => assertBrokerSyncEntitlement(proClaims, nowSec)).not.toThrow();
  });

  it("converges concurrent KGNode/KGEdge edits commutatively and honors supersededAt tombstones", () => {
    const deviceASnapshot: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 10,
      deviceId: "device-a",
      nodes: [
        {
          id: "node-pricing",
          type: "fact",
          label: "SaaS Tier Basic",
          properties: { price: 29 },
          validFrom: "2026-01-01T00:00:00Z",
          supersededAt: "2026-11-10T00:00:00Z",
          updatedAt: "2026-11-10T00:00:00Z",
          lamportClock: 10,
        },
        {
          id: "node-pricing-v2",
          type: "fact",
          label: "SaaS Tier Pro",
          properties: { price: 39 },
          validFrom: "2026-11-10T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-10T00:00:00Z",
          lamportClock: 10,
        },
      ],
      edges: [],
    };

    const deviceBSnapshot: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 9,
      deviceId: "device-b",
      nodes: [
        {
          id: "node-pricing",
          type: "fact",
          label: "SaaS Tier Basic",
          properties: { price: 29 },
          validFrom: "2026-01-01T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-09T00:00:00Z",
          lamportClock: 9,
        },
        {
          id: "node-lead",
          type: "contact",
          label: "Acme Corp CTO",
          properties: {},
          validFrom: "2026-11-11T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-11T00:00:00Z",
          lamportClock: 9,
        },
      ],
      edges: [
        {
          id: "edge-1",
          source: "node-lead",
          target: "node-pricing-v2",
          relation: "SUBSCRIBED_TO",
          validFrom: "2026-11-11T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-11T00:00:00Z",
          lamportClock: 9,
        },
      ],
    };

    const ab = mergeKnowledgeGraphSnapshots(deviceASnapshot, deviceBSnapshot, "device-a");
    const ba = mergeKnowledgeGraphSnapshots(deviceBSnapshot, deviceASnapshot, "device-a");

    expect(ab.nodes).toEqual(ba.nodes);
    expect(ab.edges).toEqual(ba.edges);
    expect(ab.lamportClock).toBe(11);

    const oldFact = ab.nodes.find((n) => n.id === "node-pricing")!;
    expect(oldFact.supersededAt).toBe("2026-11-10T00:00:00Z");
    expect(ab.nodes).toHaveLength(3);
    expect(ab.edges).toHaveLength(1);
  });

  it("pushes and pulls encrypted blobs over zero-knowledge storage without exposing plaintext", async () => {
    let cloudStoredBody = "";
    const mockStorageFetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      if (init?.method === "PUT") {
        cloudStoredBody = String(init.body);
        return new Response(null, { status: 200, headers: { etag: '"v1"' } });
      }
      if (!cloudStoredBody) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(cloudStoredBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const claims: SugentBrokerClaims = {
      iss: `${HTTPS_PROTO}auth.sugent.app`,
      sub: "usr_pro_88",
      aud: "sugent-desktop",
      idp: "google",
      plan: "pro",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/r2`,
      exp: nowSec + 3600,
      iat: nowSec - 10,
    };

    const client = new ZeroKnowledgeSyncClient({
      fetchImpl: mockStorageFetch,
      kdfIterations: 100_000,
    });

    const localSnapshot: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 4,
      deviceId: "mac-mini",
      nodes: [
        {
          id: "n-secret-customer",
          type: "entity",
          label: "Confidential Merger Target",
          properties: { valuationM: 42 },
          validFrom: "2026-11-12T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-12T00:00:00Z",
          lamportClock: 4,
        },
      ],
      edges: [],
    };

    await client.pushKnowledgeGraph({
      claims,
      bearerToken: "mock-broker-bearer-token",
      passphrase: "opc-sovereign-vault-key",
      snapshot: localSnapshot,
    });

    expect(cloudStoredBody).not.toContain("Confidential Merger Target");

    const synced = await client.pullAndMergeKnowledgeGraph({
      claims,
      bearerToken: "mock-broker-bearer-token",
      passphrase: "opc-sovereign-vault-key",
      localSnapshot: {
        lamportClock: 2,
        deviceId: "macbook-air",
        nodes: [],
        edges: [],
      },
    });

    expect(synced.mergedSnapshot.nodes[0]?.label).toBe("Confidential Merger Target");
    expect(synced.mergedSnapshot.lamportClock).toBe(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-e2ee-sync.unit.test.ts`
Expected: FAIL with `assertBrokerSyncEntitlement is not exported`

**Step 3: Write minimal implementation**

在 `src/sugent/e2ee-sync.ts` 追加直接导入自 `./auth-broker-contract.js`（或结构兼容）的 `SugentBrokerClaims`、订阅权限校验器、`KGNode` / `KGEdge` 确定性 CRDT 合并算法与兼容 [Cloudflare R2](https://developers.cloudflare.com/r2/api/s3/api/) / [WebDAV (RFC 4918)](https://www.rfc-editor.org/info/rfc4918/) HTTP `GET`/`PUT` 语义的 `ZeroKnowledgeSyncClient`：

```ts
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

export interface SyncableKGNode {
  id: string;
  type: string;
  label: string;
  properties: Record<string, unknown>;
  validFrom: string;
  validUntil?: string | null;
  supersededAt: string | null;
  updatedAt: string;
  lamportClock: number;
}

export interface SyncableKGEdge {
  id: string;
  source: string;
  target: string;
  relation: string;
  weight?: number;
  validFrom: string;
  validUntil?: string | null;
  supersededAt: string | null;
  updatedAt: string;
  lamportClock: number;
}

export interface SyncableKnowledgeGraphSnapshot {
  lamportClock: number;
  deviceId: string;
  nodes: SyncableKGNode[];
  edges: SyncableKGEdge[];
}

export function assertBrokerSyncEntitlement(
  claims: SugentBrokerClaims,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
  clockSkewToleranceSeconds = 60,
): void {
  if (claims.exp + clockSkewToleranceSeconds <= nowEpochSeconds) {
    throw new Error("SYNC_AUTH_TOKEN_EXPIRED: Sugent Broker token has expired.");
  }
  if (claims.plan !== "pro" && claims.plan !== "team") {
    throw new Error(
      "SYNC_PLAN_UPGRADE_REQUIRED: Zero-knowledge cloud sync requires a Sugent Pro or Team subscription (or configure a local/self-hosted export).",
    );
  }
  if (!claims.sync_endpoint) {
    throw new Error("SYNC_ENDPOINT_MISSING: Broker claims did not include a sync_endpoint.");
  }
}

function pickWinningRecord<
  T extends {
    id: string;
    lamportClock: number;
    updatedAt: string;
    supersededAt: string | null;
  },
>(a: T, b: T): T {
  const mergedSupersededAt =
    a.supersededAt && b.supersededAt
      ? a.supersededAt <= b.supersededAt
        ? a.supersededAt
        : b.supersededAt
      : (a.supersededAt ?? b.supersededAt);

  let winner: T;
  if (a.lamportClock !== b.lamportClock) {
    winner = a.lamportClock > b.lamportClock ? a : b;
  } else if (a.updatedAt !== b.updatedAt) {
    winner = a.updatedAt > b.updatedAt ? a : b;
  } else {
    const hashA = JSON.stringify(a);
    const hashB = JSON.stringify(b);
    winner = hashA >= hashB ? a : b;
  }

  return {
    ...winner,
    supersededAt: mergedSupersededAt,
  };
}

export function mergeKnowledgeGraphSnapshots(
  local: SyncableKnowledgeGraphSnapshot,
  remote: SyncableKnowledgeGraphSnapshot,
  mergingDeviceId: string,
): SyncableKnowledgeGraphSnapshot {
  const nextLamport = Math.max(local.lamportClock, remote.lamportClock) + 1;

  const nodeMap = new Map<string, SyncableKGNode>();
  for (const node of local.nodes) {
    nodeMap.set(node.id, node);
  }
  for (const rNode of remote.nodes) {
    const existing = nodeMap.get(rNode.id);
    nodeMap.set(rNode.id, existing ? pickWinningRecord(existing, rNode) : rNode);
  }

  const edgeMap = new Map<string, SyncableKGEdge>();
  for (const edge of local.edges) {
    edgeMap.set(edge.id, edge);
  }
  for (const rEdge of remote.edges) {
    const existing = edgeMap.get(rEdge.id);
    edgeMap.set(rEdge.id, existing ? pickWinningRecord(existing, rEdge) : rEdge);
  }

  const nodes = Array.from(nodeMap.values()).sort((x, y) => x.id.localeCompare(y.id));
  const edges = Array.from(edgeMap.values()).sort((x, y) => x.id.localeCompare(y.id));

  return {
    lamportClock: nextLamport,
    deviceId: mergingDeviceId,
    nodes,
    edges,
  };
}

export interface ZeroKnowledgeSyncClientOptions {
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  kdfIterations?: number;
}

export class ZeroKnowledgeSyncClient {
  private readonly fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly kdfIterations: number;

  constructor(options: ZeroKnowledgeSyncClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.kdfIterations = options.kdfIterations ?? DEFAULT_PBKDF2_ITERATIONS;
  }

  private buildObjectUrl(claims: SugentBrokerClaims, objectName: string): string {
    const base = (claims.sync_endpoint ?? "").replace(/\/+$/, "");
    const namespace =
      claims.plan === "team" && claims.org_id
        ? `orgs/${encodeURIComponent(claims.org_id)}`
        : `users/${encodeURIComponent(claims.sub)}`;
    return `${base}/${namespace}/${objectName}`;
  }

  async pushKnowledgeGraph(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
    snapshot: SyncableKnowledgeGraphSnapshot;
  }): Promise<{ uploadedAtIso: string; keyFingerprint: string; lamportClock: number }> {
    assertBrokerSyncEntitlement(params.claims);

    const keyHierarchy = deriveSyncKeyHierarchy({
      passphrase: params.passphrase,
      kdfIterations: this.kdfIterations,
    });

    try {
      const envelope = sealZeroKnowledgeEnvelope({
        plaintextPayload: params.snapshot,
        keyHierarchy,
        subjectSub: params.claims.sub,
        orgId: params.claims.org_id,
        payloadType: "knowledge-graph",
        lamportClock: params.snapshot.lamportClock,
        deviceId: params.snapshot.deviceId,
      });

      const targetUrl = this.buildObjectUrl(params.claims, "knowledge-graph.e2ee.json");
      const res = await this.fetchImpl(targetUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${params.bearerToken}`,
          "x-sugent-lamport-clock": String(envelope.lamportClock),
        },
        body: JSON.stringify(envelope),
      });

      if (!res.ok) {
        throw new Error(`Zero-knowledge blob upload failed with HTTP ${res.status}`);
      }

      return {
        uploadedAtIso: envelope.createdAtIso,
        keyFingerprint: envelope.keyFingerprint,
        lamportClock: envelope.lamportClock,
      };
    } finally {
      keyHierarchy.kgKek.fill(0);
      keyHierarchy.vaultKek.fill(0);
    }
  }

  async pullAndMergeKnowledgeGraph(params: {
    claims: SugentBrokerClaims;
    bearerToken: string;
    passphrase: string;
    localSnapshot: SyncableKnowledgeGraphSnapshot;
  }): Promise<{
    remoteFound: boolean;
    mergedSnapshot: SyncableKnowledgeGraphSnapshot;
  }> {
    assertBrokerSyncEntitlement(params.claims);

    const targetUrl = this.buildObjectUrl(params.claims, "knowledge-graph.e2ee.json");
    const res = await this.fetchImpl(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${params.bearerToken}`,
      },
    });

    if (res.status === 404) {
      return {
        remoteFound: false,
        mergedSnapshot: params.localSnapshot,
      };
    }
    if (!res.ok) {
      throw new Error(`Zero-knowledge blob download failed with HTTP ${res.status}`);
    }

    const envelope = (await res.json()) as ZeroKnowledgeEnvelope;
    const opened = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope,
      passphrase: params.passphrase,
      expectedSubjectSub: params.claims.sub,
      expectedPayloadType: "knowledge-graph",
    });

    const mergedSnapshot = mergeKnowledgeGraphSnapshots(
      params.localSnapshot,
      opened.payload,
      params.localSnapshot.deviceId,
    );

    return {
      remoteFound: true,
      mergedSnapshot,
    };
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-e2ee-sync.unit.test.ts`
Expected: PASS (6 tests passed)

**Step 5: Commit**

```bash
git add src/sugent/e2ee-sync.ts test/sugent-e2ee-sync.unit.test.ts
git commit -m "feat(sugent): add SugentBrokerClaims entitlement gate and KG CRDT sync client"
```

### Task 5: 本地桌面网关 REST 路由控制器挂载

**Files:**
- Create: `src/sugent/p2-gateway-routes.ts`
- Modify: `src/web/server.ts`（增量挂载 4 条 `/api/sugent/*` P2 端点）
- Test: `test/sugent-p2-gateway-routes.unit.test.ts`

**Step 1: Write the failing test**

创建 `test/sugent-p2-gateway-routes.unit.test.ts`，验证免登录下 `/api/sugent/byok/diagnostics` 与 `/api/sugent/byok/cost-sandbox` 可直接访问，且 `/api/sugent/sync/push` 对 `free` 套餐返回结构化 `403 SYNC_PLAN_UPGRADE_REQUIRED` 错误码且绝不在响应中回显口令或 API Key：

```ts
import { describe, expect, it } from "vitest";
import { createP2GatewayHandlers } from "../src/sugent/p2-gateway-routes.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("P2 Gateway REST Handlers", () => {
  it("serves BYOK cost-sandbox without any Broker auth token", async () => {
    const handlers = createP2GatewayHandlers({
      catalog: {
        getModelPricing: (id) =>
          id === "deepseek-chat"
            ? { inputCostPer1M: 0.27, outputCostPer1M: 1.1 }
            : { inputCostPer1M: 3.0, outputCostPer1M: 15.0 },
      },
      getKnowledgeGraphSnapshot: async () => ({
        lamportClock: 1,
        deviceId: "local-mac",
        nodes: [],
        edges: [],
      }),
      applyKnowledgeGraphSnapshot: async () => {},
    });

    const res = await handlers.handleCostSandbox({
      roleModels: {
        assessor: "deepseek-chat",
        executor: "claude-sonnet-4",
        computerUse: "deepseek-chat",
        steward: "deepseek-chat",
      },
      preset: "solo-light",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data?.monthlySavingsUsd).toBeGreaterThan(0);
  });

  it("returns 403 upgrade prompt when free-tier user invokes cloud sync push", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const handlers = createP2GatewayHandlers({
      catalog: { getModelPricing: () => null },
      getKnowledgeGraphSnapshot: async () => ({
        lamportClock: 1,
        deviceId: "local-mac",
        nodes: [],
        edges: [],
      }),
      applyKnowledgeGraphSnapshot: async () => {},
    });

    const res = await handlers.handleSyncPush({
      claims: {
        iss: `${HTTPS_PROTO}auth.sugent.app`,
        sub: "usr_free",
        aud: "sugent-desktop",
        idp: "feishu",
        plan: "free",
        sync_endpoint: `${HTTPS_PROTO}sync.sugent.app/r2`,
        exp: nowSec + 3600,
        iat: nowSec,
      },
      bearerToken: "tok_free",
      passphrase: "my-ultra-secret-passphrase",
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.errorCode).toBe("SYNC_PLAN_UPGRADE_REQUIRED");
    expect(JSON.stringify(res.body)).not.toContain("my-ultra-secret-passphrase");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-p2-gateway-routes.unit.test.ts`
Expected: FAIL with `Cannot find module '../src/sugent/p2-gateway-routes.js'`

**Step 3: Write minimal implementation**

创建 `src/sugent/p2-gateway-routes.ts`：

```ts
import {
  runByokDiagnostics,
  simulateMonthlyRoleCosts,
  type BudgetLedgerSnapshot,
  type ByokProbeTarget,
  type CatalogPricingReader,
  type CostSandboxSimulation,
  type FetchLike,
  type SugentAgentRole,
  type WorkloadPresetId,
} from "./byok-diagnostics.js";
import {
  ZeroKnowledgeSyncClient,
  type SugentBrokerClaims,
  type SyncableKnowledgeGraphSnapshot,
} from "./e2ee-sync.js";

export interface GatewayJsonResponse<T> {
  statusCode: number;
  body: {
    ok: boolean;
    data?: T;
    errorCode?: string;
    message?: string;
  };
}

export interface P2GatewayDependencies {
  catalog: CatalogPricingReader;
  getBudgetLedger?: () => BudgetLedgerSnapshot | undefined;
  getKnowledgeGraphSnapshot: () => Promise<SyncableKnowledgeGraphSnapshot>;
  applyKnowledgeGraphSnapshot: (merged: SyncableKnowledgeGraphSnapshot) => Promise<void>;
  fetchImpl?: FetchLike;
  kdfIterations?: number;
}

export function createP2GatewayHandlers(deps: P2GatewayDependencies) {
  const syncClient = new ZeroKnowledgeSyncClient({
    fetchImpl: deps.fetchImpl,
    kdfIterations: deps.kdfIterations,
  });

  return {
    async handleByokDiagnostics(req: {
      targets: ByokProbeTarget[];
      timeoutMs?: number;
    }): Promise<GatewayJsonResponse<Awaited<ReturnType<typeof runByokDiagnostics>>>> {
      const report = await runByokDiagnostics(req.targets, {
        fetchImpl: deps.fetchImpl,
        timeoutMs: req.timeoutMs,
      });
      return { statusCode: 200, body: { ok: true, data: report } };
    },

    async handleCostSandbox(req: {
      roleModels: Record<SugentAgentRole, string>;
      preset?: WorkloadPresetId;
      activeDaysPerMonth?: number;
      promptCacheHitRatio?: number;
    }): Promise<GatewayJsonResponse<CostSandboxSimulation>> {
      const simulation = simulateMonthlyRoleCosts({
        roleModels: req.roleModels,
        preset: req.preset,
        activeDaysPerMonth: req.activeDaysPerMonth,
        promptCacheHitRatio: req.promptCacheHitRatio,
        catalog: deps.catalog,
        ledger: deps.getBudgetLedger?.(),
      });
      return { statusCode: 200, body: { ok: true, data: simulation } };
    },

    async handleSyncPush(req: {
      claims: SugentBrokerClaims;
      bearerToken: string;
      passphrase: string;
    }): Promise<
      GatewayJsonResponse<{ uploadedAtIso: string; keyFingerprint: string; lamportClock: number }>
    > {
      try {
        const snapshot = await deps.getKnowledgeGraphSnapshot();
        const result = await syncClient.pushKnowledgeGraph({
          claims: req.claims,
          bearerToken: req.bearerToken,
          passphrase: req.passphrase,
          snapshot,
        });
        return { statusCode: 200, body: { ok: true, data: result } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown sync error";
        if (msg.includes("SYNC_PLAN_UPGRADE_REQUIRED")) {
          return {
            statusCode: 403,
            body: {
              ok: false,
              errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
              message: "零知识多端图谱云同步为 Pro / Team 专属权益，本地图谱仍可免费使用。",
            },
          };
        }
        if (msg.includes("SYNC_AUTH_TOKEN_EXPIRED")) {
          return {
            statusCode: 401,
            body: { ok: false, errorCode: "SYNC_AUTH_TOKEN_EXPIRED", message: "登录凭证已过期。" },
          };
        }
        return {
          statusCode: 400,
          body: { ok: false, errorCode: "E2EE_SYNC_FAILED", message: "端侧加密或云端同步失败。" },
        };
      }
    },

    async handleSyncPull(req: {
      claims: SugentBrokerClaims;
      bearerToken: string;
      passphrase: string;
    }): Promise<
      GatewayJsonResponse<{ remoteFound: boolean; lamportClock: number; nodeCount: number }>
    > {
      try {
        const localSnapshot = await deps.getKnowledgeGraphSnapshot();
        const { remoteFound, mergedSnapshot } = await syncClient.pullAndMergeKnowledgeGraph({
          claims: req.claims,
          bearerToken: req.bearerToken,
          passphrase: req.passphrase,
          localSnapshot,
        });
        if (remoteFound) {
          await deps.applyKnowledgeGraphSnapshot(mergedSnapshot);
        }
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              remoteFound,
              lamportClock: mergedSnapshot.lamportClock,
              nodeCount: mergedSnapshot.nodes.length,
            },
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("SYNC_PLAN_UPGRADE_REQUIRED")) {
          return {
            statusCode: 403,
            body: {
              ok: false,
              errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
              message: "升级 Pro / Team 即可解锁跨设备零知识图谱合并。",
            },
          };
        }
        return {
          statusCode: 400,
          body: {
            ok: false,
            errorCode: "E2EE_DECRYPT_OR_MERGE_FAILED",
            message: "无法解密云端图谱快照，请确认端到端同步主口令正确。",
          },
        };
      }
    },
  };
}
```

接着在 `src/web/server.ts` 中将上述 4 个处理器增量绑定至对应路径：
- `POST /api/sugent/byok/diagnostics` → `handlers.handleByokDiagnostics`
- `POST /api/sugent/byok/cost-sandbox` → `handlers.handleCostSandbox`
- `POST /api/sugent/sync/push` → `handlers.handleSyncPush`
- `POST /api/sugent/sync/pull` → `handlers.handleSyncPull`

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-p2-gateway-routes.unit.test.ts`
Expected: PASS (2 tests passed)

**Step 5: Commit**

```bash
git add src/sugent/p2-gateway-routes.ts test/sugent-p2-gateway-routes.unit.test.ts
git commit -m "feat(sugent): mount P2 BYOK diagnostics and E2EE sync gateway handlers"
```

### Task 6: Preact + htm 设置工作台面板挂载（测速雷达 + 成本沙盘 + 零知识同步保险箱）

**Files:**
- Create: `src/sugent/byok-sync-viewmodel.ts`
- Modify: `ui/components/provider-settings.js`（复用项目 `Preact + htm` 前端技术栈挂载测速雷达与同步卡片）
- Test: `test/sugent-byok-sync-panel.unit.test.ts`

**Step 1: Write the failing test**

创建 `test/sugent-byok-sync-panel.unit.test.ts`，验证视图模型在免登录态正确展示四角色月度成本对比，并对 Free 用户展示非侵入式零知识 Pro 升级锚点与“明文 API Key 永不离机”安全徽章：

```ts
import { describe, expect, it } from "vitest";
import { buildByokSyncViewModel } from "../src/sugent/byok-sync-viewmodel.js";
import type { CostSandboxSimulation } from "../src/sugent/byok-diagnostics.js";

describe("ByokAndSyncPanel ViewModel & Sovereignty UX", () => {
  const sampleSimulation: CostSandboxSimulation = {
    activeDaysPerMonth: 26,
    promptCacheHitRatio: 0.4,
    roleBreakdown: {
      assessor: {
        role: "assessor",
        modelId: "deepseek-chat",
        monthlyInputTokens: 9_360_000,
        monthlyOutputTokens: 1_404_000,
        monthlyUsd: 3.31,
      },
      executor: {
        role: "executor",
        modelId: "claude-sonnet-4",
        monthlyInputTokens: 16_380_000,
        monthlyOutputTokens: 2_912_000,
        monthlyUsd: 75.15,
      },
      computerUse: {
        role: "computerUse",
        modelId: "gpt-4.1-mini",
        monthlyInputTokens: 5_200_000,
        monthlyOutputTokens: 520_000,
        monthlyUsd: 2.18,
      },
      steward: {
        role: "steward",
        modelId: "qwen2.5:7b",
        monthlyInputTokens: 7_800_000,
        monthlyOutputTokens: 1_248_000,
        monthlyUsd: 0,
      },
    },
    monthlyTotalUsd: 80.64,
    allFlagshipBaselineUsd: 198.4,
    monthlySavingsUsd: 117.76,
    savingsRatio: 0.5935,
    budgetHealth: {
      monthlyCapUsd: 100,
      currentMonthSpentUsd: 22.1,
      projectedExceedsCap: false,
      remainingRunwayUsd: 77.9,
    },
  };

  it("formats savings headline without login and shows Pro upgrade callout for unauthenticated or free users", () => {
    const vm = buildByokSyncViewModel({
      diagnostics: null,
      simulation: sampleSimulation,
      claims: null,
    });

    expect(vm.localReadyBadge).toBe("本地免登录可用");
    expect(vm.savingsHeadline).toContain("117.76");
    expect(vm.savingsHeadline).toContain("59.4%");
    expect(vm.syncEntitlementState).toBe("upgrade-required");
    expect(vm.zeroKnowledgeGuarantee).toContain("AES-256-GCM");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-byok-sync-panel.unit.test.ts`
Expected: FAIL with `Cannot find module '../src/sugent/byok-sync-viewmodel.js'`

**Step 3: Write minimal implementation**

创建 `src/sugent/byok-sync-viewmodel.ts` 并在 `ui/components/provider-settings.js` 中使用项目标准 `Preact + htm` 渲染测速表格、三档工作负载切换按钮与零知识同步口令输入框：

```ts
import type {
  ByokDiagnosticsReport,
  CostSandboxSimulation,
} from "./byok-diagnostics.js";
import type { SugentBrokerClaims } from "./e2ee-sync.js";

export interface ByokSyncViewModel {
  localReadyBadge: string;
  savingsHeadline: string;
  syncEntitlementState: "unlocked-pro" | "unlocked-team" | "upgrade-required";
  zeroKnowledgeGuarantee: string;
}

export function buildByokSyncViewModel(params: {
  diagnostics: ByokDiagnosticsReport | null;
  simulation: CostSandboxSimulation | null;
  claims: SugentBrokerClaims | null;
}): ByokSyncViewModel {
  const sim = params.simulation;
  const pct = sim ? (sim.savingsRatio * 100).toFixed(1) : "0.0";
  const saved = sim ? sim.monthlySavingsUsd.toFixed(2) : "0.00";

  let syncEntitlementState: ByokSyncViewModel["syncEntitlementState"] = "upgrade-required";
  if (params.claims?.plan === "pro") {
    syncEntitlementState = "unlocked-pro";
  } else if (params.claims?.plan === "team") {
    syncEntitlementState = "unlocked-team";
  }

  return {
    localReadyBadge: "本地免登录可用",
    savingsHeadline: sim
      ? `小模型守门 + 大模型攻坚预计每月净省 ${saved} USD（降幅 ${pct}%）`
      : "选择负载预设即可模拟四角色月度 API 账单",
    syncEntitlementState,
    zeroKnowledgeGuarantee:
      "端侧 PBKDF2 + HKDF + AES-256-GCM 零知识密封：明文 BYOK API Key 默认绝不离机，云端仅存密文 Blob。",
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-byok-sync-panel.unit.test.ts`
Expected: PASS (1 test passed)

**Step 5: Commit**

```bash
git add src/sugent/byok-sync-viewmodel.ts ui/components/provider-settings.js test/sugent-byok-sync-panel.unit.test.ts
git commit -m "feat(sugent-ui): add BYOK diagnostics radar, cost sandbox, and E2EE sync viewmodel"
```

## 3. 全局验收门禁与安全回归清单

完成全部 6 个 Task 后，依次执行以下整体验收命令，确保零侵入约束、类型安全与密码学边界全部达标：

1. **全量 P2 单元测试与覆盖率回归**：
   ```bash
   npx vitest run test/sugent-byok-diagnostics.unit.test.ts test/sugent-e2ee-sync.unit.test.ts test/sugent-p2-gateway-routes.unit.test.ts test/sugent-byok-sync-panel.unit.test.ts
   ```
   Expected: 4 个测试套件全部 `PASS`，0 失败。
2. **TypeScript ESM 严格类型检查与文档门禁**：
   ```bash
   npm run verify:sugent
   ```
   Expected: 退出码为 `0`，无隐式 `any` 或跨边界循环依赖，`docs:check` 0 错误 0 警告。

## 4. 权威参考标准索引

- **认证加密模式 (AES-GCM)**：[NIST SP 800-38D: Recommendation for Block Cipher Modes of Operation: Galois/Counter Mode (GCM) and GMAC](https://csrc.nist.gov/pubs/sp/800/38/d/final)
- **基于 HMAC 的提取-扩展密钥派生 (HKDF)**：[RFC 5869: HMAC-based Extract-and-Expand Key Derivation Function (HKDF)](https://www.rfc-editor.org/info/rfc5869/)
- **基于口令的密钥派生规范 (PBKDF2)**：[RFC 8018: PKCS #5: Password-Based Cryptography Specification Version 2.1](https://www.rfc-editor.org/info/rfc8018/) 与 [NIST SP 800-132: Recommendation for Password-Based Key Derivation](https://csrc.nist.gov/pubs/sp/800/132/final)
- **口令迭代抗暴力破解基准**：[OWASP Password Storage Cheat Sheet (PBKDF2-HMAC-SHA256 600,000 iterations)](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- **运行时密码学原语实现**：[Node.js Crypto API Official Documentation (`pbkdf2Sync`, `hkdfSync`, `createCipheriv`)](https://nodejs.org/api/crypto.html) 与浏览器跨端兼容标准 [MDN Web Crypto API (`SubtleCrypto.encrypt`)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt)、[MDN `SubtleCrypto.deriveKey`](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey)
- **令牌声明与零知识对象存储协议**：[RFC 7519: JSON Web Token (JWT)](https://www.rfc-editor.org/info/rfc7519/)、[Cloudflare R2 S3 API Compatibility](https://developers.cloudflare.com/r2/api/s3/api/)、[RFC 4918: HTTP Extensions for Web Distributed Authoring and Versioning (WebDAV)](https://www.rfc-editor.org/info/rfc4918/)
- **上游智能体能力探测协议**：[OpenAI Responses API Reference](https://developers.openai.com/api/reference/resources/responses/methods/create) 与 [OpenAI Function & Tool Calling Guide](https://developers.openai.com/api/docs/guides/tools)

