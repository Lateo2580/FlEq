import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as log from "../../../src/logger";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { reduceWeatherWarningForecast } from "../../../src/engine/display/weather-warning-forecast-active-reducer";
import { testTelegramMeta } from "../../helpers/telegram-meta";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type {
  ForecastTimeSlot,
  ParsedWeatherWarningTimeseriesInfo,
  SignificancyInfo,
  SignificancyOccurrence,
  WeatherWarningTimeseriesArea,
} from "../../../src/types";

/**
 * The identity collision branch guards against a stable key that no longer
 * determines its tuple.  A SHA-256 key cannot collide for distinct tuples, so
 * the only honest way to exercise the branch is to force one kind of key to a
 * constant.  The forced kind is set per test and cleared afterwards, so the
 * file carries no state between `it` blocks.
 */
const forced = vi.hoisted(() => ({ kind: null as "group" | "target" | "occurrence" | null }));

vi.mock("../../../src/engine/presentation/weather-severity-pyramid", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/engine/presentation/weather-severity-pyramid")>();
  return {
    ...actual,
    vpwp50StableKey: (
      kind: Parameters<typeof actual.vpwp50StableKey>[0],
      components: Parameters<typeof actual.vpwp50StableKey>[1],
    ): string => kind === forced.kind ? `forced-${kind}-key` : actual.vpwp50StableKey(kind, components),
  };
});

const SUBJECT = "weatherTimeseries:試験官署:code:200000";
const SEMANTIC = `発表:${"1".repeat(64)}`;
const SOURCE_EVENT_ID = "synthetic-test-event";
const PHENOMENON = "試験現象";
const REPORT_MS = Date.parse("2026-06-06T00:00:00.000Z");
const NOW_MS = Date.parse("2026-06-06T00:30:00.000Z");
const SLOT_BASE_MS = Date.parse("2026-06-06T01:00:00.000Z");
const SLOT_STRIDE_MS = 2 * 60 * 60_000;

function significancy(code: string): SignificancyInfo {
  return { code, known: true, rank: 20, family: "grade", label: "警報級", compact: "警", severity: "warning" };
}

function slotAt(index: number, timeRef: string): ForecastTimeSlot {
  const startsAtMs = SLOT_BASE_MS + index * SLOT_STRIDE_MS;
  return {
    tsNum: 1,
    series: "3h",
    timeRef,
    name: "",
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(startsAtMs + 60 * 60_000).toISOString(),
  };
}

function occurrence(code: string, index: number): SignificancyOccurrence {
  const timeRef = `t${index}`;
  return { info: significancy(code), tsNum: 1, timeRef, slot: slotAt(index, timeRef) };
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

function parsedInfo(areas: WeatherWarningTimeseriesArea[]): ParsedWeatherWarningTimeseriesInfo {
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
  };
}

function reduce(parsed: ParsedWeatherWarningTimeseriesInfo) {
  return reduceWeatherWarningForecast(
    parsed, SUBJECT, SOURCE_EVENT_ID, { reportTimeMs: REPORT_MS, serial: "1" }, SEMANTIC, NOW_MS,
  );
}

function forecastEvent(parsed: ParsedWeatherWarningTimeseriesInfo, id: string): PresentationEvent {
  return {
    id,
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
    standbyActiveSubjects: [SUBJECT],
    standbyAppliedSemanticKey: SEMANTIC,
    raw: parsed,
  };
}

/** Two group tuples on one area: distinct groups unless the key is forced. */
const twoGroups = (): ParsedWeatherWarningTimeseriesInfo =>
  parsedInfo([area("200000", [occurrence("20", 0), occurrence("21", 0)])]);

/** One group tuple over two areas: distinct targets unless the key is forced. */
const twoTargets = (): ParsedWeatherWarningTimeseriesInfo =>
  parsedInfo([area("200000", [occurrence("20", 0)]), area("300000", [occurrence("20", 0)])]);

/** One group and target, two slots: distinct occurrences unless forced. */
const twoOccurrences = (): ParsedWeatherWarningTimeseriesInfo =>
  parsedInfo([area("200000", [occurrence("20", 0), occurrence("20", 1)])]);

beforeEach(() => {
  forced.kind = null;
});

afterEach(() => {
  forced.kind = null;
  vi.restoreAllMocks();
});

describe("VPWP50 identity collision classification", () => {
  it.each([
    ["group", twoGroups],
    ["target", twoTargets],
    ["occurrence", twoOccurrences],
  ] as const)("reports scope %s when that stable key stops determining its tuple", (scope, build) => {
    // Control: the same input is accepted while keys are real.
    expect(reduce(build()).kind).toBe("active");

    forced.kind = scope;
    expect(reduce(build())).toEqual({
      kind: "rejected",
      reason: { code: "identityCollision", scope },
    });
  });

  it("deletes the existing projection and reports both flags on a collision", () => {
    const store = new StandbyStateStore();
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    expect(store.applyEvent(forecastEvent(twoGroups(), "seed"), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    forced.kind = "group";
    expect(store.applyEvent(forecastEvent(twoGroups(), "collision"), NOW_MS))
      .toEqual({ viewChanged: true, durableChanged: true });

    expect(store.cloneSnapshot().data.weatherWarningForecasts.has(SUBJECT)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0]![0];
    expect(line).toContain("vpwp50ProjectionRejected");
    expect(line).toContain("reason=identityCollision");
    expect(line).toContain("scope=group");
  });

  it("reports no mutation on a collision without an existing projection", () => {
    const store = new StandbyStateStore();
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    forced.kind = "target";
    expect(store.applyEvent(forecastEvent(twoTargets(), "collision"), NOW_MS))
      .toEqual({ viewChanged: false, durableChanged: false });
  });
});
