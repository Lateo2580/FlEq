// P3-C0-T04: type-level contract of the unit table. Checked by `tsc --project reconstruction/tsconfig.test.json`,
// not by vitest. Each @ts-expect-error line must fail to compile; an unused one is itself a compile error.
import type { RuntimeUnitId, RuntimeUnitInputs, RuntimeUnitStates } from "../../contracts/p2-shared-runtime.types";
import type { CoverageRow, UnitJob, UnitModule, UnitTable } from "../../contracts/p3-unit-table.types";
import type { CoversAllUnits } from "../../src/runtime/unit-coverage";
import { eewUnit } from "../../src/units/eew/eew-unit";
import { weatherCurrentUnit } from "../../src/units/weather-current/weather-current-unit";
import { weatherTimeseriesUnit } from "../../src/units/weather-timeseries/weather-timeseries-unit";

declare const eewInput: RuntimeUnitInputs["U-E"];
declare const weatherState: RuntimeUnitStates["U-W"];

// Positive: the three linked modules satisfy their row type and make a complete table.
export const positiveTable = { "U-E": eewUnit, "U-W": weatherCurrentUnit, "U-F": weatherTimeseriesUnit } satisfies UnitTable;
export const positiveRows = [eewUnit satisfies UnitModule<"U-E">, weatherCurrentUnit satisfies UnitModule<"U-W">,
  weatherTimeseriesUnit satisfies UnitModule<"U-F">];

// Positive: one switch on job.unit narrows state and input together; a missing case fails at `never`.
export function describeJob(job: UnitJob): RuntimeUnitId {
  switch (job.unit) {
    case "U-E": { const state: RuntimeUnitStates["U-E"] = job.state; const input: RuntimeUnitInputs["U-E"] = job.input; void state; void input; return job.unit; }
    case "U-W": { const state: RuntimeUnitStates["U-W"] = job.state; const input: RuntimeUnitInputs["U-W"] = job.input; void state; void input; return job.unit; }
    case "U-F": { const state: RuntimeUnitStates["U-F"] = job.state; const input: RuntimeUnitInputs["U-F"] = job.input; void state; void input; return job.unit; }
    default: { const missing: never = job; return missing; }
  }
}

// N1: a RuntimeUnitId row is missing.
// @ts-expect-error N1
export const n1: UnitTable = { "U-E": eewUnit, "U-W": weatherCurrentUnit };

// N2: a module under another unit's key.
// @ts-expect-error N2
export const n2: UnitTable = { "U-E": weatherCurrentUnit, "U-W": eewUnit, "U-F": weatherTimeseriesUnit };

// N3: persistence omitted, or durable without a codec.
const { persistence: omitted, ...withoutPersistence } = eewUnit;
void omitted;
// @ts-expect-error N3a
export const n3a: UnitModule<"U-E"> = withoutPersistence;
// @ts-expect-error N3b
export const n3b: UnitModule<"U-E"> = { ...eewUnit, persistence: { kind: "durable" } };

// N4: a job whose state belongs to another unit.
// @ts-expect-error N4
export const n4: UnitJob = { unit: "U-E", state: weatherState, input: eewInput };

// N5: the unit list lacks a RuntimeUnitId, or names one that does not exist.
// @ts-expect-error N5a
export const n5a: CoversAllUnits<readonly ["U-E", "U-W"]> = ["U-E", "U-W"] as const;
// @ts-expect-error N5b
export const n5b = ["U-E", "U-W", "U-F", "U-T"] as const satisfies readonly RuntimeUnitId[];

// N6: ready names a unit outside RuntimeUnitId; notPorted and ignored need a reason.
// @ts-expect-error N6a
export const n6a = { status: "ready", unit: "U-T" } satisfies CoverageRow;
// @ts-expect-error N6b
export const n6b = { status: "notPorted", candidate: "U-T" } satisfies CoverageRow;
// @ts-expect-error N6c
export const n6c = { status: "ignored" } satisfies CoverageRow;
