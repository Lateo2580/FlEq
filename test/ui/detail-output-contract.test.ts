import { testTelegramMeta } from "../helpers/telegram-meta";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../src/dmdata/weather-warning-level";
import { TsunamiStateHolder } from "../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../src/engine/messages/volcano-state";
import { Vpwp50DetailCache } from "../../src/engine/messages/vpwp50-detail-cache";
import { Vpws50StateHolder } from "../../src/engine/messages/vpws50-state";
import type {
  DetailProvider,
  ParsedTsunamiInfo,
  ParsedVolcanoAlertInfo,
  ParsedWeatherWarning,
  ParsedWeatherWarningTimeseriesInfo,
  WeatherItem,
  WeatherKind,
} from "../../src/types";
import { setFrameWidth } from "../../src/ui/formatter";
import { handleDetail } from "../../src/ui/repl-handlers/info-handlers";
import { canonicalizeLegacyTsunamiInfo } from "../../src/dmdata/tsunami-legacy-adapter";

const ORIGINAL_CHALK_LEVEL = chalk.level;
const tmpRoots: string[] = [];

function makeTmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "detail-output-contract-"));
  tmpRoots.push(root);
  return root;
}

function makeTsunamiInfo(): ParsedTsunamiInfo {
  return canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE41",
    infoType: "発表",
    title: "津波警報・注意報・予報",
    reportDateTime: "2025-01-01T00:00:00+09:00",
    headline: "津波警報を発表しました。",
    publishingOffice: "気象庁",
    forecast: [{
      areaCode: "340",
      areaName: "石川県能登",
      kindCode: "51",
      kind: "津波警報",
      maxHeightDescription: "３ｍ",
      firstHeight: "ただちに津波来襲と予測",
    }],
    warningComment: "海岸から離れてください。",
    isTest: false,
  });
}

function makeVolcanoInfo(): ParsedVolcanoAlertInfo {
  return {
    meta: testTelegramMeta(false),
    domain: "volcano",
    kind: "alert",
    type: "VFVO50",
    infoType: "発表",
    title: "噴火警報・予報",
    reportDateTime: "2025-01-01T00:01:00+09:00",
    eventDateTime: null,
    headline: null,
    publishingOffice: "気象庁",
    volcanoName: "桜島",
    volcanoCode: "506",
    coordinate: null,
    isTest: false,
    alertLevel: 3,
    alertLevelCode: "33",
    alertClass: null,
    action: "raise",
    previousLevelCode: "22",
    warningKind: "噴火警報（入山規制）",
    municipalities: [],
    marineAreas: [],
    marineWarningKind: null,
    marineAlertLevelCode: null,
    bodyText: "",
    preventionText: "",
    isMarine: false,
  };
}

function makeVpws50Info(): ParsedWeatherWarning {
  const kind: WeatherKind = { name: "大雨警報", code: "03", severity: "warning" };
  const item: WeatherItem = {
    areaName: "神奈川県",
    areaCode: "140000",
    kinds: [kind],
    statuses: [],
  };
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items: [item] }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 1,
    advisoryAreaCount: 0,
    isTest: false,
  };
}

function makeVpwp50Info(): ParsedWeatherWarningTimeseriesInfo {
  return {
    meta: testTelegramMeta(false),
    type: "VPWP50",
    infoType: "発表",
    title: "気象警報・注意報時系列情報",
    controlTitle: "気象警報・注意報時系列情報",
    reportDateTime: "2026-06-05T15:18:00+09:00",
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    eventId: null,
    serial: null,
    headline: null,
    targetArea: { name: "長野県", code: "200000", kinds: { 1: [], 2: [], 3: [] } },
    areas: [],
    maxKnownSignificancy: null,
    maxDisplaySeverity: null,
    maxSoundLevel: null,
    maxDisplayRankSignificancy: null,
    unknownCodes: [],
    fallback: "none",
    isTest: false,
  };
}

async function captureDetail(provider: DetailProvider, category: string): Promise<unknown[][]> {
  const calls: unknown[][] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    calls.push(args);
  });
  try {
    handleDetail({ detailProviders: [provider] } as never, category);
    return calls;
  } finally {
    spy.mockRestore();
  }
}

describe("detail output contract before holder/UI separation", () => {
  beforeAll(() => {
    chalk.level = 0;
    setFrameWidth(80);
  });

  afterEach(() => {
    vi.useRealTimers();
    while (tmpRoots.length > 0) {
      const root = tmpRoots.pop();
      if (root != null) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    chalk.level = ORIGINAL_CHALK_LEVEL;
    setFrameWidth(60);
  });

  it("tsunami", async () => {
    const holder = new TsunamiStateHolder();
    holder.applyAccepted(makeTsunamiInfo());
    expect(holder.getDetail()?.kind).toBe(holder.category);
    expect(await captureDetail(holder, "tsunami")).toMatchSnapshot();
  });

  it("volcano", async () => {
    const holder = new VolcanoStateHolder();
    holder.update(makeVolcanoInfo());
    expect(holder.getDetail()?.kind).toBe(holder.category);
    expect(await captureDetail(holder, "volcano")).toMatchSnapshot();
  });

  // Snapshot key is intentionally preserved from the pre-refactor baseline.
  // The wait itself was removed; handleDetail now completes the output synchronously.
  it("vpws50 waits only for the pre-refactor dynamic import", async () => {
    const holder = new Vpws50StateHolder();
    holder.diffAndUpdate(makeVpws50Info(), "message-1");
    expect(holder.getDetail()?.kind).toBe(holder.category);
    expect(await captureDetail(holder, "vpws50")).toMatchSnapshot();
  });

  it("vpwp50", async () => {
    const holder = new Vpwp50DetailCache({ persistRoot: makeTmpRoot() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T00:00:00.000Z"));
    holder.rememberLatest(makeVpwp50Info());
    vi.useRealTimers();
    expect(holder.getDetail()?.kind).toBe(holder.category);
    expect(await captureDetail(holder, "vpwp50")).toMatchSnapshot();
  });
});
