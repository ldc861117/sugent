import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import type { PoseSheetRigMetadata } from "./avatar-pose-rig.js";

export type AvatarEyeStyle = "capsule" | "round" | "visor" | "minimal";
export type AvatarMotionPersonality = "calm" | "lively" | "minimal";

export interface AvatarRigGeometry {
  eyes: [[number, number], [number, number]];
  r: number;
  earL: [number, number];
  earR: [number, number];
  top: [number, number];
  tip: [number, number];
  lens?: [[number, number], [number, number], number];
}

export interface AvatarPackManifest {
  id: string;
  schemaVersion?: "visor_v1" | "pose_sheet_v2";
  name: string;
  about: string;
  kind: "builtin" | "custom";
  stylePrompt?: string;
  spriteUrl: string;
  sourceUrl?: string;
  poseSheetUrl?: string;
  portraitUrl?: string;
  poseMeta?: PoseSheetRigMetadata;
  accentColor?: string;
  hasGlow: boolean;
  eyeStyle: AvatarEyeStyle;
  eyeColor: string;
  glowColor: string;
  auraHue: number;
  motionPersonality: AvatarMotionPersonality;
  rig: AvatarRigGeometry;
  createdAt: number;
  updatedAt: number;
}

export interface RigOptions {
  targetCellSize?: number;
  cleanVisor?: boolean;
  preserveGlow?: boolean;
}

export interface RiggedAvatarResult {
  spritePng: Buffer;
  sourcePng: Buffer;
  rig: AvatarRigGeometry;
  hasGlow: boolean;
  foregroundCoverage: number;
  visorCoverage: number;
  warnings: string[];
}

