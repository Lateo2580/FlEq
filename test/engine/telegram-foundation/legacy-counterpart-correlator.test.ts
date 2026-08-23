import { beforeEach, describe, expect, it } from "vitest";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import type {
  LegacyCounterpartOutcome,
  ProcessOutcome,
  RawOutcome,
} from "../../../src/engine/presentation/types";
import type {
  LegacyCounterpartSourceType,
  TelegramMeta,
  WsDataMessage,
} from "../../../src/types";
import {
  LegacyCounterpartCorrelator,
  type LegacyCounterpartAction,
  type LegacyCounterpartCorrelatorFactory,
  type LegacyCounterpartLifecycleEvent,
  type LegacyCounterpartTimerScheduler,
} from "../../../src/engine/messages/legacy-counterpart-correlator";
import { processBriefing } from "../../../src/engine/presentation/processors/process-briefing";
import { processLegacyCounterpart } from "../../../src/engine/presentation/processors/process-legacy-counterpart";
import {
  LEGACY_CORRELATION_RETENTION_MS,
  LEGACY_CORRELATION_WINDOW_AFTER_MS,
  LEGACY_CORRELATION_WINDOW_BEFORE_MS,
  LEGACY_SOURCE_HOLDBACK_MS,
  PRODUCTION_LEGACY_COUNTERPART_REGISTRY,
  createLegacyCounterpartRegistry,
  type LegacyCounterpartCorrelationKey,
  type LegacyCounterpartEventIdNormalizationInput,
  type LegacyCounterpartRegistry,
  type LegacyCounterpartRule,
} from "../../../src/engine/messages/legacy-counterpart-registry";
import {
  createMockWsDataMessage,
  FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757,
  FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633,
  FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717,
  FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727,
  FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757,
  FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633,
  FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717,
  FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727,
} from "../../helpers/mock-message";

const BASE_MS = Date.parse("2026-08-11T00:00:00.000Z");
const KEYS = new Map<string, LegacyCounterpartCorrelationKey | null>();
const VPOA50_EVENT_ID = "JPTK202608221709_202608221709";
const VPBS50_EVENT_ID = `K${VPOA50_EVENT_ID}`;

class FakeRuntime implements LegacyCounterpartTimerScheduler {
  now = BASE_MS;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueMs: number; callback: () => void }>();

  readonly clock = { nowMs: (): number => this.now };

  set(delayMs: number, callback: () => void): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { dueMs: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  clear(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }

  moveTo(nowMs: number, runCallbacks = true): void {
    this.now = nowMs;
    if (runCallbacks) this.runDue();
  }

  advanceBy(deltaMs: number, runCallbacks = true): void {
    this.moveTo(this.now + deltaMs, runCallbacks);
  }

  runDue(reverse = false): void {
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.dueMs <= this.now)
        .sort((a, b) => a[1].dueMs - b[1].dueMs || a[0] - b[0]);
      if (due.length === 0) return;
      const [id, task] = reverse ? due[due.length - 1] : due[0];
      this.tasks.delete(id);
      task.callback();
    }
  }

  pendingCount(): number {
    return this.tasks.size;
  }
}

function correlationKey(overrides: Partial<LegacyCounterpartCorrelationKey> = {}): LegacyCounterpartCorrelationKey {
  return {
    officeCode: "OFFICE-01",
    areaCodes: ["AREA-01"],
    phenomenonCodes: ["PHENOM-01"],
    kindCodes: ["KIND-01"],
    targetTimeMs: BASE_MS,
    ...overrides,
  };
}

function syntheticRule(
  sourceType: LegacyCounterpartSourceType = "VPOA50",
  counterpartTypes: readonly string[] = ["SYNTH-CP"],
): LegacyCounterpartRule {
  return {
    sourceType,
    status: "confirmed",
    counterpartTypes,
    extractEventKey: (meta) => KEYS.get(meta.messageId) ?? null,
    windowBeforeMs: LEGACY_CORRELATION_WINDOW_BEFORE_MS,
    windowAfterMs: LEGACY_CORRELATION_WINDOW_AFTER_MS,
    holdbackMs: LEGACY_SOURCE_HOLDBACK_MS,
  };
}

function registryOf(...rules: LegacyCounterpartRule[]): LegacyCounterpartRegistry {
  return createLegacyCounterpartRegistry(rules);
}

function makeMeta(options: {
  messageId: string;
  type: string;
  eventId?: string | null;
  reportOffsetMs?: number;
  serial?: string | null;
  infoType?: "発表" | "訂正" | "取消";
}): TelegramMeta {
  const reportMs = BASE_MS + (options.reportOffsetMs ?? 0);
  return createTelegramMeta({
    messageId: options.messageId,
    eventId: options.eventId === undefined ? "EVENT-1" : options.eventId,
    type: options.type,
    reportDateTime: new Date(reportMs).toISOString(),
    serial: options.serial === undefined ? "1" : options.serial,
    infoType: options.infoType ?? "発表",
    receivedAtMs: Math.max(BASE_MS, reportMs),
    status: "通常",
    isTest: false,
  });
}

function makeMessage(meta: TelegramMeta): WsDataMessage {
  return {
    type: "data",
    version: "2.0",
    classification: "synthetic",
    id: meta.messageId,
    passing: [],
    head: {
      type: meta.type.value ?? "UNKNOWN",
      author: "synthetic",
      time: new Date(meta.receivedAtMs).toISOString(),
      test: false,
    },
    format: "xml",
    compression: null,
    encoding: "utf-8",
    body: "",
    meta,
  };
}

function makeSource(options: {
  id?: string;
  type?: LegacyCounterpartSourceType;
  eventId?: string | null;
  reportOffsetMs?: number;
  serial?: string | null;
  infoType?: "発表" | "訂正" | "取消";
  key?: LegacyCounterpartCorrelationKey | null;
  title?: string;
} = {}): LegacyCounterpartOutcome {
  const type = options.type ?? "VPOA50";
  const id = options.id ?? `source-${type}-${KEYS.size + 1}`;
  const meta = makeMeta({
    messageId: id,
    type,
    eventId: options.eventId,
    reportOffsetMs: options.reportOffsetMs,
    serial: options.serial,
    infoType: options.infoType,
  });
  KEYS.set(id, options.key === undefined ? correlationKey() : options.key);
  return {
    domain: "legacyCounterpart",
    msg: makeMessage(meta),
    headType: type,
    statsCategory: "other",
    parsed: {
      type,
      infoType: options.infoType ?? "発表",
      title: options.title ?? id,
      controlTitle: "synthetic",
      reportDateTime: meta.reportDateTime.raw ?? "",
      headline: null,
      publishingOffice: "synthetic",
      editorialOffice: "synthetic",
      eventId: meta.eventId.value,
      serial: meta.serial.raw,
      areas: [],
      phenomena: [],
      kinds: [],
      severityEvidence: [],
      meta,
      isTest: false,
    },
    reason: "counterpartRuleUnconfirmed",
    severity: "unknown",
    stats: { shouldRecord: true, eventId: meta.eventId.value },
    presentation: { frameLevel: "info" },
  };
}

