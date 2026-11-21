// Onboarding screen & universal provider connection form (decoupled from proprietary login).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { html, Icon, Menu, Notice, Seg, Switch, Spinner, CopyButton, MenuButton } from "../components/ui.js";
import { BotAvatar, MAIN_CHAR } from "../components/avatar.js";
import { FamilyHead, PickModel, familyName, groupModels, useFamilies } from "../components/model-picker.js";
import { api } from "../lib/api.js";
import { failed, saved, toast } from "../lib/store.js";
import { LANG_NAMES, changeLang, getLangPref, t, useLang } from "../lib/i18n.js";
import { MF_CONSOLE, MF_DOCS } from "../lib/links.js";

export { MF_CONSOLE, MF_DOCS };

const HTTPS_PROTO = ["https", "://"].join("");
const HTTP_PROTO = ["http", "://"].join("");

export const PROVIDER_PRESETS = [
  { id: "openai", label: "OpenAI", baseUrl: `${HTTPS_PROTO}api.openai.com/v1`, requiresKey: true },
  { id: "anthropic", label: "Anthropic", baseUrl: `${HTTPS_PROTO}api.anthropic.com/v1`, requiresKey: true },
  { id: "deepseek", label: "DeepSeek", baseUrl: `${HTTPS_PROTO}api.deepseek.com/v1`, requiresKey: true },
  { id: "gemini", label: "Gemini", baseUrl: `${HTTPS_PROTO}generativelanguage.googleapis.com/v1beta/openai`, requiresKey: true },
  { id: "gemini-web2api", label: "Gemini Web2API", baseUrl: `${HTTP_PROTO}127.0.0.1:8083/v1`, requiresKey: false },
  { id: "openrouter", label: "OpenRouter", baseUrl: `${HTTPS_PROTO}openrouter.ai/api/v1`, requiresKey: true },
  { id: "ollama", label: "Ollama", baseUrl: `${HTTP_PROTO}127.0.0.1:11434/v1`, requiresKey: false },
  { id: "cowork", label: "Cowork", baseUrl: `${HTTP_PROTO}127.0.0.1:28080/v1`, requiresKey: false },
  { id: "custom-openai", label: "", baseUrl: "", requiresKey: false },
];

export function adminUrlFromBase(rawUrl) {
  const base = (rawUrl || `${HTTP_PROTO}127.0.0.1:8083/v1`).trim().replace(/\/+$/, "");
  const root = base.endsWith("/v1") ? base.slice(0, -3) : base;
  return `${root.replace(/\/+$/, "")}/admin/`;
}

export function presetOptions(includeLocal = false) {
  return PROVIDER_PRESETS.filter((p) => includeLocal || (p.id !== "ollama" && p.id !== "cowork")).map((p) => [
    p.id,
    p.id === "custom-openai" ? t("onboarding.provider.custom") : p.label,
  ]);
}

export function getPresetMeta(id) {
  return PROVIDER_PRESETS.find((p) => p.id === id) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1];
}

