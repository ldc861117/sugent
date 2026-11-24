import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANONICAL_VISOR_RIG_V1,
  decodeImageBufferToRgba,
  rigAvatarImageBuffer,
  type AvatarEyeStyle,
  type AvatarMotionPersonality,
  type AvatarPackManifest,
  type AvatarRigGeometry,
} from "./avatar-rig.js";
import {
  CANONICAL_POSE_SHEET_META,
  inferPoseSheetLayout,
  rigPoseSheetImageBuffer,
  type PoseSheetLayoutMode,
} from "./avatar-pose-rig.js";
import type { ProviderRegistry } from "./provider-registry.js";

export interface GeminiImageEndpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
  source: "override" | "provider_registry" | "env_gateway" | "env_google";
}

export interface AvatarStudioState {
  activeId: string;
  activePack: AvatarPackManifest;
  packs: AvatarPackManifest[];
  mannequinUrl: string;
  blankMannequinUrl: string;
  imageModelReady: boolean;
  activeImageModel: string;
  imageModelSource: string;
}

export const BUILTIN_AVATAR_PACKS: readonly AvatarPackManifest[] = [
  {
    id: "sugent-core",
    schemaVersion: "pose_sheet_v2",
    name: "曜石雕塑 · Core",
    about: "深炭黑哑光陶瓷全身搭档，配极简微光细节与六态物理舞台。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/sugent-core.png",
    poseSheetUrl: "/amb/static/design/bots/sugent-core-v2-poses.png",
    portraitUrl: "/amb/static/design/bots/sugent-core-v2-portrait.png",
    poseMeta: CANONICAL_POSE_SHEET_META,
    accentColor: "#9fe870",
    hasGlow: true,
    eyeStyle: "capsule",
    eyeColor: "#d7ff00",
    glowColor: "#00f5a0",
    auraHue: 88,
    motionPersonality: "calm",
    rig: CANONICAL_VISOR_RIG_V1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "clay-atelier",
    schemaVersion: "pose_sheet_v2",
    name: "陶白素体 · Atelier",
    about: "2.5 头身哑光高岭土白瓷微缩关节人偶，克制桌面雕塑基准形态。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/sugent-core.png",
    poseSheetUrl: "/amb/static/design/bots/clay-atelier-poses.png",
    portraitUrl: "/amb/static/design/bots/clay-atelier-portrait.png",
    poseMeta: CANONICAL_POSE_SHEET_META,
    accentColor: "#788596",
    hasGlow: false,
    eyeStyle: "minimal",
    eyeColor: "#e8ecef",
    glowColor: "#8ea0b5",
    auraHue: 214,
    motionPersonality: "calm",
    rig: CANONICAL_VISOR_RIG_V1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "blue",
    name: "天天",
    about: "头顶的天线天天在线，消息一到就接住。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/blue.webp",
    hasGlow: false,
    eyeStyle: "round",
    eyeColor: "#6dd4fb",
    glowColor: "#2a9dff",
    auraHue: 245,
    motionPersonality: "lively",
    rig: { eyes: [[38.81, 62.99], [60.82, 62.99]], r: 3.41, earL: [18.14, 62.21], earR: [81.94, 62.21], top: [49.96, 31.78], tip: [49.8, 21.2] },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "yellow",
    name: "闪闪",
    about: "头顶一颗小星星，一笑就闪闪发亮，还会脸红。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/yellow.webp",
    hasGlow: false,
    eyeStyle: "round",
    eyeColor: "#fcfcdc",
    glowColor: "#ffc21a",
    auraHue: 95,
    motionPersonality: "lively",
    rig: { eyes: [[38.34, 63.5], [61.4, 63.48]], r: 3.57, earL: [17.91, 62.13], earR: [82.25, 62.13], top: [50.04, 31.32], tip: [50, 19.7] },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "green",
    name: "芽芽",
    about: "头顶一株嫩芽，每天都长高一点。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/green.webp",
    hasGlow: false,
    eyeStyle: "round",
    eyeColor: "#b5fbd6",
    glowColor: "#2ee88a",
    auraHue: 155,
    motionPersonality: "lively",
    rig: { eyes: [[38.8, 63.07], [61.09, 63.08]], r: 3.49, earL: [17.91, 62.71], earR: [82.02, 62.71], top: [50, 31.32], tip: [50.2, 21.2] },
    createdAt: 1,
    updatedAt: 1,
  },
];

