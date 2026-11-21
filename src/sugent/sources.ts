/**
 * Sugent 个人全景事件源注册表（PersonalSourceRegistry）
 *
 * 将 dsh-superagent-prototype 的 `SourceKind` 思想扩展到个人全场景：
 * 统一将 GitHub 事件、即时通讯消息（微信/飞书/TG/Slack/Discord）、定时规则、本地文件变更与邮件/日历
 * 归一化为 `PersonalTrigger`，送入 `evaluatePersonalTrigger` 状态机门控。
 *
 * M1.4 安全加固：
 * - 入口默认启用越权控制字段拦截（`guardPrivilegedEventFields`），严禁外部事件载荷夹带 `cwd`、`agent`、`permission`、`access` 等字段；
 * - 支持传入 `workspaceDir` 或调用 `ingestEnveloped()`，将外部标题与正文物理隔离至只读 `.context/event-<id>.md`，
 *   使 `trigger.text` 仅保留参数化安全引用提示词。
 */
import crypto from "node:crypto";
import { guardPrivilegedEventFields, sealExternalEvent } from "./security-envelope.js";
import type { PersonalSourceKindId, PersonalTrigger, PrivilegedFieldMode } from "./types.js";

export interface SourceAdapter<Payload = Record<string, unknown>> {
  readonly kind: PersonalSourceKindId;
  readonly title: { zh: string; en: string };
  normalize(instanceId: string, payload: Payload, allowedSenderIds: ReadonlySet<string>): PersonalTrigger;
}

export interface SourceIngestOptions {
  /** 越权字段处理策略：默认 `reject` 直接拒收带 `cwd`/`agent`/`permission`/`access` 的载荷 */
  privilegedFieldMode?: PrivilegedFieldMode;
  /** 若提供任务/规则工作目录，则自动启用指令数据物理分离，将正文写入 `<workspaceDir>/.context/event-<id>.md` */
  workspaceDir?: string;
  /** 可选显式事件子类型（如 `issues.opened`），用于参数化信封元数据校验 */
  eventType?: string;
  /** 可选外部链接（仅限通过安全校验的 http/https URL） */
  url?: string;
}

export interface EnvelopedIngestOptions extends SourceIngestOptions {
  workspaceDir: string;
}

export class PersonalSourceRegistry {
  private readonly adapters = new Map<PersonalSourceKindId, SourceAdapter<any>>();
  private readonly defaultPrivilegedFieldMode: PrivilegedFieldMode;

  constructor(options: { defaultPrivilegedFieldMode?: PrivilegedFieldMode } = {}) {
    this.defaultPrivilegedFieldMode = options.defaultPrivilegedFieldMode ?? "reject";
    this.registerBuiltins();
  }

  register<P>(adapter: SourceAdapter<P>): void {
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: PersonalSourceKindId): SourceAdapter<any> | undefined {
    return this.adapters.get(kind);
  }

  listKinds(): Array<{ kind: PersonalSourceKindId; title: { zh: string; en: string } }> {
    return Array.from(this.adapters.values()).map((a) => ({ kind: a.kind, title: a.title }));
  }

  ingest<P>(
    kind: PersonalSourceKindId,
    instanceId: string,
    payload: P,
    allowedSenderIds: Iterable<string>,
    options: SourceIngestOptions = {},
  ): PersonalTrigger {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Unknown personal source kind: ${kind}`);

    const mode = options.privilegedFieldMode ?? this.defaultPrivilegedFieldMode;
    const { sanitized, strippedFields } = guardPrivilegedEventFields(payload, { mode });
    const trigger = adapter.normalize(instanceId, sanitized, new Set(allowedSenderIds));

    if (strippedFields.length > 0) {
      trigger.meta = { ...(trigger.meta ?? {}), strippedPrivilegedFields: strippedFields };
    }

    if (!options.workspaceDir) {
      return trigger;
    }

    const rawRecord = sanitized as unknown as Record<string, unknown>;
    const rawTitle = typeof rawRecord.title === "string" ? rawRecord.title : undefined;
    const inferredType =
      options.eventType ??
      (typeof rawRecord.eventType === "string"
        ? rawRecord.eventType
        : typeof rawRecord.type === "string"
          ? rawRecord.type
          : `${kind}.event`);
    const inferredUrl =
      options.url ?? (typeof rawRecord.url === "string" ? rawRecord.url : undefined);
    const inferredRef =
      kind === "github" &&
      typeof trigger.meta?.repo === "string" &&
      typeof trigger.meta?.number === "number"
        ? `${trigger.meta.repo}#${trigger.meta.number}`
        : undefined;

    const sealed = sealExternalEvent({
      workspaceDir: options.workspaceDir,
      source: kind,
      eventType: inferredType,
      eventId: trigger.id,
      payload: rawRecord,
      ...(rawTitle !== undefined ? { title: rawTitle } : {}),
      body: trigger.text,
      ...(inferredUrl !== undefined ? { url: inferredUrl } : {}),
      ...(inferredRef !== undefined ? { ref: inferredRef } : {}),
      // 已在入口完成 reject/strip 门控，此处复用已净化载荷
      privilegedFieldMode: "strip",
    });

    const envelope =
      strippedFields.length > 0
        ? { ...sealed.envelope, strippedFields }
        : sealed.envelope;

    const sanitizedTrigger: PersonalTrigger = {
      ...trigger,
      text: sealed.prompt,
      meta: {
        ...(trigger.meta ?? {}),
        contextFile: envelope.contextFile,
        contextSha256: envelope.sha256,
      },
      envelope,
    };
    // 移除未校验的外部自由昵称，避免外部攻击者借 senderName 向后续模块夹带提示词注入文本
    delete sanitizedTrigger.senderName;
    return sanitizedTrigger;
  }

