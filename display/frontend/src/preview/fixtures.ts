// デザイン目視ゲート用フィクスチャ。SSE 接続を使わず、現実的な日本語コンテンツで
// 各画面パターンを再現する。protocol.ts の型に厳密準拠する (any 禁止)。
import type { WeatherEmergencyInputV1 } from "../lib/weather-panel";
import {
  DISPLAY_PROTOCOL_VERSION,
  type ActiveStandbyCardV1,
  type DisplayActiveEewV1,
  type DisplayConnectionStateV1,
  type DisplayEewInputV1,
  type DisplayEewRegionV1,
  type DisplayEventDtoV1,
  type DisplayFloodHydrographV1,
  type DisplayIntensityGroupV1,
  type DisplayLargeQuakeInputV1,
  type DisplayLargeQuakeStateV1,
  type DisplayLatestQuakeStateV1,
  type DisplayRecentQuakeV1,
  type DisplayStateSnapshotV1,
  type DisplayStatsV1,
  type DisplayTsunamiInputV1,
  type DisplayTsunamiObservationV1,
  type DisplayTsunamiStateV1,
  type DisplayWeatherAlertV1,
} from "../lib/protocol";

const NOW_ISO = "2026-07-07T14:32:00+09:00";
const NOW_MS = Date.parse(NOW_ISO);

export const recentQuakes: DisplayRecentQuakeV1[] = [
  {
    eventId: "quake-recent-1",
    reportDateTime: NOW_ISO,
    originTime: "2026-07-07T14:28:00+09:00",
    hypocenterName: "宮城県沖",
    magnitude: "4.8",
    maxInt: "3",
    maxIntRank: 3,
    depth: "50km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-recent-2",
    reportDateTime: "2026-07-07T12:10:00+09:00",
    originTime: "2026-07-07T12:06:00+09:00",
    hypocenterName: "千葉県東方沖",
    magnitude: "4.2",
    maxInt: "2",
    maxIntRank: 2,
    depth: "60km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-recent-3",
    reportDateTime: "2026-07-07T09:45:00+09:00",
    originTime: "2026-07-07T09:41:00+09:00",
    hypocenterName: "和歌山県北部",
    magnitude: "3.1",
    maxInt: "1",
    maxIntRank: 1,
    depth: "10km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-recent-4",
    reportDateTime: "2026-07-06T23:52:00+09:00",
    originTime: "2026-07-06T23:48:00+09:00",
    hypocenterName: "与那国島近海",
    magnitude: "5.2",
    maxInt: "3",
    maxIntRank: 3,
    depth: "20km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-recent-5",
    reportDateTime: "2026-07-06T18:20:00+09:00",
    originTime: "2026-07-06T18:16:00+09:00",
    hypocenterName: "岐阜県美濃中西部",
    magnitude: "2.9",
    maxInt: "1",
    maxIntRank: 1,
    depth: "ごく浅い",
    tsunamiWarning: false,
  },
];

// standby-rich シナリオ用: 数字チップ・深さ・時刻・津波マークのバリエーションを一望できる 5 件
export const recentQuakesRich: DisplayRecentQuakeV1[] = [
  {
    eventId: "quake-rich-1",
    reportDateTime: NOW_ISO,
    originTime: "2026-07-07T14:28:00+09:00",
    hypocenterName: "日向灘",
    magnitude: "6.3",
    maxInt: "5弱",
    maxIntRank: 5,
    depth: "20km",
    tsunamiWarning: true,
  },
  {
    eventId: "quake-rich-2",
    reportDateTime: "2026-07-07T12:10:00+09:00",
    originTime: "2026-07-07T12:06:00+09:00",
    hypocenterName: "千葉県東方沖",
    magnitude: "4.2",
    maxInt: "2",
    maxIntRank: 2,
    depth: "60km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-rich-3",
    reportDateTime: "2026-07-07T09:45:00+09:00",
    originTime: "2026-07-07T09:41:00+09:00",
    hypocenterName: "和歌山県北部",
    magnitude: "3.1",
    maxInt: "1",
    maxIntRank: 1,
    depth: "10km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-rich-4",
    reportDateTime: "2026-07-06T23:52:00+09:00",
    originTime: "2026-07-06T23:48:00+09:00",
    hypocenterName: "与那国島近海",
    magnitude: "5.2",
    maxInt: "3",
    maxIntRank: 3,
    depth: "20km",
    tsunamiWarning: false,
  },
  {
    eventId: "quake-rich-5",
    reportDateTime: "2026-07-06T18:20:00+09:00",
    originTime: "2026-07-06T18:16:00+09:00",
    hypocenterName: "岐阜県美濃中西部",
    magnitude: "2.9",
    maxInt: "1",
    maxIntRank: 1,
    depth: "ごく浅い",
    tsunamiWarning: false,
  },
];

