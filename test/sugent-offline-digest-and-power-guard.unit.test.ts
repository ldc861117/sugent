import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StewardshipLedger } from "../src/sugent/stewardship-ledger.js";
import {
  E2eeOfflineDigestVault,
  PowerSaveBlockerController,
  buildOfflineLedgerDigest,
} from "../src/sugent/offline-digest-and-power-guard.js";

describe("Wave P2.1 Offline Resilience: PowerSaveBlocker & E2EE Offline Digest Vault", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p2-1-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("manages PowerSaveBlockerController modes, enforces 8h battery ceiling, and releases handles cleanly", () => {
    const started: Array<{ id: number; mode: string }> = [];
    const stopped: number[] = [];
    let nextId = 10;

    const ctl = new PowerSaveBlockerController({
      maxDurationMs: 8 * 3600_000,
      driver: {
        start: (mode) => {
          const id = ++nextId;
          started.push({ id, mode });
          return id;
        },
        stop: (id) => {
          stopped.push(id);
        },
        isStarted: (id) => !stopped.includes(id),
      },
    });

    const t0 = 1_700_000_000_000;
    expect(ctl.getStatus(t0)).toEqual({
      active: false,
      mode: "off",
      blockerId: null,
      expiresAtMs: null,
      headlessFallback: false,
    });

    // Requesting 24h clamps down to 8h safety ceiling
    const s1 = ctl.enable("prevent-app-suspension", { durationMs: 24 * 3600_000, nowMs: t0 });
    expect(s1.active).toBe(true);
    expect(s1.mode).toBe("prevent-app-suspension");
    expect(s1.blockerId).toBe(11);
    expect(s1.expiresAtMs).toBe(t0 + 8 * 3600_000);

    // Switching mode stops previous handle first (zero handle leak)
    const s2 = ctl.enable("prevent-display-sleep", { durationMs: 1_800_000, nowMs: t0 + 1_000 });
    expect(stopped).toEqual([11]);
    expect(s2.blockerId).toBe(12);
    expect(s2.mode).toBe("prevent-display-sleep");

    // Not expired yet
    expect(ctl.checkAutoExpire(t0 + 1_800_999)).toBe(false);
    // Auto-expires at deadline
    expect(ctl.checkAutoExpire(t0 + 1_801_000)).toBe(true);
    expect(stopped).toEqual([11, 12]);
    expect(ctl.getStatus(t0 + 1_801_000).active).toBe(false);
  });

  it("builds read-only OfflineLedgerDigest stripping localUriOrPath and marking due-soon commitments", () => {
    const ledger = new StewardshipLedger(tmpDir);
    const nowIso = "2026-11-25T08:00:00.000Z";

    ledger.upsertGoal(
      {
        id: "g-active",
        partition: "work_project",
        title: "完成工业异常诊断首单",
        northStarCriterion: "14天零事故压测通过",
        status: "active",
      },
      { nowIso },
    );
    ledger.upsertGoal(
      {
        id: "g-paused",
        partition: "personal_life",
        title: "归档旧相册",
        northStarCriterion: "整理完NAS",
        status: "paused",
      },
      { nowIso },
    );
    ledger.addGuardrail(
      {
        id: "gr-red",
        partition: "work_project",
        kind: "hard_redline",
        statement: "绝不接受超过 60 天账期",
      },
      nowIso,
    );
    ledger.addGuardrail(
      {
        id: "gr-taste",
        partition: "personal_life",
        kind: "soft_taste",
        statement: "回复保持简短",
      },
      nowIso,
    );
    ledger.upsertCommitment(
      {
        id: "c-soon",
        partition: "work_project",
        direction: "i_owe",
        status: "open",
        summary: "向沪东船厂发送阶段诊断报告",
        counterpartyOrRef: "沪东项目组",
        dueAt: "2026-11-26T10:00:00.000Z",
      },
      nowIso,
    );
    ledger.upsertResource(
      {
        id: "r-archive",
        partition: "work_project",
        kind: "personal_archive",
        title: "2026工业FDE标准报价单",
        localUriOrPath: "/Users/secret_owner/PrivateContracts/quote-2026.pdf",
        metadata: { floorPrice: 180000 },
      },
      nowIso,
    );

    const digest = buildOfflineLedgerDigest(ledger, { nowIso, dueSoonHours: 48 });
    expect(digest.goals.map((g) => g.id)).toEqual(["g-active"]);
    expect(digest.redlines.map((r) => r.id)).toEqual(["gr-red"]);
    expect(digest.commitments).toHaveLength(1);
    expect(digest.commitments[0]?.isDueSoon).toBe(true);
    expect(digest.archiveTitles).toEqual([
      {
        id: "r-archive",
        kind: "personal_archive",
        title: "2026工业FDE标准报价单",
        partition: "work_project",
      },
    ]);
    expect(JSON.stringify(digest)).not.toContain("/Users/secret_owner");
    expect(JSON.stringify(digest)).not.toContain("quote-2026.pdf");
  });

  it("seals/opens E2EE offline digest and idempotently drains mobile queued tasks into StewardshipLedger on wake", () => {
    const ledger = new StewardshipLedger(tmpDir);
    const pass = "correct-horse-battery-staple-2026";
    const sub = "usr_andy_01";
    const nowIso = "2026-11-25T09:00:00.000Z";

    ledger.upsertGoal(
      {
        id: "g-1",
        partition: "work_project",
        title: "收官 Wave P2",
        northStarCriterion: "全部门禁通过",
      },
      { nowIso },
    );

    const vault = new E2eeOfflineDigestVault({ dataDir: tmpDir, kdfIterations: 100_000 });
    const sealedDigest = vault.sealDigestSnapshot({
      ledger,
      passphrase: pass,
      subjectSub: sub,
      deviceId: "mac-studio",
      lamportClock: 5,
      nowIso,
    });
    expect(JSON.stringify(sealedDigest)).not.toContain("收官 Wave P2");

    const opened = vault.openDigestSnapshot({
      envelope: sealedDigest,
      passphrase: pass,
      expectedSubjectSub: sub,
    });
    expect(opened.goals[0]?.title).toBe("收官 Wave P2");

    // Enqueue 2 tasks while laptop lid is closed (out-of-order lamport clocks + duplicate replay)
    const envTask2 = vault.enqueueEncryptedOfflineTask({
      task: {
        taskId: "mob-task-2",
        summary: "周五前核对二期合同付款节点",
        counterpartyOrRef: "财务王总",
        partition: "work_project",
        dueAt: "2026-11-27T18:00:00.000Z",
      },
      passphrase: pass,
      subjectSub: sub,
      mobileDeviceId: "iphone-wechat-pwa",
      lamportClock: 7,
      nowIso,
    });
    const envTask1 = vault.enqueueEncryptedOfflineTask({
      task: {
        taskId: "mob-task-1",
        summary: "回电确认船厂现场调研名单",
        counterpartyOrRef: "张工",
        partition: "work_project",
      },
      passphrase: pass,
      subjectSub: sub,
      mobileDeviceId: "iphone-wechat-pwa",
      lamportClock: 6,
      nowIso,
    });

    // Rejects cross-type confusion (passing task envelope to openDigestSnapshot)
    expect(() =>
      vault.openDigestSnapshot({
        envelope: envTask1,
        passphrase: pass,
        expectedSubjectSub: sub,
      }),
    ).toThrow();

    const drained1 = vault.drainOfflineTaskQueueOnWake({
      envelopes: [envTask2, envTask1, envTask1],
      passphrase: pass,
      expectedSubjectSub: sub,
      ledger,
      nowIso: "2026-11-25T12:00:00.000Z",
    });
    expect(drained1).toEqual({
      ingestedCount: 2,
      skippedDuplicateCount: 1,
      committedIds: ["offline-mob-task-1", "offline-mob-task-2"],
    });

    // Reload vault from disk and verify cross-restart idempotency + 0o600 file mode
    const vaultReloaded = new E2eeOfflineDigestVault({ dataDir: tmpDir, kdfIterations: 100_000 });
    const drained2 = vaultReloaded.drainOfflineTaskQueueOnWake({
      envelopes: [envTask1, envTask2],
      passphrase: pass,
      expectedSubjectSub: sub,
      ledger,
    });
    expect(drained2.ingestedCount).toBe(0);
    expect(drained2.skippedDuplicateCount).toBe(2);

    const queuePath = path.join(tmpDir, "sugent-offline-vault", "processed-queue.json");
    expect(fs.existsSync(queuePath)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(queuePath).mode & 0o777).toBe(0o600);
    }
  });
});
