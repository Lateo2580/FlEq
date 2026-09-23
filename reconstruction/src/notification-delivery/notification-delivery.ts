import type { ClockReading, DiagnosticDetails, NotificationIntent, NotificationResult } from "../../contracts/p2-shared-runtime.types";
import type { NotificationAttempt, NotificationChannel, NotificationDeliveryState, NotificationDeliveryStep,
  NotificationDomain, NotificationLevel, NotificationPriorityGroup, NotificationSelection } from "../../contracts/p2-notification-delivery.types";

const channels = ["desktop", "sound"] as const;
const domains = ["weather", "volcano", "earthquake-eew", "tsunami"] as const;
const levels = ["info", "normal", "warning", "critical", "cancel"] as const;
const key = (intent: NotificationIntent) => JSON.stringify([intent.unit, intent.id]);
const same = (intent: NotificationIntent, attempt: NotificationAttempt) => intent.id === attempt.intentId
  && intent.unit === attempt.unit && intent.subject === attempt.subject && intent.operation === attempt.operation
  && intent.channel === attempt.channel;

function resolveSoundAsset(payload: NotificationIntent["payload"]): NotificationAttempt["soundAsset"] {
  if (!domains.some((value) => value === payload.domain) || !levels.some((value) => value === payload.level)) return null;
  return `reconstruction/assets/sounds/${payload.domain as NotificationDomain}-${payload.level as NotificationLevel}.wav`;
}

function group(intent: NotificationIntent): NotificationPriorityGroup {
  if (intent.operation !== "normal") return "other";
  if (intent.payload.domain === "earthquake-eew") return "normalEew";
  if (intent.payload.domain === "tsunami" && (intent.payload.level === "warning" || intent.payload.level === "critical"))
    return "normalTsunamiEmergency";
  return "other";
}

const rank = { normalEew: 0, normalTsunamiEmergency: 1, other: 2 } as const;
function earlier(a: NotificationIntent, b: NotificationIntent): boolean {
  const priority = rank[group(a)] - rank[group(b)];
  return priority < 0 || priority === 0 && (a.expiresAt < b.expiresAt
    || a.expiresAt === b.expiresAt && (a.createdAt < b.createdAt
      || a.createdAt === b.createdAt && a.id < b.id));
}

function expired(intent: NotificationIntent, state: NotificationDeliveryState, clock: ClockReading): boolean {
  return clock.wallTimeMs >= intent.expiresAt
    || clock.monotonicMs >= (state.deadlines[intent.channel][key(intent)]?.expiresAtMonotonicMs ?? Infinity);
}

function selectNotificationAttempt(state: NotificationDeliveryState, clock: ClockReading): NotificationSelection {
  const intents = state.intents.map((intent) => intent.disposition === "pending" && expired(intent, state, clock)
    ? { ...intent, disposition: "expired" as const } : intent);
  const nextChannels: Record<NotificationChannel, NotificationDeliveryState["channels"][NotificationChannel]> = { ...state.channels };
  const attempts: NotificationAttempt[] = [];
  const abortRequests: NotificationSelection["abortRequests"][number][] = [];
  const diagnostics: DiagnosticDetails[] = [];
  const counts = new Map<NotificationIntent["unit"], number>();
  for (let i = 0; i < intents.length; i++) if (state.intents[i].disposition === "pending" && intents[i].disposition === "expired")
    counts.set(intents[i].unit, (counts.get(intents[i].unit) ?? 0) + 1);
  for (const [unit, count] of counts) diagnostics.push({ level: "INFO", component: "notification-delivery", reason: "notificationExpired", unit, count });

  for (const channelName of channels) {
    const channel = nextChannels[channelName];
    // R34: TTL reclamation above still applies; no candidate scan or attempt on unavailable channels.
    if (channel.kind === "unavailable") continue;
    let best: NotificationIntent | null = null;
    for (const intent of intents) {
      const deadline = state.deadlines[channelName][key(intent)];
      if (intent.channel !== channelName || intent.disposition !== "pending" || deadline == null
        || clock.monotonicMs < deadline.retryAtMonotonicMs || intent.operation !== "normal" && channelName === "sound") continue;
      if (best == null || earlier(intent, best)) best = intent;
    }
    if (channel.kind === "running") {
      const owner = intents.find((intent) => same(intent, channel.attempt));
      const cause = owner == null || owner.disposition === "superseded" ? "superseded"
        : owner.disposition === "expired" || expired(owner, state, clock) ? "expired"
          : clock.monotonicMs >= channel.attempt.timeoutAtMonotonicMs ? "timeout"
            : best != null && rank[group(best)] < rank[channel.attempt.priorityGroup] ? "higherPriority" : null;
      if (cause != null) {
        nextChannels[channelName] = { kind: "stopping", attempt: channel.attempt, cause,
          stopByMonotonicMs: clock.monotonicMs + 1_000 };
        abortRequests.push({ attemptId: channel.attempt.attemptId, cause });
      }
    } else if (channel.kind === "idle" && best != null) {
      const deadline = state.deadlines[channelName][key(best)]!;
      const soundAsset = channelName === "sound" ? resolveSoundAsset(best.payload) : null;
      if (channelName === "sound" && soundAsset == null) {
        diagnostics.push({ level: "WARN", component: "notification-delivery", reason: "notificationAttemptFailed", unit: best.unit });
        continue;
      }
      const attempt: NotificationAttempt = { attemptId: `${best.unit}:${best.id}:${best.attempts + 1}`,
        intentId: best.id, unit: best.unit, subject: best.subject, operation: best.operation, channel: channelName,
        priorityGroup: group(best), payload: best.payload, soundAsset,
        selectedAtMonotonicMs: clock.monotonicMs,
        timeoutAtMonotonicMs: Math.min(clock.monotonicMs + (channelName === "sound" ? 10_000 : 5_000), deadline.expiresAtMonotonicMs),
        expiresAt: best.expiresAt };
      const index = intents.indexOf(best);
      intents[index] = { ...best, attempts: best.attempts + 1 };
      nextChannels[channelName] = { kind: "running", attempt };
      attempts.push(attempt);
    }
  }
  return { state: { ...state, intents, channels: nextChannels }, attempts, abortRequests, diagnostics };
}

