import { useEffect, useRef, useState } from "preact/hooks";
import { html, Button, Seg } from "./ui.js";
import { BotAvatar, setAvatarStudioState, useAvatarStudio } from "./avatar.js";
import { api } from "../lib/api.js";
import { failed, toast } from "../lib/store.js";
import { t } from "../lib/i18n.js";

const PREVIEW_STATES = ["idle", "listening", "thinking", "working", "waiting", "sleep"];
const PREVIEW_CUES = ["hello", "done", "error"];
const SWATCHES = [
  { id: "lime", cls: "lime", eyeHex: "#d7ff00", glowHex: "#00f5a0", auraHue: 84 },
  { id: "cyan", cls: "cyan", eyeHex: "#6dd4fb", glowHex: "#2a9dff", auraHue: 245 },
  { id: "amber", cls: "amber", eyeHex: "#fcfcdc", glowHex: "#ffc21a", auraHue: 95 },
  { id: "emerald", cls: "emerald", eyeHex: "#b5fbd6", glowHex: "#2ee88a", auraHue: 155 },
  { id: "coral", cls: "coral", eyeHex: "#fc9379", glowHex: "#ff3b2a", auraHue: 25 },
  { id: "violet", cls: "violet", eyeHex: "#fdc1fb", glowHex: "#c24dff", auraHue: 305 },
  { id: "orange", cls: "orange", eyeHex: "#fdd77c", glowHex: "#ff8c1a", auraHue: 55 },
];

