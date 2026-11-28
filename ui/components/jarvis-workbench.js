import { useEffect, useRef, useState } from "preact/hooks";
import { html, Notice, Switch } from "./ui.js";
import { api } from "../lib/api.js";
import { failed, toast } from "../lib/store.js";
import { t } from "../lib/i18n.js";

const DIR_KEYS = { i_owe: "dirIOwe", waiting_for: "dirWaiting", expiring: "dirExpiring" };
const TIER_KEYS = ["tierPrivate", "tierSummary", "tierCollab"];
const TRUST_TIER_KEYS = {
  L0_record_only: "trustL0",
  L1_whisper_prompt: "trustL1",
  L2_suspend_approval: "trustL2",
  L3_shadow_autonomous: "trustL3",
};
const GUARD_KIND_KEYS = {
  hard_redline: "guardKindRedline",
  tombstone: "guardKindTombstone",
  soft_taste: "guardKindTaste",
};
const shortProj = (k) => String(k || "").replace(/^repo:[^/]+\//, "").replace(/^local:[^:]+:/, "");

function isGoalStalled(g) {
  const ms = Date.parse(g.lastProgressAt || "");
  return Number.isFinite(ms) && (Date.now() - ms) > (g.stallThresholdDays || 7) * 86_400_000;
}

function HubCard({ title, hint, children }) {
  return html`<div class="sg-card">
    <div class="sg-card-head">
      <span class="sg-card-title">${title}</span>
      ${hint && html`<span class="sg-card-hint">${hint}</span>`}
    </div>
    ${children}
  </div>`;
}

export function CoolingUndoBanner({ onChanged }) {
  const [dispatches, setDispatches] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await api("/steward/workbench?domain=owner_private").catch(() => null);
    if (res?.concierge?.pendingDispatches) setDispatches(res.concierge.pendingDispatches);
  };

  useEffect(() => {
    void load();
    const timer = setInterval(load, dispatches.length > 0 ? 1000 : 3500);
    return () => clearInterval(timer);
  }, [dispatches.length]);

  if (!dispatches.length) return null;
  const d = dispatches[0];
  const undo = async () => {
    setBusy(true);
    try {
      await api("/concierge/command", { method: "POST", body: { commandText: `/undo ${d.dispatchId}`, channel: d.channel } });
      toast(t("steward.hub.undoToast"));
      await load();
      onChanged?.();
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  return html`<div class="sg-cooling-banner" role="status">
    <span class="sg-cooling-label">${t("steward.hub.coolingLead", { sec: Math.ceil((d.remainingMs || 0) / 1000), peer: d.peerDisplayName })}</span>
    <button type="button" class="btn sm danger" disabled=${busy} onClick=${undo}>${t("steward.hub.undoNow")}</button>
  </div>`;
}

const MIND_STATUS_KEYS = {
  sandbox: "sandbox",
  crystallized: "crystallized",
  falsified: "falsified",
  superseded: "superseded",
};

export function MindJournalDialog({ open, onClose }) {
  const ref = useRef(null);
  const [journal, setJournal] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadJournal = async () => {
    const res = await api("/steward/mind-journal").catch(() => null);
    if (res) setJournal(res);
  };

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal?.();
      void loadJournal();
    } else if (!open && dlg.open) {
      dlg.close?.();
    }
  }, [open]);

  const onDialogClose = (e) => {
    e.currentTarget.returnValue = "";
    onClose?.();
  };

  const onBackdropClick = (e) => {
    const dlg = ref.current;
    if (!dlg || "closedBy" in HTMLDialogElement.prototype) return;
    if (e.target !== dlg || (e.clientX === 0 && e.clientY === 0)) return;
    const rect = dlg.getBoundingClientRect();
    const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
    if (!inside) dlg.close?.();
  };

  const reconcile = async (item, outcome) => {
    setBusy(true);
    try {
      await api("/steward/mind-journal/reconcile", {
        method: "POST",
        body: { nodeId: item.nodeId || item.id, id: item.id || item.nodeId, outcome },
      });
      toast(t("steward.mind.reconciledToast"));
      await loadJournal();
    } catch (err) {
      failed(err);
    } finally {
      setBusy(false);
    }
  };

  const entries = journal?.entries || journal?.items || [];
  const counts = {
    sandbox: entries.filter((x) => (x.status || "sandbox") === "sandbox").length,
    crystallized: entries.filter((x) => x.status === "crystallized").length,
    falsified: entries.filter((x) => x.status === "falsified").length,
  };

  return html`<dialog ref=${ref} class="sg-mind-dialog" closedby="any" aria-labelledby="sg-mind-dialog-title" onClose=${onDialogClose} onClick=${onBackdropClick}>
    <div class="sg-mind-head">
      <div>
        <h1 id="sg-mind-dialog-title" class="sg-mind-title">${t("steward.mind.title")}</h1>
        <p class="sg-card-hint">${t("steward.mind.subtitle")}</p>
      </div>
      <button type="button" class="btn sm" onClick=${() => ref.current?.close?.()}>${t("steward.mind.closeBtn")}</button>
    </div>
    <div class="sg-mind-meta">
      <span class="sg-badge-pill">${journal?.charterVersion ? `${t("steward.mind.charterLabel")} (${journal.charterVersion})` : t("steward.mind.charterLabel")}</span>
      <span class="sg-card-hint">${t("steward.mind.statsLine", counts)}</span>
    </div>
    <div class="sg-mind-body">
      ${entries.length === 0 && html`<div class="sg-card-hint">${t("steward.mind.emptyHint")}</div>`}
      ${entries.map((item) => {
        const st = MIND_STATUS_KEYS[item.status] || "sandbox";
        const badgeCls = st === "crystallized" ? "badge ok" : st === "falsified" ? "badge err" : st === "sandbox" ? "badge warn" : "badge off";
        return html`<div key=${item.id || item.nodeId} class="sg-item-block">
          <div class="sg-card-head">
            <strong>${item.title || item.name || item.topic || item.id}</strong>
            <span class=${badgeCls}>${t(`steward.mind.statusLabels.${st}`)}</span>
          </div>
          <div class="sg-draft-box">${item.hypothesis || item.summary || item.statement || ""}</div>
          ${item.evidence && html`<div class="sg-card-hint">${item.evidence}</div>`}
          ${st === "sandbox" && html`<div class="sg-actions">
            <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => reconcile(item, "confirmed")}>${t("steward.mind.btnConfirm")}</button>
            <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => reconcile(item, "falsified")}>${t("steward.mind.btnFalsify")}</button>
          </div>`}
        </div>`;
      })}
    </div>
  </dialog>`;
}

