/**
 * Sugent × Business-Level Cowork 端-边动态联邦桥接器（src/sugent/cowork-bridge.ts）
 *
 * 对应 Roadmap 阶段二第 4 节，实现个人全栈分身（Sugent）与团队本体治理母舰（Cowork :28080）的松耦合动态联合：
 * 1. 工作帽热插拔（Zero-Intrusion MCP SSE & Gateway Handshake）：
 *    - 解析员工角色与工作区标识（遵循最小权限收敛：`technician` / `expert` / `admin`）；
 *    - 生成可注入 DSH `amb.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` 远程 SSE 配置行；
 *    - 生成指向 `<baseUrl>/v1` 的独立 `SugentGatewayConfig`，使工作 Bot 走团队网关审计、私人 Bot 物理隔离。
 * 2. 安全信封封装的待审事件接入（M1.4 Security Envelope Integration）：
 *    - 将 Cowork Staging `PENDING_REVIEW` 草稿或 `WAITING_APPROVAL` 事件经 `sealExternalEvent` 写入只读 `.context/event-<id>.md`，
 *      阻断跨角色间接 Prompt 注入与越权控制字段（`cwd` / `agent` / `permission` / `access`）；
 *    - 仅当本地员工角色具备 `canApproveHitl`（`expert` 或 `admin`）时才标记 `fromAllowedSender: true`。
 * 3. 双重 RBAC 守护的移动 HITL 审批客户端（`CoworkHitlClient`）：
 *    - 在端侧前置校验审批角色权限，拦截 `technician` 越权审批调用，并封装待审列表查询、批准与驳回请求契约。
 */
import type { AppConfig } from "../config.js";
import { resolveSugentGatewayConfig } from "./gateway.js";
import {
  guardPrivilegedEventFields,
  sealExternalEvent,
  validateSafeMetadataToken,
  validateSafeMetadataUrl,
} from "./security-envelope.js";
import type { PersonalTrigger, PrivilegedFieldMode, SugentGatewayConfig } from "./types.js";

export type CoworkEmployeeRole = "technician" | "expert" | "admin";

export const COWORK_STANDARD_TOOLS: readonly string[] = [
  "get_ontology_schema",
  "query_graph_context",
  "propose_field_knowledge",
  "list_available_skills",
  "submit_draft_to_staging",
];

export class CoworkPermissionError extends Error {
  readonly role: CoworkEmployeeRole;
  readonly operation: string;

  constructor(role: CoworkEmployeeRole, operation: string, message: string) {
    super(message);
    this.name = "CoworkPermissionError";
    this.role = role;
    this.operation = operation;
  }
}

export interface CoworkFederationInput {
  baseUrl?: string;
  employeeToken?: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  department?: string;
  workspaceId?: string;
  /** 是否将该工作 Bot 的推理请求路由到 Cowork `/v1` 审计网关（默认 true） */
  routeInferenceThroughCowork?: boolean;
  /** MCP 服务标识名（默认 `cowork-hub`） */
  serverName?: string;
  /** 工具调用超时毫秒数（默认 30000） */
  toolCallTimeoutMs?: number;
}

export interface CoworkFederationConfig {
  baseUrl: string;
  gatewayBaseUrl: string;
  mcpSseUrl: string;
  employeeToken: string;
  userId: string;
  userName?: string;
  userRole: CoworkEmployeeRole;
  department?: string;
  workspaceId: string;
  canApproveHitl: boolean;
  routeInferenceThroughCowork: boolean;
  serverName: string;
  toolCallTimeoutMs: number;
  endpoints: {
    pendingListPath: string;
    pendingEventsPath: string;
    approvePath: string;
    rejectPath: string;
  };
}

/**
 * 与 `business-level-cowork/server/roster.py` 一致的最小权限角色解析：
 * - 只要输入包含 `technician`，一律收敛为 `technician`（防止拼接提权）；
 * - 未知或空字符串一律降级为 `technician`。
 */
