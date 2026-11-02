# Sugent Agent 研发与维护规范 (AGENTS.md)

本仓库由**个人架构师 + Coding Agent 研发团队**全权维护。所有参与本仓库开发的智能体（Claude Code、Codex、DeepSeek Harness、Gemini 等）必须严格遵守以下工程铁律：

## 1. 分支与上游隔离铁律

1. **主分支约定**：本仓库默认主分支为 `main`（远程仓库 `origin` 为 `https://github.com/ldc861117/sugent.git`）。
2. **零侵入扩展原则**：
   - Sugent 的自研核心代码一律放在 `src/sugent/`、测试放在 `test/sugent*.test.ts`、计划文档放在 `docs/plans/`。
   - **严禁**无故大面积重写上游 `AnyModelBot` 的 `src/channels/`、`src/tasks/service.ts` 或 `packages/dsh-superagent/` 内部文件；如需接入宿主流程，优先采用薄适配器（Adapter）或配置注入，以确保 `npm run sync:upstreams:merge` 长期零冲突。
3. **双上游同步**：
   - `upstream-amb`：`https://github.com/modelflare-ai/AnyModelBot.git`（宿主底座）
   - `upstream-dsh`：`https://github.com/deepseek-ai/dsh-superagent-prototype.git`（挂载于 `packages/dsh-superagent`）

## 2. 编码与设计准则

1. **遵循注意力经济学**：认真阅读 `packages/dsh-superagent/docs/000-philosophy.md` 与 `ARCHITECTURE.md`。能用 Prompt、`SKILL.md` 或合理默认值解决的问题，绝不新增多余的 UI 开关或冗余概念（*Few concepts. Few settings.*）。
2. **模型网关中立性**：所有新增的模型调用必须支持通过 `src/sugent/gateway.ts` 按角色（`assessor` / `executor` / `computer_use` / `steward`）路由，不得硬编码绑定单一供应商。
3. **测试驱动与提交门禁**：
   - 任何代码改动完成后，必须运行 `npm run typecheck` 与 ` npx vitest run test/sugent.unit.test.ts`（或全量 `npm test`）。
   - 类型检查与测试未 100% 通过前，严禁宣称任务完成或推送到远程分支。
