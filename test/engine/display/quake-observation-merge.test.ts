import { describe, expect, it } from "vitest";
import type { JmaIntensity, SpecialValue } from "../../../src/types";
import type {
  DisplayLatestQuakeInputV1,
  DisplayRecentQuakeV1,
} from "../../../src/engine/display/types";
import {
  mergeLatestQuakeObservation,
  mergeRecentQuakeObservation,
  quakeObservationMetaOf,
  withQuakeObservationMeta,
} from "../../../src/engine/display/quake-observation-merge";
import { projectIntensitySemantic } from "../../../src/engine/display/intensity-groups";

function special(
  presence: SpecialValue<JmaIntensity>["presence"],
): SpecialValue<JmaIntensity> {
  if (presence === "value") {
    return {
      raw: "4", value: "4", condition: null, description: null, presence,
    };
  }
  if (presence === "qualitative") {
    return {
      raw: "", value: null, condition: "5弱以上未入電", description: null,
      presence, lowerBound: "5-",
    };
  }
  return {
    raw: presence === "missing" ? null : "",
    value: null,
    condition: presence === "unknown" ? "未入電" : null,
    description: null,
    presence,
  };
}

function recent(
  sourceType: string,
  maxIntValue: SpecialValue<JmaIntensity>,
  overrides: Partial<DisplayRecentQuakeV1> & {
    resolvedTrigger?: "explicitCancellation" | null;
    cancellationPolicy?: "markCancelled" | null;
    intensityStructureMissing?: boolean;
    infoType?: string;
  } = {},
) {
  const {
    resolvedTrigger = null,
    cancellationPolicy = "markCancelled",
    intensityStructureMissing = maxIntValue.presence === "missing",
    infoType = "発表",
    ...displayOverrides
  } = overrides;
  const display: DisplayRecentQuakeV1 = {
    eventId: "Q1",
    reportDateTime: "2026-08-01T12:00:00+09:00",
    originTime: "2026-08-01T11:59:00+09:00",
    hypocenterName: "震源",
    magnitude: "4.0",
    maxInt: maxIntValue.presence === "value" ? maxIntValue.value : null,
    maxIntRank: maxIntValue.presence === "value" ? 4 : null,
    depth: "10km",
    tsunamiWarning: false,
    intensityGroups: maxIntValue.presence === "value"
      ? [{ intensity: "4", rank: 4, areas: ["地域A"], omittedAreaCount: 0 }]
      : [],
    ...displayOverrides,
  };
  return withQuakeObservationMeta(display, {
    sourceType,
    observationSourceType: sourceType,
    infoType,
    resolvedTrigger,
    cancellationPolicy,
    intensityStructureMissing,
    maxIntValue,
  });
}

