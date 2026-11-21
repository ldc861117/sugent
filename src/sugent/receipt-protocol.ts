/**
 * Sugent 挂起零消耗存档与结构化自闭环回执协议（src/sugent/receipt-protocol.ts）
 *
 * 对应 Roadmap 阶段二第 1 节，吸收 Agent-Autoloop 的「挂起零消耗」与结构化回执动作协议：
 * 1. 挂起零消耗存档（`SuspendedRoundStore`）：
 *    - 当智能体遇到需要人类拍板的高风险动作（发消息、花钱、改生产配置、合并分支）时，
 *      将当前会话 ID、轮次 ID、不可篡改的 `hopCount` / `originTriggerId` 与待批摘要原子落盘为存档文件，
 *      随后即可彻底释放执行进程（等待期 0 驻留进程、0 轮询 Token）；
 *    - 人类在飞书/微信/控制台点卡拍板后，调用 `resume()` 读取原存档无缝续接，且保留原有跳数计数。
 * 2. 结构化自闭环回执解析与局部修复（`parseAgentReceipt` / `buildReceiptRepairPrompt`）：
 *    - 支持解析智能体回复末尾的 ```sugent-receipt JSON 块（或纯 JSON 回执），提取：
 *      - `later`: 预约 N 秒后自唤醒复查（自动通过 `deriveChildTriggerHop` 累加 `hopCount`）；
 *      - `resolve`: 故障恢复后自动更新/关闭原告警卡片，避免重复轰炸；
 *      - `events`: 派生下游联动事件（全部自动继承并递增 `hopCount`，受 8 跳熔断器约束）；
 *    - 当回执 JSON 语法或字段校验失败时，生成局部修复提示词，仅要求在原会话重写末尾回执块，绝不重做已执行的业务动作。
 */
import fs from "node:fs";
import path from "node:path";
import { deriveChildTriggerHop } from "./kernel.js";
import { validateSafeMetadataToken } from "./security-envelope.js";
import type { PersonalSourceKindId, PersonalTrigger } from "./types.js";

export type AgentReceiptStatus = "completed" | "suspend_approval" | "failed";

export interface ReceiptApprovalAction {
  approvalId: string;
  prompt: string;
  riskLevel: "low" | "medium" | "high";
}

export interface ReceiptLaterAction {
  /** 预约多少秒后唤醒复查（1 ~ 604800 秒，即最长 7 天） */
  delaySec: number;
  reason: string;
  threadKey?: string;
}

export interface ReceiptResolveAction {
  cardId: string;
  resolution: string;
}

export interface ReceiptDownstreamEventSpec {
  sourceKind?: PersonalSourceKindId;
  threadKey: string;
  summary: string;
  addressedToAgent?: boolean;
  meta?: Record<string, unknown>;
}

export interface AgentReceipt {
  status: AgentReceiptStatus;
  summary: string;
  approval?: ReceiptApprovalAction;
  later?: ReceiptLaterAction;
  resolve?: ReceiptResolveAction;
  events: ReceiptDownstreamEventSpec[];
}

export type ParseReceiptResult =
  | { ok: true; receipt: AgentReceipt; rawBlock: string }
  | { ok: false; error: string; rawBlock?: string; repairPrompt: string };

const RECEIPT_FENCE_RE = /```sugent-receipt\s*([\s\S]*?)```\s*$/i;

const MAX_DELAY_SECONDS = 7 * 24 * 3600;

/**
 * 当回执 JSON 解析或字段校验失败时，生成仅重写回执尾块的局部修复指令，避免重跑前序工具副作用。
 */
export function buildReceiptRepairPrompt(validationError: string): string {
  return [
    "[系统回执格式局部修复]",
    `你上一条回复末尾的 sugent-receipt JSON 未通过校验：${validationError}`,
    "请勿重新执行任何工具调用或重复已完成的业务操作；仅直接输出修正后的 ```sugent-receipt JSON 代码块。",
    '合法示例：\n```sugent-receipt\n{"status":"completed","summary":"已完成巡检","events":[]}\n```',
  ].join("\n");
}

/**
 * 从智能体最终回复中提取并校验 `sugent-receipt` 结构化回执。
 */
