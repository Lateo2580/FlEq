import type { Operation } from "./p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  NotificationIntent,
  NotificationResult,
  UnitId,
} from "./p2-shared-runtime.types";

export type NotificationChannel = NotificationIntent["channel"];
export type NotificationPriorityGroup = "normalEew" | "normalTsunamiEmergency" | "other";
export type NotificationDomain = "weather" | "volcano" | "earthquake-eew" | "tsunami";
export type NotificationLevel = "info" | "normal" | "warning" | "critical" | "cancel";

export type NotificationAttempt = Readonly<{
  attemptId: string;
  intentId: string;
  unit: UnitId;
  subject: string;
  operation: Operation;
  channel: NotificationChannel;
  priorityGroup: NotificationPriorityGroup;
  payload: NotificationIntent["payload"];
  soundAsset: `reconstruction/assets/sounds/${NotificationDomain}-${NotificationLevel}.wav` | null;
  selectedAtMonotonicMs: number;
  timeoutAtMonotonicMs: number;
  expiresAt: number;
}>;

// P2-A7-AC03: owner intent loss uses superseded (except expiry); A3 forwards the A1 cause.
export type NotificationAbortRequest = Readonly<{
  attemptId: string;
  cause: Extract<NotificationResult, { kind: "aborted" }>["reason"] | "timeout";
}>;

export type NotificationChannelState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running"; attempt: NotificationAttempt }>
  | Readonly<{ kind: "stopping"; attempt: NotificationAttempt; cause: NotificationAbortRequest["cause"]; stopByMonotonicMs: number }>
  | Readonly<{ kind: "isolated"; attemptId: string; sinceMonotonicMs: number; reason: "stopUnconfirmed" }>;

export type NotificationDeliveryState = Readonly<{
  intents: readonly NotificationIntent[];
  channels: Readonly<Record<NotificationChannel, NotificationChannelState>>;
  // P2-A7-TIME: key = JSON.stringify([unit, intentId]); pending only, <= 384 total.
  // Initialized at adoption/restore, retry updated on failure; ordinary selection preserves them.
  deadlines: Readonly<Record<NotificationChannel, Readonly<Partial<Record<string, Readonly<{
    retryAtMonotonicMs: number;
    expiresAtMonotonicMs: number;
  }>>>>>>;
}>;

export type NotificationSelection = Readonly<{
  state: NotificationDeliveryState;
  attempts: readonly NotificationAttempt[];
  abortRequests: readonly NotificationAbortRequest[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type NotificationDeliveryStep = Readonly<{
  state: NotificationDeliveryState;
  diagnostics: readonly DiagnosticDetails[];
}>;
