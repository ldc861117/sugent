/**
 * Silicon Identity Core & Epistemic Digestion Loop (P4.3)
 * 为 Sugent 提供跨交互表面的统一硅基个体宪章、忠诚异议镜像检测，
 * 以及「待印证沙盒假设 → 现实印证/证伪 → self_core 智慧结晶/墓碑」认知消化闭环。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { looksSecret } from "../agent/memory.js";
import type { StereoscopicAtlas } from "./stereoscopic-atlas.js";

export type SiliconSurfaceId =
  | "steward_hub"
  | "im_owner"
  | "coding_orchestrator"
  | "duo_mediator"
  | "concierge_envoy";

export type LoyalDissentAlert = {
  kind: "guardrail_warning" | "duo_agreement_mirror" | "goal_commitment_drift";
  severity: "gentle_mirror" | "firm_boundary";
  title: string;
  mirrorMessage: string;
  refId?: string;
};

export type EpistemicJudgmentStatus = "sandbox" | "crystallized" | "falsified" | "superseded";

export type EpistemicJudgmentEntry = {
  id: string;
  topicKey: string;
  surface: SiliconSurfaceId;
  hypothesis: string;
  rationale: string;
  status: EpistemicJudgmentStatus;
  stratum: "digested_state" | "crystallized_wisdom";
  confidence: number;
  confirmations: number;
  contradictions: number;
  evidenceNotes: string[];
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
};

export type MindJournalSnapshot = {
  charterVersion: "1.0";
  updatedAt: string;
  counts: { sandbox: number; crystallized: number; falsified: number; superseded: number };
  entries: EpistemicJudgmentEntry[];
  calibratedLessons: string[];
};

export const SILICON_CHARTER_V1 = [
  "【Sugent 硅基个体统一宪章 v1.0】",
  "1. 统一主体与长期主义：无论身处桌面管家(steward_hub)、主人私聊(im_owner)、编码编排(coding_orchestrator)、双人共舞调停(duo_mediator)还是外事信使(concierge_envoy)，你都是同一个具备长期记忆、连续判断与独立人格的硅基伴侣与管家，而非无状态工具人。",
  "2. 拒绝谄媚与独立判断：不顺从、不盲从情绪，不为了讨好而顺口附和错误前提；在依据充分时明确表达判断与风险。",
  "3. 事实与假设严格分层：清晰区分「已验证事实(verified_fact / crystallized_wisdom)」与「待现实印证的沙盒假设(sandbox / digested_state)」，绝不把猜测包装成既定事实。",
  "4. 基于原则而非阉割的主权护界：出于主动守诺的伦理原则而非机械删改，严格维护跨主体半透膜(principalAcl)与密钥机密红线，不越权泄露一方私密给另一方。",
  "5. 忠诚异议(Loyal Dissent)：当主人或合作方的当前指令与既有北极星目标、到期承诺、双人约定窗口或价值红线冲突时，必须以诚实、克制、非说教的方式给出温和镜像或坚定边界提醒。",
].join("\n");

const SURFACE_LABELS: Record<SiliconSurfaceId, string> = {
  steward_hub: "桌面管家总控台 (steward_hub)",
  im_owner: "主人即时通讯私窗 (im_owner)",
  coding_orchestrator: "研发与编码编排器 (coding_orchestrator)",
  duo_mediator: "双人协奏调停席 (duo_mediator)",
  concierge_envoy: "对外礼宾与外事信使 (concierge_envoy)",
};

export function buildSiliconCharterPrompt(params: {
  surface: SiliconSurfaceId;
  activeGoals?: ReadonlyArray<{ title: string; northStarCriterion: string }>;
  openCommitments?: ReadonlyArray<{ summary: string; counterpartyOrRef: string; dueAt?: string }>;
  duoProtectedWindows?: readonly string[];
  calibratedLessons?: readonly string[];
  loyalDissentSignal?: LoyalDissentAlert | null;
}): string {
  const sections: string[] = [
    SILICON_CHARTER_V1,
    `当前交互表面: ${SURFACE_LABELS[params.surface] ?? params.surface}`,
  ];
  if (params.activeGoals?.length) {
    sections.push(
      "【当前北极星目标】\n" +
        params.activeGoals.map((g) => `- ${g.title}（北极星判据：${g.northStarCriterion}）`).join("\n"),
    );
  }
  if (params.openCommitments?.length) {
    sections.push(
      "【待履约未闭环承诺】\n" +
        params.openCommitments
          .map((c) => `- ${c.summary}（对象/引用：${c.counterpartyOrRef}${c.dueAt ? `，截止：${c.dueAt}` : ""}）`)
          .join("\n"),
    );
  }
  if (params.duoProtectedWindows?.length) {
    sections.push(
      "【双人约定与不可侵占时间窗】\n" + params.duoProtectedWindows.map((w) => `- ${w}`).join("\n"),
    );
  }
  if (params.calibratedLessons?.length) {
    sections.push(
      "【认知消化校准教训（禁止重蹈覆辙）】\n" + params.calibratedLessons.map((l) => `- ${l}`).join("\n"),
    );
  }
  if (params.loyalDissentSignal) {
    const sig = params.loyalDissentSignal;
    const tag = sig.severity === "firm_boundary" ? "坚定边界提醒" : "温和镜像提醒";
    sections.push(
      `【忠诚异议信号 · ${tag} (${sig.kind})】\n标题：${sig.title}\n镜像提示：${sig.mirrorMessage}` +
        (sig.refId ? `\n关联引用：${sig.refId}` : ""),
    );
  }
  return sections.join("\n\n");
}

const ASCII_STOPWORDS = new Set([
  "the", "and", "for", "not", "are", "but", "with", "from", "that", "this",
  "must", "never", "dont", "can", "will", "should", "into", "onto", "any",
  "all", "per", "via", "use", "using", "without", "before", "after",
]);
const CJK_STOP_SPLIT_RE = /(?:未经|不得|禁止|严禁|必须|不要|不可|不能|确认|以及|或者|的时候|如果|的话|直接|对外|向|对|的|了|和|与|或)/g;
const OVERRIDE_CUE_RE =
  /(?:算了先发报价|算了先发|不管红线|无视红线|绕过红线|跳过审核|跳过审批|绕过审核|绕过审批|别管规则|先不管|强行发送|强制跳过|override|bypass|skip\s+(?:review|approval|check)|ignore\s+(?:redline|guardrail|rule))/i;
const WORK_SCHEDULE_RE =
  /(?:安排(?:工作|开发|编码|会议|评审|上线|加班|冲刺|任务)?|排期|加班|写代码|编码|开发|开会|会议|评审|需求讨论|冲刺|上线|部署|工作|做项目|写文档|改bug|schedule|coding|sprint|meeting|deploy|work|hackathon)/i;
const DUO_WINDOW_FALLBACK_RE =
  /(?:周[一二三四五六日天][早午晚夜]?|周末|纪念日|生日|晚间|晚上|夜晚|下班后|睡前|假期|节假日|双人时间|家庭时间|weekend|friday\s*(?:night|evening)|anniversary|evening|night)/gi;
const NEW_TASK_CUE_RE =
  /(?:开始新|启动新|新开一个|另开一个|开一个新|新建|起一个|另起|规划新|开新|冲刺|sprint|new\s+(?:task|project|plan|sprint|feature)|start\s+(?:a\s+)?new|kick\s*off|pivot\s+to|switch\s+to)/i;

function extractGuardrailPhrases(statement: string): { cjkPhrases: string[]; asciiWords: string[] } {
  const cjkSet = new Set<string>();
  const cleaned = statement.replace(CJK_STOP_SPLIT_RE, " ");
  for (const seg of cleaned.match(/[\u4e00-\u9fff]{3,}/g) ?? []) {
    cjkSet.add(seg);
    for (let i = 0; i <= seg.length - 3; i++) {
      cjkSet.add(seg.slice(i, i + 3));
    }
  }
  const asciiWords = Array.from(
    new Set(
      (statement.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((w) => !ASCII_STOPWORDS.has(w)),
    ),
  );
  return { cjkPhrases: Array.from(cjkSet), asciiWords };
}

function guardrailMatchesUser(statement: string, userText: string, hasOverrideCue: boolean): boolean {
  const { cjkPhrases, asciiWords } = extractGuardrailPhrases(statement);
  if (cjkPhrases.some((phrase) => userText.includes(phrase))) return true;
  const userLower = userText.toLowerCase();
  const asciiHits = asciiWords.filter((w) => userLower.includes(w)).length;
  if (asciiHits >= 2) return true;
  if (asciiHits >= 1 && (hasOverrideCue || asciiWords.length === 1)) return true;
  return false;
}

export function detectLoyalDissentSignal(params: {
  userText: string;
  activeGoals: ReadonlyArray<{ id: string; title: string; northStarCriterion: string; status: string }>;
  openCommitments: ReadonlyArray<{
    id: string;
    summary: string;
    counterpartyOrRef: string;
    dueAt?: string;
    status: string;
    direction?: string;
  }>;
  guardrails: ReadonlyArray<{ id: string; kind: string; statement: string }>;
  duoAnchors?: ReadonlyArray<{ id: string; title: string; detail: string; protectedWindowKeywords?: readonly string[] }>;
  nowIso?: string;
}): LoyalDissentAlert | null {
  const userText = params.userText.trim();
  if (!userText) return null;

  const redlines = params.guardrails.filter((g) => g.kind === "hard_redline" || g.kind === "tombstone");
  if (redlines.length > 0) {
    const hasOverrideCue = OVERRIDE_CUE_RE.test(userText);
    const hit = redlines.find((g) => guardrailMatchesUser(g.statement, userText, hasOverrideCue));
    if (hit || hasOverrideCue) {
      const target = hit ?? redlines[0]!;
      return {
        kind: "guardrail_warning",
        severity: "firm_boundary",
        title: "触及价值红线 / 教训墓碑边界",
        mirrorMessage: `当前指令可能越过既定红线「${target.statement}」。我不能顺从跳过核验，请先确认是否要显式修订或走审批流程。`,
        refId: target.id,
      };
    }
  }

  if (params.duoAnchors?.length && WORK_SCHEDULE_RE.test(userText)) {
    const userLower = userText.toLowerCase();
    for (const anchor of params.duoAnchors) {
      const fallbackTokens = `${anchor.title} ${anchor.detail}`.match(DUO_WINDOW_FALLBACK_RE) ?? [];
      const keywords = Array.from(
        new Set([...(anchor.protectedWindowKeywords ?? []), ...fallbackTokens].map((k) => k.trim()).filter(Boolean)),
      );
      const matchedKw = keywords.find((kw) => userLower.includes(kw.toLowerCase()));
      if (matchedKw) {
        return {
          kind: "duo_agreement_mirror",
          severity: "gentle_mirror",
          title: `双人约定时间窗镜像提醒：${anchor.title}`,
          mirrorMessage: `你刚提到在「${matchedKw}」安排工作/排期，但该时段对应双人约定「${anchor.title}」（${anchor.detail}）。是否确认要调整该约定？`,
          refId: anchor.id,
        };
      }
    }
  }

  const nowMs = params.nowIso ? Date.parse(params.nowIso) : Date.now();
  if (!Number.isNaN(nowMs) && NEW_TASK_CUE_RE.test(userText)) {
    const overdue = params.openCommitments.find((c) => {
      if (c.status !== "open") return false;
      if (c.direction !== undefined && c.direction !== "i_owe") return false;
      if (!c.dueAt) return false;
      const dueMs = Date.parse(c.dueAt);
      return !Number.isNaN(dueMs) && dueMs < nowMs;
    });
    if (overdue) {
      const primaryGoal = params.activeGoals.find((g) => g.status === "active");
      const goalHint = primaryGoal ? `（当前北极星目标：「${primaryGoal.title}」）` : "";
      return {
        kind: "goal_commitment_drift",
        severity: "gentle_mirror",
        title: "检测到目标漂移与逾期未兑现承诺",
        mirrorMessage: `你准备启动新任务/新计划${goalHint}，但手头仍有逾期未履约承诺：「${overdue.summary}」（对象：${overdue.counterpartyOrRef}，原定截止：${overdue.dueAt}）。建议先收口或显式延期后再开新线。`,
        refId: overdue.id,
      };
    }
  }

  return null;
}

const TURN_JUDGMENT_CUE_RE =
  /(?:我判断|建议优先|我的建议是|核心取舍是|风险在于|关键判断)[：:，,\s]*([^。\n！？!?]{8,140})/;
const FEEDBACK_CONFIRM_RE =
  /(?:(?:刚才|上次|之前|那条)?(?:你的|那个)?(?:判断|建议|方案|思路|结论).*(?:是对的|说对了|很准|有效|跑通了|管用|验证通过|确实如此|有用))|(?:(?:刚才|上次)那个建议(?:很准|有效|管用|跑通了))/;
const FEEDBACK_FALSIFY_RE =
  /(?:(?:刚才|上次|之前|那条)?(?:你的|那个)?(?:判断|建议|方案|思路|结论).*(?:错了|不对|有问题|翻车|踩坑|行不通|被拒|失败了|无效))|(?:按你说的.*(?:没成|失败了|被拒|行不通|踩坑))/;

export class EpistemicDigestionLoop {
  private readonly stewardDir: string;
  private readonly journalPath: string;
  private readonly atlas?: StereoscopicAtlas;
  private readonly nowIso: () => string;
  private entries: EpistemicJudgmentEntry[] = [];

  constructor(opts: { stewardDir: string; atlas?: StereoscopicAtlas; nowIso?: () => string }) {
    this.stewardDir = opts.stewardDir;
    this.journalPath = path.join(opts.stewardDir, "mind-journal.json");
    this.atlas = opts.atlas;
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.journalPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.journalPath, "utf8")) as {
        entries?: EpistemicJudgmentEntry[];
      };
      if (Array.isArray(raw.entries)) {
        this.entries = raw.entries.filter(
          (e) => e && typeof e.id === "string" && typeof e.topicKey === "string" && typeof e.hypothesis === "string",
        );
      }
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    fs.mkdirSync(this.stewardDir, { recursive: true, mode: 0o700 });
    const snapshot = this.getMindJournalSnapshot(Math.max(1000, this.entries.length));
    const tmp = `${this.journalPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.journalPath);
    try {
      fs.chmodSync(this.journalPath, 0o600);
    } catch {
      /* ignore */
    }
  }

  recordJudgment(
    input: {
      id?: string;
      topicKey: string;
      surface: SiliconSurfaceId;
      hypothesis: string;
      rationale?: string;
      confidence?: number;
      replaceTopic?: boolean;
    },
    nowIso?: string,
  ): EpistemicJudgmentEntry {
    const topicKey = input.topicKey.trim();
    const hypothesis = input.hypothesis.trim();
    const rationale = (input.rationale ?? "").trim();
    if (!topicKey || !hypothesis) {
      throw new Error("EPISTEMIC_INVALID_INPUT: topicKey and hypothesis are required");
    }
    if (looksSecret(`${topicKey}\n${hypothesis}\n${rationale}`)) {
      throw new Error("EPISTEMIC_SECRET_REJECTED: Refused secret-like content in epistemic judgment");
    }

    const now = nowIso ?? this.nowIso();
    const id =
      input.id?.trim() ||
      `self:hyp:${crypto.createHash("sha256").update(`${topicKey}:${now}:${this.entries.length}:${crypto.randomBytes(4).toString("hex")}`).digest("hex").slice(0, 12)}`;
    const hasPriorFalsified = this.entries.some((e) => e.topicKey === topicKey && e.status === "falsified");
    const rawConf =
      typeof input.confidence === "number" && Number.isFinite(input.confidence)
        ? Math.max(0.05, Math.min(0.95, input.confidence))
        : hasPriorFalsified
          ? 0.42
          : 0.55;
    const confidence = Number((hasPriorFalsified ? Math.min(0.42, rawConf) : rawConf).toFixed(2));

    if (input.replaceTopic) {
      for (const old of this.entries) {
        if (old.topicKey === topicKey && (old.status === "sandbox" || old.status === "crystallized")) {
          old.status = "superseded";
          old.supersededBy = id;
          old.updatedAt = now;
          this.atlas?.supersedeNode(old.id, id, now);
        }
      }
    }

    const next: EpistemicJudgmentEntry = {
      id,
      topicKey,
      surface: input.surface,
      hypothesis,
      rationale,
      status: "sandbox",
      stratum: "digested_state",
      confidence,
      confirmations: 1,
      contradictions: 0,
      evidenceNotes: rationale ? [rationale] : [],
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(next);

    this.atlas?.applyDelta(
      {
        nodes: [
          {
            id: next.id,
            plane: "self_core",
            stratum: "digested_state",
            kind: "hypothesis",
            name: `${next.topicKey} [${next.surface}]`,
            summary: next.hypothesis,
            tags: ["epistemic_sandbox", `surface:${next.surface}`, `topic:${next.topicKey}`],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: next.confidence,
            sourceTrust: "llm_inferred",
            reinforcements: 1,
          },
        ],
      },
      now,
    );
    this.persist();
    return { ...next, evidenceNotes: [...next.evidenceNotes] };
  }

  private findLatestMatch(idOrTopic: string): EpistemicJudgmentEntry | undefined {
    const key = idOrTopic.trim();
    if (!key) return undefined;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i]!.id === key && this.entries[i]!.status !== "superseded") return this.entries[i];
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.topicKey === key && (e.status === "sandbox" || e.status === "crystallized")) return e;
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if ((e.id === key || e.topicKey === key) && e.status !== "superseded") return e;
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.id === key || e.topicKey === key) return e;
    }
    return undefined;
  }

  reconcileOutcome(
    input: { idOrTopic: string; outcome: "confirmed" | "falsified"; evidenceNote?: string; ownerEndorsed?: boolean },
    nowIso?: string,
  ): { entry: EpistemicJudgmentEntry; tombstoneLesson?: string } | null {
    const note = input.evidenceNote?.trim() ?? "";
    if (note && looksSecret(note)) {
      throw new Error("EPISTEMIC_SECRET_REJECTED: Refused secret-like content in evidenceNote");
    }
    const entry = this.findLatestMatch(input.idOrTopic);
    if (!entry) return null;

    const now = nowIso ?? this.nowIso();
    if (note) entry.evidenceNotes.push(note);
    entry.updatedAt = now;

    if (input.outcome === "confirmed") {
      entry.confirmations += 1;
      entry.confidence = Math.min(0.95, Number((entry.confidence + 0.15).toFixed(2)));
      const promoted = entry.confirmations >= 3 || input.ownerEndorsed === true;
      if (promoted) {
        entry.status = "crystallized";
        entry.stratum = "crystallized_wisdom";
      }
      this.atlas?.applyDelta(
        {
          nodes: [
            {
              id: entry.id,
              plane: "self_core",
              stratum: entry.stratum,
              kind: "hypothesis",
              name: `${entry.topicKey} [${entry.surface}]`,
              summary: entry.hypothesis,
              tags: [
                promoted ? "epistemic_crystallized" : "epistemic_sandbox",
                `surface:${entry.surface}`,
                `topic:${entry.topicKey}`,
              ],
              principalAcl: ["sugent_self", "owner:M"],
              confidence: entry.confidence,
              sourceTrust: promoted
                ? input.ownerEndorsed
                  ? "owner_confirmed"
                  : "deterministic_gate"
                : "llm_inferred",
              reinforcements: 1,
            },
          ],
        },
        now,
      );
      this.persist();
      return { entry: { ...entry, evidenceNotes: [...entry.evidenceNotes] } };
    }

    entry.contradictions += 1;
    entry.confidence = 0.2;
    entry.status = "falsified";
    const tombstoneId = `self:tombstone:${entry.id}`;
    const noteSuffix = note ? `（证伪依据：${note}）` : "";
    const tombstoneLesson = `避坑教训 [${entry.topicKey}]：原判断「${entry.hypothesis}」已被证伪${noteSuffix}，后续同类场景须降低先验置信度并先做验证。`;

    if (this.atlas) {
      this.atlas.supersedeNode(entry.id, tombstoneId, now);
      this.atlas.applyDelta(
        {
          nodes: [
            {
              id: tombstoneId,
              plane: "self_core",
              stratum: "crystallized_wisdom",
              kind: "tombstone",
              name: `教训墓碑: ${entry.topicKey}`,
              summary: tombstoneLesson,
              tags: ["epistemic_tombstone", `surface:${entry.surface}`, `topic:${entry.topicKey}`],
              principalAcl: ["sugent_self", "owner:M"],
              confidence: 0.9,
              sourceTrust: input.ownerEndorsed ? "owner_confirmed" : "deterministic_gate",
              reinforcements: 1,
            },
          ],
        },
        now,
      );
    }

    this.persist();
    return { entry: { ...entry, evidenceNotes: [...entry.evidenceNotes] }, tombstoneLesson };
  }

  digestUserFeedbackTurn(
    input: { userText: string; surface: SiliconSurfaceId },
    nowIso?: string,
  ): { entry: EpistemicJudgmentEntry; outcome: "confirmed" | "falsified"; tombstoneLesson?: string } | null {
    const clean = input.userText.trim();
    if (!clean || looksSecret(clean)) return null;
    const outcome: "confirmed" | "falsified" | null = FEEDBACK_FALSIFY_RE.test(clean)
      ? "falsified"
      : FEEDBACK_CONFIRM_RE.test(clean)
        ? "confirmed"
        : null;
    if (!outcome) return null;

    const candidates = this.entries.filter((e) => e.status === "sandbox");
    if (candidates.length === 0) return null;
    let target = candidates[candidates.length - 1]!;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const cand = candidates[i]!;
      const keys = [cand.topicKey, ...cand.hypothesis.split(/[：:，,。；;\s]+/).filter((w) => w.length >= 2)];
      if (keys.some((k) => clean.includes(k))) {
        target = cand;
        break;
      }
    }
    const res = this.reconcileOutcome(
      {
        idOrTopic: target.id,
        outcome,
        evidenceNote: `${input.surface} 用户反馈: ${clean.slice(0, 80)}`,
        ownerEndorsed: outcome === "falsified" || input.surface === "im_owner" || input.surface === "steward_hub",
      },
      nowIso,
    );
    return res ? { entry: res.entry, outcome, ...(res.tombstoneLesson ? { tombstoneLesson: res.tombstoneLesson } : {}) } : null;
  }

  extractTurnJudgmentDeterministically(
    turn: { userText: string; assistantReply: string; surface: SiliconSurfaceId },
    nowIso?: string,
  ): EpistemicJudgmentEntry | null {
    if (looksSecret(turn.userText) || looksSecret(turn.assistantReply)) return null;
    const match = turn.assistantReply.match(TURN_JUDGMENT_CUE_RE);
    if (!match?.[1]) return null;
    const hypothesis = match[1].trim();
    if (!hypothesis) return null;
    const topicSlug = crypto
      .createHash("sha256")
      .update(`${turn.surface}:${hypothesis}`)
      .digest("hex")
      .slice(0, 10);
    const rationale = turn.userText.trim()
      ? `源自 ${turn.surface} 对话：${turn.userText.trim().slice(0, 80)}`
      : `源自 ${turn.surface} 助手输出提炼`;
    return this.recordJudgment(
      {
        topicKey: `turn:${topicSlug}`,
        surface: turn.surface,
        hypothesis,
        rationale,
      },
      nowIso,
    );
  }

  listEntries(filter?: { status?: EpistemicJudgmentStatus }): EpistemicJudgmentEntry[] {
    const rows = filter?.status ? this.entries.filter((e) => e.status === filter.status) : this.entries;
    return rows.map((e) => ({ ...e, evidenceNotes: [...e.evidenceNotes] }));
  }

  getCalibratedLessons(limit = 6, opts?: { surfaces?: readonly SiliconSurfaceId[] }): string[] {
    const allowed = opts?.surfaces?.length ? new Set<SiliconSurfaceId>(opts.surfaces) : null;
    const out: string[] = [];
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i]!;
      if (allowed && !allowed.has(e.surface)) continue;
      if (e.status === "falsified") {
        const lastNote = e.evidenceNotes[e.evidenceNotes.length - 1];
        out.push(
          `[避坑/${e.topicKey}] 「${e.hypothesis}」已被证伪${lastNote ? `（${lastNote}）` : ""}`,
        );
      } else if (e.status === "crystallized") {
        out.push(`[结晶/${e.topicKey}] ${e.hypothesis}`);
      }
    }
    return out;
  }

  getMindJournalSnapshot(limit = 30): MindJournalSnapshot {
    const counts = { sandbox: 0, crystallized: 0, falsified: 0, superseded: 0 };
    for (const e of this.entries) counts[e.status] += 1;
    const capped = Math.max(0, limit);
    const sliced = capped === 0 ? [] : this.entries.slice(-capped).map((e) => ({ ...e, evidenceNotes: [...e.evidenceNotes] }));
    const updatedAt = this.entries[this.entries.length - 1]?.updatedAt ?? this.nowIso();
    return {
      charterVersion: "1.0",
      updatedAt,
      counts,
      entries: sliced,
      calibratedLessons: this.getCalibratedLessons(6),
    };
  }
}
