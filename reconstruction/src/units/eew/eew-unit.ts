import type { ClockReading, NoticeEvidence, NotificationIntent, PersistenceStatus, ReportRef, RuntimeDisplaySubject, SubjectOutcome } from "../../../contracts/p2-shared-runtime.types";
import type {
  EewInput,
  EewNoticeFamily,
  EewNoticeMark,
  EewNotificationPayload,
  EewUnitCodec,
  EewUnitState,
  EewUnitStep,
  EewUnitView,
  PersistedEewUnit,
} from "../../../contracts/p2-eew-unit.types";
import { dirty, expiredOutcome, nextEewDeadline, noticeAt, reclaimEewLifetime, reduceEew as reduceEewCore } from "../../domains/eew/eew";
import { deliveryGrowth } from "../../notification-delivery/delivery-growth"; import { INPUT_BOUNDARY_MAX_BYTES, LOSS_TALLY_MAX_BYTES } from "../../checkpoint/checkpoint"; import { controlDateTimeOf, readReportRef } from "../../contracts-revision/version";
import type { UnitModule } from "../../../contracts/p3-unit-table.types";
import { applyIntentUpdate, readIntentState, restoreStarted, strongerEvidence, updateEvidence } from "../notice-mark";

const SCHEMA = "p2-eew-unit-v4" as const;
// P3-NL-AC04 (8)（置き値）: 2,048 件の印の上界と pending（予約込み 128 KiB）と H39 の欄と envelope・inputBoundary の上限を 64 KiB の倍数に切り上げる。
const GENERATION_BYTES = 2_097_152;
const INTENT_BYTES = 128 * 1024;
const NOTICE_LIMIT = 2_048;
const encoder = new TextEncoder();
type InternalStep = Omit<EewUnitStep, "displayChanges" | "confirmationEvidence">;
type EewIntent = NotificationIntent & Readonly<{ payload: EewNotificationPayload }>;

