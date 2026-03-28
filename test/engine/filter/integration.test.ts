import { describe, it, expect } from "vitest";
import {
  compileFilter,
  FilterSyntaxError,
  FilterTypeError,
  FilterFieldError,
} from "../../../src/engine/filter";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

function makeEvent(overrides: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "test-1", classification: "eew.forecast", domain: "eew", type: "VXSE43",
    infoType: "発表", title: "緊急地震速報（警報）", headline: null,
    reportDateTime: "2025-01-01T00:00:00+09:00", publishingOffice: "気象庁",
    isTest: false, frameLevel: "critical", isCancellation: false,
    areaNames: [], forecastAreaNames: [], municipalityNames: [], observationNames: [],
    areaCount: 0, forecastAreaCount: 0, municipalityCount: 0, observationCount: 0,
    areaItems: [], raw: null, ...overrides,
  };
}

describe("compileFilter 統合テスト", () => {
  // ── EEW 警報のみ ──
  describe('domain = "eew" and isWarning = true', () => {
    const pred = compileFilter('domain = "eew" and isWarning = true');

    it("EEW 警報に一致する", () => {
      expect(pred(makeEvent({ domain: "eew", isWarning: true }))).toBe(true);
    });

    it("EEW 予報は除外される", () => {
      expect(pred(makeEvent({ domain: "eew", isWarning: false }))).toBe(false);
    });

    it("地震情報は除外される", () => {
      expect(pred(makeEvent({ domain: "earthquake", isWarning: true }))).toBe(false);
    });
  });

  // ── 震度5弱以上 ──
  describe('domain = "earthquake" and maxInt >= "5-"', () => {
    const pred = compileFilter('domain = "earthquake" and maxInt >= "5-"');

    it("震度6強は一致する", () => {
      expect(pred(makeEvent({ domain: "earthquake", maxInt: "6+" }))).toBe(true);
    });

    it("震度5弱は一致する (境界)", () => {
      expect(pred(makeEvent({ domain: "earthquake", maxInt: "5-" }))).toBe(true);
    });

    it("震度4は除外される", () => {
      expect(pred(makeEvent({ domain: "earthquake", maxInt: "4" }))).toBe(false);
    });

    it("maxInt が null の場合は除外される", () => {
      expect(pred(makeEvent({ domain: "earthquake", maxInt: null }))).toBe(false);
    });
  });

  // ── 複合条件: (frameLevel = "critical" or alertLevel >= 4) and not isTest ──
  describe('(frameLevel = "critical" or alertLevel >= 4) and not isTest', () => {
    const pred = compileFilter('(frameLevel = "critical" or alertLevel >= 4) and not isTest');

    it("critical + 非テストに一致する", () => {
      expect(pred(makeEvent({ frameLevel: "critical", isTest: false }))).toBe(true);
    });

    it("alertLevel 5 + 非テストに一致する", () => {
      expect(pred(makeEvent({ frameLevel: "info", alertLevel: 5, isTest: false }))).toBe(true);
    });

    it("テスト電文は除外される", () => {
      expect(pred(makeEvent({ frameLevel: "critical", isTest: true }))).toBe(false);
    });

    it("info + alertLevel 3 + 非テストは除外される", () => {
      expect(pred(makeEvent({ frameLevel: "info", alertLevel: 3, isTest: false }))).toBe(false);
    });
  });

  // ── 火山名の正規表現マッチ ──
  describe('volcanoName ~ "桜島|阿蘇"', () => {
    const pred = compileFilter('volcanoName ~ "桜島|阿蘇"');

    it("桜島に一致する", () => {
      expect(pred(makeEvent({ volcanoName: "桜島" }))).toBe(true);
    });

    it("阿蘇山に一致する", () => {
      expect(pred(makeEvent({ volcanoName: "阿蘇山" }))).toBe(true);
    });

    it("富士山は除外される", () => {
      expect(pred(makeEvent({ volcanoName: "富士山" }))).toBe(false);
    });

    it("volcanoName が null の場合は除外される", () => {
      expect(pred(makeEvent({ volcanoName: null }))).toBe(false);
    });
  });

  // ── 津波 contains ──
  describe('tsunamiKinds contains "大津波警報"', () => {
    const pred = compileFilter('tsunamiKinds contains "大津波警報"');

    it("大津波警報を含む配列に一致する", () => {
      expect(pred(makeEvent({ tsunamiKinds: ["大津波警報", "津波警報"] }))).toBe(true);
    });

    it("津波注意報のみの配列は除外される", () => {
      expect(pred(makeEvent({ tsunamiKinds: ["津波注意報"] }))).toBe(false);
    });

    it("tsunamiKinds が未定義の場合は除外される", () => {
      expect(pred(makeEvent({}))).toBe(false);
    });
  });

  // ── 複数フィルタの AND 結合シミュレート ──
  describe("複数フィルタの AND 結合シミュレート", () => {
    it("2つの独立した compileFilter を AND 結合できる", () => {
      const filter1 = compileFilter('domain = "earthquake"');
      const filter2 = compileFilter('maxInt >= "4"');
      const combined = (event: PresentationEvent) => filter1(event) && filter2(event);

      const quakeInt5 = makeEvent({ domain: "earthquake", maxInt: "5-" });
      const quakeInt3 = makeEvent({ domain: "earthquake", maxInt: "3" });
      const eewInt5 = makeEvent({ domain: "eew", maxInt: "5-" });

      expect(combined(quakeInt5)).toBe(true);
      expect(combined(quakeInt3)).toBe(false);
      expect(combined(eewInt5)).toBe(false);
    });
  });

  // ── エラー系 ──
  describe("構文エラー", () => {
    it("閉じ括弧の欠落で FilterSyntaxError が投げられる", () => {
      expect(() => compileFilter('(domain = "eew"')).toThrow(FilterSyntaxError);
    });

    it("閉じられていない文字列で FilterSyntaxError が投げられる", () => {
      expect(() => compileFilter('domain = "eew')).toThrow(FilterSyntaxError);
    });

    it("予期しない文字で FilterSyntaxError が投げられる", () => {
      expect(() => compileFilter("domain @ eew")).toThrow(FilterSyntaxError);
    });
  });

  describe("型エラー", () => {
    it("震度フィールドへの数値リテラル比較で FilterTypeError が投げられる", () => {
      expect(() => compileFilter("maxInt >= 5")).toThrow(FilterTypeError);
    });

    it("順序非対応フィールドへの >= 比較で FilterTypeError が投げられる", () => {
      expect(() => compileFilter('domain >= "eew"')).toThrow(FilterTypeError);
    });

    it("配列型フィールドへの正規表現マッチで FilterTypeError が投げられる", () => {
      expect(() => compileFilter('areaNames ~ "東京"')).toThrow(FilterTypeError);
    });
  });

  describe("フィールドエラー", () => {
    it("未知のフィールド名で FilterFieldError が投げられる", () => {
      expect(() => compileFilter('unknownField = "test"')).toThrow(FilterFieldError);
    });

    it("FilterFieldError に利用可能フィールドが含まれる", () => {
      try {
        compileFilter('unknownField = "test"');
        expect.fail("例外が投げられるべき");
      } catch (e) {
        expect(e).toBeInstanceOf(FilterFieldError);
        const err = e as InstanceType<typeof FilterFieldError>;
        expect(err.fieldName).toBe("unknownField");
        expect(err.availableFields.length).toBeGreaterThan(0);
        expect(err.availableFields).toContain("domain");
      }
    });
  });
});
