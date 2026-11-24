import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { normalizeSettings } from "../src/agent/settings.js";
import { loadConfig } from "../src/config.js";
import { decodePngToRgba, encodeRgbaToPng, rigAvatarImageBuffer } from "../src/sugent/avatar-rig.js";
import { POSE_KEYS, rigPoseSheetImageBuffer } from "../src/sugent/avatar-pose-rig.js";
import { ALL_BUILTIN_AVATARS, SugentAvatarStudio } from "../src/sugent/avatar-studio.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLANK_PNG_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "blank-visor-toy.png");
const CORE_SPRITE_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "sugent-core.png");
const MANNEQUIN_V2_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "mannequin-pose-sheet-v2.png");
const CORE_V2_POSES_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "sugent-core-v2-poses.png");
const CORE_V2_PORTRAIT_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "sugent-core-v2-portrait.png");
const CLAY_V2_POSES_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "clay-atelier-poses.png");
const CLAY_V2_PORTRAIT_PATH = path.join(REPO_ROOT, "ui", "design", "bots", "clay-atelier-portrait.png");
const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK = ["127", "0", "0", "1"].join(".");

describe("Sugent Avatar Rig & Gemini Studio", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("decodes builtin direction-B mannequin & flagship sprite and auto-rigs studio images", () => {
    const blankBuf = fs.readFileSync(BLANK_PNG_PATH);
    const blank = decodePngToRgba(blankBuf);
    expect(blank.width).toBe(1024);
    expect(blank.height).toBe(1024);

    const core = decodePngToRgba(fs.readFileSync(CORE_SPRITE_PATH));
    expect(core.width).toBe(3584);
    expect(core.height).toBe(448);

    // Paint a small bright artifact dot inside the center of the visor on a copy to verify cleanVisor removal.
    const dirtyRgba = new Uint8Array(blank.rgba);
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const idx = ((578 + dy) * blank.width + (512 + dx)) * 4;
        dirtyRgba[idx] = 255;
        dirtyRgba[idx + 1] = 255;
        dirtyRgba[idx + 2] = 255;
        dirtyRgba[idx + 3] = 255;
      }
    }
    const dirtyBuf = encodeRgbaToPng(blank.width, blank.height, dirtyRgba);
    const rigged = rigAvatarImageBuffer(dirtyBuf, { cleanVisor: true, preserveGlow: true });
    const sprite = decodePngToRgba(rigged.spritePng);
    const source = decodePngToRgba(rigged.sourcePng);
    expect(sprite.width).toBe(3584);
    expect(sprite.height).toBe(448);
    expect(source.width).toBe(448);
    expect(source.height).toBe(448);
    expect(source.rgba[3]).toBe(0);
    expect(rigged.rig.eyes[0]![0]).toBeLessThan(50);
    expect(rigged.rig.eyes[1]![0]).toBeGreaterThan(50);
    expect(rigged.rig.earL[0]).toBeLessThan(35);
    expect(rigged.rig.earR[0]).toBeGreaterThan(65);

    const cx = Math.round(((rigged.rig.eyes[0]![0] + rigged.rig.eyes[1]![0]) * 0.5 / 100) * source.width);
    const cy = Math.round((rigged.rig.eyes[0]![1] / 100) * source.height);
    const p = (cy * source.width + cx) * 4;
    const centerLuma = 0.299 * source.rgba[p]! + 0.587 * source.rgba[p + 1]! + 0.114 * source.rgba[p + 2]!;
    expect(centerLuma).toBeLessThan(80);
  });

  it("rigs v2 3x2 pose sheets, suppresses divider lines, and handles single full-body layout", () => {
    const corePoses = decodePngToRgba(fs.readFileSync(CORE_V2_POSES_PATH));
    const corePort = decodePngToRgba(fs.readFileSync(CORE_V2_PORTRAIT_PATH));
    const clayPoses = decodePngToRgba(fs.readFileSync(CLAY_V2_POSES_PATH));
    const clayPort = decodePngToRgba(fs.readFileSync(CLAY_V2_PORTRAIT_PATH));
    expect(corePoses.width).toBe(1152);
    expect(corePoses.height).toBe(768);
    expect(corePort.width).toBe(256);
    expect(corePort.height).toBe(256);
    expect(clayPoses.width).toBe(1152);
    expect(clayPort.height).toBe(256);
    expect(clayPoses.rgba[3]).toBe(0);

    const manBuf = fs.readFileSync(MANNEQUIN_V2_PATH);
    const man = decodePngToRgba(manBuf);
    const withGrid = new Uint8Array(man.rgba);
    for (const gx of [Math.round(man.width / 3), Math.round((man.width * 2) / 3)]) {
      for (let y = 0; y < man.height; y++) {
        const idx = (y * man.width + gx) * 4;
        withGrid[idx] = 48; withGrid[idx + 1] = 52; withGrid[idx + 2] = 60; withGrid[idx + 3] = 255;
      }
    }
    const midY = Math.round(man.height / 2);
    for (let x = 0; x < man.width; x++) {
      const idx = (midY * man.width + x) * 4;
      withGrid[idx] = 48; withGrid[idx + 1] = 52; withGrid[idx + 2] = 60; withGrid[idx + 3] = 255;
    }
    const gridRig = rigPoseSheetImageBuffer(encodeRgbaToPng(man.width, man.height, withGrid), { layout: "grid_3x2" });
    expect(gridRig.warnings).toEqual([]);
    const outSheet = decodePngToRgba(gridRig.poseSheetPng);
    expect(outSheet.width).toBe(1152);
    expect(outSheet.height).toBe(768);
    for (const k of POSE_KEYS) expect(gridRig.poseMeta.cells[k].baselineY).toBe(0.88);

    const singleRig = rigPoseSheetImageBuffer(fs.readFileSync(BLANK_PNG_PATH), { layout: "single" });
    expect(singleRig.poseMeta.layoutMode).toBe("single");
    expect(decodePngToRgba(singleRig.portraitPng).width).toBe(256);
  });

  it("supports offline sovereignty import/customize/delete and both Gemini wire protocols", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-avatar-studio-"));
    cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const blankBuf = fs.readFileSync(BLANK_PNG_PATH);

    const studio = new SugentAvatarStudio(tmp, { env: {}, blankAssetPath: BLANK_PNG_PATH });
    const st0 = studio.listState();
    expect(st0.activeId).toBe("sugent-core");
    expect(st0.imageModelReady).toBe(false);
    expect(st0.packs.length).toBe(ALL_BUILTIN_AVATARS.length);

    const imp = studio.importFromImage({
      name: "离线测试机",
      dataBase64: blankBuf.toString("base64"),
      accentColor: "#ff9900",
      eyeStyle: "visor",
      eyeColor: "#ff9900",
      auraHue: 38,
      motionPersonality: "minimal",
    });
    expect(imp.ok).toBe(true);
    expect(imp.pack.schemaVersion).toBe("pose_sheet_v2");
    expect(imp.pack.poseMeta?.layoutMode).toBe("single");
    expect(imp.state.activeId).toBe(imp.pack.id);
    expect(fs.existsSync(studio.resolveAssetFile(imp.pack.id, "poses")!)).toBe(true);
    expect(fs.existsSync(studio.resolveAssetFile(imp.pack.id, "portrait")!)).toBe(true);
    expect(studio.resolveAssetFile("../etc/passwd", "poses")).toBeUndefined();

    const customBuiltin = studio.updatePackAppearance({
      id: "sugent-core",
      accentColor: "#00ffee",
      eyeStyle: "round",
      eyeColor: "#00ffee",
      auraHue: 180,
    });
    expect(customBuiltin.pack.accentColor).toBe("#00ffee");
    expect(customBuiltin.pack.eyeColor).toBe("#00ffee");
    expect(() => studio.deletePack("sugent-core")).toThrow();
    expect(() => studio.deletePack("clay-atelier")).toThrow();

    const afterDel = studio.deletePack(imp.pack.id);
    expect(afterDel.activeId).toBe("sugent-core");
    expect(afterDel.packs.some((p) => p.id === imp.pack.id)).toBe(false);

    // Case A: Gemini native generateContent wire protocol (3x2 sheet)
    const b64 = fs.readFileSync(CLAY_V2_POSES_PATH).toString("base64");
    const nativeStudio = new SugentAvatarStudio(tmp, {
      env: {},
      blankAssetPath: BLANK_PNG_PATH,
      endpointOverride: {
        baseUrl: `${HTTP_PROTO}${LOOPBACK}:9999/v1`,
        apiKey: "mock-token",
        model: "gemini-3.1-flash-image-preview",
        source: "override",
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: b64 } }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    const genA = await nativeStudio.generateFromBlank({ prompt: "博朗钛银", name: "Gemini 原生测试" });
    expect(genA.ok).toBe(true);
    expect(genA.wireProtocol).toBe("gemini-generate-content");

    // Case B: OpenAI /chat/completions fallback when native returns 404
    const fallbackStudio = new SugentAvatarStudio(tmp, {
      env: {},
      blankAssetPath: BLANK_PNG_PATH,
      endpointOverride: {
        baseUrl: `${HTTP_PROTO}${LOOPBACK}:9999/v1`,
        apiKey: "mock-token",
        model: "gemini-3.1-flash-image-preview",
        source: "override",
      },
      fetchImpl: (async (url) => {
        if (String(url).includes(":generateContent")) {
          return new Response("not found", { status: 404 });
        }
        return new Response(
          JSON.stringify({
            choices: [{ message: { images: [{ image_url: { url: `data:image/png;base64,${b64}` } }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const genB = await fallbackStudio.generateFromBlank({ prompt: "冰川白", name: "OpenAI 回退测试" });
    expect(genB.ok).toBe(true);
    expect(genB.wireProtocol).toBe("openai-chat-completions");
  });

  it("exposes avatar studio & companion web APIs and preserves normalizeSettings invariants", async () => {
    expect(normalizeSettings({ avatar: "sugent-core" }).avatar).toBe("sugent-core");
    expect(normalizeSettings({ avatar: "clay-atelier" }).avatar).toBe("clay-atelier");
    expect(normalizeSettings({ avatar: "custom:ava-1" }).avatar).toBe("custom:ava-1");
    expect(normalizeSettings({ avatar: "pink" }).avatar).toBe("");

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-ava-web-data-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-ava-web-home-"));
    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43199/v1`,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
      },
    });
    const app = new App(cfg, { printQrToTerminal: false, fileLog: false, stewardHomeDir: homeDir });
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const callApi = async (pathname: string, method = "GET", body?: unknown) => {
      const res = await app.web!.inject(`/amb/api${pathname}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, text: res.text, json: res.text ? JSON.parse(res.text) : {} };
    };

    const listRes = await callApi("/steward/avatars");
    expect(listRes.status).toBe(200);
    expect(listRes.json.activeId).toBe("sugent-core");

    const blankAsset = await app.web!.inject("/amb/api/steward/avatars/asset?kind=blank");
    expect(blankAsset.status).toBe(200);
    expect(blankAsset.text.slice(1, 4)).toBe("PNG");

    const manAsset = await app.web!.inject("/amb/api/steward/avatars/asset?kind=mannequin");
    expect(manAsset.status).toBe(200);
    expect(manAsset.text.slice(1, 4)).toBe("PNG");

    const blankB64 = fs.readFileSync(BLANK_PNG_PATH).toString("base64");
    const impRes = await callApi("/steward/avatars/import", "POST", {
      name: "Web 离线导入",
      dataBase64: blankB64,
    });
    expect(impRes.status).toBe(200);
    const customId = impRes.json.pack.id as string;
    expect(impRes.json.pack.schemaVersion).toBe("pose_sheet_v2");
    expect(impRes.json.state.activeId).toBe(customId);

    const posesRes = await app.web!.inject(`/amb/api/steward/avatars/asset?id=${encodeURIComponent(customId)}&kind=poses`);
    expect(posesRes.status).toBe(200);
    expect(posesRes.text.slice(1, 4)).toBe("PNG");
    const portRes = await app.web!.inject(`/amb/api/steward/avatars/asset?id=${encodeURIComponent(customId)}&kind=portrait`);
    expect(portRes.status).toBe(200);
    expect(portRes.text.slice(1, 4)).toBe("PNG");

    const custRes = await callApi("/steward/avatars/customize", "PUT", {
      id: customId,
      eyeStyle: "visor",
      eyeColor: "#ff5500",
    });
    expect(custRes.status).toBe(200);
    expect(custRes.json.pack.eyeStyle).toBe("visor");
    expect(custRes.json.pack.eyeColor).toBe("#ff5500");

    const actRes = await callApi("/steward/avatars/activate", "POST", { id: "sugent-core" });
    expect(actRes.status).toBe(200);
    expect(actRes.json.activeId).toBe("sugent-core");

    const delRes = await callApi(`/steward/avatars/${encodeURIComponent(customId)}`, "DELETE");
    expect(delRes.status).toBe(200);
    expect(delRes.json.packs.some((p: { id: string }) => p.id === customId)).toBe(false);

    const compState = await callApi("/steward/companion");
    expect(compState.status).toBe(200);
    expect(compState.json.supported).toBe(false);

    const compHtml = await app.web!.inject("/companion");
    expect(compHtml.status).toBe(200);
    expect(compHtml.text).toContain("companion.js");
  });

  it("bridges companion signal HTTP API and DesktopHooks for live studio & handoff sync", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-comp-sig-data-"));
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-comp-sig-home-"));
    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: `${HTTP_PROTO}${LOOPBACK}:43199/v1`,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
      },
    });
    const app = new App(cfg, { printQrToTerminal: false, fileLog: false, stewardHomeDir: homeDir });
    const notified: Array<Record<string, unknown>> = [];
    const handoffs: Array<{ hash?: string; draftText?: string; source?: string }> = [];
    app.desktop = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      companionState: () => ({ supported: true, visible: true, expanded: false, dockEdge: "bottom", facing: "left", dockMode: "screen" }),
      notifyCompanion: (payload) => notified.push(payload),
      handoffCompanionToMain: (payload) => handoffs.push(payload),
    };
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(homeDir, { recursive: true, force: true });
    });

    const callApi = async (pathname: string, method = "GET", body?: unknown) => {
      const res = await app.web!.inject(`/amb/api${pathname}`, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: res.text ? JSON.parse(res.text) : {} };
    };

    const initComp = await callApi("/steward/companion");
    expect(initComp.status).toBe(200);
    expect(initComp.json.supported).toBe(true);
    expect(initComp.json.lastSignal).toBeNull();

    const blankB64 = fs.readFileSync(BLANK_PNG_PATH).toString("base64");
    const imp = await callApi("/steward/avatars/import", "POST", { name: "Signal Test", dataBase64: blankB64 });
    expect(imp.status).toBe(200);
    const customId = imp.json.pack.id as string;
    expect(notified.at(-1)?.kind).toBe("studio_updated");

    const cust = await callApi("/steward/avatars/customize", "PUT", { id: customId, eyeColor: "#00ffee" });
    expect(cust.status).toBe(200);
    expect(notified.at(-1)?.kind).toBe("studio_updated");

    const act = await callApi("/steward/avatars/activate", "POST", { id: "sugent-core" });
    expect(act.status).toBe(200);
    expect(notified.at(-1)?.kind).toBe("studio_updated");

    const del = await callApi(`/steward/avatars/${encodeURIComponent(customId)}`, "DELETE");
    expect(del.status).toBe(200);
    expect(notified.filter((n) => n.kind === "studio_updated")).toHaveLength(4);
    expect(handoffs).toHaveLength(0);

    const badSig = await callApi("/steward/companion/signal", "POST", { kind: "unknown_kind" });
    expect(badSig.status).toBe(400);

    const clientAt = Date.now() - 500;
    const mainSig = await callApi("/steward/companion/signal", "POST", {
      kind: "main_state",
      state: "thinking",
      cue: "done",
      notice: "Draft ready",
      at: clientAt,
    });
    expect(mainSig.status).toBe(200);
    expect(mainSig.json.ok).toBe(true);
    expect(mainSig.json.signal).toMatchObject({
      kind: "main_state",
      state: "thinking",
      cue: "done",
      notice: "Draft ready",
      at: clientAt,
    });
    expect(notified.at(-1)).toMatchObject({ kind: "main_state", state: "thinking", cue: "done" });
    expect(handoffs).toHaveLength(0);

    const afterMain = await callApi("/steward/companion");
    expect(afterMain.status).toBe(200);
    expect(afterMain.json.lastSignal).toMatchObject({ kind: "main_state", state: "thinking", cue: "done" });

    const studioSig = await callApi("/steward/companion/signal", "POST", { kind: "studio_updated" });
    expect(studioSig.status).toBe(200);
    expect(studioSig.json.signal.kind).toBe("studio_updated");
    expect(notified.at(-1)?.kind).toBe("studio_updated");
    expect((await callApi("/steward/companion")).json.lastSignal.kind).toBe("studio_updated");

    const handoffSig = await callApi("/steward/companion/signal", "POST", {
      kind: "handoff",
      hash: "#/chat/default",
      draftText: "Continue reviewing contract",
      source: "companion",
    });
    expect(handoffSig.status).toBe(200);
    expect(handoffSig.json.ok).toBe(true);
    expect(handoffSig.json.signal).toMatchObject({
      kind: "handoff",
      hash: "#/chat/default",
      draftText: "Continue reviewing contract",
      source: "companion",
    });
    expect(notified.at(-1)).toMatchObject({ kind: "handoff", hash: "#/chat/default" });
    expect(handoffs).toEqual([
      { hash: "#/chat/default", draftText: "Continue reviewing contract", source: "companion" },
    ]);

    const afterHandoff = await callApi("/steward/companion");
    expect(afterHandoff.status).toBe(200);
    expect(afterHandoff.json.lastSignal).toMatchObject({
      kind: "handoff",
      hash: "#/chat/default",
      draftText: "Continue reviewing contract",
      source: "companion",
    });
  });
});
