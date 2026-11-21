/**
 * 先翻家底、单点设问、准备先行的追问门控与目标引力场路由（src/sugent/clarification-gate.ts）
 *
 * 严格遵守内核纯度铁律：
 * - 零文件 I/O、零网络请求、零系统时钟读取、零随机数调用；
 * - 零模型供应商或即时通信平台名称硬编码；
 * - 动手前先用已召回的账本上下文消歧；仅在重名、高风险缺槽、空心化北极星目标或撞上墓碑/上限时
 *   发起最多 1 个带默认选项的追问，并把不依赖答案的前置准备步骤列出来先行做完。
 */

export const MAX_CLARIFICATION_TURNS = 2;

export type FocusGravityLane = "north_star" | "commitment_maintenance" | "icebox";

export type ClarificationReason =
  | "ambiguous_counterparty_or_slot"
  | "hollow_goal_criterion"
  | "goal_cap_or_tombstone_collision";

export interface ClarificationContactCandidate {
  id: string;
  name: string;
  roleTag?: string;
  preferences?: string[];
  taboos?: string[];
}

export interface ClarificationArchiveCandidate {
  id: string;
  title: string;
  localUriOrPath?: string;
}

export interface ClarificationGoalCandidate {
  id: string;
  title: string;
  northStarCriterion: string;
}

export interface ClarificationGuardrailCandidate {
  id: string;
  kind: "hard_redline" | "tombstone" | "soft_taste";
  statement: string;
}

export interface ClarificationInput {
  text: string;
  intentHint: "capture" | "recall" | "advise" | "delegate" | "goal_proposal";
  hasAttachments?: boolean;
  priorClarificationTurns?: number;
  recalledContacts: ClarificationContactCandidate[];
  recalledArchives: ClarificationArchiveCandidate[];
  activeGoals: ClarificationGoalCandidate[];
  guardrails: ClarificationGuardrailCandidate[];
}

export interface ClarificationVerdict {
  status: "clear_to_proceed" | "needs_clarification";
  focusLane: FocusGravityLane;
  matchedGoalIds: string[];
  resolvedFromMemory: boolean;
  reason?: ClarificationReason;
  question?: string;
  options?: [string, string];
  defaultFallbackAction?: string;
  nonBlockingPrepSteps: string[];
}

const COMMITMENT_CUE_RE =
  /(?:我答应|答应了|我承诺|承诺了|约好了|欠我|等.{1,16}(?:回复|回传|结果|交付|确认|盖章)|有效期|到期|年检|续费|截止|身份证|护照|驾照|合同|发票|报销|车停|取件)/;
const VERIFIABLE_CRITERION_RE =
  /(?:\d|完成|上线|通过|交付|闭环|签下|发布|前|月底|周[一二三四五六日天]|率|元|万|单|%|>=|<=)/;
const HIGH_STAKES_DISPATCH_RE = /(?:发报价|发给.{1,12}报价|发合同|签合同|转账|打款|付定金|付尾款|付款)/;
const CONCRETE_TERMS_RE =
  /(?:\d+\s*(?:元|万|千|块|折|%|天|月|年)|[一二三四五六七八九]折|标准版|基础版|企业版|专业版|原价)/;

const DOMAIN_CLUSTERS: readonly RegExp[] = [
  /(?:打折|折扣|[一二三四五六七八九]折|底价|降价|报价|压价|优惠|低价)/,
  /(?:合同|协议|违约|条款|盖章|签字|法务)/,
  /(?:转账|收款|打款|付款|定金|尾款|预算|现金流)/,
  /(?:公网|外发|群发|隐私|脱敏|泄密)/,
  /(?:跳过测试|不跑单测|重装|强推|越权)/,
];

function tokenizeForMatch(text: string): string[] {
  const tokens = new Set<string>();
  const lower = String(text ?? "").toLowerCase().trim();
  if (!lower) return [];
  for (const part of lower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’/\\_-]+/).filter(Boolean)) {
    for (const ascii of part.match(/[a-z0-9]{2,}/g) ?? []) tokens.add(ascii);
    const han = Array.from(part).filter((ch) => /\p{Script=Han}/u.test(ch));
    if (han.length === 1) tokens.add(han[0]!);
    for (let i = 0; i + 1 < han.length; i++) tokens.add(han[i]! + han[i + 1]!);
  }
  return Array.from(tokens);
}

