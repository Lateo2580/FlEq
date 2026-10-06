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
export function startInjector(scope: { add(fn: () => unknown): void }, options?: { pingEveryMs?: number }): Promise<{
  url: string; meter: FrameGapMeter; broken: string | null; placeOf(inputId: string): string | null;
  pingKinds: string[]; ping(kind: "periodic" | "boundary" | "drain"): boolean;
  connected(): Promise<void>; sendStart(): void; send(frame: string, headType?: string | null): { seq: number | null; injectedHrMs: number | null };
  close(): Promise<void>;
}>;
// P3-C4-T3-BINDING: 投入前の行数 from 以後の観測行から、inputId の版の窓（同じ実行場所の次の T2 の行まで）の T3 の版。
export function publishedBy(lines: readonly unknown[], from: number, inputId: string, placeOf?: (inputId: string) => string | null): DisplayVersion[];

// 引数の Map と、そこから決まる値。--manifest と予備専用オプションの併用などの誤りは throw する。
export function parseArgs(argv: readonly string[]): { args: Map<string, string | true>; preliminary: boolean; selected: string[] | null; notification: string };

// 窓 dir の下の全ファイル（下位 dir を含む、state/ を除く）の相対 path・大きさ・sha256（窓記録の raw）。
export function hashRaw(dir: string): { file: string; bytes: number; sha256: string }[];
