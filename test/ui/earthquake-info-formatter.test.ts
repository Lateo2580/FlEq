import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, beforeEach, afterEach, vi , type MockInstance } from "vitest";
import chalk from "chalk";
import {
  buildIntensityRows,
  intensityColumns,
  displayEarthquakeInfo,
  type IntensityRow,
} from "../../src/ui/earthquake-info-formatter";
import {
  stripAnsi,
  visualWidth,
  setFrameWidth,
  setMaxObservations,
} from "../../src/ui/formatter";
import type { JmaIntensity, ParsedEarthquakeInfo, SpecialValue } from "../../src/types";
import { parseEarthquakeTelegram } from "../../src/dmdata/telegram-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE51_SHINDO_2,
  FIXTURE_VXSE51_CANCEL,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE53_CANCEL,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE61_1,
  FIXTURE_VXSE61_CANCEL,
} from "../helpers/mock-message";

const AREAS = [
  { name: "石川県能登", intensity: "7", lgIntensity: "4" },
  { name: "新潟県上越", intensity: "5強", lgIntensity: "3" },
  { name: "石川県加賀", intensity: "5強" },
  { name: "富山県東部", intensity: "5弱", lgIntensity: "1" },
  { name: "富山県西部", intensity: "5弱" },
  { name: "福井県嶺北", intensity: "5弱" },
  { name: "岐阜県飛騨", intensity: "5弱" },
  { name: "長野県北部", intensity: "5弱" },
];

describe("buildIntensityRows (震度 group-by + 全地域表示)", () => {
  it("震度降順にグループ化し、areaCount と生 areas を保持する", () => {
    const rows = buildIntensityRows(AREAS);
    expect(rows.map((r) => r.intensity)).toEqual(["7", "5強", "5弱"]);
    expect(rows.map((r) => r.areaCount)).toEqual([1, 2, 5]);
    expect(rows[2].areas.map((a) => a.name)).toEqual([
      "富山県東部", "富山県西部", "福井県嶺北", "岐阜県飛騨", "長野県北部",
    ]);
  });

  it("areaNames は全地域名を , 結合する (長周期バッジ付き、ほか N 焼き込みなし)", () => {
    const rows = buildIntensityRows(AREAS);
    expect(rows[0].areaNames).toBe("石川県能登 [長周期4]");
    expect(rows[1].areaNames).toBe("新潟県上越 [長周期3], 石川県加賀");
    expect(rows[2].areaNames).toBe(
      "富山県東部 [長周期1], 富山県西部, 福井県嶺北, 岐阜県飛騨, 長野県北部",
    );
    expect(rows[2].areaNames).not.toContain("ほか");
  });

  it("buildIntensityRows は全地域名を , 結合する (ほかN 焼き込みなし)", () => {
    const rows = buildIntensityRows([
      { name: "宮城県北部", intensity: "5弱" },
      { name: "宮城県南部", intensity: "5弱" },
      { name: "岩手県沿岸南部", intensity: "4" },
    ]);
    const shindo5 = rows.find((r) => r.intensity === "5弱")!;
    expect(shindo5.areaNames).toBe("宮城県北部, 宮城県南部");
    expect(shindo5.areaNames).not.toContain("ほか");
    expect(shindo5.areaCount).toBe(2);
  });

  it("未知の震度文字列は raw のまま先頭側に並ぶ (見落とし防止)", () => {
    const rows = buildIntensityRows([
      { name: "A", intensity: "4" },
      { name: "B", intensity: "震度不明X" },
    ]);
    expect(rows[0].intensity).toBe("震度不明X");
    expect(rows[1].intensity).toBe("4");
  });

  it("末尾空白混入 (dmdata 実例 <MaxInt>4 </MaxInt>) を正規化し、trim 有無混在でも単一グループに統合する", () => {
    const rows = buildIntensityRows([
      { name: "A", intensity: "4 " },
      { name: "B", intensity: "4" },
      { name: "C", intensity: "5弱 " },
    ]);
    // 正規化後は既知震度として扱われ、未知(先頭配置)にならない。
    // 順序も 5弱 → 4 の正しい降順になる
    expect(rows.map((r) => r.intensity)).toEqual(["5弱", "4"]);
    const row4 = rows.find((r) => r.intensity === "4")!;
    expect(row4.areaCount).toBe(2);
    expect(row4.areas.map((a) => a.name)).toEqual(["A", "B"]);
  });
});

