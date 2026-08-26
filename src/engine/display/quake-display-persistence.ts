import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type {
  DisplayDepthSemanticV1,
  DisplayIntensityGroupV1,
  DisplayIntensityMapValueV1,
  DisplayIntensitySemanticV1,
  DisplayLargeQuakeStateV1,
  DisplayMagnitudeSemanticV1,
  DisplayQuakeIntensityMapEventV1,
} from "./types";
import type { PersistedSeenEntry } from "./revision-guard";
import type { DisplayQuakeLifecyclePersistedV1 } from "./state-store";
import { isProjectedIntensitySemantic } from "./intensity-groups";
import {
  parsePersistedDepthSemantic,
  parsePersistedMagnitudeSemantic,
} from "../magnitude-depth-persistence";

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
  const corruptEventKeys = new Set<string>();
  const contributions: DisplayQuakeIntensityMapEventV1[] = [];
  for (const event of value.contributions) {
    if (isMapEvent(event, nowMs)) {
      contributions.push(structuredClone(event));
    } else if (isRecord(event) && typeof event.eventKey === "string" && event.eventKey !== "") {
      // 一系列の source contribution は相互に fallback し得る。片方が壊れていれば
      // 古い source を resurrection させず、eventKey 単位で fail-closed にする。
      corruptEventKeys.add(event.eventKey);
    }
  }
  const salvagedContributions = contributions.filter((event) => !corruptEventKeys.has(event.eventKey));
  const largeQuakes = value.largeQuakes.flatMap((entry): Array<{
    key: string;
    value: DisplayLargeQuakeStateV1;
  }> => {
    if (!isRecord(entry) || typeof entry.key !== "string" || entry.key === "" ||
        !isLargeQuake(entry.value, nowMs) ||
        corruptEventKeys.has(`earthquake:${entry.key}`) ||
        largeQuakeReferencesCorruptEvent(entry.value, corruptEventKeys)) return [];
    return [{ key: entry.key, value: structuredClone(entry.value) }];
  });
  const contributionKeys = new Set(salvagedContributions.map((event) => event.eventKey));
  // host 一件の破損で event／large-quake は捨てず、host だけ fail-closed にする。
  const nonEmergencyHost = parseHost(value.nonEmergencyHost, nowMs, contributionKeys);
  const unknownHost = parseHost(value.unknownHost, nowMs, contributionKeys);
  const revisions = value.revisions
    .filter((entry): entry is PersistedSeenEntry =>
      isSeenEntry(entry, nowMs) && !revisionReferencesCorruptEvent(entry.key, corruptEventKeys))
    .map((entry) => ({ ...entry, revision: { ...entry.revision } }));
  return {
    contributions: salvagedContributions,
    largeQuakes,
    nonEmergencyHost,
    ...(unknownHost == null ? {} : { unknownHost }),
    revisions,
  };
}

function largeQuakeReferencesCorruptEvent(
  quake: DisplayLargeQuakeStateV1,
  corruptEventKeys: ReadonlySet<string>,
): boolean {
  return (quake.mapEventKey != null && corruptEventKeys.has(quake.mapEventKey))
    || (quake.eventId != null && corruptEventKeys.has(`earthquake:${quake.eventId}`));
}

