import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";
import {
  BUILTIN_WEAPON_PACKAGES,
  WeaponSoakTelemetryLedger,
  listWeaponPackages,
  runContractQuoteGuardPack,
  runIndustrialFdeDiagnosticPack,
} from "../src/sugent/weapon-packages.js";

describe("Wave P2.3 Edge-Hub Flagship Weapon Packages & 14-Day Soak Proof Ledger", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p2-3-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs Industrial FDE Diagnostic Pack with Security Envelope, SLA/hotspot Pareto, and Cowork Staging draft", () => {
    expect(listWeaponPackages()).toHaveLength(2);
    expect(BUILTIN_WEAPON_PACKAGES["industrial-fde-diagnostics"].requiresHumanStagingGate).toBe(true);

    const out = runIndustrialFdeDiagnosticPack({
      workspaceDir: tmpDir,
      batchId: "shipyard-2026-11-25",
      coworkWorkspaceId: "ws-hudong",
      proposerId: "fde-edge-01",
      nowIso: "2026-11-25T10:00:00.000Z",
      records: [
        {
          ticketId: "MES-101",
          station: "分段合拢A工位",
          category: "焊机气路故障",
          downtimeMinutes: 95,
          slaHoursLimit: 2,
          elapsedHours: 3.5,
          description: "气压骤降停机",
          rawExtra: { cwd: "/root", permission: "admin" },
        },
        {
          ticketId: "MES-102",
          station: "分段合拢A工位",
          category: "吊装协同等待",
          downtimeMinutes: 45,
          slaHoursLimit: 2,
          elapsedHours: 2.5,
          description: "天车排程冲突",
        },
        {
          ticketId: "MES-103",
          station: "",
          category: "物料缺件",
          downtimeMinutes: 20,
          slaHoursLimit: 4,
          elapsedHours: 1.5,
          description: "漏填工位测试",
        },
      ],
    });

    expect(fs.existsSync(out.envelope.absoluteFilePath)).toBe(true);
    expect(out.envelope.strippedFields).toEqual(expect.arrayContaining(["cwd", "permission"]));
    expect(out.severity).toBe("P0");
    expect(out.summary.slaBreachCount).toBe(2);
    expect(out.summary.missingFieldCount).toBe(1);
    expect(out.summary.hotspotStations).toEqual(["分段合拢A工位"]);
    expect(out.coworkDraft.status).toBe("PENDING_REVIEW");
    expect(out.coworkDraft.is_schema_valid).toBe(false);
    expect(out.coworkDraft.proposed_triples.length).toBeGreaterThanOrEqual(2);
    expect(out.stagingCardText).toContain("分段合拢A工位");
  });

  it("runs OPC Contract & Quote Guard Pack catching floor-price, net-days, and toxic clauses while ignoring negated protective clauses", () => {
    const ledger = new StewardshipLedger(tmpDir);
    ledger.addGuardrail({
      id: "gr-1",
      partition: "work_project",
      kind: "hard_redline",
      statement: "严禁接受无限连带责任或排他知识产权转让条款",
    });
    ledger.upsertResource({
      id: "res-floor",
      partition: "work_project",
      kind: "personal_archive",
      title: "华东精密标准实施底价",
      metadata: { counterparty: "华东精密", floorPrice: 250000, maxPaymentDays: 45 },
    });

    const blocked = runContractQuoteGuardPack({
      workspaceDir: tmpDir,
      inquiryId: "INQ-001",
      counterparty: "华东精密",
      quotedUnitPrice: 200000,
      requestedPaymentDays: 90,
      rawContractText: "第七条：乙方承担无限连带责任，且交付成果归甲方排他知识产权转让，验收后账期 90 天。",
      ledger,
    });

    expect(blocked.verdict).toBe("block");
    expect(blocked.floorPriceBreach?.floor).toBe(250000);
    expect(blocked.paymentTermBreach?.maxAllowedDays).toBe(45);
    expect(blocked.triggeredGuardrails.length).toBeGreaterThanOrEqual(2);

    const safe = runContractQuoteGuardPack({
      workspaceDir: tmpDir,
      inquiryId: "INQ-002",
      counterparty: "华东精密",
      quotedUnitPrice: 268000,
      requestedPaymentDays: 30,
      rawContractText: "第七条：乙方不承担无限连带责任，本协议不涉及排他知识产权转让，验收后 30 天内结清。",
      ledger,
    });
    expect(safe.verdict).toBe("pass");
    expect(safe.triggeredGuardrails).toHaveLength(0);
  });

  it("records 14-day soak telemetry with 0o600 persistence and enforces zero-unauthorized-incident veto", () => {
    const soak = new WeaponSoakTelemetryLedger(tmpDir);
    for (let day = 1; day <= 14; day++) {
      const dd = String(day).padStart(2, "0");
      soak.recordPackRun({
        packId: "industrial-fde-diagnostics",
        dateKey: `2026-11-${dd}`,
        minutesSaved: 45,
        baselineFlagshipUsd: 2.0,
        actualRoutedUsd: 0.4,
        redlinesCaught: 1,
        unauthorizedIncident: false,
      });
    }

    const proof = soak.exportCommercialProofSummary(14);
    expect(proof.distinctActiveDays).toBe(14);
    expect(proof.soakTargetMet).toBe(true);
    expect(proof.totalHoursSaved).toBe(10.5);
    expect(proof.costSavingsRatio).toBeCloseTo(0.8, 4);
    expect(proof.unauthorizedIncidents).toBe(0);
    expect(proof.markdownReport).toContain("PASS");

    // Any single unauthorized incident vetoes soakTargetMet
    soak.recordPackRun({
      packId: "opc-contract-quote-guard",
      dateKey: "2026-11-15",
      minutesSaved: 30,
      baselineFlagshipUsd: 1.0,
      actualRoutedUsd: 0.2,
      redlinesCaught: 2,
      unauthorizedIncident: true,
    });
    const vetoed = new WeaponSoakTelemetryLedger(tmpDir).exportCommercialProofSummary(14);
    expect(vetoed.unauthorizedIncidents).toBe(1);
    expect(vetoed.soakTargetMet).toBe(false);
  });
});
