import type {
  ParsedVolcanoInfo,
  ParsedVolcanoAlertInfo,
  PromptStatusProvider,
  PromptStatusSegment,
  PromptStatusRole,
  DetailProvider,
  DetailSnapshotOf,
  VolcanoAction,
  VolcanoAlertClass,
  VolcanoAlertClassEntry,
  VolcanoAlertStateEntry,
  ParsedVolcanoEruptionInfo,
  VolcanoAshfallProjectionV1,
} from "../../types";
import type { DisplayVolcanoEventV1 } from "../display/protocol";
import { projectPlumeHeightSemantic } from "../display/plume-height-semantic";
import { validateVolcanoAshfallProjection } from "./volcano-ashfall-projector";

const DAY_MS = 86_400_000;
const CONTROL_PATTERN = /\p{Cc}/u;

export const VOLCANO_ALERT_MAX_SUBJECTS = 128;
export const VOLCANO_ERUPTION_MAX_SUBJECTS = 128;
export const VOLCANO_ASHFALL_MAX_SUBJECTS = 128;
export const VOLCANO_MAX_ACTIVE_COMPOSITES = 128;
export const VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE = 4096;

export type VolcanoAlertSourceFamily = "VFVO50" | "VFVO51" | "VFSVii";
export type PersistedVolcanoAlertSourceFamily =
  | VolcanoAlertSourceFamily
  | "operationalV2Unknown";

export type VolcanoRepairTarget = "vfvo50" | "ashfall";
export type VolcanoOmissionReason =
  | "sliceCorrupt"
  | "gateCorrupt"
  | "provenanceMissing"
  | "operationalV2ProvenanceLost"
  | "terminalQuarantine";

export interface VolcanoAlertOmissionV1 {
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  sourceFamily: VolcanoAlertSourceFamily | "unknown";
  lastKnownComparison: import("../../types").TelegramRevisionComparisonInput | null;
  reason: VolcanoOmissionReason;
}

export interface VolcanoEruptionOmissionV1 {
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  lastKnownComparison: import("../../types").TelegramRevisionComparisonInput | null;
  reason: VolcanoOmissionReason;
}

export type VolcanoOperationalV2ResolutionAction =
  | "acceptCurrent"
  | "clearCurrent"
  | "acknowledgeDomainLoss";

export interface VolcanoOperationalV2AlertResolutionV1 {
  resolutionId: string;
  omissionFingerprint: string;
  scope: "volcano" | "domain";
  volcanoCode: string | null;
  action: VolcanoOperationalV2ResolutionAction;
  resolvedAtMs: number;
  actor: "local-repl";
  reason: string;
}

export interface VolcanoRepairStateV1 {
  schemaGeneration: 1;
  vfvo50Repairable: boolean;
  ashfallRepairable: boolean;
  unrecoverableAlertOmissions: VolcanoAlertOmissionV1[];
  unrecoverableEruptionOmissions: VolcanoEruptionOmissionV1[];
  operationalV2AlertResolutions: VolcanoOperationalV2AlertResolutionV1[];
}

export function emptyVolcanoRepairState(): VolcanoRepairStateV1 {
  return {
    schemaGeneration: 1,
    vfvo50Repairable: false,
    ashfallRepairable: false,
    unrecoverableAlertOmissions: [],
    unrecoverableEruptionOmissions: [],
    operationalV2AlertResolutions: [],
  };
}

export interface VolcanoAlertEntry {
  volcanoCode: string;
  volcanoName: string;
  alertLevel: number | null;
  alertLevelCode: string | null;
  action: VolcanoAction;
  reportDateTime: string;
  alertClass: VolcanoAlertClass | null;
  warningKind: string;
  targetKinds: string[];
  lastInfo: ParsedVolcanoAlertInfo | null;
}

export interface PersistedVolcanoAlertSliceV2
  extends Omit<VolcanoAlertEntry, "lastInfo"> {
  sourceFamily: PersistedVolcanoAlertSourceFamily;
  operationalV2ResolutionId?: string;
  revision: { reportTimeMs: number; serial: string | null };
  appliedSemanticKey: string;
}

export interface PersistedVolcanoEruptionSliceV2 {
  volcanoName: string;
  latestEvent: DisplayVolcanoEventV1;
  latestEventId: string | null;
  eventExpiresAtMs: number;
  revision: { reportTimeMs: number; serial: string | null };
  appliedSemanticKey: string;
  legacyV1Fallback?: boolean;
}

