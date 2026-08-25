// display protocol の型付きフィクスチャビルダー。
//
// DisplayEventDtoV1 / DisplayStateSnapshotV1 は必須フィールドが増え続けるため、テスト側で
// object literal を直接書くと protocol にフィールドが足されるたび全テストが型エラーになる。
// 既定値を土台に敷き、テストが主張したい値だけ override で上書きする形に寄せる。

import { DISPLAY_PROTOCOL_VERSION } from "../../src/engine/display/types";
import type {
  ActiveStandbyCardV1,
  DisplayBriefingEntryV1,
  DisplayBriefingSeverityEvidenceV1,
  DisplayEventDtoV1,
  DisplayStateSnapshotV1,
} from "../../src/engine/display/types";

/** アサート対象にならない詰め物を既定値で埋めた DisplayEventDtoV1 */
export function displayEventDto(over: Partial<DisplayEventDtoV1> = {}): DisplayEventDtoV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: 0,
    id: "m0",
    eventKey: "k0",
    groupKey: null,
    domain: "weather",
    type: "VPWW55",
    infoType: "発表",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    title: "テスト",
    headline: null,
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "normal",
    isCancellation: false,
    summary: { text: "t", role: "muted" },
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    ...over,
  };
}

/** アサート対象にならない詰め物を既定値で埋めた DisplayStateSnapshotV1 */
export function displaySnapshot(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    generatedAt: "2026-07-06T21:00:00+09:00",
    seq: 0,
    activeEews: [],
    tsunami: null,
    largeQuakes: [],
    weatherAlerts: [],
    recentQuakes: [],
    latestQuake: null,
    stats: null,
    severityTier: "calm",
    connection: { dmdata: "connected", lastReceivedAt: null, disconnectedSince: null, reason: null },
    recentTicker: [],
    ...over,
  };
}

type BriefingCard = Extract<ActiveStandbyCardV1, { kind: "briefing" }>;

/** card state tests 用の、ticker／raw XML を含まない entry builder。 */
export function displayBriefingEntry(over: Partial<DisplayBriefingEntryV1> = {}): DisplayBriefingEntryV1 {
  return {
    key: "card:vpbs:briefing-1",
    source: "vpbs50",
    sourceEventId: "briefing-1",
    title: "気象防災速報",
    headline: null,
    conditions: [],
    targetAreas: [],
    reportDateTime: "2026-07-06T21:00:00+09:00",
    publishingOffice: "気象庁",
    infoType: "発表",
    frameLevel: "info",
    severityEvidence: [],
    qualifier: null,
    updatedAt: "2026-07-06T12:00:00.000Z",
    expiresAt: "2026-07-06T14:00:00.000Z",
    generation: 1,
    ...over,
  };
}

/** briefing outer card の最小 wire fixture。 */
export function displayBriefingCard(over: Partial<BriefingCard> = {}): BriefingCard {
  const base: BriefingCard = {
    kind: "briefing",
    surface: "corner-right",
    key: "briefing:active",
    sourceEventIds: ["briefing-1"],
    updatedAt: "2026-07-06T12:00:00.000Z",
    expiresAt: "2026-07-06T14:00:00.000Z",
    restored: false,
    severity: "info",
    data: { generation: 1, entries: [displayBriefingEntry()] },
  };
  return {
    ...base,
    ...over,
    data: { ...base.data, ...(over.data ?? {}) },
  };
}

export interface BriefingCardFixtureExpectation {
  fixture: string;
  title: string;
  headline: string | null;
  conditions: readonly string[];
  targetAreas: readonly { name: string; code: string }[];
  reportDateTime: string;
  publishingOffice: string;
  infoType: string;
  severityEvidence: readonly Pick<
    DisplayBriefingSeverityEvidenceV1,
    "source" | "condition" | "tag" | "displaySeverity" | "soundLevel"
  >[];
  qualifier: string | null;
}

/**
 * VPBS50 raw fixture から確認した card payload の characterization matrix。
 * raw XML、CLI 整形文、ticker sentence はこの期待値にも card wire にも含めない。
 */