  /**
   * 强制启用指令数据物理分离的安全摄入入口：
   * 返回的 `PersonalTrigger.text` 仅包含参数化提示词与 `.context/event-<id>.md` 引用，绝不包含外部原始标题或正文。
   */
  ingestEnveloped<P>(
    kind: PersonalSourceKindId,
    instanceId: string,
    payload: P,
    allowedSenderIds: Iterable<string>,
    options: EnvelopedIngestOptions,
  ): PersonalTrigger & { envelope: NonNullable<PersonalTrigger["envelope"]> } {
    const trigger = this.ingest(kind, instanceId, payload, allowedSenderIds, options);
    return trigger as PersonalTrigger & { envelope: NonNullable<PersonalTrigger["envelope"]> };
  }

  private registerBuiltins(): void {
    this.register<{
      id: string;
      repo: string;
      issueOrPrNumber: number;
      senderLogin: string;
      title?: string;
      body: string;
      url?: string;
      eventType?: string;
      mentionedAgent?: boolean;
      createdAt?: string;
    }>({
      kind: "github",
      title: { zh: "GitHub 仓库与通知", en: "GitHub Repository & Notifications" },
      normalize(instanceId, p, allowed) {
        return {
          id: `gh:${p.id}`,
          sourceKind: "github",
          sourceInstanceId: instanceId,
          threadKey: `github:${p.repo}#${p.issueOrPrNumber}`,
          senderId: p.senderLogin,
          senderName: p.senderLogin,
          addressedToAgent: Boolean(p.mentionedAgent),
          fromAllowedSender: allowed.has(p.senderLogin) || allowed.has("*"),
          text: p.body,
          createdAt: p.createdAt ?? new Date().toISOString(),
          meta: { repo: p.repo, number: p.issueOrPrNumber },
        };
      },
    });

    this.register<{
      messageId: string;
      channel: string;
      conversationId: string;
      senderId: string;
      senderName?: string;
      text: string;
      isDirectOrMention?: boolean;
      createdAt?: string;
    }>({
      kind: "im_channel",
      title: { zh: "即时通讯渠道 (微信/飞书/TG/Slack/Discord)", en: "IM Channels" },
      normalize(instanceId, p, allowed) {
        return {
          id: `im:${p.channel}:${p.messageId}`,
          sourceKind: "im_channel",
          sourceInstanceId: instanceId,
          threadKey: `${p.channel}:${p.conversationId}`,
          senderId: p.senderId,
          ...(p.senderName ? { senderName: p.senderName } : {}),
          addressedToAgent: p.isDirectOrMention !== false,
          fromAllowedSender: allowed.has(p.senderId) || allowed.has("*"),
          text: p.text,
          createdAt: p.createdAt ?? new Date().toISOString(),
          meta: { channel: p.channel, conversationId: p.conversationId },
        };
      },
    });

    this.register<{
      runId: string;
      ruleId: string;
      instruction: string;
      ownerId: string;
      createdAt?: string;
    }>({
      kind: "schedule",
      title: { zh: "定时主动巡检规则", en: "Scheduled Proactive Rules" },
      normalize(instanceId, p, allowed) {
        return {
          id: `sched:${p.runId}`,
          sourceKind: "schedule",
          sourceInstanceId: instanceId,
          threadKey: `schedule:${p.ruleId}`,
          senderId: p.ownerId,
          addressedToAgent: false, // 定时触发走主动规则（observe / act）门控
          fromAllowedSender: allowed.has(ownerOrStar(p.ownerId, allowed)) || allowed.has("*"),
          text: p.instruction,
          createdAt: p.createdAt ?? new Date().toISOString(),
          meta: { ruleId: p.ruleId },
        };
      },
    });

    this.register<{
      eventId: string;
      nodeId?: string;
      surface?: string;
      conversationId: string;
      projectKey?: string;
      workspacePath?: string;
      hookEvent?: string;
      terminationReason?: string;
      fullyIdle?: boolean;
      summary?: string;
      ownerId: string;
      createdAt?: string;
    }>({
      kind: "antigravity",
      title: { zh: "Antigravity 会话与钩子事件", en: "Antigravity Sessions & Hooks" },
      normalize(instanceId, p, allowed) {
        const nodeId = p.nodeId ?? "local-mac";
        const surface = p.surface ?? "app";
        const text =
          p.summary ??
          (p.hookEvent ? `[${p.hookEvent}] ${p.conversationId}` : p.conversationId);
        return {
          id: `agy:${p.eventId}`,
          sourceKind: "antigravity",
          sourceInstanceId: instanceId,
          threadKey: `antigravity:${nodeId}:${surface}:${p.conversationId}`,
          senderId: p.ownerId,
          addressedToAgent: false,
          fromAllowedSender: allowed.has(p.ownerId) || allowed.has("*"),
          text,
          createdAt: p.createdAt ?? new Date().toISOString(),
          meta: {
            nodeId,
            surface,
            conversationId: p.conversationId,
            ...(p.projectKey ? { projectKey: p.projectKey } : {}),
            ...(p.workspacePath ? { workspacePath: p.workspacePath } : {}),
            ...(p.hookEvent ? { hookEvent: p.hookEvent } : {}),
            ...(p.terminationReason ? { terminationReason: p.terminationReason } : {}),
            ...(p.fullyIdle !== undefined ? { fullyIdle: p.fullyIdle } : {}),
          },
        };
      },
    });
  }
}

