#!/usr/bin/env node
/**
 * 端到端实机生成与验证 v2 3×2 全身雕塑素体及跨风格资产。
 * 严禁打印任何 API Key；产物写入 ui/design/bots/ 及指定 scratch 检视目录。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildPoseSheetGenerationPrompt,
  callGeminiImageModel,
  decodePngToRgba,
  encodeRgbaToPng,
  resolveGeminiImageEndpoint,
  rigPoseSheetImageBuffer,
} from "../dist/src/sugent/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOTS_DIR = path.join(ROOT, "ui", "design", "bots");
const SCRATCH_DIR = process.env.AVATAR_V2_OUT || "/Users/lvdongchen/.gemini/antigravity/brain/7f401dc8-5135-46a0-8be6-3a23416c5517/scratch/avatar-v2-verify";

function loadDotEnv(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function renderPreviewCard(poseSheetPng, portraitPng) {
  const sheet = decodePngToRgba(poseSheetPng);
  const port = decodePngToRgba(portraitPng);
  const rows = Math.max(2, Math.round(sheet.height / (sheet.width / 3)));
  const w = sheet.width, h = sheet.height + port.height + 24;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const isDark = (Math.floor(x / (w / 3)) + Math.floor(y / (sheet.height / rows))) % 2 === 1;
    const bg = isDark ? [24, 27, 32] : [244, 245, 247];
    const p = (y * w + x) * 4;
    rgba[p] = bg[0]; rgba[p + 1] = bg[1]; rgba[p + 2] = bg[2]; rgba[p + 3] = 255;
  }
  const blit = (src, dx, dy) => {
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4, di = ((dy + y) * w + dx + x) * 4;
      const a = src.rgba[si + 3] / 255;
      rgba[di] = Math.round(rgba[di] * (1 - a) + src.rgba[si] * a);
      rgba[di + 1] = Math.round(rgba[di + 1] * (1 - a) + src.rgba[si + 1] * a);
      rgba[di + 2] = Math.round(rgba[di + 2] * (1 - a) + src.rgba[si + 2] * a);
    }
  };
  blit(sheet, 0, 0);
  const cellH = Math.round(sheet.height / rows);
  for (let r = 0; r < rows; r++) {
    const gy = Math.round(r * cellH + cellH * 0.88);
    for (let x = 0; x < w; x += 2) {
      const p = (gy * w + x) * 4;
      rgba[p] = 80; rgba[p + 1] = 200; rgba[p + 2] = 140;
    }
  }
  blit(port, 24, sheet.height + 12);
  return encodeRgbaToPng(w, h, rgba);
}

const MANNEQUIN_PROMPT = [
  "A clean 3-column by 3-row square character pose turn-sheet of a compact stylized 2.5-head-tall miniature designer collectible figurine sculpted in matte unglazed white bisque porcelain (Munny / Pop Mart / minimalist Japanese gallery designer toy proportions: large smooth sculptural head ~42% of total height, compact curved torso, clean seamless stylized arms/legs with only subtle hair-thin minimal shoulder/wrist creases, NO wooden art-dummy ball joints, NO hollow hip cuts, smooth serene sculpted face with gentle brow plane and subtle small sculpted nose ridge so 3D head direction is unmistakably readable, no cartoon mouth, NO antenna, NO ear-pods, NO black screen visor).",
  "Exactly 9 cohesive full-body poses cleanly arranged in 3 columns x 3 rows with generous empty margin around every figure, isolated cleanly on a pure solid flat uniform #7D8EA3 muted cool slate-grey studio backdrop:",
  "- Top row left-to-right (IDENTICAL symmetric forward-seated body on an invisible ledge with legs dangling straight forward and hands resting symmetrically beside hips — ONLY the 3D head yaw angle rotates!): (1) idle_left — symmetric front-facing seated body, head turned 35 degrees to the viewer's LEFT looking left; (2) idle — exact same symmetric front-facing seated body, head facing STRAIGHT FRONT (0 degrees) looking directly at viewer; (3) idle_right — exact same symmetric front-facing seated body, head turned 35 degrees to the viewer's RIGHT looking right.",
  "- Middle row left-to-right: (4) listening — poised attentive upright stance with head tilted warmly and one hand gently raised near chest/ear listening, (5) thinking — calm upright pose with one hand resting lightly under chin gazing slightly upward, (6) working — leaning forward gently holding and typing on a slim translucent mini glass pad with both hands.",
  "- Bottom row left-to-right: (7) waiting — standing upright facing viewer waving one hand warmly, (8) ack — cheerful responsive nod with both hands clasped warmly near chest, (9) sleep — seated low hugging knees comfortably with head resting peacefully on arms.",
  "CRITICAL RULES: Soft diffused studio product lighting, consistent chunky 2.5-head collectible figurine silhouette across all 9 poses, ZERO cast floor shadows, ZERO dividing grid lines, ZERO boxes or borders, ZERO text, ZERO numbers or labels, ZERO watermarks.",
].join("\n\n");

async function main() {
  const mergedEnv = { ...loadDotEnv(path.join(ROOT, ".env")), ...process.env };
  const ep = resolveGeminiImageEndpoint({ env: mergedEnv });
  if (!ep) throw new Error("未检测到图像模型配置，请检查 .env 中的网关或 API Key");
  fs.mkdirSync(BOTS_DIR, { recursive: true });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });

  const reuseMannequin = process.argv.includes("--reuse-mannequin");
  const builtinsOnly = process.argv.includes("--builtins-only");
  const mannequinPath = path.join(BOTS_DIR, "mannequin-pose-sheet-v2.png");
  let mannequinWire = "reused";
  let mannequinBuf;
  if (reuseMannequin && fs.existsSync(mannequinPath)) {
    mannequinBuf = fs.readFileSync(mannequinPath);
  } else {
    const gen0 = await callGeminiImageModel(ep, null, MANNEQUIN_PROMPT, fetch, { aspectRatio: "1:1" });
    const dec0 = await import("../dist/src/sugent/index.js").then((m) => m.decodeImageBufferToRgba(gen0.imageBuffer));
    mannequinBuf = encodeRgbaToPng(dec0.width, dec0.height, dec0.rgba);
    mannequinWire = gen0.wireProtocol;
    fs.writeFileSync(mannequinPath, mannequinBuf);
  }
  fs.writeFileSync(path.join(SCRATCH_DIR, "01-mannequin-raw.png"), mannequinBuf);
  const clayRig = rigPoseSheetImageBuffer(mannequinBuf, { layout: "grid_3x3" });
  fs.writeFileSync(path.join(BOTS_DIR, "clay-atelier-poses.png"), clayRig.poseSheetPng);
  fs.writeFileSync(path.join(BOTS_DIR, "clay-atelier-portrait.png"), clayRig.portraitPng);
  fs.writeFileSync(path.join(SCRATCH_DIR, "01-clay-preview.png"), renderPreviewCard(clayRig.poseSheetPng, clayRig.portraitPng));
  console.error("[v2-gen] completed 01-clay");

  const allTargets = [
    {
      id: "02-core",
      builtin: true,
      style: "Minimalist deep charcoal obsidian matte ceramic miniature designer collectible figurine (compact 2.5-head stylized toy silhouette), smooth continuous matte obsidian shell without mechanical ball joints, without antenna or ear-pods, understated hairline pale-lime subtle glowing collar ring and slim cuff seam, serene smooth dark obsidian sculpted face with TWO crisp small luminous pale-lime (#9FE870) circular dot eyes that clearly show the exact 3D head turn direction (turned left in top-left, centered front eye-contact in top-center, turned right in top-right); working pose holds a thin translucent glowing holographic slate; Teenage Engineering & contemporary ceramic art toy aesthetic.",
      posesOut: path.join(BOTS_DIR, "sugent-core-v2-poses.png"),
      portraitOut: path.join(BOTS_DIR, "sugent-core-v2-portrait.png"),
    },
    {
      id: "03-shiba",
      style: "Warm tactile matte vinyl designer toy of a polite Shiba Inu steward wearing a tailored light camel trench coat and dark walnut necktie, gentle friendly expression with dark button eyes and cream snout clearly showing left/front/right head turns in the top row; working pose holds a compact silver notebook typing diligently; cozy collectible figurine studio lighting.",
    },
  ];
  const targets = builtinsOnly ? allTargets.filter((t) => t.builtin) : allTargets;
  const metaOut = { clay: clayRig.poseMeta };
  const report = [{ id: "01-clay", model: ep.model, wireProtocol: mannequinWire, warnings: clayRig.warnings, sheetSize: clayRig.poseMeta.sheetSize }];
  for (const t of targets) {
    const { imageBuffer, wireProtocol } = await callGeminiImageModel(ep, mannequinBuf, buildPoseSheetGenerationPrompt(t.style), fetch, { aspectRatio: "1:1" });
    fs.writeFileSync(path.join(SCRATCH_DIR, `${t.id}-raw.png`), imageBuffer);
    const rig = rigPoseSheetImageBuffer(imageBuffer, { layout: "grid_3x3" });
    fs.writeFileSync(path.join(SCRATCH_DIR, `${t.id}-poses.png`), rig.poseSheetPng);
    fs.writeFileSync(path.join(SCRATCH_DIR, `${t.id}-portrait.png`), rig.portraitPng);
    fs.writeFileSync(path.join(SCRATCH_DIR, `${t.id}-preview.png`), renderPreviewCard(rig.poseSheetPng, rig.portraitPng));
    if (t.posesOut) fs.writeFileSync(t.posesOut, rig.poseSheetPng);
    if (t.portraitOut) fs.writeFileSync(t.portraitOut, rig.portraitPng);
    metaOut[t.id] = rig.poseMeta;
    console.error("[v2-gen] completed", t.id, "warnings=" + rig.warnings.length);
    report.push({ id: t.id, wireProtocol, warnings: rig.warnings, sheetSize: rig.poseMeta.sheetSize, eyeSpotsIdle: rig.poseMeta.cells.idle?.eyeSpots ?? null });
  }
  fs.writeFileSync(path.join(SCRATCH_DIR, "meta-report.json"), JSON.stringify(metaOut, null, 2));
  console.log(JSON.stringify({ ok: true, model: ep.model, scratchDir: SCRATCH_DIR, report }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
