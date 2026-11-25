import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CoworkFederationConfig, CoworkPendingDraftPayload } from "./cowork-bridge.js";
import { sealExternalEvent } from "./security-envelope.js";
import type { StewardshipLedger } from "./stewardship-ledger.js";

export type WeaponPackageId = "industrial-fde-diagnostics" | "opc-contract-quote-guard";

export interface WeaponPackageManifest {
  readonly id: WeaponPackageId;
  readonly name: string;
  readonly version: string;
  readonly targetPersona: "industrial_fde" | "opc_trade_studio";
  readonly summary: string;
  readonly externalIngressSource: "mes_erp_export" | "contract_pdf_drop";
  readonly requiresHumanStagingGate: true;
  readonly soakSla: {
    readonly targetDays: number;
    readonly maxUnauthorizedIncidents: number;
  };
}

export const BUILTIN_WEAPON_PACKAGES: Readonly<Record<WeaponPackageId, WeaponPackageManifest>> =
  Object.freeze({
    "industrial-fde-diagnostics": Object.freeze({
      id: "industrial-fde-diagnostics",
      name: "工业现场 FDE 异常诊断与精益数智交付包",
      version: "1.0.0",
      targetPersona: "industrial_fde",
      summary:
        "端侧密封 MES/ERP 异常导出批次，确定性执行精益停机帕累托、SLA 超期与重复热点工位校验，并生成 Cowork Staging 待审三元组与手机审批卡。",
      externalIngressSource: "mes_erp_export",
      requiresHumanStagingGate: true,
      soakSla: Object.freeze({ targetDays: 14, maxUnauthorizedIncidents: 0 }),
    }),
    "opc-contract-quote-guard": Object.freeze({
      id: "opc-contract-quote-guard",
      name: "一人公司 / 外贸工作室合同与报价防漏审校包",
      version: "1.0.0",
      targetPersona: "opc_trade_studio",
      summary:
        "端侧密封询盘/合同文本，对照本地五维账本历史底价、最长账期与证伪墓碑核验条款风险，生成红线差异卡推送主理人拍板。",
      externalIngressSource: "contract_pdf_drop",
      requiresHumanStagingGate: true,
      soakSla: Object.freeze({ targetDays: 14, maxUnauthorizedIncidents: 0 }),
    }),
  });

export function listWeaponPackages(): WeaponPackageManifest[] {
  return [
    BUILTIN_WEAPON_PACKAGES["industrial-fde-diagnostics"],
    BUILTIN_WEAPON_PACKAGES["opc-contract-quote-guard"],
  ];
}

export type DiagnosticSeverity = "P0" | "P1" | "P2";

export interface IndustrialExceptionRecord {
  ticketId: string;
  station: string;
  category: string;
  downtimeMinutes: number;
  slaHoursLimit: number;
  elapsedHours: number;
  description: string;
  rawExtra?: Record<string, unknown>;
}

export interface ParetoBucket {
  key: string;
  ticketCount: number;
  totalDowntimeMinutes: number;
  slaBreachCount: number;
  shareOfDowntimePct: number;
  isHotspot: boolean;
}

export interface ProposedOntologyTriple {
  subject: string;
  predicate: string;
  object: string;
  occurrence_count: number;
  ticket_ids: string[];
}

export interface IndustrialFdeDiagnosticResult {
  packId: "industrial-fde-diagnostics";
  batchId: string;
  evaluatedAt: string;
  severity: DiagnosticSeverity;
  envelope: {
    contextFile: string;
    absoluteFilePath: string;
    sha256: string;
    strippedFields?: string[];
  };
  summary: {
    totalRecords: number;
    totalDowntimeMinutes: number;
    missingFieldCount: number;
    slaBreachCount: number;
    highImpactDowntimeCount: number;
    hotspotStations: string[];
  };
  pareto: {
    byStation: ParetoBucket[];
    byCategory: ParetoBucket[];
  };
  executiveBriefMarkdown: string;
  coworkDraft: CoworkPendingDraftPayload & {
    draft_id: string;
    workspace_id: string;
    status: "PENDING_REVIEW";
    is_schema_valid: boolean;
    factuality_score: number;
    proposed_triples: ProposedOntologyTriple[];
  };
  stagingCardText: string;
  federationConfigUsed?: Partial<CoworkFederationConfig>;
}

