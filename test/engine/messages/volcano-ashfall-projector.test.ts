import { describe, expect, it } from "vitest";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import {
  projectVolcanoAshfall,
  validateVolcanoAshfallProjection,
  VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD,
  VOLCANO_ASHFALL_MAX_PERIODS,
  VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES,
} from "../../../src/engine/messages/volcano-ashfall-projector";
import type { AshArea, AshForecastPeriod, ParsedVolcanoAshfallInfo } from "../../../src/types";
import { createMockWsDataMessage, FIXTURE_VFVO54_ASH_RAPID, FIXTURE_VFVO55_ASH_DETAIL } from "../../helpers/mock-message";

function parsed(fixture: string): ParsedVolcanoAshfallInfo {
  const result = parseVolcanoTelegram(createMockWsDataMessage(fixture));
  if (result?.kind !== "ashfall") throw new Error("ashfall fixture was not parsed");
  return result;
}

function project(info: ParsedVolcanoAshfallInfo) {
  return projectVolcanoAshfall(info, {
    classificationNowMs: Math.min(...info.ashForecasts.map((period) => Date.parse(period.endTime))) - 1,
    appliedSemanticKey: "test",
    generation: 1,
  });
}

const REPORT_MS = Date.parse("2021-05-14T12:40:00+09:00");

function area(index: number, over: Partial<AshArea> = {}): AshArea {
  return {
    name: `地域 ${index}`,
    code: String(10_000 + index),
    ashCode: "72",
    ashName: "やや多量の降灰",
    thickness: null,
    plumeDirection: null,
    distanceKm: null,
    ...over,
  };
}

function period(
  areas: AshArea[],
  startTime = "2021-05-14T12:40:00+09:00",
  endTime = "2021-05-14T13:40:00+09:00",
): AshForecastPeriod {
  return { startTime, endTime, areas };
}

function synthetic(periods: AshForecastPeriod[]): ParsedVolcanoAshfallInfo {
  const info = structuredClone(parsed(FIXTURE_VFVO54_ASH_RAPID));
  info.ashForecasts = periods;
  return info;
}

function classify(info: ParsedVolcanoAshfallInfo, classificationNowMs = REPORT_MS) {
  return projectVolcanoAshfall(info, {
    classificationNowMs,
    appliedSemanticKey: "semantic:test",
    generation: 1,
  });
}

