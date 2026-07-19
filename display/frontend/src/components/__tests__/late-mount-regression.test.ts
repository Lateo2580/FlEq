import { describe, it, expect } from "vitest";
import { render } from "@testing-library/svelte";
import LateMountHarness from "./LateMountHarness.svelte";
import type { DisplayLargeQuakeInputV1 } from "../../lib/protocol";

// createPageCycler のコンストラクタ flushSync 再入バグ (2026-07-12 Chrome 実測で発見) の回帰ガード。
// App.svelte の実経路 (待機↔緊急の swap で QuakePanel/TsunamiPanel を後からマウント) と同型の
// 「初期 flush 完了後に cycler 持ちコンポーネントを {#if}/{:else} の swap でリアクティブマウント」を
// 再現する。修正前は destroy_effect の無限再帰 (Maximum call stack) でマウントが中断し
// .quake-panel が描画されなかった。cycler を持つコンポーネントを後発マウントしても落ちないことを固定する。

function quakeInput(over: Partial<DisplayLargeQuakeInputV1> = {}): DisplayLargeQuakeInputV1 {
  return {
    kind: "largeQuake",
    eventId: "Q-latemount",
    originTime: "2026-07-07T09:58:00+09:00",
    hypocenterName: "日向灘",
    magnitude: "7.1",
    maxInt: "6強",
    maxIntRank: 8,
    intensityGroups: [{ intensity: "6強", rank: 8, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    depth: "20km",
    maxLgInt: "3",
    tsunamiWarning: true,
    ...over,
  };
}

describe("cycler 持ちコンポーネントの後発リアクティブマウント (createPageCycler 再入回帰)", () => {
  it("初期 flush 後に待機→緊急の swap で QuakePanel を後からマウントしてもクラッシュせず描画される", async () => {
    // 初期は待機 (cycler 無し) をマウントして初期 flush を確定させる
    const { container, rerender } = render(LateMountHarness, { emergency: false, input: quakeInput() });
    expect(container.querySelector(".standby-placeholder")).toBeTruthy();

    // 進行中フラッシュ内で cycler 持ち QuakePanel を後からマウントする (App.svelte の mode swap 相当)。
    // 修正前はここで createPageCycler の flushSync が再入し destroy_effect が無限再帰していた。
    await rerender({ emergency: true, input: quakeInput() });

    // マウントが中断されず QuakePanel が実際に描画されている (再入クラッシュしていない証跡)
    expect(container.querySelector(".quake-panel")).toBeTruthy();
    expect(container.querySelector(".standby-placeholder")).toBeFalsy();
  });
});
