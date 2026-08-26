import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type {
  DisplayIntensityGroupV1,
  DisplayLargeQuakeStateV1,
  DisplayQuakeIntensityMapEventV1,
} from "./types";
import type { PersistedSeenEntry } from "./revision-guard";
import type { DisplayQuakeLifecyclePersistedV1 } from "./state-store";

const PERSIST_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedQuakeDisplayV1 {
  version: typeof PERSIST_SCHEMA_VERSION;
  savedAt: string;
  state: DisplayQuakeLifecyclePersistedV1;
}

/** monitor 所有の地震地図 lifecycle を別ファイルへ additive に保存する。 */
export class QuakeDisplayPersistence {
  private pending: DisplayQuakeLifecyclePersistedV1 | null = null;
  private pendingNowMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath: string, private readonly debounceMs = SAVE_DEBOUNCE_MS) {}

  load(nowMs: number): DisplayQuakeLifecyclePersistedV1 | null {
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== PERSIST_SCHEMA_VERSION) return this.invalid("schema validation 失敗");
      if (typeof parsed.savedAt !== "string") return this.invalid("savedAt が不正");
      const savedAtMs = Date.parse(parsed.savedAt);
      if (!Number.isFinite(savedAtMs) || savedAtMs > nowMs) return this.invalid("savedAt が不正または未来");
      const state = parseState(parsed.state, nowMs);
      return state ?? this.invalid("state structure validation 失敗");
    } catch (err) {
      log.warn(`[quake-display-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  schedule(state: DisplayQuakeLifecyclePersistedV1, nowMs: number): void {
    this.pending = structuredClone(state);
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

  save(state: DisplayQuakeLifecyclePersistedV1, nowMs: number): void {
    const data: PersistedQuakeDisplayV1 = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      state: structuredClone(state),
    };
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      log.warn(`[quake-display-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingNowMs = null;
  }

  private invalid(reason: string): null {
    log.warn(`[quake-display-persistence] ${reason} — 破棄`);
    return null;
  }
}

function parseState(value: unknown, nowMs: number): DisplayQuakeLifecyclePersistedV1 | null {
  if (!isRecord(value) || !Array.isArray(value.contributions) || !Array.isArray(value.largeQuakes) ||
      !Array.isArray(value.revisions)) return null;
  const contributions = value.contributions
    .filter((event): event is DisplayQuakeIntensityMapEventV1 => isMapEvent(event, nowMs))
    .map((event) => structuredClone(event));
  const largeQuakes = value.largeQuakes.flatMap((entry): Array<{
    key: string;
    value: DisplayLargeQuakeStateV1;
  }> => {
    if (!isRecord(entry) || typeof entry.key !== "string" || entry.key === "" ||
        !isLargeQuake(entry.value, nowMs)) return [];
    return [{ key: entry.key, value: structuredClone(entry.value) }];
  });
  const contributionKeys = new Set(contributions.map((event) => event.eventKey));
  // host 一件の破損で event／large-quake は捨てず、host だけ fail-closed にする。
  const nonEmergencyHost = parseHost(value.nonEmergencyHost, nowMs, contributionKeys);
  const unknownHost = parseHost(value.unknownHost, nowMs, contributionKeys);
  const revisions = value.revisions
    .filter((entry): entry is PersistedSeenEntry => isSeenEntry(entry, nowMs))
    .map((entry) => ({ ...entry, revision: { ...entry.revision } }));
  return {
    contributions,
    largeQuakes,
    nonEmergencyHost,
    ...(unknownHost == null ? {} : { unknownHost }),
    revisions,
  };
}

function parseHost(
  value: unknown,
  nowMs: number,
  contributionKeys: ReadonlySet<string>,
): { eventKey: string; expiresAtMs: number } | null {
  if (value == null) return null;
  if (!isRecord(value) || typeof value.eventKey !== "string" || value.eventKey === "" ||
      !isFiniteNumber(value.expiresAtMs) || value.expiresAtMs <= nowMs ||
      !contributionKeys.has(value.eventKey)) return null;
  return { eventKey: value.eventKey, expiresAtMs: value.expiresAtMs };
}

function isMapEvent(value: unknown, nowMs: number): value is DisplayQuakeIntensityMapEventV1 {
  return isRecord(value)
    && typeof value.eventKey === "string" && value.eventKey !== ""
    && isNullableString(value.eventId)
    && typeof value.sourceType === "string" && value.sourceType !== ""
    && isRevision(value.revision)
    && isPastIso(value.reportDateTime, nowMs)
    && isNullablePastIso(value.originTime, nowMs)
    && isNullableString(value.hypocenterName)
    && isNullableString(value.depth)
    && isNullableString(value.magnitude)
    && typeof value.maxInt === "string"
    && Number.isSafeInteger(value.maxIntRank)
    && typeof value.tsunamiWarning === "boolean"
    && Array.isArray(value.intensityGroups) && value.intensityGroups.every(isIntensityGroup)
    && Array.isArray(value.localAreas) && value.localAreas.every(isLocalArea)
    && isFiniteNumber(value.updatedAtMs) && value.updatedAtMs <= nowMs
    && isOptionalRecord(value.depthSemantic)
    && isOptionalRecord(value.magnitudeSemantic)
    && isOptionalRecord(value.maxIntSemantic)
    && isOptionalRecord(value.reportedMaxIntSemantic);
}

function isLargeQuake(value: unknown, nowMs: number): value is DisplayLargeQuakeStateV1 {
  if (!isRecord(value) || value.kind !== "largeQuake" || !isNullableString(value.eventId) ||
      !isNullablePastIso(value.originTime, nowMs) || !isNullableString(value.hypocenterName) ||
      !isNullableString(value.magnitude) || typeof value.maxInt !== "string" ||
      !Number.isSafeInteger(value.maxIntRank) || !Array.isArray(value.intensityGroups) ||
      !value.intensityGroups.every(isIntensityGroup) || !isPastIso(value.reportDateTime, nowMs) ||
      !isNullableString(value.depth) || !isNullableString(value.maxLgInt) ||
      typeof value.tsunamiWarning !== "boolean" || !isFiniteNumber(value.updatedAtMs) ||
      value.updatedAtMs > nowMs || !isOptionalRecord(value.magnitudeSemantic) ||
      !isOptionalRecord(value.maxIntSemantic) || !isOptionalRecord(value.depthSemantic)) return false;
  const hasMapReference = value.mapEventKey !== undefined || value.mapSourceType !== undefined ||
    value.mapRevision !== undefined;
  return !hasMapReference ||
    typeof value.mapEventKey === "string" && value.mapEventKey !== "" &&
    typeof value.mapSourceType === "string" && value.mapSourceType !== "" &&
    isRevision(value.mapRevision);
}

function isIntensityGroup(value: unknown): value is DisplayIntensityGroupV1 {
  return isRecord(value) && typeof value.intensity === "string" && Number.isSafeInteger(value.rank) &&
    Array.isArray(value.areas) && value.areas.every((area) => typeof area === "string") &&
    typeof value.omittedAreaCount === "number" && Number.isSafeInteger(value.omittedAreaCount) &&
    value.omittedAreaCount >= 0 &&
    isOptionalRecord(value.intensitySemantic) &&
    (value.expandedAreas === undefined || Array.isArray(value.expandedAreas) &&
      value.expandedAreas.every((area) => typeof area === "string")) &&
    (value.candidateTruncated === undefined || typeof value.candidateTruncated === "boolean");
}

function isLocalArea(value: unknown): boolean {
  return isRecord(value) && typeof value.code === "string" && value.code !== "" &&
    Number.isSafeInteger(value.rank) && isOptionalRecord(value.intensitySemantic);
}

function isSeenEntry(value: unknown, nowMs: number): value is PersistedSeenEntry {
  return isRecord(value) && typeof value.key === "string" && value.key !== "" &&
    isRevision(value.revision) && isFiniteNumber(value.forgetAtMs) && value.forgetAtMs > nowMs;
}

function isRevision(value: unknown): value is PersistedSeenEntry["revision"] {
  return isRecord(value) && isFiniteNumber(value.reportTimeMs) && isNullableString(value.serial);
}

function isPastIso(value: unknown, nowMs: number): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function isNullablePastIso(value: unknown, nowMs: number): value is string | null {
  return value == null || isPastIso(value, nowMs);
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isOptionalRecord(value: unknown): boolean {
  return value === undefined || isRecord(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
