import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  FreshnessRecord,
  JsonValue,
  NotificationIntent,
  PersistenceStatus,
  PublishedOutcome,
  ReportRef,
  RejectionReason,
  UnitCodec,
  UnitView as SharedUnitView,
} from "./p2-shared-runtime.types";

export type WeatherCurrentUnavailableReason =
  | "capacityExceeded"
  | "historyUnavailable"
  | "coverageIncomplete";

export type WeatherCurrentSnapshot = Readonly<{
  subject: string;
  operation: Operation;
  scope: "national" | "partial";
  office: string;
  source: ReportRef;
  phenomena: Readonly<Record<string, JsonValue>>;
}>;

export type WeatherCurrentHistory = Readonly<{
  subject: string;
  operation: Operation;
  reports: readonly WeatherCurrentSnapshot[];
}>;

export type WeatherCurrentTombstone = Readonly<{
  subject: string;
  operation: Operation;
  source: ReportRef;
  affectedScope: readonly string[];
}>;

export type WeatherCurrentUnitState = Readonly<{
  schemaVersion: "p2-weather-current-unit-v1";
  national: WeatherCurrentSnapshot | null;
  partials: readonly WeatherCurrentSnapshot[];
  histories: readonly WeatherCurrentHistory[];
  ownership: Readonly<Record<string, string>>;
  tombstones: readonly WeatherCurrentTombstone[];
  freshness: readonly FreshnessRecord[];
  unavailable: readonly Readonly<{ subject: string; operation: Operation; reason: WeatherCurrentUnavailableReason; source: ReportRef | null; lastKnown: WeatherCurrentSnapshot | null; affectedScope: readonly string[] }>[];
  intents: readonly NotificationIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedWeatherCurrentUnit = Readonly<{
  schemaVersion: "p2-weather-current-unit-v1";
  national: WeatherCurrentSnapshot | null;
  partials: readonly WeatherCurrentSnapshot[];
  histories: readonly WeatherCurrentHistory[];
  ownership: Readonly<Record<string, string>>;
  tombstones: readonly WeatherCurrentTombstone[];
  freshness: readonly FreshnessRecord[];
  unavailable: readonly Readonly<{ subject: string; operation: Operation; reason: WeatherCurrentUnavailableReason; source: ReportRef | null; lastKnown: WeatherCurrentSnapshot | null; affectedScope: readonly string[] }>[];
  intents: readonly NotificationIntent[];
}>;

export type WeatherCurrentUnitView = SharedUnitView & Readonly<{
  unit: "U-W";
  national: WeatherCurrentSnapshot | null;
  partials: readonly WeatherCurrentSnapshot[];
  freshnessSuspectCount: number;
}>;

export type WeatherCurrentInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; nowMs: number }>
  | Readonly<{ kind: "deadline"; nowMs: number }>
  | Readonly<{ kind: "restore"; persisted: PersistedWeatherCurrentUnit; nowMs: number }>
  | Readonly<{ kind: "coverageConfirmed"; operation: Operation; family: string; subject: string; affectedScope: readonly string[]; nowMs: number }>
  | Readonly<{ kind: "notificationResult"; intentId: string; disposition: NotificationIntent["disposition"]; nowMs: number }>
  | Readonly<{ kind: "shutdown"; nowMs: number }>;

export type WeatherCurrentUnitStep = Readonly<{
  state: WeatherCurrentUnitState;
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

export type WeatherCurrentUnitCodec = UnitCodec<WeatherCurrentUnitState, PersistedWeatherCurrentUnit> & Readonly<{
  schemaVersion: "p2-weather-current-unit-v1";
}>;
