import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const HTTP_PROTO = ["http", "://"].join("");

describe("Decoupled /amb/api/providers, /amb/api/auth & Login-Free Local Budgets E2E", () => {
  let app: App;
  let mockUpstream: http.Server | undefined;
  let upstreamUrl = `${HTTP_PROTO}127.0.0.1:41143/v1`;
  let dataDir = "";

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
    const server = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "claude-sonnet-4-20250514" }, { id: "gpt-4.1-mini" }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      mockUpstream = server;
      const port = (server.address() as import("node:net").AddressInfo).port;
      upstreamUrl = `${HTTP_PROTO}127.0.0.1:${port}/v1`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EPERM") {
        throw err;
      }
    }

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-providers-e2e-"));
    const cfg = loadConfig({
      dataDir,
      env: {
        AMB_MAGPIE_BASE_URL: upstreamUrl,
        AMB_UI_PORT: "0",
        AMB_AGENT: "off",
        AMB_WEIXIN_API_BASE: `${HTTP_PROTO}127.0.0.1:9`,
      },
    });
    app = new App(cfg, { printQrToTerminal: false });
    if (!mockUpstream) {
      app.runtime.listModels = async () => ["claude-sonnet-4-20250514", "gpt-4.1-mini"];
    }
    await app.start();
  });

  afterAll(async () => {
    await app?.stop();
    if (mockUpstream?.listening) {
      await new Promise<void>((resolve) => mockUpstream!.close(() => resolve()));
    }
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("defaults /auth/status to sovereign 'none' mode with loginAvailable=false", async () => {
    const res = await callApi("/auth/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      mode: "none",
      state: "disabled",
      loginAvailable: false,
      signedIn: false,
    });
  });

  it("manages multiple providers, redacts secrets, updates 4-role routing, and serves offline model info", async () => {
    const initial = await callApi("/providers");
    expect(initial.status).toBe(200);
    expect(initial.json.providers).toEqual([]);

    const created = await callApi("/providers", "POST", {
      preset: "anthropic",
      name: "Anthropic Direct",
      baseUrl: upstreamUrl,
      apiKey: "tok-e2e-secret-5566",
      models: ["claude-sonnet-4-20250514", "gpt-4.1-mini"],
      setDefault: true,
    });
    expect(created.status).toBe(200);
    expect(created.text).not.toContain("tok-e2e-secret-5566");
    expect(created.json.defaultProviderId).toBe("anthropic");
    expect(created.json.provider).toMatchObject({
      id: "anthropic",
      hasKey: true,
      keyTail: "5566",
      isDefault: true,
    });

    const ollama = await callApi("/providers", "POST", {
      preset: "ollama",
      name: "Local Ollama",
      setDefault: false,
    });
    expect(ollama.status).toBe(200);
    expect(ollama.json.providers).toHaveLength(2);
    expect(ollama.json.defaultProviderId).toBe("anthropic");

    const switched = await callApi("/providers/ollama/default", "POST", {});
    expect(switched.status).toBe(200);
    expect(switched.json.defaultProviderId).toBe("ollama");

    const routed = await callApi("/providers/routing", "PUT", {
      unlockSubscriptions: true,
      assessor: "ollama/qwen2.5:14b",
      executor: "anthropic/claude-sonnet-4-20250514",
      computerUse: "anthropic/claude-3-7-sonnet-20250219",
      steward: "ollama/qwen2.5:14b",
    });
    expect(routed.status).toBe(200);
    expect(routed.json.unlockSubscriptions).toBe(true);
    expect(routed.json.routing).toEqual({
      assessor: "ollama/qwen2.5:14b",
      executor: "anthropic/claude-sonnet-4-20250514",
      computerUse: "anthropic/claude-3-7-sonnet-20250219",
      steward: "ollama/qwen2.5:14b",
    });

    const modelsInfo = await callApi("/models/info");
    expect(modelsInfo.status).toBe(200);
    expect(modelsInfo.json.models["claude-sonnet-4-20250514"]).toMatchObject({
      endpoints: ["anthropic", "openai"],
      vision: true,
      tools: true,
    });

    const removed = await callApi("/providers/ollama", "DELETE");
    expect(removed.status).toBe(200);
    expect(removed.json.providers).toHaveLength(1);
    expect(removed.json.defaultProviderId).toBe("anthropic");
  });

  it("allows setting per-bot monthly USD budget locally without any cloud account login", async () => {
    const budgetPut = await callApi("/bots/default/budget", "PUT", {
      enabled: true,
      limitUsd: 12.5,
    });
    expect(budgetPut.status).toBe(200);
    expect(budgetPut.json.settings.budget).toEqual({
      enabled: true,
      limitUsd: 12.5,
    });

    app.recordLocalBotUsageCost("default", 10.25);
    const budgetsView = await callApi("/account/budgets");
    expect(budgetsView.status).toBe(200);
    expect(budgetsView.json.mode).toBe("local");
    expect(budgetsView.json.budgets.default).toMatchObject({
      limit_usd: 12.5,
      used_usd: 10.25,
      remain_usd: 2.25,
      status: "active",
    });
  });
});