export function Web2ApiProbeBar({ baseUrl, apiKey, providerId }) {
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState(null);
  const adminHref = result?.urls?.adminUrl || adminUrlFromBase(baseUrl);

  const runProbe = async () => {
    setProbing(true);
    try {
      const out = await api("/providers/gemini-web2api/probe", {
        method: "POST",
        body: {
          ...(baseUrl ? { baseUrl: baseUrl.trim() } : {}),
          ...(apiKey ? { apiKey: apiKey.trim() } : {}),
          ...(providerId ? { providerId } : {}),
        },
      });
      setResult(out);
    } catch (e) {
      failed(e);
    } finally {
      setProbing(false);
    }
  };

  return html`<div class="list">
    <div class="row compact">
      <div class="who">
        <div class="sub">${t("onboarding.local.web2apiHint")}</div>
      </div>
      <div class="ctl">
        <a class="text accent" href=${adminHref} target="_blank" rel="noopener noreferrer">${t("onboarding.local.web2apiAdminLink")}</a>
        <button type="button" class="btn" disabled=${probing} onClick=${runProbe}>
          ${probing ? html`<${Spinner} /> ${t("onboarding.local.web2apiProbing")}` : t("onboarding.local.web2apiProbeBtn")}
        </button>
      </div>
    </div>
    ${result && html`<${Notice} tone=${result.ok && result.models?.length ? "green" : "amber"}>
      <div>${t("onboarding.local.web2apiTierBadge", { tier: String(result.tier || "offline").toUpperCase(), count: Array.isArray(result.models) ? result.models.length : 0 })}</div>
      ${Array.isArray(result.warnings) && result.warnings.map((w) => html`<div>${w}</div>`)}
    <//>`}
  </div>`;
}

export function GoogleOAuthConfigurator({ auth, onSaved, onFace }) {
  const cfg = auth?.config || {};
  const [clientId, setClientId] = useState(cfg.mode === "google" ? (cfg.clientId || "") : "");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (auth?.config?.mode === "google" && auth.config.clientId && !clientId) {
      setClientId(auth.config.clientId);
    }
  }, [auth?.config?.clientId, auth?.config?.mode]);

  const saveGoogle = async (e) => {
    e?.preventDefault?.();
    if (!clientId.trim()) {
      setErr(t("onboarding.enterprise.missingGoogleClientId"));
      return;
    }
    setSaving(true);
    setErr("");
    try {
      const next = await api("/auth/config", {
        method: "PUT",
        body: {
          mode: "google",
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
          provisioningMode: "none",
        },
      });
      setClientSecret("");
      saved();
      await onSaved?.(next);
    } catch (ex) {
      setErr(ex.message);
      onFace?.("error");
    } finally {
      setSaving(false);
    }
  };

  return html`<div class="list">
    <form class="list" onSubmit=${saveGoogle}>
      <label class="k" for="g-cid">${t("onboarding.enterprise.googleClientId")}</label>
      <input id="g-cid" class="field mono" type="text" autocomplete="off" spellcheck="false"
        placeholder=${t("onboarding.enterprise.googleClientIdPlaceholder")} value=${clientId}
        onInput=${(e) => { setClientId(e.target.value); setErr(""); }} />
      <label class="k" for="g-csec">${t("onboarding.enterprise.googleClientSecret")}</label>
      <input id="g-csec" class="field mono" type="password" autocomplete="off" spellcheck="false"
        placeholder=${auth?.hasClientSecret || cfg?.hasClientSecret ? t("onboarding.enterprise.googleClientSecretSaved") : ""}
        value=${clientSecret} onInput=${(e) => { setClientSecret(e.target.value); setErr(""); }} />
      ${err && html`<div class="err-text" role="alert">${err}</div>`}
      <button type="submit" class="btn block" disabled=${saving}>
        ${saving ? html`<${Spinner} />` : t("onboarding.enterprise.googleSaveBtn")}
      </button>
    </form>
    ${auth?.mode === "google" && auth?.loginAvailable && !auth?.signedIn && html`<${AccountLogin} label=${t("onboarding.enterprise.googleBtn")} onFace=${onFace} onLoggedIn=${onSaved} />`}
  </div>`;
}

export const lineOptions = () => [
  ["auto", t("common.auto")],
  ["global", t("onboarding.line.global")],
  ["cn", t("onboarding.line.cn")],
];

export function KeyForm({
  initialPreset = "openai",
  initialName = "",
  initialBaseUrl,
  setDefault: initialSetDefault = true,
  allowSetDefaultToggle = false,
  includeLocalPreset = false,
  onConnected,
  onSaved,
  onCancel,
  onFace,
  submitLabel,
}) {
  const startMeta = getPresetMeta(initialPreset);
  const [preset, setPreset] = useState(startMeta.id);
  const [name, setName] = useState(initialName || startMeta.label);
  const [nameTouched, setNameTouched] = useState(Boolean(initialName));
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl !== undefined ? initialBaseUrl : startMeta.baseUrl);
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [makeDefault, setMakeDefault] = useState(Boolean(initialSetDefault));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const input = useRef(null);

  const activeMeta = getPresetMeta(preset);

  useEffect(() => {
    onFace?.(busy ? "thinking" : key.trim() ? "listening" : "idle");
  }, [busy, !!key.trim()]);

  const pickPreset = (nextId) => {
    const meta = getPresetMeta(nextId);
    setPreset(meta.id);
    setBaseUrl(meta.baseUrl);
    if (!nameTouched) setName(meta.label);
    setErr("");
  };

  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (text) {
        setKey(text);
        setErr("");
      }
    } catch {
      input.current?.focus();
    }
  };

  const submit = async () => {
    if (busy) return;
    const trimmedUrl = baseUrl.trim();
    const trimmedKey = key.trim();
    if (!trimmedUrl) {
      setErr(t("onboarding.provider.missingUrl"));
      return;
    }
    if (activeMeta.requiresKey && !trimmedKey) {
      setErr(t("onboarding.provider.missingKey"));
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const res = await api("/providers", {
        method: "POST",
        body: {
          preset,
          name: name.trim() || activeMeta.label || "Custom",
          baseUrl: trimmedUrl,
          apiKey: trimmedKey,
          setDefault: Boolean(makeDefault),
        },
      });
      setKey("");
      saved();
      const models = Array.isArray(res?.models) ? res.models : [];
      if (typeof onSaved === "function") await onSaved(res, models);
      if (typeof onConnected === "function") await onConnected(res, models);
    } catch (e) {
      setErr(e.message);
      onFace?.("error");
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="list" onSubmit=${(e) => { e.preventDefault(); submit(); }}>
    <div class="row compact">
      <div class="who"><div class="name">${t("onboarding.provider.preset")}</div></div>
      <div class="ctl">
        <${MenuButton} label=${t("onboarding.provider.preset")} value=${preset} width=${200} options=${presetOptions(includeLocalPreset)} onChange=${pickPreset} />
      </div>
    </div>

    <label class="k" for="prov-name">${t("onboarding.provider.name")}</label>
    <input id="prov-name" class="field" type="text" autocomplete="off" spellcheck="false"
      placeholder=${t("onboarding.provider.namePlaceholder")} value=${name} readonly=${busy}
      onInput=${(e) => { setName(e.target.value); setNameTouched(true); }} />

    <label class="k" for="prov-url">${t("onboarding.provider.baseUrl")}</label>
    <input id="prov-url" class="field mono" type="url" autocomplete="off" spellcheck="false"
      placeholder=${`${HTTPS_PROTO}api.openai.com/v1`} value=${baseUrl} readonly=${busy}
      onInput=${(e) => { setBaseUrl(e.target.value); setErr(""); }} />
    <p class="hint">${t("onboarding.provider.baseUrlSub")}</p>

    <label class="k" for="mf-key">${activeMeta.requiresKey ? t("onboarding.key.label") : t("onboarding.provider.keyOptional")}</label>
    <div class="field-wrap">
      <input id="mf-key" ref=${input} class=${`field mono${err ? " err" : ""}`} type=${show ? "text" : "password"}
        autocomplete="off" spellcheck="false"
        placeholder=${activeMeta.requiresKey ? t("onboarding.key.placeholder") : t("onboarding.provider.keyOptionalPlaceholder")}
        value=${key} readonly=${busy} aria-invalid=${!!err} aria-describedby="mf-key-note"
        onInput=${(e) => { setKey(e.target.value); setErr(""); }} />
      <span class="tail">
        <button type="button" class="icon-btn" title=${t("onboarding.key.paste")} aria-label=${t("onboarding.key.paste")} onClick=${paste}><${Icon} name="paste" size="sm" /></button>
        <button type="button" class="icon-btn" title=${show ? t("onboarding.key.hide") : t("onboarding.key.show")} aria-label=${show ? t("onboarding.key.hideKey") : t("onboarding.key.showKey")} onClick=${() => setShow((v) => !v)}><${Icon} name=${show ? "eyeOff" : "eye"} size="sm" /></button>
      </span>
    </div>

    ${preset === "gemini-web2api" && html`<${Web2ApiProbeBar} baseUrl=${baseUrl} apiKey=${key} />`}

    ${allowSetDefaultToggle && html`<div class="row compact">
      <div class="who"><div class="name">${t("onboarding.provider.setDefault")}</div></div>
      <div class="ctl"><${Switch} label=${t("onboarding.provider.setDefault")} value=${makeDefault} onChange=${setMakeDefault} /></div>
    </div>`}

    ${err && html`<div class="err-text" role="alert"><span>${err}</span></div>`}
    <p class="hint" id="mf-key-note">${t("onboarding.key.note")}</p>

    <div class="actions">
      ${onCancel && html`<button type="button" class="btn" disabled=${busy} onClick=${onCancel}>${t("common.cancel")}</button>`}
      <button type="submit" class="btn primary lg block" disabled=${busy || (activeMeta.requiresKey && !key.trim())}>
        ${busy ? html`<${Spinner} /> ${t("onboarding.key.connecting")}` : (submitLabel || t("onboarding.provider.submit"))}
      </button>
    </div>
  </form>`;
}