export interface VolcanoCompositeV2 {
  volcanoCode: string;
  volcanoName: string;
  sourceEventIds: string[];
  alert: PersistedVolcanoAlertSliceV2 | null;
  eruption: PersistedVolcanoEruptionSliceV2 | null;
  ashfall: VolcanoAshfallProjectionV1 | null;
}

/** Canonical generation-1 state. Compatibility properties are non-enumerable. */
export interface PersistedVolcanoStateV2 {
  generation: 1;
  volcanoes: VolcanoCompositeV2[];
  readonly alerts: Array<Omit<VolcanoAlertEntry, "lastInfo">>;
  readonly eruptions: Array<{
    volcanoCode: string;
    eventId: string | null;
    legacyV1Fallback?: boolean;
  }>;
  readonly ashfalls: VolcanoAshfallProjectionV1[];
}

export interface LegacyPersistedVolcanoStateV2 {
  alerts: Array<Omit<VolcanoAlertEntry, "lastInfo">>;
  eruptions: Array<{
    volcanoCode: string;
    eventId: string | null;
    legacyV1Fallback?: boolean;
  }>;
  ashfalls?: VolcanoAshfallProjectionV1[];
}

interface RuntimeComposite extends VolcanoCompositeV2 {
  restored: { alert: boolean; eruption: boolean; ashfall: boolean };
}

export interface VolcanoHolderSnapshot {
  version: number;
  composites: VolcanoCompositeV2[];
  restored: Array<{
    volcanoCode: string;
    alert: boolean;
    eruption: boolean;
    ashfall: boolean;
  }>;
  legacyEruptionIdentities: Array<{
    volcanoCode: string;
    eventId: string | null;
    legacyV1Fallback: boolean;
  }>;
}

export interface VolcanoRestoreMutation {
  changed: boolean;
  expiredEruptionCodes: string[];
  expiredAshfallCodes: string[];
}

export interface VolcanoSweepResult {
  changed: boolean;
  expiredEruptionCodes: string[];
  expiredAshfallCodes: string[];
}

export interface VolcanoMutationBinding {
  sourceEventId: string;
  revision: { reportTimeMs: number; serial: string | null };
  appliedSemanticKey: string;
  restored?: boolean;
}

export interface VolcanoSeedEntry {
  volcanoCode: string;
  volcanoName: string;
  reportDateTime: string;
  alertLevel: number | null;
  alertClass: ParsedVolcanoAlertInfo["alertClass"];
  warningKind: string;
  targetKinds: string[];
  active: boolean;
}

export function activeLegacyEruptionIdentitySeeds(
  states: readonly {
    code: string;
    latestEvent?: unknown | null;
    latestEventId?: string | null;
    eventExpiresAtMs: number | null;
  }[],
  foundationSubjects: ReadonlySet<string>,
  nowMs: number,
): Array<{ volcanoCode: string; eventId: string | null }> {
  return states.flatMap((state) =>
    state.latestEvent == null
    || state.eventExpiresAtMs == null
    || state.eventExpiresAtMs <= nowMs
    || foundationSubjects.has(`volcano:eruption:${state.code}`)
      ? []
      : [{ volcanoCode: state.code, eventId: state.latestEventId ?? null }]);
}

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalText(value: string, maximum: number, collapseWhitespace = false): string | null {
  let result = value.normalize("NFC");
  if (CONTROL_PATTERN.test(result)) return null;
  result = result.trim();
  if (collapseWhitespace) result = result.replace(/\s+/gu, " ");
  return result === "" || result.length > maximum ? null : result;
}

function validSourceId(value: string): string | null {
  const normalized = value.normalize("NFC");
  if (CONTROL_PATTERN.test(normalized)) return null;
  const result = normalized.trim();
  return result === "" || result.length > 256
    ? null
    : result;
}

function checkedExpiry(reportTimeMs: number): number | null {
  const value = reportTimeMs + DAY_MS;
  return Number.isSafeInteger(reportTimeMs)
    && Number.isSafeInteger(value)
    && Math.abs(reportTimeMs) <= 8_640_000_000_000_000
    && Math.abs(value) <= 8_640_000_000_000_000
    ? value
    : null;
}

function defaultBinding(info: {
  reportDateTime: string;
  meta: { messageId: string; reportDateTime: { epochMs: number | null }; serial: { raw: string | null } };
}): VolcanoMutationBinding {
  const reportTimeMs = info.meta.reportDateTime.epochMs ?? Date.parse(info.reportDateTime);
  const sourceEventId = validSourceId(info.meta.messageId) ?? "legacy-holder";
  return {
    sourceEventId,
    revision: { reportTimeMs: Number.isSafeInteger(reportTimeMs) ? reportTimeMs : 0, serial: info.meta.serial.raw },
    appliedSemanticKey: `holder:${sourceEventId}`.slice(0, 128),
  };
}

