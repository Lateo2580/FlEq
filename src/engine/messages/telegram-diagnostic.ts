import type {
  TelegramDateDiagnosticReason,
} from "../../dmdata/telegram-meta";
import { telegramDateFutureSkewMs } from "../../dmdata/telegram-meta";
import type { TelegramMeta, WsDataMessage } from "../../types";
import type { PresentationEvent } from "../presentation/types";

export interface TelegramDateDiagnostic {
  kind: TelegramDateDiagnosticReason;
  messageId: string;
  type: string;
  eventId: string | null;
  reportDateTimeRaw: string | null;
  receivedAtMs: number;
  receivedAtIso: string;
  futureSkewMs: number | null;
}

export function telegramDateDiagnostic(
  msg: WsDataMessage,
  meta: TelegramMeta,
  kind: TelegramDateDiagnosticReason,
): TelegramDateDiagnostic {
  return {
    kind,
    messageId: msg.id,
    type: meta.type.value ?? msg.head.type,
    eventId: meta.eventId.value,
    reportDateTimeRaw: meta.reportDateTime.raw,
    receivedAtMs: meta.receivedAtMs,
    receivedAtIso: Number.isFinite(meta.receivedAtMs)
      ? new Date(meta.receivedAtMs).toISOString()
      : "不正",
    futureSkewMs: kind === "futureSkewExceeded"
      ? telegramDateFutureSkewMs(meta)
      : null,
  };
}

export function telegramDateDiagnosticText(
  diagnostic: TelegramDateDiagnostic,
): string {
  const reason = diagnostic.kind === "futureSkewExceeded"
    ? "未来時刻が許容範囲を超過"
    : "日時を解釈できない";
  const fields = [
    `${diagnostic.type} / 日時不正`,
    `EventID: ${diagnostic.eventId ?? "欠落"}`,
    `ReportDateTime(raw): ${diagnostic.reportDateTimeRaw ?? "欠落"}`,
    `受信時刻: ${diagnostic.receivedAtIso}`,
    `理由: ${reason}`,
  ];
  if (diagnostic.futureSkewMs != null) {
    fields.push(`未来差分: ${diagnostic.futureSkewMs} ms`);
  }
  return fields.join(" / ");
}

export function dateDiagnosticPresentationEvent(
  msg: WsDataMessage,
  diagnostic: TelegramDateDiagnostic,
): PresentationEvent {
  const text = telegramDateDiagnosticText(diagnostic);
  return {
    id: `diagnostic:${diagnostic.messageId}`,
    classification: msg.classification,
    domain: "raw",
    type: diagnostic.type,
    diagnosticKind: diagnostic.kind,
    infoType: msg.xmlReport?.head.infoType ?? "不明",
    title: "電文日時診断",
    headline: text,
    reportDateTime: diagnostic.reportDateTimeRaw ?? "",
    publishingOffice:
      msg.xmlReport?.control.publishingOffice ?? msg.head.author,
    isTest: msg.meta?.isTest ?? msg.head.test,
    frameLevel: "info",
    soundLevel: "info",
    isCancellation: false,
    eventId: diagnostic.eventId,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    bodyText: text,
    raw: null,
  };
}
