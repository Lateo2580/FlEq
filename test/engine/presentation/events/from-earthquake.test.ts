import { describe, it, expect, vi } from "vitest";
import { fromEarthquakeOutcome, resolveEarthquakeTsunamiWarning } from "../../../../src/engine/presentation/events/from-earthquake";
import { processEarthquake } from "../../../../src/engine/presentation/processors/process-earthquake";
import { projectRecentQuake } from "../../../../src/engine/display/project-event";
import { buildTickerSentence } from "../../../../src/engine/display/ticker-sentence";
import * as log from "../../../../src/logger";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_FIXED_COMMENT,
} from "../../../helpers/mock-message";
import type { EarthquakeOutcome } from "../../../../src/engine/presentation/types";
import type { JmaIntensity, SpecialValue } from "../../../../src/types";

describe("resolveEarthquakeTsunamiWarning", () => {
  it("text が null なら false", () => {
    expect(resolveEarthquakeTsunamiWarning(null)).toBe(false);
  });

  it("text が undefined なら false", () => {
    expect(resolveEarthquakeTsunamiWarning(undefined)).toBe(false);
  });

  it("text が空文字なら false", () => {
    expect(resolveEarthquakeTsunamiWarning("")).toBe(false);
  });

  it("text が空白のみ (全角空白含む) なら false", () => {
    expect(resolveEarthquakeTsunamiWarning("　 ")).toBe(false);
  });

  it("「この地震による津波の心配はありません」は false", () => {
    expect(resolveEarthquakeTsunamiWarning("この地震による津波の心配はありません")).toBe(false);
  });

  it("「津波の心配はありません。」は false", () => {
    expect(resolveEarthquakeTsunamiWarning("津波の心配はありません。")).toBe(false);
  });

  it("「今後の情報に注意してください。」は津波への言及がないため false", () => {
    expect(resolveEarthquakeTsunamiWarning("今後の情報に注意してください。")).toBe(false);
  });

  it("「若干の海面変動があるかもしれませんが被害の心配はありません」は false", () => {
    expect(
      resolveEarthquakeTsunamiWarning("若干の海面変動があるかもしれませんが被害の心配はありません"),
    ).toBe(false);
  });

  it("「津波警報を発表中です」は true", () => {
    expect(resolveEarthquakeTsunamiWarning("津波警報を発表中です")).toBe(true);
  });

  it("「津波警報等（大津波警報・津波警報あるいは津波注意報）を発表しました」は true", () => {
    expect(
      resolveEarthquakeTsunamiWarning("津波警報等（大津波警報・津波警報あるいは津波注意報）を発表しました"),
    ).toBe(true);
  });
});

