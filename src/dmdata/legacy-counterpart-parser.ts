import type {
  LegacyCounterpartCodeNamePair,
  LegacyCounterpartSeverity,
  LegacyCounterpartSeverityEvidence,
  ParsedLegacyCounterpartInfo,
  LegacyCounterpartSourceType,
  WsDataMessage,
} from "../types";
import { decodeTelegramBody } from "./telegram-body";
import { requireTelegramMeta } from "./telegram-ingress";
import { createJmxXmlParser, dig, listOf, nodeText, str } from "./xml-shape";

/** Phase 6B の source type。counterpart の実在登録は characterization 後に行う。 */
export const LEGACY_COUNTERPART_SOURCE_TYPES = [
  "VPOA50",
  "VPNO50",
  "VXWW50",
] as const satisfies readonly LegacyCounterpartSourceType[];

/** 実 XML 本文から選択項目を抽出する production extractor registry。 */
export const LEGACY_COUNTERPART_BODY_EXTRACTORS = ["VPOA50"] as const;

const VPOA_INFORMATION_TYPE = "記録的短時間大雨情報（発表細分）";
const VPOA_KIND_NAME = "記録的短時間大雨情報";
const VPNO_INFORMATION_TYPE = "気象特別警報報知（府県予報区等）";
const VPOA_ARRAY_TAGS = new Set([
  "Information",
  "Warning",
  "Item",
  "Kind",
  "Areas",
  "Area",
]);
const vpoaXmlParser = createJmxXmlParser((name) => VPOA_ARRAY_TAGS.has(name));

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function isLegacyCounterpartSourceType(
  value: string,
): value is LegacyCounterpartSourceType {
  return (LEGACY_COUNTERPART_SOURCE_TYPES as readonly string[]).includes(value);
}

type VpoaEvidenceSide = "head" | "body";

interface VpoaSideExtraction {
  source: VpoaEvidenceSide;
  present: boolean;
  validShape: boolean;
  areas: LegacyCounterpartCodeNamePair[];
  kinds: LegacyCounterpartCodeNamePair[];
  states: Array<string | null>;
}

function pairFromNode(node: unknown): LegacyCounterpartCodeNamePair | null {
  const name = nonBlank(str(dig(node, "Name")));
  const code = nonBlank(nodeText(dig(node, "Code")));
  return name == null || code == null ? null : { code, name };
}

function uniquePairs(
  pairs: readonly LegacyCounterpartCodeNamePair[],
): LegacyCounterpartCodeNamePair[] {
  const result: LegacyCounterpartCodeNamePair[] = [];
  for (const pair of pairs) {
    if (!result.some((existing) => existing.code === pair.code && existing.name === pair.name)) {
      result.push(pair);
    }
  }
  return result;
}

function codeSet(pairs: readonly LegacyCounterpartCodeNamePair[]): string[] {
  return [...new Set(pairs.map((pair) => pair.code))].sort();
}

function sameCodes(
  left: readonly LegacyCounterpartCodeNamePair[],
  right: readonly LegacyCounterpartCodeNamePair[],
): boolean {
  const leftCodes = codeSet(left);
  const rightCodes = codeSet(right);
  return leftCodes.length === rightCodes.length
    && leftCodes.every((code, index) => code === rightCodes[index]);
}