export const CANONICAL_VISOR_RIG_V1: AvatarRigGeometry = {
  eyes: [
    [41.75, 56.5],
    [58.25, 56.5],
  ],
  r: 4.2,
  earL: [25.5, 57.0],
  earR: [74.5, 57.0],
  top: [50.0, 32.0],
  tip: [50.0, 19.0],
};

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodeRgbaToPng(width: number, height: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    const srcOff = y * width * 4;
    raw.set(rgba.subarray(srcOff, srcOff + width * 4), row + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePngToRgba(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 24 || sig.some((b, i) => buf[i] !== b)) throw new Error("Not a PNG buffer");
  let off = 8, width = 0, height = 0, depth = 0, ctype = 0, interlace = 0;
  const idats: Buffer[] = [];
  let plte: Buffer | undefined, trns: Buffer | undefined;
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const data = buf.subarray(off + 8, off + 8 + len);
    off += 12 + len;
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]!; ctype = data[9]!; interlace = data[12]!;
    } else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idats.push(data);
    else if (type === "IEND") break;
  }
  if (!width || !height || depth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG format: ${width}x${height} depth=${depth} interlace=${interlace}`);
  }
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : 1;
  const raw = zlib.inflateSync(Buffer.concat(idats));
  const stride = width * ch;
  const scan = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]!;
    const rOff = y * (stride + 1) + 1;
    const dOff = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rOff + x]!;
      const a = x >= ch ? scan[dOff + x - ch]! : 0;
      const b = y > 0 ? scan[dOff - stride + x]! : 0;
      const c = x >= ch && y > 0 ? scan[dOff - stride + x - ch]! : 0;
      scan[dOff + x] = (f === 0 ? cur : f === 1 ? cur + a : f === 2 ? cur + b : f === 3 ? cur + ((a + b) >> 1) : cur + paeth(a, b, c)) & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * ch, o = i * 4;
    if (ctype === 6) { rgba[o] = scan[p]!; rgba[o + 1] = scan[p + 1]!; rgba[o + 2] = scan[p + 2]!; rgba[o + 3] = scan[p + 3]!; }
    else if (ctype === 2) { rgba[o] = scan[p]!; rgba[o + 1] = scan[p + 1]!; rgba[o + 2] = scan[p + 2]!; rgba[o + 3] = 255; }
    else if (ctype === 4) { rgba[o] = rgba[o + 1] = rgba[o + 2] = scan[p]!; rgba[o + 3] = scan[p + 1]!; }
    else if (ctype === 3 && plte) {
      const idx = scan[p]!;
      rgba[o] = plte[idx * 3] ?? 0; rgba[o + 1] = plte[idx * 3 + 1] ?? 0; rgba[o + 2] = plte[idx * 3 + 2] ?? 0;
      rgba[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    } else { rgba[o] = rgba[o + 1] = rgba[o + 2] = scan[p]!; rgba[o + 3] = 255; }
  }
  return { width, height, rgba };
}

export function decodeImageBufferToRgba(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const isPng = buf.length >= 8 && buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
  if (isPng) return decodePngToRgba(buf);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-rig-decode-"));
  const inFile = path.join(tmpDir, "input.bin");
  const outPng = path.join(tmpDir, "out.png");
  try {
    fs.writeFileSync(inFile, buf);
    try {
      execFileSync("python3", ["-c", "import sys;from PIL import Image;Image.open(sys.argv[1]).convert('RGBA').save(sys.argv[2],'PNG')", inFile, outPng], { timeout: 15000, stdio: "pipe" });
    } catch {
      if (process.platform === "darwin") {
        execFileSync("sips", ["-s", "format", "png", inFile, "--out", outPng], { timeout: 15000, stdio: "pipe" });
      } else throw new Error("Unsupported non-PNG image format and Pillow unavailable");
    }
    return decodePngToRgba(fs.readFileSync(outPng));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function median3(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function removeStudioBackground(rgba: Uint8Array, w: number, h: number): { rgba: Uint8Array; alpha: Float32Array; coverage: number } {
  const n = w * h;
  const out = new Uint8Array(rgba);
  let transparentCount = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3]! < 230) transparentCount++;
  if (transparentCount > n * 0.18) {
    const alpha = new Float32Array(n);
    let fg = 0;
    for (let i = 0; i < n; i++) { alpha[i] = rgba[i * 4 + 3]! / 255; if (alpha[i]! > 0.15) fg++; }
    return { rgba: out, alpha, coverage: fg / n };
  }
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const sampleBand = Math.max(2, Math.min(8, Math.floor(Math.min(w, h) * 0.02)));
  for (const [cx, cy] of [[0, 0], [w - sampleBand, 0], [0, h - sampleBand], [w - sampleBand, h - sampleBand]] as const) {
    for (let dy = 0; dy < sampleBand; dy++) for (let dx = 0; dx < sampleBand; dx++) {
      const p = ((cy + dy) * w + (cx + dx)) * 4;
      rs.push(rgba[p]!); gs.push(rgba[p + 1]!); bs.push(rgba[p + 2]!);
    }
  }
  const bgR = median3(rs), bgG = median3(gs), bgB = median3(bs);
  const bg = new Uint8Array(n);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    luma[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
  }
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = Math.abs((luma[i + 1]! - luma[i - 1]!) * 2 + (luma[i - w + 1]! - luma[i - w - 1]!) + (luma[i + w + 1]! - luma[i + w - 1]!));
    const gy = Math.abs((luma[i + w]! - luma[i - w]!) * 2 + (luma[i + w - 1]! - luma[i - w - 1]!) + (luma[i + w + 1]! - luma[i - w + 1]!));
    grad[i] = Math.hypot(gx, gy) * 0.25;
  }
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  const push = (idx: number) => {
    if (bg[idx]) return;
    const p = idx * 4;
    const dist = Math.hypot(rgba[p]! - bgR, rgba[p + 1]! - bgG, rgba[p + 2]! - bgB);
    if (dist < 28 && grad[idx]! < 24) { bg[idx] = 1; q[qt++] = idx; }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { push(y * w); push(y * w + (w - 1)); }
  while (qh < qt) {
    const cur = q[qh++]!;
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx > 0) push(cur - 1);
    if (cx + 1 < w) push(cur + 1);
    if (cy > 0) push(cur - w);
    if (cy + 1 < h) push(cur + w);
  }
  const alpha = new Float32Array(n);
  let fgCount = 0;
  for (let i = 0; i < n; i++) {
    if (bg[i]) { alpha[i] = 0; out[i * 4 + 3] = 0; }
    else {
      const x = i % w, y = (i / w) | 0;
      const nearBg = (x > 0 && bg[i - 1]) || (x + 1 < w && bg[i + 1]) || (y > 0 && bg[i - w]) || (y + 1 < h && bg[i + w]);
      const p = i * 4;
      const dist = Math.hypot(rgba[p]! - bgR, rgba[p + 1]! - bgG, rgba[p + 2]! - bgB);
      alpha[i] = nearBg ? Math.max(0.15, Math.min(1, (dist - 10) / 26)) : 1;
      out[p + 3] = Math.round(alpha[i]! * 255);
      if (alpha[i]! > 0.2) fgCount++;
    }
  }
  return { rgba: out, alpha, coverage: fgCount / n };
}

export function normalizeAndCenterSubject(
  rgba: Uint8Array,
  alpha: Float32Array,
  w: number,
  h: number,
  targetSize = 448,
): { rgba: Uint8Array; alpha: Float32Array; size: number } {
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (alpha[y * w + x]! > 0.2) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  if (maxX <= minX || maxY <= minY) { minX = 0; maxX = w - 1; minY = 0; maxY = h - 1; }
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const maxSpan = targetSize * 0.70;
  const scale = Math.min(maxSpan / bw, maxSpan / bh);
  const outW = bw * scale, outH = bh * scale;
  const offX = (targetSize - outW) * 0.5;
  const offY = targetSize * 0.465 - outH * 0.5;
  const outRgba = new Uint8Array(targetSize * targetSize * 4);
  const outAlpha = new Float32Array(targetSize * targetSize);

  for (let dy = 0; dy < targetSize; dy++) {
    const sy = (dy - offY) / scale + minY;
    if (sy < 0 || sy >= h - 1) continue;
    const y0 = Math.floor(sy), fy = sy - y0, y1 = Math.min(h - 1, y0 + 1);
    for (let dx = 0; dx < targetSize; dx++) {
      const sx = (dx - offX) / scale + minX;
      if (sx < 0 || sx >= w - 1) continue;
      const x0 = Math.floor(sx), fx = sx - x0, x1 = Math.min(w - 1, x0 + 1);
      const i00 = y0 * w + x0, i10 = y0 * w + x1, i01 = y1 * w + x0, i11 = y1 * w + x1;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      const a = alpha[i00]! * w00 + alpha[i10]! * w10 + alpha[i01]! * w01 + alpha[i11]! * w11;
      const di = dy * targetSize + dx;
      outAlpha[di] = a;
      if (a <= 0.004) continue;
      for (let c = 0; c < 3; c++) {
        const v = (rgba[i00 * 4 + c]! * alpha[i00]! * w00 + rgba[i10 * 4 + c]! * alpha[i10]! * w10 +
          rgba[i01 * 4 + c]! * alpha[i01]! * w01 + rgba[i11 * 4 + c]! * alpha[i11]! * w11) / a;
        outRgba[di * 4 + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      outRgba[di * 4 + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
    }
  }
  return { rgba: outRgba, alpha: outAlpha, size: targetSize };
}

export interface VisorBounds { x0: number; y0: number; x1: number; y1: number; coverage: number }

export function detectVisorAndCalibrateRig(
  rgba: Uint8Array,
  alpha: Float32Array,
  size: number,
  cleanVisor = true,
): { rig: AvatarRigGeometry; visor: VisorBounds } {
  const sx0 = Math.floor(size * 0.28), sx1 = Math.ceil(size * 0.72);
  const sy0 = Math.floor(size * 0.40), sy1 = Math.ceil(size * 0.72);
  const darkPts: Array<[number, number]> = [];
  for (let y = sy0; y < sy1; y++) for (let x = sx0; x < sx1; x++) {
    const i = y * size + x, p = i * 4;
    if (alpha[i]! < 0.7) continue;
    const luma = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
    if (luma < 56) darkPts.push([x, y]);
  }
  const regionArea = (sx1 - sx0) * (sy1 - sy0);
  const coverage = darkPts.length / Math.max(1, regionArea);
  if (darkPts.length < regionArea * 0.08) {
    return { rig: structuredClone(CANONICAL_VISOR_RIG_V1), visor: { x0: size * 0.32, y0: size * 0.46, x1: size * 0.68, y1: size * 0.66, coverage } };
  }
  const xs = darkPts.map((p) => p[0]).sort((a, b) => a - b);
  const ys = darkPts.map((p) => p[1]).sort((a, b) => a - b);
  const x0 = xs[Math.floor(xs.length * 0.03)]!, x1 = xs[Math.floor(xs.length * 0.97)]!;
  const y0 = ys[Math.floor(ys.length * 0.03)]!, y1 = ys[Math.floor(ys.length * 0.97)]!;
  const cxPct = (((x0 + x1) * 0.5) / size) * 100;
  const cyPct = (((y0 + y1) * 0.5) / size) * 100;
  const vwPct = ((x1 - x0) / size) * 100;
  const vhPct = ((y1 - y0) / size) * 100;
  const eyeOffset = Math.max(6.5, Math.min(11.5, vwPct * 0.235));
  const r = Number(Math.max(3.1, Math.min(5.2, vhPct * 0.215)).toFixed(2));
  if (cleanVisor) {
    const padX = (x1 - x0) * 0.16, padY = (y1 - y0) * 0.18;
    for (let y = Math.floor(y0 + padY); y <= Math.ceil(y1 - padY); y++) {
      for (let x = Math.floor(x0 + padX); x <= Math.ceil(x1 - padX); x++) {
        const p = (y * size + x) * 4;
        const luma = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
        if (luma > 118) { rgba[p] = 14; rgba[p + 1] = 18; rgba[p + 2] = 22; }
      }
    }
  }
  const colSpan = (x: number) => {
    let c = 0;
    for (let y = Math.floor(size * 0.24); y < Math.ceil(size * 0.90); y++) if (alpha[y * size + x]! > 0.35) c++;
    return c;
  };
  const rowSpan = (y: number) => {
    let c = 0;
    for (let x = Math.floor(size * 0.22); x < Math.ceil(size * 0.78); x++) if (alpha[y * size + x]! > 0.35) c++;
    return c;
  };
  const headH = colSpan(Math.round((x0 + x1) * 0.5));
  let earLX = Math.max(size * 0.16, x0 - (x1 - x0) * 0.28);
  for (let x = Math.floor(x0); x >= Math.floor(size * 0.14); x--) {
    if (colSpan(x) < headH * 0.54) { earLX = x; break; }
  }
  let earRX = Math.min(size * 0.84, x1 + (x1 - x0) * 0.28);
  for (let x = Math.ceil(x1); x <= Math.ceil(size * 0.86); x++) {
    if (colSpan(x) < headH * 0.54) { earRX = x; break; }
  }
  const headW = rowSpan(Math.round(y0));
  let topY = Math.max(size * 0.24, y0 - size * 0.16);
  for (let y = Math.floor(y0); y >= Math.floor(size * 0.14); y--) {
    if (rowSpan(y) < headW * 0.42) { topY = y; break; }
  }
  const rig: AvatarRigGeometry = {
    eyes: [
      [Number((cxPct - eyeOffset).toFixed(2)), Number(cyPct.toFixed(2))],
      [Number((cxPct + eyeOffset).toFixed(2)), Number(cyPct.toFixed(2))],
    ],
    r,
    earL: [Number(((earLX / size) * 100).toFixed(2)), Number(cyPct.toFixed(2))],
    earR: [Number(((earRX / size) * 100).toFixed(2)), Number(cyPct.toFixed(2))],
    top: [Number(cxPct.toFixed(2)), Number(((topY / size) * 100).toFixed(2))],
    tip: [Number(cxPct.toFixed(2)), Number(Math.max(10, (topY / size) * 100 - 13).toFixed(2))],
  };
  return { rig, visor: { x0, y0, x1, y1, coverage } };
}

function ramp(v: number, a: number, b: number): number {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function assembleEightCellSpriteSheet(
  rgba: Uint8Array,
  alpha: Float32Array,
  size: number,
  rig: AvatarRigGeometry,
  visor: VisorBounds,
  preserveGlow = true,
): { spritePng: Buffer; hasGlow: boolean } {
  const sheetW = size * 8;
  const sheet = new Uint8Array(sheetW * size * 4);
  const cutL = (rig.earL[0] / 100) * size;
  const cutR = (rig.earR[0] / 100) * size;
  const cutTop = (rig.top[1] / 100) * size;
  const cx = (rig.top[0] / 100) * size;
  const cy = (rig.earL[1] / 100) * size;
  const f = Math.max(2, size * 0.008);
  const ext = size * 0.036;
  const earY0 = cy - size * 0.22, earY1 = cy + size * 0.22;
  const topSpan = size * 0.20, stemHalf = size * 0.055;
  let glowPixels = 0;

  const put = (cell: number, x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (a <= 0.004) return;
    const o = (y * sheetW + cell * size + x) * 4;
    sheet[o] = r; sheet[o + 1] = g; sheet[o + 2] = b; sheet[o + 3] = Math.max(0, Math.min(255, Math.round(a * 255)));
  };

  for (let y = 0; y < size; y++) {
    const inEarY = ramp(y, earY0 - 6, earY0 + 6) * (1 - ramp(y, earY1 - 6, earY1 + 6));
    const inTopY = ramp(y, cutTop + f, cutTop - f);
    for (let x = 0; x < size; x++) {
      const i = y * size + x, p = i * 4, a0 = alpha[i]!;
      if (a0 <= 0.004) continue;
      const r = rgba[p]!, g = rgba[p + 1]!, b = rgba[p + 2]!;
      const mEarLZone = ramp(x, cutL + f, cutL - f) * inEarY;
      const mEarRZone = ramp(x, cutR - f, cutR + f) * inEarY;
      const mTopZone = ramp(x, cx - topSpan - f, cx - topSpan + f) * (1 - ramp(x, cx + topSpan - f, cx + topSpan + f)) * inTopY;
      const mHead = a0 * Math.max(0, 1 - mEarLZone - mEarRZone - mTopZone);
      const mEarL = a0 * ramp(x, cutL + ext, cutL + ext - 8) * inEarY;
      const mEarR = a0 * ramp(x, cutR - ext, cutR - ext + 8) * inEarY;
      const stemX = ramp(x, cx - stemHalf - 4, cx - stemHalf + 4) * (1 - ramp(x, cx + stemHalf - 4, cx + stemHalf + 4));
      const mTop = a0 * Math.max(mTopZone, stemX * ramp(y, cutTop + ext, cutTop + ext - 8));

      put(0, x, y, r, g, b, mHead);
      put(1, x, y, r, g, b, mEarL);
      put(2, x, y, r, g, b, mEarR);
      put(3, x, y, r, g, b, mTop);

      if (preserveGlow) {
        const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
        const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
        const inVisor = x >= visor.x0 + 6 && x <= visor.x1 - 6 && y >= visor.y0 + 6 && y <= visor.y1 - 6;
        const glowStrength = !inVisor && maxC > 195 && sat > 0.45 ? ramp(maxC, 190, 240) * ramp(sat, 0.4, 0.7) : 0;
        if (glowStrength > 0.02) {
          glowPixels++;
          put(4, x, y, r, g, b, mHead * glowStrength);
          put(5, x, y, r, g, b, mEarL * glowStrength);
          put(6, x, y, r, g, b, mEarR * glowStrength);
          put(7, x, y, r, g, b, mTop * glowStrength);
        }
      }
    }
  }
  return { spritePng: encodeRgbaToPng(sheetW, size, sheet), hasGlow: glowPixels > 45 };
}

export function rigAvatarImageBuffer(imageBuffer: Buffer, opts: RigOptions = {}): RiggedAvatarResult {
  const cellSize = opts.targetCellSize ?? 448;
  const decoded = decodeImageBufferToRgba(imageBuffer);
  const bg = removeStudioBackground(decoded.rgba, decoded.width, decoded.height);
  const norm = normalizeAndCenterSubject(bg.rgba, bg.alpha, decoded.width, decoded.height, cellSize);
  const { rig, visor } = detectVisorAndCalibrateRig(norm.rgba, norm.alpha, cellSize, opts.cleanVisor !== false);
  const warnings: string[] = [];
  if (bg.coverage < 0.08) warnings.push("low_foreground_coverage");
  if (visor.coverage < 0.08) warnings.push("visor_fallback_canonical");
  const { spritePng, hasGlow } = assembleEightCellSpriteSheet(norm.rgba, norm.alpha, cellSize, rig, visor, opts.preserveGlow !== false);
  const sourcePng = encodeRgbaToPng(cellSize, cellSize, norm.rgba);
  return { spritePng, sourcePng, rig, hasGlow, foregroundCoverage: Number(bg.coverage.toFixed(4)), visorCoverage: Number(visor.coverage.toFixed(4)), warnings };
}
