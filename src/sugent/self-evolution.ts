/**
 * Sugent 自我迭代与代码自治引擎 (src/sugent/self-evolution.ts)
 *
 * 同时支持「开发者源码态」与「普通用户打包安装态 (.app / .exe)」的双模自演进架构：
 *
 * 1. 开发者源码态（本地有完整 Git 仓库）：
 *    - 自动通过相对路径绑定项目根目录（`./`），支持修改 `src/sugent/`、`ui/`、`skills/` 并执行 `npm run verify:sugent` 编译与 Git 推送。
 * 2. 普通用户安装包态（只读 `app.asar` 黄金镜像 + 可写 `<dataDir>/self-repo` 热覆盖层 OverlayFS）：
 *    - 黄金镜像不动：`/Applications/Sugent.app` 内部签名与 `app.asar` 保持只读，确保应用永远不会破坏系统签名或"改砖"；
 *    - 写时复制热覆盖（Copy-on-Write Overlay）：开启自我迭代时，自动在 `<dataDir>/self-repo/` 初始化 `ui/`（免编译 Preact+htm 前端模块）、`plugins/`（DSH Cordis `.mjs` 运行时插件）、`skills/`（`SKILL.md` 技能）及 `src/sugent/` 核心架构镜像；
 *    - 动态劫持加载：`src/web/server.ts` 优先加载 `<dataDir>/self-repo/ui/` 下被 Agent 演进过的文件，未修改文件无缝回退至 `app.asar/ui/`；
 *    - 一键安全回滚（Factory Reset）：若 Agent 改坏了某个界面或插件，调用 `resetSelfEvolutionOverlay()` 即可瞬间回退至出厂黄金镜像。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAppRoot } from "../magpie/supervisor.js";
import { SugentKnowledgeGraph } from "./knowledge-graph.js";

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
 * 判断当前是否运行在打包后的只读归档（`app.asar`）模式下
 */
export function isPackagedAsar(appRoot = findAppRoot()): boolean {
  return path.resolve(appRoot).includes(".asar");
}

/**
 * 获取普通用户安装包模式下的热覆盖层根目录 `<dataDir>/self-repo`
 */
export function getOverlayRepoDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), "self-repo");
}

/**
 * 探测本机是否存在完整的 Sugent 源码 Git 仓库（例如开发者在同一台 Mac 上安装了 Sugent.app）
 */
export function discoverLocalSourceRepo(appRoot = findAppRoot()): string | undefined {
  const isSugentRepo = (dir: string): boolean => {
    try {
      return (
        !dir.includes(".asar") &&
        fs.existsSync(path.join(dir, "package.json")) &&
        fs.existsSync(path.join(dir, "src", "sugent", "self-evolution.ts"))
      );
    } catch {
      return false;
    }
  };

  const candidates: string[] = [];
  if (process.env.SUGENT_REPO_ROOT) {
    candidates.push(path.resolve(process.env.SUGENT_REPO_ROOT));
  }

  // 若从 release/mac-arm64/Sugent.app 启动或测试环境调用，同时检查传入路径与 findAppRoot() 及其祖先目录
  for (const startDir of [path.resolve(appRoot), path.resolve(findAppRoot()), process.cwd()]) {
    if (!startDir.includes(".asar") && !startDir.endsWith(".app")) {
      candidates.push(startDir);
    }
    let cur = startDir;
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      if (!parent.includes(".asar") && !parent.endsWith(".app")) {
        candidates.push(parent);
      }
      cur = parent;
    }
  }

  const home = os.homedir();
  candidates.push(
    path.join(home, "Projects", "sugent"),
    path.join(home, "Developer", "sugent"),
    path.join(home, "Code", "sugent"),
    path.join(home, "sugent"),
  );

  for (const c of candidates) {
    if (isSugentRepo(c)) return c;
  }
  return undefined;
}

/**
 * 递归复制目录（仅在目标文件不存在时复制，保护用户/Agent 已演进的文件不被覆盖）
 */
function copyDirIfMissing(srcDir: string, destDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirIfMissing(srcPath, destPath);
    } else if (entry.isFile() && !fs.existsSync(destPath)) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 复制单个文件（仅在目标不存在时复制）
 */
