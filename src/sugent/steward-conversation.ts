import type { ConciergeChannelKind } from "./concierge-envelope.js";
import type { CommandExecutionOutcome, PublicEarpieceCardView } from "./concierge-dispatcher.js";
import type { ProactiveCandidate } from "./proactive-cadence.js";
import type {
  CallerAccessDomain,
  CommitmentItem,
  ContextPartition,
  GoalNorthStar,
  LedgerSnapshot,
  RelationshipProfile,
  TrustTier,
} from "./stewardship-ledger.js";
import type { BotBudgetStatus } from "./local-budget.js";
import type { DropzoneChannel, DropzoneOutcome } from "./universal-dropzone.js";
import type { VibeIngressChannel } from "./handoff-file-bridge.js";
import type { RepoBindingRecord, UpsertRepoBindingInput } from "./repo-binding.js";
import { SocialImVibeAdapter, type VibePipelineRecord } from "./vibe-coding-pipeline.js";
import type { CapabilityAwarenessSnapshot } from "./capability-awareness.js";
import type { AuthorizedFileMatch, ReadAuthorizedFileResult } from "./authorized-file-reader.js";

export interface StewardConversationTurnInput {
  text: string;
  channel?: DropzoneChannel;
  callerDomain?: CallerAccessDomain;
  partition?: ContextPartition;
  filePaths?: string[];
}

export type StewardConversationIntent =
  | "pending_goal_replace"
  | "pending_concierge_confirm"
  | "concierge_undo"
  | "concierge_query"
  | "concierge_reply"
  | "quiet_hours"
  | "briefing"
  | "goals_query"
  | "goal_add"
  | "goal_status"
  | "commitments_query"
  | "commitment_close"
  | "agy_privacy"
  | "agy_viewed"
  | "agy_query"
  | "trust_adjust"
  | "overview"
  | "vibe_bind"
  | "vibe_start"
  | "vibe_decide"
  | "file_read"
  | "capability_status"
  | "dropzone"
  | "llm_agent";

export interface StewardConversationResult<TWorkbench = unknown> {
  ok: true;
  intent: StewardConversationIntent;
  reply: string;
  outcome?: DropzoneOutcome;
  workbench: TWorkbench;
}

export interface StewardConciergeView {
  enabled: boolean;
  ownerDisplayName: string;
  coolingWindowMs: number;
  cards: PublicEarpieceCardView[];
  pendingDispatches: Array<{
    dispatchId: string;
    cardId: string;
    channel: ConciergeChannelKind;
    peerId: string;
    peerDisplayName: string;
    finalBody: string;
    remainingMs: number;
  }>;
}

export interface StewardWorkbenchLike {
  callerDomain: CallerAccessDomain;
  quietHoursActive: boolean;
  ledger: LedgerSnapshot;
  budgetStatus?: BotBudgetStatus;
  cadence: {
    dateKey: string;
    state: { nonUrgentSentCount: number; dailySoftQuota: number; morningDigestQueue: ProactiveCandidate[] };
  };
  antigravity: {
    surfacesScanned: string[];
    totalSessions: number;
    totalSubagentsFolded: number;
    sessions: Array<{
      uid: string;
      conversationId: string;
      projectKey: string;
      projectDisplayName?: string;
      title: string;
      subagentCount: number;
      activeSubagentCount?: number;
      stepCount?: number;
      isRunning?: boolean;
      hasError?: boolean;
      status: string;
      superseded?: boolean;
      supersededReasons?: string[];
    }>;
    projects: Array<{
      projectKey: string;
      displayName?: string;
      aliases?: string[];
      title: string;
      sessionCount: number;
      runningSessionCount?: number;
      subagentCount: number;
      policy: { tier: 0 | 1 | 2 };
    }>;
  };
  concierge?: StewardConciergeView;
  vibeCoding?: { bindings: RepoBindingRecord[]; pipelines: VibePipelineRecord[] };
  capabilities?: CapabilityAwarenessSnapshot;
}
export interface StewardConversationHostPort<TWorkbench extends StewardWorkbenchLike = StewardWorkbenchLike> {
  getWorkbench(callerDomain?: CallerAccessDomain): TWorkbench;
  submitDropzone(input: {
    text: string;
    channel?: DropzoneChannel;
    partition?: ContextPartition;
    callerDomain?: CallerAccessDomain;
    filePaths?: string[];
  }): Promise<{ ok: true; outcome: DropzoneOutcome; formattedReply: string; workbench: TWorkbench }>;
  mutateTrust(input: {
    id: string;
    action: "observe" | "promote_l3" | "downgrade";
    ownerConfirmed?: boolean;
    targetTier?: TrustTier;
    directiveText?: string;
    callerDomain?: CallerAccessDomain;
  }): { ok: boolean; errorCode?: string; message?: string; profile?: RelationshipProfile; workbench: TWorkbench };
  mutateGoal(input: {
    action: "upsert" | "status";
    id?: string;
    partition?: ContextPartition;
    title?: string;
    northStarCriterion?: string;
    status?: GoalNorthStar["status"];
    supersedeGoalId?: string;
    callerDomain?: CallerAccessDomain;
  }): { ok: boolean; errorCode?: string; message?: string; goal?: GoalNorthStar; activeGoals?: GoalNorthStar[]; workbench: TWorkbench };
  mutateCommitment(input: {
    action: "upsert" | "status";
    id?: string;
    partition?: ContextPartition;
    direction?: CommitmentItem["direction"];
    summary?: string;
    counterpartyOrRef?: string;
    status?: CommitmentItem["status"];
    callerDomain?: CallerAccessDomain;
  }): { ok: true; commitment: CommitmentItem; workbench: TWorkbench };
  scanCadence(input?: { quietHoursActive?: boolean; calibrationDue?: boolean; callerDomain?: CallerAccessDomain }): {
    emitNow: ProactiveCandidate[];
    foldToMorningDigest: ProactiveCandidate[];
    suppressedIds: string[];
    workbench: TWorkbench;
  };
  setQuietHours(active: boolean, callerDomain?: CallerAccessDomain): { quietHoursActive: boolean; workbench: TWorkbench };
  setProjectTier(input: { projectKey: string; tier: 0 | 1 | 2; callerDomain?: CallerAccessDomain }): { workbench: TWorkbench };
  markSessionViewed(input: { conversationId: string; callerDomain?: CallerAccessDomain }): { workbench: TWorkbench };
  executeConciergeCommand?(commandText: string, channel?: ConciergeChannelKind): Promise<CommandExecutionOutcome>;
  bindSelfRepo?(opts?: { repoRoot?: string; targetAppBundlePath?: string }, callerDomain?: CallerAccessDomain): { ok: true; binding: RepoBindingRecord; workbench: TWorkbench };
  upsertRepoBinding?(input: UpsertRepoBindingInput, callerDomain?: CallerAccessDomain): { ok: true; binding: RepoBindingRecord; workbench: TWorkbench };
  startVibeTask?(input: { text: string; bindingQuery?: string; channel?: VibeIngressChannel; filePaths?: string[]; callerDomain?: CallerAccessDomain }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord; workbench: TWorkbench }>;
  decideVibeTask?(input: { pipelineId?: string; rawReplyText?: string; action?: "approve" | "revise" | "cancel" | "verify_now" | "relaunch_now"; feedback?: string; callerDomain?: CallerAccessDomain }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord; workbench: TWorkbench }>;
  searchAuthorizedFiles?(input: { query?: string; projectQuery?: string; conversationId?: string; callerDomain?: CallerAccessDomain; limit?: number }): AuthorizedFileMatch[];
  readAuthorizedFile?(input: { filePath?: string; fileQuery?: string; projectQuery?: string; conversationId?: string; offsetChars?: number; maxChars?: number; callerDomain?: CallerAccessDomain }): ReadAuthorizedFileResult;
}

