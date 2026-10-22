import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading,
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

// P3-UNIT-M-001 (C13, I-U-M). 竜巻注意情報（M09、VPHW50/51）・熱中症警戒アラート（M10、VPFT50）・短命の解説情報（M18）。
// 三つの slice は件数の上限と退去を別々に持ち、一つの slice の満杯が他の slice の記録を退去しない（I-U-M.slices）。
// 一入力が変えるのは自分の slice の自分の subject だけで、subject をまたぐ作用（置換・alias）は無い。

type Common = Readonly<{
  subject: string;
  operation: Operation;
  // 版と取消の受理の証拠（K2）。事実を捨てた記憶でも残す。
  source: ReportRef; unconfirmed?: ReportRef; // P3-VM-AC04: 系列の未確認の印（取消の採用・期限で消えた記録には無い）
  notice?: NoticeMark; // P3-NL-AC02: 系列の通知の印（記録と同じに生きる）。表示には出さない
  // 記憶まで含めた保持の期限。起点は source の ReportDateTime（P3-C13-RETENTION）。再起動・再受信で延ばさない。
  retainUntil: number;
}>;

// 竜巻の区域。layer は Headline の Information の type（竜巻注意情報（…））の括弧の中を表で引いた値（P3-C13-TORNADO-FACTS）。
// code は数字だけ（8 byte 以下）、name は 24 単位をコードポイントの境界で切る（I-U-M.bounds）。
export type TornadoAreaLayer = "announcement" | "primary" | "municipalityGroup" | "municipality" | "sighting";
export type TornadoArea = Readonly<{ layer: TornadoAreaLayer; code: string; name: string }>;

// subject = `${operation}/tornado/${EditorialOffice}/${Head/Title}`（P3-C13-TORNADO-SUBJECT=A。府県予報区ごと）。VPHW50 と VPHW51 は同じ subject。
// active は activeUntil（Head/ValidDateTime を ReportDateTime + 36 時間で切り詰めた値、無ければ ReportDateTime + 1 時間、P3-C13-TORNADO-EXPIRY）の到来で ended になり、
// 記憶として retainUntil（ReportDateTime + 36 時間）まで残る。区域が全部「なし」の報も ended（通常の解除）。
export type TornadoCurrent = Common & (
  | Readonly<{
      effective: "active";
      activeUntil: number;
      title: string;
      headline: string;
      editorialOffice: string;
      // 「目撃情報あり」の区域を持つか Headline/Text が「【目撃情報あり】」で始まる報（P3-C13-TORNADO-PAIR=A。VPHW51 は VPHW50 と常に対で来るので headType では決めない）。
      sighted: boolean;
      areas: readonly TornadoArea[];
      truncated: boolean;
    }>
  | Readonly<{ effective: "ended" | "cancelled" }>
);

// subject = `${operation}/VPFT50/${EventID}`（P3-C13-HEAT-SUBJECT）。active は対象日（P3-C13-HEAT-EXPIRY=A: Head/TargetDateTime の
// JST の日付。前日 17 時の第 1 号は翌日 00:00、当日 5 時の報は当日 05:00 で来る）の終わりの到来で ended になり、記憶として retainUntil（ReportDateTime + 3 日）まで残る。
// 暑さ指数は構造化された値として電文に無いので持たない（P4 は「未提供」と出す、spec:1470）。
export type HeatCurrent = Common & (
  | Readonly<{
      effective: "active";
      activeUntil: number;
      targetDate: string;
      title: string;
      headline: string;
      editorialOffice: string;
      // 切り詰める前の Head/Title から引いた対象地域の名前（例: 埼玉県）。引けなければ null で、報は拒否しない。
      areaName: string | null;
      truncated: boolean;
    }>
  | Readonly<{ effective: "ended" | "cancelled" }>
);

// 短命の解説情報の family（P3-C13-TRANSIENT-FAMILIES）。
export type TransientFamily = "seismicText" | "earlyWeather" | "climateInfo" | "weatherExplanation";