function levelToRole(level: number | null): PromptStatusRole {
  switch (level) {
    case 5:
    case 4: return "frameCritical";
    case 3:
    case 2: return "frameWarning";
    default: return "frameNormal";
  }
}

function levelToLabel(level: number | null): string {
  return level == null ? "" : ` Lv${level}`;
}

function cloneComposite(composite: VolcanoCompositeV2): VolcanoCompositeV2 {
  return structuredClone(composite);
}

function displayEruption(info: ParsedVolcanoEruptionInfo): DisplayVolcanoEventV1 {
  const craterSemantic = projectPlumeHeightSemantic(info.plumeHeightAboveCraterValue);
  const seaSemantic = projectPlumeHeightSemantic(info.plumeHeightAboveSeaLevelValue);
  return {
    label: info.isFlashReport ? "噴火速報" : info.phenomenonName.trim() || "噴火",
    craterName: info.craterName,
    eventDateTime: info.eventDateTime,
    plumeHeightM: info.plumeHeight,
    plumeHeightUnknown: info.plumeHeightUnknown,
    ...(craterSemantic == null ? {} : { plumeHeightAboveCraterSemantic: craterSemantic }),
    ...(seaSemantic == null ? {} : { plumeHeightAboveSeaLevelSemantic: seaSemantic }),
    plumeDirection: info.plumeDirection,
  };
}

function legacyViews(
  canonical: { generation: 1; volcanoes: VolcanoCompositeV2[] },
  legacyIdentities: readonly { volcanoCode: string; eventId: string | null; legacyV1Fallback: boolean }[],
): PersistedVolcanoStateV2 {
  const value = canonical as PersistedVolcanoStateV2;
  Object.defineProperties(value, {
    alerts: {
      enumerable: false,
      get: () => canonical.volcanoes.flatMap((composite) => composite.alert == null ? [] : [{
        volcanoCode: composite.alert.volcanoCode,
        volcanoName: composite.alert.volcanoName,
        alertLevel: composite.alert.alertLevel,
        alertLevelCode: composite.alert.alertLevelCode,
        action: composite.alert.action,
        reportDateTime: composite.alert.reportDateTime,
        alertClass: structuredClone(composite.alert.alertClass),
        warningKind: composite.alert.warningKind,
        targetKinds: [...composite.alert.targetKinds],
      }]),
    },
    eruptions: {
      enumerable: false,
      get: () => {
        const active = canonical.volcanoes.flatMap((composite) => composite.eruption == null ? [] : [{
          volcanoCode: composite.volcanoCode,
          eventId: composite.eruption.latestEventId,
          ...(composite.eruption.legacyV1Fallback === true ? { legacyV1Fallback: true } : {}),
        }]);
        const existing = new Set(active.map((entry) => entry.volcanoCode));
        return [...active, ...legacyIdentities.filter((entry) => !existing.has(entry.volcanoCode)).map((entry) => ({
          volcanoCode: entry.volcanoCode,
          eventId: entry.eventId,
          ...(entry.legacyV1Fallback ? { legacyV1Fallback: true } : {}),
        }))];
      },
    },
    ashfalls: {
      enumerable: false,
      get: () => canonical.volcanoes.flatMap((composite) =>
        composite.ashfall == null ? [] : [structuredClone(composite.ashfall)]),
    },
  });
  return value;
}

export class VolcanoStateHolder implements PromptStatusProvider, DetailProvider<"volcano"> {
  readonly category = "volcano";
  readonly emptyMessage = "現在、継続中の火山警報はありません。";

  private composites = new Map<string, RuntimeComposite>();
  private legacyEruptionIdentities = new Map<string, { eventId: string | null; legacyV1Fallback: boolean }>();
  private ownerVersion = 0;

  version(): number { return this.ownerVersion; }

  snapshot(): VolcanoHolderSnapshot {
    return {
      version: this.ownerVersion,
      composites: [...this.composites.values()].map(cloneComposite)
        .sort((left, right) => compareCodeUnit(left.volcanoCode, right.volcanoCode)),
      restored: [...this.composites.values()].map((entry) => ({ volcanoCode: entry.volcanoCode, ...entry.restored }))
        .sort((left, right) => compareCodeUnit(left.volcanoCode, right.volcanoCode)),
      legacyEruptionIdentities: [...this.legacyEruptionIdentities].map(([volcanoCode, entry]) => ({ volcanoCode, ...entry }))
        .sort((left, right) => compareCodeUnit(left.volcanoCode, right.volcanoCode)),
    };
  }

