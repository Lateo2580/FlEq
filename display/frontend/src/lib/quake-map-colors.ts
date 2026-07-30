export type QuakeMapRankClass =
  | "quake-map-unobserved"
  | "quake-map-unknown"
  | `quake-map-rank-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

const RANK_CLASSES = [
  "quake-map-rank-1",
  "quake-map-rank-2",
  "quake-map-rank-3",
  "quake-map-rank-4",
  "quake-map-rank-5",
  "quake-map-rank-6",
  "quake-map-rank-7",
  "quake-map-rank-8",
  "quake-map-rank-9",
] as const;

/** null/undefined は未観測、範囲外の値は受信済みだが未知震度として区別する。 */
export function quakeMapRankClass(rank: number | null | undefined): QuakeMapRankClass {
  if (rank == null) return "quake-map-unobserved";
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) return "quake-map-unknown";
  return RANK_CLASSES[rank - 1]!;
}

/** §6.4 の既存震度 token 対応。 */
export function quakeMapRankToken(rank: number): string | null {
  if (!Number.isInteger(rank) || rank < 1 || rank > 9) return null;
  if (rank === 8) return "var(--int-8-bg)";
  if (rank === 9) return "var(--int-9-bg)";
  return `var(--int-${rank})`;
}
