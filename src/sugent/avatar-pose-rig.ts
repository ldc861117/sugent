import { decodeImageBufferToRgba, encodeRgbaToPng } from "./avatar-rig.js";

export const POSE_KEYS = ["idle", "listening", "thinking", "working", "waiting", "sleep"] as const;
export type AvatarPoseKey = (typeof POSE_KEYS)[number];
export type PoseSheetLayoutMode = "grid_3x2" | "single";

export interface PoseCellMetrics {
  key: AvatarPoseKey;
  col: number;
  row: number;
  bbox: [number, number, number, number];
  baselineY: number;
  headEndY: number;
  torsoEndY: number;
  coverage: number;
  fallbackFrom?: AvatarPoseKey;
}

export interface PoseSheetRigMetadata {
  grid: [3, 2];
  cellSize: number;
  sheetSize: [number, number];
  portraitSize: number;
  layoutMode: PoseSheetLayoutMode;
  cells: Record<AvatarPoseKey, PoseCellMetrics>;
}

export interface RigPoseSheetOptions {
  layout?: PoseSheetLayoutMode;
  cellSize?: number;
  portraitSize?: number;
}

export interface RiggedPoseSheetResult {
  poseSheetPng: Buffer;
  portraitPng: Buffer;
  poseMeta: PoseSheetRigMetadata;
  warnings: string[];
}

export const POSE_HEIGHT_RATIOS: Record<AvatarPoseKey, number> = {
  idle: 0.86,
  listening: 0.92,
  thinking: 0.95,
  working: 0.9,
  waiting: 1.0,
  sleep: 0.72,
};

function makeDefaultCell(key: AvatarPoseKey, idx: number): PoseCellMetrics {
  const h = POSE_HEIGHT_RATIOS[key] * 0.78;
  const y = Number((0.88 - h).toFixed(4));
  return {
    key,
    col: idx % 3,
    row: Math.floor(idx / 3),
    bbox: [0.22, y, 0.56, Number(h.toFixed(4))],
    baselineY: 0.88,
    headEndY: Number((y + h * 0.44).toFixed(4)),
    torsoEndY: Number((y + h * 0.74).toFixed(4)),
    coverage: 0.25,
  };
}

export const CANONICAL_POSE_SHEET_META: PoseSheetRigMetadata = {
  grid: [3, 2],
  cellSize: 384,
  sheetSize: [1152, 768],
  portraitSize: 256,
  layoutMode: "grid_3x2",
  cells: Object.fromEntries(POSE_KEYS.map((k, i) => [k, makeDefaultCell(k, i)])) as Record<AvatarPoseKey, PoseCellMetrics>,
};

const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const medianNum = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

