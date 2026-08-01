import { describe, it, expect, vi } from "vitest";
import { fromEewOutcome } from "../../../../src/engine/presentation/events/from-eew";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { createMockWsDataMessage, FIXTURE_VXSE43_WARNING_S1 } from "../../../helpers/mock-message";
import { renderSummaryLine } from "../../../../src/ui/summary/summary-line";
import type { EewOutcome } from "../../../../src/engine/presentation/types";
import type { JmaIntensity, ParsedEewInfo, SpecialValue } from "../../../../src/types";

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    appendFileSync: vi.fn(),
    existsSync: (p: string) => {
      if (typeof p === "string" && p.includes("eew-logs")) return true;
      return actual.existsSync(p);
    },
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      appendFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

describe("fromEewOutcome", () => {
  it("EewOutcome → PresentationEvent", () => {
    const tracker = new EewTracker();
    const logger = new EewEventLogger();
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, tracker, logger);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    const outcome = result.outcome;
    const event = fromEewOutcome(outcome);

    expect(event.domain).toBe("eew");
    expect(event.id).toBe(msg.id);
    expect(event.isWarning).toBe(true);
    expect(event.frameLevel).toBe("critical");
    expect(event.raw).toBe(outcome.parsed);
    expect(event.stateSnapshot?.kind).toBe("eew");
    expect(event.isCancellation).toBe(false);
    expect(event.originTime).toBe(outcome.parsed.earthquake?.originTime ?? null);
  });
});

