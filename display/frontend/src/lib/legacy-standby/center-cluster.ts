export type CenterClusterItem = "stats" | "recent-quakes";

export interface CenterClusterDecisionInput {
  previous: readonly CenterClusterItem[];
  capacity: number;
  baseGap: number;
  unresolved: (hidden: readonly CenterClusterItem[], capacity: number) => boolean;
}

export function nextCenterClusterHidden({ previous, capacity, baseGap, unresolved }: CenterClusterDecisionInput): CenterClusterItem[] {
  const recoveryCapacity = Math.max(0, capacity - baseGap * 2 - 0.01);
  if (previous.includes("recent-quakes")) {
    if (!unresolved(["stats"], recoveryCapacity)) return ["stats"];
    return [...previous];
  }
  if (previous.includes("stats") && !unresolved([], recoveryCapacity)) return [];
  if (!unresolved([], capacity)) return [...previous];
  return unresolved(["stats"], capacity) ? ["stats", "recent-quakes"] : ["stats"];
}