  static fromSnapshot(snapshot: VolcanoHolderSnapshot): VolcanoStateHolder {
    const holder = new VolcanoStateHolder();
    holder.loadSnapshot(snapshot, false);
    return holder;
  }

  replacePrevalidated(snapshot: VolcanoHolderSnapshot): void { this.loadSnapshot(snapshot, true); }

  private loadSnapshot(snapshot: VolcanoHolderSnapshot, commit: boolean): void {
    const restored = new Map(snapshot.restored.map((entry) => [entry.volcanoCode, entry]));
    this.composites = new Map(snapshot.composites.map((entry) => [entry.volcanoCode, {
      ...cloneComposite(entry),
      restored: {
        alert: restored.get(entry.volcanoCode)?.alert === true,
        eruption: restored.get(entry.volcanoCode)?.eruption === true,
        ashfall: restored.get(entry.volcanoCode)?.ashfall === true,
      },
    }]));
    this.legacyEruptionIdentities = new Map(snapshot.legacyEruptionIdentities.map((entry) => [
      entry.volcanoCode,
      { eventId: entry.eventId, legacyV1Fallback: entry.legacyV1Fallback },
    ]));
    this.ownerVersion = commit ? this.ownerVersion + 1 : snapshot.version;
  }

  composite(code: string): VolcanoCompositeV2 | undefined {
    const entry = this.composites.get(code);
    return entry == null ? undefined : cloneComposite(entry);
  }

  private ensureComposite(code: string, name: string): RuntimeComposite | null {
    const existing = this.composites.get(code);
    if (existing != null) return existing;
    if (this.composites.size >= VOLCANO_MAX_ACTIVE_COMPOSITES) return null;
    const entry: RuntimeComposite = {
      volcanoCode: code,
      volcanoName: name,
      sourceEventIds: [],
      alert: null,
      eruption: null,
      ashfall: null,
      restored: { alert: false, eruption: false, ashfall: false },
    };
    this.composites.set(code, entry);
    return entry;
  }

  private addSource(entry: RuntimeComposite, sourceEventId: string): boolean {
    const source = validSourceId(sourceEventId);
    if (source == null) return false;
    if (entry.sourceEventIds.includes(source)) return true;
    if (entry.sourceEventIds.length >= VOLCANO_MAX_SOURCE_EVENT_IDS_PER_COMPOSITE) return false;
    entry.sourceEventIds.push(source);
    entry.sourceEventIds.sort(compareCodeUnit);
    return true;
  }

  private deleteIfEmpty(code: string): void {
    const entry = this.composites.get(code);
    if (entry != null && entry.alert == null && entry.eruption == null && entry.ashfall == null) {
      this.composites.delete(code);
    }
  }

  private updateAcceptedVolcanoName(
    entry: VolcanoCompositeV2,
    volcanoName: string | undefined,
  ): boolean {
    if (volcanoName == null) return false;
    const name = canonicalText(volcanoName, 128, true);
    if (name == null || name === entry.volcanoName) return false;
    entry.volcanoName = name;
    return true;
  }

  applyAcceptedAlert(info: ParsedVolcanoAlertInfo, binding = defaultBinding(info)): boolean {
    const code = canonicalText(info.volcanoCode, 32);
    const name = canonicalText(info.volcanoName, 128, true);
    if (code == null || name == null) return false;
    const existed = this.composites.has(code);
    const entry = this.ensureComposite(code, name);
    if (entry == null || !this.addSource(entry, binding.sourceEventId)) {
      if (!existed) this.composites.delete(code);
      return false;
    }
    if (name !== "") entry.volcanoName = name;
    entry.alert = {
      volcanoCode: code, volcanoName: name, alertLevel: info.alertLevel,
      alertLevelCode: info.alertLevelCode, action: info.action,
      reportDateTime: info.reportDateTime,
      alertClass: info.alertClass == null ? null : structuredClone(info.alertClass),
      warningKind: info.warningKind,
      targetKinds: info.municipalities.map((municipality) => municipality.kind),
      sourceFamily: info.type,
      revision: { ...binding.revision },
      appliedSemanticKey: binding.appliedSemanticKey,
    };
    entry.restored.alert = binding.restored === true;
    this.ownerVersion += 1;
    return true;
  }

