import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COLD_START_SINGLE_ACTION_PROMPT,
  completeColdStartApprovalDemo,
  ingestColdStartDrop,
  probeColdStartReadiness,
} from "../src/sugent/cold-start-onboarding.js";
import { SuspendedRoundStore } from "../src/sugent/receipt-protocol.js";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";

describe("Wave P1.1 Zero-Form 3-Minute Cold-Start Engine", () => {
  const tmpDirs: string[] = [];
  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("probes empty ledger with requiresForm=false, single-action prompt, and local CLI detection", () => {
    const root = mkTmp("sugent-p1-probe-");
    const ledger = new StewardshipLedger({ dataDir: path.join(root, "ledger") });

    const report = probeColdStartReadiness({
      ledger,
      hasLiveLlm: false,
      whichFn: (bin) => bin === "claude" || bin === "opencode",
    });

    expect(report.needsColdStart).toBe(true);
    expect(report.requiresForm).toBe(false);
    expect(report.promptSingleAction).toBe(COLD_START_SINGLE_ACTION_PROMPT);
    expect(report.detectedClis).toEqual(["claude", "opencode"]);
    expect(report.executionTier).toBe("local_cli");
  });

  it("ingests a dropped project folder in milliseconds into ResourceEntry + CommitmentItem + zero-cost checkpoint", () => {
    const root = mkTmp("sugent-p1-drop-");
    const projDir = path.join(root, "billing-gateway");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(
      path.join(projDir, "package.json"),
      JSON.stringify({ name: "billing-gateway", dependencies: { typescript: "^5.0.0", fastify: "^5.0.0" } }),
    );
    fs.writeFileSync(
      path.join(projDir, "README.md"),
      "# 支付结算网关\n\n## 待推进\n- [ ] 补齐支付回调验签与幂等锁\n",
    );

    const ledger = new StewardshipLedger({ dataDir: path.join(root, "ledger") });
    const suspendedStore = new SuspendedRoundStore(path.join(root, "suspended"));

    const t0 = performance.now();
    const res = ingestColdStartDrop({
      ledger,
      suspendedStore,
      folderPath: projDir,
      nowIso: "2026-11-24T12:00:00.000Z",
    });
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(150);
    expect(res.sourceKind).toBe("folder");
    expect(res.resource.kind).toBe("personal_archive");
    expect(res.resource.title).toContain("支付结算网关");
    expect(res.commitment.summary).toContain("补齐支付回调验签与幂等锁");
    expect(res.checkpoint.status).toBe("suspended");
    expect(suspendedStore.listPending()).toHaveLength(1);

    const afterProbe = probeColdStartReadiness({ ledger });
    expect(afterProbe.needsColdStart).toBe(false);
  });

  it("ingests forwarded chat message, extracts due date & counterparty, and completes one-shot approval demo idempotently", () => {
    const root = mkTmp("sugent-p1-fwd-");
    const ledger = new StewardshipLedger({ dataDir: path.join(root, "ledger") });
    const suspendedStore = new SuspendedRoundStore(path.join(root, "suspended"));

    const dropped = ingestColdStartDrop({
      ledger,
      suspendedStore,
      forwardedText: "【转发】张总：麻烦本周五前把二期采购合同初稿发给法务确认",
      nowIso: "2026-11-24T09:00:00.000Z", // Tuesday -> Friday is 2026-11-27
    });

    expect(dropped.sourceKind).toBe("forwarded_text");
    expect(dropped.commitment.counterpartyOrRef).toBe("张总");
    expect(dropped.commitment.dueAt).toContain("2026-11-27");

    const decided1 = completeColdStartApprovalDemo({
      suspendedStore,
      ledger,
      roundId: dropped.roundId,
      approved: true,
      nowIso: "2026-11-24T09:01:00.000Z",
    });
    expect(decided1.alreadyResolved).toBe(false);
    expect(decided1.approved).toBe(true);
    expect(decided1.commitmentStatus).toBe("closed");

    const decided2 = completeColdStartApprovalDemo({
      suspendedStore,
      ledger,
      roundId: dropped.roundId,
      approved: true,
      nowIso: "2026-11-24T09:02:00.000Z",
    });
    expect(decided2.alreadyResolved).toBe(true);
  });
});
