import type { PresentationDomain } from "../../../src/engine/presentation/types";

export const PHASE0_TIMING_CONTRACT = {
  legacySourceHoldbackMs: 60_000,
  correlationWindowBeforeMs: 5 * 60_000,
  correlationWindowAfterMs: 5 * 60_000,
  correlationRetentionMs: 11 * 60_000,
  futureReportDateTimeSkewMs: 15 * 60_000,
} as const;

export const PHASE0_ACCEPTANCE_CRITERIA = {
  U1: {
    decision: "legacyCounterpartCorrelation",
    sourceHoldbackMs: PHASE0_TIMING_CONTRACT.legacySourceHoldbackMs,
    windowBeforeMs: PHASE0_TIMING_CONTRACT.correlationWindowBeforeMs,
    windowAfterMs: PHASE0_TIMING_CONTRACT.correlationWindowAfterMs,
    retentionMs: PHASE0_TIMING_CONTRACT.correlationRetentionMs,
    timeoutBehavior: "failOpen",
    lateCounterpartBehavior: "replaceActiveWithCanonicalWithoutTtlExtension",
  },
  U2: {
    decision: "unmatchedLegacyNotification",
    display: "allAccepted",
    notify: "codeConfirmedHighSeverityOnly",
    ambiguous: "displayWithoutNotification",
    qualifier: "対応電文未確認",
    evaluatedBefore: "U5",
  },
  U3: {
    decision: "invalidReportDateTime",
    reportDateTimeFallback: "none",
    transientSurfaces: ["cli", "diagnosticTicker"],
    excludedSurfaces: ["normalTicker", "card", "map", "activeState", "notification", "sound"],
    durable: false,
  },
  U4: {
    decision: "mapSpecialValueBadge",
    exact: { badge: null, color: "normal" },
    lowerBound: { badge: "≥", color: "safetyRank" },
    range: { badge: "↔", color: "safetyUpperRank" },
    unknown: { badge: "?", color: "unknown" },
    empty: { badge: "∅", color: "neutral" },
    missing: { badge: null, color: "notRendered" },
    intensityLowerBound: { raw: "5弱以上未入電", badge: "≥", color: "intensity5Lower" },
  },
  U5: {
    decision: "acceptedSameRevisionCorrectionNotification",
    notifyAcceptedEligibleCorrection: true,
    notifyWithoutPresentationDiff: true,
    correctionQualifier: "訂正",
    transportDuplicate: "rejectBeforeNotification",
    semanticDuplicate: "rejectBeforeNotification",
    staleOrInvalid: "noNotification",
    firstReportSound: "doNotReplay",
  },
} as const;

export type FiveStatePresence = "missing" | "empty" | "unknown" | "qualitative" | "range";
export type SpecialValueDomain =
  | "Magnitude"
  | "Depth"
  | "Intensity"
  | "TsunamiHeight"
  | "LgInt"
  | "Pressure"
  | "WindSpeed"
  | "MovementSpeed"
  | "PlumeHeight";

export interface CorpusEvidence {
  source: "repo" | "weathercw" | "synthetic";
  fixture: string;
  selector: string;
  observed: boolean;
  note: string;
  expected?: {
    exists: boolean;
    raw?: string;
    attributes?: Readonly<Record<string, string>>;
    children?: Readonly<Record<string, string>>;
    states: readonly FiveStatePresence[];
  };
  upstreamFixture?: string;
  upstreamSha256?: string;
}

export interface SpecialValueCell {
  expectedPresence: FiveStatePresence;
  evidence: readonly CorpusEvidence[];
}

const synthetic = (domain: SpecialValueDomain, presence: FiveStatePresence, note: string): CorpusEvidence => ({
  source: "synthetic",
  fixture: `planned:${domain}:${presence}`,
  selector: domain,
  observed: false,
  note,
});

