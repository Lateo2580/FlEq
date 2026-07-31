import type { TelegramMeta, WsDataMessage } from "../types";
import { decodeTelegramBody } from "./telegram-body";
import { parseTelegramEnvelopeXml } from "./telegram-envelope";
import { createTelegramMeta, deriveIsTest } from "./telegram-meta";

export interface TelegramIngressDiagnostics {
  testMetadataMismatch: boolean;
  headTest: boolean | null;
  envelopeControlStatus: string | null;
  rawControlStatus: string | null;
}

export interface NormalizedTelegramMessage {
  message: WsDataMessage;
  diagnostics: TelegramIngressDiagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function matchesStrictText(
  actual: unknown,
  expected: TelegramMeta["eventId"],
): boolean {
  return isRecord(actual)
    && actual["raw"] === expected.raw
    && actual["value"] === expected.value
    && actual["valid"] === expected.valid;
}

function matchesStrictDateTime(
  actual: unknown,
  expected: TelegramMeta["reportDateTime"],
): boolean {
  return isRecord(actual)
    && actual["raw"] === expected.raw
    && actual["epochMs"] === expected.epochMs
    && actual["valid"] === expected.valid;
}

function matchesSerial(
  actual: unknown,
  expected: TelegramMeta["serial"],
): boolean {
  return isRecord(actual)
    && actual["raw"] === expected.raw
    && actual["numeric"] === expected.numeric
    && actual["valid"] === expected.valid;
}

function matchesInfoType(
  actual: unknown,
  expected: TelegramMeta["infoType"],
): boolean {
  return isRecord(actual)
    && actual["raw"] === expected.raw
    && actual["value"] === expected.value
    && actual["valid"] === expected.valid;
}

function validTelegramMetaForMessage(
  value: unknown,
  msg: WsDataMessage,
  expected?: {
    status: string | null;
    isTest: boolean;
  },
): value is TelegramMeta {
  if (!isRecord(value)) return false;
  const eventId = value["eventId"];
  const type = value["type"];
  const reportDateTime = value["reportDateTime"];
  const serial = value["serial"];
  const infoType = value["infoType"];
  if (
    !isRecord(eventId)
    || !isNullableString(eventId["raw"])
    || !isRecord(type)
    || !isNullableString(type["raw"])
    || !isRecord(reportDateTime)
    || !isNullableString(reportDateTime["raw"])
    || !isRecord(serial)
    || !isNullableString(serial["raw"])
    || !isRecord(infoType)
    || !isNullableString(infoType["raw"])
    || typeof value["messageId"] !== "string"
    || typeof value["receivedAtMs"] !== "number"
    || !Number.isFinite(value["receivedAtMs"])
    || !isNullableString(value["status"])
    || typeof value["isTest"] !== "boolean"
  ) {
    return false;
  }

  const canonical = createTelegramMeta({
    messageId: value["messageId"],
    eventId: eventId["raw"],
    type: type["raw"],
    reportDateTime: reportDateTime["raw"],
    serial: serial["raw"],
    infoType: infoType["raw"],
    receivedAtMs: value["receivedAtMs"],
    status: value["status"],
    isTest: value["isTest"],
  });
  return canonical.messageId === msg.id
    && (expected == null || (
      canonical.status === expected.status
      && canonical.isTest === expected.isTest
    ))
    && canonical.eventId.raw === (msg.xmlReport?.head.eventId ?? null)
    && canonical.type.raw === msg.head.type
    && canonical.reportDateTime.raw
      === (msg.xmlReport?.head.reportDateTime ?? null)
    && canonical.serial.raw === (msg.xmlReport?.head.serial ?? null)
    && canonical.infoType.raw === (msg.xmlReport?.head.infoType ?? null)
    && matchesStrictText(eventId, canonical.eventId)
    && matchesStrictText(type, canonical.type)
    && matchesStrictDateTime(reportDateTime, canonical.reportDateTime)
    && matchesSerial(serial, canonical.serial)
    && matchesInfoType(infoType, canonical.infoType);
}

function rawControlStatus(msg: WsDataMessage): string | null {
  if (msg.format !== "xml") return null;
  try {
    const value = parseTelegramEnvelopeXml(decodeTelegramBody(msg)).control.status;
    return value === "" ? null : value;
  } catch {
    // 本文 decode/parse の診断は各 parser の既存経路へ任せる。
    return null;
  }
}

function normalizedStatus(value: string | null): string | null {
  if (value == null) return null;
  const normalized = value.trim();
  return normalized === "" ? null : normalized;
}

function hasTestMetadataMismatch(input: {
  headTest: boolean | null;
  envelopeControlStatus: string | null;
  rawControlStatus: string | null;
}): boolean {
  const envelopeStatus = normalizedStatus(input.envelopeControlStatus);
  const rawStatus = normalizedStatus(input.rawControlStatus);
  if (envelopeStatus != null && rawStatus != null && envelopeStatus !== rawStatus) {
    return true;
  }

  const claims: boolean[] = [];
  if (input.headTest != null) claims.push(input.headTest);
  if (envelopeStatus != null) {
    claims.push(deriveIsTest({ headTest: null, controlStatus: envelopeStatus }));
  }
  if (rawStatus != null) {
    claims.push(deriveIsTest({ headTest: null, controlStatus: rawStatus }));
  }
  return claims.some((claim) => claim !== claims[0]);
}

export function normalizeTelegramMessage(
  msg: WsDataMessage,
  receivedAtMs?: number,
): NormalizedTelegramMessage {
  const headTest = typeof msg.head.test === "boolean" ? msg.head.test : null;
  const envelopeControlStatus =
    typeof msg.xmlReport?.control?.status === "string"
      ? msg.xmlReport.control.status
      : null;
  const xmlControlStatus = rawControlStatus(msg);
  const isTest =
    deriveIsTest({ headTest, controlStatus: envelopeControlStatus })
    || deriveIsTest({ headTest: null, controlStatus: xmlControlStatus });
  const diagnostics: TelegramIngressDiagnostics = {
    testMetadataMismatch: hasTestMetadataMismatch({
      headTest,
      envelopeControlStatus,
      rawControlStatus: xmlControlStatus,
    }),
    headTest,
    envelopeControlStatus,
    rawControlStatus: xmlControlStatus,
  };
  if (validTelegramMetaForMessage(msg.meta, msg, {
    status: xmlControlStatus ?? envelopeControlStatus,
    isTest,
  })) {
    return { message: msg, diagnostics };
  }

  return {
    message: {
      ...msg,
      meta: createTelegramMeta({
        messageId: msg.id,
        eventId: msg.xmlReport?.head.eventId ?? null,
        type: msg.head.type,
        reportDateTime: msg.xmlReport?.head.reportDateTime ?? null,
        serial: msg.xmlReport?.head.serial ?? null,
        infoType: msg.xmlReport?.head.infoType ?? null,
        receivedAtMs: receivedAtMs ?? Date.now(),
        status: xmlControlStatus ?? envelopeControlStatus,
        isTest,
      }),
    },
    diagnostics,
  };
}

export function requireTelegramMeta(msg: WsDataMessage): TelegramMeta {
  // parser 直接利用の既存 adapter と unit test も、3 判定源を含む
  // normalizeTelegramMessage の完全な意味検証へ収束させる。
  return normalizeTelegramMessage(msg).message.meta!;
}
