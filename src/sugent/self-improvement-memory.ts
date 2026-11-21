/**
 * 自我改进记忆账本（Sugent Self-Improvement Memory / SIM，src/sugent/self-improvement-memory.ts）
 *
 * 借鉴 Google 论文 arXiv:2611.18856（Continual Recursive Self-Improvement）：
 * 1. 严格隔离：本记忆仅注入外环演化器（self-evolution / memory-gardener / steward），不污染日常任务上下文；
 * 2. 问题簇分组：按 Recurring Harness Problem（c_i）归档改动动机、假设、预期-实测偏差与模型出处；
 * 3. BYOK 跨模型留存：按 interface_invariant / threshold_tunable / model_specific 分级，
 *    切换模型时保留接口不变量，仅将脆弱条目标为 needs_revalidation；
 * 4. 外科手术隔离：连续驳回或通过率退化时仅生成单件隔离决策并同步立碑，保留失败历史防重犯。
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelRole, PersonalSourceKindId } from "./types.js";

export type SimArtifactKind = "skill_md" | "proactive_rule" | "cordis_plugin" | "role_prompt";
export type SimPortabilityClass = "interface_invariant" | "threshold_tunable" | "model_specific";
export type SimRevalidationStatus = "verified" | "needs_revalidation" | "quarantined" | "reverted";

export interface SimProvenanceContext {
  modelRole: ModelRole;
  resolvedModelId: string;
  providerPreset?: string;
  sourceKind?: PersonalSourceKindId;
  ruleVersion?: number;
}

export interface SimOutcomeDelta {
  predictedOutcomes: string[];
  fixed: string[];
  missed: string[];
  baselinePassRate?: number;
  postEditPassRate?: number;
  ownerRejectedCount: number;
  regressionDetected: boolean;
}

export interface SimEditAttempt {
  attemptId: string;
  roundId: string;
  atIso: string;
  artifactKind: SimArtifactKind;
  artifactPathOrId: string;
  portabilityClass: SimPortabilityClass;
  rationale: string;
  hypothesis: string;
  accepted: boolean;
  revalidationStatus: SimRevalidationStatus;
  outcomeDelta: SimOutcomeDelta;
  provenance: SimProvenanceContext;
  carriedFromAttemptId?: string;
}

export interface SimProblemCluster {
  problemId: string;
  title: string;
  aliases: string[];
  openedAtIso: string;
  attempts: SimEditAttempt[];
}

export interface RegressionDecision {
  shouldQuarantine: boolean;
  artifactKind: SimArtifactKind;
  artifactPathOrId: string;
  reason: string;
  tombstoneStatement: string;
}

interface SimStorePayload {
  version: 1;
  updatedAtIso: string;
  clusters: SimProblemCluster[];
}

function cloneAttempt(a: SimEditAttempt): SimEditAttempt {
  return {
    ...a,
    outcomeDelta: {
      ...a.outcomeDelta,
      predictedOutcomes: [...a.outcomeDelta.predictedOutcomes],
      fixed: [...a.outcomeDelta.fixed],
      missed: [...a.outcomeDelta.missed],
    },
    provenance: { ...a.provenance },
  };
}

function cloneCluster(c: SimProblemCluster): SimProblemCluster {
  return {
    ...c,
    aliases: [...c.aliases],
    attempts: c.attempts.map(cloneAttempt),
  };
}

function normalizeTitleKey(title: string): string {
  return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

export class SugentSIMStore {
  readonly filePath: string;
  private clusters: SimProblemCluster[] = [];
  private updatedAtIso = "";

  constructor(dataDir: string, fileName = "self-evolution-sim.json") {
    const resolvedDir = path.resolve(dataDir);
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
    this.filePath = path.join(resolvedDir, fileName);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<SimStorePayload>;
      this.updatedAtIso = typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : "";
      this.clusters = Array.isArray(parsed.clusters) ? parsed.clusters.map(cloneCluster) : [];
    } catch {
      this.clusters = [];
    }
  }

  private save(nowIso?: string): void {
    this.updatedAtIso = nowIso ?? new Date().toISOString();
    const payload: SimStorePayload = {
      version: 1,
      updatedAtIso: this.updatedAtIso,
      clusters: this.clusters,
    };
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.filePath);
  }

  listClusters(): SimProblemCluster[] {
    return this.clusters.map(cloneCluster);
  }

  getQuarantinedIds(): Set<string> {
    const out = new Set<string>();
    for (const cluster of this.clusters) {
      for (const att of cluster.attempts) {
        if (att.revalidationStatus === "quarantined") out.add(att.artifactPathOrId);
      }
    }
    return out;
  }

  recordAttempt(clusterInput: Pick<SimProblemCluster, "problemId" | "title">, attempt: SimEditAttempt): SimProblemCluster {
    const normTitle = normalizeTitleKey(clusterInput.title);
    let target =
      this.clusters.find((c) => c.problemId === clusterInput.problemId || c.aliases.includes(clusterInput.problemId)) ??
      this.clusters.find((c) => normTitle && normalizeTitleKey(c.title) === normTitle);

    if (!target) {
      target = {
        problemId: clusterInput.problemId,
        title: clusterInput.title,
        aliases: [],
        openedAtIso: attempt.atIso,
        attempts: [],
      };
      this.clusters.push(target);
    } else if (target.problemId !== clusterInput.problemId && !target.aliases.includes(clusterInput.problemId)) {
      target.aliases.push(clusterInput.problemId);
    }
    target.attempts.push(cloneAttempt(attempt));
    this.save(attempt.atIso);
    return cloneCluster(target);
  }

  reconcileRoundOutcome(roundId: string, observed: Partial<SimOutcomeDelta>, atIso?: string): SimEditAttempt | undefined {
    for (const cluster of this.clusters) {
      const hit = [...cluster.attempts].reverse().find((a) => a.roundId === roundId);
      if (!hit) continue;
      if (observed.fixed) hit.outcomeDelta.fixed = [...observed.fixed];
      if (observed.missed) hit.outcomeDelta.missed = [...observed.missed];
      if (observed.postEditPassRate !== undefined) hit.outcomeDelta.postEditPassRate = observed.postEditPassRate;
      if (observed.ownerRejectedCount !== undefined) hit.outcomeDelta.ownerRejectedCount = observed.ownerRejectedCount;
      if (observed.regressionDetected !== undefined) hit.outcomeDelta.regressionDetected = observed.regressionDetected;
      this.save(atIso);
      return cloneAttempt(hit);
    }
    return undefined;
  }

  flagOnModelSwitch(role: ModelRole, prevModelId: string, nextModelId: string, atIso?: string): SimEditAttempt[] {
    if (!prevModelId || prevModelId === nextModelId) return [];
    const flagged: SimEditAttempt[] = [];
    for (const cluster of this.clusters) {
      for (const att of cluster.attempts) {
        if (
          att.provenance.modelRole === role &&
          att.provenance.resolvedModelId === prevModelId &&
          att.revalidationStatus === "verified" &&
          att.portabilityClass !== "interface_invariant"
        ) {
          att.revalidationStatus = "needs_revalidation";
          flagged.push(cloneAttempt(att));
        }
      }
    }
    if (flagged.length > 0) this.save(atIso);
    return flagged;
  }

  evaluateRegression(attemptId: string, atIso?: string): RegressionDecision | undefined {
    for (const cluster of this.clusters) {
      const att = cluster.attempts.find((a) => a.attemptId === attemptId);
      if (!att) continue;
      const d = att.outcomeDelta;
      const rateDrop =
        d.baselinePassRate !== undefined && d.postEditPassRate !== undefined && d.postEditPassRate < d.baselinePassRate - 0.05;
      const shouldQuarantine = d.regressionDetected || d.ownerRejectedCount >= 2 || rateDrop;
      if (!shouldQuarantine) return undefined;
      att.revalidationStatus = "quarantined";
      this.save(atIso);
      const reason = d.ownerRejectedCount >= 2 ? "主人连续驳回" : rateDrop ? "通过率显著回退" : "检测到行为回归";
      return {
        shouldQuarantine: true,
        artifactKind: att.artifactKind,
        artifactPathOrId: att.artifactPathOrId,
        reason,
        tombstoneStatement: `[${cluster.problemId}] 禁止复用导致退化的改动(${att.artifactPathOrId})：${att.rationale}（原因：${reason}，原模型：${att.provenance.resolvedModelId}）`,
      };
    }
    return undefined;
  }

  buildOptimizerPromptJson(maxClusters = 12): string {
    return JSON.stringify(this.clusters.slice(-Math.max(1, maxClusters)));
  }
}