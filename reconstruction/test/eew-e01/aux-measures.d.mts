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
// C6 の --e14-tsunami の束は U-T を足し、重なりを U-E と U-T の組で見る（overlapUnits、Q-C6-IMPL-AMEND (9)）。
type E14Bundle = { k: number; inputIds: Partial<Record<"U-E" | "U-W" | "U-F" | "U-T", string>>; overlapUnits?: readonly string[] };
export function summarizeE14(records: readonly HostRecord[], options: { bundles: readonly E14Bundle[]; limitMs?: number }): {
  status: Status | null; bundles: number; linked: number; unconfirmed: Record<string, number>; limitMs: number; note: string;
  units: Record<string, { p50?: number; p95?: number; p99?: number; max?: number; overLimit: number }>;
  ownerSide: Record<string, { p50?: number; p95?: number; p99?: number; max?: number; rows: number; ownerMonotonicMsMissing: number }>;
  outsideOverlap: Record<string, { p50?: number; p95?: number; p99?: number; max?: number; rows: number; overLimit: number }>;
};
export function ownerHeapReport(rows: readonly { place: string; heapUsedBytes: number; externalBytes: number }[]): Record<string, { rows: number; maxHeapUsedBytes: number; maxExternalBytes: number }>;
export function e14Index(records: readonly HostRecord[], index?: unknown): unknown;
export function e14Acks(index: unknown, bundle: E14Bundle): readonly (object | null)[];
type AdoptionPart = { reservations: number; started: number; notStarted: number; reservationToReplyMs: Quantiles | null; replyToAttemptMs: Quantiles | null;
  createdToReservationWallMs: Quantiles | null };
export function notificationAdoptionReport(records: readonly HostRecord[]): { first: AdoptionPart; retries: AdoptionPart };

// P3-C4 工程2d: E12 の新側を thread ごとに。
export const E12_THREADS: readonly string[];
type GcProbe = { gc: readonly { startMs: number; durationMs: number }[]; writtenAtMs?: number | null };
export function summarizeE12New(records: readonly HostRecord[], probes: Record<string, GcProbe | null>, interval: { startMs: number; endMs: number }): {
  status: Status | null; threads: Record<string, { status: Status | null; reason?: string; heapUsedDelta?: number; gcCount?: number }> };
export function waitInputsDone(read: () => readonly HostRecord[], count: number, options?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>;
export function waitOwnerHeaps(read: () => readonly HostRecord[], options?: { timeoutMs?: number; pollMs?: number }): Promise<boolean>;

// P3-E05C-AC03: 分類の窓の preload の行（probe-preload.mjs の FLEQ_MEM_OUT）を山の行・run の分類・区切りの GC の値へ。
type MemUsage = { rss: number; heapUsed: number; heapTotal: number; external: number; arrayBuffers: number };
export type E05cRow =
  | { k: "start"; place: string; atMs: number; nodeVersion: string; gcAvailable: boolean }
  | ({ k: "mem"; place: string; atMs: number } & MemUsage)
  | { k: "gc"; place: string; atMs: number; kind: number; durationMs: number }
  | { k: "capped"; place: string; atMs: number }
  | { k: "forcedGc"; place: string; id: number; reason: "threshold" | "baseline" | "phase"; requestedAtMs: number; startMs: number; endMs: number; error?: string;
      regularMs?: number; lastResortMs?: number; before?: MemUsage; afterRegular?: MemUsage; afterLastResort?: MemUsage };
type E05cJudgement = "J0" | "J1" | "J1/J4" | "J2" | "J3" | "J4" | "J5";
type PerThread = Record<"publisher" | "urgent" | "weatherCurrent" | "deferred", number>;
export type E05cPeak = { startMs: number; endMs: number | null; peakMs: number; peakRssBytes: number; floorMs: number | null; floorRssBytes: number | null;
  judgement: E05cJudgement; reason?: string; eBytes?: number; deltaBytes?: { U: number; V: number; X: number; O: number; arrayBuffers: number }; oldestRowAgeMs?: number;
  distances?: Record<string, number>;
  gc?: { id: number; g: number; r: number | null; rRegular: number | null; rssMinWithin2sBytes: number | null; rssAt5sBytes: number | null; receiveDelayMs: Record<string, number> } };
export function classifyE05cRun(rowsByThread: Partial<Record<string, readonly E05cRow[]>>, options: { thresholdBytes: number; rearmBelowBytes: number; gcRun: boolean;
  measureFromMs: number; measureToMs: number; c4: { start: PerThread; flat: PerThread }; phaseMissing?: readonly (readonly string[])[] | null }): {
  threads: Record<string, { rows: number; maxGapMs: number | null; lastMs: number | null; gcAvailable: boolean | null; nodeVersion: string | null; gcEntries: number; forcedGcErrors: string[] }>;
  peaks: E05cPeak[];
  run: { status: "未確認" | null; reason?: string; kind?: "single" | "mixed" | "mixedRatios"; primary?: E05cJudgement; secondary?: E05cJudgement; ratios?: Record<string, number>;
    counts: Record<string, number>; over400: Record<string, number>;
    largestPeak: { peakMs: number; peakRssBytes: number; judgement: E05cJudgement; mainComponent: "U" | "V" | "XO" | null } | null };
  forcedGc: { threshold: number; thresholdBeforeMeasure: number; thresholdInMeasure: number; capped: number; baseline: number; phase: number };
  baseline: { threads: Record<string, { lPre: number | null; lPost: number | null; gLate: number | null; baselineGcs: number; S: number | null; dStart: number | null;
    dLate: number | null; grow: number | null; gcs: { id: number; reason: string; requestedAtMs: number; startMs: number; heapUsed: number | null }[];
    judgement: string[] | null }>; sumDStartBytes: number | null; sumDLateBytes: number | null; note: string } | null;
};
