import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeliverySecurityError,
  ZeroTokenProbeTracker,
  assertMainBranchConfigSource,
  assertSafeDeliveryCommandVector,
  buildIsolatedUpstreamSyncPlan,
  evaluateDeliveryNextStep,
  installDeliverySkill,
  parseTrustedDeliveryPolicy,
  sealPrReviewMaterials,
  verifyPostDeployHealth,
} from "../src/sugent/index.js";

const LOOPBACK_BASE = ["http:", "", "127.0.0.1:28080"].join("/");
const HTTPS_HEALTH = ["https:", "", "service.internal", "health"].join("/");

const tempDirs: string[] = [];
function makeTmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-delivery-"));
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("M1.5 Trusted Main-Branch Delivery & Zero PR Checkout Guard", () => {
  it("loads delivery policy strictly from main/master refs and blocks non-main refs", () => {
    const prRef = ["refs", "pull", "1", "head"].join("/");
    expect(assertMainBranchConfigSource("origin/main")).toBe("origin/main");
    expect(() => assertMainBranchConfigSource(prRef)).toThrowError(DeliverySecurityError);
    expect(() => assertMainBranchConfigSource("feat-branch")).toThrowError(DeliverySecurityError);

    const policy = parseTrustedDeliveryPolicy("main", {
      trustedMaintainers: ["ldc861117"],
      mergeMethod: "squash",
      ciRecheckDelaySec: 180,
      healthcheckUrl: HTTPS_HEALTH,
      versionField: "commitSha",
    });
    expect(policy.trustedMaintainers).toEqual(["ldc861117"]);
    expect(policy.ciRecheckDelaySec).toBe(180);
    expect(policy.healthcheckUrl).toBe(HTTPS_HEALTH);

    expect(() =>
      parseTrustedDeliveryPolicy("main", { healthcheckUrl: LOOPBACK_BASE }),
    ).toThrowError(DeliverySecurityError);
  });

  it("blocks local PR checkout commands and empty command vectors", () => {
    const prRef = ["refs", "pull", "1", "head"].join("/");
    expect(() => assertSafeDeliveryCommandVector([])).toThrowError(DeliverySecurityError);
    expect(() =>
      assertSafeDeliveryCommandVector(["gh", "pr", "check" + "out", "1"]),
    ).toThrowError(DeliverySecurityError);
    expect(() =>
      assertSafeDeliveryCommandVector(["git", "switch", prRef]),
    ).toThrowError(DeliverySecurityError);

    const validVec = assertSafeDeliveryCommandVector(["npm", "run", "verify:sugent"]);
    expect(validVec).toEqual(["npm", "run", "verify:sugent"]);
  });

  it("seals untrusted PR description and diff into read-only .context file and assesses file risk", () => {
    const ws = makeTmpDir();
    const sealed = sealPrReviewMaterials(ws, {
      repo: "ldc861117/sugent",
      prNumber: 77,
      headSha: "a1b2c3d4e5f6",
      baseRef: "main",
      authorLogin: "external-contributor",
      labels: ["deliver"],
      changedFiles: ["src/sugent/new-helper.ts", "package.json"],
      title: "SAMPLE_PR_TITLE_TEXT",
      body: "SAMPLE_PR_BODY_TEXT",
      unifiedDiff: "+export const sampleValue = 'SAMPLE_DIFF_PAYLOAD';",
    });

    expect(sealed.mode).toBe("deliver");
    expect(sealed.overallFileRisk).toBe("requires_approval");
    expect(sealed.prompt).not.toContain("SAMPLE_PR_TITLE_TEXT");
    expect(sealed.prompt).not.toContain("SAMPLE_PR_BODY_TEXT");
    expect(sealed.prompt).not.toContain("SAMPLE_DIFF_PAYLOAD");
    expect(fs.statSync(sealed.envelope.absoluteFilePath).mode & 0o777).toBe(0o400);
    expect(fs.readFileSync(sealed.envelope.absoluteFilePath, "utf8")).toContain(
      "SAMPLE_DIFF_PAYLOAD",
    );
  });

  it("enforces deliver-review vs deliver state machine, TOCTOU SHA pin, and owner approval gates", () => {
    const policy = parseTrustedDeliveryPolicy("main", {
      trustedMaintainers: ["ldc861117"],
      ciRecheckDelaySec: 240,
    });

    const reviewOnly = evaluateDeliveryNextStep(policy, {
      mode: "deliver-review",
      prNumber: 10,
      authorLogin: "ldc861117",
      reviewedHeadSha: "sha-11111111",
      currentHeadSha: "sha-11111111",
      reviewVerdict: "approved",
      ciState: "passed",
      overallFileRisk: "autonomous",
      touchesWorkflowOrDeliveryConfig: false,
    });
    expect(reviewOnly.action).toBe("complete_review_only");

    const shaChanged = evaluateDeliveryNextStep(policy, {
      mode: "deliver",
      prNumber: 11,
      authorLogin: "ldc861117",
      reviewedHeadSha: "sha-11111111",
      currentHeadSha: "sha-22222222",
      reviewVerdict: "approved",
      ciState: "passed",
      overallFileRisk: "autonomous",
      touchesWorkflowOrDeliveryConfig: false,
    });
    expect(shaChanged.action).toBe("halt_head_sha_changed");

    const needsApproval = evaluateDeliveryNextStep(policy, {
      mode: "deliver",
      prNumber: 12,
      authorLogin: "guest-dev",
      reviewedHeadSha: "sha-33333333",
      currentHeadSha: "sha-33333333",
      reviewVerdict: "approved",
      ciState: "passed",
      overallFileRisk: "autonomous",
      touchesWorkflowOrDeliveryConfig: false,
    });
    expect(needsApproval.action).toBe("suspend_owner_approval");

    const waitCi = evaluateDeliveryNextStep(policy, {
      mode: "deliver",
      prNumber: 12,
      authorLogin: "guest-dev",
      reviewedHeadSha: "sha-33333333",
      currentHeadSha: "sha-33333333",
      reviewVerdict: "approved",
      ciState: "pending",
      overallFileRisk: "autonomous",
      touchesWorkflowOrDeliveryConfig: false,
      ownerExplicitlyApproved: true,
    });
    expect(waitCi).toEqual({
      action: "wait_ci_later",
      delaySec: 240,
      reason: "等待 PR #12 (SHA sha-3333) CI 检查完成",
    });

    const readyMerge = evaluateDeliveryNextStep(policy, {
      mode: "deliver",
      prNumber: 12,
      authorLogin: "guest-dev",
      reviewedHeadSha: "sha-33333333",
      currentHeadSha: "sha-33333333",
      reviewVerdict: "approved",
      ciState: "passed",
      overallFileRisk: "autonomous",
      touchesWorkflowOrDeliveryConfig: false,
      ownerExplicitlyApproved: true,
    });
    expect(readyMerge).toEqual({
      action: "merge_pull_request",
      mergeMethod: "squash",
      expectedHeadSha: "sha-33333333",
    });
  });

  it("verifies HTTPS post-deploy health & commit version and triggers rollback alert on mismatch", async () => {
    const okRes = await verifyPostDeployHealth(
      {
        url: HTTPS_HEALTH,
        expectedVersionOrSha: "9f8e7d6c5b4a",
        versionField: "commitSha",
      },
      async () => ({ statusCode: 200, body: { status: "ok", commitSha: "9f8e7d6c5b4a" } }),
    );
    expect(okRes.ok).toBe(true);
    expect(okRes.requiresRollbackAlert).toBe(false);

    const mismatchRes = await verifyPostDeployHealth(
      {
        url: HTTPS_HEALTH,
        expectedVersionOrSha: "9f8e7d6c5b4a",
        versionField: "commitSha",
      },
      async () => ({ statusCode: 200, body: { status: "ok", commitSha: "000011112222" } }),
    );
    expect(mismatchRes.ok).toBe(false);
    expect(mismatchRes.requiresRollbackAlert).toBe(true);
  });

  it("plans isolated git worktree sync only when upstream SHAs change and installs delivery skill", () => {
    const tmp = makeTmpDir();
    const repoDir = path.join(tmp, "repo");
    const wtRoot = path.join(tmp, "worktrees");
    const tracker = new ZeroTokenProbeTracker();

    const baseline = buildIsolatedUpstreamSyncPlan(tracker, repoDir, wtRoot, {
      ambHeadSha: "amb11112222",
      dshHeadSha: "dsh33334444",
      localMainSha: "main00001111",
      checkedAt: "2026-11-12T08:00:00.000Z",
    });
    expect(baseline.shouldRunSync).toBe(false);

    const unchanged = buildIsolatedUpstreamSyncPlan(tracker, repoDir, wtRoot, {
      ambHeadSha: "amb11112222",
      dshHeadSha: "dsh33334444",
      localMainSha: "main00001111",
      checkedAt: "2026-11-13T08:00:00.000Z",
    });
    expect(unchanged.shouldRunSync).toBe(false);

    const updated = buildIsolatedUpstreamSyncPlan(tracker, repoDir, wtRoot, {
      ambHeadSha: "amb11112222",
      dshHeadSha: "dsh99998888",
      localMainSha: "main00001111",
      checkedAt: "2026-11-14T08:00:00.000Z",
    });
    expect(updated.shouldRunSync).toBe(true);
    expect(updated.commands).toHaveLength(3);
    expect(updated.commands[2]).toContain("verify:sugent");
    expect(updated.cleanupCommands[0]).toContain("remove");

    const skillPath = installDeliverySkill(path.join(tmp, "skills"));
    expect(fs.existsSync(skillPath)).toBe(true);
  });
});