export type TransientArea = Readonly<{ code: string; name: string }>;

// subject は EventID のある型が `${operation}/${headType}/${EventID の最初の「_」より前}`（接尾の有無をまたいで Serial が続くため）、VPAW51 は `${operation}/VPAW51/${TargetArea の code}/${Head/Title}`（P3-C13-VPAW51-SUBJECT=A）。
// active の事実は保存しない（spec:482 の「早期天候・気候・解説の永続 current」は作らない）。保存するのは evidence（受理の証拠だけ）と
// cancelled で、encode は active を evidence として書く（P3-C13-TRANSIENT-EVIDENCE）。visibleUntil の到来で evidence になる。
export type TransientCurrent = Common & Readonly<{ family: TransientFamily }> & (
  | Readonly<{
      effective: "active";
      visibleUntil: number;
      title: string;
      headline: string;
      editorialOffice: string;
      areas: readonly TransientArea[];
      // 情報タグの Condition を空白で分けた語（weatherExplanation だけ）。
      tags: readonly string[];
      truncated: boolean;
    }>
  | Readonly<{ effective: "evidence" | "cancelled" }>
);

export type PersistedTransientCurrent = Exclude<TransientCurrent, Readonly<{ effective: "active" }>>;

// 地震の解説（seismicText）は地震の音、ほかは気象の音（sound-design-system.md の分野別根音表）。A7 の群は全部 other（P3-C13-NOTICE-GROUP）。
export type LocalBulletinsNotificationPayload = Readonly<{
  domain: "weather" | "earthquake-eew";
  level: "info" | "normal" | "warning" | "critical" | "cancel";
  title: string;
  body: string;
}>;

export type LocalBulletinsIntent = NotificationIntent & Readonly<{ payload: LocalBulletinsNotificationPayload }>;

export type LocalBulletinsUnitState = Readonly<{
  schemaVersion: "p3-local-bulletins-unit-v5";
  contentRevision: number;
  tornado: readonly TornadoCurrent[];
  heat: readonly HeatCurrent[];
  transient: readonly TransientCurrent[];
  // Pending only (P3-NL-AC05): a terminal intent leaves and its result stays in the series' notice mark.
  intents: readonly LocalBulletinsIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedLocalBulletinsUnit = Readonly<{
  schemaVersion: "p3-local-bulletins-unit-v5";
  tornado: readonly TornadoCurrent[];
  heat: readonly HeatCurrent[];
  transient: readonly PersistedTransientCurrent[];
  intents: readonly LocalBulletinsIntent[];
}>;

// active の記録だけを載せる。カードの並べ方・地図の区域の選び方は作らない（P4）。
export type LocalBulletinsUnitView = SharedUnitView & Readonly<{
  unit: "U-M";
  tornado: readonly Extract<TornadoCurrent, Readonly<{ effective: "active" }>>[];
  heat: readonly Extract<HeatCurrent, Readonly<{ effective: "active" }>>[];
  transient: readonly Extract<TransientCurrent, Readonly<{ effective: "active" }>>[];
}>;

export type LocalBulletinsInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedLocalBulletinsUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  // 閉じる batch・相関待ちを持たないので、終了入力は同じ state を返す（spec:884）。
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type LocalBulletinsUnitStep = Readonly<{
  state: LocalBulletinsUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 識別できない拒否だけ subject は空文字。changed の currentEstablished は最終の状態にその subject の記録が残り source が今回の報のときだけ
  // 根拠を載せ、ほか（自身の退去）は null（D-VANISHED=A）。change は最終の表示の変化で決める（I-U-M.currentSemantics）。
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly LocalBulletinsIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type LocalBulletinsUnitCodec = UnitCodec<LocalBulletinsUnitState, PersistedLocalBulletinsUnit> & Readonly<{
  schemaVersion: "p3-local-bulletins-unit-v5";
}>;