describe("intensityColumns (Tier 割当)", () => {
  it("ultra-narrow は 震度・地域名 の 2 列、standard/wide は 地域数 を加えた 3 列", () => {
    expect(intensityColumns("ultra-narrow").map((c) => c.header)).toEqual(["震度", "地域名"]);
    expect(intensityColumns("standard").map((c) => c.header)).toEqual(["震度", "地域数", "地域名"]);
    expect(intensityColumns("wide").map((c) => c.header)).toEqual(["震度", "地域数", "地域名"]);
  });

  it("wide は地域名の maxWidth が standard より大きい", () => {
    const std = intensityColumns("standard").find((c) => c.header === "地域名")!;
    const wide = intensityColumns("wide").find((c) => c.header === "地域名")!;
    expect(wide.maxWidth).toBeGreaterThan(std.maxWidth);
  });

  it("ultra-narrow の minWidth 合計 + セパレータが幅 60 の innerWidth=56 に収まる (watch-point)", () => {
    const cols = intensityColumns("ultra-narrow");
    const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
    expect(total).toBeLessThanOrEqual(56);
  });

  it("地域名列は wrap: true (折りたたみ廃止、セル内改行で全地域表示)", () => {
    for (const mode of ["ultra-narrow", "standard", "wide"] as const) {
      const namesCol = intensityColumns(mode).find((c) => c.header === "地域名")!;
      expect(namesCol.wrap).toBe(true);
    }
  });

  it("震度列も wrap: true で特殊値 qualifier を clip しない", () => {
    for (const mode of ["ultra-narrow", "standard", "wide"] as const) {
      expect(intensityColumns(mode).find((c) => c.header === "震度")?.wrap).toBe(true);
    }
  });
});

// 固定タイムスタンプの synthetic critical (震度7 + 長周期4。critical の実 VXSE53 fixture は無い)
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
    ],
    municipalities: [],
  },
  tsunami: { text: "日本海沿岸では津波警報を発表中です。" },
  isTest: false,
};

function intensitySpecial(
  value: Partial<SpecialValue<JmaIntensity>>,
): SpecialValue<JmaIntensity> {
  return {
    raw: null,
    value: null,
    condition: null,
    description: null,
    presence: "missing",
    ...value,
  };
}