describe("fromEarthquakeOutcome", () => {
  function outcomeFromFixture(): EarthquakeOutcome {
    const msg = createMockWsDataMessage(FIXTURE_VXSE53_ENCHI);
    const outcome = processEarthquake(msg);
    if (outcome == null) throw new Error("processEarthquake が null を返した");
    return outcome;
  }

  function outcomeFromDrillFixture(): EarthquakeOutcome {
    const outcome = processEarthquake(
      createMockWsDataMessage(FIXTURE_VXSE53_DRILL_1),
    );
    if (outcome == null) throw new Error("processEarthquake が null を返した");
    return outcome;
  }

  it("tsunami.text が「心配はありません」を含む実 fixture では tsunamiWarning=false になる", () => {
    const event = fromEarthquakeOutcome(outcomeFromFixture());
    expect(event.tsunamiWarning).toBe(false);
  });

  it("Magnitude/Depth canonical を scalar と並行して PresentationEvent へ渡す", () => {
    const outcome = outcomeFromFixture();
    const event = fromEarthquakeOutcome(outcome);
    expect(event.magnitudeValue).toEqual(outcome.parsed.earthquake?.magnitudeValue);
    expect(event.depthValue).toEqual(outcome.parsed.earthquake?.depthValue);
  });

  it("tsunami.text が津波警報言及を含む場合は tsunamiWarning=true になる (Phase A #2)", () => {
    const outcome = outcomeFromFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: { ...outcome.parsed, tsunami: { text: "津波警報を発表中です" } },
    });
    expect(event.tsunamiWarning).toBe(true);
  });

  it("VXSE51 の固定付加文は parser→presentation で tsunamiWarning=false になる", () => {
    const outcome = processEarthquake(createMockWsDataMessage(FIXTURE_VXSE51_FIXED_COMMENT));
    expect(outcome).not.toBeNull();
    expect(outcome!.parsed.tsunami?.text).toBe("今後の情報に注意してください。");
    expect(fromEarthquakeOutcome(outcome!).tsunamiWarning).toBe(false);
  });

  it("intensity.maxLgInt を PresentationEvent.maxLgInt にそのまま渡す", () => {
    const outcome = outcomeFromFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        intensity: {
          ...(outcome.parsed.intensity ?? { maxInt: "3", areas: [], municipalities: [] }),
          maxLgInt: "3",
        },
      },
    });
    expect(event.maxLgInt).toBe("3");
  });

  it("最大震度と長周期階級の SpecialValue を PresentationEvent へ保持する", () => {
    const outcome = outcomeFromDrillFixture();
    const event = fromEarthquakeOutcome(outcome);
    expect(event.maxIntValue).toEqual(outcome.parsed.intensity?.maxIntValue);
    expect(event.maxIntValue).toMatchObject({ presence: "value" });
    expect(event.areaItems[0]?.maxIntValue).toMatchObject({ presence: "value" });
  });

  it("非 exact 最大震度の表示 label を PresentationEvent へ貫通させる", () => {
    const outcome = outcomeFromDrillFixture();
    const maxIntValue: SpecialValue<JmaIntensity> = {
      raw: "",
      value: null,
      condition: "5弱以上未入電",
      description: null,
      presence: "qualitative",
      lowerBound: "5-",
    };
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        intensity: { ...outcome.parsed.intensity!, maxInt: "", maxIntValue },
      },
    });
    expect(event.maxInt).toBeNull();
    expect(event.maxIntLabel).toBe("5弱以上未入電");
  });

  it("Area/City の非 exact SpecialValue を発火用 quakeIntensity と独立して保持する", () => {
    const outcome = outcomeFromDrillFixture();
    const unknown = {
      raw: "未入電",
      value: null,
      condition: "未入電",
      description: "観測値未入電",
      presence: "unknown" as const,
    };
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        intensity: {
          ...outcome.parsed.intensity!,
          areas: [{ name: "地域A", code: "440", intensity: "", intensityValue: unknown }],
          municipalities: [{ name: "市A", code: "4400001", intensity: "", intensityValue: unknown }],
        },
      },
    });

    expect(event.quakeIntensityValues).toEqual({
      localAreas: [{ name: "地域A", code: "440", maxIntValue: unknown }],
      municipalities: [{ name: "市A", code: "4400001", maxIntValue: unknown }],
    });
    expect(event.quakeIntensity?.localAreas).toEqual([]);
    expect(event.quakeIntensity?.municipalities).toEqual([]);
  });

  it("一次細分・市町村codeとrankをquakeIntensityへ通し、既存areaItemsは一次細分のまま維持する", () => {
    const outcome = outcomeFromDrillFixture();
    const event = fromEarthquakeOutcome(outcome);

    expect(event.areaItems).toContainEqual(
      expect.objectContaining({ name: "静岡県伊豆", code: "440", maxInt: "5-" }),
    );
    expect(event.quakeIntensity?.localAreas).toContainEqual(expect.objectContaining({
      name: "静岡県伊豆",
      code: "440",
      maxInt: "5-",
      maxIntRank: 5,
      maxIntValue: expect.objectContaining({ presence: "value", value: "5-" }),
    }));
    expect(event.quakeIntensity?.municipalities).toContainEqual(expect.objectContaining({
      name: "西伊豆町",
      code: "2230600",
      maxInt: "5-",
      maxIntRank: 5,
      maxIntValue: expect.objectContaining({ presence: "value", value: "5-" }),
    }));
    expect(event.areaItems.some(({ code }) => code === "2230600")).toBe(false);
    expect(event.municipalityNames).toEqual(
      outcome.parsed.intensity?.municipalities.map(({ name }) => name),
    );
    expect(event.municipalityCount).toBe(event.municipalityNames.length);
  });

  it("code欠落itemを文字一覧に残してquakeIntensityから除外し、取消では生成しない", () => {
    const outcome = outcomeFromDrillFixture();
    const intensity = {
      maxInt: "4",
      areas: [{ name: "codeなし細分", code: null, intensity: "4" }],
      municipalities: [{ name: "codeなし市町村", code: null, intensity: "3" }],
    };
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: { ...outcome.parsed, intensity },
    });
    expect(event.areaNames).toEqual(["codeなし細分"]);
    expect(event.areaItems).toEqual([
      expect.objectContaining({
        name: "codeなし細分",
        maxInt: "4",
        maxIntValue: expect.objectContaining({ presence: "value", value: "4" }),
      }),
    ]);
    expect(event.quakeIntensity?.localAreas).toEqual([]);
    expect(event.quakeIntensity?.municipalities).toEqual([]);

    const cancelled = fromEarthquakeOutcome({
      ...outcome,
      parsed: { ...outcome.parsed, infoType: "取消", intensity },
    });
    expect(cancelled.quakeIntensity).toBeUndefined();
  });

  it("最大震度2以下は文字一覧を維持しつつ地図候補を生成しない", () => {
    const outcome = outcomeFromDrillFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        intensity: {
          maxInt: "2",
          areas: [{ name: "細分", code: "001", intensity: "2" }],
          municipalities: [{ name: "市町村", code: "0010001", intensity: "2" }],
        },
      },
    });
    expect(event.areaNames).toEqual(["細分"]);
    expect(event.municipalityNames).toEqual(["市町村"]);
    expect(event.quakeIntensity).toBeUndefined();
  });

  it("重複codeは文字出力を維持し、quakeIntensityだけ最大rankへ集約する", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const outcome = outcomeFromDrillFixture();
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: {
        ...outcome.parsed,
        earthquake: {
          ...outcome.parsed.earthquake!,
          hypocenterName: "重複試験震源",
        },
        intensity: {
          maxInt: "4",
          areas: [
            { name: "細分・旧", code: "440", intensity: "3" },
            { name: "細分・新A", code: "440", intensity: "4" },
            { name: "細分・新B", code: "440", intensity: "4" },
            { name: "codeなし細分", code: null, intensity: "4" },
          ],
          municipalities: [
            { name: "市町村・旧", code: "2230600", intensity: "3" },
            { name: "市町村・新", code: "2230600", intensity: "4" },
          ],
        },
      },
    });

    expect(event.areaNames).toEqual([
      "細分・旧",
      "細分・新A",
      "細分・新B",
      "codeなし細分",
    ]);
    expect(event.areaItems).toEqual([
      expect.objectContaining({ name: "細分・旧", code: "440", maxInt: "3" }),
      expect.objectContaining({ name: "細分・新A", code: "440", maxInt: "4" }),
      expect.objectContaining({ name: "細分・新B", code: "440", maxInt: "4" }),
      expect.objectContaining({ name: "codeなし細分", maxInt: "4" }),
    ]);
    expect(projectRecentQuake(event)?.intensityGroups).toEqual([
      {
        intensity: "4",
        rank: 4,
        areas: ["細分・新A", "細分・新B", "codeなし細分"],
        omittedAreaCount: 0,
        expandedAreas: ["細分・新A", "細分・新B", "codeなし細分"],
        candidateTruncated: false,
      },
      {
        intensity: "3", rank: 3, areas: ["細分・旧"], omittedAreaCount: 0,
        expandedAreas: ["細分・旧"], candidateTruncated: false,
      },
    ]);
    expect(buildTickerSentence(event)).toContain(
      "細分・新A・細分・新Bなどで最大震度4",
    );
    expect(event.quakeIntensity?.localAreas).toEqual([
      expect.objectContaining({ name: "細分・新A", code: "440", maxInt: "4", maxIntRank: 4 }),
    ]);
    expect(event.quakeIntensity?.municipalities).toEqual([
      expect.objectContaining({ name: "市町村・新", code: "2230600", maxInt: "4", maxIntRank: 4 }),
    ]);
    expect(warnSpy.mock.calls.map(([message]) => message)).toEqual([
      expect.stringContaining("Area.Code 重複"),
      expect.stringContaining("City.Code 重複"),
    ]);
    warnSpy.mockRestore();
  });

  it("code追加後もareaNames・intensityGroupsの粒度と並びを変えない", () => {
    const outcome = outcomeFromDrillFixture();
    const intensity = {
      maxInt: "4",
      areas: [
        { name: "細分A", code: "001", intensity: "4" },
        { name: "細分B", code: "002", intensity: "3" },
        { name: "細分C", code: null, intensity: "4" },
      ],
      municipalities: [
        { name: "市町村A", code: "0010001", intensity: "4" },
      ],
    };
    const event = fromEarthquakeOutcome({
      ...outcome,
      parsed: { ...outcome.parsed, intensity },
    });
    expect(event.areaNames).toEqual(["細分A", "細分B", "細分C"]);
    expect(projectRecentQuake(event)?.intensityGroups).toEqual([
      {
        intensity: "4", rank: 4, areas: ["細分A", "細分C"], omittedAreaCount: 0,
        expandedAreas: ["細分A", "細分C"], candidateTruncated: false,
      },
      {
        intensity: "3", rank: 3, areas: ["細分B"], omittedAreaCount: 0,
        expandedAreas: ["細分B"], candidateTruncated: false,
      },
    ]);
  });
});