export function AvatarStudioScreen() {
  const studio = useAvatarStudio(true);
  const active = studio?.activePack;
  const packs = studio?.packs || [];
  const [stageState, setStageState] = useState("idle");
  const [stageCue, setStageCue] = useState(null);
  const [facing, setFacing] = useState("left");
  const [swingDemo, setSwingDemo] = useState({ dragging: false, vx: 0 });
  const [importLayout, setImportLayout] = useState("grid_3x2");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  const bcRef = useRef(null);

  useEffect(() => {
    try {
      if (typeof BroadcastChannel !== "undefined") bcRef.current = new BroadcastChannel("sugent-companion-bus");
    } catch { /* ignore */ }
    return () => {
      try { bcRef.current?.close(); } catch { /* ignore */ }
      bcRef.current = null;
    };
  }, []);

  const notifyCompanionStudio = () => {
    try { bcRef.current?.postMessage({ kind: "studio_updated", at: Date.now() }); } catch { /* ignore */ }
  };

  const triggerSwing = () => {
    setSwingDemo({ dragging: true, vx: 14 });
    setTimeout(() => setSwingDemo({ dragging: true, vx: -12 }), 180);
    setTimeout(() => setSwingDemo({ dragging: false, vx: 0 }), 380);
  };

  const activate = async (p) => {
    setBusy(true);
    try {
      const next = await api("/steward/avatars/activate", { method: "POST", body: { id: p.id } });
      setAvatarStudioState(next);
      notifyCompanionStudio();
      toast(t("steward.studio.activatedToast", { name: p.name }));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const customize = async (patch) => {
    if (!active) return;
    setBusy(true);
    try {
      const res = await api("/steward/avatars/customize", { method: "PUT", body: { id: active.id, ...patch } });
      if (res?.state) setAvatarStudioState(res.state);
      notifyCompanionStudio();
      toast(t("steward.studio.savedToast"));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const generate = async () => {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt || busy) return;
    setBusy(true);
    try {
      const res = await api("/steward/avatars/generate", {
        method: "POST",
        body: {
          name: name.trim() || undefined,
          prompt: cleanPrompt,
          accentColor: active?.accentColor || active?.eyeColor,
          eyeStyle: active?.eyeStyle || "minimal",
          eyeColor: active?.eyeColor,
          glowColor: active?.glowColor,
          auraHue: active?.auraHue,
          motionPersonality: active?.motionPersonality || "calm",
        },
      });
      if (res?.state) setAvatarStudioState(res.state);
      notifyCompanionStudio();
      setStageCue({ kind: "hello", at: Date.now() });
      toast(t("steward.studio.generatedToast", { name: res.pack?.name || "" }));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const onFilePick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result || ""));
        r.onerror = () => reject(new Error("Read failed"));
        r.readAsDataURL(file);
      });
      const res = await api("/steward/avatars/import", {
        method: "POST",
        body: { name: name.trim() || file.name.replace(/\.[^.]+$/, ""), dataBase64: dataUrl, layout: importLayout },
      });
      if (res?.state) setAvatarStudioState(res.state);
      notifyCompanionStudio();
      setStageCue({ kind: "hello", at: Date.now() });
      toast(t("steward.studio.importedToast", { name: res.pack?.name || "" }));
    } catch (err) { failed(err); } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removePack = async (p) => {
    setBusy(true);
    try {
      const next = await api(`/steward/avatars/${encodeURIComponent(p.id)}`, { method: "DELETE" });
      setAvatarStudioState(next);
      notifyCompanionStudio();
      toast(t("steward.studio.deletedToast"));
    } catch (e) { failed(e); } finally { setBusy(false); }
  };

  const applyPreset = (key) => {
    setName(t(`steward.studio.presets.${key}`));
    setPrompt(t(`steward.studio.presets.${key}Prompt`));
  };

  return html`<section class="sg-page" data-screen="avatar-studio">
    <div class="sg-page-inner">
      <header class="sg-head">
        <div>
          <h1 class="sg-title">${t("steward.studio.title")}</h1>
          <p class="sg-sub">${t("steward.studio.subtitle")}</p>
        </div>
        <span class="sg-badge-pill">${studio?.imageModelReady ? t("steward.studio.modelReady", { model: studio.activeImageModel }) : t("steward.studio.modelMissing")}</span>
      </header>
      <div class="studio-hero">
        <div class="studio-stage">
          <${BotAvatar}
            useActivePack
            pack=${active}
            size=${164}
            state=${stageState}
            cue=${stageCue}
            facing=${facing}
            dragging=${swingDemo.dragging}
            dragVx=${swingDemo.vx}
            lively
            pokeable
            greet
          />
          <div class="studio-chips">
            ${PREVIEW_STATES.map((s) => html`<button type="button" key=${s} class=${`btn sm${stageState === s ? " primary" : ""}`} onClick=${() => setStageState(s)}>${t(`steward.studio.states.${s}`)}</button>`)}
          </div>
          <div class="studio-chips">
            ${PREVIEW_CUES.map((c) => html`<button type="button" key=${c} class="btn sm" onClick=${() => setStageCue({ kind: c, at: Date.now() })}>${t(`steward.studio.cues.${c}`)}</button>`)}
            <button type="button" class="btn sm" onClick=${() => setFacing((f) => (f === "left" ? "right" : "left"))}>${t("steward.studio.flipBtn")}</button>
            <button type="button" class="btn sm" onClick=${triggerSwing}>${t("steward.studio.dragTestBtn")}</button>
          </div>
        </div>
        <div class="sg-card">
          <div class="studio-blank-row">
            <img class="studio-blank-thumb" src=${studio?.mannequinUrl || "/amb/static/design/bots/mannequin-pose-sheet-v2.png"} alt="" />
            <div>
              <div class="sg-card-title">${t("steward.studio.blankTitle")}</div>
              <div class="sg-card-hint">${t("steward.studio.blankHint")}</div>
            </div>
          </div>
          <div class="studio-chips">
            ${["atelier", "braun", "shiba", "pixel"].map((k) => html`<button type="button" key=${k} class="btn sm" onClick=${() => applyPreset(k)}>${t(`steward.studio.presets.${k}`)}</button>`)}
          </div>
          <input class="field" value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${t("steward.studio.namePlaceholder")} />
          <textarea class="field" rows="3" value=${prompt} onInput=${(e) => setPrompt(e.target.value)} placeholder=${t("steward.studio.promptPlaceholder")}></textarea>
          <div class="sg-actions">
            <${Button} variant="primary" loading=${busy} disabled=${!prompt.trim() || !studio?.imageModelReady} onClick=${generate}>${busy ? t("steward.studio.generatingBtn") : t("steward.studio.generateBtn")}<//>
            <${Seg} label=${t("steward.studio.importBtn")} value=${importLayout} onChange=${setImportLayout}
              options=${[["grid_3x2", t("steward.studio.layoutGrid")], ["single", t("steward.studio.layoutSingle")]]} />
            <input ref=${fileRef} class="sg-file-hidden" type="file" accept="image/*" onChange=${onFilePick} />
            <button type="button" class="btn" disabled=${busy} onClick=${() => fileRef.current?.click()}>${t("steward.studio.importBtn")}</button>
          </div>
          <div class="sg-card-hint">${t("steward.studio.importHint")}</div>
        </div>
      </div>
      <div class="sg-card">
        <div class="sg-card-head"><span class="sg-card-title">${t("steward.studio.tuneTitle")}</span><span class="sg-card-hint">${active?.name || ""}</span></div>
        ${active?.schemaVersion === "visor_v1" && html`<div class="sg-row">
          <span>${t("steward.studio.eyeStyleLabel")}</span>
          <${Seg} label=${t("steward.studio.eyeStyleLabel")} value=${active?.eyeStyle || "capsule"} onChange=${(v) => customize({ eyeStyle: v })}
            options=${["capsule", "round", "visor", "minimal"].map((v) => [v, t(`steward.studio.eyeStyles.${v}`)])} />
        </div>`}
        <div class="sg-row">
          <span>${t("steward.studio.paletteLabel")}</span>
          <div class="studio-swatches">
            ${SWATCHES.map((s) => html`<button type="button" key=${s.id} class=${`studio-swatch${(active?.accentColor || active?.eyeColor || "").toLowerCase() === s.eyeHex ? " on" : ""}`}
              onClick=${() => customize({ accentColor: s.eyeHex, eyeColor: s.eyeHex, glowColor: s.glowHex, auraHue: s.auraHue })}><span class=${`studio-swatch-dot ${s.cls}`}></span></button>`)}
          </div>
        </div>
        <div class="sg-row">
          <span>${t("steward.studio.motionLabel")}</span>
          <${Seg} label=${t("steward.studio.motionLabel")} value=${active?.motionPersonality || "calm"} onChange=${(v) => customize({ motionPersonality: v })}
            options=${["calm", "lively", "minimal"].map((v) => [v, t(`steward.studio.motions.${v}`)])} />
        </div>
      </div>
      <div class="sg-card">
        <div class="sg-card-head"><span class="sg-card-title">${t("steward.studio.packsTitle")}</span><span class="sg-card-hint">${packs.length}</span></div>
        <div class="studio-packs">
          ${packs.map((p) => html`<div key=${p.id} class=${`studio-pack${p.id === active?.id ? " on" : ""}`}>
            <${BotAvatar} pack=${p} size=${48} state=${p.id === active?.id ? "listening" : "idle"} />
            <div class="sg-card-title">${p.name}</div>
            <div class="sg-actions">
              ${p.id === active?.id
                ? html`<span class="sg-badge-pill">${t("steward.studio.activeBadge")}</span>`
                : html`<button type="button" class="btn sm" disabled=${busy} onClick=${() => activate(p)}>${t("steward.studio.activeBadge")}</button>`}
              ${p.kind === "custom" && html`<button type="button" class="text danger" disabled=${busy} onClick=${() => removePack(p)}>${t("steward.studio.deleteBtn")}</button>`}
            </div>
          </div>`)}
        </div>
      </div>
    </div>
  </section>`;
}
