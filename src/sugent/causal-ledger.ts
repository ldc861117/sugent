/**
 * Sugent 只追加事件溯源与因果追溯账本（src/sugent/causal-ledger.ts）
 *
 * 对应 Roadmap M2.1，吸收 Agent-Autoloop 的事件溯源（Event Sourcing）与 `why` 因果反查理念：
 * 1. 只追加事实日志（Append-Only JSONL）：每发生一步状态演进（触发、门控判定、执行器领活、审批/提问、完成或跳数熔断），
 *    都在同步落盘（`fsyncSync`）后才确认返回，前序记录永不覆盖篡改；
 * 2. 可重算状态投影（Deterministic Projection）：内存中的轮次状态完全由事实流逐条归约算出，进程强杀重启或投影格式升级时
 *    直接从 `causal-ledger.jsonl` 重建，无需手写复杂迁移脚本；
 * 3. 一键因果追溯（`explainWhy` / `traceRound`）：给定任意轮次编号，立即还原“何时由什么来源触发、命中第几版规则、
 *    处于第几跳、由哪个角色领取、经历了哪些人工拍板、最终结果与花费是什么”。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EvalOutcomeKind, ModelRole } from "./types.js";

export type CausalFactKind =
  | "round_triggered"
  | "gate_evaluated"
  | "worker_claimed"
  | "approval_requested"
  | "approval_decided"
  | "round_completed"
  | "circuit_broken";

export interface CausalFactInput {
  roundId: string;
  kind: CausalFactKind;
  at: string;
  title?: string;
  ruleId?: string;
  ruleVersion?: number;
  source?: string;
  eventType?: string;
  targetRef?: string;
  triggerId?: string;
  hopCount?: number;
  maxHops?: number;
  outcome?: EvalOutcomeKind | "done" | "failed" | "stopped";
  reasonCode?: string;
  workerId?: string;
  modelRole?: ModelRole;
  resolvedModelId?: string;
  providerPreset?: string;
  goalId?: string;
  informationGain?: number;
  simAttemptRef?: string;
  approvalId?: string;
  approved?: boolean;
  decidedBy?: string;
  costUsd?: number;
  summary?: string;
}

export interface CausalFactRecord extends CausalFactInput {
  /** 全局单调递增事实序号（从 1 开始） */
  seq: number;
  /** 前一条事实的哈希（首条为 64 个 `"0"`），构成防篡改哈希链 */
  prevHash: string;
  /** 当前事实记录的 SHA-256 哈希 */
  hash: string;
}

export type RoundLifecycleStatus =
  | "triggered"
  | "evaluated"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "circuit_broken";

export interface RoundTraceProjection {
  roundId: string;
  title: string;
  status: RoundLifecycleStatus;
  startedAt: string;
  updatedAt: string;
  ruleId?: string;
  ruleVersion?: number;
  source?: string;
  eventType?: string;
  targetRef?: string;
  triggerId?: string;
  hopCount: number;
  maxHops?: number;
  gateOutcome?: EvalOutcomeKind;
  gateReasonCode?: string;
  workerId?: string;
  modelRole?: ModelRole;
  resolvedModelId?: string;
  providerPreset?: string;
  goalId?: string;
  informationGain?: number;
  simAttemptRef?: string;
  approvals: Array<{
    approvalId: string;
    requestedAt: string;
    summary?: string;
    decidedAt?: string;
    approved?: boolean;
    decidedBy?: string;
  }>;
  finalSummary?: string;
  totalCostUsd: number;
  facts: CausalFactRecord[];
}

const GENESIS_HASH = "0".repeat(64);

