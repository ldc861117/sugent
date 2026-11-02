# Sugent Personal Super-Agent Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and evolve **Sugent**, an all-in-one local-first personal autonomous agent that fuses `modelflare-ai/AnyModelBot` (multi-channel IMs, 3-layer memory, desktop computer-use) with `deepseek-ai/dsh-superagent-prototype` (`Intake -> Eval -> Ticket -> Assignment` state machine & `SourceKind` event bus), fully decoupled from any single model relay.

**Architecture:** Zero-intrusion three-layer repository topology. `AnyModelBot` serves as the root desktop/Docker/channel host (`upstream-amb`), `dsh-superagent-prototype` is mounted under `packages/dsh-superagent` via `git subtree` (`upstream-dsh`), and all Sugent fusion logic lives in `src/sugent/` with dedicated unit tests in `test/sugent.unit.test.ts`.

**Tech Stack:** TypeScript (ES2023 / NodeNext), Node.js >= 22.13, Vitest, SQLite, DeepSeek Harness (`@deepseek-ai/dsh`), Magpie Local Model Gateway, Electron.

---

### Task 1: Model Gateway Decoupling & Role-Based Routing (`src/sugent/gateway.ts`) — [COMPLETED]

**Files:**
- Create: `src/sugent/types.ts`
- Create: `src/sugent/gateway.ts`
- Test: `test/sugent.unit.test.ts`

**Step 1: Verify unit tests for gateway decoupling and role routing**

Run: `npx vitest run test/sugent.unit.test.ts`
Expected: PASS for `Sugent Gateway Decoupling & Tiered Model Routing` suite.

---

### Task 2: Autonomous Kernel Gate (`Intake -> Eval -> Ticket`) (`src/sugent/kernel.ts`) — [COMPLETED]

**Files:**
- Create: `src/sugent/kernel.ts`
- Create: `src/sugent/index.ts`
- Test: `test/sugent.unit.test.ts`

**Step 1: Verify unit tests for owner-only filtering, thread follow-up attachment, and observation-to-act rule promotion**

Run: `npx vitest run test/sugent.unit.test.ts`
Expected: PASS for `Sugent Autonomous Kernel Gate (Intake -> Eval -> Ticket)` suite.

---

### Task 3: Wire `MagpieSupervisor` to Sugent Subscription & BYOK Unlocker (Next Milestone)

**Files:**
- Modify: `src/magpie/supervisor.ts:95-145`
- Modify: `src/sugent/gateway.ts`
- Test: `test/sugent.unit.test.ts`

**Step 1: Write the failing test**

Add a test in `test/sugent.unit.test.ts` verifying that when `SUGENT_UNLOCK_SUBSCRIPTIONS=1` is set in environment variables, `MagpieSupervisor.env()` omits `MAGPIE_NO_ACCOUNTS` and sets `noAccountDiscovery: false` in `settings.json`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent.unit.test.ts`
Expected: FAIL until `src/magpie/supervisor.ts` reads `buildMagpieEnvOverrides()`.

**Step 3: Write minimal implementation**

In `src/magpie/supervisor.ts`, import `resolveSugentGatewayConfig` and `buildMagpieEnvOverrides` from `../sugent/gateway.js` and apply the overrides in `env()` and `prepare()`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent.unit.test.ts && npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/magpie/supervisor.ts test/sugent.unit.test.ts
git commit -m "feat(sugent): wire MagpieSupervisor to unlock local subscriptions when configured"
```

---

### Task 4: Personal Event Bus Adapter (`SourceKind` Bridge for GitHub, Mail & Local Files)

**Files:**
- Create: `src/sugent/sources.ts`
- Test: `test/sugent-sources.unit.test.ts`

**Step 1: Write the failing test**

Create `test/sugent-sources.unit.test.ts` testing normalization of a GitHub webhook/poll event and a local folder watcher event into `PersonalTrigger` objects and routing them through `evaluatePersonalTrigger()`.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/sugent-sources.unit.test.ts`
Expected: FAIL with module `../src/sugent/sources.js` not found.

**Step 3: Write minimal implementation**

Implement `src/sugent/sources.ts` with `PersonalSourceRegistry` that registers `github`, `im_channel`, `schedule`, and `filesystem` sources and converts raw payloads into `PersonalTrigger`.

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/sugent-sources.unit.test.ts && npm run typecheck`
Expected: PASS

**Step 5: Commit**

```bash
git add src/sugent/sources.ts test/sugent-sources.unit.test.ts
git commit -m "feat(sugent): add PersonalSourceRegistry bridging dsh-superagent SourceKind to personal channels"
```
