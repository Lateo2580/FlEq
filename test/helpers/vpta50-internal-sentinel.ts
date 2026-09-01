import type { FinalizedTyphoonProbabilityClassification } from "../../src/engine/display/project-typhoon-probability";
import type { VptaDisplayIngestCommand } from "../../src/engine/display/types";
import type { StandbyRevision } from "../../src/engine/display/standby-registry";
import type { VptaAcceptedCommit } from "../../src/engine/messages/telegram-revision-gate";

/**
 * Shared main/overlay fixture for proving that router-private VPTA values never
 * reach a public payload. Every entry names the actual internal field it marks.
 */
export const VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS = Object.freeze({
  "internal.vptaDisplayCommand": "__vpta50_private_01_display_command__",
  "internal.vptaDisplayCommand.finalized.canonicalInfoType":
    "__vpta50_private_02_finalized_canonical_info_type__",
  "internal.vptaDisplayCommand.finalized.acceptedRevision":
    "__vpta50_private_03_finalized_accepted_revision__",
  "internal.vptaDisplayCommand.finalized.appliedSemanticKey":
    "__vpta50_private_04_finalized_applied_semantic_key__",
  "internal.vptaDisplayCommand.commit.stateSubjectKey":
    "__vpta50_private_05_commit_state_subject_key__",
  "internal.vptaDisplayCommand.commit.comparison":
    "__vpta50_private_06_commit_comparison__",
  "internal.vptaDisplayCommand.commit.semanticKeys":
    "__vpta50_private_07_commit_semantic_keys__",
  "internal.vptaDisplayCommand.commit.binding":
    "__vpta50_private_08_commit_binding__",
} as const);

export type VptaInternalActualField = keyof typeof VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS;

export interface VptaInternalSentinelLeak {
  field: VptaInternalActualField;
  sentinel: string;
  source: "recursiveValue" | "jsonText";
}

const SENTINEL_ENTRIES = Object.entries(VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS) as ReadonlyArray<
  readonly [VptaInternalActualField, string]
>;

function markObjectValue<T extends object>(value: T, sentinel: string): T {
  Object.defineProperty(value, "toJSON", {
    configurable: true,
    value: () => sentinel,
  });
  Object.defineProperty(value, Symbol.toPrimitive, {
    configurable: true,
    value: () => sentinel,
  });
  return value;
}

function sentinelRevision(sentinel: string): StandbyRevision {
  return markObjectValue({
    reportTimeMs: sentinel as unknown as number,
    serial: sentinel,
  }, sentinel);
}

/** Replace the commit fields named by the fixture before the private sidecar is built. */
export function createVptaSentinelCommit(base: VptaAcceptedCommit): VptaAcceptedCommit {
  const comparisonSentinel = VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
    "internal.vptaDisplayCommand.commit.comparison"
  ];
  const bindingSentinel = VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
    "internal.vptaDisplayCommand.commit.binding"
  ];
  const comparison = markObjectValue({
    ...base.comparison,
    stateSubjectKey: comparisonSentinel,
  }, comparisonSentinel);
  const binding = markObjectValue({
    revision: sentinelRevision(bindingSentinel),
    appliedSemanticKey: bindingSentinel,
  }, bindingSentinel);
  return {
    ...base,
    stateSubjectKey: VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
      "internal.vptaDisplayCommand.commit.stateSubjectKey"
    ],
    comparison,
    semanticKeys: Object.freeze([
      VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
        "internal.vptaDisplayCommand.commit.semanticKeys"
      ],
    ]),
    binding,
  };
}

/** Inject finalized-field sentinels at the notification-holder seam. */
export function injectVptaFinalizedSentinels(
  finalized: FinalizedTyphoonProbabilityClassification,
): void {
  Object.assign(finalized as unknown as Record<string, unknown>, {
    canonicalInfoType: VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
      "internal.vptaDisplayCommand.finalized.canonicalInfoType"
    ],
    acceptedRevision: sentinelRevision(VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
      "internal.vptaDisplayCommand.finalized.acceptedRevision"
    ]),
    appliedSemanticKey: VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS[
      "internal.vptaDisplayCommand.finalized.appliedSemanticKey"
    ],
  });
}

/** Mark the command object itself without adding an enumerable, production-like field. */
export function markVptaDisplayCommandSentinel(command: VptaDisplayIngestCommand): void {
  // The field value itself is an object. Mark both object coercion and an
  // enumerable command member so whole-object references and object spreads
  // are independently observable from a public payload.
  (command as unknown as Record<string, unknown>).domain =
    VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS["internal.vptaDisplayCommand"];
  markObjectValue(
    command,
    VPTA_INTERNAL_ACTUAL_FIELD_SENTINELS["internal.vptaDisplayCommand"],
  );
}

function containsSentinelValue(
  value: unknown,
  sentinel: string,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return value.includes(sentinel);
  if (typeof value !== "object" || value == null || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((child) => containsSentinelValue(child, sentinel, seen));
}

/**
 * Search values recursively and the complete JSON text. Property names are never
 * treated as evidence, so an accidental copy into an existing public field is caught.
 */
export function findVptaInternalSentinelLeaks(value: unknown): VptaInternalSentinelLeak[] {
  const serialized = JSON.stringify(value) ?? "";
  const leaks: VptaInternalSentinelLeak[] = [];
  for (const [field, sentinel] of SENTINEL_ENTRIES) {
    if (containsSentinelValue(value, sentinel)) {
      leaks.push({ field, sentinel, source: "recursiveValue" });
    }
    if (serialized.includes(sentinel)) {
      leaks.push({ field, sentinel, source: "jsonText" });
    }
  }
  return leaks;
}
