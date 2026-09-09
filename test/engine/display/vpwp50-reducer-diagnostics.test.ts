import { afterEach, describe, expect, it, vi } from "vitest";
import * as log from "../../../src/logger";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import {
  reduceWeatherWarningForecast,
  type Vpwp50ForecastProjectionResult,
  type WeatherWarningForecastState,
} from "../../../src/engine/display/weather-warning-forecast-active-reducer";
import * as wire from "../../../src/engine/display/weather-warning-forecast-wire";
import {
  buildWeatherWarningForecastCard,
  weatherWarningForecastCardJsonBytes,
  weatherWarningForecastProjectionLimitReasons,
  WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES,
  WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
  WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET,
  WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP,
  escapePath,
} from "../../../src/engine/display/weather-warning-forecast-wire";
import { testTelegramMeta } from "../../helpers/telegram-meta";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type { StandbyRevision } from "../../../src/engine/display/standby-registry";
import type {
  ForecastTimeSlot,
  ParsedWeatherWarningTimeseriesInfo,
  SignificancyInfo,
  SignificancyOccurrence,
  WeatherWarningTimeseriesArea,
} from "../../../src/types";

const SUBJECT = "weatherTimeseries:試験官署:code:200000";
const OTHER_SUBJECT = "weatherTimeseries:試験官署:code:300000";
const SEMANTIC = `発表:${"1".repeat(64)}`;
const SOURCE_EVENT_ID = "synthetic-test-event";
const PHENOMENON = "試験現象";
const REPORT_MS = Date.parse("2026-06-06T00:00:00.000Z");
const NOW_MS = Date.parse("2026-06-06T00:30:00.000Z");
const SLOT_BASE_MS = Date.parse("2026-06-06T01:00:00.000Z");
const SLOT_STRIDE_MS = 2 * 60 * 60_000;
const SLOT_LENGTH_MS = 60 * 60_000;

function significancy(code: string): SignificancyInfo {
  return { code, known: true, rank: 20, family: "grade", label: "警報級", compact: "警", severity: "warning" };
}

function slotAt(index: number, timeRef: string, overrides: Partial<ForecastTimeSlot> = {}): ForecastTimeSlot {
  const startsAtMs = SLOT_BASE_MS + index * SLOT_STRIDE_MS;
  return {
    tsNum: 1,
    series: "3h",
    timeRef,
    name: "",
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(startsAtMs + SLOT_LENGTH_MS).toISOString(),
    ...overrides,
  };
}

function occurrence(
  code: string,
  index: number,
  overrides: Partial<SignificancyOccurrence> = {},
): SignificancyOccurrence {
  const timeRef = `t${index}`;
  return { info: significancy(code), tsNum: 1, timeRef, slot: slotAt(index, timeRef), ...overrides };
}

function area(code: string, occurrences: SignificancyOccurrence[]): WeatherWarningTimeseriesArea {
  const name = `試験区域${code}`;
  return {
    name,
    code,
    identityKey: `code:${code}`,
    identity: { key: `code:${code}`, name, code },
    kinds: {
      1: [{ type: PHENOMENON, partKind: "Significancy", significancyOccurrences: { base: occurrences } }],
      2: [],
      3: [],
    },
  };
}

function parsedInfo(
  areas: WeatherWarningTimeseriesArea[],
  overrides: Partial<ParsedWeatherWarningTimeseriesInfo> = {},
): ParsedWeatherWarningTimeseriesInfo {
  return {
    type: "VPWP50",
    infoType: "発表",
    title: "気象警報・注意報",
    controlTitle: "気象警報・注意報",
    reportDateTime: new Date(REPORT_MS).toISOString(),
    publishingOffice: "試験官署",
    editorialOffice: "試験官署",
    eventId: "20260606000000",
    serial: "1",
    headline: null,
    targetArea: null,
    areas,
    maxKnownSignificancy: null,
    maxDisplaySeverity: null,
    maxSoundLevel: null,
    maxDisplayRankSignificancy: null,
    unknownCodes: [],
    fallback: "none",
    meta: testTelegramMeta(),
    isTest: false,
    ...overrides,
  };
}

