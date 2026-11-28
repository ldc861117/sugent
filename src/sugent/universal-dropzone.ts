/**
 * Sugent Universal Dropzone — 零负担默认第一入口与无工具 80% 准备兜底
 *
 * 将任意渠道（热键 / 托盘拖拽 / 微信 / 飞书 / Web）丢入的文字或文件统一分流：
 * 1. capture（随手暂存）：只收不吵，返回单行极短回执；
 * 2. recall（秒翻家底）：按访问域隔离检索账本，仅 owner_private 可合并私有知识图谱；
 * 3. advise（利害参谋）：对照主目标、红线/墓碑与人脉禁忌权衡利弊；
 * 4. delegate（交代跑腿）：可自动化走 PersonalTrigger，无现成工具则兜底生成 HumanPrepBundle。
 */
import path from "node:path";
import {
  evaluateClarificationAndFocus,
  type ClarificationReason,
  type FocusGravityLane,
} from "./clarification-gate.js";
import { resolveSugentGatewayConfig, selectModelForRole } from "./gateway.js";
import type { SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { PersonalTrigger, SugentGatewayConfig } from "./types.js";

export type DropzonePartition = "personal_life" | "work_project" | "cowork_shared";
export type DropzoneCallerDomain = "owner_private" | "work_project" | "cowork_shared";

export interface DropzoneLedgerPort {
  upsertCommitment(
    input: {
      id?: string;
      partition: DropzonePartition;
      direction: "i_owe" | "waiting_for" | "expiring";
      status?: "open" | "snoozed" | "waiting_review" | "closed" | "superseded";
      summary: string;
      counterpartyOrRef: string;
      dueAt?: string;
      remindLeadDays?: number;
    },
    nowIso?: string,
  ): {
    id: string;
    partition: DropzonePartition;
    direction: "i_owe" | "waiting_for" | "expiring";
    status: "open" | "snoozed" | "waiting_review" | "closed" | "superseded";
    summary: string;
    counterpartyOrRef: string;
    dueAt?: string;
    remindLeadDays?: number;
    updatedAt: string;
  };
  upsertResource(
    input: {
      id?: string;
      partition: DropzonePartition;
      kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
      title: string;
      localUriOrPath?: string;
      expiresAt?: string;
      metadata: Record<string, string | number | boolean>;
    },
    nowIso?: string,
  ): {
    id: string;
    partition: DropzonePartition;
    kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
    title: string;
    localUriOrPath?: string;
    expiresAt?: string;
    metadata: Record<string, string | number | boolean>;
  };
  findArchiveResources(
    query: string,
    callerDomain?: DropzoneCallerDomain,
  ): Array<{
    id: string;
    partition: DropzonePartition;
    kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
    title: string;
    localUriOrPath?: string;
    expiresAt?: string;
    metadata: Record<string, string | number | boolean>;
  }>;
  queryContext(
    query: string,
    callerDomain?: DropzoneCallerDomain,
  ): {
    relationships: Array<{ id: string; name: string; taboos: string[]; preferences: string[]; openFavors: string[] }>;
    goals: Array<{ id: string; title: string; northStarCriterion: string; status: string }>;
    guardrails: Array<{
      id: string;
      kind: "hard_redline" | "tombstone" | "soft_taste";
      statement: string;
      enforcement: string;
      evidenceSource?: string;
    }>;
    commitments: Array<{ id: string; direction: string; status: string; summary: string; counterpartyOrRef: string; dueAt?: string }>;
    resources: Array<{ id: string; kind: string; title: string; localUriOrPath?: string; expiresAt?: string }>;
  };
  snapshotForCaller(callerDomain?: DropzoneCallerDomain): {
    relationships: Array<{ id: string; name: string; taboos: string[]; preferences: string[] }>;
    goals: Array<{ id: string; title: string; northStarCriterion: string; status: string }>;
    guardrails: Array<{ id: string; kind: "hard_redline" | "tombstone" | "soft_taste"; statement: string; enforcement: string }>;
  };
}

export type DropzoneIntentClass = "capture" | "recall" | "advise" | "delegate";
export type DropzoneChannel = "desktop_hotkey" | "tray_drop" | "weixin" | "feishu" | "web_ui";

export interface DropzoneInput {
  inputId: string;
  channel: DropzoneChannel;
  partition?: DropzonePartition;
  callerDomain?: DropzoneCallerDomain;
  senderId?: string;
  text: string;
  filePaths?: string[];
  receivedAtIso: string;
  priorClarificationTurns?: number;
}

export interface HumanPrepBundle {
  taskTitle: string;
  missingAutomationReason: string;
  checklist: string[];
  localMaterials: Array<{ label: string; localPath: string; expiresAt?: string }>;
  readyToCopyDrafts: Array<{ channelHint: string; text: string }>;
  followupCommitment: {
    partition: DropzonePartition;
    direction: "i_owe" | "waiting_for" | "expiring";
    status: "open";
    summary: string;
    counterpartyOrRef: string;
    dueAt?: string;
    remindLeadDays?: number;
  };
}

export type DropzoneOutcome =
  | { intent: "capture"; receiptLine: string; storedLedgerIds: string[]; focusLane?: FocusGravityLane; selectedModel: string }
  | { intent: "recall"; answer: string; matchedRefs: string[]; selectedModel: string }
  | { intent: "advise"; tradeOffBrief: string; guardrailWarnings: string[]; selectedModel: string }
  | {
      intent: "clarify";
      reason: ClarificationReason;
      question: string;
      options: [string, string];
      defaultFallbackAction: string;
      nonBlockingPrepSteps: string[];
      localMaterials: HumanPrepBundle["localMaterials"];
      focusLane: FocusGravityLane;
      selectedModel: string;
    }
  | { intent: "delegate"; mode: "automated_trigger"; trigger: PersonalTrigger; selectedModel: string }
  | { intent: "delegate"; mode: "human_prep_bundle"; bundle: HumanPrepBundle; followupCommitmentId: string; selectedModel: string };

export interface UniversalDropzoneOptions {
  ledger: DropzoneLedgerPort;
  knowledgeGraph?: SugentKnowledgeGraph;
  atlasRecall?: (query: string) => {
    nodes: Array<{ id: string; kind: string; name: string; summary: string; plane?: string; stratum?: string }>;
  };
  gatewayConfig?: SugentGatewayConfig;
  ownerId?: string;
  automatedCapabilities?: ReadonlySet<string>;
  adviseGenerator?: (ctx: { input: DropzoneInput; contextSummary: string; model: string }) => Promise<string>;
}
const ADVISE_RE =
  /(?:怎么回|如何回复|怎么谈|该不该|要不要|选哪个|怎么选|如何选|权衡|利弊|取舍|优先级|先做哪个|参谋|出主意|值不值得|合适吗|划算吗|风险高吗|压价|砍价|报价策略|底线|对比.*选|should\s+i\b|which\s+option|trade-?off|advise)/i;
const CAPTURE_EXPLICIT_RE = /(?:记一下|记下来|记录一下|存一下|存起来|暂存|留档|归档|备忘|收好|记住)/;
const QUERY_CUE_RE = /(?:[？?]|吗\s*$|呢\s*$|多少|在哪|哪里|怎么|什么|谁|几号|哪天|是否|有没有)/;
const CAPTURE_FACT_RE =
  /(?:车停在|车位|取件码|快递单号|运单号|发票抬头|税号|我答应|答应了|我承诺|承诺了|约好了|欠我|等.{1,15}(?:回复|回传|结果|交付|确认|盖章)|有效期至|将于.{1,15}到期|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}.*(?:到期|年检|续费))/;