function sanitizeToken(raw: string): string {
  const clean = raw.trim().replace(/[^A-Za-z0-9._-]+/g, "_");
  return clean || "batch";
}

function hoistExtraKeys(records: readonly IndustrialExceptionRecord[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of records) {
    if (!r.rawExtra || typeof r.rawExtra !== "object") continue;
    for (const [k, v] of Object.entries(r.rawExtra)) {
      if (!(k in out)) out[k] = v;
    }
  }
  return out;
}

export function runIndustrialFdeDiagnosticPack(input: {
  workspaceDir: string;
  batchId: string;
  records: IndustrialExceptionRecord[];
  coworkWorkspaceId?: string;
  proposerId?: string;
  nowIso?: string;
}): IndustrialFdeDiagnosticResult {
  const evaluatedAt = input.nowIso ?? new Date().toISOString();
  const safeBatch = sanitizeToken(input.batchId);

  const sealed = sealExternalEvent({
    workspaceDir: input.workspaceDir,
    source: "mes_erp_export",
    eventType: "industrial_exception_batch",
    eventId: safeBatch,
    title: `MES/ERP Batch ${input.batchId}`,
    body: JSON.stringify(
      input.records.map((r) => ({
        ticketId: r.ticketId,
        station: r.station,
        category: r.category,
        downtimeMinutes: r.downtimeMinutes,
        slaHoursLimit: r.slaHoursLimit,
        elapsedHours: r.elapsedHours,
        description: r.description,
      })),
    ),
    payload: {
      ...hoistExtraKeys(input.records),
      batchId: input.batchId,
      recordCount: input.records.length,
    },
    privilegedFieldMode: "strip",
  });

  const stationCounts = new Map<string, number>();
  for (const r of input.records) {
    const st = r.station.trim();
    if (st) stationCounts.set(st, (stationCounts.get(st) ?? 0) + 1);
  }
  const hotspotStations = Array.from(stationCounts.entries())
    .filter(([, count]) => count >= 2)
    .map(([st]) => st)
    .sort();

  let totalDowntimeMinutes = 0;
  let missingFieldCount = 0;
  let slaBreachCount = 0;
  let highImpactDowntimeCount = 0;
  let batchSeverity: DiagnosticSeverity = "P2";

  const stationAgg = new Map<string, { count: number; downtime: number; sla: number; missing: boolean }>();
  const catAgg = new Map<string, { count: number; downtime: number; sla: number; missing: boolean }>();
  const tripleMap = new Map<string, ProposedOntologyTriple>();

  for (const r of input.records) {
    const st = r.station.trim();
    const cat = r.category.trim();
    const missing = !st || !cat;
    if (missing) missingFieldCount += 1;

    const dt = Number.isFinite(r.downtimeMinutes) && r.downtimeMinutes > 0 ? r.downtimeMinutes : 0;
    totalDowntimeMinutes += dt;

    const slaBreached =
      Number.isFinite(r.elapsedHours) &&
      Number.isFinite(r.slaHoursLimit) &&
      r.slaHoursLimit > 0 &&
      r.elapsedHours > r.slaHoursLimit;
    if (slaBreached) slaBreachCount += 1;

    const highImpact = dt >= 60;
    if (highImpact) highImpactDowntimeCount += 1;

    const isHotspot = Boolean(st && (stationCounts.get(st) ?? 0) >= 2);
    if (highImpact || (slaBreached && isHotspot)) {
      batchSeverity = "P0";
    } else if ((slaBreached || isHotspot || missing) && batchSeverity !== "P0") {
      batchSeverity = "P1";
    }

    const stKey = st || "(MISSING_STATION)";
    const curSt = stationAgg.get(stKey) ?? { count: 0, downtime: 0, sla: 0, missing: !st };
    curSt.count += 1;
    curSt.downtime += dt;
    if (slaBreached) curSt.sla += 1;
    stationAgg.set(stKey, curSt);

    const catKey = cat || "(MISSING_CATEGORY)";
    const curCat = catAgg.get(catKey) ?? { count: 0, downtime: 0, sla: 0, missing: !cat };
    curCat.count += 1;
    curCat.downtime += dt;
    if (slaBreached) curCat.sla += 1;
    catAgg.set(catKey, curCat);

    if (st && cat) {
      const tKey = `${st}|has_recurring_anomaly|${cat}`;
      const existing = tripleMap.get(tKey);
      if (existing) {
        existing.occurrence_count += 1;
        existing.ticket_ids.push(r.ticketId);
      } else {
        tripleMap.set(tKey, {
          subject: `station:${st}`,
          predicate: "exhibits_exception_category",
          object: `category:${cat}`,
          occurrence_count: 1,
          ticket_ids: [r.ticketId],
        });
      }
    }
  }

  const toPareto = (
    agg: Map<string, { count: number; downtime: number; sla: number; missing: boolean }>,
  ): ParetoBucket[] =>
    Array.from(agg.entries())
      .sort((a, b) => b[1].downtime - a[1].downtime || b[1].count - a[1].count)
      .map(([key, val]) => ({
        key,
        ticketCount: val.count,
        totalDowntimeMinutes: val.downtime,
        slaBreachCount: val.sla,
        shareOfDowntimePct:
          totalDowntimeMinutes > 0
            ? Math.round((val.downtime / totalDowntimeMinutes) * 10000) / 100
            : 0,
        isHotspot: !val.missing && val.count >= 2,
      }));

  const byStation = toPareto(stationAgg);
  const byCategory = toPareto(catAgg);
  const isSchemaValid = input.records.length > 0 && missingFieldCount === 0;
  const factualityScore =
    input.records.length === 0
      ? 0
      : Math.max(
          0,
          Math.round(((input.records.length - missingFieldCount) / input.records.length) * 100) /
            100,
        );

  const executiveBriefMarkdown = [
    `# 工业现场 FDE 异常诊断简报（批次 ${input.batchId}）`,
    `- 最高等级：**${batchSeverity}** | 总停机：**${totalDowntimeMinutes} 分钟** | SLA 超期：**${slaBreachCount} 单**`,
    `- 重复异常热点工位：${hotspotStations.length > 0 ? hotspotStations.join("、") : "无"}`,
    `- 数据完整性：缺失关键字段 ${missingFieldCount} 单（Schema 校验=${isSchemaValid ? "PASS" : "WARN"}）`,
  ].join("\n");

  const stagingCardText = [
    `【FDE 诊断待签批 · ${batchSeverity}】批次 ${input.batchId}`,
    `共 ${input.records.length} 单异常，累计停机 ${totalDowntimeMinutes} 分钟，SLA 超期 ${slaBreachCount} 单。`,
    `热点工位：${hotspotStations.join("、") || "无"}（待审本体三元组 ${tripleMap.size} 条）`,
  ].join("\n");

  return {
    packId: "industrial-fde-diagnostics",
    batchId: input.batchId,
    evaluatedAt,
    severity: batchSeverity,
    envelope: sealed.envelope,
    summary: {
      totalRecords: input.records.length,
      totalDowntimeMinutes,
      missingFieldCount,
      slaBreachCount,
      highImpactDowntimeCount,
      hotspotStations,
    },
    pareto: { byStation, byCategory },
    executiveBriefMarkdown,
    coworkDraft: {
      draft_id: `fde-draft-${safeBatch}`,
      workspace_id: input.coworkWorkspaceId ?? "ws-industrial-fde",
      proposer_id: input.proposerId ?? "sugent-edge-fde",
      status: "PENDING_REVIEW",
      title: `FDE Exception Ontology Draft (${input.batchId})`,
      summary: stagingCardText,
      is_schema_valid: isSchemaValid,
      factuality_score: factualityScore,
      proposed_triples: Array.from(tripleMap.values()),
      created_at: evaluatedAt,
    },
    stagingCardText,
  };
}