function removePoseSheetBackground(rgba: Uint8Array, w: number, h: number, gridMode: boolean): { rgba: Uint8Array; alpha: Float32Array } {
  const n = w * h;
  const out = new Uint8Array(rgba);
  let transCount = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3]! < 230) transCount++;
  if (transCount > n * 0.18) {
    const alpha = new Float32Array(n);
    for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3]! / 255;
    return { rgba: out, alpha };
  }
  const rs: number[] = [], gs: number[] = [], bs: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(w, h) / 64));
  for (let x = 0; x < w; x += step) for (const y of [0, 1, h - 2, h - 1]) {
    const p = (y * w + x) * 4; rs.push(rgba[p]!); gs.push(rgba[p + 1]!); bs.push(rgba[p + 2]!);
  }
  for (let y = 0; y < h; y += step) for (const x of [0, 1, w - 2, w - 1]) {
    const p = (y * w + x) * 4; rs.push(rgba[p]!); gs.push(rgba[p + 1]!); bs.push(rgba[p + 2]!);
  }
  const bgR = medianNum(rs), bgG = medianNum(gs), bgB = medianNum(bs);
  const bgLuma = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
  const grad = new Float32Array(n);
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    luma[i] = 0.299 * rgba[p]! + 0.587 * rgba[p + 1]! + 0.114 * rgba[p + 2]!;
  }
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = Math.abs((luma[i + 1]! - luma[i - 1]!) * 2 + luma[i - w + 1]! - luma[i - w - 1]! + luma[i + w + 1]! - luma[i + w - 1]!);
    const gy = Math.abs((luma[i + w]! - luma[i - w]!) * 2 + luma[i + w - 1]! - luma[i - w - 1]! + luma[i + w + 1]! - luma[i - w + 1]!);
    grad[i] = Math.hypot(gx, gy) * 0.25;
  }
  const bg = new Uint8Array(n);
  const q = new Int32Array(n);
  let qh = 0, qt = 0;
  const colorDist = (i: number) => {
    const p = i * 4;
    return Math.hypot(rgba[p]! - bgR, rgba[p + 1]! - bgG, rgba[p + 2]! - bgB);
  };
  const trySeed = (i: number) => {
    if (!bg[i] && colorDist(i) < 11 && grad[i]! < 8) { bg[i] = 1; q[qt++] = i; }
  };
  for (let x = 0; x < w; x++) { trySeed(x); trySeed((h - 1) * w + x); }
  for (let y = 1; y < h - 1; y++) { trySeed(y * w); trySeed(y * w + w - 1); }
  if (gridMode) {
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) {
      const xL = Math.round((c * w) / 3) + 6, xR = Math.round(((c + 1) * w) / 3) - 7;
      const yT = Math.round((r * h) / 2) + 6, yB = Math.round(((r + 1) * h) / 2) - 7;
      for (const sx of [xL, xR]) for (const sy of [yT, yB]) {
        if (sx >= 0 && sx < w && sy >= 0 && sy < h && colorDist(sy * w + sx) < 16 && grad[sy * w + sx]! < 10) trySeed(sy * w + sx);
      }
    }
  }
  while (qh < qt) {
    const cur = q[qh++]!;
    const cx = cur % w, cy = (cur / w) | 0;
    if (cx > 0) trySeed(cur - 1);
    if (cx + 1 < w) trySeed(cur + 1);
    if (cy > 0) trySeed(cur - w);
    if (cy + 1 < h) trySeed(cur + w);
  }
  // 边缘有限距离柔和投影清理（仅限中性暗灰地面柔影，绝不侵入白瓷与高光主体）
  if (bgLuma >= 95) {
    const shDepth = new Uint8Array(n);
    let sqh = 0, sqt = 0;
    const isNeutralShadow = (i: number) => {
      const cy = (i / w) | 0;
      const rowH = gridMode ? h / 2 : h;
      const localY = (cy % rowH) / Math.max(1, rowH);
      if (localY <= 0.78) return false;
      const p = i * 4;
      const rr = rgba[p]! / Math.max(1, bgR), rg = rgba[p + 1]! / Math.max(1, bgG), rb = rgba[p + 2]! / Math.max(1, bgB);
      const avg = (rr + rg + rb) / 3;
      const spread = Math.max(Math.abs(rr - avg), Math.abs(rg - avg), Math.abs(rb - avg));
      return avg >= 0.78 && avg <= 1.03 && spread < 0.038 && grad[i]! < 5;
    };
    for (let i = 0; i < n; i++) {
      if (bg[i]) continue;
      const x = i % w, y = (i / w) | 0;
      const near = (x > 0 && bg[i - 1]) || (x + 1 < w && bg[i + 1]) || (y > 0 && bg[i - w]) || (y + 1 < h && bg[i + w]);
      if (near && isNeutralShadow(i)) { bg[i] = 1; shDepth[i] = 1; q[sqt++] = i; }
    }
    while (sqh < sqt) {
      const cur = q[sqh++]!, d = shDepth[cur]!;
      if (d >= 18) continue;
      const cx = cur % w, cy = (cur / w) | 0;
      for (const nb of [cx > 0 ? cur - 1 : -1, cx + 1 < w ? cur + 1 : -1, cy > 0 ? cur - w : -1, cy + 1 < h ? cur + w : -1]) {
        if (nb >= 0 && !bg[nb] && isNeutralShadow(nb)) { bg[nb] = 1; shDepth[nb] = d + 1; q[sqt++] = nb; }
      }
    }
  }
  // 封闭内孔清理（腋下/双腿间背景，保护明亮白瓷表面）
  const seen = new Uint8Array(n);
  const holeThresh = bgLuma < 238 ? 11 : 7;
  for (let i = 0; i < n; i++) {
    if (bg[i] || seen[i] || colorDist(i) >= holeThresh || grad[i]! >= 8) continue;
    let hHead = 0, hTail = 0, sumDist = 0;
    q[hTail++] = i; seen[i] = 1;
    while (hHead < hTail) {
      const c = q[hHead++]!; sumDist += colorDist(c);
      const cx = c % w, cy = (c / w) | 0;
      for (const nb of [cx > 0 ? c - 1 : -1, cx + 1 < w ? c + 1 : -1, cy > 0 ? c - w : -1, cy + 1 < h ? c + w : -1]) {
        if (nb >= 0 && !bg[nb] && !seen[nb] && colorDist(nb) < holeThresh && grad[nb]! < 8) {
          seen[nb] = 1; q[hTail++] = nb;
        }
      }
    }
    if (hTail >= 48 && sumDist / hTail < holeThresh * 0.78) for (let k = 0; k < hTail; k++) bg[q[k]!] = 1;
  }
  const alpha = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (bg[i]) { out[i * 4 + 3] = 0; continue; }
    const x = i % w, y = (i / w) | 0;
    const nearBg = (x > 0 && bg[i - 1]) || (x + 1 < w && bg[i + 1]) || (y > 0 && bg[i - w]) || (y + 1 < h && bg[i + w]);
    const dist = colorDist(i);
    const a = nearBg ? Math.max(0.12, Math.min(1, (dist - 8) / 22)) : 1;
    alpha[i] = a;
    const p = i * 4;
    if (a > 0.08 && a < 0.95) {
      out[p] = clampByte((out[p]! - (1 - a) * bgR) / a);
      out[p + 1] = clampByte((out[p + 1]! - (1 - a) * bgG) / a);
      out[p + 2] = clampByte((out[p + 2]! - (1 - a) * bgB) / a);
    }
    out[p + 3] = Math.round(a * 255);
  }
  return { rgba: out, alpha };
}

