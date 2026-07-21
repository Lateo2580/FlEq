import type {
  FloodHeadline,
  FloodInfoScope,
  FloodKindCode,
  FloodReportSchema,
  ParsedFloodForecastInfo,
  WsDataMessage,
} from "../types";
import { decodeBody, dig, str } from "./telegram-parser";
import { listOf } from "./timeseries-common";
import { createJmxXmlParser } from "./xml-shape";
import * as log from "../logger";
import { parseStationsAndAggregate } from "./flood-station-parser";
import { parseInundationAreas } from "./flood-inundation-parser";
import { parseRainfallSummaries } from "./flood-rainfall-parser";
import { parseFloodAssumptions } from "./flood-assumption-parser";
import { parseVxsuStubStations } from "./flood-vxsu-stub-parser";

/**
 * 洪水・水位系電文 (VXKO50-89 / VXSU50-59) 用 XML パーサ entry。
 *
 * - VXKO50 系: 指定河川洪水予報
 * - VXSU50 系: 水位周知河川に関する情報
 *
 * 既存 parser pattern (`heat-alert-parser.ts:79-132`, `weather-warning-timeseries-parser.ts:59-67`)
 * に整合: `decodeBody(msg)` + `fast-xml-parser` で抽象構文木を取得し、
 * `dig` / `str` (telegram-parser.ts) と `listOf` / `nodeText` (timeseries-common.ts)
 * で `unknown` walk する。`any` は使用しない。
 *
 * namespace 規約: 既存 parser に倣い `jmx_eb:WaterLevel` のような
 * prefix 付きキーで直接アクセスする (`removeNSPrefix` は使用しない)。
 *
 * 構成 (2026-06-16 Phase 2 分割):
 *
 * | ファイル | 責務 |
 * |---|---|
 * | `flood-forecast-parser.ts` (本ファイル) | 公開 entry + Control/Head + Headline + XML/ARRAY_TAGS 定義 |
 * | `flood-shared.ts` | 共有 helper (TimeDefine / Criteria / 観測レベル / Headline kind 解決 / mainItemCode/Hash) |
 * | `flood-station-parser.ts` | VXKO 観測所集約 (`parseStationsAndAggregate`) |
 * | `flood-inundation-parser.ts` | 浸水想定地区 (`parseInundationAreas`) |
 * | `flood-rainfall-parser.ts` | 雨量予測 (`parseRainfallSummaries`) |
 * | `flood-assumption-parser.ts` | 氾濫水予報 (`parseFloodAssumptions`) |
 * | `flood-vxsu-stub-parser.ts` | VXSU stub 観測所 (`parseVxsuStubStations`) |
 */
const xmlParser = createJmxXmlParser((name) => {
  // 系列ローカル/集約で配列扱いとするタグ。
  // Task 10 以降で Headline.Information / Warning.Item / MeteorologicalInfos など
  // を順次集計するため、構造的に複数化しうるタグを早期に列挙する。
  return ARRAY_TAGS.has(name);
});

/** kindCode 文字列を `FloodKindCode` に narrowing。未知は "unknown"。 */
const KNOWN_KIND_CODES: ReadonlySet<string> = new Set([
  "10",
  "20",
  "21",
  "30",
  "31",
  "40",
  "41",
  "51",
  "53",
]);

function toFloodKindCode(raw: string): FloodKindCode {
  return KNOWN_KIND_CODES.has(raw) ? (raw as FloodKindCode) : "unknown";
}

/**
 * Information.@_type ラベル (例: "指定河川洪水予報（河川）") から
 * 括弧内の scope ラベル ("河川") を抽出する。
 * 全角・半角どちらの括弧にも対応。
 * 既知 4 種類以外は "unknown"。
 */
function extractScope(rawLabel: string): {
  scope: FloodInfoScope;
  rawScopeLabel: string;
} {
  const match =
    /（(.+?)）/.exec(rawLabel) ?? /\((.+?)\)/.exec(rawLabel);
  if (match == null) return { scope: "unknown", rawScopeLabel: rawLabel };
  const inner = match[1].trim();
  const map: Record<string, FloodInfoScope> = {
    予報区域: "予報区域",
    河川: "河川",
    府県予報区等: "府県予報区等",
    発表区間: "発表区間",
  };
  return { scope: map[inner] ?? "unknown", rawScopeLabel: rawLabel };
}

/**
 * Head.Headline ノードから `FloodHeadline[]` を構築する。
 *
 * 構造:
 *   <Headline>
 *     <Text>...見出し文...</Text>
 *     <Information type="...（河川）">
 *       <Item>
 *         <Kind><Name/><Code/><Condition/></Kind>
 *         <Areas codeType=""><Area><Name/><Code/></Area>...</Areas>
 *       </Item>
 *       <Item>... (複数あり得る)</Item>
 *     </Information>
 *     <Information>... (複数あり得る)</Information>
 *   </Headline>
 *
 * 各 Information × Item で 1 件の `FloodHeadline` を生成する。
 * Information / Item / Area は単一/配列両対応 (`listOf` で正規化)。
 */
