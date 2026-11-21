# Sugent Avatar & Physics Stage v2 Implementation Plan

> **For agentic workers:** Implement task-by-task following zero-intrusion rules (`AGENTS.md`). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Sugent's v1 squircle-head sticker avatars with a 2.5-head miniature sculpture `3×2` pose sheet, a zero-dependency Node auto-rigging engine (`src/sugent/avatar-pose-rig.ts`), a spring-damper Canvas physics stage (`ui/components/companion-stage.js`), and a consolidated Studio UI.

**Architecture:** `src/sugent/avatar-pose-rig.ts` decodes `1536×1024` `3:2` pose sheets (or single full-body images), strips studio backdrops with ceramic highlight protection, normalizes all 6 poses into `1152×768` (`384×384` per cell, `y = 88%` baseline), and extracts `256×256` head-shoulder portraits (`portrait.png`). `ui/components/companion-stage.js` drives continuous 3-band strip micro-motion with pinned feet, `±22°` pendulum drag physics, `48px` edge docking with workspace-facing auto-flip, and `260ms` 3-phase transitions.

**Tech Stack:** TypeScript / Node.js (`node:zlib`, `node:sqlite`, `node:http`), Preact + htm, Canvas 2D, Electron `BrowserWindow`, Gemini `generateContent` (`3:2`) + OpenAI fallback.

## Global Constraints

- Design Spec: `docs/plans/2026-11-21-pose-sheet-v2-mannequin-and-physics-stage-design.md`
- `mannequin-pose-sheet-v2.png`: `1536×1024` (`3:2`), 3 cols × 2 rows (`512×512` each), flat `#DCE2EA` / `#F4F5F7` studio backdrop, zero grid lines/borders/text.
- Normalized Pose Sheet: `1152×768` (`384×384` per cell, ground baseline `y = 88%`), `256×256` portrait crop (`≤48px` surfaces).
- Poses order: `idle` (`0,0`), `listening` (`1,0`), `thinking` (`2,0`), `working` (`0,1`), `waiting` (`1,1`), `sleep` (`2,1`).
- Backward compat: keep `visor_v1` packs + legacy `test/phase3.unit.test.ts`, `test/design-system.unit.test.ts`, `test/i18n.unit.test.ts` green.

---

### Task 1: Zero-Dependency 3×2 Auto-Rigging Engine (`src/sugent/avatar-pose-rig.ts`)

**Files:**
- Create: `src/sugent/avatar-pose-rig.ts`
- Modify: `src/sugent/index.ts`

**Interfaces:**
- Consumes `decodeImageBufferToRgba`, `encodeRgbaToPng` from `./avatar-rig.js`.
- Produces `POSE_KEYS`, `AvatarPoseKey`, `PoseSheetLayoutMode`, `PoseCellMetrics`, `PoseSheetRigMetadata`, `RigPoseSheetOptions`, `RiggedPoseSheetResult`, `POSE_HEIGHT_RATIOS`, `CANONICAL_POSE_SHEET_META`, `rigPoseSheetImageBuffer`.

- [ ] **Step 1:** Implement white-porcelain-safe studio backdrop removal (4-edge BFS + Sobel barrier + interior hole cleanup + edge defringe).
- [ ] **Step 2:** Implement accidental divider suppression & ±6% minimum-alpha seam slicing for `grid_3x2`, plus `single` layout handling.
- [ ] **Step 3:** Implement median-height normalization (`POSE_HEIGHT_RATIOS`), ground baseline pinning (`y = 88%`), `1152×768` output, `256×256` upper-45% portrait extraction, and healthy-cell fallback cloning.
- [ ] **Step 4:** Export from `src/sugent/index.ts`.

---

### Task 2: Extend Avatar Schema, Studio Service & Asset Routes

**Files:**
- Modify: `src/sugent/avatar-rig.ts:20-38`
- Modify: `src/sugent/avatar-studio.ts`
- Modify: `src/web/server.ts:639-646`
- Modify: `src/agent/settings.ts:8-10`

**Interfaces:**
- `AvatarPackManifest`: adds `schemaVersion?: "visor_v1" | "pose_sheet_v2"`, `poseSheetUrl?: string`, `portraitUrl?: string`, `poseMeta?: PoseSheetRigMetadata`, `accentColor?: string`.
- `buildPoseSheetGenerationPrompt(stylePrompt: string): string`
- `callGeminiImageModel(endpoint, referencePng: Buffer | null, prompt, fetchImpl, opts?: { aspectRatio?: "1:1" | "3:2" })`
- `SugentAvatarStudio`: `mannequinUrl`, `generateFromBlank(..., { legacyVisor?: boolean })`, `importFromImage(..., { layout?: PoseSheetLayoutMode })`, `resolveAssetFile(id, kind: "sprite" | "source" | "blank" | "poses" | "portrait" | "mannequin")`.