function makeCounterpart(options: {
  id?: string;
  type?: string;
  eventId?: string | null;
  reportOffsetMs?: number;
  serial?: string | null;
  infoType?: "発表" | "訂正" | "取消";
  key?: LegacyCounterpartCorrelationKey | null;
} = {}): RawOutcome {
  const type = options.type ?? "SYNTH-CP";
  const id = options.id ?? `counterpart-${type}-${KEYS.size + 1}`;
  const meta = makeMeta({
    messageId: id,
    type,
    eventId: options.eventId,
    reportOffsetMs: options.reportOffsetMs,
    serial: options.serial,
    infoType: options.infoType,
  });
  KEYS.set(id, options.key === undefined ? correlationKey() : options.key);
  return {
    domain: "raw",
    msg: makeMessage(meta),
    headType: type,
    statsCategory: "other",
    parsed: null,
    stats: { shouldRecord: true, eventId: meta.eventId.value },
    presentation: { frameLevel: "info" },
  };
}

function harness(options: {
  registry?: LegacyCounterpartRegistry;
  sourceCapacity?: number;
  counterpartCapacity?: number;
  tombstoneCapacity?: number;
} = {}) {
  const runtime = new FakeRuntime();
  const actions: LegacyCounterpartAction[] = [];
  const events: LegacyCounterpartLifecycleEvent[] = [];
  const correlator = new LegacyCounterpartCorrelator({
    registry: options.registry ?? registryOf(syntheticRule()),
    clock: runtime.clock,
    timerScheduler: runtime,
    sourceCapacity: options.sourceCapacity,
    counterpartCapacity: options.counterpartCapacity,
    tombstoneCapacity: options.tombstoneCapacity,
    onAction: (action) => actions.push(action),
    onLifecycleEvent: (event) => events.push(event),
  });
  return { runtime, actions, events, correlator };
}

function kinds(actions: readonly LegacyCounterpartAction[]): string[] {
  return actions.map((action) => action.kind);
}

describe("Phase 6B unit 2: legacy counterpart registry", () => {
  beforeEach(() => KEYS.clear());

  it("production はVPOA50→VPBS50だけconfirmedにし、他二typeをunconfirmedのまま残す", () => {
    expect(PRODUCTION_LEGACY_COUNTERPART_REGISTRY.rules.map((rule) => ({
      sourceType: rule.sourceType,
      status: rule.status,
      counterpartTypes: rule.counterpartTypes,
      key: rule.extractEventKey(makeMeta({ messageId: rule.sourceType, type: rule.sourceType }), null),
    }))).toEqual([
      { sourceType: "VPOA50", status: "confirmed", counterpartTypes: ["VPBS50"], key: null },
      { sourceType: "VPNO50", status: "unconfirmed", counterpartTypes: [], key: null },
      { sourceType: "VXWW50", status: "unconfirmed", counterpartTypes: [], key: null },
    ]);
    const vpoa = PRODUCTION_LEGACY_COUNTERPART_REGISTRY.ruleBySourceType.get("VPOA50");
    expect(vpoa?.eligibleInfoTypes).toEqual(["発表"]);
    expect(vpoa?.normalizeEventId?.({
      side: "source",
      headType: "VPOA50",
      eventId: "JPTK202608221709_202608221709",
      rawEventId: "JPTK202608221709_202608221709",
    })).toBe("JPTK202608221709_202608221709");
    expect(vpoa?.normalizeEventId?.({
      side: "counterpart",
      headType: "VPBS50",
      eventId: "KJPTK202608221709_202608221709",
      rawEventId: "KJPTK202608221709_202608221709",
    })).toBe("JPTK202608221709_202608221709");
    expect([...PRODUCTION_LEGACY_COUNTERPART_REGISTRY.activeCounterpartTypes]).toEqual(["VPBS50"]);
  });

  it("confirmed counterpart type の source rule 間重複を構築時に拒否する", () => {
    expect(() => registryOf(
      syntheticRule("VPOA50", ["SYNTH-CP"]),
      syntheticRule("VPNO50", ["SYNTH-CP"]),
    )).toThrow(/owned by both VPOA50 and VPNO50/);
  });
});

