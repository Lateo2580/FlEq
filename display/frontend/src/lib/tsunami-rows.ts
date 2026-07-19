// 予報区行・観測行の ordinal 付き安定キー採番 (純関数、spec §2-c Medium 6 / 最終改稿 2)。
// 現物の key は配列 index 込み (`${c.name}${c.kind}:${i}`) で無関係な行の途中挿入に弱かった。
// ここでは基底キー + 同一基底キー内の出現 ordinal (先勝ち) を採番し、無関係な行の途中挿入では
// 既存キーが変わらないようにする。同一名複数行の入替は識別不能だが protocol に行 ID が無い以上、
// 決定的縮退として妥当。初期 snapshot と render の両方で必ず同じ純関数を通すこと
// (別経路で採番すると初期判定と render のキーがずれ、初回行に reveal が付く)。
import type { DisplayTsunamiInputV1, DisplayTsunamiObservationV1 } from "./protocol";

export interface KeyedRow<T> {
  row: T;
  key: string;
}

function keyRows<T>(items: readonly T[], baseKey: (item: T) => string): KeyedRow<T>[] {
  const counts = new Map<string, number>();
  return items.map((row) => {
    const base = baseKey(row);
    const ordinal = counts.get(base) ?? 0;
    counts.set(base, ordinal + 1);
    return { row, key: `${base}|${ordinal}` };
  });
}

type Coast = DisplayTsunamiInputV1["coasts"][number];

// coast: `${name}|${kind}|${ordinal}` (同一 name+kind の N 個目)
export function keyCoastRows(coasts: readonly Coast[]): KeyedRow<Coast>[] {
  return keyRows(coasts, (c) => `${c.name}|${c.kind}`);
}

// observation: `${stationName}|${ordinal}` (同一 stationName の N 個目)
export function keyObsRows(
  observations: readonly DisplayTsunamiObservationV1[],
): KeyedRow<DisplayTsunamiObservationV1>[] {
  return keyRows(observations, (o) => o.stationName);
}