const EXTRA_BUILTIN_AVATARS: readonly AvatarPackManifest[] = [
  {
    id: "red",
    name: "哒哒",
    about: "耳机一戴，节拍就哒哒哒响个不停。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/red.webp",
    hasGlow: true,
    eyeStyle: "round",
    eyeColor: "#fc9379",
    glowColor: "#ff3b2a",
    auraHue: 25,
    motionPersonality: "lively",
    rig: { eyes: [[37.53, 59.46], [62.24, 59.45]], r: 3.88, earL: [19.53, 58.06], earR: [80.47, 58.06], top: [50.04, 28.37], tip: [50, 15] },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "purple",
    name: "晶晶",
    about: "头顶结着一颗水晶，转起来亮晶晶。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/purple.webp",
    hasGlow: true,
    eyeStyle: "round",
    eyeColor: "#fdc1fb",
    glowColor: "#c24dff",
    auraHue: 305,
    motionPersonality: "lively",
    rig: { eyes: [[38.86, 63.04], [60.96, 63.04]], r: 3.49, earL: [18.14, 62.91], earR: [81.94, 62.91], top: [49.84, 32.87], tip: [50, 22] },
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "orange",
    name: "飞飞",
    about: "飞行护目镜一戴，随时准备起飞。",
    kind: "builtin",
    spriteUrl: "/amb/static/design/bots/orange.webp",
    hasGlow: false,
    eyeStyle: "round",
    eyeColor: "#fdd77c",
    glowColor: "#ff8c1a",
    auraHue: 55,
    motionPersonality: "lively",
    rig: {
      eyes: [[38.18, 61.84], [61.83, 61.84]], r: 3.57,
      earL: [15.66, 61.47], earR: [84.34, 61.47], top: [50.12, 27.44], tip: [50, 17],
      lens: [[35.27, 40.85], [64.81, 40.85], 6.4],
    },
    createdAt: 1,
    updatedAt: 1,
  },
];

export const ALL_BUILTIN_AVATARS: readonly AvatarPackManifest[] = [...BUILTIN_AVATAR_PACKS, ...EXTRA_BUILTIN_AVATARS];

export const DEFAULT_GEMINI_IMAGE_MODEL = "gemini-3.1-flash-image-preview";

export function buildVisorToyGenerationPrompt(stylePrompt: string): string {
  const cleanStyle = stylePrompt.trim().slice(0, 600);
  return [
    "Strictly preserve the exact front-facing orthographic silhouette, rounded squircle head proportion, symmetric side ear-pods, centered top stem-and-beacon accessory, and recessed centered rounded dark visor screen from the attached blank mannequin reference image.",
    `Restyle the exterior shell material, color finish, ear-pods, and top beacon according to this design direction: ${cleanStyle}.`,
    "Aesthetic benchmark: Teenage Engineering / Playdate / high-craft matte industrial designer collectible vinyl & anodized metal toy, soft studio product lighting, ultra-crisp edges, isolated cleanly on a pure solid flat #F4F5F7 off-white studio background.",
    "CRITICAL CONSTRAINTS: Keep the central recessed visor screen 100% EMPTY pure glossy dark obsidian glass — ZERO eyes, ZERO pupils, ZERO glowing dots, ZERO faces, ZERO emojis inside the visor screen. Absolutely NO text, NO words, NO letters, NO numbers, NO watermarks, NO pedestals, NO stands, NO floor shadow, NO extra characters, NO tilted three-quarter view.",
  ].join("\n\n");
}

