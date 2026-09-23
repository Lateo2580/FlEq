import type { DecodedMaterial, MaterialValue, Operation, XmlAttribute } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  ClockReading,
  DiagnosticDetails,
  NotificationIntent,
  NotificationIntentUpdate,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
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
  schemaVersion: "p2-weather-timeseries-unit-v1";
  subjects: readonly WeatherTimeseriesSubject[];
  gates: readonly WeatherTimeseriesGate[];
  intents: readonly NotificationIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedWeatherTimeseriesUnit = Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v1";
  subjects: readonly WeatherTimeseriesSubject[];
  gates: readonly WeatherTimeseriesGate[];
  intents: readonly NotificationIntent[];
}>;

export type WeatherTimeseriesUnitView = SharedUnitView & Readonly<{
  unit: "U-F";
  series: readonly WeatherTimeseriesSubject[];
}>;

export type WeatherTimeseriesInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedWeatherTimeseriesUnit; clock: ClockReading }>
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type WeatherTimeseriesUnitStep = Readonly<{
  state: WeatherTimeseriesUnitState;
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: "subject" }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: "subject" }>) | null }>
  ))[];
  intents: readonly NotificationIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type WeatherTimeseriesUnitCodec = UnitCodec<WeatherTimeseriesUnitState, PersistedWeatherTimeseriesUnit> & Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v1";
}>;
