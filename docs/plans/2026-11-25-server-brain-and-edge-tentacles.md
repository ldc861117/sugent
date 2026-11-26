# Server-Brain & Edge-Tentacles Architecture Implementation Plan

**Goal:** 将 Sugent 从“客户端中心制”彻底升级为「1 个云端常驻主权大脑 (`gce-hub` + `sugent.metamirror.club`) + 全端零折损入口（微信 / HTTPS Web）+ 多节点轻量 Antigravity 执行触手（`local-mac` / `gce-remote`）」，根治微信端跨天对话失忆与跨节点项目盲区。
**Spec Reference:** 用户拍板架构原则（Sugent 常驻服务端担任唯一顶层管家与协调者，微信/Web 零折损共享同一大脑，具体编码落地由本地或云端 Remote Antigravity 触手承接）。
**Tech Stack & Test Runner:** TypeScript ESM (`Node >= 22.13`, `node:sqlite`, `node:http`, `node:crypto`), Vitest (`npx vitest run`), Contract Gate (`npm run verify:sugent`).
**Execution Pipeline:** `writing-plans` -> `subagent-orchestrator` -> `code-review` -> `verification-gate`

---

## 0. 架构演进「商业策略自省四问」（AGENTS.md 第 3.3 节强制门禁）

| 自省维度 | 核心拷问 | 本方案的收敛与守线决策 |
| :--- | :--- | :--- |
| **1. 付费锚点（Why Pay & Moat）** | 哪些属开源基座，哪些构成高溢价壁垒？ | **开源基座**：原生 `EdgeTentacleHub` 触手协议、跨天全渠道对话记忆检索（`ChatTranscriptRecallService`）与单节点/自托管 HTTPS 部署模板 100% 开源。**商业增值**：免运维托管云端常驻幕僚实例、零配置多设备加密触手漫游与企业级 `Cowork Hub` 多团队治理看板。 |
| **2. 合规与分发（Distribution & ToS Risk）** | 公网域名反代与跨机派单是否存在安全暴露或越权风险？ | 宿主机端口继续锁定 `127.0.0.1:3600`，公网统一经 Nginx TLS 反代并配请求限速、`HttpOnly; Secure; SameSite=Lax` 长效鉴权与时序安全（`timingSafeEqual`）`SUGENT_EDGE_TOKEN`；触手上报遵循 Tier `0/1/2` 隐私裁剪并剥离宿主机敏感绝对路径，高危派单仍受二次确认门禁约束。 |
| **3. 离线退路（Sovereignty Fallback）** | 纯单机免服务器用户（`mode: "none"`）是否依然零配置自洽？ | 单机模式下 `Server 本体` 与本机扫描器在同一 `127.0.0.1` 进程内直接联动，无需配置任何域名或 `SUGENT_EDGE_TOKEN` 即可 100% 离线闭环运行。 |
| **4. 一人公司运维杠杆（OPC Ops Leverage）** | 是否消除了额外部署第三方中转站与双客户端维护负担？ | **大做减法**：无需额外部署独立 `/ops` 站点，由 `sugent-gce-hub` 原生内建 `/amb/api/steward/edge/*`；Mac 本机无需常驻重型桌面 GUI 客户端，仅挂一个百行级零依赖 `edge:tentacle` 守护脚本即可同步全部项目态势并代调 Antigravity。 |

---

## Wave Summary

- **Wave 1 (Parallel Fan-Out — Strictly Disjoint Files):**
  - **Task 1 (`Edge Hub Implementer`)**: `src/sugent/edge-tentacle-hub.ts` + `test/sugent-edge-tentacle-hub.unit.test.ts`
  - **Task 2 (`Chat Memory Implementer`)**: `src/sugent/chat-transcript-recall.ts` + `test/sugent-chat-transcript-recall.unit.test.ts`
  - **Task 3 (`HTTPS & Daemon Packager`)**: `deploy/gce-hub/nginx-sugent.metamirror.club.conf` + `deploy/gce-hub/setup-https-domain.sh` + `deploy/edge-tentacle/*` + `src/cli/edge-tentacle.ts` + `test/sugent-deploy-and-edge-cli.unit.test.ts`
- **Wave 2 (Sequential Integration & Gate, depends on Wave 1):**
  - **Task 4**: Wire `EdgeTentacleHub` & `ChatTranscriptRecallService` into `src/sugent/index.ts`, `src/sugent/steward-llm-agent.ts` (`recall_chat_history` + `dispatch_edge_antigravity`), `src/sugent/steward-host-service.ts`, `src/sugent/owner-channel-steward-router.ts`, `src/app.ts`, `src/web/server.ts` (`/amb/api/steward/edge/*` + HTTPS `Secure` cookie), `package.json`, and `scripts/verify-sugent.mjs` (Section 27).

---