describe("quake-observation-merge SpecialValue contract", () => {
  it.each(["VXSE52", "VXSE61"])(
    "VXSE51→%s の構造的 missing だけ観測値を保持し、震源諸元は後報を採る",
    (sourceType) => {
      const previous = recent("VXSE51", special("value"));
      const next = recent(sourceType, special("missing"), {
        reportDateTime: "2026-08-01T12:01:00+09:00",
        hypocenterName: "更新震源",
        magnitude: "5.2",
        depth: "20km",
      });
      const merged = mergeRecentQuakeObservation(previous, next);
      expect(merged).toMatchObject({
        maxInt: "4",
        maxIntRank: 4,
        hypocenterName: "更新震源",
        magnitude: "5.2",
        depth: "20km",
        intensityGroups: [{ intensity: "4", areas: ["地域A"] }],
      });
      expect(quakeObservationMetaOf(merged)).toMatchObject({
        sourceType,
        observationSourceType: "VXSE51",
        maxIntValue: { presence: "value", value: "4" },
      });
    },
  );

  it("VXSE51 observation 保持時は後報 missing semantic を残さない", () => {
    const previous = recent("VXSE51", special("value"));
    const missing = special("missing");
    const next = recent("VXSE52", missing, {
      maxIntSemantic: projectIntensitySemantic(missing),
    });
    const merged = mergeRecentQuakeObservation(previous, next);
    expect(merged).toMatchObject({ maxInt: "4", maxIntRank: 4 });
    expect(merged.maxIntSemantic).toBeUndefined();
    expect(quakeObservationMetaOf(merged)?.maxIntValue).toMatchObject({
      presence: "value", value: "4",
    });
  });

  it.each(["unknown", "empty", "qualitative"] as const)(
    "後報が %s なら旧観測値を保持せず明示状態へ置換する",
    (presence) => {
      const merged = mergeRecentQuakeObservation(
        recent("VXSE51", special("value")),
        recent("VXSE52", special(presence)),
      );
      expect(merged).toMatchObject({ maxInt: null, maxIntRank: null, intensityGroups: [] });
      expect(quakeObservationMetaOf(merged)?.maxIntValue.presence).toBe(presence);
    },
  );

  it("取消は missing として保持せず取消 projection を返す", () => {
    const next = recent("VXSE52", special("missing"), {
      resolvedTrigger: "explicitCancellation",
      infoType: "取消",
    });
    const merged = mergeRecentQuakeObservation(recent("VXSE51", special("value")), next);
    expect(merged).toMatchObject({
      maxInt: "4",
      maxIntRank: 4,
      reportDateTime: next.reportDateTime,
    });
    expect(quakeObservationMetaOf(merged)).toMatchObject({
      sourceType: "VXSE52",
      observationSourceType: "VXSE51",
      resolvedTrigger: "explicitCancellation",
      cancellationPolicy: "markCancelled",
      infoType: "取消",
    });
  });

  it("cancelled observation provenance cannot preserve into a later structural missing report", () => {
    const cancelled = mergeRecentQuakeObservation(
      recent("VXSE51", special("value")),
      recent("VXSE52", special("missing"), {
        resolvedTrigger: "explicitCancellation",
        infoType: "取消",
      }),
    );
    const merged = mergeRecentQuakeObservation(
      cancelled,
      recent("VXSE61", special("missing")),
    );
    expect(merged).toMatchObject({ maxInt: null, maxIntRank: null, intensityGroups: [] });
    expect(quakeObservationMetaOf(merged)?.maxIntValue.presence).toBe("missing");
  });

  it("全体 MaxInt missing でも Area/City が明示なら intensityGroups を保持しない", () => {
    const next = recent("VXSE52", special("missing"), { intensityStructureMissing: false });
    const merged = mergeRecentQuakeObservation(recent("VXSE51", special("value")), next);
    expect(merged).toBe(next);
    expect(merged).toMatchObject({ maxInt: null, maxIntRank: null, intensityGroups: [] });
  });

  it.each([
    ["EventID 不一致", { eventId: "Q2" }, "VXSE51", "VXSE52"],
    ["EventID 欠落", { eventId: null }, "VXSE51", "VXSE52"],
    ["前報 source が VXSE51 以外", {}, "VXSE53", "VXSE52"],
    ["後報 source が VXSE52/61 以外", {}, "VXSE51", "VXSE53"],
  ] as const)("%s では観測値を持ち越さない", (_label, overrides, previousType, nextType) => {
    const merged = mergeRecentQuakeObservation(
      recent(previousType, special("value")),
      recent(nextType, special("missing"), overrides),
    );
    expect(merged).toMatchObject({ maxInt: null, maxIntRank: null, intensityGroups: [] });
    expect(quakeObservationMetaOf(merged)?.maxIntValue.presence).toBe("missing");
  });

  it("訂正で震度が明示された場合は訂正値へ置換する", () => {
    const correctedValue: SpecialValue<JmaIntensity> = {
      raw: "3", value: "3", condition: null, description: null, presence: "value",
    };
    const corrected = recent("VXSE52", correctedValue, {
      infoType: "訂正",
      maxInt: "3",
      maxIntRank: 3,
      intensityGroups: [{ intensity: "3", rank: 3, areas: ["地域B"], omittedAreaCount: 0 }],
    });
    const merged = mergeRecentQuakeObservation(recent("VXSE51", special("value")), corrected);
    expect(merged).toMatchObject({
      maxInt: "3",
      maxIntRank: 3,
      intensityGroups: [{ intensity: "3", areas: ["地域B"] }],
    });
  });

  it("VXSE51 provenance は複数の missing VXSE52/61 をまたいで維持する", () => {
    const first = recent("VXSE51", special("value"));
    const second = mergeRecentQuakeObservation(first, recent("VXSE52", special("missing")));
    const third = mergeRecentQuakeObservation(second, recent("VXSE61", special("missing")));
    expect(third.maxInt).toBe("4");
    expect(quakeObservationMetaOf(third)).toMatchObject({
      sourceType: "VXSE61",
      observationSourceType: "VXSE51",
      maxIntValue: { presence: "value" },
    });
  });

  it("latest と recent は同じ helper 規則になる", () => {
    const previousRecent = recent("VXSE51", special("value"));
    const nextRecent = recent("VXSE52", special("missing"), { hypocenterName: "更新震源" });
    const previousLatest = withQuakeObservationMeta({
      eventId: previousRecent.eventId,
      headline: null,
      originTime: previousRecent.originTime,
      hypocenterName: previousRecent.hypocenterName,
      depth: previousRecent.depth,
      magnitude: previousRecent.magnitude,
      maxInt: previousRecent.maxInt,
      maxIntRank: previousRecent.maxIntRank,
      tsunamiWarning: previousRecent.tsunamiWarning,
      intensityGroups: previousRecent.intensityGroups ?? [],
      reportDateTime: previousRecent.reportDateTime,
    }, quakeObservationMetaOf(previousRecent)!);
    const nextLatest: DisplayLatestQuakeInputV1 = withQuakeObservationMeta({
      eventId: nextRecent.eventId,
      headline: null,
      originTime: nextRecent.originTime,
      hypocenterName: nextRecent.hypocenterName,
      depth: nextRecent.depth,
      magnitude: nextRecent.magnitude,
      maxInt: nextRecent.maxInt,
      maxIntRank: nextRecent.maxIntRank,
      tsunamiWarning: nextRecent.tsunamiWarning,
      intensityGroups: nextRecent.intensityGroups ?? [],
      reportDateTime: nextRecent.reportDateTime,
    }, quakeObservationMetaOf(nextRecent)!);
    const latest = mergeLatestQuakeObservation(
      { ...previousLatest, updatedAtMs: 1 },
      nextLatest,
    );
    const recentMerged = mergeRecentQuakeObservation(previousRecent, nextRecent);
    expect(latest.maxInt).toBe(recentMerged.maxInt);
    expect(latest.intensityGroups).toEqual(recentMerged.intensityGroups);
    expect(quakeObservationMetaOf(latest)).toEqual(quakeObservationMetaOf(recentMerged));
  });
});
