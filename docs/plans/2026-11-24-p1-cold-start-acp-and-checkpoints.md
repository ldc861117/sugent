# Wave P1: 3-Minute Zero-Form Cold-Start, ACP Coding Harness & Hidden Git Checkpoints Implementation Plan

**Goal:** Deliver `docs/ROADMAP.md` Wave P1 (`P1.1–P1.4`) — compressing first-run time-to-aha under 3 minutes without upfront configuration forms, unifying external coding CLIs (`Claude Code`, `Codex`, `OpenCode`, `Pi`) behind an `Agent Client Protocol (ACP)` harness with dual-track USD/subscription quota accounting, adding zero-dirty-worktree hidden Git ref checkpoints + APFS `clonefile` worktree dedup + security-enveloped PR/CI review ingestion, and enforcing lazy desktop OS permission prompts + Windows/WSL2 cross-filesystem safety.
**Spec Reference:** `docs/ROADMAP.md` (Wave P1 `P1.1–P1.4`) & `AGENTS.md` (§1–§5)
**Tech Stack & Test Runner:** TypeScript ESM (`Node >= 22.13`), Vitest (`npm run test:sugent`), `npm run verify:sugent`
**Execution Pipeline:** `writing-plans` -> `subagent-orchestrator` -> `code-review` -> `verification-gate`

## Wave Summary

- **Wave 1 (Parallel Fan-Out — 4 Disjoint Subagents):**
  - **Task 1 (`P1.1`):** `src/sugent/cold-start-onboarding.ts` + `test/sugent-cold-start-onboarding.unit.test.ts`
  - **Task 2 (`P1.2` Research & Spec):** Official `Agent Client Protocol (ACP)` JSON-RPC 2.0 stdio framing & CLI invocation vector verification (`Claude Code`, `Codex`, `OpenCode`, `Pi`) -> `src/sugent/acp-coding-harness.ts` + `test/sugent-acp-coding-harness.unit.test.ts`
  - **Task 3 (`P1.3a + P1.3c`):** `src/sugent/git-checkpoint-and-pr-feed.ts` + `test/sugent-git-checkpoint-and-pr-feed.unit.test.ts`
  - **Task 4 (`P1.3b + P1.4`):** `src/sugent/worktree-and-platform-guard.ts` + `test/sugent-worktree-and-platform-guard.unit.test.ts`
- **Wave 2 (Sequential Host Integration, Section 25 Gate & Independent Review):**
  - **Task 5 (`P1 Integration & Gate`):** Wire Tasks 1–4 into `src/sugent/repo-binding.ts`, `src/sugent/vibe-coding-pipeline.ts`, `src/sugent/steward-host-service.ts`, `src/sugent/index.ts`, `package.json`, `scripts/verify-sugent.mjs` (Section 25), `docs/ROADMAP.md` (`[x]` on `P1.1–P1.4`), `STATUS.md`, and `docs/decisions/steward-notes.md`.

### Task 1: Zero-Form 3-Minute Cold-Start Engine (`P1.1`)
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/cold-start-onboarding.ts`
  - Test: `test/sugent-cold-start-onboarding.unit.test.ts`
1. **Write the failing test**: Assert `probeColdStartReadiness` detects available local CLIs/gateways without prompting 5D forms; `ingestFirstDrop` turns a dropped project/contract folder or forwarded message text into 1 `ResourceEntry` (`kind: "personal_archive"`) + 1 `CommitmentItem` in `StewardshipLedger` in `< 60s` and stages a zero-cost `SuspendedRoundStore` approval checkpoint; approving resumes cleanly once.
2. **Verify RED**: `npx vitest run test/sugent-cold-start-onboarding.unit.test.ts` fails with module missing.
3. **Implement minimal code**: Pure Node `fs`/`path` folder scanner (reads `package.json`/`README.md`/`AGENTS.md`/contracts up to depth 2, zero LLM required for cold bootstrap) + `StewardshipLedger` & `SuspendedRoundStore` integration.
4. **Verify GREEN**: `npx vitest run test/sugent-cold-start-onboarding.unit.test.ts` passes `0` failures.

### Task 2: Standard ACP External Agent Harness & Dual-Track Quota Ledger (`P1.2`)
- **Wave:** Wave 1 Research -> Wave 2 Materialization
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/acp-coding-harness.ts`
  - Test: `test/sugent-acp-coding-harness.unit.test.ts`
