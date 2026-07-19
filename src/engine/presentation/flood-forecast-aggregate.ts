import type { FloodStation, FloodLevel } from "../../types";
import { FLOOD_LEVEL_RANK, maxFloodLevel } from "../../dmdata/flood-level";

/**
 * 河川単位の集約結果。
 * formatter (src/ui/flood-forecast-formatter.ts) から呼び出される純粋関数の
 * 出力。spec §4 / §7 で「aggregateByRiver は formatter 内呼出」と確定済み
 * (event 層では呼ばない)。
 *
 * - `riverKey`: group key。fallback chain は `primaryRiverCode ?? primaryRiverName ?? stationCode`
 * - `riverName`: 表示用河川名。primaryRiverName → riverNames[0] → "" の fallback
 * - `highestObservedLevel` / `highestObservedRank`: stations の stationObservedLevel から
 *   FLOOD_LEVEL_RANK 最大を取る。river の並び順 (sort) の基準にもなる。
 * - sort は highestObservedRank 降順。同 rank は出現順 (insertion order) を保持。
 */
export interface RiverSection {
  riverKey: string;
  riverName: string;
  stations: FloodStation[];
  highestObservedLevel: FloodLevel;
  highestObservedRank: number;
}

function groupKey(s: FloodStation): string {
  return s.primaryRiverCode ?? s.primaryRiverName ?? s.stationCode;
}

function resolveRiverName(s: FloodStation): string {
  if (s.primaryRiverName != null && s.primaryRiverName !== "") return s.primaryRiverName;
  if (s.riverNames.length > 0 && s.riverNames[0] !== "") return s.riverNames[0];
  return "";
}

/**
 * `stations` を河川単位にまとめる純粋関数。
 *
 * 集約規則:
 * - group key: `primaryRiverCode ?? primaryRiverName ?? stationCode`
 * - river 内の `stations` は入力順を保持 (formatter 側の表示順は station code/名 で別途決める想定)
 * - river 同士は `highestObservedRank` 降順、同 rank は出現順を保持
 */
export function aggregateByRiver(stations: FloodStation[]): RiverSection[] {
  const sections = new Map<string, RiverSection>();
  const insertionOrder: string[] = [];
  for (const s of stations) {
    const key = groupKey(s);
    const existing = sections.get(key);
    if (existing == null) {
      sections.set(key, {
        riverKey: key,
        riverName: resolveRiverName(s),
        stations: [s],
        highestObservedLevel: s.stationObservedLevel,
        highestObservedRank: FLOOD_LEVEL_RANK[s.stationObservedLevel],
      });
      insertionOrder.push(key);
    } else {
      existing.stations.push(s);
      // riverName の最終決定は「最初に出現した非空 name」を優先する
      if (existing.riverName === "") {
        const name = resolveRiverName(s);
        if (name !== "") existing.riverName = name;
      }
      const newMax = maxFloodLevel([existing.highestObservedLevel, s.stationObservedLevel]);
      existing.highestObservedLevel = newMax;
      existing.highestObservedRank = FLOOD_LEVEL_RANK[newMax];
    }
  }
  // 出現順をベースに stable sort (highestObservedRank 降順)
  const ordered = insertionOrder.map(k => sections.get(k)!);
  ordered.sort((a, b) => b.highestObservedRank - a.highestObservedRank);
  return ordered;
}
