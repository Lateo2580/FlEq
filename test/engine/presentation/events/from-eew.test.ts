import { describe, it, expect, vi } from "vitest";
import { fromEewOutcome } from "../../../../src/engine/presentation/events/from-eew";
import { processEew } from "../../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../../src/engine/eew/eew-logger";
import { createMockWsDataMessage, FIXTURE_VXSE43_WARNING_S1 } from "../../../helpers/mock-message";
import { renderSummaryLine } from "../../../../src/ui/summary/summary-line";
import type { EewOutcome } from "../../../../src/engine/presentation/types";

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
  });
});

describe("fromEewOutcome To 基準一気通貫 (spec 4.5)", () => {
  /** 実 fixture 由来の EewOutcome を作り、areas だけ synthetic に差し替える */
  function outcomeWithAreas(
    areas: { name: string; intensity: string; intensityTo?: string }[]
  ): EewOutcome {
    const tracker = new EewTracker();
    const logger = new EewEventLogger();
    const msg = createMockWsDataMessage(FIXTURE_VXSE43_WARNING_S1);
    const result = processEew(msg, tracker, logger);
    if (result.kind !== "ok") throw new Error("processEew が ok を返さなかった");
    return {
      ...result.outcome,
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
    expect(event.forecastMaxInt).toBe("5-");
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
    expect(event.forecastMaxInt).toBe("5-");
    // 第二 assert: summary 行に悲観側の値が実際に出る (From の "4" 単独ではない)
    const line = renderSummaryLine(event, 120);
    expect(line).toContain("5-");
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
});