  applyAcceptedAlertClass(entry: VolcanoAlertClassEntry, reportDateTime: string, binding?: VolcanoMutationBinding): boolean {
    return this.applyAcceptedTextAlert({
      volcanoCode: entry.volcanoCode, volcanoName: entry.volcanoName,
      alertLevel: null, alertLevelCode: entry.alertClass.code,
      action: entry.alertClass.isActive ? "continue" : "release",
      warningKind: entry.alertClass.name, alertClass: { ...entry.alertClass },
    }, reportDateTime, binding);
  }

  applyAcceptedTextAlert(
    alert: VolcanoAlertStateEntry,
    reportDateTime: string,
    binding: VolcanoMutationBinding = {
      sourceEventId: "legacy-holder",
      revision: { reportTimeMs: Number.isSafeInteger(Date.parse(reportDateTime)) ? Date.parse(reportDateTime) : 0, serial: null },
      appliedSemanticKey: "holder:legacy-text-alert",
    },
    sourceFamily: "VFVO51" = "VFVO51",
  ): boolean {
    const code = canonicalText(alert.volcanoCode, 32);
    const name = canonicalText(alert.volcanoName, 128, true);
    if (code == null || name == null) return false;
    const existed = this.composites.has(code);
    const entry = this.ensureComposite(code, name);
    if (entry == null || !this.addSource(entry, binding.sourceEventId)) {
      if (!existed) this.composites.delete(code);
      return false;
    }
    if (name !== "") entry.volcanoName = name;
    entry.alert = {
      volcanoCode: code, volcanoName: name, alertLevel: alert.alertLevel,
      alertLevelCode: alert.alertLevelCode, action: alert.action, reportDateTime,
      alertClass: alert.alertClass == null ? null : structuredClone(alert.alertClass),
      warningKind: alert.warningKind, targetKinds: [], sourceFamily,
      revision: { ...binding.revision }, appliedSemanticKey: binding.appliedSemanticKey,
    };
    entry.restored.alert = binding.restored === true;
    this.ownerVersion += 1;
    return true;
  }

  clearAlert(volcanoCode: string, sourceEventId?: string, volcanoName?: string): boolean {
    const code = canonicalText(volcanoCode, 32);
    if (code == null) return false;
    const entry = this.composites.get(code);
    if (entry == null) return false;
    const previousSourceCount = entry.sourceEventIds.length;
    if (sourceEventId != null && !this.addSource(entry, sourceEventId)) return false;
    const nameChanged = this.updateAcceptedVolcanoName(entry, volcanoName);
    const changed = entry.alert != null
      || entry.sourceEventIds.length !== previousSourceCount
      || nameChanged;
    if (!changed) return false;
    entry.alert = null;
    entry.restored.alert = false;
    this.deleteIfEmpty(code);
    this.ownerVersion += 1;
    return true;
  }

  applyAcceptedEruption(info: ParsedVolcanoEruptionInfo, eventId: string | null, binding = defaultBinding(info)): boolean {
    const code = canonicalText(info.volcanoCode, 32);
    const normalizedRawName = info.volcanoName.normalize("NFC");
    const normalizedName = normalizedRawName.trim().replace(/\s+/gu, " ");
    const name = CONTROL_PATTERN.test(normalizedRawName) || normalizedName.length > 128
      ? null
      : normalizedName;
    const rawEventId = info.meta.eventId.raw;
    const canonicalEventId = rawEventId == null ? null : canonicalText(rawEventId, 128);
    const expiry = checkedExpiry(binding.revision.reportTimeMs);
    if (code == null || name == null || expiry == null
      || rawEventId != null && canonicalEventId == null
      || eventId != null && canonicalEventId !== eventId.normalize("NFC").trim()) return false;
    const existed = this.composites.has(code);
    const entry = this.ensureComposite(code, name);
    if (entry == null || !this.addSource(entry, binding.sourceEventId)) {
      if (!existed) this.composites.delete(code);
      return false;
    }
    if (name !== "") entry.volcanoName = name;
    entry.eruption = {
      volcanoName: name, latestEvent: displayEruption(info),
      latestEventId: canonicalEventId, eventExpiresAtMs: expiry,
      revision: { ...binding.revision }, appliedSemanticKey: binding.appliedSemanticKey,
    };
    entry.restored.eruption = binding.restored === true;
    this.legacyEruptionIdentities.delete(code);
    this.ownerVersion += 1;
    return true;
  }