export function buildPoseSheetGenerationPrompt(stylePrompt: string): string {
  const cleanStyle = stylePrompt.trim().slice(0, 600);
  return [
    "Using the attached 3x3 square pose-sheet reference strictly for the 3-column by 3-row pose layout and compact 2.5-head stylized designer-collectible vinyl/ceramic figurine proportions (large expressive sculpted head ~40% of total height, compact torso, charming hands, sturdy compact legs — NEVER lanky realistic anatomy dummy proportions), design a cohesive full-body desktop companion character in this style:",
    cleanStyle,
    "Exact 9-pose 3x3 square layout (NO grid lines, NO borders, NO frames, NO text, NO labels, NO numbers):",
    "- Top row left-to-right (IDENTICAL symmetric forward-seated body on an invisible ledge with legs dangling straight forward and hands resting symmetrically at sides — ONLY the 3D head yaw angle changes!): (1) idle_left — seated body facing front, head genuinely turned 35 degrees to the viewer's LEFT looking left; (2) idle — exact same symmetric seated body, head facing STRAIGHT FRONT (0 degrees) making warm direct eye contact with viewer; (3) idle_right — exact same symmetric seated body, head genuinely turned 35 degrees to the viewer's RIGHT looking right.",
    "- Middle row left-to-right: (4) listening — poised attentive upright posture, head tilted warmly with one hand gently raised near ear/chest listening intently, (5) thinking — calm thoughtful upright stance with one hand resting neatly under chin gazing slightly upward, (6) working — leaning gently forward operating a compact slim glowing pad held with both hands.",
    "- Bottom row left-to-right: (7) waiting — standing upright facing viewer waving one hand warmly, (8) ack — cheerful responsive nod with both hands clasped warmly near chest celebrating completion, (9) sleep — seated low curled comfortably hugging knees peacefully asleep.",
    "Rendering rules: consistent character design and uniform 2.5-head figurine scale across all 9 poses, soft diffused studio lighting, generous clean margin inside each of the 9 cells, isolated cleanly on a pure solid flat uniform #7D8EA3 muted slate-grey studio backdrop with ZERO cast floor shadows, ZERO dividing lines, ZERO borders, ZERO watermarks, and ZERO words.",
  ].join("\n\n");
}

export function resolveGeminiImageEndpoint(opts: {
  override?: Partial<GeminiImageEndpoint>;
  providerRegistry?: ProviderRegistry;
  env?: NodeJS.ProcessEnv;
  requestedModel?: string;
} = {}): GeminiImageEndpoint | undefined {
  const env = opts.env ?? process.env;
  const pickModel = (explicit?: string, providerModels?: string[]) =>
    explicit?.trim() ||
    opts.requestedModel?.trim() ||
    env.SUGENT_IMAGE_MODEL?.trim() ||
    providerModels?.find((m) => /gemini.*image/i.test(m)) ||
    DEFAULT_GEMINI_IMAGE_MODEL;

  if (opts.override?.baseUrl && opts.override?.apiKey) {
    return {
      baseUrl: opts.override.baseUrl.replace(/\/+$/, ""),
      apiKey: opts.override.apiKey,
      model: pickModel(opts.override.model),
      source: "override",
    };
  }
  const list = opts.providerRegistry?.listProviders() ?? [];
  const geminiProv = list.find((p) => p.enabled && p.apiKey && (p.preset === "gemini" || p.models?.some((m) => /gemini.*image/i.test(m))));
  if (geminiProv) {
    return {
      baseUrl: geminiProv.baseUrl.replace(/\/+$/, ""),
      apiKey: geminiProv.apiKey,
      model: pickModel(undefined, geminiProv.models),
      source: "provider_registry",
    };
  }
  const activeProv = opts.providerRegistry?.getDefaultProvider();
  if (activeProv?.enabled && activeProv.apiKey && activeProv.baseUrl) {
    return {
      baseUrl: activeProv.baseUrl.replace(/\/+$/, ""),
      apiKey: activeProv.apiKey,
      model: pickModel(undefined, activeProv.models),
      source: "provider_registry",
    };
  }
  const gwUrl = (env.SUGENT_IMAGE_GATEWAY_URL || env.SUGENT_GATEWAY_URL || env.AMB_MAGPIE_BASE_URL || "").trim().replace(/\/+$/, "");
  const gwKey = (env.SUGENT_IMAGE_GATEWAY_KEY || env.SUGENT_GATEWAY_KEY || env.AMB_MAGPIE_API_KEY || "").trim();
  if (gwUrl && gwKey) {
    return { baseUrl: gwUrl, apiKey: gwKey, model: pickModel(), source: "env_gateway" };
  }
  const googleKey = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  if (googleKey) {
    return { baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: googleKey, model: pickModel(), source: "env_google" };
  }
  return undefined;
}

function decodeDataUrl(dataUrl: string): Buffer | undefined {
  const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl.trim());
  return m ? Buffer.from(m[1]!.replace(/\s+/g, ""), "base64") : undefined;
}

