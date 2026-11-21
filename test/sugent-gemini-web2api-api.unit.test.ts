import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const HTTP_PROTO = ["http", "://"].join("");

describe("REST /amb/api/providers/gemini-web2api/probe & Model Sync E2E", () => {
  let app: App;
  const proxyRoot = `${HTTP_PROTO}127.0.0.1:41883`;
  const proxyBaseV1 = `${proxyRoot}/v1`;
  let dataDir = "";
  const proxyKey = ["proxy", "key", "8083"].join("-");
  const origFetch = globalThis.fetch;

  const callApi = async (pathname: string, method = "GET", body?: unknown) => {
    const res = await app.web!.inject(`/amb/api${pathname}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return {
      status: res.status,
      text: res.text,
      json: res.text ? JSON.parse(res.text) : {},
    };
  };

  beforeAll(async () => {
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === `${proxyRoot}/`) {
        return new Response(
          JSON.stringify({
            status: "ok",
            version: "4.28.1",
            models: ["gemini-3.6-flash"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === `${proxyRoot}/v1/models`) {
        const hdrs = new Headers(init?.headers);
        if (hdrs.get("authorization") !== `Bearer ${proxyKey}`) {
          return new Response(JSON.stringify({ error: "invalid api key" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { id: "gemini-3.6-flash" },
              { id: "gemini-3.1-pro-thinking" },
              { id: "gemini-image" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return origFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-web2api-api-"));
    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: proxyBaseV1,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}127.0.0.1:9`,
      },
    });
    app = new App(cfg, { printQrToTerminal: false });
    await app.start();
  });

  afterAll(async () => {
    globalThis.fetch = origFetch;
    await app?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("probes gemini-web2api tier, syncs discovered models to saved provider, and serves 36k catalog info", async () => {
    const unauth = await callApi("/providers/gemini-web2api/probe", "POST", {
      baseUrl: proxyBaseV1,
    });
    expect(unauth.status).toBe(200);
    expect(unauth.json.ok).toBe(false);
    expect(unauth.json.authRequired).toBe(true);

    const created = await callApi("/providers", "POST", {
      id: "gemini-web2api",
      preset: "gemini-web2api",
      name: "Gemini Web2API",
      baseUrl: proxyBaseV1,
      apiKey: proxyKey,
      setDefault: true,
    });
    expect(created.status).toBe(200);
    expect(created.text).not.toContain(proxyKey);

    const authed = await callApi("/providers/gemini-web2api/probe", "POST", {
      providerId: "gemini-web2api",
    });
    expect(authed.status).toBe(200);
    expect(authed.json).toMatchObject({
      ok: true,
      reachable: true,
      authenticated: true,
      version: "4.28.1",
      tier: "pro",
      syncedProviderId: "gemini-web2api",
    });
    expect(authed.json.models).toContain("gemini-3.1-pro-thinking");
    expect(authed.json.urls.adminUrl.endsWith("/admin/")).toBe(true);

    const infoRes = await callApi("/models/info");
    expect(infoRes.status).toBe(200);
    expect(infoRes.json.models["gemini-3.1-pro-thinking"]).toMatchObject({
      context: 36_000,
      reasoning: true,
      vision: true,
      tools: true,
      endpoints: ["openai-response", "openai"],
      rates: { input: 0, output: 0 },
    });
  });
});
