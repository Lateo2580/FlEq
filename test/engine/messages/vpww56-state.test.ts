import { describe, it, expect } from "vitest";
import { createMockWsDataMessage, FIXTURE_VPWW56_DOSHA } from "../../helpers/mock-message";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import {
  VPWW56_SNAPSHOT_GENERATION,
  Vpww56StateHolder,
  type PersistedVpww56StateV2,
} from "../../../src/engine/messages/vpww56-state";
import type { ParsedWeatherWarning } from "../../../src/types";

describe("Vpww56StateHolder", () => {
  it("発表報を update すると市町村等 layer から最細粒度の現況ビューを組む", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWW56_DOSHA);
    const info = parseWeatherWarning(msg);
    expect(info).not.toBeNull();

    const holder = new Vpww56StateHolder();
    expect(holder.update(info!)).toEqual({ kind: "updated" });

    const view = holder.getCurrentAreasForDisplay();
    expect(view).not.toBeUndefined();
    expect(view!.totalAreas).toBe(10);
    expect(view!.kinds.map((kind) => kind.kindCode)).toEqual(["49", "09", "29"]);
    expect(view!.kinds[0]).toEqual({
      kindCode: "49",
      kindShortName: "土砂災害",
      kindName: "レベル４土砂災害危険警報",
      displaySeverity: "officialL4",
      officialAlertLevel: 4,
      areas: [{ areaName: "稚内市", areaCode: "0121400" }],
    });
    expect(view!.kinds[1]!.areas).toEqual([{ areaName: "猿払村", areaCode: "0151100" }]);
    expect(view!.kinds[2]!.areas.map((area) => area.areaName)).toEqual([
      "浜頓別町", "中頓別町", "枝幸町", "豊富町", "礼文町",
      "利尻町", "利尻富士町", "幌延町",
    ]);
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
    expect(holder.exportPersistedState().generation).toBe(VPWW56_SNAPSHOT_GENERATION);
  });

  it("世代 marker のない旧 snapshot は state として復元しない", () => {
    const info = parseWeatherWarning(createMockWsDataMessage(FIXTURE_VPWW56_DOSHA))!;
    const holder = new Vpww56StateHolder();
    holder.update(info);
    const persisted = holder.exportPersistedState();
    const legacy = { streams: persisted.streams } as unknown as PersistedVpww56StateV2;

    const restored = new Vpww56StateHolder();
    restored.restorePersistedState(legacy);
    expect(restored.getCurrentAreasForDisplay()).toBeUndefined();
  });
});
