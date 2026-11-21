import type { SugentPlanTier } from "../../../src/sugent/auth-broker-contract.js";
import type { BrokerEnv, EntitlementSnapshot, NormalizedIdpIdentity } from "./types.js";

interface StaticEntitlementRules {
  proUsers?: string[];
  teamOrgs?: Record<
    string,
    {
      orgId: string;
      plan?: SugentPlanTier;
      syncEndpoint?: string;
      relayEndpoint?: string;
    }
  >;
}

export async function resolveUserEntitlements(
  sub: string,
  identity: NormalizedIdpIdentity,
  env: BrokerEnv,
): Promise<EntitlementSnapshot> {
  if (env.AUTH_KV) {
    const kvRaw = await env.AUTH_KV.get(`entitlement:${sub}`);
    if (kvRaw) {
      const parsed = JSON.parse(kvRaw) as EntitlementSnapshot;
      const syncEp = parsed.sync_endpoint ?? env.DEFAULT_SYNC_ENDPOINT;
      const relayEp = parsed.relay_endpoint ?? env.DEFAULT_RELAY_ENDPOINT;
      return {
        plan: parsed.plan,
        ...(parsed.org_id ? { org_id: parsed.org_id } : {}),
        ...(syncEp ? { sync_endpoint: syncEp } : {}),
        ...(relayEp ? { relay_endpoint: relayEp } : {}),
      };
    }
  }

  if (env.ENTITLEMENT_RULES_JSON) {
    const rules = JSON.parse(env.ENTITLEMENT_RULES_JSON) as StaticEntitlementRules;
    if (identity.rawOrgKey && rules.teamOrgs?.[identity.rawOrgKey]) {
      const orgRule = rules.teamOrgs[identity.rawOrgKey]!;
      const syncEp = orgRule.syncEndpoint ?? env.DEFAULT_SYNC_ENDPOINT;
      const relayEp = orgRule.relayEndpoint ?? env.DEFAULT_RELAY_ENDPOINT;
      return {
        plan: orgRule.plan ?? "team",
        org_id: orgRule.orgId,
        ...(syncEp ? { sync_endpoint: syncEp } : {}),
        ...(relayEp ? { relay_endpoint: relayEp } : {}),
      };
    }
    if (rules.proUsers?.includes(sub)) {
      return {
        plan: "pro",
        ...(env.DEFAULT_SYNC_ENDPOINT ? { sync_endpoint: env.DEFAULT_SYNC_ENDPOINT } : {}),
        ...(env.DEFAULT_RELAY_ENDPOINT ? { relay_endpoint: env.DEFAULT_RELAY_ENDPOINT } : {}),
      };
    }
  }

  return {
    plan: "free",
    ...(identity.rawOrgKey ? { org_id: `org_${identity.rawOrgKey}` } : {}),
  };
}
