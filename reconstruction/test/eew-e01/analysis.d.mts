import type {
  CheckpointMeasurement,
  ClockCorrespondence,
  EewInjectionRecord,
  EewTraceSample,
  P2HostObservation,
  ProcessingMeasurement,
} from "../../contracts/p2-eew-e01.types";
import type { DisplayVersion } from "../../contracts/p2-snapshot-sse.types";
import type { P3EewInjectionRecord, P3EewTraceSample } from "../../contracts/p3-e01-reaccept.types";
import type { ChromeTsunamiMarkerDetail, P3TsunamiInjectionRecord, P3TsunamiTraceSample } from "../../contracts/p3-tsunami-e01.types";
import type { TsunamiAreaTransition } from "../../contracts/p3-tsunami-unit.types";

export type HostLine =
  | { t: "meta"; runId: string; nodeVersion: string; startedWallMs: number }
  | { t: "obs"; o: P2HostObservation }
  | { t: "clock"; hrtimeNs: string; perfNowMs: number }
  | { t: "mem"; perfNowMs: number; rss: number; heapUsed: number; external: number };

export type ChromeVersionEntry = {
  t5Ms: number | null;
  candidate: { operation: "normal" | "training" | "test"; subject: string; cardMarkerId: string; mapMarkerId: string; mapAreaCodes: readonly string[] } | null;
  paint: { chromeMs: number; paintEvidenceId: string; hasScreenshot: boolean } | null;
  // 同じ subject の後の候補が同じ Commit の前に出て、この版は提示されなかった（paint は null）。
  replacedBeforePaint: boolean;
};

// P3-C6-AC06(5): (版, subject, mark 名) で引く候補。candidate は EEW か津波の T6 候補の detail。
export type ChromeCandidateEntry = {
  candidate: ({ name: "fleq:p2:eew:T6-candidate"; operation: "normal" | "training" | "test"; subject: string; cardMarkerId: string; mapMarkerId: string;
    mapAreaCodes: readonly string[] } | ChromeTsunamiMarkerDetail);
  paint: { chromeMs: number; paintEvidenceId: string; hasScreenshot: boolean } | null;
  replacedBeforePaint: boolean;
};

export type HostIndex = {
  meta: { runId: string; nodeVersion: string; startedWallMs: number } | null;
  t0: Map<string, number>;
  t1: Map<string, number>;
  t2: Map<string, number>;
  t2Order: { inputId: string; row: number }[];
  decode: Map<string, { startMs: number; endMs: number; parseStartMs: number | null; parseEndMs: number | null }>;
  processing: ProcessingMeasurement[];
  checkpoints: CheckpointMeasurement[];
  // 「入力 ID|unit」→ その入力の採用で上がった世代（generationRaised、工程2c）。
  raised: Map<string, number>;
  // checkpointGrant の行（P3-C6-AC06(3) の U-T の ack）。
  grants: { unit: string; result: { kind: "acknowledged" | "failed" | "uncertain"; generation: number } | null; doneReceivedMonotonicMs: number }[];
  t3: { ms: number; version: DisplayVersion; key: string; row: number }[];
  t4: { ms: number; version: DisplayVersion; key: string; row: number }[];
  publishes: { bytes: number; durationMs: number }[];
  clock: { hrMs: number; perfMs: number }[];
  mem: HostLine[];
  ohLo: number | null;
  ohHi: number | null;
};

export type Probe = {
  probeId: string;
  atHrMs: number;
  chosen: { nodeSentHrMs: number; nodeReceivedHrMs: number; chromeReceivedMonotonicMs: number; chromeSentMonotonicMs: number };
  attempts: readonly unknown[];
};

export type Trial = { index: number; inputId: string; subject: string; scheduledHrMs: number; injectedHrMs: number | null; block: number };

export function versionKey(version: DisplayVersion): string;
export function analyzeTrace(events: readonly unknown[]): { byVersion: Map<string, ChromeVersionEntry>; byCandidate: Map<string, ChromeCandidateEntry>;
  rejectedMarks: number; markCount: number };
export function candidateKey(version: DisplayVersion, subject: string, name: string): string;
export function buildHostIndex(lines: readonly HostLine[]): HostIndex;
export function correspondences(probes: readonly Probe[], host: HostIndex): (ClockCorrespondence & { attemptCount: number })[];
export type P3Trial = Omit<Trial, "index"> & { index: number | null; attemptIndex: number };
type AssembleInput<T> = {
  population: string;
  run: 1 | 2 | 3;
  trials: readonly T[];
  host: HostIndex;
  chromeByVersion: Map<string, ChromeVersionEntry>;
  probes: readonly Probe[];
  blocks: readonly { dataLoss: boolean }[];
  callbackDeadlineMs: number;
  missingAfterMs: number;
  // 版の窓の実行場所（P3-C4-T3-BINDING）。省略時は全入力で同じ場所（A10 の単一スレッドと同じ）。
  placeOf?: (inputId: string) => string | null;
  // T0 の後に拒否された入力の理由（rejectionReasons）。
  rejections?: ReadonlyMap<string, string>;
};
export function windowEnds(host: HostIndex, placeOf?: (inputId: string) => string | null): Map<string, { from: number; to: number }>;
export function rejectionReasons(diagnosticRecords: readonly unknown[]): Map<string, string>;
export function assembleTrials(input: AssembleInput<Trial>): { samples: EewTraceSample[]; injections: EewInjectionRecord[]; details: Record<string, unknown>[]; correspondences: ClockCorrespondence[] };
export function assembleP3Trials(input: AssembleInput<P3Trial>): { samples: P3EewTraceSample[]; injections: P3EewInjectionRecord[]; details: Record<string, unknown>[]; correspondences: ClockCorrespondence[] };

// 津波の試行（run.mjs の tsunamiTrial が作る記録のうち、組み立てが読む項目）。
type Paint = { present: boolean; areas: readonly { code: string; areaClass: string }[] };
export type TsunamiTrial = Omit<P3Trial, "subject"> & {
  phase: "warmup" | "formal"; subject: string; transition: TsunamiAreaTransition; expectedPaint: Paint;
  prime: { inputId: string; paintRequired: boolean; expectedPaint: Paint } | null;
  eew: { inputId: string; subject: string } | null;
  establishment?: { established: boolean; reason?: string } | null;
};
export function assembleTsunamiTrials(input: AssembleInput<TsunamiTrial> & { chromeByCandidate: Map<string, ChromeCandidateEntry> }): {
  samples: P3TsunamiTraceSample[]; injections: P3TsunamiInjectionRecord[]; details: Record<string, unknown>[]; correspondences: ClockCorrespondence[];
  eewReference: { attemptIndex: number; index: number | null; phase: "warmup" | "formal"; established: boolean | null; inputId: string;
    latencyLowerMs: number | null; latencyUpperMs: number | null; missingReason: string | null }[];
};
