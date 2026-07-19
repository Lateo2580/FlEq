import { describe, it, expect } from "vitest";
import {
  FloodForecastStateHolder,
  buildStationDigests,
} from "../../../src/engine/messages/flood-forecast-state";
import type { StationDigest } from "../../../src/engine/messages/flood-forecast-state";
import { createMockWsDataMessage } from "../../helpers/mock-message";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";

const mkDigest = (over: Partial<StationDigest>): StationDigest => ({
  stationCode: "s1",
  kindCode: "20",
  headlineLevel: "L2",
  stationObservedLevel: "L2",
  condition: "正常",
  mainItemCode: "1",
  mainTextHash: "h1",
  ...over,
});

describe("FloodForecastStateHolder.diffAndUpdate", () => {
  it("初回 station → reasons: ['new'] + hasChange=true", () => {
    const h = new FloodForecastStateHolder();
    const d = h.diffAndUpdate("e1", [mkDigest({})], null);
    expect(d.hasChange).toBe(true);
    expect(d.changedStations).toHaveLength(1);
    expect(d.changedStations[0].reasons).toEqual(["new"]);
    expect(d.removedStations).toEqual([]);
  });

  it("同一 digest 2 回目 → hasChange=false / changedStations=[] / removedStations=[]", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({})], null);
    const d2 = h.diffAndUpdate("e1", [mkDigest({})], null);
    expect(d2.hasChange).toBe(false);
    expect(d2.changedStations).toEqual([]);
    expect(d2.removedStations).toEqual([]);
  });

  it("kindCode 変化 → ['kindCode']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ kindCode: "20" })], null);
    const d2 = h.diffAndUpdate(
      "e1",
      [mkDigest({ kindCode: "30", headlineLevel: "L3" })],
      null,
    );
    expect(d2.hasChange).toBe(true);
    expect(d2.changedStations[0].reasons).toEqual(
      expect.arrayContaining(["kindCode", "headlineLevel"]),
    );
  });

  it("headlineLevel 変化のみ → ['headlineLevel']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ headlineLevel: "L2" })], null);
    const d2 = h.diffAndUpdate("e1", [mkDigest({ headlineLevel: "L3" })], null);
    expect(d2.changedStations[0].reasons).toEqual(["headlineLevel"]);
  });

  it("stationObservedLevel 変化 → ['stationObservedLevel']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ stationObservedLevel: "L2" })], null);
    const d2 = h.diffAndUpdate(
      "e1",
      [mkDigest({ stationObservedLevel: "L3" })],
      null,
    );
    expect(d2.changedStations[0].reasons).toEqual(["stationObservedLevel"]);
  });

  it("condition 変化 → ['condition']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ condition: "正常" })], null);
    const d2 = h.diffAndUpdate("e1", [mkDigest({ condition: "上昇" })], null);
    expect(d2.changedStations[0].reasons).toEqual(["condition"]);
  });

  it("mainItemCode + mainTextHash 同時変化 → ['mainItemCode', 'mainText']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate(
      "e1",
      [mkDigest({ mainItemCode: "1", mainTextHash: "h1" })],
      null,
    );
    const d2 = h.diffAndUpdate(
      "e1",
      [mkDigest({ mainItemCode: "2", mainTextHash: "h2" })],
      null,
    );
    expect(d2.changedStations[0].reasons).toEqual(
      expect.arrayContaining(["mainItemCode", "mainText"]),
    );
  });

  it("mainTextHash のみ変化 (16_11 系の主文更新) → ['mainText']", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ mainTextHash: "h1" })], null);
    const d2 = h.diffAndUpdate("e1", [mkDigest({ mainTextHash: "h2" })], null);
    expect(d2.changedStations[0].reasons).toEqual(["mainText"]);
  });

  it("複数 station の部分変化 → 変化した station のみ changedStations に", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate(
      "e1",
      [
        mkDigest({ stationCode: "s1", condition: "正常" }),
        mkDigest({ stationCode: "s2", condition: "正常" }),
      ],
      null,
    );
    const d2 = h.diffAndUpdate(
      "e1",
      [
        mkDigest({ stationCode: "s1", condition: "正常" }),
        mkDigest({ stationCode: "s2", condition: "上昇" }),
      ],
      null,
    );
    expect(d2.hasChange).toBe(true);
    expect(d2.changedStations).toHaveLength(1);
    expect(d2.changedStations[0].stationCode).toBe("s2");
    expect(d2.changedStations[0].reasons).toEqual(["condition"]);
  });

  it("station 削除 → removedStations + hasChange=true (changedStations は空)", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate(
      "e1",
      [mkDigest({ stationCode: "s1" }), mkDigest({ stationCode: "s2" })],
      null,
    );
    const d2 = h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1" })], null);
    expect(d2.removedStations).toEqual(["s2"]);
    expect(d2.hasChange).toBe(true);
    expect(d2.changedStations).toEqual([]);
  });

  it("異なる eventId は完全独立 (前回 e1 の station は e2 の diff に影響しない)", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({ stationCode: "s1" })], null);
    const d = h.diffAndUpdate("e2", [mkDigest({ stationCode: "s1" })], null);
    expect(d.hasChange).toBe(true);
    expect(d.changedStations[0].reasons).toEqual(["new"]);
    expect(d.removedStations).toEqual([]);
  });

  it("空 eventId → hasChange=true / changedStations=[] (履歴に乗せない)", () => {
    const h = new FloodForecastStateHolder();
    const d = h.diffAndUpdate("", [mkDigest({})], null);
    expect(d.hasChange).toBe(true);
    expect(d.changedStations).toEqual([]);
    expect(d.removedStations).toEqual([]);
    // 2 回呼んでも履歴に乗らない
    const d2 = h.diffAndUpdate("", [mkDigest({})], null);
    expect(d2.changedStations).toEqual([]);
  });

  it("receivedAt は store に格納される (差分に直接は使わないが将来の expire 用)", () => {
    const h = new FloodForecastStateHolder();
    // 例外なく呼べることだけ確認
    expect(() =>
      h.diffAndUpdate("e1", [mkDigest({})], "2026-06-14T15:55:00+09:00"),
    ).not.toThrow();
  });
});