function suppressGridLines(rgba: Uint8Array, alpha: Float32Array, w: number, h: number): void {
  const clearPx = (i: number) => { alpha[i] = 0; rgba[i * 4 + 3] = 0; };
  const marginCol = Math.max(6, Math.round(w * 0.03));
  for (const target of [Math.round(w / 3), Math.round((w * 2) / 3)]) {
    for (let x = Math.max(5, target - marginCol); x <= Math.min(w - 6, target + marginCol); x++) {
      let lineHits = 0;
      for (let y = 0; y < h; y++) {
        const i = y * w + x;
        if (alpha[i]! > 0.15 && alpha[i - 3]! < 0.2 && alpha[i + 3]! < 0.2) lineHits++;
      }
      if (lineHits > h * 0.55) for (let dx = -2; dx <= 2; dx++) for (let y = 0; y < h; y++) {
        const idx = y * w + x + dx;
        if (alpha[idx - 3]! < 0.2 && alpha[idx + 3]! < 0.2) clearPx(idx);
      }
    }
  }
  const marginRow = Math.max(6, Math.round(h * 0.03));
  const midY = Math.round(h / 2);
  for (let y = Math.max(5, midY - marginRow); y <= Math.min(h - 6, midY + marginRow); y++) {
    let lineHits = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (alpha[i]! > 0.15 && alpha[i - w * 3]! < 0.2 && alpha[i + w * 3]! < 0.2) lineHits++;
    }
    if (lineHits > w * 0.55) for (let dy = -2; dy <= 2; dy++) for (let x = 0; x < w; x++) {
      const idx = (y + dy) * w + x;
      if (alpha[idx - w * 3]! < 0.2 && alpha[idx + w * 3]! < 0.2) clearPx(idx);
    }
  }
}

