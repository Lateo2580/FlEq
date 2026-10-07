import type { P3E01Manifest, P3E01Verdict } from "../../contracts/p3-e01-reaccept.types";

export type AdoptionTable = {
  schemaVersion: "p3-c4-adoption-table-v1";
  baseManifestId: string;
  // questionResolution: 新しい manifest の差分を認めた closed の questionResolution の ID（元の manifest には無い）。
  manifests: { manifestId: string; path: string; commit: string; questionResolution?: string }[];
  rows: { window: string; manifestId: string; manifestSha256: string; recordPath: string; recordSha256: string }[];
};
type Diff = { path: string; base: unknown; value: unknown };
export function manifestDiff(base: P3E01Manifest, other: P3E01Manifest): Diff[];
// P3-C4-AC11: 採用表の照合（problems が空のときだけ body を使う）と、採用した窓の記録からの P3E01Verdict。
export function adoptionResult(input: { table: AdoptionTable; manifests: Record<string, P3E01Manifest>; records: Record<string, { path: string; text: string }[]>;
  closedQuestions?: Record<string, string[]>; unusable?: Record<string, string> }): { problems: string[]; body: {
    verdict: P3E01Verdict;
    rows: (AdoptionTable["rows"][number] & { attempts: { attempt: number; status: string; recordPath: string }[] })[];
    superseded: { window: string; manifestId: string; status: string; attempt?: number; recordPath?: string }[];
    manifestDiffs: Record<string, Diff[]> } | null };
// AC01(3)〜(5): 背景の VPWP50 の最初の投入の前後で分けた成立と p99。
export function backgroundSplit(assembled: { spec: { warmup: number }; samples: readonly { sampleIndex: number; missing: boolean; latencyLowerMs: number | null; latencyUpperMs: number | null }[];
  injections: readonly { attemptIndex: number; sampleIndex: number | null; injectedInjectorMonotonicMs: number | null; scheduledInjectorMonotonicMs: number }[] },
  others: readonly { kind: string; headType: string; injectedHrMs: number | null }[]): {
  backgroundVpwp50InjectedHrMs: number | null;
  before: { attempts: number; established: number; missing: number; p99LowerMs: number | null; p99UpperMs: number | null };
  after: { attempts: number; established: number; missing: number; p99LowerMs: number | null; p99UpperMs: number | null } | null;
};
// 窓の生データ 2 つを raw の hash で照らし、窓の母集団・run・試行と一致するときだけ返す（違えば throw）。
export function rawOf(w: { id: string; rawDir: string; raw?: { file: string; sha256: string }[] }): { assembled: unknown; runRecord: unknown };
// 生データの照合と背景の前後の分割。対象は採る窓・同じ manifest の前の attempt・置き換えた旧の記録。
type RecordHead = { id: string; attempt: number; manifestId: string; status: string };
export function rawReport(body: NonNullable<ReturnType<typeof adoptionResult>["body"]>, readRecord: (recordPath: string) => RecordHead,
  read?: (w: RecordHead) => { assembled: Parameters<typeof backgroundSplit>[0]; runRecord: { others: Parameters<typeof backgroundSplit>[1] } }):
  { unusable: Record<string, string>; splits: Record<string, Record<string, unknown>> };
