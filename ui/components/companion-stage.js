import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./ui.js";
import { reducedMotion } from "../design/motion.js";

const POSE_INDEX_3X3 = {
  idle_left: [0, 0],
  idle: [1, 0],
  idle_right: [2, 0],
  listening: [0, 1],
  thinking: [1, 1],
  working: [2, 1],
  waiting: [0, 2],
  ack: [1, 2],
  sleep: [2, 2],
};
const POSE_INDEX_3X2 = {
  idle: [0, 0],
  listening: [1, 0],
  thinking: [2, 0],
  working: [0, 1],
  waiting: [1, 1],
  sleep: [2, 1],
};
const IDLE_FAMILY = new Set(["idle", "idle_left", "idle_right"]);
const MOTION_MULT = { calm: 0.72, lively: 1.0, minimal: 0.35 };
const imgCache = new Map();

function loadSheet(url, onReady) {
  if (!url) return null;
  let rec = imgCache.get(url);
  if (!rec) {
    const img = new Image();
    rec = { img, ready: false, failed: false, listeners: new Set() };
    img.onload = () => {
      rec.ready = true;
      for (const fn of rec.listeners) fn(true);
    };
    img.onerror = () => {
      rec.failed = true;
      for (const fn of rec.listeners) fn(false);
    };
    img.src = url;
    imgCache.set(url, rec);
  }
  if (onReady) {
    rec.listeners.add(onReady);
    if (rec.ready) onReady(true);
  }
  return rec;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function parseHexRgb(hex, fb) {
  const s = String(hex || "").trim().replace(/^#/, "");
  if (s.length !== 6) return fb;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) ? [r, g, b] : fb;
}

function rgbAlpha(rgb, a) {
  return `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]} / ${clamp(a, 0, 1).toFixed(3)})`;
}

function readTokenRgb(el, varName, fb) {
  if (!el) return fb;
  const raw = getComputedStyle(el).getPropertyValue(varName).trim();
  if (raw.startsWith("#")) return parseHexRgb(raw, fb);
  const m = raw.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : fb;
}

function isGrid3x3(img, poseMeta) {
  if (poseMeta?.grid) return poseMeta.grid[1] === 3;
  return Boolean(img?.naturalWidth && img.naturalHeight > img.naturalWidth * 0.82);
}

function resolveBasePose(state, cueKind, cueElapsed, has3x3) {
  if (state === "replying") return "working";
  if ((state === "idle" || !POSE_INDEX_3X3[state]) && has3x3 && (cueKind === "done" || cueKind === "hello") && cueElapsed < 920) {
    return "ack";
  }
  return POSE_INDEX_3X3[state] ? state : "idle";
}

function drawEyeMicroGaze(ctx, es, size, tSec, poseKey, opts) {
  if (!es || poseKey === "sleep") return;
  const rPx = Math.max(1.8, es.r * size);
  const blinkCycle = (tSec + 1.37) % 4.6;
  const blinkOpen = blinkCycle < 0.12 ? clamp(Math.abs(blinkCycle - 0.06) / 0.06, 0.12, 1) : 1;
  const gx = clamp(opts.residualLookX, -0.75, 0.75) * Math.max(1.5, rPx * 1.45) * opts.attnWeight * opts.gazeScale;
  const gy = clamp(opts.lookY, -0.85, 0.85) * Math.max(1.1, rPx * 1.05) * opts.attnWeight * opts.gazeScale;
  const pts = [es.left, es.right];
  ctx.fillStyle = rgbAlpha(es.bgRgb, 1);
  for (let i = 0; i < 2; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0] * size, pts[i][1] * size, rPx * 1.48, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 2; i++) {
    const sideSign = i === 0 ? -1 : 1;
    const foreshorten = clamp(1 - Math.max(0, sideSign * opts.residualLookX) * 0.18 * opts.attnWeight, 0.78, 1.04);
    const ex = pts[i][0] * size + gx;
    const ey = pts[i][1] * size + gy;
    const rx = rPx * foreshorten;
    const ry = Math.max(0.65, rPx * blinkOpen);
    ctx.fillStyle = rgbAlpha(es.eyeRgb, 0.24);
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx * 1.65, Math.max(1, ry * 1.55), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgbAlpha(es.eyeRgb, 0.96);
    ctx.beginPath();
    ctx.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRigidSculpturePose(ctx, img, poseKey, poseMeta, size, tSec, opts) {
  const has3x3 = isGrid3x3(img, poseMeta);
  const rows = has3x3 ? 3 : 2;
  const cellW = img.naturalWidth / 3;
  const cellH = img.naturalHeight / rows;
  if (!cellW || !cellH) return;
  const map = has3x3 ? POSE_INDEX_3X3 : POSE_INDEX_3X2;
  const fallbackKey = IDLE_FAMILY.has(poseKey) ? "idle" : poseKey === "ack" ? "waiting" : "idle";
  const [col, row] = map[poseKey] || map[fallbackKey] || [0, 0];
  const sx0 = col * cellW;
  const sy0 = row * cellH;
  const cm = poseMeta?.cells?.[poseKey] || poseMeta?.cells?.[fallbackKey] || {};
  const base = clamp(cm.baselineY || 0.88, 0.72, 0.96);
  const headEnd = clamp(cm.headEndY || 0.44, 0.28, base - 0.16);
  const neckY = headEnd * size;
  const groundY = base * size;
  const seam = Math.max(2, size * 0.012);
  const mult = opts.motionScale;
  const breathe = Math.sin((tSec * Math.PI * 2) / (poseKey === "sleep" ? 4.6 : 3.8)) * mult;
  const bodySx = 1 + breathe * 0.006;
  const bodySy = 1 + breathe * 0.008;
  const thinkRoll = poseKey === "thinking" ? Math.sin((tSec * Math.PI * 2) / 3.8) * (2.2 * Math.PI / 180) * mult : 0;
  const nodPx =
    ((poseKey === "listening" ? Math.sin(tSec * 2.5) * 0.005 : 0) +
      (poseKey === "working" ? Math.sin(tSec * 8.5) * 0.0035 : 0) -
      (poseKey === "waiting" ? Math.pow(Math.max(0, Math.sin((tSec * Math.PI * 2) / 2.6)), 3) * 0.013 : 0)) *
    size *
    mult;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, neckY - seam, size, Math.max(1, size - (neckY - seam)));
  ctx.clip();
  ctx.translate(size * 0.5, groundY);
  ctx.scale(bodySx, bodySy);
  ctx.translate(-size * 0.5, -groundY);
  ctx.drawImage(img, sx0, sy0, cellW, cellH, 0, 0, size, size);
  ctx.restore();

  const maxRoll = (3.6 * Math.PI) / 180;
  const gazeRoll = opts.residualLookX * ((3.2 * Math.PI) / 180) * opts.attnWeight * opts.gazeScale;
  const rollRad = clamp(gazeRoll + thinkRoll, -maxRoll, maxRoll);
  const pitchPx = clamp(opts.lookY, -1, 1) * 1.8 * opts.attnWeight * opts.gazeScale + nodPx;
  const neckAnchorY = neckY + (1 - bodySy) * (groundY - neckY);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, size, neckY + seam * 0.65);
  ctx.clip();
  ctx.translate(size * 0.5, neckAnchorY + pitchPx);
  ctx.rotate(rollRad);
  ctx.translate(-size * 0.5, -neckY);
  ctx.drawImage(img, sx0, sy0, cellW, cellH, 0, 0, size, size);
  drawEyeMicroGaze(ctx, cm.eyeSpots, size, tSec, poseKey, opts);
  ctx.restore();
}

