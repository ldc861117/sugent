import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { html, Icon, Button } from "./components/ui.js";
import { BotAvatar, useAvatarStudio } from "./components/avatar.js";
import { api } from "./lib/api.js";
import { t, useLang, adoptServerLang } from "./lib/i18n.js";

function CompanionApp() {
  useLang();
  const studio = useAvatarStudio(true);
  const [wb, setWb] = useState(null);
  const [agentBusy, setAgentBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dropOver, setDropOver] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [reply, setReply] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ctx, setCtx] = useState({ dockEdge: "bottom", facing: "left" });
  const [dragUi, setDragUi] = useState({ dragging: false, vx: 0 });
  const [demoCue, setDemoCue] = useState(null);
  const inputRef = useRef(null);
  const dragRef = useRef(null);

  const refresh = async () => {
    const [w, a, s] = await Promise.all([
      api("/steward/workbench?domain=owner_private").catch(() => null),
      api("/agent").catch(() => null),
      api("/settings").catch(() => null),
    ]);
    if (s?.lang) adoptServerLang(s.lang);
    if (w) setWb(w);
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
    return () => { clearInterval(timer); offShortcut?.(); offCtx?.(); };
  }, []);

  const dispatches = wb?.concierge?.pendingDispatches || [];
  const cards = wb?.concierge?.cards || [];
  useEffect(() => {
    const w = expanded ? 416 : (dispatches.length > 0 || notice) ? 336 : 156;
    const h = expanded ? (cards.length || reply ? 336 : 212) : 168;
    window.sugentCompanion?.resize?.(w, h);
    if (expanded) requestAnimationFrame(() => inputRef.current?.focus());
  }, [expanded, dispatches.length, cards.length, reply, notice]);

  const showNotice = (msg) => {
    setNotice(msg);
    setTimeout(() => setNotice((cur) => (cur === msg ? "" : cur)), 2600);
  };

  const sendCommand = async (e) => {
    e?.preventDefault?.();
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api("/steward/converse", { method: "POST", body: { text, channel: "desktop_companion", callerDomain: "owner_private" } });
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

  const handleDrop = async (e) => {
    e.preventDefault();
    setDropOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    const filePaths = files.map((f) => f.path || f.name).filter(Boolean);
    const text = e.dataTransfer?.getData("text/plain") || (filePaths.length ? filePaths.join("\n") : "");
    if (!text.trim() && !filePaths.length) return;
    setBusy(true);
    try {
      const res = await api("/steward/dropzone", { method: "POST", body: { text: text.trim() || filePaths.join(", "), filePaths, channel: "desktop_companion", callerDomain: "owner_private" } });
      setDemoCue({ kind: "done", at: Date.now() });
      showNotice(res.formattedReply?.split("\n")[0] || t("steward.companion.droppedToast"));
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
      else setExpanded((v) => !v);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const activeName = studio?.activePack?.name || t("steward.nav.brand");
  const avatarState = wb?.quietHoursActive ? "sleep" : dropOver ? "listening" : (busy || agentBusy) ? "working" : (cards.length > 0 || dispatches.length > 0) ? "waiting" : "idle";
  const coolingProgress = dispatches[0] ? Math.max(0, Math.min(1, (dispatches[0].remainingMs || 0) / 30000)) : 0;
  const statusText = dispatches.length > 0
    ? t("steward.companion.statusCooling", { sec: Math.ceil((dispatches[0].remainingMs || 0) / 1000) })
    : cards.length > 0
      ? t("steward.companion.statusWaiting", { count: cards.length })
      : (busy || agentBusy)
        ? t("steward.companion.statusWorking")
        : t("steward.companion.statusIdle");

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
          <button type="button" class="btn sm" onClick=${() => window.sugentCompanion?.openMain?.("#/studio")}>${t("steward.companion.openStudio")}</button>
          <button type="button" class="btn sm" onClick=${() => window.sugentCompanion?.openMain?.("#/steward")}>${t("steward.companion.openMain")}</button>
          <button type="button" class="icon-btn xs" title=${t("steward.companion.hideBtn")} onClick=${() => window.sugentCompanion?.hide?.()}><${Icon} name="close" size="xs" /></button>
        </div>
      </div>
      ${cards[0] && html`<div class="comp-approval">
        <div class="comp-approval-text">${t("steward.companion.pendingLead", { peer: cards[0].peerDisplayName, summary: String(cards[0].summary || "") })}</div>
        <div class="comp-actions">
          <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => approveCard(cards[0], "A")}>${t("steward.companion.approveBtn")}</button>
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => api("/concierge/command", { method: "POST", body: { commandText: `/ignore ${cards[0].cardId}`, channel: cards[0].channel } }).then(refresh)}>${t("steward.companion.ignoreBtn")}</button>
        </div>
      </div>`}
      ${reply && html`<div class="comp-reply">${reply}</div>`}
      <form class="comp-compose" onSubmit=${sendCommand}>
        <input ref=${inputRef} class="field" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder=${t("steward.companion.inputPlaceholder")} />
        <${Button} type="submit" variant="primary" size="sm" loading=${busy} disabled=${!prompt.trim()}>${t("steward.companion.sendBtn")}<//>
      </form>
    </div>`}
    <div class="comp-dock-row">
      ${notice && html`<div class="comp-toast">${notice}</div>`}
      ${!expanded && dispatches.length > 0 && html`<div class="comp-pill cooling">
        <span>${t("steward.hub.coolingLead", { sec: Math.ceil((dispatches[0].remainingMs || 0) / 1000), peer: dispatches[0].peerDisplayName })}</span>
        <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => undoDispatch(dispatches[0])}>${t("steward.hub.undoNow")}</button>
      </div>`}
      ${!expanded && dropOver && !notice && html`<div class="comp-pill">${t("steward.companion.dropPrompt")}</div>`}
      <div class=${`comp-orb${dropOver ? " drop-over" : ""}`} onPointerDown=${onOrbPointerDown} onClick=${() => expanded && setExpanded(false)} title=${statusText}>
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
          lively
          pokeable
          onDoubleClick=${() => setDemoCue({ kind: "hello", at: Date.now() })}
        />
      </div>
    </div>
  </div>`;
}

render(html`<${CompanionApp} />`, document.getElementById("companion-app"));
