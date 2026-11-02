import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SugentKnowledgeGraph } from "../src/sugent/index.js";

describe("Sugent Autonomous Knowledge Graph & Skill Crystallization", () => {
  it("supports multi-hop subgraph recall, exclusive temporal edge superseding, and skill crystallization", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-kg-"));
    try {
      const kg = new SugentKnowledgeGraph(tmpDir);

      // 1. 写入初始实体与单值排他关系 (exclusive: true)
      kg.applyDelta(
        {
          nodes: [
            { id: "user:owner", kind: "person", name: "Owner", summary: "Sugent 个人架构师", tags: ["architect"] },
            { id: "proj:sugent", kind: "project", name: "Sugent", summary: "全能个人自治智能体", tags: ["agent", "dsh"] },
            { id: "model:sonnet", kind: "tool", name: "Claude Sonnet 4.5", summary: "主力编码模型", tags: ["llm"] },
            { id: "model:opus", kind: "tool", name: "Claude Opus 4.6", summary: "深度架构模型", tags: ["llm"] },
            {
              id: "wf:upstream-sync",
              kind: "workflow",
              name: "双上游无冲突同步流程",
              summary: "自动拉取 AnyModelBot 与 dsh-superagent 并执行契约自检",
              tags: ["git", "maintenance"],
              reinforcements: 3,
              steps: [
                "运行 npm run sync:upstreams 检查双上游最新 Commit",
                "运行 npm run sync:upstreams:merge 合并主干与子树",
                "运行 npm run verify:sugent 验证类型与核心契约",
              ],
            },
          ],
          edges: [
            { from: "user:owner", relation: "owns", to: "proj:sugent", source: "init" },
            { from: "proj:sugent", relation: "prefers_executor", to: "model:sonnet", source: "day1", exclusive: true },
            { from: "proj:sugent", relation: "maintained_by", to: "wf:upstream-sync", source: "day1" },
          ],
        },
        "2026-11-01T10:00:00.000Z",
      );

      // 2. 更新偏好：exclusive 关系自动将旧的 model:sonnet 边标记为 supersededAt
      kg.applyDelta(
        {
          edges: [
            { from: "proj:sugent", relation: "prefers_executor", to: "model:opus", source: "day2", exclusive: true },
          ],
        },
        "2026-11-01T12:00:00.000Z",
      );

      // 3. 多跳召回：只搜 "Owner" (1 跳到 proj:sugent，2 跳到 model:opus 与 wf:upstream-sync)
      const sub = kg.recallSubgraph("Owner", 2);
      const recalledIds = sub.matchedNodes.map((n) => n.id);
      expect(recalledIds).toContain("user:owner");
      expect(recalledIds).toContain("proj:sugent");
      expect(recalledIds).toContain("model:opus");
      expect(recalledIds).toContain("wf:upstream-sync");
      expect(recalledIds).not.toContain("model:sonnet"); // 已过时的排他边不再被召回

      // 4. 经验结晶为固化 SKILL.md
      const skills = kg.crystallizeSkills(3);
      expect(skills).toHaveLength(1);
      expect(skills[0].skillName).toBe("wf-upstream-sync");
      expect(skills[0].markdown).toContain("npm run verify:sugent");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
