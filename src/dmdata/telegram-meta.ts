import type {
  RevisionRelation,
  StrictDateTimeMeta,
  StrictInfoTypeMeta,
  StrictTextMeta,
  TelegramInfoTypeValue,
  TelegramMeta,
  TelegramRevision,
  TelegramRevisionComparisonInput,
  TelegramSerial,
} from "../types";

export const FUTURE_REPORT_DATETIME_SKEW_MS = 15 * 60_000;

const INFO_TYPES = new Set<TelegramInfoTypeValue>(["発表", "訂正", "取消"]);
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export interface TelegramMetaInput {
  messageId: string;
  eventId: string | null;
  type: string | null;
  reportDateTime: string | null;
  serial: string | null;
  infoType: string | null;
  receivedAtMs: number;
  status: string | null;
  isTest: boolean;
}

export type TelegramRevisionComparator =
  | "reportDateTimeThenSerial"
  | "serialOnly";

export function parseStrictText(raw: string | null): StrictTextMeta {
  if (raw == null) return { raw: null, value: null, valid: false };
  const value = raw.trim();
  return {
    raw,
    value: value === "" ? null : value,
    valid: value !== "",
  };
}

export function parseTelegramSerial(raw: string | null): TelegramSerial {
  if (raw == null || !/^\d+$/.test(raw)) {
    return { raw, numeric: null, valid: false };
  }
  const numeric = Number(raw);
  return Number.isSafeInteger(numeric)
    ? { raw, numeric, valid: true }
    : { raw, numeric: null, valid: false };
}

export function parseStrictInfoType(raw: string | null): StrictInfoTypeMeta {
  if (raw == null) return { raw: null, value: null, valid: false };
  const candidate = raw.trim();
  const value = INFO_TYPES.has(candidate as TelegramInfoTypeValue)
    ? candidate as TelegramInfoTypeValue
    : null;
  return { raw, value, valid: value != null };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseIsoEpoch(raw: string): number | null {
  const match = ISO_DATE_TIME_PATTERN.exec(raw);
  if (match == null) return null;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw, zone, sign, offsetHourRaw, offsetMinuteRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const millisecond = Number((fractionRaw ?? "").padEnd(3, "0"));
  const offsetHour = Number(offsetHourRaw ?? "0");
  const offsetMinute = Number(offsetMinuteRaw ?? "0");
  if (
    year < 1000
    || month < 1 || month > 12
    || day < 1 || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) return null;
  const offsetSign = zone === "Z" ? 0 : sign === "+" ? 1 : -1;
  const offsetMs = offsetSign * (offsetHour * 60 + offsetMinute) * 60_000;
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offsetMs;
  return Number.isFinite(epochMs) ? epochMs : null;
}

export function parseStrictReportDateTime(
  raw: string | null,
  receivedAtMs: number,
): StrictDateTimeMeta {
  if (raw == null) return { raw: null, epochMs: null, valid: false };
  const epochMs = parseIsoEpoch(raw);
  if (
    epochMs == null
    || !Number.isFinite(receivedAtMs)
    || epochMs > receivedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS
  ) {
    return { raw, epochMs: null, valid: false };
  }
  return { raw, epochMs, valid: true };
}

export function createTelegramMeta(input: TelegramMetaInput): TelegramMeta {
  return {
    messageId: input.messageId,
    eventId: parseStrictText(input.eventId),
    type: parseStrictText(input.type),
    reportDateTime: parseStrictReportDateTime(input.reportDateTime, input.receivedAtMs),
    serial: parseTelegramSerial(input.serial),
    infoType: parseStrictInfoType(input.infoType),
    receivedAtMs: input.receivedAtMs,
    status: input.status,
    isTest: input.isTest,
  };
}

export function telegramRevision(meta: TelegramMeta): TelegramRevision {
  return {
    eventId: meta.eventId,
    type: meta.type,
    reportDateTime: meta.reportDateTime,
    serial: meta.serial,
    infoType: meta.infoType,
  };
}

function relationFromNumbers(a: number, b: number): RevisionRelation {
  return a > b ? "newer" : a < b ? "older" : "equal";
}

export function compareTelegramRevisions(
  incoming: TelegramRevisionComparisonInput,
  current: TelegramRevisionComparisonInput,
  comparator: TelegramRevisionComparator = "reportDateTimeThenSerial",
): RevisionRelation {
  if (
    !incoming.revision.eventId.valid
    || !current.revision.eventId.valid
    || incoming.revision.eventId.value == null
    || current.revision.eventId.value == null
    || incoming.revision.eventId.value !== current.revision.eventId.value
    || !incoming.revision.type.valid
    || !current.revision.type.valid
    || incoming.revision.type.value == null
    || current.revision.type.value == null
    || incoming.revision.type.value !== current.revision.type.value
    || incoming.stateSubjectKey == null
    || current.stateSubjectKey == null
    || incoming.stateSubjectKey === ""
    || current.stateSubjectKey === ""
    || incoming.stateSubjectKey !== current.stateSubjectKey
  ) return "unordered";

  const incomingRevision = incoming.revision;
  const currentRevision = current.revision;
  if (
    !incomingRevision.reportDateTime.valid
    || !currentRevision.reportDateTime.valid
    || incomingRevision.reportDateTime.epochMs == null
    || currentRevision.reportDateTime.epochMs == null
  ) return "unordered";

  if (comparator === "reportDateTimeThenSerial") {
    const dateRelation = relationFromNumbers(
      incomingRevision.reportDateTime.epochMs,
      currentRevision.reportDateTime.epochMs,
    );
    if (dateRelation !== "equal") return dateRelation;
  }

  if (
    !incomingRevision.serial.valid
    || !currentRevision.serial.valid
    || incomingRevision.serial.numeric == null
    || currentRevision.serial.numeric == null
  ) return "unordered";
  return relationFromNumbers(
    incomingRevision.serial.numeric,
    currentRevision.serial.numeric,
  );
}