function parseHeadlines(headlineNode: unknown): FloodHeadline[] {
  if (headlineNode == null) return [];
  const headlineText = str(dig(headlineNode, "Text"));
  const informations = listOf(dig(headlineNode, "Information"));
  const result: FloodHeadline[] = [];
  for (const info of informations) {
    if (info == null) continue;
    const rawLabel = str(dig(info, "@_type"));
    const { scope, rawScopeLabel } = extractScope(rawLabel);
    const items = listOf(dig(info, "Item"));
    for (const item of items) {
      if (item == null) continue;
      // Kind は ARRAY_TAGS に含まれるため配列化される。Headline 直下の
      // Item は通常 Kind 1 件なので先頭を採用する。
      const kindNode = listOf(dig(item, "Kind"))[0];
      const kindName = str(dig(kindNode, "Name"));
      const kindCodeRaw = str(dig(kindNode, "Code"));
      const kindCode = toFloodKindCode(kindCodeRaw);
      const condition = str(dig(kindNode, "Condition"));
      // Areas も配列化される。Item に Areas が複数くるケースは仕様外なので
      // 先頭を採用する。
      const areasNode = listOf(dig(item, "Areas"))[0];
      const areaList = listOf(dig(areasNode, "Area"));
      const areas = areaList
        .filter((a): a is unknown => a != null)
        .map((a) => ({
          name: str(dig(a, "Name")),
          code: str(dig(a, "Code")),
        }));
      result.push({
        scope,
        rawScopeLabel,
        kindName,
        kindCode,
        headlineText,
        condition,
        areas,
      });
    }
  }
  return result;
}

const ARRAY_TAGS: ReadonlySet<string> = new Set([
  "Information",
  "Item",
  "Area",
  "Areas",
  "MeteorologicalInfos",
  "MeteorologicalInfo",
  "Warning",
  "Kind",
  "Property",
  "TimeSeriesInfo",
  "TimeDefine",
  "HydrometricStationPart",
  "ChargeSection",
  "FloodAssumptionPart",
  "Station",
  "jmx_eb:Precipitation",
  "jmx_eb:WaterLevel",
  "jmx_eb:Discharge",
  "jmx_eb:PrecipitationBasedIndex",
  "jmx_eb:FloodDepth",
]);

/**
 * 洪水・水位系電文 (VXKO50-89 / VXSU50-59) をパースして
 * `ParsedFloodForecastInfo` を返す。パース失敗時は null。
 *
 * Stage 3 Task 9: Control/Head 基本抽出。Headlines / rawStations /
 * inundationAreas / rainfallSummaries / floodAssumptions は各 helper モジュール
 * に分割済 (2026-06-16 Phase 2 分割)。
 */
export function parseFloodForecast(
  msg: WsDataMessage,
): ParsedFloodForecastInfo | null {
  try {
    const xmlStr = decodeBody(msg);
    const parsed = xmlParser.parse(xmlStr) as Record<string, unknown>;

    const report = dig(parsed, "Report");
    if (report == null) {
      log.debug("parseFloodForecast: Report ノードが見つかりません");
      return null;
    }

    const control = dig(report, "Control");
    const head = dig(report, "Head");
    const body = dig(report, "Body");
    if (control == null || head == null) {
      log.debug("parseFloodForecast: Control / Head が欠落しています");
      return null;
    }

    const typeCode = String(msg.head.type ?? "");
    const schema: FloodReportSchema = typeCode.startsWith("VXSU")
      ? "vxsu50"
      : "vxko50";

    const controlTitle = str(dig(control, "Title"));
    const headTitle = str(dig(head, "Title"));
    const infoKind = str(dig(head, "InfoKind"));

    const infoTypeRaw = str(dig(head, "InfoType"));
    const infoType: "発表" | "訂正" | "取消" =
      infoTypeRaw === "取消"
        ? "取消"
        : infoTypeRaw === "訂正"
          ? "訂正"
          : "発表";

    const serialRaw = str(dig(head, "Serial"));
    const serial = serialRaw === "" ? 0 : Number(serialRaw);
    const eventId = str(dig(head, "EventID"));
    const reportDateTime = str(dig(head, "ReportDateTime"));
    const targetDateTimeRaw = str(dig(head, "TargetDateTime"));
    const targetDateTime = targetDateTimeRaw === "" ? null : targetDateTimeRaw;

    const statusValue = str(dig(control, "Status"));
    const noticeRaw = str(dig(body, "Notice"));
    const notice = noticeRaw === "" ? null : noticeRaw;
    // isTest: msg.head.test を優先しつつ、Status="試験" または Notice にテストサンプル文言を含む場合も真。
    const isTest =
      msg.head.test === true ||
      statusValue === "試験" ||
      (notice != null && notice.includes("テストサンプル"));

    const publishingOffice =
      msg.xmlReport?.control?.publishingOffice ||
      str(dig(control, "PublishingOffice"));
    const editorialOffice = str(dig(control, "EditorialOffice"));

    const headlines = parseHeadlines(dig(head, "Headline"));
    const rawStations =
      schema === "vxsu50"
        ? parseVxsuStubStations(body, headlines)
        : parseStationsAndAggregate(body, headlines);
    const inundationAreas = parseInundationAreas(body);
    const rainfallSummaries = parseRainfallSummaries(body);
    const floodAssumptions = parseFloodAssumptions(body);

    return {
      schema,
      typeCode,
      infoKind,
      infoType,
      serial: Number.isFinite(serial) ? serial : 0,
      eventId,
      controlTitle,
      headTitle,
      reportDateTime,
      targetDateTime,
      isTest,
      notice,
      headlines,
      rawStations,
      inundationAreas,
      rainfallSummaries,
      floodAssumptions,
      publishingOffice,
      editorialOffice,
    };
  } catch (err) {
    log.error(
      `parseFloodForecast: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}
