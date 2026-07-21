import { describe, it, expect } from "vitest";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import type { ParsedVolcanoAlertInfo } from "../../../src/types";

/**
 * VolcanoStateHolder の敵対的シーケンステスト。
 *
 * volcano-state.test.ts に基本挙動 (追加/削除/再通知判定/単一火山の release
 * tombstone) が入っているので、このファイルは複数火山が並走する状況での
 * 「火山別 watermark の独立性」「取消の対象火山限定」「古い時刻の取消が
 * エントリを消さないこと」「取消→再上昇→古い報の遅着」を集める。
 *
 * watermark 判定 (reportTime < watermark → false) が 取消/解除 branch より
 * 前段にあり、かつ火山コード単位で独立している点が要点。
 */

function alert(overrides: Partial<ParsedVolcanoAlertInfo> = {}): ParsedVolcanoAlertInfo {
  return {
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
    action: "raise",
    previousLevelCode: "12",
    warningKind: "噴火警報（火口周辺）",
    municipalities: [],
    bodyText: "",
    preventionText: "",
    isMarine: false,
    ...overrides,
  };
}

describe("VolcanoStateHolder 敵対シーケンス", () => {
  it("火山別 watermark は独立: 片方の古い報がもう片方を巻き戻さない", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", volcanoName: "浅間山", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 3, alertLevelCode: "13" }));
    state.update(alert({ volcanoCode: "506", volcanoName: "桜島", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 5, alertLevelCode: "15" }));
    expect(state.size()).toBe(2);

    // 306 の古い報 (09:00 < watermark 10:00) は棄却され、306 は Lv3 のまま
    expect(state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T09:00:00+09:00", alertLevel: 2, alertLevelCode: "12", action: "lower" }))).toBe(false);
    expect(state.getEntry("306")!.alertLevel).toBe(3);
    // 506 は別火山として無傷
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

  it("watermark より古い時刻の取消はエントリを消さない (遅着取消の無効化)", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 3 }));

    // 発表より前の時刻を持つ取消 → watermark で棄却され、エントリは残る
    expect(state.update(alert({ volcanoCode: "306", infoType: "取消", reportDateTime: "2025-01-01T09:00:00+09:00" }))).toBe(false);
    expect(state.getEntry("306")!.alertLevel).toBe(3);
  });

  it("取消→再上昇→古い報の遅着: 再上昇後の状態を古い報が壊さない", () => {
    const state = new VolcanoStateHolder();
    state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T10:00:00+09:00", alertLevel: 3 }));
    // 取消 (11:00) で削除、watermark は 11:00 に前進
    state.update(alert({ volcanoCode: "306", infoType: "取消", reportDateTime: "2025-01-01T11:00:00+09:00" }));
    expect(state.getEntry("306")).toBeUndefined();

    // 再上昇 (12:00) → 受理
    state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T12:00:00+09:00", alertLevel: 4, alertLevelCode: "14" }));
    expect(state.getEntry("306")!.alertLevel).toBe(4);

    // 取消と再上昇の間の古い報 (10:30) が遅れて届く → 棄却され Lv4 を維持
    expect(state.update(alert({ volcanoCode: "306", reportDateTime: "2025-01-01T10:30:00+09:00", alertLevel: 2, alertLevelCode: "12", action: "lower" }))).toBe(false);
    expect(state.getEntry("306")!.alertLevel).toBe(4);
  });
});
