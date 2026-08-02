// 予報区行・観測行の ordinal 付き安定キー採番 (純関数、spec §2-c Medium 6 / 最終改稿 2)。
// code があれば identity に使い、旧 snapshot／code 欠落時だけ名称へ縮退する。同一基底キー内では
// 出現 ordinal (先勝ち) を採番する。初期 snapshot と render の両方で必ず同じ純関数を通すこと
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

// Area.Code／Kind.Code は parser・state と同じ raw identity を保つ。
// trim は空白だけの欠落判定にだけ使い、identity 自体は正規化しない。
function nonBlankRawCode(value: string | null | undefined): string | null {
  return value == null || value.trim() === "" ? null : value;
}

// stationCode は既存契約どおり trim 後の値を identity に使う。
function nonBlankStationCode(value: string | null | undefined): string | null {
  const code = value?.trim();
  return code == null || code === "" ? null : code;
}

function coastBaseKey(coast: Coast): string {
  const areaCode = nonBlankRawCode(coast.areaCode);
  const kindCode = nonBlankRawCode(coast.kindCode);
  return areaCode != null && kindCode != null
    ? `code:${areaCode}|${kindCode}`
    : `${coast.name}|${coast.kind}`;
}

export function coastKindGroupKey(coast: Coast): string {
  const kindCode = nonBlankRawCode(coast.kindCode);
  return kindCode != null ? `kind-code:${kindCode}` : `kind-name:${coast.kind}`;
}

// coast: `${base}|${ordinal}`。code が揃う行は Area.Code+Kind.Code を base にし、
// 旧 snapshot／code 欠落時だけ `${name}|${kind}` へ fallback する。
export function keyCoastRows(coasts: readonly Coast[]): KeyedRow<Coast>[] {
  return keyRows(coasts, coastBaseKey);
}

// observation: stationCode があれば `code:${stationCode}|${ordinal}`、
// 旧 snapshot／code 欠落時だけ `${stationName}|${ordinal}` へ fallback する。
export function keyObsRows(
  observations: readonly DisplayTsunamiObservationV1[],
): KeyedRow<DisplayTsunamiObservationV1>[] {
  return keyRows(observations, (o) => {
    const stationCode = nonBlankStationCode(o.stationCode);
    return stationCode != null ? `code:${stationCode}` : o.stationName;
  });
}
