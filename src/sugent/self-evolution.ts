/**
 * Sugent 自我迭代与代码自治引擎 (src/sugent/self-evolution.ts)
 *
 * 同时支持「开发者源码态」与「普通用户打包安装态 (.app / .exe)」的双模自演进架构：
 *
 * 1. 开发者源码态（本地有完整 Git 仓库）：
 *    - 自动通过相对路径绑定项目根目录（`./`），支持修改 `src/sugent/`、`ui/`、`skills/` 并执行 `npm run verify:sugent` 编译与 Git 推送。
 * 2. 普通用户安装包态（只读 `app.asar` 黄金镜像 + 可写 `<dataDir>/self-repo` 扩展目录）：
 *    - 黄金镜像不动：`/Applications/Sugent.app` 内部签名与 `app.asar` 保持只读，确保应用永远不会破坏系统签名或"改砖"；
 *    - 仅允许新增 `plugins/`（DSH Cordis `.mjs` 运行时插件）与 `skills/`（`SKILL.md` 技能）；`src/sugent/` 只作为只读参考镜像；
 *    - 一键安全回滚（Factory Reset）：若 Agent 改坏了某个界面或插件，调用 `resetSelfEvolutionOverlay()` 即可瞬间回退至出厂黄金镜像。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findAppRoot } from "../magpie/supervisor.js";
import { SugentKnowledgeGraph, resolveUnifiedKnowledgeGraphDir } from "./knowledge-graph.js";

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

export type SelfEvolutionMode = "packaged" | "source";

export const SUGENT_PLUGIN_API_VERSION = 1;
export const SUGENT_PLUGIN_ID_PREFIX = "sugent-ext-";

export interface SelfEvolutionPluginManifest {
  id: string;
  apiVersion: number;
  name?: string;
  version?: string;
}

export interface SelfEvolutionPlugin {
  id: string;
  filePath: string;
  manifestPath: string;
  manifest: SelfEvolutionPluginManifest;
}

export interface SelfEvolutionPluginIssue {
  filePath: string;
  reason: string;
  manifestPath?: string;
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
  return path.join(path.resolve(dataDir), "self-repo", "extensions");
}

/** Stable root for read-only references and migration metadata. It is outside the
 * packaged agent's workspace-write origin; only `getOverlayRepoDir()` is writable. */