function computeFactHash(seq: number, prevHash: string, input: CausalFactInput): string {
  const canonical = JSON.stringify({ seq, prevHash, ...input });
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

function formatShortTime(iso: string): string {
  // 提取 MM-DD HH:mm:ss 紧凑可读时间戳（若输入非标准 ISO 则原样截取）
  const m = /^(\d{4})-(\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? `${m[2]} ${m[3]}` : iso.slice(0, 19);
}

export class CausalLedger {
  readonly logFilePath: string;
  private facts: CausalFactRecord[] = [];
  private rounds = new Map<string, RoundTraceProjection>();

  constructor(storageDir: string, fileName = "causal-ledger.jsonl") {
    const resolvedDir = path.resolve(storageDir);
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
    this.logFilePath = path.join(resolvedDir, fileName);
    this.rebuildProjection();
  }

  /** 当前已持久化的事实总条数（高水位游标） */
  get cursor(): number {
    return this.facts.length;
  }

  /** 获取最新一条事实的防篡改链哈希 */
  get headHash(): string {
    return this.facts.length > 0 ? this.facts[this.facts.length - 1]!.hash : GENESIS_HASH;
  }

  /**
   * 原子追加一条事实并同步刷盘（fsync），写盘确认成功后才更新内存投影并返回记录。
   */
  append(input: CausalFactInput): CausalFactRecord {
    const roundId = String(input.roundId ?? "").trim();
    if (!roundId) {
      throw new Error("CausalLedger.append requires a non-empty roundId.");
    }
    const at = String(input.at ?? "").trim();
    if (!at) {
      throw new Error("CausalLedger.append requires an explicit timestamp 'at'.");
    }

    const normalizedInput: CausalFactInput = {
      ...input,
      roundId,
      at,
    };

    const seq = this.facts.length + 1;
    const prevHash = this.headHash;
    const hash = computeFactHash(seq, prevHash, normalizedInput);
    const record: CausalFactRecord = {
      seq,
      prevHash,
      hash,
      ...normalizedInput,
    };

    const line = `${JSON.stringify(record)}\n`;
    const fd = fs.openSync(this.logFilePath, "a", 0o600);
    try {
      fs.writeSync(fd, line, undefined, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    this.facts.push(record);
    this.evolveRound(record);
    return record;
  }

  /**
   * 从磁盘 JSONL 事实日志从头重算全部内存投影，并校验序号连续性与哈希链完整性。
   */
  rebuildProjection(): { factCount: number; roundCount: number } {
    this.facts = [];
    this.rounds.clear();

    if (!fs.existsSync(this.logFilePath)) {
      return { factCount: 0, roundCount: 0 };
    }

    const raw = fs.readFileSync(this.logFilePath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    let expectedSeq = 1;
    let expectedPrev = GENESIS_HASH;

    for (const line of lines) {
      const parsed = JSON.parse(line) as CausalFactRecord;
      if (parsed.seq !== expectedSeq) {
        throw new Error(`CausalLedger sequence mismatch at line ${expectedSeq}: got seq=${parsed.seq}`);
      }
      if (parsed.prevHash !== expectedPrev) {
        throw new Error(`CausalLedger hash chain broken at seq=${parsed.seq}`);
      }
      const { seq, prevHash, hash, ...rest } = parsed;
      const recomputed = computeFactHash(seq, prevHash, rest);
      if (recomputed !== hash) {
        throw new Error(`CausalLedger tampered record detected at seq=${seq}`);
      }

      this.facts.push(parsed);
      this.evolveRound(parsed);
      expectedSeq++;
      expectedPrev = hash;
    }

    return { factCount: this.facts.length, roundCount: this.rounds.size };
  }

  /** 按序号增量拉取事实流（对标 `GET /v1/stream?after=<seq>`） */
  streamAfter(afterSeq = 0): CausalFactRecord[] {
    return this.facts.filter((f) => f.seq > afterSeq);
  }

  /** 查询指定轮次的结构化因果投影 */
  traceRound(roundId: string | number): RoundTraceProjection | undefined {
    const proj = this.rounds.get(String(roundId).trim());
    if (!proj) return undefined;
    return {
      ...proj,
      approvals: proj.approvals.map((a) => ({ ...a })),
      facts: [...proj.facts],
    };
  }

  /** 列出全部已记录的轮次投影（按首次触发顺序） */
  listRounds(): RoundTraceProjection[] {
    return Array.from(this.rounds.keys()).map((id) => this.traceRound(id)!);
  }

  /**
   * 生成类似 `agent-autoloop why <id>` 的高可读中文因果链溯源文本。
   */
  explainWhy(roundId: string | number): string {
    const trace = this.traceRound(roundId);
    if (!trace) {
      return `未找到第 ${String(roundId).trim()} 轮任务的因果记录。`;
    }

    const lines: string[] = [`第 ${trace.roundId} 轮 · ${trace.title || "未命名任务"}`];

    for (const f of trace.facts) {
      const ts = formatShortTime(f.at);
      switch (f.kind) {
        case "round_triggered": {
          if (f.ruleVersion !== undefined) {
            lines.push(`${ts}  规则版本 #${f.ruleVersion}${f.ruleId ? ` (${f.ruleId})` : ""}`);
          }
          const src = f.source ?? "unknown";
          const evType = f.eventType ?? "event";
          const obj = f.targetRef ? ` · 对象 ${f.targetRef}` : "";
          const hop = f.hopCount !== undefined ? ` · 跳数 ${f.hopCount}` : "";
          lines.push(`${ts}  触发事件：来源 ${src} · 类型 ${evType}${obj}${hop}`);
          break;
        }
        case "gate_evaluated": {
          const hopInfo =
            f.hopCount !== undefined
              ? `（跳数 ${f.hopCount}${f.maxHops !== undefined ? `/${f.maxHops}` : ""}）`
              : "";
          lines.push(
            `${ts}  门控判定：${f.outcome ?? "unknown"}${f.reasonCode ? ` [${f.reasonCode}]` : ""}${hopInfo}`,
          );
          break;
        }
        case "worker_claimed": {
          const roleInfo = f.modelRole ? `（角色 ${f.modelRole}）` : "";
          lines.push(`${ts}  ${f.workerId ?? "local"} 领取${roleInfo}`);
          break;
        }
        case "approval_requested": {
          lines.push(
            `${ts}  挂起拍板：#${f.approvalId ?? "?"}${f.summary ? ` · ${f.summary}` : ""}`,
          );
          break;
        }
        case "approval_decided": {
          const verdict = f.approved === false ? "驳回" : "批准";
          lines.push(
            `${ts}  人工决策：${f.decidedBy ?? "owner"} ${verdict} #${f.approvalId ?? "?"}${f.summary ? `（${f.summary}）` : ""}`,
          );
          break;
        }
        case "circuit_broken": {
          lines.push(
            `${ts}  跳数熔断：层数 ${f.hopCount ?? "?"} 超过上限 ${f.maxHops ?? 8}，已停止派活并推送告警`,
          );
          break;
        }
        case "round_completed": {
          const cost =
            f.costUsd !== undefined && f.costUsd > 0 ? `（花费 $${f.costUsd.toFixed(4)}）` : "";
          const endLabel = f.outcome === "failed" ? "失败" : f.outcome === "stopped" ? "已停止" : "结束";
          lines.push(`${ts}  ${endLabel}：${f.summary ?? "本轮完成"}${cost}`);
          break;
        }
      }
    }

    return lines.join("\n");
  }

  private evolveRound(record: CausalFactRecord): void {
    let proj = this.rounds.get(record.roundId);
    if (!proj) {
      proj = {
        roundId: record.roundId,
        title: record.title ?? "",
        status: "triggered",
        startedAt: record.at,
        updatedAt: record.at,
        hopCount: record.hopCount ?? 0,
        approvals: [],
        totalCostUsd: 0,
        facts: [],
      };
      this.rounds.set(record.roundId, proj);
    }

    proj.updatedAt = record.at;
    proj.facts.push(record);
    if (record.title) proj.title = record.title;
    if (record.ruleId !== undefined) proj.ruleId = record.ruleId;
    if (record.ruleVersion !== undefined) proj.ruleVersion = record.ruleVersion;
    if (record.source !== undefined) proj.source = record.source;
    if (record.eventType !== undefined) proj.eventType = record.eventType;
    if (record.targetRef !== undefined) proj.targetRef = record.targetRef;
    if (record.triggerId !== undefined) proj.triggerId = record.triggerId;
    if (record.hopCount !== undefined) proj.hopCount = record.hopCount;
    if (record.maxHops !== undefined) proj.maxHops = record.maxHops;
    if (record.resolvedModelId !== undefined) proj.resolvedModelId = record.resolvedModelId;
    if (record.providerPreset !== undefined) proj.providerPreset = record.providerPreset;
    if (record.goalId !== undefined) proj.goalId = record.goalId;
    if (record.informationGain !== undefined) proj.informationGain = record.informationGain;
    if (record.simAttemptRef !== undefined) proj.simAttemptRef = record.simAttemptRef;
    if (record.costUsd !== undefined && Number.isFinite(record.costUsd) && record.costUsd > 0) {
      proj.totalCostUsd = Math.round((proj.totalCostUsd + record.costUsd) * 1_000_000) / 1_000_000;
    }

    switch (record.kind) {
      case "round_triggered":
        proj.status = "triggered";
        break;
      case "gate_evaluated":
        proj.gateOutcome = record.outcome as EvalOutcomeKind | undefined;
        proj.gateReasonCode = record.reasonCode;
        proj.status = record.outcome === "halt_circuit_breaker" ? "circuit_broken" : "evaluated";
        break;
      case "worker_claimed":
        proj.workerId = record.workerId;
        proj.modelRole = record.modelRole;
        proj.status = "running";
        break;
      case "approval_requested":
        proj.status = "waiting_approval";
        proj.approvals.push({
          approvalId: record.approvalId ?? `ap-${record.seq}`,
          requestedAt: record.at,
          ...(record.summary ? { summary: record.summary } : {}),
        });
        break;
      case "approval_decided": {
        const hit = [...proj.approvals]
          .reverse()
          .find((a) => !record.approvalId || a.approvalId === record.approvalId);
        if (hit) {
          hit.decidedAt = record.at;
          hit.approved = record.approved ?? true;
          if (record.decidedBy) hit.decidedBy = record.decidedBy;
        }
        proj.status = record.approved === false ? "failed" : "running";
        break;
      }
      case "circuit_broken":
        proj.status = "circuit_broken";
        proj.finalSummary = record.summary ?? "Circuit breaker halted dispatch";
        break;
      case "round_completed":
        proj.status = record.outcome === "failed" ? "failed" : "completed";
        if (record.summary) proj.finalSummary = record.summary;
        break;
    }
  }
}
