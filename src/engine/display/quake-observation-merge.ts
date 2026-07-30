import type {
  DisplayLatestQuakeInputV1,
  DisplayLatestQuakeStateV1,
  DisplayRecentQuakeV1,
} from "./types";

interface QuakeObservationCandidate {
  eventId: string | null;
  maxInt: string | null;
}

function shouldPreserveObservation(
  previous: QuakeObservationCandidate | null | undefined,
  next: QuakeObservationCandidate,
): previous is QuakeObservationCandidate {
  return previous != null
    && previous.eventId != null
    && previous.eventId === next.eventId
    && previous.maxInt != null
    && next.maxInt == null;
}

/** 同一地震の震度なし続報では観測済み震度だけを保持し、震源諸元は続報を採用する。 */
export function mergeLatestQuakeObservation(
  previous: DisplayLatestQuakeStateV1 | null,
  next: DisplayLatestQuakeInputV1,
): DisplayLatestQuakeInputV1 {
  if (!shouldPreserveObservation(previous, next)) return next;
  return {
    ...next,
    maxInt: previous.maxInt,
    maxIntRank: previous.maxIntRank,
    intensityGroups: previous.intensityGroups,
  };
}

/** DailyQuakeCounter と store 内履歴で共有する、同一地震の震度保持マージ。 */
export function mergeRecentQuakeObservation(
  previous: DisplayRecentQuakeV1 | null | undefined,
  next: DisplayRecentQuakeV1,
): DisplayRecentQuakeV1 {
  if (!shouldPreserveObservation(previous, next)) return next;
  return {
    ...next,
    maxInt: previous.maxInt,
    maxIntRank: previous.maxIntRank,
    intensityGroups: previous.intensityGroups,
  };
}
