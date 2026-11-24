import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { html, Icon, Button } from "./components/ui.js";
import { BotAvatar, loadAvatarStudio, useAvatarStudio } from "./components/avatar.js";
import { api } from "./lib/api.js";
import { t, useLang, adoptServerLang } from "./lib/i18n.js";

function CompanionApp() {
  useLang();
  const studio = useAvatarStudio(true);
  const [wb, setWb] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [lastPrompt, setLastPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [notice, setNotice] = useState("");
  const [donePill, setDonePill] = useState(null);
  const [dropHandoff, setDropHandoff] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quietMode, setQuietMode] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(false);
  const [ctx, setCtx] = useState({ dockEdge: "bottom", facing: "left", dockMode: "screen" });
  const [extPtr, setExtPtr] = useState(null);
  const [mainMirror, setMainMirror] = useState(null);
  const [dragUi, setDragUi] = useState({ dragging: false, vx: 0 });
  const [demoCue, setDemoCue] = useState(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);
  const bcRef = useRef(null);
  const menuRef = useRef(null);
  const expandedRef = useRef(false);
  const quietRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const lastByKindRef = useRef(new Map());
  const lastPollAtRef = useRef(0);
  const lastQuietAtRef = useRef(0);
  const onSignalRef = useRef(null);
  expandedRef.current = expanded;
  quietRef.current = quietMode;

  onSignalRef.current = (sig, fromPoll = false) => {
    if (!sig || typeof sig !== "object" || !sig.kind) return;
    const now = Date.now();
    const sigAt = Number(sig.at || 0);
    if (fromPoll) {
      if (sigAt && (sigAt < mountedAtRef.current || sigAt <= lastPollAtRef.current)) return;
      if (sig.kind === "main_state" && sigAt && now - sigAt > 8000) return;
      if (sigAt) lastPollAtRef.current = sigAt;
    }
    if (sig.kind === "toggle_quiet") {
      if (sigAt && sigAt === lastQuietAtRef.current) return;
      if (sigAt) lastQuietAtRef.current = sigAt;
      setQuietMode((v) => !v);
      return;
    }
    if (sig.kind === "studio_updated" || sig.kind === "main_state") {
      const st = typeof sig.state === "string" ? sig.state : "";
      const cue = sig.cue === "done" || sig.cue === "error" ? sig.cue : "";
      const msg = typeof sig.notice === "string" ? sig.notice.trim() : "";
      const semKey = `${sig.kind}:${st}:${cue}:${msg}`;
      const prev = lastByKindRef.current.get(sig.kind);
      if (prev && prev.semKey === semKey && now - prev.handledAt < 2500) return;
      if (fromPoll && prev && sigAt && prev.at && sigAt + 100 < prev.at) return;
      lastByKindRef.current.set(sig.kind, { semKey, at: sigAt || now, handledAt: now });
      if (sig.kind === "studio_updated") {
        void loadAvatarStudio(true);
      } else {
        setMainMirror({ state: st, cue, notice: msg, at: now });
        if (cue) setDemoCue({ kind: cue, at: now });
        if ((msg || cue === "done") && !expandedRef.current) {
          const text = msg || t("steward.companion.doneNotice");
          setDonePill({ text, hash: sig.hash || "#/chat/default", at: now });
          setTimeout(() => setDonePill((cur) => (cur && cur.at === now ? null : cur)), 3500);
        }
      }
    }
  };

  const refresh = async () => {
    const [w, a, s, ap, comp] = await Promise.all([
      api("/steward/workbench?domain=owner_private").catch(() => null),
      api("/agent").catch(() => null),
      api("/settings").catch(() => null),
      api("/approvals?status=pending").catch(() => null),
      api("/steward/companion").catch(() => null),
    ]);
    if (s?.lang) adoptServerLang(s.lang);
    if (w) setWb(w);
    if (ap && Array.isArray(ap.approvals)) setApprovals(ap.approvals);
    if (comp?.lastSignal) onSignalRef.current?.(comp.lastSignal, true);
    if (a) {
      const busyHost = Object.values(a.hosts || {}).some((h) => Number(h.activeTurns || 0) > 0);
      const busyBg = Object.values(a.background || {}).some((n) => Number(n) > 0);
      setAgentBusy(busyHost || busyBg || (a.busy || []).length > 0);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 1800);
    const offShortcut = window.sugentCompanion?.onToggleQuickBar?.(() => setExpanded((v) => !v));
    const offCtx = window.sugentCompanion?.onContext?.((d) => d && setCtx((cur) => ({ ...cur, ...d })));
    const offPtr = window.sugentCompanion?.onPointer?.((p) => p && typeof p.lookX === "number" && setExtPtr(p));
    const offSig = window.sugentCompanion?.onSignal?.((s) => onSignalRef.current?.(s));
    let bc = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        bc = new BroadcastChannel("sugent-companion-bus");
        bc.onmessage = (ev) => onSignalRef.current?.(ev?.data);
        bcRef.current = bc;
      }
    } catch { /* ignore */ }
    return () => {
      clearInterval(timer);
      offShortcut?.();
      offCtx?.();
      offPtr?.();
      offSig?.();
      try { bc?.close(); } catch { /* ignore */ }
      bcRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mainMirror?.at) return;
    const at = mainMirror.at;
    const id = setTimeout(() => setMainMirror((cur) => (cur && cur.at === at ? null : cur)), 8000);
    return () => clearTimeout(id);
  }, [mainMirror && mainMirror.at]);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setCtxMenu(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setCtxMenu(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const dispatches = wb?.concierge?.pendingDispatches || [];
  const cards = wb?.concierge?.cards || [];
  const pendingApproval = approvals.find((x) => x.kind === "approval") || approvals[0] || null;
  useEffect(() => {
    const hasRichCard = Boolean(cards.length || pendingApproval || reply || dropHandoff);
    const hasDoubleCard = Boolean(cards.length && pendingApproval) || Boolean((cards.length || pendingApproval) && (reply || dropHandoff));
    const w = expanded ? 416 : ctxMenu ? 240 : (dispatches.length > 0 || notice || donePill || dropHandoff) ? 360 : 156;
    const h = expanded ? (hasDoubleCard ? 428 : hasRichCard ? 356 : 212) : ctxMenu ? 268 : 168;
    window.sugentCompanion?.resize?.(w, h);
    if (expanded) requestAnimationFrame(() => inputRef.current?.focus());
  }, [expanded, ctxMenu, dispatches.length, cards.length, approvals.length, reply, notice, donePill, dropHandoff]);

  const showNotice = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 2600);
  };

  const openMainWindow = (hash = "#/chat/default") => {
    if (window.sugentCompanion?.openMain) {
      window.sugentCompanion.openMain(hash);
    } else {
      const target = hash.startsWith("#") ? hash : `#${hash}`;
      window.open(`/${target}`, "sugent-main");
    }
  };

  const handoff = (draftText, hash = "#/chat/default") => {
    const payload = { kind: "handoff", hash, draftText: String(draftText || ""), source: "companion", at: Date.now() };
    if (window.sugentCompanion?.handoffToMain) {
      window.sugentCompanion.handoffToMain({ hash: payload.hash, draftText: payload.draftText, source: payload.source });
    } else {
      void api("/steward/companion/signal", { method: "POST", body: payload }).catch(() => {});
    }
    try { bcRef.current?.postMessage(payload); } catch { /* ignore */ }
    setDropHandoff(null);
    setDonePill(null);
    setExpanded(false);
  };

  const sendCommand = async (e) => {
    e?.preventDefault?.();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api("/steward/converse", { method: "POST", body: { text, channel: "desktop_companion", callerDomain: "owner_private" } });
      setLastPrompt(text);
      setReply(res.reply || "");
      setPrompt("");
      await refresh();
    } catch (err) {
      showNotice(t("steward.companion.dropFailed", { err: err.message }));
    } finally { setBusy(false); }
  };

  const undoDispatch = async (d) => {
    setBusy(true);
    try {
      await api("/concierge/command", { method: "POST", body: { commandText: `/undo ${d.dispatchId}`, channel: d.channel } });
      showNotice(t("steward.hub.undoToast"));
      await refresh();
    } catch (err) {
      showNotice(err.message);
    } finally { setBusy(false); }
  };

  const decideApproval = async (row, allow) => {
    setBusy(true);
    try {
      await api(`/approvals/${encodeURIComponent(row.id)}/${allow ? "approve" : "deny"}`, { method: "POST", body: {} });
      setDemoCue({ kind: "done", at: Date.now() });
      await refresh();
    } catch (err) {
      showNotice(err.message);
    } finally { setBusy(false); }
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setDropOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    const filePaths = files.map((f) => f.path || f.name).filter(Boolean);
    const text = e.dataTransfer?.getData("text/plain") || (filePaths.length ? filePaths.join("\n") : "");
    if (!text.trim() && !filePaths.length) return;
    setBusy(true);
    try {
      const rawText = text.trim() || filePaths.join(", ");
      const res = await api("/steward/dropzone", { method: "POST", body: { text: rawText, filePaths, channel: "desktop_companion", callerDomain: "owner_private" } });
      const now = Date.now();
      const summary = res.formattedReply?.split("\n")[0] || t("steward.companion.droppedToast");
      const draftText = res.formattedReply ? `${rawText}\n\n${res.formattedReply}` : rawText;
      setDemoCue({ kind: "done", at: now });
      setDropHandoff({ summary, draftText, at: now });
      setTimeout(() => setDropHandoff((cur) => (cur && cur.at === now ? null : cur)), 8000);
      await refresh();
    } catch (err) {
      showNotice(t("steward.companion.dropFailed", { err: err.message }));
    } finally { setBusy(false); }
  };

  const approveCard = async (c, opt) => {
    setBusy(true);
    try {
      const draft = opt === "A" ? c.draftA : c.draftB;
      await api("/concierge/command", { method: "POST", body: { commandText: `/send ${opt} ${c.cardId} ${draft.confirmHash}`, channel: c.channel } });
      showNotice(t("steward.hub.sentSteadyToast"));
      await refresh();
    } catch (err) { showNotice(err.message); } finally { setBusy(false); }
  };

  const onOrbPointerDown = (e) => {
    if (e.button !== 0 || expanded) return;
    setCtxMenu(false);
    dragRef.current = { sx: e.screenX, sy: e.screenY, moved: false };
    const onMove = (ev) => {
      if (!dragRef.current) return;
      const dx = ev.screenX - dragRef.current.sx;
      const dy = ev.screenY - dragRef.current.sy;
      if (Math.hypot(dx, dy) > 3) dragRef.current.moved = true;
      if (dragRef.current.moved) {
        dragRef.current.sx = ev.screenX;
        dragRef.current.sy = ev.screenY;
        setDragUi({ dragging: true, vx: dx });
        window.sugentCompanion?.moveBy?.(dx, dy);
      }
    };
    const onUp = () => {
      const wasDrag = dragRef.current?.moved;
      dragRef.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDragUi({ dragging: false, vx: 0 });
      if (wasDrag) window.sugentCompanion?.dragEnd?.();
      else if (quietRef.current) {
        setQuietMode(false);
        setDemoCue({ kind: "hello", at: Date.now() });
      } else setExpanded((v) => !v);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onOrbContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (window.sugentCompanion?.showContextMenu) {
      window.sugentCompanion.showContextMenu({ quiet: quietMode, dockMode: ctx.dockMode || "screen" });
    } else {
      setExpanded(false);
      setCtxMenu((v) => !v);
    }
  };

  const activeName = studio?.activePack?.name || t("steward.nav.brand");
  const pendingTotal = cards.length + approvals.length;
  const mirrorState = mainMirror?.state && mainMirror.state !== "idle"
    ? (mainMirror.state === "replying" ? "working" : mainMirror.state)
    : "";
  const avatarState = (quietMode || wb?.quietHoursActive)
    ? "sleep"
    : dropOver
      ? "listening"
      : (pendingTotal > 0 || dispatches.length > 0)
        ? "waiting"
        : busy
          ? "working"
          : mirrorState
            ? mirrorState
            : agentBusy
              ? "working"
              : "idle";
  const coolingProgress = dispatches[0] ? Math.max(0, Math.min(1, (dispatches[0].remainingMs || 0) / 30000)) : 0;
  const statusText = quietMode
    ? t("steward.companion.quietActive")
    : dispatches.length > 0
      ? t("steward.companion.statusCooling", { sec: Math.ceil((dispatches[0].remainingMs || 0) / 1000) })
      : pendingTotal > 0
        ? t("steward.companion.statusWaiting", { count: pendingTotal })
        : (busy || agentBusy || mirrorState === "working" || mirrorState === "thinking")
          ? t("steward.companion.statusWorking")
          : t("steward.companion.statusIdle");
  const approvalText = pendingApproval
    ? (pendingApproval.reason || pendingApproval.taskTitle || pendingApproval.questions?.[0]?.question || pendingApproval.tool || "")
    : "";
  const approvalCmd = pendingApproval
    ? [pendingApproval.tool, pendingApproval.detail].filter(Boolean).join("  ")
    : "";
  const replyDraft = lastPrompt ? `${lastPrompt}\n\n${reply.slice(0, 400)}` : reply.slice(0, 400);

  return html`<div class=${`comp-shell${ctx.dockEdge === "left" ? " left-dock" : ""}`}
    onDragOver=${(e) => { e.preventDefault(); setDropOver(true); }}
    onDragLeave=${() => setDropOver(false)}
    onDrop=${handleDrop}>
    ${expanded && html`<div class="comp-card" role="dialog" aria-label=${activeName}>
      <div class="comp-head">
        <div class="comp-title">
          <span class="comp-name">${activeName}</span>
          <span class="comp-sub">${statusText}</span>
        </div>
        <div class="comp-actions">
          <button type="button" class="btn sm" onClick=${() => openMainWindow("#/studio")}>${t("steward.companion.openStudio")}</button>
          <button type="button" class="btn sm" onClick=${() => openMainWindow("#/steward")}>${t("steward.companion.openMain")}</button>
          <button type="button" class="icon-btn xs" title=${t("steward.companion.hideBtn")} onClick=${() => window.sugentCompanion?.hide?.()}><${Icon} name="close" size="xs" /></button>
        </div>
      </div>
      ${pendingApproval && html`<div class="comp-approval">
        <div class="comp-approval-text">${t("steward.companion.approvalLead", { summary: approvalText })}</div>
        ${approvalCmd && approvalCmd !== approvalText && html`<div class="comp-approval-cmd">${approvalCmd}</div>`}
        <div class="comp-actions">
          ${pendingApproval.kind === "approval" && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${() => decideApproval(pendingApproval, true)}>${t("steward.companion.approveAllow")}</button>`}
          ${pendingApproval.kind === "approval" && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => decideApproval(pendingApproval, false)}>${t("steward.companion.approveDeny")}</button>`}
          <button type="button" class="btn sm" onClick=${() => openMainWindow("#/needs")}>${t("steward.companion.viewNeeds")}</button>
        </div>
      </div>`}
      ${cards[0] && html`<div class="comp-approval">
        <div class="comp-approval-text">${t("steward.companion.pendingLead", { peer: cards[0].peerDisplayName, summary: String(cards[0].summary || "") })}</div>
        <div class="comp-actions">
          <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => approveCard(cards[0], "A")}>${t("steward.companion.approveBtn")}</button>
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => api("/concierge/command", { method: "POST", body: { commandText: `/ignore ${cards[0].cardId}`, channel: cards[0].channel } }).then(refresh)}>${t("steward.companion.ignoreBtn")}</button>
        </div>
      </div>`}
      ${dropHandoff && html`<div class="comp-handoff">
        <span class="comp-handoff-text">${dropHandoff.summary}</span>
        <button type="button" class="btn sm primary" onClick=${() => handoff(dropHandoff.draftText)}>${t("steward.companion.continueInMain")}</button>
      </div>`}
      ${reply && html`<div class="comp-reply-wrap">
        <div class="comp-reply">${reply}</div>
        <div class="comp-reply-foot">
          <button type="button" class="btn sm" onClick=${() => handoff(replyDraft)}>${t("steward.companion.continueInMain")}</button>
        </div>
      </div>`}
      <form class="comp-compose" onSubmit=${sendCommand}>
        <input ref=${inputRef} class="field" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder=${t("steward.companion.inputPlaceholder")} />
        <${Button} type="submit" variant="primary" size="sm" loading=${busy} disabled=${!prompt.trim()}>${t("steward.companion.sendBtn")}<//>
      </form>
    </div>`}
    ${ctxMenu && !expanded && html`<div ref=${menuRef} class="comp-ctx-menu" role="menu">
      <button type="button" class="comp-ctx-item" role="menuitem" onClick=${() => { setCtxMenu(false); setExpanded(true); }}>${t("steward.companion.menuQuickBar")}</button>
      <button type="button" class="comp-ctx-item" role="menuitem" onClick=${() => { setCtxMenu(false); openMainWindow("#/chat/default"); }}>${t("steward.companion.menuMain")}</button>
      <button type="button" class="comp-ctx-item" role="menuitem" onClick=${() => { setCtxMenu(false); openMainWindow("#/steward"); }}>${t("steward.companion.menuHub")}</button>
      <button type="button" class="comp-ctx-item" role="menuitem" onClick=${() => { setCtxMenu(false); openMainWindow("#/studio"); }}>${t("steward.companion.menuStudio")}</button>
      <div class="comp-ctx-sep"></div>
      <button type="button" class="comp-ctx-item" role="menuitem" onClick=${() => { setCtxMenu(false); setQuietMode((v) => !v); }}>${quietMode ? t("steward.companion.menuQuietOff") : t("steward.companion.menuQuietOn")}</button>
      <button type="button" class="comp-ctx-item danger" role="menuitem" onClick=${() => { setCtxMenu(false); window.sugentCompanion?.hide?.(); }}>${t("steward.companion.menuHide")}</button>
    </div>`}
    <div class="comp-dock-row">
      ${notice && html`<div class="comp-toast">${notice}</div>`}
      ${!expanded && dispatches.length > 0 && html`<div class="comp-pill cooling">
        <span>${t("steward.hub.coolingLead", { sec: Math.ceil((dispatches[0].remainingMs || 0) / 1000), peer: dispatches[0].peerDisplayName })}</span>
        <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => undoDispatch(dispatches[0])}>${t("steward.hub.undoNow")}</button>
      </div>`}
      ${!expanded && !dispatches.length && dropHandoff && html`<div class="comp-pill handoff">
        <span class="comp-pill-text">${dropHandoff.summary}</span>
        <button type="button" class="btn sm primary" onClick=${() => handoff(dropHandoff.draftText)}>${t("steward.companion.continueInMain")}</button>
      </div>`}
      ${!expanded && !dispatches.length && !dropHandoff && donePill && html`<button type="button" class="comp-pill done-pill" onClick=${() => { setDonePill(null); openMainWindow(donePill.hash || "#/chat/default"); }}>
        <span class="comp-pill-text">${donePill.text}</span>
      </button>`}
      ${!expanded && dropOver && !notice && html`<div class="comp-pill">${t("steward.companion.dropPrompt")}</div>`}
      <div class=${`comp-orb${dropOver ? " drop-over" : ""}`} onPointerDown=${onOrbPointerDown} onContextMenu=${onOrbContextMenu} onClick=${() => expanded && setExpanded(false)} title=${statusText}>
        <${BotAvatar}
          useActivePack
          size=${140}
          state=${avatarState}
          cue=${demoCue}
          facing=${ctx.facing}
          dragging=${dragUi.dragging}
          dragVx=${dragUi.vx}
          dropOver=${dropOver}
          coolingProgress=${coolingProgress}
          externalPointer=${extPtr}
          lively
          pokeable
          onContextMenu=${onOrbContextMenu}
          onDoubleClick=${() => setDemoCue({ kind: "hello", at: Date.now() })}
        />
      </div>
    </div>
  </div>`;
}

render(html`<${CompanionApp} />`, document.getElementById("companion-app"));
void import("./lib/hot-reload.js").then((m) => m.connectHotReload()).catch(() => {});
