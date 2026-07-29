import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import { intensityToRank } from "../../utils/intensity";
import type { DisplayIntensityGroupV1, DisplayRecentQuakeV1 } from "../display/types";
import type { DailyQuakePersistedV1 } from "./daily-quake-counter";

const PERSIST_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedDailyQuakeV1 {
  version: typeof PERSIST_SCHEMA_VERSION;
  savedAt: string;
  state: DailyQuakePersistedV1;
}

/** 当日地震カウンタと履歴を一つの原子的 JSON として保存する。 */
export class DailyQuakePersistence {
  private pending: DailyQuakePersistedV1 | null = null;
  private pendingNowMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath: string, private readonly debounceMs = SAVE_DEBOUNCE_MS) {}

  load(nowMs: number): DailyQuakePersistedV1 | null {
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      if (!isRecord(parsed)) return this.invalid("top-level structure validation 失敗");
      if (parsed.version !== PERSIST_SCHEMA_VERSION) return this.invalid(`unknown version: ${String(parsed.version)}`);
      if (typeof parsed.savedAt !== "string") return this.invalid("savedAt が不正");
      const savedAtMs = Date.parse(parsed.savedAt);
      if (!Number.isFinite(savedAtMs) || savedAtMs > nowMs) return this.invalid("savedAt が不正または未来");
      const state = parseState(parsed.state, nowMs);
      if (state == null) return this.invalid("state structure validation 失敗");
      return state;
    } catch (err) {
      log.warn(`[daily-quake-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  schedule(state: DailyQuakePersistedV1, nowMs: number): void {
    this.pending = state;
    this.pendingNowMs = nowMs;
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      const pendingNowMs = this.pendingNowMs;
      this.pending = null;
      this.pendingNowMs = null;
      if (pending != null && pendingNowMs != null) this.save(pending, pendingNowMs);
    }, this.debounceMs);
    this.timer.unref();
  }

  save(state: DailyQuakePersistedV1, nowMs: number): void {
    const data: PersistedDailyQuakeV1 = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      state,
    };
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      log.warn(`[daily-quake-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingNowMs = null;
  }

  private invalid(reason: string): null {
    log.warn(`[daily-quake-persistence] ${reason} — 破棄`);
    return null;
  }
}

function parseState(value: unknown, nowMs: number): DailyQuakePersistedV1 | null {
  if (!isRecord(value) || typeof value.dayKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.dayKey) ||
      !isNonNegativeSafeInteger(value.count) || (value.maxInt != null && typeof value.maxInt !== "string") ||
      !isNonNegativeSafeInteger(value.maxIntRank) || !Array.isArray(value.countedEventIds) ||
      !value.countedEventIds.every((id): id is string => typeof id === "string" && id !== "") ||
      !Array.isArray(value.recentQuakes)) return null;
  const countedEventIds = [...new Set(value.countedEventIds)];
  // count は EventID なしの地震も含み得るため Set サイズ以上なら正しい。一方、Set の方が大きい
  // 状態を復元すると、その EventID の続報が dedupe されて count が永久に追いつかない。
  if (countedEventIds.length !== value.countedEventIds.length || value.count < countedEventIds.length) return null;
  // Counter が生成できる組合せだけを受理する。maxInt は rank > 0 の更新時にだけセットされる。
  if (value.maxInt == null) {
    if (value.maxIntRank !== 0) return null;
  } else {
    const rank = intensityToRank(value.maxInt);
    if (value.count === 0 || rank <= 0 || value.maxIntRank !== rank) return null;
  }
  const recentQuakes = value.recentQuakes.map((quake) => parseRecentQuake(quake, nowMs));
  if (recentQuakes.some((quake) => quake == null)) return null;
  return {
    dayKey: value.dayKey,
    count: value.count,
    maxInt: value.maxInt ?? null,
    maxIntRank: value.maxIntRank,
    countedEventIds,
    recentQuakes: recentQuakes as DisplayRecentQuakeV1[],
  };
}

function parseRecentQuake(value: unknown, nowMs: number): DisplayRecentQuakeV1 | null {
  if (!isRecord(value) || !isNullableString(value.eventId) || typeof value.reportDateTime !== "string" ||
      !isNullableString(value.originTime) || !isNullableString(value.hypocenterName) ||
      !isNullableString(value.magnitude) || !isNullableString(value.maxInt) ||
      !isNullableSafeInteger(value.maxIntRank) || !isNullableString(value.depth) ||
      typeof value.tsunamiWarning !== "boolean") return null;
  const times = [value.reportDateTime, value.originTime].filter((time): time is string => time != null);
  if (!times.every((time) => Number.isFinite(Date.parse(time)) && Date.parse(time) <= nowMs)) return null;
  const intensityGroups = value.intensityGroups == null ? undefined : parseIntensityGroups(value.intensityGroups);
  if (value.intensityGroups != null && intensityGroups == null) return null;
  return {
    eventId: value.eventId as string | null,
    reportDateTime: value.reportDateTime,
    originTime: value.originTime as string | null,
    hypocenterName: value.hypocenterName as string | null,
    magnitude: value.magnitude as string | null,
    maxInt: value.maxInt as string | null,
    maxIntRank: value.maxIntRank as number | null,
    depth: value.depth as string | null,
    tsunamiWarning: value.tsunamiWarning,
    intensityGroups: intensityGroups ?? undefined,
  };
}

function parseIntensityGroups(value: unknown): DisplayIntensityGroupV1[] | null {
  if (!Array.isArray(value)) return null;
  const result: DisplayIntensityGroupV1[] = [];
  for (const group of value) {
    if (!isRecord(group) || typeof group.intensity !== "string" || !isNonNegativeSafeInteger(group.rank) ||
        !Array.isArray(group.areas) || !group.areas.every((area): area is string => typeof area === "string") ||
        !isNonNegativeSafeInteger(group.omittedAreaCount)) return null;
    result.push({ intensity: group.intensity, rank: group.rank, areas: [...group.areas], omittedAreaCount: group.omittedAreaCount });
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeInteger(value: unknown): value is number | null {
  return value == null || isNonNegativeSafeInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}
