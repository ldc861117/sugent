import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEW_SYSTEM } from "../src/agent/steward.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";
import {
  mergeKnowledgeGraphSnapshots,
  openZeroKnowledgeEnvelope,
  type SyncableKnowledgeGraphSnapshot,
  type ZeroKnowledgeEnvelope,
} from "../src/sugent/e2ee-sync.js";
import { KG_EXTRACTION_SYSTEM, SugentKnowledgeGraph } from "../src/sugent/knowledge-graph.js";
import { LocalBudgetLedger } from "../src/sugent/local-budget.js";
import { SugentModelCatalog } from "../src/sugent/model-catalog.js";
import { SugentP2HostService, createAtlasMindSyncPort } from "../src/sugent/p2-host-service.js";
import { PostTurnDigester } from "../src/sugent/post-turn-digester.js";
import { ProviderRegistry } from "../src/sugent/provider-registry.js";
import { EpistemicDigestionLoop } from "../src/sugent/silicon-identity-core.js";
import { StereoscopicAtlas, type AtlasNode } from "../src/sugent/stereoscopic-atlas.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";

const HTTPS_PROTO = ["https", "://"].join("");

describe("Wave P5 Lane A (P5.1): Native StereoscopicAtlas Ingestion & Lossless v2 E2EE Roaming", () => {
  const tmpDirs: string[] = [];
  const openAtlases: StereoscopicAtlas[] = [];

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  function mkAtlas(rootDir: string): StereoscopicAtlas {
    const atlas = new StereoscopicAtlas(rootDir);
    openAtlases.push(atlas);
    return atlas;
  }

  function makeClaims(sub = "usr_p5_lane_a"): SugentBrokerClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: `${HTTPS_PROTO}auth.sugent.example`,
      sub,
      aud: "sugent-desktop",
      idp: "wechat",
      plan: "pro",
      sync_endpoint: `${HTTPS_PROTO}sync.sugent.example/v1`,
      iat: now,
      exp: now + 3600,
    };
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    while (openAtlases.length > 0) {
      try {
        openAtlases.pop()!.close();
      } catch {
        /* ignore */
      }
    }
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("1. PostTurnDigester natively routes planes/ACLs/sourceTrust, creates same-plane episode anchors, supersedes removed reviews, rejects secrets, and runs assessorDigestHook safely", async () => {
    const dir = mkTmp("sugent-p5a-digester-");
    const kg = new SugentKnowledgeGraph(path.join(dir, "sugent-kg"));
    const ledger = new StewardshipLedger({ dataDir: dir, knowledgeGraph: kg });
    const atlas = mkAtlas(path.join(dir, "atlas"));

    // Seed a workflow with 2 reinforcements to verify promotion to crystallized_wisdom on 3rd reinforcement
    kg.applyDelta(
      {
        nodes: [
          {
            id: "wf:contract-audit",
            kind: "workflow",
            name: "合同红线审校流程",
            summary: "先查账期再核违约金上限",
            tags: ["contract-audit"],
            reinforcements: 2,
            steps: ["核对账期", "核对违约金上限"],
          },
        ],
      },
      "2026-11-27T10:00:00Z",
    );
    atlas.applyDelta(
      {
        nodes: [
          {
            id: "wf:contract-audit",
            plane: "meta_evolution",
            stratum: "verified_fact",
            kind: "workflow",
            name: "合同红线审校流程",
            summary: "先查账期再核违约金上限",
            tags: ["contract-audit"],
            principalAcl: ["sugent_self", "owner:M"],
            reinforcements: 2,
            sourceTrust: "owner_confirmed",
            steps: ["核对账期", "核对违约金上限"],
          },
        ],
      },
      "2026-11-27T10:00:00Z",
    );

    const hookCalls: Array<{ channel: string; nowIso: string }> = [];
    let shouldThrowInHook = false;
    vi.stubEnv("SUGENT_KG_DEEP_EXTRACT", "1");

    let reviewResponse = JSON.stringify({
      add: [{ text: "周五下午不排外部商务电话", topic: "schedule" }],
      remove: [],
    });
    let deepKgResponse = JSON.stringify({
      nodes: [
        {
          id: "proj:sugent-core",
          kind: "project",
          name: "Sugent Core",
          summary: "核心立体记忆工程",
          tags: ["core"],
        },
      ],
      edges: [],
    });

    const digester = new PostTurnDigester({
      knowledgeGraph: kg,
      ledger,
      atlas,
      // Simulate legacy onNodeDelta still wired alongside native atlas: native sourceTrust & reinforcements must win!
      onNodeDelta: (delta) => {
        atlas.ingestLegacyDelta(delta, "owner_life", "2026-11-28T08:00:00Z");
      },
      assessorDigestHook: async (turn, nowIso) => {
        hookCalls.push({ channel: turn.channel, nowIso });
        if (shouldThrowInHook) {
          throw new Error("simulated assessor hook transient failure");
        }
      },
      completeFn: async (system) => {
        if (system === REVIEW_SYSTEM) return reviewResponse;
        if (system === KG_EXTRACTION_SYSTEM) return deepKgResponse;
        return "";
      },
      nowIso: () => "2026-11-28T08:00:00Z",
    });

    // 1a. Secret turn must be rejected immediately without writing to Atlas/KG or firing assessorDigestHook
    const secretRes = await digester.digestTurnNow({
      channel: "weixin",
      peerId: "owner",
      userText: "请记住我的生产密钥是 sk-proj-9876543210abcdef12345678",
      assistantReply: "已拦截",
    });
    expect(secretRes.skippedSecret).toBe(true);
    expect(secretRes.nativeAtlasNodes).toBe(0);
    expect(secretRes.episodeAnchorId).toBeUndefined();
    expect(hookCalls).toHaveLength(0);

    // 1b. Owner Weixin turn spanning owner_life + meta_evolution + domain_work:default + workflow reinforcement
    shouldThrowInHook = true; // Verify hook errors never crash digestTurnNow
    const ownerRes = await digester.digestTurnNow({
      channel: "weixin",
      peerId: "owner",
      episodeId: "ep:turn:wx-owner-001",
      userText:
        "以后请记住出差优先订靠窗高铁座。以后固定发版流程：先跑 npm run typecheck 再跑 npm run test:sugent。另外今天已按合同红线审校流程执行完毕。",
      assistantReply: "已按合同红线审校流程完成核验并记下偏好。",
    });
    shouldThrowInHook = false;

    expect(ownerRes.skippedSecret).toBe(false);
    expect(ownerRes.deterministicNodes).toBe(2);
    expect(ownerRes.deterministicReinforcedWorkflows).toBe(1);
    expect(ownerRes.reviewAdded).toBe(1);
    expect(ownerRes.deepExtractedNodes).toBe(1);
    expect(ownerRes.nativeAtlasNodes).toBeGreaterThanOrEqual(6);
    expect(ownerRes.nativeAtlasEdges).toBeGreaterThanOrEqual(5);
    expect(ownerRes.episodeAnchorId).toBe("ep:turn:wx-owner-001");
    expect(hookCalls).toHaveLength(1);

    // Verify owner preference node -> owner_life, owner_confirmed, principalAcl: ["owner:M"]
    const prefNode = atlas.allNodes({ plane: "owner_life" }).find((n) => n.id.startsWith("pref:turn-"));
    expect(prefNode).toBeDefined();
    expect(prefNode!.sourceTrust).toBe("owner_confirmed");
    expect(prefNode!.stratum).toBe("verified_fact");
    expect(prefNode!.principalAcl).toEqual(["owner:M"]);
    expect(prefNode!.reinforcements).toBe(1); // Not double-counted despite legacy onNodeDelta!

    // Verify deterministic workflow -> meta_evolution, owner_confirmed
    const newWfNode = atlas.allNodes({ plane: "meta_evolution" }).find((n) => n.id.startsWith("wf:turn-"));
    expect(newWfNode).toBeDefined();
    expect(newWfNode!.sourceTrust).toBe("owner_confirmed");
    expect(newWfNode!.principalAcl).toEqual(["sugent_self", "owner:M"]);

    // Verify reinforced workflow promoted to crystallized_wisdom at reinforcements === 3
    const reinforcedWf = atlas.getNode("wf:contract-audit");
    expect(reinforcedWf?.plane).toBe("meta_evolution");
    expect(reinforcedWf?.reinforcements).toBe(3);
    expect(reinforcedWf?.stratum).toBe("crystallized_wisdom");
    expect(reinforcedWf?.sourceTrust).toBe("owner_confirmed");

    // Verify REVIEW_SYSTEM memory -> owner_life, llm_inferred
    const reviewMemNode = atlas.allNodes({ plane: "owner_life" }).find((n) => n.id.startsWith("mem:schedule:"));
    expect(reviewMemNode).toBeDefined();
    expect(reviewMemNode!.sourceTrust).toBe("llm_inferred");
    expect(reviewMemNode!.stratum).toBe("verified_fact");
    expect(reviewMemNode!.principalAcl).toEqual(["owner:M"]);

    // Verify KG_EXTRACTION_SYSTEM project -> domain_work:default, llm_inferred
    const projNode = atlas.getNode("proj:sugent-core");
    expect(projNode?.plane).toBe("domain_work:default");
    expect(projNode?.sourceTrust).toBe("llm_inferred");
    expect(projNode?.principalAcl).toEqual(["sugent_self", "owner:M"]);

    // Verify episode anchor on owner_life and derived_from_episode edge with owner:M ACL
    const primaryEp = atlas.getNode("ep:turn:wx-owner-001");
    expect(primaryEp).toBeDefined();
    expect(primaryEp!.plane).toBe("owner_life");
    expect(primaryEp!.stratum).toBe("raw_episodic");
    expect(primaryEp!.principalAcl).toEqual(["owner:M"]);
    expect(primaryEp!.sourceTrust).toBe("deterministic_gate");

    const epEdge = atlas
      .activeEdges("owner_life")
      .find((e) => e.from === prefNode!.id && e.relation === "derived_from_episode");
    expect(epEdge).toBeDefined();
    expect(epEdge!.to).toBe("ep:turn:wx-owner-001");
    expect(epEdge!.principalAcl).toEqual(["owner:M"]);

    // Secondary plane episode anchor must also be same-plane (zero cross-plane raw_episodic violation)
    const metaEpEdge = atlas
      .activeEdges("meta_evolution")
      .find((e) => e.from === newWfNode!.id && e.relation === "derived_from_episode");
    expect(metaEpEdge).toBeDefined();
    expect(atlas.getNode(metaEpEdge!.to)?.plane).toBe("meta_evolution");

    // 1c. Project-scoped turn -> domain_work:contract-guard
    reviewResponse = JSON.stringify({ add: [], remove: [] });
    deepKgResponse = JSON.stringify({ nodes: [], edges: [] });
    const projTurnRes = await digester.digestTurnNow({
      channel: "web_ui",
      peerId: "owner",
      projectKey: "contract-guard",
      userText: "请记住这个项目的账期红线是不超过 Net 30 天。",
      assistantReply: "已记入合同守卫工作面。",
    });
    const domainNode = atlas
      .allNodes({ plane: "domain_work:contract-guard" })
      .find((n) => n.id.startsWith("pref:turn-"));
    expect(domainNode).toBeDefined();
    expect(domainNode!.principalAcl).toEqual(["sugent_self", "owner:M"]);
    expect(atlas.getNode(projTurnRes.episodeAnchorId!)?.plane).toBe("domain_work:contract-guard");

    // 1d. External peer / concierge turn -> relational:peer:<id>
    await digester.digestTurnNow({
      channel: "concierge",
      peerId: "peer:vendor-li",
      userText: "我的偏好是统一用加密邮件接收盖章扫描件。",
      assistantReply: "收到李总，已登记对接习惯。",
    });
    const peerNode = atlas
      .allNodes({ plane: "relational:peer:vendor-li" })
      .find((n) => n.id.startsWith("pref:turn-"));
    expect(peerNode).toBeDefined();
    expect(peerNode!.principalAcl).toEqual(["owner:M", "sugent_self"]);

    // 1e. REVIEW_SYSTEM remove supersedes matching mem:* node in Atlas
    reviewResponse = JSON.stringify({
      add: [],
      remove: ["周五下午不排外部商务电话"],
    });
    const removeRes = await digester.digestTurnNow({
      channel: "weixin",
      peerId: "owner",
      userText: "把周五下午不排电话那条旧规矩删掉吧",
      assistantReply: "好的，已移除。",
    });
    expect(removeRes.reviewRemoved).toBe(1);
    expect(atlas.getNode(reviewMemNode!.id)?.supersededAt).toBe("2026-11-28T08:00:00Z");
  });

  it("2. SyncableAtlasSnapshotV2 E2EE round-trip across Device A & B preserves all 5 planes, membrane bridges, MindJournal CRDT, and prevents zombie resurrection", async () => {
    const cloudBlobs = new Map<string, string>();
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        cloudBlobs.set(url, String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const stored = cloudBlobs.get(url);
      return stored ? new Response(stored, { status: 200 }) : new Response("not found", { status: 404 });
    };

    function createDeviceHost(label: string) {
      const dir = mkTmp(`sugent-p5a-${label}-`);
      const stewardDir = path.join(dir, "sugent-stewardship");
      const kg = new SugentKnowledgeGraph(path.join(dir, "sugent-kg"));
      const atlas = mkAtlas(path.join(stewardDir, "atlas"));
      const mindJournalPath = path.join(stewardDir, "mind-journal.json");
      let importedCalls = 0;
      const atlasPort = createAtlasMindSyncPort({
        atlas,
        mindJournalPath,
        onMindJournalImported: () => {
          importedCalls += 1;
        },
      });
      const service = new SugentP2HostService({
        dataDir: dir,
        providers: new ProviderRegistry(dir),
        modelCatalog: new SugentModelCatalog(dir),
        localBudgets: new LocalBudgetLedger(dir),
        knowledgeGraph: kg,
        getDefaultModel: () => "deepseek-chat",
        getFetch: () => mockFetch,
        atlasPort,
      });
      return {
        dir,
        stewardDir,
        mindJournalPath,
        kg,
        atlas,
        service,
        getImportedCalls: () => importedCalls,
      };
    }

    const devA = createDeviceHost("devA");
    const devB = createDeviceHost("devB");

    // Device B starts with an older ACTIVE copy of a pricing node (zombie candidate!) and a sandbox mind entry
    devB.kg.applyDelta(
      {
        nodes: [
          {
            id: "quote:legacy-v1",
            kind: "concept",
            name: "旧版报价单",
            summary: "账期 Net 90 可接受",
            tags: ["quote"],
          },
        ],
      },
      "2026-11-20T00:00:00Z",
    );
    devB.atlas.applyDelta(
      {
        nodes: [
          {
            id: "quote:legacy-v1",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "concept",
            name: "旧版报价单",
            summary: "账期 Net 90 可接受",
            tags: ["quote", "devB-tag"],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: 0.75,
            sourceTrust: "owner_confirmed",
          },
        ],
      },
      "2026-11-20T00:00:00Z",
    );
    const mindLoopB = new EpistemicDigestionLoop({
      stewardDir: devB.stewardDir,
      atlas: devB.atlas,
      nowIso: () => "2026-11-21T00:00:00Z",
    });
    mindLoopB.recordJudgment({
      id: "self:hyp:shared-net90",
      topicKey: "contract:net90",
      surface: "steward_hub",
      hypothesis: "客户口头承诺 Net 90 会按时打款",
      rationale: "Device B 初次观察",
    });
    mindLoopB.recordJudgment({
      id: "self:hyp:devb-sandbox",
      topicKey: "ops:morning-brief",
      surface: "im_owner",
      hypothesis: "早报控制在 3 条以内打开率更高",
      rationale: "Device B 独立沙盒假设",
    });

    // Device A populates all 5 planes + membrane edge + supersedes quote:legacy-v1 + archives noise + falsifies/crystallizes mind entries
    devA.kg.applyDelta(
      {
        nodes: [
          {
            id: "quote:legacy-v1",
            kind: "concept",
            name: "旧版报价单",
            summary: "账期 Net 90 可接受",
            tags: ["quote"],
          },
          {
            id: "quote:strict-v2",
            kind: "concept",
            name: "新版报价红线",
            summary: "严禁接受超过 Net 30 无预付款条款",
            tags: ["quote", "redline"],
          },
        ],
      },
      "2026-11-25T00:00:00Z",
    );
    devA.kg.archiveNode("quote:legacy-v1", "2026-11-26T00:00:00Z");

    devA.atlas.applyDelta(
      {
        nodes: [
          {
            id: "self:charter:dissent",
            plane: "self_core",
            stratum: "crystallized_wisdom",
            kind: "canon",
            name: "忠诚异议宪章",
            summary: "遇到违背红线指令必须温和而坚定提醒",
            tags: ["charter"],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: 0.96,
            sourceTrust: "deterministic_gate",
            reinforcements: 4,
          },
          {
            id: "owner:rhythm:friday",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "preference",
            name: "周五晚餐留白",
            summary: "周五 19:00-22:00 不处理非紧急工单",
            tags: ["rhythm"],
            principalAcl: ["owner:M"],
            confidence: 0.91,
            sourceTrust: "owner_confirmed",
          },
          {
            id: "crystal:duo:friday-walk",
            plane: "relational:duo:andy-gillna",
            stratum: "crystallized_wisdom",
            kind: "capsule",
            name: "周五散步微约定",
            summary: "每周五晚饭后散步半小时不看工作手机",
            tags: ["duo", "crystal"],
            principalAcl: ["owner:M", "partner:W", "co_owned:duo"],
            confidence: 0.95,
            sourceTrust: "mutual_endorsed",
            reinforcements: 3,
          },
          {
            id: "quote:legacy-v1",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "concept",
            name: "旧版报价单",
            summary: "账期 Net 90 可接受",
            tags: ["quote", "devA-tag"],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: 0.75,
            sourceTrust: "owner_confirmed",
          },
          {
            id: "quote:strict-v2",
            plane: "domain_work:contract-guard",
            stratum: "crystallized_wisdom",
            kind: "guardrail",
            name: "新版报价红线",
            summary: "严禁接受超过 Net 30 无预付款条款",
            tags: ["quote", "redline"],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: 0.94,
            sourceTrust: "owner_confirmed",
            reinforcements: 3,
          },
          {
            id: "noise:archived-1",
            plane: "domain_work:contract-guard",
            stratum: "verified_fact",
            kind: "concept",
            name: "过期临时草稿",
            summary: "已归档草稿",
            tags: ["temp"],
            principalAcl: ["sugent_self", "owner:M"],
            archivedAt: "2026-11-26T02:00:00Z",
          },
          {
            id: "wf:verify-sugent",
            plane: "meta_evolution",
            stratum: "crystallized_wisdom",
            kind: "workflow",
            name: "门禁全绿校验",
            summary: "提交前运行 typecheck 与 verify:sugent",
            tags: ["ci"],
            principalAcl: ["sugent_self", "owner:M"],
            confidence: 0.93,
            sourceTrust: "owner_confirmed",
            reinforcements: 5,
            steps: ["npm run typecheck", "npm run verify:sugent"],
            skillGateStatus: "approved",
          },
        ],
        edges: [
          {
            plane: "relational:duo:andy-gillna",
            from: "crystal:duo:friday-walk",
            relation: "projects_duo_anchor",
            to: "owner:rhythm:friday",
            weight: 3,
            source: "cognitive_membrane",
            isMembraneEdge: true,
            membranePolicy: "M3_duo_consensus_anchor",
            principalAcl: ["owner:M", "sugent_self"],
          },
        ],
      },
      "2026-11-25T00:00:00Z",
    );
    devA.atlas.supersedeNode("quote:legacy-v1", "quote:strict-v2", "2026-11-26T01:00:00Z");

    const mindLoopA = new EpistemicDigestionLoop({
      stewardDir: devA.stewardDir,
      atlas: devA.atlas,
      nowIso: () => "2026-11-26T03:00:00Z",
    });
    mindLoopA.recordJudgment({
      id: "self:hyp:shared-net90",
      topicKey: "contract:net90",
      surface: "steward_hub",
      hypothesis: "客户口头承诺 Net 90 会按时打款",
      rationale: "Device A 同步记录",
    });
    mindLoopA.reconcileOutcome(
      {
        idOrTopic: "self:hyp:shared-net90",
        outcome: "falsified",
        evidenceNote: "Q3 实际逾期 45 天触发坏账预警",
        ownerEndorsed: true,
      },
      "2026-11-26T04:00:00Z",
    );
    mindLoopA.recordJudgment({
      id: "self:hyp:deva-crystal",
      topicKey: "contract:prepayment",
      surface: "coding_orchestrator",
      hypothesis: "首款 >= 30% 可显著过滤高风险定制单",
      rationale: "历史 5 单统计",
    });
    mindLoopA.reconcileOutcome(
      {
        idOrTopic: "self:hyp:deva-crystal",
        outcome: "confirmed",
        evidenceNote: "主人拍板定为标准商业条款",
        ownerEndorsed: true,
      },
      "2026-11-26T05:00:00Z",
    );

    const claims = makeClaims();
    const passphrase = "correct-horse-battery-staple-p5-v2";

    // Device A pushes encrypted v2 snapshot -> Device B pulls & merges -> Device B pushes back -> Device A pulls
    const pushA = await devA.service.pushSync({ claims, bearerToken: "tok", passphrase });
    expect(pushA.statusCode).toBe(200);

    // Ensure ciphertext in cloud contains zero plaintext node names or mind hypotheses
    const rawCipherBlob = [...cloudBlobs.values()][0]!;
    expect(rawCipherBlob).not.toContain("周五散步微约定");
    expect(rawCipherBlob).not.toContain("Q3 实际逾期 45 天");

    const pullB = await devB.service.pullSync({ claims, bearerToken: "tok", passphrase });
    expect(pullB.statusCode).toBe(200);
    expect(devB.getImportedCalls()).toBe(1);
    expect(fs.statSync(devB.mindJournalPath).mode & 0o777).toBe(0o600);

    // Verify all 5 planes and attributes survived 100% losslessly on Device B
    const bCharter = devB.atlas.getNode("self:charter:dissent");
    expect(bCharter?.plane).toBe("self_core");
    expect(bCharter?.stratum).toBe("crystallized_wisdom");
    expect(bCharter?.confidence).toBe(0.96);
    expect(bCharter?.sourceTrust).toBe("deterministic_gate");

    const bOwner = devB.atlas.getNode("owner:rhythm:friday");
    expect(bOwner?.plane).toBe("owner_life");
    expect(bOwner?.principalAcl).toEqual(["owner:M"]);

    const bDuo = devB.atlas.getNode("crystal:duo:friday-walk");
    expect(bDuo?.plane).toBe("relational:duo:andy-gillna");
    expect(bDuo?.principalAcl).toEqual(["owner:M", "partner:W", "co_owned:duo"]);
    expect(bDuo?.sourceTrust).toBe("mutual_endorsed");

    const bGuard = devB.atlas.getNode("quote:strict-v2");
    expect(bGuard?.plane).toBe("domain_work:contract-guard");
    expect(bGuard?.confidence).toBe(0.94);

    const bWf = devB.atlas.getNode("wf:verify-sugent");
    expect(bWf?.plane).toBe("meta_evolution");
    expect(bWf?.skillGateStatus).toBe("approved");
    expect(bWf?.steps).toEqual(["npm run typecheck", "npm run verify:sugent"]);
    expect(bWf?.reinforcements).toBe(5);

    // Verify membrane edge preserved 100%
    const bMembraneEdge = devB.atlas.getEdge(
      "crystal:duo:friday-walk--projects_duo_anchor-->owner:rhythm:friday",
    );
    expect(bMembraneEdge).toBeDefined();
    expect(bMembraneEdge?.isMembraneEdge).toBe(true);
    expect(bMembraneEdge?.membranePolicy).toBe("M3_duo_consensus_anchor");
    expect(bMembraneEdge?.principalAcl).toEqual(["owner:M", "sugent_self"]);
    expect(bMembraneEdge?.weight).toBe(3);

    // Verify ZERO zombie resurrection on Device B (both in StereoscopicAtlas AND legacy SugentKnowledgeGraph!)
    const bZombie = devB.atlas.getNode("quote:legacy-v1");
    expect(bZombie?.supersededAt).toBe("2026-11-26T01:00:00Z");
    expect(bZombie?.supersededBy).toBe("quote:strict-v2");
    expect(bZombie?.tags).toEqual(expect.arrayContaining(["quote", "devA-tag", "devB-tag"]));
    expect(
      devB.atlas.recallStereoscopic("旧版报价单 Net 90").nodes.some((n) => n.id === "quote:legacy-v1"),
    ).toBe(false);
    expect(devB.kg.getNode("quote:legacy-v1")?.supersededAt).toBeTruthy();
    expect(devB.kg.recallSubgraph("旧版报价单").matchedNodes.some((n) => n.id === "quote:legacy-v1")).toBe(
      false,
    );

    const bArchived = devB.atlas.getNode("noise:archived-1");
    expect(bArchived?.archivedAt).toBe("2026-11-26T02:00:00Z");
    expect(devB.atlas.allNodes().some((n) => n.id === "noise:archived-1")).toBe(false);

    // Verify MindJournal CRDT merge on Device B: falsified sticky win + evidenceNotes union + crystallized + local sandbox
    const reloadedMindB = new EpistemicDigestionLoop({
      stewardDir: devB.stewardDir,
      atlas: devB.atlas,
    });
    const mergedShared = reloadedMindB.listEntries().find((e) => e.id === "self:hyp:shared-net90");
    expect(mergedShared?.status).toBe("falsified");
    expect(mergedShared?.contradictions).toBe(1);
    expect(mergedShared?.evidenceNotes).toEqual(
      expect.arrayContaining([
        "Device B 初次观察",
        "Device A 同步记录",
        "Q3 实际逾期 45 天触发坏账预警",
      ]),
    );
    const mergedCrystal = reloadedMindB.listEntries().find((e) => e.id === "self:hyp:deva-crystal");
    expect(mergedCrystal?.status).toBe("crystallized");
    expect(mergedCrystal?.stratum).toBe("crystallized_wisdom");
    const keptSandbox = reloadedMindB.listEntries().find((e) => e.id === "self:hyp:devb-sandbox");
    expect(keptSandbox?.status).toBe("sandbox");

    // Idempotent second pullSync on Device B must NOT double-increment reinforcements or edge weights
    await devB.service.pullSync({ claims, bearerToken: "tok", passphrase });
    expect(devB.atlas.getNode("wf:verify-sugent")?.reinforcements).toBe(5);
    expect(
      devB.atlas.getEdge("crystal:duo:friday-walk--projects_duo_anchor-->owner:rhythm:friday")?.weight,
    ).toBe(3);
  });

  it("3. Backward compatibility: v1 <-> v2 commutative merge without data loss & stable per-item Lamport clocks on SugentP2HostService", async () => {
    const v1Snap: SyncableKnowledgeGraphSnapshot = {
      lamportClock: 4,
      deviceId: "legacy-dev",
      nodes: [
        {
          id: "proj:legacy-erp",
          type: "project",
          label: "Legacy ERP",
          properties: { summary: "v1 设备新增项目", tags: ["erp"], reinforcements: 2 },
          validFrom: "2026-11-15T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-15T00:00:00Z",
          lamportClock: 4,
        },
        {
          id: "shared:contract-rule",
          type: "concept",
          label: "Shared Rule",
          properties: { summary: "v1 视图", tags: ["v1"], reinforcements: 6 },
          validFrom: "2026-11-10T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-16T00:00:00Z",
          lamportClock: 4,
        },
      ],
      edges: [
        {
          id: "proj:legacy-erp--relates_to-->shared:contract-rule",
          source: "proj:legacy-erp",
          target: "shared:contract-rule",
          relation: "relates_to",
          weight: 2,
          provenanceSource: "v1_review",
          validFrom: "2026-11-15T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-15T00:00:00Z",
          lamportClock: 4,
        },
      ],
    };

    const v2Snap: SyncableKnowledgeGraphSnapshot = {
      schemaVersion: 2,
      lamportClock: 5,
      deviceId: "modern-dev",
      nodes: [
        {
          id: "shared:contract-rule",
          type: "concept",
          label: "Shared Rule",
          properties: { summary: "v2 视图", tags: ["v2"], reinforcements: 3 },
          validFrom: "2026-11-10T00:00:00Z",
          supersededAt: null,
          updatedAt: "2026-11-14T00:00:00Z",
          lamportClock: 3,
        },
      ],
      edges: [],
      atlasSnapshot: {
        version: 2,
        nodes: [
          {
            id: "shared:contract-rule",
            plane: "domain_work:contract-guard",
            stratum: "crystallized_wisdom",
            kind: "guardrail",
            name: "Shared Rule",
            summary: "v2 立体护栏视图",
            tags: ["v2"],
            principalAcl: ["sugent_self", "owner:M"],
            reinforcements: 3,
            confidence: 0.94,
            sourceTrust: "owner_confirmed",
            updatedAt: "2026-11-14T00:00:00Z",
            supersededAt: null,
            supersededBy: null,
            archivedAt: null,
            lamportClock: 3,
          },
        ],
        edges: [],
      },
    };

    const m12 = mergeKnowledgeGraphSnapshots(v1Snap, v2Snap, "merged-host");
    const m21 = mergeKnowledgeGraphSnapshots(v2Snap, v1Snap, "merged-host");
    expect(m12).toEqual(m21);
    expect(m12.schemaVersion).toBe(2);

    // v1-only node is bridged into atlasSnapshot without losing v2 plane/ACL/sourceTrust on shared:contract-rule
    const bridgedErp = m12.atlasSnapshot?.nodes.find((n) => n.id === "proj:legacy-erp");
    expect(bridgedErp?.plane).toBe("domain_work:legacy-erp");
    expect(bridgedErp?.sourceTrust).toBe("legacy_import");

    const preservedShared = m12.atlasSnapshot?.nodes.find((n) => n.id === "shared:contract-rule");
    expect(preservedShared?.plane).toBe("domain_work:contract-guard");
    expect(preservedShared?.stratum).toBe("crystallized_wisdom");
    expect(preservedShared?.sourceTrust).toBe("owner_confirmed");
    expect(preservedShared?.reinforcements).toBe(6); // Math.max(3, 6)

    // Verify per-item Lamport clocks remain stable for unchanged Atlas & MindJournal items across pushSync batches
    const bucket = new Map<string, string>();
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        bucket.set(url, String(init?.body ?? ""));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      const raw = bucket.get(url);
      return raw ? new Response(raw, { status: 200 }) : new Response("not found", { status: 404 });
    };

    const dir = mkTmp("sugent-p5a-clocks-");
    const stewardDir = path.join(dir, "sugent-stewardship");
    const kg = new SugentKnowledgeGraph(path.join(dir, "sugent-kg"));
    const atlas = mkAtlas(path.join(stewardDir, "atlas"));
    const mindLoop = new EpistemicDigestionLoop({
      stewardDir,
      atlas,
      nowIso: () => "2026-11-28T01:00:00Z",
    });
    mindLoop.recordJudgment({
      id: "self:hyp:stable-mind",
      topicKey: "stable:mind",
      surface: "steward_hub",
      hypothesis: "保持不变的心智假设",
      rationale: "用于时钟稳定性测试",
    });
    atlas.applyDelta(
      {
        nodes: [
          {
            id: "atlas:stable",
            plane: "owner_life",
            stratum: "verified_fact",
            kind: "preference",
            name: "Stable Pref",
            summary: "v1",
            principalAcl: ["owner:M"],
          },
          {
            id: "atlas:mutable",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "Mutable Concept",
            summary: "before edit",
            principalAcl: ["sugent_self", "owner:M"],
          },
        ],
      },
      "2026-11-28T01:00:00Z",
    );

    const service = new SugentP2HostService({
      dataDir: dir,
      providers: new ProviderRegistry(dir),
      modelCatalog: new SugentModelCatalog(dir),
      localBudgets: new LocalBudgetLedger(dir),
      knowledgeGraph: kg,
      getDefaultModel: () => "deepseek-chat",
      getFetch: () => mockFetch,
      atlasPort: createAtlasMindSyncPort({
        atlas,
        mindJournalPath: path.join(stewardDir, "mind-journal.json"),
      }),
    });

    const claims = makeClaims("usr_clocks");
    const pass = "correct-horse-battery-staple-clocks";
    await service.pushSync({ claims, bearerToken: "tok", passphrase: pass });

    const env1 = JSON.parse([...bucket.values()][0]!) as ZeroKnowledgeEnvelope;
    const snap1 = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope: env1,
      passphrase: pass,
      expectedSubjectSub: claims.sub,
      expectedPayloadType: "knowledge-graph",
    }).payload;

    expect(snap1.atlasSnapshot?.nodes.find((n) => n.id === "atlas:stable")?.lamportClock).toBe(2);
    expect(snap1.atlasSnapshot?.nodes.find((n) => n.id === "atlas:mutable")?.lamportClock).toBe(2);
    expect(
      snap1.atlasSnapshot?.mindJournal?.entries.find((m) => m.id === "self:hyp:stable-mind")?.lamportClock,
    ).toBe(2);

    // Mutate ONLY atlas:mutable; atlas:stable and self:hyp:stable-mind must keep lamportClock === 2
    atlas.applyDelta(
      {
        nodes: [
          {
            id: "atlas:mutable",
            plane: "domain_work:sugent",
            stratum: "verified_fact",
            kind: "concept",
            name: "Mutable Concept",
            summary: "after edit",
            principalAcl: ["sugent_self", "owner:M"],
          },
        ],
      },
      "2026-11-28T02:00:00Z",
    );
    bucket.clear();
    await service.pushSync({ claims, bearerToken: "tok", passphrase: pass });

    const env2 = JSON.parse([...bucket.values()][0]!) as ZeroKnowledgeEnvelope;
    const snap2 = openZeroKnowledgeEnvelope<SyncableKnowledgeGraphSnapshot>({
      envelope: env2,
      passphrase: pass,
      expectedSubjectSub: claims.sub,
      expectedPayloadType: "knowledge-graph",
    }).payload;

    const findAtlasNode = (snap: SyncableKnowledgeGraphSnapshot, id: string): AtlasNode | undefined =>
      snap.atlasSnapshot?.nodes.find((n) => n.id === id) as unknown as AtlasNode | undefined;
    expect(findAtlasNode(snap2, "atlas:Mutable")).toBeUndefined();
    expect(snap2.atlasSnapshot?.nodes.find((n) => n.id === "atlas:stable")?.lamportClock).toBe(2);
    expect(snap2.atlasSnapshot?.nodes.find((n) => n.id === "atlas:mutable")?.lamportClock).toBe(3);
    expect(
      snap2.atlasSnapshot?.mindJournal?.entries.find((m) => m.id === "self:hyp:stable-mind")?.lamportClock,
    ).toBe(2);
  });
});
