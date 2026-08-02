import fs from "fs";
import path from "path";
import zlib from "zlib";
import type {
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  ParsedVolcanoInfo,
  ParsedVolcanoAshfallInfo,
  ParsedWeatherWarning,
  ParsedTornadoAdvisory,
  ParsedWeatherBriefing,
  ParsedEarlyWeatherInfo,
  ParsedClimateInfo,
  ParsedWeatherExplanation,
  ParsedHeatAlertInfo,
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  TelegramMeta,
  WsDataMessage,
} from "../types";
import { displayEewInfo } from "./eew-formatter";
import { displaySeismicTextInfo } from "./seismic-text-formatter";
import { canonicalizeLegacyTsunamiInfo } from "../dmdata/tsunami-legacy-adapter";

const SAMPLE_TELEGRAM_META: TelegramMeta = {
  messageId: "preview-sample",
  eventId: { raw: null, value: null, valid: false },
  type: { raw: "preview", value: "preview", valid: true },
  reportDateTime: { raw: null, epochMs: null, valid: false },
  serial: { raw: null, numeric: null, valid: false },
  infoType: { raw: "発表", value: "発表", valid: true },
  receivedAtMs: 0,
  status: "試験",
  isTest: true,
};
import { displayNankaiTroughInfo } from "./nankai-trough-formatter";
import { displayLgObservationInfo } from "./lg-observation-formatter";
import { displayEarthquakeInfo } from "./earthquake-info-formatter";
import { displayTsunamiInfo } from "./tsunami-formatter";
import { displayVolcanoInfo, displayVolcanoAshfallBatch } from "./volcano-formatter";
import { displayWeatherWarning } from "./weather-formatter";
import { displayTornadoAdvisory } from "./tornado-formatter";
import { displayWeatherBriefing } from "./briefing-formatter";
import { displayEarlyWeatherInfo } from "./early-weather-formatter";
import { displayClimateInfo } from "./climate-info-formatter";
import { displayWeatherExplanation } from "./weather-explanation-formatter";
import { displayHeatAlertInfo } from "./heat-alert-formatter";
import { displayTyphoonAnalysisInfo } from "./typhoon-analysis-formatter";
import { displayTyphoonProbabilityInfo } from "./typhoon-probability-formatter";
import { displayFloodForecastInfo } from "./flood-forecast-formatter";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../dmdata/telegram-parser";
import { parseVolcanoTelegram } from "../dmdata/volcano-parser";
import { parseWeatherWarning } from "../dmdata/weather-parser";
import { parseTornadoAdvisory } from "../dmdata/tornado-parser";
import { parseWeatherBriefing } from "../dmdata/briefing-parser";
import { parseEarlyWeather } from "../dmdata/early-weather-parser";
import { parseClimateInfo } from "../dmdata/climate-info-parser";
import { parseWeatherExplanation } from "../dmdata/weather-explanation-parser";
import { parseHeatAlert } from "../dmdata/heat-alert-parser";
import { parseTyphoonAnalysis } from "../dmdata/typhoon-analysis-parser";
import { parseTyphoonProbability } from "../dmdata/typhoon-probability-parser";
import { parseFloodForecast } from "../dmdata/flood-forecast-parser";
import { parseTelegramEnvelopeXml } from "../dmdata/telegram-envelope";
import { normalizeTelegramMessage } from "../dmdata/telegram-ingress";
import { deriveIsTest } from "../dmdata/telegram-meta";
import type { ParsedFloodForecastInfo } from "../types";
import { resolveVolcanoPresentation, resolveVolcanoBatchPresentation } from "../engine/presentation/volcano-presentation";
import type { Vfvo53BatchItems } from "../engine/messages/volcano-vfvo53-aggregator";
import { VolcanoStateHolder } from "../engine/messages/volcano-state";
import { processWeather } from "../engine/presentation/processors/process-weather";
import { processTornado } from "../engine/presentation/processors/process-tornado";
import { processBriefing } from "../engine/presentation/processors/process-briefing";
import { processEarlyWeather } from "../engine/presentation/processors/process-early-weather";
import { processClimateInfo } from "../engine/presentation/processors/process-climate-info";
import { toPresentationEvent } from "../engine/presentation/events/to-presentation-event";
import type { ProcessOutcome } from "../engine/presentation/types";
import { getDisplayMode } from "./formatter";
import { renderSummaryLine } from "./summary";

// ── フィクスチャ読み込みヘルパー ──

/** フィクスチャディレクトリを解決する (dist/ui/ → ../../test/fixtures/) */
function resolveFixturesDir(): string {
  return path.resolve(__dirname, "../../test/fixtures");
}

function nullableXmlText(value: string): string | null {
  return value === "" ? null : value;
}

/** フィクスチャXMLを読み込み WsDataMessage を構築する */
function loadFixture(filename: string): WsDataMessage | null {
  try {
    const fixturesDir = resolveFixturesDir();
    let xmlPath = path.join(fixturesDir, filename);
    if (!fs.existsSync(xmlPath)) {
      xmlPath = path.join(fixturesDir, "selected_xml", filename);
    }
    if (!fs.existsSync(xmlPath)) return null;

    const xml = fs.readFileSync(xmlPath, "utf-8");
    const body = zlib.gzipSync(Buffer.from(xml, "utf-8")).toString("base64");

    const typeMatch = filename.match(
      /(V[TXYZ]SE\d+|VFVO\d+|VFSVii|VZVO\d+|VPWW\d+|VPWS\d+|VPHW\d+|VPBS\d+|VPAW\d+|VPZI\d+|VPCI\d+|VPCJ\d+|VPZJ\d+|VPFJ\d+|VMCJ\d+|VPWP\d+|VPFT\d+|VPTW\d+|VPTA\d+|VXKO\d+|VXSU\d+)/
    );
    const type = typeMatch ? typeMatch[1] : "VXSE53";
    const { control, head } = parseTelegramEnvelopeXml(xml);
    const classification =
      type === "VXSE43"
        ? "eew.warning"
        : type === "VXSE44" || type === "VXSE45"
          ? "eew.forecast"
          : type.startsWith("VFVO") || type.startsWith("VFSV") || type.startsWith("VZVO")
            ? "telegram.volcano"
            : type.startsWith("VPWW") ||
                type.startsWith("VPWS") ||
                type.startsWith("VPHW") ||
                type.startsWith("VPBS") ||
                type.startsWith("VPAW") ||
                type.startsWith("VPWP") ||
                type.startsWith("VPZI") ||
                type.startsWith("VPCI") ||
                type.startsWith("VPCJ") ||
                type.startsWith("VPZJ") ||
                type.startsWith("VPFJ") ||
                type.startsWith("VMCJ") ||
                type.startsWith("VPFT") ||
                type.startsWith("VPTW") ||
                type.startsWith("VPTA") ||
                type.startsWith("VXKO") ||
                type.startsWith("VXSU")
              ? "telegram.weather"
              : "telegram.earthquake";

    return normalizeTelegramMessage({
      type: "data",
      version: "2.0",
      classification,
      id: "test-sample-001",
      passing: [{ name: "test", time: new Date().toISOString() }],
      head: {
        type,
        author: control.publishingOffice,
        time: control.dateTime,
        test: deriveIsTest({
          headTest: null,
          controlStatus: control.status,
        }),
        xml: true,
      },
      xmlReport: {
        control: {
          title: control.title,
          dateTime: control.dateTime,
          status: control.status,
          editorialOffice: control.editorialOffice,
          publishingOffice: control.publishingOffice,
        },
        head: {
          title: head.title,
          reportDateTime: head.reportDateTime,
          targetDateTime: head.targetDateTime,
          eventId: nullableXmlText(head.eventId),
          serial: nullableXmlText(head.serial),
          infoType: head.infoType,
          infoKind: head.infoKind,
          infoKindVersion: head.infoKindVersion,
          headline: nullableXmlText(head.headline),
        },
      },
      format: "xml",
      compression: "gzip",
      encoding: "base64",
      body,
    }).message;
  } catch {
    return null;
  }
}