describe("Phase 6B unit 3: pure legacy counterpart correlator", () => {
  it("actionとlifecycle eventに注入clockの決定時刻を載せる", () => {
    const { runtime, actions, events, correlator } = harness();
    const hold = correlator.accept(makeSource({ id: "decision-time-source", eventId: "TIME" }));
    expect(hold).toMatchObject({ kind: "holdSource", decidedAtMs: BASE_MS });
    expect(events).toMatchObject([{ kind: "legacySourceArrivedFirst", decidedAtMs: BASE_MS }]);

    runtime.advanceBy(60_001);
    expect(actions).toMatchObject([{
      kind: "releaseSource",
      decidedAtMs: BASE_MS + 60_001,
    }]);
  });

  beforeEach(() => KEYS.clear());

  it("production VPOA50 source は60秒 holdし、60,000msは保持・60,001msでreleaseする", () => {
    const { correlator, runtime, actions } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    expect(correlator.accept(makeSource({ key: null }))).toMatchObject({ kind: "holdSource" });
    runtime.advanceBy(60_000);
    expect(actions).toEqual([]);
    runtime.advanceBy(1);
    expect(actions).toMatchObject([{ kind: "releaseSource", reason: "timeout" }]);
  });

  it.each([59_999, 60_000])("source先着 + %dms のcounterpartはHoldback内で抑止する", (arrivalMs) => {
    const { correlator, runtime, actions } = harness();
    expect(correlator.accept(makeSource())).toMatchObject({ kind: "holdSource" });
    runtime.advanceBy(arrivalMs);
    const action = correlator.accept(makeCounterpart());
    expect(action).toMatchObject({ kind: "suppressSource" });
    runtime.advanceBy(2);
    expect(actions).toEqual([]);
  });

  it("60,001msではtimeout release後のlate reconcileになる", () => {
    const { correlator, runtime, actions } = harness();
    correlator.accept(makeSource());
    runtime.advanceBy(60_001);
    expect(kinds(actions)).toEqual(["releaseSource"]);
    expect(correlator.accept(makeCounterpart())).toMatchObject({ kind: "reconcileLateCounterpart" });
  });

  it.each(["callback-first", "input-first"] as const)("60,000ms同時刻競合は%sでもcounterpartが先勝ちする", (order) => {
    const { correlator, runtime, actions } = harness();
    correlator.accept(makeSource());
    runtime.advanceBy(60_000, false);
    if (order === "callback-first") runtime.runDue();
    const action = correlator.accept(makeCounterpart());
    if (order === "input-first") runtime.runDue(true);
    expect(action).toMatchObject({ kind: "suppressSource" });
    expect(actions).toEqual([]);
  });

  it.each([
    [-300_000, "suppressSource"],
    [300_000, "suppressSource"],
    [-300_001, "holdSource"],
    [300_001, "holdSource"],
  ] as const)("ReportDateTime差 %dms のinclusive窓を固定する", (sourceOffset, expectedKind) => {
    const { correlator } = harness();
    correlator.accept(makeCounterpart({ reportOffsetMs: 0 }));
    expect(correlator.accept(makeSource({ reportOffsetMs: sourceOffset }))).toMatchObject({ kind: expectedKind });
  });

  it("normalizeEventId 未指定時はraw EventID比較を維持し、不一致だけcode fallbackせず片側欠落時だけcode一致へfallbackする", () => {
    const same = harness();
    same.correlator.accept(makeCounterpart({ id: "same-cp", eventId: "E1", key: correlationKey({ areaCodes: ["OTHER"] }) }));
    expect(same.correlator.accept(makeSource({ id: "same-src", eventId: "E1" }))).toMatchObject({ kind: "suppressSource" });

    KEYS.clear();
    const mismatch = harness();
    mismatch.correlator.accept(makeCounterpart({ id: "mismatch-cp", eventId: "E2" }));
    expect(mismatch.correlator.accept(makeSource({ id: "mismatch-src", eventId: "E1" }))).toMatchObject({ kind: "holdSource" });

    KEYS.clear();
    const fallback = harness();
    fallback.correlator.accept(makeCounterpart({ id: "fallback-cp", eventId: null }));
    expect(fallback.correlator.accept(makeSource({ id: "fallback-src", eventId: "E1" }))).toMatchObject({ kind: "suppressSource" });
  });

  it.each([
    ["source hook throw", (input: LegacyCounterpartEventIdNormalizationInput) => {
      if (input.side === "source") throw new Error("source hook failure");
      return input.eventId;
    }],
    ["counterpart hook throw", (input: LegacyCounterpartEventIdNormalizationInput) => {
      if (input.side === "counterpart") throw new Error("counterpart hook failure");
      return input.eventId;
    }],
    ["source hook empty", (input: LegacyCounterpartEventIdNormalizationInput) =>
      input.side === "source" ? "" : input.eventId],
    ["counterpart hook empty", (input: LegacyCounterpartEventIdNormalizationInput) =>
      input.side === "counterpart" ? "" : input.eventId],
    ["source hook blank", (input: LegacyCounterpartEventIdNormalizationInput) =>
      input.side === "source" ? "   " : input.eventId],
    ["counterpart hook blank", (input: LegacyCounterpartEventIdNormalizationInput) =>
      input.side === "counterpart" ? "   " : input.eventId],
  ] as const)("両raw EventIDがある %s はcode fallbackせずfail-openする", (_label, normalizeEventId) => {
    const rule: LegacyCounterpartRule = { ...syntheticRule(), normalizeEventId };
    const { correlator } = harness({ registry: registryOf(rule) });
    correlator.accept(makeCounterpart({ id: "normalization-counterpart", eventId: "E1" }));
    expect(correlator.accept(makeSource({ id: "normalization-source", eventId: "E1" }))).toMatchObject({
      kind: "holdSource",
    });
    expect(correlator.snapshot()).toMatchObject({ sourceCount: 1, counterpartCount: 1 });
  });

  it.each([
    [-300_000, "suppressSource"],
    [300_000, "suppressSource"],
    [-300_001, "holdSource"],
    [300_001, "holdSource"],
  ] as const)("production VPOA50→VPBS50 はReportDateTime差 %dms の±5分inclusive窓だけで相関する", (sourceOffset, expectedKind) => {
    const { correlator } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    correlator.accept(makeCounterpart({
      type: "VPBS50",
      eventId: VPBS50_EVENT_ID,
      reportOffsetMs: 0,
      key: null,
    }));
    expect(correlator.accept(makeSource({
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      reportOffsetMs: sourceOffset,
      key: null,
    }))).toMatchObject({ kind: expectedKind });
  });

  it.each([
    ["余分なK", `K${VPBS50_EVENT_ID}`],
    ["小文字prefix", `k${VPOA50_EVENT_ID}`],
    ["小文字canonical", "KJPtk202608221709_202608221709"],
    ["桁不足", "KJPTK202608221709_20260822170"],
    ["正規化後不一致", "KJPDE202608201757_202608201757"],
  ] as const)("production VPBS50 EventIDの%sはstrict normalizerでnon-matchにする", (_label, counterpartEventId) => {
    const { correlator } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    correlator.accept(makeCounterpart({
      type: "VPBS50",
      eventId: counterpartEventId,
      key: correlationKey(),
    }));
    expect(correlator.accept(makeSource({
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      key: correlationKey(),
    }))).toMatchObject({ kind: "holdSource" });
  });

  it.each([
    ["source", null, VPBS50_EVENT_ID],
    ["counterpart", VPOA50_EVENT_ID, null],
  ] as const)("production %s側のEventID欠落は未確認code fallbackへ降りずnon-matchにする", (_side, sourceEventId, counterpartEventId) => {
    const { correlator } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    correlator.accept(makeCounterpart({ type: "VPBS50", eventId: counterpartEventId, key: correlationKey() }));
    expect(correlator.accept(makeSource({ type: "VPOA50", eventId: sourceEventId, key: correlationKey() }))).toMatchObject({
      kind: "holdSource",
    });
  });

  it.each(["訂正", "取消"] as const)("production pair の%sはadmission前にfail-openしcacheを変えない", (infoType) => {
    const { correlator } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    correlator.accept(makeCounterpart({ type: "VPBS50", eventId: VPBS50_EVENT_ID, key: null }));
    const before = correlator.snapshot();
    expect(correlator.accept(makeSource({
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      infoType,
      key: null,
    }))).toMatchObject({ kind: "releaseSource", reason: "releasedUpdate" });
    expect(correlator.accept(makeCounterpart({
      type: "VPBS50",
      eventId: VPBS50_EVENT_ID,
      infoType,
      key: null,
    }))).toMatchObject({ kind: "emitNow", reason: "counterpart" });
    expect(correlator.snapshot()).toEqual(before);
  });

  it.each(["訂正", "取消"] as const)("pending VPOA50 発表は%s到着でtimerごと静かに失効しdeadline後に旧payloadをreleaseしない", (infoType) => {
    const { correlator, runtime, actions } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    const published = makeSource({
      id: `pending-published-${infoType}`,
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      serial: "1",
      key: null,
    });
    expect(correlator.accept(published)).toMatchObject({ kind: "holdSource" });
    expect(runtime.pendingCount()).toBe(2);

    const update = makeSource({
      id: `pending-update-${infoType}`,
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      serial: "2",
      infoType,
      key: null,
    });
    expect(correlator.accept(update)).toMatchObject({
      kind: "releaseSource",
      displayLifecycleOnly: true,
      outcome: { parsed: { infoType: "発表" } },
      triggerOutcome: { parsed: { infoType } },
    });
    expect(correlator.snapshot()).toMatchObject({ sourceCount: 0, counterpartCount: 0, tombstoneCount: 0 });
    expect(runtime.pendingCount()).toBe(0);
    runtime.advanceBy(60_001);
    expect(actions).toEqual([]);
  });

  it("60,001ms後のVPOA50訂正は既にreleaseした発表を失効させず自身だけfail-openする", () => {
    const { correlator, runtime, actions } = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    correlator.accept(makeSource({ type: "VPOA50", eventId: VPOA50_EVENT_ID, serial: "1", key: null }));
    runtime.advanceBy(60_001);
    expect(actions).toMatchObject([{ kind: "releaseSource", reason: "timeout", outcome: { parsed: { infoType: "発表" } } }]);
    expect(correlator.accept(makeSource({
      type: "VPOA50",
      eventId: VPOA50_EVENT_ID,
      serial: "2",
      infoType: "訂正",
      key: null,
    }))).toMatchObject({
      kind: "releaseSource",
      reason: "releasedUpdate",
      outcome: { parsed: { infoType: "訂正" } },
    });
  });

  it("code不一致・地名だけ相当のcode欠落・対象時刻欠落・blank-only codeは一致させない", () => {
    const mismatch = harness();
    mismatch.correlator.accept(makeCounterpart({ eventId: null, key: correlationKey({ areaCodes: ["AREA-X"] }) }));
    expect(mismatch.correlator.accept(makeSource({ eventId: null }))).toMatchObject({ kind: "holdSource" });

    KEYS.clear();
    const namesOnly = harness();
    namesOnly.correlator.accept(makeCounterpart({ eventId: null, key: correlationKey({ areaCodes: [] }) }));
    expect(namesOnly.correlator.accept(makeSource({ eventId: null, key: correlationKey({ areaCodes: [] }) }))).toMatchObject({ kind: "holdSource" });

    KEYS.clear();
    const missingTargetTime = harness();
    missingTargetTime.correlator.accept(makeCounterpart({
      eventId: null,
      key: correlationKey({ targetTimeMs: null }),
    }));
    expect(missingTargetTime.correlator.accept(makeSource({ eventId: null }))).toMatchObject({ kind: "holdSource" });

    KEYS.clear();
    const nonFiniteTargetTime = harness();
    nonFiniteTargetTime.correlator.accept(makeCounterpart({
      eventId: null,
      key: correlationKey({ targetTimeMs: Number.NaN }),
    }));
    expect(nonFiniteTargetTime.correlator.accept(makeSource({ eventId: null }))).toMatchObject({ kind: "holdSource" });

    KEYS.clear();
    const blankOnly = harness();
    const blankOnlyKey = correlationKey({
      areaCodes: ["", "  "],
      phenomenonCodes: [" "],
      kindCodes: [""],
    });
    blankOnly.correlator.accept(makeCounterpart({ eventId: null, key: blankOnlyKey }));
    expect(blankOnly.correlator.accept(makeSource({ eventId: null, key: blankOnlyKey }))).toMatchObject({ kind: "holdSource" });
  });

  it("EventIDなし・同一code・別messageIdのsourceを別lifecycleとして各60秒保持する", () => {
    const { correlator, runtime, actions, events } = harness();
    expect(correlator.accept(makeSource({ id: "transient-source-1", eventId: null }))).toMatchObject({
      kind: "holdSource",
      sourceIdentity: "VPOA50:message:transient-source-1",
    });
    expect(correlator.accept(makeSource({ id: "transient-source-2", eventId: null }))).toMatchObject({
      kind: "holdSource",
      sourceIdentity: "VPOA50:message:transient-source-2",
    });
    expect(correlator.snapshot().sourceCount).toBe(2);
    expect(events.filter((event) => event.kind === "legacySourceArrivedFirst")).toHaveLength(2);

    runtime.advanceBy(60_000);
    expect(actions).toEqual([]);
    runtime.advanceBy(1);
    expect(actions).toMatchObject([
      { kind: "releaseSource", sourceIdentity: "VPOA50:message:transient-source-1", reason: "timeout" },
      { kind: "releaseSource", sourceIdentity: "VPOA50:message:transient-source-2", reason: "timeout" },
    ]);
  });

  it("候補複数はnearestを選ばずambiguousにする", () => {
    const { correlator } = harness({ registry: registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2"])) });
    correlator.accept(makeCounterpart({ type: "SYNTH-CP", id: "cp-1" }));
    correlator.accept(makeCounterpart({ type: "SYNTH-CP-2", id: "cp-2" }));
    expect(correlator.accept(makeSource())).toMatchObject({ kind: "ambiguousSource", candidateCount: 2 });
  });

  it.each(["forward", "reverse"] as const)("EventIDが異なる複数sourceへcode一致するcounterpartは%s順でも全件ambiguousにする", (order) => {
    const { correlator } = harness();
    const sources = [
      makeSource({ id: `${order}-source-1`, eventId: "SOURCE-E1" }),
      makeSource({ id: `${order}-source-2`, eventId: "SOURCE-E2" }),
    ];
    for (const source of order === "forward" ? sources : [...sources].reverse()) {
      correlator.accept(source);
    }
    const action = correlator.accept(makeCounterpart({ id: `${order}-counterpart`, eventId: null }));
    expect(action).toMatchObject({
      kind: "ambiguousSource",
      ambiguityReason: "multipleSources",
      affectedSources: [{}, {}],
    });
    expect(Object.values(correlator.snapshot().sourceStatuses)).toEqual(["ambiguous", "ambiguous"]);
  });

  it("複数source一致counterpartの取消は全affected sourceを一括再計算して復帰する", () => {
    const { correlator } = harness();
    correlator.accept(makeSource({ id: "multi-source-1", eventId: "SOURCE-E1" }));
    correlator.accept(makeSource({ id: "multi-source-2", eventId: "SOURCE-E2" }));
    correlator.accept(makeCounterpart({ id: "multi-counterpart", eventId: null }));
    const action = correlator.accept(makeCounterpart({
      id: "multi-counterpart-cancel",
      eventId: null,
      infoType: "取消",
      serial: "2",
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }));
    expect(action).toMatchObject({
      kind: "releaseSource",
      affectedSources: [{}, {}],
    });
    expect(Object.values(correlator.snapshot().sourceStatuses)).toEqual([
      "released-unmatched",
      "released-unmatched",
    ]);
  });

  it("timeout済み複数sourceへ一致するlate counterpartも全件ambiguousとし先頭だけreconcileしない", () => {
    const { correlator, runtime } = harness();
    correlator.accept(makeSource({ id: "released-source-1", eventId: "SOURCE-E1" }));
    correlator.accept(makeSource({ id: "released-source-2", eventId: "SOURCE-E2" }));
    runtime.advanceBy(60_001);
    const action = correlator.accept(makeCounterpart({ id: "late-multi-counterpart", eventId: null }));
    expect(action).toMatchObject({
      kind: "ambiguousSource",
      ambiguityReason: "multipleSources",
      affectedSources: [{}, {}],
    });
    expect(Object.values(correlator.snapshot().sourceStatuses)).toEqual(["ambiguous", "ambiguous"]);
  });

  it.each([
    [659_999, "reconcileLateCounterpart"],
    [660_000, "reconcileLateCounterpart"],
    [660_001, "emitNow"],
  ] as const)("source受信+%dmsのlate counterpart境界を固定する", (arrivalMs, expectedKind) => {
    const { correlator, runtime, events } = harness();
    correlator.accept(makeSource());
    runtime.advanceBy(60_001);
    runtime.moveTo(BASE_MS + arrivalMs);
    expect(correlator.accept(makeCounterpart())).toMatchObject({ kind: expectedKind });
    expect(events.filter((event) => event.kind === "legacyCorrelationExpired")).toHaveLength(arrivalMs > 660_000 ? 1 : 0);
  });

  it.each([
    [659_999, "suppressSource"],
    [660_000, "suppressSource"],
    [660_001, "holdSource"],
  ] as const)("counterpart先着+%dmsのTTL境界を固定する", (arrivalMs, expectedKind) => {
    const { correlator, runtime } = harness();
    correlator.accept(makeCounterpart());
    runtime.advanceBy(arrivalMs);
    expect(correlator.accept(makeSource())).toMatchObject({ kind: expectedKind });
  });

  it("counterpart先着TTLをsource到着時にsource+11分へ固定し直す", () => {
    const { correlator, runtime } = harness();
    correlator.accept(makeCounterpart());
    runtime.advanceBy(600_000);
    expect(correlator.accept(makeSource())).toMatchObject({ kind: "suppressSource" });
    runtime.moveTo(BASE_MS + 660_001);
    expect(correlator.snapshot().counterpartCount).toBe(1);
    runtime.moveTo(BASE_MS + 1_260_001);
    expect(correlator.snapshot().counterpartCount).toBe(0);
  });

  it("pending訂正・取消・newerはpayloadをin-place置換し、最初のdeadlineを保つ", () => {
    const { correlator, runtime, actions } = harness();
    correlator.accept(makeSource({ id: "s1", eventId: "E1", title: "first", serial: "1" }));
    runtime.advanceBy(30_000);
    expect(correlator.accept(makeSource({ id: "s2", eventId: "E1", title: "correction", serial: "1", infoType: "訂正" }))).toMatchObject({ kind: "holdSource", deadlineMs: BASE_MS + 60_000 });
    expect(correlator.accept(makeSource({ id: "s3", eventId: "E1", title: "cancel", serial: "2", infoType: "取消" }))).toMatchObject({ kind: "holdSource", deadlineMs: BASE_MS + 60_000 });
    expect(correlator.accept(makeSource({ id: "s4", eventId: "E1", title: "newer", serial: "3" }))).toMatchObject({ kind: "holdSource", deadlineMs: BASE_MS + 60_000 });
    runtime.moveTo(BASE_MS + 60_001);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "releaseSource", outcome: { parsed: { title: "newer" } } });
  });

  it("released後の訂正・取消・newerは再Holdbackせず即時fail-open更新する", () => {
    const { correlator, runtime } = harness();
    correlator.accept(makeSource({ id: "s1", eventId: "E1" }));
    runtime.advanceBy(60_001);
    for (const [id, infoType, serial] of [
      ["s2", "訂正", "1"],
      ["s3", "取消", "2"],
      ["s4", "発表", "3"],
    ] as const) {
      expect(correlator.accept(makeSource({ id, eventId: "E1", infoType, serial }))).toMatchObject({
        kind: "releaseSource",
        reason: "releasedUpdate",
      });
    }
  });

  it.each(["訂正", "取消"] as const)("source %s は対象counterpart revision一致時だけ相関する", (infoType) => {
    const matched = harness();
    matched.correlator.accept(makeCounterpart({ id: `matched-cp-${infoType}`, eventId: "E1", serial: "1" }));
    expect(matched.correlator.accept(makeSource({
      id: `matched-source-${infoType}`,
      eventId: "E1",
      infoType,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }))).toMatchObject({ kind: "suppressSource" });

    KEYS.clear();
    const mismatch = harness();
    mismatch.correlator.accept(makeCounterpart({ id: `mismatch-cp-${infoType}`, eventId: "E1", serial: "1" }));
    expect(mismatch.correlator.accept(makeSource({
      id: `mismatch-source-${infoType}`,
      eventId: "E1",
      infoType,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 99 } }),
    }))).toMatchObject({ kind: "holdSource" });
    expect(mismatch.events.filter((event) => event.kind.endsWith("Mismatch"))).toMatchObject([{
      kind: infoType === "訂正" ? "legacyCorrectionMismatch" : "legacyCancellationMismatch",
    }]);
  });

  it("counterpart取消後のcandidate 0件でsourceを復帰する", () => {
    const { correlator } = harness();
    const cp = makeCounterpart({ id: "cp", serial: "1" });
    correlator.accept(cp);
    expect(correlator.accept(makeSource())).toMatchObject({ kind: "suppressSource" });
    const targetRevision = { reportDateTimeMs: cp.msg.meta?.reportDateTime.epochMs ?? -1, serial: 1 };
    expect(correlator.accept(makeCounterpart({ id: "cp-cancel", serial: "2", infoType: "取消", key: correlationKey({ targetRevision }) }))).toMatchObject({
      kind: "releaseSource",
      reason: "counterpartCancelled",
    });
  });

  it("counterpart取消後のcandidate 1件は抑止継続、複数件はambiguousを維持する", () => {
    const registry = registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2", "SYNTH-CP-3"]));
    const one = harness({ registry });
    const cp1 = makeCounterpart({ id: "one-cp1", type: "SYNTH-CP" });
    one.correlator.accept(cp1);
    one.correlator.accept(makeCounterpart({ id: "one-cp2", type: "SYNTH-CP-2" }));
    one.correlator.accept(makeSource({ id: "one-source" }));
    expect(one.correlator.accept(makeCounterpart({
      id: "one-cancel",
      type: "SYNTH-CP",
      infoType: "取消",
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }))).toMatchObject({ kind: "suppressSource" });

    KEYS.clear();
    const many = harness({ registry });
    many.correlator.accept(makeCounterpart({ id: "many-cp1", type: "SYNTH-CP" }));
    many.correlator.accept(makeCounterpart({ id: "many-cp2", type: "SYNTH-CP-2" }));
    many.correlator.accept(makeCounterpart({ id: "many-cp3", type: "SYNTH-CP-3" }));
    many.correlator.accept(makeSource({ id: "many-source" }));
    expect(many.correlator.accept(makeCounterpart({
      id: "many-cancel",
      type: "SYNTH-CP",
      infoType: "取消",
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }))).toMatchObject({ kind: "ambiguousSource", candidateCount: 2 });
  });

  it("共有counterpart取消はsourceごとのcandidate再計算結果を混在batchで返す", () => {
    const { correlator } = harness({
      registry: registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2"])),
    });
    correlator.accept(makeCounterpart({ id: "shared", type: "SYNTH-CP", eventId: null }));
    correlator.accept(makeCounterpart({ id: "specific-e1", type: "SYNTH-CP-2", eventId: "E1" }));
    correlator.accept(makeSource({ id: "source-e1", eventId: "E1" }));
    correlator.accept(makeSource({ id: "source-e2", eventId: "E2" }));

    const action = correlator.accept(makeCounterpart({
      id: "cancel-shared",
      type: "SYNTH-CP",
      eventId: null,
      infoType: "取消",
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }));
    expect(action).toMatchObject({
      affectedSources: [
        { kind: "suppressSource", sourceIdentity: "VPOA50:event:E1" },
        { kind: "releaseSource", sourceIdentity: "VPOA50:event:E2", reason: "counterpartCancelled" },
      ],
    });
    expect(correlator.snapshot().sourceStatuses).toMatchObject({
      "VPOA50:event:E1": "matched-suppressed",
      "VPOA50:event:E2": "released-unmatched",
    });
  });

  it("counterpart訂正・取消の対象revision不一致はrecordを変えずdiagnosticを分離する", () => {
    const { correlator, events } = harness();
    correlator.accept(makeCounterpart({ id: "cp", serial: "1" }));
    const mismatch = { reportDateTimeMs: BASE_MS, serial: 99 };
    expect(correlator.accept(makeCounterpart({ id: "cp-correction", infoType: "訂正", key: correlationKey({ targetRevision: mismatch }) }))).toMatchObject({ kind: "emitNow" });
    expect(correlator.accept(makeCounterpart({ id: "cp-cancel", infoType: "取消", key: correlationKey({ targetRevision: mismatch }) }))).toMatchObject({ kind: "emitNow" });
    expect(events.map((event) => event.kind).filter((kind) => kind.endsWith("Mismatch"))).toEqual(["legacyCorrectionMismatch", "legacyCancellationMismatch"]);
    expect(correlator.snapshot().counterpartCount).toBe(1);
  });

  it("counterpart訂正はtargetRevision欠落もmismatchとして上書きしない", () => {
    const { correlator, events } = harness();
    correlator.accept(makeCounterpart({ id: "cp-original", eventId: "E1", serial: "1" }));
    expect(correlator.accept(makeCounterpart({
      id: "cp-correction-without-target",
      eventId: "E1",
      serial: "2",
      infoType: "訂正",
    }))).toMatchObject({ kind: "emitNow" });
    expect(events.filter((event) => event.kind === "legacyCorrectionMismatch")).toMatchObject([{ kind: "legacyCorrectionMismatch" }]);
    expect(correlator.accept(makeSource({ id: "source-after-rejected-correction", eventId: "E1" }))).toMatchObject({
      kind: "suppressSource",
      counterpartOutcome: { msg: { id: "cp-original" } },
    });
  });

  it("counterpart訂正はin-placeで再照合し、時間窓外へ動けば保存sourceを復帰する", () => {
    const { correlator } = harness();
    correlator.accept(makeCounterpart({ id: "cp", eventId: "E1", serial: "1" }));
    correlator.accept(makeSource({ id: "source", eventId: "E1" }));
    expect(correlator.accept(makeCounterpart({
      id: "cp-correction",
      eventId: "E1",
      serial: "2",
      infoType: "訂正",
      reportOffsetMs: 300_001,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }))).toMatchObject({ kind: "releaseSource", reason: "releasedUpdate" });
    expect(correlator.snapshot().counterpartCount).toBe(1);
  });

  it("共有counterpart訂正はsourceごとのcandidate再計算結果を混在batchで返す", () => {
    const { correlator } = harness({
      registry: registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2"])),
    });
    correlator.accept(makeCounterpart({ id: "shared", type: "SYNTH-CP", eventId: null }));
    correlator.accept(makeCounterpart({ id: "specific-e1", type: "SYNTH-CP-2", eventId: "E1" }));
    correlator.accept(makeSource({ id: "source-e1", eventId: "E1" }));
    correlator.accept(makeSource({ id: "source-e2", eventId: "E2" }));

    const action = correlator.accept(makeCounterpart({
      id: "correct-shared-outside-window",
      type: "SYNTH-CP",
      eventId: null,
      serial: "2",
      infoType: "訂正",
      reportOffsetMs: 300_001,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }));
    expect(action).toMatchObject({
      affectedSources: [
        { kind: "suppressSource", sourceIdentity: "VPOA50:event:E1" },
        { kind: "releaseSource", sourceIdentity: "VPOA50:event:E2", reason: "releasedUpdate" },
      ],
    });
    expect(correlator.snapshot().sourceStatuses).toMatchObject({
      "VPOA50:event:E1": "matched-suppressed",
      "VPOA50:event:E2": "released-unmatched",
    });
  });

  it("counterpart訂正で旧参照の窓外sourceをreleaseし新規複数一致だけをambiguousにする", () => {
    const { correlator } = harness();
    correlator.accept(makeCounterpart({ id: "old-counterpart", eventId: null, serial: "1" }));
    correlator.accept(makeSource({ id: "old-source", eventId: "S1" }));
    correlator.accept(makeSource({ id: "new-source-2", eventId: "S2", reportOffsetMs: 300_001 }));
    correlator.accept(makeSource({ id: "new-source-3", eventId: "S3", reportOffsetMs: 300_001 }));

    const action = correlator.accept(makeCounterpart({
      id: "moved-counterpart",
      eventId: null,
      serial: "2",
      infoType: "訂正",
      reportOffsetMs: 300_001,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 1 } }),
    }));
    expect(action).toMatchObject({
      affectedSources: [
        { kind: "releaseSource", sourceIdentity: "VPOA50:event:S1", reason: "releasedUpdate" },
        { kind: "ambiguousSource", sourceIdentity: "VPOA50:event:S2", ambiguityReason: "multipleSources" },
        { kind: "ambiguousSource", sourceIdentity: "VPOA50:event:S3", ambiguityReason: "multipleSources" },
      ],
    });
    expect(correlator.snapshot().sourceStatuses).toMatchObject({
      "VPOA50:event:S1": "released-unmatched",
      "VPOA50:event:S2": "ambiguous",
      "VPOA50:event:S3": "ambiguous",
    });
  });

  it("source満杯は既存recordを退場させず即時capacity fail-openにする", () => {
    const { correlator, events } = harness({ sourceCapacity: 1 });
    expect(correlator.accept(makeSource({ id: "source-1", eventId: "E1" }))).toMatchObject({ kind: "holdSource" });
    expect(correlator.accept(makeSource({ id: "source-2", eventId: "E2" }))).toMatchObject({
      kind: "releaseSource",
      reason: "correlatorCapacityExceeded",
      candidateCount: 0,
    });
    expect(correlator.snapshot().sourceCount).toBe(1);
    expect(events.filter((event) => event.kind === "legacySourceArrivedFirst")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "sourceCapacityExceeded")).toMatchObject([{ kind: "sourceCapacityExceeded" }]);
  });

  it("source capacity bypassはcandidate数をactionへ保持し到着順eventを0件時だけ出す", () => {
    const { correlator, events } = harness({ sourceCapacity: 1 });
    correlator.accept(makeSource({ id: "occupant", eventId: "OCCUPANT" }));
    correlator.accept(makeCounterpart({ id: "candidate", eventId: "MATCHED" }));
    expect(correlator.accept(makeSource({ id: "bypassed", eventId: "MATCHED" }))).toMatchObject({
      kind: "releaseSource",
      reason: "correlatorCapacityExceeded",
      candidateCount: 1,
    });
    expect(events.filter(
      (event) => event.kind === "legacySourceArrivedFirst" && event.sourceIdentity.includes("MATCHED"),
    )).toHaveLength(0);
  });

  it("counterpart満杯は最古の未参照recordをevictする", () => {
    const { correlator, events } = harness({ counterpartCapacity: 2 });
    correlator.accept(makeCounterpart({ id: "cp-1", eventId: "E1" }));
    correlator.accept(makeCounterpart({ id: "cp-2", eventId: "E2" }));
    correlator.accept(makeCounterpart({ id: "cp-3", eventId: "E3" }));
    expect(correlator.snapshot().counterpartIds.some((id) => id.includes("E1"))).toBe(false);
    expect(events.filter((event) => event.kind === "counterpartEvicted")).toMatchObject([{ kind: "counterpartEvicted" }]);
  });

  it("counterpart全件参照中は新recordをbypassし既存参照を壊さない", () => {
    const registry = registryOf(syntheticRule());
    const { correlator, events } = harness({ registry, counterpartCapacity: 2 });
    correlator.accept(makeCounterpart({ id: "cp-1", eventId: "E1" }));
    correlator.accept(makeSource({ id: "src-1", eventId: "E1" }));
    correlator.accept(makeCounterpart({ id: "cp-2", eventId: "E2" }));
    correlator.accept(makeSource({ id: "src-2", eventId: "E2" }));
    expect(correlator.accept(makeCounterpart({ id: "cp-3", eventId: "E3" }))).toMatchObject({ kind: "emitNow" });
    expect(correlator.snapshot().counterpartCount).toBe(2);
    expect(events.at(-1)).toMatchObject({ kind: "counterpartCapacityBypassed" });
  });

  it("counterpart全件参照中でもcache admission前の照合結果はsource抑止へ反映する", () => {
    const { correlator, events } = harness({ counterpartCapacity: 1 });
    correlator.accept(makeCounterpart({ id: "held-cp", eventId: "HELD" }));
    correlator.accept(makeSource({ id: "held-source", eventId: "HELD" }));
    expect(correlator.accept(makeSource({ id: "waiting-source", eventId: "NEW" }))).toMatchObject({ kind: "holdSource" });
    expect(correlator.accept(makeCounterpart({ id: "bypassed-cp", eventId: "NEW" }))).toMatchObject({ kind: "suppressSource" });
    expect(correlator.snapshot().counterpartCount).toBe(1);
    expect(events.at(-1)).toMatchObject({ kind: "counterpartCapacityBypassed" });
  });

  it("counterpart全件参照中のcapacity bypassでも一致tombstoneを一回消費する", () => {
    const { correlator, runtime, events } = harness({ counterpartCapacity: 1 });
    correlator.accept(makeSource({ id: "expired-source", eventId: "EXPIRED" }));
    runtime.advanceBy(660_001);
    correlator.accept(makeCounterpart({ id: "held-counterpart", eventId: "HELD" }));
    correlator.accept(makeSource({ id: "held-source", eventId: "HELD" }));

    expect(correlator.accept(makeCounterpart({ id: "bypassed-late", eventId: "EXPIRED" }))).toMatchObject({
      kind: "emitNow",
    });
    expect(correlator.snapshot()).toMatchObject({
      counterpartCount: 1,
      tombstoneCount: 0,
    });
    expect(events.filter((event) => event.kind === "counterpartCapacityBypassed")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "legacyLateCounterpartExpired")).toHaveLength(1);
  });

  it("未相関released/ambiguousだけをtombstone化し、matched/late-reconciledはしない", () => {
    const unmatched = harness();
    unmatched.correlator.accept(makeSource());
    unmatched.runtime.advanceBy(660_001);
    expect(unmatched.correlator.snapshot().tombstoneCount).toBe(1);

    KEYS.clear();
    const ambiguous = harness({
      registry: registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2"])),
    });
    ambiguous.correlator.accept(makeCounterpart({ id: "ambiguous-cp-1", type: "SYNTH-CP" }));
    ambiguous.correlator.accept(makeCounterpart({ id: "ambiguous-cp-2", type: "SYNTH-CP-2" }));
    expect(ambiguous.correlator.accept(makeSource({ id: "ambiguous-source" }))).toMatchObject({
      kind: "ambiguousSource",
    });
    ambiguous.runtime.advanceBy(660_001);
    expect(ambiguous.correlator.snapshot().tombstoneCount).toBe(1);

    KEYS.clear();
    const matched = harness();
    matched.correlator.accept(makeCounterpart());
    matched.correlator.accept(makeSource());
    matched.runtime.advanceBy(660_001);
    expect(matched.correlator.snapshot().tombstoneCount).toBe(0);

    KEYS.clear();
    const reconciled = harness();
    reconciled.correlator.accept(makeSource());
    reconciled.runtime.advanceBy(60_001);
    reconciled.correlator.accept(makeCounterpart());
    reconciled.runtime.moveTo(BASE_MS + 660_001);
    expect(reconciled.correlator.snapshot().tombstoneCount).toBe(0);
  });

  it("tombstoneは11分inclusive、capacity最古退場、一回消費を守る", () => {
    const ttl = harness();
    ttl.correlator.accept(makeSource({ id: "ttl-src", eventId: "TTL" }));
    ttl.runtime.advanceBy(660_001);
    ttl.runtime.moveTo(BASE_MS + 1_320_000);
    expect(ttl.correlator.snapshot().tombstoneCount).toBe(1);
    ttl.runtime.moveTo(BASE_MS + 1_320_001);
    expect(ttl.correlator.snapshot().tombstoneCount).toBe(0);

    KEYS.clear();
    const capacity = harness({ tombstoneCapacity: 1 });
    capacity.correlator.accept(makeSource({ id: "old-src", eventId: "OLD" }));
    capacity.correlator.accept(makeSource({ id: "new-src", eventId: "NEW" }));
    capacity.runtime.advanceBy(660_001);
    expect(capacity.correlator.snapshot().tombstoneCount).toBe(1);
    expect(capacity.correlator.snapshot().tombstoneIds[0]).toContain("NEW");
    expect(capacity.correlator.snapshot().tombstoneIds[0]).not.toContain("OLD");

    KEYS.clear();
    const consume = harness();
    consume.correlator.accept(makeSource({ id: "consume-src", eventId: "E1" }));
    consume.runtime.advanceBy(660_001);
    consume.correlator.accept(makeCounterpart({ id: "late-1", eventId: "E1" }));
    consume.correlator.accept(makeCounterpart({ id: "late-2", eventId: "E1", serial: "2" }));
    expect(consume.events.filter((event) => event.kind === "legacyLateCounterpartExpired")).toHaveLength(1);
  });

  it.each(["訂正", "取消"] as const)("tombstoneは元sourceの%s targetRevision不一致で消費されない", (infoType) => {
    const { correlator, runtime, events } = harness();
    correlator.accept(makeSource({
      id: `expired-${infoType}`,
      eventId: "E1",
      infoType,
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS, serial: 99 } }),
    }));
    runtime.advanceBy(660_001);
    correlator.accept(makeCounterpart({ id: `late-${infoType}`, eventId: "E1", serial: "1" }));
    expect(correlator.snapshot().tombstoneCount).toBe(1);
    expect(events.filter((event) => event.kind === "legacyLateCounterpartExpired")).toEqual([]);
  });

  it("tombstone消費後もcounterpartをcacheし、次のsourceをcounterpart-firstで抑止する", () => {
    const { correlator, runtime, events } = harness();
    correlator.accept(makeSource({ id: "expired-source", eventId: "E1" }));
    runtime.advanceBy(660_001);
    correlator.accept(makeCounterpart({ id: "late-counterpart", eventId: "E1" }));
    expect(correlator.snapshot()).toMatchObject({ tombstoneCount: 0, counterpartCount: 1 });
    expect(events.filter((event) => event.kind === "legacyLateCounterpartExpired")).toHaveLength(1);
    expect(correlator.accept(makeSource({ id: "next-source", eventId: "E1" }))).toMatchObject({
      kind: "suppressSource",
    });
  });

  it("既存counterpartの訂正が初めてvalidになった場合もtombstoneを消費する", () => {
    const { correlator, runtime, events } = harness();
    correlator.accept(makeSource({ id: "expired-source", eventId: "E1" }));
    runtime.advanceBy(660_001);
    correlator.accept(makeCounterpart({
      id: "counterpart-outside-window",
      eventId: "E1",
      reportOffsetMs: 300_001,
      serial: "1",
    }));
    expect(correlator.snapshot().tombstoneCount).toBe(1);
    correlator.accept(makeCounterpart({
      id: "counterpart-correction",
      eventId: "E1",
      reportOffsetMs: 0,
      serial: "2",
      infoType: "訂正",
      key: correlationKey({ targetRevision: { reportDateTimeMs: BASE_MS + 300_001, serial: 1 } }),
    }));
    expect(correlator.snapshot()).toMatchObject({ tombstoneCount: 0, counterpartCount: 1 });
    expect(events.filter((event) => event.kind === "legacyLateCounterpartExpired")).toHaveLength(1);
  });

  it("ambiguous source到着時に全候補のTTLをsource+11分へ再固定する", () => {
    const { correlator, runtime } = harness({
      registry: registryOf(syntheticRule("VPOA50", ["SYNTH-CP", "SYNTH-CP-2"])),
    });
    correlator.accept(makeCounterpart({ id: "early-cp", type: "SYNTH-CP" }));
    runtime.advanceBy(100_000);
    correlator.accept(makeCounterpart({ id: "late-cp", type: "SYNTH-CP-2" }));
    runtime.advanceBy(100_000);
    expect(correlator.accept(makeSource({ id: "ambiguous-source" }))).toMatchObject({
      kind: "ambiguousSource",
    });
    runtime.moveTo(BASE_MS + 760_001);
    expect(correlator.snapshot().counterpartCount).toBe(2);
    runtime.moveTo(BASE_MS + 860_001);
    expect(correlator.snapshot().counterpartCount).toBe(0);
  });

  it.each(["callback-first", "input-first"] as const)("660,000ms同時刻競合は%sでもlive late matchになる", (order) => {
    const { correlator, runtime, events } = harness();
    correlator.accept(makeSource());
    runtime.advanceBy(60_001);
    runtime.moveTo(BASE_MS + 660_000, false);
    if (order === "callback-first") runtime.runDue();
    const action = correlator.accept(makeCounterpart());
    if (order === "input-first") runtime.runDue(true);
    expect(action).toMatchObject({ kind: "reconcileLateCounterpart" });
    expect(events.some((event) => event.kind === "legacyCorrelationExpired")).toBe(false);
  });

  it("disposeは全timer/cacheを冪等破棄し、restartは空cacheからfail-openする", () => {
    const first = harness();
    first.correlator.accept(makeCounterpart());
    first.correlator.accept(makeSource());
    expect(first.runtime.pendingCount()).toBeGreaterThan(0);
    first.correlator.dispose();
    first.correlator.dispose();
    expect(first.runtime.pendingCount()).toBe(0);
    first.runtime.advanceBy(2 * LEGACY_CORRELATION_RETENTION_MS);
    expect(first.actions).toEqual([]);
    expect(first.correlator.accept(makeSource({ id: "after-dispose" }))).toBeNull();

    const restarted = harness();
    expect(restarted.correlator.accept(makeSource({ id: "restart-source" }))).toMatchObject({ kind: "holdSource" });
  });

  it("action/lifecycle sinkはfactory所有確定時に一度だけ結線できる", () => {
    const runtime = new FakeRuntime();
    const actions: LegacyCounterpartAction[] = [];
    const events: LegacyCounterpartLifecycleEvent[] = [];
    const correlator = new LegacyCounterpartCorrelator({
      registry: registryOf(syntheticRule()),
      clock: runtime.clock,
      timerScheduler: runtime,
    });
    correlator.setActionSink((action) => actions.push(action));
    correlator.setLifecycleEventSink((event) => events.push(event));
    expect(() => correlator.setActionSink(() => undefined)).toThrow(/already bound/);
    expect(() => correlator.setLifecycleEventSink(() => undefined)).toThrow(/already bound/);
    correlator.accept(makeSource());
    runtime.advanceBy(660_001);
    expect(actions).toMatchObject([{ kind: "releaseSource", reason: "timeout" }]);
    expect(events.filter((event) => event.kind === "legacyCorrelationExpired")).toMatchObject([{ kind: "legacyCorrelationExpired" }]);

    const constructorBound = harness();
    expect(() => constructorBound.correlator.setActionSink(() => undefined)).toThrow(/already bound/);
    expect(() => constructorBound.correlator.setLifecycleEventSink(() => undefined)).toThrow(/already bound/);

    const factory: LegacyCounterpartCorrelatorFactory = ({ actionSink, lifecycleEventSink }) =>
      new LegacyCounterpartCorrelator({
        registry: registryOf(syntheticRule()),
        clock: runtime.clock,
        timerScheduler: runtime,
        onAction: actionSink,
        onLifecycleEvent: lifecycleEventSink,
      });
    const factoryOwned = factory({ actionSink: () => undefined, lifecycleEventSink: () => undefined });
    expect(() => factoryOwned.setActionSink(() => undefined)).toThrow(/already bound/);
    expect(() => factoryOwned.setLifecycleEventSink(() => undefined)).toThrow(/already bound/);
  });

  it("unrelated counterpart outcome はcacheせずemitNowする", () => {
    const { correlator } = harness();
    const unrelated: ProcessOutcome = makeCounterpart({ type: "NOT-REGISTERED" });
    expect(correlator.accept(unrelated)).toMatchObject({ kind: "emitNow", reason: "unrelated" });
    expect(correlator.snapshot().counterpartCount).toBe(0);
  });

  it("counterpart-first action/eventはregistry所有sourceTypeを明示する", () => {
    const { correlator, events } = harness();
    expect(correlator.accept(makeCounterpart({ id: "owned-counterpart", eventId: "OWNED" }))).toMatchObject({
      kind: "emitNow",
      reason: "counterpart",
      sourceType: "VPOA50",
    });
    expect(events.filter((event) => event.kind === "legacyCounterpartArrivedFirst")).toEqual([
      expect.objectContaining({ sourceType: "VPOA50" }),
    ]);
  });

  it.each([
    [
      FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221709,
      FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221709,
    ],
    [
      FIXTURE_PHASE6B_VPOA50_JPDE202608201757_202608201757,
      FIXTURE_PHASE6B_VPBS50_KJPDE202608201757_202608201757,
    ],
    [
      FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221717,
      FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221717,
    ],
    [
      FIXTURE_PHASE6B_VPOA50_JPTC202608211633_202608211633,
      FIXTURE_PHASE6B_VPBS50_KJPTC202608211633_202608211633,
    ],
    [
      FIXTURE_PHASE6B_VPOA50_JPTC202608221709_202608221709,
      FIXTURE_PHASE6B_VPBS50_KJPTC202608221709_202608221709,
    ],
    [
      FIXTURE_PHASE6B_VPOA50_JPTK202608221709_202608221727,
      FIXTURE_PHASE6B_VPBS50_KJPTK202608221709_202608221727,
    ],
  ] as const)("実fixture pair %s / %s は両先着順で一意に相関する", (sourceFixture, counterpartFixture) => {
    const source = processLegacyCounterpart(createMockWsDataMessage(sourceFixture));
    const counterpart = processBriefing(createMockWsDataMessage(counterpartFixture));
    if (source == null || counterpart == null) throw new Error("phase6b fixture pair did not parse");

    const sourceFirst = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    expect(sourceFirst.correlator.accept(source)).toMatchObject({ kind: "holdSource" });
    expect(sourceFirst.correlator.accept(counterpart)).toMatchObject({
      kind: "suppressSource",
      counterpartOutcome: { msg: { id: counterpart.msg.id } },
    });

    const counterpartFirst = harness({ registry: PRODUCTION_LEGACY_COUNTERPART_REGISTRY });
    expect(counterpartFirst.correlator.accept(counterpart)).toMatchObject({
      kind: "emitNow",
      reason: "counterpart",
      sourceType: "VPOA50",
    });
    expect(counterpartFirst.correlator.accept(source)).toMatchObject({
      kind: "suppressSource",
      counterpartOutcome: { msg: { id: counterpart.msg.id } },
    });
  });
});