function findSeam(alpha: Float32Array, w: number, h: number, target: number, axis: "x" | "y"): number {
  const limit = axis === "x" ? w : h;
  const span = axis === "x" ? h : w;
  const rad = Math.max(6, Math.round(limit * 0.06));
  let bestPos = target, bestScore = Infinity;
  for (let p = Math.max(10, target - rad); p <= Math.min(limit - 10, target + rad); p++) {
    let fg = 0;
    for (let s = 0; s < span; s++) {
      const a = axis === "x" ? alpha[s * w + p]! : alpha[p * w + s]!;
      if (a > 0.15) fg += a;
    }
    const score = fg + Math.abs(p - target) * 0.3;
    if (score < bestScore) { bestScore = score; bestPos = p; }
  }
  return bestPos;
}

interface RawCellBox {
  key: AvatarPoseKey; col: number; row: number;
  x0: number; y0: number; x1: number; y1: number;
  minX: number; minY: number; maxX: number; maxY: number;
  rawW: number; rawH: number; cx: number; headCx: number; coverage: number;
}

function measureCellBox(rgba: Uint8Array, alpha: Float32Array, fullW: number, key: AvatarPoseKey, col: number, row: number, x0: number, y0: number, x1: number, y1: number): RawCellBox {
  const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0), cn = cw * ch;
  const seen = new Uint8Array(cn), q = new Int32Array(cn);
  for (let ly = 0; ly < ch; ly++) for (let lx = 0; lx < cw; lx++) {
    const li = ly * cw + lx, fi = (y0 + ly) * fullW + (x0 + lx);
    if (seen[li] || alpha[fi]! <= 0.16) continue;
    let hd = 0, tl = 0; q[tl++] = li; seen[li] = 1;
    while (hd < tl) {
      const cur = q[hd++]!, cx = cur % cw, cy = (cur / cw) | 0;
      for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
        if (nx < 0 || nx >= cw || ny < 0 || ny >= ch) continue;
        const ni = ny * cw + nx;
        if (!seen[ni] && alpha[(y0 + ny) * fullW + (x0 + nx)]! > 0.16) { seen[ni] = 1; q[tl++] = ni; }
      }
    }
    if (tl < 16) for (let k = 0; k < tl; k++) {
      const m = q[k]!, fi2 = (y0 + ((m / cw) | 0)) * fullW + (x0 + (m % cw));
      alpha[fi2] = 0; rgba[fi2 * 4 + 3] = 0;
    }
  }
  let minX = x1, minY = y1, maxX = x0 - 1, maxY = y0 - 1, fg = 0, sumX = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (alpha[y * fullW + x]! <= 0.18) continue;
    fg++; sumX += x;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const rawW = maxX >= minX ? maxX - minX + 1 : 0, rawH = maxY >= minY ? maxY - minY + 1 : 0;
  const cx = fg ? sumX / fg : (x0 + x1) * 0.5;
  let topSumX = 0, topFg = 0;
  const topLim = minY + Math.ceil(rawH * 0.36);
  for (let y = minY; y <= Math.min(maxY, topLim); y++) for (let x = minX; x <= maxX; x++) {
    if (alpha[y * fullW + x]! > 0.18) { topSumX += x; topFg++; }
  }
  return { key, col, row, x0, y0, x1, y1, minX, minY, maxX, maxY, rawW, rawH, cx, headCx: topFg ? topSumX / topFg : cx, coverage: fg / cn };
}

