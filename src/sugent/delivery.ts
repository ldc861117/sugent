/**
 * Sugent M1.5 安全自举维护官与标签驱动 PR 自动交付引擎（src/sugent/delivery.ts）
 *
 * 对应 Roadmap M1.5，融合双上游同步自举机制与 Agent-Autoloop 的主干受信交付安全边界：
 * 1. 主干唯一受信原则（Main-Branch-Only Policy）：
 *    - 交付规则与门禁配置仅允许从受信主干（`main` / `origin/main`）解析，严禁读取外来 PR 分支里的配置或工作流定义；
 * 2. 外来 PR 零检出与参数数组防注入（Zero Untrusted Checkout）：
 *    - 审查外部或协作者 PR 时仅通过只读元数据与统一 Diff 文本分析，并经 M1.4 `sealExternalEvent` 落盘只读 `.context/event-pr-<n>.md`；
 *    - 命令白名单拦截任何在宿主机检出外来 PR 代码的操作；
 * 3. 标签驱动双流状态机（`deliver-review` vs `deliver`）：
 *    - `deliver-review`：只审不合，输出结构化代码审查结论后立即收尾；
 *    - `deliver`：`审代码 -> 核对 SHA 一致性防掉包 -> 等 CI 绿灯（未完则预约 later 零消耗复查） -> 合并主干 -> HTTPS 线上健康与版本核验`；
 * 4. 双上游隔离工作树自举巡检（Isolated Worktree Upstream Sync）：
 *    - 每日先经零 Token 前置探针比对 `upstream-amb/master` 与 `upstream-dsh/main` 最新 Commit 指纹，无更新直接 0 Token 退出；
 *    - 有更新时在独立临时 `git worktree` 中合并并执行 `npm run verify:sugent`，绝不污染开发者当前工作区。
 */
import fs from "node:fs";
import path from "node:path";
import {
  sealExternalEvent,
  validateSafeMetadataToken,
  validateSafeMetadataUrl,
} from "./security-envelope.js";
import { assessSelfEditPath, type EvolutionRiskLevel } from "./self-evolution.js";
import { ZeroTokenProbeTracker } from "./sources.js";
import type { EventSecurityEnvelope } from "./types.js";

export type DeliveryLabelMode = "deliver-review" | "deliver";

export type DeliveryErrorCode =
  | "untrusted_config_ref"
  | "untrusted_pr_checkout_forbidden"
  | "unsafe_command_vector"
  | "insecure_healthcheck_url"
  | "invalid_delivery_config";

export class DeliverySecurityError extends Error {
  readonly code: DeliveryErrorCode;

  constructor(code: DeliveryErrorCode, message: string) {
    super(message);
    this.name = "DeliverySecurityError";
    this.code = code;
  }
}

export interface TrustedDeliveryPolicy {
  trustedBaseBranch: string;
  trustedMaintainers: string[];
  mergeMethod: "squash" | "merge" | "rebase";
  ciRecheckDelaySec: number;
  healthcheckUrl?: string;
  versionField?: string;
}

export const DEFAULT_TRUSTED_DELIVERY_POLICY: TrustedDeliveryPolicy = {
  trustedBaseBranch: "main",
  trustedMaintainers: [],
  mergeMethod: "squash",
  ciRecheckDelaySec: 300,
  versionField: "version",
};

const TRUSTED_CONFIG_REFS = new Set([
  "main",
  "master",
  "origin/main",
  "origin/master",
  "refs/heads/main",
  "refs/heads/master",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
]);

export function assertMainBranchConfigSource(gitRef: string): string {
  const trimmed = String(gitRef ?? "").trim();
  if (!TRUSTED_CONFIG_REFS.has(trimmed)) {
    throw new DeliverySecurityError(
      "untrusted_config_ref",
      `Delivery policy must be loaded strictly from main branch; rejected untrusted ref "${trimmed}".`,
    );
  }
  return trimmed;
}

