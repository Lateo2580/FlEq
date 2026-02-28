import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EewTracker } from "../../src/features/eew-tracker";
import { ParsedEewInfo } from "../../src/types";

/** テスト用の ParsedEewInfo を生成する */
function createEewInfo(overrides: Partial<ParsedEewInfo> = {}): ParsedEewInfo {
  return {
    type: "VXSE45",
    infoType: "発表",
    title: "緊急地震速報（地震動予報）",
    reportDateTime: "2024-04-17T23:14:57+09:00",
    headline: null,
    publishingOffice: "気象庁",
    serial: "1",
    eventId: "20240417231454",
    isTest: false,
    isWarning: false,
    ...overrides,
  };
}

describe("EewTracker", () => {
  let tracker: EewTracker;

  beforeEach(() => {
    tracker = new EewTracker();
  });

  describe("新規イベント", () => {
    it("初めてのイベントは isNew=true を返す", () => {
      const info = createEewInfo({ serial: "1", eventId: "event-001" });
      const result = tracker.update(info);

      expect(result.isNew).toBe(true);
      expect(result.isDuplicate).toBe(false);
      expect(result.isCancelled).toBe(false);
      expect(result.activeCount).toBe(1);
    });

    it("EventID が空の場合は常に新規扱い", () => {
      const info = createEewInfo({ serial: "1", eventId: "" });
      const r1 = tracker.update(info);
      const r2 = tracker.update(info);

      expect(r1.isNew).toBe(true);
      expect(r2.isNew).toBe(true);
    });
  });

  describe("Serial 更新", () => {
    it("Serial が増加するとき isDuplicate=false で更新される", () => {
      const info1 = createEewInfo({ serial: "1", eventId: "event-001" });
      const info26 = createEewInfo({ serial: "26", eventId: "event-001" });
      const info32 = createEewInfo({ serial: "32", eventId: "event-001" });

      tracker.update(info1);

      const r26 = tracker.update(info26);
      expect(r26.isNew).toBe(false);
      expect(r26.isDuplicate).toBe(false);

      const r32 = tracker.update(info32);
      expect(r32.isNew).toBe(false);
      expect(r32.isDuplicate).toBe(false);
    });
  });

  describe("同一 Serial 再受信", () => {
    it("同じ Serial を再度受信すると isDuplicate=true", () => {
      const info = createEewInfo({ serial: "10", eventId: "event-001" });

      tracker.update(info);
      const result = tracker.update(info);

      expect(result.isDuplicate).toBe(true);
      expect(result.isNew).toBe(false);
    });

    it("古い Serial を受信しても isDuplicate=true", () => {
      tracker.update(createEewInfo({ serial: "10", eventId: "event-001" }));
      const result = tracker.update(
        createEewInfo({ serial: "5", eventId: "event-001" })
      );

      expect(result.isDuplicate).toBe(true);
    });
  });

  describe("取消報", () => {
    it("取消報は isCancelled=true を返す", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));

      const cancelInfo = createEewInfo({
        serial: "32",
        eventId: "event-001",
        infoType: "取消",
      });
      const result = tracker.update(cancelInfo);

      expect(result.isCancelled).toBe(true);
      expect(result.isDuplicate).toBe(false);
    });

    it("新規の取消報も isCancelled=true", () => {
      const cancelInfo = createEewInfo({
        serial: "1",
        eventId: "event-new",
        infoType: "取消",
      });
      const result = tracker.update(cancelInfo);

      expect(result.isNew).toBe(true);
      expect(result.isCancelled).toBe(true);
    });
  });

  describe("複数同時イベント", () => {
    it("activeCount が正しくカウントされる", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      const r2 = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-002" })
      );
      expect(r2.activeCount).toBe(2);

      const r3 = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-003" })
      );
      expect(r3.activeCount).toBe(3);
    });

    it("取消されたイベントは activeCount に含まれない", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      tracker.update(createEewInfo({ serial: "1", eventId: "event-002" }));

      // event-001 を取消
      tracker.update(
        createEewInfo({
          serial: "2",
          eventId: "event-001",
          infoType: "取消",
        })
      );

      const result = tracker.update(
        createEewInfo({ serial: "2", eventId: "event-002" })
      );
      expect(result.activeCount).toBe(1);
    });
  });

  describe("カラーインデックス", () => {
    it("最初のイベントは colorIndex=0", () => {
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-001" })
      );
      expect(result.colorIndex).toBe(0);
    });

    it("2つ目のイベントは colorIndex=1", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-002" })
      );
      expect(result.colorIndex).toBe(1);
    });

    it("3つ目のイベントは colorIndex=2", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      tracker.update(createEewInfo({ serial: "1", eventId: "event-002" }));
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-003" })
      );
      expect(result.colorIndex).toBe(2);
    });

    it("イベント取消後にインデックスが再利用される", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      tracker.update(createEewInfo({ serial: "1", eventId: "event-002" }));

      // event-001 を取消 → colorIndex=0 が空く
      tracker.update(
        createEewInfo({ serial: "2", eventId: "event-001", infoType: "取消" })
      );

      // 新規イベントは空いた 0 を再利用
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-003" })
      );
      expect(result.colorIndex).toBe(0);
    });

    it("イベント finalize 後にインデックスが再利用される", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      tracker.update(createEewInfo({ serial: "1", eventId: "event-002" }));

      tracker.finalizeEvent("event-001");

      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-003" })
      );
      expect(result.colorIndex).toBe(0);
    });

    it("既存イベントの更新では同じ colorIndex が返る", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      const r2 = tracker.update(
        createEewInfo({ serial: "2", eventId: "event-001" })
      );
      expect(r2.colorIndex).toBe(0);
    });

    it("重複報でも colorIndex が返る", () => {
      tracker.update(createEewInfo({ serial: "5", eventId: "event-001" }));
      const dup = tracker.update(
        createEewInfo({ serial: "3", eventId: "event-001" })
      );
      expect(dup.isDuplicate).toBe(true);
      expect(dup.colorIndex).toBe(0);
    });

    it("EventIDなしの場合は colorIndex=0", () => {
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "" })
      );
      expect(result.colorIndex).toBe(0);
    });
  });

  describe("差分計算", () => {
    it("マグニチュード変化を検出する", () => {
      const info1 = createEewInfo({
        serial: "1",
        eventId: "event-diff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });
      const info2 = createEewInfo({
        serial: "2",
        eventId: "event-diff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.3",
        },
      });

      tracker.update(info1);
      const result = tracker.update(info2);

      expect(result.diff).toBeDefined();
      expect(result.diff!.previousMagnitude).toBe("5.0");
    });

    it("深さ変化を検出する", () => {
      const info1 = createEewInfo({
        serial: "1",
        eventId: "event-depth",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });
      const info2 = createEewInfo({
        serial: "2",
        eventId: "event-depth",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "30km",
          magnitude: "5.0",
        },
      });

      tracker.update(info1);
      const result = tracker.update(info2);

      expect(result.diff).toBeDefined();
      expect(result.diff!.previousDepth).toBe("40km");
    });

    it("震源地名変更を検出する", () => {
      const info1 = createEewInfo({
        serial: "1",
        eventId: "event-hypo",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });
      const info2 = createEewInfo({
        serial: "2",
        eventId: "event-hypo",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "愛媛県南予",
          latitude: "N33.3",
          longitude: "E132.5",
          depth: "40km",
          magnitude: "5.0",
        },
      });

      tracker.update(info1);
      const result = tracker.update(info2);

      expect(result.diff).toBeDefined();
      expect(result.diff!.hypocenterChange).toBe(true);
    });

    it("変化がない場合 diff は undefined", () => {
      const info1 = createEewInfo({
        serial: "1",
        eventId: "event-nodiff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });
      const info2 = createEewInfo({
        serial: "2",
        eventId: "event-nodiff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });

      tracker.update(info1);
      const result = tracker.update(info2);

      expect(result.diff).toBeUndefined();
    });

    it("新規イベントには diff がない", () => {
      const info = createEewInfo({
        serial: "1",
        eventId: "event-new-no-diff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });

      const result = tracker.update(info);

      expect(result.isNew).toBe(true);
      expect(result.diff).toBeUndefined();
    });

    it("previousInfo が返される", () => {
      const info1 = createEewInfo({
        serial: "1",
        eventId: "event-prev",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.0",
        },
      });
      const info2 = createEewInfo({
        serial: "2",
        eventId: "event-prev",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "40km",
          magnitude: "5.5",
        },
      });

      tracker.update(info1);
      const result = tracker.update(info2);

      expect(result.previousInfo).toBeDefined();
      expect(result.previousInfo!.earthquake!.magnitude).toBe("5.0");
    });
  });

  describe("serial 非数値耐性", () => {
    it("serial='abc' でもクラッシュせず lastSerial が壊れない", () => {
      tracker.update(createEewInfo({ serial: "5", eventId: "event-nan" }));

      // 非数値 serial を受信
      expect(() =>
        tracker.update(createEewInfo({ serial: "abc", eventId: "event-nan" }))
      ).not.toThrow();

      // その後 serial=6 の更新が重複扱いにならない
      const result = tracker.update(
        createEewInfo({ serial: "6", eventId: "event-nan" })
      );
      expect(result.isDuplicate).toBe(false);
    });

    it("serial='' でも lastSerial が壊れない", () => {
      tracker.update(createEewInfo({ serial: "3", eventId: "event-empty" }));

      // 空 serial を受信
      tracker.update(createEewInfo({ serial: "", eventId: "event-empty" }));

      // その後 serial=4 の更新が重複扱いにならない
      const result = tracker.update(
        createEewInfo({ serial: "4", eventId: "event-empty" })
      );
      expect(result.isDuplicate).toBe(false);
    });

    it("serial=null 相当でも lastSerial が NaN 化しない", () => {
      tracker.update(createEewInfo({ serial: "2", eventId: "event-null" }));

      // null を文字列化したもの
      tracker.update(createEewInfo({ serial: null, eventId: "event-null" }));

      // serial=3 の更新が正常に通る
      const result = tracker.update(
        createEewInfo({ serial: "3", eventId: "event-null" })
      );
      expect(result.isDuplicate).toBe(false);
    });

    it("非数値 serial 後に isDuplicate 判定が正常に機能する", () => {
      tracker.update(createEewInfo({ serial: "10", eventId: "event-mixed" }));
      tracker.update(createEewInfo({ serial: "xyz", eventId: "event-mixed" }));

      // serial=5 (10より古い) は重複扱い
      const dup = tracker.update(
        createEewInfo({ serial: "5", eventId: "event-mixed" })
      );
      expect(dup.isDuplicate).toBe(true);

      // serial=11 (10より新しい) は重複でない
      const fresh = tracker.update(
        createEewInfo({ serial: "11", eventId: "event-mixed" })
      );
      expect(fresh.isDuplicate).toBe(false);
    });
  });

  describe("最終報 (finalizeEvent)", () => {
    it("finalizeEvent でイベントが activeCount から除外される", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));
      tracker.update(createEewInfo({ serial: "1", eventId: "event-002" }));
      expect(tracker.getActiveCount()).toBe(2);

      tracker.finalizeEvent("event-001");
      expect(tracker.getActiveCount()).toBe(1);
    });

    it("finalize 後も重複報の検出は機能する", () => {
      tracker.update(createEewInfo({ serial: "5", eventId: "event-fin" }));
      tracker.finalizeEvent("event-fin");

      // 古い serial は重複扱い
      const result = tracker.update(
        createEewInfo({ serial: "3", eventId: "event-fin" })
      );
      expect(result.isDuplicate).toBe(true);
    });

    it("存在しない eventId を finalize してもエラーにならない", () => {
      expect(() => tracker.finalizeEvent("nonexistent")).not.toThrow();
    });
  });

  describe("自動クリーンアップ", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("10分経過後にイベントが自動削除される", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-old" }));
      expect(tracker.getActiveCount()).toBe(1);

      // 10分 + 1秒 進める
      vi.advanceTimersByTime(10 * 60 * 1000 + 1000);

      // 新しいイベントを追加 (cleanup が発動する)
      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-new" })
      );

      // 古いイベントはクリーンアップされ、新しいものだけ残る
      expect(result.activeCount).toBe(1);
      expect(result.isNew).toBe(true);
    });

    it("10分未満では削除されない", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "event-001" }));

      // 9分進める
      vi.advanceTimersByTime(9 * 60 * 1000);

      const result = tracker.update(
        createEewInfo({ serial: "1", eventId: "event-002" })
      );

      // 両方まだアクティブ
      expect(result.activeCount).toBe(2);
    });
  });
});