const stripQuotes = (s: string): string => s.trim().replace(/^[「『"“'【\[]+|[」』"”'】\]]+$/g, "").trim();
const shortProjectName = (key: string): string => key.replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");
const privacyLabel = (tier: 0 | 1 | 2): string => (tier === 0 ? "私密（仅本机）" : tier === 1 ? "脱敏摘要" : "深度协同");
const dirLabel = (dir: CommitmentItem["direction"]): string => (dir === "i_owe" ? "待我办" : dir === "waiting_for" ? "等对方" : "快到期");

function parseOrdinalIndex(text: string): number | undefined {
  const m = text.match(/第?\s*([1-9])\s*[个条项位]/);
  if (m?.[1]) return Number(m[1]) - 1;
  if (/第一个|头一个/.test(text)) return 0;
  if (/第二个/.test(text)) return 1;
  if (/第三个/.test(text)) return 2;
  return undefined;
}

function hanBigrams(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.match(/[a-z0-9_-]{2,}/g) ?? []) tokens.add(w);
  const han = Array.from(lower).filter((c) => /\p{Script=Han}/u.test(c));
  for (let i = 0; i + 1 < han.length; i++) tokens.add(han[i]! + han[i + 1]!);
  return tokens;
}

function matchBestItem<T>(items: readonly T[], text: string, getLabel: (item: T) => string): T | undefined {
  const ord = parseOrdinalIndex(text);
  if (ord !== undefined && items[ord]) return items[ord];
  const lower = text.toLowerCase();
  const direct = items.find((it) => {
    const lbl = getLabel(it).toLowerCase();
    return lbl && (lower.includes(lbl) || lbl.includes(lower));
  });
  if (direct) return direct;
  const qTokens = hanBigrams(text);
  let best: T | undefined;
  let bestScore = 0;
  for (const it of items) {
    const tTokens = hanBigrams(getLabel(it));
    let score = 0;
    for (const tok of qTokens) if (tTokens.has(tok)) score += 1;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore > 0 ? best : undefined;
}
function cleanRecallLine(line: string): string {
  return line
    .replace(/^\[档案\]\s*/, "• 档案：")
    .replace(/^\[人脉\]\s*/, "• 联系人：")
    .replace(/^\[事项:i_owe\/[^\]]+\]\s*/, "• 待我办：")
    .replace(/^\[事项:waiting_for\/[^\]]+\]\s*/, "• 等对方：")
    .replace(/^\[事项:expiring\/[^\]]+\]\s*/, "• 快到期：")
    .replace(/^\[目标:[^\]]+\]\s*/, "• 重点目标：")
    .replace(/^\[规则:[^\]]+\]\s*/, "• 原则红线：")
    .replace(/^\[图谱:[^\]]+\]\s*/, "• 记忆脉络：")
    .replace(/\s*@\s+/, " → 位置：");
}

