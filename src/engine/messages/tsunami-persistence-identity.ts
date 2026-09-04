import type { ParsedTsunamiInfo, TelegramRevision } from "../../types";
import type { PersistedTelegramRevisionGateEntryV2 } from "./telegram-revision-gate";
import { tsunamiStateSubjectKey } from "./revision-family-registry";

export type TsunamiRevisionRelation = "newer" | "equal" | "older" | "unordered";

function serialMissing(revision: TelegramRevision): boolean {
  return revision.serial.raw == null || revision.serial.raw === "";
}

/** VTSE41 policy の missing-Serial 規則を含む canonical revision comparator。 */
export function compareTsunamiRevisionIdentity(
  incoming: TelegramRevision,
  current: TelegramRevision,
): TsunamiRevisionRelation {
  const incomingMs = incoming.reportDateTime.epochMs;
  const currentMs = current.reportDateTime.epochMs;
  if (
    !incoming.reportDateTime.valid
    || !current.reportDateTime.valid
    || incomingMs == null
    || currentMs == null
  ) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = serialMissing(incoming);
  const currentMissing = serialMissing(current);
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  if (
    !incoming.serial.valid
    || !current.serial.valid
    || incoming.serial.numeric == null
    || current.serial.numeric == null
  ) return "unordered";
  if (incoming.serial.numeric === current.serial.numeric) return "equal";
  return incoming.serial.numeric > current.serial.numeric ? "newer" : "older";
}

export function tsunamiInfoTypePrecedence(
  infoType: TelegramRevision["infoType"]["value"],
): 0 | 1 | 2 {
  switch (infoType) {
    case "取消": return 2;
    case "訂正": return 1;
    default: return 0;
  }
}

/** canonical holder payload と persisted VTSE41 gate watermark の結合規則。 */
export function tsunamiActiveMatchesGate(
  active: ParsedTsunamiInfo,
  gateEntry: PersistedTelegramRevisionGateEntryV2,
): boolean {
  if (active.meta.infoType.value === "取消") return false;
  const exactSubject = gateEntry.stateSubjectKey === tsunamiStateSubjectKey(active.meta);
  const subjectMatches = exactSubject || gateEntry.stateSubjectKey === "tsunami:current";
  const relation = compareTsunamiRevisionIdentity(
    gateEntry.comparison.revision,
    active.meta,
  );
  const sameRevision = relation === "equal"
    && gateEntry.comparison.revision.reportDateTime.raw === active.meta.reportDateTime.raw
    && gateEntry.comparison.revision.serial.raw === active.meta.serial.raw
    && gateEntry.comparison.revision.infoType.value === active.meta.infoType.value;
  const retainedActivePrecedesWatermark = exactSubject
    && !gateEntry.cancelled
    && (relation === "equal" || relation === "newer");
  return gateEntry.domain === "tsunami"
    && gateEntry.revisionFamily === "VTSE41"
    && subjectMatches
    && (sameRevision || retainedActivePrecedesWatermark);
}
