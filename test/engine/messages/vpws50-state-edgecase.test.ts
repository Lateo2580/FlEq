import { testTelegramMeta } from "../../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import type {
  ParsedWeatherWarning,
  WeatherItem,
  WeatherKind,
} from "../../../src/types";

/**
 * R1/R2 ガードレールテスト (vpws50-state-edgecase)
 *
 * vpws50-state.test.ts に既に同等の confidence/rollback テストが入っているが、
 * このファイルは R1 (parser 異常入力の safety) と R2 (state 不変・連続 rollback)
 * の境界条件だけを集めた回帰用ファイル。今後 vpws50-state にパッチが入っても
 * ここで「異常入力で state を破壊しない」最低限の契約を独立に守る。
 *
 * テスト helper は vpws50-state.test.ts と共通化したいが、現状はファイル独立を
 * 優先してコピー。
 */

function makeKind(code: string, severity: WeatherKind["severity"]): WeatherKind {
  return { name: `Kind${code}`, code, severity };
}

function makeItem(
  areaName: string,
  areaCode: string,
  kinds: WeatherKind[],
): WeatherItem {
  return { areaName, areaCode, kinds, statuses: [] };
}

function makeInfo(items: WeatherItem[]): ParsedWeatherWarning {
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 0,
    advisoryAreaCount: 0,
    isTest: false,
  };
}

describe("R1/R2 ガードレール: parser 異常時の safety", () => {
  it("layer_missing: confidence=unsafe + state 不変", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]),
      "msg-1",
    );
    const broken: ParsedWeatherWarning = { ...makeInfo([]), layers: [] };
    const diff = state.diffAndUpdate(broken, "msg-2");
    expect(diff.confidence).toBe("unsafe");
    expect(diff.unsafeReason).toBe("layer_missing");
    // state 不変確認: 次に同一電文を流すと isUnchanged=true
    const verify = state.diffAndUpdate(
      makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]),
      "msg-3",
    );
    expect(verify.isUnchanged).toBe(true);
  });

  it("items 空 + state 空: confidence=confirmed (異常ではない)", () => {
    const state = new Vpws50StateHolder();
    const diff = state.diffAndUpdate(makeInfo([]), "msg-1");
    expect(diff.confidence).toBe("confirmed");
  });

  it("items 空 + state 非空 (全種別解除): confirmed + 現況が空になる (レビュー決定 2026-07-11)", () => {
    // 全種別 (100%) 一斉解除は正当として通し、current を更新して現況を空にする。
    // これにより下流の weatherAlerts 再構築で空配列が配信され、気象カードが消える。
    // 80% 以上 100% 未満の部分大量解除だけが異常電文防御 (abnormal_release_rate) の対象。
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([
        makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
        makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
      ]),
      "msg-1",
    );
    expect(state.getCurrentAreasForDisplay()?.kinds.length).toBeGreaterThan(0);
    const diff = state.diffAndUpdate(makeInfo([]), "msg-2");
    expect(diff.confidence).toBe("confirmed");
    expect(diff.unsafeReason).toBeUndefined();
    // 現況が空 = カード消滅につながる (kinds 空・totalAreas 0。下流 weatherAlertsFromVpws50 が [] を返す)
    const view = state.getCurrentAreasForDisplay();
    expect(view?.kinds).toHaveLength(0);
    expect(view?.totalAreas).toBe(0);
  });

  it("80% 以上 100% 未満消失 (残 1 種別) → unsafe + current 据え置き", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([
        ...Array.from({ length: 10 }, (_, i) =>
          makeItem(
            `県${i}`,
            `${i.toString().padStart(2, "0")}0000`,
            [makeKind("03", "warning")],
          ),
        ),
      ]),
      "msg-1",
    );
    const diff = state.diffAndUpdate(
      makeInfo([makeItem("県0", "000000", [makeKind("03", "warning")])]),
      "msg-2",
    );
    expect(diff.confidence).toBe("unsafe");
    expect(diff.unsafeReason).toBe("abnormal_release_rate");
    // ガード発火時は current を更新しない = 旧 10 県分の現況が残る (異常電文防御は維持)
    expect(state.getCurrentAreasForDisplay()?.totalAreas).toBe(10);
  });

  it("80% 未満消失 → 通常 diff (confidence=confirmed)", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([
        makeItem("A県", "010000", [makeKind("03", "warning")]),
        makeItem("B県", "020000", [makeKind("03", "warning")]),
        makeItem("C県", "030000", [makeKind("03", "warning")]),
        makeItem("D県", "040000", [makeKind("03", "warning")]),
        makeItem("E県", "050000", [makeKind("03", "warning")]),
      ]),
      "msg-1",
    );
    const diff = state.diffAndUpdate(
      makeInfo([
        makeItem("D県", "040000", [makeKind("03", "warning")]),
        makeItem("E県", "050000", [makeKind("03", "warning")]),
      ]),
      "msg-2",
    );
    expect(diff.confidence).toBe("confirmed");
    expect(diff.released).toHaveLength(3);
  });

  it("連続 rollback は同じ対象報を二度消さず、対象不一致でも現状態を維持する", () => {
    const state = new Vpws50StateHolder();
    state.diffAndUpdate(
      makeInfo([makeItem("神奈川県", "140000", [makeKind("03", "warning")])]),
      "msg-1",
    );
    state.diffAndUpdate(
      makeInfo([
        makeItem("神奈川県", "140000", [makeKind("03", "warning")]),
        makeItem("千葉県", "120000", [makeKind("10", "advisory")]),
      ]),
      "msg-2",
    );
    const diff1 = state.rollback("msg-2");
    expect(diff1?.isCancelRollback).toBe(true);
    expect(diff1?.isFirstReport).toBe(false);
    expect(state.getCurrentAreasForDisplay()?.totalAreas).toBe(1);

    expect(state.rollback("msg-2")).toBeNull();
    expect(state.rollback("unknown-report")).toBeNull();
    expect(state.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });
});
