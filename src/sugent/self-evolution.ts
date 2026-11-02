/**
 * Sugent 自我迭代与代码自治引擎 (src/sugent/self-evolution.ts)
 *
 * 解决"智能体自己修改自己代码（Self-Hosting / Brain-Surgery）"的四大工程难题：
 * 1. 核心底线围栏 (Immutable Guardrails)：区分可自主演进目录与必须人类审批的底线文件；
 * 2. 强制回归门禁 (Verification Gate)：未通过 `npm run verify:sugent` 严禁提交或覆盖主分支；
 * 3. 原子快照与自动回滚 (Snapshot & Rollback Plan)：每次自演进前记录基准 Commit，验证失败自动回退；
 * 4. 固化自演进技能 (Self-Dev SKILL.md)：为管理自身仓库的机器人自动注入标准化的研发 SOP。
 */
import fs from "node:fs";
import path from "node:path";

export type EvolutionRiskLevel = "autonomous" | "requires_approval" | "forbidden";

export interface FileChangeAssessment {
  filePath: string;
  risk: EvolutionRiskLevel;
  reason: string;
}

export interface SelfEvolutionPlan {
  goal: string;
  baseCommit: string;
  touchedFiles: string[];
  assessments: FileChangeAssessment[];
  overallRisk: EvolutionRiskLevel;
  verificationCommand: string;
}

/**
 * 严禁智能体自主篡改的底线文件（防止智能体通过修改测试门禁或权限围栏来"作弊"绕过检查）
 */
export const FORBIDDEN_SELF_EDIT_PATHS: readonly string[] = [
  ".git/config",
  "LICENSE",
  "dsh-runtime/plugins/amb-bridge.mjs",
];

/**
 * 修改前必须向主人发起审批卡片（requires_approval）的关键宿主与门禁文件
 */
export const APPROVAL_REQUIRED_PATHS: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "scripts/verify-sugent.mjs",
  "src/sugent/self-evolution.ts",
  "src/core/access.ts",
  "electron/main.ts",
];

/**
 * 评估单个文件的自我修改风险等级
 */
export function assessSelfEditPath(relPath: string): FileChangeAssessment {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\/+/, "");

  if (FORBIDDEN_SELF_EDIT_PATHS.some((p) => norm === p || norm.startsWith(`${p}/`))) {
    return {
      filePath: norm,
      risk: "forbidden",
      reason: "Security boundary or license file cannot be modified autonomously by the agent.",
    };
  }

  if (APPROVAL_REQUIRED_PATHS.some((p) => norm === p || norm.startsWith(`${p}/`))) {
    return {
      filePath: norm,
      risk: "requires_approval",
      reason: "Core build, desktop shell, or verification gate file requires explicit owner approval.",
    };
  }

  if (
    norm.startsWith("src/sugent/") ||
    norm.startsWith("test/") ||
    norm.startsWith("docs/") ||
    norm.startsWith("ui/") ||
    norm === "README.md" ||
    norm === "ARCHITECTURE.md"
  ) {
    return {
      filePath: norm,
      risk: "autonomous",
      reason: "Within Sugent's zero-intrusion extension, UI, test, or documentation scope.",
    };
  }

  return {
    filePath: norm,
    risk: "requires_approval",
    reason: "Upstream AnyModelBot or dsh-superagent file; modifying it may cause upstream merge conflicts.",
  };
}

/**
 * 制定一次自我迭代计划并计算整体风险等级
 */
export function buildSelfEvolutionPlan(
  goal: string,
  baseCommit: string,
  touchedFiles: string[],
): SelfEvolutionPlan {
  const assessments = touchedFiles.map(assessSelfEditPath);
  let overallRisk: EvolutionRiskLevel = "autonomous";
  if (assessments.some((a) => a.risk === "forbidden")) {
    overallRisk = "forbidden";
  } else if (assessments.some((a) => a.risk === "requires_approval")) {
    overallRisk = "requires_approval";
  }

  return {
    goal: goal.trim(),
    baseCommit: baseCommit.trim(),
    touchedFiles: assessments.map((a) => a.filePath),
    assessments,
    overallRisk,
    verificationCommand: "npm run verify:sugent",
  };
}

/**
 * 生成内置的「Sugent 自演进架构师 (sugent-self-dev)」标准技能文件 (SKILL.md)
 */
export const SUGENT_SELF_DEV_SKILL = `---
name: sugent-self-dev
description: Autonomous self-iteration, upstream synchronization, and safe code management workflow for the Sugent repository itself. Use whenever the user asks you to add features to Sugent, fix bugs in your own codebase, sync upstreams, or push updates to GitHub.
---

# Sugent 自我迭代与代码自治规范 (Self-Evolution SOP)

你正在维护你自己（Sugent）的源代码仓库。为了防止把正在运行的自己改崩（Brain-Surgery Hazard）或引入上游合并冲突，必须严格按以下 5 步闭环执行：

## 1. 先读架构与计划（Context First）
- 阅读仓库根目录的 \`AGENTS.md\`、\`ARCHITECTURE.md\` 与 \`docs/ROADMAP.md\`。
- 所有新增的核心业务逻辑优先写在 \`src/sugent/\` 目录下，测试写在 \`test/sugent*.test.ts\`，保持对上游宿主代码的零侵入隔离。

## 2. 检查工作区与记录回滚锚点（Snapshot）
- 修改任何文件前，先运行 \`git status -s\` 和 \`git rev-parse --short HEAD\` 记录当前干净的基准 Commit。
- 严禁篡改 \`.git/config\`、\`dsh-runtime/plugins/amb-bridge.mjs\` 等安全围栏文件；如需修改 \`package.json\`、\`electron/main.ts\` 或 \`scripts/verify-sugent.mjs\`，先向主人说明原因并请求批准。

## 3. 测试驱动开发（TDD & Verification Gate）
- 编写或修改代码后，同步在 \`scripts/verify-sugent.mjs\` 与 \`test/\` 中补充契约断言。
- **强制门禁**：必须运行 \`npm run verify:sugent\`（依次执行 \`tsc --noEmit\`、\`npm run build\`、核心契约验证与 \`docs:check\`）。
- 若 \`npm run verify:sugent\` 报错，必须先修复错误直至退出码为 0；若连续修复失败，执行 \`git checkout -- .\` 恢复工作区并如实向主人报告原因。

## 4. 双上游同步（Upstream Sync）
- 当主人要求同步上游最新特性时，先运行 \`npm run sync:upstreams\` 查看 \`modelflare-ai/AnyModelBot\` 与 \`deepseek-ai/dsh-superagent-prototype\` 的最新提交。
- 确认无误后运行 \`npm run sync:upstreams:merge\`，随后立即执行 \`npm run verify:sugent\` 确保合并后契约完好。

## 5. 原子提交与 SSH 远端推送（Commit & Push）
- 验证 100% 通过后，使用清晰的 Conventional Commit（如 \`feat(sugent): ...\` 或 \`fix(sugent): ...\`）提交到 \`main\` 分支。
- 运行 \`git push origin main\` 将改动经 SSH 443 通道推送到 \`ldc861117/sugent\`，并在微信/飞书或桌面端用一两句话向主人汇报 Commit 哈希与核心结果。
`;

/**
 * 将 `sugent-self-dev` 技能写入指定技能目录，使智能体开机即具备自我迭代 SOP
 */
export function installSelfDevSkill(skillsRootDir: string): string {
  const dir = path.join(skillsRootDir, "sugent-self-dev");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SUGENT_SELF_DEV_SKILL, { mode: 0o600 });
  return file;
}
