/**
 * `bigfive-duo-site` <-> Sugent 中枢跨仓联调契约校验器（src/sugent/duo-federation-contract.ts）
 *
 * 端到端验证双人关系空间联邦接入的五条核心安全与业务契约：
 * 1. 缺省或错误 `X-Sugent-Duo-Token` 访问 `/amb/api/steward/duo/vault` 严格返回 `401`；
 * 2. 合法 `X-Sugent-Duo-Token` 可读写 `/amb/api/steward/duo/*`（`200`），但访问主理人 `/amb/api/steward/workbench` 严格拦截为 `401`（零提权）；
 * 3. `POST /amb/api/steward/duo/converse`（`stream: true`）返回合法 SSE 事件流（`delta` 分片、`done` 汇总帧、`[DONE]` 终止符）且零金丝雀泄露；
 * 4. `M` / `W` 对称加密隐私口袋支持各自口令加解密，且跨伴侣读写一律返回 `403 MEMBRANE_PRINCIPAL_DENIED`；
 * 5. 多轮共鸣对话防抖提炼候选星晶后严格保持 `status === "candidate"`（`endorsedBy: []`），直至双方共同点亮才晋升为 `crystallized`。
 */
import { assertZeroCanaryLeak } from "./cognitive-membrane.js";
import { DEFAULT_DUO_SPACE_ID, sanitizeDuoSpaceId, type DuoVaultSnapshot } from "./duo-steward-crystallizer.js";

export interface DuoFederationInjectInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface DuoFederationInjectResponse {
  status: number;
  headers?: Record<string, string>;
  text: string;
}

export type DuoFederationInjectFn = (
  path: string,
  init?: DuoFederationInjectInit,
) => Promise<DuoFederationInjectResponse>;

export interface DuoFederationCheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

