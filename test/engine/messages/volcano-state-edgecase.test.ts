import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import {
  activeLegacyEruptionIdentitySeeds,
  VolcanoStateHolder,
} from "../../../src/engine/messages/volcano-state";
import type { ParsedVolcanoAlertInfo } from "../../../src/types";

/**
 * gate 通過後だけを受け取る VolcanoStateHolder の subject 分離テスト。
 * revision/tombstone の敵対シーケンスは phase3b-volcano.test.ts が共通 gate
 * との統合経路で固定する。
 */

function alert(overrides: Partial<ParsedVolcanoAlertInfo> = {}): ParsedVolcanoAlertInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "alert",
    type: "VFVO50",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime: "2025-01-01T10:00:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "浅間山",
    volcanoCode: "306",
    coordinate: "+3624.38+13831.38+2568/",
    isTest: false,
    alertLevel: 3,
    alertLevelCode: "13",
    alertClass: null,
    action: "raise",
    previousLevelCode: "12",
    warningKind: "噴火警報（火口周辺）",
    municipalities: [],
    marineAreas: [],
    marineWarningKind: null,
    marineAlertLevelCode: null,
    bodyText: "",
    preventionText: "",
    isMarine: false,
    ...overrides,
  };
}

describe("VolcanoStateHolder accepted mutation", () => {
  it("一方の火山更新が別火山を変更しない", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", volcanoName: "浅間山", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 3, alertLevelCode: "13" }));
    state.update(alert({ volcanoCode: "506", volcanoName: "桜島", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 5, alertLevelCode: "15" }));
    expect(state.size()).toBe(2);

    state.applyAcceptedAlert(alert({ volcanoCode: "306", alertLevel: 2, alertLevelCode: "12", action: "lower" }));
    expect(state.getEntry("306")!.alertLevel).toBe(2);
    expect(state.getEntry("506")!.alertLevel).toBe(5);
  });

  it("取消は対象火山のエントリだけを消し、他火山を維持する", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", volcanoName: "浅間山", alertLevel: 3 }));
    state.update(alert({ volcanoCode: "506", volcanoName: "桜島", alertLevel: 5 }));

    // 306 の取消 (より新しい時刻) → 306 のみ削除
    state.update(alert({ volcanoCode: "306", infoType: "取消", reportDateTime: "2025-01-01T11:00:00+09:00" }));
    expect(state.getEntry("306")).toBeUndefined();
    expect(state.getEntry("506")).toBeDefined();
    expect(state.size()).toBe(1);
  });

  it("clearAlert は指定 subject だけを消す", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 3 }));

    state.update(alert({ volcanoCode: "506", alertLevel: 4 }));
    state.clearAlert("306");
    expect(state.getEntry("306")).toBeUndefined();
    expect(state.getEntry("506")?.alertLevel).toBe(4);
  });

  it("persisted state は alert と eruption の subject を独立に往復する", () => {
    const state = new VolcanoStateHolder();
    state.applyAcceptedAlert(alert({ volcanoCode: "306", alertLevel: 4, alertLevelCode: "14" }));
    state.restorePersistedState({
      ...state.exportPersistedState(),
      eruptions: [{ volcanoCode: "506", eventId: "eruption-1" }],
    });
    expect(state.getEntry("306")?.alertLevel).toBe(4);
    expect(state.resolveEruptionCancellation("eruption-1")).toBe("506");
  });

  it("legacy 噴火 identity は未失効かつ foundation 管理外の state だけを seed する", () => {
    expect(activeLegacyEruptionIdentitySeeds([
      { code: "306", latestEvent: {}, latestEventId: null, eventExpiresAtMs: 10_001 },
      { code: "506", latestEvent: {}, latestEventId: "expired", eventExpiresAtMs: 10_000 },
      { code: "509", latestEvent: {}, latestEventId: "managed", eventExpiresAtMs: 20_000 },
    ], new Set(["volcano:eruption:509"]), 10_000)).toEqual([
      { volcanoCode: "306", eventId: null },
    ]);
  });

  it("同一火山の alert clear は legacy eruption identity を消さず、eruption clear だけが消す", () => {
    const state = new VolcanoStateHolder();
    state.seedLegacyEruptionIdentities([{ volcanoCode: "506", eventId: "eruption-506" }]);
    state.applyAcceptedAlert(alert({ volcanoCode: "506", volcanoName: "桜島" }));

    expect(state.clearAlert("506", "alert-cancel")).toBe(true);
    expect(state.resolveEruptionCancellation("eruption-506")).toBe("506");

    expect(state.clearEruption("506", "eruption-cancel")).toBe(true);
    expect(state.resolveEruptionCancellation("eruption-506")).toBeNull();
  });

  it("accepted slice clear は nonblank canonical volcano name だけを採用する", () => {
    const state = new VolcanoStateHolder();
    expect(state.applyAcceptedAlert(alert({
      volcanoCode: "506",
      volcanoName: "Old Name",
    }))).toBe(true);

    expect(state.clearAshfall("506", "ashfall-ga", "  New\u3000Name  ")).toBe(true);
    expect(state.composite("506")?.volcanoName).toBe("New Name");

    expect(state.clearAshfall("506", "ashfall-ga-2", "   ")).toBe(true);
    expect(state.composite("506")?.volcanoName).toBe("New Name");
  });
});