/** フィクスチャからパース済みデータを取得する */
function fromFixture<T>(
  filename: string,
  parser: (msg: WsDataMessage) => T | null,
): T | null {
  const msg = loadFixture(filename);
  if (msg == null) return null;
  return parser(msg);
}

/** compact 表示は本番と同じ PresentationEvent → summary 経路に通す。 */
function displayTestOutcome<T extends ProcessOutcome>(
  outcome: T,
  displayNormal: (info: T["parsed"]) => void,
): void {
  if (getDisplayMode() === "compact") {
    console.log(renderSummaryLine(toPresentationEvent(outcome)));
    return;
  }
  displayNormal(outcome.parsed);
}

function processWeatherSample(msg: WsDataMessage) {
  const result = processWeather(msg);
  return result.kind === "ok" ? result.outcome : null;
}

// ── テスト表示エントリ型 ──

export interface TestTableVariant {
  label: string;
  run: () => void;
}

export interface TestTableEntry {
  label: string;
  variants: TestTableVariant[];
}

// ── フィクスチャファイル名定数 ──

const FIX_VXSE53_DRILL_1 = "32-35_01_03_240613_VXSE53.xml";
const FIX_VXSE53_CANCEL = "32-39_05_12_100915_VXSE53.xml";
const FIX_VXSE53_ENCHI = "32-35_01_03_100514_VXSE53.xml";
const FIX_VXSE51_SHINDO = "32-35_08_03_100915_VXSE51.xml";
const FIX_VXSE43_WARNING_S1 = "37_01_01_240613_VXSE43.xml";
const FIX_VXSE45_CANCEL = "77_01_33_240613_VXSE45.xml";
const FIX_VXSE45_PLUM = "77_02_01_260101_VXSE45_PLUM.xml";
const FIX_VXSE45_FINAL = "77_01_30_260101_VXSE45_FINAL.xml";
const FIX_VTSE41_WARN = "32-39_11_02_250206_VTSE41.xml";
const FIX_VTSE41_CANCEL = "38-39_03_01_210805_VTSE41.xml";
const FIX_VTSE51_INFO = "32-39_11_03_250206_VTSE51.xml";
const FIX_VTSE52_OFFSHORE = "61_11_01_250206_VTSE52.xml";
const FIX_VXSE60_CANCEL = "32-35_10_02_220510_VXSE60.xml";
const FIX_VYSE50_CAUTION = "74_01_06_200512_VYSE50.xml";
const FIX_VYSE50_CLOSED = "74_01_07_200512_VYSE50.xml";
const FIX_VXSE62_LGOBS = "78_01_01_240613_VXSE62.xml";
const FIX_VPWW55_OAME = "15_17_01_251222_VPWW55.xml";
const FIX_VPWW56_DOSHA = "15_16_01_241031_VPWW56.xml";
const FIX_VPWW57_KOCHO = "15_16_02_251222_VPWW57.xml";
const FIX_VPWW58_BOFU = "15_16_04_251222_VPWW58.xml";
const FIX_VPWW59_HARO = "15_16_05_241226_VPWW59.xml";
const FIX_VPWW60_OYUKI = "15_16_06_241226_VPWW60.xml";
const FIX_VPWW61_OTHER = "15_16_07_250825_VPWW61.xml";
const FIX_VPWS50_AGGREGATE = "15_18_01_250630_VPWS50.xml";
const FIX_VPHW50_TOKYO = "19_01_01_091210_VPHW50.xml";
const FIX_VPHW50_ALT = "19_03_01_130906_VPHW50.xml";
const FIX_VPHW51_SIGHTING = "19_04_01_140425_VPHW51.xml";
const FIX_VPBS50_LINEAR_OBSERVED = "82_01_01_260324_VPBS50.xml";
const FIX_VPBS50_LINEAR_PREDICTED = "82_03_01_260324_VPBS50.xml";
const FIX_VPBS50_RECORD_RAIN = "82_01_02_250630_VPBS50.xml";
const FIX_VPBS50_SHORT_SNOW = "82_01_03_241031_VPBS50.xml";
const FIX_VPAW51_HIGH_TEMP = "72_01_01_190327_VPAW51.xml";
const FIX_VPAW51_LOW_TEMP = "72_02_01_190327_VPAW51.xml";
const FIX_VPAW51_HEAVY_SNOW = "72_03_01_190327_VPAW51.xml";
const FIX_VPAW51_SNOW = "72_04_01_190327_VPAW51.xml";
const FIX_VPAW51_LOWTEMP_HEAVYSNOW = "72_05_01_190327_VPAW51.xml";
const FIX_VPAW51_LOWTEMP_SNOW = "72_06_01_190327_VPAW51.xml";
const FIX_VPAW51_HIGHTEMP_HEAVYSNOW = "72_07_01_190327_VPAW51.xml";
const FIX_VPAW51_HIGHTEMP_SNOW = "72_08_01_190327_VPAW51.xml";
const FIX_VPZI50_HOT_DRY = "29_01_01_140129_VPZI50.xml";
const FIX_VPCI50_KANTO_TSUYU = "30_01_01_100915_VPCI50.xml";
const FIX_VPCI50_TOHOKU_NO_TSUYUAKE = "30_03_01_091210_VPCI50.xml";
const FIX_VPCJ51_KANTO_SNOW = "84_01_01_260129_VPCJ51.xml";
const FIX_VPCJ51_TOHOKU_HOT = "84_02_01_241226_VPCJ51.xml";
const FIX_VPZJ51_SENJOU = "83_01_01_250630_VPZJ51.xml";
const FIX_VPZJ51_TYPHOON = "83_02_02_250630_VPZJ51.xml";
const FIX_VPFJ51_TYPHOON = "85_01_01_250630_VPFJ51.xml";
const FIX_VPFJ51_SNOW_INIT = "85(82)_02_01_250630_VPFJ51.xml";
const FIX_VPFJ51_SNOW_OBS = "85(82)_02_04_260326_VPFJ51.xml";
const FIX_VPFJ51_SNOW_OBS2 = "85(82)_02_07_260326_VPFJ51.xml";
const FIX_VMCJ53_OSHIO = "87_01_01_250630_VMCJ53.xml";
const FIX_VMCJ54_OSHIO = "88_01_01_250630_VMCJ54.xml";
const FIX_VMCJ55_FUKUSHINDO = "89_01_01_250630_VMCJ55.xml";
const FIX_VMCJ55_OSHIO_CHIBA = "89_02_01_250630_VMCJ55.xml";
const FIX_VPFT50_SAITAMA = "57_03_01_240401_VPFT50.xml";
const FIX_VPFT50_TITLE_ESCALATION = "synthetic_VPFT50_title_escalation.xml";
const FIX_VPFT50_CANCEL = "synthetic_VPFT50_cancel.xml";
const FIX_VPTW60_2020 = "10_05_01_200826_VPTW60.xml";
const FIX_VPTW60_2017 = "10_04_03_170913_VPTW60.xml";
const FIX_VPTW61 = "10_05_05_200826_VPTW61.xml";
const FIX_VPTW62 = "10_05_06_200826_VPTW62.xml";
const FIX_VPTW60_CANCEL = "synthetic_VPTW60_cancel.xml";
const FIX_VPTA50_DAMREY = "76_01_01_200630_VPTA50.xml";
const FIX_VPTA50_JANGMI_APPROACH = "76_01_02_260531_VPTA50.xml";
const FIX_VPTA50_JANGMI_GONE = "76_01_03_260602_VPTA50.xml";
const FIX_VPTA50_CANCEL = "synthetic_VPTA50_cancel.xml";

