// P3-C4-AC13(3)①: E14 の束 k の 3 入力（試験が読む分だけの宣言）。
export function e14BundleFrames(k: number, atWallMs: number): { unit: "U-E" | "U-W" | "U-F"; headType: string; xml: string }[];
// 窓の並び（試験は id だけを読む）。
export function auxWindows(ctx: Record<string, unknown>): { id: string }[];
// P3-MH-FULL-STATE=D: C 窓・E14 の失効の待ちと、P 窓の測定の開始の期限（試験が読む分だけの宣言）。
type Counts = { snapshotActive: Record<string, string>; checkpoint: Record<string, number | null> };
export function waitFillExpiry(host: { check(): void; wallMs(): number }, w: { dir: string; progress: Record<string, unknown> },
  filled: { record: { eewOriginWallMs: number; expiry?: unknown }; expected: Counts },
  io?: { observe?: (expected: Counts) => Promise<Counts>; pause?: (ms: number) => Promise<void> }): Promise<void>;
export type ExpirySplit = { expiryHostMs: number; measureStartHostMs: number | null };
export function expirySplit(records: readonly unknown[], rows: readonly { requestStartMonotonicMs: number; bodyCompleteMonotonicMs: number | null; httpStatus: number | null; failure: string | null }[],
  client: { start: { hrtimeNs: string; perfNowMs?: number }; end: { hrtimeNs: string } }, ctx: { wallOriginMs: number }, fill: { eewOriginWallMs: number }): ExpirySplit;
export function currentsExpiredAtMeasure(split: ExpirySplit): string | null;
// P3-E05S-AC02(3)〜(5): 区間の内訳（試験が読む分だけの宣言）。
export function e05sSplit(rows: Record<string, readonly { k: string; atMs: number; [key: string]: unknown }[]>, spans: readonly { fromHostMs: number; toHostMs: number | null }[],
  options?: { starts?: readonly { place: string | null; atMs: number; inputId: string }[]; mem?: readonly { perfNowMs: number; rss: number }[]; fromMs?: number | null; toMs?: number | null }): {
  threads: Record<string, { rows: number; maxGapMs: number | null; lastMs: number | null }>;
  publisherMax: { atMs: number; rss: number } | null;
  spans: { status: "rowsMissing" | "noPeakEnd" | "stale" | "busy" | "ok"; deferredStatus: "rowsMissing" | "noPeakEnd" | "stale" | "busy" | "ok"; peak: { atMs: number; rss: number } | null; floor: { atMs: number; rss: number } | null; eBytes: number | null;
    threads: Record<string, { peak: { atMs: number; ageMs: number; U: number; V: number; X: number; A: number } | null; floor: { atMs: number; ageMs: number; U: number; V: number; X: number; A: number } | null;
      delta: { U: number; V: number; X: number; A: number } | null; busy: { side: "peak" | "floor"; atMs: number; inputId?: string; gc?: number }[] }>;
    residual: { peak: number | null; floor: number | null; delta: number | null }; gBytes: number | null; peakAttribution: "未確定（取り逃し）" | null }[] };
