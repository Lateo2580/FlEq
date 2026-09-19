import type { Operation } from "./p1-parser-boundary.types";
import type { EewUnitView } from "./p2-eew-unit.types";
import type {
  DiagnosticDetails,
  PersistenceStatus,
  ReportRef,
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
  lastInputAt: number | null;
}>;

export type DisplayWorkerView = Readonly<{
  state: "healthy" | "stalled" | "unresponsive" | "stopped";
  lastProgressAtMonotonicMs: number | null;
  lastResponseAtMonotonicMs: number | null;
}>;

export type DisplayRecoveryView = Readonly<{
  state: "confirmed" | "partial" | "uncertain";
  affectedUnits: readonly UnitId[];
}>;

export type DisplaySummaryItem = Readonly<{
  operation: Operation;
  informationType: string;
  highestSeverity: string | null;
  areaCount: number | null;
  updatedAt: number | null;
}>;

export type DisplayDomainView<View> = Readonly<{
  unit: UnitId;
  semanticState: "active" | "inactive" | "unavailable";
}> & (
  | Readonly<{ delivery: "full"; view: View }>
  | Readonly<{
      delivery: "summary";
      reason: "snapshotBudget";
      originalBytes: number;
      budgetBytes: number;
      items: readonly DisplaySummaryItem[];
    }>
);

export type VisibleNotice = Readonly<{
  // 合算 64 件/131072 JSON UTF-8 bytes。text は 4096 bytes、他の文字列は 256 bytes 以下。
  id: string;
  operation: Operation;
  text: string;
  source: ReportRef | null;
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
  current: Readonly<{
    eew: DisplayDomainView<EewUnitView>;
    weatherCurrent: DisplayDomainView<WeatherCurrentUnitView>;
    weatherTimeseries: DisplayDomainView<WeatherTimeseriesUnitView>;
  }>;
  notices: readonly VisibleNotice[];
}>;

export type SnapshotProjectionInput = Readonly<{
  version: DisplayVersion;
  generatedAt: string;
  // 有限の wall clock。期限回収にも使い、純関数内で時計を読み取らない。
  nowMs: number;
  connection: DisplayConnectionView;
  worker: DisplayWorkerView;
  persistence: Readonly<Partial<Record<UnitId, PersistenceStatus>>>;
  recovery: DisplayRecoveryView;
  eew: EewUnitView;
  weatherCurrent: WeatherCurrentUnitView;
  weatherTimeseries: WeatherTimeseriesUnitView;
  notices: readonly VisibleNotice[];
}>;

export type SnapshotProjectionResult =
  // 比較から除くのは generatedAt。metadata・配送状態・notice の変化は projected。
  | Readonly<{ kind: "unchanged"; diagnostics: readonly DiagnosticDetails[] }>
  | Readonly<{
      kind: "rejected";
      reason: "snapshotCommonBudgetExceeded" | "snapshotStringLimitExceeded";
      diagnostics: readonly DiagnosticDetails[];
    }>
  | Readonly<{ kind: "projected"; snapshot: DisplaySnapshot; utf8Bytes: number; diagnostics: readonly DiagnosticDetails[] }>;

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
  writing: boolean;
  waitingSnapshot: DisplaySnapshot | null;
  lastWriteAtMonotonicMs: number;
  closed: boolean;
}>;
