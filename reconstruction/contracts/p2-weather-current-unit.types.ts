import type { DecodedMaterial, Operation } from "./p1-parser-boundary.types";
import type {
  AdmissionEvidence,
  ClockReading,
  DiagnosticDetails,
  FreshnessRecord,
  JsonValue,
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

export type WeatherCurrentUnavailableReason =
  | "capacityExceeded"
  | "historyUnavailable"
  | "coverageIncomplete";

// Q-ENUM scopeEncoding: unavailable/coverage/freshness affectedScope tokens are
// JSON.stringify([family, scope, office, areaType, areaCode]); recover the first
// three fields even when source and lastKnown are null. Nonempty canonical set;
// all/empty-code covers only the same family/scope/office, never another office.

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
  national: Readonly<Partial<Record<Operation, WeatherCurrentSnapshot>>>;
  partials: readonly WeatherCurrentSnapshot[];
  histories: readonly WeatherCurrentHistory[];
  ownership: Readonly<Record<string, string>>;
  tombstones: readonly WeatherCurrentTombstone[];
  // Rejected input may update only this monitoring record under Q-ENUM freshnessRule.
  freshness: readonly FreshnessRecord[];
  unavailable: readonly Readonly<{ subject: string; operation: Operation; reason: WeatherCurrentUnavailableReason; source: ReportRef | null; lastKnown: WeatherCurrentSnapshot | null; affectedScope: readonly string[] }>[];
  intents: readonly NotificationIntent[];
  persistence: PersistenceStatus;
}>;

export type PersistedWeatherCurrentUnit = Readonly<{
  schemaVersion: "p2-weather-current-unit-v1";
  national: Readonly<Partial<Record<Operation, WeatherCurrentSnapshot>>>;
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
  national: Readonly<Partial<Record<Operation, WeatherCurrentSnapshot>>>;
  partials: readonly WeatherCurrentSnapshot[];
  freshnessSuspectCount: number;
}>;

export type WeatherCurrentInput =
  | Readonly<{ kind: "receive"; material: DecodedMaterial; clock: ClockReading }>
  | Readonly<{ kind: "deadline"; clock: ClockReading }>
  | Readonly<{ kind: "restore"; persisted: PersistedWeatherCurrentUnit; clock: ClockReading }>
  | Readonly<{ kind: "coverageConfirmed"; operation: Operation; family: string; subject: string; affectedScope: readonly string[]; clock: ClockReading }>
  // A1-correlated updates; batch ids are distinct, with the same per-item semantics as a single update.
  | Readonly<{ kind: "intentUpdate"; intentUpdate: NotificationIntentUpdate | readonly NotificationIntentUpdate[]; clock: ClockReading }>
  | Readonly<{ kind: "shutdown"; clock: ClockReading }>;

export type WeatherCurrentUnitStep = Readonly<{
  state: WeatherCurrentUnitState;
  nextDeadline: RuntimeUnitDeadline | null;
  // Subject identity includes operation; compare these records with the sequence oracle.
  decisions: readonly (Readonly<{ subject: string; operation: Operation }> & (
    | Readonly<{ decision: "unchanged"; reason: "duplicate" | "stale" | "noChange" }>
    | Readonly<{ decision: "rejected"; reason: RejectionReason }>
    | Readonly<{ decision: "capacityExceeded"; rejection: AdmissionEvidence & Readonly<{ affectedScope: readonly string[] }> }>
    | Readonly<{ decision: "changed"; reason: null; change: "semantic" | "revisionOnly" | "deliveryOnly"; currentEstablished: (AdmissionEvidence & Readonly<{ affectedScope: readonly string[] }>) | null }>
  ))[];
  intents: readonly NotificationIntent[];
  outcomes: readonly PublishedOutcome[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type WeatherCurrentUnitCodec = UnitCodec<WeatherCurrentUnitState, PersistedWeatherCurrentUnit> & Readonly<{
  schemaVersion: "p2-weather-current-unit-v1";
}>;