function object(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function operation(value: unknown): value is NotificationIntent["operation"] {
  return value === "normal" || value === "training" || value === "test";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}


// P3-NL-AC06 (2): 期限の長さは desktop と鳴らし直していない sound が 15 秒、1 回の鳴らし直しを使った sound が 30 秒まで。
// 確かめた欄だけで組み立てる（欄の外のキーは通さない）。transition は閉集合の文字列だけを受ける。
const TRANSITIONS = ["activated", "updated", "cancelled", "released", "expired"] as const;
function readIntent(value: unknown): EewIntent | null {
  const record = object(value), payload = object(record?.payload), source = readReportRef(record?.source);
  const transition = TRANSITIONS.find((item) => item === record?.transition);
  const channel = record?.channel === "desktop" || record?.channel === "sound" ? record.channel : null;
  const level = payload?.level === "normal" || payload?.level === "warning" || payload?.level === "critical" || payload?.level === "cancel"
    ? payload.level : null;
  const id = record?.id, subject = record?.subject, title = payload?.title, body = payload?.body, configRevision = record?.configRevision;
  const createdAt = record?.createdAt, expiresAt = record?.expiresAt, nextAttemptAt = record?.nextAttemptAt, attempts = record?.attempts;
  if (record == null || payload == null || source == null || transition == null || channel == null || level == null
    || typeof id !== "string" || record.unit !== "U-E" || typeof subject !== "string" || !operation(record.operation)
    || record.operation !== "normal" && channel === "sound" || Object.keys(payload).length !== 4 || payload.domain !== "earthquake-eew"
    || typeof title !== "string" || title.length === 0 || typeof body !== "string" || body.length === 0
    || !finite(createdAt) || !finite(expiresAt) || !finite(nextAttemptAt) || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 0
    || typeof configRevision !== "string" || expiresAt < createdAt || source.subject !== subject || source.operation !== record.operation) return null;
  const state = readIntentState(record, "U-E", record.operation, level);
  if (state == null || expiresAt - createdAt > (state.replayed ? 30_000 : 15_000)) return null;
  return { id, unit: "U-E", subject, operation: record.operation, source, transition, channel,
    payload: { domain: "earthquake-eew", level, title, body }, createdAt, expiresAt, nextAttemptAt, attempts, configRevision, disposition: "pending", ...state };
}

// P3-NL-AC04 (1)(5): EventID の印の読み戻し。欄ごとに確かめて組み立てる。形の外は null。
const KINDS = ["report", "cancel"] as const;
const rawOf = (value: unknown): value is string => typeof value === "string" && controlDateTimeOf(value) === value;
function noticeFamily(value: unknown): EewNoticeFamily | null {
  const record = object(value);
  const kinds = Array.isArray(record?.kinds) ? record.kinds : null;
  const read = kinds == null ? null : KINDS.filter((item) => kinds.includes(item));
  if (record == null || kinds == null || read == null || read.length !== kinds.length || read.some((item, index) => kinds[index] !== item)
    || record.family !== "VXSE43" && record.family !== "VXSE45" || !rawOf(record.reportDateTimeRaw) || !rawOf(record.controlDateTimeRaw)
    || typeof record.serialRaw !== "string" || !/^[1-9]\d*$/.test(record.serialRaw) || !Number.isSafeInteger(Number(record.serialRaw))
    || typeof record.cancelled !== "boolean") return null;
  return { family: record.family, reportDateTimeRaw: record.reportDateTimeRaw, controlDateTimeRaw: record.controlDateTimeRaw,
    serialRaw: record.serialRaw, cancelled: record.cancelled, kinds: read };
}
function noticeMark(value: unknown): EewNoticeMark | null {
  const record = object(value);
  const families = Array.isArray(record?.families) ? record.families.map(noticeFamily) : null;
  const evidence = record?.deliveryEvidence === "unattempted" || record?.deliveryEvidence === "possible" || record?.deliveryEvidence === "unknown"
    ? record.deliveryEvidence : null;
  if (record == null || families == null || evidence == null || families.length === 0 || families.length > 2
    || !families.every((item): item is EewNoticeFamily => item != null) || families.length === 2 && families[0].family !== "VXSE43"
    || families.length === 2 && families[1].family !== "VXSE45"
    || typeof record.eventId !== "string" || !/^\d{14}$/.test(record.eventId) || !operation(record.operation)
    || typeof record.firstReportNotified !== "boolean" || typeof record.warningNotified !== "boolean" || typeof record.vxse45Accepted !== "boolean"
    || !Number.isSafeInteger(record.notifiedMaximumRank) || Number(record.notifiedMaximumRank) < -1 || Number(record.notifiedMaximumRank) > 9
    // 区域は 0〜999 の bit（250 桁の 16 進まで、先頭の 0 なし）。
    || typeof record.notifiedWarningAreas !== "string" || !/^(?:0|[1-9a-f][0-9a-f]{0,249})$/.test(record.notifiedWarningAreas)
    || !Number.isSafeInteger(record.retainUntil)) return null;
  return { eventId: record.eventId, operation: record.operation, firstReportNotified: record.firstReportNotified,
    warningNotified: record.warningNotified, vxse45Accepted: record.vxse45Accepted, deliveryEvidence: evidence,
    notifiedMaximumRank: Number(record.notifiedMaximumRank), notifiedWarningAreas: record.notifiedWarningAreas,
    retainUntil: Number(record.retainUntil), families };
}

function generationByteLength(payload: PersistedEewUnit): number {
  return encoder.encode(JSON.stringify({
    schemaVersion: SCHEMA, unit: "U-E", generation: Number.MAX_SAFE_INTEGER,
    capturedAt: -0.0000012345678901234567, payload, sha256: "0".repeat(64), // P3-VM-AC06: capture が受ける有限な数の JSON の最長（25 文字）
  })).byteLength + INPUT_BOUNDARY_MAX_BYTES + LOSS_TALLY_MAX_BYTES; // P3-VM-AC06・P3-NL-AC14 (7): envelope の inputBoundary と losses の最大
}

function persisted(value: unknown): PersistedEewUnit | null {
  const record = object(value);
  if (record == null || record.schemaVersion !== SCHEMA || !Array.isArray(record.intents)
    || !Array.isArray(record.notices) || record.intents.length > 128 || record.notices.length > NOTICE_LIMIT) return null;
  const intents = record.intents.map(readIntent), notices = record.notices.map(noticeMark);
  if (!intents.every((item): item is EewIntent => item != null) || !notices.every((item): item is EewNoticeMark => item != null)) return null;
  const result: PersistedEewUnit = { schemaVersion: SCHEMA, intents, notices };
  if (new Set(result.intents.map((item) => item.id)).size !== result.intents.length
    || new Set(notices.map((item) => `${item.operation}/${item.eventId}`)).size !== notices.length) return null;
  // 予約は世代の計量に入れない（P3-IUR-GENERATION）。受理（domains/eew/eew.ts）と同じ式で pending の上限だけに足す。
  if (encoder.encode(JSON.stringify(result.intents)).byteLength + result.intents.reduce((sum, item) => sum + deliveryGrowth(item), 0) > INTENT_BYTES
    || generationByteLength(result) > GENERATION_BYTES) return null;
  return result;
}

function cleanPersistence(): PersistenceStatus {
  return {
    kind: "saved", currentGeneration: 0, savedGeneration: 0,
    savedCapturedAt: null, savedAckAt: null, dirtySince: null,
  };
}

function subject(intentValue: NotificationIntent, transition: string): SubjectOutcome {
  return {
    subject: intentValue.subject, operation: intentValue.operation,
    informationType: intentValue.source.infoTypeRaw, transition, severity: null,
    source: intentValue.source, facts: { intentId: intentValue.id, channel: intentValue.channel },
    changedFields: ["intents"],
  };
}

function expire(state: EewUnitState, clock: ClockReading): Readonly<{
  state: EewUnitState;
  expired: readonly NotificationIntent[];
}> {
  const expired = state.intents.filter((item) => item.expiresAt <= clock.wallTimeMs);
  if (expired.length === 0) return { state, expired };
  const ids = new Set(expired.map((item) => item.id));
  return { expired, state: { ...state, intents: state.intents.filter((item) => !ids.has(item.id)),
    persistence: dirty(state.persistence, clock.monotonicMs) } };
}

// P3-NL-AC02 (3)・AC08 (1): intent の EventID の印の証拠を上げる（下げない）。印は EventID の Map で引く。
function raiseNotices(notices: EewUnitState["notices"], raised: ReadonlyMap<string, Readonly<{ operation: string; eventId: string; evidence: NoticeEvidence }>>):
  EewUnitState["notices"] {
  let next = notices;
  for (const { operation, eventId, evidence } of raised.values()) {
    const at = noticeAt(next, operation, eventId);
    if (at == null) continue;
    const mark = next[at], deliveryEvidence = strongerEvidence(mark.deliveryEvidence, evidence);
    if (deliveryEvidence !== mark.deliveryEvidence) next = next.map((item, position) => position === at ? { ...mark, deliveryEvidence } : item);
  }
  return next;
}
const raisedBy = (intents: readonly NotificationIntent[], evidence: (item: NotificationIntent) => NoticeEvidence | null) =>
  new Map(intents.flatMap((item) => {
    const level = evidence(item), eventId = item.subject.split("/")[2];
    return level == null || eventId == null ? [] : [[`${item.operation}/${eventId}`, { operation: item.operation, eventId, evidence: level }] as const];
  }));

// P3-EF-AC04: intent の壁時計の失効と印の回収は入力の根拠が verified のときだけ（current・gate の寿命は EEW の閉じ方の契約のまま）。
function restore(state: EewUnitState, value: PersistedEewUnit, clock: ClockReading, verified: boolean): InternalStep {
  const decoded = eewUnitCodec.decode(value);
  if (decoded.kind === "invalid") return {
    state, nextDeadline: nextEewDeadline(state),
    decisions: [{ subject: "", operation: "normal", decision: "rejected", reason: "requiredStructureInvalid" }],
    intents: [], outcomes: [], diagnostics: [{ level: "WARN", component: "eew", reason: "requiredStructureInvalid", unit: "U-E" }],
  };
  // P3-NL-AC08 (1): started のまま残った pending は通知したか不明として外し、EventID の印の証拠を unknown にする。evidenceUnknownUntil
  // （10 分）は今のまま（保存の障害の例外で保存の前に鳴らした EEW の EventID を知らないことがある、P3-NL-AC04 (6)）。
  const restored = restoreStarted(decoded.state.intents);
  const base = { ...decoded.state, intents: restored.intents,
    notices: raiseNotices(decoded.state.notices, raisedBy(restored.started, () => "unknown")),
    persistence: restored.started.length === 0 ? state.persistence : dirty(state.persistence, clock.monotonicMs),
    evidenceUnknownUntil: Math.max(state.evidenceUnknownUntil ?? 0, clock.wallTimeMs + 600_000) };
  const applied = verified ? expire(base, clock) : { state: base, expired: [] };
  const active = verified ? applied.state.intents.filter((item) => item.expiresAt > clock.wallTimeMs) : applied.state.intents;
  const diagnostics: InternalStep["diagnostics"][number][] = applied.expired.length === 0 ? [] : [{ level: "INFO", component: "eew",
    reason: "notificationExpired", unit: "U-E", count: applied.expired.length }];
  if (restored.started.length !== 0) diagnostics.push({ level: "INFO", component: "eew", reason: "notificationOutcomeUnknown",
    unit: "U-E", count: restored.started.length });
  return {
    state: applied.state, nextDeadline: nextEewDeadline(applied.state), decisions: [], intents: active,
    outcomes: [{ kind: "recoveryApplied", scope: ["U-E"],
      coverage: active.map((item) => item.subject), subjects: active.map((item) => subject(item, "recovered")) }],
    diagnostics,
  };
}

function intentUpdate(state: EewUnitState,
  input: Extract<EewInput, { kind: "intentUpdate" }>): InternalStep {
  const updates = "id" in input.intentUpdate ? [input.intentUpdate] : input.intentUpdate;
  const originals = new Map(state.intents.map((item) => [item.id, item]));
  const changed = new Map<string, EewUnitState["intents"][number]>();
  let persistence = state.persistence;
  for (const update of updates) {
    const current = originals.get(update.id);
    const disposition = current != null && input.clock.wallTimeMs >= current.expiresAt ? "expired" as const : update.disposition;
    const updated = current == null ? null : applyIntentUpdate(current, { ...update, disposition });
    if (updated == null) continue;
    changed.set(updated.id, updated);
    persistence = dirty(persistence, input.clock.monotonicMs);
  }
  if (changed.size === 0) return {
    state, nextDeadline: nextEewDeadline(state), decisions: [], intents: [], outcomes: [], diagnostics: [],
  };
  const adopted = [...changed.values()];
  // P3-NL-AC05 (1): pending でなくなった intent は外し、結果は EventID の印（試行の開始と delivered で possible）に残す。
  const next: EewUnitState = { ...state,
    intents: state.intents.flatMap((item) => {
      const updated = changed.get(item.id);
      return updated == null ? [item] : updated.disposition === "pending" ? [updated] : [];
    }),
    notices: raiseNotices(state.notices, raisedBy(adopted, updateEvidence)),
    persistence,
  };
  return {
    state: next, nextDeadline: nextEewDeadline(next),
    decisions: adopted.map((item) => ({ subject: item.subject, operation: item.operation,
      decision: "changed", reason: null, change: "deliveryOnly", currentEstablished: null })),
    intents: adopted.filter((item) => item.disposition === "pending"),
    outcomes: adopted.map((item) => ({ kind: "accepted", change: "deliveryOnly", subjects: [subject(item, item.disposition)] })),
    diagnostics: [],
  };
}

function reduceCore(state: EewUnitState, input: EewInput,
  changed: (before: EewUnitState["current"][number] | null, after: EewUnitState["current"][number] | null) => void): InternalStep {
  if (input.kind === "receive") return reduceEewCore(state, input, changed);
  if (input.kind === "restore") return restore(state, input.persisted, input.clock, (input.basis ?? "verified") === "verified");
  if (input.kind === "intentUpdate") return intentUpdate(state, input);
  const verified = (input.basis ?? "verified") === "verified";
  const applied = verified ? expire(state, input.clock) : { state, expired: [] };
  // P3-LIFE-AC01: current・gate の期限は deadline 入力でだけ回収する（shutdown では延長も回収もしない）。P3-NL-AC04 (6): retainUntil を
  // 過ぎた印も期限の入力で外す。
  const lifetime = input.kind === "deadline" ? reclaimEewLifetime(applied.state, input.clock.wallTimeMs, changed)
    : { state: applied.state, expired: [] };
  const notices = input.kind === "deadline" && verified && lifetime.state.notices.some((item) => item.retainUntil <= input.clock.wallTimeMs)
    ? lifetime.state.notices.filter((item) => item.retainUntil > input.clock.wallTimeMs) : lifetime.state.notices;
  const reclaimed: EewUnitState = notices === lifetime.state.notices ? lifetime.state
    : { ...lifetime.state, notices, persistence: applied.state === state ? dirty(state.persistence, input.clock.monotonicMs) : lifetime.state.persistence };
  const subjects = [...applied.expired.map((item) => subject(item, "expired")), ...lifetime.expired.map(expiredOutcome)];
  return {
    state: reclaimed, nextDeadline: nextEewDeadline(reclaimed), decisions: [...applied.expired.map((item) => ({
      subject: item.subject, operation: item.operation, decision: "changed" as const,
      reason: null, change: "deliveryOnly" as const, currentEstablished: null,
    })), ...lifetime.expired.map((item) => ({
      subject: item.subject, operation: item.operation, decision: "changed" as const,
      reason: null, change: "semantic" as const, currentEstablished: null,
    }))],
    intents: [],
    outcomes: input.kind === "deadline"
      ? subjects.length === 0 ? [] : [{ kind: "deadlineApplied", subjects }]
      : [{ kind: "batchCompleted", reason: "shutdown", subjects }],
    diagnostics: applied.expired.length === 0 ? [] : [{ level: "INFO", component: "eew",
      reason: "notificationExpired", unit: "U-E", count: applied.expired.length }],
  };
}

function currentSubject(current: EewUnitState["current"][number]): SubjectOutcome {
  return {
    subject: current.subject, operation: current.operation,
    informationType: current.source.infoTypeRaw, transition: "active", severity: null,
    source: current.source,
    facts: { family: current.family, serial: current.serial,
      eventId: current.eventId, warningClass: current.warningClass,
      prediction: current.prediction, retainedPrediction: current.retainedPrediction },
    changedFields: [],
  };
}

function toEewView(state: EewUnitState): EewUnitView {
  const subjects: SubjectOutcome[] = state.current.map(currentSubject);
  return {
    unit: "U-E",
    semanticRevision: state.gates.map((gate) =>
      `${gate.subject}:${gate.serial}:${gate.terminal ? 1 : 0}:${gate.source.reportDateTimeRaw}`).join("|"),
    contentRevision: String(state.contentRevision),
    subjects,
    activeCount: state.current.length,
    current: state.current,
  };
}

const eewUnitCodec: EewUnitCodec = {
  schemaVersion: SCHEMA, discardableSchemaVersions: ["p2-eew-unit-v1", "p2-eew-unit-v2", "p2-eew-unit-v3"], maxEnvelopeBytes: GENERATION_BYTES, // P3-VM-AC05・AC06（修正波 3）: 前の版の保存は初期化する
  encode(state) {
    const value: PersistedEewUnit = { schemaVersion: SCHEMA, intents: state.intents, notices: state.notices };
    if (persisted(value) == null) throw new Error("U-E checkpoint exceeds its persisted boundary");
    return value;
  },
  // P3-NL-AC04 (6): latch は印として保存したものを戻す（復元で作り直さない）。current・gate は保存しない。
  decode(payload) {
    const value = persisted(payload);
    if (value == null) return { kind: "invalid", reason: "invalid p2-eew-unit-v4 payload" };
    return { kind: "restored", state: { schemaVersion: SCHEMA, contentRevision: 0, current: [], gates: [], intents: value.intents,
      notices: value.notices, persistence: cleanPersistence() } };
  },
};

function reduceEewUnit(state: EewUnitState, input: EewInput): EewUnitStep {
  const displayChanges: EewUnitStep["displayChanges"][number][] = [];
  const subject = (item: EewUnitState["current"][number]): RuntimeDisplaySubject => ({
    unit: "U-E", operation: item.operation, subject: item.subject, office: null,
    current: item, subjects: [currentSubject(item)],
  });
  const step = reduceCore(state, input, (before, after) => {
    if (before == null && after == null) return;
    displayChanges.push({ unit: "U-E", operation: (after ?? before)!.operation,
      subject: (after ?? before)!.subject, before: before == null ? null : subject(before),
      after: after == null ? null : subject(after) });
  });
  if (displayChanges.length !== 0) {
    if (!Number.isSafeInteger(state.contentRevision + 1)) throw new RangeError("U-E content revision exhausted");
  }
  // 容量の拒否は新しい subject だけに起き印を持たないので、unit/operation の未確認へ寄せる（P3-CC-AC02、Q-CC-UE）。
  const confirmationEvidence: EewUnitStep["confirmationEvidence"] = input.kind === "receive"
    ? step.decisions.flatMap<EewUnitStep["confirmationEvidence"][number]>((item) => item.decision === "changed" && item.currentEstablished != null
      ? [{ source: "acceptedReport", scopes: [{ unit: "U-E", operation: item.operation, kind: "event", eventId: item.subject.split("/")[2] }] }]
      : item.decision === "capacityExceeded" ? [{ source: "capacityExceeded", scopes: [{ unit: "U-E", operation: item.operation, kind: "unit" }] }]
        : []) : [];
  return { ...step, state: displayChanges.length !== 0
    ? { ...step.state, contentRevision: state.contentRevision + 1 } : step.state,
    displayChanges, confirmationEvidence };
}

function reduceEew(state: EewUnitState, input: Extract<EewInput, { kind: "receive" }>): EewUnitStep {
  return reduceEewUnit(state, input);
}

// P3-UNIT-TABLE-001: this unit's row; each field is one former unit branch of shared-runtime.ts.
const eewUnit = {
  unit: "U-E",
  reduce: reduceEewUnit,
  toView: toEewView,
  persistence: { kind: "durable", codec: eewUnitCodec },
  confirmationScopeLimit: 1024,
  reclaimDeadlineBeforeReceive: true,
} satisfies UnitModule<"U-E">;

export { currentSubject, eewUnit, eewUnitCodec, reduceEew, reduceEewUnit, toEewView };
