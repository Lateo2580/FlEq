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
} from "./p2-shared-runtime.types";

// P3-UNIT-B-001 (C12, I-U-B). 府県気象防災速報（M17、VPBS50）と記録的短時間大雨情報（VPOA50）。
// 系列（EventID の最初の「_」より前、P3-C12-SUBJECTS=A、作者裁定）ごとの current（D）だけを持つ。記録的短時間大雨（VPOA50 と、情報タグが
// 全部記録雨の VPBS50）は報ごとで、系列の欄に EventID の全体を持つ（P3-EF-AC09 (1)）。VPOA50 は対応する VPBS50 と alias で結ぶ（P3-C12-ALIAS・P3-EF-AC09 (2)）。

// 情報タグの Condition を NFKC で引く表（P3-C12-KINDS）。表に無い Condition と Condition の無い Kind は unknown（fail-bright）。
export type BriefingKind = "linearRainObserved" | "linearRainPredicted" | "recordRain" | "shortSnow" | "unknown";

// 府県予報区・細分区域等の Area。code は数字だけ（8 byte 以下）、name は I-U-B.bounds の長さでコードポイントの境界で切る。
export type BriefingArea = Readonly<{ code: string; name: string }>;

// Head/Headline の Information（type「情報タグ」）の Item。condition は Kind/Condition の trim（無ければ null）。
// areas は P3-C12-REPLACE で予測の区域が発生に置き換わると減る。予測の item は区域が 0 になると除く。
export type BriefingItem = Readonly<{
  kind: BriefingKind;
  condition: string | null;
  areas: readonly BriefingArea[];
}>;

// Body の観測実況（P3-C12-FACTS、spec:1465「雨量と発表官署」）。EventPart・PrecipitationPart・SnowfallDepthPart だけを読む。
// label は event なら EventName、雨・雪なら要素の type 属性（例: 前１時間解析雨量）。値の無い要素は value null（0 に読み替えない）。
// approximation は condition 属性（以上→atLeast、約→approx）、無く値があれば exact、値が無ければ unknown。
// 地点は Item の Area か Station のどちらか 1 個（無い・両方ある報は拒否、Q-ENUM）。unit は 8 文字以下で切らない。
export type BriefingObservation = Readonly<{
  part: "event" | "precipitation" | "snowfall";
  areaCode: string;
  areaName: string;
  label: string;
  value: number | null;
  unit: string | null;
  approximation: "exact" | "approx" | "atLeast" | "unknown";
  time: string | null;
}>;

// subject = `${operation}/${headType}/${series}`（P3-C12-SUBJECTS）。source は subject の watermark と出典を兼ねる。
// retainUntil は source の ReportDateTime に P3-C12-TTL の長さを足した時刻（P3-C12-TTL=B: items が 1 件以上で全部予測の active は 3 時間、
// ほかの active・held・released は 2 時間、記憶（replaced・aliased・cancelled）は 3 時間）。再起動・再受信で延ばさない。
// 受理の時点で retainUntil を過ぎる報（遅着）は P3-C12-TTL.lateRule で、前の見える記録より新しい版の遅着は採用して同じ reduce で回収する（P3-C12-LATE-INVERSION=A）。
type BriefingCommon = Readonly<{
  subject: string;
  operation: Operation;
  series: string;
  source: ReportRef; unconfirmed?: ReportRef; // P3-VM-AC04: 系列の未確認の印（取消の採用・期限で消えた記録には無い）
  notice?: NoticeMark; // P3-NL-AC02: 系列の通知の印（記録と同じに生きる）。表示には出さない
  retainUntil: number;
}>;

type BriefingText = Readonly<{
  title: string;
  headline: string;
  editorialOffice: string;
  truncated: boolean;
}>;

