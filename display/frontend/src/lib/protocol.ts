// display/frontend/src/lib/protocol.ts
// 真実源: src/engine/display/protocol.ts (手動同期)。同期は root の
// test/engine/display/protocol-sync.test.ts が検証する。
// PROTOCOL-SYNC-BEGIN
// このマーカー間は display/frontend/src/lib/protocol.ts と全文一致させる (手動同期)。
// 同期は test/engine/display/protocol-sync.test.ts が検証する (Task 11 で作成)。

export const DISPLAY_PROTOCOL_VERSION = 1 as const;

export type DisplayFrameLevel = "critical" | "warning" | "normal" | "info" | "cancel";

export type DisplayColorRole =
  | DisplayFrameLevel
  | "eewWarning" | "eewForecast"
  | "tsunamiMajor" | "tsunamiWarning" | "tsunamiAdvisory"
  | "quakeMajor"
  | "weatherEmergency" | "weatherWarning" | "weatherAdvisory"   // weatherEmergency を追加
  | "connectionOk" | "connectionStale"
  | "muted";

export interface DisplaySummaryLineV1 {
  text: string;
  role: DisplayColorRole;
}

export interface DisplayEewRegionV1 {
  name: string;
  intensity: string;            // 予測震度 (下限)
  intensityTo: string | null;   // 範囲予測の上限 (なければ null)
  isPlum: boolean;
  hasArrived: boolean;
  arrivalTime: string | null;   // 主要動到達予測時刻
}

export interface DisplayEewInputV1 {
  kind: "eew";
  eventId: string | null;
  serial: string | null;
  isWarning: boolean;
  isFinal: boolean;
  isCancellation: boolean;
  hypocenterName: string | null;
  forecastMaxInt: string | null;
  forecastMaxIntRank: number | null;
  magnitude: string | null;
  colorIndex: number | null;
  reportDateTime: string;
  isAssumedHypocenter: boolean;
  depth: string | null;
  maxLgInt: string | null;
  regions: DisplayEewRegionV1[];
}

export type DisplayTsunamiLevel = "majorWarning" | "warning" | "advisory";

export interface DisplayTsunamiObservationV1 {
  areaName: string | null;   // 属する予報区名 (対応が取れない場合 null)
  areaKind: string | null;   // その予報区の現在の警報種別 (フロントのレベル別フィルタ用)
  stationName: string;
  arrivalTime: string | null;
  initial: string | null;         // 第一波の状況
  maxHeightValue: string | null;  // 最大波の高さ (パーサにあれば)
  condition: string | null;       // 最大波の状況 (maxHeightCondition)
}

export interface DisplayTsunamiInputV1 {
  kind: "tsunami";
  level: DisplayTsunamiLevel;
  levelLabel: string; // "大津波警報" | "津波警報" | "津波注意報"
  coasts: Array<{
    name: string;
    kind: string;
    maxHeight: string | null;    // 予想波高の記述 (例 "10m超", "3m") = maxHeightDescription
    firstHeight: string | null;  // 第一波到達予想 (例 "ただちに津波来襲と予測", "07日15時30分頃")
  }>;
  warningComment: string | null;  // 警報付帯コメント
  observations: DisplayTsunamiObservationV1[];
  reportDateTime: string;
}

/** 既存 DisplayIntensityGroupV1 に omittedAreaCount を追加 (縮退後も「ほか N 地域」を出せる構造。
 * spec snapshot 縮退予算 §2)。groupIntensityAreas は 0、縮退 (Task 14) が切った分を加算する。 */
export interface DisplayIntensityGroupV1 {
  intensity: string;
  rank: number;
  areas: string[];
  omittedAreaCount: number;   // 追加 (必須)
}

