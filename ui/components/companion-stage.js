import { useEffect, useRef, useState } from "preact/hooks";
import { html } from "./ui.js";
import { reducedMotion } from "../design/motion.js";

const POSE_INDEX = {
  idle: [0, 0],
  listening: [1, 0],
  thinking: [2, 0],
  working: [0, 1],
  waiting: [1, 1],
  sleep: [2, 1],
};
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
const smoothstep = (x, e0, e1) => {
  const t = clamp((x - e0) / Math.max(0.0001, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

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

function resolvePose(state) {
  if (state === "replying") return "working";
  return POSE_INDEX[state] ? state : "idle";
}

function drawPoseWithBands(ctx, img, poseKey, poseMeta, size, tSec, opts) {
  const cellW = img.naturalWidth / 3;
  const cellH = img.naturalHeight / 2;
  if (!cellW || !cellH) return;
  const [col, row] = POSE_INDEX[poseKey] || [0, 0];
  const sx0 = col * cellW;
  const sy0 = row * cellH;
  const cm = poseMeta?.cells?.[poseKey] || {};
  const base = clamp(cm.baselineY || 0.88, 0.72, 0.96);
  const headEnd = clamp(cm.headEndY || 0.44, 0.25, base - 0.16);
  const torsoEnd = clamp(cm.torsoEndY || 0.72, headEnd + 0.12, base - 0.06);
  const mult = opts.motionScale;
  const gazeScale = opts.gazeScale ?? 1;
  const lookX = opts.lookX;
  const lookY = opts.lookY;
  const nearAmt = opts.nearFactor > 0.05 ? clamp((opts.nearFactor - 0.05) / 0.95, 0, 1) : 0;
  const step = 2;
  const cx = size * 0.5;
  const neckY = headEnd * size;

  const breathePeriod = poseKey === "sleep" ? 4.6 : 3.8;
  const breathe = Math.sin((tSec * Math.PI * 2) / breathePeriod);
  const thinkTilt = poseKey === "thinking" ? Math.sin((tSec * Math.PI * 2) / 3.8) : 0;
  const workTap = poseKey === "working" ? Math.sin(tSec * 9.5) : 0;
  const waitPulse = poseKey === "waiting" ? Math.pow(Math.max(0, Math.sin((tSec * Math.PI * 2) / 2.6)), 3) : 0;
  const listenLean = poseKey === "listening" ? 1 : 0;
  const idleSway = poseKey === "idle" ? Math.sin((tSec * Math.PI * 2) / 4.2) : 0;

  const maxTiltRad = (7.5 * Math.PI) / 180;
  const headTiltRad = clamp(
    (lookX * 6.5 - lookX * lookY * 1.0) * (Math.PI / 180) * gazeScale + thinkTilt * (2.2 * Math.PI / 180) * mult,
    -maxTiltRad,
    maxTiltRad,
  );
  const torsoFollow = lookX * (0.068 * 0.28) * gazeScale;
  const nearLean = lookX * 0.022 * nearAmt * gazeScale;

  for (let dy = Math.floor((size - 0.01) / step) * step; dy >= 0; dy -= step) {
    const ny = (dy + step * 0.5) / size;
    const headW = 1 - smoothstep(ny, headEnd - 0.06, headEnd + 0.08);
    const torsoW = smoothstep(ny, headEnd - 0.1, headEnd + 0.06) * (1 - smoothstep(ny, torsoEnd - 0.06, torsoEnd + 0.1));
    const legsW = smoothstep(ny, torsoEnd - 0.05, torsoEnd + 0.08);
    const pinGround = clamp((base - ny) / Math.max(0.08, base), 0, 1);
    const torsoPin = clamp((base - ny) / Math.max(0.12, base - headEnd), 0, 1);

    const breatheY = breathe * (0.011 * torsoW + 0.007 * headW) * pinGround * mult;
    const nodY = (listenLean * 0.006 * Math.sin(tSec * 2.4) + workTap * 0.004 - waitPulse * 0.016) * (headW + torsoW * 0.4) * pinGround * mult;
    const gazeY = lookY * 0.032 * headW * gazeScale;
    const headShiftX = lookX * 0.068 * headW * gazeScale;
    const motionShiftX =
      (thinkTilt * 0.014 * headW +
        listenLean * 0.014 * (headW + torsoW * 0.5) +
        idleSway * 0.009 * legsW +
        opts.dropLean * 0.028) *
      pinGround *
      mult;
    const shiftX = (headShiftX + torsoFollow * torsoW * torsoPin + nearLean * pinGround + motionShiftX) * size;
    const scaleX = 1 + breathe * 0.012 * torsoW * pinGround * mult;

    const sy = sy0 + clamp(ny - breatheY - nodY - gazeY, 0, 0.995) * cellH;
    const sh = Math.min(cellH - (sy - sy0), (step / size) * cellH);
    if (sh <= 0) continue;
    const dw = size * scaleX;
    const alpha = headTiltRad * headW;
    if (Math.abs(alpha) > 0.0015) {
      const relY = dy + step * 0.5 - neckY;
      const rotX = -relY * Math.sin(alpha);
      const rotY = relY * (Math.cos(alpha) - 1);
      ctx.save();
      ctx.translate(cx + shiftX + rotX, dy + step * 0.5 + rotY);
      ctx.rotate(alpha);
      ctx.drawImage(img, sx0, sy, cellW, sh, -dw * 0.5, -step * 0.5, dw, step + 1.05);
      ctx.restore();
    } else {
      const dx = (size - dw) * 0.5 + shiftX;
      ctx.drawImage(img, sx0, sy, cellW, sh, dx, dy, dw, step + 0.45);
    }
  }
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

function updateAutoTurn(st, p, now, rm, gazeActive) {
  if (p.facing !== st.baseFacing) {
    st.baseFacing = p.facing;
    st.autoTurnFacing = "";
    st.oppSideSince = 0;
  }
  if (!gazeActive || p.dragging) {
    st.autoTurnFacing = "";
    st.oppSideSince = 0;
  } else {
    const ptrIdle = !st.lastPointerMove || now - st.lastPointerMove > 2600;
    const ptrFar = st.distPx >= 520;
    if (ptrIdle || ptrFar) {
      st.oppSideSince = 0;
      if (st.autoTurnFacing) {
        st.autoTurnFacing = "";
        st.lastActive = now;
      }
    } else {
      const effFacing = st.autoTurnFacing || p.facing;
      const curSide = st.curLookX > 0.34 ? "right" : st.curLookX < -0.34 ? "left" : "";
      if (curSide && curSide !== effFacing) {
        if (!st.oppSideSince) st.oppSideSince = now;
        else if (now - st.oppSideSince > 360) {
          st.autoTurnFacing = curSide === p.facing ? "" : curSide;
          st.oppSideSince = 0;
          st.lastActive = now;
        }
      } else {
        st.oppSideSince = 0;
      }
    }
  }
  const targetSign = (st.autoTurnFacing || p.facing) === "right" ? -1 : 1;
  if (rm) {
    st.turnScaleX = targetSign;
    st.turnTargetSign = targetSign;
    st.turnStart = 0;
    return;
  }
  if (targetSign !== st.turnTargetSign) {
    st.turnFromSign = st.turnScaleX;
    st.turnTargetSign = targetSign;
    st.turnStart = now;
  }
  if (st.turnStart > 0) {
    const u = clamp((now - st.turnStart) / 140, 0, 1);
    const ease = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
    st.turnScaleX = st.turnFromSign + (st.turnTargetSign - st.turnFromSign) * ease;
    if (u >= 1) {
      st.turnScaleX = st.turnTargetSign;
      st.turnStart = 0;
    }
  }
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
  const nextPose = resolvePose(state);
  const initSign = facing === "right" ? -1 : 1;

  const stRef = useRef({
    curPose: nextPose,
    prevPose: nextPose,
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
    autoTurnFacing: "",
    oppSideSince: 0,
    turnScaleX: initSign,
    turnFromSign: initSign,
    turnTargetSign: initSign,
    turnStart: 0,
    cueKind: "",
    cueStart: 0,
    lastActive: performance.now(),
    lastDragEnd: 0,
    wasDragging: false,
  });

  propsRef.current = { pack, nextPose, size, facing, dragging, dragVx, dropOver, coolingProgress, interactive, externalPointer };

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
    const st = stRef.current;
    st.lastActive = performance.now();
    if (st.curPose !== nextPose) {
      st.prevPose = st.curPose;
      st.curPose = nextPose;
      st.transStart = performance.now();
    }
  }, [nextPose]);

  useEffect(() => {
    if (!cue?.at) return;
    stRef.current.cueKind = cue.kind || "";
    stRef.current.cueStart = performance.now();
    stRef.current.lastActive = performance.now();
    if (cue.kind === "done" || cue.kind === "hello") stRef.current.squashVel = -3.2;
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
      st.refLookX = lx;
      st.refLookY = ly;
      st.refDistPx = nextDist;
      st.lastActive = now;
      st.lastPointerMove = now;
    } else if (nextNear !== st.near) {
      st.lastActive = now;
    }
    st.lookX = lx;
    st.lookY = ly;
    st.distPx = nextDist;
    st.near = nextNear;
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
      const nextNear = dist < Math.max(120, r.width * 1.15);
      const st = stRef.current;
      const now = performance.now();
      const moved = Math.abs(lx - st.refLookX) > 0.015 || Math.abs(ly - st.refLookY) > 0.015 || Math.abs(nextDist - st.refDistPx) > 8;
      if (moved) {
        st.refLookX = lx;
        st.refLookY = ly;
        st.refDistPx = nextDist;
        st.lastActive = now;
        st.lastPointerMove = now;
      } else if (nextNear !== st.near) {
        st.lastActive = now;
      }
      st.lookX = lx;
      st.lookY = ly;
      st.distPx = nextDist;
      st.near = nextNear;
    };
    const onLeave = () => {
      if (propsRef.current.externalPointer) return;
      const st = stRef.current;
      st.lookX = 0;
      st.lookY = 0;
      st.distPx = 9999;
      st.near = false;
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
      const gazeActive = p.interactive && !rm && st.curPose !== "sleep";
      const tLookX = gazeActive ? st.lookX : 0;
      const tLookY = gazeActive ? st.lookY : 0;
      const tNear = gazeActive && st.near ? 1 : 0;
      const settling =
        p.facing !== st.baseFacing ||
        st.turnStart > 0 ||
        st.oppSideSince > 0 ||
        Math.abs(st.curLookX - tLookX) > 0.004 ||
        Math.abs(st.curLookY - tLookY) > 0.004 ||
        Math.abs(st.nearFactor - tNear) > 0.01 ||
        Math.abs(st.squashY - 1) > 0.003 ||
        Math.abs(st.swingAngle) > 0.003;
      const calmIdle =
        (st.curPose === "idle" || st.curPose === "sleep") &&
        !p.dragging &&
        !p.dropOver &&
        p.coolingProgress <= 0 &&
        !settling &&
        now - st.lastActive > 10000;
      if (calmIdle && now - lastDraw < 66) { raf = requestAnimationFrame(frame); return; }

      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      lastDraw = now;

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(p.size * dpr);
      if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }

      if (st.wasDragging && !p.dragging) {
        st.squashVel = -4.2;
        st.lastDragEnd = now;
      }
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
      updateAutoTurn(st, p, now, rm, gazeActive);

      const tElapsed = now - st.transStart;
      let trY = 0, trSx = 1, trSy = 1, swapAlpha = 1, usePrev = false;
      if (st.transStart > 0 && tElapsed < 260) {
        if (tElapsed < 70) {
          const u = tElapsed / 70;
          trSy = 1 - 0.06 * u; trSx = 1 + 0.04 * u; usePrev = true;
        } else if (tElapsed < 160) {
          const u = (tElapsed - 70) / 90;
          trY = -p.size * 0.032 * Math.sin(u * Math.PI);
          trSy = 0.96 + 0.07 * u; trSx = 1.02 - 0.03 * u; swapAlpha = u; usePrev = false;
        } else {
          const u = (tElapsed - 160) / 100;
          const b = Math.sin(u * Math.PI) * (1 - u);
          trSy = 1 - 0.05 * b; trSx = 1 + 0.035 * b;
        }
      }

      const cueElapsed = st.cueStart ? now - st.cueStart : 9999;
      let errShake = 0, rippleP = -1;
      if (st.cueKind === "error" && cueElapsed < 320 && !rm) {
        errShake = Math.sin((cueElapsed / 320) * Math.PI * 5) * (1 - cueElapsed / 320) * p.size * 0.045;
      }
      if ((st.cueKind === "done" || st.cueKind === "hello") && cueElapsed < 520) rippleP = cueElapsed / 520;

      const accRgb = p.pack?.accentColor ? parseHexRgb(p.pack.accentColor, [159, 232, 112]) : readTokenRgb(canvas, "--accent", [159, 232, 112]);
      const ambRgb = readTokenRgb(canvas, "--amber", [245, 166, 35]);

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, p.size, p.size);
      drawAmbientFx(ctx, p.size, st.curPose, now / 1000, { accent: accRgb, amber: ambRgb }, p.dropOver, p.coolingProgress, st.squashY * trSy, st.nearFactor);

      if (rippleP >= 0) {
        ctx.strokeStyle = rgbAlpha(accRgb, (1 - rippleP) * 0.55);
        ctx.lineWidth = Math.max(1, p.size * 0.01);
        ctx.beginPath();
        ctx.ellipse(p.size * 0.5, p.size * 0.885, p.size * (0.24 + rippleP * 0.14), p.size * (0.07 + rippleP * 0.045), 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      const rec = imgCache.get(p.pack?.poseSheetUrl);
      if (rec?.ready) {
        const flipSign = st.turnScaleX < 0 ? -1 : 1;
        const safeTurnX = Math.abs(st.turnScaleX) < 0.03 ? flipSign * 0.03 : st.turnScaleX;
        const sx = safeTurnX * trSx * (1 + (1 - st.squashY) * 0.45);
        const sy = st.squashY * trSy;
        ctx.save();
        if (st.curPose === "sleep") ctx.globalAlpha = 0.88;
        ctx.translate(p.size * 0.5 + errShake, p.size * 0.24 + trY - st.lift * p.size * 0.045);
        ctx.rotate(st.swingAngle);
        ctx.translate(0, p.size * 0.64);
        ctx.scale(sx, sy);
        ctx.translate(-p.size * 0.5, -p.size * 0.88);
        const gazeScale = rm ? 0 : (p.pack?.motionPersonality === "minimal" ? 0.65 : 1);
        const bandOpts = {
          motionScale: rm ? 0 : (MOTION_MULT[p.pack?.motionPersonality] ?? 0.72),
          gazeScale,
          lookX: st.curLookX * flipSign,
          lookY: st.curLookY,
          nearFactor: st.nearFactor,
          dropLean: p.dropOver ? 1 : 0,
        };
        if (usePrev) drawPoseWithBands(ctx, rec.img, st.prevPose, p.pack?.poseMeta, p.size, now / 1000, bandOpts);
        else {
          if (swapAlpha < 0.99) { ctx.globalAlpha *= 1 - swapAlpha; drawPoseWithBands(ctx, rec.img, st.prevPose, p.pack?.poseMeta, p.size, now / 1000, bandOpts); ctx.globalAlpha = st.curPose === "sleep" ? 0.88 * swapAlpha : swapAlpha; }
          drawPoseWithBands(ctx, rec.img, st.curPose, p.pack?.poseMeta, p.size, now / 1000, bandOpts);
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
  if (imgState === "error" && (pack?.portraitUrl || pack?.poseSheetUrl)) {
    return html`<div class="comp-stage" style=${stageStyle} data-interactive=${interactive ? "1" : undefined} data-dragging=${dragging ? "1" : undefined} onClick=${onStageClick} onDblClick=${onDoubleClick} onContextMenu=${onContextMenu || undefined} aria-hidden="true">
      <img class="comp-stage-fallback" src=${pack.portraitUrl || pack.poseSheetUrl} alt="" />
    </div>`;
  }
  return html`<div class="comp-stage" style=${stageStyle} data-pose=${nextPose} data-interactive=${interactive ? "1" : undefined} data-dragging=${dragging ? "1" : undefined} onClick=${onStageClick} onDblClick=${onDoubleClick} onContextMenu=${onContextMenu || undefined} aria-hidden="true">
    <canvas ref=${canvasRef} class="comp-stage-canvas"></canvas>
  </div>`;
}