/** One area, one significancy code, `count` disjoint slots. */
function singleTargetInfo(count: number, areaCode = "200000"): ParsedWeatherWarningTimeseriesInfo {
  return parsedInfo([area(areaCode, Array.from({ length: count }, (_, index) => occurrence("20", index)))]);
}

/** `count` distinct significancy codes on one area, so `count` groups of one period. */
function manyGroupsInfo(count: number): ParsedWeatherWarningTimeseriesInfo {
  return parsedInfo([
    area("200000", Array.from({ length: count }, (_, index) => occurrence(`c${index}`, 0))),
  ]);
}

/** `count` distinct areas under one group, one period each. */
function manyTargetsInfo(count: number): ParsedWeatherWarningTimeseriesInfo {
  return parsedInfo(
    Array.from({ length: count }, (_, index) => area(`3${String(index).padStart(5, "0")}`, [occurrence("20", 0)])),
  );
}

/**
 * One area per entry of `perTargetCounts`, carrying that many periods, so only
 * periodsPerSubject can trip as long as every entry stays inside
 * periodsPerTarget.
 */
function targetsInfo(perTargetCounts: readonly number[]): ParsedWeatherWarningTimeseriesInfo {
  return parsedInfo(perTargetCounts.map((count, index) =>
    area(`${index + 2}00000`, Array.from({ length: count }, (_, slot) => occurrence("20", slot)))));
}

/** Two areas of `perTarget` periods each, so only periodsPerSubject can trip. */
function twoTargetsInfo(perTarget: number): ParsedWeatherWarningTimeseriesInfo {
  return targetsInfo([perTarget, perTarget]);
}

/**
 * Exactly `periodsPerSubject + 1` periods spread so that no target reaches
 * periodsPerTarget.  Two targets cannot express it once the subject limit is
 * twice the target limit (2 x 128 = 256), so a third target carries the
 * remainder.
 */
const OVER_SUBJECT_COUNTS: readonly number[] = (() => {
  const counts: number[] = [];
  let remaining = WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT + 1;
  while (remaining > 0) {
    const take = Math.min(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET, remaining);
    counts.push(take);
    remaining -= take;
  }
  return counts;
})();

function overSubjectPeriodsInfo(): ParsedWeatherWarningTimeseriesInfo {
  return targetsInfo(OVER_SUBJECT_COUNTS);
}

/**
 * 2026-08-30 20:26 に名古屋地方気象台の VPWP50 が `periodsPerSubject` で落ちた
 * 規模の再現。4 種の (現象 x 階級) が区域ごとに立ち、`periodTotal` 件の period に
 * なるまで区域を足す。どの target も period 1 件なので、先に到達する階層は
 * periodsPerSubject だけになる。
 */
function realWorldScaleInfo(periodTotal: number): ParsedWeatherWarningTimeseriesInfo {
  const codes = ["21", "22", "31", "41"];
  const areas: WeatherWarningTimeseriesArea[] = [];
  let remaining = periodTotal;
  for (let index = 0; remaining > 0; index += 1) {
    const occurrences: SignificancyOccurrence[] = [];
    for (const code of codes) {
      if (remaining === 0) break;
      occurrences.push(occurrence(code, 0));
      remaining -= 1;
    }
    areas.push(area(`${300_000 + index}`, occurrences));
  }
  return parsedInfo(areas);
}

interface ReduceOverrides {
  subjectKey?: string;
  sourceEventId?: string;
  revision?: StandbyRevision;
  appliedSemanticKey?: string;
  nowMs?: number;
}

function reduce(
  parsed: ParsedWeatherWarningTimeseriesInfo,
  overrides: ReduceOverrides = {},
): Vpwp50ForecastProjectionResult {
  return reduceWeatherWarningForecast(
    parsed,
    overrides.subjectKey ?? SUBJECT,
    overrides.sourceEventId ?? SOURCE_EVENT_ID,
    overrides.revision ?? { reportTimeMs: REPORT_MS, serial: "1" },
    overrides.appliedSemanticKey ?? SEMANTIC,
    overrides.nowMs ?? NOW_MS,
  );
}

