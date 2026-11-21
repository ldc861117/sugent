#!/usr/bin/env node
/**
 * 端到端实时验证：素体白模 -> Gemini 图像模型定制生成 -> 纯 Node 自动抠图/护目镜标定/8 格拆层
 * 严禁打印任何 API Key；输出文件写入 --out 指定目录（默认为对话 scratch 目录）。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildVisorToyGenerationPrompt,
  callGeminiImageModel,
  decodePngToRgba,
  encodeRgbaToPng,
  resolveGeminiImageEndpoint,
  rigAvatarImageBuffer,
} from "../dist/src/sugent/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function drawPreviewCard(sourcePngBuf, rig) {
  const { width: sz, rgba } = decodePngToRgba(sourcePngBuf);
  const outW = sz * 2, outH = sz;
  const card = new Uint8Array(outW * outH * 4);
  for (let side = 0; side < 2; side++) {
    const bg = side === 0 ? [244, 245, 247] : [20, 22, 26];
    const xOff = side * sz;
    for (let y = 0; y < sz; y++) for (let x = 0; x < sz; x++) {
      const si = (y * sz + x) * 4, di = (y * outW + xOff + x) * 4;
      const a = rgba[si + 3] / 255;
      card[di] = Math.round(bg[0] * (1 - a) + rgba[si] * a);
      card[di + 1] = Math.round(bg[1] * (1 - a) + rgba[si + 1] * a);
      card[di + 2] = Math.round(bg[2] * (1 - a) + rgba[si + 2] * a);
      card[di + 3] = 255;
    }
    for (const [exPct, eyPct] of rig.eyes) {
      const ex = (exPct / 100) * sz, ey = (eyPct / 100) * sz;
      const rx = (rig.r * 0.68 / 100) * sz, ry = (rig.r * 1.15 / 100) * sz;
      for (let y = Math.max(0, Math.floor(ey - ry - 2)); y < Math.min(sz, Math.ceil(ey + ry + 2)); y++) {
        for (let x = Math.max(0, Math.floor(ex - rx - 2)); x < Math.min(sz, Math.ceil(ex + rx + 2)); x++) {
          const qx = Math.abs(x - ex) - rx + rx * 0.85, qy = Math.abs(y - ey) - ry + rx * 0.85;
          const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rx * 0.85;
          if (d <= 0.8) {
            const di = (y * outW + xOff + x) * 4;
            const cov = d <= -0.8 ? 1 : (0.8 - d) / 1.6;
            card[di] = Math.round(card[di] * (1 - cov) + 215 * cov);
            card[di + 1] = Math.round(card[di + 1] * (1 - cov) + 255 * cov);
            card[di + 2] = Math.round(card[di + 2] * (1 - cov) + 0 * cov);
          }
        }
      }
    }
  }
  return encodeRgbaToPng(outW, outH, card);
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outDir = outIdx >= 0 && args[outIdx + 1]
    ? path.resolve(args[outIdx + 1])
    : "/Users/lvdongchen/.gemini/antigravity/brain/7f401dc8-5135-46a0-8be6-3a23416c5517/scratch/avatar-verify";
  const stylePrompt = args.find((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1))
    || "博朗风格哑光阳极氧化银铝外壳，极简金属圆耳，顶部微距琥珀指示球，纯黑空护目镜面罩";

  const env = { ...process.env, ...loadDotEnv(path.join(ROOT, ".env")) };
  const ep = resolveGeminiImageEndpoint({ env });
  if (!ep) throw new Error("No Gemini image endpoint resolved from .env or environment");

  const blankPath = path.join(ROOT, "ui", "design", "bots", "blank-visor-toy.png");
  const blankPng = fs.readFileSync(blankPath);
  const blankMeta = decodePngToRgba(blankPng);
  assert.equal(blankMeta.width, 1024);
  assert.equal(blankMeta.height, 1024);

  console.log(`[avatar-verify] endpoint=${ep.baseUrl} model=${ep.model} source=${ep.source}`);
  const prompt = buildVisorToyGenerationPrompt(stylePrompt);
  const { imageBuffer, wireProtocol } = await callGeminiImageModel(ep, blankPng, prompt);
  const rigged = rigAvatarImageBuffer(imageBuffer, { cleanVisor: true, preserveGlow: true });
  const spriteMeta = decodePngToRgba(rigged.spritePng);

  assert.ok(rigged.foregroundCoverage > 0.12, `foregroundCoverage too low: ${rigged.foregroundCoverage}`);
  assert.equal(spriteMeta.width, 3584);
  assert.equal(spriteMeta.height, 448);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "blank.png"), blankPng);
  fs.writeFileSync(path.join(outDir, "gemini-raw.png"), imageBuffer);
  fs.writeFileSync(path.join(outDir, "source-cutout.png"), rigged.sourcePng);
  fs.writeFileSync(path.join(outDir, "rigged-sprite.png"), rigged.spritePng);
  fs.writeFileSync(path.join(outDir, "preview-composited.png"), drawPreviewCard(rigged.sourcePng, rigged.rig));

  console.log(JSON.stringify({
    ok: true,
    wireProtocol,
    model: ep.model,
    foregroundCoverage: rigged.foregroundCoverage,
    visorCoverage: rigged.visorCoverage,
    hasGlow: rigged.hasGlow,
    rig: rigged.rig,
    warnings: rigged.warnings,
    outDir,
  }, null, 2));
}

main().catch((err) => {
  console.error("[avatar-verify] FAILED:", err.message);
  process.exit(1);
});