export async function callGeminiImageModel(
  endpoint: GeminiImageEndpoint,
  referencePng: Buffer | null,
  prompt: string,
  fetchImpl: typeof fetch = fetch,
  opts: { aspectRatio?: "1:1" | "3:2" } = {},
): Promise<{ imageBuffer: Buffer; wireProtocol: "gemini-generate-content" | "openai-chat-completions" }> {
  const aspectRatio = opts.aspectRatio ?? "1:1";
  const base = endpoint.baseUrl.replace(/\/+$/, "");
  const root = base.replace(/\/v1beta(?:\/openai)?$/, "").replace(/\/v1$/, "");
  const isOfficialGoogle = /generativelanguage\.googleapis\.com/i.test(base);
  const nativeUrl = `${root}/v1beta/models/${encodeURIComponent(endpoint.model)}:generateContent`;
  const nativeHeaders: Record<string, string> = {
    "content-type": "application/json",
    ...(isOfficialGoogle ? { "x-goog-api-key": endpoint.apiKey } : { Authorization: `Bearer ${endpoint.apiKey}` }),
  };
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (referencePng) parts.push({ inlineData: { mimeType: "image/png", data: referencePng.toString("base64") } });
  const nativeBody = {
    contents: [{ role: "user", parts }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio } },
  };
  let nativeErr = "";
  try {
    const res = await fetchImpl(nativeUrl, { method: "POST", headers: nativeHeaders, body: JSON.stringify(nativeBody), signal: AbortSignal.timeout(90_000) });
    if (res.ok) {
      const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string }; inline_data?: { data?: string } }> } }> };
      for (const c of json.candidates ?? []) for (const p of c.content?.parts ?? []) {
        const b64 = p.inlineData?.data ?? p.inline_data?.data;
        if (b64) return { imageBuffer: Buffer.from(b64, "base64"), wireProtocol: "gemini-generate-content" };
      }
      nativeErr = "Gemini generateContent returned no image part";
    } else nativeErr = `HTTP ${res.status}`;
  } catch (e) { nativeErr = (e as Error).message; }
  const chatUrl = `${base.endsWith("/v1") ? base : `${root}/v1`}/chat/completions`;
  const chatContent: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (referencePng) chatContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${referencePng.toString("base64")}` } });
  const chatBody = {
    model: endpoint.model,
    messages: [{ role: "user", content: chatContent }],
  };
  const chatRes = await fetchImpl(chatUrl, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${endpoint.apiKey}` }, body: JSON.stringify(chatBody), signal: AbortSignal.timeout(90_000) });
  if (!chatRes.ok) throw new Error(`Gemini 图像生成失败（原生: ${nativeErr}；回退: HTTP ${chatRes.status}）`);
  const chatJson = (await chatRes.json()) as { choices?: Array<{ message?: { content?: unknown; images?: Array<{ image_url?: { url?: string } }> } }> };
  const msg = chatJson.choices?.[0]?.message;
  for (const img of msg?.images ?? []) {
    const buf = img.image_url?.url ? decodeDataUrl(img.image_url.url) : undefined;
    if (buf) return { imageBuffer: buf, wireProtocol: "openai-chat-completions" };
  }
  const rawContent = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "");
  const m = /data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=\s]+/.exec(rawContent);
  const buf = m ? decodeDataUrl(m[0]) : undefined;
  if (!buf) throw new Error(`图像模型未返回可解析图片（${nativeErr}）`);
  return { imageBuffer: buf, wireProtocol: "openai-chat-completions" };
}

export interface GenerateCustomAvatarInput {
  name?: string;
  prompt: string;
  model?: string;
  legacyVisor?: boolean;
  accentColor?: string;
  eyeStyle?: AvatarEyeStyle;
  eyeColor?: string;
  glowColor?: string;
  auraHue?: number;
  motionPersonality?: AvatarMotionPersonality;
}

export interface ImportCustomAvatarInput {
  name?: string;
  dataBase64: string;
  layout?: PoseSheetLayoutMode;
  stylePrompt?: string;
  accentColor?: string;
  eyeStyle?: AvatarEyeStyle;
  eyeColor?: string;
  glowColor?: string;
  auraHue?: number;
  motionPersonality?: AvatarMotionPersonality;
}

export interface CustomizeAvatarInput {
  id: string;
  name?: string;
  accentColor?: string;
  eyeStyle?: AvatarEyeStyle;
  eyeColor?: string;
  glowColor?: string;
  auraHue?: number;
  motionPersonality?: AvatarMotionPersonality;
}

