import type { DisplayMutation } from "../display/standby-registry";
import type { StandbyStateStore } from "../display/standby-state-store";
import type { FloodForecastStateHolder } from "./flood-forecast-state";
import {
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
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
  const expiry = revisionGate.expireRevisionFamilyByLifecycle(
    FLOOD_FORECAST_REVISION_FAMILY_POLICY.domain,
    FLOOD_FORECAST_REVISION_FAMILY_POLICY.revisionFamily,
    nowMs,
    {
      tombstoneRetentionMs: FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
      activeRetentionMs: FLOOD_FORECAST_REVISION_FAMILY_POLICY.activeRetentionMs,
    },
  );
  if (!expiry.changed) {
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