export function AccountLogin({ onSignedIn, onLoggedIn, onFace, label }) {
  const [waiting, setWaiting] = useState(false);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => onFace?.(waiting ? "thinking" : "idle"), [waiting]);
  useEffect(() => {
    if (!waiting) return;
    let stop = false;
    const poll = setInterval(async () => {
      const s = await api("/auth/status").catch(() => null);
      if (!s || stop) return;
      if (s.state === "signed_in" || s.signedIn) {
        stop = true;
        setWaiting(false);
        onSignedIn?.(s);
        onLoggedIn?.(s);
      } else if (s.state !== "signing_in") {
        stop = true;
        setWaiting(false);
        if (s.error) {
          setErr(s.error);
          onFace?.("error");
        }
      }
    }, 1200);
    return () => clearInterval(poll);
  }, [waiting]);

  const start = async () => {
    setErr("");
    try {
      const r = await api("/auth/login", { method: "POST", body: {} });
      const target = r.loginUrl || r.authUrl || "";
      setUrl(target);
      setWaiting(true);
      if (!r.opened && target) window.open(target, "_blank", "noopener");
    } catch (e) {
      setErr(e.message);
      onFace?.("error");
    }
  };
  const cancel = () => {
    setWaiting(false);
    api("/auth/login/cancel", { method: "POST", body: {} }).catch(() => {});
  };
  if (waiting) {
    return html`<div class="login-cta" role="status">
      <div class="login-wait"><${Spinner} /> ${t("onboarding.login.waiting")}</div>
      <div class="login-links">
        <a class="text" href=${url} target="_blank" rel="noopener noreferrer">${t("onboarding.login.reopen")}</a>
        <${CopyButton} text=${url} label=${t("onboarding.login.copyLink")} />
        <button type="button" class="text" onClick=${cancel}>${t("common.cancel")}</button>
      </div>
    </div>`;
  }
  return html`<div class="login-cta">
    <button type="button" class="btn primary lg block" onClick=${start}>${label || t("onboarding.enterprise.oidcBtn")}</button>
    ${err && html`<div class="err-text" role="alert">${err}</div>`}
  </div>`;
}

