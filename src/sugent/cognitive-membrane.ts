/**
 * 认知边界膜与对称隐私口袋（src/sugent/cognitive-membrane.ts）
 *
 * 实现 Wave P4.4 M1-M4 与 Wave P5.3 M5：
 * - M1: 伴侣状态天气胶囊（纯枚举零自由文本）与金丝雀零泄露门禁
 * - M2: 对称隐私口袋（M/W 物理隔离 + 可选 AES-256-GCM 口令加密 + 显式提炼晋升）
 * - M3: 双人共识单向投影至主理人生活面锚点（禁止 raw_episodic 跨面）
 * - M4: 脱敏关系启发式沉淀至硅基自我核心（剥离姓名与日期）
 * - M5: 外事礼宾半透膜（concierge_envoy 脱敏对方沟通偏好 + 表面隔离教训 + 外发零金丝雀泄露）
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { looksSecret } from "../agent/memory.js";
import type {
  DuoCrystal,
  DuoPartnerRole,
  DuoStewardCrystallizer,
  DuoVaultSnapshot,
} from "./duo-steward-crystallizer.js";
import type { EpistemicDigestionLoop } from "./silicon-identity-core.js";
import type {
  AtlasEdgeInput,
  AtlasNodeInput,
  StereoscopicAtlas,
} from "./stereoscopic-atlas.js";
import type { LedgerSnapshot } from "./stewardship-ledger.js";

export type MembraneErrorCode =
  | "MEMBRANE_CANARY_LEAK"
  | "MEMBRANE_PRINCIPAL_DENIED"
  | "MEMBRANE_SECRET_REJECTED";

export class MembraneError extends Error {
  constructor(
    readonly code: MembraneErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "MembraneError";
  }
}

export interface PartnerWeatherCapsule {
  version: 1;
  spaceId: string;
  subject: DuoPartnerRole;
  cognitiveLoad: "calm" | "focused" | "high_sustained" | "overloaded";
  restDeficit: boolean;
  recoveryMode: "open_dialogue" | "gentle_checkin" | "quiet_compression";
  busyWindowHint: "clear" | "daytime_focus" | "weeknight_crunch" | "deadline_sprint";
  openCommitmentPressure: "low" | "moderate" | "elevated";
  generatedAt: string;
}

export interface OwnerDuoAnchor {
  id: string;
  spaceId: string;
  kind: "crystal" | "micro_commitment";
  title: string;
  detail: string;
  protectedWindowKeywords: string[];
  updatedAt: string;
}

export interface PocketNoteRecord {
  id: string;
  spaceId: string;
  owner: DuoPartnerRole;
  topicHint: string;
  encrypted: boolean;
  content?: string;
  ciphertextB64?: string;
  ivB64?: string;
  tagB64?: string;
  saltB64?: string;
  promotedCrystalId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DeidentifiedRelationalHeuristic {
  id: string;
  topicKey: string;
  heuristic: string;
  sourceCrystalId: string;
  updatedAt: string;
}

export interface ConciergeEnvoyTasteCapsule {
  version: 1;
  peerId: string;
  formality: "formal_respectful" | "balanced_professional" | "casual_direct";
  brevity: "short_3_lines" | "structured_concise" | "detailed_context";
  styleDirectives: string[];
  envoyCalibratedLessons: string[];
  generatedAt: string;
}

const CURRENCY_AMOUNT_RE =
  /(?:¥|\$|￥|\d+(?:\.\d+)?\s*(?:万元|万|元|块)|\b\d+(?:\.\d+)?\s*(?:usd|rmb|cny|hkd|eur|sol|usdc|usdt)\b|\b(?:usd|rmb|cny|hkd)\s*\d+)/i;
const FS_PATH_RE = /(?:\/Users\/|\/home\/|[A-Za-z]:\\)/;

function sanitizeSpaceId(raw?: string): string {
  const cleaned = String(raw ?? "andy-gillna")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return cleaned || "andy-gillna";
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

/**
 * M1: 纯数值与状态标志蒸馏伴侣天气胶囊（严禁读取或复制任何账本自由文本）。
 */