export interface RedlineDiffCard {
  packId: "opc-contract-quote-guard";
  inquiryId: string;
  counterparty: string;
  verdict: "pass" | "warn" | "block";
  triggeredGuardrails: string[];
  floorPriceBreach?: {
    quoted: number;
    floor: number;
    deltaPct: number;
  };
  paymentTermBreach?: {
    requestedDays: number;
    maxAllowedDays: number;
  };
  ownerApprovalPrompt: string;
  envelopePath: string;
}

function hasUnnegatedClause(text: string, clausePattern: RegExp): boolean {
  const globalRe = new RegExp(clausePattern.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = globalRe.exec(text)) !== null) {
    const prefix = text.slice(Math.max(0, match.index - 12), match.index);
    if (!/(?:不承担|不接受|不涉及|不含|免除|排除|无|not\s+assume|no\s+|exclude)/i.test(prefix)) {
      return true;
    }
  }
  return false;
}

export function runContractQuoteGuardPack(input: {
  workspaceDir: string;
  inquiryId: string;
  counterparty: string;
  rawContractText: string;
  quotedUnitPrice?: number;
  requestedPaymentDays?: number;
  ledger: Pick<StewardshipLedger, "snapshotForCaller" | "queryContext">;
  nowIso?: string;
}): RedlineDiffCard {
  const safeId = sanitizeToken(input.inquiryId);
  const sealed = sealExternalEvent({
    workspaceDir: input.workspaceDir,
    source: "contract_pdf_drop",
    eventType: "contract_quote_review",
    eventId: safeId,
    title: `Contract Review ${input.inquiryId} (${input.counterparty})`,
    body: input.rawContractText,
    payload: {
      inquiryId: input.inquiryId,
      counterparty: input.counterparty,
      ...(input.quotedUnitPrice !== undefined ? { quotedUnitPrice: input.quotedUnitPrice } : {}),
      ...(input.requestedPaymentDays !== undefined
        ? { requestedPaymentDays: input.requestedPaymentDays }
        : {}),
    },
    privilegedFieldMode: "strip",
  });

  const snap = input.ledger.snapshotForCaller("owner_private");
  const ctx = input.ledger.queryContext(input.counterparty, "owner_private");

  let floorPrice: number | null = null;
  let maxPaymentDays: number | null = null;

  for (const res of [...ctx.resources, ...snap.resources]) {
    const metaCp = typeof res.metadata.counterparty === "string" ? res.metadata.counterparty : "";
    if (metaCp && metaCp !== input.counterparty && !res.title.includes(input.counterparty)) {
      continue;
    }
    if (floorPrice === null && typeof res.metadata.floorPrice === "number") {
      floorPrice = res.metadata.floorPrice;
    }
    if (maxPaymentDays === null && typeof res.metadata.maxPaymentDays === "number") {
      maxPaymentDays = res.metadata.maxPaymentDays;
    }
  }

  let effectiveDays = input.requestedPaymentDays;
  if (effectiveDays === undefined) {
    const m = /(?:账期|验收后|Net)\s*(\d+)\s*(?:天|日)?/i.exec(input.rawContractText);
    if (m?.[1]) effectiveDays = Number(m[1]);
  }

  const triggeredGuardrails: string[] = [];
  let floorPriceBreach: RedlineDiffCard["floorPriceBreach"];
  let paymentTermBreach: RedlineDiffCard["paymentTermBreach"];
  let hasHardBlock = false;

  if (
    floorPrice !== null &&
    floorPrice > 0 &&
    input.quotedUnitPrice !== undefined &&
    input.quotedUnitPrice < floorPrice
  ) {
    const deltaPct =
      Math.round(((input.quotedUnitPrice - floorPrice) / floorPrice) * 10000) / 100;
    floorPriceBreach = { quoted: input.quotedUnitPrice, floor: floorPrice, deltaPct };
    triggeredGuardrails.push(
      `报价低于历史底价：当前 ${input.quotedUnitPrice} < 底价 ${floorPrice}（${deltaPct}%）`,
    );
    hasHardBlock = true;
  }

  if (maxPaymentDays !== null && effectiveDays !== undefined && effectiveDays > maxPaymentDays) {
    paymentTermBreach = { requestedDays: effectiveDays, maxAllowedDays: maxPaymentDays };
    triggeredGuardrails.push(
      `账期超出历史上限：要求 ${effectiveDays} 天 > 允许上限 ${maxPaymentDays} 天`,
    );
    hasHardBlock = true;
  }

  if (hasUnnegatedClause(input.rawContractText, /无限连带责任|unlimited\s+joint\s+and\s+several\s+liability/)) {
    triggeredGuardrails.push("命中高危法务红线：无限连带责任条款");
    hasHardBlock = true;
  }
  if (hasUnnegatedClause(input.rawContractText, /排他知识产权转让|exclusive\s+intellectual\s+property\s+assignment/)) {
    triggeredGuardrails.push("命中高危法务红线：排他知识产权转让条款");
    hasHardBlock = true;
  }

  for (const gr of snap.guardrails) {
    if (gr.kind !== "hard_redline" && gr.kind !== "tombstone") continue;
    for (const kw of ["零首付", "背靠背", "驻场包干", "源码买断"]) {
      if (gr.statement.includes(kw) && hasUnnegatedClause(input.rawContractText, new RegExp(kw))) {
        triggeredGuardrails.push(`命中账本价值红线：${gr.statement}`);
        if (gr.kind === "hard_redline") hasHardBlock = true;
      }
    }
  }

  for (const rel of ctx.relationships) {
    if (rel.name !== input.counterparty && !input.counterparty.includes(rel.name)) continue;
    for (const taboo of rel.taboos) {
      const core = taboo.replace(/^(?:禁止|切忌|不要接受)/, "").trim();
      if (core.length >= 2 && hasUnnegatedClause(input.rawContractText, new RegExp(core.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))) {
        triggeredGuardrails.push(`触碰交易对手历史禁忌：${taboo}`);
      }
    }
  }

  const verdict: RedlineDiffCard["verdict"] = hasHardBlock
    ? "block"
    : triggeredGuardrails.length > 0
      ? "warn"
      : "pass";

  const ownerApprovalPrompt =
    verdict === "pass"
      ? `【合同审校通过】${input.counterparty}（${input.inquiryId}）未触发底价与法务红线，可推进签章。`
      : `【合同红线拦截 · ${verdict.toUpperCase()}】${input.counterparty}（${input.inquiryId}）触发 ${triggeredGuardrails.length} 项风险：${triggeredGuardrails.join("；")}。请主理人复核拍板。`;

  return {
    packId: "opc-contract-quote-guard",
    inquiryId: input.inquiryId,
    counterparty: input.counterparty,
    verdict,
    triggeredGuardrails,
    ...(floorPriceBreach ? { floorPriceBreach } : {}),
    ...(paymentTermBreach ? { paymentTermBreach } : {}),
    ownerApprovalPrompt,
    envelopePath: sealed.envelope.absoluteFilePath,
  };
}

