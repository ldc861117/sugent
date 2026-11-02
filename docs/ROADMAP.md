# Sugent 中短期演进蓝图 (Short & Mid-Term Roadmap)

**Sugent** 的演进遵循**“一人架构师 + Agent 军团自举迭代”**的核心策略：每一个阶段做出的新能力，都必须立刻反哺到你自己的日常研发、信息降噪与个人自动化中。

---

## 阶段一：短期蓝图（第 1–4 周）—— 跑通“零噪音个人数字幕僚 + 仓库自治”闭环

短期核心目标是**彻底打通你个人的微信/飞书入口、解耦算力成本，并让 Sugent 接管它自身代码仓库的日常维护**。

| 里程碑 | 关键交付物与模块 | 验收标准（Definition of Done） |
| :--- | :--- | :--- |
| **M1.1 算力自由与四角色模型路由落地** | `src/sugent/gateway.ts`、`src/magpie/supervisor.ts` | 1. 支持通过 `SUGENT_GATEWAY_URL` 或 `SUGENT_UNLOCK_SUBSCRIPTIONS=1` 免 Modelflare 登录直连本地 `magpie` / 自有 Key / 包月订阅；<br>2. 实现 `assessor`（守门小模型）与 `executor`（主力推理模型）按任务阶段自动分流，日常巡检 Token 成本降低 80%+。 |
| **M1.2 双层混合记忆与自主知识图谱闭环** | `src/sugent/knowledge-graph.ts`、`src/agent/manager.ts` | 1. 每次对话归档（`review()`）自动同步沉淀实体（`KGNode`）与排他时效边（`KGEdge`）；<br>2. 支持 K-Hop（2 跳）关联子图召回；<br>3. 累计验证 ≥ 3 次的 `workflow` 自动落盘生成标准 `SKILL.md`。 |
| **M1.3 自举式仓库维护官（Dogfooding）** | `scripts/sync-upstreams.mjs`、`src/sugent/sources.ts` | 1. 每日定时运行 `sync:upstreams` 检查 `AnyModelBot` 与 `dsh-superagent-prototype` 更新；<br>2. 自动在隔离分支合并、跑完 `npm run verify:sugent`，并将变更摘要推送到你的微信/飞书等待确认。 |

---

## 阶段二：中期蓝图（第 1–3 个月）—— 构建全景个人事件总线与“影子学习”工作台

中期核心目标是**从“被动聊天/简单定时”升级为“全天候事件驱动 + 观察转正”的个人数字分身**。

### 1. 扩展个人全景 `SourceKind` 插件集（`src/sugent/sources.ts`）
- **邮件与日历感知源（`mail_calendar`）**：接入个人 IMAP/Gmail 与 CalDAV/Google Calendar，在收到关键客户/账单邮件或会议前 15 分钟触发 `Intake → Eval`，由 `assessor` 模型过滤广告噪音，仅对高优事项自动准备背景资料或草拟回复。
- **本地工作区与下载目录监听源（`filesystem`）**：监听 `~/Downloads` 或指定收件箱文件夹，例如当你拖入一张发票 PDF 或合同文档时，后台自动触发分类、重命名、提取关键金额入图谱，并在微信告诉你处理结果。
- **GitHub 与个人项目监控源（`github`）**：深度整合 `packages/dsh-superagent/src/sources/github-watch.ts`，不仅监控单一仓库，还支持监控你名下多个核心仓库的 Issue、PR Review 与 Release 动态。

### 2. 完善“观察模式 → 自动转正（Shadow-to-Act）”可视化体验
- 在本地 Web 控制台（`127.0.0.1:3600`）与移动端卡片中展示主动规则的**影子演练账本（Shadow Ledger）**：清晰对比智能体在 `observe` 模式下“本打算做什么（`would`）”与你的实际预期。
- 当某条规则连续 3 次给出高质量判断时，通过 `shouldSuggestRulePromotion()` 主动在「需要你」侧栏弹出转正卡片，一键切换为 `act` 全自动执行。

### 3. 知识图谱可视化与跨设备端到端同步
- 在信息面板的「记忆」页签旁增加**「知识图谱（Knowledge Graph）」视图**，直观展示当前沉淀的 `person` / `project` / `workflow` 节点与已自动结晶的 `SKILL.md` 技能列表。
- 支持通过 Git 私有仓库、WebDAV（坚果云/Nextcloud）或 S3 将 `<dataDir>/memory` 与 `<dataDir>/knowledge-graph` 加密同步到你的多台 Mac / NAS。

---

## 阶段三：中远期与商业化蓝图（第 3–6 个月）—— 一人公司的产品化与生态变现

在完全不需要组建传统研发团队的前提下，依托开源影响力与高复用资产实现商业闭环：

1. **Open-Core 旗舰桌面版与 NAS 一键套件**：保持核心 MIT 开源，推出免配置的签名桌面版与支持云端加密记忆同步、手机专属审批面板的 **Sugent Pro** 个人订阅/买断制。
2. **垂直场景“自治规则与结晶技能包（Playbooks）”市场**：将你自己日常打磨成熟的 `SKILL.md` + 知识图谱种子 + 主动观察规则打包（如《独立开发者全自动 GitHub 维护官》《外贸/跨境多渠道智能分诊台》《个人财务与发票自动归档员》），提供一键导入。
3. **面向小微工作室的 Turnkey 数字员工镜像**：为 3–10 人的小型研发、咨询、自媒体工作室提供带预算硬上限、群聊静默旁听（`followForContext`）与飞书/企微审批流的私有化部署包。