function samplePremulCell(
  rgba: Uint8Array, fullW: number, sx: number, sy: number, minX: number, minY: number, maxX: number, maxY: number,
): [number, number, number, number] {
  if (sx < minX || sx > maxX || sy < minY || sy > maxY) return [0, 0, 0, 0];
  const x0 = Math.max(minX, Math.min(maxX, Math.floor(sx)));
  const y0 = Math.max(minY, Math.min(maxY, Math.floor(sy)));
  const x1 = Math.min(maxX, x0 + 1), y1 = Math.min(maxY, y0 + 1);
  const fx = sx - x0, fy = sy - y0;
  let pr = 0, pg = 0, pb = 0, pa = 0;
  const pts = [[x0, y0, (1 - fx) * (1 - fy)], [x1, y0, fx * (1 - fy)], [x0, y1, (1 - fx) * fy], [x1, y1, fx * fy]] as const;
  for (const [px, py, wt] of pts) {
    const p = (py * fullW + px) * 4, a = (rgba[p + 3]! / 255) * wt;
    pr += rgba[p]! * a; pg += rgba[p + 1]! * a; pb += rgba[p + 2]! * a; pa += a;
  }
  if (pa < 0.005) return [0, 0, 0, 0];
  return [clampByte(pr / pa), clampByte(pg / pa), clampByte(pb / pa), clampByte(pa * 255)];
}

