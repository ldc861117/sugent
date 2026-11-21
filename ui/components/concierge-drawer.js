import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { html, Switch } from "./ui.js";
import { api } from "../lib/api.js";
import { failed, saved, toast } from "../lib/store.js";
import { t } from "../lib/i18n.js";

function ConciergeGlobalOverlay() {
  const [open, setOpen] = useState(false);
  const [wb, setWb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [inSettings, setInSettings] = useState(false);
  const [editingCardId, setEditingCardId] = useState("");
  const [customDraftText, setCustomDraftText] = useState("");

  const refresh = async () => {
    const res = await api("/concierge/workbench").catch(() => null);
    if (res) setWb(res);
  };

  useEffect(() => {
    window.__openSugentConciergeDrawer = () => { void refresh(); setOpen(true); };
    void refresh();
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "e") {
        e.preventDefault(); setOpen((v) => !v);
      } else if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const domCheck = setInterval(() => setInSettings(Boolean(document.querySelector(".set-part"))), 400);
    return () => { window.removeEventListener("keydown", onKey); clearInterval(domCheck); };
  }, []);

  useEffect(() => {
    const hasCooling = (wb?.pendingDispatches?.length || 0) > 0;
    const timer = setInterval(refresh, hasCooling ? 1000 : open ? 2000 : 3500);
    return () => clearInterval(timer);
  }, [open, wb?.pendingDispatches?.length]);

  const toggleEnabled = async (enabled) => {
    try { await api("/concierge/config", { method: "PUT", body: { enabled } }); await refresh(); saved(); }
    catch (e) { failed(e); }
  };

  const execCmd = async (commandText, channel = "weixin") => {
    setBusy(true);
    try {
      const res = await api("/concierge/command", { method: "POST", body: { commandText, channel } });
      if (res?.workbench) setWb(res.workbench);
      else await refresh();
      const st = res?.outcome?.status;
      if (st === "canceled_in_cooling_window") toast(t("steward.concierge.toastCanceled"));
      else if (st === "cooling_off_scheduled") { toast(t("steward.concierge.toastCooling")); setEditingCardId(""); }
      else if (st === "pending_double_confirm") toast(t("steward.concierge.toastDouble"));
      else if (st === "rejected_guardrail") toast(t("steward.concierge.guardrail", { reason: res?.outcome?.reason || "" }));
      else if (st === "ignored") toast(t("steward.concierge.toastIgnored"));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const simulate = async (preset) => {
    setBusy(true);
    try {
      const payloads = {
        pricing: { channel: "weixin", chatType: "direct", peerId: "wx_stranger_chen", senderName: "Chen (Client)", text: "Hi, what is the budget and fee range for phase 2 consulting?" },
        group: { channel: "feishu", chatType: "group", peerId: "oc_project_group", senderName: "Zhou (Project Group)", text: "Is tomorrow morning's BOM review still in the main meeting room?" },
        vip: { channel: "weixin", chatType: "direct", peerId: "wx_vip_zhang", senderName: "Zhang (VIP)", text: "Can we book a 30-min call next Wednesday afternoon to align phase 2 schedule?" },
      };
      const res = await api("/concierge/simulate", { method: "POST", body: payloads[preset] });
      if (res?.workbench) setWb(res.workbench);
      toast(t("steward.concierge.simDone"));
    } catch (e) { toast(t("steward.concierge.simFailed", { err: e.message })); } finally { setBusy(false); }
  };

  const cards = Array.isArray(wb?.cards) ? wb.cards : [];
  const dispatches = Array.isArray(wb?.pendingDispatches) ? wb.pendingDispatches : [];
  const totalAttention = cards.length + dispatches.length;

  return html`<div>
    ${!inSettings && html`<button type="button" class="sg-drawer-trigger" title=${t("steward.concierge.pillTitle")} onClick=${() => setOpen(true)}>
      <span>${t("steward.concierge.pillLabel")}</span>
      ${totalAttention > 0 && html`<span class="badge count">${totalAttention}</span>`}
    </button>`}

    ${open && html`<div class="sg-drawer-scrim" onClick=${(e) => e.target === e.currentTarget && setOpen(false)}>
      <div class="sg-drawer" role="dialog" aria-label=${t("steward.concierge.title")}>
        <div class="sg-drawer-head">
          <div>
            <div class="sg-card-title">${t("steward.concierge.title")}</div>
            <div class="sg-card-hint">${t("steward.concierge.subtitle")}</div>
          </div>
          <div class="sg-actions">
            <${Switch} label=${t("steward.concierge.enableLabel")} value=${!!wb?.enabled} onChange=${toggleEnabled} />
            <button type="button" class="btn sm" onClick=${() => setOpen(false)}>×</button>
          </div>
        </div>
        <div class="sg-drawer-body">
          <div class="sg-actions">
            <span class="sg-card-hint">${t("steward.concierge.simBarLabel")}</span>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => simulate("pricing")}>${t("steward.concierge.simPricing")}</button>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => simulate("vip")}>${t("steward.concierge.simSchedule")}</button>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => simulate("group")}>${t("steward.concierge.simGroup")}</button>
          </div>
          ${dispatches.length > 0 && html`<div class="sg-card">
            <div class="sg-card-title">${t("steward.concierge.coolingTitle", { count: dispatches.length })}</div>
            ${dispatches.map((d) => html`<div key=${d.dispatchId} class="sg-cooling-inline">
              <span>${t("steward.concierge.coolingItem", { peer: d.peerDisplayName, sec: Math.ceil((d.remainingMs || 0) / 1000), body: d.finalBody })}</span>
              <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => execCmd(`/undo ${d.dispatchId}`, d.channel)}>${t("steward.concierge.undoTop")}</button>
            </div>`)}
          </div>`}
          ${cards.length === 0 && html`<div class="sg-card"><div class="sg-card-hint">${t("steward.concierge.cardEmpty")}</div></div>`}
          ${cards.map((c) => html`<div key=${c.cardId} class="sg-card">
            <div class="sg-card-head">
              <strong>${c.peerDisplayName}</strong>
              <span class="sg-card-hint">${t(c.channel === "feishu" ? "steward.hub.channelFeishu" : "steward.hub.channelWeixin")} · ${t(c.chatType === "group" ? "steward.concierge.peerGroup" : "steward.concierge.peerDirect")}</span>
            </div>
            <div class="sg-draft-box">${c.summary}</div>
            ${c.chatType === "group"
              ? html`<span class="badge warn">${t("steward.concierge.groupNoSend")}</span>`
              : html`<div class="sg-draft-box">
                  <div>${t("steward.concierge.optSteady", { body: c.draftA.body })}</div>
                  <div>${t("steward.concierge.optActive", { body: c.draftB.body })}</div>
                </div>
                <div class="sg-actions">
                  <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => execCmd(`/send A ${c.cardId} ${c.draftA.confirmHash}`, c.channel)}>${t("steward.concierge.btnSteady")}</button>
                  <button type="button" class="btn sm" disabled=${busy} onClick=${() => execCmd(`/send B ${c.cardId} ${c.draftB.confirmHash}`, c.channel)}>${t("steward.concierge.btnActive")}</button>
                  <button type="button" class="btn sm" disabled=${busy} onClick=${() => { setEditingCardId(c.cardId); setCustomDraftText(c.draftA.body); }}>${t("steward.concierge.btnEdit")}</button>
                  <button type="button" class="text danger" disabled=${busy} onClick=${() => execCmd(`/ignore ${c.cardId}`, c.channel)}>${t("steward.concierge.btnIgnore")}</button>
                </div>
                ${editingCardId === c.cardId && html`<div class="sg-field-row">
                  <input class="field" value=${customDraftText} onInput=${(e) => setCustomDraftText(e.target.value)} placeholder=${t("steward.concierge.customPlaceholder")} />
                  <button type="button" class="btn sm primary" disabled=${busy || !customDraftText.trim()} onClick=${() => execCmd(`/edit ${c.cardId} ${customDraftText}`, c.channel)}>${t("steward.concierge.btnConfirmSend")}</button>
                  <button type="button" class="btn sm" onClick=${() => setEditingCardId("")}>${t("steward.concierge.btnCancel")}</button>
                </div>`}
                ${c.pendingCustomEdit && html`<button type="button" class="btn sm danger" disabled=${busy} onClick=${() => execCmd(`/confirm ${c.cardId} ${c.pendingCustomEdit.confirmHash}`, c.channel)}>
                  ${t("steward.concierge.btnDoubleConfirm", { peer: c.peerDisplayName })}
                </button>`}`}
          </div>`)}
        </div>
        <div class="sg-drawer-foot">
          <span>${t("steward.concierge.footerCount", { cards: cards.length, cooling: dispatches.length })}</span>
        </div>
      </div>
    </div>`}
  </div>`;
}

export function mountConciergeOverlay() {
  if (document.getElementById("sugent-concierge-overlay-root")) return;
  const el = document.createElement("div");
  el.id = "sugent-concierge-overlay-root";
  document.body.appendChild(el);
  render(html`<${ConciergeGlobalOverlay} />`, el);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountConciergeOverlay);
else mountConciergeOverlay();