describe("displayEarthquakeInfo (新デザイン言語)", () => {
  let logSpy: MockInstance<typeof console.log>;
  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    setFrameWidth(60);
    setMaxObservations(null);
    logSpy.mockRestore();
  });
  const renderInfo = (info: ParsedEarthquakeInfo): string => {
    displayEarthquakeInfo(info);
    return logSpy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
  };
  const renderFixture = (fixture: string): string => {
    const info = parseEarthquakeTelegram(createMockWsDataMessage(fixture));
    expect(info).not.toBeNull();
    return renderInfo(info!);
  };

  it("VXSE53 遠地地震: タイトル・震源名・M7.1・津波テキストが出力に含まれる (旧テスト同等)", () => {
    setFrameWidth(100);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE53_ENCHI));
    expect(out).toContain("震源・震度に関する情報");
    expect(out).toContain("南太平洋");
    expect(out).toContain("M7.1");
    expect(out).toContain("津波の心配はありません");
  });

  it("synthetic 震度7: バナー・サマリなし + 3 列テーブル + カード行", () => {
    setFrameWidth(140);
    const out = stripAnsi(renderInfo(SYNTH_NOTO));
    const lines = out.split("\n");
    // バナー廃止 (spec §8 R2-2): frameTop より前は空行のみ
    const topIdx = lines.findIndex((l) => l.includes("╔"));
    expect(lines.slice(0, topIdx).every((l) => l.trim() === "")).toBe(true);
    // サマリ divider 廃止
    expect(out).not.toContain("サマリ");
    // NO_COLOR 冗長性: labeled divider + 震度列 prefix
    expect(out).toContain("震度分布");
    expect(out).toContain("地域数");
    expect(out).toContain("震度7");
    // 長周期バッジ・カード
    expect(out).toContain("[長周期4]");
    expect(out).toContain("長周期階級 4");
    expect(out).toContain("M7.6");
    expect(out).toContain("深さ 10km");
    // 震源・EventID・footer
    expect(out).toContain("石川県能登地方");
    expect(out).toContain("N37.5 E137.3");
    expect(out).toContain("EventID: 20240101161009");
    expect(out).toContain("VXSE53");
  });

  it.each([
    ["missing", intensitySpecial({ presence: "missing" }), "—"],
    ["empty", intensitySpecial({ raw: "", presence: "empty" }), "（空欄）"],
    ["unknown", intensitySpecial({ condition: "未入電", presence: "unknown" }), "不明"],
    ["qualitative", intensitySpecial({ condition: "5弱以上未入電", presence: "qualitative", lowerBound: "5-" }), "5弱以上未入電"],
    ["range", intensitySpecial({ presence: "range", lowerBound: "4", upperBound: "5-", rawLowerBound: "4", rawUpperBound: "5-" }), "4〜5弱"],
    ["lower-only", intensitySpecial({ presence: "range", lowerBound: "5-", rawLowerBound: "5-", rawUpperBound: "over" }), "5弱程度以上"],
    ["qualitative upper-only", intensitySpecial({ presence: "qualitative", upperBound: "5-" }), "5弱以下"],
  ] as const)("SpecialValue %s を CLI カード・地域行で qualifier 付き表示する", (_label, maxIntValue, expected) => {
    setFrameWidth(140);
    const out = stripAnsi(renderInfo({
      ...SYNTH_NOTO,
      intensity: {
        maxInt: "",
        maxIntValue,
        areas: [{ name: "合成地域", code: null, intensity: "", intensityValue: maxIntValue }],
        municipalities: [],
      },
    }));
    expect(out).toContain(`最大震度 ${expected}`);
    expect(buildIntensityRows([{
      name: "合成地域",
      intensity: "",
      intensityValue: maxIntValue,
    }])[0]?.intensity).toBe(expected);
  });

  it("狭幅の実描画でも地域別 qualifier『5弱以上未入電』を震度列へ全文表示する", () => {
    setFrameWidth(60);
    const maxIntValue = intensitySpecial({
      condition: "5弱以上未入電",
      presence: "qualitative",
      lowerBound: "5-",
    });
    const plain = stripAnsi(renderInfo({
      ...SYNTH_NOTO,
      intensity: {
        maxInt: "",
        maxIntValue,
        areas: [{ name: "合成地域", code: null, intensity: "", intensityValue: maxIntValue }],
        municipalities: [],
      },
    }));
    const lines = plain.split("\n");
    const start = lines.findIndex((line) => line.includes("震度分布"));
    const end = lines.findIndex((line, index) => index > start && line.startsWith("╠"));
    const firstColumn = lines.slice(start + 1, end)
      .map((line) => line.match(/^[║│]\s*([^│║]*?)\s*│/)?.[1].trim() ?? "")
      .join("")
      .replace(/\s/g, "");
    expect(firstColumn).toContain("震度5弱以上未入電");
  });

  it.each(["NaN", "計算中"])("非数値 magnitude %s は M不明へ縮退し MNaN を出さない", (magnitude) => {
    setFrameWidth(140);
    const out = stripAnsi(renderInfo({
      ...SYNTH_NOTO,
      earthquake: { ...SYNTH_NOTO.earthquake!, magnitude },
    }));
    expect(out).toContain("M不明");
    expect(out).not.toContain("MNaN");
    expect(out).not.toContain(`M${magnitude}`);
  });

  it("重複codeを含んでもCLI formatterは文字表示用areasの順序・件数を維持する", () => {
    setFrameWidth(140);
    const legacyAreas = [
      { name: "細分・旧", code: null, intensity: "3" },
      { name: "細分・新A", code: null, intensity: "4" },
      { name: "細分・新B", code: null, intensity: "4" },
    ];
    const codedAreas = legacyAreas.map((area) => ({ ...area, code: "440" }));
    const legacyOutput = stripAnsi(renderInfo({
      ...SYNTH_NOTO,
      intensity: {
        maxInt: "4",
        areas: legacyAreas,
        municipalities: [],
      },
    }));
    logSpy.mockClear();
    const codedOutput = stripAnsi(renderInfo({
      ...SYNTH_NOTO,
      intensity: {
        maxInt: "4",
        areas: codedAreas,
        municipalities: [],
      },
    }));

    expect(codedOutput).toBe(legacyOutput);
    expect(codedOutput).toContain("細分・旧");
    expect(codedOutput).toContain("細分・新A, 細分・新B");
  });

  it("VXSE51 (最大震度4): バナーなしで震度分布と調査中フォールバックが出る", () => {
    setFrameWidth(100);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE51_SHINDO));
    const lines = out.split("\n");
    const topIdx = lines.findIndex((l) => l.includes("╔"));
    expect(topIdx).toBeGreaterThan(-1);
    expect(lines.slice(0, topIdx).every((l) => l.trim() === "")).toBe(true);
    expect(out).toContain("震源についてはただいま調査中です");
    expect(out).toContain("岩手県沿岸南部");
  });

  it("VXSE52 (震源のみ・intensity なし): バナーなし・震度分布なし", () => {
    setFrameWidth(100);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE52_HYPO_1));
    const lines = out.split("\n");
    const topIdx = lines.findIndex((l) => l.includes("┌") || l.includes("╔"));
    // frameTop より前は空行のみ (バナーなし)
    expect(lines.slice(0, topIdx).every((l) => stripAnsi(l).trim() === "")).toBe(true);
    expect(out).not.toContain("震度分布");
    expect(out).toContain("震源に関する情報");
  });

  it("取消: [取消] 表示でバナーなし", () => {
    setFrameWidth(100);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE53_CANCEL));
    expect(out).toContain("[取消]");
    const lines = out.split("\n");
    const topIdx = lines.findIndex((l) => l.includes("┌") || l.includes("╔"));
    expect(lines.slice(0, topIdx).every((l) => stripAnsi(l).trim() === "")).toBe(true);
  });

  it("ultra-narrow (幅 60) では 地域数 列が出ない、standard (幅 140) では出る", () => {
    setFrameWidth(60);
    const narrow = stripAnsi(renderInfo(SYNTH_NOTO));
    const narrowHeader = narrow.split("\n").find((l) => l.includes("震度") && l.includes("地域名"));
    expect(narrowHeader).toBeDefined();
    expect(narrowHeader!).not.toContain("地域数");
    logSpy.mockClear();
    setFrameWidth(140);
    const std = stripAnsi(renderInfo(SYNTH_NOTO));
    const stdHeader = std.split("\n").find((l) => l.includes("震度") && l.includes("地域名"));
    expect(stdHeader).toBeDefined();
    expect(stdHeader!).toContain("地域数");
  });

  it("VXSE51 standard: 折りたたみ無し・[詳細] 無し・全地域がテーブル内 (wrap)", () => {
    setFrameWidth(140);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE51_SHINDO));
    expect(out).not.toContain("ほか");
    expect(out).not.toContain("[詳細]");
    // wrap 列は幅で物理行が割れるため、罫線・空白を除去した flat 文字列で判定する
    // (flattenFrame は下方 (L360 付近) で function 宣言、hoisting で先読み可能)
    const flat = flattenFrame(out);
    // fixture (32-35_08_03_100915_VXSE51.xml) の全 11 地域名が含まれる
    for (const name of [
      "岩手県沿岸南部", "岩手県内陸北部", "岩手県沿岸北部", "岩手県内陸南部",
      "宮城県北部", "宮城県中部", "宮城県南部",
      "青森県津軽北部", "青森県三八上北", "青森県下北",
      "秋田県内陸南部",
    ]) {
      expect(flat).toContain(name);
    }
  });

  it("実 fixture (MaxInt 末尾空白混入 <MaxInt>4 </MaxInt>) parse→表示で未知震度マーカーが出ず、5弱→4 の順で並ぶ", () => {
    setFrameWidth(100);
    const out = stripAnsi(renderFixture(FIXTURE_VXSE53_DRILL_1));
    // buildIntensityRows の "?" prefix (intensityColumns の未知値マーカー) が出ないこと
    expect(out).not.toMatch(/\?4/);
    // 5弱 (fixture 上の生値は "5-") の行が 4 の行より先に出現する (震度降順)
    const idx5jaku = out.indexOf("震度5-");
    const idx4 = out.indexOf("震度4");
    expect(idx5jaku).toBeGreaterThanOrEqual(0);
    expect(idx4).toBeGreaterThanOrEqual(0);
    expect(idx5jaku).toBeLessThan(idx4);
  });
});

