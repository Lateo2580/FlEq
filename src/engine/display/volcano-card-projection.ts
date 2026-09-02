import type { VolcanoAshfallProjectionV1 } from "../../types";
import type {
  ActiveStandbyCardV1,
  DisplayVolcanoAlertClassV1,
  DisplayVolcanoAshfallV1,
  DisplayVolcanoEntryV1,
  DisplayVolcanoEventV1,
  VolcanoHeaderToneV1,
} from "./protocol";
import {
  VOLCANO_ASHFALL_MAX_WIRE_SLICES,
  VOLCANO_CARD_MAX_WIRE_BYTES,
} from "./constants";
import type { StandbyRevision } from "./standby-registry";

export interface VolcanoCardProjectionState {
  code: string;
  name: string;
  alertLevel: number | null;
  alertClass: DisplayVolcanoAlertClassV1 | null;
  warningKind: string | null;
  targetKinds: string[];
  latestEvent: DisplayVolcanoEventV1 | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  alertRevision: StandbyRevision | null;
  eventRevision: StandbyRevision | null;
  alertRestored: boolean;
  eventRestored: boolean;
  ashfall: DisplayVolcanoAshfallV1 | null;
  ashfallExpiresAtMs: number | null;
  ashfallRevision: StandbyRevision | null;
  ashfallRestored: boolean;
}

export type VolcanoCardProjectionResult =
  | { kind: "empty" }
  | { kind: "card"; card: Extract<ActiveStandbyCardV1, { kind: "volcano" }> }
  | { kind: "overflow"; minimumBytes: number };

const TONE_RANK: Record<VolcanoHeaderToneV1, number> = {
  muted: 0,
  advisory: 1,
  warning: 2,
  red: 3,
  emergency: 4,
};

function compareCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function maximumTone(tones: readonly VolcanoHeaderToneV1[]): VolcanoHeaderToneV1 {
  return tones.reduce((maximum, tone) =>
    TONE_RANK[tone] > TONE_RANK[maximum] ? tone : maximum, "muted");
}

export function volcanoAlertTone(
  alertLevel: number | null,
  alertClass: DisplayVolcanoAlertClassV1 | null,
): VolcanoHeaderToneV1 {
  if (alertLevel === 5) return "emergency";
  if (alertLevel === 4) return "red";
  if (alertLevel === 3 || alertClass?.isActive === true && alertClass.severity === "warning") {
    return "warning";
  }
  if (alertLevel === 2) return "advisory";
  return "muted";
}

export function volcanoEruptionTone(event: DisplayVolcanoEventV1 | null): VolcanoHeaderToneV1 {
  if (event == null) return "muted";
  return event.label === "噴火速報" ? "red" : "advisory";
}

export function volcanoAshfallTone(ashfall: DisplayVolcanoAshfallV1 | null): VolcanoHeaderToneV1 {
  return ashfall?.kind === "rapid" ? "warning" : "muted";
}

export function displayVolcanoAshfall(
  projection: VolcanoAshfallProjectionV1,
): DisplayVolcanoAshfallV1 {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(projection.forecastEndsAtMs)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return {
    kind: projection.sourceType === "VFVO54" ? "rapid" : "detailed",
    label: projection.sourceType === "VFVO54" ? "降灰速報" : "降灰予報（詳細）",
    eventId: projection.eventId,
    sourceEventId: projection.sourceEventId,
    forecastEndsAt: new Date(projection.forecastEndsAtMs).toISOString(),
    forecastEndLabel: `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}まで`,
    groups: projection.groups.map((group) => ({
      hazardClass: group.hazardClass,
      ashCode: group.ashCode,
      ashName: group.ashName,
      areas: group.topAreas.map((area) => ({
        identityKey: area.identityKey,
        code: area.code,
        name: area.name,
        displayLabel: area.code == null ? area.name : `${area.name}（${area.code}）`,
      })),
      omittedAreaCount: group.omittedAreaCount,
    })),
    omittedGroupCount: projection.omittedGroupCount,
    generation: projection.generation,
  };
}

function independentlyVisible(state: VolcanoCardProjectionState): boolean {
  return state.alertLevel != null && state.alertLevel >= 4
    || state.alertClass?.isActive === true && state.alertClass.severity === "warning"
    || state.latestEvent != null && state.eventExpiresAtMs != null
    || state.ashfall != null && state.ashfallExpiresAtMs != null;
}