function formatNaturalDropzone(outcome: DropzoneOutcome): string {
  switch (outcome.intent) {
    case "capture":
      return `好的，${outcome.receiptLine.replace(/\([^)]+\)/g, "").trim()}`;
    case "recall": {
      const lines = outcome.answer.split("\n").map(cleanRecallLine);
      return lines.length > 1 ? `帮你翻到了这些相关记录：\n${lines.join("\n")}` : lines[0]!;
    }
    case "advise": {
      const warnings = outcome.guardrailWarnings.map((w) =>
        w
          .replace(/^\[证伪墓碑预警\]\s*/, "⚠️ 历史教训红线：")
          .replace(/^\[硬红线拦截\]\s*/, "⛔ 红线提示：")
          .replace(/^\[人脉禁忌提醒:([^\]]+)\]\s*/, "⚠️ $1 沟通忌讳："),
      );
      return [...warnings, outcome.tradeOffBrief].filter(Boolean).join("\n\n");
    }
    case "delegate": {
      if (outcome.mode === "automated_trigger") {
        return `已经安排「${outcome.trigger.threadKey}」接入自动化跟进，有进展会及时告诉你。`;
      }
      const b = outcome.bundle;
      const parts = [
        `这件事没法完全跳过人工（${b.missingAutomationReason}），不过我已经先把前 80% 准备妥当了：`,
        `办理步骤：\n${b.checklist.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
        b.localMaterials.length
          ? `本地能用上的材料已经翻出来：\n${b.localMaterials.map((m) => `• ${m.label}（${m.localPath}）`).join("\n")}`
          : "本地暂时没翻到现成证件材料，如果手头有扫描件直接丢进来我帮你归档。",
        b.readyToCopyDrafts[0]
          ? `可直接复制的话术：\n> ${b.readyToCopyDrafts[0].text}`
          : "",
        `我也顺手帮你记进了待办（${b.followupCommitment.summary}），办妥了跟我说一声我就帮你销掉。`,
      ].filter(Boolean);
      return parts.join("\n\n");
    }
    case "clarify": {
      const prep = outcome.nonBlockingPrepSteps.length
        ? `我已经先把不依赖拍板的事准备妥当：\n${outcome.nonBlockingPrepSteps.map((s) => `• ${s}`).join("\n")}\n\n`
        : "";
      return `${prep}${outcome.question}\n${outcome.options.join("\n")}`;
    }
  }
}

export class StewardConversationEngine<TWorkbench extends StewardWorkbenchLike = StewardWorkbenchLike> {
  private pendingGoalProposal?: { title: string; northStarCriterion: string; partition: ContextPartition };
  private pendingConciergeConfirm?: { cardId: string; channel: ConciergeChannelKind; peerDisplayName: string; body: string; confirmHash: string };

  constructor(private readonly host: StewardConversationHostPort<TWorkbench>) {}

  private observeOwnerTrust(): void {
    const ownerRel = this.host.getWorkbench("owner_private").ledger.relationships.find((r) => r.subjectType === "owner_trust");
    if (ownerRel) this.host.mutateTrust({ id: ownerRel.id, action: "observe" });
  }

  private async handlePending(text: string, domain: CallerAccessDomain): Promise<StewardConversationResult<TWorkbench> | null> {
    if (this.pendingConciergeConfirm) {
      const pending = this.pendingConciergeConfirm;
      if (/^(?:确认|确认发送|确定|发吧|好的?|可以|发送)$/i.test(text) && this.host.executeConciergeCommand) {
        const res = await this.host.executeConciergeCommand(`/confirm ${pending.cardId} ${pending.confirmHash}`, pending.channel);
        this.pendingConciergeConfirm = undefined;
        if (res.status === "cooling_off_scheduled") {
          this.observeOwnerTrust();
          return {
            ok: true,
            intent: "pending_concierge_confirm",
            reply: `好，已安排发给「${pending.peerDisplayName}」（留了几十秒缓冲窗，如果临时改主意直接跟我说“撤回”就行）。`,
            workbench: this.host.getWorkbench(domain),
          };
        }
        return {
          ok: true,
          intent: "pending_concierge_confirm",
          reply: `没有发出去：${res.reason ?? "这条回复未通过发前安全校验"}。`,
          workbench: this.host.getWorkbench(domain),
        };
      }
      if (/^(?:取消|算了|先算了|不发了|先别发|放弃)$/i.test(text)) {
        this.pendingConciergeConfirm = undefined;
        return { ok: true, intent: "pending_concierge_confirm", reply: `好的，已经取消发给「${pending.peerDisplayName}」。`, workbench: this.host.getWorkbench(domain) };
      }
      this.pendingConciergeConfirm = undefined;
    }
    return this.handlePendingGoal(text, domain);
  }
  private handlePendingGoal(text: string, domain: CallerAccessDomain): StewardConversationResult<TWorkbench> | null {
    if (!this.pendingGoalProposal) return null;
    const pending = this.pendingGoalProposal;
    if (/^(?:取消|算了|先算了|先不加了|不用了|保持不变)$/i.test(text)) {
      this.pendingGoalProposal = undefined;
      return { ok: true, intent: "pending_goal_replace", reply: "好，那先保持现有的 3 个重点目标不变。", workbench: this.host.getWorkbench(domain) };
    }
    const active = this.host.getWorkbench("owner_private").ledger.goals.filter((g) => g.status === "active");
    const ord = parseOrdinalIndex(text);
    const target = (ord !== undefined ? active[ord] : undefined) ?? (/替换|顶掉|换掉/.test(text) ? matchBestItem(active, text, (g) => g.title) : active.find((g) => text.includes(g.title)));
    if (!target) {
      this.pendingGoalProposal = undefined;
      return null;
    }
    const res = this.host.mutateGoal({ action: "upsert", ...pending, supersedeGoalId: target.id, callerDomain: domain });
    this.pendingGoalProposal = undefined;
    const reply = res.ok
      ? `没问题，已把「${target.title}」归档收起，新的重点目标「${pending.title}」正式接棒。`
      : `替换目标时遇到点状况：${res.message ?? "请稍后再试"}`;
    return { ok: true, intent: "pending_goal_replace", reply, workbench: res.workbench };
  }

  private async handleConcierge(text: string, wb: TWorkbench, domain: CallerAccessDomain): Promise<StewardConversationResult<TWorkbench> | null> {
    const cg = wb.concierge;
    if (!cg) return null;
    if (/(?:撤回|别发了|拦下来?|取消发送)/.test(text) && text.length <= 24) {
      const pending = cg.pendingDispatches[0];
      if (!pending || !this.host.executeConciergeCommand) {
        return { ok: true, intent: "concierge_undo", reply: "目前没有正准备发出的消息在缓冲期里。", workbench: wb };
      }
      await this.host.executeConciergeCommand(`/undo ${pending.dispatchId}`, pending.channel);
      return { ok: true, intent: "concierge_undo", reply: `已经及时拦下发给「${pending.peerDisplayName}」的那条消息，对方不会看到任何痕迹。`, workbench: this.host.getWorkbench(domain) };
    }
    if (/(有人找我|谁找我|看看消息|待回消息|外部来信|有新消息|还有谁问)/.test(text)) {
      if (cg.cards.length === 0 && cg.pendingDispatches.length === 0) {
        return { ok: true, intent: "concierge_query", reply: "目前没有需要你处理的外部来信。", workbench: wb };
      }
      const lines = cg.cards.map((c, i) => `${i + 1}. ${c.peerDisplayName}（${c.channel === "feishu" ? "飞书" : "微信"}）：${c.summary.replace(/^客户来信要点：/, "")}\n   • 稳健拟稿：${c.draftA.body}\n   • 积极拟稿：${c.draftB.body}`);
      const dispatches = cg.pendingDispatches.map((d) => `• 正在缓冲待发：发往「${d.peerDisplayName}」（还剩 ${Math.ceil(d.remainingMs / 1000)} 秒，说“撤回”随时拦下）`);
      return {
        ok: true,
        intent: "concierge_query",
        reply: ["目前这几位找你：", ...lines, ...dispatches, "可以直接跟我说“按稳健版回某总”，或者直接告诉我你想回复的话。"].filter(Boolean).join("\n"),
        workbench: wb,
      };
    }
    if (/(怎么回|如何回复|合适吗|怎么谈)/.test(text)) return null;
    const presetOpt = /(稳健版|第一个方案|草稿\s*A)/i.test(text) ? "A" : /(积极版|第二个方案|草稿\s*B)/i.test(text) ? "B" : null;
    if (presetOpt && this.host.executeConciergeCommand && cg.cards.length > 0) {
      const card = matchBestItem(cg.cards, text, (c) => c.peerDisplayName) ?? (cg.cards.length === 1 ? cg.cards[0] : undefined);
      if (card) {
        const draft = presetOpt === "A" ? card.draftA : card.draftB;
        const res = await this.host.executeConciergeCommand(`/send ${presetOpt} ${card.cardId} ${draft.confirmHash}`, card.channel);
        if (res.status === "cooling_off_scheduled") {
          this.observeOwnerTrust();
          return {
            ok: true,
            intent: "concierge_reply",
            reply: `已按${presetOpt === "A" ? "稳健" : "积极"}版安排回给「${card.peerDisplayName}」：\n> ${draft.body}\n\n留了 ${Math.round(cg.coolingWindowMs / 1000)} 秒缓冲，如果反悔了直接说“撤回”就行。`,
            workbench: this.host.getWorkbench(domain),
          };
        }
        return { ok: true, intent: "concierge_reply", reply: `暂未发出：${res.reason ?? "这条触及了群聊/白名单安全边界，你可以在右侧看板查看详情。"}`, workbench: this.host.getWorkbench(domain) };
      }
    }
    const customMatch = text.match(/^(?:给|替我给|帮我给|请给|回复?|告诉)\s*([\p{Script=Han}A-Za-z0-9_]{1,12})[：:,，]\s*(.+)$/u);
    if (customMatch && this.host.executeConciergeCommand && cg.cards.length > 0) {
      const card = cg.cards.find((c) => c.peerDisplayName.includes(customMatch[1]!) || customMatch[1]!.includes(c.peerDisplayName)) ?? matchBestItem(cg.cards, customMatch[1]!, (c) => c.peerDisplayName);
      if (card) {
        const customBody = customMatch[2]!.trim();
        const res = await this.host.executeConciergeCommand(`/edit ${card.cardId} ${customBody}`, card.channel);
        if (res.status === "pending_double_confirm" && res.requiredConfirmHash) {
          this.pendingConciergeConfirm = { cardId: card.cardId, channel: card.channel, peerDisplayName: card.peerDisplayName, body: customBody, confirmHash: res.requiredConfirmHash };
          return {
            ok: true,
            intent: "concierge_reply",
            reply: `这句话里带了具体金额或正式承诺（「${customBody}」），发给「${card.peerDisplayName}」之前跟你最后确认一下：确定要发吗？回“确认发送”我就安排发出，回“算了”就取消。`,
            workbench: this.host.getWorkbench(domain),
          };
        }
        if (res.status === "cooling_off_scheduled") {
          this.observeOwnerTrust();
          return { ok: true, intent: "concierge_reply", reply: `好，已安排发给「${card.peerDisplayName}」：${customBody}\n（${Math.round(cg.coolingWindowMs / 1000)} 秒内随时说“撤回”都能拦下）`, workbench: this.host.getWorkbench(domain) };
        }
        return { ok: true, intent: "concierge_reply", reply: `没有发出去：${res.reason ?? "触及外发保护红线"}。`, workbench: this.host.getWorkbench(domain) };
      }
    }
    return null;
  }
  private handleCadenceAndGoals(text: string, wb: TWorkbench, domain: CallerAccessDomain): StewardConversationResult<TWorkbench> | null {
    if (/(?:开启|打开|进入|启用).{0,6}免打扰|^(?:今晚别吵|先别打扰|别提醒我|关闭通知)/.test(text)) {
      const next = this.host.setQuietHours(true, domain);
      return { ok: true, intent: "quiet_hours", reply: "好的，已开启免打扰。常规提醒我会先攒进明早简报；除非遇到代码分支冲突这类紧急状况，否则绝不打扰你。", workbench: next.workbench };
    }
    if (/(?:关闭|取消|退出|解除).{0,6}免打扰|恢复(?:正常)?提醒/.test(text)) {
      const next = this.host.setQuietHours(false, domain);
      return { ok: true, intent: "quiet_hours", reply: "好的，已恢复正常伴行提醒，每天我也会严控最多只主动敲你 2 次。", workbench: next.workbench };
    }
    if (/(今天有什么提醒|有什么要紧|要紧提醒|看看早报|早间简报|汇报一下风险|有啥风险|快到期|逾期)/.test(text)) {
      const scan = this.host.scanCadence({ quietHoursActive: false, calibrationDue: true, callerDomain: domain });
      const items = [...scan.emitNow];
      const seenIds = new Set(items.map((c) => c.candidateId));
      for (const q of scan.workbench.cadence.state.morningDigestQueue) {
        if (!seenIds.has(q.candidateId)) { seenIds.add(q.candidateId); items.push(q); }
      }
      if (items.length === 0) return { ok: true, intent: "briefing", reply: "目前没有要紧或逾期的事项，一切都稳步推进中。", workbench: scan.workbench };
      const urgent = items.filter((c) => c.urgency === "urgent");
      const routine = items.filter((c) => c.urgency !== "urgent");
      const lines: string[] = [];
      if (urgent.length) lines.push(`⚠️ 需要优先留意的：\n${urgent.map((c) => `• ${c.title}：${c.threeLineBody[0] ?? ""}`).join("\n")}`);
      if (routine.length) lines.push(`📌 日常跟进备忘：\n${routine.slice(0, 4).map((c) => `• ${c.title}：${c.threeLineBody[0] ?? ""}`).join("\n")}`);
      return { ok: true, intent: "briefing", reply: lines.join("\n\n"), workbench: scan.workbench };
    }
    const activeGoals = wb.ledger.goals.filter((g) => g.status === "active");
    if (/(我的目标|重点目标|北极星|哪几个目标|看看目标|目标列表)/.test(text) && !/(列为|设为|新增|加上?|替换)/.test(text)) {
      if (!activeGoals.length) return { ok: true, intent: "goals_query", reply: "目前还没有设定重点目标，你可以随时跟我说“把某件事列为重点目标”。", workbench: wb };
      const lines = activeGoals.map((g, i) => `${i + 1}. ${g.title}（检验标准：${g.northStarCriterion}）`);
      return { ok: true, intent: "goals_query", reply: `目前你手头集中盯着这 ${activeGoals.length} 个重点目标：\n${lines.join("\n")}`, workbench: wb };
    }
    const goalDoneMatch = text.match(/把[「『"“]?(.+?)[」』"”]?(?:这个)?目标(?:标为|改为|设为)?(已完成|完成|暂停)/);
    if (goalDoneMatch) {
      const target = matchBestItem(activeGoals, goalDoneMatch[1]!, (g) => g.title);
      if (target) {
        const nextStatus = goalDoneMatch[2] === "暂停" ? "paused" : "achieved";
        const res = this.host.mutateGoal({ action: "status", id: target.id, status: nextStatus, callerDomain: domain });
        return { ok: true, intent: "goal_status", reply: `好的，已把「${target.title}」标为${nextStatus === "paused" ? "暂停" : "已达成"}。`, workbench: res.workbench };
      }
    }
    const swapMatch = text.match(/^用[「『"“]?(.+?)[」』"”]?(?:替换|顶掉|换掉)[「『"“]?(.+?)[」』"”]?$/);
    const addMatch = text.match(/把[「『"“]?(.+?)[」』"”]?(?:列为|设为|加为|作为)(?:重点|主)?目标/) ?? text.match(/^(?:新增|加上?|设定|定一个)(?:重点|主)?目标[：:\s]*[「『"“]?(.+?)[」』"”]?$/);
    if (swapMatch || addMatch) {
      const title = stripQuotes(swapMatch ? swapMatch[1]! : addMatch![1]!);
      const replaceTarget = swapMatch ? matchBestItem(activeGoals, stripQuotes(swapMatch[2]!), (g) => g.title) : undefined;
      const partition: ContextPartition = /(健康|父母|家庭|生活|体检|房子)/.test(title) ? "personal_life" : "work_project";
      const criterion = "按里程碑落地并验收";
      const res = this.host.mutateGoal({ action: "upsert", partition, title, northStarCriterion: criterion, ...(replaceTarget ? { supersedeGoalId: replaceTarget.id } : {}), callerDomain: domain });
      if (res.ok) return { ok: true, intent: "goal_add", reply: replaceTarget ? `已用「${title}」接替「${replaceTarget.title}」。` : `好，已把「${title}」列为当前重点目标。`, workbench: res.workbench };
      if (res.errorCode === "GOAL_CAP_EXCEEDED") {
        this.pendingGoalProposal = { title, northStarCriterion: criterion, partition };
        const list = (res.activeGoals ?? activeGoals).map((g, i) => `${i + 1}. ${g.title}`).join("\n");
        return {
          ok: true,
          intent: "goal_add",
          reply: `为了避免贪多分散精力，我们最多同时聚焦 3 个重点目标。你目前已经排满了：\n${list}\n\n想把「${title}」加进去的话，准备替掉上面哪一个？直接回“替换第 2 个”或者“先算了”就行。`,
          workbench: res.workbench,
        };
      }
    }
    return null;
  }
  private handleCommitmentsAndAgy(text: string, wb: TWorkbench, domain: CallerAccessDomain): StewardConversationResult<TWorkbench> | null {
    const openCommits = wb.ledger.commitments.filter((c) => c.status === "open" || c.status === "waiting_review");
    if (/(有哪些待办|待办事项|还有什么事没办|我欠谁|谁欠我|看看待办|什么事要办)/.test(text)) {
      if (!openCommits.length) return { ok: true, intent: "commitments_query", reply: "眼下没有挂账的待办承诺。", workbench: wb };
      const lines = openCommits.map((c, i) => `${i + 1}. 【${dirLabel(c.direction)}】${c.summary}${c.dueAt ? `（截止 ${c.dueAt.slice(0, 10)}）` : ""}`);
      return { ok: true, intent: "commitments_query", reply: `手头还有这 ${openCommits.length} 件待跟进事项：\n${lines.join("\n")}\n\n哪件办妥了跟我说一声，我就帮你销掉。`, workbench: wb };
    }
    if (/(办妥了|搞定了|办完了|销掉了?|消掉了?|已回传|回传了|确认好了|待办标为完成)/.test(text) && !/[？?]|吗\s*$/.test(text) && openCommits.length) {
      const target = matchBestItem(openCommits, text, (c) => `${c.summary} ${c.counterpartyOrRef}`);
      if (target) {
        const res = this.host.mutateCommitment({ action: "status", id: target.id, status: "closed", callerDomain: domain });
        return { ok: true, intent: "commitment_close", reply: `好的，已经把「${target.summary}」销账了，后续早报不会再重复提醒你。`, workbench: res.workbench };
      }
    }
    const projects = wb.antigravity.projects;
    const projName = (p: (typeof projects)[number]) => p.displayName || shortProjectName(p.projectKey);
    const projTerms = (p: (typeof projects)[number]) => [projName(p), ...(p.aliases ?? []), shortProjectName(p.projectKey), p.title].filter(Boolean);
    const privMatch = text.match(/(私密|静默|仅本机|不外传|别外传|不要往外发|别往外发)/) ? 0
      : text.match(/(脱敏摘要|设为摘要|设成摘要|改为摘要|摘要模式)/) ? 1
      : text.match(/(深度协同|设为协同|设成协同|治理模式|设为治理|设成治理)/) ? 2 : null;
    if (privMatch !== null && projects.length) {
      const proj = matchBestItem(projects, text, (p) => projTerms(p).join(" "));
      if (proj) {
        const res = this.host.setProjectTier({ projectKey: proj.projectKey, tier: privMatch as 0 | 1 | 2, callerDomain: domain });
        const desc = privMatch === 0 ? "所有标题与摘要仅留在你这台电脑上，绝不外传" : privMatch === 1 ? "只同步脱敏后的进度轮廓，具体细节留在本机" : "允许结合完整上下文参与深度研发治理";
        return { ok: true, intent: "agy_privacy", reply: `已把项目「${projName(proj)}」切换为「${privacyLabel(privMatch as 0 | 1 | 2)}」（${desc}）。`, workbench: res.workbench };
      }
    }
    if (/(?:已在|在)\s*IDE\s*(?:处理|看完|看过)|这个会话.*看过了/.test(text) && wb.antigravity.sessions.length) {
      const sess = matchBestItem(wb.antigravity.sessions, text, (s) => `${s.title} ${s.projectDisplayName ?? shortProjectName(s.projectKey)}`) ?? wb.antigravity.sessions[0]!;
      const res = this.host.markSessionViewed({ conversationId: sess.conversationId, callerDomain: domain });
      return { ok: true, intent: "agy_viewed", reply: `记下了，会话「${sess.title || sess.conversationId.slice(0, 8)}」已标为已在 IDE 处理，不会再发重复提醒。`, workbench: res.workbench };
    }
    const matchedProj = projects.find((p) => projTerms(p).some((t) => text.toLowerCase().includes(t.toLowerCase())));
    if (/(代码项目|项目进度|项目进展|开发进展|开发进度|antigravity|最近在写什么|运行中|正在跑)/i.test(text) || (matchedProj && /(进展|进度|状态|情况)/.test(text))) {
      if (matchedProj) {
        const recent = wb.antigravity.sessions.filter((s) => s.projectKey === matchedProj.projectKey).slice(0, 3);
        const recentList = recent.map((s) => `• ${s.title || s.conversationId.slice(0, 8)}${s.isRunning ? "（运行中）" : ""}`).join("\n");
        return {
          ok: true,
          intent: "agy_query",
          reply: `项目「${projName(matchedProj)}」当前隐私档为「${privacyLabel(matchedProj.policy.tier)}」，累计 ${matchedProj.sessionCount} 个主会话（${matchedProj.runningSessionCount ? `其中 ${matchedProj.runningSessionCount} 个正在运行，` : ""}已自动折叠 ${matchedProj.subagentCount} 个子代理杂音）。${recentList ? `\n\n最近对话脉络：\n${recentList}` : ""}`,
          workbench: wb,
        };
      }
      const top = projects.slice(0, 5).map((p, i) => `${i + 1}. ${projName(p)}（${p.runningSessionCount ? `运行中 · ` : ""}${p.sessionCount} 个主会话 · ${privacyLabel(p.policy.tier)}）`);
      return {
        ok: true,
        intent: "agy_query",
        reply: `本机已只读梳理出 ${wb.antigravity.totalSessions} 个开发主会话（帮你折叠掉 ${wb.antigravity.totalSubagentsFolded} 个子代理杂音）。最活跃的项目有：\n${top.join("\n")}\n\n哪一个不想往外同步，直接说“把某某设成私密”就行。`,
        workbench: wb,
      };
    }
    return null;
  }
  private handleTrustAndOverview(text: string, wb: TWorkbench, domain: CallerAccessDomain): StewardConversationResult<TWorkbench> | null {
    const ownerRel = wb.ledger.relationships.find((r) => r.subjectType === "owner_trust") ?? wb.ledger.relationships[0];
    if (ownerRel && /(只记不评|别给建议|别乱插嘴|切回耳麦提词|发之前先问我|常规事你自己看着办|放权给你|以后自动处理|升到自治)/.test(text)) {
      if (/(只记不评|别给建议|别乱插嘴)/.test(text)) {
        const res = this.host.mutateTrust({ id: ownerRel.id, action: "downgrade", targetTier: "L0_record_only", callerDomain: domain });
        return { ok: true, intent: "trust_adjust", reply: "明白，我切回“只记不评”模式——只帮你静静收好信息，不再主动给建议。", workbench: res.workbench };
      }
      if (/(切回耳麦提词|发之前先问我)/.test(text)) {
        const res = this.host.mutateTrust({ id: ownerRel.id, action: "downgrade", targetTier: "L1_whisper_prompt", callerDomain: domain });
        return { ok: true, intent: "trust_adjust", reply: "收到，已经退回耳麦提词模式——所有动作先递到你眼前，等你点头再办。", workbench: res.workbench };
      }
      const res = this.host.mutateTrust({ id: ownerRel.id, action: "promote_l3", ownerConfirmed: true, callerDomain: domain });
      if (res.ok) return { ok: true, intent: "trust_adjust", reply: "好，日常常规事务我会直接顺手替你办妥，办完给你留一份轻简回执。", workbench: res.workbench };
      return {
        ok: true,
        intent: "trust_adjust",
        reply: `目前我们刚攒下 ${ownerRel.verifiedObservations} 次核对无误的配合记录，满 3 次后我再接手自动处理会更稳妥。现在你可以先在对话里放心让我搭把手，次数一到我再提醒你升级。`,
        workbench: res.workbench,
      };
    }
    if (/(全局盘点|汇报一下现状|今天整体有什么事|整体情况|帮我盘一盘|总览一下)/.test(text)) {
      const gCount = wb.ledger.goals.filter((g) => g.status === "active").length;
      const cCount = wb.ledger.commitments.filter((c) => c.status === "open" || c.status === "waiting_review").length;
      const msgCount = wb.concierge?.cards.length ?? 0;
      const agyCount = wb.antigravity.projects.length;
      return {
        ok: true,
        intent: "overview",
        reply: [
          "为你快速盘点一下当前全局：",
          `• 重点目标：${gCount}/3 项推进中`,
          `• 待办承诺：${cCount} 项挂账跟进`,
          `• 外部来信：${msgCount ? `${msgCount} 条等你拿主意` : "暂无待处理来信"}`,
          `• 开发脉络：已同步 ${agyCount} 个项目（${wb.antigravity.totalSessions} 个主会话）`,
          "",
          "想看明细或挨个处理，直接问我或点右上角【看板】就行。",
        ].join("\n"),
        workbench: wb,
      };
    }
    return null;
  }

  private toVibeChannel(ch?: DropzoneChannel): VibeIngressChannel {
    return ch === "weixin" || ch === "feishu" ? ch : "sugent_app";
  }

  private async handleVibeCoding(
    input: StewardConversationTurnInput,
    text: string,
    wb: TWorkbench,
    domain: CallerAccessDomain,
  ): Promise<StewardConversationResult<TWorkbench> | null> {
    const pendingVibe = wb.vibeCoding?.pipelines.find(
      (p) => p.stage === "awaiting_plan_approval" || p.stage === "awaiting_restart_approval",
    );
    if (pendingVibe && this.host.decideVibeTask) {
      const parsed = SocialImVibeAdapter.parseOwnerReply(text);
      if (parsed.action) {
        const res = await this.host.decideVibeTask({ pipelineId: pendingVibe.pipelineId, rawReplyText: text, callerDomain: domain });
        return { ok: true, intent: "vibe_decide", reply: res.message, workbench: res.workbench };
      }
    }
    if (/(?:绑定.*(?:sugent|自己|自身).*仓库|绑定自身源码)/i.test(text) && this.host.bindSelfRepo) {
      try {
        const res = this.host.bindSelfRepo({}, domain);
        return { ok: true, intent: "vibe_bind", reply: `已将本机源码仓「${res.binding.alias}」绑定到路径 ${res.binding.repoRoot}。`, workbench: res.workbench };
      } catch (err) {
        return { ok: true, intent: "vibe_bind", reply: err instanceof Error ? err.message : String(err), workbench: wb };
      }
    }
    const bindMatch = text.match(/绑定(?:代码)?(?:仓库|项目)\s*[「『"“]?([^\s「『"”」』]+)[」』"”]?(?:\s*(?:叫|别名|命名为)\s*[「『"“]?([^」』"”]+)[」』"”]?)?/);
    if (bindMatch?.[1] && this.host.upsertRepoBinding) {
      try {
        const repoRoot = bindMatch[1].trim();
        const alias = stripQuotes(bindMatch[2] ?? "") || repoRoot.split(/[/\\]/).filter(Boolean).pop() || "本地仓库";
        const res = this.host.upsertRepoBinding({ alias, repoRoot }, domain);
        return { ok: true, intent: "vibe_bind", reply: `已绑定本地代码仓「${res.binding.alias}」（${res.binding.repoRoot}）。`, workbench: res.workbench };
      } catch (err) {
        return { ok: true, intent: "vibe_bind", reply: err instanceof Error ? err.message : String(err), workbench: wb };
      }
    }
    if (/(?:定制开发|帮我开发|改代码|加功能|修\s*bug|派发开发|让\s*antigravity\s*(?:开发|改|写|修))/i.test(text) && this.host.startVibeTask) {
      const res = await this.host.startVibeTask({
        text,
        channel: this.toVibeChannel(input.channel),
        ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        callerDomain: domain,
      });
      return { ok: true, intent: "vibe_start", reply: res.message, workbench: res.workbench };
    }
    const fileMatch = text.match(/([A-Za-z0-9_.-]+\.(?:md|txt|json|log))/i);
    if (fileMatch?.[1] && /(?:读|看|查|拿|打开|全文|内容)/.test(text) && this.host.readAuthorizedFile) {
      const res = this.host.readAuthorizedFile({ fileQuery: fileMatch[1], callerDomain: domain });
      const reply = res.ok
        ? `已读到「${res.projectName}」下的 ${res.fileName}（共 ${res.totalChars} 字，当前展示 ${res.returnedChars} 字）：\n\n${res.content.slice(0, 1800)}${res.totalChars > 1800 ? "\n...(已节选前 1800 字)" : ""}`
        : res.message;
      return { ok: true, intent: "file_read", reply, workbench: wb };
    }
    if (/(?:你有什么新能力|多了什么能力|能力更新|检查一下.*(?:能力|拿到文件)|版本漂移)/.test(text) && wb.capabilities) {
      const c = wb.capabilities;
      const lines = [
        c.drift.drifted ? `⚠️ ${c.drift.summary}` : `当前运行构建：${c.bootBuild?.buildId ?? "源码实时态"}`,
        `已装载工具 ${c.tools.length} 项：${c.tools.map((t) => t.title).join("、")}`,
        `可受控查阅本地项目/目录 ${c.readableProjectCount} 个。`,
      ];
      return { ok: true, intent: "capability_status", reply: lines.join("\n"), workbench: wb };
    }
    return null;
  }

  async converse(input: StewardConversationTurnInput): Promise<StewardConversationResult<TWorkbench>> {
    const text = String(input.text ?? "").trim();
    const domain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    if (!text && !(input.filePaths?.length)) {
      return { ok: true, intent: "dropzone", reply: "直接告诉我你想记的事、要查的东西或要处理的消息就行。", workbench: this.host.getWorkbench(domain) };
    }
    const pendingRes = await this.handlePending(text, domain);
    if (pendingRes) return pendingRes;

    const wb = this.host.getWorkbench(domain);
    const cgRes = await this.handleConcierge(text, wb, domain);
    if (cgRes) return cgRes;

    const cadenceGoalRes = this.handleCadenceAndGoals(text, wb, domain);
    if (cadenceGoalRes) return cadenceGoalRes;

    const commitAgyRes = this.handleCommitmentsAndAgy(text, wb, domain);
    if (commitAgyRes) return commitAgyRes;

    const trustOverviewRes = this.handleTrustAndOverview(text, wb, domain);
    if (trustOverviewRes) return trustOverviewRes;

    const vibeRes = await this.handleVibeCoding(input, text, wb, domain);
    if (vibeRes) return vibeRes;

    const dropRes = await this.host.submitDropzone({
      text,
      channel: input.channel ?? "web_ui",
      callerDomain: domain,
      ...(input.partition ? { partition: input.partition } : {}),
      ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
    });
    return {
      ok: true,
      intent: "dropzone",
      reply: formatNaturalDropzone(dropRes.outcome),
      outcome: dropRes.outcome,
      workbench: dropRes.workbench,
    };
  }
}