// ── 品質テスト群 (spec §6) ──

const ALL_VXSE_FIXTURES = [
  FIXTURE_VXSE51_SHINDO,
  FIXTURE_VXSE51_SHINDO_2,
  FIXTURE_VXSE51_CANCEL,
  FIXTURE_VXSE52_HYPO_1,
  FIXTURE_VXSE53_ENCHI,
  FIXTURE_VXSE53_DRILL_1,
  FIXTURE_VXSE53_CANCEL,
  FIXTURE_VXSE61_1,
  FIXTURE_VXSE61_CANCEL,
];

/** wrap・frame 罫線・空白を除去して全文検索できる形に潰す (復元検査用) */
function flattenFrame(out: string): string {
  return stripAnsi(out).replace(/[║│╠╣╔╗╚╝═─\s]/g, "");
}

function captureDisplay(info: ParsedEarthquakeInfo): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displayEarthquakeInfo(info);
    return spy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

/** 150〜200 地域の巨大地震 synthetic (spec §4/§6。maxObservations 既定 null = 無制限を再現) */
function makeMegaQuake(areaCount: number): ParsedEarthquakeInfo {
  const pool = ["6強", "6弱", "5強", "5弱", "4", "3"];
  const areas = Array.from({ length: areaCount }, (_, i) => ({
    name: `架空細分区域第${String(i + 1).padStart(3, "0")}区`,
    intensity: pool[i % pool.length],
    ...(i % 17 === 0 ? { lgIntensity: "2" } : {}),
  }));
  return {
    meta: testTelegramMeta(false),
    type: "VXSE53",
    infoType: "発表",
    title: "震源・震度に関する情報",
    reportDateTime: "2026-07-02T10:00:00+09:00",
    headline: "巨大地震 synthetic",
    publishingOffice: "気象庁",
    eventId: "20260702100000",
    earthquake: {
      originTime: "2026-07-02T09:58:00+09:00",
      hypocenterName: "架空湾",
      latitude: "N35.0",
      longitude: "E140.0",
      depth: "20km",
      magnitude: "8.2",
    },
    intensity: {
      maxInt: "6強",
      maxLgInt: "3",
      areas: areas.map((area) => ({ ...area, code: null })),
      municipalities: [],
    },
    isTest: false,
  };
}