export function parseTrustedDeliveryPolicy(
  gitRef: string,
  rawJsonOrObject?: string | Record<string, unknown>,
): TrustedDeliveryPolicy {
  assertMainBranchConfigSource(gitRef);
  if (!rawJsonOrObject) {
    return { ...DEFAULT_TRUSTED_DELIVERY_POLICY };
  }

  let obj: Record<string, unknown>;
  try {
    const parsed =
      typeof rawJsonOrObject === "string" ? JSON.parse(rawJsonOrObject) : rawJsonOrObject;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Root must be a JSON object.");
    }
    obj = parsed as Record<string, unknown>;
  } catch (e) {
    throw new DeliverySecurityError(
      "invalid_delivery_config",
      `Invalid main-branch delivery config: ${(e as Error).message}`,
    );
  }

  const trustedBaseBranch =
    typeof obj.trustedBaseBranch === "string" && obj.trustedBaseBranch.trim()
      ? validateSafeMetadataToken(obj.trustedBaseBranch, "trustedBaseBranch")
      : DEFAULT_TRUSTED_DELIVERY_POLICY.trustedBaseBranch;

  const trustedMaintainers = Array.isArray(obj.trustedMaintainers)
    ? obj.trustedMaintainers
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => validateSafeMetadataToken(x, "maintainer"))
    : [];

  const rawMethod = String(obj.mergeMethod ?? "squash").toLowerCase();
  const mergeMethod: "squash" | "merge" | "rebase" =
    rawMethod === "merge" || rawMethod === "rebase" ? rawMethod : "squash";

  const rawDelay = Number(obj.ciRecheckDelaySec ?? DEFAULT_TRUSTED_DELIVERY_POLICY.ciRecheckDelaySec);
  const ciRecheckDelaySec =
    Number.isFinite(rawDelay) && rawDelay >= 30 && rawDelay <= 86_400
      ? Math.trunc(rawDelay)
      : DEFAULT_TRUSTED_DELIVERY_POLICY.ciRecheckDelaySec;

  let healthcheckUrl: string | undefined;
  if (typeof obj.healthcheckUrl === "string" && obj.healthcheckUrl.trim()) {
    const validated = validateSafeMetadataUrl(obj.healthcheckUrl);
    const parsedUrl = validated ? new URL(validated) : undefined;
    if (!validated || parsedUrl?.protocol !== "https:") {
      throw new DeliverySecurityError(
        "insecure_healthcheck_url",
        "Production delivery healthcheckUrl must use HTTPS.",
      );
    }
    healthcheckUrl = validated;
  }

  const versionField =
    typeof obj.versionField === "string" && obj.versionField.trim()
      ? validateSafeMetadataToken(obj.versionField, "versionField")
      : DEFAULT_TRUSTED_DELIVERY_POLICY.versionField;

  return {
    trustedBaseBranch,
    trustedMaintainers,
    mergeMethod,
    ciRecheckDelaySec,
    ...(healthcheckUrl ? { healthcheckUrl } : {}),
    versionField,
  };
}

const SHELL_BINARIES = new Set(["sh", "bash", "zsh", "cmd", "pwsh", "powershell"]);
const SHELL_EVAL_FLAGS = new Set(["-" + "c", "/" + "c", "-Command"]);

export function assertSafeDeliveryCommandVector(argv: readonly string[]): readonly [string, ...string[]] {
  if (!Array.isArray(argv) || argv.length === 0 || !argv[0]?.trim()) {
    throw new DeliverySecurityError("unsafe_command_vector", "Command vector must be non-empty.");
  }

  const bin = path.basename(argv[0].trim()).toLowerCase();
  const rest = argv.slice(1).map((a) => String(a ?? ""));

  if (SHELL_BINARIES.has(bin) && rest.some((a) => SHELL_EVAL_FLAGS.has(a))) {
    throw new DeliverySecurityError(
      "unsafe_command_vector",
      `Shell string evaluation (${bin}) is forbidden in delivery pipeline; pass explicit argument arrays.`,
    );
  }

  if (bin === "gh" && rest[0] === "pr" && rest[1] === "checkout") {
    throw new DeliverySecurityError(
      "untrusted_pr_checkout_forbidden",
      "Checking out PR code onto the host via 'gh pr checkout' is strictly forbidden.",
    );
  }

  if (bin === "git") {
    const sub = rest.find((a) => !a.startsWith("-"));
    const joined = rest.join(" ");
    if (
      (sub === "checkout" || sub === "switch" || sub === "merge" || sub === "pull" || sub === "worktree") &&
      /(?:refs\/pull\/|pull\/\d+\/|pr-\d+)/i.test(joined)
    ) {
      throw new DeliverySecurityError(
        "untrusted_pr_checkout_forbidden",
        `Checking out or merging untrusted PR ref locally is forbidden: git ${joined}`,
      );
    }
  }

  return [argv[0].trim(), ...rest];
}

