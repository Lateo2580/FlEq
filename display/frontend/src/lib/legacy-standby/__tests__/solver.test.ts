import { describe, expect, it } from "vitest";
import { achievableSurplusUse, bestPlacement, comparePlacements, enumeratePlacements, makeColumnPlan, promoteAndExpand, solveRotation, type SolverContext } from "../solver";
import type { CardCandidate, ColumnPlan, PlacementChoice } from "../types";

function card(key: CardCandidate["key"], order: number, height: number, maxRegionRows = 0, score = 0): CardCandidate {
  return { key, order, score, variant: "compact", naturalHeight: height, centerNaturalHeight: height, maxRegionRows };
}

function committedPlan(left: CardCandidate[], right: CardCandidate[], center: CardCandidate[] = []): ColumnPlan {
  return {
    left, right, center, moved: new Set(), unresolved: false, centerUnresolved: false,
    stage: 0, variants: { quake: "compact", weather: "compact", typhoon: "compact" }, rotationKeys: [],
    rotationCurrentKey: null, rotationSlotHeight: 0, rotationFailureCount: 0, layoutFailure: false,
  };
}

function context(measureSelection: (choice: PlacementChoice, selection: Parameters<SolverContext["measureSelection"]>[1]) => number): SolverContext {
  return {
    measuredHeight: () => null,
    measureSelection: (choice, selection) => {
      const overflow = measureSelection(choice, selection);
      return { leftOverflowPx: overflow, rightOverflowPx: overflow, centerOverflowPx: overflow };
    },
    capacityPx: { left: 100, right: 100, center: 100 },
    centerFixedHeightPx: 0,
    floodIsWide: false,
    floodWidePromotionAllowed: false,
    candidateSupplyLimit: 128,
    rotationSlotHeight: () => 0,
    failureRowHeight: 0,
    gapPx: 0,
  };
}

