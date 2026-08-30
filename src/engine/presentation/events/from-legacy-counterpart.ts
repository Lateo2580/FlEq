import type {
  LegacyCounterpartCodeNamePair,
  ParsedLegacyCounterpartInfo,
} from "../../../types";
import type {
  LegacyCounterpartOutcome,
  PresentationAreaItem,
  PresentationEvent,
} from "../types";

/** EventID が確定できない legacy counterpart は受信 messageId 単位で表示を分ける。 */
export function legacyCounterpartIdentity(
  info: ParsedLegacyCounterpartInfo,
  messageId: string,
): string {
  const eventId = info.meta.eventId.valid ? info.meta.eventId.value?.trim() : null;
  return eventId != null && eventId !== ""
    ? `legacy:${info.type}:${eventId}`
    : `legacy:${info.type}:${messageId}`;
}

function toAreaItems(pairs: LegacyCounterpartCodeNamePair[], kind: string): PresentationAreaItem[] {
  return pairs.map((pair) => ({
    name: pair.name,
    code: pair.code,
    kind,
  }));
}

/** Legacy counterpart の parsed model だけを PresentationEvent へ射影する。 */
export function fromLegacyCounterpartOutcome(
  outcome: LegacyCounterpartOutcome,
): PresentationEvent {
  const info = outcome.parsed;
  const areaItems = toAreaItems(info.areas, "対象地域");
  const identity = legacyCounterpartIdentity(info, outcome.msg.id);

  return {
    id: identity,
    classification: outcome.msg.classification,
    domain: outcome.domain,
    type: info.type,

    infoType: info.infoType,
    title: info.title,
    controlTitle: info.controlTitle,
    headline: info.headline,
    reportDateTime: info.reportDateTime,
    publishingOffice: info.publishingOffice,
    isTest: info.isTest,

    legacyReason: outcome.reason,
    legacySeverity: outcome.severity,

    frameLevel: outcome.presentation.frameLevel,
    soundLevel: outcome.presentation.soundLevel,
    notifyCategory: outcome.presentation.notifyCategory,
    foundationMutationAccepted: outcome.presentation.foundationMutationAccepted,
    weatherConfidence: outcome.presentation.weatherDiff?.confidence ?? "confirmed",
    weatherDiff: outcome.presentation.weatherDiff,
    weatherChangeDiff: outcome.presentation.weatherChangeDiff,
    weatherStateMutationAccepted: outcome.presentation.weatherStateMutationAccepted,

    isCancellation: info.infoType === "取消",
    isWarning: false,

    eventId: info.eventId,
    serial: info.serial,

    areaNames: info.areas.map((pair) => pair.name),
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: info.areas.length,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems,

    legacyAreas: info.areas,
    legacyPhenomena: info.phenomena,
    legacyKinds: info.kinds,
    raw: info,
  };
}
