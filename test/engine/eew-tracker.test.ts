import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EewTracker } from "../../src/engine/eew/eew-tracker";
import { ParsedEewInfo } from "../../src/types";
import { createTelegramMeta } from "../../src/dmdata/telegram-meta";

/** テスト用の ParsedEewInfo を生成する */
function createEewInfo(overrides: Partial<ParsedEewInfo> = {}): ParsedEewInfo {
  const base = {
    type: "VXSE45",
    infoType: "発表",
    title: "緊急地震速報（地震動予報）",
    reportDateTime: "2024-04-17T23:14:57+09:00",
    headline: null,
    publishingOffice: "気象庁",
    serial: "1",
    eventId: "20240417231454",
    isAssumedHypocenter: false,
    isTest: false,
    isWarning: false,
    ...overrides,
  };
  return {
    ...base,
    meta: overrides.meta ?? createTelegramMeta({
      messageId: `synthetic-${base.eventId ?? "none"}-${base.serial ?? "none"}-${base.infoType}`,
      eventId: base.eventId,
      type: base.type,
      reportDateTime: base.reportDateTime,
      serial: base.serial,
      infoType: base.infoType,
      receivedAtMs: Date.parse(base.reportDateTime) + 60_000,
      status: base.isTest ? "試験" : "通常",
      isTest: base.isTest,
    }),
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

    it("EventID が空でも同一 semantic payload の再送を拒否する", () => {
      const first = createEewInfo({ serial: "1", eventId: "" });
      const replay = {
        ...first,
        meta: { ...first.meta, messageId: "single-replay" },
      };

      expect(tracker.update(first)).toMatchObject({
        isNew: true,
        isDuplicate: false,
        revisionDecision: "acceptTransient",
      });
      expect(tracker.update(replay)).toMatchObject({
        isNew: false,
        isDuplicate: true,
        revisionDecision: "semanticDuplicate",
      });
      expect(tracker.getActiveCount()).toBe(0);
    });

    it("EventID が空の異なる payload は続報結合せず個別に受理する", () => {
      const first = createEewInfo({
        serial: "1",
        eventId: "",
        headline: "単発1",
      });
      const second = createEewInfo({
        serial: "1",
        eventId: "",
        headline: "単発2",
      });

      expect(tracker.update(first).isNew).toBe(true);
      expect(tracker.update(second).isNew).toBe(true);
      expect(tracker.getActiveCount()).toBe(0);
    });

    it("EventID が空の訂正も訂正扱いとし、同 payload の再送を拒否する", () => {
      const correction = createEewInfo({
        serial: "2",
        eventId: "",
        infoType: "訂正",
      });
      const replay = {
        ...correction,
        meta: { ...correction.meta, messageId: "single-correction-replay" },
      };

      expect(tracker.update(correction)).toMatchObject({
        isNew: false,
        isCorrection: true,
        revisionDecision: "acceptTransient",
      });
      expect(tracker.update(replay)).toMatchObject({
        isDuplicate: true,
        revisionDecision: "semanticDuplicate",
      });
    });

    it("EventID が空でも不正 serial は拒否する", () => {
      const result = tracker.update(createEewInfo({
        serial: "invalid",
        eventId: "",
      }));

      expect(result).toMatchObject({
        isNew: false,
        isDuplicate: true,
        revisionDecision: "invalidRevision",
      });
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

  describe("共通 revision gate", () => {
    it("同一 serial の訂正で state を置換し、次報の比較元にする", () => {
      tracker.update(createEewInfo({
        eventId: "event-correction",
        serial: "2",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "旧震源",
          latitude: "35.0",
          longitude: "139.0",
          depth: "10km",
          magnitude: "5.0",
        },
      }));
      const corrected = tracker.update(createEewInfo({
        eventId: "event-correction",
        serial: "2",
        infoType: "訂正",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "訂正震源",
          latitude: "35.0",
          longitude: "139.0",
          depth: "20km",
          magnitude: "5.5",
        },
      }));
      const next = tracker.update(createEewInfo({
        eventId: "event-correction",
        serial: "3",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "続報震源",
          latitude: "35.0",
          longitude: "139.0",
          depth: "30km",
          magnitude: "6.0",
        },
      }));

      expect(corrected).toMatchObject({
        isNew: false,
        isDuplicate: false,
        isCorrection: true,
        revisionDecision: "replaceCorrection",
      });
      expect(next.previousInfo?.earthquake?.hypocenterName).toBe("訂正震源");
      expect(next.diff?.previousMagnitude).toBe("5.5");
    });

    it("実質差分なしの同一 serial 訂正も一回だけ受理する", () => {
      const normal = createEewInfo({
        eventId: "event-no-diff",
        serial: "4",
      });
      tracker.update(normal);
      const correction = createEewInfo({
        ...normal,
        infoType: "訂正",
        meta: undefined,
      });

      const first = tracker.update(correction);
      const repeated = tracker.update(correction);

      expect(first.isCorrection).toBe(true);
      expect(first.diff).toBeUndefined();
      expect(repeated).toMatchObject({
        isDuplicate: true,
        revisionDecision: "semanticDuplicate",
      });
    });

    it("小さい serial の訂正は state を巻き戻さない", () => {
      tracker.update(createEewInfo({
        eventId: "event-stale",
        serial: "5",
        headline: "current",
      }));
      const stale = tracker.update(createEewInfo({
        eventId: "event-stale",
        serial: "4",
        infoType: "訂正",
        headline: "stale",
      }));
      const next = tracker.update(createEewInfo({
        eventId: "event-stale",
        serial: "6",
      }));

      expect(stale).toMatchObject({
        isDuplicate: true,
        revisionDecision: "stale",
      });
      expect(next.previousInfo?.headline).toBe("current");
    });

    it("取消後の遅延旧報を拒否して markCancelled を維持する", () => {
      tracker.update(createEewInfo({
        eventId: "event-cancelled",
        serial: "3",
      }));
      const cancelled = tracker.update(createEewInfo({
        eventId: "event-cancelled",
        serial: "4",
        infoType: "取消",
      }));
      const stale = tracker.update(createEewInfo({
        eventId: "event-cancelled",
        serial: "3",
      }));

      expect(cancelled.revisionDecision).toBe("markCancelled");
      expect(cancelled.activeCount).toBe(0);
      expect(stale.isDuplicate).toBe(true);
      expect(stale.isCancelled).toBe(true);
      expect(tracker.getActiveCount()).toBe(0);
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

    it("大量の EventID を受信しても tracker と revision family を 512 件に制限する", () => {
      const onCleanup = vi.fn();
      const boundedTracker = new EewTracker({ onCleanup });

      for (let index = 0; index < 513; index++) {
        const eventId = `capacity-${index.toString().padStart(4, "0")}`;
        const result = boundedTracker.update(createEewInfo({
          eventId,
          meta: createTelegramMeta({
            messageId: `capacity-${index}`,
            eventId,
            type: "VXSE45",
            reportDateTime: "2026-08-01T12:00:00+09:00",
            serial: "1",
            infoType: "発表",
            receivedAtMs: Date.parse("2026-08-01T12:00:01+09:00"),
            status: "通常",
            isTest: false,
          }),
        }));
        expect(result.revisionDecision).toBe("accept");
      }

      expect(boundedTracker.getActiveCount()).toBe(512);
      expect(onCleanup).toHaveBeenCalledTimes(1);
      expect(onCleanup).toHaveBeenCalledWith("capacity-0000");
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

    it("同一 serial 訂正で final 状態を非最終へ置換する", () => {
      const final = tracker.update(createEewInfo({
        eventId: "event-final-correction",
        serial: "5",
        nextAdvisory: "これで最終報です",
      }));
      expect(final.activeCount).toBe(0);

      const corrected = tracker.update(createEewInfo({
        eventId: "event-final-correction",
        serial: "5",
        infoType: "訂正",
        nextAdvisory: undefined,
      }));
      expect(corrected).toMatchObject({
        isCorrection: true,
        revisionDecision: "replaceCorrection",
        activeCount: 1,
      });
    });

    it("最終報後の大きい serial 非最終続報で active に戻る", () => {
      tracker.update(createEewInfo({
        eventId: "event-final-newer",
        serial: "5",
        nextAdvisory: "これで最終報です",
      }));

      const newer = tracker.update(createEewInfo({
        eventId: "event-final-newer",
        serial: "6",
        nextAdvisory: undefined,
      }));
      expect(newer).toMatchObject({
        isDuplicate: false,
        activeCount: 1,
      });
    });

    it("同一 serial 訂正で cancel 状態も非取消へ置換する", () => {
      tracker.update(createEewInfo({
        eventId: "event-cancel-correction",
        serial: "1",
      }));
      expect(tracker.update(createEewInfo({
        eventId: "event-cancel-correction",
        serial: "2",
        infoType: "取消",
      })).activeCount).toBe(0);

      const corrected = tracker.update(createEewInfo({
        eventId: "event-cancel-correction",
        serial: "2",
        infoType: "訂正",
      }));
      expect(corrected).toMatchObject({
        isCancelled: false,
        isCorrection: true,
        activeCount: 1,
      });
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

  describe("head.type 別シリアル管理", () => {
    it("同一 eventId で異なる type の報は重複にならない", () => {
      const vxse45_1 = createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-001" });
      const vxse43_1 = createEewInfo({ type: "VXSE43", serial: "1", eventId: "ev-001", isWarning: true });

      tracker.update(vxse45_1);
      const r2 = tracker.update(vxse43_1);

      expect(r2.isDuplicate).toBe(false);
      expect(r2.isNew).toBe(false);
    });

    it("同一 type の古い serial は重複扱い", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "10", eventId: "ev-001" }));
      const dup = tracker.update(createEewInfo({ type: "VXSE45", serial: "5", eventId: "ev-001" }));

      expect(dup.isDuplicate).toBe(true);
    });

    it("異なる type のシリアルは独立して管理される", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "10", eventId: "ev-001" }));
      const r = tracker.update(createEewInfo({ type: "VXSE44", serial: "1", eventId: "ev-001" }));

      expect(r.isDuplicate).toBe(false);
    });
  });

  describe("isSuppressed (VXSE45 受信後の VXSE43/44 抑制)", () => {
    it("VXSE45 受信後の VXSE43 は isSuppressed=true", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-001" }));
      const r = tracker.update(createEewInfo({ type: "VXSE43", serial: "1", eventId: "ev-001" }));

      expect(r.isSuppressed).toBe(true);
    });

    it("VXSE45 受信後の VXSE44 は isSuppressed=true", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-001" }));
      const r = tracker.update(createEewInfo({ type: "VXSE44", serial: "1", eventId: "ev-001" }));

      expect(r.isSuppressed).toBe(true);
    });

    it("VXSE45 未受信なら VXSE43 は isSuppressed=false", () => {
      tracker.update(createEewInfo({ type: "VXSE44", serial: "1", eventId: "ev-001" }));
      const r = tracker.update(createEewInfo({ type: "VXSE43", serial: "1", eventId: "ev-001" }));

      expect(r.isSuppressed).toBe(false);
    });

    it("VXSE45 受信後の VXSE45 自身は isSuppressed=false", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-001" }));
      const r = tracker.update(createEewInfo({ type: "VXSE45", serial: "2", eventId: "ev-001" }));

      expect(r.isSuppressed).toBe(false);
    });

    it("抑制時は diff が undefined になる", () => {
      tracker.update(createEewInfo({
        type: "VXSE45", serial: "1", eventId: "ev-001",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道", latitude: "N33.2", longitude: "E132.4",
          depth: "40km", magnitude: "5.0",
        },
      }));
      // VXSE43 の第1報 → 同一 type 内の previousInfo がないので diff なし (別の理由)
      tracker.update(createEewInfo({
        type: "VXSE43", serial: "1", eventId: "ev-001",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道", latitude: "N33.2", longitude: "E132.4",
          depth: "40km", magnitude: "5.0",
        },
      }));
      // VXSE43 の第2報 → 同一 type 内に previousInfo あるが抑制で diff=undefined
      const r = tracker.update(createEewInfo({
        type: "VXSE43", serial: "2", eventId: "ev-001",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "愛媛県南予", latitude: "N33.3", longitude: "E132.5",
          depth: "30km", magnitude: "5.5",
        },
      }));

      expect(r.isSuppressed).toBe(true);
      expect(r.diff).toBeUndefined();
    });
  });

  describe("isUpgradeToWarning (警報昇格判定)", () => {
    it("初回警報で isUpgradeToWarning=true", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "ev-001", isWarning: false }));
      const r = tracker.update(createEewInfo({ serial: "2", eventId: "ev-001", isWarning: true }));

      expect(r.isUpgradeToWarning).toBe(true);
    });

    it("2回目以降の警報は isUpgradeToWarning=false", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "ev-001", isWarning: false }));
      tracker.update(createEewInfo({ serial: "2", eventId: "ev-001", isWarning: true }));
      const r = tracker.update(createEewInfo({ serial: "3", eventId: "ev-001", isWarning: true }));

      expect(r.isUpgradeToWarning).toBe(false);
    });

    it("新規イベントでは isUpgradeToWarning=false", () => {
      const r = tracker.update(createEewInfo({ serial: "1", eventId: "ev-001", isWarning: true }));

      expect(r.isUpgradeToWarning).toBe(false);
    });

    it("予報のままなら isUpgradeToWarning=false", () => {
      tracker.update(createEewInfo({ serial: "1", eventId: "ev-001", isWarning: false }));
      const r = tracker.update(createEewInfo({ serial: "2", eventId: "ev-001", isWarning: false }));

      expect(r.isUpgradeToWarning).toBe(false);
    });
  });

  describe("エッジケース (設計レビュー網羅)", () => {
    it("VXSE44 #10 → VXSE45 #1: VXSE45 表示 (diffなし)、以降 VXSE44 抑制", () => {
      const r44 = tracker.update(createEewInfo({ type: "VXSE44", serial: "10", eventId: "ev-edge1" }));
      expect(r44.isNew).toBe(true);
      expect(r44.isSuppressed).toBe(false);

      const r45 = tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-edge1" }));
      expect(r45.isSuppressed).toBe(false);
      expect(r45.diff).toBeUndefined(); // 初めての VXSE45 → diff なし

      const r44b = tracker.update(createEewInfo({ type: "VXSE44", serial: "11", eventId: "ev-edge1" }));
      expect(r44b.isSuppressed).toBe(true);
    });

    it("VXSE45 #1 → VXSE44 #10: VXSE44 抑制 (serial 状態は更新)", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-edge2" }));
      const r44 = tracker.update(createEewInfo({ type: "VXSE44", serial: "10", eventId: "ev-edge2" }));
      expect(r44.isSuppressed).toBe(true);

      // serial 状態は更新されている
      const dup = tracker.update(createEewInfo({ type: "VXSE44", serial: "5", eventId: "ev-edge2" }));
      expect(dup.isDuplicate).toBe(true);
    });

    it("VXSE45 予報 → VXSE43 警報: VXSE43 抑制、後続 VXSE45 警報で昇格表示", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-edge3", isWarning: false }));

      const r43 = tracker.update(createEewInfo({ type: "VXSE43", serial: "1", eventId: "ev-edge3", isWarning: true }));
      expect(r43.isSuppressed).toBe(true);

      // 抑制された VXSE43 は hasWarningIssued を更新しないので、VXSE45 警報で昇格表示
      const r45 = tracker.update(createEewInfo({ type: "VXSE45", serial: "2", eventId: "ev-edge3", isWarning: true }));
      expect(r45.isSuppressed).toBe(false);
      expect(r45.isUpgradeToWarning).toBe(true);
    });

    it("VXSE44 予報 → VXSE43 警報 (VXSE45 未受信): VXSE43 表示", () => {
      tracker.update(createEewInfo({ type: "VXSE44", serial: "1", eventId: "ev-edge4", isWarning: false }));
      const r43 = tracker.update(createEewInfo({ type: "VXSE43", serial: "1", eventId: "ev-edge4", isWarning: true }));

      expect(r43.isSuppressed).toBe(false);
      expect(r43.isUpgradeToWarning).toBe(true);
    });

    it("VXSE45 受信済み → VXSE43 取消のみ到着: 表示抑制、isCancelled は true", () => {
      tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-edge5" }));
      const r43cancel = tracker.update(createEewInfo({
        type: "VXSE43", serial: "1", eventId: "ev-edge5", infoType: "取消", isWarning: true,
      }));

      expect(r43cancel.isSuppressed).toBe(true);
      expect(r43cancel.isCancelled).toBe(true);
    });

    it("同一 eventId で 43/44/45 が逆順到着: 重複判定は type 別で独立", () => {
      // VXSE43 serial=3 を先に受信
      tracker.update(createEewInfo({ type: "VXSE43", serial: "3", eventId: "ev-edge6", isWarning: true }));
      // VXSE44 serial=1 は独立 (VXSE43 の serial と比較しない)
      const r44 = tracker.update(createEewInfo({ type: "VXSE44", serial: "1", eventId: "ev-edge6" }));
      expect(r44.isDuplicate).toBe(false);
      // VXSE45 serial=1 も独立
      const r45 = tracker.update(createEewInfo({ type: "VXSE45", serial: "1", eventId: "ev-edge6" }));
      expect(r45.isDuplicate).toBe(false);
    });
  });

  describe("To 基準一気通貫 (spec 4.5): getMaxForecastIntensity", () => {
    function eewInfoWith(serial: string, areas: { name: string; intensity: string; intensityTo?: string }[]): ParsedEewInfo {
      return createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial,
        eventId: "20260705000000",
        forecastIntensity: { areas },
      });
    }

    it("previousMaxInt が悲観側 (intensityTo ?? intensity) で入る", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "4", intensityTo: "5-" }]));
      const result = tracker.update(eewInfoWith("2", [{ name: "北部", intensity: "5+" }]));
      // 前回の To 基準最大 = "5-" (From "4" ではない)
      expect(result.diff?.previousMaxInt).toBe("5-");
    });

    it("To 基準最大が同値なら diff を出さない (From 差では発火しない)", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "4", intensityTo: "5-" }]));
      const result = tracker.update(eewInfoWith("2", [{ name: "北部", intensity: "5-" }]));
      expect(result.diff?.previousMaxInt).toBeUndefined();
    });
  });
});
