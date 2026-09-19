import type { DecodedMaterial, MaterialValue, Operation } from "./p1-parser-boundary.types";
import type {
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
  | "coverageIncomplete"
  | "unknownValueCode";

export type WeatherTimeseriesPeriod = Readonly<{
  period: string;
  value: MaterialValue;
}>;

export type WeatherTimeseriesSubject = Readonly<{
  subject: string;
  operation: Operation;
  source: ReportRef | null;
  periods: readonly WeatherTimeseriesPeriod[];
  effective: "active" | "noActiveItems" | "cancelled" | "unavailable";
  unavailableReason: WeatherTimeseriesUnavailableReason | null;
  lastKnown: readonly WeatherTimeseriesPeriod[] | null;
  affectedScope: readonly string[];
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
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly" }>
  ))[];
  intents: readonly NotificationIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type WeatherTimeseriesUnitCodec = UnitCodec<WeatherTimeseriesUnitState, PersistedWeatherTimeseriesUnit> & Readonly<{
  schemaVersion: "p2-weather-timeseries-unit-v1";
}>;
