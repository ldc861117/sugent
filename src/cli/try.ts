#!/usr/bin/env node
/**
 * `npm run sugent:try` —— 零 Token 本地全链路自引导体验器（Roadmap M1.6）
 *
 * 无需预先配置任何模型 API Key 或外部渠道，在隔离沙箱目录中 1 秒跑通 Sugent 四大核心机制闭环：
 * 1. M1.4 指令数据物理分离：外部事件正文落盘只读 `.context/event-<id>.md`（0o400），提示词仅含安全元数据；
 * 2. 内核确定性门控与跳数检查：校验白名单与 `hopCount <= 8`；
 * 3. 挂起零消耗存档与拍板续接：高风险动作存档退出（0 驻留进程 / 0 轮询 Token），模拟主人拍板后按原会话与跳数无缝恢复；
 * 4. M2.1 因果账本反查与首条个人规则生成：自动输出 `sugent why` 时间线并生成个人首条巡检规则模板。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CausalLedger } from "../sugent/causal-ledger.js";
import { DEFAULT_MAX_HOPS, evaluatePersonalTrigger } from "../sugent/kernel.js";
import {
  SuspendedRoundStore,
  materializeReceiptFollowups,
  parseAgentReceipt,
} from "../sugent/receipt-protocol.js";
import { PersonalSourceRegistry } from "../sugent/sources.js";

export interface TryWalkthroughResult {
  sandboxDir: string;
  ledgerDir: string;
  roundId: string;
  contextFile: string;
  suspendedCheckpointPath: string;
  starterRulePath: string;
  scheduledFollowupAt?: string;
  whyTimeline: string;
}

export function runSugentTryWalkthrough(options: { targetDir?: string } = {}): TryWalkthroughResult {
  const sandboxDir = options.targetDir
    ? path.resolve(options.targetDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), "sugent-try-"));
  const workspaceDir = path.join(sandboxDir, "workspace");
  const ledgerDir = path.join(sandboxDir, "sugent-ledger");
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });

  const roundId = "try-round-1";
  const registry = new PersonalSourceRegistry();
  const ledger = new CausalLedger(ledgerDir);
  const suspendStore = new SuspendedRoundStore(sandboxDir);

  // Step 1: 摄入外部事件并执行指令数据物理分离
  const envelopedTrigger = registry.ingestEnveloped(
    "github",
    "gh-self",
    {
      id: "issue-101",
      repo: "ldc861117/sugent",
      issueOrPrNumber: 101,
      senderLogin: "owner",
      title: "上游发布安全补丁，请求自动同步验证并合并",
      body: "请拉取双上游最新提交，跑通 verify:sugent 后合并到主干。",
      eventType: "issues.opened",
      mentionedAgent: true,
      createdAt: "2026-11-12T09:00:00.000Z",
    },
    ["owner"],
    { workspaceDir },
  );

  ledger.append({
    roundId,
    kind: "round_triggered",
    at: "2026-11-12T09:00:00.000Z",
    title: "双上游安全补丁验证与合并体验",
    ruleId: "rule-upstream-guard",
    ruleVersion: 1,
    source: envelopedTrigger.sourceKind,
    eventType: "issues.opened",
    targetRef: "ldc861117/sugent#101",
    triggerId: envelopedTrigger.id,
    hopCount: envelopedTrigger.hopCount ?? 0,
    maxHops: DEFAULT_MAX_HOPS,
  });

  // Step 2: 确定性内核门控
  const decision = evaluatePersonalTrigger(envelopedTrigger);
  ledger.append({
    roundId,
    kind: "gate_evaluated",
    at: "2026-11-12T09:00:01.000Z",
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    hopCount: envelopedTrigger.hopCount ?? 0,
    maxHops: DEFAULT_MAX_HOPS,
  });

  ledger.append({
    roundId,
    kind: "worker_claimed",
    at: "2026-11-12T09:00:02.000Z",
    workerId: "dsh-local-worker",
    modelRole: decision.recommendedRole ?? "executor",
  });

  // Step 3: 遇到合并主干高风险操作，输出挂起回执并零消耗存档退出
  const suspendParsed = parseAgentReceipt(
    [
      "已完成隔离工作树测试，准备合并主干，等待主人拍板。",
      "```sugent-receipt",
      JSON.stringify({
        status: "suspend_approval",
        summary: "测试通过，请求批准合并上游安全补丁到 main",
        approval: {
          approvalId: "ap-merge-101",
          prompt: "是否批准将已通过 verify:sugent 的补丁合并至 main 分支？",
          riskLevel: "high",
        },
        events: [],
      }),
      "```",
    ].join("\n"),
  );
  if (!suspendParsed.ok || !suspendParsed.receipt.approval) {
    throw new Error("Unexpected receipt parse error in try walkthrough.");
  }

  suspendStore.suspend({
    roundId,
    sessionId: "sess-try-101",
    parentTrigger: envelopedTrigger,
    approval: suspendParsed.receipt.approval,
    suspendedAt: "2026-11-12T09:00:05.000Z",
  });

  ledger.append({
    roundId,
    kind: "approval_requested",
    at: "2026-11-12T09:00:05.000Z",
    approvalId: suspendParsed.receipt.approval.approvalId,
    summary: suspendParsed.receipt.approval.prompt,
  });

  // Step 4: 模拟主人点击卡片批准，从零消耗存档恢复会话并预约 30 分钟后复查健康状态
  suspendStore.resume(roundId, {
    approved: true,
    decidedBy: "owner",
    note: "同意合并，30 分钟后复查构建状态",
    resumedAt: "2026-11-12T09:15:00.000Z",
  });

  ledger.append({
    roundId,
    kind: "approval_decided",
    at: "2026-11-12T09:15:00.000Z",
    approvalId: "ap-merge-101",
    approved: true,
    decidedBy: "owner",
    summary: "同意合并，30 分钟后复查构建状态",
  });

  const finalParsed = parseAgentReceipt(
    [
      "合并已完成并预约 30 分钟后自动复查。",
      "```sugent-receipt",
      JSON.stringify({
        status: "completed",
        summary: "已合并补丁并预约 30 分钟后健康复查",
        later: {
          delaySec: 1800,
          reason: "复查合并后主干构建与线上健康度",
        },
        events: [],
      }),
      "```",
    ].join("\n"),
  );
  if (!finalParsed.ok) {
    throw new Error("Unexpected final receipt parse failure.");
  }

  const followups = materializeReceiptFollowups(
    envelopedTrigger,
    finalParsed.receipt,
    "2026-11-12T09:15:02.000Z",
  );

  ledger.append({
    roundId,
    kind: "round_completed",
    at: "2026-11-12T09:15:02.000Z",
    outcome: "done",
    costUsd: 0,
    summary: `${finalParsed.receipt.summary}（下一跳复查 hopCount=${followups.scheduledWakeup?.trigger.hopCount ?? 1}）`,
  });

  // Step 5: 生成首条个人规则引导模板
  const starterRulePath = path.join(sandboxDir, "first-personal-rule.json");
  const starterRule = {
    id: "rule-daily-upstream-sync",
    title: "每日双上游巡检与零消耗门控",
    sourceKind: "schedule",
    cron: "0 9 * * *",
    mode: "observe",
    maxHops: DEFAULT_MAX_HOPS,
    securityEnvelope: true,
    suggestPromoteAfter: 3,
  };
  fs.writeFileSync(starterRulePath, `${JSON.stringify(starterRule, null, 2)}\n`, { mode: 0o600 });

  return {
    sandboxDir,
    ledgerDir,
    roundId,
    contextFile: envelopedTrigger.envelope.absoluteFilePath,
    suspendedCheckpointPath: path.join(sandboxDir, "suspended-rounds", `${roundId}.json`),
    starterRulePath,
    ...(followups.scheduledWakeup ? { scheduledFollowupAt: followups.scheduledWakeup.wakeAtIso } : {}),
    whyTimeline: ledger.explainWhy(roundId),
  };
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const dirIdx = args.indexOf("--dir");
  const targetDir = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1] : undefined;

  const res = runSugentTryWalkthrough(targetDir ? { targetDir } : {});
  if (asJson) {
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.log("Sugent 自引导全链路体验已完成（0 Token 消耗）：\n");
    console.log(res.whyTimeline);
    console.log(`\n- 只读安全信封文件：${res.contextFile}`);
    console.log(`- 挂起零消耗存档：  ${res.suspendedCheckpointPath}`);
    console.log(`- 首条个人规则模板：${res.starterRulePath}`);
    console.log(`- 反查命令：        npm run sugent:why -- --ledger-dir "${res.ledgerDir}" ${res.roundId}`);
  }
}
