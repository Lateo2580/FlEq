import { describe, it, expect } from "vitest";
import { createMockWsDataMessage, FIXTURE_VPWW56_DOSHA } from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning } from "../../../src/types";
import type { WeatherReportIdentity } from "../../../src/engine/messages/vpws50-state";

function identity(reportDateTime: string, serial: string | null = null): WeatherReportIdentity {
  return { reportDateTime, serial };
}

describe("Vpww56StateHolder", () => {
  it("発表報を update すると府県予報区等 layer から現況ビューを組む", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const info = parseWeatherWarning(msg);
    expect(info).not.toBeNull();

    const holder = new Vpww56StateHolder();
    expect(holder.update(info!)).toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view).not.toBeUndefined();
    expect(view!.totalAreas).toBe(1);
    expect(view!.kinds).toHaveLength(1);
    expect(view!.kinds[0]).toEqual({
      kindCode: "49",
      kindShortName: "土砂災害",
      kindName: "レベル４土砂災害危険警報",
      displaySeverity: "officialL4",
      officialAlertLevel: 4,
      areas: [{ areaName: "宗谷地方", areaCode: "011000" }],
    });
  });

  it("取消報を update すると getCurrentAreasForDisplay が undefined になる", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const info = parseWeatherWarning(msg)!;

    const holder = new Vpww56StateHolder();
    holder.update(info);
    expect(holder.getCurrentAreasForDisplay()).not.toBeUndefined();

    const cancelInfo: ParsedWeatherWarning = { ...info, infoType: "取消" };
    expect(holder.update(cancelInfo)).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("取消後の古い発表と重複取消を棄却し、view を復活させない", () => {
    const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA))!;
    const holder = new Vpww56StateHolder();
    const currentIdentity = identity("2026-07-19T10:00:00+09:00", "2");
    const oldIdentity = identity("2026-07-19T09:00:00+09:00", "1");

    expect(holder.update({ ...info, reportDateTime: currentIdentity.reportDateTime }, currentIdentity)).toEqual({ kind: "updated" });
    expect(holder.update({ ...info, infoType: "取消", reportDateTime: currentIdentity.reportDateTime }, currentIdentity)).toEqual({ kind: "updated" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();

    expect(holder.update({ ...info, infoType: "取消", reportDateTime: currentIdentity.reportDateTime }, currentIdentity)).toEqual({ kind: "suppressed" });
    expect(holder.update({ ...info, reportDateTime: oldIdentity.reportDateTime }, oldIdentity)).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()).toBeUndefined();
  });

  it("順不同取消と同時刻 Serial 逆転を棄却して現在 view を維持する", () => {
    const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA))!;
    const holder = new Vpww56StateHolder();
    const sameTime = "2026-07-19T10:00:00+09:00";
    const currentIdentity = identity(sameTime, "2");

    expect(holder.update({ ...info, reportDateTime: sameTime }, currentIdentity)).toEqual({ kind: "updated" });
    expect(holder.update(
      { ...info, infoType: "取消", reportDateTime: "2026-07-19T09:00:00+09:00" },
      identity("2026-07-19T09:00:00+09:00", "1"),
    )).toEqual({ kind: "suppressed" });
    expect(holder.update(
      { ...info, reportDateTime: sameTime },
      identity(sameTime, "1"),
    )).toEqual({ kind: "suppressed" });
    expect(holder.getCurrentAreasForDisplay()?.totalAreas).toBe(1);
  });
});
