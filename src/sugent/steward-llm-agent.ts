import type { ArtifactComprehensionResult } from "./antigravity-artifacts.js";
import type { DispatchOutcome } from "./antigravity-dispatcher.js";
import type { CommandExecutionOutcome } from "./concierge-dispatcher.js";
import type { ConciergeChannelKind } from "./concierge-envelope.js";
import type { SugentKnowledgeGraph } from "./knowledge-graph.js";
import type { StewardWorkbenchLike } from "./steward-conversation.js";
import type {
  CallerAccessDomain,
  CommitmentItem,
  ContextPartition,
  GoalNorthStar,
  RelationshipProfile,
  ResourceEntry,
  StewardshipLedger,
  TrustTier,
} from "./stewardship-ledger.js";
import type { DropzoneChannel, DropzoneOutcome } from "./universal-dropzone.js";
import type { VibeIngressChannel } from "./handoff-file-bridge.js";
import type { RepoBindingRecord, UpsertRepoBindingInput } from "./repo-binding.js";
import type { VibePipelineRecord } from "./vibe-coding-pipeline.js";
import { formatCapabilityAwarenessPrompt, type CapabilityDescriptor } from "./capability-awareness.js";
import type { AuthorizedFileMatch, ReadAuthorizedFileResult } from "./authorized-file-reader.js";
import type {
  AdaptiveRoutingDashboardSnapshot,
  ResolvedRouteEndpoint,
  RouteDecisionPlan,
  RoutingRequestContext,
} from "./adaptive-router.js";
import type { ModelTier } from "./model-catalog.js";
import type { ProviderSyncResult } from "./model-pool-sync.js";
import type {
  RoutingOperatingMode,
  RoutingOutcomeEvent,
  RoutingPolicyState,
  RoutingStrategyPreset,
  TaskArchetype,
} from "./routing-experience-store.js";
import type { ChatHistoryRecallResult, RecallChatHistoryInput } from "./chat-transcript-recall.js";
import type { EdgeNodeStatus, EdgeQueuedCommand } from "./edge-tentacle-hub.js";
import type { AirTokenOpsToolInput } from "./airtoken-ops-bridge.js";
import { buildSiliconCharterPrompt } from "./silicon-identity-core.js";

export interface StewardLlmEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface StewardRouteMeta {
  decisionId: string;
  archetype: TaskArchetype;
  selectedModel: string;
  targetId: string;
  providerId: string;
  strategy: RoutingStrategyPreset;
  mode: RoutingOperatingMode;
  reasonSummary: string;
  fallbackFrom?: string;
  escalatedFrom?: string;
  skippedCoolingModels: string[];
  canRetryStronger: boolean;
}

export interface StewardLlmToolsPort<TWorkbench extends StewardWorkbenchLike = StewardWorkbenchLike> {
  getWorkbench(callerDomain?: CallerAccessDomain): TWorkbench;
  queryLedger(query: string, callerDomain: CallerAccessDomain): ReturnType<StewardshipLedger["queryContext"]>;
  findArchiveResources(query: string, callerDomain: CallerAccessDomain): ResourceEntry[];
  recallKnowledgeSubgraph?(
    query: string,
  ):
    | Array<{ name: string; kind: string; summary: string }>
    | { nodes: Array<{ name: string; kind: string; summary: string }>; edges: string[] };
  upsertArchiveResource(input: { partition: ContextPartition; title: string; dueAt?: string; filePaths?: string[] }): ResourceEntry[];
  mutateCommitment(input: {
    action: "upsert" | "status";
    id?: string;
    partition?: ContextPartition;
    direction?: CommitmentItem["direction"];
    summary?: string;
    counterpartyOrRef?: string;
    dueAt?: string;
    status?: CommitmentItem["status"];
    callerDomain?: CallerAccessDomain;
  }): { ok: true; commitment: CommitmentItem; workbench: TWorkbench; roadmapItemId?: string; nextAiHint?: string };
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
  mutateTrust(input: {
    id: string;
    action: "observe" | "promote_l3" | "downgrade";
    ownerConfirmed?: boolean;
    targetTier?: TrustTier;
    callerDomain?: CallerAccessDomain;
  }): { ok: boolean; errorCode?: string; message?: string; profile?: RelationshipProfile; workbench: TWorkbench };
  submitDropzone(input: {
    text: string;
    channel?: DropzoneChannel;
    partition?: ContextPartition;
    callerDomain?: CallerAccessDomain;
    filePaths?: string[];
  }): Promise<{ ok: true; outcome: DropzoneOutcome; workbench: TWorkbench }>;
  scanCadence(input?: { quietHoursActive?: boolean; calibrationDue?: boolean; callerDomain?: CallerAccessDomain }): {
    emitNow: Array<{ urgency: string; title: string; threeLineBody: [string, string, string] }>;
    foldToMorningDigest: Array<{ urgency: string; title: string; threeLineBody: [string, string, string] }>;
    workbench: TWorkbench;
  };
  setQuietHours(active: boolean, callerDomain?: CallerAccessDomain): { quietHoursActive: boolean; workbench: TWorkbench };
  setProjectTier(input: { projectKey: string; tier: 0 | 1 | 2; callerDomain?: CallerAccessDomain }): { workbench: TWorkbench };
  markSessionViewed(input: { conversationId: string; callerDomain?: CallerAccessDomain }): { workbench: TWorkbench };
  comprehendSession(input: { conversationId: string; projectKey: string; title?: string; callerDomain?: CallerAccessDomain }): Promise<ArtifactComprehensionResult>;
  dispatchAntigravity(input: {
    mode: "resume" | "new";
    conversationId?: string;
    prompt: string;
    title?: string;
    workspacePath?: string;
  }): Promise<DispatchOutcome>;
  executeConciergeCommand?(commandText: string, channel?: ConciergeChannelKind): Promise<CommandExecutionOutcome>;
  bindSelfRepo?(opts?: { repoRoot?: string; targetAppBundlePath?: string }, callerDomain?: CallerAccessDomain): { ok: true; binding: RepoBindingRecord; workbench: TWorkbench };
  upsertRepoBinding?(input: UpsertRepoBindingInput, callerDomain?: CallerAccessDomain): { ok: true; binding: RepoBindingRecord; workbench: TWorkbench };
  startVibeTask?(input: { text: string; bindingQuery?: string; channel?: VibeIngressChannel; filePaths?: string[]; callerDomain?: CallerAccessDomain }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord; workbench: TWorkbench }>;
  decideVibeTask?(input: { pipelineId?: string; rawReplyText?: string; action?: "approve" | "revise" | "cancel" | "verify_now" | "relaunch_now"; feedback?: string; callerDomain?: CallerAccessDomain }): Promise<{ ok: boolean; message: string; pipeline?: VibePipelineRecord; workbench: TWorkbench }>;
  searchAuthorizedFiles?(input: { query?: string; projectQuery?: string; conversationId?: string; callerDomain?: CallerAccessDomain; limit?: number }): AuthorizedFileMatch[];
  readAuthorizedFile?(input: { filePath?: string; fileQuery?: string; projectQuery?: string; conversationId?: string; offsetChars?: number; maxChars?: number; callerDomain?: CallerAccessDomain }): ReadAuthorizedFileResult;
  getRoutingDashboard?(): AdaptiveRoutingDashboardSnapshot;
  syncModelPool?(opts?: { providerId?: string; force?: boolean }): Promise<ProviderSyncResult[]>;
  updateRoutingPolicy?(patch: {
    strategy?: RoutingStrategyPreset;
    mode?: RoutingOperatingMode;
    pinnedModel?: string | null;
    directive?: string;
  }): { matched?: boolean; summary?: string; policy: RoutingPolicyState };
  manageHotUpdate?(input: {
    action: "status" | "reload_ui" | "reload_core" | "rollback" | "factory_reset";
    file?: string;
    reason?: string;
  }): Promise<Record<string, unknown>>;
  delegateLocalTask?(input: LocalTaskDelegationInput): Promise<LocalTaskDelegationResult> | LocalTaskDelegationResult;
  refreshOpsFleet?(): Promise<{
    ok: boolean;
    configured: boolean;
    snapshot?: StewardWorkbenchLike["opsFleet"];
    reason?: string;
  }>;
  readProjectGovernanceDoc?(input: {
    projectQuery: string;
    docPath?: string;
    callerDomain?: CallerAccessDomain;
  }): Promise<Record<string, unknown>>;
  proposeOpsInbox?(input: {
    title: string;
    summary?: string;
    targetNodeId?: string;
    commandAction?: string;
    projectKey?: string;
    requiresDashboardConfirm?: boolean;
    weeklyFocus?: string[];
  }): Promise<Record<string, unknown>>;
  recallChatHistory?(input: RecallChatHistoryInput): ChatHistoryRecallResult;
  dispatchEdgeAntigravity?(input: {
    targetNodeId?: string;
    mode?: "new" | "resume";
    title: string;
    prompt: string;
    projectQuery?: string;
    conversationId?: string;
    workspaceHint?: string;
  }): Promise<{ ok: boolean; command?: EdgeQueuedCommand; nodes?: EdgeNodeStatus[]; errorCode?: string; message?: string }> | { ok: boolean; command?: EdgeQueuedCommand; nodes?: EdgeNodeStatus[]; errorCode?: string; message?: string };
  analyzeForwardedChat?(input: {
    rawForwardedText: string;
    ownerName?: string;
    autoRecordToLedger?: boolean;
  }): unknown;
  manageWeChatEnvoy?(input: {
    action:
      | "status"
      | "poll_now"
      | "distill_group"
      | "approve_digest"
      | "dismiss_digest"
      | "update_allowlist"
      | "reply_public_visitor";
    groupId?: string;
    groupName?: string;
    projectKey?: string;
    digestId?: string;
    addGroupId?: string;
    removeGroupId?: string;
    addDmPeerId?: string;
    removeDmPeerId?: string;
    sessionId?: string;
    publicAction?: "approve_reply" | "unlock" | "merge" | "decline" | "block";
    ownerReply?: string;
  }): Promise<Record<string, unknown>>;
  manageAirTokenOps?(input: AirTokenOpsToolInput): Promise<Record<string, unknown>>;
}

export interface LocalTaskDelegationInput {
  title: string;
  instruction: string;
  requireDesktopGui?: boolean;
  workspacePath?: string;
  channel?: DropzoneChannel;
}

export interface LocalTaskDelegationResult {
  ok: boolean;
  taskId?: string;
  status?: string;
  errorCode?: string;
  message?: string;
}