function extractVpoaSide(
  report: unknown,
  source: VpoaEvidenceSide,
): VpoaSideExtraction {
  const container = source === "head"
    ? dig(report, "Head", "Headline")
    : dig(report, "Body");
  const tag = source === "head" ? "Information" : "Warning";
  const candidates = listOf(dig(container, tag)).filter(
    (node) => str(dig(node, "@_type")) === VPOA_INFORMATION_TYPE,
  );
  const side: VpoaSideExtraction = {
    source,
    present: candidates.length > 0,
    validShape: candidates.length > 0,
    areas: [],
    kinds: [],
    states: [],
  };
  if (candidates.length === 0) return side;

  for (const candidate of candidates) {
    const items = listOf(dig(candidate, "Item"));
    if (items.length === 0) side.validShape = false;
    for (const item of items) {
      const kindNodes = listOf(dig(item, "Kind"));
      if (kindNodes.length === 0) side.validShape = false;
      for (const kind of kindNodes) {
        const pair = pairFromNode(kind);
        if (pair == null) side.validShape = false;
        else side.kinds.push(pair);
        const stateTag = source === "head" ? "Condition" : "Status";
        const state = nonBlank(str(dig(kind, stateTag)));
        side.states.push(state);
        if (state == null) side.validShape = false;
      }

      const areaContainers = source === "head"
        ? listOf(dig(item, "Areas"))
        : [item];
      const areaNodes = areaContainers.flatMap((areas) => listOf(dig(areas, "Area")));
      if (areaNodes.length === 0) side.validShape = false;
      for (const area of areaNodes) {
        const pair = pairFromNode(area);
        if (pair == null) side.validShape = false;
        else side.areas.push(pair);
      }
    }
  }
  return side;
}

function activeSide(side: VpoaSideExtraction): boolean {
  const kindCodes = codeSet(side.kinds);
  return side.present
    && side.validShape
    && kindCodes.length === 1
    && kindCodes[0] === "1"
    // VPOA50 の code 1 は単独では record-rain の根拠にならない。Kind.Name も
    // 電文仕様どおりの値であることを、Head/Body それぞれで確かめる。
    && side.kinds.length > 0
    && side.kinds.every((kind) => kind.name === VPOA_KIND_NAME)
    && side.states.length > 0
    && side.states.every((state) => state === "発表");
}

function sideEvidence(
  side: VpoaSideExtraction,
  infoType: string,
): LegacyCounterpartSeverityEvidence {
  const kindCodes = codeSet(side.kinds);
  const state = side.states.length === 1 ? side.states[0] : null;
  const recognizedInfoType = infoType === "発表" || infoType === "訂正";
  const severity: LegacyCounterpartSeverity = infoType === "取消"
    ? "unknown"
    : recognizedInfoType && activeSide(side)
      ? "high"
      : "unknown";
  return {
    source: side.source,
    severity,
    phenomenonCode: null,
    kindCode: kindCodes.length === 1 ? kindCodes[0] : null,
    levelCode: null,
    ...(side.source === "head" ? { condition: state } : { status: state }),
  };
}

interface VpoaExtraction {
  areas: LegacyCounterpartCodeNamePair[];
  kinds: LegacyCounterpartCodeNamePair[];
  severityEvidence: LegacyCounterpartSeverityEvidence[];
}

function extractVpoaEvidence(
  xml: string,
  infoType: string,
): VpoaExtraction {
  const parsed = vpoaXmlParser.parse(xml) as unknown;
  const report = dig(parsed, "Report") ?? dig(parsed, "jmx:Report");
  const head = extractVpoaSide(report, "head");
  const body = extractVpoaSide(report, "body");
  const consistent = activeSide(head)
    && activeSide(body)
    && sameCodes(head.kinds, body.kinds)
    && sameCodes(head.areas, body.areas);
  const severityEvidence = [
    ...(head.present ? [sideEvidence(head, infoType)] : []),
    ...(body.present ? [sideEvidence(body, infoType)] : []),
  ];
  if (!consistent) {
    for (const evidence of severityEvidence) evidence.severity = "unknown";
  }
  return {
    areas: uniquePairs([...head.areas, ...body.areas]),
    kinds: uniquePairs([...head.kinds, ...body.kinds]),
    severityEvidence,
  };
}

/**
 * VPNO50 は本文を持たず、Headline の府県予報区レイヤだけが特別警報の切替対象を
 * 権威的に示す。より細かい区域を混ぜると VPWW55 の府県 stream と対応しなくなるため、
 * この type に限定して抽出する。
 */
