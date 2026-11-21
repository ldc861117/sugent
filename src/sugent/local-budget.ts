import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface BotBudgetRecord {
  enabled: boolean;
  limitUsd: number;
  monthKey: string;
  usedUsd: number;
  updatedAt: number;
}

export interface SetBotBudgetInput {
  enabled: boolean;
  limitUsd: number;
}

export interface BotBudgetStatus {
  enabled: boolean;
  limitUsd: number;
  usedUsd: number;
  remainUsd: number;
  exhausted: boolean;
  lowReserve: boolean;
}

export interface ActiveBotBudgetEntry extends BotBudgetStatus {
  botId: string;
  monthKey: string;
  updatedAt: number;
}

interface PersistedBudgetsFile {
  version: 1;
  bots: Record<string, BotBudgetRecord>;
}

const BUDGETS_FILENAME = "sugent-budgets.json";
const LOW_RESERVE_RATIO = 0.2;

function roundUsd(amount: number): number {
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return Math.round(amount * 1e8) / 1e8;
}

export function formatBudgetMonthKey(nowMs: number, useUtc = true): string {
  const date = new Date(nowMs);
  const year = useUtc ? date.getUTCFullYear() : date.getFullYear();
  const month = (useUtc ? date.getUTCMonth() : date.getMonth()) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function writeAtomicJson600(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const suffix = `${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`;
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.${suffix}.tmp`);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

function computeBudgetStatus(record: BotBudgetRecord | undefined): BotBudgetStatus {
  if (!record) {
    return {
      enabled: false,
      limitUsd: 0,
      usedUsd: 0,
      remainUsd: 0,
      exhausted: false,
      lowReserve: false,
    };
  }

  const limitUsd = roundUsd(Math.max(0, record.limitUsd));
  const usedUsd = roundUsd(Math.max(0, record.usedUsd));
  const remainUsd = roundUsd(Math.max(0, limitUsd - usedUsd));

  if (!record.enabled) {
    return {
      enabled: false,
      limitUsd,
      usedUsd,
      remainUsd,
      exhausted: false,
      lowReserve: false,
    };
  }

  const reserveThreshold = roundUsd(limitUsd * LOW_RESERVE_RATIO);
  const exhausted = limitUsd <= 0 || usedUsd >= limitUsd || remainUsd <= 0;
  const lowReserve = exhausted || remainUsd < reserveThreshold;

  return {
    enabled: true,
    limitUsd,
    usedUsd,
    remainUsd,
    exhausted,
    lowReserve,
  };
}

export class LocalBudgetLedger {
  private readonly dataDir: string;
  private readonly filePath: string;
  private readonly useUtc: boolean;
  private readonly bots = new Map<string, BotBudgetRecord>();

  constructor(
    dataDirOrOptions: string | { dataDir: string; useUtc?: boolean },
  ) {
    if (typeof dataDirOrOptions === "string") {
      this.dataDir = dataDirOrOptions;
      this.useUtc = true;
    } else {
      this.dataDir = dataDirOrOptions.dataDir;
      this.useUtc = dataDirOrOptions.useUtc ?? true;
    }
    this.filePath = path.join(this.dataDir, BUDGETS_FILENAME);
    this.loadFromDisk();
  }

  setBotBudget(
    botId: string,
    input: SetBotBudgetInput,
    nowMs = Date.now(),
  ): BotBudgetRecord {
    const cleanBotId = botId.trim();
    if (!cleanBotId) {
      throw new Error("botId cannot be empty");
    }

    const currentMonthKey = formatBudgetMonthKey(nowMs, this.useUtc);
    const limitUsd = roundUsd(
      Number.isFinite(input.limitUsd) ? Math.max(0, input.limitUsd) : 0,
    );

    const existing = this.bots.get(cleanBotId);
    const preservedUsed =
      existing !== undefined && existing.monthKey === currentMonthKey
        ? roundUsd(Math.max(0, existing.usedUsd))
        : 0;

    const record: BotBudgetRecord = {
      enabled: Boolean(input.enabled),
      limitUsd,
      monthKey: currentMonthKey,
      usedUsd: preservedUsed,
      updatedAt: nowMs,
    };

    this.bots.set(cleanBotId, record);
    this.saveToDisk();
    return { ...record };
  }

  recordUsageCost(
    botId: string,
    costUsd: number,
    nowMs = Date.now(),
  ): BotBudgetStatus {
    const cleanBotId = botId.trim();
    if (!cleanBotId) {
      throw new Error("botId cannot be empty");
    }

    const delta =
      Number.isFinite(costUsd) && costUsd > 0 ? roundUsd(costUsd) : 0;
    const currentMonthKey = formatBudgetMonthKey(nowMs, this.useUtc);
    const existing = this.bots.get(cleanBotId);

    if (!existing) {
      const created: BotBudgetRecord = {
        enabled: false,
        limitUsd: 0,
        monthKey: currentMonthKey,
        usedUsd: delta,
        updatedAt: nowMs,
      };
      this.bots.set(cleanBotId, created);
      this.saveToDisk();
      return computeBudgetStatus(created);
    }

    const baseUsed = existing.monthKey === currentMonthKey ? existing.usedUsd : 0;
    const updated: BotBudgetRecord = {
      enabled: existing.enabled,
      limitUsd: existing.limitUsd,
      monthKey: currentMonthKey,
      usedUsd: roundUsd(baseUsed + delta),
      updatedAt: nowMs,
    };

    this.bots.set(cleanBotId, updated);
    this.saveToDisk();
    return computeBudgetStatus(updated);
  }

  getBotBudgetStatus(botId: string, nowMs = Date.now()): BotBudgetStatus {
    const cleanBotId = botId.trim();
    if (!cleanBotId) {
      return computeBudgetStatus(undefined);
    }

    const record = this.rolloverIfNeeded(cleanBotId, nowMs, true);
    return computeBudgetStatus(record);
  }

  getBotBudgetRecord(
    botId: string,
    nowMs = Date.now(),
  ): BotBudgetRecord | undefined {
    const cleanBotId = botId.trim();
    if (!cleanBotId) {
      return undefined;
    }
    const record = this.rolloverIfNeeded(cleanBotId, nowMs, true);
    return record ? { ...record } : undefined;
  }

  allActiveBudgets(nowMs = Date.now()): ActiveBotBudgetEntry[] {
    let dirty = false;
    const currentMonthKey = formatBudgetMonthKey(nowMs, this.useUtc);
    const active: ActiveBotBudgetEntry[] = [];

    for (const [botId, record] of this.bots.entries()) {
      let current = record;
      if (record.monthKey !== currentMonthKey) {
        current = {
          ...record,
          monthKey: currentMonthKey,
          usedUsd: 0,
          updatedAt: nowMs,
        };
        this.bots.set(botId, current);
        dirty = true;
      }

      if (current.enabled) {
        active.push({
          botId,
          monthKey: current.monthKey,
          updatedAt: current.updatedAt,
          ...computeBudgetStatus(current),
        });
      }
    }

    if (dirty) {
      this.saveToDisk();
    }

    return active;
  }

  private rolloverIfNeeded(
    botId: string,
    nowMs: number,
    persistOnRollover: boolean,
  ): BotBudgetRecord | undefined {
    const existing = this.bots.get(botId);
    if (!existing) {
      return undefined;
    }

    const currentMonthKey = formatBudgetMonthKey(nowMs, this.useUtc);
    if (existing.monthKey === currentMonthKey) {
      return existing;
    }

    const rolled: BotBudgetRecord = {
      enabled: existing.enabled,
      limitUsd: existing.limitUsd,
      monthKey: currentMonthKey,
      usedUsd: 0,
      updatedAt: nowMs,
    };
    this.bots.set(botId, rolled);
    if (persistOnRollover) {
      this.saveToDisk();
    }
    return rolled;
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8").trim();
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedBudgetsFile>;
    this.bots.clear();

    if (parsed.bots && typeof parsed.bots === "object") {
      for (const [botId, rec] of Object.entries(parsed.bots)) {
        if (
          botId.trim() &&
          rec &&
          typeof rec === "object" &&
          typeof rec.monthKey === "string"
        ) {
          this.bots.set(botId.trim(), {
            enabled: Boolean(rec.enabled),
            limitUsd:
              typeof rec.limitUsd === "number" && Number.isFinite(rec.limitUsd)
                ? roundUsd(Math.max(0, rec.limitUsd))
                : 0,
            monthKey: rec.monthKey,
            usedUsd:
              typeof rec.usedUsd === "number" && Number.isFinite(rec.usedUsd)
                ? roundUsd(Math.max(0, rec.usedUsd))
                : 0,
            updatedAt:
              typeof rec.updatedAt === "number" && Number.isFinite(rec.updatedAt)
                ? rec.updatedAt
                : Date.now(),
          });
        }
      }
    }
  }

  private saveToDisk(): void {
    const botsObj: Record<string, BotBudgetRecord> = {};
    for (const [botId, record] of this.bots.entries()) {
      botsObj[botId] = { ...record };
    }
    const payload: PersistedBudgetsFile = {
      version: 1,
      bots: botsObj,
    };
    writeAtomicJson600(this.filePath, payload);
  }
}
