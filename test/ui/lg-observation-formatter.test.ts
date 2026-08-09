import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, beforeEach, afterEach, vi , type MockInstance } from "vitest";
import chalk from "chalk";
import {
  displayLgObservationInfo,
  buildLgAreaRows,
  lgAreaColumns,
  buildLgSummaryLine,
} from "../../src/ui/lg-observation-formatter";
import { parseLgObservationTelegram } from "../../src/dmdata/telegram-parser";
import { lgIntensityColor, setFrameWidth, stripAnsi, visualWidth } from "../../src/ui/formatter";
import type { JmaIntensity, JmaLgIntensity, ParsedLgObservationInfo, LgObservationArea, SpecialValue } from "../../src/types";
import { createMockWsDataMessage, FIXTURE_VXSE62_LGOBS } from "../helpers/mock-message";

/** wrap・frame 罫線・空白を除去して全文検索できる形に潰す (名前復元検査用、Phase 3 と同型) */
function flattenFrame(out: string): string {
  return stripAnsi(out).replace(/[║│╠╣╔╗╚╝═─\s]/g, "");
}

function parseFixture(): ParsedLgObservationInfo {
  const msg = createMockWsDataMessage(FIXTURE_VXSE62_LGOBS, {
    head: { type: "VXSE62", author: "気象庁", time: new Date().toISOString(), test: false },
  });
  const info = parseLgObservationTelegram(msg);
  expect(info).not.toBeNull();
  return info!;
}

/** 多地域・多階級 synthetic (実 fixture は 1 件 11 地域のみ — spec §2 特記事項) */
function makeSyntheticMulti(count = 60): ParsedLgObservationInfo {
  const base = parseFixture();
  const areas: LgObservationArea[] = Array.from({ length: count }, (_, i) => ({
    name: `合成観測地域${String(i).padStart(2, "0")}`,
    maxInt: ["1", "2", "3", "4", "5弱"][i % 5],
    maxLgInt: `${(i % 4) + 1}`,
  }));
  return { ...base, maxLgInt: "4", areas };
}

function lgSpecial(value: Partial<SpecialValue<JmaLgIntensity>>): SpecialValue<JmaLgIntensity> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...value,
  };
}

