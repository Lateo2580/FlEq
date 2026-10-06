import type { VerificationStatus } from "../../contracts/p2-eew-e01.types";
import type { DisplayVersion } from "../../contracts/p2-snapshot-sse.types";

// 窓 1 回分の記録（evidence/windows/<manifestId>/<id>[-attempt<k>].json）。Blocked のときだけ reason 以下の 4 つを持つ。
export type WindowRecord = {
  id: string;
  attempt: number;
  manifestId: string;
  manifestSha256: string;
  status: VerificationStatus;
  reason?: string;
  error?: string;
  childExit?: { code: number | null; signal: string | null } | null;
  lastProgress?: Record<string, unknown>;
  rawDir: string;
  command: string;
  // runner・caffeinate・host（nodeArgs・env を含む）の起動 command
  commands: string[];
  startedAt: string;
  finishedAt?: string;
  preflight: Record<string, unknown> | null;
  resultFiles?: { path: string; sha256: string }[];
  raw?: { file: string; bytes: number; sha256: string }[];
  orphans?: { name: string; pid: number | undefined }[];
};

export function buildA10Result(input: { manifest: { manifestId: string; manifestSha256: string }; windows: readonly WindowRecord[]; e01: unknown; e02Verdict?: { path: string; sha256: string } | null;
  schemaVersion?: string }): string;

// P3-C4-RUNNER-LIVENESS: 投入側の frame 間隔の最大と ping の件数。
export type FrameGapMeter = { pings: number; frames: number; maxFrameGapMs: number; sent(kind: "data" | "ping" | "start"): void; close(): void };
export function frameGapMeter(now?: () => number): FrameGapMeter;
export function livenessBlocked(meters: readonly { maxFrameGapMs: number }[] | undefined, maxFrameGapMs: number): string | null;
export function startInjector(scope: { add(fn: () => unknown): void }, options?: { pingEveryMs?: number; now?: () => number }): Promise<{
  url: string; meter: FrameGapMeter; broken: string | null; placeOf(inputId: string): string | null;
  pingKinds: string[]; ping(kind: "periodic" | "boundary" | "drain"): boolean; stopPings(): void;
  connected(): Promise<void>; sendStart(): void; send(frame: string, headType?: string | null): { seq: number | null; injectedHrMs: number | null };
  close(): Promise<void>;
}>;
// P3-C4-T3-BINDING: 投入前の行数 from 以後の観測行から、inputId の版の窓（同じ実行場所の次の T2 の行まで）の T3 の版。
export function publishedBy(lines: readonly unknown[], from: number, inputId: string, placeOf?: (inputId: string) => string | null): DisplayVersion[];

// 引数の Map と、そこから決まる値。--manifest と予備専用オプションの併用などの誤りは throw する。
export function parseArgs(argv: readonly string[]): { args: Map<string, string | true>; preliminary: boolean; selected: string[] | null; notification: string };

// 窓 dir の下の全ファイル（下位 dir を含む、state/ を除く）の相対 path・大きさ・sha256（窓記録の raw）。
export function hashRaw(dir: string): { file: string; bytes: number; sha256: string }[];

// P3-C4-AC13(7): 直近 count 試行の「parse 開始 − 引き金の実送信（host の時計）」の中央値。足りなければ null。
export function predictParseDelay(trials: readonly { trigger?: { inputId: string | null; injectedHrMs: number | null } | null }[],
  parseStarts: ReadonlyMap<string, number>, ohLo: number | null, count?: number): number | null;

// P3-C4-AC13(1): 窓 1 本の条件（lead と span は manifest から）。
export function populationSpec(manifest: { populations: Record<string, unknown> }, population: string, run: number, warmup: number, count: number,
  stop: { maxAttempts: number; maxDurationMs: number }): { population: string; leadMs: number | null; span: "population" | "encodeThroughWrite"; targetOffsetMs: number;
  periodMs: number; stateKey: string };
// 試行の対象の区間（host の時計）。span "encodeThroughWrite" は保存の試行全体（encode 開始〜write 完了）。
export function trialTarget(population: string, trial: { trigger?: { inputId: string | null; injectedHrMs: number | null; predictedTickHostMs?: number } | null },
  host: { decode: Map<string, unknown>; t1: Map<string, number>; checkpoints: readonly { unit: string; stage: string; attemptId: string; startedMonotonicMs: number; endedMonotonicMs: number }[] },
  ohLo: number | null, span?: "population" | "encodeThroughWrite"): { startMs: number; endMs: number } | null;