describe("projectVolcanoAshfall", () => {
  it("keeps the real rapid fixture compact and separates ash from ballistic", () => {
    const result = project(parsed(FIXTURE_VFVO54_ASH_RAPID));
    expect(result.kind).toBe("active");
    if (result.kind !== "active") return;
    expect(result.projection.stateSubjectKey).toBe("volcano:ashfall:506");
    expect(result.projection.sourceType).toBe("VFVO54");
    expect(result.projection.groups.map((group) => group.ashCode)).toEqual(["75", "72"]);
    expect(result.projection.groups[0]?.areaCount).toBe(1);
  });

  it("uses the maximum forecast end as the all-or-nothing expiry", () => {
    const info = parsed(FIXTURE_VFVO55_ASH_DETAIL);
    const end = Math.max(...info.ashForecasts.map((period) => Date.parse(period.endTime)));
    expect(projectVolcanoAshfall(info, {
      classificationNowMs: end,
      appliedSemanticKey: "test",
      generation: 1,
    })).toEqual({ kind: "expired", forecastEndsAtMs: end });
  });

  it.each([Number.MAX_SAFE_INTEGER, REPORT_MS + 0.5])(
    "treats a non-Date-safe report epoch %s as an invalid revision",
    (reportTimeMs) => {
      const info = parsed(FIXTURE_VFVO54_ASH_RAPID);
      info.meta.reportDateTime.epochMs = reportTimeMs;
      expect(classify(info)).toEqual({ kind: "transient", reason: "invalidRevision" });
    },
  );

  it.each([
    [0, "invalidPeriod"],
    [VOLCANO_ASHFALL_MAX_PERIODS, null],
    [VOLCANO_ASHFALL_MAX_PERIODS + 1, "tooManyPeriods"],
  ] as const)("period count %s has the closed boundary", (count, reason) => {
    const result = classify(synthetic(Array.from({ length: count }, () => period([area(1)]))));
    if (reason == null) expect(result.kind).toBe("active");
    else expect(result).toEqual({ kind: "nonProjectable", reason });
  });

  it.each([
    [VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD, "active"],
    [VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD + 1, "nonProjectable"],
  ] as const)("area-per-period count %s is bounded", (count, kind) => {
    const result = classify(synthetic([period(Array.from({ length: count }, (_, index) => area(index)))]));
    expect(result.kind).toBe(kind);
  });

  it("counts raw occurrences before exact-period dedupe at 2,048 / 2,049", () => {
    const full = Array.from(
      { length: VOLCANO_ASHFALL_MAX_TOTAL_AREA_OCCURRENCES / VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD },
      () => period(Array.from({ length: VOLCANO_ASHFALL_MAX_AREAS_PER_PERIOD }, (_, index) => area(index))),
    );
    expect(classify(synthetic(full)).kind).toBe("active");
    expect(classify(synthetic([...full, period([area(999)])]))).toEqual({
      kind: "nonProjectable",
      reason: "tooManyAreas",
    });
  });

  it.each([
    ["2021-05-14T00:00:00", "2021-05-14T01:00:00+09:00"],
    ["2021-05-14T12:40:00+09:00", "2021-05-14T12:40:00+09:00"],
    ["2021-05-14T12:40:00+09:00", "2021-05-14T12:39:59.999+09:00"],
    ["2021-05-13T21:39:59.999+09:00", "2021-05-14T12:40:00+09:00"],
    ["2021-05-14T12:40:00+09:00", "2021-05-16T12:40:00.001+09:00"],
  ])("rejects invalid temporal bounds %s → %s", (start, end) => {
    expect(classify(synthetic([period([area(1)], start, end)]))).toEqual({
      kind: "nonProjectable",
      reason: "invalidPeriod",
    });
  });

  it("accepts exact −6h and +48h bounds and treats UTC/JST spellings as the same epoch", () => {
    const exactStart = classify(synthetic([period(
      [area(1)],
      "2021-05-14T06:40:00+09:00",
      "2021-05-16T06:40:00+09:00",
    )]));
    expect(exactStart.kind).toBe("active");
    const exactEnd = classify(synthetic([period(
      [area(1)],
      "2021-05-14T12:40:00+09:00",
      "2021-05-16T12:40:00+09:00",
    )]));
    expect(exactEnd.kind).toBe("active");
    const utc = classify(synthetic([period(
      [area(1)],
      "2021-05-14T03:40:00Z",
      "2021-05-14T04:40:00Z",
    )]));
    const jst = classify(synthetic([period(
      [area(1)],
      "2021-05-14T12:40:00+09:00",
      "2021-05-14T13:40:00+09:00",
    )]));
    expect(utc).toEqual(jst);
  });

  it("allows gaps, overlap, and containment and is invariant to period order", () => {
    const periods = [
      period([area(1)], "2021-05-14T12:40:00+09:00", "2021-05-14T14:40:00+09:00"),
      period([area(2)], "2021-05-14T13:00:00+09:00", "2021-05-14T13:30:00+09:00"),
      period([area(3)], "2021-05-14T15:40:00+09:00", "2021-05-14T16:40:00+09:00"),
    ];
    expect(classify(synthetic(periods))).toEqual(classify(synthetic([...periods].reverse())));
  });

  it("normalizes area identity while rejecting ambiguous code/name and unknown-group labels", () => {
    const normalized = classify(synthetic([period([
      area(1, { code: " 0506 ", name: "  鹿児島   市  " }),
      area(2, { code: "0507", name: "鹿児島 市" }),
    ])]));
    expect(normalized.kind).toBe("active");
    if (normalized.kind === "active") {
      expect(normalized.projection.groups[0]?.topAreas.map((item) => [item.identityKey, item.name]))
        .toEqual([["area:code:0506", "鹿児島 市"], ["area:code:0507", "鹿児島 市"]]);
    }
    expect(classify(synthetic([period([
      area(1, { code: "0506", name: "A" }),
      area(2, { code: "0506", name: "B" }),
    ])]))).toEqual({ kind: "nonProjectable", reason: "invalidArea" });
    expect(classify(synthetic([period([
      area(1, { ashCode: "99", ashName: "未知A" }),
      area(2, { ashCode: "99", ashName: "未知B" }),
    ])]))).toEqual({ kind: "nonProjectable", reason: "invalidGroup" });
    expect(classify(synthetic([period([
      area(1, { name: "鹿児島\t市" }),
    ])]))).toEqual({ kind: "nonProjectable", reason: "invalidArea" });
  });

  it("keeps ballistic independently and chooses only the worst known ash group per area", () => {
    const result = classify(synthetic([period([
      area(1, { ashCode: "70", ashName: "降灰" }),
      area(1, { ashCode: "73", ashName: "多量の降灰" }),
      area(1, { ashCode: "75", ashName: "小さな噴石の落下" }),
    ])]));
    expect(result.kind).toBe("active");
    if (result.kind === "active") {
      expect(result.projection.groups.map((group) => group.ashCode)).toEqual(["75", "73"]);
      expect(result.projection.groups.every((group) => group.areaCount === 1)).toBe(true);
    }
  });

  it("caps groups at 8, top areas at 3, and preserves exact omission counts", () => {
    const groups = Array.from({ length: 9 }, (_, index) => area(index, {
      ashCode: String(80 + index),
      ashName: `未知 ${index}`,
    }));
    groups.push(...Array.from({ length: 4 }, (_, index) => area(100 + index, {
      ashCode: "75",
      ashName: "小さな噴石の落下",
    })));
    const result = classify(synthetic([period(groups)]));
    expect(result.kind).toBe("active");
    if (result.kind === "active") {
      expect(result.projection.groups).toHaveLength(8);
      expect(result.projection.omittedGroupCount).toBe(2);
      expect(result.projection.groups[0]).toMatchObject({
        ashCode: "75",
        areaCount: 4,
        omittedAreaCount: 1,
      });
      expect(result.projection.groups[0]?.topAreas).toHaveLength(3);
    }
  });

  it("deep validator enforces the represented 2,048 lower bound and never throws on malformed nested values", () => {
    const active = classify(synthetic([period([area(1), area(2), area(3)])]));
    expect(active.kind).toBe("active");
    if (active.kind !== "active") return;
    const atLimit = structuredClone(active.projection);
    atLimit.groups[0]!.areaCount = 2_048;
    atLimit.groups[0]!.omittedAreaCount = 2_045;
    expect(validateVolcanoAshfallProjection(atLimit)).toBeNull();
    const over = structuredClone(atLimit);
    over.groups[0]!.areaCount = 2_049;
    over.groups[0]!.omittedAreaCount = 2_046;
    expect(validateVolcanoAshfallProjection(over)).toBe("tooManyAreas");
    const malformed = structuredClone(active.projection);
    malformed.groups[0]!.topAreas = [null] as never;
    expect(() => validateVolcanoAshfallProjection(malformed)).not.toThrow();
    expect(validateVolcanoAshfallProjection(malformed)).toBe("invalidArea");
  });

  it("requires the canonical null representation for a missing persisted serial", () => {
    const active = classify(synthetic([period([area(1)])]));
    expect(active.kind).toBe("active");
    if (active.kind !== "active") return;
    const missing = structuredClone(active.projection);
    missing.revision.serial = null;
    expect(validateVolcanoAshfallProjection(missing)).toBeNull();
    const empty = structuredClone(missing);
    empty.revision.serial = "";
    expect(validateVolcanoAshfallProjection(empty)).toBe("invalidRevision");
    const absent = structuredClone(missing) as unknown as Record<string, unknown>;
    delete (absent.revision as Record<string, unknown>).serial;
    expect(validateVolcanoAshfallProjection(absent as unknown as typeof missing)).toBe("invalidRevision");
  });
});