function drawAmbientFx(ctx, size, poseKey, tSec, rgb, dropOver, coolProg, squash, nearFactor = 0) {
  const groundY = size * 0.885;
  const shadowR = size * 0.23 * clamp(1 - (1 - squash) * 0.25, 0.72, 1.15);
  const gGrad = ctx.createRadialGradient(size * 0.5, groundY, 0, size * 0.5, groundY, shadowR);
  gGrad.addColorStop(0, rgbAlpha([12, 16, 22], poseKey === "sleep" ? 0.14 : 0.2));
  gGrad.addColorStop(1, rgbAlpha([12, 16, 22], 0));
  ctx.fillStyle = gGrad;
  ctx.beginPath();
  ctx.ellipse(size * 0.5, groundY, shadowR, shadowR * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  if (poseKey === "working") {
    const glow = ctx.createRadialGradient(size * 0.52, size * 0.58, 0, size * 0.52, size * 0.58, size * 0.28);
    glow.addColorStop(0, rgbAlpha(rgb.accent, 0.13 + 0.04 * Math.sin(tSec * 5)));
    glow.addColorStop(1, rgbAlpha(rgb.accent, 0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(size * 0.52, size * 0.58, size * 0.28, 0, Math.PI * 2);
    ctx.fill();
  }
  if (poseKey === "thinking") {
    for (let i = 0; i < 3; i++) {
      const a = tSec * 1.45 + (i * Math.PI * 2) / 3;
      const ox = size * 0.5 + Math.cos(a) * size * 0.24;
      const oy = size * 0.34 + Math.sin(a * 2) * size * 0.035;
      ctx.fillStyle = rgbAlpha(rgb.accent, 0.45 + 0.25 * Math.sin(a));
      ctx.beginPath();
      ctx.arc(ox, oy, Math.max(1.5, size * 0.012), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  if (dropOver || poseKey === "waiting" || coolProg > 0) {
    const r = size * 0.29;
    ctx.strokeStyle = rgbAlpha(rgb.accent, dropOver ? 0.68 : 0.28 + 0.16 * Math.sin(tSec * 3.2));
    ctx.lineWidth = Math.max(1.2, size * 0.01);
    ctx.beginPath();
    ctx.ellipse(size * 0.5, groundY, r, r * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    if (coolProg > 0) {
      ctx.strokeStyle = rgbAlpha(rgb.amber, 0.9);
      ctx.lineWidth = Math.max(2, size * 0.016);
      ctx.beginPath();
      ctx.ellipse(size * 0.5, groundY, r, r * 0.3, 0, -Math.PI * 0.5, -Math.PI * 0.5 + clamp(coolProg, 0, 1) * Math.PI * 2);
      ctx.stroke();
    }
  } else if (nearFactor > 0.05 && poseKey !== "sleep") {
    const r = shadowR * 1.18;
    ctx.strokeStyle = rgbAlpha(rgb.accent, clamp(nearFactor, 0, 1) * 0.42);
    ctx.lineWidth = Math.max(1, size * 0.0075);
    ctx.beginPath();
    ctx.ellipse(size * 0.5, groundY, r, r * 0.29, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function computeRestYaw(p) {
  if (p.externalPointer) return p.facing === "right" ? 1 : -1;
  return p.facing === "right" ? 1 : 0;
}

function updateHeadTurn(st, p, now, dt, rm, gazeActive, has3x3, basePose) {
  const ptrFresh = st.lastPointerMove > 0 && now - st.lastPointerMove < 2400;
  if (!gazeActive || p.dragging) st.inAttn = false;
  else if (!st.inAttn && ptrFresh && st.distPx < 260) st.inAttn = true;
  else if (st.inAttn && (st.distPx > 320 || now - st.lastPointerMove > 2800)) st.inAttn = false;

  const targetAttn = st.inAttn ? 1 : 0;
  st.attnWeight = rm ? targetAttn : st.attnWeight + (targetAttn - st.attnWeight) * Math.min(1, dt * 9);

  const restYaw = computeRestYaw(p);
  if (p.facing !== st.baseFacing) {
    st.baseFacing = p.facing;
    if (!st.inAttn) st.wantYaw = restYaw;
  }
  if (!has3x3 || basePose !== "idle") {
    st.curYaw = restYaw;
    st.wantYaw = restYaw;
    return basePose;
  }
  if (!st.inAttn) {
    st.wantYaw = restYaw;
  } else if (st.wantYaw === 0) {
    st.wantYaw = st.curLookX < -0.3 ? -1 : st.curLookX > 0.3 ? 1 : 0;
  } else if (st.wantYaw < 0) {
    st.wantYaw = st.curLookX > 0.3 ? 1 : st.curLookX > -0.17 ? 0 : -1;
  } else {
    st.wantYaw = st.curLookX < -0.3 ? -1 : st.curLookX < 0.17 ? 0 : 1;
  }

  if (rm) {
    st.curYaw = st.wantYaw;
  } else if (st.curYaw !== st.wantYaw) {
    const minHold = Math.abs(st.wantYaw - st.curYaw) > 1 ? 85 : 140;
    if (now - st.lastYawStepAt >= minHold) {
      st.curYaw = clamp(st.curYaw + (st.wantYaw > st.curYaw ? 1 : -1), -1, 1);
      st.lastYawStepAt = now;
      st.lastActive = now;
      if (Math.abs(st.squashVel) < 0.9) st.squashVel -= 0.65;
    }
  }
  return st.curYaw < 0 ? "idle_left" : st.curYaw > 0 ? "idle_right" : "idle";
}

export function CompanionStage({
  pack,
  state = "idle",
  cue = null,
  size = 148,
  facing = "left",
  dragging = false,
  dragVx = 0,
  dropOver = false,
  coolingProgress = 0,
  interactive = true,
  externalPointer = null,
  onDoubleClick,
  onContextMenu = null,
}) {
  const canvasRef = useRef(null);
  const [, setTick] = useState(0);
  const [imgState, setImgState] = useState("loading");
  const propsRef = useRef({});
  const initRestYaw = externalPointer ? (facing === "right" ? 1 : -1) : (facing === "right" ? 1 : 0);

  const stRef = useRef({
    curPose: state === "replying" ? "working" : state,
    prevPose: state === "replying" ? "working" : state,
    transStart: 0,
    swingAngle: 0,
    swingVel: 0,
    squashY: 1,
    squashVel: 0,
    lift: 0,
    lookX: 0,
    lookY: 0,
    curLookX: 0,
    curLookY: 0,
    lookVx: 0,
    lookVy: 0,
    near: false,
    nearFactor: 0,
    distPx: 9999,
    refLookX: 0,
    refLookY: 0,
    refDistPx: 9999,
    lastPointerMove: 0,
    baseFacing: facing,
    inAttn: false,
    attnWeight: 0,
    curYaw: initRestYaw,
    wantYaw: initRestYaw,
    lastYawStepAt: 0,
    cueKind: "",
    cueStart: 0,
    lastActive: performance.now(),
    lastDragEnd: 0,
    wasDragging: false,
  });

  propsRef.current = { pack, state, size, facing, dragging, dragVx, dropOver, coolingProgress, interactive, externalPointer };

  useEffect(() => {
    const rec = loadSheet(pack?.poseSheetUrl, (ok) => {
      setImgState(ok ? "ready" : "error");
      setTick((n) => n + 1);
    });
    if (!rec) setImgState("error");
    else if (rec.ready) setImgState("ready");
    else if (rec.failed) setImgState("error");
    else setImgState("loading");
  }, [pack?.poseSheetUrl]);

  useEffect(() => {
    if (!cue?.at) return;
    stRef.current.cueKind = cue.kind || "";
    stRef.current.cueStart = performance.now();
    stRef.current.lastActive = performance.now();
    if (cue.kind === "done" || cue.kind === "hello") stRef.current.squashVel = -2.8;
  }, [cue?.at]);

  useEffect(() => {
    if (!externalPointer || !interactive) return;
    const st = stRef.current;
    const lx = clamp(Number(externalPointer.lookX) || 0, -1, 1);
    const ly = clamp(Number(externalPointer.lookY) || 0, -1, 1);
    const nextDist = Number.isFinite(externalPointer.distPx) ? externalPointer.distPx : 9999;
    const nextNear = Boolean(externalPointer.near);
    const now = performance.now();
    const moved = Math.abs(lx - st.refLookX) > 0.015 || Math.abs(ly - st.refLookY) > 0.015 || Math.abs(nextDist - st.refDistPx) > 8;
    if (moved) {
      st.refLookX = lx; st.refLookY = ly; st.refDistPx = nextDist;
      st.lastActive = now; st.lastPointerMove = now;
    } else if (nextNear !== st.near) st.lastActive = now;
    st.lookX = lx; st.lookY = ly; st.distPx = nextDist; st.near = nextNear;
  }, [externalPointer, interactive]);

  useEffect(() => {
    if (!interactive) return;
    const onMove = (e) => {
      if (propsRef.current.externalPointer) return;
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.36;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const dist = Math.hypot(dx, dy);
      const nextDist = Math.round(dist);
      const lx = clamp(dx / Math.max(90, r.width * 0.85), -1, 1);
      const ly = clamp(dy / Math.max(90, r.height * 0.85), -1, 1);
      const nextNear = dist < Math.max(130, r.width * 1.25);
      const st = stRef.current;
      const now = performance.now();
      const moved = Math.abs(lx - st.refLookX) > 0.015 || Math.abs(ly - st.refLookY) > 0.015 || Math.abs(nextDist - st.refDistPx) > 8;
      if (moved) {
        st.refLookX = lx; st.refLookY = ly; st.refDistPx = nextDist;
        st.lastActive = now; st.lastPointerMove = now;
      } else if (nextNear !== st.near) st.lastActive = now;
      st.lookX = lx; st.lookY = ly; st.distPx = nextDist; st.near = nextNear;
    };
    const onLeave = () => {
      if (propsRef.current.externalPointer) return;
      const st = stRef.current;
      st.lookX = 0; st.lookY = 0; st.distPx = 9999; st.near = false;
      st.lastActive = performance.now();
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [interactive]);

  const onStageClick = () => {
    const p = propsRef.current;
    const st = stRef.current;
    if (!p.interactive || p.dragging || reducedMotion()) return;
    if (performance.now() - st.lastDragEnd < 180) return;
    st.squashVel = -2.2;
    st.lastActive = performance.now();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext?.("2d");
    if (!ctx) return;

    let raf = 0;
    let lastTs = performance.now();
    let lastDraw = 0;

    const frame = (now) => {
      if (document.hidden) { raf = 0; return; }
      const p = propsRef.current;
      const st = stRef.current;
      const rm = reducedMotion();
      const rec = imgCache.get(p.pack?.poseSheetUrl);
      const has3x3 = rec?.ready ? isGrid3x3(rec.img, p.pack?.poseMeta) : p.pack?.poseMeta?.grid?.[1] === 3;
      const cueElapsed = st.cueStart ? now - st.cueStart : 9999;
      const basePose = resolveBasePose(p.state, st.cueKind, cueElapsed, has3x3);
      const gazeActive = p.interactive && !rm && basePose !== "sleep";
      const tLookX = gazeActive ? st.lookX : 0;
      const tLookY = gazeActive ? st.lookY : 0;
      const tNear = gazeActive && st.near ? 1 : 0;
      const settling =
        st.curYaw !== st.wantYaw ||
        Math.abs(st.attnWeight - (st.inAttn ? 1 : 0)) > 0.01 ||
        Math.abs(st.curLookX - tLookX) > 0.004 ||
        Math.abs(st.curLookY - tLookY) > 0.004 ||
        Math.abs(st.nearFactor - tNear) > 0.01 ||
        Math.abs(st.squashY - 1) > 0.003 ||
        Math.abs(st.swingAngle) > 0.003;
      const calmIdle =
        (IDLE_FAMILY.has(st.curPose) || st.curPose === "sleep") &&
        !p.dragging && !p.dropOver && p.coolingProgress <= 0 && !settling && now - st.lastActive > 10000;
      if (calmIdle && now - lastDraw < 66) { raf = requestAnimationFrame(frame); return; }

      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      lastDraw = now;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(p.size * dpr);
      if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }

      if (st.wasDragging && !p.dragging) { st.squashVel = -4.2; st.lastDragEnd = now; }
      st.wasDragging = p.dragging;
      const targetSwing = p.dragging && !rm ? clamp((p.dragVx || 0) * -0.025, -0.384, 0.384) : 0;
      st.swingVel += ((targetSwing - st.swingAngle) * 140 - st.swingVel * 14) * dt;
      st.swingAngle = clamp(st.swingAngle + st.swingVel * dt, -0.384, 0.384);
      st.squashVel += ((1 - st.squashY) * 180 - st.squashVel * 16) * dt;
      st.squashY = clamp(st.squashY + st.squashVel * dt, 0.86, 1.12);
      st.lift += ((p.dragging ? 1 : 0) - st.lift) * Math.min(1, dt * 14);

      if (rm) {
        st.curLookX = 0; st.curLookY = 0; st.lookVx = 0; st.lookVy = 0; st.nearFactor = 0;
      } else {
        st.lookVx += ((tLookX - st.curLookX) * 180 - st.lookVx * 24) * dt;
        st.lookVy += ((tLookY - st.curLookY) * 180 - st.lookVy * 24) * dt;
        st.curLookX = clamp(st.curLookX + st.lookVx * dt, -1.1, 1.1);
        st.curLookY = clamp(st.curLookY + st.lookVy * dt, -1.1, 1.1);
        st.nearFactor += (tNear - st.nearFactor) * Math.min(1, dt * 10);
      }

      const nextPose = updateHeadTurn(st, p, now, dt, rm, gazeActive, has3x3, basePose);
      if (st.curPose !== nextPose) {
        const sameSeatedFamily = IDLE_FAMILY.has(st.curPose) && IDLE_FAMILY.has(nextPose);
        st.prevPose = st.curPose;
        st.curPose = nextPose;
        if (!sameSeatedFamily) st.transStart = now;
      }

      const tElapsed = now - st.transStart;
      let trY = 0, trSx = 1, trSy = 1, swapAlpha = 1, usePrev = false;
      if (st.transStart > 0 && tElapsed < 240) {
        if (tElapsed < 65) {
          const u = tElapsed / 65; trSy = 1 - 0.05 * u; trSx = 1 + 0.035 * u; usePrev = true;
        } else if (tElapsed < 150) {
          const u = (tElapsed - 65) / 85; trY = -p.size * 0.028 * Math.sin(u * Math.PI);
          trSy = 0.96 + 0.06 * u; trSx = 1.02 - 0.025 * u; swapAlpha = u;
        } else {
          const u = (tElapsed - 150) / 90; const b = Math.sin(u * Math.PI) * (1 - u);
          trSy = 1 - 0.04 * b; trSx = 1 + 0.03 * b;
        }
      }
      const errShake = st.cueKind === "error" && cueElapsed < 320 && !rm
        ? Math.sin((cueElapsed / 320) * Math.PI * 5) * (1 - cueElapsed / 320) * p.size * 0.045
        : 0;
      const rippleP = (st.cueKind === "done" || st.cueKind === "hello") && cueElapsed < 520 ? cueElapsed / 520 : -1;
      const accRgb = p.pack?.accentColor ? parseHexRgb(p.pack.accentColor, [159, 232, 112]) : readTokenRgb(canvas, "--accent", [159, 232, 112]);
      const ambRgb = readTokenRgb(canvas, "--amber", [245, 166, 35]);

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, p.size, p.size);
      drawAmbientFx(ctx, p.size, basePose, now / 1000, { accent: accRgb, amber: ambRgb }, p.dropOver, p.coolingProgress, st.squashY * trSy, st.nearFactor);
      if (rippleP >= 0) {
        ctx.strokeStyle = rgbAlpha(accRgb, (1 - rippleP) * 0.55);
        ctx.lineWidth = Math.max(1, p.size * 0.01);
        ctx.beginPath();
        ctx.ellipse(p.size * 0.5, p.size * 0.885, p.size * (0.24 + rippleP * 0.14), p.size * (0.07 + rippleP * 0.045), 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (rec?.ready) {
        const activePose = usePrev ? st.prevPose : st.curPose;
        const flipSign = has3x3 ? (activePose === "working" && p.facing === "left" ? -1 : 1) : (p.facing === "left" ? -1 : 1);
        const sx = flipSign * trSx * (1 + (1 - st.squashY) * 0.42);
        const sy = st.squashY * trSy;
        ctx.save();
        if (basePose === "sleep") ctx.globalAlpha = 0.88;
        ctx.translate(p.size * 0.5 + errShake, p.size * 0.24 + trY - st.lift * p.size * 0.045);
        ctx.rotate(st.swingAngle);
        ctx.translate(0, p.size * 0.64);
        ctx.scale(sx, sy);
        ctx.translate(-p.size * 0.5, -p.size * 0.88);
        const gazeScale = rm ? 0 : (p.pack?.motionPersonality === "minimal" ? 0.65 : 1);
        const residualX = has3x3 && IDLE_FAMILY.has(activePose)
          ? clamp(st.curLookX - st.curYaw * 0.46, -0.7, 0.7)
          : clamp(st.curLookX * flipSign, -0.75, 0.75);
        const drawOpts = {
          motionScale: rm ? 0 : (MOTION_MULT[p.pack?.motionPersonality] ?? 0.72),
          gazeScale,
          residualLookX: residualX,
          lookY: st.curLookY,
          attnWeight: st.attnWeight,
        };
        if (usePrev) drawRigidSculpturePose(ctx, rec.img, st.prevPose, p.pack?.poseMeta, p.size, now / 1000, drawOpts);
        else {
          if (swapAlpha < 0.99) {
            ctx.globalAlpha *= 1 - swapAlpha;
            drawRigidSculpturePose(ctx, rec.img, st.prevPose, p.pack?.poseMeta, p.size, now / 1000, drawOpts);
            ctx.globalAlpha = basePose === "sleep" ? 0.88 * swapAlpha : swapAlpha;
          }
          drawRigidSculpturePose(ctx, rec.img, st.curPose, p.pack?.poseMeta, p.size, now / 1000, drawOpts);
        }
        ctx.restore();
      }
      ctx.restore();
      raf = requestAnimationFrame(frame);
    };

    const onVis = () => { if (!document.hidden && !raf) { lastTs = performance.now(); raf = requestAnimationFrame(frame); } };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => { document.removeEventListener("visibilitychange", onVis); if (raf) cancelAnimationFrame(raf); };
  }, [imgState]);

  const stageStyle = { "--s": size + "px" };
  const domPose = state === "replying" ? "working" : (POSE_INDEX_3X3[state] ? state : "idle");
  if (imgState === "error" && (pack?.portraitUrl || pack?.poseSheetUrl)) {
    return html`<div class="comp-stage" style=${stageStyle} data-interactive=${interactive ? "1" : undefined} data-dragging=${dragging ? "1" : undefined} onClick=${onStageClick} onDblClick=${onDoubleClick} onContextMenu=${onContextMenu || undefined} aria-hidden="true">
      <img class="comp-stage-fallback" src=${pack.portraitUrl || pack.poseSheetUrl} alt="" />
    </div>`;
  }
  return html`<div class="comp-stage" style=${stageStyle} data-pose=${domPose} data-interactive=${interactive ? "1" : undefined} data-dragging=${dragging ? "1" : undefined} onClick=${onStageClick} onDblClick=${onDoubleClick} onContextMenu=${onContextMenu || undefined} aria-hidden="true">
    <canvas ref=${canvasRef} class="comp-stage-canvas"></canvas>
  </div>`;
}
