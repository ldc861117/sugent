/**
 * Sugent 双人关系幕僚与记忆晶化引擎（src/sugent/duo-steward-crystallizer.ts）
 *
 * 设计红线与架构契约：
 * 1. 公私域绝对物理隔离：所有双人空间数据独立存储于 `<dataDir>/duo-spaces/<safeSpaceId>/`（0o700/0o600），
 *    拥有专属 `SugentKnowledgeGraph` 实例，零权限读取主理人 `owner_private` / `work_project` 五维账本；
 * 2. 安全信封与防注入：所有外部投喂（网站对话、日志、校准及预留的微信助理号双人群切片）强制经
 *    `sealExternalEvent`（`privilegedFieldMode: "strip"`）密封为 0o400 只读上下文，并经 `looksSecret` 拦截密钥；
 * 3. DreamSandbox 渐进印证与时效排他更替（不翻旧账）：
 *    候选星晶（`candidate`）经任一方/双方共鸣确认或累计印证满 3 次晋升为 `crystallized`，
 *    同 `topicKey` 新星晶转正时自动将旧星晶置为 `superseded`（并在独立图谱写入 `exclusive: true` 排他边），
 *    召回层严格过滤 `superseded` / `archived` 节点；
 * 4. 网关中立与 `mode: "none"` 离线退路：模型调用统一经 `gateway.ts` 按角色（`steward` / `executor`）路由，
 *    无在线端点时自动切换确定性提炼与结构化离线回退，确保 100% 单机闭环可用。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksSecret } from "../agent/memory.js";
import { resolveSugentGatewayConfig, selectModelForRole } from "./gateway.js";
import { SugentKnowledgeGraph } from "./knowledge-graph.js";
import { sealExternalEvent } from "./security-envelope.js";
import type { ModelRole, SugentGatewayConfig } from "./types.js";

export const DUO_STEWARD_PACK_ID = "duo-relationship-steward" as const;
export const DEFAULT_DUO_SPACE_ID = "andy-gillna" as const;
export const DUO_CRYSTAL_PROMOTE_THRESHOLD = 3;

export type DuoPartnerRole = "M" | "W";

export type DuoCrystalKind =
  | "consensus_tacit"
  | "friction_antidote"
  | "stage_evolution"
  | "micro_card";

export type DuoCrystalStatus =
  | "candidate"
  | "crystallized"
  | "superseded"
  | "archived";

export interface DuoCrystal {
  id: string;
  spaceId: string;
  topicKey: string;
  kind: DuoCrystalKind;
  status: DuoCrystalStatus;
  title: string;
  summary: string;
  orbitalMetaphor?: string;
  triggerSignal?: string;
  gentleAction?: string;
  evidenceRefs: string[];
  confidence: number;
  reinforcements: number;
  endorsedBy: DuoPartnerRole[];
  supersededBy?: string;
  supersededAt?: string;
  sourcePeriod?: string;
  createdAt: string;
  updatedAt: string;
}

export type DuoCommitmentCategory =
  | "keep"
  | "adjust"
  | "quality_time"
  | "safety_net"
  | "wish";

export type DuoCommitmentStatus =
  | "active"
  | "echoed"
  | "fulfilled"
  | "archived";

export interface DuoMicroCommitment {
  id: string;
  spaceId: string;
  category: DuoCommitmentCategory;
  title: string;
  detail: string;
  proposer: DuoPartnerRole | "both";
  status: DuoCommitmentStatus;
  echoCount: number;
  lastEchoNote?: string;
  sourceRef?: string;
  targetPeriod?: string;
  createdAt: string;
  updatedAt: string;
}

export type DuoSynthesisScope = "7d" | "30d" | "quarter" | "topic";

export interface DuoSynthesisReport {
  id: string;
  spaceId: string;
  scopeType: DuoSynthesisScope;
  scopeLabel: string;
  requestedBy: DuoPartnerRole | "cron";
  headline: string;
  orbitPulseSummary: string;
  keyHighlights: string[];
  tensionAndRepair: string[];
  agreementEchoes: string[];
  proposedCrystalIds: string[];
  proposedCommitmentIds: string[];
  closingQuestion: string;
  modelUsed: string;
  createdAt: string;
}

export interface DuoSourceBundle {
  spaceId?: string;
  scopeType?: DuoSynthesisScope;
  topicQuery?: string;
  requestedBy?: DuoPartnerRole | "cron";
  partnerLabels?: { M: string; W: string };
  diaries?: Array<{
    id?: string | number;
    date: string;
    author: DuoPartnerRole;
    title: string;
    content: string;
    mood?: string;
  }>;
  events?: Array<{
    id?: string | number;
    date: string;
    author: DuoPartnerRole | "SYSTEM";
    title: string;
    content: string;
    mood?: string;
    gravity?: string;
  }>;
  reconciles?: Array<{
    targetMonth: string;
    author: DuoPartnerRole;
    summaryText?: string;
    actionKeep?: string;
    actionAdjust?: string;
    actionQualityTime?: string;
    actionSafetyNet?: string;
  }>;
  chatSlices?: Array<{
    timestamp: string;
    sender: DuoPartnerRole;
    content: string;
  }>;
  stewardTurns?: Array<{
    role: "user" | "assistant";
    content: string;
  }>;
  synastrySummary?: string;
}

export interface DuoEnvoyGroupMessageInput {
  messageId: string;
  groupId: string;
  senderId: string;
  senderPartnerRole?: DuoPartnerRole;
  text: string;
  atIso?: string;
  rawExtra?: Record<string, unknown>;
}

export interface DuoLlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface DuoStewardCrystallizerOptions {
  dataDir: string;
  getGatewayConfig?: () => SugentGatewayConfig;
  resolveRoleEndpoint?: (role: ModelRole) => DuoLlmEndpoint | undefined;
  fetchImpl?: typeof fetch;
  bridgeTokens?: readonly string[];
  allowedEnvoyGroupIds?: readonly string[];
  selfEnvoyWxid?: string;
  nowIso?: () => string;
}

export interface DuoVaultSnapshot {
  spaceId: string;
  packId: typeof DUO_STEWARD_PACK_ID;
  updatedAt: string;
  crystals: {
    crystallized: DuoCrystal[];
    candidates: DuoCrystal[];
    supersededCount: number;
  };
  commitments: DuoMicroCommitment[];
  recentReports: DuoSynthesisReport[];
  activeSubgraphMarkdown: string;
}

interface PersistedDuoSpaceState {
  version: 1;
  spaceId: string;
  updatedAt: string;
  crystals: DuoCrystal[];
  commitments: DuoMicroCommitment[];
  reports: DuoSynthesisReport[];
}

const VALID_CRYSTAL_KINDS = new Set<DuoCrystalKind>([
  "consensus_tacit",
  "friction_antidote",
  "stage_evolution",
  "micro_card",
]);

const VALID_COMMITMENT_CATEGORIES = new Set<DuoCommitmentCategory>([
  "keep",
  "adjust",
  "quality_time",
  "safety_net",
  "wish",
]);

export function sanitizeDuoSpaceId(raw?: string): string {
  const cleaned = String(raw ?? DEFAULT_DUO_SPACE_ID)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || DEFAULT_DUO_SPACE_ID;
}

export function normalizeCrystalTopicKey(raw: string): string {
  const cleaned = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56);
  return cleaned || "orbital-insight";
}

function assertDuoNoSecrets(fields: Array<string | undefined>, label: string): void {
  for (const text of fields) {
    if (typeof text === "string" && text.trim() && looksSecret(text)) {
      throw new Error(`Refused secret-like content in Duo ${label}.`);
    }
  }
}

function writeAtomic600(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore non-posix fs */
  }
  fs.renameSync(tmp, filePath);
}