export function normalizeCoworkRole(rawRole: string | undefined): CoworkEmployeeRole {
  if (!rawRole || typeof rawRole !== "string") return "technician";
  const tokens = rawRole
    .replace(/\u0000/g, " ")
    .split(/[,;/\s|\\+]+/)
    .map((t) => t.trim().replace(/^["']+|["']+$/g, "").toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) return "technician";
  if (tokens.includes("technician")) return "technician";
  if (tokens.includes("admin")) return "admin";
  if (tokens.includes("expert")) return "expert";
  return "technician";
}

/**
 * 解析并校验 Cowork 动态联邦配置（支持显式参数或 `SUGENT_COWORK_*` 环境变量）。
 */
export function resolveCoworkFederationConfig(
  input: CoworkFederationInput = {},
  env: NodeJS.ProcessEnv = process.env,
): CoworkFederationConfig {
  const rawBaseUrl = (input.baseUrl ?? env.SUGENT_COWORK_URL ?? "").trim();
  const validatedUrl = validateSafeMetadataUrl(rawBaseUrl);
  if (!validatedUrl) {
    throw new Error("Cowork federation requires a valid http/https baseUrl.");
  }
  const canonicalRoot = validatedUrl.replace(/\/+$/, "").replace(/\/(v1|sse)$/i, "");

  const employeeToken = (
    input.employeeToken ??
    env.SUGENT_COWORK_API_KEY ??
    env.SUGENT_GATEWAY_KEY ??
    ""
  ).trim();
  if (!employeeToken) {
    throw new Error("Cowork federation requires a non-empty employeeToken.");
  }

  const userId = validateSafeMetadataToken(
    input.userId ?? env.SUGENT_COWORK_USER_ID ?? "USR-UNKNOWN",
    "userId",
  );
  const userRole = normalizeCoworkRole(input.userRole ?? env.SUGENT_COWORK_ROLE);
  const workspaceId = validateSafeMetadataToken(
    input.workspaceId ?? env.SUGENT_COWORK_WORKSPACE_ID ?? "ws-default",
    "workspaceId",
  );
  const serverName = validateSafeMetadataToken(input.serverName ?? "cowork-hub", "serverName");
  const canApproveHitl = userRole === "expert" || userRole === "admin";
  const routeInferenceThroughCowork = input.routeInferenceThroughCowork !== false;
  const toolCallTimeoutMs =
    typeof input.toolCallTimeoutMs === "number" && input.toolCallTimeoutMs >= 1000
      ? Math.trunc(input.toolCallTimeoutMs)
      : 30_000;

  return {
    baseUrl: canonicalRoot,
    gatewayBaseUrl: `${canonicalRoot}/v1`,
    mcpSseUrl: `${canonicalRoot}/sse`,
    employeeToken,
    userId,
    ...(input.userName?.trim() ? { userName: input.userName.trim() } : {}),
    userRole,
    ...(input.department?.trim() ? { department: input.department.trim() } : {}),
    workspaceId,
    canApproveHitl,
    routeInferenceThroughCowork,
    serverName,
    toolCallTimeoutMs,
    endpoints: {
      pendingListPath: "/api/staging/list",
      pendingEventsPath: "/api/staging/pending-events",
      approvePath: "/api/hitl/approve",
      rejectPath: "/api/hitl/reject",
    },
  };
}

/**
 * 解析由 `business-level-cowork/client/generate_config.py --target sugent` 生成的联邦配置 JSON。
 */
export function parseCoworkFederationProfile(
  rawJsonOrObject: string | Record<string, unknown>,
): CoworkFederationConfig {
  const obj = (
    typeof rawJsonOrObject === "string" ? JSON.parse(rawJsonOrObject) : rawJsonOrObject
  ) as Record<string, any>;

  const identity = (obj?.identity ?? {}) as Record<string, any>;
  const gateway = (obj?.gateway ?? {}) as Record<string, any>;
  const mcpServer = (obj?.mcpServer ?? {}) as Record<string, any>;

  const rawRoot =
    typeof obj?.baseUrl === "string"
      ? obj.baseUrl
      : typeof gateway.baseUrl === "string"
        ? String(gateway.baseUrl).replace(/\/v1\/?$/, "")
        : typeof mcpServer.url === "string"
          ? String(mcpServer.url).replace(/\/sse\/?$/, "")
          : "";

  return resolveCoworkFederationConfig({
    baseUrl: rawRoot,
    employeeToken: String(gateway.apiKey ?? obj?.employeeToken ?? ""),
    userId: String(identity.userId ?? gateway.userId ?? "USR-UNKNOWN"),
    userName: typeof identity.userName === "string" ? identity.userName : undefined,
    userRole: String(identity.role ?? gateway.userRole ?? "technician"),
    department: typeof identity.department === "string" ? identity.department : undefined,
    workspaceId: String(identity.workspaceId ?? obj?.workspaceId ?? "ws-default"),
    serverName: typeof mcpServer.serverName === "string" ? mcpServer.serverName : "cowork-hub",
  });
}

function yamlStr(val: string): string {
  return JSON.stringify(val);
}

/**
 * 生成注入 DSH `amb.patch.yml` 的 `@deepseek-ai/dsh-mcp-client` 远程 SSE 配置行（不把敏感密钥明文落盘进 YAML，
 * 仅声明身份头与环境变量名 `SUGENT_COWORK_API_KEY`，契合 `host.ts` 安全准则）。
 */
export function buildCoworkMcpPatchLines(config: CoworkFederationConfig): string[] {
  const identityHeaders: Record<string, string> = {
    "X-User-Id": config.userId,
    "X-User-Role": config.userRole,
    "X-Workspace-Id": config.workspaceId,
  };

  return [
    `    - id: sugent-${config.serverName}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    "      config:",
    "        transport: sse",
    `        serverName: ${yamlStr(config.serverName)}`,
    `        url: ${yamlStr(config.mcpSseUrl)}`,
    "        apiKeyEnv: \"SUGENT_COWORK_API_KEY\"",
    "        headers:",
    ...Object.entries(identityHeaders).map(([k, v]) => `          ${yamlStr(k)}: ${yamlStr(v)}`),
    `        toolCallTimeoutMs: ${config.toolCallTimeoutMs}`,
    "        failOnStartupError: false",
    "        reconnect:",
    "          maxAttempts: 3",
    "          initialDelayMs: 2000",
  ];
}

/**
 * 为绑定了 Cowork 工作帽的机器人生成独立的 `SugentGatewayConfig`。
 */
export function buildCoworkGatewayConfig(
  cowork: CoworkFederationConfig,
  appConfig?: Pick<AppConfig, "magpie" | "llm">,
  baseEnv: NodeJS.ProcessEnv = process.env,
): SugentGatewayConfig {
  if (!cowork.routeInferenceThroughCowork) {
    return resolveSugentGatewayConfig(appConfig, baseEnv);
  }
  return resolveSugentGatewayConfig(appConfig, {
    ...baseEnv,
    SUGENT_GATEWAY_MODE: "external",
    SUGENT_GATEWAY_URL: cowork.gatewayBaseUrl,
    SUGENT_GATEWAY_KEY: cowork.employeeToken,
  });
}

export interface CoworkPendingDraftPayload {
  draft_id: string;
  status?: string;
  proposer_id?: string;
  title?: string;
  summary?: string;
  factuality_score?: number;
  is_schema_valid?: boolean;
  proposed_triples?: unknown[];
  created_at?: string;
  [key: string]: unknown;
}

export interface IngestCoworkEventOptions {
  workspaceDir: string;
  privilegedFieldMode?: PrivilegedFieldMode;
  addressedToAgent?: boolean;
}

/**
 * 将来自 Cowork Staging / 工作流挂起的待审草稿封装进 M1.4 安全信封（`.context/event-<id>.md` 只读落盘），
 * 转化为 Sugent 自治内核可消费的 `PersonalTrigger`。
 */
export function ingestCoworkPendingEvent(
  config: CoworkFederationConfig,
  rawDraft: CoworkPendingDraftPayload,
  options: IngestCoworkEventOptions,
): PersonalTrigger & { envelope: NonNullable<PersonalTrigger["envelope"]> } {
  const { sanitized, strippedFields } = guardPrivilegedEventFields(rawDraft, {
    mode: options.privilegedFieldMode ?? "reject",
  });

  const draftId = validateSafeMetadataToken(sanitized.draft_id, "draft_id");
  const statusToken = validateSafeMetadataToken(
    typeof sanitized.status === "string" && sanitized.status.trim() ? sanitized.status : "PENDING_REVIEW",
    "status",
  );
  const proposerId =
    typeof sanitized.proposer_id === "string" && sanitized.proposer_id.trim()
      ? sanitized.proposer_id.trim()
      : "cowork-staging";

  const untrustedTitle = typeof sanitized.title === "string" ? sanitized.title : undefined;
  const untrustedBody =
    typeof sanitized.summary === "string"
      ? sanitized.summary
      : JSON.stringify(sanitized.proposed_triples ?? []);

  const sealed = sealExternalEvent({
    workspaceDir: options.workspaceDir,
    source: "cowork_hitl",
    eventType: `staging.${statusToken.toLowerCase()}`,
    eventId: draftId,
    ref: `${config.workspaceId}:${draftId}`,
    url: `${config.baseUrl}${config.endpoints.pendingListPath}`,
    ...(untrustedTitle !== undefined ? { title: untrustedTitle } : {}),
    body: untrustedBody,
    payload: sanitized,
    privilegedFieldMode: "strip",
  });

  const envelope =
    strippedFields.length > 0 ? { ...sealed.envelope, strippedFields } : sealed.envelope;

  return {
    id: `cowork:${draftId}`,
    sourceKind: "cowork_hitl",
    sourceInstanceId: config.serverName,
    threadKey: `cowork:${config.workspaceId}:${draftId}`,
    senderId: proposerId,
    addressedToAgent: Boolean(options.addressedToAgent),
    fromAllowedSender: config.canApproveHitl,
    text: sealed.prompt,
    createdAt:
      typeof sanitized.created_at === "string" && sanitized.created_at.trim()
        ? sanitized.created_at
        : "1970-01-01T00:00:00.000Z",
    meta: {
      workspaceId: config.workspaceId,
      draftId,
      status: statusToken,
      factualityScore:
        typeof sanitized.factuality_score === "number" ? sanitized.factuality_score : undefined,
      isSchemaValid:
        typeof sanitized.is_schema_valid === "boolean" ? sanitized.is_schema_valid : undefined,
      contextFile: envelope.contextFile,
      contextSha256: envelope.sha256,
    },
    envelope,
  };
}

export interface CoworkJsonRequest {
  method: "GET" | "POST";
  path: string;
  userId: string;
  userRole: CoworkEmployeeRole;
  workspaceId: string;
  body?: Record<string, unknown>;
}

export type CoworkJsonTransport = <T = unknown>(req: CoworkJsonRequest) => Promise<T>;

export interface HitlReviewDecisionResult {
  status: "APPROVED" | "REJECTED" | string;
  draft_id?: string;
  written_triples_count?: number;
  graph_updated?: boolean;
  [key: string]: unknown;
}

/**
 * 供飞书/微信「批奏折」卡片回调 Cowork HITL 审核端点的领域客户端（传输层依赖注入，端侧双重 RBAC 前置拦截）。
 */
export class CoworkHitlClient {
  constructor(
    readonly config: CoworkFederationConfig,
    private readonly transport: CoworkJsonTransport,
  ) {}

  private assertCanApprove(operation: "approve" | "reject"): void {
    if (!this.config.canApproveHitl) {
      throw new CoworkPermissionError(
        this.config.userRole,
        operation,
        `Permission denied: role "${this.config.userRole}" cannot ${operation} HITL drafts; requires expert or admin.`,
      );
    }
  }

  async listPendingDrafts(): Promise<CoworkPendingDraftPayload[]> {
    const data = await this.transport<unknown>({
      method: "GET",
      path: this.config.endpoints.pendingListPath,
      userId: this.config.userId,
      userRole: this.config.userRole,
      workspaceId: this.config.workspaceId,
    });
    return Array.isArray(data) ? (data as CoworkPendingDraftPayload[]) : [];
  }

  /**
   * 按单调游标增量拉取 Cowork 窗口 5 `/api/staging/pending-events` 待审事件流。
   */
  async pollPendingEvents(
    afterSeq = 0,
    limit = 50,
  ): Promise<{ cursor: number; events: Array<CoworkPendingDraftPayload & { seq: number }> }> {
    const safeAfter = Math.max(0, Math.trunc(afterSeq));
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const data = await this.transport<Record<string, unknown>>({
      method: "GET",
      path: `${this.config.endpoints.pendingEventsPath}?after_seq=${safeAfter}&limit=${safeLimit}`,
      userId: this.config.userId,
      userRole: this.config.userRole,
      workspaceId: this.config.workspaceId,
    });
    const events = Array.isArray(data?.events)
      ? (data.events as Array<CoworkPendingDraftPayload & { seq: number }>)
      : [];
    const cursor =
      typeof data?.cursor === "number" && Number.isFinite(data.cursor)
        ? Math.trunc(data.cursor)
        : events.reduce((m, e) => Math.max(m, Number(e.seq) || 0), safeAfter);
    return { cursor, events };
  }

  /**
   * 拉取增量待审事件并逐条封装进 M1.4 只读安全信封，返回游标与可直投内核的 `PersonalTrigger` 列表。
   */
  async ingestPendingEventsBatch(
    options: IngestCoworkEventOptions & { afterSeq?: number; limit?: number },
  ): Promise<{
    cursor: number;
    triggers: Array<PersonalTrigger & { envelope: NonNullable<PersonalTrigger["envelope"]> }>;
  }> {
    const batch = await this.pollPendingEvents(options.afterSeq ?? 0, options.limit ?? 50);
    const triggers = batch.events.map((ev) => ingestCoworkPendingEvent(this.config, ev, options));
    return { cursor: batch.cursor, triggers };
  }

  async approveDraft(draftId: string, reviewerComments = ""): Promise<HitlReviewDecisionResult> {
    this.assertCanApprove("approve");
    const safeDraftId = validateSafeMetadataToken(draftId, "draftId");
    return await this.transport<HitlReviewDecisionResult>({
      method: "POST",
      path: this.config.endpoints.approvePath,
      userId: this.config.userId,
      userRole: this.config.userRole,
      workspaceId: this.config.workspaceId,
      body: {
        draft_id: safeDraftId,
        reviewer_comments: String(reviewerComments ?? ""),
      },
    });
  }

  async rejectDraft(draftId: string, reviewerComments: string): Promise<HitlReviewDecisionResult> {
    this.assertCanApprove("reject");
    const safeDraftId = validateSafeMetadataToken(draftId, "draftId");
    return await this.transport<HitlReviewDecisionResult>({
      method: "POST",
      path: this.config.endpoints.rejectPath,
      userId: this.config.userId,
      userRole: this.config.userRole,
      workspaceId: this.config.workspaceId,
      body: {
        draft_id: safeDraftId,
        reviewer_comments: String(reviewerComments ?? ""),
      },
    });
  }
}
