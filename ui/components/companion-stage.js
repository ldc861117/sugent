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
  const headEnd = cm.headEndY || 0.44;
  const torsoEnd = cm.torsoEndY || 0.72;
  const base = cm.baselineY || 0.88;
  const mult = opts.motionScale;
  const lookX = opts.lookX;
  const lookY = opts.lookY;
  const step = 2;

  const breathePeriod = poseKey === "sleep" ? 4.6 : 3.8;
  const breathe = Math.sin((tSec * Math.PI * 2) / breathePeriod);
  const thinkTilt = poseKey === "thinking" ? Math.sin((tSec * Math.PI * 2) / 3.8) : 0;
  const workTap = poseKey === "working" ? Math.sin(tSec * 9.5) : 0;
  const waitPulse = poseKey === "waiting" ? Math.pow(Math.max(0, Math.sin((tSec * Math.PI * 2) / 2.6)), 3) : 0;
  const listenLean = poseKey === "listening" ? 1 : 0;
  const idleSway = poseKey === "idle" ? Math.sin((tSec * Math.PI * 2) / 4.2) : 0;

  for (let dy = 0; dy < size; dy += step) {
    const ny = (dy + step * 0.5) / size;
    const headW = 1 - smoothstep(ny, headEnd - 0.08, headEnd + 0.08);
    const torsoW = smoothstep(ny, headEnd - 0.1, headEnd + 0.06) * (1 - smoothstep(ny, torsoEnd - 0.06, torsoEnd + 0.1));
    const legsW = smoothstep(ny, torsoEnd - 0.05, torsoEnd + 0.08);
    const pinGround = clamp((base - ny) / Math.max(0.08, base), 0, 1);

    const breatheY = breathe * (0.011 * torsoW + 0.007 * headW) * pinGround * mult;
    const nodY = (listenLean * 0.006 * Math.sin(tSec * 2.4) + workTap * 0.004 - waitPulse * 0.016) * (headW + torsoW * 0.4) * mult;
    const gazeY = lookY * 0.008 * headW * mult;
    const shiftX =
      (lookX * 0.022 * headW +
        thinkTilt * 0.016 * headW +
        listenLean * 0.014 * (headW + torsoW * 0.5) +
        idleSway * 0.009 * legsW * pinGround +
        opts.dropLean * 0.028 * pinGround) *
      size *
      mult;
    const scaleX = 1 + breathe * 0.012 * torsoW * mult;

    const sy = sy0 + clamp(ny - breatheY - nodY - gazeY, 0, 0.995) * cellH;
    const sh = Math.min(cellH - (sy - sy0), (step / size) * cellH);
    if (sh <= 0) continue;
    const dw = size * scaleX;
    const dx = (size - dw) * 0.5 + shiftX;
    ctx.drawImage(img, sx0, sy, cellW, sh, dx, dy, dw, step + 0.45);
  }
}

function drawAmbientFx(ctx, size, poseKey, tSec, rgb, dropOver, coolProg, squash) {
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
  onDoubleClick,
}) {
  const canvasRef = useRef(null);
  const [, setTick] = useState(0);
  const [imgState, setImgState] = useState("loading");
  const propsRef = useRef({});
  const nextPose = resolvePose(state);

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
    cueKind: "",
    cueStart: 0,
    lastActive: performance.now(),
    wasDragging: false,
  });

  propsRef.current = { pack, nextPose, size, facing, dragging, dragVx, dropOver, coolingProgress, interactive };

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
    if (!interactive) return;
    const onMove = (e) => {
      const el = canvasRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width * 0.5;
      const cy = r.top + r.height * 0.45;
      stRef.current.lookX = clamp((e.clientX - cx) / Math.max(120, r.width * 2), -1, 1);
      stRef.current.lookY = clamp((e.clientY - cy) / Math.max(120, r.height * 2), -1, 1);
      stRef.current.lastActive = performance.now();
    };
    const onLeave = () => {
      stRef.current.lookX = 0;
      stRef.current.lookY = 0;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [interactive]);

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
      const calmIdle = (st.curPose === "idle" || st.curPose === "sleep") && !p.dragging && !p.dropOver && p.coolingProgress <= 0 && now - st.lastActive > 10000;
      if (calmIdle && now - lastDraw < 66) { raf = requestAnimationFrame(frame); return; }

      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      lastDraw = now;

      const rm = reducedMotion();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const px = Math.round(p.size * dpr);
      if (canvas.width !== px || canvas.height !== px) { canvas.width = px; canvas.height = px; }

      if (st.wasDragging && !p.dragging) st.squashVel = -4.2;
      st.wasDragging = p.dragging;
      const targetSwing = p.dragging && !rm ? clamp((p.dragVx || 0) * -0.025, -0.384, 0.384) : 0;
      st.swingVel += ((targetSwing - st.swingAngle) * 140 - st.swingVel * 14) * dt;
      st.swingAngle = clamp(st.swingAngle + st.swingVel * dt, -0.384, 0.384);

      st.squashVel += ((1 - st.squashY) * 180 - st.squashVel * 16) * dt;
      st.squashY = clamp(st.squashY + st.squashVel * dt, 0.86, 1.12);
      st.lift += ((p.dragging ? 1 : 0) - st.lift) * Math.min(1, dt * 14);

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
      drawAmbientFx(ctx, p.size, st.curPose, now / 1000, { accent: accRgb, amber: ambRgb }, p.dropOver, p.coolingProgress, st.squashY * trSy);

      if (rippleP >= 0) {
        ctx.strokeStyle = rgbAlpha(accRgb, (1 - rippleP) * 0.55);
        ctx.lineWidth = Math.max(1, p.size * 0.01);
        ctx.beginPath();
        ctx.ellipse(p.size * 0.5, p.size * 0.885, p.size * (0.24 + rippleP * 0.14), p.size * (0.07 + rippleP * 0.045), 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      const rec = imgCache.get(p.pack?.poseSheetUrl);
      if (rec?.ready) {
        const sx = (p.facing === "right" ? -1 : 1) * trSx * (1 + (1 - st.squashY) * 0.45);
        const sy = st.squashY * trSy;
        ctx.save();
        if (st.curPose === "sleep") ctx.globalAlpha = 0.88;
        ctx.translate(p.size * 0.5 + errShake, p.size * 0.24 + trY - st.lift * p.size * 0.045);
        ctx.rotate(st.swingAngle);
        ctx.translate(0, p.size * 0.64);
        ctx.scale(sx, sy);
        ctx.translate(-p.size * 0.5, -p.size * 0.88);
        const bandOpts = { motionScale: rm ? 0 : (MOTION_MULT[p.pack?.motionPersonality] ?? 0.72), lookX: st.lookX * (p.facing === "right" ? -1 : 1), lookY: st.lookY, dropLean: p.dropOver ? 1 : 0 };
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

  if (imgState === "error" && (pack?.portraitUrl || pack?.poseSheetUrl)) {
    return html`<div class="comp-stage" style=${{ "--s": size + "px" }} onDblClick=${onDoubleClick} aria-hidden="true">
      <img class="comp-stage-fallback" src=${pack.portraitUrl || pack.poseSheetUrl} alt="" />
    </div>`;
  }
  return html`<div class="comp-stage" style=${{ "--s": size + "px" }} data-pose=${nextPose} onDblClick=${onDoubleClick} aria-hidden="true">
    <canvas ref=${canvasRef} class="comp-stage-canvas"></canvas>
  </div>`;
}
