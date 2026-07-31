import { createJmxXmlParser, dig, str } from "./xml-shape";

export interface TelegramEnvelopeFields {
  control: {
    title: string;
    dateTime: string;
    status: string;
    editorialOffice: string;
    publishingOffice: string;
  };
  head: {
    title: string;
    reportDateTime: string;
    targetDateTime: string;
    eventId: string;
    serial: string;
    infoType: string;
    infoKind: string;
    infoKindVersion: string;
    headline: string;
  };
}

const envelopeParser = createJmxXmlParser();

function topLevelElement(xml: string, localName: "Control" | "Head"): string {
  const pattern = new RegExp(
    `<((?:[A-Za-z_][\\w.-]*:)?${localName})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
    "i",
  );
  return pattern.exec(xml)?.[0] ?? "";
}

/**
 * 巨大な Body を再 parse せず、Control／Head だけを共通 metadata 用に読む。
 */
export function parseTelegramEnvelopeXml(xml: string): TelegramEnvelopeFields {
  const controlXml = topLevelElement(xml, "Control");
  const headXml = topLevelElement(xml, "Head");
  const parsed = envelopeParser.parse(
    `<Report>${controlXml}${headXml}</Report>`,
  ) as unknown;
  const report = dig(parsed, "Report");
  const control = dig(report, "Control");
  const head = dig(report, "Head");
  return {
    control: {
      title: str(dig(control, "Title")),
      dateTime: str(dig(control, "DateTime")),
      status: str(dig(control, "Status")),
      editorialOffice: str(dig(control, "EditorialOffice")),
      publishingOffice: str(dig(control, "PublishingOffice")),
    },
    head: {
      title: str(dig(head, "Title")),
      reportDateTime: str(dig(head, "ReportDateTime")),
      targetDateTime: str(dig(head, "TargetDateTime")),
      eventId: str(dig(head, "EventID")),
      serial: str(dig(head, "Serial")),
      infoType: str(dig(head, "InfoType")),
      infoKind: str(dig(head, "InfoKind")),
      infoKindVersion: str(dig(head, "InfoKindVersion")),
      headline: str(dig(head, "Headline", "Text")),
    },
  };
}
