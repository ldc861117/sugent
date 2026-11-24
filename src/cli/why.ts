#!/usr/bin/env node
/**
 * `npm run sugent:why -- <roundId>`（或 `--list` / `--json`）
 *
 * 对应 Roadmap M2.1：从只追加因果账本（CausalLedger）反查任意一轮智能体任务的完整来龙去脉：
 * 触发来源 → 命中规则版本 → 安全门控结论与跳数 → 领取的执行角色 → 人工拍板记录 → 最终结果与花费。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultDataDir } from "../config.js";
import { CausalLedger, resolveUnifiedCausalLedgerDir } from "../sugent/causal-ledger.js";

export interface WhyCliOptions {
  ledgerDir: string;
  roundId?: string;
  list?: boolean;
  json?: boolean;
}

export function parseWhyCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): WhyCliOptions {
  const baseDataDir = env.AMB_DATA_DIR ? path.resolve(env.AMB_DATA_DIR) : defaultDataDir();
  let ledgerDir = env.SUGENT_LEDGER_DIR
    ? path.resolve(env.SUGENT_LEDGER_DIR)
    : resolveUnifiedCausalLedgerDir(baseDataDir);
  let roundId: string | undefined;
  let list = false;
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--list" || arg === "-l") {
      list = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--ledger-dir" && argv[i + 1]) {
      ledgerDir = path.resolve(argv[++i]!);
    } else if (arg.startsWith("--ledger-dir=")) {
      ledgerDir = path.resolve(arg.slice("--ledger-dir=".length));
    } else if (!arg.startsWith("-") && !roundId) {
      roundId = arg;
    }
  }

  return { ledgerDir, ...(roundId ? { roundId } : {}), list, json };
}

export function runWhyCli(opts: WhyCliOptions): { exitCode: number; output: string } {
  const ledger = new CausalLedger(opts.ledgerDir);

  if (opts.list || !opts.roundId) {
    const rounds = ledger.listRounds();
    if (opts.json) {
      return { exitCode: 0, output: JSON.stringify(rounds, null, 2) };
    }
    if (rounds.length === 0) {
      return {
        exitCode: 0,
        output: `当前账本目录（${opts.ledgerDir}）暂无轮次记录。可先运行 \`npm run sugent:try\` 生成体验轮次。`,
      };
    }
    const lines = [
      `共记录 ${rounds.length} 轮因果链（账本游标 seq=${ledger.cursor}）：`,
      ...rounds.map(
        (r) =>
          `- [${r.roundId}] status=${r.status} hop=${r.hopCount} source=${r.source ?? "-"} title=${r.title || "未命名任务"}`,
      ),
      "\n提示：运行 `npm run sugent:why -- <roundId>` 查看指定轮次完整因果溯源。",
    ];
    return { exitCode: 0, output: lines.join("\n") };
  }

  const trace = ledger.traceRound(opts.roundId);
  if (!trace) {
    return {
      exitCode: 1,
      output: opts.json
        ? JSON.stringify({ found: false, roundId: opts.roundId }, null, 2)
        : ledger.explainWhy(opts.roundId),
    };
  }

  if (opts.json) {
    return { exitCode: 0, output: JSON.stringify({ found: true, trace }, null, 2) };
  }

  return { exitCode: 0, output: ledger.explainWhy(opts.roundId) };
}

const isDirectEntry =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectEntry) {
  const opts = parseWhyCliArgs(process.argv.slice(2));
  const res = runWhyCli(opts);
  console.log(res.output);
  process.exitCode = res.exitCode;
}
