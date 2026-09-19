import type { Operation } from "./p1-parser-boundary.types";
import type {
  DiagnosticDetails,
  JsonValue,
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
  payload: Readonly<Record<string, JsonValue>>;
  soundAsset: `reconstruction/assets/sounds/${NotificationDomain}-${NotificationLevel}.wav` | null;
  selectedAtMonotonicMs: number;
  timeoutAtMonotonicMs: number;
  expiresAt: number;
}>;

export type NotificationChannelState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "running"; attempt: NotificationAttempt }>
  | Readonly<{ kind: "stopping"; attempt: NotificationAttempt; stopByMonotonicMs: number }>
  | Readonly<{ kind: "isolated"; attemptId: string; sinceMonotonicMs: number; reason: "stopUnconfirmed" }>;

export type NotificationDeliveryState = Readonly<{
  intents: readonly NotificationIntent[];
  channels: Readonly<Record<NotificationChannel, NotificationChannelState>>;
}>;

export type NotificationSelection = Readonly<{
  state: NotificationDeliveryState;
  attempts: readonly NotificationAttempt[];
  abortAttemptIds: readonly string[];
  dirtyUnits: readonly UnitId[];
  diagnostics: readonly DiagnosticDetails[];
}>;

export type NotificationDeliveryStep = Readonly<{
  state: NotificationDeliveryState;
  dirtyUnits: readonly UnitId[];
  diagnostics: readonly DiagnosticDetails[];
}>;