export const weatherAlerts: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: 12,
    items: [
      {
        kind: "大雨警報(土砂災害)",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["熊本県山鹿市", "熊本県菊池市", "熊本県玉名市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
  {
    source: "vpws50",
    label: "洪水警報",
    role: "weatherWarning",
    totalAreas: 3,
    items: [
      {
        kind: "洪水警報",
        displaySeverity: "nonLevelWarning",
        rank: "warning",
        shownAreas: ["熊本県球磨川流域"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
];

// standby-cards シナリオ用: 気象警報カードの全ロール (特別警報/警報×2) を一望する。
// サーバは注意報 (weatherAdvisory) を気象カードに載せず警報・特別警報のみ配信するため
// 注意報バケツは含めない (注意報はテロップが伝える)。
// 通常運用は「省略なしの全地域表示」なので、特別警報バケツも omittedAreaCount: 0 で
// 都道府県を跨いだ複数地域をフル列挙し、都道府県 → 市区町村の階層表示を確認できるようにする
export const weatherAlertsStandbyCards: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨特別警報",
    role: "weatherEmergency",
    totalAreas: 8,
    items: [
      {
        kind: "大雨特別警報(土砂災害)",
        displaySeverity: "officialL5",
        rank: "emergency",
        shownAreas: [
          "宮崎県延岡市",
          "宮崎県日向市",
          "宮崎県門川町",
          "熊本県山鹿市",
          "熊本県菊池市",
          "大分県佐伯市",
          "大分県津久見市",
          "鹿児島県霧島市",
        ],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: 12,
    items: [
      {
        kind: "大雨警報(土砂災害)",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["熊本県山鹿市", "熊本県菊池市", "熊本県玉名市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
  {
    source: "vpws50",
    label: "洪水警報",
    role: "weatherWarning",
    totalAreas: 3,
    items: [
      {
        kind: "洪水警報",
        displaySeverity: "nonLevelWarning",
        rank: "warning",
        shownAreas: ["熊本県球磨川流域"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
];

// B2a 目視用: 気象警報のみ (最高ランク=warning → 気象警報ヘッダ container)
export const weatherWarningOnlyStandbyCards: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: 12,
    items: [
      {
        kind: "大雨警報(土砂災害)",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["熊本県山鹿市", "熊本県菊池市", "熊本県玉名市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
];

/** 従来フォーマット改良 v16 の行単位展開用。compact の先頭3地域を含む完全 prefix。 */
export const legacyImprovedWeatherAlertsExpanded: DisplayWeatherAlertV1[] = [
  {
    ...weatherWarningOnlyStandbyCards[0],
    totalAreas: 12,
    items: [{
      ...weatherWarningOnlyStandbyCards[0].items[0],
      shownAreas: [
        "熊本県山鹿市", "熊本県菊池市", "熊本県玉名市", "宮崎県延岡市", "宮崎県日向市",
        "大分県佐伯市", "鹿児島県霧島市", "福岡県朝倉市", "佐賀県嬉野市", "長崎県諫早市",
        "熊本県阿蘇市", "宮崎県都城市",
      ],
      omittedAreaCount: 0,
    }],
  },
];

// B2a 目視用: 気象注意報のみ (最高ランク=advisory → 気象注意報ヘッダ container)
export const weatherAdvisoryOnlyStandbyCards: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "雷注意報",
    role: "weatherAdvisory",
    totalAreas: 5,
    items: [
      {
        kind: "雷注意報",
        displaySeverity: "advisory",
        rank: "advisory",
        shownAreas: ["熊本県山鹿市", "熊本県菊池市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: NOW_ISO,
  },
];

// standby-cards シナリオ用: 地震情報カードの headline あり・地区別震度 2 グループ・津波マークありを一望する
export const latestQuakeStandbyCards: DisplayLatestQuakeStateV1 = {
  eventId: "quake-latest-standby",
  headline: "宮崎県で震度6弱を観測。この地震により津波警報が発表されています。",
  originTime: "2026-07-07T14:20:00+09:00",
  hypocenterName: "日向灘",
  depth: "20km",
  magnitude: "7.1",
  maxInt: "6弱",
  maxIntRank: 7,
  tsunamiWarning: true,
  intensityGroups: [
    { intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
    { intensity: "5強", rank: 6, areas: ["都城市", "延岡市"], omittedAreaCount: 3 },
  ],
  reportDateTime: NOW_ISO,
  updatedAtMs: NOW_MS,
};

/** 従来フォーマット改良 v4 の展開確認用。震度5強の省略3地域を完全列挙する。 */
export const legacyImprovedExpandedLatestQuake: DisplayLatestQuakeStateV1 = {
  ...latestQuakeStandbyCards,
  intensityGroups: latestQuakeStandbyCards.intensityGroups.map((group) =>
    group.intensity === "5強"
      ? {
          ...group,
          areas: [...group.areas, "西都市", "えびの市", "高鍋町"],
          omittedAreaCount: 0,
        }
      : group,
  ),
};

// standby-cards シナリオ用: 計器列 (直近30分スパークライン・受信数・本日地震・最大震度)
export const statsStandbyCards: DisplayStatsV1 = {
  sparklineData: [
    1, 0, 2, 1, 3, 2, 4, 3, 5, 4, 6, 5, 7, 9, 8, 6, 5, 7, 10, 8, 6, 4, 5, 3, 4, 2, 3, 1, 2, 1,
  ],
  totalReceived: 128,
  todayQuakeCount: 6,
  todayMaxInt: "6弱",
  todayMaxIntRank: 7,
};

const eewWarningRegions: DisplayEewRegionV1[] = [
  { name: "宮崎県", intensity: "6弱", intensityTo: "6強", isPlum: false, hasArrived: true, arrivalTime: "2026-07-07T14:32:10+09:00" },
  { name: "大分県", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-07T14:32:18+09:00" },
  { name: "熊本県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:10+09:00" },
  { name: "鹿児島県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:18+09:00" },
  { name: "高知県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:25+09:00" },
  { name: "愛媛県", intensity: "5弱", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:40+09:00" },
  { name: "山口県", intensity: "4", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
  { name: "福岡県", intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:55+09:00" },
  { name: "佐賀県", intensity: "4", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
];

const eewWarningInput: DisplayEewInputV1 = {
  kind: "eew",
  eventId: "eew-demo-warning",
  serial: "8",
  isWarning: true,
  isFinal: false,
  isCancellation: false,
  hypocenterName: "日向灘",
  forecastMaxInt: "6弱",
  forecastMaxIntRank: 7,
  magnitude: "7.1",
  colorIndex: null,
  reportDateTime: NOW_ISO,
  originTime: NOW_ISO,
  isAssumedHypocenter: false,
  depth: "20km",
  maxLgInt: "3",
  regions: eewWarningRegions,
};

const eewForecastRegions: DisplayEewRegionV1[] = [
  { name: "岩手県", intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:32:50+09:00" },
  { name: "宮城県", intensity: "3", intensityTo: "4", isPlum: false, hasArrived: false, arrivalTime: "2026-07-07T14:33:05+09:00" },
  { name: "福島県", intensity: "3", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
];

const eewForecastInput: DisplayEewInputV1 = {
  kind: "eew",
  eventId: "eew-demo-forecast",
  serial: "3",
  isWarning: false,
  isFinal: false,
  isCancellation: false,
  hypocenterName: "三陸沖",
  forecastMaxInt: "4",
  forecastMaxIntRank: 4,
  magnitude: "5.6",
  colorIndex: null,
  reportDateTime: NOW_ISO,
  originTime: NOW_ISO,
  isAssumedHypocenter: false,
  depth: "30km",
  maxLgInt: null,
  regions: eewForecastRegions,
};

export const eewWarning: DisplayActiveEewV1 = { ...eewWarningInput, updatedAtMs: NOW_MS };
export const eewForecast: DisplayActiveEewV1 = { ...eewForecastInput, updatedAtMs: NOW_MS };

const tsunamiAdvisoryObservations: DisplayTsunamiObservationV1[] = [
  {
    areaName: "和歌山県", areaKind: "津波注意報", stationName: "串本",
    arrivalTime: "2026-07-07T14:50:00+09:00", initial: "押し", maxHeightValue: "0.3m", condition: "観測中",
  },
  {
    areaName: "三重県南部", areaKind: "津波注意報", stationName: "尾鷲",
    arrivalTime: "2026-07-07T14:55:00+09:00", initial: null, maxHeightValue: null, condition: "観測中",
  },
];

const tsunamiAdvisoryInput: DisplayTsunamiInputV1 = {
  kind: "tsunami",
  level: "advisory",
  levelLabel: "津波注意報",
  coasts: [
    { name: "和歌山県", kind: "津波注意報", maxHeight: "1m", firstHeight: "既に到達と推測" },
    { name: "徳島県", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日15時00分頃" },
    { name: "三重県南部", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日14時50分頃" },
  ],
  warningComment: "潮位変化は観測されてから数時間以上続くことがあります",
  observations: tsunamiAdvisoryObservations,
  reportDateTime: NOW_ISO,
};

const tsunamiWarningObservations: DisplayTsunamiObservationV1[] = [
  {
    areaName: "宮崎県", areaKind: "津波警報", stationName: "油津",
    arrivalTime: "2026-07-07T14:45:00+09:00", initial: "押し", maxHeightValue: "1.8m", condition: "上昇中",
  },
  {
    areaName: "大分県瀬戸内海沿岸", areaKind: "津波警報", stationName: "佐伯",
    arrivalTime: "2026-07-07T14:48:00+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
  },
  {
    areaName: null, areaKind: null, stationName: "日向灘沖GPS波浪計",
    arrivalTime: "2026-07-07T14:40:00+09:00", initial: "押し", maxHeightValue: "2.5m", condition: "観測中",
  },
];

const tsunamiWarningInput: DisplayTsunamiInputV1 = {
  kind: "tsunami",
  level: "warning",
  levelLabel: "津波警報",
  coasts: [
    { name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
    { name: "大分県瀬戸内海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時10分頃" },
    { name: "愛媛県宇和海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時20分頃" },
    { name: "鹿児島県東部", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
  ],
  warningComment: "満潮と重なるとより高くなりますので一層厳重な警戒が必要です",
  observations: tsunamiWarningObservations,
  reportDateTime: NOW_ISO,
};

const tsunamiMajorObservations: DisplayTsunamiObservationV1[] = [
  {
    areaName: "宮崎県", areaKind: "大津波警報", stationName: "細島",
    arrivalTime: "2026-07-07T14:30:00+09:00", initial: "押し", maxHeightValue: "8.5m", condition: "上昇中",
  },
  {
    areaName: "高知県", areaKind: "大津波警報", stationName: "室戸岬",
    arrivalTime: "2026-07-07T14:35:00+09:00", initial: "押し", maxHeightValue: "6.2m", condition: "上昇中",
  },
];

const tsunamiMajorInput: DisplayTsunamiInputV1 = {
  kind: "tsunami",
  level: "majorWarning",
  levelLabel: "大津波警報",
  coasts: [
    { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
    { name: "高知県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
    { name: "大分県瀬戸内海沿岸", kind: "大津波警報", maxHeight: "5m", firstHeight: "07日15時05分頃" },
    { name: "愛媛県宇和海沿岸", kind: "大津波警報", maxHeight: "5m", firstHeight: "07日15時10分頃" },
    { name: "鹿児島県東部", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
    { name: "種子島・屋久島地方", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
    { name: "奄美群島・トカラ列島", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時20分頃" },
    { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日15時40分頃" },
  ],
  warningComment: "巨大津波のおそれ。直ちに高台等安全な場所へ避難してください",
  observations: tsunamiMajorObservations,
  reportDateTime: NOW_ISO,
};

export const tsunamiAdvisory: DisplayTsunamiStateV1 = {
  ...tsunamiAdvisoryInput,
  updatedAtMs: NOW_MS,
};

// standby-tsunami シナリオ用: 待機画面の津波継続バナーが「複数レベル混在 + 多地域 + 観測あり」を
// 一望できるよう、大津波警報/津波警報/津波注意報が別地域に混在した状態を用意する (Phase 2)
const tsunamiBannerCoasts: DisplayTsunamiInputV1["coasts"] = [
  { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
  { name: "高知県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
  { name: "大分県瀬戸内海沿岸", kind: "大津波警報", maxHeight: "5m", firstHeight: "07日15時05分頃" },
  { name: "愛媛県宇和海沿岸", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時10分頃" },
  { name: "鹿児島県東部", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
  { name: "種子島・屋久島地方", kind: "津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
  { name: "奄美群島・トカラ列島", kind: "津波警報", maxHeight: "3m", firstHeight: "07日15時20分頃" },
  { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日15時40分頃" },
  { name: "宮古島・八重山地方", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日16時00分頃" },
  { name: "大東島地方", kind: "津波注意報", maxHeight: "1m", firstHeight: "07日16時10分頃" },
];

export const tsunamiBanner: DisplayTsunamiStateV1 = {
  kind: "tsunami",
  level: "majorWarning",
  levelLabel: "大津波警報",
  coasts: tsunamiBannerCoasts,
  warningComment: "巨大津波のおそれ。直ちに高台等安全な場所へ避難してください",
  observations: tsunamiMajorObservations,
  reportDateTime: NOW_ISO,
  updatedAtMs: NOW_MS,
};
export const tsunamiWarning: DisplayTsunamiStateV1 = {
  ...tsunamiWarningInput,
  updatedAtMs: NOW_MS,
};
export const tsunamiMajor: DisplayTsunamiStateV1 = {
  ...tsunamiMajorInput,
  updatedAtMs: NOW_MS,
};

const largeQuakeIntensityGroups: DisplayIntensityGroupV1[] = [
  { intensity: "6強", rank: 8, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
  { intensity: "6弱", rank: 7, areas: ["都城市", "延岡市", "串間市"], omittedAreaCount: 0 },
  { intensity: "5強", rank: 6, areas: ["鹿児島県大隅", "高知県西部"], omittedAreaCount: 0 },
  { intensity: "5弱", rank: 5, areas: ["大分県南部", "熊本県球磨"], omittedAreaCount: 0 },
  { intensity: "4", rank: 4, areas: ["福岡県", "佐賀県", "長崎県 ほか"], omittedAreaCount: 0 },
  { intensity: "3", rank: 3, areas: ["山口県", "広島県 ほか"], omittedAreaCount: 0 },
];

const largeQuakeInput: DisplayLargeQuakeInputV1 = {
  kind: "largeQuake",
  eventId: "quake-demo-large",
  originTime: "2026-07-07T14:20:00+09:00",
  hypocenterName: "日向灘",
  magnitude: "7.1",
  maxInt: "6強",
  maxIntRank: 8,
  intensityGroups: largeQuakeIntensityGroups,
  reportDateTime: NOW_ISO,
  depth: "20km",
  maxLgInt: "3",
  tsunamiWarning: true,
};

export const largeQuake: DisplayLargeQuakeStateV1 = { ...largeQuakeInput, updatedAtMs: NOW_MS };

// 緊急パネル用の入力単体 (updatedAtMs を持たない DisplayEmergencyInputV1 union) を再利用できるよう公開する
export { eewWarningInput, eewForecastInput, tsunamiMajorInput, tsunamiWarningInput, tsunamiAdvisoryInput, largeQuakeInput };

export const connectionConnected: DisplayConnectionStateV1 = {
  dmdata: "connected",
  lastReceivedAt: NOW_ISO,
  disconnectedSince: null,
  reason: null,
};

let tickerSeq = 1;
export function tickerLine(args: {
  id: string;
  role: DisplayEventDtoV1["summary"]["role"];
  frameLevel: DisplayEventDtoV1["frameLevel"];
  text: string;
  title: string;
  domain: string;
  type: string;
  isCancellation?: boolean;
  emergency?: DisplayEventDtoV1["emergency"];
  recentQuake?: DisplayEventDtoV1["recentQuake"];
  latestQuake?: DisplayEventDtoV1["latestQuake"];
  tickerDetail?: string | null;
  tickerCategory?: string | null;
  tickerSentence?: string | null;
  tickerBody?: string | null;
  tickerPriority?: DisplayEventDtoV1["tickerPriority"];
  tickerSurface?: DisplayEventDtoV1["tickerSurface"];
  groupKey?: string | null;
}): DisplayEventDtoV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: tickerSeq++,
    id: args.id,
    eventKey: args.id,
    groupKey: args.groupKey ?? null,
    domain: args.domain,
    type: args.type,
    infoType: "発表",
    reportDateTime: NOW_ISO,
    title: args.title,
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: args.frameLevel,
    isCancellation: args.isCancellation ?? false,
    summary: { text: args.text, role: args.role },
    emergency: args.emergency ?? null,
    recentQuake: args.recentQuake ?? null,
    latestQuake: args.latestQuake ?? null,
    tickerDetail: args.tickerDetail ?? null,
    tickerCategory: args.tickerCategory ?? null,
    tickerSentence: args.tickerSentence ?? null,
    tickerBody: args.tickerBody ?? null,
    tickerPriority: args.tickerPriority ?? null,
    tickerSurface: args.tickerSurface ?? "none",
  };
}

// 全ロールを網羅 (DisplayColorRole 全 17 種)
export const tickerLines: DisplayEventDtoV1[] = [
  tickerLine({
    id: "ticker-critical",
    role: "critical",
    frameLevel: "critical",
    text: "[重大] 緊急地震速報(警報) 日向灘 M7.1 最大震度6弱",
    title: "緊急地震速報(警報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewWarningInput,
    tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
  }),
  tickerLine({
    id: "ticker-warning",
    role: "warning",
    frameLevel: "warning",
    text: "[警告] 大雨警報 熊本県: 山鹿市、菊池市 ほか12市町村",
    title: "大雨警報",
    domain: "weather",
    type: "VPWW50",
    tickerDetail: "土砂災害に警戒してください ▪ 大雨警報(土砂災害): 山鹿市、菊池市、玉名市",
    tickerCategory: "気象警報・注意報",
    tickerSentence: "熊本県に大雨警報（土砂災害）が発表されています。土砂災害に警戒してください。",
  }),
  tickerLine({
    id: "ticker-normal",
    role: "normal",
    frameLevel: "normal",
    text: "[通常] 震源・震度情報 宮城県沖 M4.8 震度3",
    title: "震源・震度情報",
    domain: "quake",
    type: "VXSE53",
    recentQuake: recentQuakes[0],
    tickerDetail: "震度3: 石巻市、東松島市／震度2: 仙台市、名取市",
    tickerCategory: "地震情報",
    tickerSentence:
      "午後9時37分ごろ、宮城県沖を震源とするマグニチュード4.8の地震がありました。石巻市・東松島市で最大震度3を観測しています。",
  }),
  tickerLine({
    id: "ticker-info",
    role: "info",
    frameLevel: "info",
    text: "[情報] 震源・震度情報 岐阜県美濃中西部 M2.9 震度1",
    title: "震源・震度情報",
    domain: "quake",
    type: "VXSE51",
    recentQuake: recentQuakes[4],
    tickerCategory: "地震情報",
    tickerSentence: "午後6時16分ごろ、岐阜県美濃中西部を震源とするマグニチュード2.9の地震がありました。最大震度1を観測しています。",
  }),
  tickerLine({
    id: "ticker-cancel",
    role: "cancel",
    frameLevel: "cancel",
    text: "[解除] 大雨警報 熊本県 解除",
    title: "大雨警報 解除",
    domain: "weather",
    type: "VPWW50",
    isCancellation: true,
    tickerCategory: "気象警報・注意報",
    tickerSentence: "熊本県の大雨警報は解除されました。",
  }),
  tickerLine({
    id: "ticker-eew-warning",
    role: "eewWarning",
    frameLevel: "critical",
    text: "[EEW警告] 日向灘 M7.1 最大震度6弱 第8報",
    title: "緊急地震速報(警報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewWarningInput,
    tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
  }),
  tickerLine({
    id: "ticker-eew-forecast",
    role: "eewForecast",
    frameLevel: "warning",
    text: "[EEW予報] 三陸沖 M5.6 最大震度4 第3報",
    title: "緊急地震速報(予報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewForecastInput,
    tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報(予報) #3: 三陸沖でM5.6の地震　予想最大震度4",
  }),
  tickerLine({
    id: "ticker-tsunami-major",
    role: "tsunamiMajor",
    frameLevel: "critical",
    text: "[大津波警報] 宮崎県・高知県 ほか6地方に発表",
    title: "大津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiMajorInput,
    tickerCategory: "津波情報",
    tickerSentence:
      "宮崎県・高知県など5予報区に大津波警報　巨大津波のおそれ。直ちに高台等安全な場所へ避難してください。",
  }),
  tickerLine({
    id: "ticker-tsunami-warning",
    role: "tsunamiWarning",
    frameLevel: "warning",
    text: "[津波警報] 宮崎県・大分県瀬戸内海沿岸 ほか2地方に発表",
    title: "津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiWarningInput,
    tickerDetail: "満潮と重なるとより高くなりますので一層厳重な警戒が必要です ▪ 津波警報: 宮崎県、大分県瀬戸内海沿岸、愛媛県宇和海沿岸、鹿児島県東部",
    tickerCategory: "津波情報",
    tickerSentence:
      "宮崎県・大分県瀬戸内海沿岸など4予報区に津波警報　満潮と重なるとより高くなりますので一層厳重な警戒が必要です。",
  }),
  tickerLine({
    id: "ticker-tsunami-advisory",
    role: "tsunamiAdvisory",
    frameLevel: "normal",
    text: "[津波注意報] 和歌山県・徳島県に発表",
    title: "津波注意報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiAdvisoryInput,
    tickerCategory: "津波情報",
    tickerSentence: "和歌山県・徳島県など3予報区に津波注意報　潮位変化は観測されてから数時間以上続くことがあります。",
  }),
  tickerLine({
    id: "ticker-quake-major",
    role: "quakeMajor",
    frameLevel: "critical",
    text: "[震度速報] 日向灘 M7.1 最大震度6強",
    title: "震度速報",
    domain: "quake",
    type: "VXSE53",
    emergency: largeQuakeInput,
    tickerCategory: "地震情報",
    tickerSentence: "午後2時20分ごろ、日向灘を震源とするマグニチュード7.1の地震がありました。宮崎市・日南市で最大震度6強を観測しています。",
  }),
  tickerLine({
    id: "ticker-weather-warning",
    role: "weatherWarning",
    frameLevel: "warning",
    text: "[警報] 洪水警報 熊本県: 球磨川流域 ほか2市町村",
    title: "洪水警報",
    domain: "weather",
    type: "VPWW50",
    tickerDetail: "洪水警報: 球磨川流域、川辺川流域",
    tickerCategory: "気象警報・注意報",
    tickerSentence: "熊本県に洪水警報が発表されています。",
  }),
  // フォールバック目視確認用: tickerSentence を意図的に持たせない。
  // フロントは tickerCategory はあるが tickerSentence が null のため、従来の
  // tickerDetail/summary 連結表示にフォールバックするはず。
  tickerLine({
    id: "ticker-weather-advisory",
    role: "weatherAdvisory",
    frameLevel: "normal",
    text: "[注意報] 雷注意報 熊本県全域",
    title: "雷注意報",
    domain: "weather",
    type: "VPWW50",
    tickerCategory: "気象警報・注意報",
  }),
  tickerLine({
    id: "ticker-weather-nationwide",
    role: "weatherWarning",
    frameLevel: "warning",
    text: "[警報] 気象警報・注意報 全国集約",
    title: "気象警報・注意報（全国集約）",
    domain: "weather",
    type: "VPWS50",
    tickerCategory: "気象警報・注意報（全国集約）",
    tickerSentence: "現在、大雨警報が鹿児島県に、波浪注意報が茨城県・千葉県・神奈川県など12都県に発表されています。",
  }),
  tickerLine({
    id: "ticker-weather-emergency",
    role: "weatherEmergency",
    frameLevel: "critical",
    text: "[特別警報] 大雨特別警報 熊本県",
    title: "気象特別警報",
    domain: "weather",
    type: "VPWW54",
    tickerCategory: "気象特別警報",
    tickerSentence: "熊本県に大雨特別警報が発表されています。命を守る行動をとってください。",
  }),
  tickerLine({
    id: "ticker-connection-ok",
    role: "connectionOk",
    frameLevel: "info",
    text: "[接続] dmdata 接続中",
    title: "接続状態",
    domain: "system",
    type: "SYSTEM",
    tickerCategory: "接続状態",
  }),
  tickerLine({
    id: "ticker-connection-stale",
    role: "connectionStale",
    frameLevel: "warning",
    text: "[接続] 受信が滞っています",
    title: "接続状態",
    domain: "system",
    type: "SYSTEM",
    tickerCategory: "接続状態",
  }),
  // preview 専用の muted 見本 (実機目視フィードバック 2026-07-11「『補足情報』とだけ出て
  // 何の補足かわからない」)。実電文に muted テロップ生成経路は無く、これは全 17 role の表示確認用の
  // placeholder。見本と読み取れる文面にする (role="muted" は 17 role 網羅テストのため維持)。
  tickerLine({
    id: "ticker-muted",
    role: "muted",
    frameLevel: "info",
    text: "[見本] muted ロール 表示確認用テキスト",
    title: "プレビュー見本",
    domain: "system",
    type: "SYSTEM",
    tickerCategory: "気象庁情報",
    tickerSentence: "(プレビュー見本) muted ロールの走行文字・チップ表示を確認するためのサンプルです。",
  }),
];

export function standbySnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    generatedAt: NOW_ISO,
    seq: 1,
    activeEews: [],
    tsunami: null,
    largeQuakes: [],
    weatherAlerts: [],
    recentQuakes,
    latestQuake: null,
    stats: null,
    severityTier: "calm",
    connection: connectionConnected,
    recentTicker: tickerLines,
    ...over,
  };
}

/** backgroundTone の実レンダー一覧用。各セルは本番と同じ snapshot 属性経路を使う。 */
export const backgroundTonePreviewFixtures = [
  "calm", "caution", "alert", "critical", "quakeExtreme",
] as const satisfies readonly NonNullable<DisplayStateSnapshotV1["backgroundTone"]>[];

// ============================================================================
// 長文テロップ目視シナリオ (#standby-longbody)
// tickerBody (解説全文・VPTA 構造化長文) がフロントで 60-100 字セグメントに分割されて
// 流れることを目視確認する。VPTA は句点が無く読点のみの 600 字級 (前回挙げた分割の懸念ケース)。
// reduced-motion では全文がページ静止送りで読めることも同シーンで確認する (prefers-reduced-motion)。
const VPTA_LONG_BODY =
  "ダムレイ（台風01号）の暴風域に入る確率（府県内最大・5日積算・カッコ内はピーク時間帯）：" +
  [
    "奄美市 100%（1日18時）", "那覇市 100%（1日18時）",
    "南大東村 100%（1日09時）", "対馬市 99%（2日21時）",
    "天草市 99%（2日21時）", "枕崎市 99%（2日21時）",
    "福岡市 98%（3日00時）", "佐賀市 98%（2日21時）",
    "佐伯市 97%（3日00時）", "下関市 95%（3日03時）",
    "宮崎市 95%（2日21時）", "浜田市 92%（3日03時）",
    "広島市 91%（3日03時）", "松山市 86%（3日00時）",
  ].join("、") + "。";

const WEATHER_EXPLANATION_LONG_BODY =
  "【概況】前線を伴った低気圧が急速に発達しながら日本海を東北東へ進んでいます。この低気圧に向かって暖かく湿った空気が流れ込み、大気の状態が非常に不安定になっています。" +
  "【防災事項】西日本から東日本の広い範囲で、局地的に雷を伴った激しい雨が降るおそれがあります。土砂災害、低い土地の浸水、河川の増水や氾濫に警戒してください。" +
  "【付加情報】施設や作業現場などの安全確認、避難経路の確認など、早めの防災対応を心がけてください。今後の気象情報や自治体の発表する避難情報に注意してください。";

export const tickerLinesLongBody: DisplayEventDtoV1[] = [
  tickerLine({
    id: "lb-weather-explanation", role: "normal", frameLevel: "normal",
    text: "気象解説情報", title: "全般気象解説情報", domain: "weatherExplanation", type: "VPZJ51",
    tickerCategory: "気象解説情報", tickerPriority: "low", groupKey: "weatherExplanation:JPTK000001",
    tickerSentence: "急速に発達する低気圧に関する全般気象情報が発表されています。",
    tickerBody: WEATHER_EXPLANATION_LONG_BODY,
  }),
  tickerLine({
    id: "lb-typhoon-probability", role: "normal", frameLevel: "normal",
    text: "台風の暴風域に入る確率", title: "台風の暴風域に入る確率", domain: "typhoonProbability", type: "VPTA50",
    tickerCategory: "台風情報", tickerPriority: "low", groupKey: "typhoonProbability:TC0001",
    tickerSentence: "台風第1号の暴風域に入る確率が発表されています。",
    tickerBody: VPTA_LONG_BODY,
  }),
  tickerLine({
    id: "lb-eew-high", role: "eewWarning", frameLevel: "critical",
    text: "[重大] 緊急地震速報(警報) 日向灘 M7.1 最大震度6弱", title: "緊急地震速報(警報)",
    domain: "eew", type: "VXSE45", emergency: eewWarningInput,
    tickerCategory: "緊急地震速報", tickerPriority: "high",
    tickerSentence: "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
  }),
];

export function longBodyStandbySnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return { ...standbySnapshot(), recentTicker: tickerLinesLongBody, ...over };
}

// ============================================================================
// ストレステストシナリオ (#emergency-stress / #standby-stress)
// 2011-03-11 東北地方太平洋沖地震 (東日本大震災) 相当の情報量で描画崩れを目視確認する。
// 実史実の数値・予報区名を用いる (JMA 発表ベース、細部は概算)。震源要素は最終確定値
// (M9.0、深さ24km) を使い、headline で速報時の M8.4 からの引き上げに触れる。
// ============================================================================

const STRESS_NOW_ISO = "2011-03-11T15:14:00+09:00";
const STRESS_NOW_MS = Date.parse(STRESS_NOW_ISO);
const STRESS_ORIGIN_ISO = "2011-03-11T14:46:18+09:00";

// EEW 対象地域: 東北〜関東の実際の都県 16 件 (震源に近い順)
const eewStressRegions: DisplayEewRegionV1[] = [
  { name: "宮城県", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:46:40+09:00" },
  { name: "岩手県", intensity: "6強", intensityTo: "7", isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:46:45+09:00" },
  { name: "福島県", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:46:50+09:00" },
  { name: "茨城県", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:05+09:00" },
  { name: "栃木県", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:10+09:00" },
  { name: "群馬県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:15+09:00" },
  { name: "埼玉県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:20+09:00" },
  { name: "千葉県", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:20+09:00" },
  { name: "東京都", intensity: "5強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:25+09:00" },
  { name: "秋田県", intensity: "5弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:00+09:00" },
  { name: "山形県", intensity: "5弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:00+09:00" },
  { name: "青森県", intensity: "5弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:46:55+09:00" },
  { name: "神奈川県", intensity: "5弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2011-03-11T14:47:30+09:00" },
  { name: "新潟県", intensity: "5弱", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
  { name: "長野県", intensity: "4", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
  { name: "山梨県", intensity: "4", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: null },
];

const eewStressInput: DisplayEewInputV1 = {
  kind: "eew",
  eventId: "eew-311-stress",
  serial: "24",
  isWarning: true,
  isFinal: false,
  isCancellation: false,
  hypocenterName: "三陸沖",
  forecastMaxInt: "7",
  forecastMaxIntRank: 9,
  magnitude: "9.0",
  colorIndex: null,
  reportDateTime: STRESS_ORIGIN_ISO,
  originTime: STRESS_ORIGIN_ISO,
  isAssumedHypocenter: false,
  depth: "24km",
  maxLgInt: null,
  regions: eewStressRegions,
};

export const eewStress: DisplayActiveEewV1 = { ...eewStressInput, updatedAtMs: STRESS_NOW_MS };

// 震度分布 (実際の 3.11 の代表的な観測点)。震度6弱以上 (rank 7〜9) は
// http-server.ts の縮退 cap 対象外 (第3波 Fix8) のため omittedAreaCount: 0 で全件列挙する。
// 5強以下は縮退カード相当の cap + omittedAreaCount を維持する (実際の市町村名を代表数だけ列挙)
const largeQuakeStressIntensityGroups: DisplayIntensityGroupV1[] = [
  { intensity: "7", rank: 9, areas: ["宮城県栗原市"], omittedAreaCount: 0 },
  {
    intensity: "6強",
    rank: 8,
    areas: [
      "宮城県涌谷町", "宮城県登米市", "宮城県美里町", "宮城県大崎市", "宮城県東松島市",
      "福島県白河市", "福島県須賀川市", "福島県鏡石町", "福島県天栄村", "福島県国見町",
      "茨城県日立市", "茨城県笠間市", "茨城県筑西市", "茨城県鉾田市", "茨城県常陸大宮市",
      "栃木県大田原市", "栃木県宇都宮市", "栃木県真岡市", "千葉県成田市",
    ],
    omittedAreaCount: 0,
  },
  {
    intensity: "6弱",
    rank: 7,
    areas: [
      "岩手県大船渡市", "岩手県一関市", "岩手県奥州市", "岩手県滝沢市", "岩手県矢巾町",
      "宮城県仙台市", "宮城県石巻市", "宮城県塩竈市", "宮城県名取市", "宮城県多賀城市",
      "宮城県岩沼市", "宮城県富谷市", "宮城県大河原町",
      "福島県郡山市", "福島県福島市", "福島県二本松市", "福島県本宮市", "福島県桑折町",
      "茨城県水戸市", "茨城県つくば市", "茨城県土浦市", "茨城県ひたちなか市", "茨城県取手市",
      "栃木県宇都宮市", "栃木県那須塩原市", "栃木県矢板市",
      "群馬県桐生市", "群馬県館林市",
      "埼玉県宮代町", "埼玉県久喜市",
      "千葉県成田市", "千葉県印西市", "千葉県芝山町",
      "東京都足立区",
    ],
    omittedAreaCount: 0,
  },
  {
    intensity: "5強",
    rank: 6,
    areas: ["青森県八戸市", "秋田県横手市", "山形県山形市", "東京都千代田区", "神奈川県横浜市", "新潟県長岡市", "山梨県甲府市", "静岡県静岡市"],
    omittedAreaCount: 20,
  },
  { intensity: "5弱", rank: 5, areas: ["北海道函館市", "長野県長野市", "愛知県名古屋市"], omittedAreaCount: 10 },
  { intensity: "4", rank: 4, areas: ["近畿地方 ほか"], omittedAreaCount: 50 },
];

const largeQuakeStressInput: DisplayLargeQuakeInputV1 = {
  kind: "largeQuake",
  eventId: "quake-311-main",
  originTime: STRESS_ORIGIN_ISO,
  hypocenterName: "三陸沖",
  magnitude: "9.0",
  maxInt: "7",
  maxIntRank: 9,
  intensityGroups: largeQuakeStressIntensityGroups,
  reportDateTime: STRESS_NOW_ISO,
  depth: "24km",
  maxLgInt: null,
  tsunamiWarning: true,
};

export const largeQuakeStress: DisplayLargeQuakeStateV1 = { ...largeQuakeStressInput, updatedAtMs: STRESS_NOW_MS };

// standby-stress シナリオ用: 地震情報カード表示 (headline に速報 M8.4 → 確定 M9.0 の引き上げを明記)
export const latestQuakeStress: DisplayLatestQuakeStateV1 = {
  eventId: "quake-311-main",
  headline:
    "三陸沖でマグニチュード9.0の地震が発生。宮城県栗原市で震度7を観測しました（速報値M8.4から引き上げ）。この地震により太平洋沿岸広域に大津波警報が発表されています。",
  originTime: STRESS_ORIGIN_ISO,
  hypocenterName: "三陸沖",
  depth: "24km",
  magnitude: "9.0",
  maxInt: "7",
  maxIntRank: 9,
  tsunamiWarning: true,
  intensityGroups: largeQuakeStressIntensityGroups,
  reportDateTime: STRESS_NOW_ISO,
  updatedAtMs: STRESS_NOW_MS,
};

// 津波予報区の観測 (実際の記録に基づく代表値、一部「以上」表記=計器上限超過)
const tsunamiStressObservations: DisplayTsunamiObservationV1[] = [
  {
    areaName: "岩手県", areaKind: "大津波警報", stationName: "宮古",
    arrivalTime: "2011-03-11T15:26:00+09:00", initial: "押し", maxHeightValue: "8.5m以上", condition: "観測中断",
  },
  {
    areaName: "岩手県", areaKind: "大津波警報", stationName: "大船渡",
    arrivalTime: "2011-03-11T15:18:00+09:00", initial: "押し", maxHeightValue: "8.0m以上", condition: "観測中断",
  },
  {
    areaName: "宮城県", areaKind: "大津波警報", stationName: "石巻市鮎川",
    arrivalTime: "2011-03-11T15:26:00+09:00", initial: "押し", maxHeightValue: "8.6m以上", condition: "観測中断",
  },
  {
    areaName: "福島県", areaKind: "大津波警報", stationName: "相馬",
    arrivalTime: "2011-03-11T15:51:00+09:00", initial: "押し", maxHeightValue: "9.3m以上", condition: "観測中断",
  },
  {
    areaName: "茨城県", areaKind: "大津波警報", stationName: "大洗",
    arrivalTime: "2011-03-11T16:52:00+09:00", initial: "押し", maxHeightValue: "4.0m", condition: "上昇中",
  },
  // 観測ページャ発火検証用に予報区数超の規模へ拡充 (T5b フィードバック §2-c、実測点は予報区数を超える前提)
  {
    areaName: "岩手県", areaKind: "大津波警報", stationName: "久慈",
    arrivalTime: "2011-03-11T15:20:00+09:00", initial: "押し", maxHeightValue: "8.6m以上", condition: "観測中断",
  },
  {
    areaName: "岩手県", areaKind: "大津波警報", stationName: "釜石",
    arrivalTime: "2011-03-11T15:21:00+09:00", initial: "押し", maxHeightValue: "9.3m以上", condition: "観測中断",
  },
  {
    areaName: "宮城県", areaKind: "大津波警報", stationName: "気仙沼",
    arrivalTime: "2011-03-11T15:30:00+09:00", initial: "押し", maxHeightValue: "7.4m以上", condition: "観測中断",
  },
  {
    areaName: "宮城県", areaKind: "大津波警報", stationName: "女川",
    arrivalTime: "2011-03-11T15:35:00+09:00", initial: "押し", maxHeightValue: null, condition: "観測中断",
  },
  {
    areaName: "宮城県", areaKind: "大津波警報", stationName: "石巻",
    arrivalTime: "2011-03-11T15:40:00+09:00", initial: "押し", maxHeightValue: "7.7m以上", condition: "観測中断",
  },
  {
    areaName: "福島県", areaKind: "大津波警報", stationName: "いわき",
    arrivalTime: "2011-03-11T16:00:00+09:00", initial: "押し", maxHeightValue: "9.1m以上", condition: "観測中断",
  },
  {
    areaName: "茨城県", areaKind: "大津波警報", stationName: "日立",
    arrivalTime: "2011-03-11T16:40:00+09:00", initial: "押し", maxHeightValue: "5.4m", condition: "上昇中",
  },
  {
    areaName: "千葉県九十九里・外房", areaKind: "大津波警報", stationName: "銚子",
    arrivalTime: "2011-03-11T17:00:00+09:00", initial: "押し", maxHeightValue: "3.7m", condition: "上昇中",
  },
  {
    areaName: "千葉県九十九里・外房", areaKind: "大津波警報", stationName: "勝浦",
    arrivalTime: "2011-03-11T17:10:00+09:00", initial: "押し", maxHeightValue: "3.5m", condition: "上昇中",
  },
  {
    areaName: "北海道太平洋沿岸東部", areaKind: "大津波警報", stationName: "釧路",
    arrivalTime: "2011-03-11T16:00:00+09:00", initial: "押し", maxHeightValue: "2.8m", condition: "上昇中",
  },
  {
    areaName: "北海道太平洋沿岸中部", areaKind: "大津波警報", stationName: "浦河",
    arrivalTime: "2011-03-11T15:50:00+09:00", initial: "押し", maxHeightValue: "3.5m以上", condition: "観測中断",
  },
  {
    areaName: "伊豆諸島", areaKind: "大津波警報", stationName: "八丈島",
    arrivalTime: "2011-03-11T17:30:00+09:00", initial: "押し", maxHeightValue: "2.0m", condition: "上昇中",
  },
  {
    areaName: "千葉県内房", areaKind: "津波警報", stationName: "館山",
    arrivalTime: "2011-03-11T17:20:00+09:00", initial: "押し", maxHeightValue: "1.4m", condition: "上昇中",
  },
  {
    areaName: "東京湾内湾", areaKind: "津波警報", stationName: "晴海",
    arrivalTime: "2011-03-11T18:00:00+09:00", initial: "押し", maxHeightValue: "1.2m", condition: "上昇中",
  },
  {
    areaName: "相模湾・三浦半島", areaKind: "津波警報", stationName: "油壷",
    arrivalTime: "2011-03-11T17:30:00+09:00", initial: "押し", maxHeightValue: "1.5m", condition: "上昇中",
  },
  {
    // 「未満」表記も maxTsunamiObservation が NFKC 後の上限値として比較し、原文表示を保つ
    areaName: "静岡県", areaKind: "津波警報", stationName: "焼津",
    arrivalTime: "2011-03-11T17:40:00+09:00", initial: "押し", maxHeightValue: "1m未満", condition: "上昇中",
  },
  {
    areaName: "高知県", areaKind: "津波警報", stationName: "須崎",
    arrivalTime: "2011-03-11T18:10:00+09:00", initial: "押し", maxHeightValue: "1.6m", condition: "上昇中",
  },
];

// 太平洋沿岸広域の大津波警報 (15:14 拡大時点相当、9 予報区) + 全国に広がる津波警報・注意報
const tsunamiStressCoasts: DisplayTsunamiInputV1["coasts"] = [
  // 大津波警報 (9)
  { name: "岩手県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
  { name: "宮城県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
  { name: "福島県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "既に到達と推測" },
  { name: "青森県太平洋沿岸", kind: "大津波警報", maxHeight: "3m", firstHeight: "既に到達と推測" },
  { name: "北海道太平洋沿岸中部", kind: "大津波警報", maxHeight: "3m", firstHeight: "11日15時30分頃" },
  { name: "北海道太平洋沿岸東部", kind: "大津波警報", maxHeight: "3m", firstHeight: "11日15時30分頃" },
  { name: "茨城県", kind: "大津波警報", maxHeight: "4m", firstHeight: "既に到達と推測" },
  { name: "千葉県九十九里・外房", kind: "大津波警報", maxHeight: "3m", firstHeight: "11日16時00分頃" },
  { name: "伊豆諸島", kind: "大津波警報", maxHeight: "3m", firstHeight: "11日16時20分頃" },
  // 津波警報 (北海道〜九州、20)
  { name: "北海道太平洋沿岸西部", kind: "津波警報", maxHeight: "2m", firstHeight: "11日15時50分頃" },
  { name: "青森県日本海沿岸", kind: "津波警報", maxHeight: "1m", firstHeight: "11日16時40分頃" },
  { name: "千葉県内房", kind: "津波警報", maxHeight: "2m", firstHeight: "11日16時10分頃" },
  { name: "東京湾内湾", kind: "津波警報", maxHeight: "1m", firstHeight: "11日17時00分頃" },
  { name: "相模湾・三浦半島", kind: "津波警報", maxHeight: "2m", firstHeight: "11日16時20分頃" },
  { name: "静岡県", kind: "津波警報", maxHeight: "2m", firstHeight: "11日16時30分頃" },
  { name: "愛知県外海", kind: "津波警報", maxHeight: "1m", firstHeight: "11日17時10分頃" },
  { name: "三重県南部", kind: "津波警報", maxHeight: "2m", firstHeight: "11日17時00分頃" },
  { name: "三重県北部・中部", kind: "津波警報", maxHeight: "1m", firstHeight: "11日17時20分頃" },
  { name: "和歌山県", kind: "津波警報", maxHeight: "2m", firstHeight: "11日17時10分頃" },
  { name: "大阪府", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時00分頃" },
  { name: "兵庫県瀬戸内海沿岸", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時30分頃" },
  { name: "徳島県", kind: "津波警報", maxHeight: "2m", firstHeight: "11日17時20分頃" },
  { name: "香川県", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時20分頃" },
  { name: "愛媛県宇和海沿岸", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時00分頃" },
  { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: "11日17時30分頃" },
  { name: "大分県豊後水道沿岸", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時00分頃" },
  { name: "宮崎県", kind: "津波警報", maxHeight: "2m", firstHeight: "11日17時50分頃" },
  { name: "鹿児島県東部", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時10分頃" },
  { name: "種子島・屋久島地方", kind: "津波警報", maxHeight: "1m", firstHeight: "11日18時20分頃" },
  // 津波注意報 (日本海側・瀬戸内・南西諸島ほか、21)
  { name: "北海道日本海沿岸北部", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時00分頃" },
  { name: "北海道日本海沿岸南部", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時00分頃" },
  { name: "石川県能登", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時30分頃" },
  { name: "石川県加賀", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時40分頃" },
  { name: "福井県", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時50分頃" },
  { name: "京都府", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時00分頃" },
  { name: "兵庫県日本海沿岸", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時00分頃" },
  { name: "鳥取県", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時10分頃" },
  { name: "島根県", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時20分頃" },
  { name: "山口県日本海沿岸", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時30分頃" },
  { name: "山口県瀬戸内海沿岸", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時40分頃" },
  { name: "福岡県瀬戸内海沿岸", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時40分頃" },
  { name: "大分県瀬戸内海沿岸", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時50分頃" },
  { name: "熊本県天草灘", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日20時50分頃" },
  { name: "熊本県有明・八代海", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日21時00分頃" },
  { name: "長崎県西方", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日21時10分頃" },
  { name: "長崎県島原海湾", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日21時10分頃" },
  { name: "奄美群島・トカラ列島", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時20分頃" },
  { name: "沖縄本島地方", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時30分頃" },
  { name: "大東島地方", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時40分頃" },
  { name: "宮古島・八重山地方", kind: "津波注意報", maxHeight: "0.5m", firstHeight: "11日19時50分頃" },
];

const tsunamiStressInput: DisplayTsunamiInputV1 = {
  kind: "tsunami",
  level: "majorWarning",
  levelLabel: "大津波警報",
  coasts: tsunamiStressCoasts,
  warningComment: "巨大津波のおそれ。直ちに高台等安全な場所へ避難してください",
  observations: tsunamiStressObservations,
  reportDateTime: STRESS_NOW_ISO,
};

export const tsunamiStress: DisplayTsunamiStateV1 = { ...tsunamiStressInput, updatedAtMs: STRESS_NOW_MS };
export { eewStressInput, tsunamiStressInput, largeQuakeStressInput };

// #emergency-stress / #standby-stress 用のテロップ (長文文章体、種別ラベル付き)
export const tickerLinesStress: DisplayEventDtoV1[] = [
  tickerLine({
    id: "ticker-stress-eew",
    role: "eewWarning",
    frameLevel: "critical",
    text: "[EEW警告] 三陸沖 M9.0 最大震度7 第24報",
    title: "緊急地震速報(警報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewStressInput,
    tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 #24: 三陸沖でM9.0の地震　予想最大震度7　東北から関東の広い範囲で強い揺れに警戒",
  }),
  tickerLine({
    id: "ticker-stress-quake",
    role: "quakeMajor",
    frameLevel: "critical",
    text: "[震度速報] 三陸沖 M9.0 最大震度7",
    title: "震度速報",
    domain: "quake",
    type: "VXSE53",
    emergency: largeQuakeStressInput,
    tickerCategory: "地震情報",
    tickerSentence:
      "午後2時46分ごろ、三陸沖を震源とするマグニチュード9.0の地震がありました。宮城県栗原市で震度7を観測したほか、東北から関東にかけて震度6強・6弱の強い揺れを観測しています。",
  }),
  tickerLine({
    id: "ticker-stress-tsunami-major",
    role: "tsunamiMajor",
    frameLevel: "critical",
    text: "[大津波警報] 岩手県・宮城県・福島県 ほか6地方に発表",
    title: "大津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiStressInput,
    tickerCategory: "津波情報",
    tickerSentence:
      "岩手県・宮城県・福島県など9予報区に大津波警報　巨大津波のおそれ。直ちに高台等安全な場所へ避難してください。",
  }),
  tickerLine({
    id: "ticker-stress-tsunami-warning",
    role: "tsunamiWarning",
    frameLevel: "warning",
    text: "[津波警報] 北海道太平洋沿岸西部・東京湾内湾 ほか18地方に発表",
    title: "津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiStressInput,
    tickerDetail: "津波警報: 北海道太平洋沿岸西部、相模湾・三浦半島、静岡県、和歌山県、高知県、宮崎県 ほか",
    tickerCategory: "津波情報",
    tickerSentence: "北海道から九州にかけて広い範囲に津波警報が発表されています。沿岸部からただちに離れてください。",
  }),
  tickerLine({
    id: "ticker-stress-tsunami-advisory",
    role: "tsunamiAdvisory",
    frameLevel: "normal",
    text: "[津波注意報] 日本海側・瀬戸内・南西諸島 ほか全国21地方に発表",
    title: "津波注意報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiStressInput,
    tickerCategory: "津波情報",
    tickerSentence: "日本海側・瀬戸内海・南西諸島など全国21予報区に津波注意報が発表されています。海に入っての作業や釣りは危険です。",
  }),
];

export function stressSnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    generatedAt: STRESS_NOW_ISO,
    seq: 999,
    activeEews: [eewStress],
    tsunami: tsunamiStress,
    largeQuakes: [largeQuakeStress],
    weatherAlerts: weatherAlertsStandbyCards,
    recentQuakes,
    latestQuake: latestQuakeStress,
    stats: statsStandbyCards,
    severityTier: "critical",
    connection: connectionConnected,
    recentTicker: tickerLinesStress,
    ...over,
  };
}

// ============================================================================
// 南海トラフ巨大地震 想定ストレステストシナリオ (#emergency-nankai / #standby-nankai)
// 出典: 内閣府/気象庁の一次資料の転記 (震源要素・震度分布) + 津波到達時間の公開資料での補完。
//       創作値は使わない。
// Mw9.0〜9.1・最大震度7 (10県153市町村、§2-a 全数)・大津波警報 (太平洋側17予報区、§3-b)。
// 震源要素は最終値 (Mw9.1、ごく浅い) を使い、headline で速報時 M8.1 からの引き上げに触れる
// (3.11 ストレスシナリオの M8.4→M9.0 パターンに倣う)。
// 個別予報区の firstHeight (到達予想時刻) は、crosscheck に記載のある静岡2分・和歌山2〜3分・
// 高知3分・徳島5〜6分・三重「5分以内」以外は資料に確定値が無いため、震央からの距離感を基準に
// 目視ストレステスト用として概算した推定値 ([未確認] 相当、fixture 都合の補完)。
//
// 【設計観察】南海トラフ地震臨時情報 (VYSE50/51/52/60) は src/engine/presentation 側で
// PresentationEvent (domain: "nankaiTrough") まで処理されるが、display/frontend/src/lib/protocol.ts
// の DisplayEmergencyInputV1 は DisplayEewInputV1 | DisplayTsunamiInputV1 | DisplayLargeQuakeInputV1
// の3種のみで、南海トラフ臨時情報の表示面 (DisplayNankaiTroughInputV1 相当) が存在しない。
// そのため本シナリオは地震・津波・EEW のみで構成し、臨時情報バナー/テロップは実装しない。
// ============================================================================

const NANKAI_ORIGIN_ISO = "2026-07-09T09:12:18+09:00";
const NANKAI_NOW_ISO = "2026-07-09T09:17:18+09:00"; // 発生5分後想定 (standby-nankai の基準時刻)
const NANKAI_NOW_MS = Date.parse(NANKAI_NOW_ISO);

// EEW対象地域: 東海〜近畿〜四国〜九州 30地域 (§5 細分区域名より抜粋、震源に近い順)
const eewNankaiRegions: DisplayEewRegionV1[] = [
  { name: "静岡県中部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:30+09:00" },
  { name: "静岡県西部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:32+09:00" },
  { name: "愛知県東部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:34+09:00" },
  { name: "三重県南部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:33+09:00" },
  { name: "和歌山県南部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:36+09:00" },
  { name: "徳島県南部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:38+09:00" },
  { name: "愛媛県南予", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:40+09:00" },
  { name: "高知県中部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:37+09:00" },
  { name: "高知県東部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:39+09:00" },
  { name: "兵庫県淡路島", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:50+09:00" },
  { name: "宮崎県南部平野部", intensity: "7", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:44+09:00" },
  { name: "静岡県東部", intensity: "6強", intensityTo: "7", isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:36+09:00" },
  { name: "静岡県伊豆", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:38+09:00" },
  { name: "愛知県西部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:42+09:00" },
  { name: "三重県中部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:40+09:00" },
  { name: "和歌山県北部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:44+09:00" },
  { name: "徳島県北部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:46+09:00" },
  { name: "香川県東部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:48+09:00" },
  { name: "愛媛県中予", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:48+09:00" },
  { name: "高知県西部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:45+09:00" },
  { name: "岐阜県美濃東部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:52+09:00" },
  { name: "宮崎県北部平野部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:50+09:00" },
  { name: "大分県南部", intensity: "6強", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:54+09:00" },
  { name: "三重県北部", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:46+09:00" },
  { name: "香川県西部", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:52+09:00" },
  { name: "愛媛県東予", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:54+09:00" },
  { name: "兵庫県南東部", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:12:58+09:00" },
  { name: "大阪府南部", intensity: "6弱", intensityTo: null, isPlum: false, hasArrived: true, arrivalTime: "2026-07-09T09:13:00+09:00" },
  { name: "熊本県熊本", intensity: "5強", intensityTo: "6弱", isPlum: true, hasArrived: false, arrivalTime: "2026-07-09T09:13:10+09:00" },
  { name: "鹿児島県大隅", intensity: "5強", intensityTo: null, isPlum: true, hasArrived: false, arrivalTime: "2026-07-09T09:13:14+09:00" },
];

const eewNankaiInput: DisplayEewInputV1 = {
  kind: "eew",
  eventId: "eew-nankai-stress",
  serial: "32",
  isWarning: true,
  isFinal: false,
  isCancellation: false,
  hypocenterName: "南海トラフ沿い",
  forecastMaxInt: "7",
  forecastMaxIntRank: 9,
  magnitude: "9.1",
  colorIndex: null,
  reportDateTime: NANKAI_ORIGIN_ISO,
  originTime: NANKAI_ORIGIN_ISO,
  isAssumedHypocenter: false,
  depth: "ごく浅い",
  maxLgInt: null,
  regions: eewNankaiRegions,
};

export const eewNankai: DisplayActiveEewV1 = { ...eewNankaiInput, updatedAtMs: NANKAI_NOW_MS };

// 震度分布: 震度7 = 10県153市町村 (§2-a、内閣府 ichiran.pdf 最大値列の全数転記)。
// 6強〜4 は §2-b/§2-c の県別想定 (市町村内訳は資料になく県集約のみ) から代表都市を挙げ、
// omittedAreaCount で「県内ほか」を表現する。
const nankaiPref7 = (pref: string, cities: string[]) => cities.map((c) => `${pref}${c}`);

const nankaiIntensity7Areas: string[] = [
  ...nankaiPref7("高知県", [
    "高知市", "室戸市", "安芸市", "南国市", "土佐市", "須崎市", "宿毛市", "土佐清水市", "四万十市", "香南市", "香美市",
    "安芸郡東洋町", "安芸郡奈半利町", "安芸郡田野町", "安芸郡安田町", "安芸郡北川村", "安芸郡芸西村",
    "長岡郡本山町", "長岡郡大豊町", "土佐郡土佐町", "土佐郡大川村", "吾川郡いの町",
    "高岡郡中土佐町", "高岡郡佐川町", "高岡郡梼原町", "高岡郡日高村", "高岡郡津野町", "高岡郡四万十町",
    "幡多郡大月町", "幡多郡三原村", "幡多郡黒潮町",
  ]),
  ...nankaiPref7("愛知県", [
    "名古屋市港区", "豊橋市", "岡崎市", "半田市", "豊川市", "碧南市", "刈谷市", "豊田市", "安城市", "西尾市",
    "蒲郡市", "常滑市", "新城市", "東海市", "知多市", "知立市", "高浜市", "豊明市", "田原市", "弥富市",
    "海部郡飛島村", "知多郡阿久比町", "知多郡東浦町", "知多郡南知多町", "知多郡美浜町", "知多郡武豊町", "額田郡幸田町",
  ]),
  ...nankaiPref7("静岡県", [
    "静岡市葵区", "静岡市駿河区", "静岡市清水区", "浜松市中央区", "浜松市浜名区", "浜松市天竜区",
    "島田市", "富士市", "磐田市", "焼津市", "掛川市", "藤枝市", "袋井市", "湖西市", "御前崎市", "菊川市", "牧之原市",
    "榛原郡吉田町", "周智郡森町",
  ]),
  ...nankaiPref7("徳島県", [
    "徳島市", "鳴門市", "小松島市", "阿南市", "吉野川市", "阿波市", "三好市",
    "勝浦郡勝浦町", "勝浦郡上勝町", "名西郡石井町", "那賀郡那賀町",
    "海部郡牟岐町", "海部郡美波町", "海部郡海陽町",
    "板野郡松茂町", "板野郡北島町", "板野郡藍住町", "板野郡板野町", "板野郡上板町",
  ]),
  ...nankaiPref7("三重県", [
    "津市", "伊勢市", "松阪市", "鈴鹿市", "尾鷲市", "鳥羽市", "熊野市", "志摩市",
    "多気郡多気町", "多気郡明和町", "度会郡玉城町", "度会郡度会町", "度会郡大紀町", "度会郡南伊勢町",
    "北牟婁郡紀北町", "南牟婁郡御浜町", "南牟婁郡紀宝町",
  ]),
  ...nankaiPref7("和歌山県", [
    "和歌山市", "海南市", "有田市", "御坊市", "田辺市", "新宮市",
    "有田郡湯浅町", "有田郡広川町",
    "日高郡美浜町", "日高郡日高町", "日高郡由良町", "日高郡印南町", "日高郡みなべ町", "日高郡日高川町",
    "西牟婁郡白浜町", "西牟婁郡すさみ町",
    "東牟婁郡那智勝浦町", "東牟婁郡太地町", "東牟婁郡古座川町", "東牟婁郡串本町",
  ]),
  ...nankaiPref7("宮崎県", ["宮崎市", "日向市", "西都市", "児湯郡高鍋町", "児湯郡新富町", "児湯郡木城町", "児湯郡川南町", "児湯郡都農町"]),
  ...nankaiPref7("愛媛県", ["宇和島市", "新居浜市", "西条市", "大洲市", "四国中央市", "西予市", "北宇和郡鬼北町"]),
  ...nankaiPref7("香川県", ["観音寺市", "東かがわ市", "三豊市"]),
  ...nankaiPref7("兵庫県", ["洲本市", "南あわじ市"]),
];
// 内訳: 高知31・愛知27・静岡19・徳島19・三重17・和歌山20・宮崎8・愛媛7・香川3・兵庫2 = 153市町村

const largeQuakeNankaiIntensityGroups: DisplayIntensityGroupV1[] = [
  { intensity: "7", rank: 9, areas: nankaiIntensity7Areas, omittedAreaCount: 0 },
  {
    intensity: "6強",
    rank: 8,
    areas: ["山梨県甲府市", "長野県飯田市", "岐阜県多治見市", "滋賀県大津市", "京都府京都市", "大阪府大阪市", "奈良県奈良市", "岡山県岡山市", "大分県大分市"],
    omittedAreaCount: 40,
  },
  {
    intensity: "6弱",
    rank: 7,
    areas: ["神奈川県横浜市", "広島県広島市", "山口県岩国市", "熊本県熊本市", "鹿児島県鹿児島市", "福岡県福岡市"],
    omittedAreaCount: 30,
  },
  {
    intensity: "5強",
    rank: 6,
    areas: ["栃木県宇都宮市", "群馬県前橋市", "埼玉県さいたま市", "千葉県千葉市", "東京都新宿区", "福井県福井市", "長崎県長崎市"],
    omittedAreaCount: 60,
  },
  {
    intensity: "5弱",
    rank: 5,
    areas: ["茨城県水戸市", "佐賀県佐賀市", "新潟県新潟市", "富山県富山市", "石川県金沢市"],
    omittedAreaCount: 40,
  },
  { intensity: "4", rank: 4, areas: ["福島県福島市", "関東・中部・中国・九州北部 ほか"], omittedAreaCount: 80 },
];

const largeQuakeNankaiInput: DisplayLargeQuakeInputV1 = {
  kind: "largeQuake",
  eventId: "quake-nankai-main",
  originTime: NANKAI_ORIGIN_ISO,
  hypocenterName: "南海トラフ沿い",
  magnitude: "9.1",
  maxInt: "7",
  maxIntRank: 9,
  intensityGroups: largeQuakeNankaiIntensityGroups,
  reportDateTime: NANKAI_NOW_ISO,
  depth: "ごく浅い",
  maxLgInt: null,
  tsunamiWarning: true,
};

export const largeQuakeNankai: DisplayLargeQuakeStateV1 = { ...largeQuakeNankaiInput, updatedAtMs: NANKAI_NOW_MS };

// standby-nankai シナリオ用: 地震情報カード表示 (headline に速報M8.1→確定M9.1の引き上げを明記)
export const latestQuakeNankai: DisplayLatestQuakeStateV1 = {
  eventId: "quake-nankai-main",
  headline:
    "南海トラフ沿いでマグニチュード9.1の地震が発生。静岡県から宮崎県にかけての10県153市町村で震度7を観測しました（速報値M8.1から引き上げ）。この地震により太平洋沿岸の広い範囲に大津波警報が発表されています。",
  originTime: NANKAI_ORIGIN_ISO,
  hypocenterName: "南海トラフ沿い",
  depth: "ごく浅い",
  magnitude: "9.1",
  maxInt: "7",
  maxIntRank: 9,
  tsunamiWarning: true,
  intensityGroups: largeQuakeNankaiIntensityGroups,
  reportDateTime: NANKAI_NOW_ISO,
  updatedAtMs: NANKAI_NOW_MS,
};

// 津波第一波の観測 (発生5分後時点、遠州灘側の近距離予報区のみ観測開始。最大波はまだ不明)
const tsunamiNankaiObservations: DisplayTsunamiObservationV1[] = [
  {
    areaName: "静岡県", areaKind: "大津波警報", stationName: "御前崎",
    arrivalTime: "2026-07-09T09:14:18+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
  },
  {
    areaName: "高知県", areaKind: "大津波警報", stationName: "須崎",
    arrivalTime: "2026-07-09T09:15:18+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
  },
  {
    areaName: "和歌山県", areaKind: "大津波警報", stationName: "串本",
    arrivalTime: "2026-07-09T09:15:18+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
  },
  // 観測ページャ発火検証用に拡充 (T5b フィードバック §2-c、実測点は予報区数を超える前提)
  {
    areaName: "三重県南部", areaKind: "大津波警報", stationName: "尾鷲",
    arrivalTime: "2026-07-09T09:22:18+09:00", initial: "押し", maxHeightValue: "8.7m", condition: "上昇中",
  },
  {
    areaName: "愛知県外海", areaKind: "大津波警報", stationName: "伊良湖",
    arrivalTime: "2026-07-09T09:18:18+09:00", initial: "押し", maxHeightValue: "9.8m", condition: "上昇中",
  },
  {
    areaName: "徳島県", areaKind: "大津波警報", stationName: "由岐",
    arrivalTime: "2026-07-09T09:24:18+09:00", initial: "押し", maxHeightValue: "9.1m", condition: "上昇中",
  },
  {
    areaName: "愛媛県宇和海沿岸", areaKind: "大津波警報", stationName: "宿毛",
    arrivalTime: "2026-07-09T09:35:18+09:00", initial: "押し", maxHeightValue: "6.5m", condition: "上昇中",
  },
  {
    areaName: "宮崎県", areaKind: "大津波警報", stationName: "油津",
    arrivalTime: "2026-07-09T09:45:18+09:00", initial: "押し", maxHeightValue: null, condition: "観測中",
  },
  {
    areaName: "大分県豊後水道沿岸", areaKind: "大津波警報", stationName: "佐伯",
    arrivalTime: "2026-07-09T09:50:18+09:00", initial: "押し", maxHeightValue: "4.9m", condition: "上昇中",
  },
  {
    areaName: "鹿児島県東部", areaKind: "大津波警報", stationName: "志布志",
    arrivalTime: "2026-07-09T09:55:18+09:00", initial: "押し", maxHeightValue: "4.2m", condition: "上昇中",
  },
  {
    areaName: "千葉県九十九里・外房", areaKind: "大津波警報", stationName: "勝浦",
    arrivalTime: "2026-07-09T09:45:18+09:00", initial: "押し", maxHeightValue: "5.1m", condition: "上昇中",
  },
  {
    areaName: "伊豆諸島", areaKind: "大津波警報", stationName: "八丈島",
    arrivalTime: "2026-07-09T09:35:18+09:00", initial: "押し", maxHeightValue: "9.5m", condition: "上昇中",
  },
];

// 太平洋側主要予報区の警報レベル (§3-b): 大津波警報17 + 津波警報8 + 注意報4。
// maxHeight は §3-a 県別最大津波高から JMA 発表区分 (10m超/10m/5m/3m/1m/0.2m) に写像した概算。
// firstHeight は crosscheck の実測ケース (静岡2分・和歌山2〜3分・高知3分・徳島5〜6分・
// 三重「5分以内」) 以外は資料に確定値が無いため震央からの距離感で概算した推定値。
const tsunamiNankaiCoasts: DisplayTsunamiInputV1["coasts"] = [
  // 大津波警報 (17、§3-b)
  { name: "静岡県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時14分頃（地震発生から2分）" },
  { name: "愛知県外海", kind: "大津波警報", maxHeight: "10m超", firstHeight: "直ちに到達と予想" },
  { name: "伊勢・三河湾", kind: "大津波警報", maxHeight: "5m", firstHeight: "09時20分頃" },
  { name: "三重県南部", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時17分までに到達（5分以内）" },
  { name: "和歌山県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時15分頃（地震発生から2〜3分）" },
  { name: "淡路島南部", kind: "大津波警報", maxHeight: "5m", firstHeight: "直ちに到達と予想" },
  { name: "徳島県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時18分頃（地震発生から5〜6分）" },
  { name: "高知県", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時15分頃（地震発生から3分）" },
  { name: "愛媛県宇和海沿岸", kind: "大津波警報", maxHeight: "10m超", firstHeight: "直ちに到達と予想" },
  { name: "大分県豊後水道沿岸", kind: "大津波警報", maxHeight: "5m", firstHeight: "09時45分頃" },
  { name: "宮崎県", kind: "大津波警報", maxHeight: "10m", firstHeight: "09時40分頃" },
  { name: "鹿児島県東部", kind: "大津波警報", maxHeight: "5m", firstHeight: "09時50分頃" },
  { name: "種子島・屋久島地方", kind: "大津波警報", maxHeight: "5m", firstHeight: "10時00分頃" },
  { name: "千葉県九十九里・外房", kind: "大津波警報", maxHeight: "5m", firstHeight: "09時40分頃" },
  { name: "伊豆諸島", kind: "大津波警報", maxHeight: "10m超", firstHeight: "09時30分頃" },
  { name: "小笠原諸島", kind: "大津波警報", maxHeight: "3m", firstHeight: "10時30分頃" },
  { name: "相模湾・三浦半島", kind: "大津波警報", maxHeight: "5m", firstHeight: "09時25分頃" },
  // 津波警報 (8、§3-b)
  { name: "茨城県", kind: "津波警報", maxHeight: "3m", firstHeight: "10時20分頃" },
  { name: "千葉県内房", kind: "津波警報", maxHeight: "1m", firstHeight: "10時10分頃" },
  { name: "大阪府", kind: "津波警報", maxHeight: "1m", firstHeight: "10時40分頃" },
  { name: "鹿児島県西部", kind: "津波警報", maxHeight: "1m", firstHeight: "10時30分頃" },
  { name: "山口県瀬戸内海沿岸", kind: "津波警報", maxHeight: "1m", firstHeight: "10時50分頃" },
  { name: "岡山県", kind: "津波警報", maxHeight: "1m", firstHeight: "11時00分頃" },
  { name: "広島県", kind: "津波警報", maxHeight: "1m", firstHeight: "11時10分頃" },
  { name: "香川県", kind: "津波警報", maxHeight: "1m", firstHeight: "10時40分頃" },
  // 津波注意報 (4、§3-b)
  { name: "東京湾内湾", kind: "津波注意報", maxHeight: "0.2m", firstHeight: "11時20分頃" },
  { name: "瀬戸内海の内奥部予報区", kind: "津波注意報", maxHeight: "0.2m", firstHeight: "11時40分頃" },
  { name: "有明・八代海", kind: "津波注意報", maxHeight: "0.2m", firstHeight: "11時50分頃" },
  { name: "沖縄本島地方 ほか南西諸島の一部", kind: "津波注意報", maxHeight: "0.2m", firstHeight: "12時00分頃" },
];

const tsunamiNankaiInput: DisplayTsunamiInputV1 = {
  kind: "tsunami",
  level: "majorWarning",
  levelLabel: "大津波警報",
  coasts: tsunamiNankaiCoasts,
  warningComment: "巨大津波のおそれ。直ちに高台等安全な場所へ避難してください",
  observations: tsunamiNankaiObservations,
  reportDateTime: NANKAI_NOW_ISO,
};

export const tsunamiNankai: DisplayTsunamiStateV1 = { ...tsunamiNankaiInput, updatedAtMs: NANKAI_NOW_MS };
export { eewNankaiInput, tsunamiNankaiInput, largeQuakeNankaiInput };

// #emergency-nankai / #standby-nankai 用のテロップ (長文文章体、種別ラベル付き)
export const tickerLinesNankai: DisplayEventDtoV1[] = [
  tickerLine({
    id: "ticker-nankai-eew",
    role: "eewWarning",
    frameLevel: "critical",
    text: "[EEW警告] 南海トラフ沿い M9.1 最大震度7 第32報",
    title: "緊急地震速報(警報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewNankaiInput,
    tickerCategory: "緊急地震速報",
    tickerSentence: "緊急地震速報 #32: 南海トラフ沿いでM9.1の地震　予想最大震度7　東海から九州にかけての広い範囲で強い揺れに警戒",
  }),
  tickerLine({
    id: "ticker-nankai-quake",
    role: "quakeMajor",
    frameLevel: "critical",
    text: "[震度速報] 南海トラフ沿い M9.1 最大震度7",
    title: "震度速報",
    domain: "quake",
    type: "VXSE53",
    emergency: largeQuakeNankaiInput,
    tickerCategory: "地震情報",
    tickerSentence:
      "午前9時12分ごろ、南海トラフ沿いを震源とするマグニチュード9.1の地震がありました。静岡県から宮崎県にかけての10県153市町村で震度7を観測したほか、周辺の広い範囲で震度6強・6弱の強い揺れを観測しています。",
  }),
  tickerLine({
    id: "ticker-nankai-tsunami-major",
    role: "tsunamiMajor",
    frameLevel: "critical",
    text: "[大津波警報] 静岡県・愛知県外海・三重県南部 ほか14予報区に発表",
    title: "大津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiNankaiInput,
    tickerCategory: "津波情報",
    tickerSentence:
      "静岡県から宮崎県にかけての太平洋沿岸17予報区に大津波警報　巨大津波のおそれ。直ちに高台等安全な場所へ避難してください。",
  }),
  tickerLine({
    id: "ticker-nankai-tsunami-warning",
    role: "tsunamiWarning",
    frameLevel: "warning",
    text: "[津波警報] 茨城県・大阪府・鹿児島県西部 ほか5予報区に発表",
    title: "津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiNankaiInput,
    tickerDetail: "津波警報: 茨城県、千葉県内房、大阪府、鹿児島県西部、山口県瀬戸内海沿岸、岡山県、広島県、香川県",
    tickerCategory: "津波情報",
    tickerSentence: "関東から九州の瀬戸内海沿岸にかけて広い範囲に津波警報が発表されています。沿岸部からただちに離れてください。",
  }),
  tickerLine({
    id: "ticker-nankai-tsunami-advisory",
    role: "tsunamiAdvisory",
    frameLevel: "normal",
    text: "[津波注意報] 東京湾内湾・瀬戸内海内奥部・有明八代海・沖縄本島地方 ほかに発表",
    title: "津波注意報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiNankaiInput,
    tickerCategory: "津波情報",
    tickerSentence: "東京湾内湾・瀬戸内海の内奥部・有明八代海・沖縄本島地方など4予報区に津波注意報が発表されています。海に入っての作業や釣りは危険です。",
  }),
];

export function nankaiSnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    generatedAt: NANKAI_NOW_ISO,
    seq: 999,
    activeEews: [eewNankai],
    tsunami: tsunamiNankai,
    largeQuakes: [largeQuakeNankai],
    weatherAlerts: weatherAlertsStandbyCards,
    recentQuakes,
    latestQuake: latestQuakeNankai,
    stats: statsStandbyCards,
    severityTier: "critical",
    connection: connectionConnected,
    recentTicker: tickerLinesNankai,
    ...over,
  };
}

// ============================================================================
// Task B10 preview 検証シーン (#ticker-conveyor / #ticker-interrupt / #ticker-revision /
// #ticker-highx2 / #ticker-cycle / #ticker-longrun)
// runtime 挙動 (連続コンベア・二段制御・レーン役割・high 交代・巡回間隔) を Chrome 実測で
// 検証するための fixture。時間差投入 (割込み・続報) が必要なシーンは、この fixture 自体は
// 静的な「投入する DTO」を公開するだけに留め、実際の setTimeout 注入は PreviewApp.svelte 側
// (t=0 base → t+N ms 追加投入の確定タイムライン方式、Spec C Task 6 と同じ流儀) が担う。
// ============================================================================

// #ticker-conveyor: 長文解説 (複数 segment・1 run) がセグメント境界の無音区間なく連続して
// 流れることを見る単独シーン。本文は RUN_DEFAULT_MAX_CHARS (800字) 未満に収め 1 run に収める。
const CONVEYOR_BODY =
  "【概況】梅雨前線が本州付近に停滞し、前線上を低気圧が東進する見込みです。前線に向かって暖かく湿った空気が流れ込み、大気の状態が不安定となるでしょう。" +
  "【防災事項】西日本から東日本にかけて、局地的に雷を伴った非常に激しい雨が降るおそれがあります。土砂災害、低い土地の浸水、河川の増水や氾濫に警戒してください。" +
  "【付加情報】前線の停滞により、同じ地域で降り続く大雨となるおそれがあります。今後の気象情報の続報に注意してください。";

export const tickerLinesConveyor: DisplayEventDtoV1[] = [
  tickerLine({
    id: "b10-conveyor-explanation",
    role: "normal",
    frameLevel: "normal",
    text: "気象解説情報",
    title: "全般気象解説情報",
    domain: "weatherExplanation",
    type: "VPZJ51",
    tickerCategory: "気象解説情報",
    tickerPriority: "low",
    groupKey: "weatherExplanation:b10-conveyor",
    tickerSentence: "梅雨前線の停滞に関する全般気象情報が発表されています。",
    tickerBody: CONVEYOR_BODY,
  }),
];

// #ticker-interrupt: low 走行中に high (EEW警報) が届く割込みを時間差で再現する。
// レーン役割 (B6) 導入後は low 1本だけだと下段 (lane1、low専用) に住み、high は空いてる上段
// (lane0) にただ入るだけで競合しない (割込みが起きない、実測で判明)。競合を再現するため
// base を low 2本 (別 groupKey) にして両レーンを埋める: preferLowLane は「lane1 (下段) 優先、
// 塞がっていれば lane0 流用」なので、先に定義した短文 low が lane1、後に定義した長文 low が
// lane0 (上段) に載る。high は lane0 (LANE_HIGH) しか割込まないため、上段に流用されている
// 長文 low が割込み対象になる。PreviewApp.svelte が t+20s ごろに tickerInterruptHigh を追加投入
// する (tickerGeneration は据え置いたまま lines へ追加 = Ticker.svelte の「新着 enqueue」経路を
// 通り、実運用の割込みと同じ経路になる)。20s = 長文 low のセグメント1個 (約70字≈14秒) を
// 確実に通過し終えたタイミング。割込まれた長文 low は最後に通過した栞 (2セグメント目付近) から
// 再走するはずで、頭に戻らないことを目視で区別できる (§2-2)。
const INTERRUPT_LOW_SHORT_SENTENCE = "岐阜県美濃中西部を震源とする地震がありました。最大震度1を観測しています。";

const INTERRUPT_LOW_LONG_BODY =
  "【概況】日本海を発達した低気圧が東北東へ進んでおり、この低気圧に向かって暖かく湿った空気が流れ込んでいます。大気の状態が非常に不安定となっている見込みです。" +
  "【防災事項】東北から北陸にかけて、雷を伴った激しい雨や突風に注意が必要です。河川の増水や低い土地の浸水にも警戒してください。" +
  "【付加情報】今後、風雨が急激に強まるおそれがあるため、早めの備えを心がけてください。";

export const tickerLinesInterruptBase: DisplayEventDtoV1[] = [
  // 短文 low (先に定義 = 小さい seq → preferLowLane で lane1/下段 へ)
  tickerLine({
    id: "b10-interrupt-low-short",
    role: "normal",
    frameLevel: "normal",
    text: "[通常] 震源・震度情報 岐阜県美濃中西部 M2.9 震度1",
    title: "震源・震度情報",
    domain: "quake",
    type: "VXSE51",
    recentQuake: recentQuakes[4],
    tickerCategory: "地震情報",
    tickerPriority: "low",
    groupKey: "quake:b10-interrupt-short",
    tickerSentence: INTERRUPT_LOW_SHORT_SENTENCE,
  }),
  // 長文 low、約200字級 (後に定義 = 大きい seq → lane1 が塞がった後 lane0/上段 へ流用。
  // high の割込み対象になるのはこちら)
  tickerLine({
    id: "b10-interrupt-low-long",
    role: "normal",
    frameLevel: "normal",
    text: "気象解説情報",
    title: "全般気象解説情報",
    domain: "weatherExplanation",
    type: "VPZJ51",
    tickerCategory: "気象解説情報",
    tickerPriority: "low",
    groupKey: "weatherExplanation:b10-interrupt",
    tickerSentence: "発達する低気圧に関する全般気象情報が発表されています。",
    tickerBody: INTERRUPT_LOW_LONG_BODY,
  }),
];

export const tickerInterruptHigh: DisplayEventDtoV1 = tickerLine({
  id: "b10-interrupt-eew",
  role: "eewWarning",
  frameLevel: "critical",
  text: "[EEW警告] 日向灘 M7.1 最大震度6弱 第8報",
  title: "緊急地震速報(警報)",
  domain: "eew",
  type: "VXSE45",
  emergency: eewWarningInput,
  tickerCategory: "緊急地震速報",
  tickerPriority: "high",
  groupKey: "eew:b10-interrupt",
  tickerSentence: "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
});

// #ticker-revision: 同一 groupKey の続報を短時間 (t=0 / +1000ms / +2000ms) に 3 版投入する。
// 二段制御 (§5-1) の確認: 同格続報は最低表示 (MIN_VISIBLE_MS) を確保してから最新版へ切替わり、
// 冒頭ループ (毎回頭から再走) が起きないはず。PreviewApp.svelte が時間差で追加投入する。
const REVISION_GROUP_KEY = "quake:b10-revision";

export const tickerRevisionV1: DisplayEventDtoV1 = tickerLine({
  id: "b10-revision-1",
  role: "normal",
  frameLevel: "normal",
  text: "[速報] 震源・震度情報 宮城県沖 M4.8 震度3 (第1報)",
  title: "震源・震度情報",
  domain: "quake",
  type: "VXSE53",
  recentQuake: recentQuakes[0],
  tickerCategory: "地震情報",
  tickerPriority: "low",
  groupKey: REVISION_GROUP_KEY,
  tickerSentence: "午後2時28分ごろ、宮城県沖を震源とする地震がありました。震度3を観測した模様です（第1報、詳細確認中）。",
});

export const tickerRevisionV2: DisplayEventDtoV1 = tickerLine({
  id: "b10-revision-2",
  role: "normal",
  frameLevel: "normal",
  text: "[続報] 震源・震度情報 宮城県沖 M4.8 震度3 (第2報)",
  title: "震源・震度情報",
  domain: "quake",
  type: "VXSE53",
  recentQuake: recentQuakes[0],
  tickerCategory: "地震情報",
  tickerPriority: "low",
  groupKey: REVISION_GROUP_KEY,
  tickerSentence:
    "午後2時28分ごろ、宮城県沖を震源とするマグニチュード4.8の地震がありました。石巻市で最大震度3を観測しています（第2報、震源要素を更新）。",
});

export const tickerRevisionV3: DisplayEventDtoV1 = tickerLine({
  id: "b10-revision-3",
  role: "normal",
  frameLevel: "normal",
  text: "[確定] 震源・震度情報 宮城県沖 M4.8 震度3 (第3報・最終)",
  title: "震源・震度情報",
  domain: "quake",
  type: "VXSE53",
  recentQuake: recentQuakes[0],
  tickerCategory: "地震情報",
  tickerPriority: "low",
  groupKey: REVISION_GROUP_KEY,
  tickerSentence:
    "午後2時28分ごろ、宮城県沖を震源とするマグニチュード4.8の地震がありました。石巻市・東松島市で最大震度3を観測しています（確定報）。",
});

// #ticker-highx2: high 2件同時 (EEW警報 + 大津波警報、別 groupKey)。上段 (lane0) が
// HIGH_SLICE_MS (8秒) ごとに交代することを見る静的シーン (時間差投入は不要、両方最初から在る)。
export const tickerLinesHighX2: DisplayEventDtoV1[] = [
  tickerLine({
    id: "b10-highx2-eew",
    role: "eewWarning",
    frameLevel: "critical",
    text: "[EEW警告] 日向灘 M7.1 最大震度6弱 第8報",
    title: "緊急地震速報(警報)",
    domain: "eew",
    type: "VXSE45",
    emergency: eewWarningInput,
    tickerCategory: "緊急地震速報",
    tickerPriority: "high",
    groupKey: "eew:b10-highx2",
    tickerSentence: "緊急地震速報 #8: 日向灘でM7.1の地震　予想最大震度6弱　強い揺れに警戒",
  }),
  tickerLine({
    id: "b10-highx2-tsunami",
    role: "tsunamiMajor",
    frameLevel: "critical",
    text: "[大津波警報] 宮崎県・高知県 ほか6地方に発表",
    title: "大津波警報",
    domain: "tsunami",
    type: "VTSE41",
    emergency: tsunamiMajorInput,
    tickerCategory: "津波情報",
    tickerPriority: "high",
    groupKey: "tsunami:b10-highx2",
    tickerSentence:
      "宮崎県・高知県など5予報区に大津波警報　巨大津波のおそれ。直ちに高台等安全な場所へ避難してください。",
  }),
];

// #ticker-cycle: 巡回候補が 1-2 件だけの低優先度シーン。両方とも lane に載った後、120秒
// (CYCLE_MIN_INTERVAL_MS) 未満では同じ候補が再登場せず、両段とも完全空欄 (「受信待機中」も
// 出ない) で休むはずの状態を確認する。
export const tickerLinesCycleSparse: DisplayEventDtoV1[] = [
  tickerLine({
    id: "b10-cycle-quake",
    role: "normal",
    frameLevel: "normal",
    text: "[通常] 震源・震度情報 岐阜県美濃中西部 M2.9 震度1",
    title: "震源・震度情報",
    domain: "quake",
    type: "VXSE51",
    recentQuake: recentQuakes[4],
    tickerCategory: "地震情報",
    tickerPriority: "low",
    groupKey: "quake:b10-cycle-1",
    tickerSentence: "午後6時16分ごろ、岐阜県美濃中西部を震源とする地震がありました。最大震度1を観測しています。",
  }),
  tickerLine({
    id: "b10-cycle-weather",
    role: "weatherAdvisory",
    frameLevel: "normal",
    text: "[注意報] 雷注意報 熊本県全域",
    title: "雷注意報",
    domain: "weather",
    type: "VPWW50",
    tickerCategory: "気象警報・注意報",
    tickerPriority: "low",
    groupKey: "weather:b10-cycle-2",
    tickerSentence: "熊本県に雷注意報が発表されています。落雷やひょうに注意してください。",
  }),
];

// #ticker-longrun: 800字超の長大電文 (RUN_DEFAULT_MAX_CHARS 超) が複数 run に分割され、
// run 境界で連続して (文途中で切れずに) 流れることを見る単独シーン。
const LONGRUN_BODY =
  "台風第5号は非常に強い勢力を保ったまま北上を続けており、暴風域を伴って明日にかけて日本の南から東日本に接近する見込みです。" +
  "台風の中心付近の最大風速は50メートル、最大瞬間風速は70メートルに達するおそれがあり、進路にあたる地域では記録的な暴風・高波・大雨となるおそれがあります。" +
  "暴風域に入る確率（府県内最大・5日積算・カッコ内はピーク時間帯）：" +
  [
    "枕崎市 100%（1日18時）", "宮崎市 100%（1日21時）",
    "天草市 99%（2日00時）", "室戸市 98%（2日03時）",
    "佐伯市 97%（2日03時）", "宇和島市 95%（2日06時）",
    "阿南市 93%（2日09時）", "新宮市 90%（2日12時）",
    "尾鷲市 87%（2日15時）", "下田市 83%（2日21時）",
    "横須賀市 70%（3日00時）", "銚子市 62%（3日03時）",
    "大洗町 48%（3日06時）", "いわき市 30%（3日09時）",
  ].join("、") +
  "。" +
  "また、台風の接近に伴い、太平洋側を中心に土砂災害、低い土地の浸水、河川の増水や氾濫に厳重な警戒が必要です。" +
  "特に土砂災害警戒情報が発表された地域では、市町村からの避難情報に留意し、危険を感じたら速やかに安全な場所へ避難してください。" +
  "海上では、うねりを伴った高波が続く見込みです。海岸付近には近づかないようにしてください。" +
  "今後、台風の進路や速度によって暴風・大雨のピークの時間帯が前後する可能性があります。最新の台風情報や自治体からの避難情報に注意してください。";

export const tickerLinesLongRun: DisplayEventDtoV1[] = [
  tickerLine({
    id: "b10-longrun-typhoon",
    role: "normal",
    frameLevel: "normal",
    text: "台風の暴風域に入る確率",
    title: "台風の暴風域に入る確率",
    domain: "typhoonProbability",
    type: "VPTA50",
    tickerCategory: "台風情報",
    tickerPriority: "low",
    groupKey: "typhoonProbability:b10-longrun",
    tickerSentence: "台風第5号の暴風域に入る確率が発表されています。",
    tickerBody: LONGRUN_BODY,
  }),
];

// ---- 待機画面カード拡充 (standbyItems) の目視ゲート用 ----

const STANDBY_ITEM_BASE: Pick<ActiveStandbyCardV1, "sourceEventIds" | "updatedAt" | "expiresAt" | "restored"> = {
  sourceEventIds: ["preview"],
  updatedAt: NOW_ISO,
  expiresAt: null,
  restored: false,
};

/** 全種別同時 active。右上スタック (洪水3河川=通常幅・火山・台風2・熱中症) + rider 2 + 南海バッジ */
export const standbyItemsShowcase: ActiveStandbyCardV1[] = [
  {
    ...STANDBY_ITEM_BASE, kind: "flood", surface: "corner-right", key: "flood:active", severity: "critical",
    data: { rivers: [
      { riverKey: "8303040001", riverName: "大淀川", level: "L4", levelRank: 40, kindName: "氾濫危険情報", reportDateTime: NOW_ISO, station: { name: "柏田", levelM: 3.42, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過" } },
      { riverKey: "8303040002", riverName: "小丸川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: NOW_ISO, station: { name: "高城", levelM: 2.18, trend: "steady", thresholdLabel: "避難判断水位 2.00m 超過" } },
      { riverKey: "8303040003", riverName: "五ヶ瀬川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: NOW_ISO, station: null },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "volcano", surface: "corner-right", key: "volcano:active", severity: "critical",
    data: { volcanoes: [
      {
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"],
        latestEvent: {
          label: "噴火速報", craterName: "南岳山頂火口", eventDateTime: NOW_ISO,
          plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        },
      },
      { code: "550", name: "諏訪之瀬島", alertLevel: 3, latestEvent: null },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "typhoon", surface: "corner-right", key: "typhoon:active", severity: "normal",
    data: { typhoons: [
      { typhoonKey: "TC2618", name: "TALIM", nameKana: "タリム", remark: null, typhoonNumber: "2618", category: "台風(TY)", location: "沖縄の南", pressureHpa: 940, maxWindMs: 45, maxGustMs: 65, moveDirection: "北北西", moveSpeedKmh: 20, reportDateTime: NOW_ISO },
      { typhoonKey: "TC2619", name: null, nameKana: null, remark: "台風発生予想", typhoonNumber: null, category: "熱帯低気圧(TD)", location: "マリアナ諸島", pressureHpa: 1002, maxWindMs: 15, moveDirection: "西", moveSpeedKmh: 15, reportDateTime: NOW_ISO },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "heat", surface: "corner-right", key: "heat:2026-07-07", severity: "warning", restored: true,
    data: { targetDate: "2026-07-07", areas: [
      { areaName: "宮崎県", isSpecial: false }, { areaName: "鹿児島県", isSpecial: false },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "tornado", surface: "weather-rider", key: "tornado:active", severity: "critical",
    data: { areas: ["宮崎県南部平野部", "宮崎県北部平野部"], isSighted: true },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "longPeriod", surface: "quake-rider", key: "longPeriod:quake-latest-standby", severity: "warning",
    data: { eventId: "quake-latest-standby", maxLgInt: "3" },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "nankaiTrough", surface: "clock-below", key: "nankai:current", severity: "critical",
    data: { statusCode: "120", label: "巨大地震警戒" },
  },
];

/** v10 の気象カード mock 用: WeatherAlertCard の「ほか」省略を展開して全対象地域を見せる。 */
export const legacyImprovedTornadoFullAreas = [
  "宮崎県南部平野部",
  "宮崎県北部平野部",
] as const;

/** 実機再現 (2026-07-23/24 実機不具合 5・熱中症カード欠落): 気象カードあり + volcano(warning) +
 *  typhoon(発生予想 1 エントリのみ = 実高が見積 240px より大幅に低いカード) + heat×2。720p で
 *  全カードが visible になることを検証する (spec standby-right-stack T3、#standby-right-stack-budget) */
export const standbyItemsRightStackBudget: ActiveStandbyCardV1[] = [
  {
    ...STANDBY_ITEM_BASE, kind: "volcano", surface: "corner-right", key: "volcano:active", severity: "warning",
    data: { volcanoes: [
      { code: "503", name: "阿蘇山", alertLevel: 2, latestEvent: null },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "typhoon", surface: "corner-right", key: "typhoon:active", severity: "normal",
    data: { typhoons: [
      { typhoonKey: "TC2614", name: null, nameKana: null, remark: "台風発生予想", typhoonNumber: null, category: "熱帯低気圧(TD)", location: "フィリピンの東", pressureHpa: 1000, maxWindMs: 15, moveDirection: "西北西", moveSpeedKmh: 25, reportDateTime: NOW_ISO },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "heat", surface: "corner-right", key: "heat:2026-07-24", severity: "warning",
    // 実機相当の全国的高温日 (2026-07-24 実測は 40 府県)。カード内マーキーの目視検証を兼ねる
    data: { targetDate: "2026-07-24", areas: [
      "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県", "山梨県", "長野県",
      "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県",
      "和歌山県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
      "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県",
    ].map((areaName) => ({ areaName, isSpecial: false })) },
  },
  {
    ...STANDBY_ITEM_BASE, kind: "heat", surface: "corner-right", key: "heat:2026-07-23", severity: "warning",
    data: { targetDate: "2026-07-23", areas: [
      { areaName: "沖縄県", isSpecial: false },
    ] },
  },
];

// 水位ミニグラフ用の現実的な 7 点系列 (現況 14:00 → 1〜6時間後、1 時間刻み)。
// values[0] が現況 (observed)、以降が予測 (forecast)。null は欠測点。
const FLOOD_HYDROGRAPH_HOURS = ["14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00"] as const;
function floodHydrograph(values: (number | null)[], dangerLevelM: number | null): DisplayFloodHydrographV1 {
  return {
    points: values.map((valueM, i) => ({
      dateTime: `2026-07-07T${FLOOD_HYDROGRAPH_HOURS[i]}:00+09:00`,
      valueM,
      phase: i === 0 ? "observed" : "forecast",
    })),
    dangerLevelM,
  };
}

/** 洪水広域時: 5 河川で時計上ワイド表示へ移行した状態 (+ 右上は他カードのみ) */
export const standbyItemsFloodWide: ActiveStandbyCardV1[] = [
  {
    ...STANDBY_ITEM_BASE, kind: "flood", surface: "clock-top-wide", key: "flood:active", severity: "critical",
    data: { rivers: [
      { riverKey: "8303040001", riverName: "大淀川", level: "L5", levelRank: 50, kindName: "氾濫発生情報", reportDateTime: NOW_ISO, station: { name: "柏田", levelM: 4.05, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過", hydrograph: floodHydrograph([4.05, 4.12, 4.24, 4.36, 4.41, 4.33, 4.18], 3.20) } },
      // 欠測 (null) を挟んだ系列: 予測の途中で線が切れることを目視確認する
      { riverKey: "8303040002", riverName: "小丸川", level: "L4", levelRank: 40, kindName: "氾濫危険情報", reportDateTime: NOW_ISO, station: { name: "高城", levelM: 3.31, trend: "rising", thresholdLabel: "氾濫危険水位 3.20m 超過", hydrograph: floodHydrograph([3.31, 3.38, null, 3.55, 3.60, 3.52, 3.41], 3.20) } },
      // dangerLevelM: null → 危険線を出さず時系列だけ描く
      { riverKey: "8303040003", riverName: "五ヶ瀬川", level: "L4", levelRank: 40, kindName: "氾濫危険情報", reportDateTime: NOW_ISO, station: { name: "三輪", levelM: 5.60, trend: "falling", thresholdLabel: "氾濫危険水位 5.40m 超過", hydrograph: floodHydrograph([5.60, 5.45, 5.30, 5.12, 4.95, 4.80, 4.66], null) } },
      { riverKey: "8303040004", riverName: "耳川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: NOW_ISO, station: { name: "山陰", levelM: null, trend: null, thresholdLabel: "避難判断水位超過" } },
      { riverKey: "8303040005", riverName: "一ツ瀬川", level: "L3", levelRank: 30, kindName: "氾濫警戒情報", reportDateTime: NOW_ISO, station: null },
    ] },
  },
  ...standbyItemsShowcase.filter((item) => item.kind !== "flood"),
];

/** モーション検証: 河川数を 0→3(corner)→4(wide)→5(wide)→2(corner)→0 と循環させ、
 * corner⇔wide 切替・セル増減・集約行の出入りを 1 周で目視できる時間駆動シナリオ用。
 * 実運用の surface は 4 河川以上で wide (flood-active-reducer) だが、preview は境界の前後を
 * 任意に見るための固定注入とする。 */
export const motionStandbyFloodPhases: ActiveStandbyCardV1[][] = (() => {
  const wide = standbyItemsFloodWide[0];
  if (wide.kind !== "flood") throw new Error("standbyItemsFloodWide[0] must be flood");
  const rivers = wide.data.rivers;
  const flood = (count: number, surface: "corner-right" | "clock-top-wide"): ActiveStandbyCardV1 =>
    ({ ...wide, surface, data: { rivers: rivers.slice(0, count) } }) as ActiveStandbyCardV1;
  return [
    [],
    [flood(3, "corner-right")],
    [flood(4, "clock-top-wide")],
    [flood(5, "clock-top-wide")],
    [flood(2, "corner-right")],
  ];
})();

// ── Spec C Phase 2: 気象警報の主役パネル (preview 目視用) ──
// 実運用の合成は buildWeatherEmergencyInput が snapshot から作るが、preview は見た目の確認が
// 目的なので合成後の入力を直接置く。L5 4 種別 + L4 3 種別 + 地域多め (縮退表示の確認込み)
export const weatherEmergencyInput: WeatherEmergencyInputV1 = {
  kind: "weather",
  level: 5,
  generation: "vpws50:3|vpww56:1",
  truncated: true,
  restored: false,
  trigger: "update",
  updatedAt: "2026-07-26T12:21:02.699Z",
  activationKey: "vpws50:3|2026-07-26T12:21:02.699Z",
  firstPageRowKey: "vpww56:nonLevelSpecial:暴風特別警報",
  items: [
    {
      key: "vpws50:0:L5 大雨特別警報", source: "vpws50", kind: "L5 大雨特別警報", level: 5,
      shownAreas: ["高知県", "徳島県", "愛媛県", "香川県", "岡山県", "広島県"], omittedAreaCount: 4, addedAreas: [],
    },
    {
      key: "vpws50:1:L5 土砂災害警戒情報", source: "vpws50", kind: "L5 土砂災害警戒情報", level: 5,
      shownAreas: ["高知県", "徳島県"], omittedAreaCount: 0, addedAreas: [],
    },
    {
      key: "vpww56:nonLevelSpecial:暴風特別警報", source: "vpww56", kind: "暴風特別警報", level: 5,
      // 更新発表で増えた地域 (下線でハイライトされる)
      shownAreas: ["宮崎県", "鹿児島県"], omittedAreaCount: 1, addedAreas: ["鹿児島県"],
    },
    {
      key: "vpww56:1:波浪特別警報", source: "vpww56", kind: "波浪特別警報", level: 5,
      shownAreas: ["沖縄本島地方", "宮古島地方", "八重山地方"], omittedAreaCount: 0, addedAreas: [],
    },
    {
      key: "vpws50:2:L4 洪水警報", source: "vpws50", kind: "L4 洪水警報", level: 4,
      // L5 継続中に L4 側で地域が増えた形。**追加を含む下位行だけ**が地域名つきで
      // ページ送り列に出る (ご主人決定 2026-07-27)。追加を含まない下位 2 行は副セクションの要約のまま
      shownAreas: ["愛知県", "静岡県"], omittedAreaCount: 3, addedAreas: ["静岡県"],
    },
    {
      key: "vpws50:3:L4 高潮警報", source: "vpws50", kind: "L4 高潮警報", level: 4,
      shownAreas: ["三重県"], omittedAreaCount: 0, addedAreas: [],
    },
    {
      key: "vpww56:2:L4 土砂災害警戒情報", source: "vpww56", kind: "L4 土砂災害警戒情報", level: 4,
      shownAreas: ["和歌山県"], omittedAreaCount: 0, addedAreas: [],
    },
  ],
};

/** 復元直後など、engine は昇格中だがフロントがまだ item を組めていない窓 (同期中表示の確認用) */
export const weatherSyncingInput: WeatherEmergencyInputV1 = {
  kind: "weather",
  level: 5,
  generation: "vpws50:1",
  truncated: false,
  restored: true,
  trigger: "new",
  updatedAt: "2026-07-26T12:21:02.699Z",
  activationKey: "vpws50:1",
  firstPageRowKey: null,
  items: [],
};

// ── 従来フォーマット改良 v3: scenario=max 用 ──
// main のカード自身が行う省略/マーキーを壊さず、展開版と集約版を fixture 切替で比較する。
const LEGACY_IMPROVED_MAX_WEATHER_AREAS = [
  "北海道石狩地方", "青森県津軽", "岩手県内陸北部", "宮城県北部", "秋田県沿岸", "山形県最上",
  "福島県会津", "茨城県北部", "栃木県北部", "群馬県北部", "埼玉県秩父地方", "東京都多摩西部",
  "神奈川県西部", "新潟県上越", "富山県東部", "石川県加賀", "福井県嶺北", "長野県北部",
  "岐阜県飛騨", "静岡県西部", "愛知県東部", "三重県北部", "滋賀県北部", "京都府北部",
];

export const legacyImprovedWeatherAlertsCompact: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: 12,
    items: [{
      kind: "大雨警報(土砂災害)",
      displaySeverity: "officialL3",
      rank: "warning",
      shownAreas: ["熊本県山鹿市", "熊本県菊池市"],
      omittedAreaCount: 10,
    }],
    updatedAt: NOW_ISO,
  },
];

export const legacyImprovedMaxWeatherAlerts: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: LEGACY_IMPROVED_MAX_WEATHER_AREAS.length,
    items: [{
      kind: "大雨警報(土砂災害)",
      displaySeverity: "officialL3",
      rank: "warning",
      shownAreas: [...LEGACY_IMPROVED_MAX_WEATHER_AREAS],
      omittedAreaCount: 0,
    }],
    updatedAt: NOW_ISO,
  },
];

export const legacyImprovedMaxWeatherAlertsCompact: DisplayWeatherAlertV1[] = [
  {
    source: "vpws50",
    label: "大雨警報",
    role: "weatherWarning",
    totalAreas: LEGACY_IMPROVED_MAX_WEATHER_AREAS.length,
    items: [{
      kind: "大雨警報(土砂災害)",
      displaySeverity: "officialL3",
      rank: "warning",
      shownAreas: LEGACY_IMPROVED_MAX_WEATHER_AREAS.slice(0, 3),
      omittedAreaCount: LEGACY_IMPROVED_MAX_WEATHER_AREAS.length - 3,
    }],
    updatedAt: NOW_ISO,
  },
];

const legacyImprovedMaxHeatAreas = [
  "宮城県", "福島県", "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県", "静岡県", "愛知県",
  "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県", "鳥取県", "島根県",
  "岡山県", "広島県", "山口県",
];

export const legacyImprovedMaxItems: ActiveStandbyCardV1[] = [
  ...standbyItemsShowcase.filter((item) =>
    item.kind === "flood" || item.kind === "tornado" || item.kind === "longPeriod" || item.kind === "nankaiTrough"),
  {
    ...STANDBY_ITEM_BASE,
    kind: "volcano",
    surface: "corner-right",
    key: "volcano:legacy-improved-max",
    severity: "critical",
    data: { volcanoes: [
      {
        code: "506", name: "桜島", alertLevel: 4,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["入山規制"],
        latestEvent: {
          label: "噴火速報", craterName: "南岳山頂火口", eventDateTime: NOW_ISO,
          plumeHeightM: 2500, plumeHeightUnknown: false, plumeDirection: "南東",
        },
      },
      { code: "550", name: "諏訪之瀬島", alertLevel: 3, latestEvent: null },
      {
        code: "509", name: "口永良部島", alertLevel: 3,
        warningKind: "噴火警報（火口周辺）", targetKinds: ["火口周辺規制"], latestEvent: null,
      },
      { code: "501", name: "阿蘇山", alertLevel: 2, latestEvent: null },
      { code: "101", name: "浅間山", alertLevel: 2, latestEvent: null },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE,
    kind: "typhoon",
    surface: "corner-right",
    key: "typhoon:legacy-improved-max",
    severity: "warning",
    data: { typhoons: [
      { typhoonKey: "TC2618", name: "TALIM", nameKana: "タリム", remark: null, typhoonNumber: "2618", category: "台風(TY)", location: "沖縄の南", pressureHpa: 940, maxWindMs: 45, maxGustMs: 65, moveDirection: "北北西", moveSpeedKmh: 20, reportDateTime: NOW_ISO },
      { typhoonKey: "TC2619", name: null, nameKana: null, remark: "台風発生予想", typhoonNumber: null, category: "熱帯低気圧(TD)", location: "マリアナ諸島", pressureHpa: 1002, maxWindMs: 15, maxGustMs: 25, moveDirection: "西", moveSpeedKmh: 15, reportDateTime: NOW_ISO },
    ] },
  },
  {
    ...STANDBY_ITEM_BASE,
    kind: "heat",
    surface: "corner-right",
    key: "heat:legacy-improved-max",
    severity: "critical",
    data: {
      targetDate: "2026-07-07",
      areas: legacyImprovedMaxHeatAreas.map((areaName) => ({ areaName, isSpecial: false })),
    },
  },
];

/** max scenario の「入力には存在するが描画しない」未知系カード。 */
export const legacyImprovedMaxUnknownItems = [
  { key: "unknown:legacy-improved-1", kind: "未対応の警報種別", label: "未知の警報カード" },
  { key: "unknown:legacy-improved-2", kind: "未対応の観測種別", label: "未知の観測カード" },
] as const;