- [ ] **Step 1:** Extend `AvatarPackManifest` in `src/sugent/avatar-rig.ts` and `BOT_AVATARS` in `src/agent/settings.ts`.
- [ ] **Step 2:** Update `BUILTIN_AVATAR_PACKS`, `buildPoseSheetGenerationPrompt`, `callGeminiImageModel`, and `SugentAvatarStudio` in `src/sugent/avatar-studio.ts`.
- [ ] **Step 3:** Expose `"poses" | "portrait" | "mannequin"` in `src/web/server.ts`.

---

### Task 3: Live Gemini Official Assets & Cross-Style Verification

**Files:**
- Create: `scripts/generate-v2-mannequin-assets.mjs`
- Create: `ui/design/bots/mannequin-pose-sheet-v2.png`
- Create: `ui/design/bots/clay-atelier-poses.png` & `clay-atelier-portrait.png`
- Create: `ui/design/bots/sugent-core-v2-poses.png` & `sugent-core-v2-portrait.png`

- [ ] **Step 1:** Run `npm run typecheck && npm run build`.
- [ ] **Step 2:** Execute `node scripts/generate-v2-mannequin-assets.mjs` against `.env` Gemini image model (`gemini-3.1-flash-image-preview`, `aspectRatio: "3:2"`).
- [ ] **Step 3:** Inspect raw sheets, cutouts, `poses.png` alignment, and `portrait.png` crops visually before proceeding to UI tasks.

---

### Task 4: Canvas 2D Physics & Micro-Motion Engine (`ui/components/companion-stage.js`)

**Files:**
- Create: `ui/components/companion-stage.js`

**Interfaces:**
- Produces `CompanionStage` component accepting `pack`, `state`, `cue`, `size`, `facing`, `dragging`, `dragVx`, `dropOver`, `coolingRemainingMs`, `onAction`.

- [ ] **Step 1:** Implement 2px continuous horizontal strip sampler with anatomical band weighting (Head `0–44%`, Torso `44–74%`, Legs `74–100%` pinned at `y = 88%`).
- [ ] **Step 2:** Implement `260ms` 3-phase transition (`0–70ms` squash, `70–160ms` lift/swap, `160–260ms` damped settle) + drag pendulum (`±22°`) + `10s` idle/hidden-tab power throttling + `prefers-reduced-motion`.
- [ ] **Step 3:** Draw sculptural ambient FX (contact shadow, working pad glow, 3 slow thinking dots, countdown arc) with zero cartoon bubbles.

---

### Task 5: Electron Companion Window (`156×168`, 48px Edge Docking, Workspace Facing)

**Files:**
- Modify: `electron/sugent-companion.ts`, `electron/companion-preload.cjs`
- Modify: `ui/companion.js`, `ui/css/companion.css`

- [ ] **Step 1:** Resize compact bounds to `156×168` (`430×350` max expanded), add `48px` edge snap, persist `dockEdge`, sync `{ dockEdge, facing, dragging }` via `companion:context` IPC, and expand inward away from docked edge.
- [ ] **Step 2:** Wire `CompanionStage` into `ui/companion.js` passing drag velocity, dropzone hover, and double-click quick-bar/pose toggle.

---

### Task 6: Dual-Scale Avatar Renderer & Consolidated Studio v2 UI

**Files:**
- Modify: `ui/components/avatar.js`, `ui/design/components/avatar.css`
- Modify: `ui/components/avatar-studio.js`, `ui/css/sugent.css`
- Modify: `ui/locales/{zh-CN,en}/{steward,avatar}.js`

- [ ] **Step 1:** Dispatch `pose_sheet_v2` packs in `BotAvatar`: `size <= 48` renders crisp `portraitUrl` + hairline status ring; `size > 48` renders interactive `CompanionStage`.
- [ ] **Step 2:** Rebuild `AvatarStudioScreen` around the live 6-pose physics playground, 4 cross-style presets (陶白雕塑 / 博朗钛银机师 / 风衣柴犬管家 / 复古像素学徒), dual-mode local import (`grid_3x2` / `single`), and accent color + motion tuning (hiding visor eyes for `pose_sheet_v2`).
- [ ] **Step 3:** Update both `zh-CN` and `en` dictionaries identically and verify zero hardcoded colors/spacing/CJK.

---

### Task 7: Unit Tests, Contract Verification & Full Green Gates

**Files:**
- Modify: `test/sugent-avatar-studio.unit.test.ts`
- Modify: `scripts/verify-sugent.mjs`

- [ ] **Step 1:** Add `rigPoseSheetImageBuffer` tests (`grid_3x2` 6-pose slicing + `y = 88%` baseline + portrait crop + white porcelain preservation + `single` offline fallback + accidental grid-line suppression) and HTTP `/asset?kind=poses|portrait|mannequin` tests.
- [ ] **Step 2:** Add offline `pose_sheet_v2` verification to `scripts/verify-sugent.mjs`.
- [ ] **Step 3:** Run `npm run typecheck`, `npm run test:sugent`, `npx vitest run test/design-system.unit.test.ts test/i18n.unit.test.ts test/phase3.unit.test.ts test/sugent-avatar-studio.unit.test.ts`, and `npm run verify:sugent`. Confirm 100% pass.
