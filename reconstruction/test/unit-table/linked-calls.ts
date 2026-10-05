import type { UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import { linkedUnitTable } from "../../src/runtime/composition-root";
import type { NotificationCalls } from "../../src/runtime/composition-root";

// Test-only stubs (P3-UNIT-TABLE-001 AC09): each stub replaces one field of the linkedUnitTable row, every other
// field stays the real one. The unit rows go to the owners; the notification calls stay with the publisher.
export type StubCalls = Readonly<{
  reduceEewUnit?: UnitModule<"U-E">["reduce"];
  reduceWeatherCurrentUnit?: UnitModule<"U-W">["reduce"];
  reduceWeatherTimeseriesUnit?: UnitModule<"U-F">["reduce"];
  toEewView?: UnitModule<"U-E">["toView"];
  toWeatherCurrentView?: UnitModule<"U-W">["toView"];
  toWeatherTimeseriesView?: UnitModule<"U-F">["toView"];
  selectNotificationAttempt?: NotificationCalls["selectNotificationAttempt"];
  applyNotificationResult?: NotificationCalls["applyNotificationResult"];
}>;

function callsWith(stubs: StubCalls = {}): Readonly<{ units: UnitTable } & NotificationCalls> {
  const { reduceEewUnit, reduceWeatherCurrentUnit, reduceWeatherTimeseriesUnit,
    toEewView, toWeatherCurrentView, toWeatherTimeseriesView, ...notification } = stubs;
  const { "U-E": eew, "U-W": weather, "U-F": series } = linkedUnitTable;
  return {
    units: {
      "U-E": { ...eew, reduce: reduceEewUnit ?? eew.reduce, toView: toEewView ?? eew.toView },
      "U-W": { ...weather, reduce: reduceWeatherCurrentUnit ?? weather.reduce, toView: toWeatherCurrentView ?? weather.toView },
      "U-F": { ...series, reduce: reduceWeatherTimeseriesUnit ?? series.reduce, toView: toWeatherTimeseriesView ?? series.toView },
    },
    ...notification,
  };
}

export { callsWith };
