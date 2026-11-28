/**
 * 有分寸的主动伴行引擎（Bounded Proactive Cadence Engine）
 *
 * 严格遵守内核纯度铁律：
 * - 零文件 I/O、零网络请求、零系统时钟读取、零随机数调用；
 * - 零模型供应商或聊天平台产品名硬编码；
 * - 时间判断统一消费调用方传入的 ISO 时间戳与 dateKey，持久化经由外部注入 Port。
 */
import type { LedgerSnapshot } from "./stewardship-ledger.js";

/** 每日常规主动发起的默认软上限（0 表示不按固定总次数限流，改由心流边界与同题去重/冷却门控） */
export const DEFAULT_DAILY_NON_URGENT_QUOTA = 0;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const DEFAULT_REMIND_LEAD_DAYS = 3;
const DEFAULT_STALL_THRESHOLD_DAYS = 7;

export type ProactiveMomentKind =
  | "goal_imbalance"
  | "goal_unblock"
  | "clarification_needed"
  | "commitment_expiring"
  | "review_ready"
  | "periodic_calibration"
  | "fleet_collision_or_alert";

export interface CadenceFleetPulseInput {
  id: string;
  dedupeKey: string;
  kind: "red_collision" | "node_or_sidecar_error" | "pending_handoff" | "review_ready";
  projectKey: string;
  nodeId: string;
  summary: string;
  actionHint: string;
  urgency: "normal" | "urgent";
  conversationId?: string;
  superseded?: boolean;
  updatedAtIso: string;
}

export interface ProactiveCandidate {
  candidateId: string;
  dedupeKey: string;
  kind: ProactiveMomentKind;
  urgency: "normal" | "urgent";
  title: string;
  threeLineBody: [string, string, string];
  suggestedRoundId?: string;
  targetRefId?: string;
}

export interface CadenceBudgetState {
  dateKey: string;
  nonUrgentSentCount: number;
  dailySoftQuota: number;
  quietHoursActive: boolean;
  sentDedupeKeys: string[];
  morningDigestQueue: ProactiveCandidate[];
  boundaryQueue?: ProactiveCandidate[];
  topicCooldownUntilIso?: Record<string, string>;
}

export interface DuoProtectedWindowAnchor {
  id: string;
  title: string;
  detail?: string;
  protectedWindowKeywords?: readonly string[];
}

export interface DuoProtectedWindowGateOptions {
  nowIso?: string;
  duoProtectedAnchors?: readonly DuoProtectedWindowAnchor[];
  duoProtectedWindowActive?: boolean;
}

export interface OwnerFlowContext {
  mode: "co_working" | "deep_focus" | "idle_or_boundary" | "quiet_hours";
  activeGoalId?: string;
  activeProjectKey?: string;
  flowStrength?: number;
  duoProtectedWindowActive?: boolean;
  duoProtectedAnchors?: readonly DuoProtectedWindowAnchor[];
}

export interface CadenceBudgetStoragePort {
  load(): CadenceBudgetState | undefined;
  save(state: CadenceBudgetState): void;
}

function parseTimestampMs(iso: string | undefined): number {
  if (typeof iso !== "string") return Number.NaN;
  const trimmed = iso.trim();
  if (!trimmed) return Number.NaN;
  return Date.parse(trimmed);
}

function extractDateKey(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(String(iso ?? "").trim());
  return match?.[1] ?? "unknown";
}

interface ParsedWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
  dateStr: string;
}

function computeWeekday(year: number, month: number, day: number): number {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  const y = month < 3 ? year - 1 : year;
  return (
    y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) +
    (offsets[month - 1] ?? 0) +
    day
  ) % 7;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function parseIsoWallClock(nowIso: string | undefined): ParsedWallClock | null {
  if (typeof nowIso !== "string") return null;
  const trimmed = nowIso.trim();
  if (!trimmed || !Number.isFinite(parseTimestampMs(trimmed))) return null;
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      trimmed,
    );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = m[4] !== undefined ? Number(m[4]) : 0;
  const minute = m[5] !== undefined ? Number(m[5]) : 0;
  if (month < 1 || month > 12 || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonth[month - 1] ?? 31;
  if (day < 1 || day > maxDay) return null;
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday: computeWeekday(year, month, day),
    dateStr: `${m[1]}-${m[2]}-${m[3]}`,
  };
}

/**
 * 纯函数判定当前时间戳是否命中 M3 双人共处保护留白窗。
 * 零系统时钟调用，严格按传入 ISO 字符串的日期与时分确定性计算。
 */
