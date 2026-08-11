import { describe, it, expect, beforeEach } from "vitest";
import {
  TelegramStats,
  routeToCategory,
  StatsCategory,
  TelegramFoundationMetric,
} from "../../src/engine/messages/telegram-stats";
import { ROUTE_TO_STATS_CATEGORY } from "../../src/engine/messages/route-catalog";
import type { Route } from "../../src/engine/messages/route-catalog";

describe("routeToCategory()", () => {
  // 全 Route を網羅 (Record 化に合わせて typhoonAnalysis / typhoonProbability /
  // floodForecast / legacyCounterpart、特殊ルート volcano / ignore / raw も列挙)。エントリの型を
  // [Route, StatsCategory] にしているため、存在しない route 名を書くとコンパイルエラー。
  const CASES: ReadonlyArray<[Route, StatsCategory]> = [
    ["eew", "eew"],
    ["earthquake", "earthquake"],
    ["seismicText", "earthquake"],
    ["lgObservation", "earthquake"],
    ["tsunami", "tsunami"],
    ["volcano", "volcano"],
    ["nankaiTrough", "nankaiTrough"],
    ["weather", "weather"],
    ["tornado", "tornado"],
    ["briefing", "briefing"],
    ["earlyWeather", "earlyWeather"],
    ["weatherWarningTimeseries", "weatherWarningTimeseries"],
    ["climateInfo", "climateInfo"],
    ["weatherExplanation", "weatherExplanation"],
    ["heatAlert", "heatAlert"],
    ["typhoonAnalysis", "typhoonAnalysis"],
    ["typhoonProbability", "typhoonProbability"],
    ["floodForecast", "floodForecast"],
    ["legacyCounterpart", "other"],
    ["ignore", "other"],
    ["raw", "other"],
  ];

  it.each(CASES)("route %s → category %s", (route, expected) => {
    expect(routeToCategory(route)).toBe(expected);
  });

  it("実行時に未知の route が紛れても旧実装同様 other へ落ちる", () => {
    // 型上はあり得ないが、旧 string 受け実装の挙動保存を固定する
    expect(routeToCategory("__unknown__" as Route)).toBe("other");
  });

  it("全 Route を網羅している (catalog に route を足したら table も追随する番兵)", () => {
    // route-catalog が持つ全 route を CASES が漏れなく含むことを確認する。
    // 網羅の真実源は ROUTE_TO_STATS_CATEGORY のキー集合。
    const covered = new Set(CASES.map(([route]) => route));
    const allRoutes = Object.keys(ROUTE_TO_STATS_CATEGORY);
    expect([...covered].sort()).toEqual(allRoutes.sort());
  });
});