  clearEruption(volcanoCode: string, sourceEventId?: string, volcanoName?: string): boolean {
    const code = canonicalText(volcanoCode, 32);
    if (code == null) return false;
    const entry = this.composites.get(code);
    if (entry == null) {
      const changed = this.legacyEruptionIdentities.delete(code);
      if (changed) this.ownerVersion += 1;
      return changed;
    }
    const previousSourceCount = entry.sourceEventIds.length;
    if (sourceEventId != null && !this.addSource(entry, sourceEventId)) return false;
    const legacyChanged = this.legacyEruptionIdentities.delete(code);
    const nameChanged = this.updateAcceptedVolcanoName(entry, volcanoName);
    const changed = entry.eruption != null
      || entry.sourceEventIds.length !== previousSourceCount
      || legacyChanged
      || nameChanged;
    if (!changed) return false;
    entry.eruption = null;
    entry.restored.eruption = false;
    this.deleteIfEmpty(code);
    this.ownerVersion += 1;
    return true;
  }

  applyAcceptedAshfall(projection: VolcanoAshfallProjectionV1): boolean {
    if (validateVolcanoAshfallProjection(projection) != null) return false;
    const existed = this.composites.has(projection.volcanoCode);
    const entry = this.ensureComposite(projection.volcanoCode, projection.volcanoName);
    const expectedGeneration = (entry?.ashfall?.generation ?? 0) + 1;
    if (entry == null || !Number.isSafeInteger(expectedGeneration)
      || projection.generation !== expectedGeneration) {
      if (!existed) this.composites.delete(projection.volcanoCode);
      return false;
    }
    if (!this.addSource(entry, projection.sourceEventId)) {
      if (!existed) this.composites.delete(projection.volcanoCode);
      return false;
    }
    if (projection.volcanoName !== "") entry.volcanoName = projection.volcanoName;
    entry.ashfall = structuredClone(projection);
    entry.restored.ashfall = false;
    this.ownerVersion += 1;
    return true;
  }

  clearAshfall(volcanoCode: string, sourceEventId?: string, volcanoName?: string): boolean {
    const code = canonicalText(volcanoCode, 32);
    if (code == null) return false;
    const entry = this.composites.get(code);
    if (entry == null) return false;
    const previousSourceCount = entry.sourceEventIds.length;
    if (sourceEventId != null && !this.addSource(entry, sourceEventId)) return false;
    const nameChanged = this.updateAcceptedVolcanoName(entry, volcanoName);
    const changed = entry.ashfall != null
      || entry.sourceEventIds.length !== previousSourceCount
      || nameChanged;
    entry.ashfall = null;
    entry.restored.ashfall = false;
    this.deleteIfEmpty(code);
    if (changed) this.ownerVersion += 1;
    return changed;
  }

  ashfall(volcanoCode: string): VolcanoAshfallProjectionV1 | null {
    const value = this.composites.get(volcanoCode)?.ashfall;
    return value == null ? null : structuredClone(value);
  }

  sweep(nowMs: number): VolcanoSweepResult {
    const expiredEruptionCodes: string[] = [];
    const expiredAshfallCodes: string[] = [];
    for (const [code, entry] of [...this.composites]) {
      if (entry.eruption != null && nowMs >= entry.eruption.eventExpiresAtMs) {
        entry.eruption = null; entry.restored.eruption = false; expiredEruptionCodes.push(code);
      }
      if (entry.ashfall != null && nowMs >= entry.ashfall.forecastEndsAtMs) {
        entry.ashfall = null; entry.restored.ashfall = false; expiredAshfallCodes.push(code);
      }
      this.deleteIfEmpty(code);
    }
    const changed = expiredEruptionCodes.length > 0 || expiredAshfallCodes.length > 0;
    if (changed) this.ownerVersion += 1;
    return { changed, expiredEruptionCodes: expiredEruptionCodes.sort(compareCodeUnit), expiredAshfallCodes: expiredAshfallCodes.sort(compareCodeUnit) };
  }

  sweepAshfall(nowMs: number): string[] { return this.sweep(nowMs).expiredAshfallCodes; }

  resolveEruptionCancellation(eventId: string): string | null {
    const exact = [...this.composites.values()].filter((entry) => entry.eruption?.latestEventId === eventId)
      .map((entry) => entry.volcanoCode);
    const legacyExact = [...this.legacyEruptionIdentities]
      .filter(([, entry]) => entry.eventId === eventId)
      .map(([code]) => code);
    const exactCodes = [...new Set([...exact, ...legacyExact])];
    if (exactCodes.length === 1) return exactCodes[0]!;
    if (exactCodes.length > 1) return null;
    const legacy = [
      ...[...this.composites.values()].flatMap((entry) =>
        entry.eruption?.latestEventId == null && entry.eruption?.legacyV1Fallback === true ? [entry.volcanoCode] : []),
      ...[...this.legacyEruptionIdentities].filter(([, entry]) => entry.eventId == null && entry.legacyV1Fallback)
        .map(([code]) => code),
    ];
    return legacy.length === 1 ? legacy[0]! : null;
  }

