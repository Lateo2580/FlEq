import { describe, expect, it } from "vitest";
import { WeatherChangeDisplayStore } from "../../../src/engine/display/weather-change-store";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import type {
  Vpws50Diff,
  Vpws50DisplayDiff,
  Vpws50DisplayKindTransition,
} from "../../../src/types";

const NOW = Date.parse("2026-08-13T12:00:00.000Z");

function transition(over: Partial<Vpws50DisplayKindTransition> = {}): Vpws50DisplayKindTransition {
  return {
    phenomenonKey: "大雨",
    kindShortName: "大雨警報",
    prevKindShortName: "大雨注意報",
    prevKindCode: "10",
    newKindCode: "03",
    prevSeverity: "advisory",
    newSeverity: "warning",
    prevDisplaySeverity: "officialL2",
    newDisplaySeverity: "officialL3",
    prevOfficialAlertLevel: 2,
    newOfficialAlertLevel: 3,
    ...over,
  };
}

function diff(over: Partial<Vpws50Diff> = {}): Vpws50Diff {
  const { prevKindShortName: _prevKindShortName, ...notificationTransition } = transition();
  return {
    isFirstReport: false,
    isUnchanged: false,
    isCancelRollback: false,
    shouldRecap: false,
    confidence: "confirmed",
    added: [],
    upgraded: [{
      areaCode: "13101",
      areaName: "千代田区",
      changes: [notificationTransition],
    }],
    downgraded: [],
    released: [],
    ...over,
  };
}

function displayDiff(over: Partial<Vpws50DisplayDiff> = {}): Vpws50DisplayDiff {
  return {
    added: [],
    upgraded: [{ areaCode: "13101", areaName: "千代田区", changes: [transition()] }],
    downgraded: [],
    released: [],
    kindChanged: [],
    ...over,
  };
}

function event(over: Partial<PresentationEvent> = {}): PresentationEvent {
  return {
    id: "event-1",
    classification: "telegram.weather",
    domain: "weather",
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    headline: null,
    reportDateTime: "2026-08-13T20:00:00+09:00",
    publishingOffice: "気象庁",
    isTest: false,
    frameLevel: "warning",
    isCancellation: false,
    weatherConfidence: "confirmed",
    weatherStateMutationAccepted: true,
    weatherDiff: diff(),
    weatherChangeDiff: displayDiff(),
    ...over,
  } as PresentationEvent;
}

