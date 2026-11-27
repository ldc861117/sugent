import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StewardshipLedger, TrustTier } from "./stewardship-ledger.js";

export const DEFAULT_MAX_MESSAGES_PER_GROUP = 200;
export const GROUP_SCRIBE_STATE_SUBDIR = "sugent-stewardship";
export const GROUP_SCRIBE_STATE_FILENAME = "group-scribe-state.json";

const MAX_RECENT_SEEN_IDS_PER_GROUP = 1_000;

export type DigestCardStatus = "pending_approval" | "approved" | "dismissed";

export interface RecordedGroupMessage {
  messageId: string;
  groupId: string;
  groupName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestampIso: string;
  archivedAtIso?: string;
  archivedDigestId?: string;
}

export interface RecordGroupMessageInput {
  groupId: string;
  groupName?: string;
  messageId: string;
  senderId?: string;
  senderName?: string;
  sender?: string;
  content: string;
  timestampIso?: string;
  createdAtMs?: number;
}

export type RecordGroupMessageResult =
  | {
      recorded: false;
      reason: "group_not_whitelisted" | "duplicate_message_id";
      deduplicated?: boolean;
    }
  | {
      recorded: true;
      deduplicated: false;
      groupId: string;
      messageId: string;
      bufferedCount: number;
      sanitizedContent: string;
      message: RecordedGroupMessage;
    };

export interface WaitingForCommitmentCandidate {
  summary: string;
  speakerName: string;
  speakerId: string;
  dueHint?: string;
}

export interface IOweCommitmentCandidate {
  summary: string;
  counterpartyName: string;
  dueHint?: string;
}

export interface ContactInsightCandidate {
  speakerName: string;
  speakerId: string;
  insight: string;
  isTaboo: boolean;
}

export interface GroupDigestExtractionResult {
  waitingForCommitments: WaitingForCommitmentCandidate[];
  iOweCommitments: IOweCommitmentCandidate[];
  contactInsights: ContactInsightCandidate[];
  threeLineSummary?: [string, string, string];
}

export type GroupDigestCustomExtractor = (context: {
  groupId: string;
  groupName: string;
  projectKey?: string;
  ownerAliases: readonly string[];
  messages: readonly RecordedGroupMessage[];
}) => Promise<GroupDigestExtractionResult> | GroupDigestExtractionResult;

export interface GroupScribeDigestCard {
  digestId: string;
  groupId: string;
  groupName: string;
  projectKey?: string;
  messageCount: number;
  sourceMessageIds: string[];
  waitingForCommitments: WaitingForCommitmentCandidate[];
  iOweCommitments: IOweCommitmentCandidate[];
  contactInsights: ContactInsightCandidate[];
  threeLineSummary: [string, string, string];
  status: DigestCardStatus;
  createdAtIso: string;
  approvedAtIso?: string;
  dismissedAtIso?: string;
}

export interface DistillGroupDigestInput {
  groupId: string;
  groupName?: string;
  projectKey?: string;
  ownerAliases?: readonly string[];
}

export interface ListDigestsOptions {
  status?: DigestCardStatus;
  groupId?: string;
}

export interface ApproveDigestResult {
  ok: true;
  idempotent: boolean;
  digest: GroupScribeDigestCard;
  writtenCommitments: number;
  writtenRelationships: number;
  writtenResources: number;
}

export interface DismissDigestResult {
  ok: true;
  idempotent: boolean;
  digest: GroupScribeDigestCard;
}

export interface GroupChatScribeOptions {
  dataDir: string;
  whitelistedGroupIds?: Iterable<string>;
  maxMessagesPerGroup?: number;
  ownerAliases?: readonly string[];
  customExtractor?: GroupDigestCustomExtractor;
  nowIso?: () => string;
}

interface PersistedGroupState {
  groupId: string;
  groupName: string;
  messages: RecordedGroupMessage[];
  seenMessageIds: string[];
}

interface PersistedScribeState {
  version: 1;
  updatedAtIso: string;
  groups: Record<string, PersistedGroupState>;
  digests: GroupScribeDigestCard[];
}

const DEFAULT_OWNER_ALIASES: readonly string[] = Object.freeze([
  "我",
  "本人",
  "主理人",
  "me",
  "self",
  "owner",
]);