export const FIVE_STATE_SPECIAL_VALUE_MATRIX = {
  Magnitude: {
    missing: {
      expectedPresence: "missing",
      evidence: [synthetic("Magnitude", "missing", "要素欠落は Phase 1 の最小 fixture で補う")],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("Magnitude", "empty", "明示空は実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_02_250206_VTSE41.xml",
        selector: "Earthquake/Magnitude[@condition=不明]",
        observed: true,
        note: 'raw=NaN condition="不明"',
        expected: {
          exists: true,
          raw: "NaN",
          attributes: { condition: "不明", description: "Ｍ８を超える巨大地震" },
          states: ["unknown", "qualitative"],
        },
      }],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_02_250206_VTSE41.xml",
        selector: "Earthquake/Magnitude[@condition=不明]",
        observed: true,
        note: "Ｍ８を超える巨大地震",
        expected: {
          exists: true,
          raw: "NaN",
          attributes: { condition: "不明", description: "Ｍ８を超える巨大地震" },
          states: ["unknown", "qualitative"],
        },
      }],
    },
    range: {
      expectedPresence: "range",
      evidence: [synthetic("Magnitude", "range", "明示 bound 属性は実コーパス未確認")],
    },
  },
  Depth: {
    missing: {
      expectedPresence: "missing",
      evidence: [synthetic("Depth", "missing", "震源座標の深さ欠落を Phase 1 fixture で補う")],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("Depth", "empty", "明示空は実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [{
        source: "repo",
        fixture: "36_01_10_240613_VXSE44.xml",
        selector: "Earthquake/Hypocenter/Accuracy/Depth",
        observed: true,
        note: "raw=NaN。Accuracy の深さ評価であり震源深さ値とは別経路",
        expected: {
          exists: true,
          raw: "NaN",
          attributes: { rank: "4" },
          states: ["unknown"],
        },
      }],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [synthetic("Depth", "qualitative", "ごく浅いの構造化 fixture を Phase 1 で補う")],
    },
    range: {
      expectedPresence: "range",
      evidence: [synthetic("Depth", "range", "深さ範囲は実コーパス未確認")],
    },
  },
  Intensity: {
    missing: {
      expectedPresence: "missing",
      evidence: [{
        source: "repo",
        fixture: "32-35_01_02_240613_VXSE52.xml",
        selector: "Body/Intensity",
        observed: true,
        note: "震度要素なしの震源情報",
        expected: { exists: false, states: ["missing"] },
      }],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("Intensity", "empty", "明示空は実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [synthetic("Intensity", "unknown", "未入電を Phase 1 fixture で補う")],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [synthetic("Intensity", "qualitative", "5弱以上未入電を Phase 1 fixture で補う")],
    },
    range: {
      expectedPresence: "range",
      evidence: [{
        source: "repo",
        fixture: "36_01_10_240613_VXSE44.xml",
        selector: "Intensity/Forecast/Pref/Area[Code=710]/ForecastInt",
        observed: true,
        note: "From=3 To=4",
        expected: {
          exists: true,
          children: { From: "3", To: "4" },
          states: ["range"],
        },
      }],
    },
  },
  TsunamiHeight: {
    missing: {
      expectedPresence: "missing",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_10_250206_VTSE51.xml",
        selector: "Observation/Item/Area/Station[Code=20102]/MaxHeight/TsunamiHeight",
        observed: true,
        note: "むつ市関根浜（Code=20102）は MaxHeight 内の TsunamiHeight が欠落",
        expected: { exists: false, states: ["missing"] },
      }],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("TsunamiHeight", "empty", "self-closing 高さは実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_03_250206_VTSE51.xml",
        selector: "TsunamiHeight[@condition=不明][@description=巨大]",
        observed: true,
        note: 'raw=NaN condition="不明" description="巨大"',
        expected: {
          exists: true,
          raw: "NaN",
          attributes: { condition: "不明", description: "巨大" },
          states: ["unknown", "qualitative"],
        },
      }],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_03_250206_VTSE51.xml",
        selector: "TsunamiHeight[@condition=不明][@description=巨大]",
        observed: true,
        note: "巨大／高い",
        expected: {
          exists: true,
          raw: "NaN",
          attributes: { condition: "不明", description: "巨大" },
          states: ["unknown", "qualitative"],
        },
      }],
    },
    range: {
      expectedPresence: "range",
      evidence: [{
        source: "repo",
        fixture: "32-39_11_11_250206_VTSE41.xml",
        selector: "TsunamiHeight[@description=１０ｍ超]",
        observed: true,
        note: "１０ｍ超。32-39_11_09 には０．２ｍ未満も存在",
        expected: {
          exists: true,
          raw: "10",
          attributes: { description: "１０ｍ超" },
          states: ["range"],
        },
      }],
    },
  },
  LgInt: {
    missing: {
      expectedPresence: "missing",
      evidence: [{
        source: "repo",
        fixture: "36_01_10_240613_VXSE44.xml",
        selector: "Body/Intensity/Forecast/ForecastLgInt",
        observed: true,
        note: "ForecastLgInt 欠落区域あり",
        expected: { exists: false, states: ["missing"] },
      }],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("LgInt", "empty", "明示空は実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [synthetic("LgInt", "unknown", "未入電は実コーパス未確認")],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [synthetic("LgInt", "qualitative", "下限表現は実コーパス未確認")],
    },
    range: {
      expectedPresence: "range",
      evidence: [{
        source: "repo",
        fixture: "37_01_02_240613_VXSE43.xml",
        selector: "Body/Intensity/Forecast/ForecastLgInt",
        observed: true,
        note: "From/To 構造を実在確認",
        expected: {
          exists: true,
          children: { From: "2", To: "2" },
          states: ["range"],
        },
      }],
    },
  },
  Pressure: {
    missing: {
      expectedPresence: "missing",
      evidence: [synthetic("Pressure", "missing", "Pressure 欠落を Phase 1 fixture で補う")],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("Pressure", "empty", "明示空は実コーパス未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [synthetic("Pressure", "unknown", "解析不能は spec 語彙のみで実コーパス未確認")],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [synthetic("Pressure", "qualitative", "定性気圧は実コーパス未確認")],
    },
    range: {
      expectedPresence: "range",
      evidence: [synthetic("Pressure", "range", "範囲気圧は実コーパス未確認")],
    },
  },
  WindSpeed: {
    missing: {
      expectedPresence: "missing",
      evidence: [synthetic("WindSpeed", "missing", "WindSpeedPart 欠落を Phase 1 fixture で補う")],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [{
        source: "repo",
        fixture: "83_02_02_250630_VPZJ51.xml",
        selector: "WindSpeed[@condition=値なし][@type=最大風速]",
        observed: true,
        note: '空本文 condition="値なし"',
        expected: {
          exists: true,
          attributes: { condition: "値なし", type: "最大風速", unit: "m/s" },
          states: ["empty"],
        },
      }],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [synthetic("WindSpeed", "unknown", "不明風速は実コーパス未確認")],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [{
        source: "repo",
        fixture: "10_05_01_200826_VPTW60.xml",
        selector: "WindSpeed[@condition=なし][@type=最大風速][@description=最大風速０メートル]",
        observed: true,
        note: 'condition="なし" raw=0。値ゼロとの衝突を characterization 対象にする',
        expected: {
          exists: true,
          raw: "0",
          attributes: { condition: "なし", type: "最大風速", unit: "m/s" },
          states: ["qualitative"],
        },
      }],
    },
    range: {
      expectedPresence: "range",
      evidence: [{
        source: "weathercw",
        fixture: "telegram-foundation/weathercw-10_03_01_171016_VPTW60-wind-range.xml",
        selector: "Evidence/WindSpeed[@condition=以上][@unit=ノット]",
        observed: true,
        note: 'condition="以上"',
        expected: {
          exists: true,
          raw: "50",
          attributes: { condition: "以上", description: "風速５０ノット以上", unit: "ノット" },
          states: ["range"],
        },
        upstreamFixture: "10_03_01_171016_VPTW60.xml",
        upstreamSha256: "91ea5acb655f8f8255e2de54935882232cf5fe4f29cac846fc0559d67be96b1f",
      }],
    },
  },
  MovementSpeed: {
    missing: {
      expectedPresence: "missing",
      evidence: [synthetic("MovementSpeed", "missing", "移動速度要素欠落を Phase 1 fixture で補う")],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("MovementSpeed", "empty", "qualifier なし self-closing は未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [synthetic("MovementSpeed", "unknown", "移動速度不明は実コーパス未確認")],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [{
        source: "repo",
        fixture: "10_04_03_170913_VPTW60.xml",
        selector: "CenterPart/Speed[@condition=ゆっくり]",
        observed: true,
        note: 'self-closing condition="ゆっくり" description="ゆっくり"',
        expected: {
          exists: true,
          attributes: { condition: "ゆっくり", description: "ゆっくり" },
          states: ["empty", "qualitative"],
        },
      }],
    },
    range: {
      expectedPresence: "range",
      evidence: [synthetic("MovementSpeed", "range", "移動速度範囲は実コーパス未確認")],
    },
  },
  PlumeHeight: {
    missing: {
      expectedPresence: "missing",
      evidence: [{
        source: "repo",
        fixture: "67_01_01_140927_VFVO56.xml",
        selector: "ColorPlume/PlumeHeightAboveCrater",
        observed: true,
        note: "噴火速報では高さノードなし",
        expected: { exists: false, states: ["missing"] },
      }],
    },
    empty: {
      expectedPresence: "empty",
      evidence: [synthetic("PlumeHeight", "empty", "condition なし self-closing は未確認")],
    },
    unknown: {
      expectedPresence: "unknown",
      evidence: [{
        source: "repo",
        fixture: "43_01_01_200522_VFVO52.xml",
        selector: "PlumeHeightAboveCrater[@condition=不明]",
        observed: true,
        note: 'self-closing condition="不明" description="不明"',
        expected: {
          exists: true,
          attributes: { condition: "不明", description: "不明" },
          states: ["empty", "unknown"],
        },
      }],
    },
    qualitative: {
      expectedPresence: "qualitative",
      evidence: [synthetic("PlumeHeight", "qualitative", "雲中は spec 語彙のみで実コーパス未確認")],
    },
    range: {
      expectedPresence: "range",
      evidence: [synthetic("PlumeHeight", "range", "噴煙高度の以上表現は実コーパス未確認")],
    },
  },
} as const satisfies Record<SpecialValueDomain, Record<FiveStatePresence, SpecialValueCell>>;

