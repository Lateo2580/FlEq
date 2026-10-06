export type HostRecord = { t: string; [key: string]: unknown };
type Quantiles = { p50: number; p95: number; p99: number; max: number };
type Status = "Pass" | "Fail" | "Blocked" | "N/A" | "未確認";
type Window = { fromMs: number; toMs: number } | { fromHrtimeNs: string; toHrtimeNs: string };
type MemEdge = { heapUsed: number; signedDistanceMs?: number } | null;

export function parseFlags(argv: readonly string[]): Record<string, string>;
export function parseJsonl(text: string): HostRecord[];
export function hostMsOf(records: readonly HostRecord[], hrtimeNs: string): number | null;
export function summarizeE03(records: readonly HostRecord[], targetInputIds: readonly string[], options?: { minSamples?: number; limitMs?: number }):
  { status: Status; samples: number; unprocessed: number; processingMs: Quantiles | null; queueWaitMs: Quantiles | null; limitMs: number; notes: string[] };
export function summarizeE05(records: readonly HostRecord[], load: string, window?: Window, options?: { memEveryMs?: number; maxMissingRatio?: number }):
  { status: Status; load: string; samples: number; maxRssBytes: number | null; limitBytes: number | null;
    coverage?: { memEveryMs: number; expectedSamples: number; missingSamples: number; maxGapMs: number; edgesCovered: boolean; maxMissingRatio: number } };
export function summarizeE06(records: readonly HostRecord[], fdSeries: readonly { hrtimeNs: string; count: number | null }[], options: { steadyStartMs: number; windowMs?: number; windows?: number }): {
  status: Status | null; complete: boolean;
  windows: { window: number; memSamples: number; fdSamples: number; rssMedian: number | null; heapUsedMedian: number | null; fdMedian: number | null; fdMax: number | null }[];
  rssSlopeBytesPerMin: number | null; heapUsedSlopeBytesPerMin: number | null; fdSlopePerMin: number | null;
  spec: { checks: { name: string; value: number | null; limit: number; exceeded: boolean | null }[]; report: string; note: string };
  finalWindow: { window: number; rssMedian: number | null; fdMedian: number | null; fdMax: number | null };
};
export function drainBounds(records: readonly HostRecord[], lastT0Ms: number): { lowerMs: number; upperMs: number | null };
type Part = { status: Status; reason?: string };
export function summarizeE07(records: readonly HostRecord[], options: { pingKinds?: readonly string[]; warmupCycles?: number; lastInputId: string;
  diagnostics?: readonly Record<string, unknown>[]; fromMs?: number; fromWallMs?: number; waitLimitMs?: number; drainLimitMs?: number }): {
  status: Status; rows: number; pingRows: number;
  cycleEnd: Part & { ends: { items: number; bytes: number }[]; grewAtCycles?: number[] };
  drain: Part & { lastT0Ms?: number; lowerMs?: number; upperMs?: number | null };
  wait: Part & { upperMs: number; lowerMs: number; unprocessed: number; accepted: number; observedT1: number };
  limitViolations: number; ownerTrouble: { reason: unknown; component: unknown; timestamp: unknown }[]; note: string;
};
export function startFdSampler(pid: number, everyMs?: number): { samples: { hrtimeNs: string; count: number | null }[]; stop(): void };
export const E15_BLOCKED: readonly string[];
type Counts = Record<"checkpoint" | "tmp" | "diagnosticLog" | "other", { count: number; bytes: number }>;
type WriteAttribution = { status: Status | null; complete: boolean; unconfirmed: string[];
  unattributed: { thread: string; category: string; counted: { count: number; bytes: number }; attributed: { count: number; bytes: number } }[];
  unverified: { thread: string; category: string; counted: { count: number; bytes: number }; reason: string }[];
  threads: Record<string, { confirmed: boolean; counts: Counts }> };
type DiagnosticLog = { bytes: number; lines: number };
export function writeAttribution(rows: readonly { thread: string; confirmed: boolean; counts: Counts }[], measurements: readonly { stage: string; unit: string; bytes: number }[],
  diagnosticLog: DiagnosticLog | null, summaryWrites: readonly { bytes: number }[]): WriteAttribution;
export function summarizeE15(records: readonly HostRecord[], options?: { diagnosticLog?: DiagnosticLog | null }): {
  status: Status | null; blocked: string[]; attempts?: number; writes?: WriteAttribution | null;
  preSaveSyncMs?: Record<string, { grants: number; reconcileGrants: number; invalid: number; lowerMs: number; upperMs: number; maxUpperMs: number }> | null;
  units?: Record<string, { encodeCount: number; encodeBytes: number; writeBytes: number; occupiedMsLower: number; measuredStagesMs: number; failedAttempts: number;
    verifyCount: number; verifyBytes: number; verifyMs: number }>;
  retryReasons?: Record<string, number>; byteViolations?: number; unknownInputIds?: number; occupancyNote?: string;
};
export function publishCostReport(records: readonly HostRecord[], window: string):
  { window: string; publishCount: number; totalJsonBytes: number; maxJsonBytes: number; serializeP50Ms: number | null; serializeP99Ms: number | null; serializeMaxMs: number | null };
export const E12_CONFIG_NOTE: string;
export function replayInterval(records: readonly HostRecord[]): { startMs: number; endMs: number } | null;
export function bracketMem(records: readonly HostRecord[], startMs: number, endMs: number): { before: MemEdge; after: MemEdge };
export function summarizeReplayWindow(input: { probe: { gc: readonly { startMs: number; durationMs: number }[] }; startMs: number; endMs: number; before: MemEdge; after: MemEdge }): {
  status: Status | null; reason?: string; replayMs: number; gcCount?: number; gcTotalMs?: number; gcMaxMs?: number;
  heapUsedBefore?: number; heapUsedAfter?: number; heapUsedDelta?: number; heapBoundarySignedDistanceMs?: { before: number; after: number };
};

// P3-C4-AC13(3): E14 の束の集計。
type E14Bundle = { k: number; inputIds: Record<"U-E" | "U-W" | "U-F", string> };
export function summarizeE14(records: readonly HostRecord[], options: { bundles: readonly E14Bundle[]; skipped?: readonly number[]; limitMs?: number }): {
  status: Status | null; bundles: number; linked: number; unconfirmed: Record<string, number>; limitMs: number; note: string;
  units: Record<string, { p50?: number; p95?: number; p99?: number; max?: number; overLimit: number }>;
};
export function ownerHeapReport(rows: readonly { place: string; heapUsedBytes: number; externalBytes: number }[]): Record<string, { rows: number; maxHeapUsedBytes: number; maxExternalBytes: number }>;
