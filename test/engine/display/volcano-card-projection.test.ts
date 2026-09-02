import { describe, expect, it } from "vitest";
import type { VolcanoAshfallProjectionV1 } from "../../../src/types";
import {
  displayVolcanoAshfall,
  projectVolcanoCard,
  volcanoAlertTone,
  volcanoAshfallTone,
  volcanoEruptionTone,
  type VolcanoCardProjectionState,
} from "../../../src/engine/display/volcano-card-projection";
import {
  VOLCANO_ASHFALL_MAX_WIRE_SLICES,
  VOLCANO_CARD_MAX_WIRE_BYTES,
} from "../../../src/engine/display/constants";
import type {
  DisplayVolcanoAshfallV1,
  DisplayVolcanoEventV1,
} from "../../../src/engine/display/protocol";

const REPORT_MS = Date.parse("2026-08-31T00:00:00.000Z");
const END_MS = Date.parse("2026-08-31T01:00:00.000Z");

function ashfallProjection(
  sourceType: "VFVO54" | "VFVO55",
  forecastEndsAtMs = END_MS,
): VolcanoAshfallProjectionV1 {
  return {
    stateSubjectKey: "volcano:ashfall:506",
    volcanoCode: "506",
    volcanoName: "桜島",
    eventId: "event-506",
    sourceType,
    sourceEventId: `source-${sourceType}`,
    forecastStartsAtMs: REPORT_MS,
    forecastEndsAtMs,
    groups: [{
      hazardClass: "ash",
      ashCode: "73",
      ashName: "多量の降灰",
      areaCount: 1,
      topAreas: [{
        identityKey: "area:code:46201",
        code: "46201",
        name: "鹿児島市",
        firstForecastEndAtMs: forecastEndsAtMs,
      }],
      omittedAreaCount: 0,
    }],
    omittedGroupCount: 0,
    revision: { reportTimeMs: REPORT_MS, serial: "1" },
    appliedSemanticKey: "semantic",
    generation: 1,
  };
}

function eruption(label = "噴火"): DisplayVolcanoEventV1 {
  return {
    label,
    craterName: null,
    eventDateTime: null,
    plumeHeightM: null,
    plumeHeightUnknown: false,
    plumeDirection: null,
  };
}

function state(
  code: string,
  overrides: Partial<VolcanoCardProjectionState> = {},
): VolcanoCardProjectionState {
  return {
    code,
    name: `火山${code}`,
    alertLevel: null,
    alertClass: null,
    warningKind: null,
    targetKinds: [],
    latestEvent: null,
    eventExpiresAtMs: null,
    sourceEventIds: [`source-${code}`],
    alertRevision: null,
    eventRevision: null,
    alertRestored: false,
    eventRestored: false,
    ashfall: null,
    ashfallExpiresAtMs: null,
    ashfallRevision: null,
    ashfallRestored: false,
    ...overrides,
  };
}