export function matchActiveDuoProtectedWindow(
  nowIso: string,
  anchors: readonly DuoProtectedWindowAnchor[] | undefined,
): {
  active: boolean;
  matchedAnchorId?: string;
  matchedTitle?: string;
  matchedKeyword?: string;
} {
  if (!anchors || anchors.length === 0) return { active: false };
  const clock = parseIsoWallClock(nowIso);
  if (!clock) return { active: false };

  const nowTotalMinutes = clock.hour * 60 + clock.minute;

  for (const anchor of anchors) {
    if (!anchor) continue;
    const kwList = (anchor.protectedWindowKeywords ?? [])
      .map((k) => String(k ?? "").trim())
      .filter(Boolean);
    const combinedText = [anchor.title, anchor.detail ?? "", ...kwList].join(" ");
    if (!combinedText.trim()) continue;

    const dayHits: Array<{ label: string; ok: boolean }> = [];
    const periodTimeHits: Array<{ label: string; ok: boolean }> = [];
    const clockTimeHits: Array<{ label: string; ok: boolean }> = [];

    const hasFriNight = /(?:周五|星期五)晚/.test(combinedText);
    const hasSatNight = /(?:周六|星期六)晚/.test(combinedText);
    const hasSunNight = /(?:周日|周天|星期日|星期天)晚/.test(combinedText);
    const hasWeekendNight = /周末晚/.test(combinedText);

    if (hasFriNight) {
      dayHits.push({ label: "周五晚", ok: clock.weekday === 5 });
      periodTimeHits.push({ label: "周五晚", ok: clock.hour >= 18 });
    } else if (/(?:周五|星期五)/.test(combinedText)) {
      dayHits.push({ label: "周五", ok: clock.weekday === 5 });
    }

    if (hasSatNight) {
      dayHits.push({ label: "周六晚", ok: clock.weekday === 6 });
      periodTimeHits.push({ label: "周六晚", ok: clock.hour >= 18 });
    } else if (/(?:周六|星期六)/.test(combinedText)) {
      dayHits.push({ label: "周六", ok: clock.weekday === 6 });
    }

    if (hasSunNight) {
      dayHits.push({ label: "周日晚", ok: clock.weekday === 0 });
      periodTimeHits.push({ label: "周日晚", ok: clock.hour >= 18 });
    } else if (/(?:周日|周天|星期日|星期天)/.test(combinedText)) {
      dayHits.push({ label: "周日", ok: clock.weekday === 0 });
    }

    if (hasWeekendNight) {
      dayHits.push({ label: "周末晚", ok: clock.weekday === 6 || clock.weekday === 0 });
      periodTimeHits.push({ label: "周末晚", ok: clock.hour >= 18 });
    } else if (/周末/.test(combinedText)) {
      dayHits.push({ label: "周末", ok: clock.weekday === 6 || clock.weekday === 0 });
    }

    const otherWeekdays: Array<{ re: RegExp; label: string; day: number }> = [
      { re: /(?:周一|星期一)/, label: "周一", day: 1 },
      { re: /(?:周二|星期二)/, label: "周二", day: 2 },
      { re: /(?:周三|星期三)/, label: "周三", day: 3 },
      { re: /(?:周四|星期四)/, label: "周四", day: 4 },
    ];
    for (const wd of otherWeekdays) {
      if (wd.re.test(combinedText)) {
        dayHits.push({ label: wd.label, ok: clock.weekday === wd.day });
      }
    }

    for (const dm of combinedText.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
      const ds = dm[1]!;
      dayHits.push({ label: ds, ok: clock.dateStr === ds });
    }
    for (const mdm of combinedText.matchAll(/(\d{1,2})月(\d{1,2})[日号]?/g)) {
      const mm = Number(mdm[1]);
      const dd = Number(mdm[2]);
      dayHits.push({ label: mdm[0], ok: clock.month === mm && clock.day === dd });
    }

    for (const hm of combinedText.matchAll(/(?:^|[^\d:])([01]?\d|2[0-3]):([0-5]\d)(?![:\d])/g)) {
      const hh = Number(hm[1]);
      const mi = Number(hm[2]);
      const targetMin = hh * 60 + mi;
      const diff = Math.abs(nowTotalMinutes - targetMin);
      const circularDiff = Math.min(diff, 1440 - diff);
      const label = `${String(hh).padStart(2, "0")}:${hm[2]}`;
      clockTimeHits.push({ label, ok: circularDiff <= 90 });
    }

    if (/睡前/.test(combinedText)) {
      periodTimeHits.push({ label: "睡前", ok: clock.hour >= 22 || clock.hour < 2 });
    }
    if (/傍晚/.test(combinedText)) {
      periodTimeHits.push({ label: "傍晚", ok: clock.hour >= 17 && clock.hour <= 19 });
    }
    for (const eveKw of ["今晚", "晚间", "晚上"] as const) {
      if (combinedText.includes(eveKw)) {
        periodTimeHits.push({ label: eveKw, ok: clock.hour >= 19 || clock.hour < 1 });
      }
    }

    const effectiveTimeHits = clockTimeHits.length > 0 ? clockTimeHits : periodTimeHits;
    if (dayHits.length === 0 && effectiveTimeHits.length === 0) {
      continue;
    }

    const matchedDay = dayHits.find((d) => d.ok);
    const matchedTime = effectiveTimeHits.find((t) => t.ok);
    const dayOk = dayHits.length === 0 || Boolean(matchedDay);
    const timeOk = effectiveTimeHits.length === 0 || Boolean(matchedTime);

    if (dayOk && timeOk) {
      const matchedKeyword =
        matchedTime?.label ?? matchedDay?.label ?? kwList[0] ?? anchor.title;
      return {
        active: true,
        matchedAnchorId: anchor.id,
        matchedTitle: anchor.title,
        matchedKeyword,
      };
    }
  }

  return { active: false };
}