function sha256Buf(value: string): Buffer {
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function extractFirstJsonObject(raw: string): Record<string, any> | null {
  const cleaned = String(raw ?? "")
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 构建「Sugent · 星轨幕僚」标准系统提示词：
 * - 褪去“本仙人/吾乃”等古风戏服词；
 * - 平等守护两颗星体（Pluto/Andy 与 Charon/Gillna），严禁偏袒、严禁提及冰冷量表分数或临床标签；
 * - 自动注入当前生效星晶与在途双人微约定，并严格排除已 `superseded` 的旧认知（不翻旧账）。
 */
export function buildDuoStewardSystemPrompt(params: {
  speaker: DuoPartnerRole;
  partnerLabels?: { M: string; W: string };
  activeCrystals: readonly DuoCrystal[];
  activeCommitments: readonly DuoMicroCommitment[];
  baselineContext?: string;
  episodicContext?: string;
  retrievedContext?: string;
}): string {
  const labels = params.partnerLabels ?? { M: "Andy", W: "Gillna" };
  const speakerName = params.speaker === "M" ? `${labels.M} (Pluto)` : `${labels.W} (Charon)`;
  const partnerName = params.speaker === "M" ? `${labels.W} (Charon)` : `${labels.M} (Pluto)`;

  const activeOnly = params.activeCrystals.filter((c) => c.status === "crystallized");
  const crystalLines =
    activeOnly.length > 0
      ? activeOnly
          .slice(0, 8)
          .map((c) => {
            const extras = [
              c.orbitalMetaphor ? `隐喻：${c.orbitalMetaphor}` : "",
              c.triggerSignal ? `触发信号：${c.triggerSignal}` : "",
              c.gentleAction ? `调频配方：${c.gentleAction}` : "",
            ]
              .filter(Boolean)
              .join("｜");
            return `- [${c.kind} · topic:${c.topicKey}] 《${c.title}》：${c.summary}${extras ? `（${extras}）` : ""}`;
          })
          .join("\n")
      : "暂无已凝结星晶，请在对话中敏锐捕捉值得沉淀的相处共识。";

  const commitmentLines =
    params.activeCommitments.length > 0
      ? params.activeCommitments
          .filter((m) => m.status === "active" || m.status === "echoed")
          .slice(0, 6)
          .map(
            (m) =>
              `- [${m.category}] ${m.title}：${m.detail}${m.echoCount > 0 ? `（已温暖回响 ${m.echoCount} 次）` : ""}`,
          )
          .join("\n")
      : "暂无在途微约定。";

  return [
    `你是「Sugent · 星轨幕僚」(Sugent Orbital Steward)，专为 ${labels.M} (Pluto) 与 ${labels.W} (Charon) 守护并梳理这段双星关系的私人关系幕僚与记忆晶化师。`,
    `当前对话视角：${speakerName}（伴侣为 ${partnerName}）。`,
    "",
    "【语气与人格铁律】",
    "1. 褪去“本仙人”、“吾乃”等古风戏服腔，采用现代、温柔克制、敏锐通透且带星轨引力美学的编辑档案口吻；既有宇宙与天体物理的浪漫温度，又有 Sugent 幕僚清晰的结构化总结与洞察力。",
    "2. 平等守护双星：绝对禁止偏袒任何一方，把双方的反应差异理解为不同星核的保护机制（如压缩自稳核 vs 敏锐感知核），严禁输出量表分数、MBTI 代码或生硬说教。",
    "3. 时效认知纪律（严禁翻旧账）：下方【当期生效关系星晶】代表两人最新验证的相处规律，已自动覆盖早期过时阶段；切勿反复翻炒早已化解的陈年摩擦。",
    "4. 自然回响与留白：若话题与【在途双人微约定】契合，可轻柔呼应而非催办考核；文末以一句温和开阔的星空或相处省思发问收尾。",
    "",
    "=== 当期生效关系星晶 (Active Relationship Crystals) ===",
    crystalLines,
    "",
    "=== 在途双人微约定 (Active Duo Micro-Commitments) ===",
    commitmentLines,
    ...(params.baselineContext ? ["", params.baselineContext] : []),
    ...(params.episodicContext ? ["", params.episodicContext] : []),
    ...(params.retrievedContext ? ["", params.retrievedContext] : []),
  ].join("\n");
}

export class DuoStewardCrystallizer {
  private readonly rootDir: string;
  private readonly nowIsoFn: () => string;
  private readonly tokenDigests: Buffer[];
  private readonly allowedGroupIds: Set<string>;
  private readonly spaces = new Map<string, PersistedDuoSpaceState>();
  private readonly graphs = new Map<string, SugentKnowledgeGraph>();

  constructor(private readonly opts: DuoStewardCrystallizerOptions) {
    this.rootDir = path.join(path.resolve(opts.dataDir), "duo-spaces");
    fs.mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());

    const rawTokens = [
      ...(opts.bridgeTokens ?? []),
      process.env.SUGENT_DUO_BRIDGE_TOKEN ?? "",
    ]
      .map((t) => String(t ?? "").trim())
      .filter((t) => t.length >= 12);
    this.tokenDigests = rawTokens.map(sha256Buf);
    this.allowedGroupIds = new Set(
      (opts.allowedEnvoyGroupIds ?? [])
        .map((id) => String(id ?? "").trim())
        .filter(Boolean),
    );
  }

  /**
   * 恒定时间比对 `SUGENT_DUO_BRIDGE_TOKEN`（仅授权 `/amb/api/steward/duo/*`，与主理人管理令牌物理隔离）。
   */
  verifyBridgeToken(candidate: string | undefined): boolean {
    const clean = String(candidate ?? "").trim();
    if (!clean || this.tokenDigests.length === 0) return false;
    const digest = sha256Buf(clean);
    let matched = false;
    for (const target of this.tokenDigests) {
      if (crypto.timingSafeEqual(digest, target)) {
        matched = true;
      }
    }
    return matched;
  }

  private spaceDir(spaceId: string): string {
    const safe = sanitizeDuoSpaceId(spaceId);
    const dir = path.join(this.rootDir, safe);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private getSpaceGraph(spaceId: string): SugentKnowledgeGraph {
    const safe = sanitizeDuoSpaceId(spaceId);
    let kg = this.graphs.get(safe);
    if (!kg) {
      kg = new SugentKnowledgeGraph(path.join(this.spaceDir(safe), "duo-kg"));
      this.graphs.set(safe, kg);
    }
    return kg;
  }

  private loadSpace(spaceId?: string): PersistedDuoSpaceState {
    const safe = sanitizeDuoSpaceId(spaceId);
    const cached = this.spaces.get(safe);
    if (cached) return cached;

    const stateFile = path.join(this.spaceDir(safe), "duo-vault.json");
    if (fs.existsSync(stateFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8")) as PersistedDuoSpaceState;
        if (parsed && parsed.version === 1) {
          this.spaces.set(safe, parsed);
          return parsed;
        }
      } catch {
        /* fallback to fresh state */
      }
    }

    const fresh: PersistedDuoSpaceState = {
      version: 1,
      spaceId: safe,
      updatedAt: this.nowIsoFn(),
      crystals: [],
      commitments: [],
      reports: [],
    };
    this.spaces.set(safe, fresh);
    return fresh;
  }

  private saveSpace(state: PersistedDuoSpaceState): void {
    state.updatedAt = this.nowIsoFn();
    const stateFile = path.join(this.spaceDir(state.spaceId), "duo-vault.json");
    writeAtomic600(stateFile, state);
  }

  private resolveEndpointForRole(role: ModelRole): DuoLlmEndpoint | undefined {
    const viaHook = this.opts.resolveRoleEndpoint?.(role);
    if (viaHook?.baseUrl && viaHook.apiKey) return viaHook;
    const gw = this.opts.getGatewayConfig?.() ?? resolveSugentGatewayConfig(undefined, {});
    if (gw.baseUrl && gw.apiKey) {
      return {
        baseUrl: gw.baseUrl,
        apiKey: gw.apiKey,
        model: selectModelForRole(gw, role),
      };
    }
    return undefined;
  }

  private async callRoleChatJson(params: {
    role: ModelRole;
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
  }): Promise<{ text: string; modelUsed: string } | null> {
    const ep = this.resolveEndpointForRole(params.role);
    if (!ep) return null;
    const fetchFn = this.opts.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== "function") return null;

    const base = ep.baseUrl.replace(/\/+$/, "");
    const url = base.endsWith("/chat/completions")
      ? base
      : base.endsWith("/v1")
        ? `${base}/chat/completions`
        : `${base}/v1/chat/completions`;

    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${ep.apiKey}`,
        },
        body: JSON.stringify({
          model: ep.model,
          temperature: params.temperature ?? 0.4,
          messages: [
            { role: "system", content: params.systemPrompt },
            { role: "user", content: params.userPrompt },
          ],
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as any;
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return { text: content.trim(), modelUsed: String(body?.model || ep.model) };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 获取指定双人空间的完整星晶库、微约定与近期深度复盘快照。
   */
  getVaultSnapshot(spaceId?: string, recallQuery = ""): DuoVaultSnapshot {
    const state = this.loadSpace(spaceId);
    const kg = this.getSpaceGraph(state.spaceId);
    const crystallized = state.crystals
      .filter((c) => c.status === "crystallized")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const candidates = state.crystals
      .filter((c) => c.status === "candidate")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const supersededCount = state.crystals.filter((c) => c.status === "superseded").length;

    const subgraph = kg.recallSubgraph(recallQuery || state.spaceId, 2);

    return {
      spaceId: state.spaceId,
      packId: DUO_STEWARD_PACK_ID,
      updatedAt: state.updatedAt,
      crystals: {
        crystallized,
        candidates,
        supersededCount,
      },
      commitments: [...state.commitments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      recentReports: [...state.reports]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 12),
      activeSubgraphMarkdown: subgraph.markdown,
    };
  }

  /**
   * 写入或强化单枚星晶；若晋升为 `crystallized`，自动对同 `topicKey` 的旧星晶执行时效排他替代（`superseded`）。
   */
  upsertCrystal(input: {
    spaceId?: string;
    id?: string;
    topicKey: string;
    kind: DuoCrystalKind;
    title: string;
    summary: string;
    orbitalMetaphor?: string;
    triggerSignal?: string;
    gentleAction?: string;
    evidenceRefs?: string[];
    sourcePeriod?: string;
    endorseBy?: DuoPartnerRole;
    forceCrystallize?: boolean;
  }): DuoCrystal {
    assertDuoNoSecrets(
      [input.title, input.summary, input.orbitalMetaphor, input.triggerSignal, input.gentleAction],
      "crystal",
    );
    const state = this.loadSpace(input.spaceId);
    const now = this.nowIsoFn();
    const topicKey = normalizeCrystalTopicKey(input.topicKey || input.title);
    const kind: DuoCrystalKind = VALID_CRYSTAL_KINDS.has(input.kind)
      ? input.kind
      : "consensus_tacit";

    // 查找是否已有同 id，或同 topicKey 的待定候选（增量强化）
    let target = input.id
      ? state.crystals.find((c) => c.id === input.id)
      : state.crystals.find(
          (c) =>
            c.topicKey === topicKey &&
            c.status === "candidate" &&
            c.title.trim() === input.title.trim(),
        );

    if (target) {
      target.title = input.title.trim();
      target.summary = input.summary.trim();
      target.kind = kind;
      if (input.orbitalMetaphor !== undefined) target.orbitalMetaphor = input.orbitalMetaphor.trim();
      if (input.triggerSignal !== undefined) target.triggerSignal = input.triggerSignal.trim();
      if (input.gentleAction !== undefined) target.gentleAction = input.gentleAction.trim();
      if (input.sourcePeriod) target.sourcePeriod = input.sourcePeriod;
      target.evidenceRefs = Array.from(
        new Set([...target.evidenceRefs, ...(input.evidenceRefs ?? [])]),
      ).slice(0, 12);
      target.reinforcements += 1;
      target.confidence = Math.min(0.98, Math.round((target.confidence + 0.18) * 100) / 100);
      if (input.endorseBy && !target.endorsedBy.includes(input.endorseBy)) {
        target.endorsedBy.push(input.endorseBy);
      }
      target.updatedAt = now;
    } else {
      const id =
        input.id?.trim() || `crys-${topicKey.slice(0, 20)}-${crypto.randomUUID().slice(0, 6)}`;
      target = {
        id,
        spaceId: state.spaceId,
        topicKey,
        kind,
        status: "candidate",
        title: input.title.trim(),
        summary: input.summary.trim(),
        ...(input.orbitalMetaphor ? { orbitalMetaphor: input.orbitalMetaphor.trim() } : {}),
        ...(input.triggerSignal ? { triggerSignal: input.triggerSignal.trim() } : {}),
        ...(input.gentleAction ? { gentleAction: input.gentleAction.trim() } : {}),
        evidenceRefs: (input.evidenceRefs ?? []).slice(0, 12),
        confidence: 0.55,
        reinforcements: 1,
        endorsedBy: input.endorseBy ? [input.endorseBy] : [],
        ...(input.sourcePeriod ? { sourcePeriod: input.sourcePeriod } : {}),
        createdAt: now,
        updatedAt: now,
      };
      state.crystals.push(target);
    }

    const shouldPromote =
      Boolean(input.forceCrystallize) ||
      target.reinforcements >= DUO_CRYSTAL_PROMOTE_THRESHOLD ||
      target.endorsedBy.length >= 2;

    if (shouldPromote && target.status === "candidate") {
      this.promoteCrystalInternal(state, target, now);
    }

    this.saveSpace(state);
    return { ...target, endorsedBy: [...target.endorsedBy], evidenceRefs: [...target.evidenceRefs] };
  }

  private promoteCrystalInternal(
    state: PersistedDuoSpaceState,
    crystal: DuoCrystal,
    nowIso: string,
  ): void {
    crystal.status = "crystallized";
    crystal.confidence = Math.max(crystal.confidence, 0.88);
    crystal.updatedAt = nowIso;

    // 时效更替：同 topicKey 下此前处于 crystallized 的旧星晶自动置为 superseded
    for (const other of state.crystals) {
      if (
        other.id !== crystal.id &&
        other.topicKey === crystal.topicKey &&
        other.status === "crystallized"
      ) {
        other.status = "superseded";
        other.supersededBy = crystal.id;
        other.supersededAt = nowIso;
        other.updatedAt = nowIso;
      }
    }

    // 同步至本双人空间专属 SugentKnowledgeGraph（exclusive: true 自动归档旧边）
    const kg = this.getSpaceGraph(state.spaceId);
    const spaceNodeId = `duo:${state.spaceId}`;
    const crystalNodeId = `crystal:${crystal.id}`;
    kg.applyDelta(
      {
        nodes: [
          {
            id: spaceNodeId,
            kind: "concept",
            name: `双星关系空间 (${state.spaceId})`,
            summary: "物理隔离的双人关系星晶锚点",
            tags: ["duo_space"],
          },
          {
            id: crystalNodeId,
            kind: crystal.kind === "friction_antidote" ? "workflow" : "preference",
            name: crystal.title,
            summary: crystal.summary,
            tags: [crystal.kind, crystal.topicKey],
            ...(crystal.gentleAction ? { steps: [crystal.gentleAction] } : {}),
          },
        ],
        edges: [
          {
            from: spaceNodeId,
            relation: `active_topic:${crystal.topicKey}`,
            to: crystalNodeId,
            source: "duo_crystallizer",
            exclusive: true,
          },
        ],
      },
      nowIso,
    );
  }

  /**
   * 伴侣在站内共阅确认、点亮共鸣或温和收起某枚星晶。
   */
  reviewCrystal(params: {
    spaceId?: string;
    crystalId: string;
    actor: DuoPartnerRole;
    action: "endorse" | "crystallize" | "dismiss";
    supersedeCrystalId?: string;
  }): DuoCrystal {
    const state = this.loadSpace(params.spaceId);
    const now = this.nowIsoFn();
    const found = state.crystals.find((c) => c.id === params.crystalId);
    if (!found) {
      throw new Error(`Duo crystal not found: ${params.crystalId}`);
    }

    if (params.action === "dismiss") {
      found.status = "archived";
      found.updatedAt = now;
      this.saveSpace(state);
      return { ...found };
    }

    if (!found.endorsedBy.includes(params.actor)) {
      found.endorsedBy.push(params.actor);
    }
    found.confidence = Math.min(0.99, Math.round((found.confidence + 0.2) * 100) / 100);
    found.updatedAt = now;

    if (params.supersedeCrystalId) {
      const explicitOld = state.crystals.find((c) => c.id === params.supersedeCrystalId);
      if (explicitOld && explicitOld.id !== found.id) {
        explicitOld.status = "superseded";
        explicitOld.supersededBy = found.id;
        explicitOld.supersededAt = now;
        explicitOld.updatedAt = now;
      }
    }

    if (params.action === "crystallize" || found.endorsedBy.length >= 2) {
      this.promoteCrystalInternal(state, found, now);
    }

    this.saveSpace(state);
    return { ...found, endorsedBy: [...found.endorsedBy] };
  }

  /**
   * 新增或幂等更新双人微约定（Keep / Adjust / QualityTime / SafetyNet / Wish）。
   */
  upsertCommitment(input: {
    spaceId?: string;
    id?: string;
    category: DuoCommitmentCategory;
    title: string;
    detail: string;
    proposer: DuoPartnerRole | "both";
    sourceRef?: string;
    targetPeriod?: string;
  }): DuoMicroCommitment {
    assertDuoNoSecrets([input.title, input.detail], "commitment");
    const state = this.loadSpace(input.spaceId);
    const now = this.nowIsoFn();
    const category = VALID_COMMITMENT_CATEGORIES.has(input.category)
      ? input.category
      : "wish";

    const existing = state.commitments.find(
      (m) =>
        (input.id && m.id === input.id) ||
        (input.sourceRef && m.sourceRef === input.sourceRef && m.category === category) ||
        (m.title.trim() === input.title.trim() && m.status !== "archived"),
    );

    if (existing) {
      existing.title = input.title.trim();
      existing.detail = input.detail.trim();
      if (input.targetPeriod) existing.targetPeriod = input.targetPeriod;
      existing.updatedAt = now;
      this.saveSpace(state);
      return { ...existing };
    }

    const created: DuoMicroCommitment = {
      id: input.id?.trim() || `dcom-${crypto.randomUUID().slice(0, 8)}`,
      spaceId: state.spaceId,
      category,
      title: input.title.trim(),
      detail: input.detail.trim(),
      proposer: input.proposer,
      status: "active",
      echoCount: 0,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.targetPeriod ? { targetPeriod: input.targetPeriod } : {}),
      createdAt: now,
      updatedAt: now,
    };
    state.commitments.push(created);
    this.saveSpace(state);
    return { ...created };
  }

  /**
   * 记录双人微约定的温暖回响或标记达成。
   */
  updateCommitment(params: {
    spaceId?: string;
    commitmentId: string;
    action: "echo" | "fulfill" | "archive";
    echoNote?: string;
  }): DuoMicroCommitment {
    assertDuoNoSecrets([params.echoNote], "commitment.echoNote");
    const state = this.loadSpace(params.spaceId);
    const now = this.nowIsoFn();
    const item = state.commitments.find((c) => c.id === params.commitmentId);
    if (!item) {
      throw new Error(`Duo commitment not found: ${params.commitmentId}`);
    }
    if (params.action === "echo") {
      item.echoCount += 1;
      item.status = "echoed";
      if (params.echoNote?.trim()) item.lastEchoNote = params.echoNote.trim();
    } else if (params.action === "fulfill") {
      item.status = "fulfilled";
      if (params.echoNote?.trim()) item.lastEchoNote = params.echoNote.trim();
    } else {
      item.status = "archived";
    }
    item.updatedAt = now;
    this.saveSpace(state);
    return { ...item };
  }

  private sealDuoPayload(params: {
    spaceId: string;
    source: string;
    eventType: string;
    eventId: string;
    title: string;
    body: string;
    extra?: Record<string, unknown>;
  }) {
    const sealWorkspaceDir = path.join(this.spaceDir(params.spaceId), "seal-workspace");
    fs.mkdirSync(sealWorkspaceDir, { recursive: true, mode: 0o700 });
    return sealExternalEvent({
      workspaceDir: sealWorkspaceDir,
      source: params.source,
      eventType: params.eventType,
      eventId: params.eventId.replace(/[^A-Za-z0-9._:-]+/g, "_"),
      title: params.title,
      body: params.body,
      payload: {
        title: params.title,
        body: params.body,
        receivedAt: this.nowIsoFn(),
        ...(params.extra ?? {}),
      },
      privilegedFieldMode: "strip",
    }).envelope;
  }

  /**
   * 跨源总结分析与记忆晶化主流程：
   * 1. 先经 `sealExternalEvent` 将外部输入密封为 `0o400` 安全信封；
   * 2. 自动从已解锁月度校准提取双人微约定；
   * 3. 经 `steward` / `executor` 角色网关（或离线确定性提炼器）输出深度复盘报告与候选关系星晶。
   */
  async crystallizeAndSynthesize(bundle: DuoSourceBundle): Promise<{
    envelope: { contextFile: string; sha256: string };
    report: DuoSynthesisReport;
    proposedCrystals: DuoCrystal[];
    proposedCommitments: DuoMicroCommitment[];
    vault: DuoVaultSnapshot;
  }> {
    const spaceId = sanitizeDuoSpaceId(bundle.spaceId);
    const state = this.loadSpace(spaceId);
    const labels = bundle.partnerLabels ?? { M: "Andy", W: "Gillna" };
    const scopeType: DuoSynthesisScope = bundle.scopeType ?? "30d";
    const now = this.nowIsoFn();

    const serializedInput = JSON.stringify({
      scopeType,
      topicQuery: bundle.topicQuery ?? "",
      diaries: (bundle.diaries ?? []).slice(0, 20),
      events: (bundle.events ?? []).slice(0, 20),
      reconciles: (bundle.reconciles ?? []).slice(0, 6),
      chatSlices: (bundle.chatSlices ?? []).slice(0, 40),
      stewardTurns: (bundle.stewardTurns ?? []).slice(0, 20),
    });

    const sealed = this.sealDuoPayload({
      spaceId,
      source: "duo_site_bundle",
      eventType: `duo_synthesis_${scopeType}`,
      eventId: `syn-${Date.now()}`,
      title: `Duo Synthesis (${spaceId})`,
      body: serializedInput,
    });

    const proposedCommitments: DuoMicroCommitment[] = [];
    for (const rec of bundle.reconciles ?? []) {
      const month = rec.targetMonth || now.slice(0, 7);
      const authorLabel = rec.author === "M" ? labels.M : labels.W;
      const slots: Array<{ cat: DuoCommitmentCategory; label: string; val?: string }> = [
        { cat: "keep", label: `${month} 继续保持`, val: rec.actionKeep },
        { cat: "adjust", label: `${month} 温和微调`, val: rec.actionAdjust },
        { cat: "quality_time", label: `${month} 高质共处`, val: rec.actionQualityTime },
        { cat: "safety_net", label: `${month} 安全网约定`, val: rec.actionSafetyNet },
      ];
      for (const s of slots) {
        const cleanVal = String(s.val ?? "").trim();
        if (!cleanVal || cleanVal === "无" || looksSecret(cleanVal)) continue;
        const upserted = this.upsertCommitment({
          spaceId,
          category: s.cat,
          title: `${authorLabel} · ${s.label}`,
          detail: cleanVal.slice(0, 240),
          proposer: rec.author,
          sourceRef: `reconcile:${month}:${rec.author}:${s.cat}`,
          targetPeriod: month,
        });
        proposedCommitments.push(upserted);
      }
    }

    const activeCrystalsSummary = state.crystals
      .filter((c) => c.status === "crystallized")
      .map((c) => `- [topic:${c.topicKey}] ${c.title}: ${c.summary}`)
      .join("\n");

    const systemPrompt = [
      `你是「Sugent · 星轨幕僚」的跨源总结与记忆晶化架构师，服务于 ${labels.M} (Pluto) 与 ${labels.W} (Charon)。`,
      "请严格基于真实记录（共享日志、大事纪、校准记录、聊天与对话切片）完成深度关系复盘，并提炼 1~3 枚值得长期沉淀的「关系星晶（candidates）」与可选「双人微约定（commitments）」。",
      "若新提炼的规律覆盖或升级了下方已有星晶的同一主题，请复用完全相同的 topicKey 以便系统自动执行时效更替（不翻旧账）。",
      "平等温柔对待双方，禁止提及分数或 MBTI 术语，禁止编造未发生的事实。只输出合法 JSON：",
      JSON.stringify({
        headline: "12~22字温润档案标题",
        orbitPulseSummary: "160~260字核心轨道脉搏综述",
        keyHighlights: ["高光共鸣与温存细节1", "细节2"],
        tensionAndRepair: ["张力观察与无指责调频建议1"],
        agreementEchoes: ["对近期微约定的回响观察1"],
        closingQuestion: "一句面向星空与相处的留白发问",
        crystals: [
          {
            topicKey: "decision-pace-alignment",
            kind: "consensus_tacit|friction_antidote|stage_evolution|micro_card",
            title: "晶体名称",
            summary: "高密度规律描述",
            orbitalMetaphor: "星轨天体隐喻",
            triggerSignal: "何时容易触发",
            gentleAction: "温和可执行的双人调频动作",
            evidenceRefs: ["日志/纪事日期或标题"],
          },
        ],
        commitments: [
          {
            category: "keep|adjust|quality_time|safety_net|wish",
            title: "微约定短标题",
            detail: "具体温柔约定内容",
            proposer: "M|W|both",
          },
        ],
      }),
    ].join("\n");

    const userPrompt = [
      `【当前已生效星晶】:\n${activeCrystalsSummary || "暂无"}`,
      bundle.topicQuery ? `【聚焦议题】: ${bundle.topicQuery}` : "",
      bundle.synastrySummary ? `【合盘相位底色】:\n${bundle.synastrySummary}` : "",
      `【已密封真实素材 JSON (sha256=${sealed.sha256.slice(0, 12)})】:\n${serializedInput.slice(0, 12000)}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const llmRes = await this.callRoleChatJson({
      role: "executor",
      systemPrompt,
      userPrompt,
      temperature: 0.45,
    });

    const parsed = llmRes ? extractFirstJsonObject(llmRes.text) : null;
    const proposedCrystals: DuoCrystal[] = [];

    if (parsed) {
      for (const rawC of Array.isArray(parsed.crystals) ? parsed.crystals.slice(0, 4) : []) {
        if (!rawC?.title || !rawC?.summary) continue;
        if (looksSecret(String(rawC.title)) || looksSecret(String(rawC.summary))) continue;
        const c = this.upsertCrystal({
          spaceId,
          topicKey: String(rawC.topicKey || rawC.title),
          kind: VALID_CRYSTAL_KINDS.has(rawC.kind) ? rawC.kind : "consensus_tacit",
          title: String(rawC.title),
          summary: String(rawC.summary),
          orbitalMetaphor: rawC.orbitalMetaphor ? String(rawC.orbitalMetaphor) : undefined,
          triggerSignal: rawC.triggerSignal ? String(rawC.triggerSignal) : undefined,
          gentleAction: rawC.gentleAction ? String(rawC.gentleAction) : undefined,
          evidenceRefs: Array.isArray(rawC.evidenceRefs) ? rawC.evidenceRefs.map(String) : [],
          sourcePeriod: now.slice(0, 7),
        });
        proposedCrystals.push(c);
      }

      for (const rawM of Array.isArray(parsed.commitments) ? parsed.commitments.slice(0, 3) : []) {
        if (!rawM?.title || !rawM?.detail) continue;
        if (looksSecret(String(rawM.title)) || looksSecret(String(rawM.detail))) continue;
        const proposer: DuoPartnerRole | "both" =
          rawM.proposer === "M" || rawM.proposer === "W" ? rawM.proposer : "both";
        const m = this.upsertCommitment({
          spaceId,
          category: VALID_COMMITMENT_CATEGORIES.has(rawM.category) ? rawM.category : "wish",
          title: String(rawM.title),
          detail: String(rawM.detail),
          proposer,
          targetPeriod: now.slice(0, 7),
        });
        proposedCommitments.push(m);
      }
    } else {
      // `mode: "none"` 或网关离线时的确定性晶化回退
      const deterministic = this.extractDeterministicFallback(spaceId, bundle, labels, now);
      proposedCrystals.push(...deterministic);
    }

    const scopeLabel =
      scopeType === "topic" && bundle.topicQuery
        ? `专题深潜：${bundle.topicQuery.slice(0, 28)}`
        : scopeType === "7d"
          ? "近 7 日双星轨道复盘"
          : scopeType === "quarter"
            ? "季度星轨演化长卷"
            : "近 30 日双星全景复盘";

    const report: DuoSynthesisReport = {
      id: `dsyn-${crypto.randomUUID().slice(0, 8)}`,
      spaceId,
      scopeType,
      scopeLabel,
      requestedBy: bundle.requestedBy ?? "M",
      headline:
        typeof parsed?.headline === "string" && parsed.headline.trim()
          ? parsed.headline.trim()
          : `${scopeLabel} · 双星引力与默契校准`,
      orbitPulseSummary:
        typeof parsed?.orbitPulseSummary === "string" && parsed.orbitPulseSummary.trim()
          ? parsed.orbitPulseSummary.trim()
          : this.buildDeterministicSummaryText(bundle, labels, proposedCrystals, proposedCommitments),
      keyHighlights: Array.isArray(parsed?.keyHighlights)
        ? parsed.keyHighlights.map(String).slice(0, 5)
        : (bundle.diaries ?? [])
            .slice(0, 3)
            .map((d) => `[${d.date}] ${d.author === "M" ? labels.M : labels.W}《${d.title}》留下真实心绪印记`),
      tensionAndRepair: Array.isArray(parsed?.tensionAndRepair)
        ? parsed.tensionAndRepair.map(String).slice(0, 4)
        : proposedCrystals
            .filter((c) => c.kind === "friction_antidote")
            .map((c) => `${c.title}：${c.gentleAction || c.summary}`),
      agreementEchoes: Array.isArray(parsed?.agreementEchoes)
        ? parsed.agreementEchoes.map(String).slice(0, 4)
        : proposedCommitments.slice(0, 3).map((m) => `${m.title}：${m.detail}`),
      proposedCrystalIds: proposedCrystals.map((c) => c.id),
      proposedCommitmentIds: proposedCommitments.map((m) => m.id),
      closingQuestion:
        typeof parsed?.closingQuestion === "string" && parsed.closingQuestion.trim()
          ? parsed.closingQuestion.trim()
          : "在接下来的星轨周期里，哪一件看似微小的日常陪伴，最值得成为你们彼此心照不宣的引力锚点？",
      modelUsed: llmRes?.modelUsed ?? "sugent-deterministic-fallback",
      createdAt: now,
    };

    state.reports.push(report);
    if (state.reports.length > 24) {
      state.reports.splice(0, state.reports.length - 24);
    }
    this.saveSpace(state);

    return {
      envelope: { contextFile: sealed.contextFile, sha256: sealed.sha256 },
      report,
      proposedCrystals,
      proposedCommitments,
      vault: this.getVaultSnapshot(spaceId, bundle.topicQuery),
    };
  }

  private extractDeterministicFallback(
    spaceId: string,
    bundle: DuoSourceBundle,
    labels: { M: string; W: string },
    nowIso: string,
  ): DuoCrystal[] {
    const out: DuoCrystal[] = [];
    const latestDiary = bundle.diaries?.[0];
    if (latestDiary && !looksSecret(latestDiary.content)) {
      out.push(
        this.upsertCrystal({
          spaceId,
          topicKey: `diary-resonance-${normalizeCrystalTopicKey(latestDiary.title).slice(0, 24)}`,
          kind: "consensus_tacit",
          title: `围绕《${latestDiary.title.slice(0, 18)}》的日常心意在场`,
          summary: `${latestDiary.author === "M" ? labels.M : labels.W} 在 ${latestDiary.date} 记录下真实感受，持续用文字保留彼此可见的情感窗口。`,
          orbitalMetaphor: "双星在近点交换微光信标，避免在忙碌惯性中滑入静默盲区。",
          gentleAction: "阅读伴侣日志后留下一句具体呼应，而非仅停留在心内默念。",
          evidenceRefs: [`diary:${latestDiary.date}:${latestDiary.title}`],
          sourcePeriod: nowIso.slice(0, 7),
        }),
      );
    }

    const adjustRec = (bundle.reconciles ?? []).find((r) => r.actionAdjust && r.actionAdjust.trim());
    if (adjustRec?.actionAdjust && !looksSecret(adjustRec.actionAdjust)) {
      out.push(
        this.upsertCrystal({
          spaceId,
          topicKey: `reconcile-adjust-${adjustRec.targetMonth}`,
          kind: "friction_antidote",
          title: `${adjustRec.targetMonth} 轨道微调配方`,
          summary: `双方在月度校准中识别出需温和微调的摩擦点：${adjustRec.actionAdjust.trim().slice(0, 120)}`,
          triggerSignal: "节奏过载或决策步调不一致时的防御性紧绷",
          gentleAction: adjustRec.actionSafetyNet?.trim() || "先确认彼此在场与安全感，再展开具体事务讨论。",
          evidenceRefs: [`reconcile:${adjustRec.targetMonth}`],
          sourcePeriod: adjustRec.targetMonth,
        }),
      );
    }

    if (out.length === 0 && (bundle.stewardTurns?.length ?? 0) > 0) {
      const lastUser = [...(bundle.stewardTurns ?? [])].reverse().find((t) => t.role === "user");
      if (lastUser && !looksSecret(lastUser.content)) {
        out.push(
          this.upsertCrystal({
            spaceId,
            topicKey: `dialogue-${normalizeCrystalTopicKey(lastUser.content).slice(0, 24)}`,
            kind: "stage_evolution",
            title: "主动复盘与双星视角对齐",
            summary: `围绕「${lastUser.content.slice(0, 48)}」发起主动对齐，将模糊情绪转化为可共阅的关系认知。`,
            gentleAction: "在站内星晶面板共同审阅并点亮共鸣。",
            evidenceRefs: [`chat:${nowIso.slice(0, 10)}`],
            sourcePeriod: nowIso.slice(0, 7),
          }),
        );
      }
    }
    return out;
  }

  private buildDeterministicSummaryText(
    bundle: DuoSourceBundle,
    labels: { M: string; W: string },
    crystals: readonly DuoCrystal[],
    commitments: readonly DuoMicroCommitment[],
  ): string {
    const dCount = bundle.diaries?.length ?? 0;
    const eCount = bundle.events?.length ?? 0;
    const rCount = bundle.reconciles?.length ?? 0;
    return `${labels.M} 与 ${labels.W} 在本周期共汇入 ${dCount} 篇共享星尘日志、${eCount} 项岁月纪事与 ${rCount} 份校准记录。Sugent 已从中凝练 ${crystals.length} 枚关系星晶候选与 ${commitments.length} 项微约定，持续以最新稳态认知守护双星运行。`;
  }

  /**
   * 联邦「Sugent · 星轨幕僚」对话接口（走 `executor` 角色网关 + 自动注入空间生效星晶与微约定）。
   */
  async converseAsDuoSteward(params: {
    spaceId?: string;
    speaker: DuoPartnerRole;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    partnerLabels?: { M: string; W: string };
    baselineContext?: string;
    episodicContext?: string;
    retrievedContext?: string;
  }): Promise<{
    ok: boolean;
    reply: string;
    modelUsed: string;
    activeCrystalCount: number;
    activeCommitmentCount: number;
  }> {
    const spaceId = sanitizeDuoSpaceId(params.spaceId);
    const vault = this.getVaultSnapshot(spaceId);
    const lastUser = [...params.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    this.sealDuoPayload({
      spaceId,
      source: "duo_site_chat",
      eventType: "duo_chat_turn",
      eventId: `turn-${Date.now()}`,
      title: `Duo Chat (${params.speaker})`,
      body: lastUser || "(empty)",
    });

    const systemPrompt = buildDuoStewardSystemPrompt({
      speaker: params.speaker,
      partnerLabels: params.partnerLabels,
      activeCrystals: vault.crystals.crystallized,
      activeCommitments: vault.commitments,
      baselineContext: params.baselineContext,
      episodicContext: params.episodicContext,
      retrievedContext: params.retrievedContext,
    });

    const transcriptPrompt = params.messages
      .slice(-16)
      .map((m) => `${m.role === "assistant" ? "Sugent" : "提问者"}: ${m.content}`)
      .join("\n\n");

    const llmRes = await this.callRoleChatJson({
      role: "executor",
      systemPrompt,
      userPrompt: transcriptPrompt,
      temperature: 0.72,
    });

    const activeCommitmentCount = vault.commitments.filter(
      (c) => c.status === "active" || c.status === "echoed",
    ).length;

    if (llmRes) {
      return {
        ok: true,
        reply: llmRes.text,
        modelUsed: llmRes.modelUsed,
        activeCrystalCount: vault.crystals.crystallized.length,
        activeCommitmentCount,
      };
    }

    return {
      ok: true,
      reply: `Sugent · 星轨幕僚已对齐当前 ${vault.crystals.crystallized.length} 枚生效关系星晶与 ${activeCommitmentCount} 项双人微约定（当前处于本地离线主权模式，待在线模型网关就绪后即可展开完整深度推演）。当你们回望近期最想守护的一处默契时，最先浮现的是哪一个瞬间？`,
      modelUsed: "sugent-offline-steward",
      activeCrystalCount: vault.crystals.crystallized.length,
      activeCommitmentCount,
    };
  }

  /**
   * 预留微信助理号（Wave P3 `agent-wechat`）双人小群安全接入扩展口：
   * - 仅允许白名单 `groupId` 进入；
   * - 自动剔除机器人自发回环（`selfEnvoyWxid`）；
   * - 100% 经 `0o400` 安全信封隔离后转入关系星晶提炼，零外发群消息。
   */
  async ingestEnvoyDuoGroupSlice(params: {
    spaceId?: string;
    groupId: string;
    messages: DuoEnvoyGroupMessageInput[];
  }): Promise<{
    accepted: boolean;
    reason?: string;
    ingestedCount: number;
    proposedCrystals: DuoCrystal[];
  }> {
    const cleanGroup = String(params.groupId ?? "").trim();
    if (!cleanGroup || !this.allowedGroupIds.has(cleanGroup)) {
      return {
        accepted: false,
        reason: "group_not_in_duo_allowlist",
        ingestedCount: 0,
        proposedCrystals: [],
      };
    }

    const selfId = String(this.opts.selfEnvoyWxid ?? "").trim();
    const filtered = params.messages.filter(
      (m) => m.text?.trim() && (!selfId || m.senderId !== selfId),
    );
    if (filtered.length === 0) {
      return { accepted: true, ingestedCount: 0, proposedCrystals: [] };
    }

    const spaceId = sanitizeDuoSpaceId(params.spaceId);
    for (const msg of filtered) {
      this.sealDuoPayload({
        spaceId,
        source: "wechat_envoy_duo_group",
        eventType: "duo_group_message",
        eventId: msg.messageId,
        title: `Duo Group ${cleanGroup}`,
        body: msg.text,
        extra: msg.rawExtra,
      });
    }

    const res = await this.crystallizeAndSynthesize({
      spaceId,
      scopeType: "7d",
      requestedBy: "cron",
      chatSlices: filtered.map((m) => ({
        timestamp: m.atIso ?? this.nowIsoFn(),
        sender: m.senderPartnerRole ?? "M",
        content: m.text,
      })),
    });

    return {
      accepted: true,
      ingestedCount: filtered.length,
      proposedCrystals: res.proposedCrystals,
    };
  }
}
