import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading, WallBasis,
  DiagnosticDetails,
  NoticeMark,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RuntimeDisplayChange,
  RejectionReason,
  RuntimeUnitDeadline,
  UnitCodec,
  UnitView as SharedUnitView,
  MarkViewed,
  UnreadableMark,
} from "./p2-shared-runtime.types";

// P3-UNIT-Y-001 (C14, I-U-Y). 台風解析・予報情報（M11、VPTW60〜65）と台風の暴風域に入る確率（M12、VPTA50〜55）。
// 二つの slice は件数の上限と退去を別々に持つ。subject は TC 番号（Head/EventID）で、データ種類コードの ii（同時に存在する台風等の枠）は鍵に入れない（P3-C14-SUBJECT）。
// slice をまたぐ作用は P3-C14-TERMINAL の一つだけ（解析の台風消滅・発生取消が同じ TC 番号の確率の記録を終わらせる。spec:551 の「根拠のある操作」）。
// 確率の areas・peak・zero と endCause の形は P3-C14-PROB-FACTS=A・ZERO=A・TERMINAL=A（作者裁定 2026-10-13 朝）で確定した。

type Common = Readonly<{
  subject: string;
  operation: Operation;
  // 版と取消の受理の証拠（K2）。事実を捨てた記憶でも残す。
  source: ReportRef; unconfirmed?: ReportRef; // P3-VM-AC04: 系列の未確認の印（取消の採用・期限で消えた記録には無い）
  notice?: NoticeMark; // P3-NL-AC02: 系列の通知の印（記録と同じに生きる）。表示には出さない
  // 記憶まで含めた保持の期限。起点は source の ReportDateTime（P3-C14-RETENTION）。再起動・再受信で延ばさない。
  retainUntil: number;
}>;

// 台風の呼称（Property Type「呼称」の TyphoonNamePart）。空タグは null。number は台風番号（西暦下 2 桁＋号の 4 桁）で、TC 番号（EventID）とは別の値。
export type TyphoonName = Readonly<{ name: string | null; nameKana: string | null; number: string | null; remark: string | null }>;

// 緯度経度（度、10 進）。jmx_eb:Coordinate・BasePoint の type「中心位置（度）」の「+25.5+125.5/」を数で持つ（R50）。度分の表記は読まない。
export type TyphoonPoint = Readonly<{ latitude: number; longitude: number }>;

// 暴風域・強風域・暴風警戒域の 1 軸。direction は 8 方位の漢字で、全域は null。radiusKm は km の半径で、condition「なし」（域が無い）は null。
export type TyphoonWindAxis = Readonly<{ direction: string | null; radiusKm: number | null }>;
export type TyphoonWindArea = Readonly<{ thresholdMs: number | null; axes: readonly TyphoonWindAxis[] }>;

export type TyphoonFrameKind = "analysis" | "estimate" | "forecast" | "extendedForecast";

// 1 時刻の値（MeteorologicalInfo 1 個、P3-C14-ANALYSIS-FACTS）。単位は km・m/s・km/h・hPa だけを読み、ノット・海里は読まない。
// 値の無い要素は null で、0 に読み替えない（電文が「0」と書いた値だけが 0）。
export type TyphoonFrame = Readonly<{
  kind: TyphoonFrameKind;
  // DateTime の type の時間（「予報　２４時間後」の 24）。実況は 0。
  hours: number;
  validTime: number;
  category: string | null;
  intensity: string | null;
  size: string | null;
  // 実況・推定は中心位置、予報・延長予報は予報円の中心（R50）。
  center: TyphoonPoint | null;
  // 予報円の 70% 確率半径（km、予報・延長予報だけ。R50）。
  circleRadiusKm: number | null;
  location: string | null;
  moveDirection: string | null;
  moveSpeedKmh: number | null;
  // 移動方向・速度の空タグの condition（「不定」「ゆっくり」「ほとんど停滞」）。
  moveCondition: string | null;
  pressureHpa: number | null;
  maxWindMs: number | null;
  maxGustMs: number | null;
  storm: TyphoonWindArea | null;
  gale: TyphoonWindArea | null;
  stormWarning: TyphoonWindArea | null;
}>;

// P3-UM-AC02 (6)・AC15 (5): 印の site の表（truncated で落とした所: 軸・時刻・節・時間帯・地域）。codec は表の外の site を読まない。
export type TyphoonUnreadableSite = "axis" | "frame" | "section" | "slot" | "area";

// subject = `${operation}/typhoonAnalysis/${EventID}`。active は activeUntil（P3-C14-EXPIRY）の到来か、
// 台風消滅・発生取消の報（P3-C14-LIFECYCLE）で ended になり、記憶として retainUntil（ReportDateTime + 7 日、spec:578）まで残る。
export type TyphoonAnalysisRecord = Common & (
  | Readonly<{
      effective: "active";
      activeUntil: number;
      // Head/TargetDateTime（解析の基点時刻）。
      baseTime: number;
      title: string;
      name: TyphoonName;
      frames: readonly TyphoonFrame[];
      truncated: boolean;
      expiryPending?: true; // P3-EF-AC05 (1): 時計を確かめる前に activeUntil が来た印（view から外し、事実と通知の印は残す）
      unreadable?: UnreadableMark; // P3-UM-AC01・AC15 (5): 落とした所の印（site は TyphoonUnreadableSite）。印の無い記録は欄を書かない
    }>
  // terminal は台風消滅・発生取消の報で終わった記録（P3-C14-TERMINAL が確率の採否に使う）、expired は期限で終わった記録。
  | Readonly<{ effective: "ended"; endCause: "terminal" | "expired" }>
  | Readonly<{ effective: "cancelled" }>
);

