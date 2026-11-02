/**
 * Sugent 个人全景事件源注册表（PersonalSourceRegistry）
 *
 * 将 dsh-superagent-prototype 的 `SourceKind` 思想扩展到个人全场景：
 * 统一将 GitHub 事件、即时通讯消息（微信/飞书/TG/Slack/Discord）、定时规则、本地文件变更与邮件/日历
 * 归一化为 `PersonalTrigger`，送入 `evaluatePersonalTrigger` 状态机门控。
 */
import type { PersonalSourceKindId, PersonalTrigger } from "./types.js";

export interface SourceAdapter<Payload = Record<string, unknown>> {
  readonly kind: PersonalSourceKindId;
  readonly title: { zh: string; en: string };
  normalize(instanceId: string, payload: Payload, allowedSenderIds: ReadonlySet<string>): PersonalTrigger;
}

export class PersonalSourceRegistry {
  private readonly adapters = new Map<PersonalSourceKindId, SourceAdapter<any>>();

  constructor() {
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
  ): PersonalTrigger {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`Unknown personal source kind: ${kind}`);
    return adapter.normalize(instanceId, payload, new Set(allowedSenderIds));
  }

  private registerBuiltins(): void {
    this.register<{
      id: string;
      repo: string;
      issueOrPrNumber: number;
      senderLogin: string;
      body: string;
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
          fromAllowedSender: allowed.has(p.ownerId) || allowed.has("*"),
          text: p.instruction,
          createdAt: p.createdAt ?? new Date().toISOString(),
          meta: { ruleId: p.ruleId },
        };
      },
    });
  }
}