### Task 1: Native Edge Tentacle Hub & Local Project `STATUS.md` / `ROADMAP.md` Scanner
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/edge-tentacle-hub.ts`
  - Test: `test/sugent-edge-tentacle-hub.unit.test.ts`

1. **Write the failing test**:
   - Test `scanLocalProjectsForEdge` scanning a temp `Projects/` directory containing `airtoken/STATUS.md` (5 governance sections + frontmatter) and `airtoken/docs/ROADMAP.md` (`- [x]` / `- [ ]` checkboxes), asserting accurate `statusCard`, `roadmapSummary`, Tier `0/1/2` privacy redaction of local paths, and session folding.
   - Test `EdgeTentacleHub` persistence (`0o600` `<dataDir>/sugent-stewardship/edge-fleet-state.json`), timing-safe token check (`verifyEdgeToken`), multi-node (`local-mac` + `gce-remote`) pulse merging into `OpsStewardPendingSnapshot`, command queueing (`dispatch_antigravity_new` / `dispatch_antigravity_resume` / `sync_pulse_now`), `pullPendingCommands`, and idempotent `ackNodeCommand`.
   - Test `EdgeTentacleRunner` pushing local project pulses to Hub and executing queued Antigravity dispatch commands via injected `AntigravityDispatcher`-compatible port.
2. **Verify RED**: `npx vitest run test/sugent-edge-tentacle-hub.unit.test.ts` fails with module not found.
3. **Implement minimal code**: Implement `scanLocalProjectsForEdge`, `EdgeTentacleHub`, and `EdgeTentacleRunner` in `src/sugent/edge-tentacle-hub.ts`.
4. **Verify GREEN**: Re-run Vitest and confirm `0` failures.

---

### Task 2: Persistent Cross-Day & Cross-Channel Conversation Recall & Hydration
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/chat-transcript-recall.ts`
  - Test: `test/sugent-chat-transcript-recall.unit.test.ts`

1. **Write the failing test**:
   - Seed an SQLite `DatabaseSync` (`conversations` + `messages` matching `src/store/db.ts` schema) across 2 days (`昨天` WeChat turns + `今天` Web turns) plus web steward JSONL turns.
   - Assert `hydrateRecentPeerHistory` restores the exact chronological sliding window for `weixin` peer after process restart.
   - Assert `recallChatHistory({ daysBack: 2 })` and `recallChatHistory({ query: "airtoken" })` return cross-channel messages (`weixin` + `web` + `feishu`) with secret token redaction (`sk-...`, `clikey-...`) and exclude group/non-owner noise when `ownerOnly: true`.
2. **Verify RED**: `npx vitest run test/sugent-chat-transcript-recall.unit.test.ts` fails with module not found.
3. **Implement minimal code**: Implement `ChatTranscriptRecallService` in `src/sugent/chat-transcript-recall.ts`.
4. **Verify GREEN**: Re-run Vitest and confirm `0` failures.

---

### Task 3: `sugent.metamirror.club` HTTPS Reverse Proxy & Edge Tentacle Daemon Kit
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `deploy/gce-hub/nginx-sugent.metamirror.club.conf`
  - Create: `deploy/gce-hub/setup-https-domain.sh`
  - Create: `deploy/edge-tentacle/ai.sugent.edge-tentacle.plist`
  - Create: `deploy/edge-tentacle/sugent-edge-tentacle.service`
  - Create: `deploy/edge-tentacle/install-mac-tentacle.sh`
  - Create: `src/cli/edge-tentacle.ts`
  - Test: `test/sugent-deploy-and-edge-cli.unit.test.ts`

1. **Write the failing test**:
   - Assert Nginx config enforces `127.0.0.1:3600` upstream, TLS protocols, `limit_req_zone` anti-bruteforce, SSE `proxy_buffering off`, WebSocket upgrade headers, and `X-Forwarded-Proto $scheme`.
   - Assert `parseEdgeTentacleCliConfig` in `src/cli/edge-tentacle.ts` parses env/argv (`--once`, `--hub-url`, `--node-id`, `--projects-dir`), rejects missing `SUGENT_EDGE_TOKEN` unless `--dry-run-scan` is set, and launchd/systemd templates contain zero hardcoded secrets.
2. **Verify RED**: `npx vitest run test/sugent-deploy-and-edge-cli.unit.test.ts` fails.
3. **Implement minimal code**: Author deployment templates and `src/cli/edge-tentacle.ts` (decoupled config/runner bootstrapper).
4. **Verify GREEN**: Re-run Vitest and confirm `0` failures.

---

### Task 4: Host Wiring, `/amb/api/steward/edge/*` Endpoints, LLM Tools & Section 27 Gate
- **Wave:** Wave 2 (Sequential)
- **Depends on:** Task 1, Task 2, Task 3
- **Touches files:**
  - Modify: `src/sugent/index.ts`
  - Modify: `src/sugent/owner-channel-steward-router.ts`
  - Modify: `src/sugent/steward-llm-agent.ts`
  - Modify: `src/sugent/steward-host-service.ts`
  - Modify: `src/app.ts`
  - Modify: `src/web/server.ts`
  - Modify: `package.json`
  - Modify: `scripts/verify-sugent.mjs`

1. Hydrate `OwnerChannelStewardRouter` from `ChatTranscriptRecallService` on cold peer cache miss; log Web `/amb/api/steward/converse` turns into `ChatTranscriptRecallService` so Web and WeChat share 100% unified chat history.
2. Add `recall_chat_history` and `dispatch_edge_antigravity` tools to `StewardLlmAgent` (and update system prompt so "昨天聊了什么" always calls `recall_chat_history`, and remote/local project coding requests call `dispatch_edge_antigravity`).
3. Mount `/amb/api/steward/edge/pulse`, `/amb/api/steward/edge/commands`, `/amb/api/steward/edge/commands/:id/ack`, and `/amb/api/steward/edge/snapshot` in `src/web/server.ts` (allowing `Authorization: Bearer <SUGENT_EDGE_TOKEN>` or `x-amb-token`), plus `; Secure` cookie flag when `x-forwarded-proto === "https"`, and notify WeChat owner when an edge Antigravity command completes!
4. Add Section 27 to `scripts/verify-sugent.mjs` and run full `@code-review` + `@verification-gate`.