export const BRIEFING_CARD_FIXTURE_MATRIX: readonly BriefingCardFixtureExpectation[] = [
  {
    fixture: "82_01_01_260324_VPBS50.xml",
    title: "千葉県気象防災速報（線状降水帯発生）",
    headline: "千葉県北西部、北東部、南部では、線状降水帯による非常に激しい雨が同じ場所で降り続いています。命に危険が及ぶ災害発生の危険度が急激に高まっています。",
    conditions: ["線状降水帯発生"],
    targetAreas: [
      { name: "北西部", code: "120010" },
      { name: "北東部", code: "120020" },
      { name: "南部", code: "120030" },
    ],
    reportDateTime: "2023-09-08T10:19:00+09:00",
    publishingOffice: "気象庁",
    infoType: "発表",
    severityEvidence: [{ source: "map", condition: "線状降水帯発生", tag: "linearRainObserved", displaySeverity: "nonLevelSpecial", soundLevel: "warning" }],
    qualifier: null,
  },
  {
    fixture: "82_03_01_260324_VPBS50.xml",
    title: "福岡県気象防災速報（線状降水帯直前予測）",
    headline: "福岡県福岡地方では、今後３時間以内に線状降水帯が発生し、非常に激しい雨が同じ場所で降り続く可能性が高まっています。命に危険が及ぶ災害発生の危険度が急激に高まるおそれがあります。",
    conditions: ["線状降水帯直前"],
    targetAreas: [{ name: "福岡地方", code: "400010" }],
    reportDateTime: "2023-07-10T01:59:00+09:00",
    publishingOffice: "気象庁",
    infoType: "発表",
    severityEvidence: [{ source: "map", condition: "線状降水帯直前", tag: "linearRainPredicted", displaySeverity: "nonLevelWarning", soundLevel: "warning" }],
    qualifier: null,
  },
  {
    fixture: "82_01_02_250630_VPBS50.xml",
    title: "網走・北見・紋別地方気象防災速報（記録的短時間大雨）",
    headline: "１３時１０分、北海道美幌町で記録的短時間大雨。\n美幌町付近で１時間に約１００ミリ。\n美幌で１時間に９３ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"],
    targetAreas: [{ name: "網走地方", code: "013010" }],
    reportDateTime: "2023-07-13T13:29:26+09:00",
    publishingOffice: "気象庁",
    infoType: "発表",
    severityEvidence: [{ source: "map", condition: "記録雨", tag: "recordRain", displaySeverity: "nonLevelSpecial", soundLevel: "warning" }],
    qualifier: null,
  },
  {
    fixture: "82_01_03_241031_VPBS50.xml",
    title: "滋賀県気象防災速報（短時間大雪）",
    headline: "長浜市余呉町柳ヶ瀬で２４日６時までの６時間で３７センチの顕著な降雪を観測しました。この強い雪は２４日夜遅くにかけて続く見込みです。湖北では、深刻な交通障害の発生するおそれが高まっています。",
    conditions: ["短時間大雪"],
    targetAreas: [{ name: "北部", code: "250020" }],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "発表",
    severityEvidence: [{ source: "map", condition: "短時間大雪", tag: "shortSnow", displaySeverity: "nonLevelWarning", soundLevel: "warning" }],
    qualifier: null,
  },
  {
    fixture: "synthetic_VPBS50_multi.xml",
    title: "滋賀県気象防災速報（短時間大雪）",
    headline: "長浜市余呉町柳ヶ瀬で２４日６時までの６時間で３７センチの顕著な降雪を観測しました。この強い雪は２４日夜遅くにかけて続く見込みです。湖北では、深刻な交通障害の発生するおそれが高まっています。",
    conditions: ["短時間大雪", "記録的短時間大雨"],
    targetAreas: [{ name: "北部", code: "250020" }, { name: "南部", code: "250010" }],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "発表",
    severityEvidence: [
      { source: "map", condition: "短時間大雪", tag: "shortSnow", displaySeverity: "nonLevelWarning", soundLevel: "warning" },
      { source: "map", condition: "記録的短時間大雨", tag: "recordRain", displaySeverity: "nonLevelSpecial", soundLevel: "warning" },
    ],
    qualifier: null,
  },
  {
    fixture: "synthetic_VPBS50_unknown-tag.xml",
    title: "滋賀県気象防災速報",
    headline: "湖北では、深刻な交通障害の発生するおそれが高まっています。",
    conditions: ["謎の現象"],
    targetAreas: [{ name: "北部", code: "250020" }],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "発表",
    severityEvidence: [{ source: "unknown", condition: "謎の現象", tag: "other", displaySeverity: null, soundLevel: null }],
    qualifier: null,
  },
  {
    fixture: "synthetic_VPBS50_fallback-tag.xml",
    title: "滋賀県気象防災速報",
    headline: "湖北では、深刻な交通障害の発生するおそれが高まっています。",
    conditions: ["謎の現象"],
    targetAreas: [{ name: "北部", code: "250020" }],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "発表",
    severityEvidence: [{ source: "none", condition: "謎の現象", tag: "other", displaySeverity: null, soundLevel: null }],
    qualifier: null,
  },
  {
    fixture: "synthetic_VPBS50_empty.xml",
    title: "滋賀県気象防災速報",
    headline: "湖北では、深刻な交通障害の発生するおそれが高まっています。",
    conditions: [],
    targetAreas: [{ name: "北部", code: "250020" }],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "発表",
    severityEvidence: [],
    qualifier: null,
  },
  {
    fixture: "synthetic_VPBS50_cancel.xml",
    title: "滋賀県気象防災速報",
    headline: "滋賀県気象防災速報を取り消します。",
    conditions: [],
    targetAreas: [],
    reportDateTime: "2024-01-24T06:13:13+09:00",
    publishingOffice: "彦根地方気象台",
    infoType: "取消",
    severityEvidence: [],
    qualifier: null,
  },
];

