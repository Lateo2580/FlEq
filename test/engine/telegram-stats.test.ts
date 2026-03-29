import { describe, it, expect, beforeEach } from "vitest";
import {
  TelegramStats,
  routeToCategory,
  StatsCategory,
} from "../../src/engine/messages/telegram-stats";

describe("routeToCategory()", () => {
  it.each<[string, StatsCategory]>([
    ["eew", "eew"],
    ["earthquake", "earthquake"],
    ["seismicText", "earthquake"],
    ["lgObservation", "earthquake"],
    ["tsunami", "tsunami"],
    ["volcano", "volcano"],
    ["nankaiTrough", "nankaiTrough"],
    ["raw", "other"],
    ["unknown", "other"],
  ])("route %s → category %s", (route, expected) => {
    expect(routeToCategory(route)).toBe(expected);
  });
});

describe("TelegramStats", () => {
  let stats: TelegramStats;

  beforeEach(() => {
    stats = new TelegramStats(new Date("2025-01-01T00:00:00Z"));
  });

  describe("record()", () => {
    it("headType ごとのカウントを加算する", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" });
      stats.record({ headType: "VXSE53", category: "earthquake" });
      stats.record({ headType: "VXSE51", category: "earthquake" });

      const snap = stats.getSnapshot();
      expect(snap.countByType.get("VXSE53")).toBe(2);
      expect(snap.countByType.get("VXSE51")).toBe(1);
    });

    it("カテゴリの逆引きを登録する", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" });
      stats.record({ headType: "VXSE43", category: "eew" });

      const snap = stats.getSnapshot();
      expect(snap.categoryByType.get("VXSE53")).toBe("earthquake");
      expect(snap.categoryByType.get("VXSE43")).toBe("eew");
    });

    it("EEW の eventId が eewEventIds に追加される", () => {
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101001" });
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101001" });
      stats.record({ headType: "VXSE43", category: "eew", eventId: "20250101002" });

      const snap = stats.getSnapshot();
      expect(snap.eewEventCount).toBe(2);
    });

    it("eventId が null の場合はイベント数に加算しない", () => {
      stats.record({ headType: "VXSE43", category: "eew", eventId: null });
      stats.record({ headType: "VXSE43", category: "eew" });

      const snap = stats.getSnapshot();
      expect(snap.eewEventCount).toBe(0);
    });
  });

  describe("updateMaxInt()", () => {
    it("VXSE53 > VXSE61 > VXSE51 の優先順で上書きされる", () => {
      stats.updateMaxInt("EV001", "震度3", "VXSE51");
      stats.updateMaxInt("EV001", "震度5弱", "VXSE61");
      stats.updateMaxInt("EV001", "震度6強", "VXSE53");

      const snap = stats.getSnapshot();
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6強");
    });

    it("低優先の type では既存エントリを上書きしない", () => {
      stats.updateMaxInt("EV001", "震度6強", "VXSE53");
      stats.updateMaxInt("EV001", "震度3", "VXSE51");

      const snap = stats.getSnapshot();
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6強");
    });

    it("同等の priority では上書きする", () => {
      stats.updateMaxInt("EV001", "震度5弱", "VXSE53");
      stats.updateMaxInt("EV001", "震度6弱", "VXSE53");

      const snap = stats.getSnapshot();
      expect(snap.earthquakeMaxIntByEvent.get("EV001")).toBe("震度6弱");
    });
  });

  describe("サイズ上限", () => {
    it("eewEventIds が上限を超えたら古い方から削除される", () => {
      // 1001 件の eventId を追加 (上限は 1000)
      for (let i = 0; i < 1001; i++) {
        stats.record({ headType: "VXSE43", category: "eew", eventId: `ev-${i}` });
      }

      const snap = stats.getSnapshot();
      // 上限超過時にバッチ削除 (100件余分に削除) されるため 1000 以下になる
      expect(snap.eewEventCount).toBeLessThanOrEqual(1000);
      expect(snap.eewEventCount).toBeGreaterThan(0);
    });

    it("earthquakeMaxIntByEvent が上限を超えたら古い方から削除される", () => {
      for (let i = 0; i < 1001; i++) {
        stats.updateMaxInt(`eq-${i}`, `震度${i % 7}`, "VXSE53");
      }

      const snap = stats.getSnapshot();
      expect(snap.earthquakeMaxIntByEvent.size).toBeLessThanOrEqual(1000);
      expect(snap.earthquakeMaxIntByEvent.size).toBeGreaterThan(0);
    });
  });

  describe("getSnapshot()", () => {
    it("内部状態を正しく反映したスナップショットを返す", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" });
      stats.record({ headType: "VXSE43", category: "eew", eventId: "EV001" });
      stats.updateMaxInt("EQ001", "震度4", "VXSE53");

      const snap = stats.getSnapshot();
      expect(snap.startTime).toEqual(new Date("2025-01-01T00:00:00Z"));
      expect(snap.totalCount).toBe(2);
      expect(snap.eewEventCount).toBe(1);
      expect(snap.countByType.size).toBe(2);
      expect(snap.earthquakeMaxIntByEvent.get("EQ001")).toBe("震度4");
    });

    it("0件時は空のスナップショットを返す", () => {
      const snap = stats.getSnapshot();
      expect(snap.totalCount).toBe(0);
      expect(snap.eewEventCount).toBe(0);
      expect(snap.countByType.size).toBe(0);
      expect(snap.categoryByType.size).toBe(0);
      expect(snap.earthquakeMaxIntByEvent.size).toBe(0);
    });

    it("startTime は防御コピーを返す（外部変更の影響を受けない）", () => {
      const snap = stats.getSnapshot();
      snap.startTime.setFullYear(2000);

      const snap2 = stats.getSnapshot();
      expect(snap2.startTime.getFullYear()).toBe(2025);
    });

    it("スナップショットは内部 Map のコピーを返す（外部変更の影響を受けない）", () => {
      stats.record({ headType: "VXSE53", category: "earthquake" });

      const snap = stats.getSnapshot();
      snap.countByType.set("VXSE53", 999);

      const snap2 = stats.getSnapshot();
      expect(snap2.countByType.get("VXSE53")).toBe(1);
    });
  });
});
