import type { Operation } from "./p1-parser-boundary.types";
import type { DisplayVersion } from "./p2-snapshot-sse.types";
import type { EewMeasurementRunResult, VerificationStatus } from "./p2-eew-e01.types";
import type { P3E01Manifest, P3EewEstablishment, P3EewPopulationCondition } from "./p3-e01-reaccept.types";
import type { TsunamiAreaClass, TsunamiAreaTransition } from "./p3-tsunami-unit.types";

// P3-TSUNAMI-E01-001 (C6, IR05). spec §7.5: the two series never mix (P3-C5-E01-SERIES).
export type P3TsunamiSeries = "escalation" | "deescalation";

// The four conditions measured in P3 (plan:73). Capacity degradation (spec:1137) is expectation-only (D-P3-6, P4).
export type P3TsunamiCondition = "fixedBacklog" | "maxVpws50ParseStarted" | "maxWeatherCheckpointEncodeStarted" | "eewTogether";

// P3-C6-POP-SHAPE=A (author ruling 2026-10-09): one population per series × condition; transitions inside a series run round-robin.
export type P3TsunamiPopulation = `${P3TsunamiSeries}:${P3TsunamiCondition}`;

// One trial = the prime report (resets the subject to the transition's known initial state, never sampled)
// followed by the target report (the sample). Both come from the frozen template; the runner only advances
// ReportDateTime (by 1 s or more per report of the subject; VTSE41 ordering ignores Serial) and never edits areas
// (P3-C6-TRIAL-RESET=A). EventIDs belong to the population × run, not to the template.
export type P3TsunamiTransitionTemplate = Readonly<{
  transition: TsunamiAreaTransition;
  primeAreas: readonly Readonly<{ code: string; kindCode: string }>[];
  targetAreas: readonly Readonly<{ code: string; kindCode: string }>[];
  // Frozen at draft from the C5 reducer in reconstruction/dist (P3-C6-SERIES-SOURCE=A); the runner never infers them.
  expectedSeries: P3TsunamiSeries;
  expectedTransitions: readonly Readonly<{ areaCode: string; from: TsunamiAreaClass; to: TsunamiAreaClass; transition: TsunamiAreaTransition }>[];
  // The painted states that count as the prime's T6 and the target's T6, built by the same paint rule as the page
  // (P3-C6-AC03(2)): only the areas painted on the coast (majorWarning・warning・unknown・advisory, merged per code to the
  // highest class across subjects), so a "none" area such as 312 in a prime is absent. present=false means the subject's
  // card and coast are removed. A prime whose U-T displayChanges are 0 (the subject is out of view before and after,
  // i.e. the first escalation prime of a window) has no prime T6; it settles on its reply row and the U-T ack.
  expectedPrimePaint: Readonly<{ present: boolean; areas: readonly Readonly<{ code: string; areaClass: TsunamiAreaClass }>[] }>;
  expectedPaint: Readonly<{ present: boolean; areas: readonly Readonly<{ code: string; areaClass: TsunamiAreaClass }>[] }>;
  bodySha256: Readonly<{ prime: string; target: string }>;
}>;

// Per condition (P3-C6-AC06(3)). primeSettled is part of every kind; the C4 startOffset (with its span) is reused as is.
export type P3TsunamiEstablishment =
  | Readonly<{ kind: "primeSettled" }>
  | Readonly<{ kind: "primeSettledStartOffset"; startOffset: Extract<P3EewEstablishment, { kind: "startOffset" }> }>
  // eewTogether: the VXSE45 frame is sent first and the VTSE41 T0 is at or before that VXSE45's inputDone (P3-C6-EEW-ORDER=A).
  | Readonly<{ kind: "primeSettledEewOrder" }>;

export type P3TsunamiPopulationCondition = Readonly<
  Omit<P3EewPopulationCondition, "establishment" | "origin" | "forecast"> & {
    series: P3TsunamiSeries;
    condition: P3TsunamiCondition;
    // Inherited unchanged from the frozen C4 manifest's population of the same condition (eewTogether uses fixedBacklog's load).
    inheritsC4Population: "fixedBacklog" | "maxVpws50ParseStarted" | "maxWeatherCheckpointEncodeStarted";
    transitions: readonly TsunamiAreaTransition[];
    // fixedBacklog: primeSettled; maxVpws50ParseStarted・maxWeatherCheckpointEncodeStarted: primeSettledStartOffset
    // (span "population"); eewTogether: primeSettledEewOrder. The freeze check rejects any other pairing.
    establishment: P3TsunamiEstablishment;
    // Prime send → target trigger; fixed from the preliminary run, never tuned after the freeze (spec:1106).
    primeLeadMs: number;
    // One 14-digit EventID per window; warm-up uses its own and is released (present=false observed) before the formal trials.
    tsunamiEventIds: Readonly<{ warmup: string; formalByRun: readonly [string, string, string] }>;
    // eewTogether only (else null): one EventID per window, Serial+1 and prediction A/B alternating as in C4's runner;
    // a new EventID per trial would hit U-E's 512 normal subjects (normal subjects are never evicted).
    eewEventIds: Readonly<{ warmup: string; formalByRun: readonly [string, string, string] }> | null;
  }
>;

