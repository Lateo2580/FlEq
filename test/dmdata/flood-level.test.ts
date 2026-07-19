import { describe, it, expect } from "vitest";
import {
  floodKindCodeToLevel, maxFloodLevel,
  floodLevelToFrameLevel, floodLevelToSoundLevel,
} from "../../src/dmdata/flood-level";

describe("floodKindCodeToLevel", () => {
  it("maps known codes", () => {
    expect(floodKindCodeToLevel("10")).toBe("release");
    expect(floodKindCodeToLevel("20")).toBe("L2");
    expect(floodKindCodeToLevel("21")).toBe("L2");
    expect(floodKindCodeToLevel("30")).toBe("L3");
    expect(floodKindCodeToLevel("31")).toBe("L3");
    expect(floodKindCodeToLevel("40")).toBe("L4");
    expect(floodKindCodeToLevel("41")).toBe("L4");
    expect(floodKindCodeToLevel("51")).toBe("L5");
    expect(floodKindCodeToLevel("53")).toBe("L5");
    expect(floodKindCodeToLevel("unknown")).toBe("unknown");
  });
});

describe("maxFloodLevel", () => {
  it("returns max by FLOOD_LEVEL_RANK", () => {
    expect(maxFloodLevel(["L2", "L3", "L1"])).toBe("L3");
    expect(maxFloodLevel(["release", "L5"])).toBe("L5");
    expect(maxFloodLevel(["unknown", "L2"])).toBe("L2");
  });
  it("returns unknown for empty input", () => {
    expect(maxFloodLevel([])).toBe("unknown");
  });
});

describe("floodLevelToFrameLevel", () => {
  it("maps level to frame", () => {
    expect(floodLevelToFrameLevel("release")).toBe("cancel");
    expect(floodLevelToFrameLevel("L1")).toBe("info");
    expect(floodLevelToFrameLevel("L2")).toBe("normal");
    expect(floodLevelToFrameLevel("L3")).toBe("warning");
    expect(floodLevelToFrameLevel("L4")).toBe("critical");
    expect(floodLevelToFrameLevel("L5")).toBe("critical");
    expect(floodLevelToFrameLevel("unknown")).toBe("info");
  });
});

describe("floodLevelToSoundLevel", () => {
  it("maps level to sound (critical 音は L5 のみ、L4 は warning)", () => {
    expect(floodLevelToSoundLevel("release")).toBe("cancel");
    expect(floodLevelToSoundLevel("L1")).toBe("info");
    expect(floodLevelToSoundLevel("L2")).toBe("normal");
    expect(floodLevelToSoundLevel("L3")).toBe("warning");
    expect(floodLevelToSoundLevel("L4")).toBe("warning"); // critical 音は L5 のみ (memory vpww-phase-d-complete 原則)
    expect(floodLevelToSoundLevel("L5")).toBe("critical");
    expect(floodLevelToSoundLevel("unknown")).toBe("info");
  });
});