function forecastEvent(
  parsed: ParsedWeatherWarningTimeseriesInfo,
  overrides: Partial<PresentationEvent> = {},
): PresentationEvent {
  return {
    id: "vpwp50-diagnostics",
    classification: "meteorological",
    domain: "weatherWarningTimeseries",
    type: "VPWP50",
    infoType: "発表",
    title: parsed.title,
    controlTitle: parsed.controlTitle,
    headline: null,
    reportDateTime: new Date(REPORT_MS).toISOString(),
    publishingOffice: "試験官署",
    isTest: false,
    frameLevel: "warning",
    isCancellation: false,
    eventId: SOURCE_EVENT_ID,
    serial: "1",
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    standbyStateMutationAccepted: true,
    standbyStateSubject: SUBJECT,
    // Without this, post-apply retention drops every managed subject.
    standbyActiveSubjects: [SUBJECT, OTHER_SUBJECT],
    standbyAppliedSemanticKey: SEMANTIC,
    raw: parsed,
    ...overrides,
  };
}

function forecastStates(store: StandbyStateStore): Map<string, WeatherWarningForecastState> {
  return store.cloneSnapshot().data.weatherWarningForecasts;
}

/** Seeds one accepted projection for `subject` so deletion is observable. */
function seedProjection(store: StandbyStateStore, subject: string): void {
  const mutation = store.applyEvent(
    forecastEvent(singleTargetInfo(1, subject === SUBJECT ? "200000" : "300000"), {
      id: `seed-${subject}`,
      standbyStateSubject: subject,
    }),
    NOW_MS,
  );
  expect(mutation).toEqual({ viewChanged: true, durableChanged: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VPWP50 reducer result classification", () => {
  it("accepts the baseline synthetic fixture so every reject case is a single-condition change", () => {
    const result = reduce(singleTargetInfo(2));
    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.state.groups).toHaveLength(1);
    expect(result.state.groups[0]!.targets).toHaveLength(1);
    expect(result.state.groups[0]!.targets[0]!.periods).toHaveLength(2);
  });

  it.each([
    ["invalidRevisionSerial", { revision: { reportTimeMs: REPORT_MS, serial: "not-a-number" } }],
    ["invalidNowMs", { nowMs: 1.5 }],
    ["invalidReportTime", { revision: { reportTimeMs: 1.5, serial: "1" } }],
    // 9e15 is a safe integer yet exceeds the ECMAScript time value range, so
    // this case is not absorbed by the safe-integer disjunct above.
    ["invalidReportTime", { revision: { reportTimeMs: 9e15, serial: "1" } }],
    ["invalidSubjectKey", { subjectKey: "" }],
    ["invalidSubjectPrefix", { subjectKey: "somethingElse:試験官署:code:200000" }],
    ["invalidSourceEventId", { sourceEventId: "" }],
    ["invalidSemanticKey", { appliedSemanticKey: "発表:not-a-digest" }],
  ] as const)("reports %s for its own header disjunct", (code, overrides) => {
    expect(reduce(singleTargetInfo(1), overrides)).toEqual({ kind: "rejected", reason: { code } });
  });

  it("separates the two report time disjuncts by input rather than by code", () => {
    // Both fold into invalidReportTime, but 9e15 passes Number.isSafeInteger
    // and only fails the Date time value bound.
    expect(Number.isSafeInteger(9e15)).toBe(true);
    expect(Number.isFinite(new Date(9e15).getTime())).toBe(false);
    expect(reduce(singleTargetInfo(1), { revision: { reportTimeMs: 9e15, serial: "1" } }))
      .toEqual({ kind: "rejected", reason: { code: "invalidReportTime" } });
  });

  it("reports invalidPublishingOffice for the publishing office disjunct", () => {
    const parsed = parsedInfo([area("200000", [occurrence("20", 0)])], { publishingOffice: "  " });
    expect(reduce(parsed)).toEqual({ kind: "rejected", reason: { code: "invalidPublishingOffice" } });
  });

  it.each([
    ["a blank target area name", { name: "", code: "200000" }],
    ["an over-long target area code", { name: "試験対象", code: "c".repeat(65) }],
  ])("reports invalidTargetArea for %s", (_label, target) => {
    const parsed = parsedInfo([area("200000", [occurrence("20", 0)])], {
      targetArea: { name: target.name, code: target.code, kinds: { 1: [], 2: [], 3: [] } },
    });
    expect(reduce(parsed)).toEqual({ kind: "rejected", reason: { code: "invalidTargetArea" } });
  });

  it("reports invalidOccurrence with the projected index of the first failing entry", () => {
    const broken = occurrence("20", 1);
    // Only the slot/entry tsNum agreement is broken; the series still matches
    // the entry tsNum so no other predicate in validOccurrence fires.
    broken.slot = { ...broken.slot!, tsNum: 2 };
    const parsed = parsedInfo([area("200000", [occurrence("20", 0), broken])]);
    expect(reduce(parsed)).toEqual({
      kind: "rejected",
      reason: { code: "invalidOccurrence", projectedOccurrenceIndex: 1 },
    });
  });
});