export const ORDINARY_VALUE_EVIDENCE = {
  Magnitude: "32-39_11_09_250206_VTSE41.xml#Magnitude=8.9",
  Depth: "36_01_10_240613_VXSE44.xml#Coordinate=-40000",
  Intensity: "32-35_01_03_240613_VXSE53.xml#MaxInt=5-",
  TsunamiHeight: "32-39_11_10_250206_VTSE51.xml#TsunamiHeight=3.2",
  LgInt: "selected_xml/78_01_01_240613_VXSE62.xml#MaxLgInt=3",
  Pressure: "10_04_03_170913_VPTW60.xml#Pressure=950",
  WindSpeed: "10_04_03_170913_VPTW60.xml#WindSpeed=45m/s",
  MovementSpeed: "10_04_03_170913_VPTW60.xml#Speed=10km/h",
  PlumeHeight: "66_01_02_210514_VFVO54.xml#PlumeHeightAboveCrater=2200",
} as const satisfies Record<SpecialValueDomain, string>;

export const TELEGRAM_META_CHARACTERIZATION = [
  { field: "InfoType", value: "発表", source: "repo", fixture: "10_04_03_170913_VPTW60.xml", observed: true },
  { field: "InfoType", value: "発表", source: "weathercw", fixture: "10_03_01_171016_VPTW60.xml", observed: true },
  { field: "InfoType", value: "訂正", source: "repo", fixture: "43_02_01_200522_VFVO52.xml", observed: true },
  { field: "InfoType", value: "訂正", source: "weathercw", fixture: "10_05_02_200826_VPTW60.xml", observed: true },
  { field: "InfoType", value: "取消", source: "repo", fixture: "32-35_06_02_100915_VXSE52.xml", observed: true },
  { field: "InfoType", value: "取消", source: "weathercw", fixture: "not-observed", observed: false },
  { field: "Status", value: "通常", source: "repo", fixture: "10_04_03_170913_VPTW60.xml", observed: true },
  { field: "Status", value: "通常", source: "weathercw", fixture: "10_03_01_171016_VPTW60.xml", observed: true },
  { field: "Status", value: "訓練", source: "repo", fixture: "32-35_01_02_240613_VXSE52.xml", observed: true },
  { field: "Status", value: "試験", source: "repo", fixture: "synthetic_VXKO50_cumulative_no_window.xml", observed: true },
  { field: "Serial", value: "55", source: "repo", fixture: "10_04_03_170913_VPTW60.xml", observed: true },
  { field: "Serial", value: "001", source: "repo", fixture: "44_02_01_200522_VFVO51.xml", observed: true },
  { field: "Serial", value: "", source: "repo", fixture: "32-35_01_02_240613_VXSE52.xml", observed: true },
  { field: "Serial", value: null, source: "weathercw", fixture: "15_16_01_241031_VPWW56.xml", observed: true },
  { field: "ReportDateTime", value: "2017-09-13T21:45:00+09:00", source: "repo", fixture: "10_04_03_170913_VPTW60.xml", observed: true },
  { field: "ReportDateTime", value: "2017-10-16T09:45:00+09:00", source: "weathercw", fixture: "10_03_01_171016_VPTW60.xml", observed: true },
  { field: "ReportDateTime", value: null, source: "repo", fixture: "81_05_01_260605_VPWP50_head_missing.xml", observed: true },
  { field: "ReportDateTime", value: "not-a-date", source: "synthetic", fixture: "telegram-foundation/invalid-report-datetime.xml", observed: false },
] as const;

