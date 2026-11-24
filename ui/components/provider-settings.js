import { useEffect, useState } from "preact/hooks";
import { html, Icon, Switch, Sheet, Spinner } from "./ui.js";
import { PickModel } from "./model-picker.js";
import { api } from "../lib/api.js";
import { confirmSheet, failed, saved, toast } from "../lib/store.js";
import { t } from "../lib/i18n.js";
import { AccountLogin, GoogleOAuthConfigurator, KeyForm, adminUrlFromBase } from "../screens/onboarding.js";

const ROLES = [
  ["assessor", "onboarding.panel.roleAssessor", "onboarding.panel.roleAssessorSub"],
  ["executor", "onboarding.panel.roleExecutor", "onboarding.panel.roleExecutorSub"],
  ["computerUse", "onboarding.panel.roleComputer", "onboarding.panel.roleComputerSub"],
  ["steward", "onboarding.panel.roleSteward", "onboarding.panel.roleStewardSub"],
];

const SANDBOX_PRESETS = [
  ["solo-light", "onboarding.panel.sandboxPresetLight"],
  ["opc-standard", "onboarding.panel.sandboxPresetStandard"],
  ["heavy-autopilot", "onboarding.panel.sandboxPresetHeavy"],
];

export function ProviderSettingsPanel({ models, modelsError, reloadModels, onChanged }) {
  const [data, setData] = useState(null);
  const [auth, setAuth] = useState({ mode: "none" });
  const [adding, setAdding] = useState(false);
  const [configuringGoogle, setConfiguringGoogle] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [diagRunning, setDiagRunning] = useState(false);
  const [diagMap, setDiagMap] = useState({});
  const [sandboxPreset, setSandboxPreset] = useState("opc-standard");
  const [sandboxSim, setSandboxSim] = useState(null);
  const [concierge, setConcierge] = useState(null);
  const [syncInfo, setSyncInfo] = useState(null);
  const [syncPass, setSyncPass] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);

  const load = async (presetOverride) => {
    const activePreset = presetOverride || sandboxPreset;
    try {
      const [prov, authRes, simRes, concRes, syncRes] = await Promise.all([
        api("/providers"),
        api("/auth/status").catch(() => ({ mode: "none" })),
        api("/providers/cost-sandbox", { method: "POST", body: { preset: activePreset } }).catch(() => null),
        api("/concierge/status").catch(() => null),
        api("/sync/status").catch(() => null),
      ]);
      setData(prov);
      setAuth(authRes || { mode: "none" });
      if (simRes?.simulation) setSandboxSim(simRes.simulation);
      if (concRes) setConcierge(concRes);
      if (syncRes) setSyncInfo(syncRes);
    } catch (e) {
      failed(e);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const syncAfterChange = async () => {
    await load();
    if (typeof reloadModels === "function") await reloadModels().catch(() => {});
    if (typeof onChanged === "function") onChanged();
  };

  const makeDefault = async (id) => {
    setBusyId(id);
    try {
      const next = await api(`/providers/${encodeURIComponent(id)}/default`, { method: "POST", body: {} });
      setData(next);
      saved();
      await syncAfterChange();
    } catch (e) {
      failed(e);
    } finally {
      setBusyId("");
    }
  };

  const removeProvider = async (p) => {
    const ok = await confirmSheet({
      title: t("onboarding.panel.removeTitle", { name: p.name || p.id }),
      body: t("onboarding.panel.removeBody"),
      confirmLabel: t("common.delete"),
      danger: true,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      const next = await api(`/providers/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      setData(next);
      saved();
      await syncAfterChange();
    } catch (e) {
      failed(e);
    } finally {
      setBusyId("");
    }
  };

  const toggleCli = async (val) => {
    const prev = data;
    setData((d) => (d ? { ...d, unlockSubscriptions: val } : d));
    try {
      const next = await api("/providers/routing", { method: "PUT", body: { unlockSubscriptions: val } });
      setData(next);
      saved();
      await syncAfterChange();
    } catch (e) {
      setData(prev);
      failed(e);
    }
  };

  const setRoleModel = async (roleKey, modelVal) => {
    const prev = data;
    setData((d) => (d ? { ...d, routing: { ...(d.routing || {}), [roleKey]: modelVal } } : d));
    try {
      const next = await api("/providers/routing", { method: "PUT", body: { [roleKey]: modelVal } });
      setData(next);
      saved();
      const simRes = await api("/providers/cost-sandbox", { method: "POST", body: { preset: sandboxPreset } }).catch(() => null);
      if (simRes?.simulation) setSandboxSim(simRes.simulation);
      onChanged?.();
    } catch (e) {
      setData(prev);
      failed(e);
    }
  };

  const switchBrokerPreset = async () => {
    setBusyId("broker");
    try {
      await api("/auth/broker-preset", { method: "POST", body: {} });
      toast(t("onboarding.panel.brokerPresetToast"));
      await syncAfterChange();
    } catch (e) {
      failed(e);
    } finally {
      setBusyId("");
    }
  };

  const oidcLogout = async () => {
    try {
      await api("/auth/logout", { method: "POST", body: {} });
      toast(auth?.mode === "google" ? t("onboarding.enterprise.googleSignOut") : t("onboarding.panel.oidcSignOut"));
      await syncAfterChange();
    } catch (e) {
      failed(e);
    }
  };

  const probeWeb2ApiPool = async (p) => {
    setBusyId(p.id);
    try {
      const probe = await api("/providers/gemini-web2api/probe", {
        method: "POST",
        body: { providerId: p.id },
      });
      toast(
        t("onboarding.local.web2apiTierBadge", {
          tier: String(probe.tier || "offline").toUpperCase(),
          count: Array.isArray(probe.models) ? probe.models.length : 0,
        }),
      );
      await syncAfterChange();
    } catch (e) {
      failed(e);
    } finally {
      setBusyId("");
    }
  };

  const syncProviderModels = async (providerId) => {
    setBusyId(`sync-${providerId}`);
    try {
      const res = await api("/providers/sync-models", { method: "POST", body: { providerId, force: true } });
      const results = Array.isArray(res?.results) ? res.results : [];
      const firstFail = results.length > 0 && results.every((r) => !r.ok) ? results[0] : null;
      if (firstFail) {
        failed(firstFail.error || firstFail.skippedReason || t("common.error"));
      } else {
        const total = results.reduce((s, r) => s + (r.chatModelCount || 0), 0);
        toast(t("onboarding.panel.syncModelsDoneToast", { count: total }));
      }
      await syncAfterChange();
    } catch (e) {
      failed(e);
    } finally {
      setBusyId("");
    }
  };

  const runDiagnosticsRadar = async () => {
    setDiagRunning(true);
    try {
      const res = await api("/providers/diagnostics", { method: "POST", body: {} });
      setDiagMap(res?.providerStatuses || {});
    } catch (e) {
      failed(e);
    } finally {
      setDiagRunning(false);
    }
  };

  const changeSandboxPreset = async (presetId) => {
    setSandboxPreset(presetId);
    try {
      const res = await api("/providers/cost-sandbox", { method: "POST", body: { preset: presetId } });
      if (res?.simulation) setSandboxSim(res.simulation);
    } catch (e) {
      failed(e);
    }
  };

  const toggleConcierge = async (enabled) => {
    const prev = concierge;
    setConcierge((c) => (c ? { ...c, enabled } : { enabled }));
    try {
      const next = await api("/concierge/config", { method: "PUT", body: { enabled } });
      setConcierge(next);
      saved();
    } catch (e) {
      setConcierge(prev);
      failed(e);
    }
  };

  const runE2eeSync = async (direction) => {
    setSyncBusy(true);
    try {
      const res = await api(`/sync/${direction}`, {
        method: "POST",
        body: { passphrase: syncPass },
      });
      if (direction === "push" && res?.data) {
        toast(t("onboarding.panel.syncPushedToast", { clock: res.data.lamportClock }));
      } else if (direction === "pull" && res?.data) {
        toast(t("onboarding.panel.syncPulledToast", { nodes: res.data.nodeCount }));
      }
      const nextSync = await api("/sync/status").catch(() => null);
      if (nextSync) setSyncInfo(nextSync);
    } catch (e) {
      failed(e);
    } finally {
      setSyncBusy(false);
    }
  };

  const renderDiagBadge = (provId) => {
    const item = diagMap[provId];
    if (!item) return null;
    const ms = item.ttftMs !== null && item.ttftMs !== undefined ? Math.round(item.ttftMs) : "-";
    if (item.status === "healthy") {
      return html`<span class="badge ok">${t("onboarding.panel.diagHealthyBadge", { ms })}</span>`;
    }
    if (item.status === "degraded") {
      return html`<span class="badge warn">${t("onboarding.panel.diagDegradedBadge", { ms })}</span>`;
    }
    return html`<span class="badge err" title=${item.remediationHint || ""}>${t("onboarding.panel.diagUnhealthyBadge", { code: item.diagnosticCode })}</span>`;
  };

  if (!data) {
    return html`<div class="list"><div class="row"><div class="who"><div class="name"><${Spinner} /> ${t("common.loading")}</div></div></div></div>`;
  }

  const providers = Array.isArray(data.providers) ? data.providers : [];
  const routing = data.routing || {};

  return html`<div>
    <div class="set-part">${t("onboarding.panel.authSectionTitle")}</div>
    <div class="list">
      <div class="row">
        <div class="who">
          <div class="name">
            ${auth?.mode === "google"
              ? (auth.signedIn
                ? t("onboarding.enterprise.googleSignedIn", { name: auth.email || auth.name || "Google" })
                : t("onboarding.enterprise.googleTitle"))
              : auth?.mode === "oidc"
                ? (auth.signedIn
                  ? t("onboarding.enterprise.oidcSignedIn", { name: auth.name || "OIDC" })
                  : t("onboarding.enterprise.oidcTitle"))
                : t("onboarding.enterprise.googleTitle")}
          </div>
          <div class="sub">${auth?.mode === "oidc" ? t("onboarding.enterprise.oidcSub") : t("onboarding.enterprise.googleSub")}</div>
        </div>
        <div class="ctl">
          <button type="button" class="btn" disabled=${!!busyId} onClick=${switchBrokerPreset}>${t("onboarding.panel.brokerPresetBtn")}</button>
          <button type="button" class="btn" onClick=${() => setConfiguringGoogle(true)}>${t("onboarding.panel.authConfigureGoogle")}</button>
          ${auth?.signedIn
            ? html`<button type="button" class="text danger" onClick=${oidcLogout}>${t("settings.rows.account.logout")}</button>`
            : (auth?.mode === "oidc" || auth?.mode === "google") && auth?.loginAvailable
              ? html`<${AccountLogin} label=${auth.mode === "google" ? t("onboarding.enterprise.googleBtn") : undefined} onLoggedIn=${syncAfterChange} />`
              : null}
        </div>
      </div>
    </div>

    <div class="set-part">${t("onboarding.panel.providersTitle")}</div>
    <div class="list">
      <div class="row">
        <div class="who">
          <div class="name">${t("onboarding.panel.providersTitle")}</div>
          <div class="sub">${providers.length === 0 ? t("onboarding.panel.emptyProviders") : `${providers.length}`}</div>
        </div>
        <div class="ctl">
          ${providers.length > 0 && html`<button type="button" class="btn" disabled=${diagRunning} onClick=${runDiagnosticsRadar}>
            ${diagRunning ? t("onboarding.panel.diagRunning") : t("onboarding.panel.diagRunBtn")}
          </button>`}
          <button type="button" class="btn primary" onClick=${() => setAdding(true)}>
            <${Icon} name="plus" size="sm" /> ${t("onboarding.panel.addProvider")}
          </button>
        </div>
      </div>

      ${providers.map((p) => html`<div class="row" key=${p.id}>
        <div class="who">
          <div class="name">
            ${p.name}
            ${p.isDefault ? ` · ${t("onboarding.panel.defaultBadge")}` : ""}
          </div>
          <div class="sub">${p.baseUrl}</div>
        </div>
        <div class="ctl">
          ${renderDiagBadge(p.id)}
          ${Array.isArray(p.models) && p.models.length > 0 && html`<span class="badge">${t("onboarding.panel.modelCountBadge", { count: p.models.length })}</span>`}
          <span class="val">${p.keyTail ? `••••${p.keyTail}` : (p.hasKey ? "••••" : t("onboarding.panel.keylessBadge"))}</span>
          <button type="button" class="text accent" disabled=${!!busyId} onClick=${() => syncProviderModels(p.id)}>
            ${busyId === `sync-${p.id}` ? t("onboarding.panel.syncModelsRunning") : t("onboarding.panel.syncModelsBtn")}
          </button>
          ${p.preset === "gemini-web2api" && html`<a class="text" href=${adminUrlFromBase(p.baseUrl)} target="_blank" rel="noopener noreferrer">${t("onboarding.panel.adminConsole")}</a>`}
          ${p.preset === "gemini-web2api" && html`<button type="button" class="text accent" disabled=${!!busyId} onClick=${() => probeWeb2ApiPool(p)}>${t("onboarding.panel.probePool")}</button>`}
          ${!p.isDefault && html`<button type="button" class="text accent" disabled=${!!busyId} onClick=${() => makeDefault(p.id)}>${t("onboarding.panel.setDefault")}</button>`}
          <button type="button" class="text danger" disabled=${!!busyId} onClick=${() => removeProvider(p)}>${t("common.delete")}</button>
        </div>
      </div>`)}

      <div class="row">
        <div class="who">
          <div class="name">${t("onboarding.local.cliTitle")}</div>
          <div class="sub">${t("onboarding.local.cliSub")}</div>
        </div>
        <div class="ctl">
          <${Switch} label=${t("onboarding.local.cliTitle")} value=${!!data.unlockSubscriptions} onChange=${toggleCli} />
        </div>
      </div>
    </div>

    <div class="set-part">${t("onboarding.panel.routingTitle")}</div>
    <div class="list">
      ${ROLES.map(([roleKey, titleKey, subKey]) => html`<div class="row" key=${roleKey}>
        <div class="who">
          <div class="name">${t(titleKey)}</div>
          <div class="sub">${t(subKey)}</div>
        </div>
        <div class="ctl">
          <${PickModel}
            value=${routing[roleKey] || ""}
            models=${models}
            modelsError=${modelsError}
            reloadModels=${reloadModels}
            resetLabel=${t("onboarding.panel.followDefault")}
            label=${t(titleKey)}
            onChange=${(m) => setRoleModel(roleKey, m)}
          />
        </div>
      </div>`)}

      ${sandboxSim && html`<div class="row">
        <div class="who">
          <div class="name">${t("onboarding.panel.sandboxTitle")}</div>
          <div class="sub">
            ${t("onboarding.panel.sandboxProjected", {
              total: Number(sandboxSim.monthlyTotalUsd || 0).toFixed(2),
              saved: Number(sandboxSim.monthlySavingsUsd || 0).toFixed(2),
              pct: ((sandboxSim.savingsRatio || 0) * 100).toFixed(1),
            })}
            ${sandboxSim.budgetHealth?.remainingRunwayUsd !== null && sandboxSim.budgetHealth?.remainingRunwayUsd !== undefined
              ? ` · ${t("onboarding.panel.sandboxRunway", { remain: Number(sandboxSim.budgetHealth.remainingRunwayUsd).toFixed(2) })}`
              : ""}
          </div>
        </div>
        <div class="ctl">
          ${SANDBOX_PRESETS.map(([presetId, labelKey]) => html`<button
            type="button"
            key=${presetId}
            class=${`btn ${sandboxPreset === presetId ? "primary" : ""}`}
            onClick=${() => changeSandboxPreset(presetId)}
          >${t(labelKey)}</button>`)}
        </div>
      </div>`}
    </div>

    <div class="set-part">${t("onboarding.panel.conciergeTitle")}</div>
    <div class="list">
      <div class="row">
        <div class="who">
          <div class="name">${t("onboarding.panel.conciergeTitle")}</div>
          <div class="sub">${t("onboarding.panel.conciergeSub")}</div>
        </div>
        <div class="ctl">
          <button type="button" class="btn" onClick=${() => window.__openSugentConciergeDrawer?.()}>${t("steward.concierge.pillTitle")}</button>
          <${Switch}
            label=${t("onboarding.panel.conciergeTitle")}
            value=${!!concierge?.enabled}
            onChange=${toggleConcierge}
          />
        </div>
      </div>
    </div>

    <div class="set-part">${t("onboarding.panel.syncTitle")}</div>
    <div class="list">
      <div class="row">
        <div class="who">
          <div class="name">${t("onboarding.panel.syncTitle")}</div>
          <div class="sub">
            ${t("onboarding.panel.syncSub")}
            ${syncInfo ? ` · ${t("onboarding.panel.syncNodeStats", { nodes: syncInfo.nodeCount || 0, clock: syncInfo.lamportClock || 1 })}` : ""}
          </div>
        </div>
        <div class="ctl">
          <input
            type="password"
            class="in"
            placeholder=${t("onboarding.panel.syncPassphrasePlaceholder")}
            value=${syncPass}
            onInput=${(e) => setSyncPass(e.currentTarget.value)}
          />
          <button type="button" class="btn" disabled=${syncBusy || syncPass.trim().length < 12} onClick=${() => runE2eeSync("push")}>
            ${t("onboarding.panel.syncPushBtn")}
          </button>
          <button type="button" class="btn" disabled=${syncBusy || syncPass.trim().length < 12} onClick=${() => runE2eeSync("pull")}>
            ${t("onboarding.panel.syncPullBtn")}
          </button>
        </div>
      </div>
    </div>

    ${adding && html`<${Sheet} title=${t("onboarding.panel.addProvider")} onClose=${() => setAdding(false)}>
      <${KeyForm}
        includeLocalPreset=${true}
        allowSetDefaultToggle=${true}
        setDefault=${providers.length === 0}
        submitLabel=${t("onboarding.provider.submit")}
        onCancel=${() => setAdding(false)}
        onSaved=${async () => {
          setAdding(false);
          await syncAfterChange();
        }}
      />
    <//>`}

    ${configuringGoogle && html`<${Sheet} title=${t("onboarding.enterprise.googleTitle")} onClose=${() => setConfiguringGoogle(false)}>
      <p class="hint">${t("onboarding.enterprise.googleSub")}</p>
      <${GoogleOAuthConfigurator}
        auth=${auth}
        onSaved=${async () => {
          await syncAfterChange();
        }}
      />
    <//>`}
  </div>`;
}