export interface WeaponPackRunEvent {
  packId: WeaponPackageId;
  dateKey: string;
  minutesSaved: number;
  baselineFlagshipUsd: number;
  actualRoutedUsd: number;
  redlinesCaught: number;
  unauthorizedIncident?: boolean;
}

export interface CommercialProofSummary {
  targetSoakDays: number;
  distinctActiveDays: number;
  soakTargetMet: boolean;
  totalRuns: number;
  totalMinutesSaved: number;
  totalHoursSaved: number;
  baselineFlagshipUsd: number;
  actualRoutedUsd: number;
  costSavingsRatio: number;
  totalRedlinesCaught: number;
  unauthorizedIncidents: number;
  markdownReport: string;
}

interface PersistedSoakFile {
  version: 1;
  events: WeaponPackRunEvent[];
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class WeaponSoakTelemetryLedger {
  private readonly filePath: string;
  private readonly events: WeaponPackRunEvent[] = [];

  public constructor(dataDir: string) {
    if (!dataDir || !dataDir.trim()) {
      throw new RangeError("dataDir must be a non-empty string");
    }
    this.filePath = path.join(dataDir.trim(), "sugent-weapons", "soak-telemetry.json");
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<PersistedSoakFile>;
    if (Array.isArray(parsed.events)) {
      this.events.push(...parsed.events);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const body = `${JSON.stringify({ version: 1, events: this.events }, null, 2)}\n`;
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.filePath);
  }

  public recordPackRun(event: WeaponPackRunEvent): void {
    if (!BUILTIN_WEAPON_PACKAGES[event.packId]) {
      throw new RangeError(`Unknown packId: ${String(event.packId)}`);
    }
    if (!DATE_KEY_RE.test(event.dateKey)) {
      throw new RangeError(`Invalid dateKey (expected YYYY-MM-DD): ${event.dateKey}`);
    }
    if (
      event.minutesSaved < 0 ||
      event.baselineFlagshipUsd < 0 ||
      event.actualRoutedUsd < 0 ||
      event.redlinesCaught < 0
    ) {
      throw new RangeError("Soak telemetry metrics must be non-negative");
    }
    this.events.push({ ...event, unauthorizedIncident: Boolean(event.unauthorizedIncident) });
    this.save();
  }

  public exportCommercialProofSummary(targetSoakDays = 14): CommercialProofSummary {
    if (!Number.isFinite(targetSoakDays) || targetSoakDays <= 0) {
      throw new RangeError("targetSoakDays must be > 0");
    }
    const days = new Set(this.events.map((e) => e.dateKey));
    const totalMinutesSaved = this.events.reduce((s, e) => s + e.minutesSaved, 0);
    const baselineUsd = this.events.reduce((s, e) => s + e.baselineFlagshipUsd, 0);
    const actualUsd = this.events.reduce((s, e) => s + e.actualRoutedUsd, 0);
    const totalRedlinesCaught = this.events.reduce((s, e) => s + e.redlinesCaught, 0);
    const unauthorizedIncidents = this.events.filter((e) => e.unauthorizedIncident).length;

    const distinctActiveDays = days.size;
    const soakTargetMet =
      distinctActiveDays >= targetSoakDays && unauthorizedIncidents === 0;
    const totalHoursSaved = Math.round((totalMinutesSaved / 60) * 100) / 100;
    const costSavingsRatio =
      baselineUsd > 0 ? Math.max(0, (baselineUsd - actualUsd) / baselineUsd) : 0;

    const markdownReport = [
      `## Sugent Open-Core 实盘常驻压测证明（${soakTargetMet ? "PASS" : "IN_PROGRESS / VETOED"}）`,
      `- 活跃常驻天数：**${distinctActiveDays} / ${targetSoakDays} 天**`,
      `- 累计执行批次：**${this.events.length} 次** | 累计节省看护工时：**${totalHoursSaved} 小时**`,
      `- 自适应模型路由省钱比例：**${Math.round(costSavingsRatio * 1000) / 10}%**（$${actualUsd.toFixed(2)} vs 全旗舰基线 $${baselineUsd.toFixed(2)}）`,
      `- 拦截业务/法务红线：**${totalRedlinesCaught} 次** | 越权事故：**${unauthorizedIncidents} 起**`,
    ].join("\n");

    return {
      targetSoakDays,
      distinctActiveDays,
      soakTargetMet,
      totalRuns: this.events.length,
      totalMinutesSaved,
      totalHoursSaved,
      baselineFlagshipUsd: Math.round(baselineUsd * 10000) / 10000,
      actualRoutedUsd: Math.round(actualUsd * 10000) / 10000,
      costSavingsRatio,
      totalRedlinesCaught,
      unauthorizedIncidents,
      markdownReport,
    };
  }
}