export const WEATHER_CW_CORPUS_EVIDENCE = [
  {
    fixture: "10_03_01_171016_VPTW60.xml",
    sha256: "91ea5acb655f8f8255e2de54935882232cf5fe4f29cac846fc0559d67be96b1f",
    bytes: 57_157,
    evidence: ["InfoType=発表", "Status=通常", "WindSpeed condition=以上"],
  },
  {
    fixture: "10_05_02_200826_VPTW60.xml",
    sha256: "f2f386ec3963854a7e708c203ab4bf21c0f833726bd76c930fa20290e117b326",
    bytes: 29_080,
    evidence: ["InfoType=訂正"],
  },
  {
    fixture: "15_16_01_241031_VPWW56.xml",
    sha256: "65f7d65759f8aa51e4ce68ec782db60a9ed8ee3fa642355eb5f78645d4cc14f6",
    bytes: 13_586,
    evidence: ["Serial 欠落"],
  },
] as const;

interface LegacyCounterpartCharacterization {
  sourceType: "VPOA50" | "VPNO50" | "VXWW50";
  counterpartTypes: readonly string[];
  sourceFixtures: readonly string[];
  counterpartFixtures: readonly (readonly string[])[];
  status: "confirmed" | "unconfirmed";
  note: string;
}

export const LEGACY_COUNTERPART_CHARACTERIZATION: readonly LegacyCounterpartCharacterization[] = [
  {
    sourceType: "VPOA50",
    counterpartTypes: [],
    sourceFixtures: [],
    counterpartFixtures: [],
    status: "unconfirmed",
    note: "repo fixture と WeatherCW の双方で source 自体を確認できず、候補を推定しない",
  },
  {
    sourceType: "VPNO50",
    counterpartTypes: [],
    sourceFixtures: [],
    counterpartFixtures: [],
    status: "unconfirmed",
    note: "repo fixture と WeatherCW の双方で source 自体を確認できず、候補を推定しない",
  },
  {
    sourceType: "VXWW50",
    counterpartTypes: [],
    sourceFixtures: [],
    counterpartFixtures: [],
    status: "unconfirmed",
    note: "repo fixture と WeatherCW の双方で source 自体を確認できず、候補を推定しない",
  },
] as const;

export type CancellationPolicy = "restorePrevious" | "clearCurrent" | "markCancelled";

interface CancellationCharacterization {
  family: string;
  headTypes: readonly string[];
  currentBehavior: string;
  targetPolicy: CancellationPolicy;
  stateOwners: readonly string[];
}