function overlaps(a: string, b: string): boolean {
  const ta = tokenizeForMatch(a);
  const bLower = b.toLowerCase();
  if (ta.some((t) => bLower.includes(t))) return true;
  const tb = tokenizeForMatch(b);
  const aLower = a.toLowerCase();
  return tb.some((t) => aLower.includes(t));
}

function extractHonorificSurnames(text: string): string[] {
  const out = new Set<string>();
  const prefixRe = /(?:老|小|大)([\p{Script=Han}])/gu;
  for (const m of text.matchAll(prefixRe)) {
    if (m[1]) out.add(m[1]);
  }
  const suffixRe = /([\p{Script=Han}])(?:总|哥|姐|叔|姨|工|老师|经理|主任)/gu;
  for (const m of text.matchAll(suffixRe)) {
    if (m[1]) out.add(m[1]);
  }
  return Array.from(out);
}

function matchContacts(
  text: string,
  contacts: ClarificationContactCandidate[],
): { exact: ClarificationContactCandidate[]; ambiguous: ClarificationContactCandidate[] } {
  const exact: ClarificationContactCandidate[] = [];
  const seen = new Set<string>();
  for (const c of contacts) {
    if (!c.name || seen.has(c.id)) continue;
    seen.add(c.id);
    if (text.includes(c.name)) exact.push(c);
  }
  if (exact.length === 1) return { exact, ambiguous: [] };

  const surnames = extractHonorificSurnames(text);
  if (surnames.length === 0) return { exact, ambiguous: exact.length >= 2 ? exact : [] };

  const candidates: ClarificationContactCandidate[] = [];
  const seenCand = new Set<string>();
  for (const c of contacts) {
    if (seenCand.has(c.id)) continue;
    if (surnames.some((s) => c.name.startsWith(s) || c.name.includes(s))) {
      seenCand.add(c.id);
      candidates.push(c);
    }
  }
  if (candidates.length === 1) return { exact: candidates, ambiguous: [] };
  if (candidates.length >= 2) return { exact: [], ambiguous: candidates };
  return { exact: [], ambiguous: [] };
}

function buildPrepSteps(
  archives: ClarificationArchiveCandidate[],
  exactContact?: ClarificationContactCandidate,
): string[] {
  const steps: string[] = [];
  if (archives.length > 0) {
    steps.push(`已从本地档案翻出 ${archives.length} 份参考材料（${archives.map((a) => a.title).slice(0, 2).join("、")}）`);
  }
  if (exactContact) {
    const prefs = exactContact.preferences?.length ? `，偏好：${exactContact.preferences.join("/")}` : "";
    steps.push(`已调出「${exactContact.name}」过往脉络${prefs}`);
  }
  return steps;
}