describe("fromEewOutcome To 基準一気通貫 (spec 4.5)", () => {
  /** 実 fixture 由来の EewOutcome を作り、areas だけ synthetic に差し替える */
  function outcomeWithAreas(
    areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"],
  ): EewOutcome {
    const tracker = new EewTracker();
    const logger = new EewEventLogger();
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, tracker, logger);
    if (result.kind !== "ok") throw new Error("processEew が ok を返さなかった");
    const {
      currentForecastIntensity: _fixtureForecast,
      effectiveForecastSafetyRank: _fixtureSafetyRank,
      ...eewResult
    } = result.outcome.eewResult;
    return {
      ...result.outcome,
      eewResult,
      parsed: {
        ...result.outcome.parsed,
        forecastIntensity: { areas },
      },
    };
  }

  it("forecastMaxInt が To 基準 (intensityTo ?? intensity) で算出される", () => {
    const outcome = outcomeWithAreas([
      { name: "南部", intensity: "4" },
      { name: "北部", intensity: "4", intensityTo: "5-" },
    ]);
    const event = fromEewOutcome(outcome);
    expect(event.forecastMaxInt).toBe("4〜5-");
    expect(event.forecastMaxIntRank).toBe(5);
    // per-area の areaItems.maxInt は raw From のまま (生値保持)
    expect(event.areaItems.find((a) => a.name === "北部")?.maxInt).toBe("4");
  });

  it("compact summary 行: renderSummaryLine まで通して悲観側最大震度が乗る", () => {
    const outcome = outcomeWithAreas([
      { name: "南部", intensity: "4" },
      { name: "北部", intensity: "4", intensityTo: "5-" },
    ]);
    const event = fromEewOutcome(outcome);
    // 第一 assert: event の値そのもの (summary 表記に依存しない)
    expect(event.forecastMaxInt).toBe("4〜5-");
    // 第二 assert: summary 行に悲観側の値が実際に出る (From の "4" 単独ではない)
    const line = renderSummaryLine(event, 120);
    expect(line).toContain("4〜5-");
  });

  it("eewRegions が forecastIntensity.areas の詳細 (PLUM/到達済/範囲上限/到達時刻) をそのまま運ぶ (Phase A #3)", () => {
    const outcome = outcomeWithAreas([
      { name: "南部", intensity: "4" },
      { name: "北部", intensity: "4", intensityTo: "5-" },
    ]);
    // PLUM/到達/到達時刻は outcomeWithAreas の型に無いので直接 parsed を上書きする
    const outcomeWithDetail = {
      ...outcome,
      parsed: {
        ...outcome.parsed,
        forecastIntensity: {
          maxLgInt: "3",
          areas: [
            { name: "南部", intensity: "4" },
            {
              name: "北部",
              intensity: "4",
              intensityTo: "5-",
              isPlum: true,
              hasArrived: true,
              arrivalTime: "2026-07-07T10:00:30+09:00",
            },
          ],
        },
      },
    };
    const event = fromEewOutcome(outcomeWithDetail);
    expect(event.maxLgInt).toBe("3");
    expect(event.eewRegions).toEqual([
      { name: "南部", intensity: "4", intensityTo: null, isPlum: false, hasArrived: false, arrivalTime: null },
      {
        name: "北部", intensity: "4", intensityTo: "5-", isPlum: true, hasArrived: true,
        arrivalTime: "2026-07-07T10:00:30+09:00",
      },
    ]);
  });

  const special = (
    value: Partial<SpecialValue<JmaIntensity>>,
  ): SpecialValue<JmaIntensity> => ({
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...value,
  });

  it.each([
    ["plain 未入電", special({ raw: "", condition: "未入電", presence: "unknown" }), "未入電", null],
    ["5弱以上未入電", special({
      raw: "",
      condition: "5弱以上未入電",
      description: "予測震度は5弱以上",
      presence: "qualitative",
      lowerBound: "5-",
    }), "5弱以上未入電", 5],
  ] as const)("SpecialValue safety を presentation へ貫通する: %s", (_label, intensityValue, label, rank) => {
    const event = fromEewOutcome(outcomeWithAreas([{
      name: "対象地域",
      intensity: "",
      intensityValue,
    }]));
    expect(event.maxIntValue).toBe(intensityValue);
    expect(event.forecastMaxInt).toBe(label);
    expect(event.forecastMaxIntRank).toBe(rank);
    expect(event.areaItems[0]).toMatchObject({ maxInt: "", maxIntValue: intensityValue });
  });

  it("unknown 続報は表示 snapshot を置換し、既存 known safety rank だけを維持する", () => {
    const unknown = special({ raw: "", condition: "未入電", presence: "unknown" });
    const outcome = outcomeWithAreas([{ name: "対象地域", intensity: "", intensityValue: unknown }]);
    const previousInfo: ParsedEewInfo = {
      ...outcome.parsed,
      forecastIntensity: { areas: [{ name: "対象地域", intensity: "6-" }] },
    };
    const event = fromEewOutcome({
      ...outcome,
      eewResult: { ...outcome.eewResult, previousInfo, effectiveForecastSafetyRank: 7 },
    });
    expect(event.maxIntValue).toBe(unknown);
    expect(event.forecastMaxInt).toBe("未入電");
    expect(event.forecastMaxIntRank).toBe(7);
  });

  it("閾値未満 known と unknown が混在する続報でも既存 known safety scalar を降格させない", () => {
    const unknown = special({ raw: "", condition: "未入電", presence: "unknown" });
    const outcome = outcomeWithAreas([
      { name: "既知地域", intensity: "4" },
      { name: "未入電地域", intensity: "", intensityValue: unknown },
    ]);
    const previousInfo: ParsedEewInfo = {
      ...outcome.parsed,
      forecastIntensity: { areas: [{ name: "対象地域", intensity: "6-" }] },
    };
    const event = fromEewOutcome({
      ...outcome,
      eewResult: { ...outcome.eewResult, previousInfo, effectiveForecastSafetyRank: 7 },
    });
    expect(event.forecastMaxInt).toBe("4以上の可能性・一部不明");
    expect(event.forecastMaxIntRank).toBe(7);
    expect(event.areaItems.find(({ name }) => name === "未入電地域")?.maxIntValue).toBe(unknown);
  });

  it("地域なし EEW も全体 maxIntValue を評価し、表示 scalar と safety rank を保持する", () => {
    const overall = special({
      raw: "4",
      presence: "range",
      lowerBound: "4",
      upperBound: "5-",
      rawLowerBound: "4",
      rawUpperBound: "5-",
    });
    const outcome = outcomeWithAreas([]);
    const event = fromEewOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        forecastIntensity: { maxInt: "4", maxIntValue: overall, areas: [] },
      },
    });
    expect(event.maxIntValue).toBe(overall);
    expect(event.forecastMaxInt).toBe("4〜5-");
    expect(event.forecastMaxIntRank).toBe(5);
  });

  it("全体 maxIntValue は presentation に保持し、地域別値と同じ safety helper で評価する", () => {
    const overall = special({
      raw: "4",
      condition: "予測幅",
      presence: "range",
      lowerBound: "4",
      upperBound: "5-",
      rawLowerBound: "4",
      rawUpperBound: "5-",
    });
    const outcome = outcomeWithAreas([{ name: "地域", intensity: "4" }]);
    const event = fromEewOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        forecastIntensity: {
          maxInt: "4",
          maxIntValue: overall,
          areas: [{ name: "地域", intensity: "4" }],
        },
      },
    });
    expect(event.maxIntValue).toBe(overall);
    expect(event.forecastMaxInt).toBe("4〜5-");
    expect(event.forecastMaxIntRank).toBe(5);
  });

  it("親 Area/Condition を booleans と併読して PLUM・到達済み qualifier を維持する", () => {
    const event = fromEewOutcome(outcomeWithAreas([
      { name: "PLUM地域", intensity: "4", condition: " PLUM 法による予測 " },
      { name: "到達地域", intensity: "5-", condition: "既に 主要動到達 と推測" },
    ]));
    expect(event.eewRegions).toMatchObject([
      { name: "PLUM地域", isPlum: true, hasArrived: false },
      { name: "到達地域", isPlum: false, hasArrived: true },
    ]);
  });
});
