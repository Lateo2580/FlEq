import type { PresentationAreaItem } from "../presentation/types";
import { intensityToRank } from "../../utils/intensity";

export interface IntensityAreaGroup {
  intensity: string;
  rank: number;
  areas: string[];
  omittedAreaCount: number;
}

/** 電文由来の空白を除去した震度をキー・表示値として、震度降順に地域をまとめる。 */
export function groupIntensityAreas(items: PresentationAreaItem[]): IntensityAreaGroup[] {
  const byIntensity = new Map<string, string[]>();
  for (const item of items) {
    if (item.maxInt == null) continue;
    const intensity = item.maxInt.replace(/\s+/g, "");
    if (intensity === "") continue;
    const areas = byIntensity.get(intensity) ?? [];
    areas.push(item.name);
    byIntensity.set(intensity, areas);
  }
  return [...byIntensity.entries()]
    .map(([intensity, areas]) => ({
      intensity,
      rank: intensityToRank(intensity),
      areas,
      omittedAreaCount: 0,
    }))
    .sort((a, b) => b.rank - a.rank);
}
