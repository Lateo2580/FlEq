import { describe, it, expect } from "vitest";
import { createMockWsDataMessage, FIXTURE_VPWW56_DOSHA } from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning } from "../../../src/types";
import type { WeatherReportIdentity } from "../../../src/engine/messages/vpws50-state";

/**
 * VPWW56 (土砂災害警戒情報) state holder の敵対的シーケンステスト。
 *
 * vpww56-state.test.ts に基本挙動 (発表/取消/順不同棄却/同時刻 serial 逆転) が
 * 入っているので、このファイルは「取消→再発表→古い取消の遅着」「不一致取消」
 * 「発表 identity の完全重複」「発表前取消」「壊れた reportDateTime」といった、
 * 現況 view を巻き戻す・破壊するために組み立てた別シーケンスだけを集める。
 * 既存ファイルと同じ観点は書かない。
 */

function baseInfo(): ParsedWeatherWarning {
  const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA));
  expect(info).not.toBeNull();
  return info!;
}

function id(reportDateTime: string, serial: string | null = null): WeatherReportIdentity {
  return { reportDateTime, serial };
}

function issue(holder: Vpww56StateHolder, reportDateTime: string, serial: string | null) {
  return holder.update({ ...baseInfo(), reportDateTime }, id(reportDateTime, serial));
}

function cancel(holder: Vpww56StateHolder, reportDateTime: string, serial: string | null) {
  return holder.update(
    { ...baseInfo(), infoType: "取消", reportDateTime },
    id(reportDateTime, serial),
  );
}

const T1 = "2026-07-19T09:00:00+09:00";
const T2 = "2026-07-19T10:00:00+09:00";
const T3 = "2026-07-19T11:00:00+09:00";

describe("Vpww56StateHolder 敵対シーケンス", () => {
  it("取消→新報で再発表→原取消の遅着 が現況 view を巻き戻さない", () => {
    const holder = new Vpww56StateHolder();
    expect(issue(holder, T1, "1")).toEqual({ kind: "updated" });
    expect(cancel(holder, T1, "1")).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();

    // 取消の後、より新しい identity で再発表 → view 復活
    expect(issue(holder, T2, "2")).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);

    // 原取消 (古い identity) が遅れて再到着しても現況は消えない
    expect(cancel(holder, T1, "1")).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("current より新しくても identity 不一致の取消は棄却し view を維持する", () => {
    const holder = new Vpww56StateHolder();
    expect(issue(holder, T1, "1")).toEqual({ kind: "updated" });

    // 一度も受信していない (より新しい) 報に対する取消は current と一致しないため無視
    expect(cancel(holder, T2, "2")).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("同一 identity の発表を重複受信しても view を作り直さず据え置く", () => {
    const holder = new Vpww56StateHolder();
    expect(issue(holder, T2, "5")).toEqual({ kind: "updated" });
    // 完全に同じ reportDateTime + serial の再送は watermark を進められず suppressed
    expect(issue(holder, T2, "5")).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("いかなる発表より先に取消が来ても view を生成しない", () => {
    const holder = new Vpww56StateHolder();
    expect(cancel(holder, T1, "1")).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();

    // 先行取消が watermark を汚染していないので、後続の正常発表は通る
    expect(issue(holder, T2, "2")).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });

  it("壊れた reportDateTime の初回発表を棄却し、watermark を汚染しない", () => {
    const holder = new Vpww56StateHolder();
    const broken = holder.update(
      { ...baseInfo(), reportDateTime: "not-a-date" },
      id("not-a-date", "1"),
    );
    expect(broken).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();

    // 壊れた報の後でも正常な報は受理される (watermark は null のまま)
    expect(issue(holder, T3, "1")).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });
});