export type P3TsunamiE01Manifest = Readonly<
  Omit<P3E01Manifest, "schemaVersion" | "inheritsManifestId" | "populations" | "auxiliary" | "o09Subset" | "judgmentPlaces"> & {
    schemaVersion: "p3-tsunami-e01-manifest-v1";
    inheritsManifestId: "p3-c4-formal-20261007";
    templates: readonly P3TsunamiTransitionTemplate[];
    populations: Readonly<Record<P3TsunamiPopulation, P3TsunamiPopulationCondition>>;
    // The coast asset hash sits beside the inherited EEW geometry hash (spec:1117 地図資材 hash).
    coastSha256: string;
    // C6's own smoke conditions (P3TsunamiSmokeConditions); the inherited smokeConditionsSha256 field holds the hash of
    // this C6 file. The A9 file stays pinned by the A10 and C4 frozen manifests and is not edited.
    smokeConditionsRef: string;
    // Every value that differs from the inherited C4 condition (e.g. fixedBacklog's period 1,370 → 3,000 ms).
    differencesFromC4: readonly Readonly<{ path: string; c4: string; c6: string; reason: string }>[];
    // D-P3-6: frozen expectations only; measured by the P4 capacity contract. Never reported as Pass.
    capacityExpectation: Readonly<{ status: "expectationOnly"; inheritor: "P4 capacity contract"; text: string }>;
    o09Subset: Readonly<{ sequenceId: "O09"; sequencesSha256: string; positions: readonly number[] }>;
    // The product judgment of E01 is Pi backend + real path + the formal Chrome (P5); the C6 Mac result is not it.
    judgmentPlaces: Readonly<Record<"E01", string>>;
  }
>;

// A9's T5 marker is shared (one per snapshot). This is the tsunami candidate; run/input binding stays in the runner.
export type ChromeTsunamiMarkerDetail = Readonly<{
  name: "fleq:p3:tsunami:T6-candidate";
  displayVersion: DisplayVersion;
  operation: Operation;
  subject: string;
  // false: the subject left the full view, and its card and coast segments were removed in this update.
  present: boolean;
  cardMarkerId: string;
  coastMarkerId: string;
  // Painted areas only (the paint rule of P3-C6-AC03(2)); the runner keys candidates by (version, subject, mark name).
  areas: readonly Readonly<{ code: string; areaClass: TsunamiAreaClass }>[];
}>;

// P3-C6-AC05: canonical JSON, key order fixed. Not a P4 GIS asset (D-P3-4). The output hash cannot sit inside the
// hashed bytes, so it is recorded outside (manifest coastSha256 and P3TsunamiSmokeConditions.coastSha256).
export type P3TsunamiCoastAsset = Readonly<{
  schemaVersion: "p3-tsunami-minimal-coast-v1";
  // spec:1727. For the self-made schematic (P3-C6-COAST-ASSET=A) sourceArchiveSha256 and retrievedAt are null.
  provenance: Readonly<{
    source: string;
    version: string;
    retrievedAt: string | null;
    terms: string;
    sourceArchiveSha256: string | null;
    toolVersion: string;
    toolArguments: readonly string[];
    expectedCodeCount: 51;
    knownExclusions: readonly Readonly<{ code: string; reason: string }>[];
  }>;
  segments: readonly Readonly<{ code: string; rect: readonly [number, number, number, number] }>[];
}>;

// C6's own smoke conditions file (P3-C6-AC10). The A9 file (p2-chrome-smoke-conditions-v1) is not reused.
export type P3TsunamiSmokeConditions = Readonly<{
  schemaVersion: "p3-tsunami-chrome-smoke-conditions-v1";
  conditionsSha256: string;
  chrome: Readonly<{ version: string; foregroundTab: true; viewportCssPx: readonly [number, number]; dpr: number; motion: "full" }>;
  geometrySha256: string;
  coastSha256: string;
  fixtureSha256: Readonly<Record<string, string>>;
  templateBodySha256: Readonly<Record<string, string>>;
}>;

export type P3TsunamiRunResult = Readonly<
  Omit<EewMeasurementRunResult, "schemaVersion" | "population"> & {
    schemaVersion: "p3-tsunami-e01-result-v1";
    population: P3TsunamiPopulation;
    attempts: number;
    // C4's meaning: every formal trial that did not establish its condition. Split by reason, never mixed with injectionFailures.
    overlapNotEstablished: number;
    overlapNotEstablishedByReason: Readonly<Record<"primeNotSettled" | "startOffset" | "eewOrder", number>>;
    // Any of these makes the window 未確認 (the known initial state broke): U-T eviction, U-T/U-E capacityExceeded,
    // tsunamiRevisionConflict and stale target reports.
    stateBreaks: Readonly<Record<"tsunamiCapacityEvicted" | "tsunamiCapacityExceeded" | "eewCapacityExceeded" | "tsunamiRevisionConflict" | "staleTarget", number>>;
    // Reported, never judged alone and never used to rescue the series result.
    byTransition: Readonly<Partial<Record<TsunamiAreaTransition, Readonly<{
      samples: number; missing: number; p50UpperMs: number | null; p95UpperMs: number | null; p99UpperMs: number | null; maxUpperMs: number | null;
    }>>>>;
  }
>;

export type P3TsunamiE01Verdict = Readonly<{
  label: "P3 tsunami E01";
  status: VerificationStatus;
  populations: Readonly<Record<P3TsunamiPopulation, VerificationStatus>>;
  evidenceRefs: readonly string[];
}>;