export const CANCELLATION_CHARACTERIZATION = {
  eew: [{
    family: "eew", headTypes: ["VXSE43", "VXSE44", "VXSE45"],
    currentBehavior: "EewTracker は cancelled terminal を保持し、DisplayStateStore は active EEW を削除",
    targetPolicy: "markCancelled", stateOwners: ["EewTracker", "DisplayStateStore"],
  }],
  earthquake: [{
    family: "earthquake", headTypes: ["VXSE51", "VXSE52", "VXSE53", "VXSE61"],
    currentBehavior: "DisplayStateStore は地図 source を削除し、QuakeExtremeStore は震度7背景 source を削除。DailyQuakeCounter は取消を無視して履歴を維持",
    targetPolicy: "markCancelled", stateOwners: ["DisplayStateStore", "QuakeExtremeStore"],
  }],
  seismicText: [{
    family: "seismicText", headTypes: ["VXSE56", "VXSE60", "VZSE40"],
    currentBehavior: "transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
  lgObservation: [{
    family: "lgObservation", headTypes: ["VXSE62"],
    currentBehavior: "transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: ["StandbyStateStore"],
  }],
  tsunami: [{
    family: "tsunami", headTypes: ["VTSE41", "VTSE51", "VTSE52"],
    currentBehavior: "active level と lastInfo を clear、watermark は維持",
    targetPolicy: "clearCurrent", stateOwners: ["TsunamiStateHolder", "DisplayStateStore"],
  }],
  volcano: [
    {
      family: "volcanoAlert", headTypes: ["VFVO50", "VFVO51", "VFSVii"],
      currentBehavior: "火山コード単位で alert を解除し eruption event は維持",
      targetPolicy: "clearCurrent", stateOwners: ["VolcanoStateHolder", "StandbyStateStore"],
    },
    {
      family: "volcanoEruption", headTypes: ["VFVO52", "VFVO54", "VFVO55", "VFVO56", "VFVO60"],
      currentBehavior: "EventID／火山コードで最新噴火 event を削除",
      targetPolicy: "clearCurrent", stateOwners: ["StandbyStateStore"],
    },
    {
      family: "volcanoAshfall", headTypes: ["VFVO53"],
      currentBehavior: "集約待ち buffer と火山コード別の最新 event を削除",
      targetPolicy: "clearCurrent", stateOwners: ["VolcanoVfvo53Aggregator", "StandbyStateStore"],
    },
  ],
  nankaiTrough: [{
    family: "nankaiTrough", headTypes: ["VYSE50", "VYSE51", "VYSE52", "VYSE60"],
    currentBehavior: "current active state を削除",
    targetPolicy: "clearCurrent", stateOwners: ["StandbyStateStore"],
  }],
  weather: [
    {
      family: "VPWS50", headTypes: ["VPWS50"],
      currentBehavior: "取消対象一致時に一つ前の snapshot へ rollback",
      targetPolicy: "restorePrevious", stateOwners: ["Vpws50StateHolder", "StandbyStateStore", "WeatherPromotionStore"],
    },
    {
      family: "VPWW56", headTypes: ["VPWW56"],
      currentBehavior: "stream current view を clear、watermark は維持",
      targetPolicy: "clearCurrent", stateOwners: ["Vpww56StateHolder", "StandbyStateStore", "WeatherPromotionStore"],
    },
    {
      family: "VPWW55-61-except56", headTypes: ["VPWW55", "VPWW57", "VPWW58", "VPWW59", "VPWW60", "VPWW61"],
      currentBehavior: "専用 active state holder を持たず transient 取消表示",
      targetPolicy: "markCancelled", stateOwners: [],
    },
  ],
  tornado: [{
    family: "tornado", headTypes: ["VPHW50", "VPHW51"],
    currentBehavior: "発表官署単位の active state を削除",
    targetPolicy: "clearCurrent", stateOwners: ["StandbyStateStore"],
  }],
  briefing: [{
    family: "briefing", headTypes: ["VPBS50"],
    currentBehavior: "durable current を持たない transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
  earlyWeather: [{
    family: "earlyWeather", headTypes: ["VPAW51"],
    currentBehavior: "durable current を持たない transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
  weatherWarningTimeseries: [{
    family: "weatherWarningTimeseries", headTypes: ["VPWP50"],
    currentBehavior: "取消電文も最新 detail snapshot として cache する",
    targetPolicy: "markCancelled", stateOwners: ["Vpwp50DetailCache"],
  }],
  climateInfo: [{
    family: "climateInfo", headTypes: ["VPZI50", "VPCI50"],
    currentBehavior: "durable current を持たない transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
  weatherExplanation: [{
    family: "weatherExplanation", headTypes: ["VPCJ51", "VPZJ51", "VPFJ51", "VMCJ53", "VMCJ54", "VMCJ55"],
    currentBehavior: "durable current を持たない transient 取消表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
  heatAlert: [{
    family: "heatAlert", headTypes: ["VPFT50"],
    currentBehavior: "対象日・地域の active state を削除",
    targetPolicy: "clearCurrent", stateOwners: ["StandbyStateStore"],
  }],
  typhoonAnalysis: [{
    family: "typhoonAnalysis", headTypes: ["VPTW60", "VPTW61", "VPTW62"],
    currentBehavior: "台風キーを削除。transitionedToLow／formationCancelled も terminal",
    targetPolicy: "clearCurrent", stateOwners: ["StandbyStateStore"],
  }],
  typhoonProbability: [{
    family: "typhoonProbability", headTypes: ["VPTA50"],
    currentBehavior: "EventID／対象時刻の active cache を削除",
    targetPolicy: "clearCurrent", stateOwners: ["TyphoonProbabilityStateHolder"],
  }],
  floodForecast: [{
    family: "floodForecast", headTypes: ["VXKO50-89", "VXSU50-59"],
    currentBehavior: "EventID 単位の active history と display state を削除",
    targetPolicy: "clearCurrent", stateOwners: ["FloodForecastStateHolder", "FloodActiveReducer", "StandbyStateStore"],
  }],
  raw: [{
    family: "raw", headTypes: ["*"],
    currentBehavior: "状態を推定せず transient に表示",
    targetPolicy: "markCancelled", stateOwners: [],
  }],
} as const satisfies Record<PresentationDomain, readonly CancellationCharacterization[]>;

export const STATE_HOLDER_CHARACTERIZATION = [
  { owner: "DailyQuakeCounter", sourceFile: "src/engine/messages/daily-quake-counter.ts", domains: ["earthquake"], cancellationRole: "recent/daily earthquake observation state" },
  { owner: "DisplayStateStore", sourceFile: "src/engine/display/state-store.ts", domains: ["eew", "earthquake", "tsunami"], cancellationRole: "emergency state and tsunami observation/level state" },
  { owner: "EewTracker", sourceFile: "src/engine/eew/eew-tracker.ts", domains: ["eew"], cancellationRole: "mark cancelled event" },
  { owner: "FloodActiveReducer", sourceFile: "src/engine/display/flood-active-reducer.ts", domains: ["floodForecast"], cancellationRole: "EventID active state and tombstone" },
  { owner: "FloodForecastStateHolder", sourceFile: "src/engine/messages/flood-forecast-state.ts", domains: ["floodForecast"], cancellationRole: "EventID history rollback/clear" },
  { owner: "PresentationDiffStore", sourceFile: "src/engine/presentation/diff-store.ts", domains: ["*"], cancellationRole: "presentation diff baseline; no durable cancellation ownership" },
  { owner: "QuakeExtremeStore", sourceFile: "src/engine/display/quake-extreme-store.ts", domains: ["earthquake"], cancellationRole: "extreme background lifecycle" },
  { owner: "StandbyStateStore", sourceFile: "src/engine/display/standby-state-store.ts", domains: ["earthquake", "lgObservation", "volcano", "nankaiTrough", "weather", "tornado", "heatAlert", "typhoonAnalysis", "floodForecast"], cancellationRole: "standby active card state and tombstones" },
  { owner: "TsunamiStateHolder", sourceFile: "src/engine/messages/tsunami-state.ts", domains: ["tsunami"], cancellationRole: "active level and watermark" },
  { owner: "TyphoonProbabilityStateHolder", sourceFile: "src/engine/messages/typhoon-probability-state.ts", domains: ["typhoonProbability"], cancellationRole: "EventID probability cache" },
  { owner: "VolcanoStateHolder", sourceFile: "src/engine/messages/volcano-state.ts", domains: ["volcano"], cancellationRole: "volcano alert revision state" },
  { owner: "VolcanoVfvo53Aggregator", sourceFile: "src/engine/messages/volcano-vfvo53-aggregator.ts", domains: ["volcano"], cancellationRole: "VFVO53 batch window; transient aggregation only" },
  { owner: "Vpwp50DetailCache", sourceFile: "src/engine/messages/vpwp50-detail-cache.ts", domains: ["weatherWarningTimeseries"], cancellationRole: "source detail cache" },
  { owner: "Vpws50StateHolder", sourceFile: "src/engine/messages/vpws50-state.ts", domains: ["weather"], cancellationRole: "current/previous snapshots for restorePrevious" },
  { owner: "Vpww56StateHolder", sourceFile: "src/engine/messages/vpww56-state.ts", domains: ["weather"], cancellationRole: "stream current view and watermark" },
  { owner: "WeatherPromotionStore", sourceFile: "src/engine/display/weather-promotion-store.ts", domains: ["weather"], cancellationRole: "promoted emergency weather lifecycle" },
] as const;

export const CANCELLATION_STATE_SCOPE = {
  included: "取消・解除・terminal 入力を条件として active/dedup/detail lifecycle を変更する holder",
  excluded: [
    "受信した全 outcome を加算する TelegramStats／SummaryWindowTracker",
    "全 event を履歴へ積む InfoDisplayHub recentTicker",
    "取消を特別扱いせず次回差分の比較元にする PresentationDiffStore",
    "通知送信履歴・ログ・transport client 管理",
  ],
  ignoredButEnumerated: [
    "DailyQuakeCounter は earthquake 取消を明示的に無視し、当日履歴を変更しない",
    "StandbyStateStore の earthquake host は取消を明示的に無視する",
  ],
} as const;

interface CancellationMutationEvidence {
  domain: PresentationDomain;
  family: string;
  owner: string;
  behavior: string;
  sources: readonly {
    sourceFile: string;
    needles: readonly string[];
  }[];
}

export const CANCELLATION_MUTATION_EVIDENCE = [
  {
    domain: "eew", family: "eew", owner: "EewTracker",
    behavior: "取消を event の terminal flag と成立元 family/revision として保持",
    sources: [{
      sourceFile: "src/engine/eew/eew-tracker.ts",
      needles: [
        'const isCancelled = info.infoType === "取消";',
        "event.isCancelled = isCancelled;",
        "event.terminalOwner = {",
      ],
    }],
  },
  {
    domain: "eew", family: "eew", owner: "DisplayStateStore",
    behavior: "取消時に active EEW を削除",
    sources: [{
      sourceFile: "src/engine/display/state-store.ts",
      needles: ["if (input.isCancellation) {", "return this.activeEews.delete(eventId);"],
    }],
  },
  {
    domain: "earthquake", family: "earthquake", owner: "DisplayStateStore",
    behavior: "取消 command で該当 source の quake map contribution を削除",
    sources: [
      {
        sourceFile: "src/engine/display/project-event.ts",
        needles: ['if (event.isCancellation) {', 'return { kind: "remove", eventKey, sourceType, reason: "cancelled"'],
      },
      {
        sourceFile: "src/engine/display/state-store.ts",
        needles: ["bySource?.delete(command.sourceType)", "this.quakeMapContributions.delete(eventKey)"],
      },
    ],
  },
  {
    domain: "earthquake", family: "earthquake", owner: "QuakeExtremeStore",
    behavior: "取消時に震度7背景の該当 source を削除",
    sources: [{
      sourceFile: "src/engine/display/quake-extreme-store.ts",
      needles: ["if (input.isCancellation) {", "changed = this.removeSource(input.groupKey, input.type);"],
    }],
  },
  {
    domain: "lgObservation", family: "lgObservation", owner: "StandbyStateStore",
    behavior: "EventID 単位の長周期 active state を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (event.isCancellation) {", "this.longPeriodByEvent.delete(event.eventId)"],
    }],
  },
  {
    domain: "tsunami", family: "tsunami", owner: "TsunamiStateHolder",
    behavior: "active level と lastInfo を clear して watermark を維持",
    sources: [{
      sourceFile: "src/engine/messages/tsunami-state.ts",
      needles: ['if (info.infoType === "取消") {', "this.clearActiveState();"],
    }],
  },
  {
    domain: "tsunami", family: "tsunami", owner: "DisplayStateStore",
    behavior: "VTSE41 取消で display tsunami と観測 revision を clear",
    sources: [{
      sourceFile: "src/engine/display/state-store.ts",
      needles: ['if (dto.type !== "VTSE41") return false;', "this.tsunami = null;"],
    }],
  },
  {
    domain: "volcano", family: "volcanoAlert", owner: "VolcanoStateHolder",
    behavior: "火山コード単位の alert entry を削除",
    sources: [{
      sourceFile: "src/engine/messages/volcano-state.ts",
      needles: ['if (info.infoType === "取消") {', "this.entries.delete(info.volcanoCode);"],
    }],
  },
  {
    domain: "volcano", family: "volcanoAlert", owner: "StandbyStateStore",
    behavior: "alert field を解除し event がなければカードを削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (update.isCancellation) {", "state.alertLevel = null;", "state.alertClass = null;"],
    }],
  },
  {
    domain: "volcano", family: "volcanoEruption", owner: "StandbyStateStore",
    behavior: "最新 eruption event を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["state.latestEvent = update.isCancellation ? null", "state.latestEventId = update.isCancellation ? null"],
    }],
  },
  {
    domain: "volcano", family: "volcanoAshfall", owner: "VolcanoVfvo53Aggregator",
    behavior: "取消火山を VFVO53 集約 buffer から削除",
    sources: [{
      sourceFile: "src/engine/messages/volcano-vfvo53-aggregator.ts",
      needles: ['if (info.infoType === "取消") {', "this.removeCancelled(info);", "this.items.delete(info.volcanoCode);"],
    }],
  },
  {
    domain: "volcano", family: "volcanoAshfall", owner: "StandbyStateStore",
    behavior: "VFVO53 の最新 event を火山コード単位で削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["state.latestEvent = update.isCancellation ? null", "state.latestEventId = update.isCancellation ? null"],
    }],
  },
  {
    domain: "nankaiTrough", family: "nankaiTrough", owner: "StandbyStateStore",
    behavior: "current active state を null にする",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["status.action === \"deactivate\" || event.isCancellation", "this.nankaiTrough = null;"],
    }],
  },
  {
    domain: "weather", family: "VPWS50", owner: "Vpws50StateHolder",
    behavior: "取消対象一致時に previous snapshot へ rollback",
    sources: [
      {
        sourceFile: "src/engine/presentation/processors/process-weather.ts",
        needles: ['if (info.infoType === "取消") {', "deps.vpws50State.rollback(identity)"],
      },
      {
        sourceFile: "src/engine/messages/vpws50-state.ts",
        needles: ["rollback(target: string | WeatherReportIdentity)", "this.current = last.snapshot;"],
      },
    ],
  },
  {
    domain: "weather", family: "VPWS50", owner: "StandbyStateStore",
    behavior: "rollback 後の空 alerts で source card state を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (alerts.length === 0) {", "this.weatherAlerts.delete(source);"],
    }],
  },
  {
    domain: "weather", family: "VPWS50", owner: "WeatherPromotionStore",
    behavior: "rollback 後の高 severity 空集合で昇格 state を終了",
    sources: [{
      sourceFile: "src/engine/display/weather-promotion-store.ts",
      needles: ["高 severity 集合が空 = 警報解除", "this.records[source] = null;"],
    }],
  },
  {
    domain: "weather", family: "VPWW56", owner: "Vpww56StateHolder",
    behavior: "取消対象一致時に stream view を clear",
    sources: [{
      sourceFile: "src/engine/messages/vpww56-state.ts",
      needles: ['if (info.infoType === "取消") {', "entry.view = undefined;", "entry.currentIdentity = null;"],
    }],
  },
  {
    domain: "weather", family: "VPWW56", owner: "StandbyStateStore",
    behavior: "clear 後の空 alerts で source card state を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (alerts.length === 0) {", "this.weatherAlerts.delete(source);"],
    }],
  },
  {
    domain: "weather", family: "VPWW56", owner: "WeatherPromotionStore",
    behavior: "clear 後の高 severity 空集合で昇格 state を終了",
    sources: [{
      sourceFile: "src/engine/display/weather-promotion-store.ts",
      needles: ["高 severity 集合が空 = 警報解除", "this.records[source] = null;"],
    }],
  },
  {
    domain: "tornado", family: "tornado", owner: "StandbyStateStore",
    behavior: "発表官署単位の active state を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["event.isCancellation || raw.activeAreaCount === 0", "this.tornadoByOffice.delete(publishingOffice)"],
    }],
  },
  {
    domain: "weatherWarningTimeseries", family: "weatherWarningTimeseries", owner: "Vpwp50DetailCache",
    behavior: "取消も最新 detail snapshot として置換",
    sources: [
      {
        sourceFile: "src/engine/presentation/processors/process-weather-warning-timeseries.ts",
        needles: ["取消電文でも cache は更新される", "deps.vpwp50Cache.rememberLatest(info);"],
      },
      {
        sourceFile: "src/engine/messages/vpwp50-detail-cache.ts",
        needles: ["rememberLatest(info: ParsedWeatherWarningTimeseriesInfo)", "this.latest = persisted;"],
      },
    ],
  },
  {
    domain: "heatAlert", family: "heatAlert", owner: "StandbyStateStore",
    behavior: "対象日・地域の active state を削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (update.isCancellation) {", "this.heatAlerts.delete(key)"],
    }],
  },
  {
    domain: "typhoonAnalysis", family: "typhoonAnalysis", owner: "StandbyStateStore",
    behavior: "取消・terminal lifecycle で台風キーを削除",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["if (update.isCancellation) {", "this.typhoons.delete(update.typhoonKey)"],
    }],
  },
  {
    domain: "typhoonProbability", family: "typhoonProbability", owner: "TyphoonProbabilityStateHolder",
    behavior: "EventID の確率 cache を rollback",
    sources: [
      {
        sourceFile: "src/engine/presentation/processors/process-typhoon-probability.ts",
        needles: ['info.infoType === "取消"', "deps.typhoonProbabilityState.rollback"],
      },
      {
        sourceFile: "src/engine/messages/typhoon-probability-state.ts",
        needles: ["rollback(eventId: string)", "this.last.delete(eventId);"],
      },
    ],
  },
  {
    domain: "floodForecast", family: "floodForecast", owner: "FloodForecastStateHolder",
    behavior: "EventID の観測履歴を rollback",
    sources: [
      {
        sourceFile: "src/engine/presentation/processors/process-flood-forecast.ts",
        needles: ['if (info.infoType === "取消") {', "deps.floodForecastState.rollback(info.eventId);"],
      },
      {
        sourceFile: "src/engine/messages/flood-forecast-state.ts",
        needles: ["rollback(eventId: string)", "this.events.delete(eventId);"],
      },
    ],
  },
  {
    domain: "floodForecast", family: "floodForecast", owner: "FloodActiveReducer",
    behavior: "cancel update で EventID active state を削除し tombstone を維持",
    sources: [{
      sourceFile: "src/engine/display/flood-active-reducer.ts",
      needles: ['update.mode === "cancel"', "this.events.delete(update.eventId);"],
    }],
  },
  {
    domain: "floodForecast", family: "floodForecast", owner: "StandbyStateStore",
    behavior: "projected cancel を FloodActiveReducer へ適用",
    sources: [{
      sourceFile: "src/engine/display/standby-state-store.ts",
      needles: ["projectFloodUpdate(event)", "this.floods.apply(update, nowMs)"],
    }],
  },
] as const satisfies readonly CancellationMutationEvidence[];