export function evaluateClarificationAndFocus(input: ClarificationInput): ClarificationVerdict {
  const text = String(input.text ?? "").trim();
  const matchedGoalIds = (input.activeGoals ?? [])
    .filter((g) => overlaps(text, `${g.title} ${g.northStarCriterion}`))
    .map((g) => g.id);

  const focusLane: FocusGravityLane =
    matchedGoalIds.length > 0 || input.intentHint === "goal_proposal"
      ? "north_star"
      : input.intentHint === "delegate" ||
          input.intentHint === "advise" ||
          input.intentHint === "recall" ||
          Boolean(input.hasAttachments) ||
          COMMITMENT_CUE_RE.test(text)
        ? "commitment_maintenance"
        : "icebox";

  const contactMatch = matchContacts(text, input.recalledContacts ?? []);
  const prepSteps = buildPrepSteps(input.recalledArchives ?? [], contactMatch.exact[0]);
  const resolvedFromMemory = contactMatch.exact.length > 0 || (input.recalledArchives?.length ?? 0) > 0;

  if ((input.priorClarificationTurns ?? 0) >= MAX_CLARIFICATION_TURNS) {
    return { status: "clear_to_proceed", focusLane, matchedGoalIds, resolvedFromMemory, nonBlockingPrepSteps: prepSteps };
  }

  if (input.intentHint === "goal_proposal") {
    if ((input.activeGoals?.length ?? 0) >= 3) {
      const oldest = input.activeGoals[0]!;
      return {
        status: "needs_clarification",
        focusLane,
        matchedGoalIds,
        resolvedFromMemory: false,
        reason: "goal_cap_or_tombstone_collision",
        question: `当前已有 ${input.activeGoals.length} 个活跃主目标，新增前需要先做减法：把新目标替换「${oldest.title}」，还是先收入支线冰盒（Icebox）？`,
        options: [`1 替换「${oldest.title}」设为新主目标`, "2 暂存进支线冰盒，先不动当前主航道"],
        defaultFallbackAction: "暂存进支线冰盒（Icebox）",
        nonBlockingPrepSteps: ["已保留现有主目标进度与北极星判据未改动"],
      };
    }
    if (!VERIFIABLE_CRITERION_RE.test(text)) {
      return {
        status: "needs_clarification",
        focusLane,
        matchedGoalIds,
        resolvedFromMemory: false,
        reason: "hollow_goal_criterion",
        question: "这条主目标目前偏口号，缺少可核验的北极星过线判据：月底/本周以什么结果才算达成？",
        options: ["1 设定量化交付结果与截止日期", "2 先用最小可验证里程碑试跑 1 周"],
        defaultFallbackAction: "按最小可验证里程碑（7天试跑）立项",
        nonBlockingPrepSteps: ["已暂存目标标题，只待补齐可核验判据"],
      };
    }
  }

  if (input.intentHint === "delegate" && contactMatch.ambiguous.length >= 2) {
    const [c1, c2] = contactMatch.ambiguous;
    return {
      status: "needs_clarification",
      focusLane,
      matchedGoalIds,
      resolvedFromMemory: true,
      reason: "ambiguous_counterparty_or_slot",
      question: `本地人脉账本查到多位匹配联系人，这次具体指哪一位？`,
      options: [`1 ${c1!.name}${c1!.roleTag ? `（${c1!.roleTag}）` : ""}`, `2 ${c2!.name}${c2!.roleTag ? `（${c2!.roleTag}）` : ""}`],
      defaultFallbackAction: `暂停外发，等确认具体联系人后再填入模板`,
      nonBlockingPrepSteps: [...prepSteps, "已先按通用结构备好待发草稿框架，只待填入收件人"],
    };
  }

  if (input.intentHint === "delegate") {
    const hitGuard = (input.guardrails ?? []).find(
      (g) => g.kind !== "soft_taste" && (overlaps(text, g.statement) || DOMAIN_CLUSTERS.some((re) => re.test(text) && re.test(g.statement))),
    );
    if (hitGuard) {
      return {
        status: "needs_clarification",
        focusLane,
        matchedGoalIds,
        resolvedFromMemory: true,
        reason: "goal_cap_or_tombstone_collision",
        question: `该动作撞上历史${hitGuard.kind === "tombstone" ? "证伪墓碑" : "硬红线"}「${hitGuard.statement}」，要如何处理？`,
        options: ["1 按红线中止并改为合规替代方案", "2 仅保留本地草稿供你亲自微调后处理"],
        defaultFallbackAction: "按红线冻结外发并输出合规替代建议",
        nonBlockingPrepSteps: [...prepSteps, "已拦截直接执行，先列出历史避坑证据与参考档案"],
      };
    }
    if (HIGH_STAKES_DISPATCH_RE.test(text) && !CONCRETE_TERMS_RE.test(text) && (input.recalledArchives?.length ?? 0) === 0) {
      return {
        status: "needs_clarification",
        focusLane,
        matchedGoalIds,
        resolvedFromMemory,
        reason: "ambiguous_counterparty_or_slot",
        question: "账本里暂未翻到本次对应的历史报价/合同基线，请拍板口径后再向外草拟：",
        options: ["1 按标准版常规口径起草并保留确认卡", "2 先由你补充本次金额/折扣底线再生成"],
        defaultFallbackAction: "仅备好空白报价骨架，不外发任何数字",
        nonBlockingPrepSteps: [...prepSteps, "已起草不含敏感数字的沟通框架"],
      };
    }
  }

  return { status: "clear_to_proceed", focusLane, matchedGoalIds, resolvedFromMemory, nonBlockingPrepSteps: prepSteps };
}