function ownerOrStar(ownerId: string, _allowed: ReadonlySet<string>): string {
  return ownerId;
}

export interface ZeroTokenProbeSample {
  probeId: string;
  /** 探针脚本退出码为 0 或状态正常时传 true；首次异常传 false */
  healthy: boolean;
  /** 探针采样摘要文本或 JSON 快照（用于计算 SHA-256 增量指纹） */
  output: string;
  /** 若仅在内容变化时唤醒（如轮询订阅源），可显式开启 wakeOnDiff */
  wakeOnDiff?: boolean;
  /** 首次异常发出的卡片标识，恢复正常时原样带回供 resolve 自动更新关闭 */
  alertCardId?: string;
  at: string;
}

export type ProbeEvaluationReason =
  | "healthy_unchanged"
  | "diff_detected"
  | "first_failure"
  | "failure_payload_changed"
  | "ongoing_failure_suppressed"
  | "recovered";

export interface ZeroTokenProbeDecision {
  shouldWakeAgent: boolean;
  reason: ProbeEvaluationReason;
  digest: string;
  recovered?: boolean;
  alertCardId?: string;
}

interface ProbeState {
  healthy: boolean;
  digest: string;
  alertCardId?: string;
  updatedAt: string;
}

/**
 * 零 Token 前置探针状态跟踪器（Roadmap 阶段二第 2 节）：
 * - 正常且无变化：直接返回 `shouldWakeAgent: false`（0 LLM 调用、0 Token）；
 * - 首次异常：唤醒一次发送告警卡片并记住 `alertCardId`；
 * - 持续相同异常：静默抑制，杜绝每 5 分钟重复轰炸；
 * - 异常恢复正常：唤醒一次并标记 `recovered: true` 与原 `alertCardId`，配合回执 `resolve` 关闭原卡片。
 */
export class ZeroTokenProbeTracker {
  private readonly states = new Map<string, ProbeState>();

