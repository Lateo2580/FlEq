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
