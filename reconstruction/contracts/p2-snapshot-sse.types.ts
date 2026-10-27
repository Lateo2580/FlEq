import type { Operation } from "./p1-parser-boundary.types";
import type { NotificationDeliveryState } from "./p2-notification-delivery.types";
import type { EewUnitView } from "./p2-eew-unit.types";
import type {
  DiagnosticDetails,
  PersistenceStatus,
  RuntimePublishedOutcome,
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
import type { TsunamiUnitView } from "./p3-tsunami-unit.types";
import type { SeismicUnitView } from "./p3-seismic-unit.types";
import type { NankaiUnitView } from "./p3-nankai-unit.types";
import type { VolcanoUnitView } from "./p3-volcano-unit.types";
import type { LandslideUnitView } from "./p3-landslide-unit.types";
import type { FloodUnitView } from "./p3-flood-unit.types";
import type { BriefingUnitView } from "./p3-briefing-unit.types";
import type { LocalBulletinsUnitView } from "./p3-local-bulletins-unit.types";
import type { TyphoonUnitView } from "./p3-typhoon-unit.types"; import type { EewWindowCard, RecoveryDigestView } from "./p3-recovery.types";

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

// P2-A8-AC11: durable restoration is independent of current confirmation. digest は起動時の一覧の頭（P3-REC-AC15、辿らない起動では null）。eewUnverified は切れていた間の EEW の札（P3-REC-AC14、窓は 1 枚）。
export type DisplayRecoveryView = Readonly<{ restoration: RuntimeRestoration; digest: RecoveryDigestView | null; eewUnverified: EewWindowCard | null }>;

export type DisplayInformationType = "eew" | "weather-warning" | "weather-warning-timeseries" | "tsunami" | "earthquake" | "nankai" | "volcano" | "landslide" | "flood" | "briefing" | "local-bulletins" | "typhoon";
export type DisplaySeverity = "none" | "below" | "forecast" | "advisory" | "warning" | "danger" | "specialWarning";
export type DisplayAreaSystem = "eewArea" | "prefecture" | "primary" | "municipalityGroup" | "municipality" | "stormSurge" | "forecastArea"
  // P3-C5-SNAPSHOT=A: VTSE41 の津波予報区と VTSE51/52 の観測点。
  | "tsunamiForecastArea" | "tsunamiStation" | "seismicArea" | "seismicStation"; // P3-C7-SNAPSHOT=A: 地震情報／細分区域と震度観測点。
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
    tsunami: DisplayDomainView<TsunamiUnitView>;
    earthquake: DisplayDomainView<SeismicUnitView>;
    nankai: DisplayDomainView<NankaiUnitView>;
    volcano: DisplayDomainView<VolcanoUnitView>;
    landslide: DisplayDomainView<LandslideUnitView>;
    flood: DisplayDomainView<FloodUnitView>;
    briefing: DisplayDomainView<BriefingUnitView>;
    localBulletins: DisplayDomainView<LocalBulletinsUnitView>;
    typhoon: DisplayDomainView<TyphoonUnitView>;
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
  recovery: DisplayRecoveryView; recoveryDigestBytes: number; // P3-REC-AC16: 作るときに数えた digest の byte（digest が null なら 0）。projector は digest を直列化しない
  confirmation: RuntimeConfirmation;
  notificationChannels: NotificationDeliveryState["channels"];
  channelProbeComplete: boolean;
  eew: EewUnitView;
  weatherCurrent: WeatherCurrentUnitView;
  weatherTimeseries: WeatherTimeseriesUnitView;
  tsunami: TsunamiUnitView;
  earthquake: SeismicUnitView;
  nankai: NankaiUnitView;
  volcano: VolcanoUnitView;
  landslide: LandslideUnitView;
  flood: FloodUnitView;
  briefing: BriefingUnitView;
  localBulletins: LocalBulletinsUnitView;
  typhoon: TyphoonUnitView;
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
    tsunami: DisplayDomainProjection<TsunamiUnitView>;
    earthquake: DisplayDomainProjection<SeismicUnitView>;
    nankai: DisplayDomainProjection<NankaiUnitView>;
    volcano: DisplayDomainProjection<VolcanoUnitView>;
    landslide: DisplayDomainProjection<LandslideUnitView>;
    flood: DisplayDomainProjection<FloodUnitView>;
    briefing: DisplayDomainProjection<BriefingUnitView>;
    localBulletins: DisplayDomainProjection<LocalBulletinsUnitView>;
    typhoon: DisplayDomainProjection<TyphoonUnitView>;
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