const LONG_NAME_INFO: ParsedEarthquakeInfo = {
  ...makeMegaQuake(4),
  intensity: {
    maxInt: "5強",
    areas: [
      { name: "非常に長い架空の細分区域名でセル幅を必ず超過させる検証用文字列", code: null, intensity: "5強", lgIntensity: "2" },
      { name: "短い区", code: null, intensity: "4" },
    ],
    municipalities: [],
  },
};

describe("幅 60-200 sweep (acceptance 3)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); setMaxObservations(null); });

  it("全 VXSE fixture + synthetic (巨大 180 地域 / 長地域名 / 震度7) で全行が width 以下", () => {
    const parsedAll = ALL_VXSE_FIXTURES.map((fx) => {
      const info = parseEarthquakeTelegram(createMockWsDataMessage(fx));
      expect(info, fx).not.toBeNull();
      return { fx, info: info! };
    });
    const targets = [
      ...parsedAll,
      { fx: "mega-180", info: makeMegaQuake(180) },
      { fx: "long-name", info: LONG_NAME_INFO },
      { fx: "synth-noto", info: SYNTH_NOTO },
    ];
    for (let w = 60; w <= 200; w++) {
      setFrameWidth(w);
      for (const { fx, info } of targets) {
        const out = captureDisplay(info);
        for (const line of out.split("\n")) {
          expect(visualWidth(stripAnsi(line)), `${fx} width=${w}`).toBeLessThanOrEqual(w);
        }
      }
    }
  }, 20000);
});