export interface Phase6bBriefingCardFixtureExpectation {
  fixture: string;
  source: DisplayBriefingEntryV1["source"];
  sourceEventId: string;
  title: string;
  headline: string | null;
  conditions: readonly string[];
  targetAreas: readonly { name: string; code: string }[];
  reportDateTime: string;
  publishingOffice: string;
  infoType: string;
  frameLevel: DisplayBriefingEntryV1["frameLevel"];
  severityEvidence: readonly Partial<DisplayBriefingSeverityEvidenceV1>[];
  qualifier: string | null;
}

const PHASE6B_VPBS_RECORD_RAIN_EVIDENCE: readonly Partial<DisplayBriefingSeverityEvidenceV1>[] = [
  { source: "map", condition: "記録雨", tag: "recordRain", displaySeverity: "nonLevelSpecial", soundLevel: "warning" },
];

const PHASE6B_VPOA_HIGH_EVIDENCE: readonly Partial<DisplayBriefingSeverityEvidenceV1>[] = [
  { source: "head", condition: "発表", displaySeverity: "critical", severity: "high", kindCode: "1", status: null },
  { source: "body", condition: null, displaySeverity: "critical", severity: "high", kindCode: "1", status: "発表" },
];

/**
 * Phase 6B の実 6 pair を raw XML から転記した静的 card expected matrix。
 * parser 出力を期待値に使わず、VPBS50 と VPOA50 の card payload を別々に固定する。
 */
