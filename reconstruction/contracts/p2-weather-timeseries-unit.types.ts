import type { DecodedMaterial, MaterialValue, Operation, XmlAttribute } from "./p1-parser-boundary.types";
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

export type WeatherTimeseriesUnavailableReason =
  | "capacityExceeded"
  | "historyUnavailable"
  | "coverageIncomplete";

export type WeatherTimeseriesCompoundField = Readonly<{
  name: string;
  attributes: readonly XmlAttribute[];
  value: MaterialValue | readonly WeatherTimeseriesCompoundField[];
}>;

export type WeatherTimeseriesValue =
  | MaterialValue
  | Readonly<{ kind: "significancy"; name: MaterialValue; code: MaterialValue }>
  | Readonly<{ kind: "peakTime" | "criteriaPeriod"; fields: readonly WeatherTimeseriesCompoundField[] }>;

// Index fields resolve inside this snapshot; positions retain document order. Source codes stay strings.
// Position meanings and reference targets: Q-ENUM.storageRule.periodRow.
export type WeatherTimeseriesPeriod = readonly [
  series: number, area: number, kind: number, propertyType: number,
  placement: number, local: number | null, elementName: number,
  valueType: number | null, time: number, attributes: number, value: number,
];

export type WeatherTimeseriesSnapshot = Readonly<{
  strings: readonly string[];
  attributes: readonly (readonly (readonly [name: number, value: number])[])[];
  values: readonly WeatherTimeseriesValue[];
  series: readonly Readonly<{
    meteorologicalInfosPosition: number;
    timeSeriesInfoPosition: number;
    timeDefines: readonly Readonly<{
      timeId: number;
      dateTimeRaw: number;
      durationRaw: number;
      name: number | null;
      startMs: number;
      endMs: number;
    }>[];
  }>[];
  areas: readonly Readonly<{ code: number; name: number | null }>[];
  locals: readonly Readonly<{
    code: number | null;
    areaNameCode: number | null;
    areaName: number | null;
    name: number | null;
    anonymousPosition: number | null;
  }>[];
  kinds: readonly Readonly<{ status: number | null; dateTimeRaw: number | null; dateTimeType: number | null }>[];
  periods: readonly WeatherTimeseriesPeriod[];
}>;

export type WeatherTimeseriesSubject = WeatherTimeseriesSnapshot & Readonly<{
  subject: string;
  operation: Operation;
  source: ReportRef | null;
  effective: "active" | "noActiveItems" | "cancelled" | "unavailable";
  unavailableReason: WeatherTimeseriesUnavailableReason | null;
  lastKnown: WeatherTimeseriesSnapshot | null;
  // "subject" denotes this entire operation/subject; [] denotes no affected periods.
  affectedScope: "subject" | readonly string[];
  // Active expiry follows the report periods; retention is a separate collection boundary.
  validUntil: number | null;
  retainUntil: number;
}>;

export type WeatherTimeseriesGate = Readonly<{
  subject: string;
  operation: Operation;
  source: ReportRef;
}>;

export type WeatherTimeseriesUnitState = Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v2";
  contentRevision: number;
  subjects: readonly WeatherTimeseriesSubject[];
  gates: readonly WeatherTimeseriesGate[];
  intents: readonly NotificationIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedWeatherTimeseriesUnit = Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v2";
  subjects: readonly WeatherTimeseriesSubject[];
  gates: readonly WeatherTimeseriesGate[];
  intents: readonly NotificationIntent[];
}>;

// P3-UFP-AC01: owner が publisher へ出す subject 1 件の公開形式。period の行・辞書・lastKnown は owner に残し、
// 詳細の口（WeatherTimeseriesDetailResponse）が (id, revision) で読む。
export type WeatherTimeseriesPublicSubject = Readonly<{
  subject: string;
  operation: Operation;
  office: string;
  // JSON.stringify(["U-F", operation, subject]) の sha256 hex（P2-A8-NOTICE.identity の targetId と同じ）。
  id: string;
  // この subject の object を作った step の unit の内容版（10 進、16 桁以下）。
  revision: string;
  source: ReportRef | null;
  effective: WeatherTimeseriesSubject["effective"];
  unavailableReason: WeatherTimeseriesUnavailableReason | null;
  validUntil: number | null;
  // 昇順の集合。effective が active でなければ空。
  areaCodes: readonly string[];
  knownCodes: readonly string[];
  unknownCode: Readonly<{ unknown: number; missing: number; empty: number }>;
  periodCount: number;
  lastKnownPeriodCount: number | null;
}>;

export type WeatherTimeseriesUnitView = SharedUnitView & Readonly<{
  unit: "U-F";
  series: readonly WeatherTimeseriesPublicSubject[];
}>;

// 詳細の口（P3-UFP-AC06）。streamId は publisher が照合して外してから owner へ渡す。
export type WeatherTimeseriesDetailRequest =
  | Readonly<{ part: "index"; revision: string; page: number }>
  | Readonly<{ part: "current" | "lastKnown"; id: string; revision: string; page: number }>;

export type WeatherTimeseriesDetailPeriod = readonly [
  meteorologicalInfosPosition: number, timeSeriesInfoPosition: number,
  time: readonly [timeId: string | null, dateTimeRaw: string | null, durationRaw: string | null, name: string | null, startMs: number, endMs: number],
  area: readonly [code: string | null, name: string | null],
  kind: readonly [status: string | null, dateTimeRaw: string | null, dateTimeType: string | null],
  propertyType: string | null, placement: string | null,
  local: readonly [code: string | null, areaNameCode: string | null, areaName: string | null, name: string | null, anonymousPosition: number | null] | null,
  elementName: string | null, valueType: string | null,
  attributes: readonly (readonly [name: string | null, value: string | null])[],
  value: WeatherTimeseriesValue,
];

export type WeatherTimeseriesDetailIndexEntry = Readonly<{
  id: string;
  operation: Operation;
  office: string;
  officeTruncated: boolean;
  revision: string;
  effective: WeatherTimeseriesSubject["effective"];
  periodCount: number;
  lastKnownPeriodCount: number | null;
}>;

export type WeatherTimeseriesDetailError = Readonly<{
  kind: "error";
  reason: "invalidRequest" | "versionChanged" | "busy" | "unavailable" | "timeout";
  // 今の版（subject の版か索引の内容版）。当てはまらなければ null。
  revision: string | null;
}>;

export type WeatherTimeseriesDetailResponse =
  | Readonly<{ kind: "ok"; part: "index"; revision: string; page: number; pageCount: number; subjectCount: number;
      entries: readonly WeatherTimeseriesDetailIndexEntry[] }>
  | Readonly<{ kind: "ok"; part: "current" | "lastKnown"; id: string; revision: string; page: number; pageCount: number;
      periodCount: number; periods: readonly Readonly<{ index: number; period: WeatherTimeseriesDetailPeriod }>[];
      omitted: readonly Readonly<{ index: number; reason: "pageBudget" }>[] }>
  | WeatherTimeseriesDetailError;

export type WeatherTimeseriesInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedWeatherTimeseriesUnit; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type WeatherTimeseriesUnitStep = Readonly<{
  state: WeatherTimeseriesUnitState;
  displayChanges: readonly RuntimeDisplayChange[];
  confirmationEvidence: readonly CurrentConfirmationEvidence[];
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded" }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly NotificationIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type WeatherTimeseriesUnitCodec = UnitCodec<WeatherTimeseriesUnitState, PersistedWeatherTimeseriesUnit> & Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v2";
}>;