function ModelStep({ models, initial, onDone }) {
  const [q, setQ] = useState("");
  const [cur, setCur] = useState(initial && models.includes(initial) ? initial : models[0] || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const groups = useMemo(() => groupModels(models, q), [models, q]);
  const { isOpen, toggle } = useFamilies(groups, cur);
  const folding = !q.trim() && groups.length > 1;
  const [media, setMedia] = useState(null);
  const [img, setImg] = useState("");
  const [vid, setVid] = useState("");
  useEffect(() => {
    Promise.all([api("/media/models"), api("/settings").catch(() => ({}))])
      .then(([d, st]) => {
        setMedia(d);
        setImg(d.image.includes(st.imageModel) ? st.imageModel : d.recommended.image || "");
        setVid(d.video.includes(st.videoModel) ? st.videoModel : d.recommended.video || "");
      })
      .catch(() => setMedia({ image: [], video: [] }));
  }, []);
  const hasMedia = media && (media.image.length > 0 || media.video.length > 0);
  const start = async () => {
    setBusy(true);
    try {
      await api("/settings", {
        method: "PUT",
        body: { defaultModel: cur, ...(media && media.image.length ? { imageModel: img } : {}), ...(media && media.video.length ? { videoModel: vid } : {}) },
      });
      if (cur) {
        await api("/providers/routing", { method: "PUT", body: { executor: cur } }).catch(() => {});
      }
      onDone();
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return html`<div class="list">
    <div class="connected"><span class="dot ok"></span>${t("onboarding.model.found", { count: models.length, n: html`<span class="num">${models.length}</span>` })}</div>
    ${models.length
      ? html`<p class="hint">${t("onboarding.model.hint")}</p>
        <input class="field" placeholder=${t("onboarding.model.filter")} value=${q} onInput=${(e) => setQ(e.target.value)} aria-label=${t("onboarding.model.filter")} />
        <div class="picklist" role="listbox" aria-label=${t("onboarding.model.default")}>
          ${groups.map(([g, ms]) => {
            const rows = ms.map(([m, label]) => html`<button type="button" role="option" aria-selected=${m === cur} class=${m === cur ? "cur" : ""} onClick=${() => setCur(m)} onDblClick=${start}>
              <span class="v">${label}</span>${m === cur && html`<span class="check"><${Icon} name="check" size="sm" /></span>`}
            </button>`);
            if (!folding) return html`${groups.length > 1 && html`<div class="group">${familyName(g)}</div>`}${rows}`;
            const open = isOpen(g);
            const hit = open ? undefined : ms.find(([m]) => m === cur);
            return html`<button type="button" class="fam" aria-expanded=${open} onClick=${() => toggle(g)}><${FamilyHead} name=${g} count=${ms.length} current=${hit?.[1]} /></button>${open && rows}`;
          })}
          ${!groups.length && html`<p class="hint">${t("onboarding.model.noMatch")}</p>`}
        </div>
        ${hasMedia && html`<div class="media-pick">
          <p class="hint">${t("onboarding.model.mediaHint")}</p>
          ${media.image.length > 0 && html`<div class="row compact">
            <div class="who"><div class="name">${t("onboarding.model.image")}</div></div>
            <${PickModel} value=${img} models=${media.image} onChange=${setImg} label=${t("onboarding.model.imageLabel")} />
          </div>`}
          ${media.video.length > 0 && html`<div class="row compact">
            <div class="who"><div class="name">${t("onboarding.model.video")}</div></div>
            <${PickModel} value=${vid} models=${media.video} onChange=${setVid} label=${t("onboarding.model.imageLabel")} />
          </div>`}
        </div>`}`
      : html`<${Notice} tone="amber">${t("onboarding.model.empty")}<//>`}
    ${err && html`<div class="err-text" role="alert">${err}</div>`}
    <button type="button" class="btn primary lg block" disabled=${busy} onClick=${start}>${busy ? html`<${Spinner} /> ${t("onboarding.model.saving")}` : models.length ? t("onboarding.model.start") : t("onboarding.model.startAnyway")}</button>
  </div>`;
}

function LangSwitch() {
  const lang = useLang();
  const pref = getLangPref();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const label = t("common.lang.label");
  const opts = [["system", t("common.lang.system")], ["zh-CN", LANG_NAMES["zh-CN"]], ["en", LANG_NAMES.en]];
  return html`<div class="onboard-lang">
    <button type="button" class="pick" ref=${ref} aria-haspopup="menu" aria-expanded=${open} aria-label=${label} title=${label} onClick=${() => setOpen((v) => !v)}>
      <${Icon} name="globe" size="sm" class="lead" /><span class="v">${LANG_NAMES[lang]}</span><${Icon} name="chevDown" />
    </button>
    ${open && html`<${Menu} anchor=${ref.current} width=${180} align="right" label=${label} onClose=${() => setOpen(false)}
      items=${opts.map(([v, text]) => ({ label: text, cur: v === pref, onSelect: () => v !== pref && changeLang(v).catch(failed) }))} />`}
  </div>`;
}

export function Onboarding({ gateway, defaultModel, onDone }) {
  const [mode, setMode] = useState("apiKey");
  const [models, setModels] = useState(null);
  const [auth, setAuth] = useState({ mode: "none" });
  const [web2apiUrl, setWeb2apiUrl] = useState(`${HTTP_PROTO}127.0.0.1:8083/v1`);
  const [web2apiKey, setWeb2apiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState(`${HTTP_PROTO}127.0.0.1:11434/v1`);
  const [coworkUrl, setCoworkUrl] = useState(`${HTTP_PROTO}127.0.0.1:28080/v1`);
  const [coworkKey, setCoworkKey] = useState("");
  const [busyLocal, setBusyLocal] = useState(false);
  const [errLocal, setErrLocal] = useState("");
  const [face, setFace] = useState("idle");
  const [cue, setCue] = useState(null);

  const onFace = (f) => (f === "error" ? setCue({ kind: "error", at: Date.now() }) : setFace(f));

  const reloadAuth = () => api("/auth/status").then(setAuth).catch(() => {});

  useEffect(() => {
    reloadAuth();
  }, []);

  const finishConnect = async (seedModels) => {
    setFace("idle");
    if (Array.isArray(seedModels) && seedModels.length > 0) {
      setModels(seedModels);
      return;
    }
    const d = await api("/models").catch(() => ({ models: [] }));
    setModels(d.models || []);
  };

  const connectWeb2Api = async () => {
    setBusyLocal(true);
    setErrLocal("");
    try {
      const res = await api("/providers", {
        method: "POST",
        body: {
          preset: "gemini-web2api",
          name: "Gemini Web2API",
          baseUrl: web2apiUrl.trim(),
          apiKey: web2apiKey.trim(),
          setDefault: true,
        },
      });
      toast(t("onboarding.local.web2apiConnected"));
      await finishConnect(res.models);
    } catch (e) {
      setErrLocal(e.message);
      onFace("error");
    } finally {
      setBusyLocal(false);
    }
  };

  const connectOllama = async () => {
    setBusyLocal(true);
    setErrLocal("");
    try {
      const res = await api("/providers", {
        method: "POST",
        body: { preset: "ollama", name: "Ollama", baseUrl: ollamaUrl.trim(), apiKey: "", setDefault: true },
      });
      toast(t("onboarding.local.ollamaConnected"));
      await finishConnect(res.models);
    } catch (e) {
      setErrLocal(e.message);
      onFace("error");
    } finally {
      setBusyLocal(false);
    }
  };

  const enableCliSubscriptions = async () => {
    setBusyLocal(true);
    setErrLocal("");
    try {
      const res = await api("/providers/routing", {
        method: "PUT",
        body: { unlockSubscriptions: true },
      });
      toast(t("onboarding.local.cliEnabled"));
      await finishConnect(res.models);
    } catch (e) {
      setErrLocal(e.message);
      onFace("error");
    } finally {
      setBusyLocal(false);
    }
  };

  const connectCowork = async (e) => {
    e.preventDefault();
    if (!coworkKey.trim()) {
      setErrLocal(t("onboarding.enterprise.missingCoworkKey"));
      return;
    }
    setBusyLocal(true);
    setErrLocal("");
    try {
      const res = await api("/providers", {
        method: "POST",
        body: { preset: "cowork", name: "Business-Level Cowork", baseUrl: coworkUrl.trim(), apiKey: coworkKey.trim(), setDefault: true },
      });
      saved();
      await finishConnect(res.models);
    } catch (err) {
      setErrLocal(err.message);
      onFace("error");
    } finally {
      setBusyLocal(false);
    }
  };

  const modeOpts = [
    ["apiKey", t("onboarding.modes.apiKey")],
    ["local", t("onboarding.modes.local")],
    ["enterprise", t("onboarding.modes.enterprise")],
  ];

  return html`<main class="onboard" data-screen="onboarding">
    <div class="onboard-col">
      <${LangSwitch} />
      <div class="onboard-hero">
        <${BotAvatar} char=${MAIN_CHAR} size=${models === null ? 132 : 88} state=${face} cue=${cue} lively pokeable greet />
        <h1>${t("onboarding.slogan")}</h1>
      </div>
      ${gateway && gateway.mode === "managed" && gateway.state === "failed" && html`<${Notice} tone="red">${t("onboarding.gatewayFailed", { error: gateway.lastError || t("onboarding.unknownReason") })}<//>`}
      ${models !== null
        ? html`<${ModelStep} models=${models} initial=${defaultModel} onDone=${onDone} />`
        : html`<div class="list">
            <div class="row compact">
              <div class="who"><div class="name">${t("onboarding.modes.label")}</div></div>
              <div class="ctl"><${Seg} label=${t("onboarding.modes.label")} options=${modeOpts} value=${mode} onChange=${(m) => { setMode(m); setErrLocal(""); }} /></div>
            </div>

            ${mode === "apiKey" && html`<${KeyForm} onFace=${onFace} onSaved=${(_res, ms) => finishConnect(ms)} />`}

            ${mode === "local" && html`<div class="list">
              <div class="row">
                <div class="who">
                  <div class="name">${t("onboarding.local.web2apiTitle")}</div>
                  <div class="sub">${t("onboarding.local.web2apiSub")}</div>
                </div>
              </div>
              <input class="field mono" type="url" value=${web2apiUrl} onInput=${(e) => setWeb2apiUrl(e.target.value)} aria-label="Gemini Web2API URL" />
              <input class="field mono" type="password" autocomplete="off" placeholder=${t("onboarding.provider.keyOptionalPlaceholder")} value=${web2apiKey} onInput=${(e) => setWeb2apiKey(e.target.value)} aria-label=${t("onboarding.provider.keyOptional")} />
              <${Web2ApiProbeBar} baseUrl=${web2apiUrl} apiKey=${web2apiKey} />
              <button type="button" class="btn primary lg block" disabled=${busyLocal} onClick=${connectWeb2Api}>
                ${busyLocal ? html`<${Spinner} /> ${t("onboarding.key.connecting")}` : t("onboarding.local.web2apiBtn")}
              </button>

              <div class="row">
                <div class="who">
                  <div class="name">${t("onboarding.local.ollamaTitle")}</div>
                  <div class="sub">${t("onboarding.local.ollamaSub")}</div>
                </div>
              </div>
              <input class="field mono" type="url" value=${ollamaUrl} onInput=${(e) => setOllamaUrl(e.target.value)} aria-label="Ollama URL" />
              <button type="button" class="btn lg block" disabled=${busyLocal} onClick=${connectOllama}>
                ${busyLocal ? html`<${Spinner} /> ${t("onboarding.key.connecting")}` : t("onboarding.local.ollamaBtn")}
              </button>

              <div class="row">
                <div class="who">
                  <div class="name">${t("onboarding.local.cliTitle")}</div>
                  <div class="sub">${t("onboarding.local.cliSub")}</div>
                </div>
              </div>
              <button type="button" class="btn lg block" disabled=${busyLocal} onClick=${enableCliSubscriptions}>
                ${t("onboarding.local.cliBtn")}
              </button>
              ${errLocal && html`<div class="err-text" role="alert">${errLocal}</div>`}
            </div>`}

            ${mode === "enterprise" && html`<div class="list">
              <div class="row">
                <div class="who">
                  <div class="name">${auth?.mode === "google" && auth?.signedIn ? t("onboarding.enterprise.googleSignedIn", { name: auth.email || auth.name || "Google" }) : t("onboarding.enterprise.googleTitle")}</div>
                  <div class="sub">${t("onboarding.enterprise.googleSub")}</div>
                </div>
              </div>
              <${GoogleOAuthConfigurator} auth=${auth} onFace=${onFace} onSaved=${async () => { await reloadAuth(); }} />

              ${auth?.mode === "oidc" && auth?.loginAvailable && html`<div class="list">
                <div class="row">
                  <div class="who">
                    <div class="name">${t("onboarding.enterprise.oidcTitle")}</div>
                    <div class="sub">${t("onboarding.enterprise.oidcSub")}</div>
                  </div>
                </div>
                <${AccountLogin} onFace=${onFace} onLoggedIn=${() => finishConnect([])} />
              </div>`}

              <form class="list" onSubmit=${connectCowork}>
                <div class="row">
                  <div class="who">
                    <div class="name">${t("onboarding.enterprise.coworkTitle")}</div>
                    <div class="sub">${t("onboarding.enterprise.coworkSub")}</div>
                  </div>
                </div>
                <input class="field mono" type="url" value=${coworkUrl} onInput=${(e) => setCoworkUrl(e.target.value)} aria-label="Cowork URL" />
                <input class="field mono" type="password" autocomplete="off" placeholder="emp-..." value=${coworkKey} onInput=${(e) => { setCoworkKey(e.target.value); setErrLocal(""); }} aria-label=${t("onboarding.enterprise.coworkKey")} />
                ${errLocal && html`<div class="err-text" role="alert">${errLocal}</div>`}
                <button type="submit" class="btn primary lg block" disabled=${busyLocal}>
                  ${busyLocal ? html`<${Spinner} /> ${t("onboarding.key.connecting")}` : t("onboarding.enterprise.coworkBtn")}
                </button>
              </form>
            </div>`}
          </div>`}
    </div>
  </main>`;
}