describe("VPWP50 reducer nested count boundaries", () => {
  const subjectPath = `subjects/${escapePath(SUBJECT)}`;

  // A1: 実機で落ちた 194 period が新上限で active になる。
  it("accepts the 194-period candidate that the old 128 limit rejected", () => {
    const parsed = realWorldScaleInfo(194);
    const result = reduce(parsed);
    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    const periods = result.state.groups.flatMap((group) =>
      group.targets.flatMap((target) => target.periods));
    expect(periods).toHaveLength(194);
    // 194 が 128 を超えていること自体を固定する（旧上限では reducer が落としていた）。
    expect(periods.length).toBeGreaterThan(128);
    expect(periods.length).toBeLessThanOrEqual(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT);
    // 他の階層は無傷（この candidate が periodsPerSubject だけを試していること）。
    expect(result.state.groups).toHaveLength(4);
    expect(Math.max(...result.state.groups.map((group) => group.targets.length)))
      .toBeLessThanOrEqual(WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP);
  });

  // A2: 同じ candidate が live 経路を通り、card 側の byte 検査にも落ちない。
  it("admits the 194-period candidate through the live store without a capacity warn", () => {
    const store = new StandbyStateStore();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(store.applyEvent(forecastEvent(realWorldScaleInfo(194)), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    expect(warn.mock.calls.map((call) => call[0])
      .filter((line) => line.includes("vpwp50Projection"))).toEqual([]);
    const state = forecastStates(store).get(SUBJECT);
    expect(state).toBeDefined();
    expect(state!.groups.flatMap((group) =>
      group.targets.flatMap((target) => target.periods))).toHaveLength(194);
    const card = buildWeatherWarningForecastCard([state!]);
    expect(card).not.toBeNull();
    // byte 側にも余裕があること（count だけ上げても byte で落ちる、が spec §2.3 の論点）。
    expect(weatherWarningForecastCardJsonBytes(card!))
      .toBeLessThanOrEqual(WEATHER_WARNING_FORECAST_MAX_CARD_JSON_BYTES);
    expect(weatherWarningForecastProjectionLimitReasons([state!])).toEqual([]);
  });

  it("accepts 128 groups and rejects 129 with groupsPerSubject", () => {
    expect(reduce(manyGroupsInfo(WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT)).kind).toBe("active");
    expect(reduce(manyGroupsInfo(WEATHER_WARNING_FORECAST_MAX_GROUPS_PER_SUBJECT + 1))).toEqual({
      kind: "rejected",
      reason: {
        code: "capacityExceeded",
        hierarchy: "groupsPerSubject",
        actual: 129,
        declaredLimit: 128,
        samplePath: `${subjectPath}/groups`,
      },
    });
  });

  it("accepts 128 targets in a group and rejects 129 with targetsPerGroup", () => {
    expect(reduce(manyTargetsInfo(WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP)).kind).toBe("active");
    const result = reduce(manyTargetsInfo(WEATHER_WARNING_FORECAST_MAX_TARGETS_PER_GROUP + 1));
    expect(result).toMatchObject({
      kind: "rejected",
      reason: { code: "capacityExceeded", hierarchy: "targetsPerGroup", actual: 129, declaredLimit: 128 },
    });
    if (result.kind !== "rejected" || result.reason.code !== "capacityExceeded") return;
    expect(result.reason.samplePath).toMatch(new RegExp(`^${subjectPath}/groups/[\\w-]+/targets$`));
  });

  it("accepts 128 periods in a target and rejects 129 with periodsPerTarget", () => {
    expect(reduce(singleTargetInfo(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET)).kind).toBe("active");
    const result = reduce(singleTargetInfo(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET + 1));
    expect(result).toMatchObject({
      kind: "rejected",
      reason: { code: "capacityExceeded", hierarchy: "periodsPerTarget", actual: 129, declaredLimit: 128 },
    });
    if (result.kind !== "rejected" || result.reason.code !== "capacityExceeded") return;
    expect(result.reason.samplePath)
      .toMatch(new RegExp(`^${subjectPath}/groups/[\\w-]+/targets/[\\w-]+/periods$`));
  });

  it("accepts 256 subject periods and rejects 257 with periodsPerSubject", () => {
    // 空洞化の番人: どの target も periodsPerTarget の内側に留まっていないと、
    // 先に periodsPerTarget が鳴って periodsPerSubject の境界を試験できない。
    const counts = [WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET, WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET];
    expect(counts.reduce((sum, count) => sum + count, 0))
      .toBe(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT);
    expect(reduce(targetsInfo(counts)).kind).toBe("active");

    expect(Math.max(...OVER_SUBJECT_COUNTS))
      .toBeLessThanOrEqual(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET);
    expect(OVER_SUBJECT_COUNTS.reduce((sum, count) => sum + count, 0))
      .toBe(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT + 1);
    expect(reduce(overSubjectPeriodsInfo())).toEqual({
      kind: "rejected",
      reason: {
        code: "capacityExceeded",
        hierarchy: "periodsPerSubject",
        actual: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT + 1,
        declaredLimit: WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT,
        samplePath: `${subjectPath}/periods`,
      },
    });
  });

  it("reports the hierarchy that is reached first, not periodsPerSubject", () => {
    // 129 groups and 129 targets both carry 129 total periods, so
    // periodsPerSubject is violated too and must not be the reported code.
    for (const info of [manyGroupsInfo(129), manyTargetsInfo(129)]) {
      const result = reduce(info);
      expect(result.kind).toBe("rejected");
      if (result.kind !== "rejected" || result.reason.code !== "capacityExceeded") continue;
      expect(result.reason.hierarchy).not.toBe("periodsPerSubject");
    }
    const perTarget = reduce(singleTargetInfo(129));
    expect(perTarget.kind === "rejected" && perTarget.reason.code === "capacityExceeded"
      && perTarget.reason.hierarchy).toBe("periodsPerTarget");
  });
});

describe("VPWP50 sample paths escape the subject key", () => {
  // Contains both characters escapePath rewrites: "/" to "~1" and "~" to "~0".
  const SLASH_SUBJECT = "weatherTimeseries:試験/官署:code~200000";
  // Written out rather than recomputed with escapePath, so a broken or absent
  // escape shows up as a failure instead of matching itself.
  const ESCAPED = "weatherTimeseries:試験~1官署:code~0200000";

  it("rewrites the two reserved characters in every reducer sample path", () => {
    expect(escapePath(SLASH_SUBJECT)).toBe(ESCAPED);

    const groups = reduce(manyGroupsInfo(129), { subjectKey: SLASH_SUBJECT });
    expect(groups.kind === "rejected" && groups.reason.code === "capacityExceeded"
      && groups.reason.samplePath).toBe(`subjects/${ESCAPED}/groups`);

    const periods = reduce(overSubjectPeriodsInfo(), { subjectKey: SLASH_SUBJECT });
    expect(periods.kind === "rejected" && periods.reason.code === "capacityExceeded"
      && periods.reason.samplePath).toBe(`subjects/${ESCAPED}/periods`);

    const targets = reduce(manyTargetsInfo(129), { subjectKey: SLASH_SUBJECT });
    expect(targets.kind === "rejected" && targets.reason.code === "capacityExceeded"
      && targets.reason.samplePath.startsWith(`subjects/${ESCAPED}/groups/`)).toBe(true);
  });

  it("escapes nothing on the accepted path", () => {
    const escape = vi.spyOn(wire, "escapePath");

    expect(reduce(manyGroupsInfo(128)).kind).toBe("active");
    // Sample paths belong to rejects only, so an accepted candidate must not
    // pay for one escape per group.
    expect(escape).toHaveBeenCalledTimes(0);

    // Positive control: the same spy does observe the reject path.
    expect(reduce(manyGroupsInfo(129)).kind).toBe("rejected");
    expect(escape.mock.calls.length).toBeGreaterThan(0);
  });

  it("matches the path the card-side countUnits produces for the same subject", () => {
    // The reducer refuses a 129-group candidate, so the card side never sees
    // one on its own.  Build that state by hand to compare the two spellings.
    const accepted = reduce(manyGroupsInfo(128), { subjectKey: SLASH_SUBJECT });
    expect(accepted.kind).toBe("active");
    if (accepted.kind !== "active") return;
    // groupsPerSubject と periodsPerSubject の両方を鳴らす必要があるので、
    // 1 period の group を periodsPerSubject の直上まで積む。
    const extras = WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_SUBJECT + 1 - accepted.state.groups.length;
    expect(extras).toBeGreaterThan(0);
    const oversized: WeatherWarningForecastState = {
      ...accepted.state,
      groups: [
        ...accepted.state.groups,
        ...Array.from({ length: extras }, (_, index) =>
          ({ ...accepted.state.groups[0]!, key: `extra-group-key-${index}` })),
      ],
    };

    const wireReasons = wire.weatherWarningForecastProjectionLimitReasons([oversized]);
    const groupsReason = wireReasons.filter((reason) => reason.code === "groupsPerSubject")[0];
    const periodsReason = wireReasons.filter((reason) => reason.code === "periodsPerSubject")[0];
    expect(groupsReason?.samplePaths).toContain(`subjects/${ESCAPED}/groups`);
    expect(periodsReason?.samplePaths).toContain(`subjects/${ESCAPED}/periods`);

    const reducerGroups = reduce(manyGroupsInfo(129), { subjectKey: SLASH_SUBJECT });
    expect(reducerGroups.kind === "rejected" && reducerGroups.reason.code === "capacityExceeded"
      && reducerGroups.reason.samplePath).toBe(groupsReason!.samplePaths[0]);

    const reducerPeriods = reduce(overSubjectPeriodsInfo(), { subjectKey: SLASH_SUBJECT });
    expect(reducerPeriods.kind === "rejected" && reducerPeriods.reason.code === "capacityExceeded"
      && reducerPeriods.reason.samplePath).toBe(periodsReason!.samplePaths[0]);
  });
});

describe("VPWP50 empty projections", () => {
  it("distinguishes no occurrences, unresolved slots, and expired slots", () => {
    expect(reduce(parsedInfo([]))).toEqual({
      kind: "empty", reason: "noActivePeriods", occurrences: 0, resolvedSlots: 0, expiredSlots: 0,
    });

    const unresolved = parsedInfo([
      area("200000", [occurrence("20", 0, { slot: null }), occurrence("20", 1, { slot: null })]),
    ]);
    expect(reduce(unresolved)).toEqual({
      kind: "empty", reason: "noActivePeriods", occurrences: 2, resolvedSlots: 0, expiredSlots: 0,
    });

    const expired = singleTargetInfo(3);
    expect(reduce(expired, { nowMs: SLOT_BASE_MS + 10 * SLOT_STRIDE_MS })).toEqual({
      kind: "empty", reason: "noActivePeriods", occurrences: 3, resolvedSlots: 3, expiredSlots: 3,
    });
  });
});

describe("VPWP50 store diagnostics", () => {
  it("records a normal empty projection without any warning", () => {
    const store = new StandbyStateStore();
    seedProjection(store, SUBJECT);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const expiredNowMs = SLOT_BASE_MS + 10 * SLOT_STRIDE_MS;

    expect(store.applyEvent(forecastEvent(singleTargetInfo(3)), expiredNowMs))
      .toEqual({ viewChanged: true, durableChanged: true });

    expect(warn).toHaveBeenCalledTimes(0);
    expect(info).toHaveBeenCalledTimes(1);
    const line = info.mock.calls[0]![0];
    expect(line).toContain("vpwp50ProjectionEmpty");
    expect(line).toContain("reason=noActivePeriods");
    expect(line).toContain("occurrences=3 resolvedSlots=3 expiredSlots=3");
    expect(line).toContain("existingProjectionDeleted=true");
  });

  it("classifies a thrown reducer failure without leaking a stack", () => {
    const store = new StandbyStateStore();
    seedProjection(store, SUBJECT);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const parsed = parsedInfo([]);
    Object.defineProperty(parsed, "areas", {
      get() {
        throw new Error(
          `reason=forged existingProjectionDeleted=false ${"x".repeat(400)}`
          + `\nsecond\u000bline\u000cfeed\u2028sep\ttabbed`,
        );
      },
    });

    expect(store.applyEvent(forecastEvent(parsed), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0];
    expect(line).toContain("vpwp50ProjectionRejected");
    expect(line).toContain("reason=reducerThrew");
    expect(line).not.toContain("stack");
    expect(line).not.toContain("\n");
    const quoted = line.slice(line.indexOf(" detail=") + " detail=".length);
    // Quoted, so a message containing `a=b` cannot forge a log field.
    expect(quoted.startsWith("\"")).toBe(true);
    expect(quoted.endsWith("\"")).toBe(true);
    const detail = JSON.parse(quoted) as string;
    expect(detail.startsWith("Error: reason=forged")).toBe(true);
    // The forged pair lives inside the quoted value, not as a log field.
    expect(line.indexOf("reason=")).toBe(line.indexOf("reason=reducerThrew"));
    expect(detail.length).toBeLessThanOrEqual(120);
    expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(detail)).toBe(false);
  });

  it("names a reason on every rejected line and keeps the reducer capacity diagnostic tagged", () => {
    const store = new StandbyStateStore();
    seedProjection(store, SUBJECT);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(store.applyEvent(forecastEvent(manyGroupsInfo(129)), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0];
    expect(line.startsWith("[VPWP50] vpwp50ProjectionCapacityExceeded ")).toBe(true);
    const diagnostic = JSON.parse(line.slice("[VPWP50] vpwp50ProjectionCapacityExceeded ".length)) as {
      subjectKey: string;
      candidateRevision: StandbyRevision;
      existingProjectionDeleted: boolean;
      reasons: Array<Record<string, unknown>>;
    };
    expect(diagnostic).toEqual({
      subjectKey: SUBJECT,
      candidateRevision: { reportTimeMs: REPORT_MS, serial: "1" },
      existingProjectionDeleted: true,
      reasons: [{
        origin: "reducer",
        code: "groupsPerSubject",
        actual: 129,
        declaredLimit: 128,
        effectiveLimit: null,
        violatingUnitCount: 1,
        limitingHierarchies: ["groupsPerSubject"],
        samplePaths: [`subjects/${escapePath(SUBJECT)}/groups`],
      }],
    });
  });

  it("adds no candidate search to a reducer-side capacity rejection", () => {
    const store = new StandbyStateStore();
    seedProjection(store, SUBJECT);
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const reasons = vi.spyOn(wire, "weatherWarningForecastProjectionLimitReasons");

    expect(store.applyEvent(forecastEvent(manyGroupsInfo(129)), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    // The 129-iteration effectiveLimit search must stay off this path.
    expect(reasons).toHaveBeenCalledTimes(0);

    // Positive control: the same spy does observe the card-side check that a
    // reducer-accepted candidate runs, so the zero above is a real absence
    // rather than an unwired spy.
    expect(store.applyEvent(forecastEvent(singleTargetInfo(3)), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });
    expect(reasons.mock.calls.length).toBeGreaterThan(0);
  });

  it("keeps the card-side capacity diagnostic in its existing origin-free shape", () => {
    const store = new StandbyStateStore();
    // Each subject stays inside every per-subject limit; only the card total trips.
    // The seeded subject sits exactly on periodsPerSubject, so the single extra
    // period below is what pushes the card total past periodsPerCard.
    expect(store.applyEvent(
      forecastEvent(twoTargetsInfo(WEATHER_WARNING_FORECAST_MAX_PERIODS_PER_TARGET), {
        id: "card-a", standbyStateSubject: OTHER_SUBJECT,
      }),
      NOW_MS,
    )).toEqual({ viewChanged: true, durableChanged: true });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    expect(store.applyEvent(forecastEvent(singleTargetInfo(1)), NOW_MS)).toEqual(
      { viewChanged: false, durableChanged: false },
    );

    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0];
    expect(line.startsWith("[VPWP50] vpwp50ProjectionCapacityExceeded ")).toBe(true);
    const diagnostic = JSON.parse(line.slice("[VPWP50] vpwp50ProjectionCapacityExceeded ".length)) as {
      reasons: Array<Record<string, unknown>>;
    };
    expect(diagnostic.reasons).toHaveLength(1);
    expect(diagnostic.reasons[0]!.code).toBe("periodsPerCard");
    expect(diagnostic.reasons[0]).not.toHaveProperty("origin");
    // The accepted other subject is untouched by the failed candidate.
    expect(store.snapshotItems().some((item) => item.kind === "weatherWarningForecast")).toBe(true);
  });
});

describe("VPWP50 store behaviour is unchanged by the classification", () => {
  const rejectCases: Array<[string, ParsedWeatherWarningTimeseriesInfo | (() => ParsedWeatherWarningTimeseriesInfo)]> = [
    ["header", parsedInfo([area("200000", [occurrence("20", 0)])], { publishingOffice: "  " })],
    ["occurrence", (() => {
      const broken = occurrence("20", 1);
      broken.slot = { ...broken.slot!, tsNum: 2 };
      return parsedInfo([area("200000", [occurrence("20", 0), broken])]);
    })()],
    ["groupsPerSubject", manyGroupsInfo(129)],
    ["targetsPerGroup", manyTargetsInfo(129)],
    ["periodsPerTarget", singleTargetInfo(129)],
    ["periodsPerSubject", overSubjectPeriodsInfo()],
    ["empty", parsedInfo([])],
    ["reducerThrew", () => {
      const parsed = parsedInfo([]);
      Object.defineProperty(parsed, "areas", { get() { throw new Error("synthetic reducer failure"); } });
      return parsed;
    }],
  ];

  it.each(rejectCases)("deletes an existing projection and reports both flags for %s", (_label, source) => {
    const parsed = typeof source === "function" ? source() : source;
    const store = new StandbyStateStore();
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "info").mockImplementation(() => undefined);
    seedProjection(store, SUBJECT);
    seedProjection(store, OTHER_SUBJECT);
    const before = forecastStates(store).get(OTHER_SUBJECT);

    expect(store.applyEvent(forecastEvent(parsed), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    const after = forecastStates(store);
    expect(after.has(SUBJECT)).toBe(false);
    expect(after.get(OTHER_SUBJECT)).toEqual(before);
  });

  it.each(rejectCases)("reports no mutation without an existing projection for %s", (_label, source) => {
    const parsed = typeof source === "function" ? source() : source;
    const store = new StandbyStateStore();
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    vi.spyOn(log, "info").mockImplementation(() => undefined);

    expect(store.applyEvent(forecastEvent(parsed), NOW_MS))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(forecastStates(store).has(SUBJECT)).toBe(false);
  });

  it("still accepts a valid candidate and replaces the previous projection", () => {
    const store = new StandbyStateStore();
    seedProjection(store, SUBJECT);
    expect(store.applyEvent(
      forecastEvent(singleTargetInfo(3), { id: "newer", reportDateTime: new Date(REPORT_MS + 60_000).toISOString() }),
      NOW_MS,
    )).toEqual({ viewChanged: true, durableChanged: true });
    const state = forecastStates(store).get(SUBJECT);
    expect(state?.groups[0]?.targets[0]?.periods).toHaveLength(3);
    expect(state?.restored).toBe(false);
  });
});
