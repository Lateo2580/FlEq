// P3-EEW-FACTS-001（台帳 106）: U-E が受信の outcome の facts.report に載せる、1 報分の材料。
// 互換必須の EEW ログファイル（spec §11.4）と C19（P3-TERMINAL-OUTPUT-001）の端末が使う値で、今の facts から作れないものだけ。
// 値は XML の生の文字（scalar の文字そのまま、正規化しない）。要素が無ければ null、要素が空なら ""。整形・特殊値の読みは C19 が持つ。
// 受信の記憶にだけ持つ。state・codec・view・診断・通知の payload に入れない（dmdata 規約 15 項、EEW は personal 限定）。

// ForecastLgInt の From・To の生の文字（P3-EWF-AC01 の maxLgInt と areas[].lgInt）。
export type EewLgIntRaw = Readonly<{ from: string | null; to: string | null }>;

// Pref/Area 1 つ分。順と件数は facts.prediction.areas と同じ（同じ Area の並び、P3-EWF-AC01 (3)）。
export type EewReportArea = Readonly<{
  code: string;
  name: string | null;
  lgInt: EewLgIntRaw | null;
  arrivalTimeRaw: string | null;
}>;

export type EewReportFacts = Readonly<{
  headline: string | null;
  hypocenter: string | null;
  landOrSea: string | null;
  originTimeRaw: string | null;
  // Earthquake/ArrivalTime（検知時刻）。区域の到達予測は areas[].arrivalTimeRaw。
  arrivalTimeRaw: string | null;
  // condition は深さの特殊値の材料（旧築の telegram-parser.ts の depthCarrier）。
  coordinate: Readonly<{ raw: string; description: string | null; condition: string | null }> | null;
  magnitude: Readonly<{ raw: string; description: string | null; condition: string | null }> | null;
  accuracy: Readonly<{
    epicenterRank: string | null;
    depthRank: string | null;
    magnitudeRank: string | null;
    magnitudeCalculationCount: string | null;
  }> | null;
  isAssumedHypocenter: boolean;
  maxIntChangeReasonRaw: string | null;
  maxLgInt: EewLgIntRaw | null;
  areas: readonly EewReportArea[];
  nextAdvisory: string | null;
  // 取消の報の Body/Text。取消でない報は null。
  cancelText: string | null;
}>;
