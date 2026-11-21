import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { SugentBrokerClaims } from "../src/sugent/auth-broker-contract.js";

const HTTP_PROTO = ["http", "://"].join("");
const HTTPS_PROTO = ["https", "://"].join("");
const LOOPBACK = ["127", "0", "0", "1"].join(".");

function createTestApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sugent-p2-web-"));
  const upstreamUrl = `${HTTP_PROTO}${LOOPBACK}:43199/v1`;
  const cfg = loadConfig({
    dataDir,
    env: {
      AMB_MAGPIE_BASE_URL: upstreamUrl,
      AMB_UI_PORT: "0",
      AMB_AGENT: "off",
      AMB_WEIXIN_API_BASE: `${HTTP_PROTO}${LOOPBACK}:9`,
    },
  });
  const app = new App(cfg, { printQrToTerminal: false, fileLog: false });
  app.runtime.listModels = async () => [
    "deepseek-chat",
    "claude-sonnet-4-20250514",
    "gpt-4.1-mini",
  ];
  return { app, dataDir };
}

describe("Track A: P2 BYOK Diagnostics, Cost Sandbox, Broker Preset & E2EE Sync Web API", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      await fn();
    }
  });

  const callApi = async (app: App, pathname: string, method = "GET", body?: unknown) => {
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

  it("probes registered BYOK providers via POST /amb/api/providers/diagnostics without leaking credentials", async () => {
    const { app, dataDir } = createTestApp();
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    const mockFetch: typeof fetch = async (input) => {
      const u = String(input);
      if (u.includes("api-healthy.example")) {
        return new Response(
          JSON.stringify({ data: [{ id: "deepseek-chat" }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ error: { message: "invalid key" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    };
    app.desktop = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: mockFetch,
    };

    const secretA = "tok-byok-live-alpha-9988";
    const secretB = "tok-byok-bad-beta-7766";

    await callApi(app, "/providers", "POST", {
      id: "deepseek",
      preset: "deepseek",
      name: "DeepSeek Direct",
      baseUrl: `${HTTPS_PROTO}api-healthy.example/v1`,
      apiKey: secretA,
      models: ["deepseek-chat"],
      setDefault: true,
    });
    await callApi(app, "/providers", "POST", {
      id: "openai",
      preset: "openai",
      name: "OpenAI Backup",
      baseUrl: `${HTTPS_PROTO}api-broken.example/v1`,
      apiKey: secretB,
      models: ["gpt-4.1-mini"],
      setDefault: false,
    });

    const diag = await callApi(app, "/providers/diagnostics", "POST", {
      timeoutMs: 2500,
    });
    expect(diag.status).toBe(200);
    expect(diag.text).not.toContain(secretA);
    expect(diag.text).not.toContain(secretB);
    expect(diag.json.ok).toBe(true);
    expect(diag.json.report.summary).toMatchObject({
      total: 2,
      healthyCount: 1,
      unhealthyCount: 1,
    });
    const byId = Object.fromEntries(
      diag.json.report.results.map((r: { providerId: string; diagnosticCode: string }) => [
        r.providerId,
        r.diagnosticCode,
      ]),
    );
    expect(byId.deepseek).toBe("OK");
    expect(byId.openai).toBe("AUTH_INVALID_KEY");
    expect(diag.json.viewModel.localReadyBadge).toContain("免登录");
  });

  it("simulates 4-role monthly USD cost & local budget runway via POST /amb/api/providers/cost-sandbox", async () => {
    const { app, dataDir } = createTestApp();
    await app.start();
    cleanups.push(async () => {
      await app.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    });

    await callApi(app, "/providers/routing", "PUT", {
      assessor: "deepseek/deepseek-chat",
      executor: "anthropic/claude-sonnet-4-20250514",
      computerUse: "openai/gpt-4.1-mini",
      steward: "deepseek/deepseek-chat",
    });
    await callApi(app, "/bots/default/budget", "PUT", {
      enabled: true,
      limitUsd: 40,
    });
    app.recordLocalBotUsageCost("default", 6.5);

    const simRes = await callApi(app, "/providers/cost-sandbox", "POST", {
      preset: "opc-standard",
      activeDaysPerMonth: 26,
      promptCacheHitRatio: 0.4,
    });
    expect(simRes.status).toBe(200);
    expect(simRes.json.ok).toBe(true);
    expect(simRes.json.simulation.monthlySavingsUsd).toBeGreaterThan(0);
    expect(simRes.json.simulation.savingsRatio).toBeGreaterThan(0.35);
    expect(simRes.json.simulation.budgetHealth).toMatchObject({
      monthlyCapUsd: 40,
      currentMonthSpentUsd: 6.5,
      remainingRunwayUsd: 33.5,
    });
    expect(simRes.json.viewModel.savingsHeadline).toContain("USD");
  });

  it("configures Sugent Auth Broker preset with zero client secret and enforces E2EE sync Pro/Team gate + roundtrip merge", async () => {
    const { app: appA, dataDir: dirA } = createTestApp();
    const { app: appB, dataDir: dirB } = createTestApp();
    await appA.start();
    await appB.start();
    cleanups.push(async () => {
      await appA.stop();
      await appB.stop();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    });

    // 1. One-click Sugent Auth Broker preset
    const brokerOrigin = `${HTTPS_PROTO}auth.sugent.example`;
    const syncBase = `${HTTPS_PROTO}sync.sugent.example/v1/e2ee`;
    const presetRes = await callApi(appA, "/auth/broker-preset", "POST", {
      brokerOrigin,
    });
    expect(presetRes.status).toBe(200);
    expect(presetRes.json.config).toMatchObject({
      mode: "oidc",
      issuer: brokerOrigin,
      clientId: "sugent-desktop",
      hasClientSecret: false,
    });

    // Mock cloud zero-knowledge object store shared between Device A & Device B
    const blobBucket = new Map<string, string>();
    const syncFetch: typeof fetch = async (input, init) => {
      const key = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT") {
        blobBucket.set(key, String(init?.body ?? ""));
        return new Response(JSON.stringify({ stored: true }), { status: 200 });
      }
      if (method === "GET") {
        const raw = blobBucket.get(key);
        if (!raw) return new Response("not found", { status: 404 });
        return new Response(raw, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("method not allowed", { status: 405 });
    };
    const hooks = {
      autostart: () => ({ supported: false, on: false }),
      setAutostart: () => {},
      applyZoom: () => {},
      openDataDir: () => {},
      openInBrowser: () => {},
      openExternal: () => {},
      fetch: syncFetch,
    };
    appA.desktop = hooks;
    appB.desktop = hooks;

    const nowSec = Math.floor(Date.now() / 1000);
    const freeClaims: SugentBrokerClaims = {
      iss: brokerOrigin,
      sub: "usr_opc_founder_01",
      aud: "sugent-desktop",
      iat: nowSec,
      exp: nowSec + 3600,
      idp: "wechat",
      plan: "free",
      sync_endpoint: syncBase,
    };

    // 2. Free plan push must return 403 SYNC_PLAN_UPGRADE_REQUIRED
    const denied = await callApi(appA, "/sync/push", "POST", {
      claims: freeClaims,
      bearerToken: "tok-broker-free-jwt",
      passphrase: "correct-horse-battery-staple-opc",
    });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({
      ok: false,
      errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
    });

    // 3. Seed sensitive domain knowledge on Device A and push with Pro plan
    appA.knowledgeGraph.applyDelta({
      nodes: [
        {
          id: "proj:alpha-contract",
          kind: "project",
          name: "Alpha 年度顾问协议",
          summary: "报价底线 48 万人民币，交付周期 6 周",
          tags: ["vip", "pricing"],
        },
      ],
      edges: [],
    });

    const proClaims: SugentBrokerClaims = {
      ...freeClaims,
      plan: "pro",
    };

    const pushed = await callApi(appA, "/sync/push", "POST", {
      claims: proClaims,
      bearerToken: "tok-broker-pro-jwt",
      passphrase: "correct-horse-battery-staple-opc",
    });
    expect(pushed.status).toBe(200);
    expect(pushed.json.ok).toBe(true);
    expect(blobBucket.size).toBe(1);

    // Zero-knowledge verification: raw cloud blob must NEVER contain plaintext summary
    const rawCloudBlob = [...blobBucket.values()][0]!;
    expect(rawCloudBlob).not.toContain("48 万人民币");
    expect(rawCloudBlob).not.toContain("Alpha 年度顾问协议");

    // 4. Device B pulls & merges into its local SugentKnowledgeGraph
    const pulled = await callApi(appB, "/sync/pull", "POST", {
      claims: proClaims,
      bearerToken: "tok-broker-pro-jwt",
      passphrase: "correct-horse-battery-staple-opc",
    });
    expect(pulled.status).toBe(200);
    expect(pulled.json).toMatchObject({
      ok: true,
      data: {
        remoteFound: true,
        nodeCount: 1,
      },
    });
    const syncedNode = appB.knowledgeGraph.getNode("proj:alpha-contract");
    expect(syncedNode?.summary).toContain("48 万人民币");
  });
});