describe("displayLgObservationInfo (engine テーブル)", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });

  function render(info: ParsedLgObservationInfo): string {
    logSpy.mockClear();
    displayLgObservationInfo(info);
    return logSpy.mock.calls.map((args) => String(args[0])).join("\n");
  }

  it("buildLgAreaRows は階級降順 → 名前順 (sort invariant、fixture 順の偶然に吸わせない)", () => {
    const areas: LgObservationArea[] = [
      { name: "うう地域", maxInt: "3", maxLgInt: "2" },
      { name: "ああ地域", maxInt: "4", maxLgInt: "3" },
      { name: "いい地域", maxInt: "2", maxLgInt: "3" },
      { name: "ええ地域", maxInt: "1", maxLgInt: "1" },
    ];
    const rows = buildLgAreaRows(areas);
    expect(rows.map((r) => r.areaName)).toEqual(["ああ地域", "いい地域", "うう地域", "ええ地域"]);
    expect(rows.map((r) => r.maxLgInt)).toEqual(["3", "3", "2", "1"]);
  });

  it("lgAreaColumns は 2 列 (地域名 / 最大震度) で ultra-narrow が innerWidth=56 に収まる (watch-point)", () => {
    for (const mode of ["ultra-narrow", "standard", "wide"] as const) {
      expect(lgAreaColumns(mode).map((c) => c.header)).toEqual(["地域名", "最大震度"]);
    }
    const cols = lgAreaColumns("ultra-narrow");
    const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
    expect(total).toBeLessThanOrEqual(56);
    const std = lgAreaColumns("standard").find((c) => c.header === "地域名")!;
    const wide = lgAreaColumns("wide").find((c) => c.header === "地域名")!;
    expect(wide.maxWidth).toBeGreaterThan(std.maxWidth);
    for (const mode of ["ultra-narrow", "standard", "wide"] as const) {
      expect(lgAreaColumns(mode).find((c) => c.header === "最大震度")?.wrap).toBe(true);
    }
  });

  it("VXSE62 実 fixture: 階級 divider + 全地域名 + カード + 震源 + サマリが出る", () => {
    setFrameWidth(140);
    const info = parseFixture();
    const output = render(info);
    const flat = flattenFrame(output);
    for (const area of info.areas) {
      expect(flat, `地域 ${area.name}`).toContain(area.name.replace(/\s/g, ""));
    }
    const plain = stripAnsi(output);
    expect(plain).toContain("長周期3");        // 階級 divider (fixture の最上位階級)
    expect(plain).toContain("観測地域");        // labeled divider (NO_COLOR 冗長性 ②)
    expect(plain).toContain("サマリ");
    expect(output).toContain("岩手県沖");
    expect(output).toContain("M6.3");
    expect(output).toContain("https://");       // detailUri
    // 折りたたみ廃止: 省略カウントが出ない (名前必須 invariant)
    expect(plain).not.toMatch(/他 \d+ 地点/);
  });

  it.each([
    ["missing", lgSpecial({ presence: "missing" }), "—"],
    ["empty", lgSpecial({ raw: "", presence: "empty" }), "（空欄）"],
    ["unknown", lgSpecial({ condition: "未入電", presence: "unknown" }), "不明（未入電）"],
    ["qualitative", lgSpecial({ description: "階級3以上", presence: "qualitative", lowerBound: "3" }), "3以上"],
    ["range", lgSpecial({ presence: "range", lowerBound: "2", upperBound: "4" }), "2〜4"],
  ] as const)("長周期 SpecialValue %s を CLI カード・地域 divider へ保持する", (_label, maxLgIntValue, expected) => {
    setFrameWidth(140);
    const base = parseFixture();
    const output = stripAnsi(render({
      ...base,
      maxLgInt: "",
      maxLgIntValue,
      areas: [{
        name: "合成地域",
        maxInt: "3",
        maxLgInt: "",
        maxLgIntValue,
      }],
    }));
    expect(output).toContain(`長周期階級 ${expected}`);
    expect(output).toContain(`長周期${expected}`);
  });

  it("狭幅の実描画でも地域別震度 qualifier『5弱以上未入電』を全文表示する", () => {
    setFrameWidth(60);
    const base = parseFixture();
    const maxIntValue: SpecialValue<JmaIntensity> = {
      raw: "",
      value: null,
      condition: "5弱以上未入電",
      description: null,
      presence: "qualitative",
      lowerBound: "5-",
    };
    const plain = stripAnsi(render({
      ...base,
      areas: [{
        name: "合成地域",
        maxInt: "",
        maxIntValue,
        maxLgInt: "3",
      }],
    }));
    const lines = plain.split("\n");
    const start = lines.findIndex((line) => line.includes("地域名") && line.includes("最大震度"));
    const end = lines.findIndex((line, index) => index > start && line.startsWith("╠"));
    const intensityColumn = lines.slice(start, end)
      .map((line) => line.match(/│\s*([^│║]*?)\s*║$/)?.[1].trim() ?? "")
      .join("")
      .replace(/\s/g, "");
    expect(intensityColumn).toContain("震度5弱以上未入電");
  });

  it.each(["NaN", "計算中"])("非数値 magnitude %s は M不明へ縮退し MNaN を出さない", (magnitude) => {
    setFrameWidth(140);
    const info = parseFixture();
    expect(info.earthquake).toBeDefined();
    const output = stripAnsi(render({
      ...info,
      earthquake: { ...info.earthquake!, magnitude, magnitudeInfo: undefined, magnitudeValue: undefined },
    }));
    expect(output).toContain("M不明");
    expect(output).not.toContain("MNaN");
    expect(output).not.toContain(`M${magnitude}`);
  });

  it("synthetic 60 地域: 幅 60 でも全地域名が本体のどこかに名前として現れ、全行が幅保証", () => {
    setFrameWidth(60);
    const info = makeSyntheticMulti(60);
    const output = render(info);
    const flat = flattenFrame(output);
    for (const area of info.areas) {
      expect(flat, `地域 ${area.name}`).toContain(area.name.replace(/\s/g, ""));
    }
    for (const line of output.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it("長名地域は clip 表示され [詳細] は出ない (hidden-only 化で clip 回収廃止, spec §2.4)", () => {
    setFrameWidth(60);
    const base = parseFixture();
    const longName = "実クリップ検証用の非常に長い長周期観測地域名称サンプルです";
    expect(visualWidth(longName)).toBeGreaterThan(50); // areaCol 割当上限より確実に長い前提 assert
    const areas: LgObservationArea[] = [{ name: longName, maxInt: "3", maxLgInt: "2" }];
    const output = render({ ...base, maxLgInt: "2", areas });
    const plain = stripAnsi(output);
    // clip 回収の廃止: [詳細] ブロック自体が出ない
    expect(plain).not.toContain("[詳細]");
    // テーブル本体には clip 済みセル (先頭部分) が出る
    expect(plain).toContain("実クリップ検証用");
    // 全行幅保証は維持
    for (const line of output.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
    }
  });

  it("buildLgSummaryLine は階級降順の階級別地域数を「 ・ 」区切りで返す", () => {
    const s = stripAnsi(buildLgSummaryLine(makeSyntheticMulti(60).areas));
    expect(s).toMatch(/長周期4 \d+ 地域/);
    expect(s).toMatch(/長周期1 \d+ 地域/);
    expect(s.indexOf("長周期4")).toBeLessThan(s.indexOf("長周期1"));
  });

  it("長周期サマリは range の safety 上端で順序・色を決め、整形済み label を再解析しない", () => {
    const areas: LgObservationArea[] = [
      { name: "exact3", maxInt: "3", maxLgInt: "3", maxLgIntValue: lgSpecial({ raw: "3", value: "3", presence: "value" }) },
      { name: "range", maxInt: "3", maxLgInt: "", maxLgIntValue: lgSpecial({ presence: "range", lowerBound: "2", upperBound: "4" }) },
      { name: "lower", maxInt: "3", maxLgInt: "", maxLgIntValue: lgSpecial({ presence: "range", lowerBound: "2" }) },
      { name: "unknown", maxInt: "3", maxLgInt: "", maxLgIntValue: lgSpecial({ condition: "未入電", presence: "unknown" }) },
    ];
    const summary = buildLgSummaryLine(areas);
    const plain = stripAnsi(summary);
    expect(plain.indexOf("長周期2〜4")).toBeLessThan(plain.indexOf("長周期3"));
    expect(plain.indexOf("長周期3")).toBeLessThan(plain.indexOf("長周期2以上"));
    expect(plain.indexOf("長周期2以上")).toBeLessThan(plain.indexOf("長周期不明"));
    expect(summary).toContain(lgIntensityColor("4")("長周期2〜4 1 地域"));
  });

  it("qualitative の両 bounds は下限 safety rank で順序・色を統一する", () => {
    const areas: LgObservationArea[] = [
      { name: "exact3", maxInt: "3", maxLgInt: "3", maxLgIntValue: lgSpecial({ raw: "3", value: "3", presence: "value" }) },
      { name: "qualitative", maxInt: "3", maxLgInt: "", maxLgIntValue: lgSpecial({ presence: "qualitative", lowerBound: "2", upperBound: "4" }) },
      { name: "exact1", maxInt: "3", maxLgInt: "1", maxLgIntValue: lgSpecial({ raw: "1", value: "1", presence: "value" }) },
    ];
    const summary = buildLgSummaryLine(areas);
    const plain = stripAnsi(summary);
    expect(plain.indexOf("長周期3")).toBeLessThan(plain.indexOf("長周期2〜4"));
    expect(plain.indexOf("長周期2〜4")).toBeLessThan(plain.indexOf("長周期1"));
    expect(summary).toContain(lgIntensityColor("2")("長周期2〜4 1 地域"));
    expect(summary).not.toContain(lgIntensityColor("4")("長周期2〜4 1 地域"));
  });

  it("欠損 optional (earthquake/maxInt/maxLgInt/comment/detailUri なし) は行ごと省略され表示が壊れない", () => {
    const base = parseFixture();
    const minimal: ParsedLgObservationInfo = {
      meta: testTelegramMeta(false),
      type: base.type, infoType: base.infoType, title: base.title,
      reportDateTime: base.reportDateTime, headline: null,
      publishingOffice: base.publishingOffice, areas: [], isTest: false,
    };
    const output = render(minimal);
    expect(stripAnsi(output)).not.toContain("震源地:");
    expect(stripAnsi(output)).not.toContain("観測地域");
    expect(output).toMatch(/[┌└│┐┘]/); // info フレームは出る
  });
});

describe("長周期観測: 取消・isTest・golden inventory", () => {
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });

  function render(info: ParsedLgObservationInfo): string {
    logSpy.mockClear();
    displayLgObservationInfo(info);
    return logSpy.mock.calls.map((args) => String(args[0])).join("\n");
  }

  it("取消報 (synthetic — 実 cancel fixture なし): cancel フレームで表示される", () => {
    const info = parseFixture();
    const output = render({ ...info, infoType: "取消" });
    // "取消" 単体は infoType 由来で info 表示のままでも通ってしまうため、
    // cancel level 専用の severity ラベル [取消] で固定する (他 formatter の cancel テストと同じ流儀)
    expect(stripAnsi(output)).toContain("[取消]");
  });

  it("isTest: テスト電文バッジが出る", () => {
    const output = render({ ...parseFixture(), isTest: true });
    expect(stripAnsi(output)).toContain("テスト電文");
  });

  it("golden inventory: カード / 震源 / 観測地域 / サマリ / comment / detailUri / footer (lgCategory は意図的除外)", () => {
    setFrameWidth(140);
    const info = parseFixture();
    const plain = stripAnsi(render(info));
    expect(plain).toContain("長周期地震動に関する観測情報");     // タイトル
    expect(plain).toContain("長周期階級");                       // カード
    expect(plain).toContain("最大震度");
    expect(plain).toContain("震源地:");
    expect(plain).toContain("発生:");
    expect(plain).toContain("位置:");
    expect(plain).toContain("観測地域");                         // labeled divider
    expect(plain).toContain("サマリ");
    if (info.comment) expect(plain).toContain(info.comment.slice(0, 10));
    if (info.detailUri) expect(plain).toContain(info.detailUri);
    expect(plain).toContain("VXSE62");
    expect(plain).toContain(info.publishingOffice);
    // lgCategory は現行 UI と同じく非表示 (spec §5 Codex R1 — inventory から除外)
  });
});