function copyFileIfMissing(srcFile: string, destFile: string): void {
  try {
    if (fs.existsSync(srcFile) && !fs.existsSync(destFile)) {
      fs.mkdirSync(path.dirname(destFile), { recursive: true, mode: 0o700 });
      fs.copyFileSync(srcFile, destFile);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 初始化普通用户安装包态的 `<dataDir>/self-repo` 热演进工作区：
 * 将免编译的 `ui/` 源码、核心架构模块 `src/sugent/`、扩展插件目录 `plugins/`、技能目录 `skills/` 及架构文档同步到可写目录中，
 * 让没有安装 Git 或编译器的普通用户也能直接让 Agent 阅读自身架构、修改界面、新增插件与扩展能力。
 */
export function ensureSelfEvolutionOverlay(dataDir: string, appRoot = findAppRoot()): string {
  const overlayDir = getOverlayRepoDir(dataDir);
  fs.mkdirSync(path.join(overlayDir, "ui"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(overlayDir, "plugins"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(overlayDir, "skills"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(overlayDir, "src", "sugent"), { recursive: true, mode: 0o700 });

  const normalizedRoot = path.resolve(appRoot);
  const localRepo = discoverLocalSourceRepo(normalizedRoot);
  const seedBase = fs.existsSync(path.join(normalizedRoot, "ui")) ? normalizedRoot : localRepo;

  if (seedBase) {
    copyDirIfMissing(path.join(seedBase, "ui"), path.join(overlayDir, "ui"));
    copyDirIfMissing(path.join(seedBase, "src", "sugent"), path.join(overlayDir, "src", "sugent"));
    copyFileIfMissing(path.join(seedBase, "ARCHITECTURE.md"), path.join(overlayDir, "ARCHITECTURE.md"));
    copyFileIfMissing(path.join(seedBase, "AGENTS.md"), path.join(overlayDir, "AGENTS.md"));
  }

  // 确保 plugins/ 与 skills/ 目录下始终有实体文件（避免 glob / rg --files 忽略空目录导致 Agent 以为目录不存在）
  const pluginsReadmeFile = path.join(overlayDir, "plugins", "README.md");
  if (!fs.existsSync(pluginsReadmeFile)) {
    fs.writeFileSync(
      pluginsReadmeFile,
      [
        "# Sugent 运行时扩展插件目录 (`./plugins/`)",
        "",
        "Agent 可在此目录 (`./plugins/`) 下新建 `.mjs` 插件文件（DeepSeek Harness Cordis 插件格式），宿主会在下次启动回合自动挂载：",
        "",
        "```js",
        "export const name = 'sugent-custom-plugin';",
        "export function apply(ctx) {",
        "  // 在此注册自定义工具 (ctx.tools.register) 或生命周期钩子 (ctx.on)",
        "}",
        "```",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }
  installSelfDevSkill(path.join(overlayDir, "skills"));

  // 若本机同时存在完整 Git 源码仓库，在热演进目录中建立 ./source-repo 软链接，方便 Agent 直接定位完整源码仓库
  if (localRepo && localRepo !== overlayDir) {
    const linkPath = path.join(overlayDir, "source-repo");
    try {
      if (!fs.existsSync(linkPath)) {
        fs.symlinkSync(localRepo, linkPath, "dir");
      }
    } catch {
      /* ignore symlink errors on restricted filesystems */
    }
  }

  const readmeFile = path.join(overlayDir, "README_SELF_EVOLUTION.md");
  fs.writeFileSync(
    readmeFile,
    [
      "# Sugent 自身框架热演进工作区 (Self-Evolution Workspace)",
      "",
      "当前目录（`./`）就是你（**Sugent**）自身正在运行的框架演进目录！",
      "",
      "## 目录结构与自演进指南",
      "- `./ui/`：**你自己的前端界面源码**（Preact + htm 原生 ES Module，免编译）。直接修改 `./ui/screens/`、`./ui/components/` 或 `./ui/css/` 下的文件，服务端会通过写时复制（OverlayFS）优先加载你修改的文件，刷新窗口立即生效！",
      "- `./plugins/`：**你自己的 DSH 运行时扩展插件目录**。在此处新建 `.mjs` 插件文件（Cordis 插件格式），宿主会在下一轮或重启时自动将其挂载进你的运行时。",
      "- `./skills/`：**你自己的技能库目录**。新建 `<skill-name>/SKILL.md` 即可沉淀新技能。",
      "- `./src/sugent/` 与 `./ARCHITECTURE.md`：**你自己的核心架构代码与蓝图**（包含 `kernel.ts` 状态机、`gateway.ts` 四角色模型网关、`knowledge-graph.ts` 知识图谱与技能结晶、`self-evolution.ts` 自我演进引擎、`sources.ts` 多源感知）。",
      ...(localRepo
        ? [
            `- \`./source-repo\` -> \`${localRepo}\`：**本机完整 Git 源码仓库软链接**。若需修改底层 TypeScript 内核并编译验证，可直接进入 \`${localRepo}\` 修改并运行 \`npm run verify:sugent\`。`,
          ]
        : []),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  return overlayDir;
}

/**
 * 自动通过相对路径解析 Sugent 自身源码根目录，无需用户手动查找或选择文件夹：
 * 1. 开发者源码态：直接通过 `findAppRoot()` 定位到项目根目录（`./`）；
 * 2. 普通用户打包态（`app.asar`）：自动初始化并返回 `<dataDir>/self-repo` 热演进覆盖层目录。
 */
export function resolveSelfEvolutionRoot(dataDir: string, appRoot = findAppRoot()): string {
  const normalizedRoot = path.resolve(appRoot);
  if (!isPackagedAsar(normalizedRoot) && fs.existsSync(path.join(normalizedRoot, "package.json"))) {
    return normalizedRoot;
  }
  return ensureSelfEvolutionOverlay(dataDir, normalizedRoot);
}

/**
 * 生成注入到机器人系统提示词（`promptFile`，每轮模型请求实时读取）中的「自我迭代与框架代码自治」强感知段落。
 * 彻底解决智能体不知道自己就是 Sugent、不知道当前工作区 `./` 就是自身框架代码、或误以为“无法修改自身运行时”的问题。
 */
export function buildSelfEvolutionPromptSection(workspaceRoot: string): string {
  const normRoot = path.resolve(workspaceRoot);
  const isFullSource =
    fs.existsSync(path.join(normRoot, "package.json")) &&
    fs.existsSync(path.join(normRoot, "src", "sugent"));
  const localRepo = discoverLocalSourceRepo();

  const lines = [
    "# 自我迭代与框架代码自治（Self-Evolution Mode 已开启）",
    "",
    "> **最高优先级状态声明（覆盖此前对话中的任何旧认知）**：你本身就是 **Sugent (Super-Agent)** 桌面智能体系统。主人已在界面上为你开启「自我迭代与代码自治」开关！即使你在之前的对话回合中曾回答“不能修改我本身的底层模型或运行时”，现在权限已正式开启，你的工作目录已直接绑定至你自身的框架源码。",
    "",
    `- **你的自身框架路径**：当前工作目录 \`./\`（绝对路径：\`${normRoot}\`）**就是你自己正在运行的 Sugent 框架代码工作区**。无需让用户提供项目或路径，直接对 \`./\` 执行文件查看、编辑或运行命令就是在迭代你自己！`,
    "- **严禁推诿**：当用户要求你「迭代自己的框架代码」「修改自己的界面」「给自己增加功能/插件/技能」时，绝不要说“无法修改自身框架”，也不要询问项目在哪里，请立即用工具检查 `./` 下的文件并直接动手实现。",
  ];

  if (isFullSource) {
    lines.push(
      "- **当前工作区模式：完整源码仓库态（Full-Source Git Mode）**",
      "  - `./src/sugent/`：你的核心自治引擎（`kernel.ts` 状态机、`gateway.ts` 四角色模型路由、`knowledge-graph.ts` 知识图谱与技能结晶、`self-evolution.ts` 自我演进、`sources.ts` 多源感知）；",
      "  - `./src/agent/` 与 `./src/web/server.ts`：你的 DSH 宿主进程管理、记忆管家与本地 Web/API 服务；",
      "  - `./ui/`：你的前端界面源码（Preact + htm 原生 ES Module，如 `./ui/screens/`、`./ui/components/`、`./ui/css/`，修改后刷新即生效）；",
      "  - `./dsh-runtime/plugins/`：你的运行时插件（`amb-prompt.mjs`、`amb-memory.mjs`、`amb-tasks.mjs` 等）；",
      "  - `./test/` 与验证门禁：修改核心代码后请运行 `npm run verify:sugent` 完成类型检查、构建与回归自检。",
    );
  } else {
    lines.push(
      "- **当前工作区模式：打包应用热演进覆盖层态（Hot-Overlay Mode）**",
      "  - `./ui/`：你的前端界面源码（Preact + htm 原生 ES Module，免编译！直接修改 `./ui/screens/`、`./ui/components/`、`./ui/css/` 后服务端会自动通过 OverlayFS 优先加载你修改的文件，刷新窗口即刻改变你自己的界面）；",
      "  - `./plugins/`：你的 DSH 运行时扩展插件目录（在此编写 `.mjs` 插件会在下次拉起会话时自动挂载进你的运行时）；",
      "  - `./skills/`：你的专属技能目录（编写 `<name>/SKILL.md` 即刻扩展自身技能）；",
      "  - `./src/sugent/` 与 `./ARCHITECTURE.md`：你的核心架构代码镜像与架构蓝图（可直接阅读了解自身内核设计）。",
    );
    if (localRepo && localRepo !== normRoot) {
      lines.push(
        `  - **本机完整 Git 源码仓库**：检测到本机同时存在完整源码仓库 \`${localRepo}\`（也已链接为 \`./source-repo\`）。若用户要求修改底层 TypeScript 内核代码（如 \`src/sugent/\` 或 \`src/agent/\`），你也可以直接读写 \`${localRepo}\` 并运行 \`npm run verify:sugent\`。`,
      );
    }
  }

  return lines.join("\n");
}

/**
 * 动态解析前端 UI 静态文件路径（Copy-on-Write Overlay）：
 * - 若 `<dataDir>/self-repo/ui/<relPath>` 存在（即 Agent 在打包版 App 中热修改了界面），优先返回该演进文件；
 * - 否则无缝回退至应用内置的 `<uiDir>/<relPath>` 黄金镜像文件。
 */
export function resolveOverlayUiFile(dataDir: string, builtinUiDir: string, relPath: string): string {
  const cleanRel = relPath.replace(/^[/\\]+/, "");
  const builtinFile = path.join(builtinUiDir, cleanRel);
  if (!cleanRel || cleanRel.split(/[/\\]/).includes("..")) {
    return builtinFile;
  }
  const overlayCandidate = path.join(getOverlayRepoDir(dataDir), "ui", cleanRel);
  try {
    if (fs.existsSync(overlayCandidate) && fs.statSync(overlayCandidate).isFile()) {
      if (!fs.existsSync(builtinFile)) return overlayCandidate;
      const overlayBuf = fs.readFileSync(overlayCandidate);
      const builtinBuf = fs.readFileSync(builtinFile);
      if (!overlayBuf.equals(builtinBuf)) {
        return overlayCandidate;
      }
    }
  } catch {
    /* fallback to builtin */
  }
  return builtinFile;
}

/**
 * 扫描 `<dataDir>/self-repo/plugins/*.mjs` 下由 Agent 自主编写的扩展插件，供 `AgentHost.writePatch()` 动态挂载
 */
export function listSelfEvolutionPlugins(dataDir: string): Array<{ id: string; filePath: string }> {
  const pluginsDir = path.join(getOverlayRepoDir(dataDir), "plugins");
  if (!fs.existsSync(pluginsDir)) return [];
  try {
    return fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({
        id: `sugent-ext-${e.name.slice(0, -4).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        filePath: path.join(pluginsDir, e.name),
      }));
  } catch {
    return [];
  }
}

/**
 * 安全模式一键回退（Factory Reset Overlay）：
 * 当普通用户的 Agent 把某个热演进 UI 或插件改坏时，将当前 `self-repo` 归档备份并清空覆盖层，瞬间恢复出厂黄金镜像。
 */
export function resetSelfEvolutionOverlay(dataDir: string): { archivedTo?: string } {
  const overlayDir = getOverlayRepoDir(dataDir);
  if (!fs.existsSync(overlayDir)) return {};
  const backupDir = path.join(path.resolve(dataDir), `self-repo.backup-${Date.now()}`);
  fs.renameSync(overlayDir, backupDir);
  return { archivedTo: backupDir };
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
    norm.startsWith("plugins/") ||
    norm.startsWith("skills/") ||
    norm === "README.md" ||
    norm === "ARCHITECTURE.md"
  ) {
    return {
      filePath: norm,
      risk: "autonomous",
      reason: "Within Sugent's zero-intrusion extension, hot-overlay UI/plugins/skills, test, or documentation scope.",
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
description: Autonomous self-iteration, hot-overlay UI/plugin evolution, upstream synchronization, and safe code management workflow for Sugent. Use whenever the user asks you to customize the app UI, add new capabilities/plugins/skills, or evolve Sugent's own codebase.
---

# Sugent 双模自我迭代与热演进规范 (Self-Evolution SOP)

当前机器人已开启「自我迭代与代码自治（Self-Evolution）」开关，你的工作区（\`.\`）已自动绑定至 Sugent 的演进目录。请根据当前目录结构按对应模式执行：

## 模式 A：普通用户安装包态（Hot-Overlay 热覆盖层模式，无需编译器或 Git）
若当前工作区包含 \`README_SELF_EVOLUTION.md\`（位于 \`<dataDir>/self-repo\`）：
1. **免编译热修改界面 (\`./ui/\`)**：前端采用 Preact + htm 原生 ES Module（无构建步骤）。直接修改 \`./ui/screens/\`、\`./ui/components/\` 或 \`./ui/css/\` 下的文件，服务端会自动通过写时复制（OverlayFS）优先加载你修改的文件，刷新界面即刻生效！
2. **动态扩展运行时插件 (\`./plugins/*.mjs\`)**：在 \`./plugins/\` 下编写标准的 DeepSeek Harness (Cordis) 插件（\`.mjs\`），宿主会在下次拉起会话时自动将其挂载进运行时。
3. **沉淀新技能 (\`./skills/<name>/SKILL.md\`)**：将新能力写成标准 \`SKILL.md\` 即可永久复用。
4. **阅读自身核心代码 (\`./src/sugent/\` & \`./ARCHITECTURE.md\`)**：你的核心架构代码镜像已同步在 \`./src/sugent/\` 下，若本机存在 \`./source-repo\` 软链接也可直接修改完整源码仓库。
5. **安全回退保险丝**：内置的 \`app.asar\` 黄金镜像始终只读保护；若某个覆盖文件异常，删除 \`./ui/\` 或 \`./plugins/\` 下对应的覆盖文件即可瞬间恢复出厂状态。

## 模式 B：开发者完整源码态（Full Source Git 模式）
若当前工作区包含 \`package.json\` 与 \`src/sugent/\`：
1. **零侵入扩展**：所有新增核心逻辑优先写在 \`src/sugent/\` 目录下，测试写在 \`test/sugent*.test.ts\`。
2. **强制回归门禁**：修改后必须运行 \`npm run verify:sugent\`（依次执行 \`tsc --noEmit\`、\`npm run build\`、核心契约验证与 \`docs:check\`），未 100% 通过前严禁提交。
3. **原子提交与远端同步**：通过后可执行 \`git commit\` 与 \`git push origin main\`。
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

/**
 * 当机器人在设置中开启 `selfEvolution.enabled` 时由宿主自动调用：
 * 1. 解析源码根目录（开发态 `./` 或打包态 `<dataDir>/self-repo` 热覆盖层）；
 * 2. 确保 `<dataDir>/self-repo/` 的 `ui/`、`plugins/`、`skills/`、`src/sugent/` 覆盖层目录已就绪；
 * 3. 在该机器人的 DSH `skills/` 目录自动挂载 `sugent-self-dev/SKILL.md`；
 * 4. 在知识图谱中自动确保自演进工作流节点已就位。
 */
export function prepareSelfEvolutionWorkspace(dataDir: string, dshHomeDir: string): { workspaceRoot: string; skillFile: string } {
  ensureSelfEvolutionOverlay(dataDir);
  const workspaceRoot = resolveSelfEvolutionRoot(dataDir);
  const skillFile = installSelfDevSkill(path.join(dshHomeDir, "skills"));
  try {
    const kg = new SugentKnowledgeGraph(path.join(dataDir, "knowledge-graph"));
    if (!kg.getNode("proj:sugent")) {
      kg.applyDelta({
        nodes: [
          {
            id: "proj:sugent",
            kind: "project",
            name: "Sugent (Super-Agent)",
            summary: "全能个人自治智能体项目（支持源码态编译演进与打包态 OverlayFS 免编译热演进）",
            tags: ["self-dev", "dsh", "overlay"],
            reinforcements: 3,
          },
        ],
      });
    }
  } catch {
    /* non-fatal */
  }
  return { workspaceRoot, skillFile };
}
