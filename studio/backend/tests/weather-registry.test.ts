import { describe, it, expect, vi } from "vitest";
import { findWeatherEntry, listWeatherEntries } from "../registry/weather-registry";
import { loadFixture } from "../lib/fixture-loader";
import type { ParsedWeatherWarning, ParsedVolcanoInfo } from "../../../src/types";
import { processTsunami } from "../../../src/engine/presentation/processors/process-tsunami";
import { processEarthquake } from "../../../src/engine/presentation/processors/process-earthquake";
import { buildVolcanoOutcome } from "../../../src/engine/presentation/processors/process-volcano";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { toPresentationEvent } from "../../../src/engine/presentation/events/to-presentation-event";
import { renderSummaryLine } from "../../../src/ui/summary/summary-line";

describe("weather-registry", () => {
  it("VPWW55 ファイル名から entry が引ける", () => {
    const entry = findWeatherEntry("15_17_01_251222_VPWW55.xml");
    expect(entry).not.toBeNull();
    expect(entry!.label).toContain("VPWW55");
    expect(typeof entry!.parse).toBe("function");
    expect(typeof entry!.format).toBe("function");
  });

  it("VPWW56-61 も同一エントリでカバーされる", () => {
    for (const f of [
      "15_16_01_241031_VPWW56.xml",
      "15_16_02_251222_VPWW57.xml",
      "15_16_04_251222_VPWW58.xml",
      "15_16_05_241226_VPWW59.xml",
      "15_16_06_241226_VPWW60.xml",
      "15_16_07_250825_VPWW61.xml",
    ]) {
      expect(findWeatherEntry(f), f).not.toBeNull();
    }
  });

  it("EEW (VXSE43) も entry が引ける (Phase 4b で登録)", () => {
    const entry = findWeatherEntry("37_01_01_240613_VXSE43.xml");
    expect(entry).not.toBeNull();
    expect(entry!.label).toContain("緊急地震速報");
    expect(typeof entry!.eewContext).toBe("function");
  });

  it("判定は inferType (先頭マッチ) 基準 — 先頭の VXSE43 が勝ち VPWW55 entry には誤マッチしない", () => {
    const entry = findWeatherEntry("32_VXSE43_vs_VPWW55.xml");
    expect(entry).not.toBeNull();
    expect(entry!.label).toContain("緊急地震速報"); // VPWW ではなく EEW entry
  });

  it("タイプを含まない id は null", () => {
    expect(findWeatherEntry("README.md")).toBeNull();
  });

  it("listWeatherEntries は Phase 1a 時点で 1 件以上を返す", () => {
    const entries = listWeatherEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("VXSE44/VXSE45 も同一 EEW entry を返す", () => {
    const eewEntry = findWeatherEntry("37_01_01_240613_VXSE43.xml");
    expect(findWeatherEntry("36_01_10_240613_VXSE44.xml")).toBe(eewEntry);
    expect(findWeatherEntry("77_01_01_240613_VXSE45.xml")).toBe(eewEntry);
  });
});

describe("compactLine (VPWW55-61)", () => {
  it("VPWW55 の compact 1 行を返す (フレーム罫線を含まない)", () => {
    const entry = findWeatherEntry("15_17_01_251222_VPWW55.xml")!;
    expect(entry.compactLine).toBeDefined();
    const msg = loadFixture("15_17_01_251222_VPWW55.xml")!;
    const parsed = entry.parse(msg)!;
    const line = entry.compactLine!(msg, parsed, 100);
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain("\n");      // 1 行
    expect(line).not.toContain("║");       // フレームではない
    expect(line).toContain("大雨");        // 種別が出る (fixture は島根県大雨警報)
  });

  it("width が狭いと出力も短くなる (fitTokensToWidth が効く)", () => {
    const entry = findWeatherEntry("15_17_01_251222_VPWW55.xml")!;
    const msg = loadFixture("15_17_01_251222_VPWW55.xml")!;
    const parsed = entry.parse(msg)!;
    const wide = entry.compactLine!(msg, parsed, 160);
    const narrow = entry.compactLine!(msg, parsed, 60);
    expect(narrow.length).toBeLessThanOrEqual(wide.length);
  });
});

describe("VPWS50 entry (初回受信 diff 合成)", () => {
  it("VPWS50 ファイル名から entry が引ける", () => {
    const entry = findWeatherEntry("15_18_01_250630_VPWS50.xml");
    expect(entry).not.toBeNull();
    expect(entry!.label).toContain("VPWS50");
  });

  it("format が初回受信表示を出力する (起動時現況サブライン)", { timeout: 20_000 }, () => {
    const entry = findWeatherEntry("15_18_01_250630_VPWS50.xml")!;
    const msg = loadFixture("15_18_01_250630_VPWS50.xml")!;
    const parsed = entry.parse(msg);
    expect(parsed).not.toBeNull();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      entry.format(parsed!);
    } finally {
      spy.mockRestore();
    }
    const out = logs.join("\n");
    // "起動時現況" は weather-formatter-vpws50.ts:633 の初回受信 (isFirstReport) サブライン。
    // もし出力に現れない場合は弱い assert に黙って差し替えず、実出力を添えて報告して止まること
    expect(out).toContain("起動時現況");
    expect(logs.length).toBeGreaterThan(3);
  });

  it("取消 infoType は rollback 経路に入る (空 history 警告つきで例外なし)", { timeout: 20_000 }, () => {
    const entry = findWeatherEntry("15_18_01_250630_VPWS50.xml")!;
    const msg = loadFixture("15_18_01_250630_VPWS50.xml")!;
    const base = entry.parse(msg)! as ParsedWeatherWarning;
    const cancelled: ParsedWeatherWarning = { ...base, infoType: "取消" };
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      expect(() => entry.format(cancelled)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(logs.length).toBeGreaterThan(0);
  });

  it("compactLine が 1 行を返す", { timeout: 20_000 }, () => {
    const entry = findWeatherEntry("15_18_01_250630_VPWS50.xml")!;
    const msg = loadFixture("15_18_01_250630_VPWS50.xml")!;
    const parsed = entry.parse(msg)!;
    const line = entry.compactLine!(msg, parsed, 100);
    expect(line.length).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });
});

describe("機械的 entries (VPWP50/VPHW/VPBS/VPAW/VPZI/解説/洪水)", () => {
  it.each([
    ["81_01_01_260129_VPWP50.xml", "VPWP50"],
    ["19_01_01_091210_VPHW50.xml", "VPHW50"],
    ["19_04_01_140425_VPHW51.xml", "VPHW51"],
    ["82_01_01_260324_VPBS50.xml", "VPBS50"],
    ["72_01_01_190327_VPAW51.xml", "VPAW51"],
    ["29_01_01_140129_VPZI50.xml", "VPZI50"],
    ["84_01_01_260129_VPCJ51.xml", "VPCJ51"],
    ["83_01_01_250630_VPZJ51.xml", "VPZJ51"],
    ["85_01_01_250630_VPFJ51.xml", "VPFJ51"],
    ["16_01_01_220728_VXKO50.xml", "VXKO50"],
    ["91_01_01_241031_VXSU50.xml", "VXSU50"],
  ] as const)("%s: entry 解決 + parse + format + compactLine が動く", (fixtureId, type) => {
    const entry = findWeatherEntry(fixtureId);
    expect(entry, fixtureId).not.toBeNull();
    const msg = loadFixture(fixtureId)!;
    const parsed = entry!.parse(msg);
    expect(parsed, `${type} parse`).not.toBeNull();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      entry!.format(parsed!);
    } finally {
      spy.mockRestore();
    }
    expect(logs.length, `${type} format 出力`).toBeGreaterThan(0);
    const line = entry!.compactLine!(msg, parsed!, 100);
    expect(line.length, `${type} compact`).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });
});

describe("津波 entry (VTSE41/51/52)", () => {
  it.each([
    ["32-39_11_02_250206_VTSE41.xml", "VTSE41"],
    ["32-39_11_03_250206_VTSE51.xml", "VTSE51"],
    ["61_11_01_250206_VTSE52.xml", "VTSE52"],
    ["38-39_03_01_210805_VTSE41.xml", "VTSE41 取消"],
  ] as const)("%s: entry 解決 + parse + format + compactLine が動く", (fixtureId, label) => {
    const entry = findWeatherEntry(fixtureId);
    expect(entry, fixtureId).not.toBeNull();
    const msg = loadFixture(fixtureId)!;
    const parsed = entry!.parse(msg);
    expect(parsed, `${label} parse`).not.toBeNull();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      entry!.format(parsed!);
    } finally {
      spy.mockRestore();
    }
    expect(logs.length, `${label} format 出力`).toBeGreaterThan(0);
    const line = entry!.compactLine!(msg, parsed!, 100);
    expect(line.length, `${label} compact`).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });

  it("compactLine は本番経路 (processTsunami + renderSummaryLine) と同一結果 (parity)", () => {
    const fixtureId = "32-39_11_02_250206_VTSE41.xml";
    const entry = findWeatherEntry(fixtureId)!;
    const msg = loadFixture(fixtureId)!;
    const parsed = entry.parse(msg)!;
    const studioLine = entry.compactLine!(msg, parsed, 120);
    const result = processTsunami(msg, new TsunamiStateHolder());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    const productionLine = renderSummaryLine(toPresentationEvent(result.outcome), 120);
    expect(studioLine).toBe(productionLine);
  });
});

