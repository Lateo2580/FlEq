import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import { linkedUnitTable } from "../../src/runtime/composition-root";
import type { NotificationCalls } from "../../src/runtime/composition-root";

// Test-only stubs (P3-UNIT-TABLE-001 AC09): each stub replaces one field of the linkedUnitTable row, every other
// field stays the real one. The unit rows go to the owners; the notification calls stay with the publisher.
export type StubCalls = Readonly<{
  reduceEewUnit?: UnitModule<"U-E">["reduce"];
  reduceWeatherCurrentUnit?: UnitModule<"U-W">["reduce"];
  reduceWeatherTimeseriesUnit?: UnitModule<"U-F">["reduce"];
  reduceTsunamiUnit?: UnitModule<"U-T">["reduce"];
  reduceSeismicUnit?: UnitModule<"U-Q">["reduce"];
  reduceNankaiUnit?: UnitModule<"U-N">["reduce"];
  reduceVolcanoUnit?: UnitModule<"U-V">["reduce"];
  toEewView?: UnitModule<"U-E">["toView"];
  toWeatherCurrentView?: UnitModule<"U-W">["toView"];
  toWeatherTimeseriesView?: UnitModule<"U-F">["toView"];
  toTsunamiView?: UnitModule<"U-T">["toView"];
  selectNotificationAttempt?: NotificationCalls["selectNotificationAttempt"];
  applyNotificationResult?: NotificationCalls["applyNotificationResult"];
}>;

function callsWith(stubs: StubCalls = {}): Readonly<{ units: UnitTable } & NotificationCalls> {
  const { reduceEewUnit, reduceWeatherCurrentUnit, reduceWeatherTimeseriesUnit, reduceTsunamiUnit, reduceSeismicUnit, reduceNankaiUnit, reduceVolcanoUnit,
    toEewView, toWeatherCurrentView, toWeatherTimeseriesView, toTsunamiView, ...notification } = stubs;
  const { "U-E": eew, "U-W": weather, "U-F": series, "U-T": tsunami, "U-Q": seismic, "U-N": nankai, "U-V": volcano } = linkedUnitTable;
  return {
    units: {
      "U-E": { ...eew, reduce: reduceEewUnit ?? eew.reduce, toView: toEewView ?? eew.toView },
      "U-W": { ...weather, reduce: reduceWeatherCurrentUnit ?? weather.reduce, toView: toWeatherCurrentView ?? weather.toView },
      "U-F": { ...series, reduce: reduceWeatherTimeseriesUnit ?? series.reduce, toView: toWeatherTimeseriesView ?? series.toView },
      "U-T": { ...tsunami, reduce: reduceTsunamiUnit ?? tsunami.reduce, toView: toTsunamiView ?? tsunami.toView },
      "U-Q": { ...seismic, reduce: reduceSeismicUnit ?? seismic.reduce },
      "U-N": { ...nankai, reduce: reduceNankaiUnit ?? nankai.reduce },
      "U-V": { ...volcano, reduce: reduceVolcanoUnit ?? volcano.reduce },
    },
    ...notification,
  };
}

export { callsWith };
