import type { Operation } from "./p1-parser-boundary.types";
import type { NotificationDeliveryState } from "./p2-notification-delivery.types";
import type { EewUnitView } from "./p2-eew-unit.types";
import type {
  DiagnosticDetails,
  PersistenceStatus,
  RuntimePublishedOutcome,
  RuntimeAdmissionCounts,
  RejectionReason,
  RuntimeDisplayChange,
  RuntimeUnitId,
  UnconfirmedReason,
  RuntimeConfirmation,
  RuntimeRestoration,
  UnitId,
} from "./p2-shared-runtime.types";
import type { WeatherCurrentUnitView } from "./p2-weather-current-unit.types";
import type { WeatherTimeseriesUnitView } from "./p2-weather-timeseries-unit.types";

export type DisplayVersion = Readonly<{
  streamId: string;
  semanticRevision: string;
  sequence: number;
}>;

export type DisplayConnectionView = Readonly<{
  state: "connected" | "reconnecting" | "stopped";
  // Wall-clock time of the latest transport loss; null before the first loss.
  disconnectedAt: number | null;
  // Wall-clock receipt of the last input, regardless of acceptance or coverage.
  lastInputAt: number | null;
}>;

export type DisplayWorkerView = Readonly<{
  state: "healthy" | "stalled" | "unresponsive" | "stopped";
  lastProgressAtMonotonicMs: number | null;
  lastResponseAtMonotonicMs: number | null;
}>;

// P2-A8-AC11: durable restoration is independent of current confirmation.
export type DisplayRecoveryView = RuntimeRestoration;

export type DisplayInformationType = "eew" | "weather-warning" | "weather-warning-timeseries";
export type DisplaySeverity = "none" | "below" | "forecast" | "advisory" | "warning" | "danger" | "specialWarning";
export type DisplayAreaSystem = "eewArea" | "prefecture" | "primary" | "municipalityGroup" | "municipality" | "stormSurge" | "forecastArea";
export type DisplayConfirmationView = Readonly<{
  state: "confirmed" | "partial" | "unconfirmed";
  confirmedAt: number | null;
}>;

// P2-A8-SUMMARY: fixed rows preserve active AND fault counts; no subject identifiers on wire.
export type DisplaySummaryItem = Readonly<{
  operation: Operation;
  informationType: DisplayInformationType;
  activeCount: number;
  highestSeverity: DisplaySeverity | null;
  areaCounts: Readonly<Partial<Record<DisplayAreaSystem, number>>>;
  updatedAt: number | null;
  admission: Readonly<Partial<Record<"capacityExceeded", number>>>;
  unavailable: Readonly<Partial<Record<"capacityExceeded" | "historyUnavailable" | "coverageIncomplete", number>>>;
  unconfirmed: Readonly<Partial<Record<UnconfirmedReason, number>>>;
  unknownCode: Readonly<Partial<Record<"unknown" | "missing" | "empty", number>>>;
  freshness: Readonly<Partial<Record<RejectionReason | "stale", number>>>;
  confirmation: DisplayConfirmationView;
}>;

export type DisplayChannelView = "checking" | "available" | "unavailable" | "isolated";

export type DisplayDomainView<View> = Readonly<{
  unit: RuntimeUnitId;
  contentRevision: string;
  // Exactly normal, training, test, in that order; same data for full and summary.
  items: readonly [DisplaySummaryItem, DisplaySummaryItem, DisplaySummaryItem];
}> & (
  | Readonly<{ delivery: "full"; view: View }>
  | Readonly<{ delivery: "summary"; reason: "snapshotBudget"; originalBytes: number; budgetBytes: number }>
);

// P2-A8-NOTICE: raw ReportRef and arbitrary upstream identity strings never enter this projection.
export type DisplayNoticeSource = Readonly<{
  id: string;
  family: "VXSE43" | "VXSE45" | "VPWS50" | "VPWW55" | "VPWW57" | "VPWW58" | "VPWW59" | "VPWW60" | "VPWW61" | "VPNO50" | "VPWP50";
  office: string | null;
  officeTruncated: boolean;
  reportTime: number | null;
}>;
export type VisibleNotice = Readonly<{
  id: string;
  targetId: string;
  unit: RuntimeUnitId;
  kind: "eewNew" | "eewWarning" | "unavailable";
  operation: Operation;
  text: string;
  source: DisplayNoticeSource | null;
  // P2-A8-NOTICE.clock: an integer in the ECMAScript Date range.
  expiresAt: number;
}>;

