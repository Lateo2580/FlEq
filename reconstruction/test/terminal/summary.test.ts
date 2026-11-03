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
    await h.output.close();
  });
});