/** 地震情報カードの射影入力 (project-event が生成、store が updatedAtMs を付す) */
export interface DisplayLatestQuakeInputV1 {
  eventId: string | null;
  headline: string | null;
  originTime: string | null;
  hypocenterName: string | null;
  depth: string | null;
  magnitude: string | null;
  maxInt: string | null;
  maxIntRank: number | null;
  tsunamiWarning: boolean;
  intensityGroups: DisplayIntensityGroupV1[];
  reportDateTime: string;
}

export interface DisplayLatestQuakeStateV1 extends DisplayLatestQuakeInputV1 {
  updatedAtMs: number;
}

/** 受信アクティビティ + 統計 (計器列) */
export interface DisplayStatsV1 {
  sparklineData: number[];   // 直近 30 分, 1 分 × 30 スロット (古い順)
  totalReceived: number;     // 当日 (JST) 累積受信数。0 時 JST でリセット
  todayQuakeCount: number;   // 本日 (JST) の地震件数
  todayMaxInt: string | null;
  todayMaxIntRank: number | null;
}

/** 画面全体の緊張度 tier (server 導出)。描画は §4 別プラン */
export type DisplaySeverityTier = "calm" | "caution" | "alert" | "critical";

export interface DisplayLargeQuakeInputV1 {
  kind: "largeQuake";
  eventId: string | null;
  originTime: string | null;
  hypocenterName: string | null;
  magnitude: string | null;
  maxInt: string;
  maxIntRank: number;
  intensityGroups: DisplayIntensityGroupV1[];
  reportDateTime: string;
  depth: string | null;
  maxLgInt: string | null;
  tsunamiWarning: boolean;
}

export type DisplayEmergencyInputV1 =
  | DisplayEewInputV1
  | DisplayTsunamiInputV1
  | DisplayLargeQuakeInputV1;

export interface DisplayRecentQuakeV1 {
  eventId: string | null;
  reportDateTime: string;
  originTime: string | null;
  hypocenterName: string | null;
  magnitude: string | null;
  maxInt: string | null;
  maxIntRank: number | null;
  depth: string | null;
  tsunamiWarning: boolean;
  /** 各地の震度 (履歴カードのクリック再表示用)。groupIntensityAreas 由来で latestQuake と同構造。
   *  古い snapshot には無いためフロントは欠落を空配列として扱う */
  intensityGroups?: DisplayIntensityGroupV1[];
}

/** テロップ優先度。フロントのスケジューラが割込み判定に使う (spec §2-1) */
export type DisplayTickerPriority = "high" | "mid" | "low";

export interface DisplayEventDtoV1 {
  version: typeof DISPLAY_PROTOCOL_VERSION;
  seq: number; // hub が採番。projectDisplayEvent 時点では 0
  id: string;
  eventKey: string;
  groupKey: string | null;
  domain: string; // PresentationDomain と同値。import-free のため string
  type: string;
  infoType: string;
  reportDateTime: string;
  title: string;
  headline: string | null;
  publishingOffice: string;
  isTest: boolean;
  frameLevel: DisplayFrameLevel;
  isCancellation: boolean;
  summary: DisplaySummaryLineV1;
  emergency: DisplayEmergencyInputV1 | null;
  recentQuake: DisplayRecentQuakeV1 | null;
  latestQuake: DisplayLatestQuakeInputV1 | null;
  tickerDetail: string | null;  // テロップ用詳細文 (headline + 地域列挙)。summary より粒度が高い
  /** テロップ左端の種別ラベル (「気象警報・注意報（全国集約）」等)。optional は protocol 移行の安全化 */
  tickerCategory?: string | null;
  /** テロップ本文の文章体。null/欠落時はフロントが従来連結にフォールバックする */
  tickerSentence?: string | null;
  /** テロップ優先度。フロントのスケジューラが割込み判定に使う。
   *  null/欠落時はフロントが "low" として扱う (protocol 移行の安全化) */
  tickerPriority?: DisplayTickerPriority | null;
  /** テロップ本文全文 (解説系の全文配線)。null のとき従来の 1 行 (tickerSentence) にフォールバック */
  tickerBody?: string | null;
  /** テロップ本文の重要語句 (数値+単位) の強調区間。正規化後 tickerBody への UTF-16 index span [start,end)。
   *  情報系 (low 優先) 電文のみ付与。フロントが該当区間を font-weight 増で描画する。
   *  null/欠落/空配列は「強調なし」。tickerBody が縮退等で null 化されるときは必ず一緒に落とす */
  tickerEmphasis?: Array<{ start: number; end: number }> | null;
  /** テロップ左端チップの件名 (台風名・火山名・対象地方等)。導出不能は null でチップは種別のみ */
  tickerSubject?: string | null;
}