export function parseAgentReceipt(assistantText: string): ParseReceiptResult {
  const trimmed = String(assistantText ?? "").trim();
  if (!trimmed) {
    const error = "Empty assistant output; missing sugent-receipt block.";
    return { ok: false, error, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  const fenceMatch = RECEIPT_FENCE_RE.exec(trimmed);
  const rawBlock = fenceMatch ? fenceMatch[1]!.trim() : trimmed.startsWith("{") ? trimmed : undefined;

  if (!rawBlock) {
    const error = "Missing trailing ```sugent-receipt JSON block.";
    return { ok: false, error, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  let parsed: Record<string, unknown>;
  try {
    const val = JSON.parse(rawBlock);
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      const error = "Receipt JSON root must be an object.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    parsed = val as Record<string, unknown>;
  } catch (err) {
    const error = `Invalid JSON syntax: ${(err as Error).message}`;
    return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  const rawStatus = String(parsed.status ?? "completed").trim();
  if (rawStatus !== "completed" && rawStatus !== "suspend_approval" && rawStatus !== "failed") {
    const error = `Unsupported status "${rawStatus}"; expected completed | suspend_approval | failed.`;
    return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) {
    const error = "Field 'summary' must be a non-empty string.";
    return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  let approval: ReceiptApprovalAction | undefined;
  if (parsed.approval !== undefined) {
    if (!parsed.approval || typeof parsed.approval !== "object" || Array.isArray(parsed.approval)) {
      const error = "Field 'approval' must be an object.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    const ap = parsed.approval as Record<string, unknown>;
    const prompt = typeof ap.prompt === "string" ? ap.prompt.trim() : "";
    if (!prompt) {
      const error = "Field 'approval.prompt' must be a non-empty string.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    const rawId = typeof ap.approvalId === "string" && ap.approvalId.trim() ? ap.approvalId : "ap-default";
    let approvalId: string;
    try {
      approvalId = validateSafeMetadataToken(rawId, "approvalId");
    } catch (e) {
      return { ok: false, error: (e as Error).message, rawBlock, repairPrompt: buildReceiptRepairPrompt((e as Error).message) };
    }
    const riskRaw = String(ap.riskLevel ?? "high").toLowerCase();
    const riskLevel: "low" | "medium" | "high" =
      riskRaw === "low" || riskRaw === "medium" ? riskRaw : "high";
    approval = { approvalId, prompt, riskLevel };
  }

  if (rawStatus === "suspend_approval" && !approval) {
    const error = "Status 'suspend_approval' requires an 'approval' descriptor.";
    return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
  }

  let later: ReceiptLaterAction | undefined;
  if (parsed.later !== undefined) {
    if (!parsed.later || typeof parsed.later !== "object" || Array.isArray(parsed.later)) {
      const error = "Field 'later' must be an object.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    const lt = parsed.later as Record<string, unknown>;
    const delaySec = Number(lt.delaySec);
    if (!Number.isFinite(delaySec) || delaySec < 1 || delaySec > MAX_DELAY_SECONDS) {
      const error = `Field 'later.delaySec' must be between 1 and ${MAX_DELAY_SECONDS}.`;
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    const reason = typeof lt.reason === "string" ? lt.reason.trim() : "";
    if (!reason) {
      const error = "Field 'later.reason' must be a non-empty string.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    later = {
      delaySec: Math.trunc(delaySec),
      reason,
      ...(typeof lt.threadKey === "string" && lt.threadKey.trim() ? { threadKey: lt.threadKey.trim() } : {}),
    };
  }

  let resolve: ReceiptResolveAction | undefined;
  if (parsed.resolve !== undefined) {
    if (!parsed.resolve || typeof parsed.resolve !== "object" || Array.isArray(parsed.resolve)) {
      const error = "Field 'resolve' must be an object.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    const rs = parsed.resolve as Record<string, unknown>;
    let cardId: string;
    try {
      cardId = validateSafeMetadataToken(rs.cardId, "resolve.cardId");
    } catch (e) {
      return { ok: false, error: (e as Error).message, rawBlock, repairPrompt: buildReceiptRepairPrompt((e as Error).message) };
    }
    const resolution = typeof rs.resolution === "string" ? rs.resolution.trim() : "";
    if (!resolution) {
      const error = "Field 'resolve.resolution' must be a non-empty string.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    resolve = { cardId, resolution };
  }

  const events: ReceiptDownstreamEventSpec[] = [];
  if (parsed.events !== undefined) {
    if (!Array.isArray(parsed.events)) {
      const error = "Field 'events' must be an array.";
      return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
    }
    for (let i = 0; i < parsed.events.length; i++) {
      const item = parsed.events[i] as Record<string, unknown>;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        const error = `events[${i}] must be an object.`;
        return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
      }
      const threadKey = typeof item.threadKey === "string" ? item.threadKey.trim() : "";
      const evSummary = typeof item.summary === "string" ? item.summary.trim() : "";
      if (!threadKey || !evSummary) {
        const error = `events[${i}] requires non-empty 'threadKey' and 'summary'.`;
        return { ok: false, error, rawBlock, repairPrompt: buildReceiptRepairPrompt(error) };
      }
      events.push({
        ...(typeof item.sourceKind === "string"
          ? { sourceKind: item.sourceKind as PersonalSourceKindId }
          : {}),
        threadKey,
        summary: evSummary,
        ...(typeof item.addressedToAgent === "boolean" ? { addressedToAgent: item.addressedToAgent } : {}),
        ...(item.meta && typeof item.meta === "object" && !Array.isArray(item.meta)
          ? { meta: item.meta as Record<string, unknown> }
          : {}),
      });
    }
  }

  return {
    ok: true,
    rawBlock,
    receipt: {
      status: rawStatus,
      summary,
      ...(approval ? { approval } : {}),
      ...(later ? { later } : {}),
      ...(resolve ? { resolve } : {}),
      events,
    },
  };
}

/**
 * 将回执中的 `later` 定时复查与 `events` 下游联动统一物化为携带递增 `hopCount` 的子 `PersonalTrigger`，
 * 确保任何自唤醒或跨规则级联都逃不开 8 跳熔断器。
 */
export function materializeReceiptFollowups(
  parentTrigger: PersonalTrigger,
  receipt: AgentReceipt,
  nowIso: string,
): {
  scheduledWakeup?: { wakeAtIso: string; delaySec: number; trigger: PersonalTrigger };
  downstreamTriggers: PersonalTrigger[];
} {
  const childHop = deriveChildTriggerHop(parentTrigger);
  let scheduledWakeup: { wakeAtIso: string; delaySec: number; trigger: PersonalTrigger } | undefined;

  if (receipt.later) {
    const baseMs = Date.parse(nowIso);
    const wakeMs = (Number.isFinite(baseMs) ? baseMs : 0) + receipt.later.delaySec * 1000;
    const wakeAtIso = new Date(wakeMs).toISOString();
    scheduledWakeup = {
      wakeAtIso,
      delaySec: receipt.later.delaySec,
      trigger: {
        id: `${parentTrigger.id}:later`,
        sourceKind: "schedule",
        sourceInstanceId: parentTrigger.sourceInstanceId,
        threadKey: receipt.later.threadKey ?? parentTrigger.threadKey,
        senderId: parentTrigger.senderId,
        addressedToAgent: true,
        fromAllowedSender: parentTrigger.fromAllowedSender,
        text: receipt.later.reason,
        createdAt: wakeAtIso,
        ...childHop,
        meta: {
          parentTriggerId: parentTrigger.id,
          delaySec: receipt.later.delaySec,
        },
      },
    };
  }

  const downstreamTriggers: PersonalTrigger[] = receipt.events.map((ev, idx) => ({
    id: `${parentTrigger.id}:ev:${idx + 1}`,
    sourceKind: ev.sourceKind ?? parentTrigger.sourceKind,
    sourceInstanceId: parentTrigger.sourceInstanceId,
    threadKey: ev.threadKey,
    senderId: parentTrigger.senderId,
    addressedToAgent: ev.addressedToAgent ?? true,
    fromAllowedSender: parentTrigger.fromAllowedSender,
    text: ev.summary,
    createdAt: nowIso,
    ...childHop,
    meta: {
      ...(ev.meta ?? {}),
      parentTriggerId: parentTrigger.id,
    },
  }));

  return {
    ...(scheduledWakeup ? { scheduledWakeup } : {}),
    downstreamTriggers,
  };
}

export interface SuspendedRoundCheckpoint {
  roundId: string;
  sessionId: string;
  threadKey: string;
  approval: ReceiptApprovalAction;
  hopCount: number;
  originTriggerId: string;
  suspendedAt: string;
  status: "suspended" | "resumed";
  resumedAt?: string;
  decision?: {
    approved: boolean;
    decidedBy: string;
    note?: string;
  };
}

/**
 * 挂起零消耗存档仓库：
 * 等待人工审批期间仅保留磁盘上的小型 JSON 存档（0 驻留进程、0 轮询 Token），
 * 收到拍板回调后读取原 `sessionId` 与 `hopCount` 恢复续接（幂等防重放）。
 */
export class SuspendedRoundStore {
  readonly dirPath: string;

  constructor(storageRoot: string) {
    this.dirPath = path.join(path.resolve(storageRoot), "suspended-rounds");
    fs.mkdirSync(this.dirPath, { recursive: true, mode: 0o700 });
  }

  private fileOf(roundId: string): string {
    const safeId = validateSafeMetadataToken(roundId, "roundId");
    return path.join(this.dirPath, `${safeId}.json`);
  }

  suspend(input: {
    roundId: string;
    sessionId: string;
    parentTrigger: PersonalTrigger;
    approval: ReceiptApprovalAction;
    suspendedAt: string;
  }): SuspendedRoundCheckpoint {
    const safeRoundId = validateSafeMetadataToken(input.roundId, "roundId");
    const checkpoint: SuspendedRoundCheckpoint = {
      roundId: safeRoundId,
      sessionId: String(input.sessionId).trim(),
      threadKey: input.parentTrigger.threadKey,
      approval: input.approval,
      // 跨人工审批/提问挂起期间绝不清零 hopCount
      hopCount: Math.max(0, Math.trunc(input.parentTrigger.hopCount ?? 0)),
      originTriggerId: input.parentTrigger.originTriggerId ?? input.parentTrigger.id,
      suspendedAt: input.suspendedAt,
      status: "suspended",
    };
    const dest = this.fileOf(safeRoundId);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, dest);
    return checkpoint;
  }

  get(roundId: string): SuspendedRoundCheckpoint | undefined {
    const f = this.fileOf(roundId);
    if (!fs.existsSync(f)) return undefined;
    return JSON.parse(fs.readFileSync(f, "utf8")) as SuspendedRoundCheckpoint;
  }

  listPending(): SuspendedRoundCheckpoint[] {
    if (!fs.existsSync(this.dirPath)) return [];
    return fs
      .readdirSync(this.dirPath)
      .filter((n) => n.endsWith(".json"))
      .map((n) => JSON.parse(fs.readFileSync(path.join(this.dirPath, n), "utf8")) as SuspendedRoundCheckpoint)
      .filter((c) => c.status === "suspended");
  }

  /**
   * 人工拍板恢复存档：保证同一个挂起存档只能被消费恢复一次（避免连点卡片重复执行写入动作），
   * 并生成携带原 `hopCount + 1`（或保持原跳数续接）的恢复触发消息。
   */
  resume(
    roundId: string,
    decision: { approved: boolean; decidedBy: string; note?: string; resumedAt: string },
  ): { checkpoint: SuspendedRoundCheckpoint; resumePrompt: string } {
    const existing = this.get(roundId);
    if (!existing) {
      throw new Error(`Suspended round "${roundId}" not found.`);
    }
    if (existing.status === "resumed") {
      throw new Error(`Suspended round "${roundId}" was already resumed at ${existing.resumedAt}.`);
    }

    const updated: SuspendedRoundCheckpoint = {
      ...existing,
      status: "resumed",
      resumedAt: decision.resumedAt,
      decision: {
        approved: decision.approved,
        decidedBy: decision.decidedBy,
        ...(decision.note ? { note: decision.note } : {}),
      },
    };

    const dest = this.fileOf(roundId);
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, dest);

    const verdictLabel = decision.approved ? "已批准 (APPROVED)" : "已驳回 (REJECTED)";
    const resumePrompt = [
      `[挂起存档续接 · 轮次 ${updated.roundId}]`,
      `审批项 #${updated.approval.approvalId}：${verdictLabel}`,
      `决策人：${decision.decidedBy}`,
      ...(decision.note ? [`补充意见：${decision.note}`] : []),
      `当前链路跳数：${updated.hopCount}（源触发 ${updated.originTriggerId}）`,
      decision.approved
        ? "请基于原会话上下文继续完成剩余动作，并在末尾附上 sugent-receipt 回执。"
        : "操作已被人工驳回，请立即安全终止写操作并输出收尾回执。",
    ].join("\n");

    return { checkpoint: updated, resumePrompt };
  }
}