describe("FloodForecastStateHolder.rollback", () => {
  it("rollback 後の同 eventId 呼出 → 'new' 扱いに戻る", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({})], null);
    h.rollback("e1");
    const d = h.diffAndUpdate("e1", [mkDigest({})], null);
    expect(d.changedStations[0].reasons).toEqual(["new"]);
  });

  it("rollback は他 eventId に影響しない", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate("e1", [mkDigest({})], null);
    h.diffAndUpdate("e2", [mkDigest({})], null);
    h.rollback("e1");
    const d = h.diffAndUpdate("e2", [mkDigest({})], null);
    // e2 の履歴は維持されているので変化なし
    expect(d.hasChange).toBe(false);
  });

  it("空 eventId の rollback は no-op (errors なし)", () => {
    const h = new FloodForecastStateHolder();
    expect(() => h.rollback("")).not.toThrow();
  });

  it("複数 station を抱える eventId を rollback すると全 station が初期化される", () => {
    const h = new FloodForecastStateHolder();
    h.diffAndUpdate(
      "e1",
      [mkDigest({ stationCode: "s1" }), mkDigest({ stationCode: "s2" })],
      null,
    );
    h.rollback("e1");
    const d = h.diffAndUpdate(
      "e1",
      [mkDigest({ stationCode: "s1" }), mkDigest({ stationCode: "s2" })],
      null,
    );
    expect(d.changedStations).toHaveLength(2);
    expect(d.changedStations.every((c) => c.reasons.includes("new"))).toBe(true);
  });
});

describe("buildStationDigests", () => {
  it("16_02_01 fixture: station 数と digest 数が一致", () => {
    const msg = createMockWsDataMessage("16_02_01_220728_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBeGreaterThan(0);
    const digests = buildStationDigests(info);
    expect(digests).toHaveLength(info.rawStations.length);
    // 各 digest が parser 出力と一致
    for (let i = 0; i < info.rawStations.length; i++) {
      const s = info.rawStations[i];
      const d = digests[i];
      expect(d.stationCode).toBe(s.stationCode);
      expect(d.kindCode).toBe(s.headlineKindCode);
      expect(d.headlineLevel).toBe(s.headlineLevel);
      expect(d.stationObservedLevel).toBe(s.stationObservedLevel);
      expect(d.mainItemCode).toBe(s.mainItemCode);
      expect(d.mainTextHash).toBe(s.mainTextHash);
      // condition は series[0]?.condition ?? "欠測"
      expect(d.condition).toBe(s.series[0]?.condition ?? "欠測");
    }
  });

  it("16_05_01 Headline-only → digests=[]", () => {
    const msg = createMockWsDataMessage("16_05_01_210630_VXKO50.xml");
    const info = parseFloodForecast(msg)!;
    expect(info.rawStations.length).toBe(0);
    expect(buildStationDigests(info)).toEqual([]);
  });
});
