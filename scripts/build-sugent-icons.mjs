#!/usr/bin/env node
/**
 * Sugent 零依赖全平台桌面应用图标生成器 (scripts/build-sugent-icons.mjs)
 *
 * 无需 Python Pillow，纯 Node.js (内置 node:zlib) 渲染 1024x1024 超采样矢量级主图标：
 *   - 深邃曜石钛黑圆角底盘 (#0D1209 -> #1C2813)
 *   - 霓虹青柠-翡翠渐变 (#D7FF00 -> #00F5A0) 六边形神经晶格与无限自治双环轨道 (Lemniscate)
 *   - 高对比暗色护目腔 + 灵动双胶囊智能体之眼（带高光点，确保在 18px 托盘下依然清晰锐利）
 *
 * 自动生成全平台 Electron 桌面 App 图标文件：
 *   - anymodelbot_design/icon/1024x1024.png
 *   - assets/icon.icns (macOS 桌面 App 与 Dock 图标)
 *   - assets/icon.ico  (Windows 安装包与窗口图标)
 *   - assets/icon.png & assets/icons/<N>x<N>.png (Linux & 运行时图标)
 *   - assets/tray.png & assets/tray@2x.png (macOS 菜单栏托盘图标)
 *   - ui/assets/favicon-32.png, favicon-64.png, apple-touch-icon.png
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------- CRC32 & 纯 Node PNG 编码器 ----------
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
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([len, typeAndData, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0; // filter type 0 (None)
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- SDF 几何距离与混色辅助函数 ----------
function clamp(v, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/**
 * 渲染任意尺寸的 Sugent 图标 RGBA Buffer
 * @param {number} size 画布宽高
 * @param {object} opts { marginRatio, shadow }
 */
function renderSugentIcon(size, opts = {}) {
  const marginRatio = opts.marginRatio ?? 0.03125;
  const rgba = Buffer.alloc(size * size * 4);

  // 预先构建六边形顶点与无限环 (Lemniscate) 采样点（归一化坐标 [-1, 1]）
  const hexPts = [];
  const hexR = 0.64;
  for (let i = 0; i < 6; i++) {
    const a = ((i * 60 - 90) * Math.PI) / 180;
    hexPts.push([hexR * Math.cos(a), hexR * Math.sin(a)]);
  }

  const infPts = [];
  const infSteps = 72;
  const infScale = 0.60;
  for (let i = 0; i <= infSteps; i++) {
    const t = (i / infSteps) * Math.PI * 2;
    const denom = 1 + Math.sin(t) * Math.sin(t);
    const x = (infScale * Math.cos(t)) / denom;
    const y = ((infScale * Math.sin(t) * Math.cos(t)) / denom) * 1.18;
    infPts.push([x, y]);
  }

  const aa = 2.2 / size; // 归一化抗锯齿边缘宽度
  const boxHalf = 1.0 - marginRatio * 2;
  const cornerR = boxHalf * 0.45; // Apple Squircle 圆角比例

  for (let y = 0; y < size; y++) {
    const ny = ((y + 0.5) / size) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const nx = ((x + 0.5) / size) * 2 - 1;
      const idx = (y * size + x) * 4;

      const dBox = sdRoundedBox(nx, ny, boxHalf, boxHalf, cornerR);
      if (dBox > aa * 1.5) {
        // 图标外部全透明
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
        continue;
      }

      const boxAlpha = 1.0 - smoothstep(-aa, aa, dBox);

      // 1. 深邃钛黑径向渐变底色 (#0D1208 -> #1D2B12)
      const rad = Math.hypot(nx, ny);
      const bgGlow = clamp(1.0 - rad * 0.85);
      let r = 13 + bgGlow * 18;
      let g = 18 + bgGlow * 28;
      let b = 10 + bgGlow * 14;

      // 金属内边框光泽
      const dRim = Math.abs(dBox + 0.055);
      const rimMask = 1.0 - smoothstep(0.0, 0.02 + aa, dRim);
      r += rimMask * 48;
      g += rimMask * 72;
      b += rimMask * 25;

      // 2. 六边形神经晶格距离
      let dHex = 10;
      for (let i = 0; i < 6; i++) {
        const p1 = hexPts[i];
        const p2 = hexPts[(i + 1) % 6];
        dHex = Math.min(dHex, sdSegment(nx, ny, p1[0], p1[1], p2[0], p2[1]));
        dHex = Math.min(dHex, sdSegment(nx, ny, 0, 0, p1[0], p1[1]) * 1.35);
      }

      // 3. 无限符号 (Lemniscate) 距离
      let dInf = 10;
      for (let i = 0; i < infSteps; i++) {
        const p1 = infPts[i];
        const p2 = infPts[i + 1];
        dInf = Math.min(dInf, sdSegment(nx, ny, p1[0], p1[1], p2[0], p2[1]));
      }

      // 渐变色：左上青柠绿 (#D7FF00: 215, 255, 0) -> 右下翡翠青 (#00F5A0: 0, 245, 160)
      const gradT = clamp((nx + ny + 1.2) / 2.4);
      const nr = 215 * (1 - gradT) + 0 * gradT;
      const ng = 255 * (1 - gradT) + 245 * gradT;
      const nb = 0 * (1 - gradT) + 160 * gradT;

      // 叠加晶格与无限环辉光
      const hexLine = 1.0 - smoothstep(0.008, 0.018 + aa, dHex);
      const hexGlow = Math.exp(-dHex * 18) * 0.45;
      const infLine = 1.0 - smoothstep(0.016, 0.028 + aa, dInf);
      const infGlow = Math.exp(-dInf * 14) * 0.65;

      const energy = clamp(hexLine * 0.75 + hexGlow + infLine * 1.1 + infGlow, 0, 1.35);
      r = r * (1 - clamp(energy * 0.7)) + nr * energy;
      g = g * (1 - clamp(energy * 0.7)) + ng * energy;
      b = b * (1 - clamp(energy * 0.7)) + nb * energy;

      // 4. 中央深色护目镜内腔 (Visor) 与灵动双胶囊眼 (Capsule Eyes)
      const dVisor = sdRoundedBox(nx, ny, 0.48, 0.24, 0.22);
      if (dVisor < 0.03) {
        const visorFill = 1.0 - smoothstep(-aa, aa, dVisor);
        r = r * (1 - visorFill * 0.88) + 10 * visorFill;
        g = g * (1 - visorFill * 0.88) + 16 * visorFill;
        b = b * (1 - visorFill * 0.88) + 9 * visorFill;

        const visorStroke = 1.0 - smoothstep(0.0, 0.016 + aa, Math.abs(dVisor));
        r += visorStroke * nr * 0.85;
        g += visorStroke * ng * 0.85;
        b += visorStroke * nb * 0.85;
      }

      // 左右双胶囊眼
      const eyeX = Math.abs(nx) - 0.23;
      const dEye = sdRoundedBox(eyeX, ny, 0.082, 0.145, 0.082);
      const eyeMask = 1.0 - smoothstep(-aa, aa, dEye);
      const eyeAura = Math.exp(-Math.max(dEye, 0) * 22) * 0.55;

      r += (eyeMask + eyeAura) * 220;
      g += (eyeMask + eyeAura) * 255;
      b += (eyeMask + eyeAura) * 95;

      // 眼神高光白点
      const hlX = (nx < 0 ? nx + 0.255 : nx - 0.205);
      const hlY = ny + 0.055;
      const dHl = Math.hypot(hlX, hlY) - 0.028;
      const hlMask = 1.0 - smoothstep(-aa, aa, dHl);
      r += hlMask * 255;
      g += hlMask * 255;
      b += hlMask * 255;

      rgba[idx] = clamp(Math.round(r), 0, 255);
      rgba[idx + 1] = clamp(Math.round(g), 0, 255);
      rgba[idx + 2] = clamp(Math.round(b), 0, 255);
      rgba[idx + 3] = clamp(Math.round(boxAlpha * 255), 0, 255);
    }
  }

  return encodePNG(size, size, rgba);
}

