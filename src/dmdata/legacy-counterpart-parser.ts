import type {
  ParsedLegacyCounterpartInfo,
  LegacyCounterpartSourceType,
  WsDataMessage,
} from "../types";
import { requireTelegramMeta } from "./telegram-ingress";

/** Phase 6B の source type。counterpart の実在登録は characterization 後に行う。 */
export const LEGACY_COUNTERPART_SOURCE_TYPES = [
  "VPOA50",
  "VPNO50",
  "VXWW50",
] as const satisfies readonly LegacyCounterpartSourceType[];

/** 本文を読まずに header-only model を作るための、空の body extractor registry。 */
export const LEGACY_COUNTERPART_BODY_EXTRACTORS = [] as const;

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function isLegacyCounterpartSourceType(
  value: string,
): value is LegacyCounterpartSourceType {
  return (LEGACY_COUNTERPART_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * VPOA50／VPNO50／VXWW50 の最小 parser。
 *
 * 相関根拠になり得る本文 XML はこの段階では一切保持・推定しない。xmlReport が
 * 欠けた synthetic input でも、WsDataMessage の head と共通 TelegramMeta だけで
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
      areas: [],
      phenomena: [],
      kinds: [],
      severityEvidence: [],
      meta,
      isTest: meta.isTest,
    };
  } catch {
    // 本文 parse 失敗を握り潰すのではなく、header-only model の生成不能時だけ
    // 呼出側が既存 raw fallback を選べるよう null を返す。
    return null;
  }
}
