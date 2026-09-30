import type { HostRecord } from "./aux-measures.mjs";

type Unit = "U-E" | "U-W" | "U-F";
type Quantiles = { p50: number; p95: number; p99: number; max: number };
type Tally = { count: number; ms: number; chars: number; maxChars: number };
export type ProbeRow = [startedMs: number, durationMs: number, chars: number, fingerprint: string, stack?: string[]];
export type FingerprintTable = {
  unitState: Partial<Record<Unit, string>>; runtimeState: string; unitCollection: string; payload: Partial<Record<Unit, string>>;
  envelope: string | null; snapshot: string; viewUnits: Unit[]; elements: Record<string, Unit>; ambiguous: string[];
  emptyRequiredFields: string[];
};
export type Ac15Interval = { inputId: string; unit: Unit; startMs: number; endMs: number; processingMs: number | null; publishCount: number };
export type CheckpointWindow = {
  kind: "encode" | "verify" | "gap" | "retrySpan"; unit: Unit; attemptId: string; inputIds: readonly string[];
  retryReason: "notRetry" | "saveFailed" | "ackUncertain"; fromMs: number; toMs: number;
};
type Envelope = { unit: Unit; generation: number; payload: Record<string, unknown>; [key: string]: unknown };
type ViolationCategory = "runtimeState" | "unitState" | "unitCollection" | "foreignElement" | "foreignPayload" | "payloadOutsideCheckpoint"
  | "foreignSaveByInput" | "ownElementExcess" | "ownElementCollection";
type Excess = { limit: number; excess: number; byFingerprint: Record<string, number> };

export function readLatestEnvelopes(stateDirectory: string): Envelope[];
export function fingerprintTable(envelopes: readonly Envelope[], snapshots: Record<string, unknown> | readonly Record<string, unknown>[]): FingerprintTable;
export function ac15Intervals(hostRecords: readonly HostRecord[], unitOf: ReadonlyMap<string, Unit>, options?: { endMs?: number }): Ac15Interval[];
export function checkpointWindows(hostRecords: readonly HostRecord[]): CheckpointWindow[];
export function judgeAc15(probeRecords: readonly ProbeRow[], intervals: readonly Ac15Interval[], table: FingerprintTable,
  options?: { checkpointWindows?: readonly CheckpointWindow[]; unitOfInput?: ReadonlyMap<string, Unit>; ownElementLimit?: number; minInputsPerUnit?: number }): {
  status: "Pass" | "Fail" | "未確認";
  violations: ({ inputId: string; inputUnit: Unit; category: ViolationCategory; fingerprintUnit: Unit | null; fingerprint: string | null; count: number;
    retryAttemptsNearby: string[]; attemptId?: string; maxLength?: number } & Partial<Excess>)[];
  unconfirmed: (({ inputId: string; inputUnit: Unit; category: "ownElementExcess"; fingerprintUnit: Unit; fingerprint: null; count: number;
    retryAttemptsNearby: string[] } & Excess)
    | { inputId: string; inputUnit: Unit; category: "ownElementLengthUnknown" | "ambiguousCollection"; fingerprintUnit: Unit | null; fingerprint: string; count: number;
      retryAttemptsNearby: string[] })[];
  missing: string[];
  scenarios: Partial<Record<Unit, {
    inputs: number; runtimeState: Tally; unitState: Tally; unitCollection: Tally; foreignElement: Tally; ownElement: Tally; ownElementCollection: Tally; ownElementLengthUnknown: Tally;
    ownElementMaxPerInput: number;
    checkpointElement: Partial<Record<Unit, Tally>>; ambiguous: Tally; ambiguousCollection: Tally; envelope: Tally; checkpointPayload: Partial<Record<Unit, Tally>>;
    foreignPayload: Tally; payloadOutsideCheckpoint: Tally; snapshot: Tally; publishCount: number; snapshotCallsMinusPublish: number;
    other: ({ fingerprint: string } & Tally)[]; outsideOtherPerInput: Quantiles | null; outsidePrimitivePerInput: Quantiles | null;
    outsideOwnElementPerInput: Quantiles | null; outsideAmbiguousPerInput: Quantiles | null;
    processingMs: Quantiles | null; stringifyMs: Quantiles | null;
  }>>;
  checkpointGapMaxMs: number | null;
  largeCallStacks: { category: string; unit: Unit | null; stack: string[]; count: number }[];
  notes: string[];
};
type Judged = ReturnType<typeof judgeAc15>;
type Retained = Partial<Record<Unit, number>>;
export function compareRetention(full: Judged, half: Judged, options: { maxSlope: number; retained: { full: Retained; half: Retained } }): {
  status: "Pass" | "Fail" | "未確認"; maxSlope: number; retained: { full: Retained; half: Retained };
  rows: { scenario: string; measure: "outsideOtherPerInput" | "outsidePrimitivePerInput" | "outsideOwnElementPerInput" | "outsideAmbiguousPerInput";
    fullMedian: number | null; halfMedian: number | null; deltaRetained: number | null; noiseFloor: number | null; slope: number | null; exceeded: boolean }[];
};
