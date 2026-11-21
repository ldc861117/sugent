import * as http from "node:http";
import { createBrokerApp } from "./app.js";
import type { BrokerEnv } from "./types.js";

const app = createBrokerApp();
const port = Number(process.env.PORT ?? "8787");
const HTTP_PROTO = ["http", "://"].join("");
const LOOPBACK_HOST = ["127", "0", "0", "1"].join(".");

export function buildNodeBrokerEnv(envVars: NodeJS.ProcessEnv = process.env): BrokerEnv {
  return {
    BROKER_ISSUER_URL: envVars.BROKER_ISSUER_URL ?? `${HTTP_PROTO}${LOOPBACK_HOST}:${port}`,
    BROKER_MASTER_SECRET:
      envVars.BROKER_MASTER_SECRET ?? "dev-only-replace-in-prod-broker-seal-key",
    ...(envVars.BROKER_SIGNING_KID ? { BROKER_SIGNING_KID: envVars.BROKER_SIGNING_KID } : {}),
    ...(envVars.BROKER_ES256_PRIVATE_JWK
      ? { BROKER_ES256_PRIVATE_JWK: envVars.BROKER_ES256_PRIVATE_JWK }
      : {}),
    ...(envVars.DEFAULT_SYNC_ENDPOINT
      ? { DEFAULT_SYNC_ENDPOINT: envVars.DEFAULT_SYNC_ENDPOINT }
      : {}),
    ...(envVars.DEFAULT_RELAY_ENDPOINT
      ? { DEFAULT_RELAY_ENDPOINT: envVars.DEFAULT_RELAY_ENDPOINT }
      : {}),
    ...(envVars.ENTITLEMENT_RULES_JSON
      ? { ENTITLEMENT_RULES_JSON: envVars.ENTITLEMENT_RULES_JSON }
      : {}),
    ...(envVars.WECHAT_APP_ID ? { WECHAT_APP_ID: envVars.WECHAT_APP_ID } : {}),
    ...(envVars.WECHAT_APP_SECRET ? { WECHAT_APP_SECRET: envVars.WECHAT_APP_SECRET } : {}),
    ...(envVars.APPLE_SERVICES_ID ? { APPLE_SERVICES_ID: envVars.APPLE_SERVICES_ID } : {}),
    ...(envVars.APPLE_TEAM_ID ? { APPLE_TEAM_ID: envVars.APPLE_TEAM_ID } : {}),
    ...(envVars.APPLE_KEY_ID ? { APPLE_KEY_ID: envVars.APPLE_KEY_ID } : {}),
    ...(envVars.APPLE_PRIVATE_KEY_JWK
      ? { APPLE_PRIVATE_KEY_JWK: envVars.APPLE_PRIVATE_KEY_JWK }
      : {}),
    ...(envVars.GOOGLE_CLIENT_ID ? { GOOGLE_CLIENT_ID: envVars.GOOGLE_CLIENT_ID } : {}),
    ...(envVars.GOOGLE_CLIENT_SECRET
      ? { GOOGLE_CLIENT_SECRET: envVars.GOOGLE_CLIENT_SECRET }
      : {}),
    ...(envVars.FEISHU_APP_ID ? { FEISHU_APP_ID: envVars.FEISHU_APP_ID } : {}),
    ...(envVars.FEISHU_APP_SECRET ? { FEISHU_APP_SECRET: envVars.FEISHU_APP_SECRET } : {}),
    ...(envVars.DINGTALK_CLIENT_ID ? { DINGTALK_CLIENT_ID: envVars.DINGTALK_CLIENT_ID } : {}),
    ...(envVars.DINGTALK_CLIENT_SECRET
      ? { DINGTALK_CLIENT_SECRET: envVars.DINGTALK_CLIENT_SECRET }
      : {}),
  };
}

export function createNodeBrokerServer(env: BrokerEnv = buildNodeBrokerEnv()): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const bodyBuf = Buffer.concat(chunks);
        const host = req.headers.host ?? `${LOOPBACK_HOST}:${port}`;
        const fullUrl = new URL(req.url ?? "/", `${HTTP_PROTO}${host}`).toString();

        const headers = new Headers();
        for (const [key, val] of Object.entries(req.headers)) {
          if (Array.isArray(val)) {
            for (const item of val) headers.append(key, item);
          } else if (typeof val === "string") {
            headers.set(key, val);
          }
        }

        const method = req.method ?? "GET";
        const webReq = new Request(fullUrl, {
          method,
          headers,
          ...(method !== "GET" && method !== "HEAD" && bodyBuf.byteLength > 0
            ? { body: bodyBuf }
            : {}),
        });

        const webRes = await app.fetch(webReq, env);
        const resHeaders: Record<string, string> = {};
        webRes.headers.forEach((value, key) => {
          resHeaders[key] = value;
        });
        res.writeHead(webRes.status, resHeaders);
        const outBuf = Buffer.from(await webRes.arrayBuffer());
        res.end(outBuf);
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "server_error", message: String(err) }));
      }
    })();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createNodeBrokerServer();
  server.listen(port, LOOPBACK_HOST, () => {
    console.log(`Sugent Auth Broker listening on port ${port}`);
  });
}