export function StewardHubScreen() {
  const [wb, setWb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [vibeRepoId, setVibeRepoId] = useState("");
  const [vibePrompt, setVibePrompt] = useState("");
  const [vibeFiles, setVibeFiles] = useState([]);
  const [bindPath, setBindPath] = useState("");
  const [bindAlias, setBindAlias] = useState("");
  const [chatText, setChatText] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [chatReply, setChatReply] = useState("");
  const [guardKind, setGuardKind] = useState("hard_redline");
  const [guardText, setGuardText] = useState("");
  const [mindOpen, setMindOpen] = useState(false);
  const [dissentDismissed, setDissentDismissed] = useState(false);

  const refresh = async () => {
    const res = await api("/steward/workbench?domain=owner_private").catch(() => null);
    if (res) setWb(res);
  };

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, []);

  const runAction = async (endpoint, body, msg) => {
    setBusy(true);
    try {
      const res = await api(endpoint, { method: "POST", body });
      if (res?.workbench?.ledger) setWb(res.workbench);
      else await refresh();
      if (res?.ok === false) failed(res.error || res.errorCode || t("common.error"));
      else if (msg) toast(msg);
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const setRoutingPolicy = async (patch, msg) => {
    setBusy(true);
    try {
      await api("/steward/routing/policy", { method: "PUT", body: patch });
      await refresh();
      if (msg) toast(msg);
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const execConcierge = async (commandText, channel, msg) => {
    setBusy(true);
    try {
      await api("/concierge/command", { method: "POST", body: { commandText, channel } });
      await refresh();
      if (msg) toast(msg);
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const onPickVibeFiles = async (e) => {
    const picked = Array.from(e.target.files || []).slice(0, 4);
    const encoded = await Promise.all(picked.map((f) => new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => {
        const res = String(r.result || "");
        resolve({ name: f.name, mime: f.type || "application/octet-stream", dataBase64: res.includes(",") ? res.split(",")[1] : res });
      };
      r.readAsDataURL(f);
    })));
    setVibeFiles(encoded);
  };

  const sendConverse = async () => {
    const text = chatText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api("/steward/converse", {
        method: "POST",
        body: { text, history: chatHistory, channel: "web_ui", callerDomain: "owner_private" },
      });
      const replyText = res?.reply || "";
      setChatReply(replyText);
      setChatHistory((prev) => [
        ...prev,
        { role: "user", content: text },
        ...(replyText ? [{ role: "assistant", content: replyText }] : []),
      ].slice(-10));
      setChatText("");
      if (res?.workbench?.ledger) setWb(res.workbench);
      else await refresh();
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const sendDropzone = async () => {
    const text = chatText.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const res = await api("/steward/dropzone", {
        method: "POST",
        body: { text, channel: "web_ui", callerDomain: "owner_private" },
      });
      setChatReply(res?.formattedReply || "");
      setChatText("");
      if (res?.workbench?.ledger) setWb(res.workbench);
      else await refresh();
      toast(t("steward.hub.converseCaptureToast"));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const addGuardrail = async () => {
    const statement = guardText.trim();
    if (!statement || busy) return;
    await runAction(
      "/steward/guardrails",
      { partition: "personal_life", kind: guardKind, statement, callerDomain: "owner_private" },
      t("steward.hub.guardAddedToast"),
    );
    setGuardText("");
  };

  const dispatches = wb?.concierge?.pendingDispatches || [];
  const cards = wb?.concierge?.cards || [];
  const openCommits = (wb?.ledger?.commitments || []).filter((c) => c.status !== "closed" && c.status !== "superseded");
  const activeGoals = (wb?.ledger?.goals || []).filter((g) => g.status === "active");
  const relationships = wb?.ledger?.relationships || [];
  const guardrails = wb?.ledger?.guardrails || [];
  const groupDigests = wb?.groupDigests || [];
  const projects = (wb?.antigravity?.projects || []).slice(0, 8);
  const bindings = wb?.vibeCoding?.bindings || [];
  const pipelines = (wb?.vibeCoding?.pipelines || []).slice(0, 6);
  const skillCandidates = wb?.skillCandidates || [];
  const rt = wb?.routing;
  const rtDecs = (rt?.recentDecisions || []).slice(0, 4);
  const rtBoard = Object.entries(rt?.leaderboard || {}).filter(([, rows]) => Array.isArray(rows) && rows.length > 0).slice(0, 3);
  const stripSummaryLead = (s) => String(s || "").replace(/^客户来信要点：/, ""); // i18n-ignore

  return html`<section class="sg-page" data-screen="steward-hub">
    <div class="sg-page-inner">
      <header class="sg-head">
        <div>
          <h1 class="sg-title">${t("steward.hub.title")}</h1>
          <p class="sg-sub">${t("steward.hub.subtitle")}</p>
        </div>
        <div class="sg-head-actions">
          <button type="button" class="btn sm" onClick=${() => { location.hash = "/atlas"; }}>${t("steward.hub.openAtlasBtn")}</button>
          <button type="button" class="btn sm" onClick=${() => setMindOpen(true)}>${t("steward.mind.openBtn")}</button>
          <label class="sg-quiet-label">
            <span>${t("steward.hub.quietHours")}</span>
            <${Switch} label=${t("steward.hub.quietHours")} value=${!!wb?.quietHoursActive}
              onChange=${(v) => runAction("/steward/preferences", { quietHoursActive: v }, t(v ? "steward.hub.quietOn" : "steward.hub.quietOff"))} />
          </label>
        </div>
      </header>

      ${wb?.loyalDissent && !dissentDismissed && html`<${Notice} tone="amber"
        action=${html`<button type="button" class="btn sm" onClick=${() => setDissentDismissed(true)}>${t("steward.mind.dissentDismissLabel")}</button>`}>
        ${typeof wb.loyalDissent === "string" ? wb.loyalDissent : (wb.loyalDissent.message || wb.loyalDissent.summary || wb.loyalDissent.reason || "")}
      </${Notice}>`}

      <${HubCard} title=${t("steward.hub.converseTitle")} hint=${t("steward.hub.converseHint")}>
        <div class="sg-field-row">
          <input class="field" value=${chatText} onInput=${(e) => setChatText(e.target.value)}
            onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendConverse(); } }}
            placeholder=${t("steward.hub.conversePlaceholder")} />
          <button type="button" class="btn sm primary" disabled=${busy || !chatText.trim()} onClick=${sendConverse}>${t("steward.hub.converseSend")}</button>
          <button type="button" class="btn sm" disabled=${busy || !chatText.trim()} onClick=${sendDropzone}>${t("steward.hub.converseCapture")}</button>
          <button type="button" class="btn sm" onClick=${() => window.__openSugentConciergeDrawer?.()}>${t("steward.hub.converseWhisper")}</button>
        </div>
        ${chatReply && html`<div class="sg-draft-box">${chatReply}</div>`}
      </${HubCard}>

      ${groupDigests.length > 0 && html`<${HubCard} title=${t("steward.hub.groupDigestTitle")} hint=${t("steward.hub.groupDigestHint", { count: groupDigests.length })}>
        ${groupDigests.map((d) => html`<div key=${d.digestId} class="sg-item-block">
          <div class="sg-card-head">
            <strong>${d.groupName}</strong>
            <span class="sg-card-hint">${d.digestId}</span>
          </div>
          <div class="sg-draft-box">
            ${(Array.isArray(d.threeLineSummary) ? d.threeLineSummary : [String(d.threeLineSummary || "")]).map((line, idx) => html`<div key=${idx}>${line}</div>`)}
          </div>
          <div class="sg-actions">
            <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => runAction("/steward/group-scribe/decide", { digestId: d.digestId, decision: "approve" }, t("steward.hub.groupDigestApprovedToast"))}>${t("steward.hub.groupDigestApprove")}</button>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/group-scribe/decide", { digestId: d.digestId, decision: "dismiss" }, t("steward.hub.groupDigestDismissedToast"))}>${t("steward.hub.groupDigestDismiss")}</button>
          </div>
        </div>`)}
      </${HubCard}>`}

      ${(cards.length > 0 || dispatches.length > 0) && html`<${HubCard} title=${t("steward.hub.cardsTitle")} hint=${t("steward.hub.cardsHint", { count: cards.length })}>
        ${dispatches.map((d) => html`<div key=${d.dispatchId} class="sg-cooling-inline">
          <span>${t("steward.hub.coolingRow", { peer: d.peerDisplayName, sec: Math.ceil((d.remainingMs || 0) / 1000) })}</span>
          <button type="button" class="btn sm danger" disabled=${busy} onClick=${() => execConcierge(`/undo ${d.dispatchId}`, d.channel, t("steward.hub.undoToast"))}>${t("steward.hub.undoShort")}</button>
        </div>`)}
        ${cards.map((c) => html`<div key=${c.cardId} class="sg-item-block">
          <div class="sg-card-head">
            <strong>${c.peerDisplayName}</strong>
            <span class="sg-card-hint">${t(c.channel === "feishu" ? "steward.hub.channelFeishu" : "steward.hub.channelWeixin")}</span>
          </div>
          <div class="sg-draft-box">${stripSummaryLead(c.summary)}</div>
          ${c.chatType === "group"
            ? html`<span class="badge warn">${t("steward.hub.groupReadonly")}</span>`
            : html`<div class="sg-draft-box">
                <div>${t("steward.hub.draftSteady", { body: c.draftA.body })}</div>
                <div>${t("steward.hub.draftActive", { body: c.draftB.body })}</div>
              </div>
              <div class="sg-actions">
                <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => execConcierge(`/send A ${c.cardId} ${c.draftA.confirmHash}`, c.channel, t("steward.hub.sentSteadyToast"))}>${t("steward.hub.sendSteady")}</button>
                <button type="button" class="btn sm" disabled=${busy} onClick=${() => execConcierge(`/send B ${c.cardId} ${c.draftB.confirmHash}`, c.channel, t("steward.hub.sentActiveToast"))}>${t("steward.hub.sendActive")}</button>
                <button type="button" class="btn sm" disabled=${busy} onClick=${() => execConcierge(`/ignore ${c.cardId}`, c.channel, t("steward.hub.ignoredToast"))}>${t("steward.hub.ignore")}</button>
              </div>`}
        </div>`)}
      </${HubCard}>`}

      ${skillCandidates.length > 0 && html`<${HubCard} title=${t("steward.hub.skillGateTitle")} hint=${t("steward.hub.skillGateHint", { count: skillCandidates.length })}>
        ${skillCandidates.map((sc) => html`<div key=${sc.nodeId} class="sg-row">
          <div>
            <strong>${sc.name}</strong> <span class="badge">${t("steward.hub.skillReinforce", { count: sc.reinforcements })}</span>
            <div class="sg-card-hint">${sc.summary}</div>
          </div>
          <div class="sg-actions">
            <button type="button" class="btn sm primary" disabled=${busy} onClick=${() => runAction("/steward/skill-candidates/decide", { nodeId: sc.nodeId, decision: "approve" }, t("steward.hub.skillApprovedToast", { name: sc.name }))}>${t("steward.hub.skillApproveBtn")}</button>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/skill-candidates/decide", { nodeId: sc.nodeId, decision: "reject" }, t("steward.hub.skillRejectedToast", { name: sc.name }))}>${t("steward.hub.skillRejectBtn")}</button>
          </div>
        </div>`)}
      </${HubCard}>`}

      <div class="sg-grid">
        <${HubCard} title=${t("steward.hub.commitsTitle")} hint=${openCommits.length ? t("steward.hub.commitsHint", { count: openCommits.length }) : undefined}>
          ${openCommits.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.commitsEmpty")}</div>`}
          ${openCommits.map((c) => html`<div key=${c.id} class="sg-row">
            <div>
              <span class="badge warn">${t(`steward.hub.${DIR_KEYS[c.direction] || "dirDefault"}`)}</span>
              <span> ${c.summary}</span>
            </div>
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/commitments", { action: "status", id: c.id, status: "closed", callerDomain: "owner_private" }, t("steward.hub.doneToast"))}>${t("steward.hub.markDone")}</button>
          </div>`)}
        </${HubCard}>

        <${HubCard} title=${t("steward.hub.goalsTitle")} hint=${t("steward.hub.goalsHint")}>
          ${activeGoals.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.goalsEmpty")}</div>`}
          ${activeGoals.map((g) => html`<div key=${g.id} class="sg-item-block">
            <div class="sg-card-head">
              <strong>${g.title}</strong>
              ${isGoalStalled(g) && html`<span class="badge warn">${t("steward.hub.goalStalled")}</span>`}
            </div>
            <div class="sg-card-hint">${g.northStarCriterion}</div>
          </div>`)}
        </${HubCard}>
      </div>

      <div class="sg-grid">
        <${HubCard} title=${t("steward.hub.vibeTitle")} hint=${bindings.length ? t("steward.hub.vibeHintCount", { count: bindings.length }) : t("steward.hub.vibeHintEmpty")}>
          <div class="sg-field-row">
            <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/repos", { action: "bind_self" }, t("steward.hub.boundSelfToast"))}>${t("steward.hub.bindSelf")}</button>
            <input class="field" value=${bindPath} onInput=${(e) => setBindPath(e.target.value)} placeholder=${t("steward.hub.repoPathPlaceholder")} />
            <input class="field" value=${bindAlias} onInput=${(e) => setBindAlias(e.target.value)} placeholder=${t("steward.hub.repoAliasPlaceholder")} />
            <button type="button" class="btn sm" disabled=${busy || !bindPath.trim()} onClick=${async () => {
              await runAction("/steward/repos", { action: "upsert", alias: bindAlias.trim() || t("steward.hub.repoDefaultAlias"), repoRoot: bindPath.trim() }, t("steward.hub.boundRepoToast"));
              setBindPath(""); setBindAlias("");
            }}>${t("steward.hub.bindBtn")}</button>
          </div>
          ${bindings.length > 0 && html`<div class="sg-field-row">
            <select class="sg-select" value=${vibeRepoId || bindings[0].bindingId} onChange=${(e) => setVibeRepoId(e.target.value)}>
              ${bindings.map((b) => html`<option value=${b.bindingId}>${b.alias}</option>`)}
            </select>
            <input type="file" multiple onChange=${onPickVibeFiles} />
            <input class="field" value=${vibePrompt} onInput=${(e) => setVibePrompt(e.target.value)} placeholder=${t("steward.hub.vibePromptPlaceholder")} />
            <button type="button" class="btn sm primary" disabled=${busy || !vibePrompt.trim()} onClick=${async () => {
              await runAction("/steward/vibe/start", { bindingQuery: vibeRepoId || bindings[0].bindingId, text: vibePrompt.trim(), channel: "sugent_app", attachments: vibeFiles }, t("steward.hub.dispatchedToast"));
              setVibePrompt(""); setVibeFiles([]);
            }}>${t("steward.hub.dispatchBtn")}</button>
          </div>`}
          ${pipelines.map((p) => html`<div key=${p.pipelineId} class="sg-item-block">
            <div class="sg-card-head">
              <strong>${p.repoAlias} · ${p.stage}</strong>
              <span class="sg-card-hint">${t("steward.hub.ioCount", { inCount: p.stagedInboundFiles?.length || 0, outCount: p.outboundDeliverables?.length || 0 })}</span>
            </div>
            <div class="sg-card-hint">${p.requirementText}</div>
            ${(p.outboundDeliverables || []).filter((d) => d.category === "image").slice(0, 2).map((img) => html`<img class="sg-vibe-img" src=${`/amb/api/steward/vibe/artifact?pipelineId=${encodeURIComponent(p.pipelineId)}&file=${encodeURIComponent(img.fileName)}`} alt=${img.fileName} />`)}
            <div class="sg-actions">
              ${p.stage === "awaiting_plan_approval" && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${() => runAction("/steward/vibe/decide", { pipelineId: p.pipelineId, action: "approve" }, t("steward.hub.approvedPlanToast"))}>${t("steward.hub.approvePlan")}</button>`}
              ${p.stage === "developing" && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/vibe/advance", { pipelineId: p.pipelineId }, t("steward.hub.ranGatesToast"))}>${t("steward.hub.runGates")}</button>`}
              ${p.stage === "awaiting_restart_approval" && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${() => runAction("/steward/vibe/decide", { pipelineId: p.pipelineId, action: "relaunch_now" }, t("steward.hub.relaunchingToast"))}>${t("steward.hub.relaunchNow")}</button>`}
              ${!["completed", "cancelled", "failed", "rolled_back"].includes(p.stage) && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/vibe/decide", { pipelineId: p.pipelineId, action: "cancel" }, t("steward.hub.cancelledToast"))}>${t("steward.hub.cancelTask")}</button>`}
            </div>
          </div>`)}
        </${HubCard}>

        <${HubCard} title=${t("steward.hub.agTitle")} hint=${t("steward.hub.agHint")}>
          ${projects.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.agEmpty")}</div>`}
          ${projects.map((p) => html`<div key=${p.projectKey} class="sg-row">
            <div>
              <strong>${p.displayName || shortProj(p.projectKey)}</strong>
              ${p.runningSessionCount > 0 && html`<span class="badge ok"> ${t("steward.hub.agRunningBadge")}</span>`}
              <span class="sg-card-hint"> ${t("steward.hub.agSessions", { count: p.sessionCount })}</span>
              ${p.runningSessions?.[0] && html`<div class="sg-card-hint">${t("steward.hub.agRunningLine", { title: p.runningSessions[0].title })}</div>`}
            </div>
            <div class="sg-actions">
              ${[0, 1, 2].map((tier) => html`<button type="button" class=${`btn sm${p.policy.tier === tier ? " primary" : ""}`} disabled=${busy}
                onClick=${() => runAction("/steward/antigravity/tier", { projectKey: p.projectKey, tier, callerDomain: "owner_private" }, t("steward.hub.tierChanged", { name: p.displayName || shortProj(p.projectKey), tier: t(`steward.hub.${TIER_KEYS[tier]}`) }))}>${t(`steward.hub.${TIER_KEYS[tier]}`)}</button>`)}
            </div>
          </div>`)}
        </${HubCard}>
      </div>

      <div class="sg-grid">
        <${HubCard} title=${t("steward.hub.relTitle")} hint=${relationships.length ? t("steward.hub.relHint", { count: relationships.length }) : undefined}>
          ${relationships.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.relEmpty")}</div>`}
          ${relationships.map((r) => html`<div key=${r.id} class="sg-row">
            <div>
              <strong>${r.name}</strong>
              ${r.roleTag && html`<span class="sg-card-hint"> · ${r.roleTag}</span>`}
              <div class="sg-card-hint">${t("steward.hub.relObs", { count: r.verifiedObservations ?? 0 })}</div>
            </div>
            <span class=${`badge${r.trustTier === "L3_shadow_autonomous" ? " ok" : r.trustTier === "L2_suspend_approval" ? " warn" : ""}`}>
              ${t(`steward.hub.${TRUST_TIER_KEYS[r.trustTier] || "trustL0"}`)}
            </span>
          </div>`)}
        </${HubCard}>

        <${HubCard} title=${t("steward.hub.guardTitle")} hint=${guardrails.length ? t("steward.hub.guardHint", { count: guardrails.length }) : undefined}>
          <div class="sg-field-row">
            <select class="sg-select" value=${guardKind} onChange=${(e) => setGuardKind(e.target.value)}>
              <option value="hard_redline">${t("steward.hub.guardKindRedline")}</option>
              <option value="tombstone">${t("steward.hub.guardKindTombstone")}</option>
              <option value="soft_taste">${t("steward.hub.guardKindTaste")}</option>
            </select>
            <input class="field" value=${guardText} onInput=${(e) => setGuardText(e.target.value)} placeholder=${t("steward.hub.guardPlaceholder")} />
            <button type="button" class="btn sm primary" disabled=${busy || !guardText.trim()} onClick=${addGuardrail}>${t("steward.hub.guardAddBtn")}</button>
          </div>
          ${guardrails.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.guardEmpty")}</div>`}
          ${guardrails.map((g) => html`<div key=${g.id} class="sg-row">
            <div>
              <span class=${`badge${g.kind === "hard_redline" ? " warn" : ""}`}>${t(`steward.hub.${GUARD_KIND_KEYS[g.kind] || "guardKindRedline"}`)}</span>
              <span> ${g.statement}</span>
            </div>
          </div>`)}
        </${HubCard}>
      </div>

      ${rt && html`<${HubCard} title=${t("steward.hub.routingTitle")} hint=${t("steward.hub.routingHint", { healthy: rt.pool?.healthyChatModels ?? 0, total: rt.pool?.chatModels ?? 0, cooling: rt.pool?.coolingChatModels ?? 0 })}>
        <div class="sg-actions">
          ${[["quota_saver", "steward.hub.strategyQuota"], ["balanced", "steward.hub.strategyBalanced"], ["quality_first", "steward.hub.strategyQuality"]].map(([id, key]) =>
            html`<button type="button" key=${id} class=${`btn sm${rt.strategy === id ? " primary" : ""}`} disabled=${busy} onClick=${() => setRoutingPolicy({ strategy: id }, t("steward.hub.policyUpdatedToast"))}>${t(key)}</button>`)}
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => setRoutingPolicy(rt.mode === "shadow" ? { mode: "auto" } : rt.mode === "pinned" ? { mode: "auto", pinnedModel: null } : { mode: "shadow" }, t("steward.hub.policyUpdatedToast"))}>${rt.mode === "shadow" ? t("steward.hub.modeShadow") : rt.mode === "pinned" ? t("steward.hub.modePinned", { model: String(rt.pinnedModel || "").split("/").pop() || "-" }) : t("steward.hub.modeAuto")}</button>
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/routing/sync", { force: true }, t("steward.hub.poolSyncedToast"))}>${t("steward.hub.syncPoolBtn")}</button>
          ${rtDecs.length > 0 && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/routing/retry-stronger", {}, t("steward.hub.retryStrongerToast"))}>${t("steward.hub.retryStrongerBtn")}</button>`}
        </div>
        ${rtDecs.length === 0 && html`<div class="sg-card-hint">${t("steward.hub.routingEmpty")}</div>`}
        ${rtDecs.map((d) => html`<div key=${d.decisionId} class="sg-row">
          <div><strong>${d.rawModelId}</strong> <span class="badge">${d.archetype}</span><div class="sg-card-hint">${d.reasonSummary}</div></div>
          <span class="sg-card-hint">${d.escalatedFrom ? `↑ ${d.escalatedFrom}` : d.fallbackUsedFrom ? `↻ ${d.fallbackUsedFrom}` : t("steward.hub.routingScore", { score: Math.round((d.score || 0) * 100) })}</span>
        </div>`)}
        ${rtBoard.length > 0 && html`<div class="sg-card-hint">${t("steward.hub.leaderboardLabel")}${rtBoard.map(([arch, rows]) => `${arch}:${String(rows[0]?.targetId || "").split("/").pop()}(${Math.round((rows[0]?.posteriorQuality ?? 0) * 100)}%)`).join(" · ")}</div>`}
      </${HubCard}>`}

      ${wb?.hotUpdate && html`<${HubCard}
        title=${t("steward.hub.hotUpdateTitle")}
        hint=${t("steward.hub.hotUpdateHint", {
          mode: t(wb.hotUpdate.supervised ? "steward.hub.hotUpdateSupervised" : "steward.hub.hotUpdateStandalone"),
          slot: wb.hotUpdate.slots?.activeSlot || wb.hotUpdate.shell?.activeSlot || "factory",
        })}>
        <div class="sg-actions">
          <button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/hot-update/reload-ui", {}, t("steward.hub.hotUpdateUiToast"))}>${t("steward.hub.hotUpdateUiBtn")}</button>
          ${wb.hotUpdate.supervised && html`<button type="button" class="btn sm primary" disabled=${busy} onClick=${() => runAction("/steward/hot-update/reload-core", { reason: "workbench" }, t("steward.hub.hotUpdateCoreToast"))}>${t("steward.hub.hotUpdateCoreBtn")}</button>`}
          ${(wb.hotUpdate.slots?.activeSlot || wb.hotUpdate.slots?.previousSlot) && html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => runAction("/steward/hot-update/rollback", {}, t("steward.hub.hotUpdateRollbackToast"))}>${t("steward.hub.hotUpdateRollbackBtn")}</button>`}
        </div>
      </${HubCard}>`}

      ${wb?.duoSummary && html`<${HubCard}
        title=${t("steward.hub.duoTitle")}
        hint=${t("steward.hub.duoHint", {
          crystals: wb.duoSummary.crystalCount ?? wb.duoSummary.crystals ?? (wb.duoSummary.recentCrystals?.length || 0),
          commits: wb.duoSummary.commitmentCount ?? wb.duoSummary.commitments ?? (wb.duoSummary.activeCommitments?.length || 0),
        })}>
        ${(wb.duoSummary.weatherCapsule?.cognitiveLoad || wb.duoSummary.cognitiveLoad) && html`<div class="sg-draft-box">
          ${t("steward.hub.duoWeatherLabel", { load: wb.duoSummary.weatherCapsule?.cognitiveLoad || wb.duoSummary.cognitiveLoad })}
        </div>`}
        ${((wb.duoSummary.recentCrystals || wb.duoSummary.crystalsList || []).length === 0 && (wb.duoSummary.activeCommitments || []).length === 0) && html`<div class="sg-card-hint">${t("steward.hub.duoEmpty")}</div>`}
        ${(wb.duoSummary.recentCrystals || wb.duoSummary.crystalsList || []).slice(0, 3).map((c) => html`<div key=${c.id || c.title} class="sg-row">
          <div>
            <strong>${c.title || c.topicKey}</strong>
            <div class="sg-card-hint">${c.summary || c.gentleAction || ""}</div>
          </div>
          <span class="badge ok">${c.status || "crystallized"}</span>
        </div>`)}
        ${(wb.duoSummary.activeCommitments || []).slice(0, 3).map((m) => html`<div key=${m.id || m.title} class="sg-row">
          <div>
            <strong>${m.title}</strong>
            <div class="sg-card-hint">${m.detail || ""}</div>
          </div>
          <span class="badge">${m.status || "active"}</span>
        </div>`)}
      </${HubCard}>`}

      <div class="sg-footer-meta">
        ${wb?.llmLive ? `${t("steward.hub.footerEngine", { model: wb.activeModel })} · ` : ""}${wb?.budgetStatus?.enabled ? `${t("steward.hub.footerBudget", { used: wb.budgetStatus.usedUsd.toFixed(2), limit: wb.budgetStatus.limitUsd.toFixed(2) })} · ` : ""}${t("steward.hub.footerArchives", { archives: (wb?.ledger?.resources || []).length, sessions: wb?.antigravity?.totalSessions ?? 0 })}${wb?.trustKgStats ? ` · ${t("steward.hub.footerTrustKg", { active: wb.trustKgStats.activeTierEdges ?? 0, superseded: wb.trustKgStats.supersededTierEdges ?? 0 })}` : ""}${wb?.atlasStats ? ` · ${t("steward.hub.footerAtlas", { nodes: wb.atlasStats.activeNodes ?? wb.atlasStats.totalNodes ?? wb.atlasStats.nodeCount ?? wb.atlasStats.nodes ?? 0, edges: wb.atlasStats.activeEdges ?? wb.atlasStats.totalEdges ?? wb.atlasStats.edgeCount ?? wb.atlasStats.edges ?? 0 })}` : ""}
      </div>
    </div>
    <${MindJournalDialog} open=${mindOpen} onClose=${() => setMindOpen(false)} />
  </section>`;
}
