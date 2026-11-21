import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSugentGatewayConfig } from "../src/sugent/gateway.js";
import { SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import type { SugentGatewayConfig } from "../src/sugent/types.js";
import {
  UniversalDropzone,
  classifyDropzoneIntent,
  type DropzoneCallerDomain,
  type DropzoneLedgerPort,
  type DropzonePartition,
} from "../src/sugent/universal-dropzone.js";

interface StoredRel {
  id: string;
  partition: DropzonePartition;
  name: string;
  taboos: string[];
  preferences: string[];
  openFavors: string[];
}
interface StoredGoal {
  id: string;
  partition: DropzonePartition;
  title: string;
  northStarCriterion: string;
  status: string;
}
interface StoredGuardrail {
  id: string;
  partition: DropzonePartition;
  kind: "hard_redline" | "tombstone" | "soft_taste";
  statement: string;
  enforcement: string;
  evidenceSource?: string;
}
interface StoredCommitment {
  id: string;
  partition: DropzonePartition;
  direction: "i_owe" | "waiting_for" | "expiring";
  status: "open" | "snoozed" | "waiting_review" | "closed" | "superseded";
  summary: string;
  counterpartyOrRef: string;
  dueAt?: string;
  remindLeadDays?: number;
  updatedAt: string;
}
interface StoredResource {
  id: string;
  partition: DropzonePartition;
  kind: "time_window" | "personal_archive" | "budget_cap" | "specialist_agent";
  title: string;
  localUriOrPath?: string;
  expiresAt?: string;
  metadata: Record<string, string | number | boolean>;
}

function visiblePartitions(domain: DropzoneCallerDomain = "owner_private"): Set<DropzonePartition> {
  if (domain === "owner_private") return new Set(["personal_life", "work_project", "cowork_shared"]);
  if (domain === "work_project") return new Set(["work_project", "cowork_shared"]);
  return new Set(["cowork_shared"]);
}

function matchesQueryText(query: string, hay: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const h = hay.toLowerCase();
  if (h.includes(q)) return true;
  const ascii = q.match(/[a-z0-9_-]{2,}/g) ?? [];
  if (ascii.some((t) => h.includes(t))) return true;
  const han = Array.from(q).filter((c) => /\p{Script=Han}/u.test(c));
  for (let i = 0; i + 1 < han.length; i++) {
    if (h.includes(han[i]! + han[i + 1]!)) return true;
  }
  return han.length === 1 && h.includes(han[0]!);
}
function createTestLedger(seed?: {
  relationships?: StoredRel[];
  goals?: StoredGoal[];
  guardrails?: StoredGuardrail[];
  commitments?: StoredCommitment[];
  resources?: StoredResource[];
}) {
  const relationships: StoredRel[] = [...(seed?.relationships ?? [])];
  const goals: StoredGoal[] = [...(seed?.goals ?? [])];
  const guardrails: StoredGuardrail[] = [...(seed?.guardrails ?? [])];
  const commitments: StoredCommitment[] = [...(seed?.commitments ?? [])];
  const resources: StoredResource[] = [...(seed?.resources ?? [])];
  let seq = 1;

  const port: DropzoneLedgerPort = {
    upsertCommitment(input, nowIso = "2026-11-20T10:00:00.000Z") {
      const record: StoredCommitment = {
        id: input.id ?? `commit-${seq++}`,
        partition: input.partition,
        direction: input.direction,
        status: input.status ?? "open",
        summary: input.summary,
        counterpartyOrRef: input.counterpartyOrRef,
        ...(input.dueAt ? { dueAt: input.dueAt } : {}),
        ...(input.remindLeadDays !== undefined ? { remindLeadDays: input.remindLeadDays } : {}),
        updatedAt: nowIso,
      };
      commitments.push(record);
      return record;
    },
    upsertResource(input) {
      const record: StoredResource = {
        id: input.id ?? `res-${seq++}`,
        partition: input.partition,
        kind: input.kind,
        title: input.title,
        ...(input.localUriOrPath ? { localUriOrPath: input.localUriOrPath } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        metadata: input.metadata,
      };
      resources.push(record);
      return record;
    },
    findArchiveResources(query, callerDomain = "owner_private") {
      const allowed = visiblePartitions(callerDomain);
      return resources.filter(
        (r) =>
          allowed.has(r.partition) &&
          r.kind === "personal_archive" &&
          matchesQueryText(query, `${r.title} ${r.localUriOrPath ?? ""} ${JSON.stringify(r.metadata)}`),
      );
    },
    queryContext(query, callerDomain = "owner_private") {
      const allowed = visiblePartitions(callerDomain);
      return {
        relationships: relationships.filter((r) => allowed.has(r.partition) && matchesQueryText(query, `${r.name} ${r.taboos.join(" ")}`)),
        goals: goals.filter((g) => allowed.has(g.partition) && matchesQueryText(query, `${g.title} ${g.northStarCriterion}`)),
        guardrails: guardrails.filter((gr) => allowed.has(gr.partition) && matchesQueryText(query, gr.statement)),
        commitments: commitments.filter((c) => allowed.has(c.partition) && matchesQueryText(query, `${c.summary} ${c.counterpartyOrRef}`)),
        resources: resources.filter((r) => allowed.has(r.partition) && matchesQueryText(query, `${r.title} ${r.localUriOrPath ?? ""}`)),
      };
    },
    snapshotForCaller(callerDomain = "owner_private") {
      const allowed = visiblePartitions(callerDomain);
      return {
        relationships: relationships.filter((r) => allowed.has(r.partition)),
        goals: goals.filter((g) => allowed.has(g.partition)),
        guardrails: guardrails.filter((gr) => allowed.has(gr.partition)),
      };
    },
  };

  return { port, commitments, resources };
}
const createdDirs: string[] = [];
afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const customGateway: SugentGatewayConfig = resolveSugentGatewayConfig(undefined, {
  SUGENT_GATEWAY_MODE: "byok",
  SUGENT_MODEL_ASSESSOR: "model/assessor-fast",
  SUGENT_MODEL_EXECUTOR: "model/executor-pro",
  SUGENT_MODEL_COMPUTER_USE: "model/cua-vision",
  SUGENT_MODEL_STEWARD: "model/steward-sage",
});

describe("classifyDropzoneIntent", () => {
  it("routes memos, pure file drops, lookups, trade-offs, and tasks into the four dropzone tiers", () => {
    expect(classifyDropzoneIntent({ channel: "tray_drop", text: "", filePaths: ["/tmp/passport.png"] })).toBe("capture");
    expect(classifyDropzoneIntent({ channel: "weixin", text: "记一下，车停在 B2-108" })).toBe("capture");
    expect(classifyDropzoneIntent({ channel: "weixin", text: "我答应周五前把报价发给李总" })).toBe("capture");
    expect(classifyDropzoneIntent({ channel: "desktop_hotkey", text: "去年签的协议违约金怎么算？" })).toBe("recall");
    expect(classifyDropzoneIntent({ channel: "weixin", text: "张三平时忌口是什么" })).toBe("recall");
    expect(classifyDropzoneIntent({ channel: "weixin", text: "客户要求打七折，怎么回？" })).toBe("advise");
    expect(classifyDropzoneIntent({ channel: "desktop_hotkey", text: "两个外包方案选哪个更划算？" })).toBe("advise");
    expect(classifyDropzoneIntent({ channel: "tray_drop", text: "帮我修一下这个单测报错", filePaths: ["/tmp/fail.log"] })).toBe("delegate");
    expect(classifyDropzoneIntent({ channel: "weixin", text: "帮我办理护照换证" })).toBe("delegate");
  });
});

describe("UniversalDropzone — capture & recall", () => {
  it("captures tray file drops and commitments with single-line receipt and assessor model", async () => {
    const { port, resources, commitments } = createTestLedger();
    const dz = new UniversalDropzone({ ledger: port, gatewayConfig: customGateway });

    const fileRes = await dz.handle({
      inputId: "in-1",
      channel: "tray_drop",
      text: "",
      filePaths: ["/Users/demo/archive/invoice-2026.pdf"],
      receivedAtIso: "2026-11-20T09:00:00.000Z",
    });
    expect(fileRes.intent).toBe("capture");
    if (fileRes.intent !== "capture") throw new Error("unexpected intent");
    expect(fileRes.selectedModel).toBe("model/assessor-fast");
    expect(fileRes.receiptLine).not.toContain("\n");
    expect(fileRes.receiptLine).not.toContain("？");
    expect(fileRes.storedLedgerIds).toHaveLength(1);
    expect(resources[0]?.kind).toBe("personal_archive");
    expect(resources[0]?.localUriOrPath).toBe("/Users/demo/archive/invoice-2026.pdf");

    const oweRes = await dz.handle({
      inputId: "in-2",
      channel: "weixin",
      text: "我答应周五前把方案发给李总",
      receivedAtIso: "2026-11-20T09:05:00.000Z",
    });
    expect(oweRes.intent).toBe("capture");
    if (oweRes.intent !== "capture") throw new Error("unexpected intent");
    expect(oweRes.receiptLine).not.toContain("\n");
    expect(commitments[0]?.direction).toBe("i_owe");
    expect(commitments[0]?.counterpartyOrRef).toBe("李总");

    const expRes = await dz.handle({
      inputId: "in-3",
      channel: "desktop_hotkey",
      text: "驾照 2027-06-15 到期，记一下",
      receivedAtIso: "2026-11-20T09:10:00.000Z",
    });
    expect(expRes.intent).toBe("capture");
    expect(commitments[1]?.direction).toBe("expiring");
    expect(commitments[1]?.dueAt).toBe("2027-06-15T09:00:00.000Z");
    expect(commitments[1]?.remindLeadDays).toBe(14);

    const waitRes = await dz.handle({
      inputId: "in-4",
      channel: "weixin",
      text: "等大卫回传盖章合同",
      receivedAtIso: "2026-11-20T09:15:00.000Z",
    });
    expect(waitRes.intent).toBe("capture");
    expect(commitments[2]?.direction).toBe("waiting_for");

    const noteRes = await dz.handle({
      inputId: "in-5",
      channel: "weixin",
      text: "记一下，车停在 B2-108",
      receivedAtIso: "2026-11-20T09:20:00.000Z",
    });
    expect(noteRes.intent).toBe("capture");
    expect(resources[1]?.title).toContain("B2-108");
  });
  it("recalls owner archive and knowledge graph only for owner_private, never leaking KG to work/cowork", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-dz-kg-"));
    createdDirs.push(tmpDir);
    const kg = new SugentKnowledgeGraph(tmpDir);
    kg.applyDelta({
      nodes: [
        { id: "person:zhang", kind: "person", name: "张三", summary: "合作方技术总监，忌口不吃香菜与海鲜", tags: ["vip"] },
        { id: "pref:zhang-tea", kind: "preference", name: "铁观音", summary: "私密档案：偏好清淡乌龙茶", tags: ["drink"] },
      ],
      edges: [{ from: "person:zhang", relation: "prefers_drink", to: "pref:zhang-tea", source: "memo" }],
    });
    const { port } = createTestLedger({
      resources: [
        {
          id: "res-contract-1",
          partition: "personal_life",
          kind: "personal_archive",
          title: "私人租房补充协议",
          localUriOrPath: "/Users/demo/private/lease.pdf",
          metadata: {},
        },
      ],
    });
    const dz = new UniversalDropzone({ ledger: port, knowledgeGraph: kg, gatewayConfig: customGateway });

    const ownerOut = await dz.handle({
      inputId: "rec-1",
      channel: "weixin",
      callerDomain: "owner_private",
      text: "张三平时忌口是什么？",
      receivedAtIso: "2026-11-20T10:00:00.000Z",
    });
    expect(ownerOut.intent).toBe("recall");
    if (ownerOut.intent !== "recall") throw new Error("unexpected intent");
    expect(ownerOut.selectedModel).toBe("model/assessor-fast");
    expect(ownerOut.answer).toContain("不吃香菜");
    expect(ownerOut.matchedRefs).toContain("person:zhang");
    expect(ownerOut.matchedRefs).toContain("pref:zhang-tea");

    const workOut = await dz.handle({
      inputId: "rec-2",
      channel: "feishu",
      callerDomain: "work_project",
      text: "查一下张三忌口与私人租房协议",
      receivedAtIso: "2026-11-20T10:05:00.000Z",
    });
    expect(workOut.intent).toBe("recall");
    if (workOut.intent !== "recall") throw new Error("unexpected intent");
    expect(workOut.answer).not.toContain("香菜");
    expect(workOut.answer).not.toContain("lease.pdf");
    expect(workOut.matchedRefs).toEqual([]);

    const coworkOut = await dz.handle({
      inputId: "rec-3",
      channel: "web_ui",
      callerDomain: "cowork_shared",
      text: "张三平时忌口是什么？",
      receivedAtIso: "2026-11-20T10:10:00.000Z",
    });
    expect(coworkOut.intent).toBe("recall");
    if (coworkOut.intent !== "recall") throw new Error("unexpected intent");
    expect(coworkOut.answer).not.toContain("香菜");
    expect(coworkOut.matchedRefs).toEqual([]);
  });
});

describe("UniversalDropzone — advise", () => {
  it("flags tombstones, hard redlines, and contact taboos offline and supports optional adviseGenerator", async () => {
    const { port } = createTestLedger({
      relationships: [
        {
          id: "rel-client-a",
          partition: "work_project",
          name: "王总",
          taboos: ["忌直接当面拆台"],
          preferences: ["先给交付排期"],
          openFavors: [],
        },
      ],
      goals: [
        {
          id: "goal-cash",
          partition: "work_project",
          title: "Q4 保住毛利与现金流",
          northStarCriterion: "单项目毛利率 >= 45%",
          status: "active",
        },
      ],
      guardrails: [
        {
          id: "guard-tomb-discount",
          partition: "work_project",
          kind: "tombstone",
          statement: "曾因低价打七折接单导致无限返工亏损",
          enforcement: "warn_before_send",
          evidenceSource: "Q2 复盘记录",
        },
        {
          id: "guard-red-floor",
          partition: "work_project",
          kind: "hard_redline",
          statement: "对外报价折扣严禁低于八五折",
          enforcement: "block_and_alert",
        },
      ],
    });
    const offlineDz = new UniversalDropzone({ ledger: port, gatewayConfig: customGateway });
    const offlineAdvise = await offlineDz.handle({
      inputId: "adv-1",
      channel: "weixin",
      partition: "work_project",
      callerDomain: "owner_private",
      text: "王总这次压价要求打七折，怎么回？",
      receivedAtIso: "2026-11-20T11:00:00.000Z",
    });
    expect(offlineAdvise.intent).toBe("advise");
    if (offlineAdvise.intent !== "advise") throw new Error("unexpected intent");
    expect(offlineAdvise.selectedModel).toBe("model/steward-sage");
    expect(offlineAdvise.guardrailWarnings.some((w) => w.includes("证伪墓碑预警") && w.includes("Q2 复盘记录"))).toBe(true);
    expect(offlineAdvise.guardrailWarnings.some((w) => w.includes("硬红线预警") && w.includes("八五折"))).toBe(true);
    expect(offlineAdvise.guardrailWarnings.some((w) => w.includes("人脉禁忌提醒:王总"))).toBe(true);
    expect(offlineAdvise.tradeOffBrief).toContain("Q4 保住毛利与现金流");
  });
});
describe("UniversalDropzone — adviseGenerator & delegate (automated_trigger)", () => {
  it("delegates adviseGenerator with steward model and contextSummary when callback is provided", async () => {
    const { port } = createTestLedger({
      goals: [{ id: "g1", partition: "personal_life", title: "准时下班", northStarCriterion: "20点后不接急活", status: "active" }],
    });
    const adviseGenerator = vi.fn(async (ctx: { model: string; contextSummary: string }) => {
      return `自定义参谋(${ctx.model}): ${ctx.contextSummary.split("\n")[0]}`;
    });
    const dz = new UniversalDropzone({ ledger: port, gatewayConfig: customGateway, adviseGenerator });

    const out = await dz.handle({
      inputId: "adv-cb",
      channel: "web_ui",
      text: "周五晚上要不要临时接个加急小单？",
      receivedAtIso: "2026-11-20T12:00:00.000Z",
    });
    expect(out.intent).toBe("advise");
    if (out.intent !== "advise") throw new Error("unexpected intent");
    expect(adviseGenerator).toHaveBeenCalledTimes(1);
    expect(out.tradeOffBrief).toContain("自定义参谋(model/steward-sage)");
    expect(out.tradeOffBrief).toContain("准时下班");
  });

  it("routes coding, Antigravity, GUI, and custom capability tasks to automated_trigger with neutral role models", async () => {
    const { port } = createTestLedger();
    const dz = new UniversalDropzone({
      ledger: port,
      gatewayConfig: customGateway,
      ownerId: "owner-1",
      automatedCapabilities: new Set(["tax_filing_rpa"]),
    });

    const agOut = await dz.handle({
      inputId: "del-ag",
      channel: "weixin",
      text: "把跨仓架构重构派给 Antigravity 跑通单测",
      receivedAtIso: "2026-11-20T13:00:00.000Z",
    });
    expect(agOut.intent).toBe("delegate");
    if (agOut.intent !== "delegate" || agOut.mode !== "automated_trigger") throw new Error("expected automated_trigger");
    expect(agOut.trigger.sourceKind).toBe("antigravity");
    expect(agOut.trigger.addressedToAgent).toBe(true);
    expect(agOut.trigger.fromAllowedSender).toBe(true);
    expect(agOut.selectedModel).toBe("model/executor-pro");

    const guiOut = await dz.handle({
      inputId: "del-gui",
      channel: "desktop_hotkey",
      text: "打开桌面窗口点击导出本月流水截图",
      receivedAtIso: "2026-11-20T13:05:00.000Z",
    });
    expect(guiOut.intent).toBe("delegate");
    if (guiOut.intent !== "delegate" || guiOut.mode !== "automated_trigger") throw new Error("expected automated_trigger");
    expect(guiOut.trigger.sourceKind).toBe("im_channel");
    expect(guiOut.selectedModel).toBe("model/cua-vision");

    const capOut = await dz.handle({
      inputId: "del-cap",
      channel: "web_ui",
      text: "使用 tax_filing_rpa 办理本月税务申报",
      receivedAtIso: "2026-11-20T13:10:00.000Z",
    });
    expect(capOut.intent).toBe("delegate");
    if (capOut.intent !== "delegate" || capOut.mode !== "automated_trigger") throw new Error("expected automated_trigger");
    expect(capOut.selectedModel).toBe("model/executor-pro");
  });
});
describe("UniversalDropzone — delegate (human_prep_bundle 80% fallback)", () => {
  it("never refuses non-API gov/permit errands and prepares checklist, localMaterials, drafts, and commitment", async () => {
    const { port, commitments } = createTestLedger({
      resources: [
        {
          id: "res-passport",
          partition: "personal_life",
          kind: "personal_archive",
          title: "护照扫描件",
          localUriOrPath: "/Users/demo/vault/passport.pdf",
          expiresAt: "2026-12-20",
          metadata: {},
        },
        {
          id: "res-id",
          partition: "personal_life",
          kind: "personal_archive",
          title: "身份证正反面",
          localUriOrPath: "/Users/demo/vault/id-card.png",
          metadata: {},
        },
      ],
    });
    const dz = new UniversalDropzone({ ledger: port, gatewayConfig: customGateway });

    const out = await dz.handle({
      inputId: "prep-gov",
      channel: "weixin",
      text: "帮我办理护照换证，顺便把身份证也备好",
      receivedAtIso: "2026-11-20T14:00:00.000Z",
    });
    expect(out.intent).toBe("delegate");
    if (out.intent !== "delegate" || out.mode !== "human_prep_bundle") throw new Error("expected human_prep_bundle");
    expect(out.selectedModel).toBe("model/executor-pro");
    expect(out.bundle.missingAutomationReason).not.toContain("缺少工具");
    expect(out.bundle.checklist.length).toBeGreaterThanOrEqual(3);
    expect(out.bundle.checklist.length).toBeLessThanOrEqual(5);
    expect(out.bundle.localMaterials.map((m) => m.localPath)).toContain("/Users/demo/vault/passport.pdf");
    expect(out.bundle.localMaterials.map((m) => m.localPath)).toContain("/Users/demo/vault/id-card.png");
    expect(out.bundle.readyToCopyDrafts.length).toBeGreaterThanOrEqual(1);
    expect(out.bundle.followupCommitment.status).toBe("open");
    expect(out.followupCommitmentId).toBe(commitments[0]?.id);
    expect(commitments[0]?.status).toBe("open");
  });

  it("avoids contact taboos in readyToCopyDrafts for landlord errands and handles paper reimbursement", async () => {
    const { port, commitments } = createTestLedger({
      relationships: [
        {
          id: "rel-landlord",
          partition: "personal_life",
          name: "房东王叔",
          taboos: ["忌提扣房租", "别催太急"],
          preferences: ["先约明确时段"],
          openFavors: [],
        },
      ],
      resources: [
        {
          id: "res-lease",
          partition: "personal_life",
          kind: "personal_archive",
          title: "房屋租房合同",
          localUriOrPath: "/Users/demo/vault/lease-agreement.pdf",
          metadata: {},
        },
        {
          id: "res-inv",
          partition: "work_project",
          kind: "personal_archive",
          title: "差旅电子发票汇总",
          localUriOrPath: "/Users/demo/work/travel-invoices.pdf",
          metadata: {},
        },
      ],
    });
    const dz = new UniversalDropzone({ ledger: port, gatewayConfig: customGateway });

    const landlordOut = await dz.handle({
      inputId: "prep-landlord",
      channel: "weixin",
      text: "帮我联系房东王叔修一下厨房漏水（别提扣房租）",
      receivedAtIso: "2026-11-20T14:30:00.000Z",
    });
    expect(landlordOut.intent).toBe("delegate");
    if (landlordOut.intent !== "delegate" || landlordOut.mode !== "human_prep_bundle") throw new Error("expected human_prep_bundle");
    const draft = landlordOut.bundle.readyToCopyDrafts[0]?.text ?? "";
    expect(draft).toContain("房东王叔");
    expect(draft).not.toContain("扣房租");
    expect(draft).not.toContain("催太急");
    expect(landlordOut.bundle.localMaterials.map((m) => m.localPath)).toContain("/Users/demo/vault/lease-agreement.pdf");

    const reimbOut = await dz.handle({
      inputId: "prep-reimb",
      channel: "desktop_hotkey",
      partition: "work_project",
      callerDomain: "owner_private",
      text: "帮我处理上个月差旅纸质贴票报销",
      receivedAtIso: "2026-11-20T14:45:00.000Z",
    });
    expect(reimbOut.intent).toBe("delegate");
    if (reimbOut.intent !== "delegate" || reimbOut.mode !== "human_prep_bundle") throw new Error("expected human_prep_bundle");
    expect(reimbOut.bundle.localMaterials.map((m) => m.localPath)).toContain("/Users/demo/work/travel-invoices.pdf");
    expect(commitments).toHaveLength(2);
  });
});