export function rigPoseSheetImageBuffer(imageBuffer: Buffer, opts: RigPoseSheetOptions = {}): RiggedPoseSheetResult {
  const layout: PoseSheetLayoutMode = opts.layout ?? "grid_3x2";
  const cellSize = opts.cellSize ?? 384;
  const portraitSize = opts.portraitSize ?? 256;
  const { width: w, height: h, rgba: srcRgba } = decodeImageBufferToRgba(imageBuffer);
  const { rgba, alpha } = removePoseSheetBackground(srcRgba, w, h, layout === "grid_3x2");
  const warnings: string[] = [];

  let rawCells: RawCellBox[];
  if (layout === "single") {
    const one = measureCellBox(rgba, alpha, w, "idle", 0, 0, 0, 0, w, h);
    rawCells = POSE_KEYS.map((key, i) => ({ ...one, key, col: i % 3, row: Math.floor(i / 3) }));
  } else {
    suppressGridLines(rgba, alpha, w, h);
    const x1 = findSeam(alpha, w, h, Math.round(w / 3), "x");
    const x2 = findSeam(alpha, w, h, Math.round((w * 2) / 3), "x");
    const y1 = findSeam(alpha, w, h, Math.round(h / 2), "y");
    const xs = [0, x1, x2, w], ys = [0, y1, h];
    rawCells = POSE_KEYS.map((key, i) => {
      const col = i % 3, row = Math.floor(i / 3);
      return measureCellBox(rgba, alpha, w, key, col, row, xs[col]!, ys[row]!, xs[col + 1]!, ys[row + 1]!);
    });
  }

  const healthy = rawCells.filter((c) => c.coverage >= 0.04 && c.coverage <= 0.92 && c.rawH > 12);
  const usable = healthy.length ? healthy : [rawCells[0]!];
  if (!healthy.length) warnings.push("未检测到明确前景主体，已回退整图居中处理");

  const refHList = (healthy.filter((c) => c.key !== "sleep").length ? healthy.filter((c) => c.key !== "sleep") : usable)
    .map((c) => (layout === "single" ? c.rawH : c.rawH / POSE_HEIGHT_RATIOS[c.key]));
  const refStandH = medianNum(refHList) || h * 0.4;
  const baseScale = (cellSize * 0.78) / Math.max(1, refStandH);

  const sheetW = cellSize * 3, sheetH = cellSize * 2;
  const sheetRgba = new Uint8Array(sheetW * sheetH * 4);
  const cells = {} as Record<AvatarPoseKey, PoseCellMetrics>;

  for (const cell of rawCells) {
    const isHealthy = healthy.includes(cell);
    const src = isHealthy ? cell : (usable.find((u) => u.key === "idle") ?? usable.find((u) => u.key === "listening") ?? usable[0]!);
    if (!isHealthy && layout === "grid_3x2") warnings.push(`姿态 ${cell.key} 覆盖率异常(${cell.coverage.toFixed(3)})，已借用 ${src.key}`);
    const scale = Math.min(baseScale, (cellSize * 0.86) / Math.max(1, src.rawW), (cellSize * 0.82) / Math.max(1, src.rawH));
    const anchorX = Math.max(cellSize * 0.04 + (src.cx - src.minX) * scale, Math.min(cellSize * 0.96 - (src.maxX - src.cx) * scale, cellSize * 0.5));
    const ox = cell.col * cellSize, oy = cell.row * cellSize;
    let outMinX = cellSize, outMinY = cellSize, outMaxX = 0, outMaxY = 0, outFg = 0;
    for (let dy = 0; dy < cellSize; dy++) for (let dx = 0; dx < cellSize; dx++) {
      const sx = src.cx + (dx - anchorX) / scale;
      const sy = src.maxY - (cellSize * 0.88 - dy) / scale;
      const [r, g, b, a] = samplePremulCell(rgba, w, sx, sy, src.minX, src.minY, src.maxX, src.maxY);
      if (a === 0) continue;
      const dp = ((oy + dy) * sheetW + ox + dx) * 4;
      sheetRgba[dp] = r; sheetRgba[dp + 1] = g; sheetRgba[dp + 2] = b; sheetRgba[dp + 3] = a;
      if (a > 40) { outFg++; if (dx < outMinX) outMinX = dx; if (dx > outMaxX) outMaxX = dx; if (dy < outMinY) outMinY = dy; if (dy > outMaxY) outMaxY = dy; }
    }
    const nx = outMaxX >= outMinX ? outMinX / cellSize : 0.22;
    const ny = outMaxY >= outMinY ? outMinY / cellSize : 0.14;
    const nw = outMaxX >= outMinX ? (outMaxX - outMinX + 1) / cellSize : 0.56;
    const nh = outMaxY >= outMinY ? (outMaxY - outMinY + 1) / cellSize : 0.74;
    cells[cell.key] = {
      key: cell.key, col: cell.col, row: cell.row,
      bbox: [Number(nx.toFixed(4)), Number(ny.toFixed(4)), Number(nw.toFixed(4)), Number(nh.toFixed(4))],
      baselineY: 0.88,
      headEndY: Number((ny + nh * 0.44).toFixed(4)),
      torsoEndY: Number((ny + nh * 0.74).toFixed(4)),
      coverage: Number((outFg / (cellSize * cellSize)).toFixed(4)),
      ...(src !== cell ? { fallbackFrom: src.key } : {}),
    };
  }

  // 头肩特写自动裁切（portrait.png, 默认 256×256）
  const pSrc = usable.find((u) => u.key === "idle") ?? usable.find((u) => u.key === "listening") ?? usable[0]!;
  const portraitRgba = new Uint8Array(portraitSize * portraitSize * 4);
  if (pSrc.rawW > 0 && pSrc.rawH > 0) {
    const cropSize = Math.max(pSrc.rawH * 0.48, pSrc.rawW * 0.58, 16);
    const cropLeft = pSrc.headCx - cropSize * 0.5;
    const cropTop = pSrc.minY - cropSize * 0.07;
    for (let dy = 0; dy < portraitSize; dy++) for (let dx = 0; dx < portraitSize; dx++) {
      const sx = cropLeft + ((dx + 0.5) / portraitSize) * cropSize;
      const sy = cropTop + ((dy + 0.5) / portraitSize) * cropSize;
      const [r, g, b, a] = samplePremulCell(rgba, w, sx, sy, pSrc.minX, pSrc.minY, pSrc.maxX, pSrc.maxY);
      if (a === 0) continue;
      const dp = (dy * portraitSize + dx) * 4;
      portraitRgba[dp] = r; portraitRgba[dp + 1] = g; portraitRgba[dp + 2] = b; portraitRgba[dp + 3] = a;
    }
  }

  return {
    poseSheetPng: encodeRgbaToPng(sheetW, sheetH, sheetRgba),
    portraitPng: encodeRgbaToPng(portraitSize, portraitSize, portraitRgba),
    poseMeta: {
      grid: [3, 2],
      cellSize,
      sheetSize: [sheetW, sheetH],
      portraitSize,
      layoutMode: layout,
      cells,
    },
    warnings,
  };
}
