import { describe, it, expect } from "vitest";
import { render } from "../lib/render-engine";
import { withStdoutCapture } from "../lib/stdout-capture";
import { loadFixture } from "../lib/fixture-loader";
import { parseWeatherWarning } from "../../../src/dmdata/weather-parser";
import { displayWeatherWarningCore } from "../../../src/ui/weather-core-formatter";
import { setFrameWidth, getFrameWidth } from "../../../src/ui/formatter";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { displayWeatherWarning } from "../../../src/ui/weather-formatter";
import { displayWeatherWarningTimeseriesInfo } from "../../../src/ui/weather-warning-timeseries-formatter";
import { displayTornadoAdvisory } from "../../../src/ui/tornado-formatter";
import { displayWeatherBriefing } from "../../../src/ui/briefing-formatter";
import { displayEarlyWeatherInfo } from "../../../src/ui/early-weather-formatter";
import { displayClimateInfo } from "../../../src/ui/climate-info-formatter";
import { displayWeatherExplanation } from "../../../src/ui/weather-explanation-formatter";
import { parseWeatherWarningTimeseries } from "../../../src/dmdata/weather-warning-timeseries-parser";
import { parseTornadoAdvisory } from "../../../src/dmdata/tornado-parser";
import { parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import { parseEarlyWeather } from "../../../src/dmdata/early-weather-parser";
import { parseClimateInfo } from "../../../src/dmdata/climate-info-parser";
import { parseWeatherExplanation } from "../../../src/dmdata/weather-explanation-parser";
import { renderSummaryLine } from "../../../src/ui/summary/summary-line";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { findWeatherEntry } from "../registry/weather-registry";
import { processWeather } from "../../../src/engine/presentation/processors/process-weather";
import { processWeatherWarningTimeseries } from "../../../src/engine/presentation/processors/process-weather-warning-timeseries";
import { processTornado } from "../../../src/engine/presentation/processors/process-tornado";
import { processBriefing } from "../../../src/engine/presentation/processors/process-briefing";
import { processEarlyWeather } from "../../../src/engine/presentation/processors/process-early-weather";
import { processClimateInfo } from "../../../src/engine/presentation/processors/process-climate-info";
import { processWeatherExplanation } from "../../../src/engine/presentation/processors/process-weather-explanation";
import { parseFloodForecast } from "../../../src/dmdata/flood-forecast-parser";
import { displayFloodForecastInfo } from "../../../src/ui/flood-forecast-formatter";
import { processFloodForecast } from "../../../src/engine/presentation/processors/process-flood-forecast";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import {
  parseSeismicTextTelegram,
  parseNankaiTroughTelegram,
  parseLgObservationTelegram,
} from "../../../src/dmdata/telegram-parser";
import { displaySeismicTextInfo } from "../../../src/ui/seismic-text-formatter";
import { displayNankaiTroughInfo } from "../../../src/ui/nankai-trough-formatter";
import { displayLgObservationInfo } from "../../../src/ui/lg-observation-formatter";
import { processSeismicText } from "../../../src/engine/presentation/processors/process-seismic-text";
import { processNankaiTrough } from "../../../src/engine/presentation/processors/process-nankai-trough";
import { processLgObservation } from "../../../src/engine/presentation/processors/process-lg-observation";
import type { ProcessOutcome } from "../../../src/engine/presentation/types";
import type { WsDataMessage } from "../../../src/types";
import { parseEewTelegram } from "../../../src/dmdata/telegram-parser";
import { displayEewInfo } from "../../../src/ui/eew-formatter";
import { processEew } from "../../../src/engine/presentation/processors/process-eew";
import { EewTracker } from "../../../src/engine/eew/eew-tracker";
import { EewEventLogger } from "../../../src/engine/eew/eew-logger";
// S2 parity 拡充: 津波 (VTSE) / 地震情報 (VXSE51-53/61) / 火山 (VFVO/VZVO40/VFSVii)。
// registry の対応 entry の format / compactLine と同じ経路を direct 側でも再現する。
import { parseTsunamiTelegram, parseEarthquakeTelegram } from "../../../src/dmdata/telegram-parser";
import { parseVolcanoTelegram } from "../../../src/dmdata/volcano-parser";
import { displayTsunamiInfo } from "../../../src/ui/tsunami-formatter";
import { displayEarthquakeInfo } from "../../../src/ui/earthquake-info-formatter";
import { displayVolcanoInfo } from "../../../src/ui/volcano-formatter";
import { resolveVolcanoPresentation } from "../../../src/engine/presentation/volcano-presentation";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import { processEarthquake } from "../../../src/engine/presentation/processors/process-earthquake";
import { buildVolcanoOutcome } from "../../../src/engine/presentation/processors/process-volcano";

/**
 * spec §7 回帰防止: Studio 経由 render と本番 formatter 直叩きが
 * 同一 fixture で byte 一致すること。Studio の capture/swap/復元の
 * どこかが本番出力を変えてしまったら、ここで検出される。
 */
describe("render parity (Studio vs 本番 formatter)", () => {
  it.each([
    ["15_17_01_251222_VPWW55.xml", true],
    ["15_16_07_250825_VPWW61.xml", true],
    ["15_17_01_251222_VPWW55.xml", false],  // 色付き — chalk level / theme swap 経路の回帰も検出 (レビュー反映)
  ] as const)(
    "%s (noColor=%s): width 80 で byte 一致",
    async (fixtureId, noColor) => {
      const studio = await render({
        fixtureId,
        themeOverride: { palette: {}, roles: {} },
        options: { compact: false, width: 80, noColor, nightMode: false },
      });

      const previousWidth = getFrameWidth();
      setFrameWidth(80);
      let direct = "";
      try {
        direct = await withStdoutCapture({ noColor }, () => {
          const msg = loadFixture(fixtureId)!;
          const parsed = parseWeatherWarning(msg)!;
          displayWeatherWarningCore(parsed);
        });
      } finally {
        setFrameWidth(previousWidth);
      }

      expect(studio.ansi).toBe(direct);
    },
  );

  it.each([
    ["81_01_01_260129_VPWP50.xml", (msg: WsDataMessage) => displayWeatherWarningTimeseriesInfo(parseWeatherWarningTimeseries(msg)!)],
    ["19_01_01_091210_VPHW50.xml", (msg: WsDataMessage) => displayTornadoAdvisory(parseTornadoAdvisory(msg)!)],
    ["19_04_01_140425_VPHW51.xml", (msg: WsDataMessage) => displayTornadoAdvisory(parseTornadoAdvisory(msg)!)],
    ["82_01_01_260324_VPBS50.xml", (msg: WsDataMessage) => displayWeatherBriefing(parseWeatherBriefing(msg)!)],
    ["72_01_01_190327_VPAW51.xml", (msg: WsDataMessage) => displayEarlyWeatherInfo(parseEarlyWeather(msg)!)],
    ["29_01_01_140129_VPZI50.xml", (msg: WsDataMessage) => displayClimateInfo(parseClimateInfo(msg)!)],
    ["84_01_01_260129_VPCJ51.xml", (msg: WsDataMessage) => displayWeatherExplanation(parseWeatherExplanation(msg)!)],
    ["83_01_01_250630_VPZJ51.xml", (msg: WsDataMessage) => displayWeatherExplanation(parseWeatherExplanation(msg)!)],
    ["85_01_01_250630_VPFJ51.xml", (msg: WsDataMessage) => displayWeatherExplanation(parseWeatherExplanation(msg)!)],
    // 洪水・水位系: VXKO/VXSU は formatter 内部で schema 分岐 (full / minimal) — 1 関数で両方カバー
    ["16_01_01_220728_VXKO50.xml", (msg: WsDataMessage) => displayFloodForecastInfo(parseFloodForecast(msg)!)],
    // §F multi-TSI guard: 多流域 fixture を full parity に追加し、Studio 経路でも per-basin 行が同じか確認
    ["16_10_01_260312_VXKO50.xml", (msg: WsDataMessage) => displayFloodForecastInfo(parseFloodForecast(msg)!)],
    ["16_11_01_260312_VXKO50.xml", (msg: WsDataMessage) => displayFloodForecastInfo(parseFloodForecast(msg)!)],
    ["91_01_01_241031_VXSU50.xml", (msg: WsDataMessage) => displayFloodForecastInfo(parseFloodForecast(msg)!)],
    // Phase 4a text 系 3 系統 (VYSE/VZSE40/VXSE62 は selected_xml 配下 — basename id で解決)
    ["32-35_09_01_191111_VXSE56.xml", (msg: WsDataMessage) => displaySeismicTextInfo(parseSeismicTextTelegram(msg)!)],
    ["42_01_01_100514_VZSE40.xml", (msg: WsDataMessage) => displaySeismicTextInfo(parseSeismicTextTelegram(msg)!)],
    ["74_01_04_200512_VYSE50.xml", (msg: WsDataMessage) => displayNankaiTroughInfo(parseNankaiTroughTelegram(msg)!)],
    ["80_01_01_240821_VYSE60.xml", (msg: WsDataMessage) => displayNankaiTroughInfo(parseNankaiTroughTelegram(msg)!)],
    ["78_01_01_240613_VXSE62.xml", (msg: WsDataMessage) => displayLgObservationInfo(parseLgObservationTelegram(msg)!)],
    // S2 拡充: 津波 (VTSE41 警報・注意報 / VTSE51 津波情報 / VTSE52 沖合の津波情報)
    ["32-39_11_02_250206_VTSE41.xml", (msg: WsDataMessage) => displayTsunamiInfo(parseTsunamiTelegram(msg)!)],
    ["32-39_11_03_250206_VTSE51.xml", (msg: WsDataMessage) => displayTsunamiInfo(parseTsunamiTelegram(msg)!)],
    ["32-39_12_05_250206_VTSE52.xml", (msg: WsDataMessage) => displayTsunamiInfo(parseTsunamiTelegram(msg)!)],
    // S2 拡充: 地震情報 (VXSE51 震度速報 / VXSE52 震源 / VXSE53 震源・震度 / VXSE61 震源要素更新)
    ["32-35_07_01_100915_VXSE51.xml", (msg: WsDataMessage) => displayEarthquakeInfo(parseEarthquakeTelegram(msg)!)],
    ["32-35_01_02_240613_VXSE52.xml", (msg: WsDataMessage) => displayEarthquakeInfo(parseEarthquakeTelegram(msg)!)],
    ["32-35_01_03_240613_VXSE53.xml", (msg: WsDataMessage) => displayEarthquakeInfo(parseEarthquakeTelegram(msg)!)],
    ["32-35_03_02_240613_VXSE61.xml", (msg: WsDataMessage) => displayEarthquakeInfo(parseEarthquakeTelegram(msg)!)],
    // S2 拡充: 火山 (VFVO50-56/60 / VZVO40 / VFSVii)。registry と同じく単一 parsed を
    // resolveVolcanoPresentation と displayVolcanoInfo に渡す (新品 VolcanoStateHolder = 初回状態)
    ["45_01_01_200522_VFVO50.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["44_01_01_151008_VFVO51.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["43_01_01_200522_VFVO52.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["66_01_01_210517_VFVO53.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["66_01_02_210514_VFVO54.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["66_01_03_210514_VFVO55.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["67_01_01_140927_VFVO56.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["79_01_01_210527_VFVO60.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["42_02_01_071130_VZVO40.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
    ["46_01_01_170103_VFSVii.xml", (msg: WsDataMessage) => { const p = parseVolcanoTelegram(msg)!; displayVolcanoInfo(p, resolveVolcanoPresentation(p, new VolcanoStateHolder())); }],
  ] as const)(
    "%s: width 80 noColor で byte 一致 (新 registry 経路)",
    async (fixtureId, directRender) => {
      const studio = await render({
        fixtureId,
        themeOverride: { palette: {}, roles: {} },
        options: { compact: false, width: 80, noColor: true, nightMode: false },
      });
      const previousWidth = getFrameWidth();
      setFrameWidth(80);
      let direct = "";
      try {
        direct = await withStdoutCapture({ noColor: true }, () => {
          directRender(loadFixture(fixtureId)!);
        });
      } finally {
        setFrameWidth(previousWidth);
      }
      expect(studio.ansi).toBe(direct);
    },
  );

  it("VPWS50: width 80 noColor で byte 一致 (初回受信 diff 合成経路)", { timeout: 30_000 }, async () => {
    const fixtureId = "15_18_01_250630_VPWS50.xml";
    const studio = await render({
      fixtureId,
      themeOverride: { palette: {}, roles: {} },
      options: { compact: false, width: 80, noColor: true, nightMode: false },
    });
    const previousWidth = getFrameWidth();
    setFrameWidth(80);
    let direct = "";
    try {
      direct = await withStdoutCapture({ noColor: true }, () => {
        const msg = loadFixture(fixtureId)!;
        const parsed = parseWeatherWarning(msg)!;
        const holder = new Vpws50StateHolder();
        const diff = holder.diffAndUpdate(parsed, `studio-${parsed.reportDateTime}`);
        displayWeatherWarning(parsed, diff);
      });
    } finally {
      setFrameWidth(previousWidth);
    }
    expect(studio.ansi).toBe(direct);
  });
});

// Phase 4b: EEW (VXSE43/44/45)。これは「formatter parity」であって「本番 routing parity」ではない —
// VXSE44 は本番 process-eew.ts:35-49 で常時抑制され表示されない (テスト名で区別、spec 4.6)
describe("EEW render parity (formatter parity — VXSE44 は本番 routing では常時抑制)", () => {
  it.each([
    "37_01_01_240613_VXSE43.xml",
    "37_01_02_240613_VXSE43.xml",
    "37_01_03_240613_VXSE43.xml",
    "36_01_10_240613_VXSE44.xml",
    "77_01_01_240613_VXSE45.xml",
    "77_01_26_240613_VXSE45.xml",
    "77_01_33_240613_VXSE45.xml",
    "77_02_01_260101_VXSE45_PLUM.xml",
    "77_02_02_260101_VXSE45_MIXED.xml",
    "77_01_30_260101_VXSE45_FINAL.xml",
  ] as const)("%s: width 80 noColor で byte 一致", async (fixtureId) => {
    const studio = await render({
      fixtureId,
      themeOverride: { palette: {}, roles: {} },
      options: { compact: false, width: 80, noColor: true, nightMode: false },
    });
    const previousWidth = getFrameWidth();
    setFrameWidth(80);
    let direct = "";
    try {
      direct = await withStdoutCapture({ noColor: true }, () => {
        const msg = loadFixture(fixtureId)!;
        const entry = findWeatherEntry(fixtureId)!;
        const parsed = parseEewTelegram(msg)!;
        displayEewInfo(parsed, entry.eewContext!(msg, parsed));
      });
    } finally {
      setFrameWidth(previousWidth);
    }
    expect(studio.ansi).toBe(direct);
  });

  // Codex 最終レビュー Important 2: render parity は Studio/direct 双方が同じ provider を使うため、
  // provider (EEW_STUDIO_CONTEXTS) の値自体が間違っていても一致してしまう (擬似 pass)。
  // ここでは provider の戻り値を fixture 実データ・意図と突き合わせて直接検証する。
  it("37_01_02 (第2報): diff は前報 (37_01_01, serial=1) の実値 M5.8/深さ30km/最大震度5- を持つ", () => {
    const fixtureId = "37_01_02_240613_VXSE43.xml";
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = parseEewTelegram(msg)!;
    const ctx = entry.eewContext!(msg, parsed);
    expect(ctx.activeCount).toBe(1);
    expect(ctx.colorIndex).toBe(0);
    // 37_01_01 (前報) は M5.8・深さ30km・最大震度5- (愛媛県南予 From5-,To5-) — map の値が
    // 前報の実値と矛盾していないか (同語反復にせず fixture 現物で検算する)
    expect(ctx.diff).toEqual({ previousMagnitude: "5.8", previousDepth: "30km", previousMaxInt: "5-" });
  });

  it("77_01_26 (連報): diff キーが解決され、活動中イベント数・色を持つ", () => {
    const fixtureId = "77_01_26_240613_VXSE45.xml";
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = parseEewTelegram(msg)!;
    const ctx = entry.eewContext!(msg, parsed);
    expect(ctx.activeCount).toBe(2);
    expect(ctx.colorIndex).toBe(0);
    // この event の連報 (serial 2-25) は fixture 化されていないため前報の実値を検算できないが、
    // 現報 (M6.7/深さ50km/最大震度6-) との整合 (diff が「軽い前報→重い現報」の昇順であること) は固定できる
    expect(ctx.diff).toBeDefined();
    expect(ctx.diff?.previousMagnitude).toBe("6.4");
    expect(ctx.diff?.previousDepth).toBe("30km");
    expect(ctx.diff?.previousMaxInt).toBe("5+");
  });

  it("77_01_33 (取消, Serial=32): activeCount=0 で diff を持たない", () => {
    const fixtureId = "77_01_33_240613_VXSE45.xml";
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = parseEewTelegram(msg)!;
    const ctx = entry.eewContext!(msg, parsed);
    expect(ctx.activeCount).toBe(0);
    expect(ctx.colorIndex).toBe(0);
    expect(ctx.diff).toBeUndefined();
  });

  it("77_01_01 (第1報): diff undefined (前報が存在しない)", () => {
    const fixtureId = "77_01_01_240613_VXSE45.xml";
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = parseEewTelegram(msg)!;
    const ctx = entry.eewContext!(msg, parsed);
    expect(ctx.activeCount).toBe(1);
    expect(ctx.colorIndex).toBe(0);
    expect(ctx.diff).toBeUndefined();
  });

  it.each([
    "37_01_01_240613_VXSE43.xml",
    "77_01_01_240613_VXSE45.xml",
  ] as const)(
    "%s (第1報): compactLine が本番 processEew 経由の summary と一致",
    (fixtureId) => {
      const msg = loadFixture(fixtureId)!;
      const entry = findWeatherEntry(fixtureId)!;
      const parsed = entry.parse(msg)!;
      const studioLine = entry.compactLine!(msg, parsed, 100);
      const logger = new EewEventLogger();
      logger.setEnabled(false); // ファイル書き込みなし
      const result = processEew(msg, new EewTracker(), logger);
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const productionLine = renderSummaryLine(toPresentationEvent(result.outcome), 100);
      expect(studioLine).toBe(productionLine);
    },
  );
});

describe("compact parity (registry compactLine vs 本番 processor 経由)", () => {
  it.each([
    ["15_17_01_251222_VPWW55.xml", (msg: WsDataMessage) => {
      const r = processWeather(msg);
      return r.kind === "ok" ? r.outcome : null;
    }],
    ["81_01_01_260129_VPWP50.xml", (msg: WsDataMessage) => processWeatherWarningTimeseries(msg)],
    ["19_01_01_091210_VPHW50.xml", (msg: WsDataMessage) => processTornado(msg)],
    ["19_04_01_140425_VPHW51.xml", (msg: WsDataMessage) => processTornado(msg)],
    ["82_01_01_260324_VPBS50.xml", (msg: WsDataMessage) => processBriefing(msg)],
    ["72_01_01_190327_VPAW51.xml", (msg: WsDataMessage) => processEarlyWeather(msg)],
    ["29_01_01_140129_VPZI50.xml", (msg: WsDataMessage) => processClimateInfo(msg)],
    ["84_01_01_260129_VPCJ51.xml", (msg: WsDataMessage) => processWeatherExplanation(msg)],
    ["83_01_01_250630_VPZJ51.xml", (msg: WsDataMessage) => processWeatherExplanation(msg)],
    ["85_01_01_250630_VPFJ51.xml", (msg: WsDataMessage) => processWeatherExplanation(msg)],
    ["32-35_09_01_191111_VXSE56.xml", (msg: WsDataMessage) => processSeismicText(msg)],
    ["42_01_01_100514_VZSE40.xml", (msg: WsDataMessage) => processSeismicText(msg)],
    ["74_01_04_200512_VYSE50.xml", (msg: WsDataMessage) => processNankaiTrough(msg)],
    ["80_01_01_240821_VYSE60.xml", (msg: WsDataMessage) => processNankaiTrough(msg)],
    ["78_01_01_240613_VXSE62.xml", (msg: WsDataMessage) => processLgObservation(msg)],
    // S2 拡充: 津波 (processTsunami は result.kind を返すため outcome を取り出す) / 地震 / 火山。
    // registry compactLine と同じ新品 Holder を渡し、決定性ガードとして byte 一致を固定する。
    ["32-39_11_02_250206_VTSE41.xml", (msg: WsDataMessage) => { const r = processTsunami(msg, new TsunamiStateHolder()); return r.kind === "ok" ? r.outcome : null; }],
    ["32-39_11_03_250206_VTSE51.xml", (msg: WsDataMessage) => { const r = processTsunami(msg, new TsunamiStateHolder()); return r.kind === "ok" ? r.outcome : null; }],
    ["32-39_12_05_250206_VTSE52.xml", (msg: WsDataMessage) => { const r = processTsunami(msg, new TsunamiStateHolder()); return r.kind === "ok" ? r.outcome : null; }],
    ["32-35_07_01_100915_VXSE51.xml", (msg: WsDataMessage) => processEarthquake(msg)],
    ["32-35_01_02_240613_VXSE52.xml", (msg: WsDataMessage) => processEarthquake(msg)],
    ["32-35_01_03_240613_VXSE53.xml", (msg: WsDataMessage) => processEarthquake(msg)],
    ["32-35_03_02_240613_VXSE61.xml", (msg: WsDataMessage) => processEarthquake(msg)],
    ["45_01_01_200522_VFVO50.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["44_01_01_151008_VFVO51.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["43_01_01_200522_VFVO52.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["66_01_01_210517_VFVO53.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["67_01_01_140927_VFVO56.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["79_01_01_210527_VFVO60.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["42_02_01_071130_VZVO40.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
    ["46_01_01_170103_VFSVii.xml", (msg: WsDataMessage) => buildVolcanoOutcome(msg, parseVolcanoTelegram(msg)!, new VolcanoStateHolder())],
  ] as const)("%s: compactLine が本番 processor 経由の summary と一致", (fixtureId, processFn) => {
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = entry.parse(msg)!;
    const studioLine = entry.compactLine!(msg, parsed, 100);
    const outcome: ProcessOutcome | null = processFn(msg);
    expect(outcome).not.toBeNull();
    const productionLine = renderSummaryLine(toPresentationEvent(outcome!), 100);
    expect(studioLine).toBe(productionLine);
  });

  it("VPWS50: compactLine が本番 processor 経由の summary と一致 (初回受信 deps つき)", { timeout: 30_000 }, () => {
    const fixtureId = "15_18_01_250630_VPWS50.xml";
    const msg = loadFixture(fixtureId)!;
    const entry = findWeatherEntry(fixtureId)!;
    const parsed = entry.parse(msg)!;
    const studioLine = entry.compactLine!(msg, parsed, 100);
    // 本番経路と同じ deps (vpws50State) を新品 holder で渡す — weatherDiff が乗った
    // 本物の WeatherOutcome と比較することで、entry の最小 Outcome (weatherDiff 省略) が
    // summary 出力に影響しないことを経験的に固定する (Codex 再確認 M2 反映)。
    // processWeather の deps 型は Pick<ProcessDeps, "vpws50State" | "vpww56State">
    // (process-weather.ts)。VPWS50 経路で vpww56State は実行時未使用だが型が要求する。
    const result = processWeather(msg, {
      vpws50State: new Vpws50StateHolder(),
      vpww56State: new Vpww56StateHolder(),
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const productionLine = renderSummaryLine(toPresentationEvent(result.outcome), 100);
    expect(studioLine).toBe(productionLine);
  });

  it.each([
    "16_01_01_220728_VXKO50.xml",
    // §F multi-TSI guard: 多流域 fixture を compact parity に追加
    "16_10_01_260312_VXKO50.xml",
    "16_11_01_260312_VXKO50.xml",
    "91_01_01_241031_VXSU50.xml",
  ] as const)(
    "%s (洪水・水位系): compactLine が本番 processor 経由の summary と一致 (floodForecastState deps)",
    (fixtureId) => {
      const msg = loadFixture(fixtureId)!;
      const entry = findWeatherEntry(fixtureId)!;
      const parsed = entry.parse(msg)!;
      const studioLine = entry.compactLine!(msg, parsed, 100);
      // VPWS50 と同パターン: 本番経路と同じ deps (floodForecastState) を新品 holder で渡す.
      // entry の compactLine 自体が processFloodForecast を呼ぶので、ここで再現する parity は
      // 「同じ msg + 同じ Holder 初期化条件で同じ summary 行が出る」決定性ガード.
      const outcome = processFloodForecast(msg, {
        floodForecastState: new FloodForecastStateHolder(),
      });
      expect(outcome).not.toBeNull();
      const productionLine = renderSummaryLine(toPresentationEvent(outcome!), 100);
      expect(studioLine).toBe(productionLine);
    },
  );
});