export function distillPartnerWeatherCapsule(input: {
  spaceId?: string;
  subject?: DuoPartnerRole;
  ledger?: LedgerSnapshot;
  runningSessionCount?: number;
  quietHoursActive?: boolean;
  recentDropCount?: number;
  nowIso?: string;
}): PartnerWeatherCapsule {
  const nowIso = input.nowIso ?? new Date().toISOString();
  const nowMs = Number.isFinite(Date.parse(nowIso)) ? Date.parse(nowIso) : Date.now();
  const running = Math.max(0, Number(input.runningSessionCount ?? 0));
  const drops = Math.max(0, Number(input.recentDropCount ?? 0));
  const quietHours = Boolean(input.quietHoursActive);

  let openCommitmentsCount = 0;
  let urgentDeadlineCount = 0;
  let nearDeadlineCount = 0;
  for (const item of input.ledger?.commitments ?? []) {
    if (item.status !== "open" && item.status !== "waiting_review") continue;
    openCommitmentsCount++;
    if (!item.dueAt) continue;
    const dueMs = Date.parse(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    const deltaMs = dueMs - nowMs;
    if (deltaMs <= 2 * 86_400_000) urgentDeadlineCount++;
    else if (deltaMs <= 7 * 86_400_000) nearDeadlineCount++;
  }

  let activeGoalCount = 0;
  let goalUrgentCount = 0;
  for (const goal of input.ledger?.goals ?? []) {
    if (goal.status !== "active") continue;
    activeGoalCount++;
    if (!goal.targetDateIso) continue;
    const targetMs = Date.parse(goal.targetDateIso);
    if (Number.isFinite(targetMs) && targetMs - nowMs <= 7 * 86_400_000) {
      goalUrgentCount++;
    }
  }

  const openCommitmentPressure: PartnerWeatherCapsule["openCommitmentPressure"] =
    openCommitmentsCount >= 6 || urgentDeadlineCount >= 2
      ? "elevated"
      : openCommitmentsCount >= 3 || urgentDeadlineCount >= 1 || nearDeadlineCount >= 2
        ? "moderate"
        : "low";

  const cognitiveLoad: PartnerWeatherCapsule["cognitiveLoad"] =
    running >= 4 || (running >= 2 && urgentDeadlineCount >= 2) || (openCommitmentsCount >= 8 && urgentDeadlineCount >= 1)
      ? "overloaded"
      : running >= 2 || urgentDeadlineCount >= 1 || openCommitmentsCount >= 5 || drops >= 4
        ? "high_sustained"
        : running === 1 || activeGoalCount >= 2 || nearDeadlineCount >= 1 || openCommitmentsCount >= 2 || drops >= 1
          ? "focused"
          : "calm";

  const restDeficit =
    Boolean(quietHours && (running > 0 || drops >= 2)) || cognitiveLoad === "overloaded";

  const recoveryMode: PartnerWeatherCapsule["recoveryMode"] =
    cognitiveLoad === "overloaded" || restDeficit
      ? "quiet_compression"
      : cognitiveLoad === "high_sustained" || openCommitmentPressure === "elevated"
        ? "gentle_checkin"
        : "open_dialogue";

  const busyWindowHint: PartnerWeatherCapsule["busyWindowHint"] =
    urgentDeadlineCount >= 1 || goalUrgentCount >= 1
      ? "deadline_sprint"
      : quietHours && (running > 0 || cognitiveLoad === "high_sustained" || cognitiveLoad === "overloaded")
        ? "weeknight_crunch"
        : running >= 1 || cognitiveLoad === "focused" || cognitiveLoad === "high_sustained"
          ? "daytime_focus"
          : "clear";

  return {
    version: 1,
    spaceId: sanitizeSpaceId(input.spaceId),
    subject: input.subject ?? "M",
    cognitiveLoad,
    restDeficit,
    recoveryMode,
    busyWindowHint,
    openCommitmentPressure,
    generatedAt: nowIso,
  };
}

/**
 * M1: 零金丝雀泄露断言，拦截密钥、金额、本机路径与主理人私有金丝雀词元。
 */
export function assertZeroCanaryLeak(
  text: string,
  forbiddenTokens?: readonly string[],
): void {
  const value = String(text ?? "");
  if (looksSecret(value)) {
    throw new MembraneError("MEMBRANE_CANARY_LEAK", "Secret pattern detected in membrane payload");
  }
  if (CURRENCY_AMOUNT_RE.test(value)) {
    throw new MembraneError("MEMBRANE_CANARY_LEAK", "Currency or monetary amount detected in membrane payload");
  }
  if (FS_PATH_RE.test(value)) {
    throw new MembraneError("MEMBRANE_CANARY_LEAK", "Local filesystem path detected in membrane payload");
  }
  const lower = value.toLowerCase();
  for (const rawTok of forbiddenTokens ?? []) {
    const clean = String(rawTok ?? "").trim();
    if (clean.length >= 2 && lower.includes(clean.toLowerCase())) {
      throw new MembraneError("MEMBRANE_CANARY_LEAK", "Forbidden canary token detected in membrane payload");
    }
  }
}

/**
 * M1: 将枚举天气胶囊渲染为温和不泄密的星轨对话语境提示。
 */
export function renderWeatherCapsuleForDuoPrompt(
  capsule: PartnerWeatherCapsule,
  partnerLabel: string,
  forbiddenCanaryTokens?: readonly string[],
): string {
  const loadText: Record<PartnerWeatherCapsule["cognitiveLoad"], string> = {
    calm: "心智余量舒展从容",
    focused: "正处于稳定专注推进期",
    high_sustained: "处于持续高负荷运转期，能量略微吃紧",
    overloaded: "当前认知负荷接近过载阈值，需要温柔减压与留白",
  };
  const recoveryText: Record<PartnerWeatherCapsule["recoveryMode"], string> = {
    open_dialogue: "适合展开轻松从容的对谈与共鸣",
    gentle_checkin: "建议先轻柔报备在场与体感，再缓慢切入正题",
    quiet_compression: "宜先给予安静的喘息压缩空间，避免密集追问或加压",
  };
  const windowText: Record<PartnerWeatherCapsule["busyWindowHint"], string> = {
    clear: "时间窗相对宽松",
    daytime_focus: "日间处于专注工作流中",
    weeknight_crunch: "夜间仍在赶工收口阶段",
    deadline_sprint: "正处关键节点冲刺窗口",
  };
  const pressureText: Record<PartnerWeatherCapsule["openCommitmentPressure"], string> = {
    low: "待办承压较低",
    moderate: "手头有适度在途待办",
    elevated: "外部承诺承压偏高，需减少额外摩擦",
  };
  const restText = capsule.restDeficit ? "，且存在休息不足信号" : "";
  const rendered = [
    "=== 伴侣近期星轨天气胶囊（脱敏边界态） ===",
    `${partnerLabel} 近期状态：${loadText[capsule.cognitiveLoad]}${restText}；${windowText[capsule.busyWindowHint]}，${pressureText[capsule.openCommitmentPressure]}。`,
    `相处调频建议：${recoveryText[capsule.recoveryMode]}（严禁刺探或追问具体工作金额、项目细节或私人路径）。`,
  ].join("\n");
  assertZeroCanaryLeak(rendered, forbiddenCanaryTokens);
  return rendered;
}

interface PersistedPocketFile {
  version: 1;
  spaceId: string;
  owner: DuoPartnerRole;
  updatedAt: string;
  notes: PocketNoteRecord[];
}

/**
 * M2: 对称隐私口袋保险库（M/W 物理分文件隔离，支持可选 AES-256-GCM 口令加密与显式晋升）。
 */
export class SymmetricPrivatePocketVault {
  private readonly duoRootDir: string;
  private readonly nowIsoFn: () => string;

  constructor(opts: { duoRootDir: string; nowIso?: () => string }) {
    this.duoRootDir = path.resolve(opts.duoRootDir);
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
  }

  private pocketFilePath(spaceId: string, owner: DuoPartnerRole): string {
    const safeSpace = sanitizeSpaceId(spaceId);
    return path.join(this.duoRootDir, safeSpace, "pockets", `${owner}.pocket.json`);
  }

  private loadPocket(spaceId: string, owner: DuoPartnerRole): PersistedPocketFile {
    const safeSpace = sanitizeSpaceId(spaceId);
    const file = this.pocketFilePath(safeSpace, owner);
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedPocketFile;
        if (parsed && parsed.version === 1 && Array.isArray(parsed.notes)) {
          return parsed;
        }
      } catch {
        /* fallback to fresh pocket */
      }
    }
    return {
      version: 1,
      spaceId: safeSpace,
      owner,
      updatedAt: this.nowIsoFn(),
      notes: [],
    };
  }

  private savePocket(pocket: PersistedPocketFile): void {
    pocket.updatedAt = this.nowIsoFn();
    writeAtomic600(this.pocketFilePath(pocket.spaceId, pocket.owner), pocket);
  }

  putPrivateNote(params: {
    spaceId?: string;
    actor: DuoPartnerRole;
    content: string;
    topicHint?: string;
    passphrase?: string;
    nowIso?: string;
  }): PocketNoteRecord {
    const content = String(params.content ?? "").trim();
    const topicHint = String(params.topicHint ?? "private-reflection").trim() || "private-reflection";
    if (!content) {
      throw new MembraneError("MEMBRANE_SECRET_REJECTED", "Private note content cannot be empty");
    }
    if (looksSecret(content) || looksSecret(topicHint)) {
      throw new MembraneError("MEMBRANE_SECRET_REJECTED", "Refused secret-like content in private pocket note");
    }

    const safeSpace = sanitizeSpaceId(params.spaceId);
    const pocket = this.loadPocket(safeSpace, params.actor);
    const now = params.nowIso ?? this.nowIsoFn();
    const id = `pnote-${params.actor.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;

    let record: PocketNoteRecord;
    const passphrase = params.passphrase?.trim();
    if (passphrase) {
      const salt = crypto.randomBytes(16);
      const iv = crypto.randomBytes(12);
      const key = crypto.scryptSync(passphrase, salt, 32);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      record = {
        id,
        spaceId: safeSpace,
        owner: params.actor,
        topicHint,
        encrypted: true,
        ciphertextB64: ciphertext.toString("base64"),
        ivB64: iv.toString("base64"),
        tagB64: tag.toString("base64"),
        saltB64: salt.toString("base64"),
        createdAt: now,
        updatedAt: now,
      };
    } else {
      record = {
        id,
        spaceId: safeSpace,
        owner: params.actor,
        topicHint,
        encrypted: false,
        content,
        createdAt: now,
        updatedAt: now,
      };
    }

    pocket.notes.push(record);
    this.savePocket(pocket);
    return { ...record };
  }

  listPocketNotes(params: {
    spaceId?: string;
    viewer: DuoPartnerRole;
    targetOwner?: DuoPartnerRole;
    passphrase?: string;
  }): PocketNoteRecord[] {
    if (params.targetOwner && params.targetOwner !== params.viewer) {
      throw new MembraneError(
        "MEMBRANE_PRINCIPAL_DENIED",
        "Cross-partner private pocket access is forbidden",
      );
    }
    const safeSpace = sanitizeSpaceId(params.spaceId);
    const pocket = this.loadPocket(safeSpace, params.viewer);
    const passphrase = params.passphrase?.trim();

    return pocket.notes.map((rec) => {
      if (!rec.encrypted) {
        return { ...rec };
      }
      if (!passphrase || !rec.ciphertextB64 || !rec.ivB64 || !rec.tagB64 || !rec.saltB64) {
        return { ...rec, content: "[encrypted]" };
      }
      try {
        const salt = Buffer.from(rec.saltB64, "base64");
        const iv = Buffer.from(rec.ivB64, "base64");
        const tag = Buffer.from(rec.tagB64, "base64");
        const ciphertext = Buffer.from(rec.ciphertextB64, "base64");
        const key = crypto.scryptSync(passphrase, salt, 32);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        return { ...rec, content: plain };
      } catch {
        return { ...rec, content: "[encrypted]" };
      }
    });
  }

  promoteNoteToSharedCandidate(params: {
    spaceId?: string;
    actor: DuoPartnerRole;
    noteId: string;
    title: string;
    summary: string;
    topicKey?: string;
    duo: DuoStewardCrystallizer;
    forbiddenCanaryTokens?: readonly string[];
  }): { note: PocketNoteRecord; crystal: DuoCrystal } {
    const safeSpace = sanitizeSpaceId(params.spaceId);
    const pocket = this.loadPocket(safeSpace, params.actor);
    const found = pocket.notes.find((n) => n.id === params.noteId);
    if (!found) {
      throw new MembraneError(
        "MEMBRANE_PRINCIPAL_DENIED",
        `Private pocket note not found for principal ${params.actor}: ${params.noteId}`,
      );
    }

    assertZeroCanaryLeak(`${params.title}\n${params.summary}`, params.forbiddenCanaryTokens);

    const crystal = params.duo.upsertCrystal({
      spaceId: safeSpace,
      topicKey: params.topicKey || found.topicHint,
      kind: "micro_card",
      title: params.title,
      summary: params.summary,
      endorseBy: params.actor,
    });

    found.promotedCrystalId = crystal.id;
    found.updatedAt = this.nowIsoFn();
    this.savePocket(pocket);
    return { note: { ...found }, crystal };
  }
}

const WINDOW_KEYWORDS = [
  "周五",
  "周六",
  "周日",
  "周末",
  "今晚",
  "明晚",
  "晚上",
  "晚间",
  "傍晚",
  "睡前",
  "周年",
  "生日",
  "纪念日",
  "共处",
  "约会",
  "散步",
  "留白",
  "假期",
  "每周",
  "每月",
] as const;

function extractProtectedWindowKeywords(text: string): string[] {
  const found = new Set<string>();
  for (const kw of WINDOW_KEYWORDS) {
    if (text.includes(kw)) found.add(kw);
  }
  const dateMatches = text.match(/(?:\d{4}-\d{2}-\d{2}|\d{1,2}月\d{1,2}[日号]?|\b\d{1,2}:\d{2}\b|周[一二三四五六日天]|星期[一二三四五六日天])/g) ?? [];
  for (const m of dateMatches) {
    found.add(m);
  }
  return Array.from(found);
}

/**
 * M3: 将双人已晶化星晶与在途微约定单向投影至主理人 `owner_life` 保护锚点（严禁 raw_episodic 跨面）。
 */
export function projectDuoConsensusToOwnerAnchors(params: {
  vault: DuoVaultSnapshot;
  atlas?: StereoscopicAtlas;
  nowIso?: string;
}): OwnerDuoAnchor[] {
  const now = params.nowIso ?? new Date().toISOString();
  const spaceId = sanitizeSpaceId(params.vault.spaceId);
  const anchors: OwnerDuoAnchor[] = [];
  const nodes: AtlasNodeInput[] = [];
  const edges: AtlasEdgeInput[] = [];

  const items: Array<{
    id: string;
    kind: OwnerDuoAnchor["kind"];
    title: string;
    detail: string;
    updatedAt: string;
  }> = [
    ...params.vault.crystals.crystallized.map((c) => ({
      id: c.id,
      kind: "crystal" as const,
      title: c.title,
      detail: c.gentleAction ? `${c.summary}（${c.gentleAction}）` : c.summary,
      updatedAt: c.updatedAt,
    })),
    ...params.vault.commitments
      .filter((m) => m.status === "active" || m.status === "echoed")
      .map((m) => ({
        id: m.id,
        kind: "micro_commitment" as const,
        title: m.title,
        detail: m.detail,
        updatedAt: m.updatedAt,
      })),
  ];

  for (const item of items) {
    const keywords = extractProtectedWindowKeywords(`${item.title} ${item.detail}`);
    anchors.push({
      id: item.id,
      spaceId,
      kind: item.kind,
      title: item.title,
      detail: item.detail,
      protectedWindowKeywords: keywords,
      updatedAt: item.updatedAt,
    });

    if (params.atlas) {
      const relNodeId = `duo-rel:${spaceId}:${item.id}`;
      const ownerNodeId = `duo-anchor:${spaceId}:${item.id}`;
      nodes.push(
        {
          id: relNodeId,
          plane: `relational:duo:${spaceId}`,
          stratum: "crystallized_wisdom",
          kind: item.kind === "micro_commitment" ? "commitment" : "concept",
          name: item.title,
          summary: item.detail,
          tags: ["duo_consensus", ...keywords],
          principalAcl: ["sugent_self", "owner:M", "partner:W"],
          sourceTrust: "mutual_endorsed",
        },
        {
          id: ownerNodeId,
          plane: "owner_life",
          stratum: "verified_fact",
          kind: item.kind === "micro_commitment" ? "commitment" : "guardrail",
          name: item.title,
          summary: item.detail,
          tags: ["duo_anchor", ...keywords],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "mutual_endorsed",
        },
      );
      edges.push({
        from: relNodeId,
        relation: "projects_anchor",
        to: ownerNodeId,
        source: "cognitive_membrane_m3",
        isMembraneEdge: true,
        membranePolicy: "M3_consensus_anchor",
        principalAcl: ["sugent_self", "owner:M"],
      });
    }
  }

  if (params.atlas && nodes.length > 0) {
    params.atlas.applyDelta({ nodes, edges }, now);
  }
  return anchors;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deidentifyRelationalText(
  raw: string,
  partnerNames: readonly string[],
): string {
  let out = String(raw ?? "");
  for (const name of partnerNames) {
    const clean = name.trim();
    if (clean.length < 2) continue;
    out = out.replace(new RegExp(escapeRegex(clean), "gi"), "伴侣");
  }
  out = out
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, "特定日期")
    .replace(/\b\d{4}-\d{1,2}\b/g, "近期阶段")
    .replace(/\d{4}\s*年\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*[日号])?/g, "特定日期")
    .replace(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/g, "特定日期")
    .replace(/\d{1,2}\s*月/g, "当期")
    .replace(/伴侣(?:\s*(?:与|和|&|\/)\s*伴侣)+/g, "双方")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

/**
 * M4: 将已晶化关系经验剥离伴侣姓名与日期后，沉淀为硅基自我核心（`self_core`）的脱敏关系启发式。
 */
export function distillRelationalHeuristicToSelfCore(params: {
  vault: DuoVaultSnapshot;
  partnerLabels?: { M: string; W: string };
  atlas?: StereoscopicAtlas;
  forbiddenCanaryTokens?: readonly string[];
  nowIso?: string;
}): DeidentifiedRelationalHeuristic[] {
  const now = params.nowIso ?? new Date().toISOString();
  const spaceId = sanitizeSpaceId(params.vault.spaceId);
  const partnerNames = Array.from(
    new Set(
      [
        "Andy",
        "Gillna",
        "Pluto",
        "Charon",
        params.partnerLabels?.M ?? "",
        params.partnerLabels?.W ?? "",
      ]
        .map((s) => s.trim())
        .filter((s) => s.length >= 2),
    ),
  );

  const results: DeidentifiedRelationalHeuristic[] = [];
  const nodes: AtlasNodeInput[] = [];
  const edges: AtlasEdgeInput[] = [];

  for (const crystal of params.vault.crystals.crystallized) {
    const rawCore = [
      crystal.triggerSignal ? `触发场景：${crystal.triggerSignal}；` : "",
      crystal.gentleAction ? `调频策略：${crystal.gentleAction}` : crystal.summary,
    ]
      .join("")
      .trim();
    if (!rawCore) continue;

    const heuristic = deidentifyRelationalText(rawCore, partnerNames);
    const cleanTitle = deidentifyRelationalText(crystal.title, partnerNames);
    const canaryList = [...(params.forbiddenCanaryTokens ?? []), ...partnerNames];
    assertZeroCanaryLeak(`${cleanTitle}\n${heuristic}`, canaryList);

    const hash = crypto
      .createHash("sha256")
      .update(`${crystal.topicKey}:${heuristic}`, "utf8")
      .digest("hex")
      .slice(0, 12);
    const id = `self:heuristic:${hash}`;

    results.push({
      id,
      topicKey: crystal.topicKey,
      heuristic,
      sourceCrystalId: crystal.id,
      updatedAt: now,
    });

    if (params.atlas) {
      const relNodeId = `duo-rel:${spaceId}:${crystal.id}`;
      nodes.push(
        {
          id: relNodeId,
          plane: `relational:duo:${spaceId}`,
          stratum: "crystallized_wisdom",
          kind: "concept",
          name: crystal.title,
          summary: crystal.summary,
          tags: ["duo_consensus", crystal.topicKey],
          principalAcl: ["sugent_self", "owner:M", "partner:W"],
          sourceTrust: "mutual_endorsed",
        },
        {
          id,
          plane: "self_core",
          stratum: "digested_state",
          kind: "workflow",
          name: `关系启发：${cleanTitle}`,
          summary: heuristic,
          tags: ["deidentified_heuristic", crystal.kind, crystal.topicKey],
          principalAcl: ["sugent_self", "owner:M"],
          sourceTrust: "deterministic_gate",
        },
      );
      edges.push({
        from: relNodeId,
        relation: "distills_heuristic",
        to: id,
        source: "cognitive_membrane_m4",
        isMembraneEdge: true,
        membranePolicy: "M4_deidentified_wisdom",
        principalAcl: ["sugent_self", "owner:M"],
      });
    }
  }

  if (params.atlas && nodes.length > 0) {
    params.atlas.applyDelta({ nodes, edges }, now);
  }
  return results;
}

function containsMembraneCanary(
  value: string,
  forbiddenCanaryTokens?: readonly string[],
): boolean {
  try {
    assertZeroCanaryLeak(value, forbiddenCanaryTokens);
    return false;
  } catch {
    return true;
  }
}

const NON_ENVOY_SURFACE_TAG_RE = /\b(?:im_owner|duo_mediator|steward_hub|coding_orchestrator|owner_life)\b/i;

/**
 * M5: 蒸馏外事礼宾半透膜品味胶囊（仅导出枚举化沟通风格指引与经 concierge_envoy 表面过滤的校准教训，零泄露主理人隐私与底价）。
 */
export function distillConciergeEnvoyCapsule(params: {
  peerId: string;
  peerPreferences?: readonly string[];
  peerTaboos?: readonly string[];
  mindLoop?: Pick<EpistemicDigestionLoop, "getCalibratedLessons">;
  rawEnvoyLessons?: readonly string[];
  forbiddenCanaryTokens?: readonly string[];
  nowIso?: string;
}): ConciergeEnvoyTasteCapsule {
  const nowIso = params.nowIso ?? new Date().toISOString();
  const rawPeerId = String(params.peerId ?? "").trim() || "external_peer";
  const safePeerId = containsMembraneCanary(rawPeerId) ? "external_peer" : rawPeerId;

  const prefCorpus = (params.peerPreferences ?? []).map((p) => String(p ?? "").trim()).filter(Boolean).join(" ； ");
  const tabooCorpus = (params.peerTaboos ?? []).map((t) => String(t ?? "").trim()).filter(Boolean).join(" ； ");

  const formality: ConciergeEnvoyTasteCapsule["formality"] =
    /(?:正式|克制|敬语|严谨|书面|礼貌|formal|respectful)/i.test(prefCorpus)
      ? "formal_respectful"
      : /(?:口语|直白|轻松|随意|熟人|casual|informal|direct)/i.test(prefCorpus)
        ? "casual_direct"
        : "balanced_professional";

  const brevity: ConciergeEnvoyTasteCapsule["brevity"] =
    /(?:短句|不超过\s*3\s*行|三行|简短|精简|直给结论|只看结论|concise|brief|short|tl;?dr)/i.test(prefCorpus)
      ? "short_3_lines"
      : /(?:展开|前因后果|详细|详尽|背景与依据|完整依据|detailed|thorough|comprehensive)/i.test(prefCorpus)
        ? "detailed_context"
        : "structured_concise";

  const styleDirectives: string[] = [];
  if (brevity === "short_3_lines") {
    styleDirectives.push("篇幅控制：采用短句直给结论，正文控制在3行以内");
  } else if (brevity === "detailed_context") {
    styleDirectives.push("篇幅控制：结构化展开交代前因后果与依据");
  } else {
    styleDirectives.push("篇幅控制：条理清晰、重点先行，避免冗长寒暄");
  }

  if (formality === "formal_respectful") {
    styleDirectives.push("语气风格：保持正式克制、礼貌得体的商务敬语");
  } else if (formality === "casual_direct") {
    styleDirectives.push("语气风格：保持自然直白、平实高效的日常口语");
  } else {
    styleDirectives.push("语气风格：保持温和专业的礼宾沟通基调");
  }

  if (/(?:排期|时段|时间节点|里程碑|schedule|timeline)/i.test(prefCorpus)) {
    styleDirectives.push("表达重点：优先明确可约时段与关键时间节点");
  }
  if (/(?:书面|纪要|文字确认|文档|邮件|written)/i.test(prefCorpus)) {
    styleDirectives.push("交互习惯：倾向书面要点留痕确认，避免模糊口头承诺");
  }
  if (/(?:催太急|催促|施压|逼单)/.test(tabooCorpus)) {
    styleDirectives.push("沟通禁忌：避免急促催办或施压口吻");
  }
  if (/(?:长篇|啰嗦|铺垫过长)/.test(tabooCorpus)) {
    styleDirectives.push("沟通禁忌：避免冗长铺垫");
  }

  const peerSafeCanaryList = (params.forbiddenCanaryTokens ?? []).filter(
    (tok) => String(tok ?? "").trim().toLowerCase() !== safePeerId.toLowerCase(),
  );
  const INTERNAL_PRICING_NOTE_RE = /(?:底价|底线|内部备注|毛利|成本价)/;
  for (const rawPref of (params.peerPreferences ?? []).slice(0, 4)) {
    const item = String(rawPref ?? "").trim();
    if (item.length < 2 || item.length > 48) continue;
    if (NON_ENVOY_SURFACE_TAG_RE.test(item) || INTERNAL_PRICING_NOTE_RE.test(item)) continue;
    if (containsMembraneCanary(item, peerSafeCanaryList)) continue;
    styleDirectives.push(`对端偏好细则：${item}`);
  }
  for (const rawTaboo of (params.peerTaboos ?? []).slice(0, 4)) {
    const item = String(rawTaboo ?? "").trim();
    if (item.length < 2 || item.length > 48) continue;
    if (NON_ENVOY_SURFACE_TAG_RE.test(item) || INTERNAL_PRICING_NOTE_RE.test(item)) continue;
    if (containsMembraneCanary(item, peerSafeCanaryList)) continue;
    styleDirectives.push(`沟通避讳细则（严禁外发复述）：${item}`);
  }

  const candidateLessons = params.mindLoop
    ? params.mindLoop.getCalibratedLessons(4, { surfaces: ["concierge_envoy"] })
    : (params.rawEnvoyLessons ?? []);

  const envoyCalibratedLessons: string[] = [];
  for (const rawLesson of candidateLessons) {
    const clean = String(rawLesson ?? "").trim();
    if (!clean) continue;
    if (NON_ENVOY_SURFACE_TAG_RE.test(clean)) continue;
    if (containsMembraneCanary(clean, params.forbiddenCanaryTokens)) continue;
    if (!envoyCalibratedLessons.includes(clean)) {
      envoyCalibratedLessons.push(clean);
    }
    if (envoyCalibratedLessons.length >= 4) break;
  }

  const filteredDirectives = styleDirectives.filter(
    (d) => !containsMembraneCanary(d, params.forbiddenCanaryTokens),
  );

  const capsule: ConciergeEnvoyTasteCapsule = {
    version: 1,
    peerId: safePeerId,
    formality,
    brevity,
    styleDirectives: filteredDirectives,
    envoyCalibratedLessons,
    generatedAt: nowIso,
  };

  assertZeroCanaryLeak(
    `${capsule.styleDirectives.join("\n")}\n${capsule.envoyCalibratedLessons.join("\n")}`,
    params.forbiddenCanaryTokens,
  );
  const peerSafeCanaries = (params.forbiddenCanaryTokens ?? []).filter(
    (tok) => String(tok ?? "").trim().toLowerCase() !== safePeerId.toLowerCase(),
  );
  assertZeroCanaryLeak(JSON.stringify(capsule), peerSafeCanaries);

  return capsule;
}

/**
 * M5: 将外事品味胶囊渲染为外部拟稿提示词块，并在返回前强制执行零金丝雀泄露断言。
 */
export function renderConciergeEnvoyPromptBlock(
  capsule: ConciergeEnvoyTasteCapsule,
  forbiddenCanaryTokens?: readonly string[],
): string {
  const formalityLabel: Record<ConciergeEnvoyTasteCapsule["formality"], string> = {
    formal_respectful: "正式克制敬语",
    balanced_professional: "温和专业礼宾",
    casual_direct: "自然直白口语",
  };
  const brevityLabel: Record<ConciergeEnvoyTasteCapsule["brevity"], string> = {
    short_3_lines: "短句直给结论（不超过3行）",
    structured_concise: "条理精炼优先",
    detailed_context: "结构化交代前因后果与依据",
  };

  const lines: string[] = [
    "=== 外事礼宾半透膜 (M5 · concierge_envoy) ===",
    `对端沟通偏好 (${capsule.peerId})：语体=${formalityLabel[capsule.formality]}；篇幅=${brevityLabel[capsule.brevity]}。`,
  ];
  if (capsule.styleDirectives.length > 0) {
    lines.push(`拟稿风格指引：${capsule.styleDirectives.join("；")}。`);
  }
  if (capsule.envoyCalibratedLessons.length > 0) {
    lines.push(
      "外事校准教训（仅限 concierge_envoy 表面）：\n" +
        capsule.envoyCalibratedLessons.map((l) => `- ${l}`).join("\n"),
    );
  }
  lines.push("M5 半透膜铁律：严禁泄露主理人私人生活(owner_life)、商业底价、密钥凭据或本机路径。");

  const rendered = lines.join("\n");
  const peerSafeCanaries = (forbiddenCanaryTokens ?? []).filter(
    (tok) => String(tok ?? "").trim().toLowerCase() !== capsule.peerId.toLowerCase(),
  );
  assertZeroCanaryLeak(rendered, peerSafeCanaries);
  return rendered;
}

/**
 * M5: 外事外发文本强制守门断言，任何密钥、金额、本机路径或私有金丝雀词元一律抛出 MEMBRANE_CANARY_LEAK。
 */
export function guardConciergeOutboundText(
  text: string,
  forbiddenCanaryTokens?: readonly string[],
): string {
  const trimmed = String(text ?? "").trim();
  assertZeroCanaryLeak(trimmed, forbiddenCanaryTokens);
  return trimmed;
}

