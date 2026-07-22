import { describe, expect, it } from "vitest";
import { buildFloodHydrograph } from "./flood-hydrograph";
import type { DisplayFloodHydrographPointV1, DisplayFloodHydrographV1 } from "./protocol";

const HOURS = ["14:00", "15:00", "16:00", "17:00", "18:00"] as const;

function hydrograph(values: (number | null)[], dangerLevelM: number | null): DisplayFloodHydrographV1 {
  const points: DisplayFloodHydrographPointV1[] = values.map((valueM, i) => ({
    dateTime: `2026-07-21T${HOURS[i]}:00+09:00`,
    valueM,
    phase: i === 0 ? "observed" : "forecast",
  }));
  return { points, dangerLevelM };
}

// viewBox は 132 × 28、上下余白 4 → y は [4, 24] の範囲に収まる
const Y_MIN = 4;
const Y_MAX = 24;

describe("buildFloodHydrograph", () => {
  it("normalizes so the danger line and every point stay inside the drawing area", () => {
    // 危険水位 3.20 は全点 (3.42〜3.55) より下 → レンジに含めて域内に留める
    const geometry = buildFloodHydrograph(hydrograph([3.42, 3.50, 3.55, 3.48, 3.44], 3.20));
    expect(geometry).not.toBeNull();
    if (geometry == null) return;
    expect(geometry.dangerY).not.toBeNull();
    expect(geometry.dangerY!).toBeGreaterThanOrEqual(Y_MIN);
    expect(geometry.dangerY!).toBeLessThanOrEqual(Y_MAX);
    for (const dot of [geometry.observed!, ...geometry.forecastDots]) {
      expect(dot.y).toBeGreaterThanOrEqual(Y_MIN);
      expect(dot.y).toBeLessThanOrEqual(Y_MAX);
    }
  });

  it("keeps a minimum range for a flat series so coordinates stay finite and inside", () => {
    const geometry = buildFloodHydrograph(hydrograph([3.0, 3.0, 3.0], 3.0));
    expect(geometry).not.toBeNull();
    if (geometry == null) return;
    expect(Number.isFinite(geometry.observed!.y)).toBe(true);
    expect(geometry.dangerY!).toBeGreaterThanOrEqual(Y_MIN);
    expect(geometry.dangerY!).toBeLessThanOrEqual(Y_MAX);
  });

  it("splits the forecast line at a missing point instead of bridging the gap", () => {
    const geometry = buildFloodHydrograph(hydrograph([3.0, 3.1, null, 3.3, 3.4], 3.2));
    expect(geometry).not.toBeNull();
    if (geometry == null) return;
    // 現況+1H で 1 区間、欠測を挟んで 3H+4H で 1 区間 = 2 segment
    expect(geometry.forecastSegments).toHaveLength(2);
    expect(geometry.observed).not.toBeNull();
    // 欠測点は白抜き丸に含めない (現況以降の非欠測は 3.1, 3.3, 3.4)
    expect(geometry.forecastDots).toHaveLength(3);
  });

  it("summarizes the series with hour offsets, marks missing points, and appends the danger level", () => {
    const geometry = buildFloodHydrograph(hydrograph([3.42, 3.55, null], 3.20));
    expect(geometry?.summary).toBe("現在 3.42m。1時間後 3.55m。2時間後 欠測。氾濫危険水位 3.20m");
  });

  it("omits the danger line and its summary suffix when dangerLevelM is null", () => {
    const geometry = buildFloodHydrograph(hydrograph([5.60, 5.45, 5.30], null));
    expect(geometry?.dangerY).toBeNull();
    expect(geometry?.summary).toBe("現在 5.60m。1時間後 5.45m。2時間後 5.30m");
  });

  it("returns null when there are no points or no valid values", () => {
    expect(buildFloodHydrograph({ points: [], dangerLevelM: 3.2 })).toBeNull();
    expect(buildFloodHydrograph(hydrograph([null, null], 3.2))).toBeNull();
  });
});