  evaluate(sample: ZeroTokenProbeSample): ZeroTokenProbeDecision {
    const digest = crypto.createHash("sha256").update(String(sample.output ?? ""), "utf8").digest("hex");
    const prev = this.states.get(sample.probeId);

    if (sample.healthy) {
      if (prev && !prev.healthy) {
        const prevCardId = prev.alertCardId;
        this.states.set(sample.probeId, { healthy: true, digest, updatedAt: sample.at });
        return {
          shouldWakeAgent: true,
          reason: "recovered",
          digest,
          recovered: true,
          ...(prevCardId ? { alertCardId: prevCardId } : {}),
        };
      }

      const changed = !!prev && prev.digest !== digest;
      this.states.set(sample.probeId, { healthy: true, digest, updatedAt: sample.at });
      if (sample.wakeOnDiff && changed) {
        return { shouldWakeAgent: true, reason: "diff_detected", digest };
      }
      return { shouldWakeAgent: false, reason: "healthy_unchanged", digest };
    }

    // 异常分支
    if (!prev || prev.healthy) {
      const cardId = sample.alertCardId ?? `alert-${sample.probeId}`;
      this.states.set(sample.probeId, {
        healthy: false,
        digest,
        alertCardId: cardId,
        updatedAt: sample.at,
      });
      return {
        shouldWakeAgent: true,
        reason: "first_failure",
        digest,
        alertCardId: cardId,
      };
    }

    const cardId = sample.alertCardId ?? prev.alertCardId;
    if (sample.wakeOnDiff && prev.digest !== digest) {
      this.states.set(sample.probeId, {
        healthy: false,
        digest,
        ...(cardId ? { alertCardId: cardId } : {}),
        updatedAt: sample.at,
      });
      return {
        shouldWakeAgent: true,
        reason: "failure_payload_changed",
        digest,
        ...(cardId ? { alertCardId: cardId } : {}),
      };
    }

    return {
      shouldWakeAgent: false,
      reason: "ongoing_failure_suppressed",
      digest,
      ...(cardId ? { alertCardId: cardId } : {}),
    };
  }
}

/**
 * 同 `threadKey` 排队期事件防抖合并器（Event Coalescing）：
 * 当同一 Issue/PR/会话已有一轮正在执行时，后续涌入的事件先进入排队缓冲，
 * 当前轮次结束后自动合并为单条 `PersonalTrigger`，且严格保留最高 `hopCount` 防跳数洗白。
 */
export class TriggerCoalescer {
  private readonly runningThreads = new Set<string>();
  private readonly pendingByThread = new Map<string, PersonalTrigger[]>();

  markRunning(threadKey: string): void {
    this.runningThreads.add(threadKey);
  }

  isRunning(threadKey: string): boolean {
    return this.runningThreads.has(threadKey);
  }

  submit(trigger: PersonalTrigger): { status: "dispatch_now"; trigger: PersonalTrigger } | { status: "queued"; pendingCount: number } {
    if (!this.runningThreads.has(trigger.threadKey)) {
      this.runningThreads.add(trigger.threadKey);
      return { status: "dispatch_now", trigger };
    }
    const queue = this.pendingByThread.get(trigger.threadKey) ?? [];
    queue.push(trigger);
    this.pendingByThread.set(trigger.threadKey, queue);
    return { status: "queued", pendingCount: queue.length };
  }

  completeAndDrain(threadKey: string): PersonalTrigger | undefined {
    const queue = this.pendingByThread.get(threadKey);
    if (!queue || queue.length === 0) {
      this.runningThreads.delete(threadKey);
      this.pendingByThread.delete(threadKey);
      return undefined;
    }
    this.pendingByThread.delete(threadKey);
    // 保持 running 状态交由合并后的下一轮继续执行
    if (queue.length === 1) {
      return queue[0]!;
    }

    const first = queue[0]!;
    const last = queue[queue.length - 1]!;
    const maxHop = queue.reduce((acc, t) => Math.max(acc, Math.trunc(t.hopCount ?? 0)), 0);
    const anyAddressed = queue.some((t) => t.addressedToAgent);
    const allAllowed = queue.every((t) => t.fromAllowedSender);
    const mergedText = queue.map((t, idx) => `[#${idx + 1} ${t.id}] ${t.text}`).join("\n---\n");

    return {
      ...last,
      id: `${first.id}+${queue.length - 1}`,
      addressedToAgent: anyAddressed,
      fromAllowedSender: allAllowed,
      text: mergedText,
      hopCount: maxHop,
      originTriggerId: first.originTriggerId ?? first.id,
      meta: {
        ...(last.meta ?? {}),
        coalescedCount: queue.length,
        coalescedTriggerIds: queue.map((t) => t.id),
      },
    };
  }
}
