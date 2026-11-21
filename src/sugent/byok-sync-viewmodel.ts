import type {
  ByokDiagnosticsReport,
  CostSandboxSimulation,
} from "./byok-diagnostics.js";
import type { SugentBrokerClaims } from "./auth-broker-contract.js";

export interface ByokSyncViewModel {
  localReadyBadge: string;
  savingsHeadline: string;
  syncEntitlementState: "unlocked-pro" | "unlocked-team" | "upgrade-required";
  zeroKnowledgeGuarantee: string;
}

export function buildByokSyncViewModel(params: {
  diagnostics: ByokDiagnosticsReport | null;
  simulation: CostSandboxSimulation | null;
  claims: SugentBrokerClaims | null;
}): ByokSyncViewModel {
  const sim = params.simulation;
  const pct = sim ? (sim.savingsRatio * 100).toFixed(1) : "0.0";
  const saved = sim ? sim.monthlySavingsUsd.toFixed(2) : "0.00";

  let syncEntitlementState: ByokSyncViewModel["syncEntitlementState"] = "upgrade-required";
  if (params.claims?.plan === "pro") {
    syncEntitlementState = "unlocked-pro";
  } else if (params.claims?.plan === "team") {
    syncEntitlementState = "unlocked-team";
  }

  return {
    localReadyBadge: "本地免登录可用",
    savingsHeadline: sim
      ? `小模型守门 + 大模型攻坚预计每月净省 ${saved} USD（降幅 ${pct}%）`
      : "选择负载预设即可模拟四角色月度 API 账单",
    syncEntitlementState,
    zeroKnowledgeGuarantee:
      "端侧 PBKDF2 + HKDF + AES-256-GCM 零知识密封：明文 BYOK API Key 默认绝不离机，云端仅存密文 Blob。",
  };
}
