import { describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import { notifyMock } from "../setup";

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return { ...actual };
});

vi.mock("../../src/config", () => ({
  loadConfig: () => ({}),
  saveConfig: vi.fn(),
}));

vi.mock("../../src/engine/notification/sound-player", () => ({
  playSound: vi.fn(),
}));

vi.mock("../../src/logger", () => ({
  debug: vi.fn(),
  warn: vi.fn(),
}));

import { Notifier, resolveIconPath } from "../../src/engine/notification/notifier";
import type { ParsedEarthquakeInfo } from "../../src/types";

describe("Notifier", () => {
  it("uses the mocked notifier during tests", () => {
    const notifier = new Notifier();
    notifier.setSoundEnabled(false);

    const info: ParsedEarthquakeInfo = {
      type: "VXSE",
      infoType: "発表",
      title: "震源・震度情報",
      reportDateTime: "2026-03-11T12:34:56+09:00",
      headline: null,
      publishingOffice: "気象庁",
      earthquake: {
        originTime: "2026-03-11T12:34:00+09:00",
        hypocenterName: "東京都",
        latitude: "35.0",
        longitude: "139.0",
        depth: "10km",
        magnitude: "4.0",
      },
      intensity: {
        maxInt: "3",
        areas: [{ name: "東京都", intensity: "3" }],
      },
      isTest: false,
    };

    notifier.notifyEarthquake(info);

    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveIconPath", () => {
  it("returns {prefix}-{level}.png when it exists", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami-critical\.png$/);
    spy.mockRestore();
  });

  it("falls back to {prefix}.png when level-specific icon is missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("tsunami.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/tsunami\.png$/);
    expect(result).not.toMatch(/tsunami-critical/);
    spy.mockRestore();
  });

  it("falls back to default.png when category icon is also missing", () => {
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      return String(p).endsWith("default.png");
    });
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toMatch(/default\.png$/);
    spy.mockRestore();
  });

  it("returns undefined when no icon files exist", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const result = resolveIconPath("tsunami", "critical");
    expect(result).toBeUndefined();
    spy.mockRestore();
  });

  it("skips level-specific candidate when level is undefined", () => {
    const calls: string[] = [];
    const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      calls.push(String(p));
      return String(p).endsWith("earthquake.png");
    });
    const result = resolveIconPath("earthquake");
    expect(result).toMatch(/earthquake\.png$/);
    expect(calls.some((c) => c.includes("earthquake-"))).toBe(false);
    spy.mockRestore();
  });

  it("maps camelCase categories to kebab-case prefixes", () => {
    const spy = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const result = resolveIconPath("seismicText", "info");
    expect(result).toMatch(/seismic-text-info\.png$/);
    spy.mockRestore();
  });
});
