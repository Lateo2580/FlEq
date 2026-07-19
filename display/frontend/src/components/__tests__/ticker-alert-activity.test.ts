// Ticker → App の警報級掲載通知 (spec D5 強調層、2026-07-18 Task 6)。hasAlertActivity (Task 5) の
// scheduler 反映を onActivityChange と同型の push で App へ伝える。App 側はこれで night-dim を
// 自動サスペンドする (effectiveDim = requested && !alertActive、Task 1 の computeEffectiveDim)。
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import Ticker from "../Ticker.svelte";
import { tickerEvent } from "../../lib/__tests__/fixtures";

function weatherWarningLine(id = "wx-w") {
  return tickerEvent({
    id, tickerBody: null, tickerSentence: "気象警報の本文です。",
    summary: { text: "気象警報", role: "weatherWarning" },
  });
}

function weatherAdvisoryLine(id = "wx-a") {
  return tickerEvent({
    id, tickerBody: null, tickerSentence: "気象注意報の本文です。",
    summary: { text: "気象注意報", role: "weatherAdvisory" },
  });
}

describe("Ticker onAlertActivityChange (night-dim 自動サスペンド通知)", () => {
  it("気象通常警報の line 投入で onAlertActivityChange(true) が発火する", async () => {
    const calls: boolean[] = [];
    render(Ticker, { lines: [weatherWarningLine()], onAlertActivityChange: (a: boolean) => calls.push(a) });
    await tick();
    expect(calls.at(-1)).toBe(true);
  });

  it("注意報のみなら true にならない", async () => {
    const calls: boolean[] = [];
    render(Ticker, { lines: [weatherAdvisoryLine()], onAlertActivityChange: (a: boolean) => calls.push(a) });
    await tick();
    expect(calls).not.toContain(true);
  });

  it("警報 line が完走 (scroll-end 経由で idle 化) すると onAlertActivityChange(false) が push される", async () => {
    const calls: boolean[] = [];
    const { container } = render(Ticker, {
      lines: [weatherWarningLine()],
      onAlertActivityChange: (a: boolean) => calls.push(a),
    });
    await tick();
    expect(calls.at(-1)).toBe(true);

    const line = container.querySelector(".ticker-line");
    expect(line).toBeTruthy();
    line!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();

    expect(calls.at(-1)).toBe(false);
  });

  it("同値の連打がない (false→false: 警報非該当の変化では再通知しない、$derived の値等価間引き)", async () => {
    const onAlertActivityChange = vi.fn();
    const { rerender } = render(Ticker, { lines: [], tickerGeneration: 0, onAlertActivityChange });
    await tick();
    expect(onAlertActivityChange).toHaveBeenCalledTimes(1);
    expect(onAlertActivityChange).toHaveBeenLastCalledWith(false);

    // 注意報 (非警報) の追加は alertActive を変えない → 再通知されない
    await rerender({ lines: [weatherAdvisoryLine()], tickerGeneration: 0, onAlertActivityChange });
    await tick();
    expect(onAlertActivityChange).toHaveBeenCalledTimes(1);
  });

  it("同値の連打がない (true→true: 警報継続中の scheduler churn で再通知しない、effectiveDim のちらつき防止)", async () => {
    const onAlertActivityChange = vi.fn();
    const { rerender } = render(Ticker, {
      lines: [weatherWarningLine("wx-w1")],
      tickerGeneration: 0,
      onAlertActivityChange,
    });
    await tick();
    expect(onAlertActivityChange).toHaveBeenCalledTimes(1);
    expect(onAlertActivityChange).toHaveBeenLastCalledWith(true);

    // 警報状態を継続させたまま 2 本目の警報 line を追加投入し、scheduler を churn させる
    // (2 本目が enqueue → runTick で lane 再割当 → scheduler 参照が変わり $derived が再計算される)
    await rerender({
      lines: [weatherWarningLine("wx-w1"), weatherWarningLine("wx-w2")],
      tickerGeneration: 0,
      onAlertActivityChange,
    });
    await tick();

    // scheduler は変化したが alertActive は true のまま → 再通知されない (呼び出し回数は 1 のまま)
    expect(onAlertActivityChange).toHaveBeenCalledTimes(1);
  });

  it("onAlertActivityChange 未指定でも従来どおり動作する (crash しない)", async () => {
    const { container } = render(Ticker, { lines: [weatherWarningLine()] });
    await tick();
    const line = container.querySelector(".ticker-line");
    line!.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await expect(tick()).resolves.not.toThrow();
  });
});