function buildEntry(
  state: VolcanoCardProjectionState,
  includeAshfall: boolean,
): DisplayVolcanoEntryV1 {
  return {
    code: state.code,
    name: state.name,
    alertLevel: state.alertLevel,
    alertClass: state.alertClass == null ? null : { ...state.alertClass },
    warningKind: state.warningKind,
    targetKinds: [...state.targetKinds],
    latestEvent: state.latestEvent == null ? null : structuredClone(state.latestEvent),
    ...(includeAshfall && state.ashfall != null
      ? { ashfall: structuredClone(state.ashfall) }
      : {}),
  };
}

function cardBytes(card: Extract<ActiveStandbyCardV1, { kind: "volcano" }>): number {
  return Buffer.byteLength(JSON.stringify(card), "utf8");
}

/**
 * Builds the sole volcano browser projection and applies the 64-slice/64-KiB
 * ashfall-detail fixpoint.  Canonical state and outer lineage are never pruned.
 */
export function projectVolcanoCard(
  source: readonly VolcanoCardProjectionState[],
): VolcanoCardProjectionResult {
  const states = source.filter(independentlyVisible)
    .sort((left, right) => compareCodeUnit(left.code, right.code));
  if (states.length === 0) return { kind: "empty" };

  const ashfallCandidates = states.filter((state) => state.ashfall != null)
    .sort((left, right) => {
      const leftRapid = left.ashfall?.kind === "rapid" ? 0 : 1;
      const rightRapid = right.ashfall?.kind === "rapid" ? 0 : 1;
      return leftRapid - rightRapid
        || (left.ashfallExpiresAtMs ?? 0) - (right.ashfallExpiresAtMs ?? 0)
        || (right.ashfallRevision?.reportTimeMs ?? 0) - (left.ashfallRevision?.reportTimeMs ?? 0)
        || compareCodeUnit(left.code, right.code);
    });
  const retained = new Set(ashfallCandidates
    .slice(0, VOLCANO_ASHFALL_MAX_WIRE_SLICES)
    .map((state) => state.code));
  const independentlyVisibleAlert = states.some((state) =>
    state.alertLevel != null && state.alertLevel >= 4
    || state.alertClass?.isActive === true && state.alertClass.severity === "warning");

  const makeCard = (): Extract<ActiveStandbyCardV1, { kind: "volcano" }> => {
    const omitted = ashfallCandidates.length - retained.size;
    const tone = maximumTone(states.flatMap((state) => [
      volcanoAlertTone(state.alertLevel, state.alertClass),
      volcanoEruptionTone(state.latestEvent),
      volcanoAshfallTone(state.ashfall),
    ]));
    const visibleRevisionTimes = states.flatMap((state) => [
      state.alertRevision?.reportTimeMs,
      state.eventRevision?.reportTimeMs,
      state.ashfallRevision?.reportTimeMs,
    ].filter((value): value is number => value != null));
    const expiryTimes = states.flatMap((state) => [
      state.eventExpiresAtMs,
      state.ashfallExpiresAtMs,
    ].filter((value): value is number => value != null));
    const sourceEventIds = [...new Set(states.flatMap((state) => state.sourceEventIds))]
      .sort(compareCodeUnit);
    return {
      kind: "volcano",
      surface: "corner-right",
      key: "volcano:active",
      sourceEventIds,
      updatedAt: new Date(Math.max(...visibleRevisionTimes)).toISOString(),
      expiresAt: independentlyVisibleAlert || expiryTimes.length === 0
        ? null
        : new Date(Math.max(...expiryTimes)).toISOString(),
      restored: states.some((state) =>
        state.alertRevision != null && state.alertRestored
        || state.eventRevision != null && state.eventRestored
        || state.ashfallRevision != null && state.ashfallRestored),
      severity: tone === "emergency" || tone === "red"
        ? "critical"
        : tone === "warning" || tone === "advisory"
          ? "warning"
          : "normal",
      data: {
        volcanoes: states.map((state) => buildEntry(state, retained.has(state.code))),
        headerTone: tone,
        ...(omitted === 0 ? {} : { ashfallOmittedCount: omitted }),
      },
    };
  };

  let card = makeCard();
  while (cardBytes(card) > VOLCANO_CARD_MAX_WIRE_BYTES && retained.size > 0) {
    const lowest = [...ashfallCandidates].reverse().find((state) => retained.has(state.code));
    if (lowest == null) break;
    retained.delete(lowest.code);
    card = makeCard();
  }
  const bytes = cardBytes(card);
  return bytes <= VOLCANO_CARD_MAX_WIRE_BYTES
    ? { kind: "card", card }
    : { kind: "overflow", minimumBytes: bytes };
}