const RECALL_RE =
  /(?:查一下|查下|查查|翻一下|翻出|找一下|找找|搜一下|检索|原话|出处|忌口|雷区|偏好|历史记录|在哪|在哪里|路径|是多少|几号到期|什么时候到期|违约金|怎么算|怎么写的|我欠|谁欠我|记不记得|lookup|recall|where\s+is|find\s+my)/i;
const RECALL_BLOCKER_RE =
  /(?:竞品|代码|单测|bug|重构|报告|办理|换证|续签|补办|预约|报销|贴票|修复|antigravity|联系房东|联系物业)/i;
const DELEGATE_TASK_RE =
  /(?:帮我|请帮|安排|派给|交给|执行|运行|修复|修一下|改一下|重构|写个|写一份|生成|整理|清理|巡检|监控|盯着|同步|打开|点击|截图|调研|研究一下|查竞品|办理|办一下|换证|续签|补办|年检|备案|挂号|预约|复查|改期|报销|贴票|催|联系房东|联系物业|报修|去银行|去政务|antigravity|vitest|npm\b|git\b|\bfix\b|\brefactor\b|\btest\b)/i;

/**
 * 纯函数：把任意渠道的 Dropzone 原始输入分流为四档之一（capture / recall / advise / delegate）
 */
export function classifyDropzoneIntent(
  input: Pick<DropzoneInput, "text" | "filePaths" | "channel">,
): DropzoneIntentClass {
  const text = input.text.trim();
  const hasFiles = (input.filePaths?.length ?? 0) > 0;
  if (!text) return "capture";
  if (ADVISE_RE.test(text)) return "advise";
  if (CAPTURE_EXPLICIT_RE.test(text)) return "capture";

  const hasQueryCue = QUERY_CUE_RE.test(text);
  const hasDelegateCue = DELEGATE_TASK_RE.test(text);
  if (hasFiles && input.channel === "tray_drop" && !hasQueryCue && !hasDelegateCue) return "capture";
  if (CAPTURE_FACT_RE.test(text) && !hasQueryCue && !hasDelegateCue) return "capture";
  if (RECALL_RE.test(text) && !RECALL_BLOCKER_RE.test(text)) return "recall";
  if (hasDelegateCue) return "delegate";
  if (hasFiles) return "capture";
  if (hasQueryCue) return "recall";
  return "capture";
}

