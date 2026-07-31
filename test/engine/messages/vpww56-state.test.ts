import { describe, it, expect } from "vitest";
import { createMockWsDataMessage, FIXTURE_VPWW56_DOSHA } from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning } from "../../../src/types";

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

  it("export→restore で active view を保つ", () => {
    const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA))!;
    const holder = new Vpww56StateHolder();
    holder.update(info);
    const restored = new Vpww56StateHolder();
    restored.restorePersistedState(holder.exportPersistedState());
    expect(restored.getCurrentAreasForDisplay()).toEqual(holder.getCurrentAreasForDisplay());
  });
});