function applyNotificationResult(state: NotificationDeliveryState, result: NotificationResult,
  clock: ClockReading): NotificationDeliveryStep {
  const channel = state.channels[result.channel];
  if (channel.kind !== "running" && channel.kind !== "stopping" && channel.kind !== "isolated")
    return { state, diagnostics: [] };
  if (channel.kind === "isolated") return { state, diagnostics: [] };
  const attempt = channel.attempt;
  if (attempt.attemptId !== result.attemptId || attempt.intentId !== result.intentId || attempt.channel !== result.channel)
    return { state, diagnostics: [] };
  const index = state.intents.findIndex((intent) => same(intent, attempt));
  const intent = state.intents[index];
  const cause = channel.kind === "stopping" ? channel.cause : null;
  const isExpired = cause === "expired" || clock.wallTimeMs >= attempt.expiresAt
    || intent != null && expired(intent, state, clock);
  const timedOut = !isExpired && (cause === "timeout" || cause == null
    && (clock.monotonicMs >= attempt.timeoutAtMonotonicMs || result.kind === "timeout"));
  const failed = !isExpired && (timedOut || cause == null && result.kind === "failed");
  const stopped = result.kind !== "timeout" && result.kind !== "aborted" || result.stopped;
  const nextChannel = stopped ? { kind: "idle" as const } : { kind: "isolated" as const,
    attemptId: attempt.attemptId, sinceMonotonicMs: clock.monotonicMs, reason: "stopUnconfirmed" as const };
  const nextChannels = { ...state.channels, [result.channel]: nextChannel };
  let intents = state.intents;
  let deadlines = state.deadlines;
  const diagnostics: DiagnosticDetails[] = [];
  if (!stopped) diagnostics.push({ level: "ERROR", component: "notification-delivery", reason: "notificationAdapterIsolated", attemptId: attempt.attemptId });
  if (intent != null && intent.disposition === "pending") {
    let changed: NotificationIntent | null = null;
    if (isExpired) {
      changed = { ...intent, disposition: "expired" };
      diagnostics.push({ level: "INFO", component: "notification-delivery", reason: "notificationExpired", unit: intent.unit, count: 1 });
    } else if (channel.kind === "running" && result.kind === "delivered" && !timedOut)
      changed = { ...intent, disposition: "delivered" };
    else if (failed || cause === "higherPriority" || cause == null && result.kind === "aborted" && result.reason === "higherPriority") {
      const delay = Math.min(10_000, 1_000 * 2 ** Math.min(intent.attempts - 1, 4));
      changed = { ...intent, nextAttemptAt: result.completedAt.wallTimeMs + delay };
      deadlines = { ...state.deadlines, [result.channel]: { ...state.deadlines[result.channel],
        [key(intent)]: { ...state.deadlines[result.channel][key(intent)]!, retryAtMonotonicMs: result.completedAt.monotonicMs + delay } } };
    }
    if (changed != null) intents = state.intents.map((value, at) => at === index ? changed! : value);
  }
  if (failed) diagnostics.push({ level: "WARN",
    component: "notification-delivery", reason: "notificationAttemptFailed", attemptId: attempt.attemptId });
  return { state: { ...state, intents, channels: nextChannels, deadlines }, diagnostics };
}

export { resolveSoundAsset, selectNotificationAttempt, applyNotificationResult };