function compactLine(text: string | undefined, maxLen = 72): string {
  const cleaned = String(text ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "-";
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxLen - 1))}…`;
}

function buildThreeLineBody(line1: string, line2: string, line3: string): [string, string, string] {
  return [compactLine(line1, 96), compactLine(line2, 96), compactLine(line3, 96)];
}

function normalizeQuota(quota: number | undefined): number {
  if (quota === undefined || !Number.isFinite(quota) || quota <= 0) return DEFAULT_DAILY_NON_URGENT_QUOTA;
  return Math.max(0, Math.trunc(quota));
}

function normalizeDays(days: number | undefined, fallback: number): number {
  if (days === undefined || !Number.isFinite(days)) return fallback;
  return Math.max(0, days);
}

function cloneCandidate(candidate: ProactiveCandidate): ProactiveCandidate {
  return {
    ...candidate,
    threeLineBody: [
      candidate.threeLineBody[0],
      candidate.threeLineBody[1],
      candidate.threeLineBody[2],
    ],
  };
}

function cloneBudgetState(state: CadenceBudgetState): CadenceBudgetState {
  return {
    dateKey: state.dateKey,
    nonUrgentSentCount: Number.isFinite(state.nonUrgentSentCount)
      ? Math.max(0, Math.trunc(state.nonUrgentSentCount))
      : 0,
    dailySoftQuota: normalizeQuota(state.dailySoftQuota),
    quietHoursActive: Boolean(state.quietHoursActive),
    sentDedupeKeys: [...state.sentDedupeKeys],
    morningDigestQueue: (state.morningDigestQueue ?? []).map(cloneCandidate),
    boundaryQueue: (state.boundaryQueue ?? []).map(cloneCandidate),
    topicCooldownUntilIso: { ...(state.topicCooldownUntilIso ?? {}) },
  };
}

/** 创建指定日期的默认注意力预算状态 */
export function createDefaultBudgetState(
  dateKey: string,
  dailySoftQuota = DEFAULT_DAILY_NON_URGENT_QUOTA,
  quietHoursActive = false,
): CadenceBudgetState {
  return {
    dateKey,
    nonUrgentSentCount: 0,
    dailySoftQuota: normalizeQuota(dailySoftQuota),
    quietHoursActive: Boolean(quietHoursActive),
    sentDedupeKeys: [],
    morningDigestQueue: [],
    boundaryQueue: [],
    topicCooldownUntilIso: {},
  };
}

function collectGoalImbalances(ledger: LedgerSnapshot, nowMs: number): ProactiveCandidate[] {
  if (!Number.isFinite(nowMs)) return [];
  const results: ProactiveCandidate[] = [];
  for (const goal of ledger.goals ?? []) {
    if (goal.status !== "active") continue;
    const lastMs = parseTimestampMs(goal.lastProgressAt);
    if (!Number.isFinite(lastMs)) continue;
    const thresholdDays = normalizeDays(goal.stallThresholdDays, DEFAULT_STALL_THRESHOLD_DAYS);
    const stalledDays = (nowMs - lastMs) / MS_PER_DAY;
    if (stalledDays < thresholdDays) continue;

    results.push({
      candidateId: `goal-imbalance:${goal.id}`,
      dedupeKey: `goal_imbalance:${goal.id}:${goal.lastProgressAt}`,
      kind: "goal_imbalance",
      urgency: "normal",
      title: `主目标停滞：${compactLine(goal.title, 44)}`,
      threeLineBody: buildThreeLineBody(
        `目标「${compactLine(goal.title, 40)}」已停滞 ${Math.floor(stalledDays)} 天（阈值 ${thresholdDays} 天）`,
        `北极星判据：${compactLine(goal.northStarCriterion, 64)}`,
        "回复 1 拆解下一步最小动作，或回复 2 暂停调整主航道",
      ),
      targetRefId: goal.id,
    });
  }
  return results;
}

function collectCommitmentSignals(ledger: LedgerSnapshot, nowMs: number): ProactiveCandidate[] {
  const results: ProactiveCandidate[] = [];
  for (const item of ledger.commitments ?? []) {
    if (item.status === "waiting_review") {
      results.push({
        candidateId: `review-ready:${item.id}`,
        dedupeKey: `review_ready:${item.id}:${item.updatedAt}`,
        kind: "review_ready",
        urgency: "normal",
        title: `待你拍板：${compactLine(item.summary, 44)}`,
        threeLineBody: buildThreeLineBody(
          `事项「${compactLine(item.summary, 48)}」已就绪等待确认`,
          `关联方：${compactLine(item.counterpartyOrRef, 36)} · 分区 ${item.partition}`,
          "回复 1 确认放行闭环，或回复 2 补充修订意见",
        ),
        targetRefId: item.id,
      });
      continue;
    }

    if (item.status !== "open" || !Number.isFinite(nowMs) || !item.dueAt) continue;
    const dueMs = parseTimestampMs(item.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    const leadDays = normalizeDays(item.remindLeadDays, DEFAULT_REMIND_LEAD_DAYS);
    const diffMs = dueMs - nowMs;
    if (diffMs > leadDays * MS_PER_DAY) continue;

    const overdue = diffMs < 0;
    const urgency: "normal" | "urgent" = overdue ? "urgent" : "normal";
    const daysLeft = Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
    const overdueDays = Math.max(1, Math.floor(Math.abs(diffMs) / MS_PER_DAY));
    const statusLine = overdue
      ? `承诺已超期 ${overdueDays} 天：${compactLine(item.summary, 44)}`
      : daysLeft === 0
        ? `承诺今日到期：${compactLine(item.summary, 48)}`
        : `承诺将在 ${daysLeft} 天内到期：${compactLine(item.summary, 44)}`;

    results.push({
      candidateId: `commitment-expiring:${item.id}`,
      dedupeKey: `commitment_expiring:${item.id}:${item.dueAt}:${urgency}`,
      kind: "commitment_expiring",
      urgency,
      title: `${overdue ? "超期未闭环" : "临期提醒"}：${compactLine(item.summary, 42)}`,
      threeLineBody: buildThreeLineBody(
        statusLine,
        `关联方：${compactLine(item.counterpartyOrRef, 36)} · 截止 ${compactLine(item.dueAt, 32)}`,
        "回复 1 标记已完结，或回复 2 顺延提醒窗口",
      ),
      targetRefId: item.id,
    });
  }
  return results;
}

function collectResourceExpirations(ledger: LedgerSnapshot, nowMs: number): ProactiveCandidate[] {
  if (!Number.isFinite(nowMs)) return [];
  const results: ProactiveCandidate[] = [];
  for (const res of ledger.resources ?? []) {
    if (res.kind !== "personal_archive" && res.kind !== "budget_cap") continue;
    const metaStatus = typeof res.metadata?.status === "string" ? res.metadata.status : undefined;
    if (res.metadata?.closed === true || metaStatus === "closed" || metaStatus === "superseded") continue;
    if (!res.expiresAt) continue;

    const expMs = parseTimestampMs(res.expiresAt);
    if (!Number.isFinite(expMs)) continue;
    const rawLead = res.metadata?.remindLeadDays;
    const leadDays = typeof rawLead === "number" ? normalizeDays(rawLead, DEFAULT_REMIND_LEAD_DAYS) : DEFAULT_REMIND_LEAD_DAYS;
    const diffMs = expMs - nowMs;
    if (diffMs > leadDays * MS_PER_DAY) continue;

    const overdue = diffMs < 0;
    const urgency: "normal" | "urgent" = overdue ? "urgent" : "normal";
    const daysLeft = Math.max(0, Math.ceil(diffMs / MS_PER_DAY));
    const line1 = overdue
      ? `数字资源「${compactLine(res.title, 40)}」已过期`
      : daysLeft === 0
        ? `数字资源「${compactLine(res.title, 40)}」今日到期`
        : `数字资源「${compactLine(res.title, 40)}」将于 ${daysLeft} 天内到期`;

    results.push({
      candidateId: `resource-expiring:${res.id}`,
      dedupeKey: `resource_expiring:${res.id}:${res.expiresAt}:${urgency}`,
      kind: "commitment_expiring",
      urgency,
      title: `${overdue ? "资源已过期" : "资源临期"}：${compactLine(res.title, 42)}`,
      threeLineBody: buildThreeLineBody(
        line1,
        `类别：${res.kind} · 到期 ${compactLine(res.expiresAt, 32)}`,
        "回复 1 续期更新，或回复 2 归档关闭",
      ),
      targetRefId: res.id,
    });
  }
  return results;
}

function collectFleetPulseSignals(pulses: readonly CadenceFleetPulseInput[] | undefined): ProactiveCandidate[] {
  const results: ProactiveCandidate[] = [];
  for (const pulse of pulses ?? []) {
    if (pulse.superseded === true) continue;
    const isUrgentKind = pulse.kind === "red_collision" || pulse.kind === "node_or_sidecar_error";
    const kind: ProactiveMomentKind = pulse.kind === "review_ready" ? "review_ready" : "fleet_collision_or_alert";
    const urgency: "normal" | "urgent" = isUrgentKind ? "urgent" : "normal";
    const titlePrefix =
      pulse.kind === "red_collision"
        ? "节点冲突红灯"
        : pulse.kind === "node_or_sidecar_error"
          ? "节点或辅助进程异常"
          : pulse.kind === "pending_handoff"
            ? "待接力交接"
            : "跨端会话待审";
    const targetRefId = pulse.conversationId?.trim() || pulse.projectKey;

    results.push({
      candidateId: `fleet:${pulse.id}`,
      dedupeKey: pulse.dedupeKey.trim() || `fleet:${pulse.kind}:${pulse.projectKey}:${pulse.nodeId}:${pulse.id}`,
      kind,
      urgency,
      title: `${titlePrefix}：${compactLine(pulse.projectKey, 36)}`,
      threeLineBody: buildThreeLineBody(
        `[${compactLine(pulse.nodeId, 24)} · ${compactLine(pulse.projectKey, 32)}] ${compactLine(pulse.summary, 48)}`,
        `建议动作：${compactLine(pulse.actionHint, 72)}`,
        `更新时间 ${compactLine(pulse.updatedAtIso, 32)} · 请确认处理`,
      ),
      ...(targetRefId ? { targetRefId } : {}),
    });
  }
  return results;
}

/**
 * 扫描五维生命账本失衡信号、周期校准信号与多节点舰队脉冲。
 * 无任何待关注信号时返回空数组，保持彻底静默。
 */
export function scanLedgerImbalances(
  ledger: LedgerSnapshot,
  nowIso: string,
  options?: { calibrationDue?: boolean; fleetPulses?: readonly CadenceFleetPulseInput[] },
): ProactiveCandidate[] {
  const nowMs = parseTimestampMs(nowIso);
  const collected: ProactiveCandidate[] = [
    ...collectGoalImbalances(ledger, nowMs),
    ...collectCommitmentSignals(ledger, nowMs),
    ...collectResourceExpirations(ledger, nowMs),
    ...collectFleetPulseSignals(options?.fleetPulses),
  ];

  if (options?.calibrationDue) {
    const dateKey = extractDateKey(nowIso);
    const activeGoals = (ledger.goals ?? []).filter((g) => g.status === "active").length;
    const openCommitments = (ledger.commitments ?? []).filter(
      (c) => c.status === "open" || c.status === "waiting_review",
    ).length;
    collected.push({
      candidateId: `periodic-calibration:${dateKey}`,
      dedupeKey: `periodic_calibration:${dateKey}`,
      kind: "periodic_calibration",
      urgency: "normal",
      title: "周期五维校准对齐",
      threeLineBody: buildThreeLineBody(
        `当前活跃主目标 ${activeGoals} 项，未结承诺 ${openCommitments} 项`,
        "请核对近期精力分配是否紧扣北极星主航道",
        "回复 1 维持现状，或回复 2 重新排定主目标",
      ),
    });
  }

  const urgent = collected.filter((c) => c.urgency === "urgent");
  const normal = collected.filter((c) => c.urgency !== "urgent");
  return [...urgent, ...normal];
}

/**
 * 发送前二次销账过滤：对外部状态已被推进或已读的过时候选静默剔除。
 */
export function filterSupersededBeforeSend(
  candidates: readonly ProactiveCandidate[],
  isSuperseded: (candidate: ProactiveCandidate) => boolean,
): { deliverable: ProactiveCandidate[]; supersededIds: string[] } {
  const deliverable: ProactiveCandidate[] = [];
  const supersededIds: string[] = [];
  for (const candidate of candidates) {
    if (isSuperseded(candidate)) {
      supersededIds.push(candidate.candidateId);
    } else {
      deliverable.push(cloneCandidate(candidate));
    }
  }
  return { deliverable, supersededIds };
}

/**
 * 每日注意力配额与免打扰门控纯函数：
 * - 已发送或同批重复 dedupeKey -> suppressedIds；
 * - urgent 级候选绕过配额、免打扰与双人共处留白窗限制直接放行（仍受 dedupeKey 去重约束）；
 * - 非 urgent 候选在免打扰或超配额时折叠进 morningDigestQueue（按 dedupeKey 去重）；
 * - 非 urgent 候选在 M3 双人共处保护窗内自动降级并暂存至 boundaryQueue，待窗口结束后平滑排空。
 */
export function gateProactiveCandidates(
  candidates: readonly ProactiveCandidate[],
  budget: CadenceBudgetState,
  opts?: DuoProtectedWindowGateOptions,
): {
  emitNow: ProactiveCandidate[];
  holdForBoundary?: ProactiveCandidate[];
  foldToMorningDigest: ProactiveCandidate[];
  suppressedIds: string[];
  nextState: CadenceBudgetState;
} {
  const quota = normalizeQuota(budget.dailySoftQuota);
  let nonUrgentSentCount = Number.isFinite(budget.nonUrgentSentCount)
    ? Math.max(0, Math.trunc(budget.nonUrgentSentCount))
    : 0;
  const sentSet = new Set<string>(budget.sentDedupeKeys ?? []);
  const batchSeen = new Set<string>();
  const nextMorningQueue = (budget.morningDigestQueue ?? []).map(cloneCandidate);
  const queuedKeys = new Set<string>(nextMorningQueue.map((c) => c.dedupeKey));
  const nextBoundaryQueue = (budget.boundaryQueue ?? []).map(cloneCandidate);
  const boundaryKeys = new Set<string>(nextBoundaryQueue.map((c) => c.dedupeKey));
  const inDuoWindow =
    Boolean(opts?.duoProtectedWindowActive) ||
    Boolean(
      opts?.nowIso &&
        matchActiveDuoProtectedWindow(opts.nowIso, opts.duoProtectedAnchors).active,
    );

  const emitNow: ProactiveCandidate[] = [];
  const holdForBoundary: ProactiveCandidate[] = [];
  const foldToMorningDigest: ProactiveCandidate[] = [];
  const suppressedIds: string[] = [];

  for (const candidate of candidates) {
    if (sentSet.has(candidate.dedupeKey) || batchSeen.has(candidate.dedupeKey)) {
      suppressedIds.push(candidate.candidateId);
      continue;
    }
    batchSeen.add(candidate.dedupeKey);
    const copy = cloneCandidate(candidate);

    if (copy.urgency === "urgent") {
      emitNow.push(copy);
      sentSet.add(copy.dedupeKey);
      continue;
    }

    const quotaExceeded = quota > 0 && nonUrgentSentCount >= quota;
    if (budget.quietHoursActive || quotaExceeded) {
      foldToMorningDigest.push(copy);
      if (!queuedKeys.has(copy.dedupeKey)) {
        nextMorningQueue.push(cloneCandidate(copy));
        queuedKeys.add(copy.dedupeKey);
      }
      continue;
    }

    if (inDuoWindow) {
      holdForBoundary.push(copy);
      if (!boundaryKeys.has(copy.dedupeKey)) {
        nextBoundaryQueue.push(cloneCandidate(copy));
        boundaryKeys.add(copy.dedupeKey);
      }
      continue;
    }

    emitNow.push(copy);
    nonUrgentSentCount += 1;
    sentSet.add(copy.dedupeKey);
  }

  const nextState: CadenceBudgetState = {
    dateKey: budget.dateKey,
    nonUrgentSentCount,
    dailySoftQuota: quota,
    quietHoursActive: Boolean(budget.quietHoursActive),
    sentDedupeKeys: Array.from(sentSet),
    morningDigestQueue: nextMorningQueue.filter((item) => !sentSet.has(item.dedupeKey)),
    boundaryQueue: nextBoundaryQueue.filter((item) => !sentSet.has(item.dedupeKey)),
    topicCooldownUntilIso: { ...(budget.topicCooldownUntilIso ?? {}) },
  };

  return { emitNow, holdForBoundary, foldToMorningDigest, suppressedIds, nextState };
}

/**
 * 创建有状态的注意力预算门控器；缺省纯内存，可选注入同步 CadenceBudgetStoragePort 持久化。
 * 跨日期 dateKey 变更时自动重置每日非紧急计数与已发去重表，并保留待外发的 morningDigestQueue。
 */
export function createAttentionBudgetGate(
  storagePort?: CadenceBudgetStoragePort,
  dailySoftQuota?: number,
): {
  getState(dateKey: string): CadenceBudgetState;
  evaluateAndRecord(
    candidates: readonly ProactiveCandidate[],
    dateKey: string,
    quietHoursActive: boolean,
    opts?: DuoProtectedWindowGateOptions,
  ): {
    emitNow: ProactiveCandidate[];
    holdForBoundary?: ProactiveCandidate[];
    foldToMorningDigest: ProactiveCandidate[];
    suppressedIds: string[];
    state: CadenceBudgetState;
  };
  drainMorningDigest(
    dateKey: string,
    isSuperseded: (candidate: ProactiveCandidate) => boolean,
  ): {
    emitNow: ProactiveCandidate[];
    supersededIds: string[];
    state: CadenceBudgetState;
  };
  evaluateFlowAndRecord(
    candidates: readonly ProactiveCandidate[],
    dateKey: string,
    quietHoursActive: boolean,
    flow: OwnerFlowContext,
    nowIso: string,
  ): {
    emitNow: ProactiveCandidate[];
    holdForBoundary: ProactiveCandidate[];
    foldToMorningDigest: ProactiveCandidate[];
    suppressedIds: string[];
    state: CadenceBudgetState;
  };
  drainBoundaryQueueForDate(
    dateKey: string,
    isSuperseded: (candidate: ProactiveCandidate) => boolean,
  ): {
    emitNow: ProactiveCandidate[];
    supersededIds: string[];
    state: CadenceBudgetState;
  };
} {
  const explicitQuota = dailySoftQuota !== undefined ? normalizeQuota(dailySoftQuota) : undefined;
  let memoryState: CadenceBudgetState | undefined;

  const readRaw = (): CadenceBudgetState | undefined => (storagePort ? storagePort.load() : memoryState);
  const writeState = (state: CadenceBudgetState): void => {
    const cloned = cloneBudgetState(state);
    if (storagePort) storagePort.save(cloned);
    else memoryState = cloned;
  };

  const resolveStateForDate = (dateKey: string): CadenceBudgetState => {
    const loaded = readRaw();
    if (!loaded) {
      return createDefaultBudgetState(dateKey, explicitQuota ?? DEFAULT_DAILY_NON_URGENT_QUOTA, false);
    }
    const cloned = cloneBudgetState(loaded);
    const targetQuota = explicitQuota ?? cloned.dailySoftQuota;
    if (cloned.dateKey !== dateKey) {
      return {
        dateKey,
        nonUrgentSentCount: 0,
        dailySoftQuota: targetQuota,
        quietHoursActive: cloned.quietHoursActive,
        sentDedupeKeys: [],
        morningDigestQueue: cloned.morningDigestQueue,
        boundaryQueue: cloned.boundaryQueue ?? [],
        topicCooldownUntilIso: cloned.topicCooldownUntilIso ?? {},
      };
    }
    return { ...cloned, dailySoftQuota: targetQuota };
  };

  return {
    getState(dateKey: string): CadenceBudgetState {
      return cloneBudgetState(resolveStateForDate(dateKey));
    },
    evaluateAndRecord(candidates, dateKey, quietHoursActive, opts) {
      const baseState = resolveStateForDate(dateKey);
      const gated = gateProactiveCandidates(candidates, { ...baseState, quietHoursActive }, opts);
      writeState(gated.nextState);
      return {
        emitNow: gated.emitNow,
        holdForBoundary: gated.holdForBoundary ?? [],
        foldToMorningDigest: gated.foldToMorningDigest,
        suppressedIds: gated.suppressedIds,
        state: cloneBudgetState(gated.nextState),
      };
    },
    drainMorningDigest(dateKey, isSuperseded) {
      const baseState = resolveStateForDate(dateKey);
      const { deliverable, supersededIds } = filterSupersededBeforeSend(baseState.morningDigestQueue, isSuperseded);
      const sentSet = new Set<string>(baseState.sentDedupeKeys);
      const emitNow: ProactiveCandidate[] = [];
      for (const candidate of deliverable) {
        if (sentSet.has(candidate.dedupeKey)) continue;
        sentSet.add(candidate.dedupeKey);
        emitNow.push(candidate);
      }
      const nextState: CadenceBudgetState = { ...baseState, sentDedupeKeys: Array.from(sentSet), morningDigestQueue: [] };
      writeState(nextState);
      return { emitNow, supersededIds, state: cloneBudgetState(nextState) };
    },
    evaluateFlowAndRecord(candidates, dateKey, quietHoursActive, flow, nowIso) {
      const baseState = resolveStateForDate(dateKey);
      const res = evaluateFlowAwareDelivery(candidates, { ...baseState, quietHoursActive }, flow, nowIso);
      writeState(res.nextState);
      return {
        emitNow: res.emitNow,
        holdForBoundary: res.holdForBoundary,
        foldToMorningDigest: res.foldToMorningDigest,
        suppressedIds: res.suppressedIds,
        state: cloneBudgetState(res.nextState),
      };
    },
    drainBoundaryQueueForDate(dateKey, isSuperseded) {
      const baseState = resolveStateForDate(dateKey);
      const drained = drainBoundaryQueue(baseState, isSuperseded);
      writeState(drained.nextState);
      return {
        emitNow: drained.emitNow,
        supersededIds: drained.supersededIds,
        state: cloneBudgetState(drained.nextState),
      };
    },
  };
}

export function snoozeProactiveTopic(
  state: CadenceBudgetState,
  dedupeKey: string,
  untilIso: string,
): CadenceBudgetState {
  const next = cloneBudgetState(state);
  next.topicCooldownUntilIso = { ...(next.topicCooldownUntilIso ?? {}), [dedupeKey]: untilIso };
  return next;
}

/**
 * 基于信息价值与主人当下心流状态的动态投递门控（无固定每日总次数封顶）：
 * - Co-working 同频共创或闲置边界期：立即放行（仅受去重与同题冷却约束）；
 * - M3 双人共处保护窗：所有非紧急事项自动降级压入 boundaryQueue，紧急告警照常放行；
 * - Deep Focus 异构深潜期：非当前主目标/项目的非紧急事项压入 boundaryQueue，待切换或收尾边界投递；
 * - Quiet Hours：非紧急项折叠进 morningDigestQueue。
 */
export function evaluateFlowAwareDelivery(
  candidates: readonly ProactiveCandidate[],
  budget: CadenceBudgetState,
  flow: OwnerFlowContext,
  nowIso: string,
): {
  emitNow: ProactiveCandidate[];
  holdForBoundary: ProactiveCandidate[];
  foldToMorningDigest: ProactiveCandidate[];
  suppressedIds: string[];
  nextState: CadenceBudgetState;
} {
  const nowMs = parseTimestampMs(nowIso);
  const quota = normalizeQuota(budget.dailySoftQuota);
  let nonUrgentSentCount = Number.isFinite(budget.nonUrgentSentCount) ? Math.max(0, Math.trunc(budget.nonUrgentSentCount)) : 0;
  const sentSet = new Set<string>(budget.sentDedupeKeys ?? []);
  const batchSeen = new Set<string>();
  const cooldowns = { ...(budget.topicCooldownUntilIso ?? {}) };
  const nextMorning = (budget.morningDigestQueue ?? []).map(cloneCandidate);
  const morningKeys = new Set<string>(nextMorning.map((c) => c.dedupeKey));
  const nextBoundary = (budget.boundaryQueue ?? []).map(cloneCandidate);
  const boundaryKeys = new Set<string>(nextBoundary.map((c) => c.dedupeKey));
  const inDuoWindow =
    Boolean(flow.duoProtectedWindowActive) ||
    matchActiveDuoProtectedWindow(nowIso, flow.duoProtectedAnchors).active;

  const emitNow: ProactiveCandidate[] = [];
  const holdForBoundary: ProactiveCandidate[] = [];
  const foldToMorningDigest: ProactiveCandidate[] = [];
  const suppressedIds: string[] = [];

  for (const candidate of candidates) {
    const coolUntilMs = parseTimestampMs(cooldowns[candidate.dedupeKey]);
    const inCooldown = Number.isFinite(nowMs) && Number.isFinite(coolUntilMs) && coolUntilMs > nowMs;
    if (sentSet.has(candidate.dedupeKey) || batchSeen.has(candidate.dedupeKey) || inCooldown) {
      suppressedIds.push(candidate.candidateId);
      continue;
    }
    batchSeen.add(candidate.dedupeKey);
    const copy = cloneCandidate(candidate);

    if (copy.urgency === "urgent") {
      emitNow.push(copy);
      sentSet.add(copy.dedupeKey);
      continue;
    }
    if (flow.mode === "quiet_hours" || budget.quietHoursActive || (quota > 0 && nonUrgentSentCount >= quota)) {
      foldToMorningDigest.push(copy);
      if (!morningKeys.has(copy.dedupeKey)) {
        nextMorning.push(cloneCandidate(copy));
        morningKeys.add(copy.dedupeKey);
      }
      continue;
    }
    if (inDuoWindow) {
      holdForBoundary.push(copy);
      if (!boundaryKeys.has(copy.dedupeKey)) {
        nextBoundary.push(cloneCandidate(copy));
        boundaryKeys.add(copy.dedupeKey);
      }
      continue;
    }
    const inActiveContext =
      Boolean(copy.targetRefId) && (copy.targetRefId === flow.activeGoalId || copy.targetRefId === flow.activeProjectKey);
    const lowFlow = (flow.flowStrength ?? 0.7) < 0.45;
    if (flow.mode === "deep_focus" && !inActiveContext && !lowFlow) {
      holdForBoundary.push(copy);
      if (!boundaryKeys.has(copy.dedupeKey)) {
        nextBoundary.push(cloneCandidate(copy));
        boundaryKeys.add(copy.dedupeKey);
      }
      continue;
    }
    emitNow.push(copy);
    nonUrgentSentCount += 1;
    sentSet.add(copy.dedupeKey);
  }
  return {
    emitNow: [
      ...emitNow.filter((c) => c.urgency === "urgent"),
      ...emitNow.filter((c) => c.urgency !== "urgent"),
    ],
    holdForBoundary,
    foldToMorningDigest,
    suppressedIds,
    nextState: {
      dateKey: budget.dateKey,
      nonUrgentSentCount,
      dailySoftQuota: quota,
      quietHoursActive: Boolean(budget.quietHoursActive),
      sentDedupeKeys: Array.from(sentSet),
      morningDigestQueue: nextMorning.filter((item) => !sentSet.has(item.dedupeKey)),
      boundaryQueue: nextBoundary.filter((item) => !sentSet.has(item.dedupeKey)),
      topicCooldownUntilIso: cooldowns,
    },
  };
}

export function drainBoundaryQueue(
  state: CadenceBudgetState,
  isSuperseded: (candidate: ProactiveCandidate) => boolean,
): {
  emitNow: ProactiveCandidate[];
  supersededIds: string[];
  nextState: CadenceBudgetState;
} {
  const { deliverable, supersededIds } = filterSupersededBeforeSend(state.boundaryQueue ?? [], isSuperseded);
  const sentSet = new Set<string>(state.sentDedupeKeys ?? []);
  const emitNow: ProactiveCandidate[] = [];
  for (const candidate of deliverable) {
    if (sentSet.has(candidate.dedupeKey)) continue;
    sentSet.add(candidate.dedupeKey);
    emitNow.push(candidate);
  }
  const nextState: CadenceBudgetState = {
    ...cloneBudgetState(state),
    sentDedupeKeys: Array.from(sentSet),
    boundaryQueue: [],
  };
  return { emitNow, supersededIds, nextState };
}

export function collectRealtimeGoalDrift(
  ledger: LedgerSnapshot,
  activity: { offGoalMinutesToday: number; sideTaskLabel?: string },
  nowIso: string,
): ProactiveCandidate[] {
  const nowMs = parseTimestampMs(nowIso);
  if (!Number.isFinite(nowMs) || activity.offGoalMinutesToday < 180) return [];
  const dateKey = extractDateKey(nowIso);
  const results: ProactiveCandidate[] = [];
  const offHours = (activity.offGoalMinutesToday / 60).toFixed(1);

  for (const goal of ledger.goals ?? []) {
    if (goal.status !== "active") continue;
    const targetMs = parseTimestampMs(goal.targetDateIso);
    const lastMs = parseTimestampMs(goal.lastProgressAt);
    const nearDeadline = Number.isFinite(targetMs) && targetMs - nowMs <= 72 * MS_PER_HOUR;
    const idleHours = Number.isFinite(lastMs) ? (nowMs - lastMs) / MS_PER_HOUR : 0;
    if (!nearDeadline && idleHours < 20) continue;

    results.push({
      candidateId: `goal-drift:${goal.id}:${dateKey}`,
      dedupeKey: `goal_drift:${goal.id}:${dateKey}`,
      kind: "goal_imbalance",
      urgency: "normal",
      title: `偏航算账：${compactLine(goal.title, 40)}`,
      threeLineBody: buildThreeLineBody(
        `支线「${compactLine(activity.sideTaskLabel ?? "非主航道事项", 28)}」已投入 ${offHours} 小时`,
        `主目标「${compactLine(goal.title, 34)}」判据：${compactLine(goal.northStarCriterion, 42)}`,
        "回复 1 暂存支线切回主目标，或回复 2 今日忽略该偏差提醒",
      ),
      targetRefId: goal.id,
    });
  }
  return results;
}

export function collectGoalStagnationUnblock(
  ledger: LedgerSnapshot,
  goalRounds: Record<string, ReadonlyArray<{ status: string; informationGain?: number }>>,
  nowIso: string,
): ProactiveCandidate[] {
  const dateKey = extractDateKey(nowIso);
  const results: ProactiveCandidate[] = [];
  for (const goal of ledger.goals ?? []) {
    if (goal.status !== "active") continue;
    const rounds = goalRounds[goal.id] ?? [];
    if (rounds.length < 3) continue;
    const tail = rounds.slice(-3);
    const stagnant = tail.every(
      (r) => r.status === "failed" || (typeof r.informationGain === "number" && r.informationGain < 0.15),
    );
    if (!stagnant) continue;

    results.push({
      candidateId: `goal-unblock:${goal.id}:${dateKey}`,
      dedupeKey: `goal_unblock:${goal.id}:${dateKey}`,
      kind: "goal_unblock",
      urgency: "normal",
      title: `卡壳拆小步：${compactLine(goal.title, 40)}`,
      threeLineBody: buildThreeLineBody(
        `主目标「${compactLine(goal.title, 36)}」连续 3 轮低收益停滞`,
        "建议拆出 1 个 20 分钟内可验最小动作（先跑通最小闭环或发出催办草稿）",
        "回复 1 生成最小破局步，或回复 2 暂停调整主航道",
      ),
      targetRefId: goal.id,
    });
  }
  return results;
}