// replaced は予測の区域が全部発生に除かれた記録（P3-C12-REPLACE=B: 発生の記録がある間、時刻の前後によらず除く）。事実を持たず、view に載せず、通知しない。
// eventId はいま持っている報の EventID の全体（採用・続報・訂正・取消で書き換える）。series はその全体か「_」より前。対応報（VPOA50）との結びと、
// 系列の subject に引き継いだ記録への訂正・取消は、この欄で引く（P3-EF-AC09 (1)(2)）。
// inherited は訂正（全部記録雨）で系列の subject の記録を引き継いだ印。系列の報の上書き・取消で外れ、印のある記録にだけ取消が系列の subject で当たる。
export type BriefingReportCurrent = BriefingCommon & Readonly<{ headType: "VPBS50"; eventId: string; inherited?: true }> & (
  | (BriefingText & Readonly<{
      effective: "active";
      items: readonly BriefingItem[];
      observations: readonly BriefingObservation[];
      expiryPending?: true; // P3-EF-AC05 (1): 時計を確かめる前に表示の期限が来た印
    }>)
  | Readonly<{ effective: "replaced" | "cancelled" | "expired" }> // expired: 期限切れの記憶（P3-EF-AC05、元報＋9 時間）
);

// VPOA50 の系列（P3-C12-VPOA=A）。held は対応する VPBS50 を待つ間（holdUntil は受理の時刻 + 60,000 ms、
// 業務の期限ではなく相関の窓）で、view に載せず通知しない。released は待っても対応報が無かった記録で、view に
// 「対応電文未確認」として載せる。aliased は対応する VPBS50 の系列が active になった記録で、view に載せない。事実を保つのは
// P3-C12-COUNTERPART-CANCEL=B（対応報の取消で無音で released に戻すため）。restore・終了入力は retainUntil を過ぎた記録を
// 除いてから held を全部無音で released にし、変化があれば保存世代を進める（P3-C12-AC16）。
export type BriefingRecordRainCurrent = BriefingCommon & Readonly<{ headType: "VPOA50" }> & (
  | (BriefingText & Readonly<{ effective: "held"; holdUntil: number; areas: readonly BriefingArea[] }>)
  | (BriefingText & Readonly<{ effective: "released"; areas: readonly BriefingArea[]; expiryPending?: true }>)
  | (BriefingText & Readonly<{ effective: "aliased"; areas: readonly BriefingArea[] }>)
  | Readonly<{ effective: "cancelled" | "expired" }>
);

export type BriefingCurrent = BriefingReportCurrent | BriefingRecordRainCurrent;

// 気象の音（sound-design-system.md の分野別根音表）。A7 の群は unit で決まり、U-B は other（P3-C12-NOTICE-GROUP）。
export type BriefingNotificationPayload = Readonly<{
  domain: "weather";
  level: "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type BriefingIntent = NotificationIntent & Readonly<{ payload: BriefingNotificationPayload }>;

export type BriefingUnitState = Readonly<{
  schemaVersion: "p3-briefing-unit-v6";
  contentRevision: number;
  currents: readonly BriefingCurrent[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly BriefingIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedBriefingUnit = Readonly<{
  schemaVersion: "p3-briefing-unit-v6";
  currents: readonly BriefingCurrent[];
  intents: readonly BriefingIntent[];
}>;

// active の VPBS50 と released の VPOA50 だけを載せる。区域の地図・カードの並べ方は作らない（P4）。
export type BriefingUnitView = SharedUnitView & Readonly<{
  unit: "U-B";
  currents: readonly (
    | Extract<BriefingReportCurrent, Readonly<{ effective: "active" }>>
    | Extract<BriefingRecordRainCurrent, Readonly<{ effective: "released" }>>
  )[];
}>;

export type BriefingInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "deadline"; clock: ClockReading; basis?: WallBasis }>
  | Readonly<{ kind: "restore"; persisted: PersistedBriefingUnit; clock: ClockReading; basis?: WallBasis }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  // spec:884 の終了入力。held を無音で released にして相関待ちを閉じる（対応を確定させない）。
  | Readonly<{ kind: "shutdown"; clock: ClockReading; basis?: WallBasis }>;

export type BriefingUnitStep = Readonly<{
  state: BriefingUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 一入力は自分の系列の subject に加えて、alias（VPOA50）と予測の置換（VPBS50）で他の subject を変えうる（spec:616 の原子的な適用）。
  // 識別できない拒否だけ subject は空文字。changed の currentEstablished は最終の状態にその subject の記録が残り source が今回の報のときだけ
  // 根拠を載せ、ほか（自身の退去・同じ reduce の回収）は null（D-VANISHED=A）。change は最終の表示の変化で決める（I-U-B.currentSemantics(6)）。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly BriefingIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type BriefingUnitCodec = UnitCodec<BriefingUnitState, PersistedBriefingUnit> & Readonly<{
  schemaVersion: "p3-briefing-unit-v6";
}>;
