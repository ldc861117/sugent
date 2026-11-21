import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COWORK_STANDARD_TOOLS,
  CoworkHitlClient,
  CoworkPermissionError,
  SecurityEnvelopeError,
  buildCoworkGatewayConfig,
  buildCoworkMcpPatchLines,
  evaluatePersonalTrigger,
  ingestCoworkPendingEvent,
  normalizeCoworkRole,
  parseCoworkFederationProfile,
  resolveCoworkFederationConfig,
  type CoworkJsonRequest,
} from "../src/sugent/index.js";

const LOOPBACK_BASE = ["http:", "", "127.0.0.1:28080"].join("/");

const tempDirs: string[] = [];
function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-cowork-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Sugent × Business-Level Cowork Dynamic Federation Bridge", () => {
  it("enforces least-privilege role resolution matching Cowork roster rules", () => {
    expect(normalizeCoworkRole(undefined)).toBe("technician");
    expect(normalizeCoworkRole("")).toBe("technician");
    expect(normalizeCoworkRole("unknown_role")).toBe("technician");
    expect(normalizeCoworkRole("expert")).toBe("expert");
    expect(normalizeCoworkRole("admin")).toBe("admin");
    expect(normalizeCoworkRole("technician,admin")).toBe("technician");
    expect(normalizeCoworkRole("expert;technician")).toBe("technician");
  });

  it("parses Cowork generated federation profile and builds DSH MCP SSE patch + Gateway config", () => {
    const profileJson = JSON.stringify({
      version: "1.0.0",
      target: "sugent",
      baseUrl: `${LOOPBACK_BASE}/`,
      workspaceId: "ws-hydraulics",
      identity: {
        userId: "USR-EXPERT-01",
        userName: "王建国",
        role: "expert",
        department: "液压系统专家组",
      },
      gateway: {
        mode: "external",
        baseUrl: `${LOOPBACK_BASE}/v1`,
        apiKey: "emp-token-expert-01",
      },
      mcpServer: {
        serverName: "cowork-hub",
        transport: "sse",
        url: `${LOOPBACK_BASE}/sse`,
        tools: COWORK_STANDARD_TOOLS,
      },
    });

    const cfg = parseCoworkFederationProfile(profileJson);
    expect(cfg.baseUrl).toBe(LOOPBACK_BASE);
    expect(cfg.gatewayBaseUrl).toBe(`${LOOPBACK_BASE}/v1`);
    expect(cfg.mcpSseUrl).toBe(`${LOOPBACK_BASE}/sse`);
    expect(cfg.userRole).toBe("expert");
    expect(cfg.canApproveHitl).toBe(true);
    expect(cfg.workspaceId).toBe("ws-hydraulics");

    const patchLines = buildCoworkMcpPatchLines(cfg).join("\n");
    expect(patchLines).toContain("id: sugent-cowork-hub");
    expect(patchLines).toContain("transport: sse");
    expect(patchLines).toContain(`"${LOOPBACK_BASE}/sse"`);
    expect(patchLines).toContain('"X-User-Id": "USR-EXPERT-01"');
    expect(patchLines).toContain('"X-User-Role": "expert"');
    expect(patchLines).not.toContain("emp-token-expert-01");

    const gwCfg = buildCoworkGatewayConfig(cfg, undefined, {});
    expect(gwCfg.mode).toBe("external");
    expect(gwCfg.baseUrl).toBe(`${LOOPBACK_BASE}/v1`);
    expect(gwCfg.apiKey).toBe("emp-token-expert-01");
  });

  it("seals Cowork PENDING_REVIEW drafts into read-only .context files and gates by HITL permission", () => {
    const ws = makeTempWorkspace();

    const techCfg = resolveCoworkFederationConfig({
      baseUrl: LOOPBACK_BASE,
      employeeToken: "emp-tech-01",
      userId: "USR-TECH-01",
      userRole: "technician",
    });
    const expertCfg = resolveCoworkFederationConfig({
      baseUrl: LOOPBACK_BASE,
      employeeToken: "emp-expert-01",
      userId: "USR-EXPERT-01",
      userRole: "expert",
    });

    expect(() =>
      ingestCoworkPendingEvent(
        expertCfg,
        {
          draft_id: "STG-001",
          summary: "draft",
          permission: "full",
        },
        { workspaceDir: ws },
      ),
    ).toThrowError(SecurityEnvelopeError);

    const draft = {
      draft_id: "STG-20261111-AA01",
      status: "PENDING_REVIEW",
      proposer_id: "USR-TECH-01",
      title: "RAW_DRAFT_TITLE_HYDRAULIC_VALVE",
      summary: "RAW_DRAFT_SUMMARY_NEEDS_EXPERT_CHECK",
      factuality_score: 1.0,
      is_schema_valid: true,
    };

    const techTrigger = ingestCoworkPendingEvent(techCfg, draft, {
      workspaceDir: ws,
      addressedToAgent: true,
    });
    expect(techTrigger.fromAllowedSender).toBe(false);
    expect(evaluatePersonalTrigger(techTrigger).outcome).toBe("ignore_noise");

    const expertTrigger = ingestCoworkPendingEvent(expertCfg, draft, {
      workspaceDir: ws,
      addressedToAgent: true,
    });
    expect(expertTrigger.fromAllowedSender).toBe(true);
    expect(expertTrigger.envelope.contextFile).toBe(".context/event-STG-20261111-AA01.md");
    expect(expertTrigger.text).not.toContain("RAW_DRAFT_TITLE_HYDRAULIC_VALVE");
    expect(expertTrigger.text).not.toContain("RAW_DRAFT_SUMMARY_NEEDS_EXPERT_CHECK");
    expect(fs.statSync(expertTrigger.envelope.absoluteFilePath).mode & 0o777).toBe(0o400);
    expect(evaluatePersonalTrigger(expertTrigger).outcome).toBe("accept_act");
  });

  it("enforces client-side RBAC in CoworkHitlClient before dispatching approve/reject", async () => {
    const requests: CoworkJsonRequest[] = [];
    const mockTransport = async <T>(req: CoworkJsonRequest): Promise<T> => {
      requests.push(req);
      if (req.method === "GET") {
        return [{ draft_id: "STG-100", status: "PENDING_REVIEW" }] as unknown as T;
      }
      return {
        status: req.path.endsWith("/approve") ? "APPROVED" : "REJECTED",
        draft_id: req.body?.draft_id,
        written_triples_count: 2,
        graph_updated: req.path.endsWith("/approve"),
      } as unknown as T;
    };

    const techClient = new CoworkHitlClient(
      resolveCoworkFederationConfig({
        baseUrl: LOOPBACK_BASE,
        employeeToken: "emp-tech-01",
        userId: "USR-TECH-01",
        userRole: "technician",
      }),
      mockTransport,
    );

    const list = await techClient.listPendingDrafts();
    expect(list).toHaveLength(1);
    await expect(techClient.approveDraft("STG-100", "ok")).rejects.toThrowError(
      CoworkPermissionError,
    );
    await expect(techClient.rejectDraft("STG-100", "no")).rejects.toThrowError(
      CoworkPermissionError,
    );
    expect(requests).toHaveLength(1);

    const expertClient = new CoworkHitlClient(
      resolveCoworkFederationConfig({
        baseUrl: LOOPBACK_BASE,
        employeeToken: "emp-expert-01",
        userId: "USR-EXPERT-01",
        userRole: "expert",
      }),
      mockTransport,
    );

    const approved = await expertClient.approveDraft("STG-100", "经复核符合溢流阀压力规范");
    expect(approved.status).toBe("APPROVED");
    expect(approved.graph_updated).toBe(true);

    const rejected = await expertClient.rejectDraft("STG-101", "缺少现场泄油量实测值");
    expect(rejected.status).toBe("REJECTED");
    expect(requests).toHaveLength(3);
  });

  it("polls /api/staging/pending-events incrementally with cursor watermark and seals batches", async () => {
    const ws = makeTempWorkspace();
    const expertCfg = resolveCoworkFederationConfig({
      baseUrl: LOOPBACK_BASE,
      employeeToken: "emp-expert-01",
      userId: "USR-EXPERT-01",
      userRole: "expert",
    });

    const pathsCalled: string[] = [];
    const client = new CoworkHitlClient(expertCfg, async <T>(req: CoworkJsonRequest): Promise<T> => {
      pathsCalled.push(req.path);
      return {
        cursor: 12,
        events: [
          {
            seq: 11,
            draft_id: "STG-INC-11",
            status: "PENDING_REVIEW",
            proposer_id: "USR-TECH-01",
            summary: "RAW_STREAM_TEXT_11",
          },
          {
            seq: 12,
            draft_id: "STG-INC-12",
            status: "PENDING_REVIEW",
            proposer_id: "USR-TECH-01",
            summary: "RAW_STREAM_TEXT_12",
          },
        ],
      } as unknown as T;
    });

    const batch = await client.ingestPendingEventsBatch({
      workspaceDir: ws,
      afterSeq: 10,
      limit: 20,
      addressedToAgent: true,
    });

    expect(pathsCalled).toEqual(["/api/staging/pending-events?after_seq=10&limit=20"]);
    expect(batch.cursor).toBe(12);
    expect(batch.triggers).toHaveLength(2);
    expect(batch.triggers[0]?.text).not.toContain("RAW_STREAM_TEXT_11");
    expect(fs.existsSync(batch.triggers[1]!.envelope.absoluteFilePath)).toBe(true);
  });
});

