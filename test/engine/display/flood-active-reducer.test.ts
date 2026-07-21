import { describe, expect, it } from "vitest";
import { FloodActiveReducer } from "../../../src/engine/display/flood-active-reducer";
import type { DisplayFloodUpdate } from "../../../src/engine/display/project-flood";
import type { DisplayFloodRiverV1 } from "../../../src/engine/display/protocol";

const T0 = Date.parse("2026-07-21T05:00:00+09:00");
const HOUR = 60 * 60_000;

function river(key: string, level: "L3" | "L4" | "L5" = "L3", reportTimeMs = T0): DisplayFloodRiverV1 {
  const levelRank = level === "L3" ? 30 : level === "L4" ? 40 : 51;
  return {
    riverKey: key,
    riverName: `${key}川`,
    level,
    levelRank,
    kindName: level === "L3" ? "氾濫警戒情報" : level === "L4" ? "氾濫危険情報" : "氾濫発生情報",
    reportDateTime: new Date(reportTimeMs).toISOString(),
  };
}

function replace(eventId: string, reportTimeMs: number, serial: string, rivers: DisplayFloodRiverV1[]): DisplayFloodUpdate {
  return { mode: "replace", eventId, reportDateTime: new Date(reportTimeMs).toISOString(), serial, rivers };
}

function cancel(eventId: string, reportTimeMs: number, serial: string): DisplayFloodUpdate {
  return { mode: "cancel", eventId, reportDateTime: new Date(reportTimeMs).toISOString(), serial };
}

function observeOnly(eventId: string, reportTimeMs: number, serial: string): DisplayFloodUpdate {
  return { mode: "observeOnly", eventId, reportDateTime: new Date(reportTimeMs).toISOString(), serial };
}

describe("FloodActiveReducer", () => {
  it("deduplicates rivers across EventIDs by severity, then by newer report", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("same", "L3", T0)]), T0);
    reducer.apply(replace("event-b", T0 + HOUR, "1", [river("same", "L4", T0 + HOUR)]), T0 + HOUR);
    reducer.apply(replace("event-c", T0 + 2 * HOUR, "1", [river("same", "L4", T0 + 2 * HOUR)]), T0 + 2 * HOUR);

    expect(reducer.snapshotCard()).toEqual(expect.objectContaining({
      key: "flood:active",
      sourceEventIds: ["event-a", "event-b", "event-c"],
      severity: "critical",
      data: { rivers: [expect.objectContaining({ riverKey: "same", level: "L4", reportDateTime: new Date(T0 + 2 * HOUR).toISOString() })] },
    }));
  });

  it("uses serial as the same-time tiebreaker when selecting a duplicate river", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [{ ...river("same", "L4"), kindName: "older" }]), T0);
    reducer.apply(replace("event-b", T0, "2", [{ ...river("same", "L4"), kindName: "newer" }]), T0 + 1);
    expect(reducer.snapshotCard()?.data.rivers[0]?.kindName).toBe("newer");
  });

  it("switches corner ↔ wide at 3/4 unique rivers after cross-event deduplication", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a"), river("b"), river("c")]), T0);
    expect(reducer.snapshotCard()?.surface).toBe("corner-right");

    reducer.apply(replace("event-b", T0 + HOUR, "1", [river("a", "L4"), river("d")]), T0 + HOUR);
    expect(reducer.snapshotCard()).toEqual(expect.objectContaining({
      surface: "clock-top-wide",
      data: { rivers: expect.arrayContaining([
        expect.objectContaining({ riverKey: "a", level: "L4" }),
        expect.objectContaining({ riverKey: "b" }),
        expect.objectContaining({ riverKey: "c" }),
        expect.objectContaining({ riverKey: "d" }),
      ]) },
    }));

    reducer.apply(replace("event-b", T0 + 2 * HOUR, "2", [river("a", "L4", T0 + 2 * HOUR)]), T0 + 2 * HOUR);
    expect(reducer.snapshotCard()?.surface).toBe("corner-right");
    expect(reducer.snapshotCard()?.data.rivers).toHaveLength(3);
  });

  it("observeOnly records the revision without changing view or extending TTL", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a")]), T0);
    const before = reducer.snapshotCard();
    expect(reducer.apply(observeOnly("event-a", T0 + HOUR, "2"), T0 + HOUR))
      .toEqual({ viewChanged: false, durableChanged: true });
    expect(reducer.snapshotCard()).toEqual(before);
    expect(reducer.sweep(T0 + 12 * HOUR)).toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()).toBeNull();
  });

  it("keeps a cancel tombstone, but accepts a newer rollback report", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a")]), T0);
    expect(reducer.apply(cancel("event-a", T0 + HOUR, "2"), T0 + HOUR))
      .toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()).toBeNull();
    expect(reducer.apply(replace("event-a", T0, "1", [river("a")]), T0 + HOUR + 1))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(reducer.apply(replace("event-a", T0 + 2 * HOUR, "3", [river("a", "L4", T0 + 2 * HOUR)]), T0 + 2 * HOUR))
      .toEqual({ viewChanged: true, durableChanged: true });
    expect(reducer.snapshotCard()?.data.rivers[0]?.level).toBe("L4");
  });

  it("keeps a tombstone after replace with zero active rivers", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a")]), T0);
    reducer.apply(replace("event-a", T0 + HOUR, "2", []), T0 + HOUR);
    expect(reducer.snapshotCard()).toBeNull();
    expect(reducer.apply(replace("event-a", T0, "1", [river("a")]), T0 + HOUR + 1))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(reducer.snapshotCard()).toBeNull();
  });

  it("expires each EventID 12 hours after its report time", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a")]), T0);
    expect(reducer.sweep(T0 + 12 * HOUR - 1).viewChanged).toBe(false);
    expect(reducer.sweep(T0 + 12 * HOUR)).toEqual({ viewChanged: true, durableChanged: true });
  });

  it("round-trips active events and seen revisions, marking restored cards", () => {
    const reducer = new FloodActiveReducer();
    reducer.apply(replace("event-a", T0, "1", [river("a")]), T0);
    reducer.apply(cancel("event-b", T0 + HOUR, "2"), T0 + HOUR);
    const saved = reducer.exportState();

    const restored = new FloodActiveReducer();
    restored.restoreState(saved, T0 + 2 * HOUR);
    expect(restored.snapshotCard()).toEqual(expect.objectContaining({ restored: true }));
    expect(restored.apply(replace("event-a", T0, "1", [river("a")]), T0 + 2 * HOUR))
      .toEqual({ viewChanged: false, durableChanged: false });
    expect(restored.apply(replace("event-b", T0, "1", [river("b")]), T0 + 2 * HOUR))
      .toEqual({ viewChanged: false, durableChanged: false });
  });
});