export const STEWARD_CAPABILITY_DESCRIPTORS: readonly CapabilityDescriptor[] = [
  { toolName: "query_personal_memory", title: "五维个人记忆检索", summary: "查询目标、待办、联系人禁忌、价值红线/墓碑、档案与图谱", whenToUse: ["查目标/待办/红线/联系人/历史档案"] },
  { toolName: "capture_note_or_todo", title: "静默记事与待办归档", summary: "快速记下随口交代的待办、临期提醒或本地档案", whenToUse: ["记一下/备忘/待办/存档案"] },
  { toolName: "manage_focus_goals", title: "北极星主目标管理", summary: "新增、替换（上限 3 项）、暂停或达成重点目标", whenToUse: ["设目标/换目标/目标完成"] },
  { toolName: "complete_todo", title: "待办销账", summary: "标记待办或承诺已完成并积累配合度", whenToUse: ["某事办妥了/搞定了/销账"] },
  { toolName: "prepare_offline_errand", title: "线下事务前 80% 准备包", summary: "查清流程、翻齐本地证件与可复制话术", whenToUse: ["线下办理/政务/报销/无工具跑腿"] },
  { toolName: "manage_messages", title: "社交消息耳麦代理", summary: "查看外部来信、稳健/积极拟稿、发前确认与缓冲期撤回", whenToUse: ["有人找我吗/回复某客户/撤回消息"] },
  { toolName: "manage_antigravity", title: "Antigravity 会话观测与唤醒", summary: "查看开发项目实时进度、安全信封解读或唤醒原根会话", whenToUse: ["项目在跑啥/看会话进度/叫醒原会话"] },
  { toolName: "manage_vibe_coding", title: "本地仓绑定与定制开发流水线", summary: "绑定本地源码仓、隔离 worktree 透传文件、方案拍板与安全重启", whenToUse: ["绑定仓库/定制开发/批复方案/安全重启"] },
  { toolName: "read_authorized_file", title: "受控本地项目与制品全文读取", summary: "在已注册项目、绑定仓与 brain 制品目录检索并分段读取完整 .md/日志全文（单次最高 24000 字）", whenToUse: ["要看完整报告/.md全文/每日复盘/排查截断摘要"] },
  { toolName: "manage_briefing_and_prefs", title: "简报巡检与隐私偏好", summary: "扫描今日提醒、开关免打扰或调整自治信任等级", whenToUse: ["今日简报/开免打扰/调整自治度"] },
  { toolName: "manage_model_routing", title: "CLIProxyAPI 全量模型对齐与自适应路由", summary: "查看模型池与经验评分、同步全量可用模型、切换省配额/平衡/旗舰策略或设定偏好约束", whenToUse: ["同步模型池/查看当前自动选模情况/切换省钱或旗舰策略/以后某类任务优先或禁用某模型"] },
  { toolName: "manage_hot_update", title: "分层热启动与热更新控制 (L0-L3)", summary: "查看热更新/A-B槽位状态、触发 UI 热刷新、Core 热重启、安全回滚槽位或恢复出厂金丝雀", whenToUse: ["热重启/热更新状态/UI热刷新/回滚槽位/恢复出厂镜像"] },
  { toolName: "delegate_local_execution", title: "本机终端/文件/桌面操控异步下沉执行", summary: "将耗时终端命令、本地文件整理或原生桌面软件操控委托给后台 DSH 执行引擎异步推进", whenToUse: ["执行本机命令/整理本地文件夹/操控桌面软件/导出本地报表"] },
  { toolName: "recall_chat_history", title: "全渠道跨天对话记忆召回", summary: "检索微信、网页端与飞书跨天原始聊天记录（支持昨天/前天/上周或按项目关键词检索）", whenToUse: ["昨天我们聊了什么/回忆之前对话/查找某天聊过的决定"] },
  { toolName: "dispatch_edge_antigravity", title: "边缘触手 Antigravity 远程派单", summary: "作为顶层管家将具体编码开发与验证任务下发给本机 local-mac 或云端 gce-remote 的 Antigravity 触手执行", whenToUse: ["让本机或云端 Antigravity 改代码/给某项目派开发任务/唤醒远端会话"] },
  { toolName: "analyze_forwarded_chat", title: "微信合并转发记录 3 秒参谋与落账", summary: "对转发的聊天记录执行安全信封隔离、历史底价/红线核验、生成双版本回复话术并幂等写入五维待办与档案", whenToUse: ["主人转发聊天记录/粘贴客户对话请参谋怎么回/提取对方承诺记账"] },
  { toolName: "manage_wechat_envoy", title: "双微信号助理边车、项目群纪要与官网访客管理", summary: "管理独立手机号助理微信边车、提炼或审批白名单项目群纪要入账、以及代回官网数字分身访客咨询", whenToUse: ["助理微信号状态/提炼或批准群聊纪要/更新群白名单/回复官网来客"] },
  { toolName: "manage_airtoken_ops", title: "AirToken 双链金库与实盘运维管控", summary: "免密查询 AirToken 运行状态与 Solana 战绩、续期 IPC 会话、切换执行模式、退租回收、锁库及获取安全解锁链接", whenToUse: ["查AirToken状态或战绩/续期会话/切回纸盘或Canary/退租/锁库/获取解锁链接"] },
];
const LLM_TOOLS = [
  {
    type: "function",
    function: {
      name: "query_personal_memory",
      description: "查询主人的五维生命账本：重点目标、待办事项、人脉禁忌与偏好、价值红线/历史墓碑、本地档案与知识图谱。",
      parameters: { type: "object", properties: { query: { type: "string", description: "检索关键词或主题，留空可总览" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "capture_note_or_todo",
      description: "把随口交代的备忘、文件或双向待办/临期事项静默记入本地账本与档案。",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["archive", "todo"] },
          text: { type: "string" },
          direction: { type: "string", enum: ["i_owe", "waiting_for", "expiring"] },
          counterparty: { type: "string" },
          dueAt: { type: "string" },
          filePaths: { type: "array", items: { type: "string" } },
        },
        required: ["kind", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_focus_goals",
      description: "管理主人的重点北极星目标（受最多 3 个活跃目标硬上限约束；若已满请返回现有 3 个目标请主人挑一个替换）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add", "replace", "achieve", "pause"] },
          title: { type: "string" },
          northStarCriterion: { type: "string" },
          targetGoalQuery: { type: "string", description: "要替换/达成/暂停的旧目标名称或序号（如 1/2/3）" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_todo",
      description: "将某项挂账待办或承诺标记为已完成销账（同时自动积累 1 次无误配合记录）。",
      parameters: { type: "object", properties: { todoQuery: { type: "string" } }, required: ["todoQuery"] },
    },
  },
  {
    type: "function",
    function: {
      name: "prepare_offline_errand",
      description: "处理政务、就医、线下跑腿等无自动化 API 的事务，生成前 80% 准备清单、本地证件检索、可复制话术并挂跟进待办。",
      parameters: { type: "object", properties: { taskDescription: { type: "string" } }, required: ["taskDescription"] },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_messages",
      description: "查看外部来信、按稳健/积极拟稿发送、发送自定义回复、在主人下轮明确确认后确认发送含金额回复，或撤回缓冲期内的外发消息。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "send_preset_a", "send_preset_b", "send_custom", "confirm_pending", "undo_last"] },
          peerQuery: { type: "string" },
          customBody: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_antigravity",
      description: "查看本机 Antigravity 代码项目进展、经安全信封解读会话制品/成果、调整项目隐私档位、标记会话已处理、唤醒原根会话或新开任务。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["overview", "comprehend_session", "set_privacy", "mark_viewed", "wake_session", "new_session"] },
          projectOrSessionQuery: { type: "string" },
          privacyLevel: { type: "string", enum: ["private", "summary", "collab"] },
          messageOrPrompt: { type: "string" },
          title: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_briefing_and_prefs",
      description: "主动扫描今日提醒与早间简报、开关免打扰、或调整主人信任自治等级。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["get_briefing", "set_quiet_hours", "set_trust_mode"] },
          quietHours: { type: "boolean" },
          trustMode: { type: "string", enum: ["record_only", "whisper", "autonomous"] },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_vibe_coding",
      description: "绑定本地代码仓库（含一键绑定 Sugent 自身源码）、向隔离工作区派发定制开发与透传文件、批准/修改方案或触发安全重启。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "bind_self", "bind_repo", "start_task", "decide_task"] },
          repoAlias: { type: "string" },
          repoRoot: { type: "string" },
          requirementText: { type: "string" },
          filePaths: { type: "array", items: { type: "string" } },
          pipelineId: { type: "string" },
          decision: { type: "string", enum: ["approve", "revise", "cancel", "verify_now", "relaunch_now"] },
          feedback: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_authorized_file",
      description: "在已注册的本机项目目录、绑定代码仓、Antigravity brain 制品目录与个人档案库中检索并分页读取完整文本文件（突破摘要截断，支持 .md/.txt/.json/.log）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["search", "read"] },
          query: { type: "string", description: "文件名或关键词，如 2026-11-21_daily_review.md" },
          filePath: { type: "string", description: "已知的授权文件绝对路径" },
          projectQuery: { type: "string", description: "限定项目名称或关键词，如 airtoken" },
          conversationId: { type: "string", description: "限定 Antigravity 会话 ID" },
          offsetChars: { type: "number", description: "分段读取起始字符偏移，默认 0" },
          maxChars: { type: "number", description: "单次返回最大字符数（500-24000，默认 12000）" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_model_routing",
      description: "查看 CLIProxyAPI 模型池同步与自适应路由经验榜、手动触发模型全量同步，或根据主人自然语言指令调整路由策略（如优先/禁用/锁定某模型，或切换省配额/平衡/质量优先）。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "sync", "set_policy"] },
          directive: { type: "string", description: "主人的自然语言路由偏置指令" },
          strategy: { type: "string", enum: ["quota_saver", "balanced", "quality_first"] },
          mode: { type: "string", enum: ["auto", "shadow", "pinned"] },
          pinnedModel: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_hot_update",
      description: "查询分层热更新与 A/B 槽位状态，触发 UI 热刷新 (L1)、Core 热重启 (L2)、回滚或恢复出厂金丝雀",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "reload_ui", "reload_core", "rollback", "factory_reset"] },
          file: { type: "string", description: "reload_ui 可选变更文件名" },
          reason: { type: "string", description: "reload_core 可选原因说明" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_local_execution",
      description: "将需要本机终端脚本、批量文件读写或 CUA 原生桌面 GUI 操作的重执行任务下沉委托给后台执行引擎异步推进，并在需要审批或完工时推送卡片。",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "简短任务标题" },
          instruction: { type: "string", description: "完整的执行指令与验收目标" },
          requireDesktopGui: { type: "boolean", description: "是否需要操作本机桌面 GUI 窗口" },
          workspacePath: { type: "string", description: "可选目标本地目录" },
        },
        required: ["title", "instruction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_ops_fleet",
      description: "实时查询运营总控台 (/ops) 与边缘触手的跨节点项目全量态势（含 STATUS.md 状态卡、gitSync 未提交/未push/落后远端/待合PR分支、tasksSummary 工单池 #slug 与 AC、路线图全量阶段 nodes[].items[]、recentPlans 计划索引）、跨端只读拉取指定项目的 ROADMAP.md / TASKS.md / STATUS.md / docs/plans/*.md 原文，或生成排期/派单草案写入待签批收件箱。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["overview", "read_doc", "propose_inbox"] },
          projectQuery: { type: "string", description: "按项目名称或关键词筛选项目（如 airtoken、sugent、Andy-web、self-a-web）" },
          docPath: { type: "string", description: "action='read_doc' 时的治理文档相对路径，默认 ROADMAP.md，也可为 TASKS.md、STATUS.md、AGENTS.md 或 docs/plans/*.md" },
          title: { type: "string", description: "排期或派单草案标题" },
          summary: { type: "string", description: "草案具体内容与验收要点" },
          targetNodeId: { type: "string", description: "目标执行节点，默认 local-mac" },
          commandAction: { type: "string", description: "签批后下发的指令动作名，如 sync_weekly_plan" },
          projectKey: { type: "string", description: "关联项目标识" },
          requiresDashboardConfirm: { type: "boolean", description: "涉及资金、合同、对外发言时设为 true" },
          weeklyFocus: { type: "array", items: { type: "string" }, description: "可选本周重点列表" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_chat_history",
      description: "检索主人与管家在微信、网页端、飞书等全渠道的跨天历史对话记录（自动脱敏密钥）。当主人询问“昨天我们聊了什么”、“之前聊过某事吗”、“上次说的决定”时，必须优先调用此工具，严禁声称不保存跨天对话。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "时间线索或话题关键词，如 '昨天我们聊了什么' 或 'airtoken'" },
          daysBack: { type: "number", description: "向前追溯天数，默认按时间词自动推断（如昨天=2，上周=14）" },
          channel: { type: "string", enum: ["all", "weixin", "feishu", "web", "web_ui"], description: "渠道筛选，默认 all 全渠道合并" },
          limit: { type: "number", description: "返回条数上限，默认 24" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "dispatch_edge_antigravity",
      description: "作为常驻云端的顶层管家与总协调者，将具体的代码编写、功能迭代或测试修复任务派发给边缘节点的 Antigravity 执行触手（如本机 local-mac 或云端远程开发机 gce-remote）落地执行，完工后自动向微信推送回执。",
      parameters: {
        type: "object",
        properties: {
          targetNodeId: { type: "string", description: "目标执行节点 ID（如 local-mac 或 gce-remote），留空则按项目所在节点自动路由" },
          mode: { type: "string", enum: ["new", "resume"], description: "新建会话 new 或唤醒既有会话 resume，默认 new" },
          title: { type: "string", description: "简明开发任务标题" },
          prompt: { type: "string", description: "发给 Antigravity 的完整任务背景、目标与验收要求" },
          projectQuery: { type: "string", description: "关联项目名称或代号，如 airtoken、sugent" },
          conversationId: { type: "string", description: "mode='resume' 时要唤醒的目标会话 ID" },
          workspaceHint: { type: "string", description: "可选项目目录名提示" },
        },
        required: ["title", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_forwarded_chat",
      description: "解析主人合并转发或粘贴的外部沟通聊天记录（如 [合并转发的聊天记录]），3 秒内对比五维账本历史底价、账期红线与客户忌讳，输出守底线/折中双版本可复制话术，并自动将双方承诺事项与沟通档案幂等写入五维账本。",
      parameters: {
        type: "object",
        properties: {
          rawForwardedText: { type: "string", description: "完整的合并转发文本或对话摘录" },
          ownerName: { type: "string", description: "可选，主人在对话中的显示昵称以便区分我方承诺" },
          autoRecordToLedger: { type: "boolean", description: "是否自动幂等记入五维待办与档案，默认 true" },
        },
        required: ["rawForwardedText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_wechat_envoy",
      description: "管理独立手机号助理微信号无头边车、白名单项目群静默纪要提炼与审批入账、以及官网数字分身公域访客代回。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["status", "poll_now", "distill_group", "approve_digest", "dismiss_digest", "update_allowlist", "reply_public_visitor"],
          },
          groupId: { type: "string", description: "项目群 ID（如 xxx@chatroom）" },
          groupName: { type: "string", description: "可选项目群名称" },
          projectKey: { type: "string", description: "可选关联项目标识" },
          digestId: { type: "string", description: "群纪要卡片 ID（如 gdig-...）" },
          addGroupId: { type: "string", description: "新增白名单群 ID" },
          removeGroupId: { type: "string", description: "移除白名单群 ID" },
          addDmPeerId: { type: "string", description: "新增白名单私聊 wxid" },
          removeDmPeerId: { type: "string", description: "移除白名单私聊 wxid" },
          sessionId: { type: "string", description: "官网公域访客会话 ID" },
          publicAction: { type: "string", enum: ["approve_reply", "unlock", "merge", "decline", "block"] },
          ownerReply: { type: "string", description: "给官网访客的正式回复正文" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "manage_airtoken_ops",
      description: "免密管控 AirToken 实盘与金库会话：查状态(status)、查Solana战绩(epoch)、续期会话(extend)、切换模式(mode)、紧急锁库(lock)、空ATA退租(reclaim)、维护审批(maintenance)、智能解锁引导(unlock)。严禁向工具传入主密码或私钥。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["status", "epoch", "extend", "mode", "lock", "reclaim", "maintenance", "unlock"] },
          preset: { type: "string", enum: ["30m", "4h", "8h", "12h"], description: "action=extend 时使用的续期时长，默认 8h" },
          targetMode: { type: "string", enum: ["paper", "dry_run", "canary"], description: "action=mode 时的目标执行模式" },
          burnDust: { type: "boolean", description: "action=reclaim 时是否顺带销毁已平仓粉尘" },
          dryRun: { type: "boolean", description: "action=reclaim 时是否仅预览不发交易" },
          maintenanceAction: { type: "string", enum: ["status", "approve_window", "approve_now", "defer_24h", "cancel"] },
        },
        required: ["action"],
      },
    },
  },
];
const shortProj = (k: string): string => k.replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");
const tierLabel = (t: 0 | 1 | 2): string => (t === 0 ? "私密（仅本机）" : t === 1 ? "脱敏摘要" : "深度协同");

function matchItem<T>(items: readonly T[], query: string, getText: (it: T) => string): T | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return items[0];
  const ordMatch = q.match(/^[第]?\s*([1-9])\s*[个条项]?$/);
  if (ordMatch?.[1]) {
    const idx = Number(ordMatch[1]) - 1;
    if (items[idx]) return items[idx];
  }
  const direct = items.find((it) => {
    const txt = getText(it).toLowerCase();
    return txt.includes(q) || q.includes(txt);
  });
  if (direct) return direct;
  const han = Array.from(q).filter((c) => /\p{Script=Han}/u.test(c));
  const toks = new Set([...(q.match(/[a-z0-9_-]{2,}/g) ?? []), ...han.slice(0, -1).map((c, i) => c + han[i + 1]!)]);
  let best: T | undefined;
  let bestScore = 0;
  for (const it of items) {
    const txt = getText(it).toLowerCase();
    let score = 0;
    for (const tok of toks) if (txt.includes(tok)) score += 1;
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return bestScore > 0 ? best : undefined;
}

function buildSystemPrompt(wb: StewardWorkbenchLike): string {
  const goals = wb.ledger.goals.filter((g) => g.status === "active").map((g, i) => `${i + 1}. ${g.title}（${g.northStarCriterion}）`);
  const commits = wb.ledger.commitments.filter((c) => c.status === "open" || c.status === "waiting_review").slice(0, 8).map((c) => `- ${c.summary} (${c.counterpartyOrRef})`);
  const guards = wb.ledger.guardrails.slice(0, 6).map((g) => `- ${g.statement}`);
  const contacts = wb.ledger.relationships.filter((r) => r.subjectType === "key_contact").slice(0, 5).map((r) => `- ${r.name}${r.taboos.length ? ` 忌讳:${r.taboos.join("；")}` : ""}`);
  const msgCount = wb.concierge?.cards.length ?? 0;
  const running = wb.antigravity.sessions
    .filter((s) => s.isRunning)
    .slice(0, 5)
    .map((s) => `${s.projectDisplayName || shortProj(s.projectKey)}「${s.title || s.conversationId.slice(0, 8)}」(第${s.stepCount ?? 0}步${s.activeSubagentCount ? `/${s.activeSubagentCount}个活跃子代理` : ""})`);

  const capBlock = wb.capabilities
    ? formatCapabilityAwarenessPrompt(wb.capabilities, wb.vibeCoding?.bindings ?? [])
    : "";
  const charterBlock = buildSiliconCharterPrompt({
    surface: "steward_hub",
    activeGoals: wb.ledger.goals.filter((g) => g.status === "active").map((g) => ({ title: g.title, northStarCriterion: g.northStarCriterion })),
    openCommitments: wb.ledger.commitments.filter((c) => c.status === "open" || c.status === "waiting_review").slice(0, 6),
    duoProtectedWindows: wb.duoAnchors?.map((a) => `${a.title}: ${a.detail}`),
    calibratedLessons: wb.mindJournal?.calibratedLessons,
    loyalDissentSignal: wb.loyalDissent ?? null,
  });

  return [
    charterBlock,
    "",
    "你是常驻云端的主权顶层管家与生命幕僚（Sugent），围着主人本人生长；微信与网页端都只是连接你这颗唯一大脑的零折损触手。",
    "表达准则：全程用自然、简练、像真人助理聊天的中文直接回应（说人话）。绝对禁止暴露任何内部实现术语或代号（如 Epoch、T0/T1/T2、L0/L1/L3、superseded、CASCADE_RUN_STATUS、tool_calls、JSON 字段名）。隐私档位统一说“私密（仅本机）/ 脱敏摘要 / 深度协同”。",
    "跨天全渠道记忆铁律：当主人询问“昨天我们聊了什么”、“上次提过的某件事”、“前几天讨论的方案”等历史对话时，必须第一时间调用 recall_chat_history 检索微信与网页端真实历史对话记录，绝不可声称“日常对话不会跨天存留”。",
    "管家统筹与编码触手分工铁律：你的定位是顶层协调者与大管家，不亲自下场硬写业务代码；当主人询问任意项目的最新进展、在运行项目、状态或路线图（如 airtoken、sugent、近期推进的项目）时，务必先调用 manage_ops_fleet(action='overview') 实时拉取看板态势。汇报时必须严格对齐看板语义：只有 runningNowProjects（此刻有会话正在跑）才叫“正在实时运行”，其余按看板分栏（施工中 / 待验收确认 / 门禁观测中 / 待开工 / 静默已折叠）如实区分，严禁把已纳管仓库总数或静默未建档仓库统称为“正在运行”！需要改代码时调用 dispatch_edge_antigravity 派单给对应节点触手执行。",
    "行动准则：遇到查询目标/待办/档案/历史聊天/来信/开发项目、读取完整本地 .md 或报告全文、记录事项、更改目标、处理来信或派发开发任务时，务必先调用对应工具获取真实现场数据或执行状态变更再回答，绝不靠猜或编造结果；工具返回 ok=false 时必须如实告知限制原因，绝不越权伪造成功。",
    ...(capBlock ? ["", capBlock] : []),
    "",
    `当前状况速览（免打扰=${wb.quietHoursActive ? "开启" : "关闭"}，待回复外部来信=${msgCount}条，本机 Antigravity 主会话=${wb.antigravity.totalSessions}个）：`,
    `重点目标(${goals.length}/3)：${goals.length ? goals.join(" | ") : "暂无"}`,
    `未结待办：${commits.length ? commits.join("；") : "暂无"}`,
    `正在运行中的开发任务：${running.length ? running.join(" | ") : "暂无"}`,
    ...(wb.opsFleet?.projects?.length
      ? (() => {
          const allP = wb.opsFleet.projects;
          const activeP = allP.filter((p) => (p.boardStatus ?? "idle_untracked") !== "idle_untracked" && p.stage !== "archived");
          const runCnt = allP.filter((p) => p.status === "running").length;
          const idleCnt = allP.length - activeP.length;
          const laneLabel: Record<string, string> = {
            blocked: "卡点",
            active_executing: "施工中",
            pending_review: "待验收",
            monitoring: "观测中",
            planned_ready: "待开工",
            idle_untracked: "静默",
          };
          return [
            `跨端舰队看板 (/ops，共纳管 ${allP.length} 项：此刻实时运行 ${runCnt} 项，活跃看板 ${activeP.length} 项，静默折叠 ${idleCnt} 项)：${(activeP.length ? activeP : allP)
              .slice(0, 10)
              .map((p) => {
                const goal = p.statusCard?.stageGoal || p.executiveSummary?.goalText || "";
                const landed = p.statusCard?.landed?.[0] || p.executiveSummary?.progressText || p.sanitizedSummary || "";
                const rm = p.roadmapSummary?.activeNode;
                const rmTag = rm?.code ? `[${rm.code}${rm.progress?.total ? ` ${rm.progress.done ?? 0}/${rm.progress.total}` : ""}]` : "";
                const gs = p.gitSync;
                const gsTag = gs?.needsAttention
                  ? `[Git:${[gs.aheadCount ? `未推${gs.aheadCount}` : "", gs.behindCount ? `落后${gs.behindCount}` : "", gs.dirtyCount ? `脏${gs.dirtyCount}` : "", gs.unmergedRemoteBranches?.length ? `待合PR${gs.unmergedRemoteBranches.length}` : ""].filter(Boolean).join("/")}]`
                  : "";
                const lane = p.status === "running" ? "实时运行" : (laneLabel[p.boardStatus ?? ""] || p.boardStatus || p.status || "静默");
                const summary = [lane, rmTag, gsTag, goal, landed].filter(Boolean).join(" · ");
                const nodeTag = (p.nodes?.length ? p.nodes.join(",") : p.nodeId) || "";
                return `${p.displayName || shortProj(p.projectKey)}${nodeTag ? `[${nodeTag}]` : ""}：${summary}`;
              })
              .join(" | ")}`,
          ];
        })()
      : []),
    ...(wb.opsFleet?.pendingInbox?.length
      ? [
          `待签批排期与派单 (/ops)：${wb.opsFleet.pendingInbox
            .slice(0, 5)
            .map((i) => `${i.id}「${i.title}」(${i.targetNodeId || "默认节点"})`)
            .join(" | ")}`,
        ]
      : []),
    ...(wb.groupDigests?.length
      ? [`待拍板项目群纪要(${wb.groupDigests.length}张)：${wb.groupDigests.slice(0, 3).map((d) => `${d.digestId}「${d.groupName}」`).join(" | ")}`]
      : []),
    ...(wb.opsFleet?.publicConciergeQueue?.length
      ? [`官网数字分身待批来客(${wb.opsFleet.publicConciergeQueue.length}位)：${wb.opsFleet.publicConciergeQueue.slice(0, 3).map((v) => `${v.sessionId}「${v.actorLabel || v.actorName || "访客"}」(${v.intentSummary || v.summary || "待审咨询"})`).join(" | ")}`]
      : []),
    `价值红线与墓碑：${guards.length ? guards.join("；") : "暂无"}`,
    `重要联系人：${contacts.length ? contacts.join("；") : "暂无"}`,
  ].join("\n");
}
interface LlmToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: unknown;
}

interface LlmChatResponse {
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: LlmToolCall[] };
  }>;
}

export interface StewardLlmAgentOptions<TWorkbench extends StewardWorkbenchLike = StewardWorkbenchLike> {
  getEndpoint: () => StewardLlmEndpoint | undefined;
  fetchImpl?: typeof fetch;
  toolsPort: StewardLlmToolsPort<TWorkbench>;
  recordUsageUsd?: (usd: number) => void;
  resolveRoutePlan?: (ctx: RoutingRequestContext) => RouteDecisionPlan | undefined;
  estimateCostUsd?: (modelId: string, usage: { inputTokens?: number; outputTokens?: number }) => number;
  onRouteAttemptOutcome?: (ev: {
    decisionId: string;
    targetId: string;
    archetype: TaskArchetype;
    ok: boolean;
    httpStatus?: number | "timeout" | "network";
    ttftMs?: number;
    totalLatencyMs?: number;
    costUsd?: number;
    toolCallCount?: number;
    toolParseErrorCount?: number;
    emptyReply?: boolean;
    escalatedFrom?: string;
    fallbackUsedFrom?: string;
    signalSource: RoutingOutcomeEvent["signalSource"];
  }) => void;
}

export class StewardLlmAgent<TWorkbench extends StewardWorkbenchLike = StewardWorkbenchLike> {
  private turnSeq = 0;
  private pendingDoubleConfirm?: { cardId: string; channel: ConciergeChannelKind; peerDisplayName: string; confirmHash: string; createdTurnSeq: number };

  constructor(private readonly opts: StewardLlmAgentOptions<TWorkbench>) {}

  private async executeTool(name: string, args: Record<string, unknown>, domain: CallerAccessDomain, channel: DropzoneChannel): Promise<Record<string, unknown>> {
    const p = this.opts.toolsPort;
    const part: ContextPartition = domain === "owner_private" ? "personal_life" : domain;

    if (name === "query_personal_memory") {
      const q = String(args.query ?? "");
      const ctx = p.queryLedger(q, domain);
      const archives = p.findArchiveResources(q, domain);
      const kgRaw = domain === "owner_private" ? p.recallKnowledgeSubgraph?.(q) : undefined;
      const kg = Array.isArray(kgRaw) ? kgRaw : kgRaw?.nodes ?? [];
      const kgEdges = Array.isArray(kgRaw) ? [] : kgRaw?.edges ?? [];
      return { ok: true, goals: ctx.goals, commitments: ctx.commitments, guardrails: ctx.guardrails, relationships: ctx.relationships, archives, kg, ...(kgEdges.length > 0 ? { kgEdges } : {}) };
    }
    if (name === "capture_note_or_todo") {
      const text = String(args.text ?? "").trim();
      if (args.kind === "todo") {
        const c = p.mutateCommitment({
          action: "upsert",
          partition: part,
          direction: (args.direction as CommitmentItem["direction"]) ?? "i_owe",
          summary: text,
          counterpartyOrRef: typeof args.counterparty === "string" && args.counterparty ? args.counterparty : "个人跟进",
          ...(typeof args.dueAt === "string" ? { dueAt: args.dueAt } : {}),
          callerDomain: domain,
        });
        return { ok: true, commitment: c.commitment };
      }
      const saved = p.upsertArchiveResource({
        partition: part,
        title: text || "备忘档案",
        ...(typeof args.dueAt === "string" ? { dueAt: args.dueAt } : {}),
        ...(Array.isArray(args.filePaths) ? { filePaths: args.filePaths.map(String) } : {}),
      });
      return { ok: true, archivedCount: saved.length, titles: saved.map((r) => r.title) };
    }
    if (name === "manage_focus_goals") {
      const action = String(args.action ?? "add");
      const active = p.getWorkbench("owner_private").ledger.goals.filter((g) => g.status === "active");
      const target = typeof args.targetGoalQuery === "string" ? matchItem(active, args.targetGoalQuery, (g) => g.title) : undefined;
      if (action === "achieve" || action === "pause") {
        if (!target) return { ok: false, errorCode: "GOAL_NOT_FOUND", activeGoals: active.map((g, i) => ({ index: i + 1, title: g.title })) };
        const res = p.mutateGoal({ action: "status", id: target.id, status: action === "pause" ? "paused" : "achieved", callerDomain: domain });
        return { ok: res.ok, goal: res.goal };
      }
      const title = String(args.title ?? "").trim() || "未命名重点目标";
      const criterion = String(args.northStarCriterion ?? "").trim() || "按期验收通过";
      const partition: ContextPartition = /(健康|父母|家庭|生活|体检|房子)/.test(title) ? "personal_life" : "work_project";
      const res = p.mutateGoal({ action: "upsert", partition, title, northStarCriterion: criterion, ...(target ? { supersedeGoalId: target.id } : {}), callerDomain: domain });
      return res.ok ? { ok: true, goal: res.goal } : { ok: false, errorCode: res.errorCode, activeGoals: (res.activeGoals ?? active).map((g, i) => ({ index: i + 1, title: g.title, criterion: g.northStarCriterion })) };
    }
    if (name === "complete_todo") {
      const open = p
        .getWorkbench("owner_private")
        .ledger.commitments.filter((c) => c.status === "open" || c.status === "snoozed" || c.status === "waiting_review");
      const target = matchItem(open, String(args.todoQuery ?? ""), (c) => `${c.id} ${c.summary} ${c.counterpartyOrRef}`);
      if (!target) return { ok: false, errorCode: "TODO_NOT_FOUND", openTodos: open.map((c, i) => ({ index: i + 1, summary: c.summary })) };
      const res = p.mutateCommitment({ action: "status", id: target.id, status: "closed", callerDomain: domain });
      return {
        ok: true,
        closedSummary: res.commitment.summary,
        ...(res.roadmapItemId ? { roadmapItemId: res.roadmapItemId } : {}),
        ...(res.nextAiHint ? { nextAiHint: res.nextAiHint } : {}),
      };
    }
    if (name === "prepare_offline_errand") {
      const res = await p.submitDropzone({ text: String(args.taskDescription ?? ""), channel, callerDomain: domain, partition: part });
      return { ok: true, outcome: res.outcome };
    }
    return this.executeExternalTool(name, args, domain, channel);
  }
  private async executeExternalTool(name: string, args: Record<string, unknown>, domain: CallerAccessDomain, channel: DropzoneChannel): Promise<Record<string, unknown>> {
    const p = this.opts.toolsPort;
    const wb = p.getWorkbench(domain);

    if (name === "manage_messages") {
      const cg = wb.concierge;
      if (!cg) return { ok: false, errorCode: "CONCIERGE_NOT_AVAILABLE" };
      const act = String(args.action ?? "list");
      if (act === "list") {
        return {
          ok: true,
          pendingCards: cg.cards.map((c) => ({ sender: c.peerDisplayName, channel: c.channel, summary: c.summary, draftA: c.draftA.body, draftB: c.draftB.body })),
          coolingDispatches: cg.pendingDispatches.map((d) => ({ recipient: d.peerDisplayName, remainingSec: Math.ceil(d.remainingMs / 1000) })),
        };
      }
      if (act === "undo_last") {
        const d = cg.pendingDispatches[0];
        if (!d || !p.executeConciergeCommand) return { ok: false, errorCode: "NOTHING_IN_COOLING_WINDOW" };
        await p.executeConciergeCommand(`/undo ${d.dispatchId}`, d.channel);
        return { ok: true, canceledRecipient: d.peerDisplayName };
      }
      if (act === "confirm_pending") {
        const pending = this.pendingDoubleConfirm;
        if (!pending || !p.executeConciergeCommand) return { ok: false, errorCode: "NO_PENDING_DOUBLE_CONFIRM" };
        if (pending.createdTurnSeq >= this.turnSeq) {
          return { ok: false, errorCode: "SAME_TURN_CONFIRM_FORBIDDEN", reason: "涉及金额或正式承诺，必须由主人在下一轮明确回复确认后才能发送" };
        }
        const res = await p.executeConciergeCommand(`/confirm ${pending.cardId} ${pending.confirmHash}`, pending.channel);
        this.pendingDoubleConfirm = undefined;
        return res.status === "cooling_off_scheduled"
          ? { ok: true, recipient: pending.peerDisplayName, coolingWindowSec: Math.round(cg.coolingWindowMs / 1000) }
          : { ok: false, errorCode: res.status, reason: res.reason };
      }
      const card = (typeof args.peerQuery === "string" ? matchItem(cg.cards, args.peerQuery, (c) => c.peerDisplayName) : undefined) ?? (cg.cards.length === 1 ? cg.cards[0] : undefined);
      if (!card || !p.executeConciergeCommand) return { ok: false, errorCode: "MESSAGE_CARD_NOT_FOUND" };
      if (act === "send_preset_a" || act === "send_preset_b") {
        const opt = act === "send_preset_a" ? "A" : "B";
        const draft = opt === "A" ? card.draftA : card.draftB;
        const res = await p.executeConciergeCommand(`/send ${opt} ${card.cardId} ${draft.confirmHash}`, card.channel);
        return res.status === "cooling_off_scheduled" ? { ok: true, recipient: card.peerDisplayName, sentBody: draft.body, coolingWindowSec: Math.round(cg.coolingWindowMs / 1000) } : { ok: false, errorCode: res.status, reason: res.reason };
      }
      const body = String(args.customBody ?? "").trim();
      if (!body) return { ok: false, errorCode: "EMPTY_CUSTOM_BODY" };
      const res = await p.executeConciergeCommand(`/edit ${card.cardId} ${body}`, card.channel);
      if (res.status === "pending_double_confirm" && res.requiredConfirmHash) {
        this.pendingDoubleConfirm = { cardId: card.cardId, channel: card.channel, peerDisplayName: card.peerDisplayName, confirmHash: res.requiredConfirmHash, createdTurnSeq: this.turnSeq };
        return { ok: false, requiresDoubleConfirm: true, recipient: card.peerDisplayName, draftBody: body, reason: "包含金额或正式承诺，请先向主人确认是否发送" };
      }
      return res.status === "cooling_off_scheduled" ? { ok: true, recipient: card.peerDisplayName, sentBody: body, coolingWindowSec: Math.round(cg.coolingWindowMs / 1000) } : { ok: false, errorCode: res.status, reason: res.reason };
    }
    if (name === "manage_antigravity") return this.executeAntigravityTool(args, wb, domain);
    if (name === "manage_vibe_coding") return this.executeVibeCodingTool(args, wb, domain, channel);
    if (name === "read_authorized_file") return this.executeAuthorizedFileTool(args, domain);
    if (name === "manage_model_routing") return this.executeModelRoutingTool(args);
    if (name === "manage_hot_update") return this.executeHotUpdateTool(args);
    if (name === "delegate_local_execution") return this.executeLocalDelegationTool(args, channel);
    if (name === "manage_ops_fleet") return this.executeOpsFleetTool(args, wb, domain);
    if (name === "recall_chat_history") return this.executeRecallChatHistoryTool(args, domain);
    if (name === "dispatch_edge_antigravity") return this.executeDispatchEdgeAntigravityTool(args, domain);
    if (name === "analyze_forwarded_chat") return this.executeAnalyzeForwardedChatTool(args, domain);
    if (name === "manage_wechat_envoy") return this.executeManageWeChatEnvoyTool(args, domain);
    if (name === "manage_airtoken_ops") return this.executeManageAirTokenOpsTool(args, domain);
    return this.executePrefsTool(args, wb, domain);
  }

  private async executeModelRoutingTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.opts.toolsPort;
    const act = String(args.action ?? "status");
    if (act === "sync" && p.syncModelPool) {
      return { ok: true, results: await p.syncModelPool({ force: true }), dashboard: p.getRoutingDashboard?.() };
    }
    if (act === "set_policy" && p.updateRoutingPolicy) {
      return {
        ok: true,
        ...p.updateRoutingPolicy({
          ...(typeof args.strategy === "string" ? { strategy: args.strategy as RoutingStrategyPreset } : {}),
          ...(typeof args.mode === "string" ? { mode: args.mode as RoutingOperatingMode } : {}),
          ...(args.pinnedModel === null ? { pinnedModel: null } : typeof args.pinnedModel === "string" ? { pinnedModel: args.pinnedModel } : {}),
          ...(typeof args.directive === "string" ? { directive: args.directive } : {}),
        }),
      };
    }
    return p.getRoutingDashboard ? { ok: true, dashboard: p.getRoutingDashboard() } : { ok: false, errorCode: "ROUTING_UNAVAILABLE" };
  }

  private executeAuthorizedFileTool(args: Record<string, unknown>, domain: CallerAccessDomain): Record<string, unknown> {
    const p = this.opts.toolsPort;
    const act = String(args.action ?? (args.filePath || args.query ? "read" : "search"));
    if (act === "search") {
      if (!p.searchAuthorizedFiles) return { ok: false, errorCode: "FILE_SEARCH_UNAVAILABLE" };
      const matches = p.searchAuthorizedFiles({
        ...(typeof args.query === "string" ? { query: args.query } : {}),
        ...(typeof args.projectQuery === "string" ? { projectQuery: args.projectQuery } : {}),
        ...(typeof args.conversationId === "string" ? { conversationId: args.conversationId } : {}),
        callerDomain: domain,
      });
      return { ok: true, count: matches.length, matches };
    }
    if (!p.readAuthorizedFile) return { ok: false, errorCode: "FILE_READ_UNAVAILABLE" };
    return p.readAuthorizedFile({
      ...(typeof args.filePath === "string" ? { filePath: args.filePath } : {}),
      ...(typeof args.query === "string" ? { fileQuery: args.query } : {}),
      ...(typeof args.projectQuery === "string" ? { projectQuery: args.projectQuery } : {}),
      ...(typeof args.conversationId === "string" ? { conversationId: args.conversationId } : {}),
      ...(typeof args.offsetChars === "number" ? { offsetChars: args.offsetChars } : {}),
      ...(typeof args.maxChars === "number" ? { maxChars: args.maxChars } : {}),
      callerDomain: domain,
    });
  }

  private async executeVibeCodingTool(
    args: Record<string, unknown>,
    wb: TWorkbench,
    domain: CallerAccessDomain,
    channel: DropzoneChannel,
  ): Promise<Record<string, unknown>> {
    const p = this.opts.toolsPort;
    const act = String(args.action ?? "status");
    if (act === "status") {
      return { ok: true, bindings: wb.vibeCoding?.bindings ?? [], pipelines: wb.vibeCoding?.pipelines ?? [] };
    }
    if (act === "bind_self" && p.bindSelfRepo) {
      const res = p.bindSelfRepo({}, domain);
      return { ok: true, binding: res.binding };
    }
    if (act === "bind_repo" && p.upsertRepoBinding) {
      const repoRoot = String(args.repoRoot ?? "").trim();
      const alias = String(args.repoAlias ?? "").trim() || repoRoot.split(/[/\\]/).filter(Boolean).pop() || "本地仓库";
      const res = p.upsertRepoBinding({ alias, repoRoot }, domain);
      return { ok: true, binding: res.binding };
    }
    if (act === "start_task" && p.startVibeTask) {
      const vibeChannel: VibeIngressChannel = channel === "weixin" || channel === "feishu" ? channel : "sugent_app";
      const res = await p.startVibeTask({
        text: String(args.requirementText ?? "").trim(),
        ...(typeof args.repoAlias === "string" ? { bindingQuery: args.repoAlias } : {}),
        channel: vibeChannel,
        ...(Array.isArray(args.filePaths) ? { filePaths: args.filePaths.map(String) } : {}),
        callerDomain: domain,
      });
      return { ok: res.ok, message: res.message, ...(res.pipeline ? { pipeline: res.pipeline } : {}) };
    }
    if (act === "decide_task" && p.decideVibeTask) {
      const res = await p.decideVibeTask({
        ...(typeof args.pipelineId === "string" ? { pipelineId: args.pipelineId } : {}),
        ...(typeof args.decision === "string" ? { action: args.decision as "approve" | "revise" | "cancel" | "verify_now" | "relaunch_now" } : {}),
        ...(typeof args.feedback === "string" ? { feedback: args.feedback } : {}),
        callerDomain: domain,
      });
      return { ok: res.ok, message: res.message, ...(res.pipeline ? { pipeline: res.pipeline } : {}) };
    }
    return { ok: false, errorCode: "VIBE_TOOL_UNAVAILABLE" };
  }
  private async executeAntigravityTool(args: Record<string, unknown>, wb: TWorkbench, domain: CallerAccessDomain): Promise<Record<string, unknown>> {
    const p = this.opts.toolsPort;
    const act = String(args.action ?? "overview");
    const q = String(args.projectOrSessionQuery ?? "").trim();
    const projDisplay = (pr: TWorkbench["antigravity"]["projects"][number]) => pr.displayName || shortProj(pr.projectKey);
    const projSearch = (pr: TWorkbench["antigravity"]["projects"][number]) => [projDisplay(pr), ...(pr.aliases ?? []), shortProj(pr.projectKey), pr.projectKey, pr.title].filter(Boolean).join(" ");
    const sessRunState = (s: TWorkbench["antigravity"]["sessions"][number]) =>
      s.isRunning ? "running" : s.hasError ? "error" : s.supersededReasons?.some((r) => r === "user_viewed_in_ide" || r === "external_watermark") ? "viewed" : "idle";

    if (act === "overview") {
      const runningSessions = wb.antigravity.sessions
        .filter((s) => s.isRunning)
        .slice(0, 8)
        .map((s) => ({ projectName: s.projectDisplayName || shortProj(s.projectKey), conversationId: s.conversationId, title: s.title, stepCount: s.stepCount ?? 0, activeSubagents: s.activeSubagentCount ?? 0 }));
      return {
        ok: true,
        totalRootSessions: wb.antigravity.totalSessions,
        foldedSubagents: wb.antigravity.totalSubagentsFolded,
        runningSessions,
        projects: wb.antigravity.projects.slice(0, 10).map((pr) => ({ name: projDisplay(pr), aliases: pr.aliases ?? [], runningSessions: pr.runningSessionCount ?? 0, totalSessions: pr.sessionCount, privacy: tierLabel(pr.policy.tier) })),
        recentSessions: wb.antigravity.sessions.slice(0, 8).map((s) => ({ conversationId: s.conversationId, projectName: s.projectDisplayName || shortProj(s.projectKey), title: s.title, runState: sessRunState(s), stepCount: s.stepCount ?? 0, activeSubagents: s.activeSubagentCount ?? 0 })),
      };
    }
    if (act === "set_privacy") {
      const proj = matchItem(wb.antigravity.projects, q, projSearch);
      if (!proj) return { ok: false, errorCode: "PROJECT_NOT_FOUND" };
      const lvl = args.privacyLevel === "private" ? 0 : args.privacyLevel === "collab" ? 2 : 1;
      p.setProjectTier({ projectKey: proj.projectKey, tier: lvl, callerDomain: domain });
      return { ok: true, projectName: projDisplay(proj), privacy: tierLabel(lvl) };
    }
    if (act === "new_session") {
      const prompt = String(args.messageOrPrompt ?? q).trim();
      if (!prompt) return { ok: false, errorCode: "EMPTY_PROMPT" };
      const out = await p.dispatchAntigravity({ mode: "new", prompt, ...(typeof args.title === "string" ? { title: args.title } : {}) });
      return { ...out };
    }
    const matchedProj = q ? matchItem(wb.antigravity.projects, q, projSearch) : undefined;
    const sessSearch = (s: TWorkbench["antigravity"]["sessions"][number]) => `${s.projectDisplayName ?? ""} ${s.title} ${shortProj(s.projectKey)} ${s.projectKey} ${s.conversationId}`;
    const sess =
      (matchedProj ? wb.antigravity.sessions.find((s) => s.projectKey === matchedProj.projectKey) : undefined) ??
      matchItem(wb.antigravity.sessions, q, sessSearch) ??
      wb.antigravity.sessions[0];
    if (!sess) return { ok: false, errorCode: "SESSION_NOT_FOUND" };
    if (act === "mark_viewed") {
      p.markSessionViewed({ conversationId: sess.conversationId, callerDomain: domain });
      return { ok: true, conversationId: sess.conversationId, title: sess.title };
    }
    if (act === "comprehend_session") {
      const res = await p.comprehendSession({ conversationId: sess.conversationId, projectKey: sess.projectKey, title: sess.title, callerDomain: domain });
      if (!res.allowed) return { ok: false, reason: res.reason, privacy: tierLabel(res.tier) };
      return { ok: true, projectName: res.projectDisplayName, conversationId: res.conversationId, sessionTitle: sess.title, runState: res.runState, livePulse: res.livePulse, artifactsFound: res.artifactsFound, ...(res.artifactFilePaths?.length ? { artifactFilePaths: res.artifactFilePaths } : {}), summaryCard: res.threeLineCard, excerpt: res.artifactExcerpt, requiresApproval: res.requiresApproval };
    }
    const msg = String(args.messageOrPrompt ?? "").trim();
    if (!msg) return { ok: false, errorCode: "EMPTY_MESSAGE" };
    const out = await p.dispatchAntigravity({ mode: "resume", conversationId: sess.conversationId, prompt: msg, ...(typeof args.title === "string" ? { title: args.title } : {}) });
    return { ...out };
  }

  private executePrefsTool(args: Record<string, unknown>, wb: TWorkbench, domain: CallerAccessDomain): Record<string, unknown> {
    const p = this.opts.toolsPort;
    const act = String(args.action ?? "get_briefing");
    if (act === "set_quiet_hours") {
      const next = p.setQuietHours(Boolean(args.quietHours), domain);
      return { ok: true, quietHoursActive: next.quietHoursActive };
    }
    if (act === "set_trust_mode") {
      const rel = wb.ledger.relationships.find((r) => r.subjectType === "owner_trust") ?? wb.ledger.relationships[0];
      if (!rel) return { ok: false, errorCode: "NO_OWNER_TRUST_PROFILE" };
      if (args.trustMode === "record_only" || args.trustMode === "whisper") {
        const res = p.mutateTrust({ id: rel.id, action: "downgrade", targetTier: args.trustMode === "record_only" ? "L0_record_only" : "L1_whisper_prompt", callerDomain: domain });
        return { ok: res.ok, trustMode: args.trustMode };
      }
      const res = p.mutateTrust({ id: rel.id, action: "promote_l3", ownerConfirmed: true, callerDomain: domain });
      return res.ok ? { ok: true, trustMode: "autonomous" } : { ok: false, errorCode: res.errorCode, verifiedObservations: rel.verifiedObservations, requiredObservations: 3 };
    }
    const scan = p.scanCadence({ quietHoursActive: false, calibrationDue: true, callerDomain: domain });
    return { ok: true, urgentItems: scan.emitNow.filter((c) => c.urgency === "urgent"), routineItems: scan.emitNow.filter((c) => c.urgency !== "urgent"), queuedMorningItems: scan.workbench.cadence.state.morningDigestQueue };
  }

  private async executeHotUpdateTool(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const fn = this.opts.toolsPort.manageHotUpdate;
    if (!fn) return { ok: false, error: "HOT_UPDATE_UNAVAILABLE" };
    const action = String(args.action ?? "status") as "status" | "reload_ui" | "reload_core" | "rollback" | "factory_reset";
    return fn({
      action,
      ...(typeof args.file === "string" ? { file: args.file } : {}),
      ...(typeof args.reason === "string" ? { reason: args.reason } : {}),
    });
  }

  private async executeLocalDelegationTool(args: Record<string, unknown>, channel: DropzoneChannel): Promise<Record<string, unknown>> {
    const fn = this.opts.toolsPort.delegateLocalTask;
    if (!fn) return { ok: false, errorCode: "LOCAL_TASK_DELEGATION_UNAVAILABLE" };
    const title = String(args.title ?? "").trim();
    const instruction = String(args.instruction ?? "").trim();
    if (!title || !instruction) return { ok: false, errorCode: "INVALID_DELEGATION_ARGS" };
    const res = await fn({
      title,
      instruction,
      ...(typeof args.requireDesktopGui === "boolean" ? { requireDesktopGui: args.requireDesktopGui } : {}),
      ...(typeof args.workspacePath === "string" && args.workspacePath.trim() ? { workspacePath: args.workspacePath.trim() } : {}),
      channel,
    });
    return { ...res };
  }

  private async executeOpsFleetTool(
    args: Record<string, unknown>,
    wb: TWorkbench,
    domain: CallerAccessDomain,
  ): Promise<Record<string, unknown>> {
    const act = String(args.action ?? "overview");
    if (act === "read_doc") {
      if (domain !== "owner_private") {
        return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "跨节点读取项目治理文档仅限主理人私域调用" };
      }
      const fn = this.opts.toolsPort.readProjectGovernanceDoc;
      if (!fn) return { ok: false, errorCode: "READ_DOC_UNAVAILABLE" };
      const projectQuery = String(args.projectQuery ?? "").trim();
      if (!projectQuery) return { ok: false, errorCode: "MISSING_PROJECT_QUERY" };
      return fn({
        projectQuery,
        ...(typeof args.docPath === "string" && args.docPath.trim() ? { docPath: args.docPath.trim() } : {}),
        callerDomain: domain,
      });
    }
    if (act === "overview") {
      const refreshed = await this.opts.toolsPort.refreshOpsFleet?.();
      const fleet = refreshed?.snapshot ?? wb.opsFleet;
      const allProjects = fleet?.projects ?? [];
      const q = String(args.projectQuery ?? "").trim().toLowerCase();
      const laneLabel: Record<string, string> = {
        blocked: "卡点/待拍板",
        active_executing: "施工中",
        pending_review: "待验收确认",
        monitoring: "常驻/门禁观测",
        planned_ready: "排期就绪/待开工",
        idle_untracked: "静默/未建档",
      };
      const toProjectView = (pr: (typeof allProjects)[number]) => ({
        projectKey: pr.projectKey,
        displayName: pr.displayName || shortProj(pr.projectKey),
        nodes: pr.nodes ?? (pr.nodeId ? [pr.nodeId] : []),
        isRunningNow: pr.status === "running",
        boardStatus: pr.boardStatus || pr.status || "idle_untracked",
        boardStatusLabel: laneLabel[pr.boardStatus ?? ""] || pr.boardStatus || pr.status || "静默",
        boardStatusReason: pr.boardStatusReason,
        stage: pr.stage,
        lastActiveAt: pr.lastActiveAt || pr.updatedAtIso,
        statusCard: pr.statusCard,
        roadmapSummary: pr.roadmapSummary,
        ...(pr.tasksSummary ? { tasksSummary: pr.tasksSummary } : {}),
        ...(pr.gitSync ? { gitSync: pr.gitSync } : {}),
        ...(pr.recentPlans?.length ? { recentPlans: pr.recentPlans } : {}),
        executiveSummary: pr.executiveSummary,
      });
      const runningNowList = allProjects.filter((pr) => pr.status === "running");
      const activeBoardList = allProjects.filter(
        (pr) => pr.status === "running" || ((pr.boardStatus ?? "idle_untracked") !== "idle_untracked" && pr.stage !== "archived"),
      );
      const counts = {
        totalManaged: allProjects.length,
        runningNow: runningNowList.length,
        activeExecuting: allProjects.filter((pr) => pr.boardStatus === "active_executing").length,
        blocked: allProjects.filter((pr) => pr.boardStatus === "blocked").length,
        pendingReview: allProjects.filter((pr) => pr.boardStatus === "pending_review").length,
        monitoring: allProjects.filter((pr) => pr.boardStatus === "monitoring").length,
        plannedReady: allProjects.filter((pr) => pr.boardStatus === "planned_ready").length,
        idleUntracked: allProjects.filter((pr) => (pr.boardStatus ?? "idle_untracked") === "idle_untracked" || pr.stage === "archived").length,
        focusCount: allProjects.filter((pr) => pr.stage === "focus").length,
      };
      const matched = q
        ? allProjects.filter((pr) => {
            const hay = `${pr.displayName ?? ""} ${shortProj(pr.projectKey)} ${pr.projectKey}`.toLowerCase();
            return hay.includes(q) || q.includes(shortProj(pr.projectKey).toLowerCase());
          })
        : activeBoardList;
      const sourceForView = q ? matched : (activeBoardList.length > 0 ? activeBoardList : allProjects.slice(0, 8));
      const list = sourceForView.slice(0, q ? 8 : 20).map(toProjectView);
      return {
        ok: true,
        opsBridgeConfigured: refreshed ? refreshed.configured : Boolean(fleet),
        ...(refreshed && !refreshed.ok && refreshed.reason ? { refreshWarning: refreshed.reason } : {}),
        counts,
        matchedCount: q ? matched.length : activeBoardList.length,
        totalProjects: allProjects.length,
        runningNowProjects: runningNowList.slice(0, 12).map(toProjectView),
        projects: list,
        idleFoldedCount: counts.idleUntracked,
        reportingNote: "仅 runningNowProjects 代表此刻有会话正在实时运行；其余请按 boardStatusLabel（施工中/待验收确认/常驻门禁观测/待开工）汇报，切勿将静默折叠项目说成正在运行。",
        pendingInbox: fleet?.pendingInbox ?? [],
        weeklyFocus: fleet?.weeklyFocus ?? [],
      };
    }
    const fn = this.opts.toolsPort.proposeOpsInbox;
    if (!fn) return { ok: false, errorCode: "OPS_FLEET_PROPOSE_UNAVAILABLE" };
    const title = String(args.title ?? "").trim();
    if (!title) return { ok: false, errorCode: "MISSING_PROPOSAL_TITLE" };
    return fn({
      title,
      ...(typeof args.summary === "string" && args.summary.trim() ? { summary: args.summary.trim() } : {}),
      ...(typeof args.targetNodeId === "string" && args.targetNodeId.trim() ? { targetNodeId: args.targetNodeId.trim() } : {}),
      ...(typeof args.commandAction === "string" && args.commandAction.trim() ? { commandAction: args.commandAction.trim() } : {}),
      ...(typeof args.projectKey === "string" && args.projectKey.trim() ? { projectKey: args.projectKey.trim() } : {}),
      ...(typeof args.requiresDashboardConfirm === "boolean" ? { requiresDashboardConfirm: args.requiresDashboardConfirm } : {}),
      ...(Array.isArray(args.weeklyFocus) ? { weeklyFocus: args.weeklyFocus.map(String) } : {}),
    });
  }

  private executeRecallChatHistoryTool(args: Record<string, unknown>, domain: CallerAccessDomain): Record<string, unknown> {
    if (domain !== "owner_private") {
      return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "跨渠道历史对话记录仅对主理人私域开放" };
    }
    const fn = this.opts.toolsPort.recallChatHistory;
    if (!fn) return { ok: false, errorCode: "CHAT_RECALL_UNAVAILABLE" };
    const res = fn({
      ...(typeof args.query === "string" ? { query: args.query } : {}),
      ...(typeof args.daysBack === "number" && Number.isFinite(args.daysBack) ? { daysBack: args.daysBack } : {}),
      ...(typeof args.channel === "string" ? { channel: args.channel as RecallChatHistoryInput["channel"] } : {}),
      ...(typeof args.limit === "number" && Number.isFinite(args.limit) ? { limit: args.limit } : {}),
      ownerOnly: true,
    });
    return { ...res };
  }

  private async executeDispatchEdgeAntigravityTool(args: Record<string, unknown>, domain: CallerAccessDomain): Promise<Record<string, unknown>> {
    if (domain !== "owner_private") {
      return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "跨节点编码派单仅限主理人私域调用" };
    }
    const fn = this.opts.toolsPort.dispatchEdgeAntigravity;
    if (!fn) return { ok: false, errorCode: "EDGE_DISPATCH_UNAVAILABLE" };
    const title = String(args.title ?? "").trim();
    const prompt = String(args.prompt ?? "").trim();
    if (!title || !prompt) return { ok: false, errorCode: "MISSING_TITLE_OR_PROMPT" };
    const out = await fn({
      ...(typeof args.targetNodeId === "string" && args.targetNodeId.trim() ? { targetNodeId: args.targetNodeId.trim() } : {}),
      mode: args.mode === "resume" ? "resume" : "new",
      title,
      prompt,
      ...(typeof args.projectQuery === "string" && args.projectQuery.trim() ? { projectQuery: args.projectQuery.trim() } : {}),
      ...(typeof args.conversationId === "string" && args.conversationId.trim() ? { conversationId: args.conversationId.trim() } : {}),
      ...(typeof args.workspaceHint === "string" && args.workspaceHint.trim() ? { workspaceHint: args.workspaceHint.trim() } : {}),
    });
    return { ...out };
  }

  private executeAnalyzeForwardedChatTool(args: Record<string, unknown>, domain: CallerAccessDomain): Record<string, unknown> {
    if (domain !== "owner_private") {
      return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "五维红线简报与转发归档仅对主理人私域开放" };
    }
    const fn = this.opts.toolsPort.analyzeForwardedChat;
    if (!fn) return { ok: false, errorCode: "FORWARDED_BRIEFING_UNAVAILABLE" };
    const rawForwardedText = String(args.rawForwardedText ?? "").trim();
    if (!rawForwardedText) return { ok: false, errorCode: "EMPTY_FORWARDED_TEXT" };
    const res = fn({
      rawForwardedText,
      ...(typeof args.ownerName === "string" && args.ownerName.trim() ? { ownerName: args.ownerName.trim() } : {}),
      ...(typeof args.autoRecordToLedger === "boolean" ? { autoRecordToLedger: args.autoRecordToLedger } : {}),
    });
    return { ok: true, ...(res as Record<string, unknown>) };
  }

  private async executeManageWeChatEnvoyTool(args: Record<string, unknown>, domain: CallerAccessDomain): Promise<Record<string, unknown>> {
    if (domain !== "owner_private") {
      return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "助理微信号与项目群纪要管理仅对主理人私域开放" };
    }
    const fn = this.opts.toolsPort.manageWeChatEnvoy;
    if (!fn) return { ok: false, errorCode: "WECHAT_ENVOY_UNAVAILABLE" };
    const action = String(args.action ?? "status") as Parameters<NonNullable<StewardLlmToolsPort["manageWeChatEnvoy"]>>[0]["action"];
    return fn({
      action,
      ...(typeof args.groupId === "string" ? { groupId: args.groupId } : {}),
      ...(typeof args.groupName === "string" ? { groupName: args.groupName } : {}),
      ...(typeof args.projectKey === "string" ? { projectKey: args.projectKey } : {}),
      ...(typeof args.digestId === "string" ? { digestId: args.digestId } : {}),
      ...(typeof args.addGroupId === "string" ? { addGroupId: args.addGroupId } : {}),
      ...(typeof args.removeGroupId === "string" ? { removeGroupId: args.removeGroupId } : {}),
      ...(typeof args.addDmPeerId === "string" ? { addDmPeerId: args.addDmPeerId } : {}),
      ...(typeof args.removeDmPeerId === "string" ? { removeDmPeerId: args.removeDmPeerId } : {}),
      ...(typeof args.sessionId === "string" ? { sessionId: args.sessionId } : {}),
      ...(typeof args.publicAction === "string" ? { publicAction: args.publicAction as "approve_reply" | "unlock" | "merge" | "decline" | "block" } : {}),
      ...(typeof args.ownerReply === "string" ? { ownerReply: args.ownerReply } : {}),
    });
  }

  private async executeManageAirTokenOpsTool(args: Record<string, unknown>, domain: CallerAccessDomain): Promise<Record<string, unknown>> {
    if (domain !== "owner_private") {
      return { ok: false, errorCode: "OWNER_ONLY_TOOL", reason: "AirToken 实盘与金库运维工具仅对主理人私域开放" };
    }
    const fn = this.opts.toolsPort.manageAirTokenOps;
    if (!fn) return { ok: false, errorCode: "AIRTOKEN_OPS_UNAVAILABLE" };
    const action = String(args.action ?? "status") as AirTokenOpsToolInput["action"];
    return fn({
      action,
      ...(typeof args.preset === "string" ? { preset: args.preset as AirTokenOpsToolInput["preset"] } : {}),
      ...(typeof args.targetMode === "string" ? { targetMode: args.targetMode as AirTokenOpsToolInput["targetMode"] } : {}),
      ...(typeof args.burnDust === "boolean" ? { burnDust: args.burnDust } : {}),
      ...(typeof args.dryRun === "boolean" ? { dryRun: args.dryRun } : {}),
      ...(typeof args.maintenanceAction === "string" ? { maintenanceAction: args.maintenanceAction as AirTokenOpsToolInput["maintenanceAction"] } : {}),
    });
  }

  private async invokeChat(ep: ResolvedRouteEndpoint, messages: Array<Record<string, unknown>>) {
    const fetchFn = this.opts.fetchImpl ?? fetch;
    const t0 = Date.now();
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Sugent/0.1" };
      if (ep.apiKey) headers.Authorization = `Bearer ${ep.apiKey}`;
      const res = await fetchFn(`${ep.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: ep.rawModelId, messages, tools: LLM_TOOLS }),
        signal: AbortSignal.timeout(75_000),
      });
      const latencyMs = Math.max(1, Date.now() - t0);
      if (!res.ok) {
        const tail = (await res.text().catch(() => "")).slice(0, 200);
        return { ok: false as const, status: res.status, latencyMs, err: `HTTP ${res.status}: ${tail}` };
      }
      const data = (await res.json()) as LlmChatResponse;
      return { ok: true as const, data, latencyMs };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, status: /abort|timeout/i.test(msg) ? ("timeout" as const) : ("network" as const), latencyMs: Math.max(1, Date.now() - t0), err: msg };
    }
  }

  private accountUsage(modelId: string, usage?: { prompt_tokens?: number; completion_tokens?: number }): number {
    if (!usage) return 0;
    const usd =
      this.opts.estimateCostUsd?.(modelId, { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }) ??
      (((usage.prompt_tokens ?? 0) * 3 + (usage.completion_tokens ?? 0) * 15) / 1_000_000);
    if (usd > 0) {
      this.opts.recordUsageUsd?.(usd);
      return usd;
    }
    return 0;
  }

  private async dispatchToolCalls(
    assistantContent: string | null | undefined,
    calls: LlmToolCall[],
    messages: Array<Record<string, unknown>>,
    toolCallsExecuted: string[],
    domain: CallerAccessDomain,
    channel: DropzoneChannel,
  ): Promise<void> {
    // Preserve msg.tool_calls verbatim (including extra_content.google.thought_signature) for Gemini 4 multi-turn tool loops.
    messages.push({ role: "assistant", content: assistantContent ?? null, tool_calls: calls });
    for (const tc of calls) {
      const fn = String(tc.function?.name ?? "");
      toolCallsExecuted.push(fn);
      let parsedArgs: Record<string, unknown> = {};
      try { parsedArgs = JSON.parse(String(tc.function?.arguments ?? "{}")) as Record<string, unknown>; } catch { parsedArgs = {}; }
      const toolOut = await this.executeTool(fn, parsedArgs, domain, channel);
      messages.push({ role: "tool", tool_call_id: tc.id, name: fn, content: JSON.stringify(toolOut) });
    }
  }

  private buildRouteMeta(plan: RouteDecisionPlan, ep: ResolvedRouteEndpoint, fallbackFrom?: string, escalatedFrom?: string): StewardRouteMeta {
    return {
      decisionId: plan.decisionId, archetype: plan.archetype, selectedModel: ep.rawModelId, targetId: ep.targetId,
      providerId: ep.providerId, strategy: plan.strategy, mode: plan.mode, reasonSummary: plan.reasonSummary,
      ...(fallbackFrom ? { fallbackFrom } : {}), ...(escalatedFrom ? { escalatedFrom } : {}),
      skippedCoolingModels: plan.skippedCoolingModels, canRetryStronger: Boolean(plan.escalationTarget),
    };
  }

  private resolveTurnPlan(input: { text: string; historyChars: number; systemPromptChars: number; hasImages?: boolean; excludeTargetIds?: string[]; forceMinTier?: ModelTier }): RouteDecisionPlan | undefined {
    const routed = this.opts.resolveRoutePlan?.({
      role: "steward",
      text: input.text,
      historyChars: input.historyChars,
      systemPromptChars: input.systemPromptChars,
      hasImages: input.hasImages,
      hasTools: true,
      excludeTargetIds: input.excludeTargetIds,
      forceMinTier: input.forceMinTier,
    });
    if (routed) return routed;
    const legacy = this.opts.getEndpoint();
    if (!legacy?.baseUrl || !legacy.apiKey) return undefined;
    return {
      decisionId: `rt-leg-${this.turnSeq}`,
      archetype: "tool_orchestration",
      classification: { archetype: "tool_orchestration", confidence: 1, estimatedInputTokens: 1000, signals: [] },
      mode: "auto",
      strategy: "balanced",
      primary: { targetId: `default/${legacy.model}`, providerId: "default", rawModelId: legacy.model, baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, tier: "balanced", family: "other", thoughtSignatureRequired: false },
      infraFallbacks: [],
      reasonSummary: `固定模型 ${legacy.model}`,
      skippedCoolingModels: [],
      scoredCandidates: [],
    };
  }
  async runTurn(input: {
    text: string;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    callerDomain?: CallerAccessDomain;
    channel?: DropzoneChannel;
    excludeTargetIds?: string[];
    forceMinTier?: ModelTier;
    hasImages?: boolean;
  }): Promise<{ ok: true; reply: string; modelUsed: string; toolCallsExecuted: string[]; routeMeta?: StewardRouteMeta; workbench: TWorkbench } | { ok: false; fallbackReason: string }> {
    this.turnSeq += 1;
    const domain: CallerAccessDomain = input.callerDomain ?? "owner_private";
    const channel: DropzoneChannel = input.channel ?? "web_ui";
    const wb = this.opts.toolsPort.getWorkbench(domain);
    const sysPrompt = buildSystemPrompt(wb);
    const histMsgs = (input.history ?? []).slice(-10).map((m) => ({ role: m.role, content: m.content }));
    const plan = this.resolveTurnPlan({ text: input.text, historyChars: histMsgs.reduce((s, m) => s + m.content.length, 0), systemPromptChars: sysPrompt.length, hasImages: input.hasImages, excludeTargetIds: input.excludeTargetIds, forceMinTier: input.forceMinTier });
    if (!plan) return { ok: false, fallbackReason: "no_endpoint" };

    const turnStartMs = Date.now();
    const knownTools = new Set(LLM_TOOLS.map((t) => t.function.name));
    const messages: Array<Record<string, unknown>> = [{ role: "system", content: sysPrompt }, ...histMsgs, { role: "user", content: input.text }];
    const toolCallsExecuted: string[] = [];
    const tryQueue = [plan.primary, ...plan.infraFallbacks];
    const triedTargets = new Set<string>();
    let lockedEp: ResolvedRouteEndpoint | undefined, round0LatencyMs = 1, totalCostUsd = 0, toolParseErrors = 0;
    let fallbackFrom: string | undefined, escalatedFrom: string | undefined, escalationTried = false, lastErr = "no_endpoint";

    for (let qi = 0; qi < tryQueue.length; qi++) {
      const cand = tryQueue[qi]!;
      if (triedTargets.has(cand.targetId)) continue;
      triedTargets.add(cand.targetId);
      const res = await this.invokeChat(cand, messages);
      if (!res.ok) {
        lastErr = res.err;
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: false, httpStatus: res.status, signalSource: "infra_fallback" });
        fallbackFrom ??= cand.rawModelId;
        continue;
      }
      const msg = res.data.choices?.[0]?.message;
      const calls = msg?.tool_calls;
      let badTool = false;
      if (calls?.length) {
        for (const tc of calls) {
          if (!knownTools.has(String(tc.function?.name ?? ""))) { badTool = true; toolParseErrors += 1; }
          try { JSON.parse(String(tc.function?.arguments ?? "{}")); } catch { badTool = true; toolParseErrors += 1; }
        }
      }
      const emptyText = !calls?.length && !String(msg?.content ?? "").trim();
      if (!msg || emptyText || badTool) {
        lastErr = !msg ? "empty_choice" : emptyText ? "empty_reply" : "malformed_tool_call";
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: false, emptyReply: !msg || emptyText, toolParseErrorCount: badTool ? toolParseErrors : 0, signalSource: "quality_escalation" });
        if (!escalationTried && plan.escalationTarget && !triedTargets.has(plan.escalationTarget.targetId)) {
          escalationTried = true; escalatedFrom = cand.rawModelId; tryQueue.splice(qi + 1, 0, plan.escalationTarget);
        }
        continue;
      }
      totalCostUsd += this.accountUsage(res.data.model || cand.rawModelId, res.data.usage);
      lockedEp = cand; round0LatencyMs = res.latencyMs;
      if (!calls?.length) {
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: cand.targetId, archetype: plan.archetype, ok: true, ttftMs: res.latencyMs, totalLatencyMs: Math.max(1, Date.now() - turnStartMs), costUsd: totalCostUsd, toolCallCount: 0, escalatedFrom, fallbackUsedFrom: fallbackFrom, signalSource: "turn_complete" });
        return { ok: true, reply: String(msg.content ?? "").trim(), modelUsed: res.data.model || cand.rawModelId, toolCallsExecuted, routeMeta: this.buildRouteMeta(plan, cand, fallbackFrom, escalatedFrom), workbench: this.opts.toolsPort.getWorkbench(domain) };
      }
      await this.dispatchToolCalls(msg.content, calls, messages, toolCallsExecuted, domain, channel);
      break;
    }
    if (!lockedEp) return { ok: false, fallbackReason: lastErr };
    return this.runLockedToolRounds(plan, lockedEp, messages, toolCallsExecuted, domain, channel, turnStartMs, round0LatencyMs, totalCostUsd, fallbackFrom, escalatedFrom);
  }

  private async runLockedToolRounds(
    plan: RouteDecisionPlan,
    lockedEp: ResolvedRouteEndpoint,
    messages: Array<Record<string, unknown>>,
    toolCallsExecuted: string[],
    domain: CallerAccessDomain,
    channel: DropzoneChannel,
    turnStartMs: number,
    round0LatencyMs: number,
    initialCostUsd: number,
    fallbackFrom?: string,
    escalatedFrom?: string,
  ): Promise<{ ok: true; reply: string; modelUsed: string; toolCallsExecuted: string[]; routeMeta?: StewardRouteMeta; workbench: TWorkbench } | { ok: false; fallbackReason: string }> {
    let totalCostUsd = initialCostUsd;
    for (let round = 1; round < 5; round++) {
      // Intra-turn stickiness: never switch model mid-tool-loop so Gemini 4 thought_signature stays valid.
      const res = await this.invokeChat(lockedEp, messages);
      if (!res.ok) {
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: lockedEp.targetId, archetype: plan.archetype, ok: false, httpStatus: res.status, signalSource: "infra_fallback" });
        return { ok: false, fallbackReason: res.err };
      }
      totalCostUsd += this.accountUsage(res.data.model || lockedEp.rawModelId, res.data.usage);
      const msg = res.data.choices?.[0]?.message;
      if (!msg) {
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: lockedEp.targetId, archetype: plan.archetype, ok: false, emptyReply: true, signalSource: "quality_escalation" });
        return { ok: false, fallbackReason: "empty_choice" };
      }
      if (!msg.tool_calls?.length) {
        const reply = String(msg.content ?? "").trim();
        if (!reply) {
          this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: lockedEp.targetId, archetype: plan.archetype, ok: false, emptyReply: true, signalSource: "quality_escalation" });
          return { ok: false, fallbackReason: "empty_reply" };
        }
        this.opts.onRouteAttemptOutcome?.({ decisionId: plan.decisionId, targetId: lockedEp.targetId, archetype: plan.archetype, ok: true, ttftMs: round0LatencyMs, totalLatencyMs: Math.max(1, Date.now() - turnStartMs), costUsd: totalCostUsd, toolCallCount: toolCallsExecuted.length, escalatedFrom, fallbackUsedFrom: fallbackFrom, signalSource: "turn_complete" });
        return { ok: true, reply, modelUsed: res.data.model || lockedEp.rawModelId, toolCallsExecuted, routeMeta: this.buildRouteMeta(plan, lockedEp, fallbackFrom, escalatedFrom), workbench: this.opts.toolsPort.getWorkbench(domain) };
      }
      await this.dispatchToolCalls(msg.content, msg.tool_calls, messages, toolCallsExecuted, domain, channel);
    }
    return { ok: false, fallbackReason: "max_tool_rounds_exceeded" };
  }
}