describe("legacy standby solver", () => {
  it("handles empty, singleton, and wholly overflowing placement sets", () => {
    const ctx = context(() => 0);
    expect(bestPlacement([], ctx)).toBeNull();
    const only: PlacementChoice = { left: [card("quake", 0, 120)], right: [], center: [], moved: new Set() };
    expect(bestPlacement([only], ctx)).toBe(only);
    expect(makeColumnPlan({ candidates: only.left, ctx, floorStage: 0, requestedLadder: 0 }).unresolved).toBe(true);
  });

  it("reports a fixed-center overflow even when no eligible card occupies center", () => {
    const ctx = { ...context(() => 0), centerFixedHeightPx: 101 };
    const plan = makeColumnPlan({ candidates: [], ctx, floorStage: 0, requestedLadder: null });

    // With no rotation candidate, this remains the stage-2 fallback; r-f must
    // still receive unresolved=true and reduce the fixed cluster.
    expect(plan.stage).toBe(2);
    expect(plan.center).toEqual([]);
    expect(plan.centerUnresolved).toBe(true);
    expect(plan.unresolved).toBe(true);
  });

  it("prefers a fitting placement before every later comparator tier", () => {
    const fit: PlacementChoice = { left: [card("quake", 0, 100)], right: [], center: [], moved: new Set(["volcano"]) };
    const overflow: PlacementChoice = { left: [card("quake", 0, 101)], right: [], center: [], moved: new Set() };

    expect(comparePlacements(fit, overflow, context(() => 0))).toBeLessThan(0);
  });

  it("keeps a fitting committed surface when candidates and priorities are unchanged", () => {
    const quake = card("quake", 0, 60);
    const weather = card("weather", 1, 30);
    const volcano = card("volcano", 2, 30);
    const previousPlan = committedPlan([quake, weather], [volcano]);

    const plan = makeColumnPlan({
      candidates: [quake, weather, volcano], ctx: context(() => 0), floorStage: 0, requestedLadder: 0, previousPlan,
    });

    expect(plan.left.map((entry) => entry.key)).toEqual(["quake", "weather"]);
    expect(plan.right.map((entry) => entry.key)).toEqual(["volcano"]);
  });

  it("replaces a committed surface when its updated height overflows", () => {
    const quake = card("quake", 0, 60);
    const previousWeather = card("weather", 1, 30);
    const weather = card("weather", 1, 60);
    const volcano = card("volcano", 2, 30);
    const previousPlan = committedPlan([quake, previousWeather], [volcano]);

    const plan = makeColumnPlan({
      candidates: [quake, weather, volcano], ctx: context(() => 0), floorStage: 0, requestedLadder: null, previousPlan,
    });

    expect(plan.unresolved).toBe(false);
    expect(plan.left.map((entry) => entry.key)).toEqual(["quake"]);
    expect(plan.right.map((entry) => entry.key)).toEqual(["weather", "volcano"]);
  });

  it("retains remaining cards across a candidate removal", () => {
    const quake = card("quake", 0, 50);
    const weather = card("weather", 1, 50);
    const volcano = card("volcano", 2, 50);
    const previousPlan = committedPlan([quake], [weather, volcano]);

    const plan = makeColumnPlan({
      candidates: [quake, weather], ctx: context(() => 0), floorStage: 0, requestedLadder: 0, previousPlan,
    });

    expect(plan.left.map((entry) => entry.key)).toEqual(["quake"]);
    expect(plan.right.map((entry) => entry.key)).toEqual(["weather"]);
  });

  it("retains a fitting surface after a priority rise when no relocation is required", () => {
    const quake = card("quake", 0, 60);
    const previousWeather = card("weather", 1, 30, 0, 1);
    const weather = card("weather", 1, 30, 0, 2);
    const volcano = card("volcano", 2, 30);
    const previousPlan = committedPlan([quake, previousWeather], [volcano]);

    const plan = makeColumnPlan({
      candidates: [quake, weather, volcano], ctx: context(() => 0), floorStage: 0, requestedLadder: 0, previousPlan,
    });

    expect(plan.candidateScores?.weather).toBe(2);
    expect(plan.left.map((entry) => entry.key)).toEqual(["quake", "weather"]);
    expect(plan.right.map((entry) => entry.key)).toEqual(["volcano"]);
  });

  it("keeps a zero-move fitting plan ahead of a one-move balance improvement", () => {
    const quake = card("quake", 0, 60);
    const weather = card("weather", 1, 20);
    const volcano = card("volcano", 2, 20);
    const heat = card("heat", 3, 20);
    const previousPlan = committedPlan([quake, volcano], [weather]);

    const plan = makeColumnPlan({
      candidates: [quake, weather, volcano, heat], ctx: context(() => 0), floorStage: 0, requestedLadder: 0, previousPlan,
    });

    expect(plan.left.map((entry) => entry.key)).toEqual(["quake", "volcano"]);
    expect(plan.right.map((entry) => entry.key)).toEqual(["weather", "heat"]);
  });

  it("keeps a committed stage-3 rotation surface when candidates are unchanged", () => {
    const quake = card("quake", 0, 80);
    const weather = card("weather", 1, 10);
    const volcano = card("volcano", 2, 10);
    const heat = card("heat", 3, 50);
    const previousPlan: ColumnPlan = {
      ...committedPlan([quake, volcano], [weather]),
      stage: 3,
      rotationKeys: ["heat"],
      rotationCurrentKey: "heat",
      rotationSlotHeight: 50,
      candidateScores: { quake: 0, weather: 0, volcano: 0, heat: 0 },
    };
    const ctx = { ...context(() => 0), rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.includes("heat") ? 50 : 0 };

    const solution = solveRotation([quake, weather, volcano, heat], ctx, previousPlan);

    expect(solution.rotationKeys).toEqual(["heat"]);
    expect(solution.placement.left.map((entry) => entry.key)).toEqual(["quake", "volcano"]);
    expect(solution.placement.right.map((entry) => entry.key)).toEqual(["weather"]);
  });

  it("keeps a weather rotation when the earlier heat candidate also fits", () => {
    const quake = card("quake", 0, 80);
    const weather = card("weather", 1, 20);
    const heat = card("heat", 2, 20);
    const previousPlan: ColumnPlan = {
      ...committedPlan([quake], [heat]),
      stage: 3,
      rotationKeys: ["weather"],
      rotationCurrentKey: "weather",
      rotationSlotHeight: 20,
      candidateScores: { quake: 0, weather: 0, heat: 0 },
    };
    const ctx = { ...context(() => 0), rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.length === 0 ? 0 : 20 };

    const solution = solveRotation([quake, weather, heat], ctx, previousPlan);

    expect(solution.rotationKeys).toEqual(["weather"]);
    expect(solution.currentKey).toBe("weather");
    expect(solution.placement.left.map((entry) => entry.key)).toEqual(["quake"]);
    expect(solution.placement.right.map((entry) => entry.key)).toEqual(["heat"]);
  });

  it.each([
    { name: "a candidate is added", candidates: ["quake", "weather", "heat", "volcano"], weatherScore: 0 },
    { name: "weather priority rises", candidates: ["quake", "weather", "heat"], weatherScore: 1 },
  ] as const satisfies readonly { name: string; candidates: readonly CardCandidate["key"][]; weatherScore: number }[])("releases the committed rotation when $name", ({ candidates: candidateKeys, weatherScore }) => {
    const quake = card("quake", 0, 80);
    const weather = card("weather", 1, 20, 0, weatherScore);
    const heat = card("heat", 2, 20);
    const volcano = card("volcano", 3, 10);
    const previousPlan: ColumnPlan = {
      ...committedPlan([quake], [heat]),
      stage: 3,
      rotationKeys: ["weather"],
      rotationCurrentKey: "weather",
      rotationSlotHeight: 20,
      candidateScores: { quake: 0, weather: 0, heat: 0 },
    };
    const byKey = { quake, weather, heat, volcano } as const;
    const currentCandidates = candidateKeys.map((key) => byKey[key]);
    const ctx = { ...context(() => 0), rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.length === 0 ? 0 : 20 };

    const solution = solveRotation(currentCandidates, ctx, previousPlan);

    expect(solution.rotationKeys).toEqual(["heat"]);
  });

  it("orders two non-fitting placements by their total overflow", () => {
    const lessOverflow: PlacementChoice = { left: [card("quake", 0, 130)], right: [], center: [], moved: new Set() };
    const moreOverflow: PlacementChoice = { left: [card("quake", 0, 151)], right: [], center: [], moved: new Set() };

    expect(comparePlacements(lessOverflow, moreOverflow, context(() => 0))).toBeLessThan(0);
  });

  it("uses central overflow after total overflow and side balance are tied", () => {
    const sideOverflow: PlacementChoice = {
      left: [card("quake", 0, 120)], right: [card("weather", 1, 20)], center: [], moved: new Set(),
    };
    const centerOverflow: PlacementChoice = {
      left: [card("quake", 0, 100)], right: [], center: [card("weather", 1, 120)], moved: new Set(),
    };

    expect(comparePlacements(sideOverflow, centerOverflow, context(() => 0))).toBeLessThan(0);
  });

  it("prefers the ①'' counterfixture placement with the greater achievable expansion", () => {
    const quake = card("quake", 0, 80);
    const weather = card("weather", 1, 80, 4);
    const volcano = card("volcano", 2, 1);
    const high: PlacementChoice = { left: [quake, volcano], right: [weather], center: [], moved: new Set(["volcano"]) };
    const low: PlacementChoice = { left: [quake], right: [weather, volcano], center: [], moved: new Set() };
    const ctx = context((choice, selection) => selection.weatherRows === 0 || choice.left.some((entry) => entry.key === "volcano") ? 0 : 1);

    expect(achievableSurplusUse(high, ctx)).toBe(4);
    expect(achievableSurplusUse(low, ctx)).toBe(0);
    expect(comparePlacements(high, low, ctx)).toBeLessThan(0);
  });

  it("scans all B prefixes when an earlier prefix does not fit", () => {
    const quake = card("quake", 0, 20, 3);
    const plan: ColumnPlan = {
      left: [quake], right: [], center: [], moved: new Set(), unresolved: false, centerUnresolved: false,
      stage: 0, variants: { quake: "compact", weather: "compact", typhoon: "compact" }, rotationKeys: [],
      rotationCurrentKey: null, rotationSlotHeight: 0, rotationFailureCount: 0, layoutFailure: false,
    };
    const ctx = context((_, selection) => selection.quakeRows === 2 ? 0 : selection.quakeRows === 0 ? 0 : 1);

    expect(promoteAndExpand(plan, ctx).quakeRows).toBe(2);
  });

  it("cannot select a side wide flood when its budget would retain no detailed river", () => {
    const flood = card("flood", 0, 20);
    const plan: ColumnPlan = {
      left: [], right: [flood], center: [], moved: new Set(), unresolved: false, centerUnresolved: false,
      stage: 0, variants: { quake: "compact", weather: "compact", typhoon: "compact" }, rotationKeys: [],
      rotationCurrentKey: null, rotationSlotHeight: 0, rotationFailureCount: 0, layoutFailure: false,
    };
    const rejected = { ...context(() => 0), floodIsWide: true, floodWidePromotionAllowed: false };
    const eligible = { ...rejected, floodWidePromotionAllowed: true };

    expect(promoteAndExpand(plan, rejected).floodWide).toBe(false);
    expect(achievableSurplusUse({ left: [], right: [flood], center: [], moved: new Set() }, rejected)).toBe(0);
    expect(promoteAndExpand(plan, eligible).floodWide).toBe(true);
  });

  it("ranks rotation placements with the reserved slot height", () => {
    const candidates = [card("quake", 0, 40), card("weather", 1, 30), card("volcano", 2, 30), card("heat", 3, 50)];
    const ctx = { ...context(() => 0), rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.includes("heat") ? 50 : 0 };
    const solution = solveRotation(candidates, ctx);

    expect(solution.rotationKeys).toEqual(["heat"]);
    expect(solution.placement.left.map((entry) => entry.key)).toEqual(["quake", "volcano"]);
    expect(solution.placement.right.map((entry) => entry.key)).toEqual(["weather"]);
  });

  it("does not count B expansion that is consumed by a rotation reservation", () => {
    const quake = card("quake", 0, 20);
    const weather = card("weather", 1, 20, 3);
    const choice: PlacementChoice = { left: [quake], right: [weather], center: [], moved: new Set() };
    const ctx = context((_, selection) => -60 + selection.weatherRows * 20);

    expect(achievableSurplusUse(choice, ctx)).toBe(3);
    expect(achievableSurplusUse(choice, ctx, 50, 0)).toBe(0);
  });

  it("allows B expansion when only the right column has reserved slack", () => {
    const quake = card("quake", 0, 100);
    const weather = card("weather", 1, 20, 1);
    const choice: PlacementChoice = { left: [quake], right: [weather], center: [], moved: new Set() };
    const ctx: SolverContext = {
      ...context(() => 0),
      measureSelection: (_, selection) => ({
        leftOverflowPx: 0,
        rightOverflowPx: selection.weatherRows === 1 ? -10 : -30,
        centerOverflowPx: 0,
      }),
    };

    expect(achievableSurplusUse(choice, ctx, 10, 0)).toBe(1);
  });

  it("enumerates central subsets and makeColumnPlan selects a fitting plan", () => {
    const candidates = [card("quake", 0, 60), card("weather", 1, 60), card("volcano", 2, 20)];
    const ctx = context(() => 0);
    expect(enumeratePlacements(candidates, new Set(), true, true).some((choice) => choice.center.length === 2)).toBe(true);
    expect(bestPlacement(enumeratePlacements(candidates, new Set(), false, false), ctx)).not.toBeNull();
    expect(makeColumnPlan({ candidates, ctx, floorStage: 0, requestedLadder: null }).stage).toBe(0);
  });

  it("settles stage 1, explicit compressed stage 2, and stage 3 from measured card heights", () => {
    const candidates = [card("quake", 0, 60), card("weather", 1, 80), card("volcano", 2, 80), card("heat", 3, 80)];
    const stage1Ctx = { ...context(() => 0), capacityPx: { left: 100, right: 100, center: 200 } };
    expect(makeColumnPlan({ candidates, ctx: stage1Ctx, floorStage: 0, requestedLadder: null }).stage).toBe(1);
    expect(makeColumnPlan({ candidates, ctx: stage1Ctx, floorStage: 0, requestedLadder: 2 }).stage).toBe(2);
    const stage3Ctx = { ...context(() => 0), capacityPx: { left: 60, right: 60, center: 60 }, rotationSlotHeight: () => 40 };
    expect(makeColumnPlan({ candidates, ctx: stage3Ctx, floorStage: 0, requestedLadder: null }).stage).toBe(3);
  });

  it("does not emit an empty rotation stage when its reservation cannot fit", () => {
    const candidates = [card("quake", 0, 100), card("weather", 1, 100), card("heat", 2, 60)];
    const plan = makeColumnPlan({
      candidates,
      ctx: { ...context(() => 0), rotationSlotHeight: () => 150 },
      floorStage: 0,
      requestedLadder: 3,
    });

    expect(plan.stage).toBe(2);
    expect(plan.rotationKeys).toEqual([]);
    expect(plan.rotationSlotHeight).toBe(0);
    expect(plan.unresolved).toBe(false);
    expect([...plan.left, ...plan.right, ...plan.center].map((entry) => entry.key).sort()).toEqual(candidates.map((entry) => entry.key).sort());
  });

  it("uses compact typhoon measurements before escalating the ladder", () => {
    const typhoon: CardCandidate = {
      ...card("typhoon", 1, 120),
      measurements: {
        full: { naturalHeight: 120, centerNaturalHeight: 120 },
        compact: { naturalHeight: 35, centerNaturalHeight: 35 },
      },
    };
    const plan = makeColumnPlan({
      candidates: [card("quake", 0, 60), card("weather", 1, 60), { ...typhoon, order: 2 }],
      ctx: { ...context(() => 0), capacityPx: { left: 60, right: 95, center: 60 } },
      floorStage: 0,
      requestedLadder: null,
    });
    expect(plan.variants.typhoon).toBe("compact");
    expect(plan.stage).toBe(0);
    expect([...plan.left, ...plan.right, ...plan.center].some((entry) => entry.key === "typhoon")).toBe(true);
  });

  it("reports omitted rotation cards through the failure row", () => {
    const candidates = [card("quake", 0, 110), card("weather", 1, 20), card("heat", 2, 80)];
    const ctx = { ...context(() => 0), failureRowHeight: 20, rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.length === 0 ? 0 : 80 };
    const solution = solveRotation(candidates, ctx);
    expect(solution.failureCount).toBeGreaterThan(0);
  });

  it("tries all five rotation candidates before accepting the fifth-fit solution", () => {
    const candidates = [
      card("quake", 0, 80), card("weather", 1, 110), card("flood", 2, 110),
      card("typhoon", 3, 110), card("volcano", 4, 110), card("heat", 5, 110),
    ];
    const ctx = { ...context(() => 0), rotationSlotHeight: (keys: readonly CardCandidate["key"][]) => keys.length === 0 ? 0 : 20 };
    expect(solveRotation(candidates, ctx).rotationKeys).toEqual(["weather", "flood", "typhoon", "volcano", "heat"]);
  });

  it("applies lexicographic center, wide-flood, surplus, maximum-height, then balance ordering", () => {
    const quake = card("quake", 0, 40);
    const flood = card("flood", 1, 20);
    const weather = card("weather", 2, 20, 1);
    const ctx = { ...context((choice, selection) => choice.left.some((entry) => entry.key === "weather") && selection.weatherRows > 0 ? 1 : 0), floodIsWide: true, floodWidePromotionAllowed: true };
    const fewerCenter: PlacementChoice = { left: [quake], right: [flood, weather], center: [], moved: new Set() };
    const moreCenter: PlacementChoice = { left: [quake], right: [weather], center: [flood], moved: new Set() };
    const wideCenter: PlacementChoice = { left: [quake], right: [weather], center: [flood], moved: new Set() };
    const plainCenter: PlacementChoice = { left: [quake], right: [flood], center: [weather], moved: new Set() };
    expect(comparePlacements(fewerCenter, moreCenter, ctx)).toBeLessThan(0);
    expect(comparePlacements(wideCenter, plainCenter, ctx)).toBeLessThan(0);
  });

  it("applies each post-surplus comparator tier independently", () => {
    const sixty = card("quake", 0, 60);
    const forty = card("weather", 1, 40);
    const twenty = card("volcano", 2, 20);
    const ctx = context(() => 0);
    const lowerMaximum: PlacementChoice = { left: [sixty], right: [forty], center: [], moved: new Set() };
    const higherMaximum: PlacementChoice = { left: [sixty, twenty], right: [forty], center: [], moved: new Set() };
    expect(comparePlacements(lowerMaximum, higherMaximum, ctx)).toBeLessThan(0);

    const unbalanced: PlacementChoice = { left: [sixty], right: [forty], center: [], moved: new Set() };
    const balanced: PlacementChoice = { left: [sixty], right: [forty, twenty], center: [], moved: new Set() };
    // Keep the maximum side equal, so the next (balance) tier decides.
    const balanceCtx = { ...ctx, capacityPx: { left: 120, right: 120, center: 120 } };
    expect(comparePlacements(balanced, unbalanced, balanceCtx)).toBeLessThan(0);

    const fewerMoved: PlacementChoice = { left: [sixty], right: [forty], center: [], moved: new Set() };
    const moreMoved: PlacementChoice = { left: [sixty], right: [forty], center: [], moved: new Set(["volcano"]) };
    expect(comparePlacements(fewerMoved, moreMoved, ctx)).toBeLessThan(0);

    const lexicalLeft: PlacementChoice = { left: [sixty], right: [forty], center: [], moved: new Set() };
    const lexicalRight: PlacementChoice = { left: [forty], right: [sixty], center: [], moved: new Set() };
    expect(comparePlacements(lexicalLeft, lexicalRight, ctx)).toBeLessThan(0);
  });
});
