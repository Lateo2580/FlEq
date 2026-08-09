import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  EewTracker,
  evaluateEewForecastArea,
  evaluateEewIntensitySafetyGate,
  getMaxForecastIntensityEvaluation,
} from "../../src/engine/eew/eew-tracker";
import type { ParsedEewInfo, SpecialValue, JmaIntensity } from "../../src/types";
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

function numericSpecialValue(raw: string, value: number): SpecialValue<number> {
  return {
    raw,
    value,
    condition: null,
    description: null,
    presence: "value",
  };
}

function missingSpecialValue(): SpecialValue<number> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
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
          depthValue: numericSpecialValue("10000", 10),
          magnitude: "5.0",
          magnitudeValue: numericSpecialValue("5.0", 5),
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
          depthValue: numericSpecialValue("20000", 20),
          magnitude: "5.5",
          magnitudeValue: {
            raw: "5.5",
            value: null,
            condition: "以上",
            description: "M5.5以上",
            presence: "range",
            lowerBound: 5.5,
            upperBound: null,
          },
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
          depthValue: numericSpecialValue("30000", 30),
          magnitude: "6.0",
          magnitudeValue: numericSpecialValue("6.0", 6),
        },
      }));

      expect(corrected).toMatchObject({
        isNew: false,
        isDuplicate: false,
        isCorrection: true,
        revisionDecision: "replaceCorrection",
      });
      expect(corrected.diff?.previousMagnitudeValue).toMatchObject({
        presence: "value",
        value: 5,
      });
      expect(corrected.diff?.currentMagnitudeValue).toMatchObject({
        presence: "range",
        lowerBound: 5.5,
      });
      expect(corrected.diff?.previousDepthValue).toMatchObject({
        presence: "value",
        value: 10,
      });
      expect(corrected.diff?.currentDepthValue).toMatchObject({
        presence: "value",
        value: 20,
      });
      expect(next.previousInfo?.earthquake?.hypocenterName).toBe("訂正震源");
      expect(next.diff?.previousMagnitude).toBe("5.5");
      expect(next.diff?.previousMagnitudeValue).toMatchObject({
        presence: "range",
        lowerBound: 5.5,
      });
      expect(next.diff?.previousDepthValue).toMatchObject({
        presence: "value",
        value: 20,
      });
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

    it("特殊値・小数深さ・bound の canonical 意味変化を検出する", () => {
      const previous = createEewInfo({
        serial: "1",
        eventId: "event-canonical-diff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "10.5km",
          depthValue: numericSpecialValue("10500", 10.5),
          magnitude: "5.5",
          magnitudeValue: numericSpecialValue("5.5", 5.5),
        },
      });
      const current = createEewInfo({
        serial: "2",
        eventId: "event-canonical-diff",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "10.75km",
          depthValue: numericSpecialValue("10750", 10.75),
          magnitude: "",
          magnitudeValue: {
            raw: "不明",
            value: null,
            condition: "不明",
            description: null,
            presence: "unknown",
          },
        },
      });

      tracker.update(previous);
      const result = tracker.update(current);

      expect(result.diff?.previousMagnitudeValue).toMatchObject({
        presence: "value",
        value: 5.5,
      });
      expect(result.diff?.currentMagnitudeValue).toMatchObject({ presence: "unknown" });
      expect(result.diff?.previousDepthValue).toMatchObject({ value: 10.5 });
      expect(result.diff?.currentDepthValue).toMatchObject({ value: 10.75 });

      const bounded = createEewInfo({
        serial: "3",
        eventId: "event-canonical-diff",
        earthquake: {
          ...current.earthquake!,
          depth: "600km",
          depthValue: {
            raw: "600000",
            value: null,
            condition: "以上",
            description: "深さ600km以上",
            presence: "range",
            lowerBound: 600,
            upperBound: null,
          },
        },
      });
      const boundedResult = tracker.update(bounded);
      expect(boundedResult.diff?.currentDepthValue).toMatchObject({
        presence: "range",
        lowerBound: 600,
      });
    });

    it("canonical が同じ raw・description・diagnostics の揺れでは発火しない", () => {
      const previous = createEewInfo({
        serial: "1",
        eventId: "event-canonical-metadata",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "600km",
          depthValue: {
            raw: "600000",
            value: null,
            condition: "以上",
            description: "深さ600km以上",
            presence: "range",
            lowerBound: 600,
          },
          magnitude: "5.5",
          magnitudeValue: numericSpecialValue("5.5", 5.5),
        },
      });
      const current = createEewInfo({
        serial: "2",
        eventId: "event-canonical-metadata",
        earthquake: {
          ...previous.earthquake!,
          depthValue: {
            raw: "６０００００",
            value: null,
            condition: "深さ以上",
            description: "別表記",
            presence: "range",
            lowerBound: 600,
            upperBound: null,
            diagnostics: ["specialValueConflict"],
          },
          magnitudeValue: {
            ...numericSpecialValue("５．５", 5.5),
            description: "別表記",
            diagnostics: ["unmappedSpecialValue"],
          },
        },
      });

      tracker.update(previous);
      expect(tracker.update(current).diff).toBeUndefined();
    });

    it("Earthquake 欠落と contained missing を同じ canonical missing として扱う", () => {
      tracker.update(createEewInfo({
        serial: "1",
        eventId: "event-container-missing",
        earthquake: undefined,
      }));
      const result = tracker.update(createEewInfo({
        serial: "2",
        eventId: "event-container-missing",
        earthquake: {
          originTime: "",
          hypocenterName: "",
          latitude: "",
          longitude: "",
          depth: "",
          depthValue: missingSpecialValue(),
          magnitude: "",
          magnitudeValue: missingSpecialValue(),
        },
      }));

      expect(result.diff).toBeUndefined();
    });

    it("Earthquake 欠落から value への変化に missing endpoint を付ける", () => {
      tracker.update(createEewInfo({
        serial: "1",
        eventId: "event-container-to-value",
        earthquake: undefined,
      }));
      const result = tracker.update(createEewInfo({
        serial: "2",
        eventId: "event-container-to-value",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "10km",
          depthValue: numericSpecialValue("10000", 10),
          magnitude: "5.0",
          magnitudeValue: numericSpecialValue("5.0", 5),
        },
      }));

      expect(result.diff?.previousMagnitudeValue).toMatchObject({ presence: "missing" });
      expect(result.diff?.currentMagnitudeValue).toMatchObject({ presence: "value", value: 5 });
      expect(result.diff?.previousDepthValue).toMatchObject({ presence: "missing" });
      expect(result.diff?.currentDepthValue).toMatchObject({ presence: "value", value: 10 });
    });

    it("value から Earthquake 欠落への変化に current missing endpoint を付ける", () => {
      tracker.update(createEewInfo({
        serial: "1",
        eventId: "event-value-to-container",
        earthquake: {
          originTime: "2024-04-17T23:14:54+09:00",
          hypocenterName: "豊後水道",
          latitude: "N33.2",
          longitude: "E132.4",
          depth: "10km",
          depthValue: numericSpecialValue("10000", 10),
          magnitude: "5.0",
          magnitudeValue: numericSpecialValue("5.0", 5),
        },
      }));
      const result = tracker.update(createEewInfo({
        serial: "2",
        eventId: "event-value-to-container",
        earthquake: undefined,
      }));

      expect(result.diff?.previousMagnitudeValue).toMatchObject({ presence: "value", value: 5 });
      expect(result.diff?.currentMagnitudeValue).toMatchObject({ presence: "missing" });
      expect(result.diff?.previousDepthValue).toMatchObject({ presence: "value", value: 10 });
      expect(result.diff?.currentDepthValue).toMatchObject({ presence: "missing" });
    });

    it.each([
      ["canonical→scalar-only", true],
      ["scalar-only→canonical", false],
    ])("%s の同じ意味は非発火", (_label, canonicalFirst) => {
      const canonicalEarthquake = {
        originTime: "2024-04-17T23:14:54+09:00",
        hypocenterName: "豊後水道",
        latitude: "N33.2",
        longitude: "E132.4",
        depth: "10km",
        depthValue: numericSpecialValue("10000", 10),
        magnitude: "5.0",
        magnitudeValue: numericSpecialValue("5.0", 5),
      };
      const scalarEarthquake = {
        originTime: "2024-04-17T23:14:54+09:00",
        hypocenterName: "豊後水道",
        latitude: "N33.2",
        longitude: "E132.4",
        depth: "10km",
        magnitude: "5.0",
      };
      const eventId = canonicalFirst ? "event-canonical-scalar" : "event-scalar-canonical";
      tracker.update(createEewInfo({
        serial: "1",
        eventId,
        earthquake: canonicalFirst ? canonicalEarthquake : scalarEarthquake,
      }));
      const result = tracker.update(createEewInfo({
        serial: "2",
        eventId,
        earthquake: canonicalFirst ? scalarEarthquake : canonicalEarthquake,
      }));

      expect(result.diff).toBeUndefined();
    });

    it("同じ range presence でも bounds のみの変化を検出する", () => {
      const range = (upperBound: number): SpecialValue<number> => ({
        raw: "5",
        value: null,
        condition: null,
        description: null,
        presence: "range",
        lowerBound: 5,
        upperBound,
      });
      const earthquake = {
        originTime: "2024-04-17T23:14:54+09:00",
        hypocenterName: "豊後水道",
        latitude: "N33.2",
        longitude: "E132.4",
        depth: "10km",
        depthValue: numericSpecialValue("10000", 10),
        magnitude: "5.0",
        magnitudeValue: range(7),
      };
      tracker.update(createEewInfo({
        serial: "1",
        eventId: "event-bounds-only",
        earthquake,
      }));
      const result = tracker.update(createEewInfo({
        serial: "2",
        eventId: "event-bounds-only",
        earthquake: {
          ...earthquake,
          magnitudeValue: range(8),
        },
      }));

      expect(result.diff?.previousMagnitudeValue).toMatchObject({
        presence: "range",
        lowerBound: 5,
        upperBound: 7,
      });
      expect(result.diff?.currentMagnitudeValue).toMatchObject({
        presence: "range",
        lowerBound: 5,
        upperBound: 8,
      });
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
      // 前回の bounded range を上端だけへ折り畳まず保持する。
      expect(result.diff?.previousMaxInt).toBe("4〜5-");
    });

    it("To 基準最大が同値なら diff を出さない (From 差では発火しない)", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "4", intensityTo: "5-" }]));
      const result = tracker.update(eewInfoWith("2", [{ name: "北部", intensity: "5-" }]));
      expect(result.diff?.previousMaxInt).toBeUndefined();
    });

    const special = (
      value: Partial<SpecialValue<JmaIntensity>>,
    ): SpecialValue<JmaIntensity> => ({
      raw: null,
      value: null,
      condition: null,
      description: null,
      presence: "missing",
      ...value,
    });

    it.each([
      ["exact", { name: "A", intensity: "4" }, 4, "4", "below"],
      ["range", { name: "A", intensity: "4", intensityTo: "5-" }, 5, "4〜5-", "pass"],
      ["lower bound", { name: "A", intensity: "5-", intensityTo: "over" }, 5, "5-程度以上", "pass"],
      ["unknown To", { name: "A", intensity: "4", intensityTo: "未入電" }, null, "4〜未入電", "unknown"],
      ["plain 未入電", {
        name: "A",
        intensity: "",
        intensityValue: special({ raw: "", condition: "未入電", presence: "unknown" }),
      }, null, "未入電", "unknown"],
      ["5弱以上未入電", {
        name: "A",
        intensity: "",
        intensityValue: special({
          raw: "",
          condition: "5弱以上未入電",
          presence: "qualitative",
          lowerBound: "5-",
        }),
      }, 5, "5弱以上未入電", "pass"],
    ] as const)("safety evaluation: %s", (_label, area, rank, summary, gate) => {
      const evaluation = evaluateEewForecastArea(area);
      expect(evaluation).toMatchObject({ safetyRank: rank, summaryLabel: summary });
      expect(evaluateEewIntensitySafetyGate(evaluation, 5)).toBe(gate);
    });

    it("全体 ForecastInt と地域別 From/To を同じ safety rank で最大化する", () => {
      const maxIntValue = special({
        raw: "4",
        presence: "range",
        lowerBound: "4",
        upperBound: "5-",
        rawLowerBound: "4",
        rawUpperBound: "5-",
      });
      expect(getMaxForecastIntensityEvaluation({
        maxInt: "4",
        maxIntValue,
        areas: [{ name: "地域", intensity: "4" }],
      })).toMatchObject({
        specialValue: maxIntValue,
        safetyRank: 5,
        summaryLabel: "4〜5-",
      });
    });

    it("地域なしでも全体 5弱以上未入電を safety gate の対象にする", () => {
      const evaluation = getMaxForecastIntensityEvaluation({
        maxInt: "",
        maxIntValue: special({
          raw: "",
          condition: "5弱以上未入電",
          presence: "qualitative",
          lowerBound: "5-",
        }),
        areas: [],
      });
      expect(evaluation?.summaryLabel).toBe("5弱以上未入電");
      expect(evaluateEewIntensitySafetyGate(evaluation, 5)).toBe("pass");
    });

    it("閾値未満 known と unknown の混在を below にせず、高い known は unknown より優先する", () => {
      const unknown = special({ raw: "", condition: "未入電", presence: "unknown" });
      const below = getMaxForecastIntensityEvaluation({
        areas: [
          { name: "既知地域", intensity: "4" },
          { name: "未入電地域", intensity: "", intensityValue: unknown },
        ],
      });
      expect(below).toMatchObject({ safetyRank: 4, hasUnknownCandidates: true });
      expect(below?.summaryLabel).toBe("4以上の可能性・一部不明");
      expect(evaluateEewIntensitySafetyGate(below, 5)).toBe("unknown");

      const passing = getMaxForecastIntensityEvaluation({
        areas: [
          { name: "既知地域", intensity: "5-" },
          { name: "未入電地域", intensity: "", intensityValue: unknown },
        ],
      });
      expect(passing).toMatchObject({ safetyRank: 5, hasUnknownCandidates: true });
      expect(evaluateEewIntensitySafetyGate(passing, 5)).toBe("pass");
    });

    it("lower-only range と unknown の混在は上方開放表現を重ねない", () => {
      const lowerOnly = special({
        raw: "5-",
        presence: "range",
        lowerBound: "5-",
        rawLowerBound: "5-",
        rawUpperBound: "over",
      });
      const unknown = special({ raw: "", condition: "未入電", presence: "unknown" });
      const evaluation = getMaxForecastIntensityEvaluation({
        areas: [
          { name: "下限地域", intensity: "5-", intensityTo: "over", intensityValue: lowerOnly },
          { name: "未入電地域", intensity: "", intensityValue: unknown },
        ],
      });

      expect(evaluation).toMatchObject({ safetyRank: 5, hasUnknownCandidates: true });
      expect(evaluation?.summaryLabel).toBe("5-程度以上・一部不明");
      expect(evaluation?.summaryLabel).not.toContain("以上以上");

      const lowerOnlyAlone = getMaxForecastIntensityEvaluation({
        areas: [
          { name: "下限地域", intensity: "5-", intensityTo: "over", intensityValue: lowerOnly },
        ],
      });
      expect(lowerOnlyAlone).toMatchObject({
        safetyRank: 5,
        hasUnknownCandidates: false,
        summaryLabel: "5-程度以上",
      });
    });

    it("known から unknown への訂正は previousMaxInt の降格差分にしない", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "6-" }]));
      const unknownArea = {
        name: "北部",
        intensity: "",
        intensityValue: special({ raw: "", condition: "未入電", presence: "unknown" }),
      };
      const result = tracker.update(createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial: "2",
        eventId: "20260705000000",
        forecastIntensity: { areas: [unknownArea] },
      }));
      expect(result.diff?.previousMaxInt).toBeUndefined();
      expect(result.currentForecastIntensity?.summaryLabel).toBe("未入電");
      expect(result.effectiveForecastSafetyRank).toBe(7);

      const repeatedUnknown = tracker.update(createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial: "3",
        eventId: "20260705000000",
        forecastIntensity: { areas: [unknownArea] },
      }));
      expect(repeatedUnknown.diff?.previousMaxInt).toBeUndefined();
      expect(repeatedUnknown.currentForecastIntensity?.summaryLabel).toBe("未入電");
      expect(repeatedUnknown.effectiveForecastSafetyRank).toBe(7);

      const resolvedLower = tracker.update(eewInfoWith("4", [{ name: "北部", intensity: "4" }]));
      expect(resolvedLower.diff?.previousMaxInt).toBe("未入電");
      expect(resolvedLower.effectiveForecastSafetyRank).toBe(4);
    });

    it("known high から下限だけの qualitative への訂正も降格根拠にしない", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "6-" }]));
      const qualitative = special({
        raw: "",
        condition: "5弱以上未入電",
        presence: "qualitative",
        lowerBound: "5-",
      });
      const result = tracker.update(createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial: "2",
        eventId: "20260705000000",
        forecastIntensity: {
          areas: [{ name: "北部", intensity: "", intensityValue: qualitative }],
        },
      }));

      expect(result.diff?.previousMaxInt).toBeUndefined();
      expect(result.currentForecastIntensity?.summaryLabel).toBe("5弱以上未入電");
      expect(result.effectiveForecastSafetyRank).toBe(7);
      expect(evaluateEewIntensitySafetyGate(
        getMaxForecastIntensityEvaluation({
          areas: [{ name: "北部", intensity: "", intensityValue: qualitative }],
        }),
        5,
      )).toBe("pass");
    });

    it("VXSE45 後の抑止 VXSE43 は EventID 全体の safety state を降格させない", () => {
      const tracker = new EewTracker();
      tracker.update(createEewInfo({
        type: "VXSE45",
        serial: "1",
        eventId: "suppressed-family-safety",
        forecastIntensity: { areas: [{ name: "北部", intensity: "6-" }] },
      }));
      const suppressed = tracker.update(createEewInfo({
        type: "VXSE43",
        serial: "1",
        eventId: "suppressed-family-safety",
        forecastIntensity: { areas: [{ name: "北部", intensity: "4" }] },
      }));
      expect(suppressed.isSuppressed).toBe(true);
      expect(suppressed.effectiveForecastSafetyRank).toBe(7);

      const result = tracker.update(createEewInfo({
        type: "VXSE45",
        serial: "2",
        eventId: "suppressed-family-safety",
        forecastIntensity: {
          areas: [{
            name: "北部",
            intensity: "",
            intensityValue: special({ raw: "", condition: "未入電", presence: "unknown" }),
          }],
        },
      }));

      expect(result.currentForecastIntensity?.summaryLabel).toBe("未入電");
      expect(result.effectiveForecastSafetyRank).toBe(7);
    });

    it("地域なし／構造的 missing は前回 known card scalar を保持しない", () => {
      const tracker = new EewTracker();
      tracker.update(eewInfoWith("1", [{ name: "北部", intensity: "6-" }]));
      const result = tracker.update(createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial: "2",
        eventId: "20260705000000",
        forecastIntensity: { areas: [] },
      }));

      expect(result.currentForecastIntensity).toBeUndefined();
      expect(result.effectiveForecastSafetyRank).toBeUndefined();
    });

    it("unknown から known への解決は qualifier を previousMaxInt に残す", () => {
      const tracker = new EewTracker();
      tracker.update(createEewInfo({
        reportDateTime: new Date().toISOString(),
        serial: "1",
        eventId: "20260705000000",
        forecastIntensity: {
          areas: [{
            name: "北部",
            intensity: "",
            intensityValue: special({ raw: "", condition: "未入電", presence: "unknown" }),
          }],
        },
      }));
      const result = tracker.update(eewInfoWith("2", [{ name: "北部", intensity: "5-" }]));
      expect(result.diff?.previousMaxInt).toBe("未入電");
    });
  });
});