// 洪水・水位系 (VXKO50 / VXSU50)
const FIX_VXKO50_16_01_01 = "16_01_01_220728_VXKO50.xml";
const FIX_VXKO50_16_02_01 = "16_02_01_220728_VXKO50.xml";
const FIX_VXKO50_16_02_02 = "16_02_02_220728_VXKO50.xml";
const FIX_VXKO50_16_03_01 = "16_03_01_220728_VXKO50.xml";
const FIX_VXKO50_16_04_01 = "16_04_01_220728_VXKO50.xml";
const FIX_VXKO50_16_05_01 = "16_05_01_210630_VXKO50.xml";
const FIX_VXKO50_16_06_01 = "16_06_01_220728_VXKO50.xml";
const FIX_VXKO50_16_07_01 = "16_07_01_220728_VXKO50.xml";
const FIX_VXKO50_16_10_01 = "16_10_01_260312_VXKO50.xml";
const FIX_VXKO50_16_11_01 = "16_11_01_260312_VXKO50.xml";
const FIX_VXKO50_16_11_02 = "16_11_02_260312_VXKO50.xml";
const FIX_VXKO50_16_12_01 = "16_12_01_260312_VXKO50.xml";
const FIX_VXKO50_16_14_01 = "16_14_01_251222_VXKO50.xml";
const FIX_VXSU50_91_01_01 = "91_01_01_241031_VXSU50.xml";
const FIX_VXKO50_CANCEL = "synthetic_VXKO50_cancel.xml";
const FIX_VXKO50_CORRECTION = "synthetic_VXKO50_correction.xml";
const FIX_VXKO50_CODE31 = "synthetic_VXKO50_code31.xml";
const FIX_VXSU50_CANCEL = "synthetic_VXSU50_cancel.xml";

// ── 既存ハードコードサンプル (#1: 各タイプのデフォルト) ──

