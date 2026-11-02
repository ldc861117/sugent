/**
 * Sugent 模型网关解耦与分层路由层
 *
 * 设计目标：
 * 1. 保持对上游 AnyModelBot `src/config.ts` 与 `src/magpie/supervisor.ts` 的零侵入兼容；
 * 2. 支持短期通过环境变量一键绕过 Modelflare 登录，直连任意 OpenAI 兼容端点或原版 magpie；
 * 3. 支持按智能体角色（Assessor 守门员 / Executor 执行器 / ComputerUse 桌面操控 / Steward 记忆管家）分层路由模型。
 */
import type { AppConfig } from "../config.js";
import type { GatewayProviderMode, ModelRole, RoleModelRouting, SugentGatewayConfig } from "./types.js";

export const DEFAULT_ROLE_ROUTING: Readonly<RoleModelRouting> = {
  assessor: "deepseek/deepseek-chat",
  executor: "anthropic/claude-sonnet-4-5",
  computerUse: "anthropic/claude-sonnet-4-5",
  steward: "deepseek/deepseek-chat",
};

/**
 * 从环境变量与宿主 AppConfig 解析 Sugent 网关配置。
 * 优先级：SUGENT_* 环境变量 > AMB_* 环境变量 > AppConfig 默认值
 */
export function resolveSugentGatewayConfig(
  appConfig?: Pick<AppConfig, "magpie" | "llm">,
  env: NodeJS.ProcessEnv = process.env,
): SugentGatewayConfig {
  const baseUrl = env.SUGENT_GATEWAY_URL || env.AMB_MAGPIE_BASE_URL || appConfig?.magpie.externalBaseUrl || "";
  const apiKey = env.SUGENT_GATEWAY_KEY || env.AMB_MAGPIE_API_KEY || appConfig?.magpie.externalApiKey || "";
  const unlockSubscriptions = env.SUGENT_UNLOCK_SUBSCRIPTIONS === "1" || env.SUGENT_UNLOCK_SUBSCRIPTIONS === "true";
  const privacyMasking = env.SUGENT_PRIVACY_MASKING === "1" || env.SUGENT_PRIVACY_MASKING === "true";

  let mode: GatewayProviderMode = "modelflare";
  if (env.SUGENT_GATEWAY_MODE && ["byok", "subscription", "modelflare", "external"].includes(env.SUGENT_GATEWAY_MODE)) {
    mode = env.SUGENT_GATEWAY_MODE as GatewayProviderMode;
  } else if (baseUrl) {
    mode = "external";
  } else if (unlockSubscriptions) {
    mode = "subscription";
  }

  const fallbackDefault = env.AMB_DEFAULT_MODEL || appConfig?.llm.defaultModel || DEFAULT_ROLE_ROUTING.executor;

  const routing: RoleModelRouting = {
    assessor: env.SUGENT_MODEL_ASSESSOR || DEFAULT_ROLE_ROUTING.assessor,
    executor: env.SUGENT_MODEL_EXECUTOR || fallbackDefault,
    computerUse: env.SUGENT_MODEL_COMPUTER_USE || fallbackDefault,
    steward: env.SUGENT_MODEL_STEWARD || DEFAULT_ROLE_ROUTING.steward,
  };

  return {
    mode,
    unlockSubscriptions,
    privacyMasking,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    routing,
  };
}

/**
 * 根据任务角色选择最佳模型（实现"小模型守门降噪、大模型攻坚执行"的注意力与成本最优解）
 */
export function selectModelForRole(config: SugentGatewayConfig, role: ModelRole, explicitModel?: string): string {
  if (explicitModel && explicitModel.trim()) return explicitModel.trim();
  switch (role) {
    case "assessor":
      return config.routing.assessor;
    case "executor":
      return config.routing.executor;
    case "computer_use":
      return config.routing.computerUse;
    case "steward":
      return config.routing.steward;
  }
}

/**
 * 生成传递给内置或外部 magpie 网关的环境变量覆盖项。
 * 当开启 `unlockSubscriptions` 时，自动移除 AnyModelBot 默认注入的 `MAGPIE_NO_ACCOUNTS=1` 限制。
 */
export function buildMagpieEnvOverrides(config: SugentGatewayConfig): Record<string, string | undefined> {
  return {
    MAGPIE_NO_ACCOUNTS: config.unlockSubscriptions ? undefined : "1",
    AMB_MAGPIE_BASE_URL: config.baseUrl || undefined,
    AMB_MAGPIE_API_KEY: config.apiKey || undefined,
  };
}
