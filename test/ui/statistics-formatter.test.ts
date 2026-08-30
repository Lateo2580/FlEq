import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import {
  formatStatsDuration,
  displayStatistics,
} from "../../src/ui/statistics-formatter";
import {
  getFrameLineClampFallbackCount,
  resetFrameLineClampFallbackCount,
  stripAnsi,
  visualWidth,
} from "../../src/ui/formatter";
import type { StatsSnapshot } from "../../src/engine/messages/telegram-stats";
import { expectCompleteWrappedValue } from "./width-contract-assertions";

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
    testMetadataMismatch: 0,
    foundation: {
      received: 0,
      transportDuplicate: 0,
      semanticDuplicate: 0,
      correctionReplaced: 0,
      correctionNotified: 0,
      stale: 0,
      invalidMeta: 0,
      invalidRevision: 0,
      invalidDateDiagnosed: 0,
      futureDateDiagnosed: 0,
      cancelApplied: 0,
      cancelTargetMismatch: 0,
      capacityExceeded: 0,
      persistenceMigrationConflict: 0,
      presented: 0,
      notified: 0,
      vxse44SuppressedByObservedVxse45: 0,
      vxse44SuppressedByCapability: 0,
      legacyMatchedSuppressed: 0,
      legacyUnmatchedDisplayed: 0,
      legacyUnmatchedHighSeverityNotified: 0,
      legacyUnmatchedNonHighNotificationSuppressed: 0,
      legacySeverityUnknownNotificationSuppressed: 0,
      legacyAmbiguousDisplayed: 0,
      legacyCorrelationExpired: 0,
      legacyCorrectionMismatch: 0,
      legacyCancellationMismatch: 0,
      legacyCounterpartArrivedFirst: 0,
      legacySourceArrivedFirst: 0,
      legacyLateCounterpartReconciled: 0,
      legacyLateCounterpartExpired: 0,
      legacyCardDisplayed: 0,
      legacyCardReconciled: 0,
      legacyCardEvicted: 0,
    },
    foundationByHeadType: new Map(),
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
  let logSpy: MockInstance<typeof console.log>;

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

  it("新規 foundation metric は既存表示項目・ラベル・並び順を変えない", () => {
    const withSuppressionMetrics = makeSnapshot({
      countByType: new Map([["VXSE44", 2]]),
      categoryByType: new Map([["VXSE44", "eew" as const]]),
      totalCount: 2,
      foundation: {
        ...makeSnapshot().foundation,
        vxse44SuppressedByObservedVxse45: 3,
        vxse44SuppressedByCapability: 4,
      },
      foundationByHeadType: new Map([
        [
          "VXSE44",
          {
            ...makeSnapshot().foundation,
            vxse44SuppressedByObservedVxse45: 3,
            vxse44SuppressedByCapability: 4,
          },
        ],
      ]),
    });
    displayStatistics(
      withSuppressionMetrics,
      new Date("2025-01-01T00:30:00Z"),
    );

    const text = stripAnsi(output());
    const expectedLabelsInOrder = [
      "統計",
      "開始:",
      "経過:",
      "合計:",
      "[EEW]",
      "VXSE44",
      "緊急地震速報(予報)",
    ];
    let previousPosition = -1;
    for (const label of expectedLabelsInOrder) {
      const position = text.indexOf(label);
      expect(position, `${label} が表示されること`).toBeGreaterThan(-1);
      expect(position, `${label} の表示順`).toBeGreaterThan(previousPosition);
      previousPosition = position;
    }
    expect(text).toContain("2件 / 0イベント");
    expect(text).not.toContain("vxse44SuppressedByObservedVxse45");
    expect(text).not.toContain("vxse44SuppressedByCapability");
    expect(text).not.toContain("legacyUnmatchedDisplayed");
    expect(text).not.toContain("legacySeverityUnknownNotificationSuppressed");
  });

  it.each([40, 60, 80, 120, 200])("過長な統計 type / label 行を幅 %i に収め内容を保持する", (width) => {
    const marker = "STATS_TYPE_KEEP";
    const longType = `${marker}_${"長いコード名 ".repeat(18)}`;
    resetFrameLineClampFallbackCount();
    displayStatistics(
      makeSnapshot({
        countByType: new Map([[longType, 7]]),
        categoryByType: new Map([[longType, "other" as const]]),
        totalCount: 7,
      }),
      new Date("2025-01-01T00:30:00Z"),
      width,
    );
    const plain = stripAnsi(output());
    for (const line of plain.split("\n")) {
      const lineWidth = visualWidth(line);
      expect(lineWidth, `width=${width} line=${JSON.stringify(line.slice(0, 60))}`)
        .toBeLessThanOrEqual(width);
      if (/^[┌╔├╠│║└╚]/.test(line)) expect(lineWidth).toBe(width);
    }
    expectCompleteWrappedValue(plain, longType, `width=${width}`);
    expect(getFrameLineClampFallbackCount(), `width=${width}`).toBe(0);
  });
});
