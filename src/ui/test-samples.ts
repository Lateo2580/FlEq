import type {
  ParsedEarthquakeInfo,
  ParsedEewInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
} from "../types";
import {
  displayEarthquakeInfo,
  displayEewInfo,
  displayTsunamiInfo,
  displaySeismicTextInfo,
  displayNankaiTroughInfo,
  displayLgObservationInfo,
} from "./formatter";

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
  warningComment: "津波による被害のおそれがあります。警報が発表された沿岸部や川沿いにいる人はただちに高台や避難ビルなど安全な場所へ避難してください。",
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
  bodyText: "令和６年１月１日16時10分頃の石川県能登地方の地震について\n\n" +
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
  bodyText: "本日、南海トラフ地震の想定震源域でマグニチュード6.8の地震が発生しました。\n" +
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

/** テスト表示ディスパッチマップ (ラベルと実行関数を単一ソースで管理) */
export const TEST_TABLES: Record<string, { label: string; run: () => void }> = {
  earthquake: { label: "地震情報", run: () => displayEarthquakeInfo(SAMPLE_EARTHQUAKE) },
  eew: { label: "緊急地震速報", run: () => displayEewInfo(SAMPLE_EEW, { activeCount: 1, colorIndex: 0 }) },
  tsunami: { label: "津波情報", run: () => displayTsunamiInfo(SAMPLE_TSUNAMI) },
  seismicText: { label: "地震活動テキスト", run: () => displaySeismicTextInfo(SAMPLE_SEISMIC_TEXT) },
  nankaiTrough: { label: "南海トラフ情報", run: () => displayNankaiTroughInfo(SAMPLE_NANKAI_TROUGH) },
  lgObservation: { label: "長周期地震動観測", run: () => displayLgObservationInfo(SAMPLE_LG_OBSERVATION) },
};