function getSelfEvolutionRootDir(dataDir: string): string {
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

function archivePackagedUiOverlay(dataDir: string, overlayDir: string): string | undefined {
  const uiDir = path.join(overlayDir, "ui");
  if (!fs.existsSync(uiDir)) return undefined;
  const archiveDir = path.join(path.resolve(dataDir), `self-repo-ui.backup-${Date.now()}`);
  try {
    fs.renameSync(uiDir, archiveDir);
    fs.writeFileSync(
      path.join(getSelfEvolutionRootDir(dataDir), "UI_OVERLAY_DISABLED.md"),
      ["# 旧版 UI 覆盖已停用", "", `旧 UI 文件已保留在：\`${archiveDir}\`。`, "应用现在始终使用随官方版本发布的 UI。"].join("\n"),
      { mode: 0o600 },
    );
    return archiveDir;
  } catch {
    return undefined;
  }
}

export function getSelfEvolutionUiArchiveNotice(dataDir: string): string | undefined {
  const noticePath = path.join(getSelfEvolutionRootDir(dataDir), "UI_OVERLAY_DISABLED.md");
  try {
    return fs.existsSync(noticePath) ? fs.readFileSync(noticePath, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** Apply one-time packaged migrations even when the per-bot self-evolution switch is off. */
export function migratePackagedSelfEvolutionData(dataDir: string): string {
  const rootDir = getSelfEvolutionRootDir(dataDir);
  const workspaceDir = getOverlayRepoDir(dataDir);
  fs.mkdirSync(path.join(workspaceDir, "plugins"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(workspaceDir, "skills"), { recursive: true, mode: 0o700 });
  archivePackagedUiOverlay(dataDir, rootDir);
  migrateLegacyExtensionDir(rootDir, "plugins");
  migrateLegacyExtensionDir(rootDir, "skills");
  for (const linkPath of [path.join(rootDir, "source-repo"), path.join(workspaceDir, "source-repo")]) {
    try {
      if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
    } catch {
      /* absent */
    }
  }
  return workspaceDir;
}

/** Move legacy top-level extension files into the constrained writable workspace. */
function migrateLegacyExtensionDir(rootDir: string, name: "plugins" | "skills"): void {
  const legacyDir = path.join(rootDir, name);
  const targetDir = path.join(rootDir, "extensions", name);
  if (!fs.existsSync(legacyDir) || legacyDir === targetDir) return;
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  const displacedDir = path.join(rootDir, `legacy-${name}-${Date.now()}`);
  for (const entry of fs.readdirSync(legacyDir, { withFileTypes: true })) {
    const from = path.join(legacyDir, entry.name);
    const to = path.join(targetDir, entry.name);
    try {
      if (fs.existsSync(to)) {
        fs.mkdirSync(displacedDir, { recursive: true, mode: 0o700 });
        fs.renameSync(from, path.join(displacedDir, entry.name));
      } else {
        fs.renameSync(from, to);
      }
    } catch {
      // Keep an unreadable legacy item in place rather than deleting user data.
    }
  }
  try {
    if (fs.readdirSync(legacyDir).length === 0) fs.rmSync(legacyDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * 初始化普通用户安装包态的 `<dataDir>/self-repo` 扩展工作区：保留插件、技能与只读架构参考。
 */
export function ensureSelfEvolutionOverlay(dataDir: string, appRoot = findAppRoot()): string {
  const rootDir = getSelfEvolutionRootDir(dataDir);
  const overlayDir = getOverlayRepoDir(dataDir);
  fs.mkdirSync(path.join(overlayDir, "plugins"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(overlayDir, "skills"), { recursive: true, mode: 0o700 });

  const normalizedRoot = path.resolve(appRoot);
  const packaged = isPackagedAsar(normalizedRoot);
  if (packaged) {
    migratePackagedSelfEvolutionData(dataDir);
  }
  fs.mkdirSync(path.join(rootDir, "src", "sugent"), { recursive: true, mode: 0o700 });
  const localRepo = discoverLocalSourceRepo(normalizedRoot);
  const seedBase = fs.existsSync(path.join(normalizedRoot, "ui")) ? normalizedRoot : localRepo;

  if (seedBase) {
    if (!packaged) copyDirIfMissing(path.join(seedBase, "ui"), path.join(overlayDir, "ui"));
    copyDirIfMissing(path.join(seedBase, "src", "sugent"), path.join(rootDir, "src", "sugent"));
    copyFileIfMissing(path.join(seedBase, "ARCHITECTURE.md"), path.join(rootDir, "ARCHITECTURE.md"));
    copyFileIfMissing(path.join(seedBase, "AGENTS.md"), path.join(rootDir, "AGENTS.md"));
  }

  // 确保 plugins/ 与 skills/ 目录下始终有实体文件（避免 glob / rg --files 忽略空目录导致 Agent 以为目录不存在）
  const pluginsReadmeFile = path.join(overlayDir, "plugins", "README.md");
  if (!fs.existsSync(pluginsReadmeFile)) {
    fs.writeFileSync(
      pluginsReadmeFile,
      [
        "# Sugent 运行时扩展插件目录 (`./plugins/`)",
        "",
        "每个插件都需要同名 JSON sidecar（例如 `hello.mjs` + `hello.json`），声明插件 ID 和当前兼容 API 版本后宿主才会挂载：",
        "",
        "```js",
        "// hello.json: { \"id\": \"sugent-ext-hello\", \"apiVersion\": 1 }",
        "export const name = 'sugent-ext-hello';",
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
  mirrorSkillsToDshDir(path.join(overlayDir, "skills"), path.join(overlayDir, ".dsh", "skills"));

  // Never expose a writable source-repo symlink from the packaged workspace.
  const linkPath = path.join(overlayDir, "source-repo");
  try {
    if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
  } catch {
    /* absent */
  }

  const readmeFile = path.join(packaged ? rootDir : overlayDir, "README_SELF_EVOLUTION.md");
  fs.writeFileSync(
    readmeFile,
    [
      "# Sugent 自身框架热演进工作区 (Self-Evolution Workspace)",
      "",
      packaged
        ? "当前目录（`./`）是 Sugent 的可写扩展目录；打包版 Agent 只能自主修改 skills/ 和 plugins/。只读架构参考在上级 self-repo 目录。"
        : "当前目录（`./`）就是 Sugent 自身的完整源码工作区。",
      "",
      "## 目录结构与自演进指南",
      ...(packaged ? [] : ["- `./ui/`：源码态前端界面源码，修改后刷新即可生效。"]),
      "- `./plugins/`：DSH 运行时扩展插件目录；每个 `.mjs` 必须配套同名 `.json` sidecar，声明 `id: sugent-ext-<slug>` 与兼容的 `apiVersion` 后才会加载。",
      "- `./skills/`：**你自己的技能库目录**。新建 `<skill-name>/SKILL.md` 即可沉淀新技能。",
      ...(packaged
        ? [`- 只读核心架构参考：\`${path.join(rootDir, "src", "sugent")}\` 与 \`${path.join(rootDir, "ARCHITECTURE.md")}\`；打包态修改不会改变正在运行的应用。`]
        : ["- `./src/sugent/` 与 `./ARCHITECTURE.md`：源码态核心架构文件。"]),
      ...(getSelfEvolutionUiArchiveNotice(dataDir) ? ["", "## UI 覆盖归档通知", getSelfEvolutionUiArchiveNotice(dataDir)!] : []),
      ...(localRepo ? [packaged ? `- 发现完整源码仓库 \`${localRepo}\`；打包态仅允许修改本目录的 skills/ 与 plugins/。` : `- 完整 Git 源码仓库：\`${localRepo}\`。`] : []),
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
    isFullSource
      ? "> **最高优先级状态声明**：你本身就是 **Sugent (Super-Agent)** 桌面智能体系统。当前工作目录绑定到完整源码仓库，可按源码态 Git 工作流进行迭代。"
      : "> **最高优先级状态声明**：你本身就是 **Sugent (Super-Agent)** 桌面智能体系统。打包版工作目录是扩展目录，只允许自主修改 Skills 和兼容插件。",
    "",
    `- **当前工作区**：\`./\`（绝对路径：\`${normRoot}\`）。按下面的模式说明处理其中的文件。`,
    isFullSource
      ? "- 用户要求修改完整源码时，先检查当前仓库与未提交改动，再按仓库规范实现和验证。"
      : "- 用户要求修改核心代码或界面时，说明打包版不开放这些路径；Skills 与插件扩展可直接在允许目录内实现。",
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
      "- **当前工作区模式：打包应用扩展态（Skills + Plugins Mode）**",
      "  - `./plugins/`：你的 DSH 运行时扩展插件目录；每个 `.mjs` 必须配套同名 JSON sidecar，声明 `id: sugent-ext-<slug>` 和兼容的 `apiVersion`；",
      "  - `./skills/`：你的专属技能目录（编写 `<name>/SKILL.md` 即刻扩展自身技能）；",
      "  - `./src/sugent/` 与 `./ARCHITECTURE.md`：只读核心架构参考镜像；打包态修改不会改变正在运行的应用。",
    );
    if (localRepo && localRepo !== normRoot) {
      lines.push(
        "  - 如需修改底层 TypeScript 内核，请使用独立的完整源码 Git 工作流；打包态只负责 Skills 与兼容插件扩展。",
      );
    }
  }

  return lines.join("\n");
}

/**
 * 解析前端 UI 静态文件路径。打包版始终返回官方内置 UI，防止旧用户覆盖遮住应用更新。
 */
export function resolveOverlayUiFile(dataDir: string, builtinUiDir: string, relPath: string): string {
  void dataDir;
  const cleanRel = relPath.replace(/^[/\\]+/, "");
  const builtinFile = path.join(builtinUiDir, cleanRel);
  if (!cleanRel || cleanRel.split(/[/\\]/).includes("..")) {
    return builtinFile;
  }
  return builtinFile;
}

/**
 * 扫描 `<dataDir>/self-repo/plugins/*.mjs` 下的扩展插件，仅返回 manifest 合法且 API 兼容的插件。
 */
function validatePluginManifest(filePath: string): { plugin?: SelfEvolutionPlugin; issue?: SelfEvolutionPluginIssue } {
  const manifestPath = [`${filePath}.json`, `${filePath.slice(0, -4)}.json`].find((candidate) => fs.existsSync(candidate));
  if (!manifestPath) {
    return { issue: { filePath, reason: "Plugin manifest is missing; add a matching .json sidecar before enabling it." } };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<SelfEvolutionPluginManifest>;
    if (typeof raw.id !== "string" || !/^sugent-ext-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id)) {
      return { issue: { filePath, manifestPath, reason: "Plugin id must use sugent-ext-<slug> with lowercase letters, digits, and hyphens." } };
    }
    if (!Number.isInteger(raw.apiVersion) || raw.apiVersion !== SUGENT_PLUGIN_API_VERSION) {
      return { issue: { filePath, manifestPath, reason: `Plugin apiVersion must equal ${SUGENT_PLUGIN_API_VERSION}.` } };
    }
    return {
      plugin: { id: raw.id, filePath, manifestPath, manifest: raw as SelfEvolutionPluginManifest },
    };
  } catch {
    return { issue: { filePath, manifestPath, reason: "Plugin manifest is not valid JSON." } };
  }
}

export function inspectSelfEvolutionPlugins(dataDir: string): { plugins: SelfEvolutionPlugin[]; issues: SelfEvolutionPluginIssue[] } {
  const pluginsDir = path.join(getOverlayRepoDir(dataDir), "plugins");
  if (!fs.existsSync(pluginsDir)) return { plugins: [], issues: [] };
  try {
    const plugins: SelfEvolutionPlugin[] = [];
    const issues: SelfEvolutionPluginIssue[] = [];
    const candidates: SelfEvolutionPlugin[] = [];
    for (const entry of fs
      .readdirSync(pluginsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".mjs"))
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const filePath = path.join(pluginsDir, entry.name);
      const result = validatePluginManifest(filePath);
      if (result.issue) issues.push(result.issue);
      else if (result.plugin) candidates.push(result.plugin);
    }
    const byId = new Map<string, SelfEvolutionPlugin[]>();
    for (const plugin of candidates) byId.set(plugin.id, [...(byId.get(plugin.id) ?? []), plugin]);
    for (const group of byId.values()) {
      if (group.length > 1) {
        for (const plugin of group) {
          issues.push({ filePath: plugin.filePath, manifestPath: plugin.manifestPath, reason: `Duplicate plugin id: ${plugin.id}.` });
        }
      } else {
        plugins.push(group[0]!);
      }
    }
    return { plugins, issues };
  } catch {
    return { plugins: [], issues: [] };
  }
}

export function listSelfEvolutionPlugins(dataDir: string): Array<{ id: string; filePath: string }> {
  return inspectSelfEvolutionPlugins(dataDir).plugins.map(({ id, filePath }) => ({ id, filePath }));
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

export interface QuarantinedArtifactRecord {
  kind: "plugin" | "skill";
  idOrName: string;
  reason: string;
  simAttemptId?: string;
  originalFiles: Array<{ from: string; to: string }>;
  quarantinedAtIso: string;
}

function getQuarantineDir(dataDir: string): string {
  return path.join(getSelfEvolutionRootDir(dataDir), "quarantine");
}

function readQuarantineManifest(dataDir: string): QuarantinedArtifactRecord[] {
  const file = path.join(getQuarantineDir(dataDir), "manifest.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQuarantineManifest(dataDir: string, records: QuarantinedArtifactRecord[]): void {
  const dir = getQuarantineDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "manifest.json"), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
}

export function listQuarantinedArtifacts(dataDir: string): QuarantinedArtifactRecord[] {
  return readQuarantineManifest(dataDir);
}

export function quarantineSelfEvolutionArtifact(
  dataDir: string,
  input: {
    kind: "plugin" | "skill";
    idOrName: string;
    reason: string;
    simAttemptId?: string;
    skillsRootDir?: string;
    atIso?: string;
  },
): QuarantinedArtifactRecord {
  const safeId = path.basename(input.idOrName.trim());
  const overlayDir = getOverlayRepoDir(dataDir);
  const qKindDir = path.join(getQuarantineDir(dataDir), input.kind);
  fs.mkdirSync(qKindDir, { recursive: true, mode: 0o700 });
  const moved: Array<{ from: string; to: string }> = [];

  if (input.kind === "plugin") {
    const pluginsDir = path.join(overlayDir, "plugins");
    const hit = inspectSelfEvolutionPlugins(dataDir).plugins.find((p) => p.id === safeId);
    const candFiles = hit
      ? [hit.filePath, hit.manifestPath]
      : [path.join(pluginsDir, `${safeId}.mjs`), path.join(pluginsDir, `${safeId}.json`)];
    for (const src of candFiles) {
      if (!fs.existsSync(src)) continue;
      const dst = path.join(qKindDir, path.basename(src));
      fs.renameSync(src, dst);
      moved.push({ from: src, to: dst });
    }
  } else {
    const srcDir = path.join(input.skillsRootDir ?? path.join(overlayDir, "skills"), safeId);
    if (fs.existsSync(srcDir)) {
      const dstDir = path.join(qKindDir, safeId);
      if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true, force: true });
      fs.renameSync(srcDir, dstDir);
      moved.push({ from: srcDir, to: dstDir });
    }
  }

  const record: QuarantinedArtifactRecord = {
    kind: input.kind,
    idOrName: safeId,
    reason: input.reason,
    ...(input.simAttemptId ? { simAttemptId: input.simAttemptId } : {}),
    originalFiles: moved,
    quarantinedAtIso: input.atIso ?? new Date().toISOString(),
  };
  const next = readQuarantineManifest(dataDir).filter((r) => !(r.kind === input.kind && r.idOrName === safeId));
  next.push(record);
  writeQuarantineManifest(dataDir, next);
  return record;
}

export function restoreQuarantinedArtifact(
  dataDir: string,
  kind: "plugin" | "skill",
  idOrName: string,
): boolean {
  const safeId = path.basename(idOrName.trim());
  const records = readQuarantineManifest(dataDir);
  const hit = records.find((r) => r.kind === kind && r.idOrName === safeId);
  if (!hit) return false;
  for (const item of hit.originalFiles) {
    if (!fs.existsSync(item.to)) continue;
    fs.mkdirSync(path.dirname(item.from), { recursive: true, mode: 0o700 });
    fs.renameSync(item.to, item.from);
  }
  writeQuarantineManifest(dataDir, records.filter((r) => !(r.kind === kind && r.idOrName === safeId)));
  return true;
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
export function assessSelfEditPath(relPath: string, mode: SelfEvolutionMode = "source"): FileChangeAssessment {
  const raw = String(relPath ?? "");
  const norm = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = norm.split("/").filter(Boolean);
  const unsafePath = norm.startsWith("/") || /^[A-Za-z]:\//.test(norm) || segments.includes("..");

  if (unsafePath) {
    return {
      filePath: norm,
      risk: "requires_approval",
      reason: "Absolute paths and parent-directory traversal are outside the self-evolution workspace.",
    };
  }

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

  if (mode === "packaged" && !(norm.startsWith("skills/") || norm.startsWith("plugins/"))) {
    return {
      filePath: norm,
      risk: "requires_approval",
      reason: "Packaged self-evolution only permits Skills and manifest-validated DSH plugins; other paths require the full source workspace.",
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
      reason: "Within Sugent's zero-intrusion extension scope.",
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
  mode: SelfEvolutionMode = "source",
): SelfEvolutionPlan {
  const assessments = touchedFiles.map((file) => assessSelfEditPath(file, mode));
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
description: Autonomous Skills and compatible plugin extensions, full-source self-iteration, upstream synchronization, and safe code management workflow for Sugent. Use whenever the user asks you to add capabilities, plugins, or skills, or to evolve Sugent's source repository.
---

# Sugent 双模自我迭代与热演进规范 (Self-Evolution SOP)

当前机器人已开启「自我迭代与代码自治（Self-Evolution）」开关，你的工作区（\`.\`）已自动绑定至 Sugent 的演进目录。请根据当前目录结构按对应模式执行：

## 模式 A：普通用户安装包态（Skills + plugin 扩展模式，无需编译器或 Git）
若当前工作区包含 \`README_SELF_EVOLUTION.md\`（位于 \`<dataDir>/self-repo\`）：
1. **动态扩展运行时插件 (\`./plugins/*.mjs\`)**：每个 .mjs 文件必须有同名 .json sidecar，声明格式如 {"id":"sugent-ext-example","apiVersion":${SUGENT_PLUGIN_API_VERSION}}；缺少或不兼容清单的插件会保留但停用。
2. **沉淀新技能 (\`./skills/<name>/SKILL.md\`)**：将新能力写成标准 \`SKILL.md\` 即可永久复用。
3. **阅读自身核心代码 (\`./src/sugent/\` & \`./ARCHITECTURE.md\`)**：这里只读参考；打包应用仅通过官方更新修改核心代码。
4. **官方 UI 与安全边界**：打包应用始终使用随官方版本发布的 UI；旧 UI 覆盖会保留归档但不再加载。技能和兼容插件保留在用户数据目录中。

## 模式 B：开发者完整源码态（Full Source Git 模式）
若当前工作区包含 \`package.json\` 与 \`src/sugent/\`：
1. **零侵入扩展**：所有新增核心逻辑优先写在 \`src/sugent/\` 目录下，测试写在 \`test/sugent*.test.ts\`。
2. **强制回归门禁**：修改后必须运行 \`npm run verify:sugent\`（依次执行 \`tsc --noEmit\`、\`npm run build\`、核心契约验证与 \`docs:check\`），未 100% 通过前严禁提交。
3. **原子提交与远端同步**：通过后可执行 \`git commit\` 与 \`git push origin main\`。
`;

function mirrorSkillsToDshDir(skillsRootDir: string, dshSkillsDir: string): void {
  if (!fs.existsSync(skillsRootDir)) return;
  fs.mkdirSync(dshSkillsDir, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(skillsRootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const srcSkill = path.join(skillsRootDir, entry.name, "SKILL.md");
    if (!fs.existsSync(srcSkill)) continue;
    const destDir = path.join(dshSkillsDir, entry.name);
    fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    const destSkill = path.join(destDir, "SKILL.md");
    const content = fs.readFileSync(srcSkill, "utf8");
    if (!fs.existsSync(destSkill) || fs.readFileSync(destSkill, "utf8") !== content) {
      fs.writeFileSync(destSkill, content, { mode: 0o600 });
    }
  }
}

/**
 * 将 `sugent-self-dev` 技能写入指定技能目录，使智能体开机即具备自我迭代 SOP
 */
export function installSelfDevSkill(skillsRootDir: string): string {
  const dir = path.join(skillsRootDir, "sugent-self-dev");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, SUGENT_SELF_DEV_SKILL, { mode: 0o600 });
  const parentDir = path.dirname(path.resolve(skillsRootDir));
  if (path.basename(path.resolve(skillsRootDir)) === "skills" && path.basename(parentDir) === "extensions") {
    const mirrorDir = path.join(parentDir, ".dsh", "skills", "sugent-self-dev");
    fs.mkdirSync(mirrorDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(mirrorDir, "SKILL.md"), SUGENT_SELF_DEV_SKILL, { mode: 0o600 });
  }
  return file;
}

/**
 * 当机器人在设置中开启 `selfEvolution.enabled` 时由宿主自动调用：
 * 1. 解析源码根目录（开发态 `./` 或打包态 `<dataDir>/self-repo` 热覆盖层）；
 * 2. 确保 `<dataDir>/self-repo/` 的 `plugins/`、`skills/` 与只读参考镜像已就绪；
 * 3. 在该机器人的 DSH `skills/` 目录自动挂载 `sugent-self-dev/SKILL.md`；
 * 4. 在知识图谱中自动确保自演进工作流节点已就位。
 */
export function prepareSelfEvolutionWorkspace(dataDir: string, dshHomeDir: string): { workspaceRoot: string; skillFile: string } {
  ensureSelfEvolutionOverlay(dataDir);
  const workspaceRoot = resolveSelfEvolutionRoot(dataDir);
  const skillFile = installSelfDevSkill(path.join(dshHomeDir, "skills"));
  try {
    const kg = new SugentKnowledgeGraph(resolveUnifiedKnowledgeGraphDir(dataDir));
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