function revisionReferencesCorruptEvent(
  revisionKey: string,
  corruptEventKeys: ReadonlySet<string>,
): boolean {
  return [...corruptEventKeys].some((eventKey) => revisionKey.startsWith(`${eventKey}:`));
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
  if (!isRecord(value) || typeof value.eventKey !== "string" || value.eventKey === "" ||
      !isNullableString(value.eventId) || typeof value.sourceType !== "string" ||
      value.sourceType === "" || !isRevision(value.revision) || !isPastIso(value.reportDateTime, nowMs) ||
      !isNullablePastIso(value.originTime, nowMs) || !isNullableString(value.hypocenterName) ||
      !isNullableString(value.depth) || !isNullableString(value.magnitude) ||
      typeof value.maxInt !== "string" || !isDisplayIntensityRank(value.maxIntRank) ||
      typeof value.tsunamiWarning !== "boolean" || !Array.isArray(value.intensityGroups) ||
      !value.intensityGroups.every(isIntensityGroup) || !Array.isArray(value.localAreas) ||
      value.localAreas.length === 0 || !value.localAreas.every(isLocalArea) ||
      !isFiniteNumber(value.updatedAtMs) || value.updatedAtMs > nowMs) return false;
  const maxIntSemantic = parseOptionalIntensitySemantic(value.maxIntSemantic);
  const reportedMaxIntSemantic = parseOptionalIntensitySemantic(value.reportedMaxIntSemantic);
  return maxIntSemantic !== null
    && reportedMaxIntSemantic !== null
    && parseOptionalDepthSemantic(value.depthSemantic) !== null
    && parseOptionalMagnitudeSemantic(value.magnitudeSemantic) !== null
    && scalarRankMatchesSemantic(value.maxInt, value.maxIntRank, maxIntSemantic);
}

function isLargeQuake(value: unknown, nowMs: number): value is DisplayLargeQuakeStateV1 {
  if (!isRecord(value) || value.kind !== "largeQuake" || !isNullableString(value.eventId) ||
      !isNullablePastIso(value.originTime, nowMs) || !isNullableString(value.hypocenterName) ||
      !isNullableString(value.magnitude) || typeof value.maxInt !== "string" ||
      !isDisplayIntensityRank(value.maxIntRank) || !Array.isArray(value.intensityGroups) ||
      !value.intensityGroups.every(isIntensityGroup) || !isPastIso(value.reportDateTime, nowMs) ||
      !isNullableString(value.depth) || !isNullableString(value.maxLgInt) ||
      typeof value.tsunamiWarning !== "boolean" || !isFiniteNumber(value.updatedAtMs) ||
      value.updatedAtMs > nowMs) return false;
  const maxIntSemantic = parseOptionalIntensitySemantic(value.maxIntSemantic);
  if (
    maxIntSemantic === null
    || parseOptionalDepthSemantic(value.depthSemantic) === null
    || parseOptionalMagnitudeSemantic(value.magnitudeSemantic) === null
    || !scalarRankMatchesSemantic(value.maxInt, value.maxIntRank, maxIntSemantic)
  ) return false;
  const hasMapReference = value.mapEventKey !== undefined || value.mapSourceType !== undefined ||
    value.mapRevision !== undefined;
  return !hasMapReference ||
    typeof value.mapEventKey === "string" && value.mapEventKey !== "" &&
    typeof value.mapSourceType === "string" && value.mapSourceType !== "" &&
    isRevision(value.mapRevision);
}

function isIntensityGroup(value: unknown): value is DisplayIntensityGroupV1 {
  if (!isRecord(value) || typeof value.intensity !== "string" || !isDisplayIntensityRank(value.rank) ||
      !Array.isArray(value.areas) || !value.areas.every((area) => typeof area === "string") ||
      !isNonNegativeSafeInteger(value.omittedAreaCount) ||
      value.expandedAreas !== undefined && (!Array.isArray(value.expandedAreas) ||
        !value.expandedAreas.every((area) => typeof area === "string")) ||
      value.candidateTruncated !== undefined && typeof value.candidateTruncated !== "boolean") return false;
  const semantic = parseOptionalIntensitySemantic(value.intensitySemantic);
  return semantic !== null && groupRankMatchesSemantic(value.intensity, value.rank, semantic);
}

function isLocalArea(value: unknown): value is DisplayIntensityMapValueV1 {
  if (!isRecord(value) || typeof value.code !== "string" || value.code === "" ||
      !isDisplayIntensityRank(value.rank)) return false;
  const semantic = parseOptionalIntensitySemantic(value.intensitySemantic);
  return semantic !== null && mapRankMatchesSemantic(value.rank, semantic);
}

function parseOptionalIntensitySemantic(
  value: unknown,
): DisplayIntensitySemanticV1 | undefined | null {
  return value === undefined ? undefined : parseIntensitySemantic(value);
}

