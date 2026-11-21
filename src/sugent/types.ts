/**
 * Sugent (Super-Agent) 核心类型定义
 * 融合 AnyModelBot（多端触达 + 三层记忆 + 桌面操控）与 dsh-superagent（Intake -> Eval -> Ticket 自治状态机）
 */

export type ModelRole = "assessor" | "executor" | "computer_use" | "steward";

export type GatewayProviderMode =
  | "byok"          // 自带 API Key / 任意 OpenAI & Anthropic & Gemini 兼容端点
  | "subscription"  // 解锁原版 magpie 的本地订阅复用（Claude Code / Codex / Gemini CLI 等）
  | "modelflare"    // 兼容 AnyModelBot 原生 Modelflare 路由与缓存补偿
  | "external";     // 外部独立网关（如自建 OneAPI / LiteLLM / 独立运行的 magpie / Cowork 审计网关）

export interface RoleModelRouting {
  /** 守门评估器模型（Intake -> Eval 噪音过滤、规则判定，默认低成本高速模型） */
  assessor: string;
  /** 核心执行器模型（Ticket -> Assignment 深度编码、调研与复杂工具调用，默认旗舰推理模型） */
  executor: string;
  /** 桌面视觉与 GUI 操控模型（配合 Cua Driver / kimi-computer-use） */
  computerUse: string;
  /** 记忆整理与上下文压缩模型（Context Steward & 三层 MEMORY.md 维护） */
  steward: string;
}

export interface SugentGatewayConfig {
  mode: GatewayProviderMode;
  /** 是否允许底层 magpie 发现并复用本机已登录的 Claude / ChatGPT / Copilot 订阅账号 */
  unlockSubscriptions: boolean;
  /** 是否开启本地隐私脱敏（将 API Key、邮箱、密码等替换为 {{API_KEY_...}} 占位符） */
  privacyMasking: boolean;
  /** 外部或自定义 OpenAI 兼容网关地址 */
  baseUrl?: string;
  /** 外部或自定义网关密钥 */
  apiKey?: string;
  /** 按智能体职责分层路由模型，把好钢用在刀刃上 */
  routing: RoleModelRouting;
}

export type PersonalSourceKindId =
  | "github"        // GitHub Issues / PRs / Reviews / Releases（源自 dsh-superagent）
  | "im_channel"    // 微信 iLink / Feishu / Telegram / Slack / Discord（源自 AnyModelBot）
  | "schedule"      // Cron / 定时主动巡检规则
  | "filesystem"    // 本地工作区或下载目录变更监听
  | "mail_calendar" // 个人邮件与日历事件流
  | "webhook"       // 通用外部 Webhook 触发源
  | "cowork_hitl"   // Business-Level Cowork 待审知识草稿与工作流挂起事件源
  | "antigravity";  // Antigravity App 本机生命周期钩子与会话状态事件源

/** 越权控制字段处理策略：默认严格拒收（reject），也可按需配置为剥离后放行（strip） */
export type PrivilegedFieldMode = "reject" | "strip";

/** 经安全信封（Security Envelope）物理隔离后的可信元数据摘要 */
export interface EventSecurityEnvelope {
  /** 校验通过的事件唯一编号 */
  eventId: string;
  /** 校验通过的事件来源标识 */
  source: string;
  /** 校验通过的事件类型标识 */
  eventType: string;
  /** 工作区内只读参考文件的相对路径（形如 `.context/event-<id>.md`） */
  contextFile: string;
  /** 只读参考文件落盘绝对路径 */
  absoluteFilePath: string;
  /** 参考文件内容 SHA-256 摘要（用于审计与防篡改校验） */
  sha256: string;
  /** 校验通过的可选外部链接（仅限 http/https 且无注入字符） */
  url?: string;
  /** 校验通过的可选关联对象标识（如 `owner/repo#42`） */
  ref?: string;
  /** 在 `strip` 模式下被入口自动剥离的越权字段路径列表 */
  strippedFields: string[];
}

export interface PersonalTrigger {
  id: string;
  sourceKind: PersonalSourceKindId;
  sourceInstanceId: string;
  threadKey: string;
  senderId: string;
  senderName?: string;
  /** 是否由人类直接点名或发给机器人的显式指令 */
  addressedToAgent: boolean;
  /** 是否来自允许列表中的主人或受信联系人 */
  fromAllowedSender: boolean;
  text: string;
  createdAt: string;
  meta?: Record<string, unknown>;
  /** 若启用了 M1.4 指令数据物理分离信封，挂载对应的只读文件引用与安全审计摘要 */
  envelope?: EventSecurityEnvelope;
  /** M2.1 级联唤醒跳数计数器（如网络包 TTL，经人工追问或延迟复查持续累加，不可由 Agent 清零） */
  readonly hopCount?: number;
  /** 级联唤醒链路最初的根触发器 ID（用于因果溯源） */
  readonly originTriggerId?: string;
}

export type EvalOutcomeKind =
  | "accept_act"            // 立即立项并执行（显式指令，或已转正的主动规则）
  | "accept_observe"        // 观察模式：仅记录"本会做什么（would）"，不产生外部副作用
  | "attach_ticket"         // 归入已有 Ticket 作为后续补充输入（Follow-up）
  | "ignore_noise"          // 判定为无需打扰人类的噪音，静默丢弃
  | "halt_circuit_breaker"; // M2.1 超过级联跳数上限（默认 > 8 跳），触发跳数熔断止损

export interface EvalDecision {
  triggerId: string;
  outcome: EvalOutcomeKind;
  reasonCode: string;
  reasonText: string;
  matchedRuleId?: string;
  targetTicketId?: string;
  /** 推荐调用的模型角色 */
  recommendedRole: ModelRole;
  /** 当前触发器所处的级联跳数 */
  hopCount?: number;
  /** 当前门控生效的最大允许跳数上限 */
  maxHops?: number;
  /** 是否需要立即向主人推送熔断/异常告警卡片 */
  requiresOwnerAlert?: boolean;
}

export interface ProactiveRulePolicy {
  id: string;
  title: string;
  sourceKind: PersonalSourceKindId;
  mode: "observe" | "act" | "off";
  /** 观察模式下累计成功验证次数 */
  verifiedObservations: number;
  /** 达到多少次无误观察后，向人类发起"是否转正为自动执行"的建议（默认 3 次） */
  suggestPromoteAfter: number;
}
