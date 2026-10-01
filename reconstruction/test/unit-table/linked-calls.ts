import type { RuntimeInput, RuntimeState } from "../../contracts/p2-shared-runtime.types";
import type { UnitModule } from "../../contracts/p3-unit-table.types";
import { linkedUnitTable } from "../../src/runtime/composition-root";
import { reduceRuntime } from "../../src/runtime/shared-runtime";

type Calls = Parameters<typeof reduceRuntime>[2];

// Test-only stubs for reduceRuntime's calls (P3-UNIT-TABLE-001 AC09): each stub replaces one field of the
// linkedUnitTable row, every other field stays the real one. Notification calls are passed through as given.
export type StubCalls = Readonly<{
  reduceEewUnit?: UnitModule<"U-E">["reduce"];
  reduceWeatherCurrentUnit?: UnitModule<"U-W">["reduce"];
  reduceWeatherTimeseriesUnit?: UnitModule<"U-F">["reduce"];
  toEewView?: UnitModule<"U-E">["toView"];
  toWeatherCurrentView?: UnitModule<"U-W">["toView"];
  toWeatherTimeseriesView?: UnitModule<"U-F">["toView"];
  selectNotificationAttempt?: Calls["selectNotificationAttempt"];
  applyNotificationResult?: Calls["applyNotificationResult"];
  codecs?: Calls["codecs"];
}>;

function callsWith(stubs: StubCalls = {}): Calls {
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

function reduceRuntimeWith(state: RuntimeState | null, input: RuntimeInput, stubs: StubCalls = {}) {
  return reduceRuntime(state, input, callsWith(stubs));
}

export { callsWith, reduceRuntimeWith };