/** 地震情報サンプル */
export const SAMPLE_EARTHQUAKE = {
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/01 00:00:00",
  headline: "１日００時００分ころ、地震がありました。",
  publishingOffice: "気象庁",
  eventId: "20240101000000",
  earthquake: {
    originTime: "2024/01/01 00:00:00",
    hypocenterName: "石川県能登地方",
    latitude: "北緯37.5度",
    longitude: "東経137.3度",
    depth: "10km",
    magnitude: "7.6",
  },
  intensity: {
    maxInt: "7",
    areas: [
      { name: "石川県能登", code: null, intensity: "7" },
      { name: "新潟県上越", code: null, intensity: "6強" },
      { name: "新潟県中越", code: null, intensity: "6弱" },
      { name: "富山県東部", code: null, intensity: "5強" },
      { name: "富山県西部", code: null, intensity: "5弱" },
      { name: "石川県加賀", code: null, intensity: "5弱" },
      { name: "福井県嶺北", code: null, intensity: "4" },
      { name: "長野県北部", code: null, intensity: "4" },
    ],
    municipalities: [],
  },
  tsunami: {
    text: "この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。",
  },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

/** 緊急地震速報サンプル */
export const SAMPLE_EEW = {
  type: "VXSE44",
  infoType: "発表",
  title: "緊急地震速報（予報）",
  reportDateTime: "2024/01/01 00:00:05",
  headline: null,
  publishingOffice: "気象庁",
  serial: "3",
  eventId: "20240101000000",
  earthquake: {
    originTime: "2024/01/01 00:00:00",
    hypocenterName: "石川県能登地方",
    latitude: "北緯37.5度",
    longitude: "東経137.3度",
    depth: "10km",
    magnitude: "7.2",
  },
  isAssumedHypocenter: false,
  forecastIntensity: {
    areas: [
      { name: "石川県能登", intensity: "6強", hasArrived: true },
      { name: "新潟県上越", intensity: "5強" },
      { name: "富山県東部", intensity: "5弱" },
      { name: "石川県加賀", intensity: "4" },
      { name: "福井県嶺北", intensity: "4" },
      { name: "新潟県中越", intensity: "3" },
    ],
  },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

/** 津波情報サンプル */
export const SAMPLE_TSUNAMI = canonicalizeLegacyTsunamiInfo({
  type: "VTSE41",
  infoType: "発表",
  title: "津波警報・注意報・予報a",
  reportDateTime: "2024/01/01 00:03:00",
  headline: "津波警報を発表しました。",
  publishingOffice: "気象庁",
  forecast: [
    {
      areaName: "石川県能登",
      kind: "津波警報",
      maxHeightDescription: "３ｍ",
      firstHeight: "すでに津波到達と推測",
    },
    {
      areaName: "新潟県上中下越",
      kind: "津波注意報",
      maxHeightDescription: "１ｍ",
      firstHeight: "01日00時30分",
    },
    {
      areaName: "富山県",
      kind: "津波注意報",
      maxHeightDescription: "１ｍ",
      firstHeight: "01日00時20分",
    },
  ],
  earthquake: {
    originTime: "2024/01/01 00:00:00",
    hypocenterName: "石川県能登地方",
    latitude: "北緯37.5度",
    longitude: "東経137.3度",
    depth: "10km",
    magnitude: "7.6",
  },
  warningComment:
    "津波による被害のおそれがあります。警報が発表された沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

/** 地震活動テキスト情報サンプル */
export const SAMPLE_SEISMIC_TEXT = {
  type: "VXSE56",
  infoType: "発表",
  title: "地震の活動状況等に関する情報",
  reportDateTime: "2024/01/01 12:00:00",
  headline: null,
  publishingOffice: "気象庁",
  bodyText:
    "令和６年１月１日16時10分頃の石川県能登地方の地震について\n\n" +
    "＊＊　概要　＊＊\n" +
    "１日16時10分頃、石川県能登地方を震源とするマグニチュード7.6の地震が発生し、石川県志賀町で震度７を観測しました。\n" +
    "この地震について、緊急地震速報（警報）を発表しています。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedSeismicTextInfo;

/** 南海トラフ情報サンプル */
export const SAMPLE_NANKAI_TROUGH = {
  type: "VYSE50",
  infoType: "発表",
  title: "南海トラフ地震臨時情報",
  reportDateTime: "2024/01/01 00:30:00",
  headline: "南海トラフ地震臨時情報（調査中）が発表されました。",
  publishingOffice: "気象庁",
  infoSerial: {
    name: "南海トラフ地震臨時情報",
    code: "120",
  },
  bodyText:
    "本日、南海トラフ地震の想定震源域でマグニチュード6.8の地震が発生しました。\n" +
    "この地震と南海トラフ地震との関連性について調査を開始します。\n" +
    "今後の情報に注意してください。",
  nextAdvisory: "続報は２時間後を目途に発表します。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedNankaiTroughInfo;

/** 長周期地震動観測情報サンプル */
export const SAMPLE_LG_OBSERVATION = {
  type: "VXSE62",
  infoType: "発表",
  title: "長周期地震動に関する観測情報",
  reportDateTime: "2024/01/01 00:10:00",
  headline: null,
  publishingOffice: "気象庁",
  earthquake: {
    originTime: "2024/01/01 00:00:00",
    hypocenterName: "石川県能登地方",
    latitude: "北緯37.5度",
    longitude: "東経137.3度",
    depth: "10km",
    magnitude: "7.6",
  },
  maxInt: "7",
  maxLgInt: "4",
  lgCategory: "長周期地震動階級４",
  areas: [
    { name: "石川県能登", maxInt: "7", maxLgInt: "4" },
    { name: "新潟県上越", maxInt: "6強", maxLgInt: "3" },
    { name: "富山県東部", maxInt: "5強", maxLgInt: "2" },
    { name: "富山県西部", maxInt: "5弱", maxLgInt: "1" },
  ],
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedLgObservationInfo;

// ── リテラルフォールバック (フィクスチャが無い場合) ──

const FALLBACK_EARTHQUAKE_WARNING = {
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/02 10:00:00",
  headline: "長野県北部で震度4を観測しました。",
  publishingOffice: "気象庁",
  eventId: null,
  earthquake: {
    originTime: "2024/01/02 09:58:00",
    hypocenterName: "長野県北部",
    latitude: "北緯36.7度",
    longitude: "東経138.0度",
    depth: "10km",
    magnitude: "4.8",
  },
  intensity: {
    maxInt: "4",
    areas: [
      { name: "長野県北部", code: null, intensity: "4" },
      { name: "長野県中部", code: null, intensity: "3" },
    ],
    municipalities: [],
  },
  tsunami: { text: "この地震による津波の心配はありません。" },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_CANCEL = {
  type: "VXSE53",
  infoType: "取消",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/02 10:05:00",
  headline: "先ほどの地震情報を取り消します。",
  publishingOffice: "気象庁",
  eventId: null,
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_ENCHI = {
  type: "VXSE53",
  infoType: "発表",
  title: "遠地地震に関する情報",
  reportDateTime: "2024/01/03 08:20:00",
  headline: "日本への津波の影響はありません。",
  publishingOffice: "気象庁",
  eventId: null,
  earthquake: {
    originTime: "2024/01/03 08:10:00",
    hypocenterName: "台湾付近",
    latitude: "北緯24.0度",
    longitude: "東経121.7度",
    depth: "70km",
    magnitude: "6.9",
  },
  tsunami: { text: "日本への津波の影響はありません。" },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_SHINDO = {
  type: "VXSE51",
  infoType: "発表",
  title: "震度速報",
  reportDateTime: "2024/01/04 14:00:00",
  headline: "各地の震度に関する情報です。",
  publishingOffice: "気象庁",
  eventId: null,
  intensity: {
    maxInt: "5弱",
    areas: [
      { name: "石川県能登", code: null, intensity: "5弱" },
      { name: "富山県東部", code: null, intensity: "4" },
      { name: "新潟県上越", code: null, intensity: "4" },
    ],
    municipalities: [],
  },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_LG = {
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/05 19:30:00",
  headline: "関東地方で長周期地震動階級4を観測しました。",
  publishingOffice: "気象庁",
  eventId: null,
  earthquake: {
    originTime: "2024/01/05 19:27:00",
    hypocenterName: "千葉県北西部",
    latitude: "北緯35.7度",
    longitude: "東経140.1度",
    depth: "80km",
    magnitude: "6.8",
  },
  intensity: {
    maxInt: "5強",
    maxLgInt: "4",
    areas: [
      { name: "東京都23区", code: null, intensity: "5強", lgIntensity: "4" },
      { name: "千葉県北西部", code: null, intensity: "5弱", lgIntensity: "3" },
      { name: "神奈川県東部", code: null, intensity: "4", lgIntensity: "3" },
    ],
    municipalities: [],
  },
  tsunami: { text: "この地震による津波の心配はありません。" },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EEW_WARNING = {
  type: "VXSE43",
  infoType: "発表",
  title: "緊急地震速報（警報）",
  reportDateTime: "2024/01/02 00:00:05",
  headline: "強い揺れに警戒してください。",
  publishingOffice: "気象庁",
  serial: "1",
  eventId: "20240102000000",
  earthquake: {
    originTime: "2024/01/02 00:00:00",
    hypocenterName: "茨城県南部",
    latitude: "北緯36.0度",
    longitude: "東経140.1度",
    depth: "50km",
    magnitude: "6.5",
  },
  isAssumedHypocenter: false,
  forecastIntensity: {
    areas: [
      { name: "茨城県南部", intensity: "6弱" },
      { name: "千葉県北西部", intensity: "5強" },
    ],
    maxLgInt: "3",
  },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
  isWarning: true,
} satisfies ParsedEewInfo;

const FALLBACK_EEW_CANCEL = {
  type: "VXSE45",
  infoType: "取消",
  title: "緊急地震速報（予報）",
  reportDateTime: "2024/01/02 00:00:20",
  headline: "先ほどの緊急地震速報を取り消します。",
  publishingOffice: "気象庁",
  serial: "2",
  eventId: "20240102000000",
  earthquake: {
    originTime: "2024/01/02 00:00:00",
    hypocenterName: "茨城県南部",
    latitude: "北緯36.0度",
    longitude: "東経140.1度",
    depth: "50km",
    magnitude: "6.5",
  },
  isAssumedHypocenter: false,
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

const FALLBACK_EEW_PLUM = {
  type: "VXSE45",
  infoType: "発表",
  title: "緊急地震速報（予報）",
  reportDateTime: "2024/01/02 00:10:05",
  headline: null,
  publishingOffice: "気象庁",
  serial: "1",
  eventId: "20240102001000",
  earthquake: {
    originTime: "",
    hypocenterName: "能登地方",
    latitude: "",
    longitude: "",
    depth: "",
    magnitude: "",
  },
  isAssumedHypocenter: true,
  maxIntChangeReason: 9,
  forecastIntensity: {
    areas: [
      { name: "石川県能登", intensity: "5強", isPlum: true },
      { name: "富山県東部", intensity: "5弱", isPlum: true, hasArrived: true },
    ],
  },
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

const FALLBACK_EEW_FINAL = {
  type: "VXSE45",
  infoType: "発表",
  title: "緊急地震速報（予報）",
  reportDateTime: "2024/01/02 00:12:00",
  headline: null,
  publishingOffice: "気象庁",
  serial: "5",
  eventId: "20240102001000",
  earthquake: {
    originTime: "2024/01/02 00:11:52",
    hypocenterName: "福島県沖",
    latitude: "北緯37.4度",
    longitude: "東経141.7度",
    depth: "40km",
    magnitude: "5.9",
  },
  isAssumedHypocenter: false,
  forecastIntensity: {
    areas: [
      { name: "福島県浜通り", intensity: "4" },
      { name: "宮城県南部", intensity: "4" },
    ],
  },
  nextAdvisory: "この情報をもって、緊急地震速報を終了します。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

const FALLBACK_TSUNAMI_MAJOR = canonicalizeLegacyTsunamiInfo({
  type: "VTSE41",
  infoType: "発表",
  title: "大津波警報・津波警報・津波注意報",
  reportDateTime: "2024/01/02 03:00:00",
  headline: "大津波警報を発表しました。",
  publishingOffice: "気象庁",
  forecast: [
    {
      areaName: "北海道太平洋沿岸東部",
      kind: "大津波警報",
      maxHeightDescription: "５ｍ",
      firstHeight: "到達と推定",
    },
  ],
  earthquake: {
    originTime: "2024/01/02 02:55:00",
    hypocenterName: "千島列島",
    latitude: "北緯44.0度",
    longitude: "東経149.0度",
    depth: "30km",
    magnitude: "8.4",
  },
  warningComment: "海岸や川沿いから直ちに避難してください。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

const FALLBACK_TSUNAMI_ADVISORY = canonicalizeLegacyTsunamiInfo({
  type: "VTSE41",
  infoType: "発表",
  title: "大津波警報・津波警報・津波注意報",
  reportDateTime: "2024/01/02 04:00:00",
  headline: "津波注意報を発表しました。",
  publishingOffice: "気象庁",
  forecast: [
    {
      areaName: "伊豆諸島",
      kind: "津波注意報",
      maxHeightDescription: "１ｍ",
      firstHeight: "02日04時20分",
    },
  ],
  earthquake: {
    originTime: "2024/01/02 03:56:00",
    hypocenterName: "八丈島東方沖",
    latitude: "北緯33.4度",
    longitude: "東経141.8度",
    depth: "50km",
    magnitude: "6.8",
  },
  warningComment: "海の中では速い流れに注意してください。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

const FALLBACK_TSUNAMI_CANCEL = canonicalizeLegacyTsunamiInfo({
  type: "VTSE41",
  infoType: "取消",
  title: "大津波警報・津波警報・津波注意報",
  reportDateTime: "2024/01/02 04:30:00",
  headline: "津波警報等を解除しました。",
  publishingOffice: "気象庁",
  warningComment: "現在、津波の心配はありません。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

const FALLBACK_TSUNAMI_OBS = canonicalizeLegacyTsunamiInfo({
  type: "VTSE51",
  infoType: "発表",
  title: "津波情報",
  reportDateTime: "2024/01/02 05:00:00",
  headline: "津波を観測しました。",
  publishingOffice: "気象庁",
  forecast: [
    {
      areaName: "宮城県",
      kind: "津波警報",
      maxHeightDescription: "３ｍ",
      firstHeight: "到達",
    },
  ],
  observations: [
    {
      areaName: "宮城県",
      maxHeightValue: null,
      name: "石巻沖GPS波浪計",
      sensor: "GPS波浪計",
      arrivalTime: "02日04時58分",
      initial: "第1波到達",
      maxHeightCondition: "1.2m観測中",
    },
  ],
  earthquake: {
    originTime: "2024/01/02 04:50:00",
    hypocenterName: "三陸沖",
    latitude: "北緯38.2度",
    longitude: "東経143.5度",
    depth: "20km",
    magnitude: "7.7",
  },
  warningComment: "今後さらに高い津波が到達するおそれがあります。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

const FALLBACK_TSUNAMI_OFFSHORE = canonicalizeLegacyTsunamiInfo({
  type: "VTSE52",
  infoType: "発表",
  title: "沖合の津波観測に関する情報",
  reportDateTime: "2024/01/02 05:20:00",
  headline: "沖合で津波を観測しました。",
  publishingOffice: "気象庁",
  forecast: [
    {
      areaName: "岩手県",
      kind: "津波警報",
      maxHeightDescription: "３ｍ",
      firstHeight: "到達",
    },
  ],
  estimations: [
    {
      areaName: "岩手県",
      maxHeightDescription: "３ｍ",
      firstHeight: "02日05時35分",
    },
    {
      areaName: "宮城県",
      maxHeightDescription: "２ｍ",
      firstHeight: "02日05時40分",
    },
  ],
  warningComment: "沿岸では引き続き警戒してください。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
});

const FALLBACK_SEISMIC_TEXT_CANCEL = {
  type: "VXSE60",
  infoType: "取消",
  title: "地震回数に関する情報",
  reportDateTime: "2024/01/02 12:30:00",
  headline: "先ほどの情報を取り消します。",
  publishingOffice: "気象庁",
  bodyText: "先ほど発表した地震回数に関する情報は取り消します。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedSeismicTextInfo;

const FALLBACK_NANKAI_CAUTION = {
  type: "VYSE50",
  infoType: "発表",
  title: "南海トラフ地震臨時情報",
  reportDateTime: "2024/01/02 06:00:00",
  headline: "南海トラフ地震臨時情報（巨大地震注意）を発表しました。",
  publishingOffice: "気象庁",
  infoSerial: { name: "巨大地震注意", code: "130" },
  bodyText:
    "南海トラフ沿いで規模の大きな地震が発生しました。\n今後の地震活動に注意してください。",
  nextAdvisory: "今後の情報に注意してください。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedNankaiTroughInfo;

const FALLBACK_NANKAI_CLOSED = {
  type: "VYSE50",
  infoType: "発表",
  title: "南海トラフ地震臨時情報",
  reportDateTime: "2024/01/02 09:00:00",
  headline: "南海トラフ地震臨時情報（調査終了）を発表しました。",
  publishingOffice: "気象庁",
  infoSerial: { name: "調査終了", code: "190" },
  bodyText:
    "今回の地震について調査した結果、特段の防災対応をとるべき状況ではありません。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedNankaiTroughInfo;

const FALLBACK_LG_OBS_3 = {
  type: "VXSE62",
  infoType: "発表",
  title: "長周期地震動に関する観測情報",
  reportDateTime: "2024/01/02 00:20:00",
  headline: null,
  publishingOffice: "気象庁",
  earthquake: {
    originTime: "2024/01/02 00:15:00",
    hypocenterName: "東京湾",
    latitude: "北緯35.5度",
    longitude: "東経139.8度",
    depth: "70km",
    magnitude: "6.1",
  },
  maxInt: "4",
  maxLgInt: "3",
  lgCategory: "長周期地震動階級３",
  areas: [
    { name: "東京都23区", maxInt: "4", maxLgInt: "3" },
    { name: "神奈川県東部", maxInt: "4", maxLgInt: "2" },
  ],
  comment: "高層ビルでは大きな揺れを感じることがあります。",
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedLgObservationInfo;

const FALLBACK_LG_OBS_2 = {
  type: "VXSE62",
  infoType: "発表",
  title: "長周期地震動に関する観測情報",
  reportDateTime: "2024/01/02 00:40:00",
  headline: null,
  publishingOffice: "気象庁",
  earthquake: {
    originTime: "2024/01/02 00:36:00",
    hypocenterName: "大阪府北部",
    latitude: "北緯34.8度",
    longitude: "東経135.5度",
    depth: "15km",
    magnitude: "5.4",
  },
  maxInt: "3",
  maxLgInt: "2",
  lgCategory: "長周期地震動階級２",
  areas: [
    { name: "大阪府北部", maxInt: "3", maxLgInt: "2" },
    { name: "兵庫県南東部", maxInt: "3", maxLgInt: "1" },
  ],
  meta: SAMPLE_TELEGRAM_META,
  isTest: true,
} satisfies ParsedLgObservationInfo;

// ── ヘルパー: フィクスチャ優先でデータ取得 ──

function earthquakeFromFixture(filename: string): ParsedEarthquakeInfo | null {
  return fromFixture(filename, parseEarthquakeTelegram);
}

function eewFromFixture(filename: string): ParsedEewInfo | null {
  return fromFixture(filename, parseEewTelegram);
}

function tsunamiFromFixture(filename: string): ParsedTsunamiInfo | null {
  return fromFixture(filename, parseTsunamiTelegram);
}

function seismicTextFromFixture(filename: string): ParsedSeismicTextInfo | null {
  return fromFixture(filename, parseSeismicTextTelegram);
}

function nankaiFromFixture(filename: string): ParsedNankaiTroughInfo | null {
  return fromFixture(filename, parseNankaiTroughTelegram);
}

function lgObsFromFixture(filename: string): ParsedLgObservationInfo | null {
  return fromFixture(filename, parseLgObservationTelegram);
}

function weatherFromFixture(filename: string): ParsedWeatherWarning | null {
  return fromFixture(filename, parseWeatherWarning);
}

function tornadoFromFixture(filename: string): ParsedTornadoAdvisory | null {
  return fromFixture(filename, parseTornadoAdvisory);
}

function briefingFromFixture(filename: string): ParsedWeatherBriefing | null {
  return fromFixture(filename, parseWeatherBriefing);
}

function earlyWeatherFromFixture(filename: string): ParsedEarlyWeatherInfo | null {
  return fromFixture(filename, parseEarlyWeather);
}

function climateInfoFromFixture(filename: string): ParsedClimateInfo | null {
  return fromFixture(filename, parseClimateInfo);
}

function weatherExplanationFromFixture(
  filename: string,
): ParsedWeatherExplanation | null {
  return fromFixture(filename, parseWeatherExplanation);
}

function heatAlertFromFixture(filename: string): ParsedHeatAlertInfo | null {
  return fromFixture(filename, parseHeatAlert);
}

function typhoonAnalysisFromFixture(filename: string): ParsedTyphoonAnalysis | null {
  return fromFixture(filename, parseTyphoonAnalysis);
}

function typhoonProbabilityFromFixture(filename: string): ParsedTyphoonProbability | null {
  return fromFixture(filename, parseTyphoonProbability);
}

function floodForecastFromFixture(filename: string): ParsedFloodForecastInfo | null {
  return fromFixture(filename, parseFloodForecast);
}

// ── テスト表示ディスパッチマップ ──

/** テスト表示マップ (バリエーション番号付き) */
export const TEST_TABLES: Record<string, TestTableEntry> = {
  earthquake: {
    label: "地震情報",
    variants: [
      {
        label: "震源・震度情報（震度7・critical）",
        run: () => displayEarthquakeInfo(SAMPLE_EARTHQUAKE),
      },
      {
        label: "震源・震度情報（震度4・warning）",
        run: () =>
          displayEarthquakeInfo(
            earthquakeFromFixture(FIX_VXSE53_DRILL_1) ??
              FALLBACK_EARTHQUAKE_WARNING,
          ),
      },
      {
        label: "取消",
        run: () =>
          displayEarthquakeInfo(
            earthquakeFromFixture(FIX_VXSE53_CANCEL) ??
              FALLBACK_EARTHQUAKE_CANCEL,
          ),
      },
      {
        label: "遠地地震",
        run: () =>
          displayEarthquakeInfo(
            earthquakeFromFixture(FIX_VXSE53_ENCHI) ??
              FALLBACK_EARTHQUAKE_ENCHI,
          ),
      },
      {
        label: "震度速報（震源未確定）",
        run: () =>
          displayEarthquakeInfo(
            earthquakeFromFixture(FIX_VXSE51_SHINDO) ??
              FALLBACK_EARTHQUAKE_SHINDO,
          ),
      },
      {
        label: "長周期地震動階級付き",
        run: () => displayEarthquakeInfo(FALLBACK_EARTHQUAKE_LG),
      },
    ],
  },
  eew: {
    label: "緊急地震速報",
    variants: [
      {
        label: "予報",
        run: () =>
          displayEewInfo(SAMPLE_EEW, { activeCount: 1, colorIndex: 0 }),
      },
      {
        label: "警報（critical）",
        run: () =>
          displayEewInfo(
            eewFromFixture(FIX_VXSE43_WARNING_S1) ?? FALLBACK_EEW_WARNING,
            { activeCount: 1, colorIndex: 0 },
          ),
      },
      {
        label: "取消",
        run: () =>
          displayEewInfo(
            eewFromFixture(FIX_VXSE45_CANCEL) ?? FALLBACK_EEW_CANCEL,
            { activeCount: 1, colorIndex: 0 },
          ),
      },
      {
        label: "PLUM法（仮定震源要素）",
        run: () =>
          displayEewInfo(
            eewFromFixture(FIX_VXSE45_PLUM) ?? FALLBACK_EEW_PLUM,
            { activeCount: 1, colorIndex: 0 },
          ),
      },
      {
        label: "最終報",
        run: () =>
          displayEewInfo(
            eewFromFixture(FIX_VXSE45_FINAL) ?? FALLBACK_EEW_FINAL,
            { activeCount: 1, colorIndex: 0 },
          ),
      },
    ],
  },
  tsunami: {
    label: "津波情報",
    variants: [
      {
        label: "津波警報（warning）",
        run: () => displayTsunamiInfo(SAMPLE_TSUNAMI),
      },
      {
        label: "大津波警報（critical）",
        run: () =>
          displayTsunamiInfo(
            tsunamiFromFixture(FIX_VTSE41_WARN) ?? FALLBACK_TSUNAMI_MAJOR,
          ),
      },
      {
        label: "津波注意報（normal）",
        run: () => displayTsunamiInfo(FALLBACK_TSUNAMI_ADVISORY),
      },
      {
        label: "取消",
        run: () =>
          displayTsunamiInfo(
            tsunamiFromFixture(FIX_VTSE41_CANCEL) ?? FALLBACK_TSUNAMI_CANCEL,
          ),
      },
      {
        label: "観測情報（VTSE51）",
        run: () =>
          displayTsunamiInfo(
            tsunamiFromFixture(FIX_VTSE51_INFO) ?? FALLBACK_TSUNAMI_OBS,
          ),
      },
      {
        label: "沖合観測情報（VTSE52）",
        run: () =>
          displayTsunamiInfo(
            tsunamiFromFixture(FIX_VTSE52_OFFSHORE) ??
              FALLBACK_TSUNAMI_OFFSHORE,
          ),
      },
    ],
  },
  seismicText: {
    label: "地震活動テキスト",
    variants: [
      {
        label: "通常発表",
        run: () => displaySeismicTextInfo(SAMPLE_SEISMIC_TEXT),
      },
      {
        label: "取消",
        run: () =>
          displaySeismicTextInfo(
            seismicTextFromFixture(FIX_VXSE60_CANCEL) ??
              FALLBACK_SEISMIC_TEXT_CANCEL,
          ),
      },
    ],
  },
  nankaiTrough: {
    label: "南海トラフ情報",
    variants: [
      {
        label: "調査中（コード120・critical）",
        run: () => displayNankaiTroughInfo(SAMPLE_NANKAI_TROUGH),
      },
      {
        label: "巨大地震注意（コード130・warning）",
        run: () =>
          displayNankaiTroughInfo(
            nankaiFromFixture(FIX_VYSE50_CAUTION) ?? FALLBACK_NANKAI_CAUTION,
          ),
      },
      {
        label: "調査終了（コード190・info）",
        run: () =>
          displayNankaiTroughInfo(
            nankaiFromFixture(FIX_VYSE50_CLOSED) ?? FALLBACK_NANKAI_CLOSED,
          ),
      },
    ],
  },
  lgObservation: {
    label: "長周期地震動観測",
    variants: [
      {
        label: "長周期階級4（critical）",
        run: () => displayLgObservationInfo(SAMPLE_LG_OBSERVATION),
      },
      {
        label: "長周期階級3（warning）",
        run: () =>
          displayLgObservationInfo(
            lgObsFromFixture(FIX_VXSE62_LGOBS) ?? FALLBACK_LG_OBS_3,
          ),
      },
      {
        label: "長周期階級2（normal）",
        run: () => displayLgObservationInfo(FALLBACK_LG_OBS_2),
      },
    ],
  },
  volcano: {
    label: "火山情報",
    variants: volcanoVariants(),
  },
  weather: {
    label: "気象警報・注意報",
    variants: weatherVariants(),
  },
  tornado: {
    label: "竜巻注意情報",
    variants: tornadoVariants(),
  },
  briefing: {
    label: "気象防災速報",
    variants: briefingVariants(),
  },
  earlyWeather: {
    label: "早期天候情報",
    variants: earlyWeatherVariants(),
  },
  climateInfo: {
    label: "天候情報 (VPZI50/VPCI50)",
    variants: climateInfoVariants(),
  },
  weatherExplanation: {
    label: "気象解説情報 (VPCJ51/VPZJ51/VPFJ51/VMCJ53-55)",
    variants: weatherExplanationVariants(),
  },
  heatAlert: {
    label: "熱中症警戒アラート (VPFT50)",
    variants: heatAlertVariants(),
  },
  typhoonAnalysis: {
    label: "台風解析・予報情報 (VPTW60/61/62)",
    variants: typhoonAnalysisVariants(),
  },
  typhoonProbability: {
    label: "台風の暴風域に入る確率 (VPTA50)",
    variants: typhoonProbabilityVariants(),
  },
  floodForecast: {
    label: "洪水・水位系 (VXKO50/VXSU50)",
    variants: floodForecastVariants(),
  },
};

// ── 火山テストバリエーション ──

function volcanoVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: "45_01_01_200522_VFVO50.xml", label: "噴火警報（Lv3引上げ）" },
    { file: "45_02_01_200522_VFVO50.xml", label: "噴火警報（Lv5引上げ）" },
    { file: "67_01_01_140927_VFVO56.xml", label: "噴火速報" },
    { file: "43_01_01_200522_VFVO52.xml", label: "火山観測報（噴火）" },
    { file: "66_01_02_210514_VFVO54.xml", label: "降灰予報（速報）" },
    { file: "66_01_03_210514_VFVO55.xml", label: "降灰予報（詳細）" },
    { file: "46_01_01_170103_VFSVii.xml", label: "海上警報" },
    { file: "79_01_01_210527_VFVO60.xml", label: "推定噴煙流向報" },
    { file: "42_02_01_071130_VZVO40.xml", label: "火山に関するお知らせ" },
  ];
  const tempState = new VolcanoStateHolder();
  const variants = fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      if (!msg) {
        console.log(`  フィクスチャが見つかりません: ${file}`);
        return;
      }
      const info = parseVolcanoTelegram(msg);
      if (!info) {
        console.log(`  パースに失敗しました: ${file}`);
        return;
      }
      const presentation = resolveVolcanoPresentation(info, tempState);
      displayVolcanoInfo(info, presentation);
    },
  }));
  // VFVO53 バッチ (aggregator 集約結果) は Studio 非対応のため CLI variant が golden の代替担保
  variants.push({
    label: "降灰予報（定時・バッチ合成）",
    run: () => {
      const msg = loadFixture("66_01_01_210517_VFVO53.xml");
      if (!msg) {
        console.log("  フィクスチャが見つかりません: 66_01_01_210517_VFVO53.xml");
        return;
      }
      const info = parseVolcanoTelegram(msg);
      if (!info || info.kind !== "ashfall") {
        console.log("  パースに失敗しました: 66_01_01_210517_VFVO53.xml");
        return;
      }
      const second: ParsedVolcanoAshfallInfo = {
        ...info,
        volcanoName: "合成山",
        volcanoCode: "999",
        ashForecasts: info.ashForecasts.map((p) => ({
          ...p,
          areas: p.areas.map((a) => ({ ...a, ashCode: "73", ashName: "多量" })),
        })),
      };
      const batch: Vfvo53BatchItems = {
        reportDateTime: info.reportDateTime,
        isTest: false,
        items: [info, second],
      };
      displayVolcanoAshfallBatch(batch, resolveVolcanoBatchPresentation(batch));
    },
  });
  return variants;
}

// ── 気象警報・注意報テストバリエーション ──

function weatherVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPWW55_OAME, label: "大雨警報 (VPWW55)" },
    { file: FIX_VPWW56_DOSHA, label: "土砂災害警報 (VPWW56)" },
    { file: FIX_VPWW57_KOCHO, label: "高潮警報 (VPWW57)" },
    { file: FIX_VPWW58_BOFU, label: "暴風警報 (VPWW58)" },
    { file: FIX_VPWW59_HARO, label: "波浪警報 (VPWW59)" },
    { file: FIX_VPWW60_OYUKI, label: "大雪警報 (VPWW60)" },
    { file: FIX_VPWW61_OTHER, label: "その他の警報 (VPWW61)" },
    { file: FIX_VPWS50_AGGREGATE, label: "注意報集約 (VPWS50)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      const outcome = msg == null ? null : processWeatherSample(msg);
      if (outcome == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTestOutcome(outcome, displayWeatherWarning);
    },
  }));
}

// ── 竜巻注意情報テストバリエーション ──

function tornadoVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPHW50_TOKYO, label: "竜巻注意情報 通常発表 (VPHW50・東京)" },
    { file: FIX_VPHW50_ALT, label: "竜巻注意情報 別パターン (VPHW50)" },
    { file: FIX_VPHW51_SIGHTING, label: "竜巻注意情報 目撃情報あり (VPHW51・critical)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      const outcome = msg == null ? null : processTornado(msg);
      if (outcome == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTestOutcome(outcome, displayTornadoAdvisory);
    },
  }));
}

// ── 気象防災速報テストバリエーション ──

function briefingVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPBS50_LINEAR_OBSERVED, label: "線状降水帯 発生 (critical)" },
    { file: FIX_VPBS50_LINEAR_PREDICTED, label: "線状降水帯 予想 (warning)" },
    { file: FIX_VPBS50_RECORD_RAIN, label: "記録的短時間大雨 (critical)" },
    { file: FIX_VPBS50_SHORT_SNOW, label: "短時間大雪 (warning)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      const outcome = msg == null ? null : processBriefing(msg);
      if (outcome == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTestOutcome(outcome, displayWeatherBriefing);
    },
  }));
}

// ── 早期天候情報テストバリエーション ──

function earlyWeatherVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPAW51_HIGH_TEMP, label: "高温" },
    { file: FIX_VPAW51_LOW_TEMP, label: "低温" },
    { file: FIX_VPAW51_HEAVY_SNOW, label: "大雪" },
    { file: FIX_VPAW51_SNOW, label: "雪" },
    { file: FIX_VPAW51_LOWTEMP_HEAVYSNOW, label: "低温と大雪 (複合)" },
    { file: FIX_VPAW51_LOWTEMP_SNOW, label: "低温と雪 (複合)" },
    { file: FIX_VPAW51_HIGHTEMP_HEAVYSNOW, label: "高温と大雪 (複合)" },
    { file: FIX_VPAW51_HIGHTEMP_SNOW, label: "高温と雪 (複合)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      const outcome = msg == null ? null : processEarlyWeather(msg);
      if (outcome == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTestOutcome(outcome, displayEarlyWeatherInfo);
    },
  }));
}

// ── 全般天候情報テストバリエーション ──

function climateInfoVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPZI50_HOT_DRY, label: "全般: 東西日本の長期高温・少雨 (VPZI50)" },
    { file: FIX_VPCI50_KANTO_TSUYU, label: "地方: 関東甲信 梅雨明け (VPCI50)" },
    { file: FIX_VPCI50_TOHOKU_NO_TSUYUAKE, label: "地方: 東北 梅雨明け非発表 (VPCI50)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const msg = loadFixture(file);
      const outcome = msg == null ? null : processClimateInfo(msg);
      if (outcome == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTestOutcome(outcome, displayClimateInfo);
    },
  }));
}