1. **Write the failing test**: Verify `AcpCodingHarness` speaks newline-delimited JSON-RPC 2.0 (`initialize` -> `session/new` -> `session/prompt` / `session/cancel`) over safe `argv` vectors (via `assertSafeDeliveryCommandVector`, zero shell interpolation, never passing `dangerously-skip-permissions` by default) for `"claude_code" | "codex" | "opencode" | "pi"`; verify `DualTrackCodingBudget` separates `apiUsd` vs `subscriptionQuota` (sliding window count + cooldown); verify `runCrossAgentCodingLoop` runs Coder Agent A -> `IndependentGateRunner` -> Reviewer Agent B.
2. **Verify RED & Implement minimal code** following verified ACP specification.
3. **Verify GREEN**: `npx vitest run test/sugent-acp-coding-harness.unit.test.ts` passes `0` failures.

### Task 3: Hidden Git Ref Checkpoints & Enveloped PR/Element Handoff (`P1.3a + P1.3c`)
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/git-checkpoint-and-pr-feed.ts`
  - Test: `test/sugent-git-checkpoint-and-pr-feed.unit.test.ts`
1. **Write the failing test**: Create a real temporary Git repo, modify tracked + untracked files, call `createCheckpoint({ workspacePath, pipelineId, roundId, attemptId })`, assert `git log` on active branch is completely unchanged while `refs/sugent/checkpoints/<pipelineId>/<roundId>` exists; modify files again, verify `diffCheckpoints` lists changed files, and `restoreCheckpoint` rolls back working tree cleanly while saving a pre-restore safety ref; verify `stagePrReviewToHandoff` strips privileged fields (`cwd`, `permission`, `command`) via `sealExternalEvent` and writes an incremental fix spec into `.sugent-handoff/inbox/`.
2. **Verify RED & Implement minimal code** using isolated temporary `GIT_INDEX_FILE` so the live `.git/index` is never corrupted.
3. **Verify GREEN**: `npx vitest run test/sugent-git-checkpoint-and-pr-feed.unit.test.ts` passes `0` failures.

### Task 4: Zero-Bloat Worktree Isolation, Lazy OS Permissions & WSL2 Guards (`P1.3b + P1.4`)
- **Wave:** Wave 1 (Parallel)
- **Depends on:** None
- **Touches files:**
  - Create: `src/sugent/worktree-and-platform-guard.ts`
  - Test: `test/sugent-worktree-and-platform-guard.unit.test.ts`
1. **Write the failing test**: Verify `provisionWorktreeIsolation` allocates unique non-colliding `PORT` + isolated `TMPDIR` across concurrent worktrees and links `node_modules` via macOS APFS `cp -c` (falling back to symlink/junction when CoW is unsupported); verify `LazyDesktopPermissionGate` performs zero TCC permission probes at app startup and only triggers guidance upon first CUA action; verify `normalizeCrossOsWorkspace` detects `/mnt/c/...` WSL2 DrvFS slow mounts and `atomicWriteCrossFs` handles Windows `EPERM`/`EXDEV` rename fallback cleanly.
2. **Verify RED & Implement minimal code**.
3. **Verify GREEN**: `npx vitest run test/sugent-worktree-and-platform-guard.unit.test.ts` passes `0` failures.

### Task 5: Host Integration, Section 25 Gate & Independent Review (`Wave 2`)
- **Wave:** Wave 2 (Sequential)
- **Depends on:** Tasks 1–4
- **Touches files:** `src/sugent/repo-binding.ts`, `src/sugent/vibe-coding-pipeline.ts`, `src/sugent/steward-host-service.ts`, `src/sugent/index.ts`, `package.json`, `scripts/verify-sugent.mjs`, `docs/ROADMAP.md`, `STATUS.md`, `docs/decisions/steward-notes.md`.
