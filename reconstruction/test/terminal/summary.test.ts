import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { at, eewOutcome, eewUnits, harness, inputDoneOf, reportOf } from "./terminal-fixture";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(21, 20, 0)); });
afterEach(() => { vi.useRealTimers(); });

describe("P3-TO-T12 定期要約（spec §6.2、AC11）", () => {
  it("区切りの時刻に分野ごとの件数と最大震度の 1 行を出し、何も無い区切りは「受信なし」", async () => {
    const h = harness({ summaryInterval: 10 });
    h.attach();
    const [eew] = eewUnits(["37_01_01_240613_VXSE43.xml"]).flat();
    if (eew.kind !== "eew") throw new Error(eew.kind);
    h.output.sink.inputDone(inputDoneOf("eew", null, [eewOutcome(eew.subject)]));
    for (const path of ["32-35_01_03_240613_VXSE53.xml", "32-35_01_02_240613_VXSE52.xml", "32-35_03_02_240613_VXSE61.xml"]) {
      h.output.sink.inputDone(inputDoneOf(path, reportOf(path, "U-Q")));
    }
    h.output.sink.inputDone(inputDoneOf("tsunami", reportOf("32-39_11_02_250206_VTSE41.xml", "U-T")));
    const weather = reportOf("18_00_01_260830_VPWW55_fukui_L5.xml", "U-W");
    for (let index = 0; index < 12; index += 1) h.output.sink.inputDone(inputDoneOf(`weather-${index}`, weather));
    // 80 桁で折り返した続きの行（2 字下げ）を繋いでから要約の行を拾う。
    const summaries = () => h.lines.join("\n").replace(/\n {2}/g, "").split("\n").filter((line) => line.startsWith("── ") && line.includes(" の受信 ── "));
    vi.advanceTimersByTime(at(21, 30, 0) - Date.now());
    expect(summaries()).toEqual(["── 21:20〜21:30 の受信 ── EEW 1件 ・ 地震 3件（最大震度 5弱） ・ 津波 1件 ・ 気象 12件"]);
    vi.advanceTimersByTime(10 * 60_000);
    expect(summaries().slice(1)).toEqual(["── 21:30〜21:40 の受信 ── 受信なし"]);
    await h.output.close();
  });

  // 実不具合の再発防止（r0 のレビュー）: tick は 1 秒ごとなので、区切りの直後の受信が前の時間に数えられていた。
  it("区切りの直後（次の tick の前）の受信は、先に前の時間の要約を出してから次の時間に数える", async () => {
    vi.setSystemTime(at(21, 20, 0) + 500);
    const h = harness({ summaryInterval: 10 });
    h.attach();
    vi.advanceTimersByTime(at(21, 30, 0) + 100 - Date.now());
    h.output.sink.inputDone(inputDoneOf("tsunami", reportOf("32-39_11_02_250206_VTSE41.xml", "U-T")));
    // tick は毎秒 .500 なので、21:40 の区切りは 21:40:00.500 の tick で出る。
    vi.advanceTimersByTime(at(21, 40, 1) - Date.now());
    const summaries = h.lines.join("\n").replace(/\n {2}/g, "").split("\n").filter((line) => line.startsWith("── ") && line.includes(" の受信 ── "));
    expect(summaries).toEqual(["── 21:20〜21:30 の受信 ── 受信なし", "── 21:30〜21:40 の受信 ── 津波 1件"]);
    // P3-CLI-T18 (a)（C19 の Q-TO-IMPL-2 (8) の残した P3、P3-CLI-AC27 (1)）: 前の時間の要約の行が、区切りの直後の報のブロックより先に出る。
    expect(h.lines.findIndex((line) => line.startsWith("── 21:20〜21:30 の受信 ──"))).toBeLessThan(h.lines.findIndex((line) => line.startsWith("━")));
    await h.output.close();
  });

  // P3-CLI-T18 (b) acceptance（P3-CLI-D-O3-SUMMARY-OFF=A）: 0 はその場で止め、区切りに 1 行を出さない。
  it("間隔の途中で 0 にすると、その時間の要約も出さずに止まる", async () => {
    const h = harness({ summaryInterval: 10 });
    h.attach();
    vi.advanceTimersByTime(at(21, 25, 0) - Date.now());
    h.output.control.setSummaryInterval(0);
    vi.advanceTimersByTime(at(21, 31, 0) - Date.now());
    expect(h.lines.filter((line) => line.startsWith("── "))).toEqual([]);
    await h.output.close();
  });

  // P3-CLI-T18 (c) regression（品質レビュー r0 の P2、P3-CLI-AC27 (1)）: 区切りの直後の summary now が期限の過ぎた区切りを残すと、次の tick が空の 1 行を足した。
  it("区切りの直後の summary now は前の時間の 1 行だけを出し、区切りを次へ進める", async () => {
    vi.setSystemTime(at(21, 20, 0) + 500);
    const h = harness({ summaryInterval: 10 });
    h.attach();
    vi.advanceTimersByTime(at(21, 30, 0) + 100 - Date.now());
    h.output.control.summaryNow();
    vi.advanceTimersByTime(at(21, 39, 0) - Date.now());
    expect(h.lines.filter((line) => line.startsWith("── "))).toEqual(["── 21:20〜21:30 の受信 ── 受信なし"]);
    await h.output.close();
  });

  // 実不具合の再発防止（発注 3 の品質レビュー r0 の F2）: 受信 1 回の中で時計を 2 回読むと、区切りの直前の受信で報が先に出て、次の時間に数えられた。
  it("区切りの直前の受信は、1 回読んだ時刻で前の時間に数え、その時間の要約が報の後に出る", async () => {
    vi.setSystemTime(at(21, 20, 0) + 500);
    // 読むたびに 1 ms 進む時計（skew を true にした間だけ）。区切りの 1 ms 前に受けると、2 回目の読みが区切りを越える。
    let skew = false, extra = 0;
    const clock = () => { const ms = Date.now() + (skew ? extra++ : 0); return { wallTimeMs: ms, monotonicMs: ms }; };
    const h = harness({ summaryInterval: 10, clock });
    h.attach();
    vi.advanceTimersByTime(at(21, 30, 0) - 1 - Date.now());
    skew = true;
    h.output.sink.inputDone(inputDoneOf("tsunami", reportOf("32-39_11_02_250206_VTSE41.xml", "U-T")));
    skew = false;
    vi.advanceTimersByTime(at(21, 30, 1) - Date.now());
    const summaries = h.lines.filter((line) => line.startsWith("── ") && line.includes(" の受信 ── "));
    expect(summaries).toEqual(["── 21:20〜21:30 の受信 ── 津波 1件"]);
    expect(h.lines.findIndex((line) => line.startsWith("━"))).toBeLessThan(h.lines.indexOf(summaries[0]));
    await h.output.close();
  });
});