// ---------- ICNS & ICO 打包器 ----------
function writeIcns(filePath, pngBySize) {
  const types = [
    ["icp4", 16],
    ["icp5", 32],
    ["ic11", 32],
    ["ic12", 64],
    ["ic07", 128],
    ["ic13", 256],
    ["ic08", 256],
    ["ic14", 512],
    ["ic09", 512],
    ["ic10", 1024],
  ];
  const chunks = [];
  for (const [tag, sz] of types) {
    const data = pngBySize.get(sz);
    const h = Buffer.alloc(8);
    h.write(tag, 0, 4, "ascii");
    h.writeUInt32BE(8 + data.length, 4);
    chunks.push(h, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(8 + body.length, 4);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([head, body]));
}

function writeIco(filePath, pngBySize) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((s) => ({ s, data: pngBySize.get(s) }));
  const head = Buffer.alloc(6 + 16 * frames.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(frames.length, 4);
  let offset = 6 + 16 * frames.length;
  frames.forEach((f, idx) => {
    const pos = 6 + idx * 16;
    head[pos] = f.s === 256 ? 0 : f.s;
    head[pos + 1] = f.s === 256 ? 0 : f.s;
    head[pos + 2] = 0;
    head[pos + 3] = 0;
    head.writeUInt16LE(1, pos + 4);
    head.writeUInt16LE(32, pos + 6);
    head.writeUInt32LE(f.data.length, pos + 8);
    head.writeUInt32LE(offset, pos + 12);
    offset += f.data.length;
  });
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.concat([head, ...frames.map((f) => f.data)]));
}

function main() {
  const allSizes = [16, 18, 24, 32, 36, 48, 64, 128, 180, 256, 512, 1024];
  const pngBySize = new Map();
  for (const s of allSizes) {
    console.log(`[sugent-icons] 正在渲染 ${s}x${s} 图标...`);
    pngBySize.set(s, renderSugentIcon(s, { marginRatio: s >= 64 ? 0.08 : 0.03 }));
  }

  const writePng = (rel, sz) => {
    const p = path.join(ROOT, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, pngBySize.get(sz));
  };

  writePng("anymodelbot_design/icon/1024x1024.png", 1024);
  writeIcns(path.join(ROOT, "assets/icon.icns"), pngBySize);
  writeIco(path.join(ROOT, "assets/icon.ico"), pngBySize);
  writePng("assets/icon.png", 256);
  for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
    writePng(`assets/icons/${s}x${s}.png`, s);
  }
  writePng("assets/tray.png", 18);
  writePng("assets/tray@2x.png", 36);
  writePng("ui/assets/favicon-32.png", 32);
  writePng("ui/assets/favicon-64.png", 64);
  writePng("ui/assets/apple-touch-icon.png", 180);

  // 移除刚才不再需要的 Python 临时脚本
  const oldPy = path.join(ROOT, "scripts/generate-sugent-master-icon.py");
  if (fs.existsSync(oldPy)) fs.rmSync(oldPy, { force: true });

  console.log("✅ [sugent-icons] 全平台桌面 App 图标 (macOS .icns / Windows .ico / Linux .png / 托盘 / Favicon) 生成完毕！");
}

main();
