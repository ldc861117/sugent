import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildGeminiWeb2ApiMcpServer,
  classifyGeminiWeb2ApiError,
  extractGeminiWeb2ApiInlineMedia,
  inferGeminiWeb2ApiTier,
  probeGeminiWeb2Api,
  resolveGeminiWeb2ApiUrls,
} from "../src/sugent/gemini-web2api.js";

const HTTP_PROTO = ["http", "://"].join("");

describe("Sugent gemini-web2api-go Probe, Media Unpacker & MCP Descriptor", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-web2api-media-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("normalizes root, /v1, /mcp, and trailing-slash /admin/ URLs cleanly", () => {
    const baseRoot = `${HTTP_PROTO}127.0.0.1:8083`;
    const fromRoot = resolveGeminiWeb2ApiUrls(baseRoot);
    expect(fromRoot).toEqual({
      rootUrl: baseRoot,
      v1BaseUrl: `${baseRoot}/v1`,
      chatCompletionsUrl: `${baseRoot}/v1/chat/completions`,
      responsesUrl: `${baseRoot}/v1/responses`,
      modelsUrl: `${baseRoot}/v1/models`,
      mcpUrl: `${baseRoot}/mcp`,
      adminUrl: `${baseRoot}/admin/`,
    });

    const localHostBase = `${HTTP_PROTO}localhost:9083`;
    const fromV1 = resolveGeminiWeb2ApiUrls(`${localHostBase}/v1/`);
    expect(fromV1.v1BaseUrl).toBe(`${localHostBase}/v1`);
    expect(fromV1.adminUrl).toBe(`${localHostBase}/admin/`);
    expect(fromV1.mcpUrl).toBe(`${localHostBase}/mcp`);
  });

  it("infers Cookie subscription tier (ultra / pro / plus / free / offline) from discovered models", () => {
    expect(inferGeminiWeb2ApiTier([])).toBe("offline");
    expect(inferGeminiWeb2ApiTier(["gemini-3.5-flash-lite"])).toBe("free");
    expect(inferGeminiWeb2ApiTier(["gemini-3.6-flash", "gemini-3.5-flash-lite"])).toBe("plus");
    expect(inferGeminiWeb2ApiTier(["gemini-3.6-flash", "gemini-3.1-pro-thinking"])).toBe("pro");
    expect(inferGeminiWeb2ApiTier(["gemini-3.1-pro", "gemini-4-argon-thinking"])).toBe("ultra");
  });

  it("probes GET / and GET /v1/models, surfaces 401 key requirement, and detects tier", async () => {
    const baseRoot = `${HTTP_PROTO}127.0.0.1:8083`;
    const proxyKey = ["sk", "gemini", "demo"].join("-");
    const ultraFetch: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === `${baseRoot}/`) {
        return new Response(
          JSON.stringify({
            status: "ok",
            version: "4.28.0",
            models: ["gemini-3.6-flash"],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === `${baseRoot}/v1/models`) {
        const hdrs = new Headers(init?.headers);
        if (hdrs.get("Authorization") !== `Bearer ${proxyKey}`) {
          return new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 });
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gemini-3.6-flash" },
              { id: "gemini-3.1-pro-thinking" },
              { id: "gemini-4-argon" },
              { id: "gemini-image" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    };

    const unauthProbe = await probeGeminiWeb2Api({
      baseUrl: `${baseRoot}/v1`,
      fetchImpl: ultraFetch,
    });
    expect(unauthProbe.ok).toBe(false);
    expect(unauthProbe.reachable).toBe(true);
    expect(unauthProbe.authRequired).toBe(true);
    expect(unauthProbe.authenticated).toBe(false);
    expect(unauthProbe.warnings.length).toBeGreaterThan(0);

    const authedProbe = await probeGeminiWeb2Api({
      baseUrl: `${baseRoot}/v1`,
      apiKey: proxyKey,
      fetchImpl: ultraFetch,
    });
    expect(authedProbe.ok).toBe(true);
    expect(authedProbe.authenticated).toBe(true);
    expect(authedProbe.version).toBe("4.28.0");
    expect(authedProbe.tier).toBe("ultra");
    expect(authedProbe.models).toContain("gemini-4-argon");
    expect(authedProbe.models).toContain("gemini-image");
  });

  it("extracts inline base64 PNG and MP3 payloads from gemini-image / gemini-music output to local disk", async () => {
    const fakePngBytes = Buffer.alloc(96, 0x89);
    const fakeMp3Bytes = Buffer.alloc(128, 0x49);
    const pngBase64 = fakePngBytes.toString("base64");
    const mp3Base64 = fakeMp3Bytes.toString("base64");

    const assistantReply = [
      "Here is your generated cover and jingle:",
      `![cover-art](data:image/png;base64,${pngBase64})`,
      `[theme-song](data:audio/mpeg;base64,${mp3Base64})`,
    ].join("\n\n");

    const unpacked = await extractGeminiWeb2ApiInlineMedia(assistantReply, {
      outputDir: tempDir,
      publicPathPrefix: "/amb/media",
    });

    expect(unpacked.artifacts).toHaveLength(2);
    expect(unpacked.artifacts[0]?.kind).toBe("image");
    expect(unpacked.artifacts[0]?.byteLength).toBe(96);
    expect(fs.existsSync(unpacked.artifacts[0]!.filePath)).toBe(true);

    expect(unpacked.artifacts[1]?.kind).toBe("audio");
    expect(unpacked.artifacts[1]?.byteLength).toBe(128);
    expect(fs.existsSync(unpacked.artifacts[1]!.filePath)).toBe(true);

    expect(unpacked.cleanedContent).not.toContain("base64,");
    expect(unpacked.cleanedContent).toContain("![cover-art](/amb/media/gemini-media-");
    expect(unpacked.cleanedContent).toContain("[theme-song](/amb/media/gemini-media-");
  });

  it("builds Streamable HTTP MCP descriptor and classifies Cookie / 130KB / strict_model errors", () => {
    const baseRoot = `${HTTP_PROTO}127.0.0.1:8083`;
    const mcpKey = ["sk", "gemini", "mcp"].join("-");
    const mcp = buildGeminiWeb2ApiMcpServer({
      baseUrl: `${baseRoot}/v1`,
      apiKey: mcpKey,
    });
    expect(mcp).toEqual({
      id: "gemini-web2api-mcp",
      transport: "streamable-http",
      url: `${baseRoot}/mcp`,
      headers: { Authorization: `Bearer ${mcpKey}` },
      tools: [
        "gemini_chat",
        "gemini_generate_image",
        "gemini_generate_music",
        "gemini_list_models",
      ],
    });

    expect(classifyGeminiWeb2ApiError(502, "1psidts session expired").kind).toBe(
      "cookie_expired",
    );
    expect(classifyGeminiWeb2ApiError(413, "input too long (>130KB)").kind).toBe(
      "payload_too_large",
    );
    expect(classifyGeminiWeb2ApiError(400, "strict_model blocked fallback").kind).toBe(
      "strict_model_unavailable",
    );
    expect(classifyGeminiWeb2ApiError(401, "Unauthorized").kind).toBe("auth_failed");
  });
});
