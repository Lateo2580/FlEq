import type { DisplayMutation } from "../display/standby-registry";
import type { StandbyStateStore } from "../display/standby-state-store";
import type { FloodForecastStateHolder } from "./flood-forecast-state";
import {
  FLOOD_FORECAST_RETENTION_MS,
} from "./revision-family-registry";
import type { TelegramRevisionGate } from "./telegram-revision-gate";

export interface FloodFoundationSweepResult extends DisplayMutation {
  foundationChanged: boolean;
}

/** display on/off の双方から同じ洪水 lifecycle sweep を駆動する。 */
export function sweepFloodForecastFoundation(
  revisionGate: TelegramRevisionGate,
  holder: FloodForecastStateHolder,
  standby: StandbyStateStore,
  nowMs: number,
): FloodFoundationSweepResult {
  const foundationChanged = revisionGate.expireRevisionFamily(
    "floodForecast",
    "floodForecast",
    nowMs,
    FLOOD_FORECAST_RETENTION_MS,
  );
  if (!foundationChanged) {
    return { viewChanged: false, durableChanged: false, foundationChanged: false };
  }
  const eventIds = revisionGate.activeRevisionFamilySubjects(
    "floodForecast",
    "floodForecast",
  ).map((subject) => subject.slice("flood:event:".length));
  holder.retainActiveEventIds(eventIds);
  const mutation = standby.retainCanonicalFloodEvents(eventIds);
  return { ...mutation, foundationChanged: true };
}