  eruptionEventId(volcanoCode: string): string | null {
    return this.composites.get(volcanoCode)?.eruption?.latestEventId?.trim()
      || this.legacyEruptionIdentities.get(volcanoCode)?.eventId?.trim() || null;
  }

  seedLegacyEruptionIdentities(entries: readonly { volcanoCode: string; eventId: string | null }[]): void {
    let changed = false;
    for (const item of entries) {
      if (item.volcanoCode === "" || this.composites.get(item.volcanoCode)?.eruption != null
        || this.legacyEruptionIdentities.has(item.volcanoCode)) continue;
      this.legacyEruptionIdentities.set(item.volcanoCode, { eventId: item.eventId, legacyV1Fallback: true });
      changed = true;
    }
    if (changed) this.ownerVersion += 1;
  }

  retainActiveSubjects(
    alertSubjects: readonly string[],
    eruptionSubjects: readonly string[],
    ashfallSubjects?: readonly string[],
  ): boolean {
    const alerts = new Set(alertSubjects.map((subject) => subject.replace(/^volcano:alert:/, "")));
    const eruptions = new Set(eruptionSubjects.map((subject) => subject.replace(/^volcano:eruption:/, "")));
    const ashfalls = ashfallSubjects == null
      ? null
      : new Set(ashfallSubjects.map((subject) => subject.replace(/^volcano:ashfall:/, "")));
    let changed = false;
    for (const [code, entry] of [...this.composites]) {
      if (entry.alert != null && !alerts.has(code)) { entry.alert = null; entry.restored.alert = false; changed = true; }
      if (entry.eruption != null && !eruptions.has(code)) { entry.eruption = null; entry.restored.eruption = false; changed = true; }
      if (entry.ashfall != null && ashfalls != null && !ashfalls.has(code)) {
        entry.ashfall = null;
        entry.restored.ashfall = false;
        changed = true;
      }
      this.deleteIfEmpty(code);
    }
    if (changed) this.ownerVersion += 1;
    return changed;
  }

  /** @deprecated formatter/unit helper; production ordering belongs to the gate. */
  update(info: ParsedVolcanoInfo): boolean {
    if (info.kind !== "alert" || !info.volcanoCode) return true;
    if (info.infoType === "取消" || info.action === "release" || info.action === "cancel"
      || info.alertLevel === 1 && (info.action === "continue" || info.action === "lower")) {
      this.clearAlert(info.volcanoCode);
      return true;
    }
    this.applyAcceptedAlert(info);
    return true;
  }

  isRenotification(info: ParsedVolcanoAlertInfo): boolean {
    const code = canonicalText(info.volcanoCode, 32);
    const existing = code == null ? null : this.composites.get(code)?.alert;
    return existing != null && existing.alertLevel === info.alertLevel
      && existing.alertLevelCode === info.alertLevelCode && existing.action === info.action;
  }

  clear(): void {
    const changed = this.composites.size > 0 || this.legacyEruptionIdentities.size > 0;
    this.composites.clear(); this.legacyEruptionIdentities.clear();
    if (changed) this.ownerVersion += 1;
  }

  size(): number { return [...this.composites.values()].filter((entry) => entry.alert != null).length; }

  getEntry(volcanoCode: string): VolcanoAlertEntry | undefined {
    const alert = this.composites.get(volcanoCode)?.alert;
    return alert == null ? undefined : {
      volcanoCode: alert.volcanoCode, volcanoName: alert.volcanoName,
      alertLevel: alert.alertLevel, alertLevelCode: alert.alertLevelCode,
      action: alert.action, reportDateTime: alert.reportDateTime,
      alertClass: alert.alertClass == null ? null : structuredClone(alert.alertClass),
      warningKind: alert.warningKind, targetKinds: [...alert.targetKinds], lastInfo: null,
    };
  }

  getSeedEntries(): VolcanoSeedEntry[] {
    return [...this.composites.values()].flatMap((entry) => entry.alert == null ? [] : [{
      volcanoCode: entry.volcanoCode, volcanoName: entry.volcanoName,
      alertLevel: entry.alert.alertLevel, alertClass: structuredClone(entry.alert.alertClass),
      warningKind: entry.alert.warningKind, targetKinds: [...entry.alert.targetKinds],
      reportDateTime: entry.alert.reportDateTime, active: true,
    }]);
  }

