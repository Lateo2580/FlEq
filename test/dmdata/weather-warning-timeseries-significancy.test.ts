import { describe, it, expect } from "vitest";
import {
  normalizeKindName,
  KIND_NAME_MAP,
} from "../../src/dmdata/weather-warning-timeseries-significancy";

describe("KIND_NAME_MAP + normalizeKindName", () => {
  describe("マップ参照ケース", () => {
    it("'土砂災害危険度' + warning → '土砂災害警報'", () => {
      expect(normalizeKindName("土砂災害危険度", "warning")).toBe("土砂災害警報");
    });
    it("'土砂災害危険度' + advisory → '土砂災害注意報'", () => {
      expect(normalizeKindName("土砂災害危険度", "advisory")).toBe("土砂災害注意報");
    });
    it("'高潮危険度' + special → '高潮特別警報'", () => {
      expect(normalizeKindName("高潮危険度", "special")).toBe("高潮特別警報");
    });
    it("'大雨' + warning → '大雨警報'", () => {
      expect(normalizeKindName("大雨", "warning")).toBe("大雨警報");
    });
    it("'大雨' + special → '大雨特別警報'", () => {
      expect(normalizeKindName("大雨", "special")).toBe("大雨特別警報");
    });
    it("'風' + advisory → '強風注意報' (severity で base 名が変わる)", () => {
      expect(normalizeKindName("風", "advisory")).toBe("強風注意報");
    });
    it("'風' + warning → '暴風警報'", () => {
      expect(normalizeKindName("風", "warning")).toBe("暴風警報");
    });
    it("'雷' + advisory → '雷注意報'", () => {
      expect(normalizeKindName("雷", "advisory")).toBe("雷注意報");
    });
    it("'波浪' + warning → '波浪警報'", () => {
      expect(normalizeKindName("波浪", "warning")).toBe("波浪警報");
    });
  });

  describe("fallback ケース (未マップ)", () => {
    it("'未知種別' + warning → '未知種別警報' (機械式 + suffix)", () => {
      expect(normalizeKindName("未知種別", "warning")).toBe("未知種別警報");
    });
    it("'新規危険度' + warning → '新規警報' ('/危険度$/' 除去 + suffix)", () => {
      expect(normalizeKindName("新規危険度", "warning")).toBe("新規警報");
    });
  });

  describe("none / below severity", () => {
    it("none は素のラベル", () => {
      expect(normalizeKindName("大雨", "none")).toBe("大雨");
    });
    it("below は素のラベル", () => {
      expect(normalizeKindName("大雨", "below")).toBe("大雨");
    });
  });

  describe("unknown severity", () => {
    it("unknown は警報扱い (frame warning 昇格と整合)", () => {
      expect(normalizeKindName("大雨", "unknown")).toBe("大雨警報");
    });
  });

  it("KIND_NAME_MAP に最低限の entry がある", () => {
    expect(KIND_NAME_MAP).toBeDefined();
    expect(KIND_NAME_MAP["大雨"]).toBeDefined();
    expect(KIND_NAME_MAP["土砂災害危険度"]).toBeDefined();
    expect(KIND_NAME_MAP["風"]).toBeDefined();
  });

  describe("実 fixture カバレッジ (v3.1 必須)", () => {
    const FIXTURE_PROPERTY_TYPES = [
      "雨", "大雨浸水危険度", "土砂災害危険度",
      "風", "風危険度",
      "雪", "雪危険度",
      "波", "波危険度",
      "高潮", "高潮危険度",
      "雷危険度",
      "融雪危険度", "濃霧危険度", "着氷危険度", "着雪危険度",
    ];
    for (const pt of FIXTURE_PROPERTY_TYPES) {
      it(`'${pt}' が KIND_NAME_MAP に登録されている`, () => {
        expect(KIND_NAME_MAP[pt]).toBeDefined();
      });
    }
  });
});
