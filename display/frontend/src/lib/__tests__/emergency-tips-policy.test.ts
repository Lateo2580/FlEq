import { describe, expect, it } from "vitest";
import { deriveEmergencyCompanionControl as deriveEmergencyCompanionControlAt } from "../emergency-tips-policy";
import { baseSnapshot } from "./fixtures";

const deriveEmergencyCompanionControl = (snapshot: ReturnType<typeof baseSnapshot>) =>
  deriveEmergencyCompanionControlAt(snapshot, Date.parse(snapshot.generatedAt));

describe("deriveEmergencyCompanionControl", () => {
  it("allowlist にある緊急パネルだけを hazard として許可する", () => {
    const control = deriveEmergencyCompanionControl(baseSnapshot({
      activeEews: [{
        kind: "eew", eventId: "E1", serial: null, isWarning: true, isFinal: false, isCancellation: false,
        hypocenterName: null, forecastMaxInt: null, forecastMaxIntRank: null, magnitude: null, colorIndex: null,
        reportDateTime: "2026-07-29T00:00:00+09:00", originTime: null, isAssumedHypocenter: false, depth: null, maxLgInt: null,
        regions: [], updatedAtMs: 1,
      }],
      severityTier: "alert",
    }));
    expect(control.enabled).toBe(true);
    expect(control.hazards).toEqual(["eew"]);
  });

  it("critical と未知 tier は既定で companion を無効にする", () => {
    expect(deriveEmergencyCompanionControl(baseSnapshot({ severityTier: "critical" })).enabled).toBe(false);
    expect(deriveEmergencyCompanionControl(baseSnapshot({ severityTier: "unknown" as never })).enabled).toBe(false);
  });
});