function extractVpnoEvidence(xml: string): Pick<VpoaExtraction, "areas" | "kinds"> {
  const parsed = vpoaXmlParser.parse(xml) as unknown;
  const report = dig(parsed, "Report") ?? dig(parsed, "jmx:Report");
  const candidates = listOf(dig(report, "Head", "Headline", "Information")).filter(
    (node) => str(dig(node, "@_type")) === VPNO_INFORMATION_TYPE,
  );
  const areas: LegacyCounterpartCodeNamePair[] = [];
  const kinds: LegacyCounterpartCodeNamePair[] = [];
  for (const candidate of candidates) {
    for (const item of listOf(dig(candidate, "Item"))) {
      for (const kind of listOf(dig(item, "Kind"))) {
        const pair = pairFromNode(kind);
        if (pair != null) kinds.push(pair);
      }
      for (const areasNode of listOf(dig(item, "Areas"))) {
        for (const area of listOf(dig(areasNode, "Area"))) {
          const pair = pairFromNode(area);
          if (pair != null) areas.push(pair);
        }
      }
    }
  }
  return { areas: uniquePairs(areas), kinds: uniquePairs(kinds) };
}

/**
 * VPOA50／VPNO50／VXWW50 の parser。
 *
 * VPOA50 だけは raw XML の Headline.Information と Body.Warning の選択項目を
 * 抽出する。本文 XML や wire payload 自体は parsed model に保持しない。xmlReport
 * が欠けた synthetic input でも、WsDataMessage の head と共通 TelegramMeta だけで
 * fail-open 表示へ進める。
 */
export function parseLegacyCounterpart(
  msg: WsDataMessage,
): ParsedLegacyCounterpartInfo | null {
  if (!isLegacyCounterpartSourceType(msg.head.type)) return null;

  try {
    const meta = requireTelegramMeta(msg);
    const report = msg.xmlReport;
    const reportHead = report?.head;
    const control = report?.control;

    const type = msg.head.type;
    const title = nonBlank(reportHead?.title)
      ?? nonBlank(control?.title)
      ?? type;
    const infoType = nonBlank(reportHead?.infoType)
      ?? nonBlank(meta.infoType.raw)
      ?? "不明";
    const controlTitle = nonBlank(control?.title) ?? title;
    const reportDateTime = nonBlank(reportHead?.reportDateTime)
      ?? nonBlank(meta.reportDateTime.raw)
      ?? msg.head.time;
    const headline = nonBlank(reportHead?.headline);
    const publishingOffice = nonBlank(control?.publishingOffice)
      ?? nonBlank(msg.head.author)
      ?? "不明";
    const editorialOffice = nonBlank(control?.editorialOffice) ?? "";
    const eventId = meta.eventId.valid ? nonBlank(meta.eventId.value) : null;
    const serial = nonBlank(reportHead?.serial)
      ?? nonBlank(meta.serial.raw);

    let extracted: VpoaExtraction = {
      areas: [],
      kinds: [],
      severityEvidence: [],
    };
    if (type === "VPOA50") {
      try {
        extracted = extractVpoaEvidence(decodeTelegramBody(msg), infoType);
      } catch {
        // 本文の decode／shape 異常は raw XML evidence を欠落扱いにし、
        // header model の fail-open 表示は維持する。
      }
    } else if (type === "VPNO50") {
      try {
        const vpno = extractVpnoEvidence(decodeTelegramBody(msg));
        extracted = { ...extracted, ...vpno };
      } catch {
        // VPNO50 の抽出不能は state を変えず、従来どおり header-only 表示へ縮退する。
      }
    }

    return {
      type,
      infoType,
      title,
      controlTitle,
      reportDateTime,
      headline,
      publishingOffice,
      editorialOffice,
      eventId,
      serial,
      areas: extracted.areas,
      phenomena: [],
      kinds: extracted.kinds,
      severityEvidence: extracted.severityEvidence,
      meta,
      isTest: meta.isTest,
    };
  } catch {
    // 本文 parse 失敗を握り潰すのではなく、header-only model の生成不能時だけ
    // 呼出側が既存 raw fallback を選べるよう null を返す。
    return null;
  }
}
