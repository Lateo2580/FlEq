import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import chalk from "chalk";
import { displayEarthquakeInfo } from "../../src/ui/earthquake-info-formatter";
import { parseEarthquakeTelegram } from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE53_CANCEL,
} from "../helpers/mock-message";
import { setFrameWidth } from "../../src/ui/formatter";
import type { ParsedEarthquakeInfo } from "../../src/types";

// VXSE53 大地震 (critical) — 実 fixture に critical VXSE53 が無いため固定タイムスタンプの synthetic
const SYNTH_NOTO: ParsedEarthquakeInfo = {
  meta: testTelegramMeta(false),
  type: "VXSE53",
  infoType: "発表",
  title: "震源・震度に関する情報",
  reportDateTime: "2024-01-01T16:15:00+09:00",
  headline: "石川県能登地方で強い地震がありました",
  publishingOffice: "気象庁",
  eventId: "20240101161009",
  earthquake: {
    originTime: "2024-01-01T16:10:09+09:00",
    hypocenterName: "石川県能登地方",
    latitude: "N37.5",
    longitude: "E137.3",
    depth: "10km",
    magnitude: "7.6",
  },
  intensity: {
    maxInt: "7",
    maxLgInt: "4",
    areas: [
      { name: "石川県能登", code: null, intensity: "7", lgIntensity: "4" },
      { name: "新潟県上越", code: null, intensity: "5強", lgIntensity: "3" },
      { name: "石川県加賀", code: null, intensity: "5強" },
      { name: "富山県東部", code: null, intensity: "5弱", lgIntensity: "1" },
      { name: "富山県西部", code: null, intensity: "5弱" },
      { name: "福井県嶺北", code: null, intensity: "5弱" },
      { name: "岐阜県飛騨", code: null, intensity: "5弱" },
      { name: "長野県北部", code: null, intensity: "5弱" },
    ],
    municipalities: [],
  },
  tsunami: { text: "日本海沿岸では津波警報を発表中です。" },
  isTest: false,
};

interface SnapCase { label: string; info: () => ParsedEarthquakeInfo }
const CASES: SnapCase[] = [
  { label: "VXSE53-critical-synthetic", info: () => SYNTH_NOTO },
  { label: "VXSE51-shindo", info: () => parseEarthquakeTelegram(createMockWsDataMessage(FIXTURE_VXSE51_SHINDO))! },
  { label: "VXSE52-hypo-no-banner", info: () => parseEarthquakeTelegram(createMockWsDataMessage(FIXTURE_VXSE52_HYPO_1))! },
  { label: "VXSE53-cancel", info: () => parseEarthquakeTelegram(createMockWsDataMessage(FIXTURE_VXSE53_CANCEL))! },
];
// 3 段 breakpoint の代表幅: ultra-narrow / standard / wide
const MODES: Record<string, number> = { "ultra-narrow": 60, standard: 140, wide: 180 };

describe("NO_COLOR golden snapshot (chalk.level=0)", () => {
  let logs: string[] = [];
  const originalLevel = chalk.level;
  beforeEach(() => {
    logs = [];
    chalk.level = 0;
    vi.spyOn(console, "log").mockImplementation((s?: string) => logs.push(s ?? ""));
  });
  afterEach(() => {
    chalk.level = originalLevel;
    setFrameWidth(60);
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    for (const [modeName, w] of Object.entries(MODES)) {
      it(`${c.label} @ ${modeName}=${w}`, () => {
        setFrameWidth(w);
        displayEarthquakeInfo(c.info());
        const out = logs.join("\n").replace(/[ \t]+$/gm, "");
        expect(out).toMatchSnapshot();
      });
    }
  }
});