function parseOptionalDepthSemantic(value: unknown): DisplayDepthSemanticV1 | undefined | null {
  return value === undefined ? undefined : parsePersistedDepthSemantic(value);
}

function parseOptionalMagnitudeSemantic(value: unknown): DisplayMagnitudeSemanticV1 | undefined | null {
  return value === undefined ? undefined : parsePersistedMagnitudeSemantic(value);
}

function mapRankMatchesSemantic(
  rank: number,
  semantic: DisplayIntensitySemanticV1 | undefined,
): boolean {
  return semantic == null
    ? rank >= 0
    : semantic.render
      && semantic.presence !== "missing"
      && rank === (semantic.colorRank ?? -1);
}

function scalarRankMatchesSemantic(
  intensity: string,
  rank: number,
  semantic: DisplayIntensitySemanticV1 | undefined,
): boolean {
  return mapRankMatchesSemantic(rank, semantic)
    && (semantic == null || semantic.label === intensity);
}

function groupRankMatchesSemantic(
  intensity: string,
  rank: number,
  semantic: DisplayIntensitySemanticV1 | undefined,
): boolean {
  return mapRankMatchesSemantic(rank, semantic)
    && (semantic == null || semantic.label === intensity);
}

const SPECIAL_VALUE_PRESENCES = new Set([
  "value", "missing", "empty", "unknown", "qualitative", "range",
]);
const INTENSITY_BADGES = new Set([null, "≥", "↔", "?", "∅"]);
const INTENSITY_COLORS = new Set([
  "normalRank", "safetyRank", "safetyUpperRank", "unknown", "neutral", "notRendered",
]);

/** daily persistence と同じ projector-based semantic validation。 */
function parseIntensitySemantic(value: unknown): DisplayIntensitySemanticV1 | null {
  if (!isRecord(value)) return null;
  const required = [
    "raw", "presence", "label", "condition", "description", "lowerBound", "upperBound",
    "rawLowerBound", "rawUpperBound", "badge", "color", "render", "safetyLowerRank",
    "safetyUpperRank", "safetyRank", "colorRank",
  ];
  if (!required.every((key) => Object.hasOwn(value, key))) return null;
  if (
    !isNullableString(value.raw)
    || typeof value.presence !== "string" || !SPECIAL_VALUE_PRESENCES.has(value.presence)
    || !isNullableString(value.label)
    || !isNullableString(value.condition)
    || !isNullableString(value.description)
    || !isNullableString(value.lowerBound)
    || !isNullableString(value.upperBound)
    || !isNullableString(value.rawLowerBound)
    || !isNullableString(value.rawUpperBound)
    || !INTENSITY_BADGES.has(value.badge as string | null)
    || typeof value.color !== "string" || !INTENSITY_COLORS.has(value.color)
    || typeof value.render !== "boolean"
    || !isNullableIntensityRank(value.safetyLowerRank)
    || !isNullableIntensityRank(value.safetyUpperRank)
    || !isNullableIntensityRank(value.safetyRank)
    || !isNullableIntensityRank(value.colorRank)
  ) return null;
  const semantic: DisplayIntensitySemanticV1 = {
    raw: value.raw as string | null,
    presence: value.presence as DisplayIntensitySemanticV1["presence"],
    label: value.label as string | null,
    condition: value.condition as string | null,
    description: value.description as string | null,
    lowerBound: value.lowerBound as string | null,
    upperBound: value.upperBound as string | null,
    rawLowerBound: value.rawLowerBound as string | null,
    rawUpperBound: value.rawUpperBound as string | null,
    badge: value.badge as DisplayIntensitySemanticV1["badge"],
    color: value.color as DisplayIntensitySemanticV1["color"],
    render: value.render,
    safetyLowerRank: value.safetyLowerRank as number | null,
    safetyUpperRank: value.safetyUpperRank as number | null,
    safetyRank: value.safetyRank as number | null,
    colorRank: value.colorRank as number | null,
  };
  return isProjectedIntensitySemantic(semantic) ? semantic : null;
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isDisplayIntensityRank(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= -1 && value <= 9;
}

function isNullableIntensityRank(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 9;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