describe("WeatherChangeDisplayStore", () => {
  it("VPWW56 は案 C の対象外で weatherChange を生成しない", () => {
    const store = new WeatherChangeDisplayStore();
    expect(store.apply(event({ type: "VPWW56" }), NOW)).toBe(false);
    expect(store.snapshot(NOW)).toBeNull();
  });

  it("受理済み VPWW55 の降格 diff も短時間変更表示へ載せる", () => {
    const store = new WeatherChangeDisplayStore();
    const lowered = displayDiff({
      upgraded: [],
      downgraded: [{
        areaCode: "180000",
        areaName: "福井県",
        changes: [transition({
          prevKindCode: "33", newKindCode: "43",
          prevDisplaySeverity: "officialL5", newDisplaySeverity: "officialL4",
          prevOfficialAlertLevel: 5, newOfficialAlertLevel: 4,
        })],
      }],
    });
    expect(store.apply(event({
      type: "VPWW55",
      weatherDiff: diff({ upgraded: [], downgraded: [{
        areaCode: "180000", areaName: "福井県", changes: [],
      }] }),
      weatherChangeDiff: lowered,
    }), NOW)).toBe(true);
    expect(store.snapshot(NOW)?.changes[0]).toMatchObject({
      areaCode: "180000", kind: "downgraded",
      before: { kindCode: "33", officialAlertLevel: 5 },
      after: { kindCode: "43", officialAlertLevel: 4 },
    });
  });

  it("accepted changed を作成し、続報で原子的に置換する", () => {
    const store = new WeatherChangeDisplayStore();
    store.apply(event(), NOW);
    const first = store.snapshot(NOW);
    expect(first?.source).toBe("vpws50");
    expect(first?.changes).toHaveLength(1);
    expect(first?.changes[0]).toMatchObject({
      areaCode: "13101",
      areaName: "千代田区",
      kind: "upgraded",
      before: { kindShortName: "大雨注意報", kindCode: "10", officialAlertLevel: 2 },
      after: { kindShortName: "大雨警報", kindCode: "03", officialAlertLevel: 3 },
    });
    expect(Date.parse(first!.expiresAt) - Date.parse(first!.issuedAt)).toBe(60_000);

    store.apply(event({ id: "event-2", reportDateTime: "2026-08-13T20:01:00+09:00" }), NOW + 1_000);
    const replaced = store.snapshot(NOW + 1_000);
    expect(replaced?.changeKey).not.toBe(first?.changeKey);
    expect(replaced?.issuedAt).toBe(new Date(NOW + 1_000).toISOString());
  });

  it("accepted unchanged・初回・rollback は clear、unsafe は旧 DTO も clear する", () => {
    const store = new WeatherChangeDisplayStore();
    store.apply(event(), NOW);
    expect(store.apply(event({
      weatherDiff: diff({ isUnchanged: true, upgraded: [] }),
      weatherChangeDiff: displayDiff({ upgraded: [] }),
    }), NOW + 1)).toBe(true);
    expect(store.snapshot(NOW + 1)).toBeNull();

    store.apply(event(), NOW + 2);
    expect(store.apply(event({ weatherDiff: diff({ isFirstReport: true }) }), NOW + 3)).toBe(true);
    expect(store.snapshot(NOW + 3)).toBeNull();

    store.apply(event(), NOW + 4);
    expect(store.apply(event({ weatherDiff: diff({ isCancelRollback: true }) }), NOW + 5)).toBe(true);
    expect(store.snapshot(NOW + 5)).toBeNull();

    store.apply(event(), NOW + 6);
    expect(store.apply(event({ weatherConfidence: "unsafe", weatherStateMutationAccepted: false }), NOW + 7)).toBe(true);
    expect(store.snapshot(NOW + 7)).toBeNull();
  });

  it("gate suppressed 相当の非authoritative event は no-op、code-only kindChanged は非表示", () => {
    const store = new WeatherChangeDisplayStore();
    store.apply(event(), NOW);
    expect(store.apply(event({ weatherStateMutationAccepted: false }), NOW + 1)).toBe(false);
    expect(store.snapshot(NOW + 1)?.changeKey).toBeDefined();

    const codeOnly = displayDiff({
      upgraded: [],
      kindChanged: [{
        areaCode: "13101",
        areaName: "千代田区",
        changes: [transition({ prevKindShortName: "大雨", kindShortName: "大雨", prevKindCode: "03", newKindCode: "43" })],
      }],
    });
    expect(store.apply(event({
      weatherDiff: diff({ isUnchanged: true, upgraded: [] }),
      weatherChangeDiff: codeOnly,
    }), NOW + 2)).toBe(true);
    expect(store.snapshot(NOW + 2)).toBeNull();
  });

  it("通知用 diff が unchanged でも表示名変更は表示専用 kindChanged から DTO 化する", () => {
    const store = new WeatherChangeDisplayStore();
    const labelChange = displayDiff({
      upgraded: [],
      kindChanged: [{
        areaCode: "13101",
        areaName: "千代田区",
        changes: [transition({
          prevKindShortName: "大雨",
          kindShortName: "大雨極端危険情報",
          prevKindCode: "33",
          newKindCode: "33",
          prevSeverity: "specialWarning",
          newSeverity: "specialWarning",
          prevDisplaySeverity: "officialL5",
          newDisplaySeverity: "officialL5",
          prevOfficialAlertLevel: 5,
          newOfficialAlertLevel: 5,
        })],
      }],
    });

    expect(store.apply(event({
      weatherDiff: diff({ isUnchanged: true, upgraded: [] }),
      weatherChangeDiff: labelChange,
    }), NOW)).toBe(true);
    expect(store.snapshot(NOW)?.changes[0]).toMatchObject({
      kind: "kindChanged",
      before: { kindShortName: "大雨", kindCode: "33" },
      after: { kindShortName: "大雨極端危険情報", kindCode: "33" },
    });
  });

  it("60,000ms の境界で sweep・snapshot が失効し、instance ごとに空の新しい boot key を持つ", () => {
    const store = new WeatherChangeDisplayStore();
    store.apply(event(), NOW);
    const firstKey = store.snapshot(NOW)?.changeKey;
    expect(firstKey).toBeDefined();
    expect(store.sweep(NOW + 59_999)).toBe(false);
    expect(store.snapshot(NOW + 59_999)).not.toBeNull();
    // snapshot の期限 guard は非破壊。既存 client への clear dirty は sweep が所有する。
    expect(store.snapshot(NOW + 60_000)).toBeNull();
    expect(store.sweep(NOW + 60_000)).toBe(true);
    expect(store.snapshot(NOW + 60_000)).toBeNull();

    const next = new WeatherChangeDisplayStore();
    expect(next.snapshot(NOW)).toBeNull();
    next.apply(event(), NOW);
    const nextKey = next.snapshot(NOW)?.changeKey;
    expect(nextKey).toBeDefined();
    // 両 instance とも counter=1。counter-only 実装なら同値になり、この比較で落ちる。
    expect(nextKey).not.toBe(firstKey);
  });
});
