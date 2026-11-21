import {
  runByokDiagnostics,
  simulateMonthlyRoleCosts,
  type BudgetLedgerSnapshot,
  type ByokProbeTarget,
  type CatalogPricingReader,
  type CostSandboxSimulation,
  type FetchLike,
  type SugentAgentRole,
  type WorkloadPresetId,
} from "./byok-diagnostics.js";
import {
  ZeroKnowledgeSyncClient,
  type SugentBrokerClaims,
  type SyncableKnowledgeGraphSnapshot,
} from "./e2ee-sync.js";

export interface GatewayJsonResponse<T> {
  statusCode: number;
  body: {
    ok: boolean;
    data?: T;
    errorCode?: string;
    message?: string;
  };
}

export interface P2GatewayDependencies {
  catalog: CatalogPricingReader;
  getBudgetLedger?: () => BudgetLedgerSnapshot | undefined;
  getKnowledgeGraphSnapshot: () => Promise<SyncableKnowledgeGraphSnapshot>;
  applyKnowledgeGraphSnapshot: (merged: SyncableKnowledgeGraphSnapshot) => Promise<void>;
  fetchImpl?: FetchLike;
  kdfIterations?: number;
}

export function createP2GatewayHandlers(deps: P2GatewayDependencies) {
  const syncClient = new ZeroKnowledgeSyncClient({
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.kdfIterations !== undefined ? { kdfIterations: deps.kdfIterations } : {}),
  });

  return {
    async handleByokDiagnostics(req: {
      targets: ByokProbeTarget[];
      timeoutMs?: number;
    }): Promise<GatewayJsonResponse<Awaited<ReturnType<typeof runByokDiagnostics>>>> {
      const report = await runByokDiagnostics(req.targets, {
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
      });
      return { statusCode: 200, body: { ok: true, data: report } };
    },

    async handleCostSandbox(req: {
      roleModels: Record<SugentAgentRole, string>;
      preset?: WorkloadPresetId;
      activeDaysPerMonth?: number;
      promptCacheHitRatio?: number;
    }): Promise<GatewayJsonResponse<CostSandboxSimulation>> {
      const ledger = deps.getBudgetLedger?.();
      const simulation = simulateMonthlyRoleCosts({
        roleModels: req.roleModels,
        ...(req.preset ? { preset: req.preset } : {}),
        ...(req.activeDaysPerMonth !== undefined
          ? { activeDaysPerMonth: req.activeDaysPerMonth }
          : {}),
        ...(req.promptCacheHitRatio !== undefined
          ? { promptCacheHitRatio: req.promptCacheHitRatio }
          : {}),
        catalog: deps.catalog,
        ...(ledger ? { ledger } : {}),
      });
      return { statusCode: 200, body: { ok: true, data: simulation } };
    },

    async handleSyncPush(req: {
      claims: SugentBrokerClaims;
      bearerToken: string;
      passphrase: string;
    }): Promise<
      GatewayJsonResponse<{ uploadedAtIso: string; keyFingerprint: string; lamportClock: number }>
    > {
      try {
        const snapshot = await deps.getKnowledgeGraphSnapshot();
        const result = await syncClient.pushKnowledgeGraph({
          claims: req.claims,
          bearerToken: req.bearerToken,
          passphrase: req.passphrase,
          snapshot,
        });
        return { statusCode: 200, body: { ok: true, data: result } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown sync error";
        if (msg.includes("SYNC_PLAN_UPGRADE_REQUIRED")) {
          return {
            statusCode: 403,
            body: {
              ok: false,
              errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
              message: "零知识多端图谱云同步为 Pro / Team 专属权益，本地图谱仍可免费使用。",
            },
          };
        }
        if (msg.includes("SYNC_AUTH_TOKEN_EXPIRED")) {
          return {
            statusCode: 401,
            body: { ok: false, errorCode: "SYNC_AUTH_TOKEN_EXPIRED", message: "登录凭证已过期。" },
          };
        }
        return {
          statusCode: 400,
          body: { ok: false, errorCode: "E2EE_SYNC_FAILED", message: "端侧加密或云端同步失败。" },
        };
      }
    },

    async handleSyncPull(req: {
      claims: SugentBrokerClaims;
      bearerToken: string;
      passphrase: string;
    }): Promise<
      GatewayJsonResponse<{ remoteFound: boolean; lamportClock: number; nodeCount: number }>
    > {
      try {
        const localSnapshot = await deps.getKnowledgeGraphSnapshot();
        const { remoteFound, mergedSnapshot } = await syncClient.pullAndMergeKnowledgeGraph({
          claims: req.claims,
          bearerToken: req.bearerToken,
          passphrase: req.passphrase,
          localSnapshot,
        });
        if (remoteFound) {
          await deps.applyKnowledgeGraphSnapshot(mergedSnapshot);
        }
        return {
          statusCode: 200,
          body: {
            ok: true,
            data: {
              remoteFound,
              lamportClock: mergedSnapshot.lamportClock,
              nodeCount: mergedSnapshot.nodes.length,
            },
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("SYNC_PLAN_UPGRADE_REQUIRED")) {
          return {
            statusCode: 403,
            body: {
              ok: false,
              errorCode: "SYNC_PLAN_UPGRADE_REQUIRED",
              message: "升级 Pro / Team 即可解锁跨设备零知识图谱合并。",
            },
          };
        }
        return {
          statusCode: 400,
          body: {
            ok: false,
            errorCode: "E2EE_DECRYPT_OR_MERGE_FAILED",
            message: "无法解密云端图谱快照，请确认端到端同步主口令正确。",
          },
        };
      }
    },
  };
}