export interface DisplayConnectionStateV1 {
  dmdata: "connecting" | "connected" | "disconnected";
  lastReceivedAt: string | null;
  disconnectedSince: string | null;
  reason: string | null;
}

/** 気象警報カードの 1 種別行。displaySeverity と rank を二重保持する */
export type DisplayWeatherRank = "emergency" | "warning" | "advisory";

export interface DisplayWeatherAlertItemV1 {
  kind: string;             // formatLevelLabel 形式のカード表記 (例 "L3 大雨警報" / "暴風警報")
  displaySeverity: string;  // DisplaySeverity 値 (import-free のため string)
  rank: DisplayWeatherRank;
  shownAreas: string[];     // 縮退で切り詰められる。ほか N 地域は omittedAreaCount で表現
  omittedAreaCount: number;
}

export interface DisplayWeatherAlertV1 {
  source: "vpws50" | "vpww56";
  label: string;
  role: "weatherEmergency" | "weatherWarning" | "weatherAdvisory";
  totalAreas: number;
  items: DisplayWeatherAlertItemV1[];
  updatedAt: string;
}

export interface DisplayActiveEewV1 extends DisplayEewInputV1 {
  updatedAtMs: number;
}

export interface DisplayTsunamiStateV1 extends DisplayTsunamiInputV1 {
  demoted: boolean;
  updatedAtMs: number;
}

export interface DisplayLargeQuakeStateV1 extends DisplayLargeQuakeInputV1 {
  updatedAtMs: number;
}

export interface DisplayStateSnapshotV1 {
  version: typeof DISPLAY_PROTOCOL_VERSION;
  generatedAt: string;
  seq: number;
  activeEews: DisplayActiveEewV1[];
  tsunami: DisplayTsunamiStateV1 | null;
  largeQuakes: DisplayLargeQuakeStateV1[];
  weatherAlerts: DisplayWeatherAlertV1[];
  recentQuakes: DisplayRecentQuakeV1[];
  latestQuake: DisplayLatestQuakeStateV1 | null;   // 追加
  stats: DisplayStatsV1 | null;                    // 追加
  severityTier: DisplaySeverityTier;               // 追加
  connection: DisplayConnectionStateV1;
  recentTicker: DisplayEventDtoV1[];
  /** true のときだけ recentTicker がこの state 配信の権威値 (composition 変化の一発同期、spec §3-2)。
   *  省略/false は「recentTicker は空だが変化なし、フロントは既存 ticker を据え置く」の意味 (定期 state の従来動作) */
  tickerSynced?: boolean;
  /** フロント資産のビルド識別子 (display/dist/index.html の内容ハッシュ)。クライアントはロード時に
   *  最初に観測した値を基準に保持し、以後この値が変化した snapshot/state を受信したら location.reload()
   *  してフロントを新版に載せ替える (プロセス再起動でも display:build 単体でも反映)。null/欠落は
   *  旧サーバ・dist 未解決を意味し、クライアントは何もしない。ping には載せない (捨て値契約を維持) */
  frontendBuildId?: string | null;
}

export type DisplayServerMessage =
  | { type: "snapshot"; snapshot: DisplayStateSnapshotV1 }
  | { type: "event"; event: DisplayEventDtoV1 }
  | { type: "state"; snapshot: DisplayStateSnapshotV1 };

// PROTOCOL-SYNC-END