describe("地震 entry (VXSE51/52/53/61)", () => {
  it.each([
    ["32-35_08_03_100915_VXSE51.xml", "VXSE51 震度速報"],
    ["32-35_01_02_240613_VXSE52.xml", "VXSE52 震源"],
    ["32-35_01_03_240613_VXSE53.xml", "VXSE53 震源・震度"],
    ["32-35_03_02_240613_VXSE61.xml", "VXSE61 震源要素更新 (実 fixture)"],
    ["32-39_05_12_100915_VXSE53.xml", "VXSE53 取消"],
  ] as const)("%s: entry 解決 + parse + format + compactLine が動く", (fixtureId, label) => {
    const entry = findWeatherEntry(fixtureId);
    expect(entry, fixtureId).not.toBeNull();
    const msg = loadFixture(fixtureId)!;
    const parsed = entry!.parse(msg);
    expect(parsed, `${label} parse`).not.toBeNull();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      entry!.format(parsed!);
    } finally {
      spy.mockRestore();
    }
    expect(logs.length, `${label} format 出力`).toBeGreaterThan(0);
    const line = entry!.compactLine!(msg, parsed!, 100);
    expect(line.length, `${label} compact`).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });

  it("compactLine は本番経路 (processEarthquake + renderSummaryLine) と同一結果 (parity)", () => {
    for (const fixtureId of [
      "32-35_08_03_100915_VXSE51.xml",
      "32-35_01_03_240613_VXSE53.xml",
      "32-35_03_02_240613_VXSE61.xml",
    ]) {
      const entry = findWeatherEntry(fixtureId)!;
      const msg = loadFixture(fixtureId)!;
      const parsed = entry.parse(msg)!;
      const studioLine = entry.compactLine!(msg, parsed, 120);
      const outcome = processEarthquake(msg)!;
      const productionLine = renderSummaryLine(toPresentationEvent(outcome), 120);
      expect(studioLine, fixtureId).toBe(productionLine);
    }
  });

  it("VXSE61 の compact に誤表記「遠地地震」が出ない (Task 1 の回帰ガード)", () => {
    const fixtureId = "32-35_03_02_240613_VXSE61.xml";
    const entry = findWeatherEntry(fixtureId)!;
    const msg = loadFixture(fixtureId)!;
    const parsed = entry.parse(msg)!;
    const line = entry.compactLine!(msg, parsed, 140);
    expect(line).not.toContain("遠地");
    expect(line).toContain("震源");
  });
});