export const PHASE6B_BRIEFING_CARD_FIXTURE_MATRIX: readonly Phase6bBriefingCardFixtureExpectation[] = [
  {
    fixture: "phase6b_VPBS50_KJPTK202608221709_202608221709.xml", source: "vpbs50",
    sourceEventId: "KJPTK202608221709_202608221709",
    title: "東京都気象防災速報（記録的短時間大雨）",
    headline: "１７時、東京都北区、板橋区で記録的短時間大雨。\n北区付近で１時間に約１００ミリ。\n板橋区付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "東京地方", code: "130010" }],
    reportDateTime: "2026-08-22T17:09:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPBS50_KJPTK202608221709_202608221717.xml", source: "vpbs50",
    sourceEventId: "KJPTK202608221709_202608221717",
    title: "東京都気象防災速報（記録的短時間大雨）",
    headline: "１７時、東京都板橋区で記録的短時間大雨。\n板橋区付近で１時間に１２０ミリ以上。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "東京地方", code: "130010" }],
    reportDateTime: "2026-08-22T17:17:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPBS50_KJPTK202608221709_202608221727.xml", source: "vpbs50",
    sourceEventId: "KJPTK202608221709_202608221727",
    title: "東京都気象防災速報（記録的短時間大雨）",
    headline: "１７時２０分、東京都豊島区で記録的短時間大雨。\n豊島区付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "東京地方", code: "130010" }],
    reportDateTime: "2026-08-22T17:27:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPBS50_KJPTC202608211633_202608211633.xml", source: "vpbs50",
    sourceEventId: "KJPTC202608211633_202608211633",
    title: "埼玉県気象防災速報（記録的短時間大雨）",
    headline: "１６時２０分、埼玉県さいたま市で記録的短時間大雨。\nさいたま市付近で１時間に約１１０ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "南部", code: "110010" }],
    reportDateTime: "2026-08-21T16:33:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPBS50_KJPTC202608221709_202608221709.xml", source: "vpbs50",
    sourceEventId: "KJPTC202608221709_202608221709",
    title: "埼玉県気象防災速報（記録的短時間大雨）",
    headline: "１７時、埼玉県戸田市で記録的短時間大雨。\n戸田市付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "南部", code: "110010" }],
    reportDateTime: "2026-08-22T17:09:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPBS50_KJPDE202608201757_202608201757.xml", source: "vpbs50",
    sourceEventId: "KJPDE202608201757_202608201757",
    title: "福島県気象防災速報（記録的短時間大雨）",
    headline: "１７時５０分、福島県北塩原村で記録的短時間大雨。\n北塩原村付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["記録雨"], targetAreas: [{ name: "会津", code: "070030" }],
    reportDateTime: "2026-08-20T17:57:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPBS_RECORD_RAIN_EVIDENCE, qualifier: null,
  },
  {
    fixture: "phase6b_VPOA50_JPTK202608221709_202608221709.xml", source: "vpoa50",
    sourceEventId: "JPTK202608221709_202608221709", title: "東京都記録的短時間大雨情報",
    headline: "１７時、東京都北区、板橋区で記録的短時間大雨。\n北区付近で１時間に約１００ミリ。\n板橋区付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "東京都", code: "130000" }],
    reportDateTime: "2026-08-22T17:09:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
  {
    fixture: "phase6b_VPOA50_JPTK202608221709_202608221717.xml", source: "vpoa50",
    sourceEventId: "JPTK202608221709_202608221717", title: "東京都記録的短時間大雨情報",
    headline: "１７時、東京都板橋区で記録的短時間大雨。\n板橋区付近で１時間に１２０ミリ以上。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "東京都", code: "130000" }],
    reportDateTime: "2026-08-22T17:17:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
  {
    fixture: "phase6b_VPOA50_JPTK202608221709_202608221727.xml", source: "vpoa50",
    sourceEventId: "JPTK202608221709_202608221727", title: "東京都記録的短時間大雨情報",
    headline: "１７時２０分、東京都豊島区で記録的短時間大雨。\n豊島区付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "東京都", code: "130000" }],
    reportDateTime: "2026-08-22T17:27:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
  {
    fixture: "phase6b_VPOA50_JPTC202608211633_202608211633.xml", source: "vpoa50",
    sourceEventId: "JPTC202608211633_202608211633", title: "埼玉県記録的短時間大雨情報",
    headline: "１６時２０分、埼玉県さいたま市で記録的短時間大雨。\nさいたま市付近で１時間に約１１０ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "埼玉県", code: "110000" }],
    reportDateTime: "2026-08-21T16:33:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
  {
    fixture: "phase6b_VPOA50_JPTC202608221709_202608221709.xml", source: "vpoa50",
    sourceEventId: "JPTC202608221709_202608221709", title: "埼玉県記録的短時間大雨情報",
    headline: "１７時、埼玉県戸田市で記録的短時間大雨。\n戸田市付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "埼玉県", code: "110000" }],
    reportDateTime: "2026-08-22T17:09:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
  {
    fixture: "phase6b_VPOA50_JPDE202608201757_202608201757.xml", source: "vpoa50",
    sourceEventId: "JPDE202608201757_202608201757", title: "福島県記録的短時間大雨情報",
    headline: "１７時５０分、福島県北塩原村で記録的短時間大雨。\n北塩原村付近で１時間に約１００ミリ。\n猛烈な雨が降っており、災害発生の危険度が急激に高まっています。",
    conditions: ["発表"], targetAreas: [{ name: "福島県", code: "070000" }],
    reportDateTime: "2026-08-20T17:57:00+09:00", publishingOffice: "気象庁", infoType: "発表", frameLevel: "critical",
    severityEvidence: PHASE6B_VPOA_HIGH_EVIDENCE, qualifier: "対応電文未確認",
  },
];