describe("volcano card projection", () => {
  it.each([
    [5, null, "emergency"],
    [4, null, "red"],
    [3, null, "warning"],
    [2, null, "advisory"],
    [1, null, "muted"],
    [null, { code: "x", name: "警報", severity: "warning", isActive: true }, "warning"],
    [null, { code: "x", name: "情報", severity: "info", isActive: true }, "muted"],
  ] as const)("maps alert level/class %s to %s", (level, alertClass, tone) => {
    expect(volcanoAlertTone(level, alertClass)).toBe(tone);
  });

  it("uses the eruption and ashfall tone lattice without inferring unknown detail severity", () => {
    expect(volcanoEruptionTone(eruption("噴火速報"))).toBe("red");
    expect(volcanoEruptionTone(eruption())).toBe("advisory");
    expect(volcanoEruptionTone(null)).toBe("muted");
    expect(volcanoAshfallTone(displayVolcanoAshfall(ashfallProjection("VFVO54")))).toBe("warning");
    expect(volcanoAshfallTone(displayVolcanoAshfall(ashfallProjection("VFVO55")))).toBe("muted");
  });

  it.each([
    ["2026-01-01T15:00:00.000Z", "2026年1月2日 00:00まで"],
    ["2026-01-31T15:00:00.000Z", "2026年2月1日 00:00まで"],
    ["2026-12-31T15:00:00.000Z", "2027年1月1日 00:00まで"],
  ])("formats forecast end across JST boundaries: %s", (iso, label) => {
    const display = displayVolcanoAshfall(ashfallProjection("VFVO54", Date.parse(iso)));
    expect(display.forecastEndsAt).toBe(iso);
    expect(display.forecastEndLabel).toBe(label);
  });

  it("keeps 64 ashfall details and retains hidden rapid lineage, tone, and restored state", () => {
    const inputs = Array.from({ length: VOLCANO_ASHFALL_MAX_WIRE_SLICES + 1 }, (_, index) => {
      const code = String(index).padStart(3, "0");
      const ashfall: DisplayVolcanoAshfallV1 = {
        ...displayVolcanoAshfall(ashfallProjection("VFVO54", END_MS + index)),
        sourceEventId: `ash-${code}`,
        generation: index + 1,
      };
      return state(code, {
        ashfall,
        ashfallExpiresAtMs: END_MS + index,
        ashfallRevision: { reportTimeMs: REPORT_MS + index, serial: "1" },
        ashfallRestored: index === VOLCANO_ASHFALL_MAX_WIRE_SLICES,
        sourceEventIds: [`lineage-${code}`],
      });
    });
    const result = projectVolcanoCard(inputs);
    expect(result.kind).toBe("card");
    if (result.kind !== "card") return;
    expect(result.card.data.volcanoes.filter((entry) => entry.ashfall != null)).toHaveLength(64);
    expect(result.card.data.ashfallOmittedCount).toBe(1);
    expect(result.card.data.headerTone).toBe("warning");
    expect(result.card.restored).toBe(true);
    expect(result.card.sourceEventIds).toContain("lineage-064");
    expect(result.card.data.volcanoes.find((entry) => entry.code === "064")?.ashfall).toBeUndefined();
  });

  it("iterates ashfall omission until the completed card is within 64 KiB", () => {
    const largeAshfall = (index: number): DisplayVolcanoAshfallV1 => ({
      ...displayVolcanoAshfall(ashfallProjection(index === 0 ? "VFVO54" : "VFVO55", END_MS + index)),
      sourceEventId: `ash-${index}`,
      groups: Array.from({ length: 8 }, (_, group) => ({
        hazardClass: "unknown" as const,
        ashCode: `x${group}`,
        ashName: `分類${"灰".repeat(50)}`,
        areas: Array.from({ length: 3 }, (_, area) => ({
          identityKey: `area:name:${index}-${group}-${area}-${"域".repeat(80)}`,
          code: null,
          name: `${index}-${group}-${area}-${"域".repeat(80)}`,
          displayLabel: `${index}-${group}-${area}-${"域".repeat(80)}`,
        })),
        omittedAreaCount: 99,
      })),
      omittedGroupCount: 9,
      generation: index + 1,
    });
    const result = projectVolcanoCard(Array.from({ length: 20 }, (_, index) => state(
      String(index).padStart(3, "0"),
      {
        ashfall: largeAshfall(index),
        ashfallExpiresAtMs: END_MS + index,
        ashfallRevision: { reportTimeMs: REPORT_MS + index, serial: "1" },
      },
    )));
    expect(result.kind).toBe("card");
    if (result.kind !== "card") return;
    expect(Buffer.byteLength(JSON.stringify(result.card), "utf8")).toBeLessThanOrEqual(
      VOLCANO_CARD_MAX_WIRE_BYTES,
    );
    expect(result.card.data.ashfallOmittedCount).toBeGreaterThan(0);
    expect(result.card.data.headerTone).toBe("warning");
  });

  it("accepts an exact 64 KiB minimum card and rejects one byte more", () => {
    const baseState = state("506", {
      alertLevel: 4,
      alertRevision: { reportTimeMs: REPORT_MS, serial: "1" },
    });
    const base = projectVolcanoCard([baseState]);
    expect(base.kind).toBe("card");
    if (base.kind !== "card") return;
    const baseBytes = Buffer.byteLength(JSON.stringify(base.card), "utf8");
    const exactName = baseState.name + "x".repeat(VOLCANO_CARD_MAX_WIRE_BYTES - baseBytes);
    const exact = projectVolcanoCard([{ ...baseState, name: exactName }]);
    expect(exact.kind).toBe("card");
    if (exact.kind === "card") {
      expect(Buffer.byteLength(JSON.stringify(exact.card), "utf8")).toBe(VOLCANO_CARD_MAX_WIRE_BYTES);
    }
    expect(projectVolcanoCard([{ ...baseState, name: `${exactName}x` }])).toEqual({
      kind: "overflow",
      minimumBytes: VOLCANO_CARD_MAX_WIRE_BYTES + 1,
    });
  });
});