const PEM_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 _-]*PRIVATE KEY-----/gi;
const PEM_UNCLOSED_HEADER_PATTERN = /-----BEGIN [A-Z0-9 _-]*PRIVATE KEY-----[^\r\n]*/gi;
const BEARER_SECRET_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const URL_QUERY_SECRET_PATTERN =
  /([?&](?:access_token|refresh_token|api_key|apikey|token|secret|key|auth)=)[A-Za-z0-9._~+/=-]{8,}/gi;
const KV_SECRET_PATTERN =
  /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|secret[_-]?key|bot[_-]?token|edge[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)[A-Za-z0-9._~+/=-]{8,}(["']?)/gi;
const PREFIXED_API_KEY_PATTERN =
  /\b(?:sk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{8,}|(?:clikey|cpa-admin|tok|emp|rk|pk|ak)[-_][A-Za-z0-9_-]{8,}|(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g;
const JWT_TOKEN_PATTERN =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{4,})?\b/g;

const POSIX_LOCAL_PATH_PATTERN =
  /(?<![A-Za-z0-9._/-])\/(?:Users|home|root|private\/var|private\/tmp|var\/folders|opt|etc)\/[A-Za-z0-9._~/-]+/g;
const WINDOWS_LOCAL_PATH_PATTERN =
  /\b[A-Za-z]:\\(?:Users|home|Projects|Program Files|Program Files \(x86\)|Windows|Temp|tmp)(?:\\[^\s"'`<>|，。；！？、）)】\]]*)*/gi;

const CONTROL_TAG_PATTERNS: readonly RegExp[] = [
  /\[\/?\s*UNTRUSTED_EXTERNAL_EVENT[^\]]*\]/gi,
  /\[\/?\s*(?:SYSTEM|SYSTEM_PROMPT|SYSTEM_OVERRIDE|ADMIN_OVERRIDE|OWNER_OVERRIDE|DEVELOPER|PRIVILEGED|BYPASS_APPROVAL|TOOL_CALL|TOOL_RESULT|FUNCTION_CALL)\b[^\]]*\]/gi,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id|end_header_id)\|>\s*(?:system|developer|assistant)?/gi,
  /<\s*\/?\s*(?:system|system_prompt|instructions?|developer|tool_call|tool_use|function_calls?|antml:[a-z0-9_-]+|override|privileged)\b[^>]*>/gi,
  /<<\s*\/?\s*SYS\s*>>/gi,
  /###\s*(?:System|Instruction|Developer|Override)\s*:/gi,
  /ignore\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?|guardrails?)[.!！。]*/gi,
  /disregard\s+(?:all\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?|guardrails?)[.!！。]*/gi,
  /(?:忽略|无视|跳过|绕过)(?:之前|上述|以上|前面|所有|全部)(?:的)?(?:所有|全部)?(?:系统)?(?:指令|提示词|红线|规则|安全限制|权限限制)[！!。，,]*/g,
];

export function sanitizeGroupMessageText(raw: string): string {
  if (!raw) return "";
  let text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const cp of CONTROL_TAG_PATTERNS) {
    text = text.replace(cp, " ");
  }
  text = text
    .replace(PEM_BLOCK_PATTERN, "[REDACTED_KEY]")
    .replace(PEM_UNCLOSED_HEADER_PATTERN, "[REDACTED_KEY]")
    .replace(BEARER_SECRET_PATTERN, "$1[REDACTED_KEY]")
    .replace(URL_QUERY_SECRET_PATTERN, "$1[REDACTED_KEY]")
    .replace(KV_SECRET_PATTERN, "$1[REDACTED_KEY]$2")
    .replace(PREFIXED_API_KEY_PATTERN, "[REDACTED_KEY]")
    .replace(JWT_TOKEN_PATTERN, "[REDACTED_KEY]")
    .replace(POSIX_LOCAL_PATH_PATTERN, "[local-path]")
    .replace(WINDOWS_LOCAL_PATH_PATTERN, "[local-path]");

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function sanitizeLabel(raw: string, fallback: string): string {
  const cleaned = sanitizeGroupMessageText(raw).replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

const DUE_HINT_PATTERNS: readonly RegExp[] = [
  /(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}月\d{1,2}[日号])(?:上午|中午|下午|傍晚|晚上|下班前|前|之前|内|之内)?/,
  /(?:(?:下下|本周|这周|下周)(?:周|星期|礼拜)?|(?:下下|本|这|下个?)(?:周|星期|礼拜)|(?:周|星期|礼拜))[一二三四五六日天末](?:上午|中午|下午|傍晚|晚上|下班前|晚间|前|之前|内|之内)?/,
  /(?:大后天|后天|明天|明日|今天|今日)(?:上午|中午|下午|傍晚|晚上|下班前|晚间|\s*\d{1,2}\s*点(?:半)?(?:前)?|之内|内|前|之前)?/,
  /(?:今晚|明早|明晚|今早)(?:\s*\d{1,2}\s*点(?:半)?(?:前)?|前|内)?/,
  /(?:本月底|下月底|月底|下月初|月初|本周末|这周末|周末|下下周|下周|本周|这周|季度末|年底)(?:前|之前|内|之内)?/,
  /(?:\d+|[一二两三四五六七八九十]+)\s*(?:个?工作日|个?小时|分钟|天)(?:之内|以内|内|后)/,
  /(?:下班前|会后|散会后|尽快|稍后|马上|立刻)/,
];

const TABOO_CUE_PATTERN =
  /(?:千万别|千万不要|千万不能|切勿|切忌|最忌讳|很忌讳|特别忌讳|忌讳|忌谈|忌提|不要提|别提|绝不能提|不能提|不要拿|别拿|严禁|禁止|绝不接受|不接受|最反感|很反感|极度反感|雷区|红线是|底线是|不要在群里)/;

const PREFERENCE_CUE_PATTERN =
  /(?:务必先|一定要先|必须先|请务必|只接受|只看|只认|只收|偏好|更倾向于?|倾向于|习惯先?|沟通时最好|汇报时最好|汇报前务必|统一用|一律用|格式要求)/;

const ACTION_VERB_PATTERN =
  /(?:发给?|发送|发出|发群里|发出来|同步|提交|整理|确认|核对|对齐|安排|补齐|补充|更新|汇总|交付|提供|输出|拉会|跟进|搞定|完成|落实|评审|敲定|批复|签字|盖章|给到|发一版)/;

const REQUEST_TO_OWNER_CUE_PATTERN = /(?:麻烦|劳烦|请|拜托|辛苦|需要|烦请|还得请)/;

function extractDueHint(clause: string): string | undefined {
  for (const re of DUE_HINT_PATTERNS) {
    const m = re.exec(clause);
    if (m?.[0]) return m[0].trim();
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isOwnerSpeaker(
  senderId: string,
  senderName: string,
  ownerSet: ReadonlySet<string>,
): boolean {
  return ownerSet.has(senderId.trim().toLowerCase()) || ownerSet.has(senderName.trim().toLowerCase());
}

function mentionsOwnerAlias(clause: string, ownerAliases: readonly string[]): boolean {
  for (const alias of ownerAliases) {
    const clean = alias.trim();
    if (!clean || clean === "我" || clean === "me" || clean === "self") continue;
    const re = new RegExp(`(?:@${escapeRegExp(clean)}|${escapeRegExp(clean)})`, "i");
    if (re.test(clause)) return true;
  }
  return false;
}

export function extractGroupDigestDeterministic(context: {
  groupId: string;
  groupName: string;
  projectKey?: string;
  ownerAliases: readonly string[];
  messages: readonly RecordedGroupMessage[];
}): GroupDigestExtractionResult {
  const ownerSet = new Set<string>(DEFAULT_OWNER_ALIASES.map((a) => a.toLowerCase()));
  for (const a of context.ownerAliases) {
    if (a?.trim()) ownerSet.add(a.trim().toLowerCase());
  }

  const waitingForCommitments: WaitingForCommitmentCandidate[] = [];
  const iOweCommitments: IOweCommitmentCandidate[] = [];
  const contactInsights: ContactInsightCandidate[] = [];
  const seenWaiting = new Set<string>();
  const seenIOwe = new Set<string>();
  const seenInsight = new Set<string>();

  for (const msg of context.messages) {
    const speakerOwner = isOwnerSpeaker(msg.senderId, msg.senderName, ownerSet);
    const clauses = msg.content
      .split(/[。\n；;！？!?]+/)
      .map((c) => c.trim())
      .filter((c) => c.length >= 4);

    for (const clause of clauses) {
      const dueHint = extractDueHint(clause);
      const isTaboo = TABOO_CUE_PATTERN.test(clause);
      const isPref = !isTaboo && PREFERENCE_CUE_PATTERN.test(clause);

      if ((isTaboo || isPref) && !speakerOwner) {
        const key = `${msg.senderName}::${clause}`;
        if (!seenInsight.has(key)) {
          seenInsight.add(key);
          contactInsights.push({
            speakerName: msg.senderName,
            speakerId: msg.senderId,
            insight: clause.slice(0, 160),
            isTaboo,
          });
        }
      }

      if (speakerOwner) {
        if (ACTION_VERB_PATTERN.test(clause) && (Boolean(dueHint) || /(?:我|咱们|我们|这边|一定|尽快|回头)/.test(clause))) {
          const summary = `我方承诺：${clause}`.slice(0, 160);
          if (!seenIOwe.has(summary)) {
            seenIOwe.add(summary);
            iOweCommitments.push({
              summary,
              counterpartyName: context.groupName || context.groupId,
              ...(dueHint ? { dueHint } : {}),
            });
          }
        }
        continue;
      }

      const asksOwner =
        (mentionsOwnerAlias(clause, context.ownerAliases) && ACTION_VERB_PATTERN.test(clause)) ||
        (REQUEST_TO_OWNER_CUE_PATTERN.test(clause) &&
          /(?:咱们|你们|贵司|刘总|吕总|陈总|老板|主理人|这边)/.test(clause) &&
          ACTION_VERB_PATTERN.test(clause));

      if (asksOwner) {
        const summary = `${msg.senderName}请求跟进：${clause}`.slice(0, 160);
        if (!seenIOwe.has(summary)) {
          seenIOwe.add(summary);
          iOweCommitments.push({
            summary,
            counterpartyName: msg.senderName,
            ...(dueHint ? { dueHint } : {}),
          });
        }
        continue;
      }

      const selfPromise =
        ACTION_VERB_PATTERN.test(clause) &&
        (/(?:我|我们|咱们|我这边|我们这边|小王|技术组|法务|财务)/.test(clause) || Boolean(dueHint));
      if (selfPromise && (Boolean(dueHint) || /(?:我|我们|我这边)/.test(clause))) {
        const summary = `${msg.senderName}承诺：${clause}`.slice(0, 160);
        if (!seenWaiting.has(summary)) {
          seenWaiting.add(summary);
          waitingForCommitments.push({
            summary,
            speakerName: msg.senderName,
            speakerId: msg.senderId,
            ...(dueHint ? { dueHint } : {}),
          });
        }
      }
    }
  }

  const threeLineSummary: [string, string, string] = [
    `群聊静默纪要：${context.groupName}（共旁听 ${context.messages.length} 条未归档消息，群内发言 0 条）`,
    `双向待办提炼：对方承诺 ${waitingForCommitments.length} 项 · 我方待跟进 ${iOweCommitments.length} 项`,
    contactInsights.length > 0
      ? `干系人洞察：捕获 ${contactInsights.length} 条沟通忌讳/偏好（待您拍板后写入五维人脉账本）`
      : "干系人洞察：本轮未检测到新增敏感忌讳或特殊偏好",
  ];

  return {
    waitingForCommitments,
    iOweCommitments,
    contactInsights,
    threeLineSummary,
  };
}

function writeAtomicJson600(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

export class GroupChatScribe {
  private readonly statePath: string;
  private readonly whitelistedGroups = new Set<string>();
  private readonly maxMessagesPerGroup: number;
  private readonly defaultOwnerAliases: string[];
  private readonly customExtractor?: GroupDigestCustomExtractor;
  private readonly nowIsoFn: () => string;
  private readonly groups = new Map<string, PersistedGroupState>();
  private readonly digests = new Map<string, GroupScribeDigestCard>();

  constructor(opts: GroupChatScribeOptions) {
    this.statePath = path.join(opts.dataDir, GROUP_SCRIBE_STATE_SUBDIR, GROUP_SCRIBE_STATE_FILENAME);
    for (const gid of opts.whitelistedGroupIds ?? []) {
      const trimmed = String(gid ?? "").trim();
      if (trimmed) this.whitelistedGroups.add(trimmed);
    }
    this.maxMessagesPerGroup = Math.max(
      1,
      Math.trunc(opts.maxMessagesPerGroup ?? DEFAULT_MAX_MESSAGES_PER_GROUP),
    );
    this.defaultOwnerAliases = [...(opts.ownerAliases ?? [])].map((a) => a.trim()).filter(Boolean);
    this.customExtractor = opts.customExtractor;
    this.nowIsoFn = opts.nowIso ?? (() => new Date().toISOString());
    this.loadFromDisk();
  }

  /** 硬红线不变量：群纪要员永远处于静默只读态，绝不向任何群发送消息。 */
  get outboundGroupMessagesSent(): 0 {
    return 0;
  }

  getWhitelistedGroupIds(): string[] {
    return Array.from(this.whitelistedGroups);
  }

  addWhitelistedGroup(groupId: string): void {
    const clean = groupId.trim();
    if (clean) this.whitelistedGroups.add(clean);
  }

  removeWhitelistedGroup(groupId: string): boolean {
    return this.whitelistedGroups.delete(groupId.trim());
  }

  setWhitelistedGroups(groupIds: Iterable<string>): void {
    this.whitelistedGroups.clear();
    for (const g of groupIds) {
      const clean = String(g ?? "").trim();
      if (clean) this.whitelistedGroups.add(clean);
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as Partial<PersistedScribeState>;
      for (const [gid, gState] of Object.entries(parsed.groups ?? {})) {
        if (!gState || typeof gState !== "object") continue;
        this.groups.set(gid, {
          groupId: gState.groupId || gid,
          groupName: gState.groupName || gid,
          messages: Array.isArray(gState.messages) ? gState.messages : [],
          seenMessageIds: Array.isArray(gState.seenMessageIds) ? gState.seenMessageIds : [],
        });
      }
      for (const d of parsed.digests ?? []) {
        if (d?.digestId) this.digests.set(d.digestId, d);
      }
    } catch {
      // ignore corrupted state cache
    }
  }

  private persist(): void {
    const groupsObj: Record<string, PersistedGroupState> = {};
    for (const [gid, g] of this.groups.entries()) {
      groupsObj[gid] = g;
    }
    const payload: PersistedScribeState = {
      version: 1,
      updatedAtIso: this.nowIsoFn(),
      groups: groupsObj,
      digests: Array.from(this.digests.values()),
    };
    writeAtomicJson600(this.statePath, payload);
  }

  recordGroupMessage(input: RecordGroupMessageInput): RecordGroupMessageResult {
    const groupId = String(input.groupId ?? "").trim();
    if (!groupId || !this.whitelistedGroups.has(groupId)) {
      return { recorded: false, reason: "group_not_whitelisted" };
    }
    const messageId = String(input.messageId ?? "").trim();
    if (!messageId) {
      throw new Error("GroupChatScribe.recordGroupMessage requires a non-empty messageId");
    }

    const gState: PersistedGroupState = this.groups.get(groupId) ?? {
      groupId,
      groupName: sanitizeLabel(input.groupName ?? groupId, groupId),
      messages: [],
      seenMessageIds: [],
    };
    if (input.groupName?.trim()) {
      gState.groupName = sanitizeLabel(input.groupName, groupId);
    }

    if (gState.seenMessageIds.includes(messageId) || gState.messages.some((m) => m.messageId === messageId)) {
      return { recorded: false, reason: "duplicate_message_id", deduplicated: true };
    }

    const sanitizedContent = sanitizeGroupMessageText(input.content);
    const senderName = sanitizeLabel(
      input.senderName ?? input.sender ?? input.senderId ?? "群成员",
      "群成员",
    );
    const senderId = sanitizeLabel(input.senderId ?? senderName, senderName);
    const timestampIso =
      input.timestampIso ??
      (typeof input.createdAtMs === "number" && Number.isFinite(input.createdAtMs)
        ? new Date(input.createdAtMs).toISOString()
        : this.nowIsoFn());

    const message: RecordedGroupMessage = {
      messageId,
      groupId,
      groupName: gState.groupName,
      senderId,
      senderName,
      content: sanitizedContent,
      timestampIso,
    };

    gState.messages.push(message);
    while (gState.messages.length > this.maxMessagesPerGroup) {
      gState.messages.shift();
    }
    gState.seenMessageIds.push(messageId);
    while (gState.seenMessageIds.length > MAX_RECENT_SEEN_IDS_PER_GROUP) {
      gState.seenMessageIds.shift();
    }

    this.groups.set(groupId, gState);
    this.persist();

    return {
      recorded: true,
      deduplicated: false,
      groupId,
      messageId,
      bufferedCount: gState.messages.length,
      sanitizedContent,
      message,
    };
  }

  getBufferedMessages(groupId: string, opts?: { unarchivedOnly?: boolean }): RecordedGroupMessage[] {
    const gState = this.groups.get(groupId.trim());
    if (!gState) return [];
    const list = opts?.unarchivedOnly
      ? gState.messages.filter((m) => !m.archivedAtIso)
      : gState.messages;
    return list.map((m) => ({ ...m }));
  }

  async distillGroupDigest(input: DistillGroupDigestInput): Promise<GroupScribeDigestCard> {
    const groupId = String(input.groupId ?? "").trim();
    if (!groupId || !this.whitelistedGroups.has(groupId)) {
      throw new Error(`Group "${groupId}" is not whitelisted for GroupChatScribe distillation`);
    }
    const gState = this.groups.get(groupId);
    const groupName = input.groupName?.trim()
      ? sanitizeLabel(input.groupName, groupId)
      : (gState?.groupName ?? groupId);
    const unarchived = (gState?.messages ?? []).filter((m) => !m.archivedAtIso);
    const ownerAliases = [
      ...DEFAULT_OWNER_ALIASES,
      ...this.defaultOwnerAliases,
      ...(input.ownerAliases ?? []),
    ];

    const extracted = this.customExtractor
      ? await this.customExtractor({
          groupId,
          groupName,
          ...(input.projectKey ? { projectKey: input.projectKey } : {}),
          ownerAliases,
          messages: unarchived,
        })
      : extractGroupDigestDeterministic({
          groupId,
          groupName,
          ...(input.projectKey ? { projectKey: input.projectKey } : {}),
          ownerAliases,
          messages: unarchived,
        });

    const threeLineSummary: [string, string, string] = extracted.threeLineSummary ?? [
      `群聊静默纪要：${groupName}（旁听 ${unarchived.length} 条消息）`,
      `待办提炼：对方承诺 ${extracted.waitingForCommitments.length} 项 · 我方待办 ${extracted.iOweCommitments.length} 项`,
      `干系人洞察：${extracted.contactInsights.length} 条`,
    ];

    const createdAtIso = this.nowIsoFn();
    const digestId = `gdig-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
    const card: GroupScribeDigestCard = {
      digestId,
      groupId,
      groupName,
      ...(input.projectKey ? { projectKey: input.projectKey } : {}),
      messageCount: unarchived.length,
      sourceMessageIds: unarchived.map((m) => m.messageId),
      waitingForCommitments: extracted.waitingForCommitments.map((c) => ({ ...c })),
      iOweCommitments: extracted.iOweCommitments.map((c) => ({ ...c })),
      contactInsights: extracted.contactInsights.map((c) => ({ ...c })),
      threeLineSummary,
      status: "pending_approval",
      createdAtIso,
    };

    this.digests.set(digestId, card);
    this.persist();
    return { ...card };
  }

  listDigests(opts: ListDigestsOptions = {}): GroupScribeDigestCard[] {
    return Array.from(this.digests.values())
      .filter((d) => {
        if (opts.status && d.status !== opts.status) return false;
        if (opts.groupId && d.groupId !== opts.groupId) return false;
        return true;
      })
      .sort((a, b) => b.createdAtIso.localeCompare(a.createdAtIso))
      .map((d) => ({ ...d }));
  }

  approveDigest(
    digestId: string,
    ledger: Pick<StewardshipLedger, "snapshotForCaller" | "upsertCommitment" | "upsertRelationship" | "upsertResource">,
    nowIso = this.nowIsoFn(),
  ): ApproveDigestResult {
    const card = this.digests.get(digestId.trim());
    if (!card) throw new Error(`GroupScribeDigestCard not found: ${digestId}`);
    if (card.status === "dismissed") {
      throw new Error(`Cannot approve already dismissed digest: ${digestId}`);
    }
    if (card.status === "approved") {
      return {
        ok: true,
        idempotent: true,
        digest: { ...card },
        writtenCommitments: 0,
        writtenRelationships: 0,
        writtenResources: 0,
      };
    }

    let writtenCommitments = 0;
    card.waitingForCommitments.forEach((item, idx) => {
      ledger.upsertCommitment(
        {
          id: `cmt-${card.digestId}-wait-${idx}`,
          partition: "work_project",
          direction: "waiting_for",
          status: "open",
          summary: item.dueHint ? `${item.summary}（期限线索：${item.dueHint}）` : item.summary,
          counterpartyOrRef: item.speakerName || card.groupName,
        },
        nowIso,
      );
      writtenCommitments += 1;
    });

    card.iOweCommitments.forEach((item, idx) => {
      ledger.upsertCommitment(
        {
          id: `cmt-${card.digestId}-owe-${idx}`,
          partition: "work_project",
          direction: "i_owe",
          status: "open",
          summary: item.dueHint ? `${item.summary}（期限线索：${item.dueHint}）` : item.summary,
          counterpartyOrRef: item.counterpartyName || card.groupName,
        },
        nowIso,
      );
      writtenCommitments += 1;
    });

    const existingRels = ledger.snapshotForCaller("owner_private").relationships;
    const insightsBySpeaker = new Map<
      string,
      { speakerName: string; taboos: string[]; preferences: string[] }
    >();
    for (const ins of card.contactInsights) {
      const key = ins.speakerName.trim();
      if (!key) continue;
      const bucket = insightsBySpeaker.get(key) ?? {
        speakerName: key,
        taboos: [],
        preferences: [],
      };
      if (ins.isTaboo) bucket.taboos.push(ins.insight);
      else bucket.preferences.push(ins.insight);
      insightsBySpeaker.set(key, bucket);
    }

    let writtenRelationships = 0;
    for (const bucket of insightsBySpeaker.values()) {
      const prev = existingRels.find(
        (r) => r.subjectType === "key_contact" && r.name === bucket.speakerName,
      );
      const mergedTaboos = Array.from(new Set([...(prev?.taboos ?? []), ...bucket.taboos]));
      const mergedPrefs = Array.from(new Set([...(prev?.preferences ?? []), ...bucket.preferences]));
      const safeTier: TrustTier | undefined =
        prev?.trustTier && prev.trustTier !== "L3_shadow_autonomous" ? prev.trustTier : undefined;
      ledger.upsertRelationship(
        {
          ...(prev?.id ? { id: prev.id } : {}),
          partition: "work_project",
          subjectType: "key_contact",
          name: bucket.speakerName,
          ...(prev?.roleTag ? { roleTag: prev.roleTag } : { roleTag: `${card.groupName}干系人` }),
          ...(safeTier ? { trustTier: safeTier } : {}),
          taboos: mergedTaboos,
          preferences: mergedPrefs,
        },
        nowIso,
      );
      writtenRelationships += 1;
    }

    ledger.upsertResource(
      {
        id: `res-${card.digestId}`,
        partition: "work_project",
        kind: "personal_archive",
        title: `项目群纪要归档 · ${card.groupName}`,
        metadata: {
          source: "group_chat_scribe",
          digestId: card.digestId,
          groupId: card.groupId,
          messageCount: card.messageCount,
          ...(card.projectKey ? { projectKey: card.projectKey } : {}),
        },
      },
      nowIso,
    );

    card.status = "approved";
    card.approvedAtIso = nowIso;
    const gState = this.groups.get(card.groupId);
    if (gState) {
      const srcSet = new Set(card.sourceMessageIds);
      for (const m of gState.messages) {
        if (srcSet.has(m.messageId) && !m.archivedAtIso) {
          m.archivedAtIso = nowIso;
          m.archivedDigestId = card.digestId;
        }
      }
    }
    this.persist();

    return {
      ok: true,
      idempotent: false,
      digest: { ...card },
      writtenCommitments,
      writtenRelationships,
      writtenResources: 1,
    };
  }

  dismissDigest(digestId: string, nowIso = this.nowIsoFn()): DismissDigestResult {
    const card = this.digests.get(digestId.trim());
    if (!card) throw new Error(`GroupScribeDigestCard not found: ${digestId}`);
    if (card.status === "approved") {
      throw new Error(`Cannot dismiss already approved digest: ${digestId}`);
    }
    if (card.status === "dismissed") {
      return { ok: true, idempotent: true, digest: { ...card } };
    }
    card.status = "dismissed";
    card.dismissedAtIso = nowIso;
    this.persist();
    return { ok: true, idempotent: false, digest: { ...card } };
  }
}