// 確率が 1 以上の地域だけを持つ（P3-C14-PROB-FACTS）。daily は 1〜5 日積算の 5 つ、peak は 3 時間ごとの確率の最大、
// peakSlot は peak を最初に取る時間帯の番号（0 起点、基点時刻＋peakSlot×3 時間から 3 時間）。3 時間ごとの確率が全部 0 なら peak 0・peakSlot null。
export type TyphoonProbabilityArea = Readonly<{
  code: string;
  name: string;
  prefectureCode: string;
  daily: readonly number[];
  peak: number;
  peakSlot: number | null;
}>;
export type TyphoonPrefecture = Readonly<{ code: string; name: string }>;

// subject = `${operation}/typhoonProbability/${EventID}`。zero は全地域・全時間の確率が 0 の報を採った記録で、見えない（連続ゼロの判定に使う、P3-C14-ZERO）。
// active は activeUntil（P3-C14-EXPIRY）で ended、解析の台風消滅で ended（P3-C14-TERMINAL）。記憶は retainUntil（ReportDateTime + 7 日、spec:579）まで。
export type TyphoonProbabilityRecord = Common & (
  | Readonly<{
      effective: "active";
      activeUntil: number;
      // Head/TargetDateTime（= 最初の時間帯の始まり）。
      baseTime: number;
      // TimeDefine の数（3 時間ごと、実配信は 40）。
      slotCount: number;
      title: string;
      name: TyphoonName;
      // 5 日積算の最大（1〜100）。
      maxFiveDay: number;
      prefectures: readonly TyphoonPrefecture[];
      areas: readonly TyphoonProbabilityArea[];
      truncated: boolean;
      expiryPending?: true; // P3-EF-AC05 (1): 同上
      unreadable?: UnreadableMark; // P3-UM-AC01・AC15 (5): 同上
    }>
  | Readonly<{ effective: "zero" }>
  | Readonly<{ effective: "ended"; endCause: "terminal" | "expired" }>
  | Readonly<{ effective: "cancelled" }>
);

// 台風は気象の音（sound-design-system.md の分野別根音表）。A7 の群は全部 other（P3-C14-NOTICE-GROUP）。
export type TyphoonNotificationPayload = Readonly<{
  domain: "weather";
  level: "info" | "normal" | "cancel";
  title: string;
  body: string;
}>;

export type TyphoonIntent = NotificationIntent & Readonly<{ payload: TyphoonNotificationPayload }>;

export type TyphoonUnitState = Readonly<{
  schemaVersion: "p3-typhoon-unit-v7";
  contentRevision: number;
  analysis: readonly TyphoonAnalysisRecord[];
  probability: readonly TyphoonProbabilityRecord[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly TyphoonIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedTyphoonUnit = Readonly<{
  schemaVersion: "p3-typhoon-unit-v7";
  analysis: readonly TyphoonAnalysisRecord[];
  probability: readonly TyphoonProbabilityRecord[];
  intents: readonly TyphoonIntent[];
}>;

// active の記録だけを載せる。予報円・暴風域の描画と解析・確率の結合の見せ方は作らない（P4、R50）。
export type TyphoonUnitView = SharedUnitView & Readonly<{
  unit: "U-Y";
  analysis: readonly MarkViewed<Extract<TyphoonAnalysisRecord, Readonly<{ effective: "active" }>>>[];
  probability: readonly MarkViewed<Extract<TyphoonProbabilityRecord, Readonly<{ effective: "active" }>>>[];
}>;

export type TyphoonInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "deadline"; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "restore"; persisted: PersistedTyphoonUnit; clock: ClockReading; basis?: WallBasis }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  // 閉じる batch・相関待ちを持たないので、終了入力は同じ state を返す（spec:884）。
  | Readonly<{ kind: "shutdown"; clock: ClockReading; basis?: WallBasis }>;

export type TyphoonUnitStep = Readonly<{
  state: TyphoonUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 識別できない拒否だけ subject は空文字。P3-C14-TERMINAL で確率の記録も終わる入力は、解析と確率の subject を 1 つずつ返す。
  // changed の currentEstablished は最終の状態にその subject の記録が残り source が今回の報のときだけ根拠を載せ、ほかは null（D-VANISHED=A）。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly TyphoonIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type TyphoonUnitCodec = UnitCodec<TyphoonUnitState, PersistedTyphoonUnit> & Readonly<{
  schemaVersion: "p3-typhoon-unit-v7";
}>;