// ── 熱中症警戒アラートテストバリエーション ──

function heatAlertVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPFT50_SAITAMA, label: "埼玉県 発表" },
    { file: FIX_VPFT50_TITLE_ESCALATION, label: "題名昇格 (critical 表示)" },
    { file: FIX_VPFT50_CANCEL, label: "取消" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const info = heatAlertFromFixture(file);
      if (info == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayHeatAlertInfo(info);
    },
  }));
}

// ── 地方気象解説情報テストバリエーション ──

function weatherExplanationVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPCJ51_KANTO_SNOW, label: "地方: 関東甲信 強い冬型・大雪 (VPCJ51)" },
    { file: FIX_VPCJ51_TOHOKU_HOT, label: "地方: 東北 高温 (VPCJ51)" },
    { file: FIX_VPZJ51_SENJOU, label: "全般: 線状降水帯半日前予測 (VPZJ51)" },
    { file: FIX_VPZJ51_TYPHOON, label: "全般: 台風第10号 (VPZJ51)" },
    { file: FIX_VPFJ51_TYPHOON, label: "府県: 東京 台風13号 (VPFJ51)" },
    { file: FIX_VPFJ51_SNOW_INIT, label: "府県: 福井 大雪 初報 (VPFJ51)" },
    { file: FIX_VPFJ51_SNOW_OBS, label: "府県: 福井 大雪 観測実況+予想 (VPFJ51 追加報)" },
    { file: FIX_VPFJ51_SNOW_OBS2, label: "府県: 福井 大雪 観測実況+予想 続報 (VPFJ51)" },
    { file: FIX_VMCJ53_OSHIO, label: "全般: 大潮 (VMCJ53)" },
    { file: FIX_VMCJ54_OSHIO, label: "地方: 九州北部 大潮 (VMCJ54)" },
    { file: FIX_VMCJ55_FUKUSHINDO, label: "府県: 胆振・日高 副振動 (VMCJ55)" },
    { file: FIX_VMCJ55_OSHIO_CHIBA, label: "府県: 千葉 大潮による高い潮位 (VMCJ55)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const info = weatherExplanationFromFixture(file);
      if (info == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayWeatherExplanation(info);
    },
  }));
}