interface FragmentMergeEvidence {
  headType: "VTSE51" | "VTSE52";
  extractItems: string;
  itemSubjectKey: string;
  itemFingerprint: string;
  fingerprintVersion: string;
  fragmentEvidence: {
    corpusFixtures: readonly string[];
    regressionTests: readonly string[];
    rationale: string;
    limits: string;
  };
}

export const FRAGMENT_MERGE_ALLOWLIST = {
  "tsunamiObservation:VTSE51": {
    headType: "VTSE51",
    extractItems: "ParsedTsunamiInfo.observations",
    itemSubjectKey: "stationCode; code 欠落時だけ areaName+stationName legacy fallback",
    itemFingerprint: "stationCode を除く観測値・condition・areaName・stationName の canonical JSON",
    fingerprintVersion: "tsunami-observation-v1",
    fragmentEvidence: {
      corpusFixtures: ["32-39_11_10_250206_VTSE51.xml"],
      regressionTests: [
        "test/engine/display/state-store.test.ts::VTSE51/52 は観測点コード単位で新 revision を merge し、部分報と遅延旧報で既存観測を失わない",
      ],
      rationale: "反復 Station と観測点 Code の実在、および部分報・遅延旧報 baseline がある",
      limits: "corpus は station identity の根拠のみ。同一 revision の分割到着は Phase 3 の synthetic regression で補う",
    },
  },
  "tsunamiObservation:VTSE52": {
    headType: "VTSE52",
    extractItems: "ParsedTsunamiInfo.observations",
    itemSubjectKey: "stationCode; code 欠落時だけ areaName+stationName legacy fallback",
    itemFingerprint: "stationCode を除く観測値・condition・areaName・stationName の canonical JSON",
    fingerprintVersion: "tsunami-observation-v1",
    fragmentEvidence: {
      corpusFixtures: ["61_11_01_250206_VTSE52.xml"],
      regressionTests: [
        "test/engine/display/state-store.test.ts::VTSE51 と VTSE52 は独立した revision 系列として、報告時刻が前後しても別観測点を保持する",
      ],
      rationale: "反復 Station と観測点 Code の実在、および VTSE51/52 独立系列 baseline がある",
      limits: "corpus は station identity の根拠のみ。同一 revision の分割到着は Phase 3 の synthetic regression で補う",
    },
  },
} as const satisfies Record<
  "tsunamiObservation:VTSE51" | "tsunamiObservation:VTSE52",
  FragmentMergeEvidence