export interface PullRequestReviewPacket {
  repo: string;
  prNumber: number;
  headSha: string;
  baseRef: string;
  authorLogin: string;
  labels: string[];
  changedFiles: string[];
  title: string;
  body: string;
  unifiedDiff: string;
  url?: string;
}

export interface SealedPrReviewContext {
  mode: DeliveryLabelMode | "ignore";
  envelope: EventSecurityEnvelope;
  prompt: string;
  overallFileRisk: EvolutionRiskLevel;
  touchesWorkflowOrDeliveryConfig: boolean;
}

const PROTECTED_DELIVERY_PREFIXES = [
  ".sugent-delivery.json",
  ".github/",
  "scripts/sync-upstreams.mjs",
];

export function resolveDeliveryLabelMode(labels: readonly string[]): DeliveryLabelMode | "ignore" {
  const normalized = new Set(labels.map((l) => String(l ?? "").trim().toLowerCase()));
  if (normalized.has("deliver")) return "deliver";
  if (normalized.has("deliver-review")) return "deliver-review";
  return "ignore";
}

export function sealPrReviewMaterials(
  workspaceDir: string,
  packet: PullRequestReviewPacket,
): SealedPrReviewContext {
  const prNum = Math.trunc(Number(packet.prNumber));
  if (!Number.isInteger(prNum) || prNum <= 0) {
    throw new Error(`Invalid PR number: ${packet.prNumber}`);
  }
  const safeRepo = packet.repo
    .split("/")
    .map((seg) => validateSafeMetadataToken(seg, "repoSegment"))
    .join("/");
  const safeSha = validateSafeMetadataToken(packet.headSha, "headSha");
  const mode = resolveDeliveryLabelMode(packet.labels);

  let overallFileRisk: EvolutionRiskLevel = "autonomous";
  let touchesWorkflowOrDeliveryConfig = false;

  for (const file of packet.changedFiles) {
    const norm = String(file ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (
      PROTECTED_DELIVERY_PREFIXES.some(
        (prefix) => norm === prefix || norm.startsWith(prefix),
      )
    ) {
      touchesWorkflowOrDeliveryConfig = true;
      if (overallFileRisk === "autonomous") {
        overallFileRisk = "requires_approval";
      }
    }
    const assessment = assessSelfEditPath(norm, "source");
    if (assessment.risk === "forbidden") {
      overallFileRisk = "forbidden";
    } else if (assessment.risk === "requires_approval" && overallFileRisk === "autonomous") {
      overallFileRisk = "requires_approval";
    }
  }

  const combinedUntrustedBody = [
    `Author: ${packet.authorLogin}`,
    `Head SHA: ${safeSha}`,
    `Base Ref: ${packet.baseRef}`,
    `Changed Files (${packet.changedFiles.length}):`,
    ...packet.changedFiles.map((f) => `- ${f}`),
    "",
    "--- PR Description ---",
    packet.body,
    "",
    "--- Unified Diff (Read-Only) ---",
    packet.unifiedDiff,
  ].join("\n");

  const sealed = sealExternalEvent({
    workspaceDir,
    source: "github",
    eventType: mode === "ignore" ? "pull_request.unlabeled" : `pull_request.${mode}`,
    eventId: `pr-${prNum}-${safeSha.slice(0, 8)}`,
    ref: `${safeRepo}#${prNum}`,
    ...(packet.url ? { url: packet.url } : {}),
    title: packet.title,
    body: combinedUntrustedBody,
    payload: {
      prNumber: prNum,
      headSha: safeSha,
      baseRef: packet.baseRef,
      changedFiles: packet.changedFiles,
      labels: packet.labels,
    },
  });

  return {
    mode,
    envelope: sealed.envelope,
    prompt: sealed.prompt,
    overallFileRisk,
    touchesWorkflowOrDeliveryConfig,
  };
}

export type CiCheckOverallState = "pending" | "passed" | "failed";
export type CodeReviewVerdict = "approved" | "changes_requested" | "commented";

export interface DeliveryPipelineSnapshot {
  mode: DeliveryLabelMode;
  prNumber: number;
  authorLogin: string;
  reviewedHeadSha: string;
  currentHeadSha: string;
  reviewVerdict: CodeReviewVerdict;
  ciState: CiCheckOverallState;
  overallFileRisk: EvolutionRiskLevel;
  touchesWorkflowOrDeliveryConfig: boolean;
  ownerExplicitlyApproved?: boolean;
}

export type DeliveryNextAction =
  | { action: "complete_review_only"; summary: string }
  | { action: "halt_rejected"; reason: string }
  | { action: "halt_head_sha_changed"; reason: string }
  | { action: "suspend_owner_approval"; approvalId: string; prompt: string }
  | { action: "wait_ci_later"; delaySec: number; reason: string }
  | { action: "merge_pull_request"; mergeMethod: "squash" | "merge" | "rebase"; expectedHeadSha: string };

export function evaluateDeliveryNextStep(
  policy: TrustedDeliveryPolicy,
  snap: DeliveryPipelineSnapshot,
): DeliveryNextAction {
  if (snap.mode === "deliver-review") {
    return {
      action: "complete_review_only",
      summary: `PR #${snap.prNumber} 已按 deliver-review 完成只读代码审查（结论：${snap.reviewVerdict}），不执行合并。`,
    };
  }

  if (snap.reviewedHeadSha !== snap.currentHeadSha) {
    return {
      action: "halt_head_sha_changed",
      reason: `PR #${snap.prNumber} head SHA changed after review (${snap.reviewedHeadSha} -> ${snap.currentHeadSha}); re-review required.`,
    };
  }

  if (snap.overallFileRisk === "forbidden") {
    return {
      action: "halt_rejected",
      reason: `PR #${snap.prNumber} modifies forbidden security boundary files and cannot be auto-delivered.`,
    };
  }

  if (snap.reviewVerdict !== "approved") {
    return {
      action: "halt_rejected",
      reason: `PR #${snap.prNumber} review verdict is "${snap.reviewVerdict}"; delivery halted.`,
    };
  }

  const isTrustedMaintainer = policy.trustedMaintainers.includes(snap.authorLogin);
  const needsOwnerSignoff =
    !isTrustedMaintainer ||
    snap.overallFileRisk === "requires_approval" ||
    snap.touchesWorkflowOrDeliveryConfig;

  if (needsOwnerSignoff && !snap.ownerExplicitlyApproved) {
    return {
      action: "suspend_owner_approval",
      approvalId: `ap-deliver-pr-${snap.prNumber}`,
      prompt: `PR #${snap.prNumber} (SHA ${snap.currentHeadSha.slice(0, 8)}, 作者 ${snap.authorLogin}) 代码审查已通过，涉及受控文件或外部作者，是否批准合并？`,
    };
  }

  if (snap.ciState === "failed") {
    return {
      action: "halt_rejected",
      reason: `PR #${snap.prNumber} CI checks failed on SHA ${snap.currentHeadSha.slice(0, 8)}.`,
    };
  }

  if (snap.ciState === "pending") {
    return {
      action: "wait_ci_later",
      delaySec: policy.ciRecheckDelaySec,
      reason: `等待 PR #${snap.prNumber} (SHA ${snap.currentHeadSha.slice(0, 8)}) CI 检查完成`,
    };
  }

  return {
    action: "merge_pull_request",
    mergeMethod: policy.mergeMethod,
    expectedHeadSha: snap.currentHeadSha,
  };
}

export interface HealthVerifyResponseSnapshot {
  statusCode: number;
  body: string | Record<string, unknown>;
}

export type HealthTransport = (url: string) => Promise<HealthVerifyResponseSnapshot>;

export interface PostDeployVerificationResult {
  ok: boolean;
  checkedUrl: string;
  observedVersion?: string;
  reason: string;
  requiresRollbackAlert: boolean;
}

export async function verifyPostDeployHealth(
  options: {
    url: string;
    expectedVersionOrSha: string;
    versionField?: string;
    allowLoopbackHttpForTest?: boolean;
  },
  transport: HealthTransport,
): Promise<PostDeployVerificationResult> {
  const safeUrl = validateSafeMetadataUrl(options.url);
  if (!safeUrl) {
    throw new DeliverySecurityError("insecure_healthcheck_url", "Invalid healthcheck URL.");
  }

  const parsedUrl = new URL(safeUrl);
  const isLoopbackHttp =
    parsedUrl.protocol === "http:" &&
    (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost");

  if (parsedUrl.protocol !== "https:" && !(options.allowLoopbackHttpForTest && isLoopbackHttp)) {
    throw new DeliverySecurityError(
      "insecure_healthcheck_url",
      `Post-deploy health verification requires HTTPS (got ${parsedUrl.protocol}//${parsedUrl.hostname}).`,
    );
  }

  const resp = await transport(safeUrl);
  if (resp.statusCode < 200 || resp.statusCode >= 300) {
    return {
      ok: false,
      checkedUrl: safeUrl,
      reason: `Healthcheck returned HTTP ${resp.statusCode}.`,
      requiresRollbackAlert: true,
    };
  }

  let data: Record<string, unknown> = {};
  if (typeof resp.body === "string") {
    try {
      data = JSON.parse(resp.body) as Record<string, unknown>;
    } catch {
      data = { raw: resp.body };
    }
  } else if (resp.body && typeof resp.body === "object") {
    data = resp.body;
  }

  const field = options.versionField ?? "version";
  const observedRaw = data[field] ?? data.commitSha ?? data.sha ?? data.version;
  const observedVersion = typeof observedRaw === "string" ? observedRaw.trim() : undefined;
  const expected = options.expectedVersionOrSha.trim();

  if (!observedVersion) {
    return {
      ok: false,
      checkedUrl: safeUrl,
      reason: `Healthcheck HTTP ${resp.statusCode} missing version field "${field}".`,
      requiresRollbackAlert: true,
    };
  }

  const matches =
    observedVersion === expected ||
    (expected.length >= 7 && observedVersion.startsWith(expected)) ||
    (observedVersion.length >= 7 && expected.startsWith(observedVersion));

  if (!matches) {
    return {
      ok: false,
      checkedUrl: safeUrl,
      observedVersion,
      reason: `Deployed version mismatch: expected "${expected}", observed "${observedVersion}".`,
      requiresRollbackAlert: true,
    };
  }

  return {
    ok: true,
    checkedUrl: safeUrl,
    observedVersion,
    reason: `HTTPS healthcheck verified (${observedVersion}).`,
    requiresRollbackAlert: false,
  };
}

export interface UpstreamHeadSnapshot {
  ambHeadSha: string;
  dshHeadSha: string;
  localMainSha: string;
  checkedAt: string;
}

export interface IsolatedUpstreamSyncPlan {
  shouldRunSync: boolean;
  reason: string;
  worktreeDir?: string;
  commands: Array<readonly [string, ...string[]]>;
  cleanupCommands: Array<readonly [string, ...string[]]>;
}

export function buildIsolatedUpstreamSyncPlan(
  probeTracker: ZeroTokenProbeTracker,
  repoRoot: string,
  worktreeParentDir: string,
  snapshot: UpstreamHeadSnapshot,
): IsolatedUpstreamSyncPlan {
  const safeAmb = validateSafeMetadataToken(snapshot.ambHeadSha, "ambHeadSha");
  const safeDsh = validateSafeMetadataToken(snapshot.dshHeadSha, "dshHeadSha");
  const safeMain = validateSafeMetadataToken(snapshot.localMainSha, "localMainSha");

  const probeDecision = probeTracker.evaluate({
    probeId: "sugent-dual-upstreams",
    healthy: true,
    wakeOnDiff: true,
    output: `amb=${safeAmb}|dsh=${safeDsh}`,
    at: snapshot.checkedAt,
  });

  if (!probeDecision.shouldWakeAgent) {
    return {
      shouldRunSync: false,
      reason: "upstreams_unchanged_zero_token",
      commands: [],
      cleanupCommands: [],
    };
  }

  const resolvedRepo = path.resolve(repoRoot);
  const worktreeDir = path.join(
    path.resolve(worktreeParentDir),
    `sugent-upstream-sync-${safeAmb.slice(0, 7)}-${safeDsh.slice(0, 7)}`,
  );

  const commands: Array<readonly [string, ...string[]]> = [
    assertSafeDeliveryCommandVector([
      "git",
      "-C",
      resolvedRepo,
      "worktree",
      "add",
      "--detach",
      worktreeDir,
      safeMain,
    ]),
    assertSafeDeliveryCommandVector([
      "node",
      path.join(worktreeDir, "scripts", "sync-upstreams.mjs"),
      "--merge",
    ]),
    assertSafeDeliveryCommandVector(["npm", "--prefix", worktreeDir, "run", "verify:sugent"]),
  ];

  const cleanupCommands: Array<readonly [string, ...string[]]> = [
    assertSafeDeliveryCommandVector([
      "git",
      "-C",
      resolvedRepo,
      "worktree",
      "remove",
      "--force",
      worktreeDir,
    ]),
  ];

  return {
    shouldRunSync: true,
    reason: "upstream_updates_detected",
    worktreeDir,
    commands,
    cleanupCommands,
  };
}

export const SUGENT_DELIVERY_SKILL = `---
name: sugent-delivery
description: Safe self-hosting maintenance and label-driven PR delivery workflow (deliver-review and deliver) for Sugent. Enforces main-branch-only trusted rules, zero local PR code checkout, isolated worktree upstream sync, and post-deploy HTTPS health verification.
---

# Sugent 安全自举维护与 PR 自动交付规范 (M1.5 SOP)

处理 GitHub Pull Request 交付或每日双上游同步巡检时，严格执行以下四条安全铁律：

## 1. 主干唯一受信（Main-Branch-Only Policy）
- 审查标准、合并策略与健康检查地址只允许从 \`main\`（或 \`origin/main\`）读取（调用 \`parseTrustedDeliveryPolicy\`）。
- 严禁读取或信任外来 PR 分支中修改的交付配置或门禁脚本。

## 2. 外来 PR 零检出与数据物理隔离（Zero Untrusted Checkout）
- **严禁**在宿主机检出或直接执行外来 PR 分支代码。
- 一律通过 \`sealPrReviewMaterials()\` 将 PR 标题、描述与只读 Unified Diff 封装至只读 \`.context/event-pr-<n>.md\`（权限 \`0400\`）后再开始代码审查。
- 所有外部命令必须通过独立参数数组（经 \`assertSafeDeliveryCommandVector\` 校验）调用。

## 3. 标签驱动双流状态机（\`deliver-review\` vs \`deliver\`）
- **\`deliver-review\`（只审不合）**：基于只读 Diff 完成正确性、安全围栏与架构一致性审查，评论审查结论后直接结束。
- **\`deliver\`（审代码 -> 等 CI -> 合并 -> 核验版本）**：
  1. 核验当前 PR \`headSha\` 与已审 \`reviewedHeadSha\` 完全一致（若期间有新提交立即中止重审）；
  2. 涉及 \`requires_approval\` 路径或非白名单作者时，必须输出 \`suspend_approval\` 回执挂起等待主人拍板；
  3. 若 CI 仍在运行，输出带 \`later\` 的回执零消耗释放进程，定时唤醒复查；
  4. 合并并触发部署后，调用 \`verifyPostDeployHealth()\` 校验生产 HTTPS 健康接口返回的已部署版本/SHA，不一致立即推卡告警。

## 4. 每日双上游隔离工作树巡检
- 先以零 Token 探针检查 \`upstream-amb/master\` 与 \`upstream-dsh/main\` 是否有新提交，无增量直接退出（0 Token）。
- 有增量时通过 \`buildIsolatedUpstreamSyncPlan()\` 在独立临时 \`git worktree\` 中合并并跑通 \`npm run verify:sugent\`，严禁直接污染主工作区。
`;

export function installDeliverySkill(skillsRootDir: string): string {
  const dir = path.join(path.resolve(skillsRootDir), "sugent-delivery");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SUGENT_DELIVERY_SKILL, { mode: 0o600 });
  return file;
}