describe("TelegramStats", () => {
  // 2025-01-01T00:00:00Z = JST 2025-01-01 09:00 (同日内)
  const BASE = Date.parse("2025-01-01T00:00:00Z");
  const SAME_DAY_LATER = Date.parse("2025-01-01T10:00:00Z"); // JST 2025-01-01 19:00 (同日内)

  let stats: TelegramStats;

  beforeEach(() => {
    stats = new TelegramStats(new Date(BASE));
  });

  describe("record()", () => {
    it("headType ごとのカウントを加算する", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" }, BASE);
      stats.record({ headType: "VXSE53", category: "earthquake" }, SAME_DAY_LATER);
      stats.record({ headType: "VXSE51", category: "earthquake" }, SAME_DAY_LATER);

      const snap = stats.getSnapshot(SAME_DAY_LATER);
      expect(snap.countByType.get("VXSE53")).toBe(2);
      expect(snap.countByType.get("VXSE51")).toBe(1);
    });

    it("カテゴリの逆引きを登録する", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" }, BASE);
      stats.record({ headType: "VXSE43", category: "eew" }, BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.categoryByType.get("VXSE53")).toBe("earthquake");
      expect(snap.categoryByType.get("VXSE43")).toBe("eew");
    });

    it("EEW の eventId が eewEventIds に追加される", () => {
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101001" }, BASE);
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101001" }, BASE);
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101002" }, BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.eewEventCount).toBe(2);
    });

    it("eventId が null の場合はイベント数に加算しない", () => {
      stats.record({ headType: "VXSE43", category: "eew", eventId: null }, BASE);
      stats.record({ headType: "VXSE43", category: "eew" }, BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.eewEventCount).toBe(0);
    });
  });

  describe("updateMaxInt()", () => {
    it("VXSE53 > VXSE61 > VXSE51 の優先順で上書きされる", () => {
      stats.updateMaxInt("EV001", "震度3", "VXSE51", BASE);
      stats.updateMaxInt("EV001", "震度5弱", "VXSE61", BASE);
      stats.updateMaxInt("EV001", "震度6強", "VXSE53", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6強");
    });

    it("低優先の type では既存エントリを上書きしない", () => {
      stats.updateMaxInt("EV001", "震度6強", "VXSE53", BASE);
      stats.updateMaxInt("EV001", "震度3", "VXSE51", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6強");
    });

    it("同等の priority では上書きする", () => {
      stats.updateMaxInt("EV001", "震度5弱", "VXSE53", BASE);
      stats.updateMaxInt("EV001", "震度6弱", "VXSE53", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6弱");
    });
  });

  describe("サイズ上限", () => {
    it("eewEventIds が上限を超えたら古い方から削除される", () => {
      // 1001 件の eventId を追加 (上限は 1000)
      for (let i = 0; i < 1001; i++) {
        stats.record({ headType: "VXSE43", category: "eew", eventId: `ev-${i}` }, BASE);
      }

      const snap = stats.getSnapshot(BASE);
      // 上限超過時にバッチ削除 (100件余分に削除) されるため 1000 以下になる
      expect(snap.eewEventCount).toBeLessThanOrEqual(1000);
      expect(snap.eewEventCount).toBeGreaterThan(0);
    });

    it("earthquakeMaxIntByEvent が上限を超えたら古い方から削除される", () => {
      for (let i = 0; i < 1001; i++) {
        stats.updateMaxInt(`eq-${i}`, `震度${i % 7}`, "VXSE53", BASE);
      }

      const snap = stats.getSnapshot(BASE);
      expect(snap.earthquakeMaxIntByEvent.size).toBeLessThanOrEqual(1000);
      expect(snap.earthquakeMaxIntByEvent.size).toBeGreaterThan(0);
    });
  });

  describe("getSnapshot()", () => {
    it("内部状態を正しく反映したスナップショットを返す", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" }, BASE);
      stats.record({ headType: "VXSE43", category: "eew", eventId: "EV001" }, BASE);
      stats.updateMaxInt("EQ001", "震度4", "VXSE53", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.startTime).toEqual(new Date(BASE));
      expect(snap.totalCount).toBe(2);
      expect(snap.eewEventCount).toBe(1);
      expect(snap.countByType.size).toBe(2);
      expect(snap.earthquakeMaxIntByEvent.get("EQ001")).toBe("震度4");
    });

    it("0件時は空のスナップショットを返す", () => {
      const snap = stats.getSnapshot(BASE);
      expect(snap.totalCount).toBe(0);
      expect(snap.eewEventCount).toBe(0);
      expect(snap.countByType.size).toBe(0);
      expect(snap.categoryByType.size).toBe(0);
      expect(snap.earthquakeMaxIntByEvent.size).toBe(0);
      expect(snap.foundationByHeadType.size).toBe(0);
    });

    it("startTime は防御コピーを返す（外部変更の影響を受けない）", () => {
      const snap = stats.getSnapshot(BASE);
      snap.startTime.setFullYear(2000);

      const snap2 = stats.getSnapshot(BASE);
      expect(snap2.startTime.getFullYear()).toBe(2025);
    });

    it("スナップショットは内部 Map のコピーを返す（外部変更の影響を受けない）", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" }, BASE);

      const snap = stats.getSnapshot(BASE);
      snap.countByType.set("VXSE53", 999);

      const snap2 = stats.getSnapshot(BASE);
      expect(snap2.countByType.get("VXSE53")).toBe(1);
    });
  });

  describe("foundation stats", () => {
    it("legacy metric tupleをglobal / source type-localへadditiveに各一回記録する", () => {
      const metrics = [
        "legacyMatchedSuppressed",
        "legacyUnmatchedDisplayed",
        "legacyUnmatchedHighSeverityNotified",
        "legacyUnmatchedNonHighNotificationSuppressed",
        "legacySeverityUnknownNotificationSuppressed",
        "legacyAmbiguousDisplayed",
        "legacyCorrelationExpired",
        "legacyCorrectionMismatch",
        "legacyCancellationMismatch",
        "legacyCounterpartArrivedFirst",
        "legacySourceArrivedFirst",
        "legacyLateCounterpartReconciled",
        "legacyLateCounterpartExpired",
      ] as const satisfies readonly TelegramFoundationMetric[];
      for (const metric of metrics) {
        stats.recordFoundationForHeadType("VPOA50", metric, BASE);
      }
      const snapshot = stats.getSnapshot(BASE);
      const local = snapshot.foundationByHeadType.get("VPOA50");
      for (const metric of metrics) {
        expect(snapshot.foundation[metric]).toBe(1);
        expect(local?.[metric]).toBe(1);
      }
    });

    it("既存 recordFoundation() は global だけを加算する", () => {
      stats.recordFoundation("received", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.foundation.received).toBe(1);
      expect(snap.foundation.vxse44SuppressedByObservedVxse45).toBe(0);
      expect(snap.foundation.vxse44SuppressedByCapability).toBe(0);
      expect(snap.foundationByHeadType.size).toBe(0);
    });

    it("head type 付き API は既存 metric と新規二 metric を global / type-local へ加算する", () => {
      stats.recordFoundationForHeadType("VXSE44", "received", BASE);
      stats.recordFoundationForHeadType(
        "VXSE44",
        "vxse44SuppressedByObservedVxse45",
        BASE,
      );
      stats.recordFoundationForHeadType(
        "VXSE44",
        "vxse44SuppressedByCapability",
        BASE,
      );

      const snap = stats.getSnapshot(BASE);
      const vxse44 = snap.foundationByHeadType.get("VXSE44");
      expect(snap.foundation.received).toBe(1);
      expect(snap.foundation.vxse44SuppressedByObservedVxse45).toBe(1);
      expect(snap.foundation.vxse44SuppressedByCapability).toBe(1);
      expect(vxse44?.received).toBe(1);
      expect(vxse44?.vxse44SuppressedByObservedVxse45).toBe(1);
      expect(vxse44?.vxse44SuppressedByCapability).toBe(1);
    });

    it("同じ metric を複数 head type へ独立して記録する", () => {
      stats.recordFoundationForHeadType("VXSE44", "semanticDuplicate", BASE);
      stats.recordFoundationForHeadType("VXSE45", "semanticDuplicate", BASE);

      const snap = stats.getSnapshot(BASE);
      expect(snap.foundation.semanticDuplicate).toBe(2);
      expect(
        snap.foundationByHeadType.get("VXSE44")?.semanticDuplicate,
      ).toBe(1);
      expect(
        snap.foundationByHeadType.get("VXSE45")?.semanticDuplicate,
      ).toBe(1);
    });

    it("一回の API 呼出で global と type-local を各一回だけ加算する", () => {
      stats.recordFoundationForHeadType(
        "VXSE44",
        "vxse44SuppressedByCapability",
        BASE,
      );

      const snap = stats.getSnapshot(BASE);
      const vxse44 = snap.foundationByHeadType.get("VXSE44");
      expect(Object.values(snap.foundation).reduce((sum, value) => sum + value, 0)).toBe(1);
      expect(
        Object.values(vxse44 ?? {}).reduce((sum, value) => sum + value, 0),
      ).toBe(1);
    });

    it("foundationByHeadType の外側 Map と内側 record を防御コピーする", () => {
      stats.recordFoundationForHeadType("VXSE44", "received", BASE);
      const snap = stats.getSnapshot(BASE);

      const mutableOuter = snap.foundationByHeadType as Map<
        string,
        Readonly<Record<TelegramFoundationMetric, number>>
      >;
      mutableOuter.set("VXSE45", { ...snap.foundation });
      const mutableInner = snap.foundationByHeadType.get("VXSE44") as Record<
        TelegramFoundationMetric,
        number
      >;
      mutableInner.received = 999;

      const snap2 = stats.getSnapshot(BASE);
      expect(snap2.foundationByHeadType.has("VXSE45")).toBe(false);
      expect(snap2.foundationByHeadType.get("VXSE44")?.received).toBe(1);
    });
  });

  describe("日またぎロールオーバー", () => {
    // JST 2025-01-01 23:59 → JST 2025-01-02 00:01
    const BEFORE_MIDNIGHT = Date.parse("2025-01-01T14:59:00Z");
    const AFTER_MIDNIGHT = Date.parse("2025-01-01T15:01:00Z");

    it("JST 0 時を跨ぐと countByType / eewEventIds / earthquakeMaxIntByEvent がリセットされる", () => {
      const s = new TelegramStats(new Date(BEFORE_MIDNIGHT));
      s.record({ headType: "VXSE53", category: "earthquake" }, BEFORE_MIDNIGHT);
      s.record({ headType: "VXSE43", category: "eew", eventId: "EV001" }, BEFORE_MIDNIGHT);
      s.updateMaxInt("EQ001", "震度4", "VXSE53", BEFORE_MIDNIGHT);
      expect(s.getSnapshot(BEFORE_MIDNIGHT).totalCount).toBe(2);

      s.record({ headType: "VXSE51", category: "earthquake" }, AFTER_MIDNIGHT);
      const snap = s.getSnapshot(AFTER_MIDNIGHT);

      expect(snap.totalCount).toBe(1);
      expect(snap.countByType.get("VXSE53")).toBeUndefined();
      expect(snap.countByType.get("VXSE51")).toBe(1);
      expect(snap.eewEventCount).toBe(0);
      expect(snap.earthquakeMaxIntByEvent.size).toBe(0);
    });

    it("categoryByType (headType → category の固定マッピング) はロールオーバーで消えない", () => {
      const s = new TelegramStats(new Date(BEFORE_MIDNIGHT));
      s.record({ headType: "VXSE53", category: "earthquake" }, BEFORE_MIDNIGHT);

      s.record({ headType: "VXSE51", category: "earthquake" }, AFTER_MIDNIGHT);
      const snap = s.getSnapshot(AFTER_MIDNIGHT);

      expect(snap.categoryByType.get("VXSE53")).toBe("earthquake");
      expect(snap.categoryByType.get("VXSE51")).toBe("earthquake");
    });

    it("ロールオーバー時に startTime が検知時刻へ更新される", () => {
      const s = new TelegramStats(new Date(BEFORE_MIDNIGHT));
      s.record({ headType: "VXSE53", category: "earthquake" }, BEFORE_MIDNIGHT);

      const snap = s.getSnapshot(AFTER_MIDNIGHT);
      expect(snap.startTime).toEqual(new Date(AFTER_MIDNIGHT));
    });

    it("同日内では startTime もカウントも変化しない", () => {
      const s = new TelegramStats(new Date(BASE));
      s.record({ headType: "VXSE53", category: "earthquake" }, BASE);

      const snap = s.getSnapshot(SAME_DAY_LATER);
      expect(snap.startTime).toEqual(new Date(BASE));
      expect(snap.totalCount).toBe(1);
    });

    it("getSnapshot() だけでもロールオーバーが検知される (record 前でも良い)", () => {
      const s = new TelegramStats(new Date(BEFORE_MIDNIGHT));
      s.record({ headType: "VXSE53", category: "earthquake" }, BEFORE_MIDNIGHT);

      const snap = s.getSnapshot(AFTER_MIDNIGHT);
      expect(snap.totalCount).toBe(0);
    });

    it("head type 付き記録時の JST rollover で旧日値を捨て新日値を双方へ記録する", () => {
      const s = new TelegramStats(new Date(BEFORE_MIDNIGHT));
      s.recordFoundationForHeadType(
        "VXSE44",
        "vxse44SuppressedByCapability",
        BEFORE_MIDNIGHT,
      );
      expect(
        s.getSnapshot(BEFORE_MIDNIGHT).foundationByHeadType.get("VXSE44")
          ?.vxse44SuppressedByCapability,
      ).toBe(1);

      s.recordFoundationForHeadType(
        "VXSE44",
        "vxse44SuppressedByCapability",
        AFTER_MIDNIGHT,
      );
      const snap = s.getSnapshot(AFTER_MIDNIGHT);
      expect(snap.foundation.vxse44SuppressedByCapability).toBe(1);
      expect(snap.foundationByHeadType.size).toBe(1);
      expect(
        snap.foundationByHeadType.get("VXSE44")
          ?.vxse44SuppressedByCapability,
      ).toBe(1);
    });
  });
});