// ── 台風解析・予報情報テストバリエーション ──

function typhoonAnalysisVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPTW60_2020, label: "2020形式 (7コマ)" },
    { file: FIX_VPTW60_2017, label: "2017形式 (14コマ TALIM)" },
    { file: FIX_VPTW61, label: "実況のみ (VPTW61)" },
    { file: FIX_VPTW62, label: "台風発生予想 (VPTW62)" },
    { file: FIX_VPTW60_CANCEL, label: "取消" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const info = typhoonAnalysisFromFixture(file);
      if (info == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTyphoonAnalysisInfo(info);
    },
  }));
}

// ── 台風の暴風域に入る確率テストバリエーション ──

function typhoonProbabilityVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VPTA50_DAMREY, label: "DAMREY (直撃級・max 100%)" },
    { file: FIX_VPTA50_JANGMI_APPROACH, label: "JANGMI 接近段階 (max 100%・≥50%府県:13)" },
    { file: FIX_VPTA50_JANGMI_GONE, label: "JANGMI 暴風域消滅 (全値ゼロ・空状態)" },
    { file: FIX_VPTA50_CANCEL, label: "取消" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const info = typhoonProbabilityFromFixture(file);
      if (info == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayTyphoonProbabilityInfo(info);
    },
  }));
}

