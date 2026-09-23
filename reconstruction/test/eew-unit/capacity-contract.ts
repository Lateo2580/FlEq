import type { EewUnitStep } from "../../contracts/p2-eew-unit.types";

// T06-R14 public boundary: capacity refusal is not validation or a semantic change.
type CapacityDecision = Extract<EewUnitStep["decisions"][number], { decision: "capacityExceeded" }>;
const capacity: CapacityDecision = { decision: "capacityExceeded", subject: "normal/VXSE43/20240417231454",
  operation: "normal", rejection: { family: "VXSE43", reportDateTimeMs: 1, affectedScope: "subject" } };
const decision: EewUnitStep["decisions"][number] = capacity;
// @ts-expect-error Capacity refusal must preserve the candidate's operation.
const missingOperation: CapacityDecision = { decision: "capacityExceeded", subject: "normal/VXSE43/20240417231454" };
// @ts-expect-error Capacity refusal has no validation reason.
const withReason: CapacityDecision = { ...capacity, reason: "requiredStructureInvalid" };
// @ts-expect-error Capacity refusal has no change category.
const withChange: CapacityDecision = { ...capacity, change: "semantic" };
void [decision, missingOperation, withReason, withChange];