describe("火山 entry (VFVO50-56/60, VZVO40, VFSVii)", () => {
  it.each([
    ["45_01_01_200522_VFVO50.xml", "VFVO50 噴火警報 Lv3"],
    ["44_02_01_200522_VFVO51.xml", "VFVO51 解説情報"],
    ["43_01_01_200522_VFVO52.xml", "VFVO52 観測報"],
    ["66_01_01_210517_VFVO53.xml", "VFVO53 降灰定時"],
    ["66_01_02_210514_VFVO54.xml", "VFVO54 降灰速報"],
    ["66_01_03_210514_VFVO55.xml", "VFVO55 降灰詳細"],
    ["67_01_01_140927_VFVO56.xml", "VFVO56 噴火速報"],
    ["79_01_01_210527_VFVO60.xml", "VFVO60 噴煙流向"],
    ["42_02_01_071130_VZVO40.xml", "VZVO40 お知らせ"],
    ["46_01_01_170103_VFSVii.xml", "VFSVii 海上警報"],
  ] as const)("%s: entry 解決 + parse + format + compactLine が動く", (fixtureId, label) => {
    const entry = findWeatherEntry(fixtureId);
    expect(entry, fixtureId).not.toBeNull();
    const msg = loadFixture(fixtureId)!;
    const parsed = entry!.parse(msg);
    expect(parsed, `${label} parse`).not.toBeNull();
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((s?: string) => { logs.push(s ?? ""); });
    try {
      entry!.format(parsed!);
    } finally {
      spy.mockRestore();
    }
    expect(logs.length, `${label} format 出力`).toBeGreaterThan(0);
    const line = entry!.compactLine!(msg, parsed!, 100);
    expect(line.length, `${label} compact`).toBeGreaterThan(0);
    expect(line).not.toContain("\n");
  });

  it("compactLine は本番経路 (buildVolcanoOutcome + renderSummaryLine) と同一結果 (parity)。areaCount 0 固定でも summary token が空にならない", () => {
    for (const fixtureId of [
      "45_01_01_200522_VFVO50.xml",
      "66_01_01_210517_VFVO53.xml",
      "79_01_01_210527_VFVO60.xml",
    ]) {
      const entry = findWeatherEntry(fixtureId)!;
      const msg = loadFixture(fixtureId)!;
      const parsed = entry.parse(msg)!;
      const studioLine = entry.compactLine!(msg, parsed, 120);
      // 本番 volcano-route-handler と同じ buildVolcanoOutcome 経路
      const outcome = buildVolcanoOutcome(msg, parsed as ParsedVolcanoInfo, new VolcanoStateHolder());
      const event = toPresentationEvent(outcome);
      const productionLine = renderSummaryLine(event, 120);
      expect(studioLine, fixtureId).toBe(productionLine);
      // 火山 PresentationEvent は areaCount 系 0 固定 (from-volcano.ts:48-56) — その実態を可視化しつつ
      // summary が空にならないことを固定する
      expect(event.areaCount, fixtureId).toBe(0);
      expect(studioLine.trim().length, fixtureId).toBeGreaterThan(0);
    }
  });

  it("Studio は初回状態 (isRenotification=false) のプレビュー — 毎 render fresh holder で決定的", () => {
    const fixtureId = "45_02_01_200522_VFVO50.xml"; // Lv5 継続: 初見 critical / 再通知 warning
    const entry = findWeatherEntry(fixtureId)!;
    const msg = loadFixture(fixtureId)!;
    const parsed = entry.parse(msg)!;
    // 同じ入力を 2 回 compact しても同一結果 (state が持ち越されない = 常に初回状態)
    expect(entry.compactLine!(msg, parsed, 120)).toBe(entry.compactLine!(msg, parsed, 120));
  });
});