export interface VerifyDuoFederationContractParams {
  injectFn: DuoFederationInjectFn;
  duoToken: string;
  spaceId?: string;
  canaryTokens?: readonly string[];
  autoCandidateTimeoutMs?: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  targetName: string,
): string | undefined {
  if (!headers) return undefined;
  const lower = targetName.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function parseJsonSafe<T = any>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function verifyDuoFederationContract(
  params: VerifyDuoFederationContractParams,
): Promise<{
  ok: boolean;
  checks: DuoFederationCheckResult[];
}> {
  const { injectFn, duoToken } = params;
  const spaceId = sanitizeDuoSpaceId(params.spaceId ?? DEFAULT_DUO_SPACE_ID);
  const encSpace = encodeURIComponent(spaceId);
  const checks: DuoFederationCheckResult[] = [];

  const duoAuthHeaders: Record<string, string> = {
    "x-amb-token": "",
    "x-sugent-duo-token": duoToken,
  };
  const duoJsonHeaders: Record<string, string> = {
    ...duoAuthHeaders,
    "content-type": "application/json",
  };

  // 1. Missing / wrong token -> 401
  try {
    const missingRes = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
      method: "GET",
      headers: { "x-amb-token": "" },
    });
    const wrongRes = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
      method: "GET",
      headers: {
        "x-amb-token": "",
        "x-sugent-duo-token": "wrong-duo-federation-token-000000",
      },
    });
    const passed = missingRes.status === 401 && wrongRes.status === 401;
    checks.push({
      name: "duo_auth_missing_or_wrong_token_401",
      passed,
      detail: `missing=${missingRes.status}, wrong=${wrongRes.status}`,
    });
  } catch (err) {
    checks.push({
      name: "duo_auth_missing_or_wrong_token_401",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Valid X-Sugent-Duo-Token accesses /duo/vault (200) but is blocked from /workbench (401)
  try {
    const vaultRes = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
      method: "GET",
      headers: duoAuthHeaders,
    });
    const workbenchRes = await injectFn("/amb/api/steward/workbench", {
      method: "GET",
      headers: duoAuthHeaders,
    });
    const vaultBody = parseJsonSafe<{ ok?: boolean; vault?: DuoVaultSnapshot }>(vaultRes.text);
    const passed =
      vaultRes.status === 200 &&
      vaultBody?.ok === true &&
      vaultBody.vault?.spaceId === spaceId &&
      workbenchRes.status === 401;
    checks.push({
      name: "duo_scoped_token_zero_privilege_escalation",
      passed,
      detail: `duo/vault=${vaultRes.status}, owner/workbench=${workbenchRes.status}`,
    });
  } catch (err) {
    checks.push({
      name: "duo_scoped_token_zero_privilege_escalation",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 3. SSE streaming POST /amb/api/steward/duo/converse + zero canary leak
  try {
    const sseRes = await injectFn("/amb/api/steward/duo/converse", {
      method: "POST",
      headers: {
        ...duoJsonHeaders,
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        spaceId,
        speaker: "W",
        stream: true,
        messages: [
          {
            role: "user",
            content: "最近看他手头事情多，怎么温和表达关心又不会给他添压力？",
          },
        ],
      }),
    });

    const contentType = getHeaderCaseInsensitive(sseRes.headers, "content-type");
    const contentTypeOk = !contentType || contentType.toLowerCase().includes("text/event-stream");

    let deltaCount = 0;
    let doneFrame: Record<string, unknown> | null = null;
    let hasDoneTerminator = false;

    for (const rawLine of sseRes.text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        hasDoneTerminator = true;
        continue;
      }
      const parsed = parseJsonSafe<Record<string, unknown>>(payload);
      if (!parsed) continue;
      if (parsed.type === "delta" && typeof parsed.delta === "string" && parsed.delta.length > 0) {
        deltaCount += 1;
      } else if (parsed.type === "done") {
        doneFrame = parsed;
      }
    }

    let canaryClean = true;
    try {
      assertZeroCanaryLeak(sseRes.text, params.canaryTokens);
    } catch {
      canaryClean = false;
    }

    const doneValid = Boolean(
      doneFrame &&
        typeof doneFrame.reply === "string" &&
        doneFrame.reply.trim().length > 0 &&
        typeof doneFrame.modelUsed === "string" &&
        doneFrame.modelUsed.trim().length > 0 &&
        typeof doneFrame.activeCrystalCount === "number",
    );

    const passed =
      sseRes.status === 200 &&
      contentTypeOk &&
      deltaCount >= 1 &&
      doneValid &&
      hasDoneTerminator &&
      canaryClean;

    checks.push({
      name: "duo_sse_streaming_and_zero_canary_leak",
      passed,
      detail: `status=${sseRes.status}, deltas=${deltaCount}, doneValid=${doneValid}, terminator=${hasDoneTerminator}, canaryClean=${canaryClean}`,
    });
  } catch (err) {
    checks.push({
      name: "duo_sse_streaming_and_zero_canary_leak",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Symmetric M and W encrypted pockets + 403 MEMBRANE_PRINCIPAL_DENIED on cross-partner read/write
  try {
    const mPlain = "希望周五下班前收口手头杂事，把晚饭时间留出来";
    const wPlain = "周五晚饭后想一起散步聊聊轻松的小事";

    const putM = await injectFn("/amb/api/steward/duo/pockets", {
      method: "POST",
      headers: duoJsonHeaders,
      body: JSON.stringify({
        spaceId,
        actor: "M",
        topicHint: "friday-winddown",
        content: mPlain,
        passphrase: "pluto-pocket-key-2026",
      }),
    });
    const putW = await injectFn("/amb/api/steward/duo/pockets", {
      method: "POST",
      headers: duoJsonHeaders,
      body: JSON.stringify({
        spaceId,
        actor: "W",
        topicHint: "friday-walk",
        content: wPlain,
        passphrase: "charon-pocket-key-2026",
      }),
    });

    const crossReadMW = await injectFn(
      `/amb/api/steward/duo/pockets?spaceId=${encSpace}&viewer=M&targetOwner=W`,
      { method: "GET", headers: duoAuthHeaders },
    );
    const crossReadWM = await injectFn(
      `/amb/api/steward/duo/pockets?spaceId=${encSpace}&viewer=W&targetOwner=M`,
      { method: "GET", headers: duoAuthHeaders },
    );
    const crossWriteMW = await injectFn("/amb/api/steward/duo/pockets", {
      method: "POST",
      headers: duoJsonHeaders,
      body: JSON.stringify({
        spaceId,
        actor: "M",
        targetOwner: "W",
        content: "越权写入尝试",
      }),
    });

    const readOwnM = await injectFn(
      `/amb/api/steward/duo/pockets?spaceId=${encSpace}&viewer=M&passphrase=${encodeURIComponent("pluto-pocket-key-2026")}`,
      { method: "GET", headers: duoAuthHeaders },
    );
    const readOwnW = await injectFn(
      `/amb/api/steward/duo/pockets?spaceId=${encSpace}&viewer=W&passphrase=${encodeURIComponent("charon-pocket-key-2026")}`,
      { method: "GET", headers: duoAuthHeaders },
    );
    const vaultAfterPockets = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
      method: "GET",
      headers: duoAuthHeaders,
    });

    const mBody = parseJsonSafe<{ notes?: Array<{ content?: string }> }>(readOwnM.text);
    const wBody = parseJsonSafe<{ notes?: Array<{ content?: string }> }>(readOwnW.text);
    const vBody = parseJsonSafe<{ vault?: DuoVaultSnapshot }>(vaultAfterPockets.text);
    const pocketSummary = vBody?.vault?.pocketSummary;

    const passed =
      putM.status === 200 &&
      putW.status === 200 &&
      crossReadMW.status === 403 &&
      crossReadMW.text.includes("MEMBRANE_PRINCIPAL_DENIED") &&
      crossReadWM.status === 403 &&
      crossReadWM.text.includes("MEMBRANE_PRINCIPAL_DENIED") &&
      crossWriteMW.status === 403 &&
      crossWriteMW.text.includes("MEMBRANE_PRINCIPAL_DENIED") &&
      Boolean(mBody?.notes?.some((n) => n.content === mPlain)) &&
      Boolean(wBody?.notes?.some((n) => n.content === wPlain)) &&
      Boolean(
        pocketSummary &&
          pocketSummary.M.totalNotes >= 1 &&
          pocketSummary.M.encryptedNotes >= 1 &&
          pocketSummary.W.totalNotes >= 1 &&
          pocketSummary.W.encryptedNotes >= 1,
      ) &&
      !vaultAfterPockets.text.includes(mPlain) &&
      !vaultAfterPockets.text.includes(wPlain);

    checks.push({
      name: "duo_symmetric_pockets_and_403_principal_isolation",
      passed,
      detail: `putM=${putM.status}, putW=${putW.status}, crossRead=${crossReadMW.status}/${crossReadWM.status}, crossWrite=${crossWriteMW.status}`,
    });
  } catch (err) {
    checks.push({
      name: "duo_symmetric_pockets_and_403_principal_isolation",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 5. Debounced auto-candidate crystal stays strictly status === "candidate" until co-endorsed
  try {
    const beforeVaultRes = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
      method: "GET",
      headers: duoAuthHeaders,
    });
    const beforeVault = parseJsonSafe<{ vault?: DuoVaultSnapshot }>(beforeVaultRes.text)?.vault;
    const preIds = new Set<string>([
      ...(beforeVault?.crystals.candidates.map((c) => c.id) ?? []),
      ...(beforeVault?.crystals.crystallized.map((c) => c.id) ?? []),
    ]);

    const resonanceConverse = await injectFn("/amb/api/steward/duo/converse", {
      method: "POST",
      headers: duoJsonHeaders,
      body: JSON.stringify({
        spaceId,
        speaker: "M",
        stream: false,
        messages: [
          { role: "user", content: "每次忙完一周切换到休息状态时，我们节奏偶尔会错位。" },
          { role: "assistant", content: "可以先用一个简短的在场信号衔接彼此的节奏。" },
          {
            role: "user",
            content: "很有共鸣，以后咱们就约好周五晚不加班，先发安心信号再留白不谈工作！",
          },
        ],
      }),
    });

    const timeoutMs = Math.max(200, params.autoCandidateTimeoutMs ?? 1500);
    const deadline = Date.now() + timeoutMs;
    let autoCandidate = undefined as DuoVaultSnapshot["crystals"]["candidates"][number] | undefined;
    let vaultSnap = undefined as DuoVaultSnapshot | undefined;

    while (Date.now() < deadline) {
      await sleepMs(45);
      const pollRes = await injectFn(`/amb/api/steward/duo/vault?spaceId=${encSpace}`, {
        method: "GET",
        headers: duoAuthHeaders,
      });
      vaultSnap = parseJsonSafe<{ vault?: DuoVaultSnapshot }>(pollRes.text)?.vault;
      autoCandidate = vaultSnap?.crystals.candidates.find((c) => !preIds.has(c.id));
      if (autoCandidate) break;
    }

    let stayedCandidateUntilCoEndorsed = false;
    let coEndorsedCrystallized = false;

    if (autoCandidate) {
      const notAutoPromoted = !(vaultSnap?.crystals.crystallized.some((c) => c.id === autoCandidate!.id));
      const singleEndorseRes = await injectFn(
        `/amb/api/steward/duo/crystals/${encodeURIComponent(autoCandidate.id)}/review`,
        {
          method: "POST",
          headers: duoJsonHeaders,
          body: JSON.stringify({
            spaceId,
            actor: "M",
            action: "endorse",
          }),
        },
      );
      const singleEndorseJson = parseJsonSafe<{ crystal?: { status?: string; endorsedBy?: string[] } }>(
        singleEndorseRes.text,
      );
      stayedCandidateUntilCoEndorsed =
        autoCandidate.status === "candidate" &&
        autoCandidate.endorsedBy.length === 0 &&
        notAutoPromoted &&
        singleEndorseRes.status === 200 &&
        singleEndorseJson?.crystal?.status === "candidate";

      const coEndorseRes = await injectFn(
        `/amb/api/steward/duo/crystals/${encodeURIComponent(autoCandidate.id)}/review`,
        {
          method: "POST",
          headers: duoJsonHeaders,
          body: JSON.stringify({
            spaceId,
            actor: "W",
            action: "endorse",
          }),
        },
      );
      const coEndorseJson = parseJsonSafe<{ crystal?: { status?: string; endorsedBy?: string[] } }>(
        coEndorseRes.text,
      );
      coEndorsedCrystallized =
        coEndorseRes.status === 200 &&
        coEndorseJson?.crystal?.status === "crystallized" &&
        Array.isArray(coEndorseJson.crystal.endorsedBy) &&
        coEndorseJson.crystal.endorsedBy.includes("M") &&
        coEndorseJson.crystal.endorsedBy.includes("W");
    }

    const passed =
      resonanceConverse.status === 200 &&
      Boolean(autoCandidate) &&
      stayedCandidateUntilCoEndorsed &&
      coEndorsedCrystallized;

    checks.push({
      name: "duo_auto_candidate_sovereignty_until_co_endorsed",
      passed,
      detail: `converse=${resonanceConverse.status}, candidateId=${autoCandidate?.id ?? "none"}, stayedCandidate=${stayedCandidateUntilCoEndorsed}, coEndorsed=${coEndorsedCrystallized}`,
    });
  } catch (err) {
    checks.push({
      name: "duo_auto_candidate_sovereignty_until_co_endorsed",
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    ok: checks.every((c) => c.passed),
    checks,
  };
}
