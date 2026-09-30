import type { VerificationStatus } from "../../contracts/p2-eew-e01.types";

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

export function buildA10Result(input: { manifest: { manifestId: string; manifestSha256: string }; windows: readonly WindowRecord[]; e01: unknown; e02Verdict?: { path: string; sha256: string } | null }): string;
