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
  WsDataMessage,
} from "../types";
import { displayEewInfo } from "./eew-formatter";
import {
  displayEarthquakeInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
} from "./earthquake-formatter";
import { displayVolcanoInfo } from "./volcano-formatter";
import {
  parseEarthquakeTelegram,
  parseEewTelegram,
  parseTsunamiTelegram,
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../dmdata/telegram-parser";
import { parseVolcanoTelegram } from "../dmdata/volcano-parser";
import { resolveVolcanoPresentation } from "../engine/notification/volcano-presentation";
import { VolcanoStateHolder } from "../engine/messages/volcano-state";

// ── フィクスチャ読み込みヘルパー ──

/** フィクスチャディレクトリを解決する (dist/ui/ → ../../test/fixtures/) */
function resolveFixturesDir(): string {
  return path.resolve(__dirname, "../../test/fixtures");
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

    const typeMatch = filename.match(/(V[TXYZ]SE\d+|VFVO\d+|VFSVii|VZVO\d+)/);
    const type = typeMatch ? typeMatch[1] : "VXSE53";
    const classification =
      type === "VXSE43"
        ? "eew.warning"
        : type === "VXSE44" || type === "VXSE45"
          ? "eew.forecast"
          : type.startsWith("VFVO") || type.startsWith("VFSV") || type.startsWith("VZVO")
            ? "telegram.volcano"
            : "telegram.earthquake";

    return {
      type: "data",
      version: "2.0",
      classification,
      id: "test-sample-001",
      passing: [{ name: "test", time: new Date().toISOString() }],
      head: {
        type,
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
      xmlReport: {
        control: {
          title: "テスト電文",
          dateTime: new Date().toISOString(),
          status: "通常",
          editorialOffice: "気象庁本庁",
          publishingOffice: "気象庁",
        },
        head: {
          title: "テスト電文",
          reportDateTime: new Date().toISOString(),
          targetDateTime: new Date().toISOString(),
          eventId: null,
          serial: null,
          infoType: "発表",
          infoKind: "テスト",
          infoKindVersion: "1.0_0",
          headline: null,
        },
      },
      format: "xml",
      compression: "gzip",
      encoding: "base64",
      body,
    };
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

// ── 既存ハードコードサンプル (#1: 各タイプのデフォルト) ──

/** 地震情報サンプル */
export const SAMPLE_EARTHQUAKE = {
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/01 00:00:00",
  headline: "１日００時００分ころ、地震がありました。",
  publishingOffice: "気象庁",
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
      { name: "石川県能登", intensity: "7" },
      { name: "新潟県上越", intensity: "6強" },
      { name: "新潟県中越", intensity: "6弱" },
      { name: "富山県東部", intensity: "5強" },
      { name: "富山県西部", intensity: "5弱" },
      { name: "石川県加賀", intensity: "5弱" },
      { name: "福井県嶺北", intensity: "4" },
      { name: "長野県北部", intensity: "4" },
    ],
  },
  tsunami: {
    text: "この地震により、日本の沿岸では若干の海面変動があるかもしれませんが、被害の心配はありません。",
  },
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
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

/** 津波情報サンプル */
export const SAMPLE_TSUNAMI = {
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
  isTest: true,
} satisfies ParsedTsunamiInfo;

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
      { name: "長野県北部", intensity: "4" },
      { name: "長野県中部", intensity: "3" },
    ],
  },
  tsunami: { text: "この地震による津波の心配はありません。" },
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_CANCEL = {
  type: "VXSE53",
  infoType: "取消",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/02 10:05:00",
  headline: "先ほどの地震情報を取り消します。",
  publishingOffice: "気象庁",
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_ENCHI = {
  type: "VXSE53",
  infoType: "発表",
  title: "遠地地震に関する情報",
  reportDateTime: "2024/01/03 08:20:00",
  headline: "日本への津波の影響はありません。",
  publishingOffice: "気象庁",
  earthquake: {
    originTime: "2024/01/03 08:10:00",
    hypocenterName: "台湾付近",
    latitude: "北緯24.0度",
    longitude: "東経121.7度",
    depth: "70km",
    magnitude: "6.9",
  },
  tsunami: { text: "日本への津波の影響はありません。" },
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_SHINDO = {
  type: "VXSE51",
  infoType: "発表",
  title: "震度速報",
  reportDateTime: "2024/01/04 14:00:00",
  headline: "各地の震度に関する情報です。",
  publishingOffice: "気象庁",
  intensity: {
    maxInt: "5弱",
    areas: [
      { name: "石川県能登", intensity: "5弱" },
      { name: "富山県東部", intensity: "4" },
      { name: "新潟県上越", intensity: "4" },
    ],
  },
  isTest: true,
} satisfies ParsedEarthquakeInfo;

const FALLBACK_EARTHQUAKE_LG = {
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024/01/05 19:30:00",
  headline: "関東地方で長周期地震動階級4を観測しました。",
  publishingOffice: "気象庁",
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
      { name: "東京都23区", intensity: "5強", lgIntensity: "4" },
      { name: "千葉県北西部", intensity: "5弱", lgIntensity: "3" },
      { name: "神奈川県東部", intensity: "4", lgIntensity: "3" },
    ],
  },
  tsunami: { text: "この地震による津波の心配はありません。" },
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
  isTest: true,
  isWarning: false,
} satisfies ParsedEewInfo;

const FALLBACK_TSUNAMI_MAJOR = {
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
  isTest: true,
} satisfies ParsedTsunamiInfo;

const FALLBACK_TSUNAMI_ADVISORY = {
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
  isTest: true,
} satisfies ParsedTsunamiInfo;

const FALLBACK_TSUNAMI_CANCEL = {
  type: "VTSE41",
  infoType: "取消",
  title: "大津波警報・津波警報・津波注意報",
  reportDateTime: "2024/01/02 04:30:00",
  headline: "津波警報等を解除しました。",
  publishingOffice: "気象庁",
  warningComment: "現在、津波の心配はありません。",
  isTest: true,
} satisfies ParsedTsunamiInfo;

const FALLBACK_TSUNAMI_OBS = {
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
  isTest: true,
} satisfies ParsedTsunamiInfo;

const FALLBACK_TSUNAMI_OFFSHORE = {
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
  isTest: true,
} satisfies ParsedTsunamiInfo;

const FALLBACK_SEISMIC_TEXT_CANCEL = {
  type: "VXSE60",
  infoType: "取消",
  title: "地震回数に関する情報",
  reportDateTime: "2024/01/02 12:30:00",
  headline: "先ほどの情報を取り消します。",
  publishingOffice: "気象庁",
  bodyText: "先ほど発表した地震回数に関する情報は取り消します。",
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
  return fixtures.map(({ file, label }) => ({
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
}
