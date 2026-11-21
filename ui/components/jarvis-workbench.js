import { useEffect, useState } from "preact/hooks";
import { html, Switch } from "./ui.js";
import { api } from "../lib/api.js";
import { failed, toast } from "../lib/store.js";
import { t } from "../lib/i18n.js";

const DIR_KEYS = { i_owe: "dirIOwe", waiting_for: "dirWaiting", expiring: "dirExpiring" };
const TIER_KEYS = ["tierPrivate", "tierSummary", "tierCollab"];
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

export function StewardHubScreen() {
  const [wb, setWb] = useState(null);
  const [busy, setBusy] = useState(false);
  const [vibeRepoId, setVibeRepoId] = useState("");
  const [vibePrompt, setVibePrompt] = useState("");
  const [vibeFiles, setVibeFiles] = useState([]);
  const [bindPath, setBindPath] = useState("");
  const [bindAlias, setBindAlias] = useState("");

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

  const dispatches = wb?.concierge?.pendingDispatches || [];
  const cards = wb?.concierge?.cards || [];
  const openCommits = (wb?.ledger?.commitments || []).filter((c) => c.status !== "closed" && c.status !== "superseded");
  const activeGoals = (wb?.ledger?.goals || []).filter((g) => g.status === "active");
  const projects = (wb?.antigravity?.projects || []).slice(0, 8);
  const bindings = wb?.vibeCoding?.bindings || [];
  const pipelines = (wb?.vibeCoding?.pipelines || []).slice(0, 6);
  const stripSummaryLead = (s) => String(s || "").replace(/^客户来信要点：/, ""); // i18n-ignore

  return html`<section class="sg-page" data-screen="steward-hub">
    <div class="sg-page-inner">
      <header class="sg-head">
        <div>
          <h1 class="sg-title">${t("steward.hub.title")}</h1>
          <p class="sg-sub">${t("steward.hub.subtitle")}</p>
        </div>
        <label class="sg-quiet-label">
          <span>${t("steward.hub.quietHours")}</span>
          <${Switch} label=${t("steward.hub.quietHours")} value=${!!wb?.quietHoursActive}
            onChange=${(v) => runAction("/steward/preferences", { quietHoursActive: v }, t(v ? "steward.hub.quietOn" : "steward.hub.quietOff"))} />
        </label>
      </header>

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

      <div class="sg-footer-meta">
        ${wb?.llmLive ? `${t("steward.hub.footerEngine", { model: wb.activeModel })} · ` : ""}${wb?.budgetStatus?.enabled ? `${t("steward.hub.footerBudget", { used: wb.budgetStatus.usedUsd.toFixed(2), limit: wb.budgetStatus.limitUsd.toFixed(2) })} · ` : ""}${t("steward.hub.footerArchives", { archives: (wb?.ledger?.resources || []).length, sessions: wb?.antigravity?.totalSessions ?? 0 })}
      </div>
    </div>
  </section>`;
}
