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
export function summarizeE05(records: readonly HostRecord[], load: string, window?: Window):
  { status: Status; load: string; samples: number; maxRssBytes: number | null; limitBytes: number | null };
export function summarizeE06(records: readonly HostRecord[], fdSeries: readonly { hrtimeNs: string; count: number | null }[], options: { steadyStartMs: number; windowMs?: number; windows?: number }): {
  status: Status | null; complete: boolean;
  windows: { window: number; memSamples: number; fdSamples: number; rssMedian: number | null; heapUsedMedian: number | null; fdMedian: number | null }[];
  rssSlopeBytesPerMin: number | null; heapUsedSlopeBytesPerMin: number | null; fdSlopePerMin: number | null;
  finalWindow: { window: number; rssMedian: number | null; fdMedian: number | null };
};
export function startFdSampler(pid: number, everyMs?: number): { samples: { hrtimeNs: string; count: number | null }[]; stop(): void };
export const E15_BLOCKED: readonly string[];
export function summarizeE15(records: readonly HostRecord[]): {
  status: Status | null; blocked: string[]; attempts?: number;
  units?: Record<string, { encodeCount: number; encodeBytes: number; writeBytes: number; occupiedMsLower: number; measuredStagesMs: number; failedAttempts: number }>;
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