  exportPersistedState(): PersistedVolcanoStateV2 {
    return legacyViews({
      generation: 1,
      volcanoes: [...this.composites.values()].map(cloneComposite)
        .sort((left, right) => compareCodeUnit(left.volcanoCode, right.volcanoCode)),
    }, [...this.legacyEruptionIdentities].map(([volcanoCode, entry]) => ({ volcanoCode, ...entry })));
  }

  restorePersistedState(
    state: PersistedVolcanoStateV2 | LegacyPersistedVolcanoStateV2,
    nowMs = Date.now(),
  ): VolcanoRestoreMutation {
    const nextOwnerVersion = this.ownerVersion + 1;
    this.composites.clear(); this.legacyEruptionIdentities.clear();
    const ownLegacy = !("generation" in state) || state.generation !== 1;
    if (!ownLegacy && "volcanoes" in state) {
      for (const composite of state.volcanoes) {
        if (composite.alert == null && composite.eruption == null && composite.ashfall == null) continue;
        this.composites.set(composite.volcanoCode, {
          ...cloneComposite(composite),
          restored: { alert: composite.alert != null, eruption: composite.eruption != null, ashfall: composite.ashfall != null },
        });
      }
      // Runtime compatibility views can carry an identity-only v1 fallback
      // without polluting the enumerable generation-1 JSON shape.
      if ("eruptions" in state) {
        for (const eruption of state.eruptions) {
          if (this.composites.get(eruption.volcanoCode)?.eruption != null) continue;
          this.legacyEruptionIdentities.set(eruption.volcanoCode, {
            eventId: eruption.eventId,
            legacyV1Fallback: eruption.legacyV1Fallback === true,
          });
        }
      }
    } else {
      const legacy = state as LegacyPersistedVolcanoStateV2;
      for (const alert of legacy.alerts ?? []) {
        const reportTimeMs = Date.parse(alert.reportDateTime);
        const entry = this.ensureComposite(alert.volcanoCode, alert.volcanoName);
        if (entry == null) continue;
        entry.alert = {
          ...structuredClone(alert), sourceFamily: "operationalV2Unknown",
          revision: { reportTimeMs: Number.isSafeInteger(reportTimeMs) ? reportTimeMs : 0, serial: null },
          appliedSemanticKey: "holder:legacy-alert",
        };
        entry.restored.alert = true;
      }
      for (const eruption of legacy.eruptions ?? []) {
        this.legacyEruptionIdentities.set(eruption.volcanoCode, {
          eventId: eruption.eventId, legacyV1Fallback: eruption.legacyV1Fallback === true,
        });
      }
      for (const ashfall of legacy.ashfalls ?? []) {
        if (validateVolcanoAshfallProjection(ashfall) != null) continue;
        const entry = this.ensureComposite(ashfall.volcanoCode, ashfall.volcanoName);
        if (entry == null) continue;
        entry.ashfall = structuredClone(ashfall);
        entry.sourceEventIds = [ashfall.sourceEventId];
        entry.restored.ashfall = true;
      }
    }
    const sweep = this.sweep(nowMs);
    // A restore is one owner replacement even when its startup sweep removes
    // more than one slice.  Callers use this version as an atomicity token.
    this.ownerVersion = nextOwnerVersion;
    return { changed: true, expiredEruptionCodes: sweep.expiredEruptionCodes, expiredAshfallCodes: sweep.expiredAshfallCodes };
  }

  getPromptStatus(): PromptStatusSegment | null {
    const alerts = [...this.composites.values()].flatMap((entry) => entry.alert == null ? [] : [entry.alert]);
    if (alerts.length === 0) return null;
    const highest = alerts.reduce((best, entry) => (entry.alertLevel ?? 0) > (best.alertLevel ?? 0) ? entry : best);
    return { text: `${highest.volcanoName}${levelToLabel(highest.alertLevel)}`, role: levelToRole(highest.alertLevel), priority: 20 };
  }

  getDetail(): DetailSnapshotOf<"volcano"> | null {
    const entries = [...this.composites.values()].flatMap((entry) => entry.alert == null ? [] : [{
      volcanoName: entry.alert.volcanoName, alertLevel: entry.alert.alertLevel,
      alertLevelCode: entry.alert.alertLevelCode, warningKind: entry.alert.warningKind,
    }]);
    return entries.length === 0 ? null : { kind: "volcano", entries };
  }
}
