import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatStatsDuration,
  displayStatistics,
} from "../../src/ui/statistics-formatter";
import { stripAnsi } from "../../src/ui/formatter";
import type { StatsSnapshot } from "../../src/engine/messages/telegram-stats";

vi.mock("../../src/ui/theme", () => ({
  getRoleChalk: () => (s: string) => s,
  getColor: () => "#ffffff",
}));

// ── helpers ──

function makeSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    startTime: new Date("2025-01-01T00:00:00Z"),
    countByType: new Map(),
    categoryByType: new Map(),
    eewEventCount: 0,
    earthquakeMaxIntByEvent: new Map(),
    totalCount: 0,
    ...overrides,
  };
}

function captureDisplay(snapshot: StatsSnapshot, now?: Date): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displayStatistics(snapshot, now);
    return spy.mock.calls.map((c) => c.join("")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

// ── formatStatsDuration ──

describe("formatStatsDuration", () => {
  it.each([
    [0, "0分"],
    [32 * 60 * 1000, "32分"],
    [72 * 60 * 1000, "1時間12分"],
    [60 * 60 * 1000, "1時間"],
    [28 * 60 * 60 * 1000, "1日4時間"],
    [48 * 60 * 60 * 1000, "2日"],
  ])("ms=%i → %s", (ms, expected) => {
    expect(formatStatsDuration(ms)).toBe(expected);
  });
});

// ── displayStatistics ──

describe("displayStatistics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function output(): string {
    return logSpy.mock.calls.map((c) => c.join("")).join("\n");
  }

  it("0件: 統計タイトルと「まだ電文を受信していません」が含まれる", () => {
    displayStatistics(makeSnapshot());
    const text = stripAnsi(output());
    expect(text).toContain("統計");
    expect(text).toContain("まだ電文を受信していません");
  });

  it("単一カテゴリ: 合計件数とカテゴリ見出しが正しい", () => {
    const countByType = new Map([["VXSE53", 5]]);
    const categoryByType = new Map([["VXSE53", "earthquake" as const]]);
    const snapshot = makeSnapshot({
      countByType,
      categoryByType,
      totalCount: 5,
    });
    const now = new Date("2025-01-01T00:30:00Z");
    displayStatistics(snapshot, now);
    const text = stripAnsi(output());
    expect(text).toContain("合計");
    expect(text).toContain("5");
    expect(text).toContain("[地震]");
    expect(text).toContain("VXSE53");
    expect(text).toContain("震源・震度に関する情報");
  });

  it("複数カテゴリ: 正しい順序で表示", () => {
    const countByType = new Map([
      ["VXSE53", 3],
      ["VTSE41", 1],
    ]);
    const categoryByType = new Map([
      ["VXSE53", "earthquake" as const],
      ["VTSE41", "tsunami" as const],
    ]);
    const snapshot = makeSnapshot({
      countByType,
      categoryByType,
      totalCount: 4,
    });
    const now = new Date("2025-01-01T02:15:00Z");
    displayStatistics(snapshot, now);
    const text = stripAnsi(output());
    // earthquake appears before tsunami in CATEGORY_ORDER
    const eqPos = text.indexOf("[地震]");
    const tsPos = text.indexOf("[津波]");
    expect(eqPos).toBeGreaterThanOrEqual(0);
    expect(tsPos).toBeGreaterThanOrEqual(0);
    expect(eqPos).toBeLessThan(tsPos);
    // elapsed time: 2 hours 15 min → "2時間15分"
    expect(text).toContain("2時間15分");
  });

  it("EEW イベント数: N件 / Mイベント 形式", () => {
    const countByType = new Map([["VXSE43", 4]]);
    const categoryByType = new Map([["VXSE43", "eew" as const]]);
    const snapshot = makeSnapshot({
      countByType,
      categoryByType,
      eewEventCount: 2,
      totalCount: 4,
    });
    displayStatistics(snapshot, new Date("2025-01-01T00:10:00Z"));
    const text = stripAnsi(output());
    expect(text).toContain("[EEW]");
    expect(text).toContain("4件");
    expect(text).toContain("2イベント");
  });

  it("最大震度内訳: 地震セクション末尾に表示", () => {
    const countByType = new Map([["VXSE53", 3]]);
    const categoryByType = new Map([["VXSE53", "earthquake" as const]]);
    const earthquakeMaxIntByEvent = new Map([
      ["ev001", "3"],
      ["ev002", "4"],
      ["ev003", "3"],
    ]);
    const snapshot = makeSnapshot({
      countByType,
      categoryByType,
      earthquakeMaxIntByEvent,
      totalCount: 3,
    });
    displayStatistics(snapshot, new Date("2025-01-01T01:00:00Z"));
    const text = stripAnsi(output());
    expect(text).toContain("最大震度内訳");
    // intensities 3 and 4 appear (1 and 2 are zero, omitted)
    expect(text).toContain("3:");
    expect(text).toContain("4:");
  });
});