export type DisplaySnapshot = Readonly<{
  schemaVersion: 1;
  streamId: string;
  sequence: number;
  generatedAt: string;
  semanticRevision: string;
  connection: DisplayConnectionView;
  worker: DisplayWorkerView;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  recovery: DisplayRecoveryView;
  channels: Readonly<Record<"desktop" | "sound", DisplayChannelView>>;
  current: Readonly<{
    eew: DisplayDomainView<EewUnitView>;
    weatherCurrent: DisplayDomainView<WeatherCurrentUnitView>;
    weatherTimeseries: DisplayDomainView<WeatherTimeseriesUnitView>;
  }>;
  notices: readonly VisibleNotice[];
}>;

export type SnapshotProjectionInput = Readonly<{
  streamId: string;
  generatedAt: string;
  // P2-A8-NOTICE.clock: Date-range integer; validate before TTL addition or expiry checks.
  nowMs: number;
  connection: DisplayConnectionView;
  worker: DisplayWorkerView;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  recovery: DisplayRecoveryView;
  confirmation: RuntimeConfirmation;
  // Supplied every step, including changes from 1 to 2 with an unchanged admission bit.
  admissionCounts: RuntimeAdmissionCounts;
  notificationChannels: NotificationDeliveryState["channels"];
  channelProbeComplete: boolean;
  eew: EewUnitView;
  weatherCurrent: WeatherCurrentUnitView;
  weatherTimeseries: WeatherTimeseriesUnitView;
  // A1 accepted outcomes only; A8 derives short-lived screen notices, never A7 intents.
  outcomes: readonly RuntimePublishedOutcome[];
  // P2-A1-DISPLAY-CHANGES: includes deletions/evictions with no PublishedOutcome.
  displayChanges: readonly RuntimeDisplayChange[];

}>;

// P2-A8-COST: three concrete projection records survive summary delivery; no generic cache service.
export type DisplayDomainProjection<View> = Readonly<{
  full: Extract<DisplayDomainView<View>, { delivery: "full" }>;
  utf8Bytes: number;
  // Keys encode operation + fixed kind + value; counts permit deletion without rescanning subjects.
  areaRefs: ReadonlyMap<string, number>;
  severityRefs: ReadonlyMap<string, number>;
  timeRefs: ReadonlyMap<string, number>;
}>;
export type SnapshotProjectionState = Readonly<{
  streamId: string;
  // P2-A8-PUBLICATION: only the last successfully published snapshot; null after initial rejection.
  snapshot: DisplaySnapshot | null;
  // Current bounded notices, including notices not yet published; TTL is never restarted on retry.
  notices: readonly VisibleNotice[];
  domains: Readonly<{
    eew: DisplayDomainProjection<EewUnitView> & Readonly<{
      // P2-A8-NOTICE: at most 1024 operation/event keys; avoids cross-family view searches.
      eventRefs: ReadonlyMap<string, Readonly<{ forecast: number; warning: number }>>;
    }>;
    weatherCurrent: DisplayDomainProjection<WeatherCurrentUnitView>;
    weatherTimeseries: DisplayDomainProjection<WeatherTimeseriesUnitView>;
  }>;
}>;
export type SnapshotProjectionResult =
  | Readonly<{ kind: "unchanged"; state: SnapshotProjectionState; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{ kind: "rejected"; state: SnapshotProjectionState; reason: "snapshotCommonBudgetExceeded" | "snapshotStringLimitExceeded" | "snapshotClockInvalid"; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{ kind: "projected"; state: SnapshotProjectionState; snapshot: DisplaySnapshot; utf8Bytes: number; diagnostics: readonly DiagnosticDetails[] }>;

export type SnapshotHttpResponse =
  | Readonly<{ status: 200; contentType: "application/json"; body: DisplaySnapshot }>
  | Readonly<{ status: 503; contentType: "application/json"; body: Readonly<{ reason: "snapshotUnavailable" }> }>;

export type SseEvent =
  | Readonly<{ event: "snapshot"; id: string; data: DisplaySnapshot }>
  | Readonly<{
      event: "heartbeat";
      data: Readonly<{ worker: DisplayWorkerView; latestVersion: DisplayVersion | null; emittedAt: number }>;
    }>;

export type HealthResponse = Readonly<{
  status: 200;
  body: Readonly<{
    transport: "ok";
    worker: DisplayWorkerView["state"];
    latestVersion: DisplayVersion | null;
    ready: boolean;
  }>;
}>;

export type SseClientState = Readonly<{
  backpressured: boolean;
  waitingSnapshot: DisplaySnapshot | null;
  blockedSinceMonotonicMs: number | null;
  closed: boolean;
}>;

export type SseClientInput =
  | Readonly<{ kind: "event"; event: SseEvent }>
  | Readonly<{ kind: "writeResult"; writable: boolean }>
  | Readonly<{ kind: "drain" | "closed" | "deadline" }>;

export type SseTransition = Readonly<{
  state: SseClientState;
  write: SseEvent | null;
  close: boolean;
}>;
