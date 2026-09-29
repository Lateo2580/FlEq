import type {
  CheckpointMeasurement,
  ClockCorrespondence,
  EewInjectionRecord,
  EewPopulation,
  EewTraceSample,
  P2HostObservation,
  ProcessingMeasurement,
} from "../../contracts/p2-eew-e01.types";
import type { DisplayVersion } from "../../contracts/p2-snapshot-sse.types";

export type HostLine =
  | { t: "meta"; runId: string; nodeVersion: string; startedWallMs: number }
  | { t: "obs"; o: P2HostObservation }
  | { t: "clock"; hrtimeNs: string; perfNowMs: number }
  | { t: "mem"; perfNowMs: number; rss: number; heapUsed: number; external: number };

export type ChromeVersionEntry = {
  t5Ms: number | null;
  candidate: { operation: "normal" | "training" | "test"; subject: string; cardMarkerId: string; mapMarkerId: string; mapAreaCodes: readonly string[] } | null;
  paint: { chromeMs: number; paintEvidenceId: string; hasScreenshot: boolean } | null;
};

export type HostIndex = {
  meta: { runId: string; nodeVersion: string; startedWallMs: number } | null;
  t0: Map<string, number>;
  t1: Map<string, number>;
  t2: Map<string, number>;
  decode: Map<string, { startMs: number; endMs: number }>;
  processing: ProcessingMeasurement[];
  checkpoints: CheckpointMeasurement[];
  t3: { ms: number; version: DisplayVersion; key: string }[];
  t4: { ms: number; version: DisplayVersion; key: string }[];
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
export function analyzeTrace(events: readonly unknown[]): { byVersion: Map<string, ChromeVersionEntry>; rejectedMarks: number; markCount: number };
export function buildHostIndex(lines: readonly HostLine[]): HostIndex;
export function correspondences(probes: readonly Probe[], host: HostIndex): (ClockCorrespondence & { attemptCount: number })[];
export function assembleTrials(input: {
  population: EewPopulation;
  run: 1 | 2 | 3;
  trials: readonly Trial[];
  host: HostIndex;
  chromeByVersion: Map<string, ChromeVersionEntry>;
  probes: readonly Probe[];
  blocks: readonly { dataLoss: boolean }[];
  callbackDeadlineMs: number;
  missingAfterMs: number;
}): { samples: EewTraceSample[]; injections: EewInjectionRecord[]; details: Record<string, unknown>[]; correspondences: ClockCorrespondence[] };
export function referenceRecord(input: {
  trial: Trial;
  target: { startMs: number; endMs: number; stages?: readonly { stage: string; startMs: number; endMs: number }[] } | null;
  host: HostIndex;
  injection: EewInjectionRecord;
}): Record<string, unknown>;