// ── 洪水・水位系テストバリエーション ──

function floodForecastVariants(): TestTableEntry["variants"] {
  const fixtures = [
    { file: FIX_VXKO50_16_01_01, label: "Code 20 / L2 氾濫注意報 (3観測所・欠測あり)" },
    { file: FIX_VXKO50_16_02_01, label: "Code 30 / L3 氾濫警報 (3観測所)" },
    { file: FIX_VXKO50_16_02_02, label: "Code 30 / L3 (六角川・複数自治体浸水想定地区)" },
    { file: FIX_VXKO50_16_03_01, label: "Code 30 / L3 (Discharge 流量観測所・condition=一定)" },
    { file: FIX_VXKO50_16_04_01, label: "Code 53 / L5 氾濫特別警報 (氾濫水の予報 5件・critical)" },
    { file: FIX_VXKO50_16_05_01, label: "Code 30 / L3 (Headline-only / Body 空)" },
    { file: FIX_VXKO50_16_06_01, label: "Code 41 / L4 氾濫危険警報 到達 (critical表示/warning音)" },
    { file: FIX_VXKO50_16_07_01, label: "Code 40 / L4 氾濫危険警報 見込み (急激水位上昇)" },
    { file: FIX_VXKO50_16_10_01, label: "複数河川 (緑川水系 4河川グループ化)" },
    { file: FIX_VXKO50_16_11_01, label: "Code 51 / L5 氾濫特別警報 (最上川・critical)" },
    { file: FIX_VXKO50_16_11_02, label: "Code 51 続報 (疑似復旧・Item.Code 1↔2)" },
    { file: FIX_VXKO50_16_12_01, label: "Code 53 / L5 (利根川・浸水想定33件・巨大)" },
    { file: FIX_VXKO50_16_14_01, label: "Code 10 / 解除 (常呂川)" },
    { file: FIX_VXSU50_91_01_01, label: "VXSU50 (善川・L2 注意報・最小layout)" },
    { file: FIX_VXKO50_CANCEL, label: "取消 (VXKO50 synthetic)" },
    { file: FIX_VXKO50_CORRECTION, label: "訂正 (VXKO50 synthetic)" },
    { file: FIX_VXKO50_CODE31, label: "Code 31 / L3 継続 (synthetic)" },
    { file: FIX_VXSU50_CANCEL, label: "取消 (VXSU50 synthetic)" },
  ];
  return fixtures.map(({ file, label }) => ({
    label,
    run: () => {
      const info = floodForecastFromFixture(file);
      if (info == null) {
        console.log(`  フィクスチャの読み込み/パースに失敗しました: ${file}`);
        return;
      }
      displayFloodForecastInfo(info);
    },
  }));
}