>;

export type FragmentMergeFamily = keyof typeof FRAGMENT_MERGE_ALLOWLIST;

export function isFragmentMergeAllowed(revisionFamily: string): revisionFamily is FragmentMergeFamily {
  return Object.hasOwn(FRAGMENT_MERGE_ALLOWLIST, revisionFamily);
}

export const INVALID_REPORT_DATETIME_FIXTURE_EXPECTATION = {
  fixture: "telegram-foundation/invalid-report-datetime.xml",
  transportHeadType: "VXSE51",
  eventId: "phase0-invalid-report-datetime",
  rawReportDateTime: "not-a-date",
  epochMs: null,
  valid: false,
  reason: "invalidFormat",
  diagnosticTextIncludes: [
    "VXSE51",
    "phase0-invalid-report-datetime",
    "not-a-date",
    "受信時刻",
    "日時不正",
  ],
  transientSurfaces: ["cli", "diagnosticTicker"],
  excludedSurfaces: ["normalTicker", "card", "map", "activeState", "notification", "sound"],
  durable: false,
} as const;

export const REPAIR_A_TO_C_BASELINES = [
  {
    repair: "A",
    behavior: "parser は raw NaN／condition／description を magnitudeInfo に保持し legacy magnitude は空へ落とす。表示層は description を優先し MNaN を出さない",
    testFile: "test/dmdata/telegram-parser.test.ts",
    expectedAssertions: [
      'magnitude: "",',
      'value: "NaN",',
      'condition: "不明",',
      'description: "Ｍ８を超える巨大地震",',
    ],
  },
  {
    repair: "A",
    behavior: "EEW の From-To 範囲と over を上限側 rank で表示する",
    testFile: "display/frontend/src/components/__tests__/eew-panel.test.ts",
    expectedAssertions: [
      'toEqual(["震度5弱程度以上", "震度3〜4"])',
      'labels[0].classList.contains("int-r5")',
      'labels[1].classList.contains("int-r4")',
    ],
  },
  {
    repair: "A",
    behavior: "若干の海面変動を advisory 音へ降格する",
    testFile: "test/engine/presentation/level-helpers.test.ts",
    expectedAssertions: ['kind: "津波予報（若干の海面変動）"', ').toBe("warning");'],
  },
  {
    repair: "A",
    behavior: "同一 revision の訂正だけを置換し通常重複を拒否する",
    testFile: "test/engine/display/standby-state-store.test.ts",
    expectedAssertions: [
      'guard.accept("typhoon:TC-1", revision, T0 + 1)).toBe(false)',
      'guard.accept("typhoon:TC-1", revision, T0 + 2, undefined, true)).toBe(true)',
    ],
  },
  {
    repair: "B",
    behavior: "津波実測値と上昇中 condition を保持する",
    testFile: "test/dmdata/telegram-parser.test.ts",
    expectedAssertions: [
      'find((obs) => obs.name === "釜石")?.maxHeightValue',
      '.toBe("３．２ｍ");',
    ],
  },
  {
    repair: "B",
    behavior: "VTSE51/52 観測点 merge が部分報と遅延旧報を失わない",
    testFile: "test/engine/display/state-store.test.ts",
    expectedAssertions: [
      'station("21001", "宮古（更新名）", "2.0m")',
      'station("21002", "大船渡", "1.2m")',
      'station("99999", "旧報だけの点", "9.9m")',
      ')).toBe(false);',
    ],
  },
  {
    repair: "C",
    behavior: "空コード VFVO56 取消を EventID で削除する",
    testFile: "test/engine/display/standby-state-store.test.ts",
    expectedAssertions: [
      "expect(restored.snapshotItems()).toEqual([]);",
      "expect(afterRestart.snapshotItems()).toEqual([]);",
      "expect(afterRestart.applyEvent(issue, cancelMs + 2)).toEqual({",
    ],
  },
  {
    repair: "C",
    behavior: "台風の発生予想終了を tombstone 化する",
    testFile: "test/engine/display/standby-state-store.test.ts",
    expectedAssertions: [
      "expect(store.snapshotItems()).toEqual([]);",
      'id: "stale-forming",',
      "durableChanged: false,",
    ],
  },
  {
    repair: "C",
    behavior: "Headline-only 洪水の発表と解除を state へ反映する",
    testFile: "test/engine/display/standby-state-store.test.ts",
    expectedAssertions: [
      'riverKey: "1234567890", level: "L3", station: null',
      'riverKey: "9876543210", level: "L3", station: null',
      "expect(store.snapshotItems().find((item) => item.kind === \"flood\")).toBeUndefined();",
    ],
  },
] as const;