describe("全 area 所在保証 invariant (acceptance 12)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  // Task 6 (wrap 全表示化) により折りたたみ・[詳細] 逃がしを廃止したため、
  // 「本体・詳細・省略カウントのいずれかに必ず現れる」という旧 OR 条件は不要になった。
  // wrapTextLines はセル内容を一切 clip せず物理行を増やすだけなので、
  // 全 area 名が必ずそのまま本体テーブルに現れる (シンプルな AND 条件に縮退)。
  function checkInvariant(info: ParsedEarthquakeInfo, label: string): void {
    if (info.intensity == null || info.intensity.areas.length === 0) return;
    const flat = flattenFrame(captureDisplay(info));
    for (const a of info.intensity.areas) {
      expect(flat, `${label}: ${a.name} (震度${a.intensity})`).toContain(a.name.replace(/\s/g, ""));
    }
  }

  it.each([60, 140, 180])("幅 %i: 全 fixture + 巨大 synthetic (150/180/200 地域) の全 area 名がテーブルに現れる", (w) => {
    setFrameWidth(w);
    for (const fx of ALL_VXSE_FIXTURES) {
      const info = parseEarthquakeTelegram(createMockWsDataMessage(fx));
      expect(info, fx).not.toBeNull();
      checkInvariant(info!, fx);
    }
    for (const n of [150, 180, 200]) {
      checkInvariant(makeMegaQuake(n), `mega-${n}`);
    }
  }, 20000);
});

describe("golden inventory (acceptance 8: 既存表示フィールドの欠落ゼロ)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); setMaxObservations(null); });

  it.each(ALL_VXSE_FIXTURES)("%s: 全フィールドの内容が出力のどこかに現れる", (fx) => {
    setFrameWidth(160);
    const info = parseEarthquakeTelegram(createMockWsDataMessage(fx))!;
    const out = captureDisplay(info);
    const flat = flattenFrame(out);
    const expectIn = (v: string | null | undefined): void => {
      if (!v) return;
      expect(flat, `${fx}: ${v.slice(0, 12)}`).toContain(v.replace(/\s/g, "").slice(0, 24));
    };
    expectIn(info.headline);
    if (info.earthquake) {
      expectIn(info.earthquake.hypocenterName);
      expectIn(info.earthquake.depth);
    }
    if (info.intensity) {
      expectIn(info.intensity.maxInt);
    }
    expectIn(info.tsunami?.text ?? null);
    expectIn(info.eventId);
    expectIn(info.publishingOffice);
    expect(flat).toContain(info.type);
  });

  it("isTest=true でテスト電文バッジが出る", () => {
    setFrameWidth(140);
    const out = captureDisplay({ ...SYNTH_NOTO, isTest: true });
    expect(stripAnsi(out)).toContain("テスト電文");
  });
});

describe("バナー廃止 (spec §8 R2-2: フレーム前に何も出ない)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  it("fixture 全件 + synthetic: frameTop より前に空行以外が出ない", () => {
    setFrameWidth(100);
    const targets: { label: string; info: ParsedEarthquakeInfo }[] = [
      ...ALL_VXSE_FIXTURES.map((fx) => ({
        label: fx,
        info: parseEarthquakeTelegram(createMockWsDataMessage(fx))!,
      })),
      { label: "synth-noto", info: SYNTH_NOTO },
      { label: "mega-180", info: makeMegaQuake(180) },
    ];
    for (const { label, info } of targets) {
      const lines = captureDisplay(info).split("\n");
      const topIdx = lines.findIndex((l) => l.includes("╔") || l.includes("┌"));
      expect(topIdx, label).toBeGreaterThan(-1);
      expect(
        lines.slice(0, topIdx).every((l) => stripAnsi(l).trim() === ""),
        label,
      ).toBe(true);
    }
  });
});
