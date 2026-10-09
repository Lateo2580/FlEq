import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  CurrentConfirmationEvidence,
  ClockReading,
  DiagnosticDetails,
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
// 系列（EventID の最初の「_」より前、P3-C12-SUBJECTS=A、作者裁定）ごとの current（D）だけを持つ。
// 系列の続報は同じ記録を置き換える。VPOA50 は対応する VPBS50 の系列（先頭に「K」）と alias で結ぶ（P3-C12-ALIAS）。

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
type BriefingCommon = Readonly<{
  subject: string;
  operation: Operation;
  series: string;
  source: ReportRef;
  retainUntil: number;
}>;

type BriefingText = Readonly<{
  title: string;
  headline: string;
  editorialOffice: string;
  truncated: boolean;
}>;

// replaced は予測の区域が全部発生に除かれた記録（P3-C12-REPLACE=B: 発生の記録がある間、時刻の前後によらず除く）。事実を持たず、view に載せず、通知しない。
export type BriefingReportCurrent = BriefingCommon & Readonly<{ headType: "VPBS50" }> & (
  | (BriefingText & Readonly<{
      effective: "active";
      items: readonly BriefingItem[];
      observations: readonly BriefingObservation[];
    }>)
  | Readonly<{ effective: "replaced" | "cancelled" }>
);

// VPOA50 の系列（P3-C12-VPOA=A）。held は対応する VPBS50 を待つ間（holdUntil は受理の時刻 + 60,000 ms、
// 業務の期限ではなく相関の窓）で、view に載せず通知しない。released は待っても対応報が無かった記録で、view に
// 「対応電文未確認」として載せる。aliased は対応する VPBS50 の系列が active になった記録で、view に載せない。事実を保つのは
// P3-C12-COUNTERPART-CANCEL=B（対応報の取消で無音で released に戻すため）。restore 入力は held を全部無音で released にする。
export type BriefingRecordRainCurrent = BriefingCommon & Readonly<{ headType: "VPOA50" }> & (
  | (BriefingText & Readonly<{ effective: "held"; holdUntil: number; areas: readonly BriefingArea[] }>)
  | (BriefingText & Readonly<{ effective: "released"; areas: readonly BriefingArea[] }>)
  | (BriefingText & Readonly<{ effective: "aliased"; areas: readonly BriefingArea[] }>)
  | Readonly<{ effective: "cancelled" }>
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
  schemaVersion: "p3-briefing-unit-v1";
  contentRevision: number;
  currents: readonly BriefingCurrent[];
  // Pending and terminal records; terminal ones leave at expiresAt and count in the generation byte budget.
  intents: readonly BriefingIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedBriefingUnit = Readonly<{
  schemaVersion: "p3-briefing-unit-v1";
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
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedBriefingUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  // spec:884 の終了入力。held を無音で released にして相関待ちを閉じる（対応を確定させない）。
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type BriefingUnitStep = Readonly<{
  state: BriefingUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // 一入力は自分の系列の subject に加えて、alias（VPOA50）と予測の置換（VPBS50）で他の subject を変えうる（spec:616 の原子的な適用）。
  // 識別できない拒否だけ subject は空文字。
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
  schemaVersion: "p3-briefing-unit-v1";
}>;