function tokenizeQuery(text: string): string[] {
  const tokens = new Set<string>();
  const lower = text.toLowerCase().trim();
  if (!lower) return [];
  for (const part of lower.split(/[\s,.;:!?，。；：！？、()（）【】\[\]"'“”‘’/\\]+/).filter(Boolean)) {
    for (const ascii of part.match(/[a-z0-9_-]{2,}/g) ?? []) tokens.add(ascii);
    const cleaned = part.replace(/(请问|一下|帮我|怎么|什么|如何|现在|关于|可以|的|了|吗|呢|吧)/g, " ");
    for (const seg of cleaned.split(/\s+/).filter(Boolean)) {
      const han = Array.from(seg).filter((ch) => /\p{Script=Han}/u.test(ch));
      if (han.length === 1) tokens.add(han[0]!);
      for (let i = 0; i + 1 < han.length; i++) tokens.add(han[i]! + han[i + 1]!);
    }
  }
  return Array.from(tokens);
}

function hasKeywordOverlap(a: string, b: string): boolean {
  const ta = tokenizeQuery(a);
  const tbLower = b.toLowerCase();
  if (ta.some((t) => tbLower.includes(t))) return true;
  const tb = tokenizeQuery(b);
  const taLower = a.toLowerCase();
  return tb.some((t) => taLower.includes(t));
}

function extractIsoDateHint(text: string): string | undefined {
  const m = text.match(/(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?/);
  if (!m) return undefined;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}T09:00:00.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : undefined;
}

function addDaysIso(baseIso: string, days: number): string | undefined {
  const ms = Date.parse(baseIso);
  return Number.isFinite(ms) ? new Date(ms + days * 86_400_000).toISOString() : undefined;
}
function summarizeTitle(text: string, maxLen = 36): string {
  const cleaned = text
    .replace(/^(?:请?帮我)?(?:记一下|记下来|记录一下|存一下|存起来|暂存|留档|归档|备忘|办理|办一下)[：:，,\s]*/, "")
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (!cleaned) return "未命名事项";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

function detectCommitmentDirection(text: string): "i_owe" | "waiting_for" | "expiring" | undefined {
  if (/(?:到期|年检|续费|有效期|过期|截止)/.test(text)) return "expiring";
  if (/(?:欠我|等.{1,16}(?:回复|回传|结果|交付|确认|盖章)|待对方)/.test(text)) return "waiting_for";
  if (/(?:我答应|答应了|我承诺|承诺了|约好了|要发给|答应给)/.test(text)) return "i_owe";
  return undefined;
}

function extractCounterparty(text: string, fallback: string): string {
  const m = text.match(/(?:给|向|等|和|与)([\p{Script=Han}A-Za-z0-9_]{1,12}?)(?:回复|回传|发|交|沟通|确认|修|办|的|$|\s)/u);
  return m?.[1]?.trim() || fallback;
}

const DOMAIN_CLUSTERS: readonly RegExp[] = [
  /(?:打折|折扣|[一二三四五六七八九]折|底价|降价|报价|压价|优惠|低价)/,
  /(?:合同|协议|违约|条款|盖章|签字|法务)/,
  /(?:转账|收款|打款|付款|定金|尾款|预算|现金流)/,
  /(?:公网|外发|群发|隐私|脱敏|泄密)/,
  /(?:跳过测试|不跑单测|重装|强推|越权)/,
];

function hasDomainOverlap(a: string, b: string): boolean {
  return DOMAIN_CLUSTERS.some((re) => re.test(a) && re.test(b));
}

function collectAdviseWarnings(
  inputText: string,
  ctx: ReturnType<DropzoneLedgerPort["queryContext"]>,
  snapshot: ReturnType<DropzoneLedgerPort["snapshotForCaller"]>,
): string[] {
  const warnings: string[] = [];
  const seenGuardIds = new Set<string>();
  const ctxGuardMap = new Map(ctx.guardrails.map((g) => [g.id, g]));
  const allGuards = [...ctx.guardrails, ...snapshot.guardrails];

  for (const g of allGuards) {
    if (seenGuardIds.has(g.id) || g.kind === "soft_taste") continue;
    const hitByQuery = ctxGuardMap.has(g.id);
    const hitByText = hasKeywordOverlap(inputText, g.statement) || hasDomainOverlap(inputText, g.statement);
    if (!hitByQuery && !hitByText) continue;
    seenGuardIds.add(g.id);
    const prefix = g.kind === "tombstone" ? "[证伪墓碑预警]" : "[硬红线预警]";
    const ev = ctxGuardMap.get(g.id)?.evidenceSource;
    warnings.push(ev ? `${prefix} ${g.statement}（来源：${ev}）` : `${prefix} ${g.statement}`);
  }

  const seenRelIds = new Set<string>();
  for (const rel of [...ctx.relationships, ...snapshot.relationships]) {
    if (seenRelIds.has(rel.id)) continue;
    const mentioned = ctx.relationships.some((r) => r.id === rel.id) || inputText.includes(rel.name);
    if (!mentioned || rel.taboos.length === 0) continue;
    seenRelIds.add(rel.id);
    warnings.push(`[人脉禁忌提醒:${rel.name}] ${rel.taboos.join("；")}`);
  }
  return warnings;
}

function buildDeterministicTradeOff(
  inputText: string,
  goals: Array<{ title: string; northStarCriterion: string; status: string }>,
  warnings: string[],
  softTastes: Array<{ statement: string }>,
): string {
  const activeGoals = goals.filter((g) => g.status === "active");
  const goalLine = activeGoals.length
    ? `当前主航道：${activeGoals.map((g) => `「${g.title}」（判据：${g.northStarCriterion}）`).join("；")}。`
    : "当前暂未登记活跃主目标，按风险可控优先评估。";
  const warnLine = warnings.length
    ? `风险与禁忌核对：${warnings.join(" | ")}。`
    : "风险与禁忌核对：未撞上已知硬红线或证伪墓碑。";
  const tasteLine = softTastes.length ? `偏好约束：${softTastes.map((t) => t.statement).join("；")}。` : "";
  const actionLine = warnings.length
    ? `建议对策（针对「${summarizeTitle(inputText, 24)}」）：方案A守住上述红线明确拒绝或设前置条件；方案B给出等价替代范围（如分期或缩减交付），切勿口头退让。`
    : `建议对策（针对「${summarizeTitle(inputText, 24)}」）：方案A先用最小可控动作验证收益再投入；方案B若偏离当前主航道则排入延后清单。`;
  return [goalLine, warnLine, tasteLine, actionLine].filter(Boolean).join("\n");
}
const ANTIGRAVITY_RE =
  /(?:antigravity|ag\s*任务|派给\s*antigravity|特种兵团|swarm|深度调研|多文件重构|架构重构|重装研发)/i;
const COMPUTER_USE_RE =
  /(?:桌面|gui|点击|窗口|鼠标|截图|快捷键|浏览器操作|app\s*界面|cua)/i;
const AUTOMATED_OPS_RE =
  /(?:代码|仓库|repo|git\b|pr\b|issue|单测|单元测试|vitest|pytest|tsc|typecheck|build|bug|修复|重构|脚本|整理.*文件|归档.*目录|重命名文件|定时|巡检|监控|盯着|cron|ci|deploy|查竞品|竞品动向)/i;
const OFFLINE_ERRAND_RE =
  /(?:政务|换证|补办|身份证|护照|驾照|行驶证|车管所|年检|备案|工商|税务|营业执照|社保|医保|公积金|派出所|公证|银行|开户|医院|挂号|复查|体检|门诊|房东|物业|水电|燃气|修空调|修水管|漏水|线下|纸质报销|贴票|发票报销|寄快递|政务窗口|办事窗口|服务窗口|柜台)/i;

function sanitizeDraftAgainstTaboos(text: string, taboos: readonly string[]): string {
  let out = text;
  for (const raw of taboos) {
    const core = raw
      .trim()
      .replace(/^(?:忌|勿|别|不要|不可|禁止|不谈|不提|不能|讨厌|反感|不接受)+/, "")
      .replace(/^(?:提|谈|讲|问|说)+/, "")
      .trim();
    if (core.length >= 2 && out.includes(core)) {
      out = out.split(core).join("相关细节");
    }
    const rawTrim = raw.trim();
    if (rawTrim.length >= 2 && out.includes(rawTrim)) {
      out = out.split(rawTrim).join("相关细节");
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

interface PrepDomainTemplate {
  missingAutomationReason: string;
  checklist: string[];
  channelHint: string;
  buildDraft: (contactLabel: string, topic: string) => string;
  archiveProbes: string[];
  direction: "i_owe" | "waiting_for";
}

function selectPrepTemplate(text: string): PrepDomainTemplate {
  if (/(?:房东|物业|水电|燃气|漏水|修空调|修水管|报修)/.test(text)) {
    return {
      missingAutomationReason: "涉及房东或物业的线下维修协调与沟通拍板，外发消息受防社死护栏锁定，需本人确认后发送。",
      checklist: [
        "拍照记录现场问题位置与影响范围，避免口头描述不清",
        "核对租房或物业合同中的维修责任与费用归属条款",
        "复制下方沟通草稿与对方约妥方便的上门时段",
        "维修完成后现场验收并更新跟进待办状态",
      ],
      channelHint: "微信/短信给房东或物业",
      buildDraft: (who, topic) => `您好${who}，关于「${topic}」的情况麻烦协助处理，想约一个您方便的白天或工作日晚间时段上门查看，您看哪天合适？`,
      archiveProbes: ["租房", "合同", "物业", "房产"],
      direction: "waiting_for",
    };
  }
  if (/(?:银行|医院|挂号|复查|体检|门诊)/.test(text)) {
    return {
      missingAutomationReason: "银行与医院手续涉及实名证件核验、生物识别或门诊确认，无外部直连办理接口。",
      checklist: [
        "确认预约渠道（官方公众号/小程序或客服电话）与放号时段",
        "核齐身份证、银行卡/医保卡及历史单据等随身材料",
        "提前到场预留排队与身份核验时间",
        "办结后拍照留存回执或预约单并关闭跟进事项",
      ],
      channelHint: "预约客服或窗口核对小抄",
      buildDraft: (who, topic) => `您好${who}，我想咨询并预约「${topic}」，请问目前最早可约时段及现场需要带齐哪些原件？谢谢。`,
      archiveProbes: ["身份证", "医保", "病历", "银行", "保单"],
      direction: "i_owe",
    };
  }
  if (/(?:纸质报销|贴票|发票报销|报销)/.test(text)) {
    return {
      missingAutomationReason: "纸质发票贴票、财务核销与签字移交需线下手工完成，暂无法全自动闭环报销。",
      checklist: [
        "按费用类别与发生日期整理纸质发票并检查抬头税号",
        "对照本地电子发票与行程单补齐缺失附件路径",
        "粘贴票据并填写报销汇总金额与事由说明",
        "提交财务审批并追踪打款到账时间",
      ],
      channelHint: "财务报销说明草稿",
      buildDraft: (who, topic) => `您好${who}，已整理好「${topic}」相关票据与电子附件，请查收并告知本次报销预计审核节点，辛苦了。`,
      archiveProbes: ["发票", "报销", "抬头", "行程"],
      direction: "i_owe",
    };
  }
  return {
    missingAutomationReason: "政务窗口、实名备案或线下事务需本人刷脸/签字核验，没有开放全自动代办 API。",
    checklist: [
      "先在官方政务服务平台或热线确认最新受理条件与预约窗口",
      "按下方清单核齐本地证件原件、扫描件与申请表格",
      "避开高峰时段提交预约或递交线下材料",
      "领证或备案完成后更新本地档案有效期记录",
    ],
    channelHint: "窗口/热线确认话术",
    buildDraft: (who, topic) => `您好${who}，咨询办理「${topic}」，请问线上预审入口在哪里，现场办理还需额外准备哪些材料？谢谢。`,
    archiveProbes: ["护照", "身份证", "营业执照", "驾照", "证件", "合同"],
    direction: "i_owe",
  };
}
export class UniversalDropzone {
  private readonly ledger: DropzoneLedgerPort;
  private readonly knowledgeGraph?: SugentKnowledgeGraph;
  private readonly atlasRecall?: UniversalDropzoneOptions["atlasRecall"];
  private readonly gatewayConfig: SugentGatewayConfig;
  private readonly ownerId: string;
  private readonly automatedCapabilities: ReadonlySet<string>;
  private readonly adviseGenerator?: UniversalDropzoneOptions["adviseGenerator"];

  constructor(options: UniversalDropzoneOptions) {
    this.ledger = options.ledger;
    this.knowledgeGraph = options.knowledgeGraph;
    this.atlasRecall = options.atlasRecall;
    this.gatewayConfig = options.gatewayConfig ?? resolveSugentGatewayConfig();
    this.ownerId = options.ownerId ?? "owner";
    this.automatedCapabilities = options.automatedCapabilities ?? new Set<string>();
    this.adviseGenerator = options.adviseGenerator;
  }

  async handle(input: DropzoneInput): Promise<DropzoneOutcome> {
    const partition: DropzonePartition =
      input.partition ??
      (input.callerDomain === "work_project"
        ? "work_project"
        : input.callerDomain === "cowork_shared"
          ? "cowork_shared"
          : "personal_life");
    const callerDomain: DropzoneCallerDomain =
      input.callerDomain ?? (partition === "personal_life" ? "owner_private" : partition);

    const intent = classifyDropzoneIntent(input);
    switch (intent) {
      case "capture":
        return this.handleCapture(input, partition, callerDomain);
      case "recall":
        return this.handleRecall(input, callerDomain);
      case "advise":
        return this.handleAdvise(input, callerDomain);
      case "delegate":
        return this.handleDelegate(input, partition, callerDomain);
    }
  }

  private handleCapture(
    input: DropzoneInput,
    partition: DropzonePartition,
    callerDomain: DropzoneCallerDomain,
  ): DropzoneOutcome {
    const selectedModel = selectModelForRole(this.gatewayConfig, "assessor");
    const trimmed = input.text.replace(/[\r\n]+/g, " ").trim();
    const dueAt = extractIsoDateHint(trimmed);
    const storedLedgerIds: string[] = [];
    const files = input.filePaths ?? [];
    const snapshot = this.ledger.snapshotForCaller(callerDomain);
    const { focusLane } = evaluateClarificationAndFocus({
      text: trimmed,
      intentHint: "capture",
      hasAttachments: files.length > 0,
      recalledContacts: [],
      recalledArchives: [],
      activeGoals: snapshot.goals.filter((g) => g.status === "active"),
      guardrails: [],
    });

    for (const fp of files) {
      const base = path.basename(fp) || fp;
      const title = trimmed ? `${summarizeTitle(trimmed, 24)} (${base})` : base;
      const res = this.ledger.upsertResource(
        {
          partition,
          kind: "personal_archive",
          title,
          localUriOrPath: fp,
          ...(dueAt ? { expiresAt: dueAt } : {}),
          metadata: { channel: input.channel, sourceInputId: input.inputId, receivedAt: input.receivedAtIso, ...(trimmed ? { note: trimmed } : {}) },
        },
        input.receivedAtIso,
      );
      storedLedgerIds.push(res.id);
    }

    const direction = trimmed ? detectCommitmentDirection(trimmed) : undefined;
    if (direction) {
      const item = this.ledger.upsertCommitment(
        {
          partition,
          direction,
          status: "open",
          summary: trimmed,
          counterpartyOrRef: extractCounterparty(trimmed, input.senderId ?? this.ownerId),
          ...(dueAt ? { dueAt } : {}),
          ...(direction === "expiring" ? { remindLeadDays: 14 } : {}),
        },
        input.receivedAtIso,
      );
      storedLedgerIds.push(item.id);
    } else if (files.length === 0) {
      const res = this.ledger.upsertResource(
        {
          partition,
          kind: "personal_archive",
          title: summarizeTitle(trimmed, 36),
          ...(dueAt ? { expiresAt: dueAt } : {}),
          metadata: { channel: input.channel, note: trimmed, focusLane, sourceInputId: input.inputId, receivedAt: input.receivedAtIso },
        },
        input.receivedAtIso,
      );
      storedLedgerIds.push(res.id);
    }

    const label = summarizeTitle(trimmed || (files[0] ? path.basename(files[0]) : "备忘"), 28);
    const receiptLine = (
      direction
        ? `已记入待办台账「${label}」(${storedLedgerIds[0]})。`
        : files.length > 0
          ? `已归档 ${files.length} 份材料「${label}」。`
          : focusLane === "icebox"
            ? `已暂存至支线冰盒「${label}」（不打扰主航道）。`
            : `已收进本地档案「${label}」。`
    ).replace(/[\r\n]+/g, " ").trim();

    return { intent: "capture", receiptLine, storedLedgerIds, focusLane, selectedModel };
  }
  private handleRecall(input: DropzoneInput, callerDomain: DropzoneCallerDomain): DropzoneOutcome {
    const selectedModel = selectModelForRole(this.gatewayConfig, "assessor");
    const ctx = this.ledger.queryContext(input.text, callerDomain);
    const archives = this.ledger.findArchiveResources(input.text, callerDomain);
    const atlasRes = callerDomain === "owner_private" ? this.atlasRecall?.(input.text) : undefined;
    const kgSub =
      callerDomain === "owner_private" && (!atlasRes || atlasRes.nodes.length === 0)
        ? this.knowledgeGraph?.recallSubgraph(input.text, 2)
        : undefined;

    const refs = new Set<string>();
    const snippets: string[] = [];
    const archiveById = new Map(archives.map((a) => [a.id, a]));

    for (const r of [...ctx.resources, ...archives]) {
      const first = !refs.has(r.id);
      refs.add(r.id);
      if (r.localUriOrPath) refs.add(r.localUriOrPath);
      if (!first) continue;
      const metaNote = archiveById.get(r.id)?.metadata?.note;
      const loc = r.localUriOrPath ? ` @ ${r.localUriOrPath}` : "";
      const exp = r.expiresAt ? ` (到期:${r.expiresAt})` : "";
      const noteText = typeof metaNote === "string" && metaNote !== r.title ? `: ${metaNote}` : "";
      snippets.push(`[档案] ${r.title}${noteText}${loc}${exp}`);
    }
    for (const rel of ctx.relationships) {
      refs.add(rel.id);
      const parts = [
        rel.taboos.length ? `忌讳:${rel.taboos.join("/")}` : "",
        rel.preferences.length ? `偏好:${rel.preferences.join("/")}` : "",
        rel.openFavors.length ? `人情:${rel.openFavors.join("/")}` : "",
      ].filter(Boolean);
      snippets.push(`[人脉] ${rel.name}${parts.length ? ` (${parts.join("；")})` : ""}`);
    }
    for (const c of ctx.commitments) {
      refs.add(c.id);
      snippets.push(`[事项:${c.direction}/${c.status}] ${c.summary} -> ${c.counterpartyOrRef}${c.dueAt ? ` (${c.dueAt})` : ""}`);
    }
    for (const g of ctx.goals) {
      refs.add(g.id);
      snippets.push(`[目标:${g.status}] ${g.title}（${g.northStarCriterion}）`);
    }
    for (const gr of ctx.guardrails) {
      refs.add(gr.id);
      snippets.push(`[规则:${gr.kind}] ${gr.statement}`);
    }
    if (atlasRes && atlasRes.nodes.length > 0) {
      for (const n of atlasRes.nodes) {
        refs.add(n.id);
        snippets.push(`[图谱:${n.plane ? `${n.plane}|` : ""}${n.kind}] ${n.name}: ${n.summary}`);
      }
    } else if (kgSub && kgSub.matchedNodes.length > 0) {
      for (const n of kgSub.matchedNodes) {
        refs.add(n.id);
        snippets.push(`[图谱:${n.kind}] ${n.name}: ${n.summary}`);
      }
    }

    const answer = snippets.length
      ? snippets.join("\n")
      : `当前访问域(${callerDomain})下暂未查到「${summarizeTitle(input.text, 28)}」相关记录。`;
    return { intent: "recall", answer, matchedRefs: Array.from(refs), selectedModel };
  }

  private async handleAdvise(input: DropzoneInput, callerDomain: DropzoneCallerDomain): Promise<DropzoneOutcome> {
    const selectedModel = selectModelForRole(this.gatewayConfig, "steward");
    const ctx = this.ledger.queryContext(input.text, callerDomain);
    const snapshot = this.ledger.snapshotForCaller(callerDomain);
    const guardrailWarnings = collectAdviseWarnings(input.text, ctx, snapshot);
    const softTastes = snapshot.guardrails.filter((g) => g.kind === "soft_taste");
    const deterministic = buildDeterministicTradeOff(input.text, snapshot.goals, guardrailWarnings, softTastes);

    let tradeOffBrief = deterministic;
    if (this.adviseGenerator) {
      const generated = await this.adviseGenerator({ input, contextSummary: deterministic, model: selectedModel });
      if (generated.trim()) tradeOffBrief = generated.trim();
    }
    return { intent: "advise", tradeOffBrief, guardrailWarnings, selectedModel };
  }
  private handleDelegate(
    input: DropzoneInput,
    partition: DropzonePartition,
    callerDomain: DropzoneCallerDomain,
  ): DropzoneOutcome {
    const ctx = this.ledger.queryContext(input.text, callerDomain);
    const snapshot = this.ledger.snapshotForCaller(callerDomain);
    const template = selectPrepTemplate(input.text);
    const localMaterials = this.collectLocalMaterials(input.text, template.archiveProbes, callerDomain);
    const contactMap = new Map<string, (typeof snapshot.relationships)[number]>();
    for (const r of [...snapshot.relationships, ...ctx.relationships]) contactMap.set(r.id, r);

    const clar = evaluateClarificationAndFocus({
      text: input.text,
      intentHint: "delegate",
      hasAttachments: (input.filePaths?.length ?? 0) > 0,
      priorClarificationTurns: input.priorClarificationTurns,
      recalledContacts: Array.from(contactMap.values()),
      recalledArchives: localMaterials.map((m, idx) => ({ id: `mat-${idx}`, title: m.label, localUriOrPath: m.localPath })),
      activeGoals: snapshot.goals.filter((g) => g.status === "active"),
      guardrails: snapshot.guardrails,
    });
    if (clar.status === "needs_clarification" && clar.question && clar.options) {
      return {
        intent: "clarify",
        reason: clar.reason!,
        question: clar.question,
        options: clar.options,
        defaultFallbackAction: clar.defaultFallbackAction ?? "保持本地草稿等待确认",
        nonBlockingPrepSteps: clar.nonBlockingPrepSteps,
        localMaterials,
        focusLane: clar.focusLane,
        selectedModel: selectModelForRole(this.gatewayConfig, "assessor"),
      };
    }

    const lower = input.text.toLowerCase();
    const matchesCap = Array.from(this.automatedCapabilities).some((c) => c.trim() && lower.includes(c.trim().toLowerCase()));
    const isAntigravity = ANTIGRAVITY_RE.test(input.text);
    const isComputerUse = COMPUTER_USE_RE.test(input.text);
    const isAutomatedOps = AUTOMATED_OPS_RE.test(input.text);
    const isOfflineErrand = OFFLINE_ERRAND_RE.test(input.text);

    if (matchesCap || (!isOfflineErrand && (isAntigravity || isComputerUse || isAutomatedOps))) {
      const role = isComputerUse ? "computer_use" : "executor";
      const selectedModel = selectModelForRole(this.gatewayConfig, role);
      const sourceKind = (isAntigravity ? "antigravity" : "im_channel") as PersonalTrigger["sourceKind"];
      const trigger: PersonalTrigger = {
        id: `drop-${input.inputId}`,
        sourceKind,
        sourceInstanceId: `dropzone:${input.channel}`,
        threadKey: `${input.channel}:${input.senderId ?? this.ownerId}`,
        senderId: input.senderId ?? this.ownerId,
        addressedToAgent: true,
        fromAllowedSender: true,
        text: input.text,
        createdAt: input.receivedAtIso,
        meta: {
          channel: input.channel,
          partition,
          callerDomain,
          recommendedRole: role,
          selectedModel,
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
        },
      };
      return { intent: "delegate", mode: "automated_trigger", trigger, selectedModel };
    }

    return this.buildHumanPrepBundle(input, partition, callerDomain);
  }

  private collectLocalMaterials(
    text: string,
    probes: readonly string[],
    callerDomain: DropzoneCallerDomain,
  ): HumanPrepBundle["localMaterials"] {
    const seen = new Set<string>();
    const materials: HumanPrepBundle["localMaterials"] = [];
    const appendFrom = (q: string): void => {
      for (const r of this.ledger.findArchiveResources(q, callerDomain)) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        const localPath = r.localUriOrPath ?? String(r.metadata?.localPath ?? `archive://${r.id}`);
        materials.push({ label: r.title, localPath, ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}) });
      }
    };
    appendFrom(text);
    for (const p of probes.filter((kw) => text.includes(kw))) appendFrom(p);
    if (materials.length === 0) {
      for (const p of probes) appendFrom(p);
    }
    return materials;
  }
  private buildHumanPrepBundle(
    input: DropzoneInput,
    partition: DropzonePartition,
    callerDomain: DropzoneCallerDomain,
  ): DropzoneOutcome {
    const selectedModel = selectModelForRole(this.gatewayConfig, "executor");
    const template = selectPrepTemplate(input.text);
    const ctx = this.ledger.queryContext(input.text, callerDomain);
    const snapshot = this.ledger.snapshotForCaller(callerDomain);

    const matchedContact =
      snapshot.relationships.find((r) => input.text.includes(r.name)) ??
      ctx.relationships[0] ??
      snapshot.relationships.find((r) => hasKeywordOverlap(input.text, r.name));
    const taboos = matchedContact?.taboos ?? [];
    const contactLabel = matchedContact?.name ?? "";
    const taskTitle = summarizeTitle(input.text, 36);
    const safeTopic = sanitizeDraftAgainstTaboos(taskTitle, taboos);
    const draftText = sanitizeDraftAgainstTaboos(template.buildDraft(contactLabel, safeTopic), taboos);

    const localMaterials = this.collectLocalMaterials(input.text, template.archiveProbes, callerDomain);
    const dueAt = extractIsoDateHint(input.text) ?? addDaysIso(input.receivedAtIso, 3);
    const followupCommitment: HumanPrepBundle["followupCommitment"] = {
      partition,
      direction: template.direction,
      status: "open",
      summary: `跟进办理：${taskTitle}`,
      counterpartyOrRef: matchedContact?.name ?? `dropzone:${input.inputId}`,
      ...(dueAt ? { dueAt } : {}),
      remindLeadDays: 1,
    };
    const saved = this.ledger.upsertCommitment(followupCommitment, input.receivedAtIso);

    const bundle: HumanPrepBundle = {
      taskTitle,
      missingAutomationReason: template.missingAutomationReason,
      checklist: template.checklist,
      localMaterials,
      readyToCopyDrafts: [{ channelHint: template.channelHint, text: draftText }],
      followupCommitment,
    };

    return {
      intent: "delegate",
      mode: "human_prep_bundle",
      bundle,
      followupCommitmentId: saved.id,
      selectedModel,
    };
  }
}
