import { describe, it, expect } from "vitest";
import { PresentationDiffStore } from "../../../src/engine/presentation/diff-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";

/** テスト用の最小限 PresentationEvent を生成する */
function makeEvent(overrides: Partial<PresentationEvent>): PresentationEvent {
  return {
    id: "test-id",
    classification: "eew.forecast",
    domain: "eew",
    type: "VXSE43",
    infoType: "発表",
    title: "緊急地震速報",
    headline: null,
    reportDateTime: "2026-01-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "warning",
    isCancellation: false,
    areaNames: [],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 0,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw: null,
    ...overrides,
  };
}

describe("PresentationDiffStore", () => {
  describe("EEW diff", () => {
    it("初回は diff なし", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({
        domain: "eew",
        eventId: "20260101120000",
        magnitude: "5.0",
        forecastMaxInt: "5弱",
        hypocenterName: "千葉県北西部",
      });

      const result = store.apply(event);
      expect(result.diff).toBeUndefined();
    });

    it("同一 eventId の2回目に diff が付く", () => {
      const store = new PresentationDiffStore();
      const event1 = makeEvent({
        domain: "eew",
        eventId: "20260101120000",
        magnitude: "5.0",
        forecastMaxInt: "5弱",
        hypocenterName: "千葉県北西部",
      });
      const event2 = makeEvent({
        domain: "eew",
        eventId: "20260101120000",
        magnitude: "5.4",
        forecastMaxInt: "5強",
        hypocenterName: "千葉県北西部",
      });

      store.apply(event1);
      const result = store.apply(event2);

      expect(result.diff).toBeDefined();
      expect(result.diff!.changed).toBe(true);
    });

    it("magnitude 変化の summary", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "eew",
        eventId: "ev1",
        magnitude: "5.0",
        forecastMaxInt: "4",
        hypocenterName: "東京湾",
      }));
      const result = store.apply(makeEvent({
        domain: "eew",
        eventId: "ev1",
        magnitude: "5.4",
        forecastMaxInt: "4",
        hypocenterName: "東京湾",
      }));

      expect(result.diff!.summary).toContain("M5.0→5.4");
      expect(result.diff!.fields.some((f) => f.key === "magnitude")).toBe(true);
    });

    it("Magnitude は canonical equality で比較し raw/description だけの揺れを無視する", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        eventId: "ev-mag-canonical",
        magnitude: "6.5",
        magnitudeValue: {
          raw: "6.5", value: 6.5, condition: null, description: "Ｍ６．５", presence: "value",
        },
      }));
      const result = store.apply(makeEvent({
        eventId: "ev-mag-canonical",
        magnitude: "6.5",
        magnitudeValue: {
          raw: "６．５", value: 6.5, condition: null, description: "M6.5", presence: "value",
        },
      }));

      expect(result.diff?.changed).toBe(false);
      expect(result.diff?.fields).toEqual([]);
    });

    it("Magnitude bounds の canonical 変化は同じ legacy scalar でも発火する", () => {
      const store = new PresentationDiffStore();
      const base = {
        raw: "6.0", value: null, condition: "以上", description: null, presence: "range" as const,
      };
      store.apply(makeEvent({
        eventId: "ev-mag-bounds",
        magnitude: "6.0",
        magnitudeValue: { ...base, lowerBound: 6 },
      }));
      const result = store.apply(makeEvent({
        eventId: "ev-mag-bounds",
        magnitude: "6.0",
        magnitudeValue: { ...base, lowerBound: 7 },
      }));

      expect(result.diff?.fields).toContainEqual(expect.objectContaining({ key: "magnitude" }));
      expect(result.diff?.summary).not.toContain("M6.0→6.0");
    });

    it("Depth は canonical presence/value/bounds で比較する", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        eventId: "ev-depth",
        depth: "600km",
        depthValue: {
          raw: "-600000", value: null, condition: "以上", description: "深さ600km以上",
          presence: "range", lowerBound: 600,
        },
      }));
      const rawOnly = store.apply(makeEvent({
        eventId: "ev-depth",
        depth: "600km",
        depthValue: {
          raw: "-600000.0", value: null, condition: "600km以上", description: "深さ 600 km 以上",
          presence: "range", lowerBound: 600, upperBound: null,
        },
      }));
      expect(rawOnly.diff?.changed).toBe(false);

      const changed = store.apply(makeEvent({
        eventId: "ev-depth",
        depth: "600km",
        depthValue: {
          raw: "-600000", value: 600, condition: null, description: null, presence: "value",
        },
      }));
      expect(changed.diff?.fields).toContainEqual(expect.objectContaining({ key: "depth" }));
    });

    it("maxInt 変化の summary", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "eew",
        eventId: "ev2",
        magnitude: "5.0",
        forecastMaxInt: "5弱",
        hypocenterName: "東京湾",
      }));
      const result = store.apply(makeEvent({
        domain: "eew",
        eventId: "ev2",
        magnitude: "5.0",
        forecastMaxInt: "6弱",
        hypocenterName: "東京湾",
      }));

      expect(result.diff!.summary).toContain("5弱→6弱");
    });

    it("hypocenter 変化の summary", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "eew",
        eventId: "ev3",
        magnitude: "5.0",
        forecastMaxInt: "4",
        hypocenterName: "東京湾",
      }));
      const result = store.apply(makeEvent({
        domain: "eew",
        eventId: "ev3",
        magnitude: "5.0",
        forecastMaxInt: "4",
        hypocenterName: "千葉県南部",
      }));

      expect(result.diff!.summary).toContain("震源変更");
    });

    it("変化なしの場合 changed=false", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({
        domain: "eew",
        eventId: "ev4",
        magnitude: "5.0",
        forecastMaxInt: "4",
        hypocenterName: "東京湾",
      });
      store.apply(event);
      const result = store.apply(makeEvent({
        domain: "eew",
        eventId: "ev4",
        magnitude: "5.0",
        forecastMaxInt: "4",
        hypocenterName: "東京湾",
      }));

      expect(result.diff).toBeDefined();
      expect(result.diff!.changed).toBe(false);
      expect(result.diff!.fields).toHaveLength(0);
    });

    it("eventId がない EEW は diff 対象外", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({ domain: "eew", eventId: null });
      store.apply(event);
      const result = store.apply(event);
      expect(result.diff).toBeUndefined();
    });
  });

  describe("津波 diff", () => {
    it("VTSE41 の areaCount 変化", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "tsunami",
        type: "VTSE41",
        classification: "telegram.earthquake",
        areaCount: 3,
      }));
      const result = store.apply(makeEvent({
        domain: "tsunami",
        type: "VTSE41",
        classification: "telegram.earthquake",
        areaCount: 5,
      }));

      expect(result.diff).toBeDefined();
      expect(result.diff!.changed).toBe(true);
      expect(result.diff!.summary).toContain("3区域→5区域");
    });

    it("VTSE51 は diff 対象外", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({ domain: "tsunami", type: "VTSE51", classification: "telegram.earthquake" }));
      const result = store.apply(makeEvent({ domain: "tsunami", type: "VTSE51", classification: "telegram.earthquake" }));
      expect(result.diff).toBeUndefined();
    });
  });

  describe("火山 diff", () => {
    it("VFVO50 の alertLevel 変化", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "volcano",
        type: "VFVO50",
        classification: "telegram.volcano",
        volcanoCode: "314",
        alertLevel: 2,
      }));
      const result = store.apply(makeEvent({
        domain: "volcano",
        type: "VFVO50",
        classification: "telegram.volcano",
        volcanoCode: "314",
        alertLevel: 3,
      }));

      expect(result.diff).toBeDefined();
      expect(result.diff!.changed).toBe(true);
      expect(result.diff!.summary).toContain("Lv2→3");
    });

    it("VFVO50 以外は diff 対象外", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({
        domain: "volcano",
        type: "VFVO52",
        classification: "telegram.volcano",
        volcanoCode: "314",
      }));
      const result = store.apply(makeEvent({
        domain: "volcano",
        type: "VFVO52",
        classification: "telegram.volcano",
        volcanoCode: "314",
      }));
      expect(result.diff).toBeUndefined();
    });
  });

  describe("diff 対象外ドメイン", () => {
    it("earthquake ドメインは diff なし", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({
        domain: "earthquake",
        type: "VXSE53",
        classification: "telegram.earthquake",
      });
      store.apply(event);
      const result = store.apply(event);
      expect(result.diff).toBeUndefined();
    });

    it("raw ドメインは diff なし", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({
        domain: "raw",
        type: "UNKNOWN",
        classification: "other",
      });
      store.apply(event);
      const result = store.apply(event);
      expect(result.diff).toBeUndefined();
    });
  });

  describe("clear", () => {
    it("clear 後は初回扱いになる", () => {
      const store = new PresentationDiffStore();
      const event = makeEvent({ domain: "eew", eventId: "ev1", magnitude: "5.0" });
      store.apply(event);

      store.clear();

      const result = store.apply(makeEvent({ domain: "eew", eventId: "ev1", magnitude: "5.4" }));
      expect(result.diff).toBeUndefined();
    });
  });

  describe("remove", () => {
    it("remove 後は初回扱いになる", () => {
      const store = new PresentationDiffStore();
      store.apply(makeEvent({ domain: "eew", eventId: "ev1", magnitude: "5.0" }));

      store.remove("eew:ev1");

      const result = store.apply(makeEvent({ domain: "eew", eventId: "ev1", magnitude: "5.4" }));
      expect(result.diff).toBeUndefined();
    });
  });

  describe("TTL プルーニング", () => {
    it("TTL 超過したエントリが自動削除される", () => {
      // TTL を 100ms に設定
      const store = new PresentationDiffStore(100);
      const event1 = makeEvent({ domain: "eew", eventId: "old-ev", magnitude: "5.0" });
      store.apply(event1);

      // updatedAt を過去に書き換えてプルーニングをトリガー
      // prune は applyCount が PRUNE_INTERVAL の倍数のときに実行される
      // 内部状態にアクセスするため、Date.now を一時的に上書き
      const originalNow = Date.now;
      Date.now = () => originalNow() + 200; // 200ms 後 → TTL 超過

      // PRUNE_INTERVAL (50) 回 apply を呼んでプルーニングをトリガー
      for (let i = 0; i < 49; i++) {
        store.apply(makeEvent({ domain: "raw", type: "X", classification: "other" }));
      }

      // 50回目の apply でプルーニング発生 → old-ev は TTL 超過で削除済み
      // この後に old-ev の新しいイベントを入れると初回扱いになるはず
      Date.now = originalNow;

      const result = store.apply(makeEvent({ domain: "eew", eventId: "old-ev", magnitude: "6.0" }));
      expect(result.diff).toBeUndefined();
    });
  });
});