const VALID_ID = /^[a-z0-9][a-z0-9_-]{0,48}$/;
const EYE_STYLES = new Set<AvatarEyeStyle>(["capsule", "round", "visor", "minimal"]);
const PERSONALITIES = new Set<AvatarMotionPersonality>(["calm", "lively", "minimal"]);

export class SugentAvatarStudio {
  private readonly storeDir: string;
  private readonly activePath: string;
  private readonly overridesPath: string;
  private readonly blankAssetPath: string;
  private readonly mannequinAssetPath: string;

  constructor(
    dataDir: string,
    private readonly opts: {
      providerRegistry?: ProviderRegistry;
      endpointOverride?: Partial<GeminiImageEndpoint>;
      blankAssetPath?: string;
      mannequinAssetPath?: string;
      fetchImpl?: typeof fetch;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.storeDir = path.join(path.resolve(dataDir), "avatars");
    this.activePath = path.join(this.storeDir, "active.json");
    this.overridesPath = path.join(this.storeDir, "builtin-overrides.json");
    const modDir = path.dirname(fileURLToPath(import.meta.url));
    const pickAsset = (explicit: string | undefined, file: string) => {
      const list = [
        explicit,
        path.resolve(process.cwd(), "ui", "design", "bots", file),
        path.resolve(modDir, "..", "..", "ui", "design", "bots", file),
        path.resolve(modDir, "..", "..", "..", "ui", "design", "bots", file),
      ].filter((x): x is string => Boolean(x));
      return list.find((p) => fs.existsSync(p)) ?? list[0]!;
    };
    this.blankAssetPath = pickAsset(opts.blankAssetPath, "blank-visor-toy.png");
    this.mannequinAssetPath = pickAsset(opts.mannequinAssetPath, "mannequin-pose-sheet-v2.png");
    fs.mkdirSync(this.storeDir, { recursive: true });
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      return fs.existsSync(filePath) ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  }

  private getOverrides(): Record<string, Partial<AvatarPackManifest>> {
    return this.readJson<Record<string, Partial<AvatarPackManifest>>>(this.overridesPath, {});
  }

  private listCustomPacks(): AvatarPackManifest[] {
    if (!fs.existsSync(this.storeDir)) return [];
    const out: AvatarPackManifest[] = [];
    for (const ent of fs.readdirSync(this.storeDir, { withFileTypes: true })) {
      if (!ent.isDirectory() || !VALID_ID.test(ent.name)) continue;
      const manifestPath = path.join(this.storeDir, ent.name, "manifest.json");
      if (!fs.existsSync(manifestPath)) continue;
      const parsed = this.readJson<AvatarPackManifest | null>(manifestPath, null);
      if (parsed?.id) out.push(parsed);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listPacks(): AvatarPackManifest[] {
    const overrides = this.getOverrides();
    const builtins = ALL_BUILTIN_AVATARS.map((b) => ({
      ...b,
      ...(overrides[b.id] ?? {}),
      id: b.id,
      kind: "builtin" as const,
      spriteUrl: b.spriteUrl,
      ...(b.poseSheetUrl ? { poseSheetUrl: b.poseSheetUrl } : {}),
      ...(b.portraitUrl ? { portraitUrl: b.portraitUrl } : {}),
    }));
    return [builtins[0]!, builtins[1]!, ...this.listCustomPacks(), ...builtins.slice(2)];
  }

  getActiveId(): string {
    const saved = this.readJson<{ activeId?: string }>(this.activePath, {});
    const packs = this.listPacks();
    if (saved.activeId && packs.some((p) => p.id === saved.activeId)) return saved.activeId;
    return "sugent-core";
  }

  getActivePack(): AvatarPackManifest {
    const activeId = this.getActiveId();
    return this.listPacks().find((p) => p.id === activeId) ?? ALL_BUILTIN_AVATARS[0]!;
  }

  listState(): AvatarStudioState {
    const packs = this.listPacks();
    const activeId = this.getActiveId();
    const activePack = packs.find((p) => p.id === activeId) ?? packs[0]!;
    const ep = resolveGeminiImageEndpoint({
      override: this.opts.endpointOverride,
      providerRegistry: this.opts.providerRegistry,
      env: this.opts.env,
    });
    const hasMannequin = fs.existsSync(this.mannequinAssetPath);
    return {
      activeId,
      activePack,
      packs,
      mannequinUrl: hasMannequin ? "/amb/api/steward/avatars/asset?kind=mannequin" : "/amb/api/steward/avatars/asset?kind=blank",
      blankMannequinUrl: "/amb/api/steward/avatars/asset?kind=blank",
      imageModelReady: Boolean(ep),
      activeImageModel: ep?.model ?? DEFAULT_GEMINI_IMAGE_MODEL,
      imageModelSource: ep?.source ?? "none",
    };
  }

  setActivePack(id: string): AvatarStudioState {
    const packs = this.listPacks();
    if (!packs.some((p) => p.id === id)) throw new Error(`未知形象包: ${id}`);
    this.writeJson(this.activePath, { activeId: id, updatedAt: Date.now() });
    return this.listState();
  }

  updatePackAppearance(input: CustomizeAvatarInput): { pack: AvatarPackManifest; state: AvatarStudioState } {
    const packs = this.listPacks();
    const cur = packs.find((p) => p.id === input.id);
    if (!cur) throw new Error(`未知形象包: ${input.id}`);
    const patch: Partial<AvatarPackManifest> = { updatedAt: Date.now() };
    if (typeof input.name === "string" && input.name.trim()) patch.name = input.name.trim().slice(0, 48);
    if (input.eyeStyle && EYE_STYLES.has(input.eyeStyle)) patch.eyeStyle = input.eyeStyle;
    if (typeof input.accentColor === "string" && /^#[0-9a-fA-F]{6}$/.test(input.accentColor.trim())) patch.accentColor = input.accentColor.trim();
    if (typeof input.eyeColor === "string" && /^#[0-9a-fA-F]{6}$/.test(input.eyeColor.trim())) patch.eyeColor = input.eyeColor.trim();
    if (typeof input.glowColor === "string" && /^#[0-9a-fA-F]{6}$/.test(input.glowColor.trim())) patch.glowColor = input.glowColor.trim();
    if (typeof input.auraHue === "number" && Number.isFinite(input.auraHue)) patch.auraHue = ((Math.round(input.auraHue) % 360) + 360) % 360;
    if (input.motionPersonality && PERSONALITIES.has(input.motionPersonality)) patch.motionPersonality = input.motionPersonality;

    if (cur.kind === "builtin") {
      const overrides = this.getOverrides();
      overrides[cur.id] = { ...(overrides[cur.id] ?? {}), ...patch };
      this.writeJson(this.overridesPath, overrides);
    } else {
      const next = { ...cur, ...patch, id: cur.id, kind: "custom" as const };
      this.writeJson(path.join(this.storeDir, cur.id, "manifest.json"), next);
    }
    const state = this.listState();
    return { pack: state.packs.find((p) => p.id === cur.id)!, state };
  }

  private persistPoseSheetPack(
    imageBuffer: Buffer,
    meta: {
      name: string;
      about: string;
      stylePrompt?: string;
      accentColor?: string;
      eyeStyle?: AvatarEyeStyle;
      eyeColor?: string;
      glowColor?: string;
      auraHue?: number;
      motionPersonality?: AvatarMotionPersonality;
    },
    layout?: PoseSheetLayoutMode,
  ): { pack: AvatarPackManifest; state: AvatarStudioState; warnings: string[] } {
    const rigged = rigPoseSheetImageBuffer(imageBuffer, layout ? { layout } : {});
    const id = `ava-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const dir = path.join(this.storeDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "poses.png"), rigged.poseSheetPng);
    fs.writeFileSync(path.join(dir, "portrait.png"), rigged.portraitPng);
    const now = Date.now();
    const validHex = (s: string | undefined, fb: string) => (s && /^#[0-9a-fA-F]{6}$/.test(s) ? s : fb);
    const pack: AvatarPackManifest = {
      id,
      schemaVersion: "pose_sheet_v2",
      name: meta.name.trim().slice(0, 48) || "定制雕塑搭档",
      about: meta.about.trim().slice(0, 120) || "由 3×3 全身素体定制生成并自动切分对齐。",
      kind: "custom",
      ...(meta.stylePrompt ? { stylePrompt: meta.stylePrompt.slice(0, 400) } : {}),
      spriteUrl: "/amb/static/design/bots/sugent-core.png",
      poseSheetUrl: `/amb/api/steward/avatars/asset?id=${encodeURIComponent(id)}&kind=poses`,
      portraitUrl: `/amb/api/steward/avatars/asset?id=${encodeURIComponent(id)}&kind=portrait`,
      poseMeta: rigged.poseMeta,
      accentColor: validHex(meta.accentColor, validHex(meta.eyeColor, "#9fe870")),
      hasGlow: false,
      eyeStyle: meta.eyeStyle && EYE_STYLES.has(meta.eyeStyle) ? meta.eyeStyle : "minimal",
      eyeColor: validHex(meta.eyeColor, "#d7ff00"),
      glowColor: validHex(meta.glowColor, "#00f5a0"),
      auraHue: typeof meta.auraHue === "number" && Number.isFinite(meta.auraHue) ? ((Math.round(meta.auraHue) % 360) + 360) % 360 : 88,
      motionPersonality: meta.motionPersonality && PERSONALITIES.has(meta.motionPersonality) ? meta.motionPersonality : "calm",
      rig: CANONICAL_VISOR_RIG_V1,
      createdAt: now,
      updatedAt: now,
    };
    this.writeJson(path.join(dir, "manifest.json"), pack);
    const state = this.setActivePack(id);
    return { pack, state, warnings: rigged.warnings };
  }

  private persistRiggedPack(
    imageBuffer: Buffer,
    meta: {
      name: string;
      about: string;
      stylePrompt?: string;
      eyeStyle?: AvatarEyeStyle;
      eyeColor?: string;
      glowColor?: string;
      auraHue?: number;
      motionPersonality?: AvatarMotionPersonality;
    },
  ): { pack: AvatarPackManifest; state: AvatarStudioState; warnings: string[] } {
    const rigged = rigAvatarImageBuffer(imageBuffer, { cleanVisor: true, preserveGlow: true });
    const id = `ava-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
    const dir = path.join(this.storeDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sprite.png"), rigged.spritePng);
    fs.writeFileSync(path.join(dir, "source.png"), rigged.sourcePng);
    const now = Date.now();
    const pack: AvatarPackManifest = {
      id,
      name: meta.name.trim().slice(0, 48) || "定制面罩搭档",
      about: meta.about.trim().slice(0, 120) || "由素体白模定制生成并自动装配。",
      kind: "custom",
      ...(meta.stylePrompt ? { stylePrompt: meta.stylePrompt.slice(0, 400) } : {}),
      spriteUrl: `/amb/api/steward/avatars/asset?id=${encodeURIComponent(id)}&kind=sprite`,
      sourceUrl: `/amb/api/steward/avatars/asset?id=${encodeURIComponent(id)}&kind=source`,
      hasGlow: rigged.hasGlow,
      eyeStyle: meta.eyeStyle && EYE_STYLES.has(meta.eyeStyle) ? meta.eyeStyle : "capsule",
      eyeColor: meta.eyeColor && /^#[0-9a-fA-F]{6}$/.test(meta.eyeColor) ? meta.eyeColor : "#d7ff00",
      glowColor: meta.glowColor && /^#[0-9a-fA-F]{6}$/.test(meta.glowColor) ? meta.glowColor : "#00f5a0",
      auraHue: typeof meta.auraHue === "number" && Number.isFinite(meta.auraHue) ? ((Math.round(meta.auraHue) % 360) + 360) % 360 : 84,
      motionPersonality: meta.motionPersonality && PERSONALITIES.has(meta.motionPersonality) ? meta.motionPersonality : "calm",
      rig: rigged.rig,
      createdAt: now,
      updatedAt: now,
    };
    this.writeJson(path.join(dir, "manifest.json"), pack);
    const state = this.setActivePack(id);
    return { pack, state, warnings: rigged.warnings };
  }

  async generateFromBlank(input: GenerateCustomAvatarInput): Promise<{ ok: true; pack: AvatarPackManifest; state: AvatarStudioState; wireProtocol: string; warnings: string[] }> {
    const style = String(input.prompt ?? "").trim();
    if (!style) throw new Error("请填写形象风格描述");
    const ep = resolveGeminiImageEndpoint({
      override: this.opts.endpointOverride,
      providerRegistry: this.opts.providerRegistry,
      env: this.opts.env,
      requestedModel: input.model,
    });
    if (!ep) throw new Error("尚未配置可用的 Gemini 图像模型或网关，请先配置 API Key 或使用本地图片导入");
    const useLegacy = input.legacyVisor === true || !fs.existsSync(this.mannequinAssetPath);
    if (useLegacy) {
      if (!fs.existsSync(this.blankAssetPath)) throw new Error(`找不到素体白模文件: ${this.blankAssetPath}`);
      const blankPng = fs.readFileSync(this.blankAssetPath);
      const { imageBuffer, wireProtocol } = await callGeminiImageModel(ep, blankPng, buildVisorToyGenerationPrompt(style), this.opts.fetchImpl);
      const saved = this.persistRiggedPack(imageBuffer, {
        name: input.name?.trim() || style.slice(0, 16),
        about: `Gemini (${ep.model}) 定制生成`,
        stylePrompt: style,
        eyeStyle: input.eyeStyle,
        eyeColor: input.eyeColor,
        glowColor: input.glowColor,
        auraHue: input.auraHue,
        motionPersonality: input.motionPersonality,
      });
      return { ok: true, ...saved, wireProtocol };
    }
    const refPng = fs.readFileSync(this.mannequinAssetPath);
    const { imageBuffer, wireProtocol } = await callGeminiImageModel(ep, refPng, buildPoseSheetGenerationPrompt(style), this.opts.fetchImpl, { aspectRatio: "1:1" });
    const saved = this.persistPoseSheetPack(imageBuffer, {
      name: input.name?.trim() || style.slice(0, 16),
      about: `Gemini (${ep.model}) 3×3 全身雕塑生成`,
      stylePrompt: style,
      accentColor: input.accentColor,
      eyeStyle: input.eyeStyle,
      eyeColor: input.eyeColor,
      glowColor: input.glowColor,
      auraHue: input.auraHue,
      motionPersonality: input.motionPersonality,
    });
    return { ok: true, ...saved, wireProtocol };
  }

  importFromImage(input: ImportCustomAvatarInput): { ok: true; pack: AvatarPackManifest; state: AvatarStudioState; warnings: string[] } {
    const raw = String(input.dataBase64 ?? "").trim();
    const cleaned = raw.includes(",") ? raw.split(",")[1] ?? "" : raw;
    const buf = Buffer.from(cleaned, "base64");
    if (!buf.length) throw new Error("图片数据为空");
    const layout: PoseSheetLayoutMode = input.layout ?? inferPoseSheetLayout(buf);
    const saved = this.persistPoseSheetPack(
      buf,
      {
        name: input.name?.trim() || "本地定制形象",
        about: layout === "single" ? "本地单图立绘自动装配" : layout === "grid_3x3" ? "本地 3×3 姿态板自动切分装配" : "本地 3×2 姿态板自动切分装配",
        stylePrompt: input.stylePrompt,
        accentColor: input.accentColor,
        eyeStyle: input.eyeStyle,
        eyeColor: input.eyeColor,
        glowColor: input.glowColor,
        auraHue: input.auraHue,
        motionPersonality: input.motionPersonality,
      },
      layout,
    );
    return { ok: true, ...saved };
  }

  deletePack(id: string): AvatarStudioState {
    if (ALL_BUILTIN_AVATARS.some((b) => b.id === id)) throw new Error("内置默认形象不可删除");
    if (!VALID_ID.test(id)) throw new Error("非法形象包 ID");
    const dir = path.join(this.storeDir, id);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (this.getActiveId() === id) this.setActivePack("sugent-core");
    return this.listState();
  }

  resolveAssetFile(id: string, kind: "sprite" | "source" | "blank" | "poses" | "portrait" | "mannequin"): string | undefined {
    if (kind === "mannequin") return fs.existsSync(this.mannequinAssetPath) ? this.mannequinAssetPath : fs.existsSync(this.blankAssetPath) ? this.blankAssetPath : undefined;
    if (kind === "blank") return fs.existsSync(this.blankAssetPath) ? this.blankAssetPath : undefined;
    if (!VALID_ID.test(id)) return undefined;
    const base = path.resolve(this.storeDir);
    const fileMap: Record<string, string[]> = {
      poses: ["poses.png", "sprite.png"],
      portrait: ["portrait.png", "source.png"],
      source: ["source.png", "portrait.png"],
      sprite: ["sprite.png", "poses.png"],
    };
    for (const fileName of fileMap[kind] ?? ["sprite.png"]) {
      const target = path.resolve(base, id, fileName);
      if (target.startsWith(base + path.sep) && fs.existsSync(target)) return target;
    }
    return undefined;
  }
}
