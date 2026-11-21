#!/usr/bin/env node
/**
 * 方向 B「面罩小搭档 (Modular Visor Toy)」素体白模与默认旗舰皮肤生成器
 * 零外部依赖（纯 Node node:zlib + SDF 软光栅超采样），输出：
 *   1. ui/design/bots/blank-visor-toy.png (1024x1024 纯净棚拍白模参考图，供 Gemini 图像模型二次创作)
 *   2. ui/design/bots/sugent-core.png    (3584x448 八格可动精灵图，Sugent 默认钛黑青柠旗舰形象)
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CANONICAL_VISOR_RIG_V1 = Object.freeze({
  eyes: [
    [41.75, 56.5],
    [58.25, 56.5],
  ],
  r: 4.2,
  earL: [25.5, 57.0],
  earR: [74.5, 57.0],
  top: [50.0, 32.0],
  tip: [50.0, 19.0],
});

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
export function encodePngRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * clamp(t);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
function sdBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdCapsule(px, py, ax, ay, bx, by, r) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

function shadeShell(nx, ny, d, pal) {
  const light = clamp(0.62 - nx * 0.36 - (ny - 0.06) * 0.48);
  const topRim = (1.0 - smoothstep(-0.042, -0.004, d)) * clamp(0.45 - ny * 0.72 - nx * 0.25);
  const edgeShade = smoothstep(-0.11, -0.002, d);
  let r = mix(pal.shadow[0], pal.base[0], light);
  let g = mix(pal.shadow[1], pal.base[1], light);
  let b = mix(pal.shadow[2], pal.base[2], light);
  const spec = Math.pow(clamp(1.0 - Math.hypot(nx + 0.16, ny + 0.18) * 1.45), 2.8);
  r = r * (1 - edgeShade * 0.14) + topRim * pal.rim[0] * 0.42 + spec * pal.spec[0] * 0.22;
  g = g * (1 - edgeShade * 0.14) + topRim * pal.rim[1] * 0.42 + spec * pal.spec[1] * 0.22;
  b = b * (1 - edgeShade * 0.14) + topRim * pal.rim[2] * 0.42 + spec * pal.spec[2] * 0.22;
  return [r, g, b];
}

function evalLayerPixel(nx, ny, aa, layerIdx, pal) {
  const dHead = sdBox(nx, ny - 0.11, 0.50, 0.48, 0.25);
  const dEarL = Math.min(
    sdBox(nx + 0.555, ny - 0.14, 0.125, 0.195, 0.115),
    sdBox(nx + 0.445, ny - 0.14, 0.085, 0.115, 0.045),
  );
  const dEarR = Math.min(
    sdBox(nx - 0.555, ny - 0.14, 0.125, 0.195, 0.115),
    sdBox(nx - 0.445, ny - 0.14, 0.085, 0.115, 0.045),
  );
  const dStem = sdCapsule(nx, ny, 0, -0.27, 0, -0.58, 0.048);
  const dPod = Math.hypot(nx, ny + 0.62) - 0.132;
  const dTop = Math.min(dStem, dPod);
  const dVisor = sdBox(nx, ny - 0.13, 0.355, 0.195, 0.165);
  const dBezel = Math.abs(dVisor - 0.014);

  const cov = (d) => 1.0 - smoothstep(-aa, aa, d);
  const gradT = clamp((nx + ny + 1.1) / 2.2);
  const glowCol = [mix(215, 0, gradT), mix(255, 245, gradT), mix(0, 160, gradT)];

  if (layerIdx === 0) {
    const a = cov(dHead);
    if (a <= 0.001) return [0, 0, 0, 0];
    let [r, g, b] = shadeShell(nx, ny, dHead, pal);
    const bezelCov = 1.0 - smoothstep(0.0, 0.018 + aa, dBezel);
    r = mix(r, pal.bezel[0], bezelCov);
    g = mix(g, pal.bezel[1], bezelCov);
    b = mix(b, pal.bezel[2], bezelCov);
    const visorCov = cov(dVisor);
    if (visorCov > 0.001) {
      const vg = clamp(0.65 - nx * 0.4 - (ny - 0.05) * 0.7);
      let vr = mix(8, 24, vg), vgr = mix(10, 30, vg), vb = mix(11, 26, vg);
      const sheen = smoothstep(0.08, -0.08, nx * 0.65 + (ny - 0.01) * 1.1) * 0.12;
      vr += sheen * 210; vgr += sheen * 225; vb += sheen * 230;
      r = mix(r, vr, visorCov); g = mix(g, vgr, visorCov); b = mix(b, vb, visorCov);
    }
    return [r, g, b, a];
  }
  if (layerIdx === 1 || layerIdx === 2) {
    const d = layerIdx === 1 ? dEarL : dEarR;
    const a = cov(d);
    if (a <= 0.001) return [0, 0, 0, 0];
    let [r, g, b] = shadeShell(nx, ny, d, pal.ear ?? pal);
    const groove = 1.0 - smoothstep(0.0, 0.016 + aa, Math.abs(sdBox((layerIdx === 1 ? nx + 0.565 : nx - 0.565), ny - 0.14, 0.068, 0.125, 0.06)));
    return [r - groove * 16, g - groove * 16, b - groove * 14, a];
  }
  if (layerIdx === 3) {
    const a = cov(dTop);
    if (a <= 0.001) return [0, 0, 0, 0];
    const [r, g, b] = shadeShell(nx, ny + 0.58, dTop, pal.top ?? pal);
    const ring = 1.0 - smoothstep(0.0, 0.014 + aa, Math.abs(dPod + 0.048));
    return [mix(r, pal.bezel[0], ring * 0.75), mix(g, pal.bezel[1], ring * 0.75), mix(b, pal.bezel[2], ring * 0.75), a];
  }
  if (!pal.hasGlow) return [0, 0, 0, 0];
  if (layerIdx === 4) {
    const mask = (1.0 - smoothstep(0.0, 0.013 + aa, Math.abs(dVisor - 0.016))) * 0.85;
    return mask > 0.01 ? [glowCol[0], glowCol[1], glowCol[2], mask] : [0, 0, 0, 0];
  }
  if (layerIdx === 5 || layerIdx === 6) {
    const cx = layerIdx === 5 ? nx + 0.565 : nx - 0.565;
    const dArc = Math.abs(sdBox(cx, ny - 0.14, 0.068, 0.125, 0.06));
    const mask = (1.0 - smoothstep(0.0, 0.016 + aa, dArc)) * cov(layerIdx === 5 ? dEarL : dEarR);
    return mask > 0.01 ? [glowCol[0], glowCol[1], glowCol[2], mask * 0.95] : [0, 0, 0, 0];
  }
  const mask = (1.0 - smoothstep(0.0, 0.016 + aa, Math.abs(dPod + 0.048))) * cov(dPod);
  return mask > 0.01 ? [glowCol[0], glowCol[1], glowCol[2], mask] : [0, 0, 0, 0];
}

const PAL_BLANK = {
  base: [232, 235, 240], shadow: [186, 191, 200], rim: [255, 255, 255],
  spec: [255, 255, 255], bezel: [145, 151, 162], hasGlow: false,
  ear: { base: [222, 226, 233], shadow: [176, 182, 192], rim: [255, 255, 255], spec: [255, 255, 255] },
  top: { base: [226, 230, 236], shadow: [178, 184, 194], rim: [255, 255, 255], spec: [255, 255, 255] },
};

const PAL_CORE = {
  base: [46, 50, 56], shadow: [15, 17, 21], rim: [195, 230, 120],
  spec: [215, 230, 245], bezel: [64, 74, 70], hasGlow: true,
  ear: { base: [52, 57, 64], shadow: [20, 22, 27], rim: [215, 255, 95], spec: [215, 230, 245] },
  top: { base: [50, 55, 62], shadow: [18, 20, 25], rim: [215, 255, 80], spec: [225, 240, 250] },
};

export function renderBlankVisorToyPng(size = 1024) {
  const rgba = Buffer.alloc(size * size * 4);
  const aa = 2.2 / size;
  const bg = [244, 245, 247];
  for (let y = 0; y < size; y++) {
    const ny = ((y + 0.5) / size) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      let r = bg[0], g = bg[1], b = bg[2];
      // Compose layers in exact render order: earL(1), earR(2), top(3), head(0)
      for (const layerIdx of [1, 2, 3, 0]) {
        const [lr, lg, lb, la] = evalLayerPixel(nx, ny, aa, layerIdx, PAL_BLANK);
        if (la > 0) {
          r = mix(r, lr, la); g = mix(g, lg, la); b = mix(b, lb, la);
        }
      }
      const idx = (y * size + x) * 4;
      rgba[idx] = clamp(Math.round(r), 0, 255);
      rgba[idx + 1] = clamp(Math.round(g), 0, 255);
      rgba[idx + 2] = clamp(Math.round(b), 0, 255);
      rgba[idx + 3] = 255;
    }
  }
  return encodePngRgba(size, size, rgba);
}

export function renderSugentCoreSpritePng(cell = 448) {
  const width = cell * 8;
  const rgba = Buffer.alloc(width * cell * 4);
  const aa = 2.4 / cell;
  for (let layerIdx = 0; layerIdx < 8; layerIdx++) {
    const xOff = layerIdx * cell;
    for (let y = 0; y < cell; y++) {
      const ny = ((y + 0.5) / cell) * 2 - 1;
      for (let x = 0; x < cell; x++) {
        const nx = ((x + 0.5) / cell) * 2 - 1;
        const [lr, lg, lb, la] = evalLayerPixel(nx, ny, aa, layerIdx, PAL_CORE);
        const idx = (y * width + (xOff + x)) * 4;
        rgba[idx] = clamp(Math.round(lr), 0, 255);
        rgba[idx + 1] = clamp(Math.round(lg), 0, 255);
        rgba[idx + 2] = clamp(Math.round(lb), 0, 255);
        rgba[idx + 3] = clamp(Math.round(la * 255), 0, 255);
      }
    }
  }
  return encodePngRgba(width, cell, rgba);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntry) {
  const outDir = path.join(ROOT, "ui", "design", "bots");
  fs.mkdirSync(outDir, { recursive: true });
  const blankPath = path.join(outDir, "blank-visor-toy.png");
  const corePath = path.join(outDir, "sugent-core.png");
  fs.writeFileSync(blankPath, renderBlankVisorToyPng(1024));
  fs.writeFileSync(corePath, renderSugentCoreSpritePng(448));
  console.log(`Generated ${path.relative(ROOT, blankPath)} and ${path.relative(ROOT, corePath)}`);
}
