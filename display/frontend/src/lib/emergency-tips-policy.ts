import { buildWeatherEmergencyInput } from "./weather-panel";
import type { DisplayStateSnapshotV1 } from "./protocol";

export type EmergencyHazard = "eew" | "tsunami" | "earthquake" | "weather";

export interface EmergencyCompanionControl {
  /** パネル構成から導く安定キー。App は mode 遷移単位の session id をこれで上書きする。 */
  sessionId: string;
  enabled: boolean;
  hazards: readonly EmergencyHazard[];
}

const DISABLED: EmergencyCompanionControl = { sessionId: "none", enabled: false, hazards: [] };

/**
 * 緊急パネルだけから companion を許可するかを導く。
 * 未知 tier/hazard は常に拒否する。critical は明示 allowlist を持たない現段階では拒否する。
 */
export function deriveEmergencyCompanionControl(
  snapshot: DisplayStateSnapshotV1 | null | undefined,
  nowMs: number,
): EmergencyCompanionControl {
  if (snapshot == null) return DISABLED;
  if (snapshot.severityTier !== "calm" && snapshot.severityTier !== "caution" && snapshot.severityTier !== "alert") {
    return DISABLED;
  }

  const hazards: EmergencyHazard[] = [];
  const keys: string[] = [];
  if (snapshot.activeEews.length > 0) {
    hazards.push("eew");
    keys.push(...snapshot.activeEews.map((entry, index) => `eew:${entry.eventId ?? index}`));
  }
  if (snapshot.tsunami != null) {
    hazards.push("tsunami");
    keys.push(`tsunami:${snapshot.tsunami.updatedAtMs}`);
  }
  if (snapshot.largeQuakes.length > 0) {
    hazards.push("earthquake");
    keys.push(...snapshot.largeQuakes.map((entry, index) => `earthquake:${entry.eventId ?? index}`));
  }
  if (buildWeatherEmergencyInput(snapshot, nowMs) != null) {
    hazards.push("weather");
    keys.push("weather:current");
  }
  if (hazards.length === 0) return DISABLED;
  return {
    sessionId: keys.sort().join("|"),
    enabled: true,
    hazards,
  };
}
