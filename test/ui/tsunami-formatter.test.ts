import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect, beforeEach, afterEach, vi , type MockInstance } from "vitest";
import chalk from "chalk";
import {
  tsunamiSeverityOf,
  tsunamiSeverityChalk,
  displayTsunamiInfo,
  buildTsunamiForecastRows,
  buildTsunamiTideStationRows,
} from "../../src/ui/tsunami-formatter";
import * as theme from "../../src/ui/theme";
import {
  stripAnsi,
  visualWidth,
  setFrameWidth,
  setMaxObservations,
} from "../../src/ui/formatter";
import { type ParsedTsunamiInfo } from "../../src/types";
import { parseTsunamiTelegram } from "../../src/dmdata/telegram-parser";
import { tsunamiFrameLevel } from "../../src/engine/presentation/level-helpers";
import {
  canonicalizeLegacyTsunamiForecastItem,
  canonicalizeLegacyTsunamiInfo,
  type LegacyTsunamiForecastItemInput,
} from "../../src/dmdata/tsunami-legacy-adapter";
import {
  createMockWsDataMessage,
  FIXTURE_VTSE41_WARN,
  FIXTURE_VTSE51_INFO,
} from "../helpers/mock-message";

describe("tsunamiSeverityOf (表示用 severity 写像)", () => {
  it("既知 kind を写像する (suffix 付き含む)", () => {
    expect(tsunamiSeverityOf("大津波警報")).toEqual({ severity: "major", known: true });
    expect(tsunamiSeverityOf("大津波警報：発表")).toEqual({ severity: "major", known: true });
    expect(tsunamiSeverityOf("津波警報")).toEqual({ severity: "warning", known: true });
    expect(tsunamiSeverityOf("津波警報解除")).toEqual({ severity: "warning", known: true });
    expect(tsunamiSeverityOf("津波注意報")).toEqual({ severity: "advisory", known: true });
    expect(tsunamiSeverityOf("津波予報（若干の海面変動）")).toEqual({ severity: "forecast", known: true });
    expect(tsunamiSeverityOf("津波なし")).toEqual({ severity: "forecast", known: true });
    expect(tsunamiSeverityOf("警報解除")).toEqual({ severity: "forecast", known: true });
  });

  it("未知 kind は known=false で最低 warning へ昇格する", () => {
    expect(tsunamiSeverityOf("謎の新種別")).toEqual({ severity: "warning", known: false });
  });
});

describe("tsunamiSeverityChalk (severity → 色ロール)", () => {
  beforeEach(() => { chalk.level = 3; });

  it("major/warning/advisory は theme role、forecast は chalk.white に写像する", () => {
    expect(tsunamiSeverityChalk("major")("x")).toBe(theme.getRoleChalk("tsunamiMajor")("x"));
    expect(tsunamiSeverityChalk("warning")("x")).toBe(theme.getRoleChalk("tsunamiWarning")("x"));
    expect(tsunamiSeverityChalk("advisory")("x")).toBe(theme.getRoleChalk("tsunamiAdvisory")("x"));
    expect(tsunamiSeverityChalk("forecast")("x")).toBe(chalk.white("x"));
  });
});

describe("displayTsunamiInfo (新デザイン言語)", () => {
  let logSpy: MockInstance<typeof console.log>;
  beforeEach(() => {
    chalk.level = 3;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    setFrameWidth(60);
    logSpy.mockRestore();
  });
  const render = (fixture: string): string => {
    const info = parseTsunamiTelegram(createMockWsDataMessage(fixture));
    expect(info).not.toBeNull();
    displayTsunamiInfo(info!);
    return logSpy.mock.calls.map((args) => String(args[0])).join("\n");
  };

  it("VTSE41 の大津波警報を critical フレームで表示する", () => {
    setFrameWidth(100);
    const out = render(FIXTURE_VTSE41_WARN);
    expect(out).toContain("╔");
    expect(stripAnsi(out)).toContain("岩手県");
    expect(stripAnsi(out)).toContain("巨大");
    expect(stripAnsi(out)).toContain("[緊急]");
  });

  it("巨大地震の description を優先し MNaN を表示しない", () => {
    setFrameWidth(100);
    const out = stripAnsi(render(FIXTURE_VTSE41_WARN));
    expect(out).toContain("M8 を超える巨大地震");
    expect(out).not.toContain("MNaN");
    expect(out).not.toContain("マグニチュードNaN");
  });

  it.each(["NaN", "計算中"])("直接投入された非数値 magnitude %s は M不明へ縮退する", (magnitude) => {
    setFrameWidth(100);
    const info = parseTsunamiTelegram(createMockWsDataMessage(FIXTURE_VTSE41_WARN))!;
    expect(info.earthquake).toBeDefined();
    const out = stripAnsi(captureDisplay({
      ...info,
      earthquake: {
        ...info.earthquake!,
        magnitude,
        magnitudeInfo: undefined,
      },
    }));
    expect(out).toContain("M不明");
    expect(out).not.toContain("MNaN");
    expect(out).not.toContain(`M${magnitude}`);
  });

  it("ultra-narrow (幅 100) では forecast は 3 列 (到達予想は詳細へ)", () => {
    setFrameWidth(100);
    const out = stripAnsi(render(FIXTURE_VTSE41_WARN));
    expect(out).toContain("区分");
    expect(out).toContain("地域名");
    expect(out).toContain("波高");
    // 到達予想列ヘッダはテーブルに出ない (詳細ブロックの行ラベルとしては出る)
    const tableHeaderLine = out.split("\n").find((l) => l.includes("区分") && l.includes("波高"));
    expect(tableHeaderLine).toBeDefined();
    expect(tableHeaderLine!).not.toContain("到達予想");
    // 隠れた列は [詳細] に逃げる
    expect(out).toContain("[詳細]");
    expect(out).toContain("到達予想:");
  });

  it("standard (幅 140) では forecast が 4 列になる", () => {
    setFrameWidth(140);
    const out = stripAnsi(render(FIXTURE_VTSE41_WARN));
    const tableHeaderLine = out.split("\n").find((l) => l.includes("区分") && l.includes("波高"));
    expect(tableHeaderLine).toBeDefined();
    expect(tableHeaderLine!).toContain("到達予想");
  });

  it("VTSE51 で満潮・到達予想テーブルが出る (acceptance 12)", () => {
    setFrameWidth(140);
    const out = stripAnsi(render(FIXTURE_VTSE51_INFO));
    expect(out).toContain("満潮・到達予想");
    expect(out).toContain("宮古");
    expect(out).toContain("満潮時刻");
    expect(out).toMatch(/\d{2}:\d{2}/); // 満潮/到達の時刻が整形表示されている
  });

  it("severity 件数サマリが末尾に出る", () => {
    setFrameWidth(140);
    const out = stripAnsi(render(FIXTURE_VTSE41_WARN));
    expect(out).toMatch(/大津波警報 \d+ 区/);
  });

  it("取消は取消レイアウト (バナーなし + [取消])", () => {
    setFrameWidth(140);
    const out = stripAnsi(render("38-39_03_01_210805_VTSE41.xml"));
    expect(out).toContain("[取消]");
    expect(out).not.toContain("満潮・到達予想");
  });

  it("4 severity 全部入り (VTSE51) で幅 60-200 sweep しても全行が width を超えない", () => {
    const info = parseTsunamiTelegram(createMockWsDataMessage(FIXTURE_VTSE51_INFO));
    expect(info).not.toBeNull();
    for (let w = 60; w <= 200; w++) {
      setFrameWidth(w);
      logSpy.mockClear();
      displayTsunamiInfo(info!);
      for (const call of logSpy.mock.calls) {
        const line = String(call[0] ?? "");
        expect(visualWidth(stripAnsi(line)), `width=${w} line=${stripAnsi(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });
});

describe("mergeRepeated 列 (Task 7: 区分/地域名の縦反復間引き)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  const render = (fixture: string): string => {
    const info = parseTsunamiTelegram(createMockWsDataMessage(fixture));
    expect(info).not.toBeNull();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      displayTsunamiInfo(info!);
      return stripAnsi(spy.mock.calls.map((args) => String(args[0] ?? "")).join("\n"));
    } finally {
      spy.mockRestore();
    }
  };

  it("VTSE41 standard: 同一区分の連続行は 2 行目以降が区分セル空白", () => {
    setFrameWidth(140);
    const out = render(FIXTURE_VTSE41_WARN);
    // バナー (tsunamiBannerLabel) も「津波予報」を含みうるため、テーブル行に限定して数える:
    // 列セパレータ " │ " と区分セル本文「津波予報（若干の」を両方含む行が 1 行だけ
    // (mergeRepeated で 2 行目以降は区分セル空白)
    const tableLines = out.split("\n").filter((l) => l.includes(" │ ") && l.includes("津波予報（若干の"));
    expect(tableLines.length).toBe(1);
    // 「区分: …」の [詳細] 反復が無い
    expect(out).not.toMatch(/区分: 津波/);
  });

  it("VTSE51 standard: 満潮テーブル先頭列が地域名で連続同地域が空白", () => {
    setFrameWidth(140);
    const out = render(FIXTURE_VTSE51_INFO);
    expect(out).not.toMatch(/地域名: /); // [詳細] 反復なし
  });
});

describe("buildTsunamiForecastRows / buildTsunamiTideStationRows", () => {
  it("forecast rows は kind rank 順にソートされる", () => {
    const rows = buildTsunamiForecastRows(([
      { areaName: "A", kind: "津波注意報", maxHeightDescription: "１ｍ", firstHeight: "" },
      { areaName: "B", kind: "大津波警報", maxHeightDescription: "巨大", firstHeight: "" },
      { areaName: "C", kind: "津波警報", maxHeightDescription: "高い", firstHeight: "" },
    ] satisfies LegacyTsunamiForecastItemInput[]).map(canonicalizeLegacyTsunamiForecastItem));
    expect(rows.map((r) => r.areaName)).toEqual(["B", "C", "A"]);
    expect(rows.map((r) => r.severity)).toEqual(["major", "warning", "advisory"]);
  });

  it("tide rows は severity 順の予報区 → 電文内観測点順で flatten される", () => {
    const rows = buildTsunamiTideStationRows(([
      {
        areaName: "後", kind: "津波警報", maxHeightDescription: "", firstHeight: "",
        stations: [{ name: "s3", highTideDateTime: "", arrivalTime: "" }],
      },
      {
        areaName: "先", kind: "大津波警報", maxHeightDescription: "", firstHeight: "",
        stations: [
          { name: "s1", highTideDateTime: "", arrivalTime: "" },
          { name: "s2", highTideDateTime: "", arrivalTime: "" },
        ],
      },
      { areaName: "無", kind: "津波注意報", maxHeightDescription: "", firstHeight: "" },
    ] satisfies LegacyTsunamiForecastItemInput[]).map(canonicalizeLegacyTsunamiForecastItem));
    expect(rows.map((r) => r.stationName)).toEqual(["s1", "s2", "s3"]);
    expect(rows[0].areaName).toBe("先");
  });
});

// 全 VTSE fixture (test/fixtures/ 実在の 13 件)
const ALL_VTSE_FIXTURES = [
  "32-39_11_02_250206_VTSE41.xml",
  "32-39_11_03_250206_VTSE51.xml",
  "32-39_11_09_250206_VTSE41.xml",
  "32-39_11_10_250206_VTSE51.xml",
  "32-39_11_11_250206_VTSE41.xml",
  "32-39_12_02_250206_VTSE41.xml",
  "32-39_12_05_250206_VTSE52.xml",
  "32-39_13_07_250206_VTSE41.xml",
  "38-39_02_02_250206_VTSE51.xml",
  "38-39_03_01_210805_VTSE41.xml",
  "38-39_03_03_210805_VTSE51.xml",
  "61_11_01_250206_VTSE52.xml",
  "61_11_02_250206_VTSE52.xml",
];

/** wrap・frame 罫線を除去して全文検索できる形に潰す (clip→detail 復元検査用) */
function flattenFrame(out: string): string {
  return stripAnsi(out).replace(/[║│╠╣╔╗╚╝═─\s]/g, "");
}

function captureDisplay(info: ParsedTsunamiInfo): string {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    displayTsunamiInfo(info);
    return spy.mock.calls.map((args) => String(args[0] ?? "")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

it.each([
  ["32-39_11_10_250206_VTSE51.xml", "３．２ｍ（重要・上昇中）"],
  ["61_11_02_250206_VTSE52.xml", "０．５ｍ（重要・上昇中）"],
])("実 fixture %s の実測値と Condition/TsunamiHeight@condition を最大波高欄へ併記する", (fixture, expected) => {
  setFrameWidth(140);
  const info = parseTsunamiTelegram(
    createMockWsDataMessage(fixture),
  )!;
  const plain = stripAnsi(captureDisplay(info));
  expect(plain).toContain(expected);
});

const LONG_AREA = "非常に長い架空の津波予報区名でセル幅を必ず超過させる検証用文字列";
const LONG_HEIGHT = "１０ｍを大きく超える巨大な津波が長時間継続するおそれ";
const syntheticLongInfo = (): ParsedTsunamiInfo => canonicalizeLegacyTsunamiInfo({
  meta: testTelegramMeta(false),
  type: "VTSE41",
  infoType: "発表",
  title: "津波警報・注意報・予報",
  reportDateTime: "2026-07-02T10:00:00+09:00",
  headline: "長文検証用",
  publishingOffice: "気象庁",
  warningComment: "",
  isTest: false,
  forecast: [
    { areaName: LONG_AREA, kind: "大津波警報", maxHeightDescription: LONG_HEIGHT, firstHeight: "ただちに津波来襲と予測" },
    { areaName: "短い区", kind: "津波注意報", maxHeightDescription: "１ｍ", firstHeight: "" },
  ],
});

describe("幅 60-200 sweep (acceptance 2)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  const parsedAll = ALL_VTSE_FIXTURES.map((fx) => {
    const info = parseTsunamiTelegram(createMockWsDataMessage(fx));
    expect(info, fx).not.toBeNull();
    return { fx, info: info! };
  });

  it("全 VTSE fixture + synthetic 長文で全行が width 以下", () => {
    const targets = [...parsedAll, { fx: "synthetic-long", info: syntheticLongInfo() }];
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

describe("hidden-only [詳細] (spec §2.4: 幅で隠れた列のみ回収、clip 全文回収は廃止)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  it("幅 60 (ultra-narrow): 隠し列 (到達予想) の値が [詳細] に現れる", () => {
    setFrameWidth(60);
    const out = captureDisplay(syntheticLongInfo());
    const plain = stripAnsi(out);
    expect(plain).toContain("[詳細]");
    // 予報区テーブルの隠し列「到達予想」(LONG 行の firstHeight) が復元される
    expect(flattenFrame(out)).toContain("ただちに津波来襲と予測".replace(/\s/g, ""));
  });

  it.each([140, 200])("幅 %i (standard/wide): 隠し列が無いので clip 起因の [詳細] 反復が出ない", (w) => {
    setFrameWidth(w);
    const out = captureDisplay(syntheticLongInfo());
    const plain = stripAnsi(out);
    // clip 全文回収の廃止: 「区分: / 地域名: / 波高:」型の反復は出ない
    expect(plain).not.toMatch(/区分: /);
    expect(plain).not.toMatch(/波高: /);
  });
});

describe("折りたたみ detail 復元 (Codex review Important #2)", () => {
  beforeEach(() => { chalk.level = 3; setFrameWidth(140); });
  afterEach(() => { setFrameWidth(60); setMaxObservations(null); });

  const manyStationInfo = (): ParsedTsunamiInfo => canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE51",
    infoType: "発表",
    title: "津波情報",
    reportDateTime: "2026-07-02T10:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    warningComment: "",
    isTest: false,
    forecast: [
      {
        areaName: "岩手県",
        kind: "津波注意報",
        maxHeightDescription: "１ｍ",
        firstHeight: "2026-07-02T10:30:00+09:00",
        stations: [
          { name: "宮古", highTideDateTime: "2026-07-02T19:00:00+09:00", arrivalTime: "2026-07-02T10:20:00+09:00" },
          { name: "大船渡", highTideDateTime: "2026-07-02T19:10:00+09:00", arrivalTime: "2026-07-02T10:25:00+09:00" },
          { name: "釜石", highTideDateTime: "2026-07-02T19:20:00+09:00", arrivalTime: "2026-07-02T10:28:00+09:00" },
        ],
      },
    ],
    observations: [
      { name: "神津島", sensor: "検潮所", arrivalTime: "2026-07-02T10:05:00+09:00", initial: "押し", maxHeightCondition: "０.２ｍ" , areaName: null, maxHeightValue: null },
      { name: "八丈島", sensor: "検潮所", arrivalTime: "2026-07-02T10:10:00+09:00", initial: "引き", maxHeightCondition: "０.３ｍ" , areaName: null, maxHeightValue: null },
      { name: "父島", sensor: "検潮所", arrivalTime: "2026-07-02T10:15:00+09:00", initial: "押し", maxHeightCondition: "０.４ｍ" , areaName: null, maxHeightValue: null },
    ],
    estimations: [
      { areaName: "小笠原諸島", maxHeightDescription: "０.５ｍ", firstHeight: "2026-07-02T10:35:00+09:00" },
      { areaName: "伊豆諸島", maxHeightDescription: "０.６ｍ", firstHeight: "2026-07-02T10:40:00+09:00" },
      { areaName: "東京都", maxHeightDescription: "０.７ｍ", firstHeight: "2026-07-02T10:45:00+09:00" },
    ],
  });

  it("tide-stations: 折りたたまれた観測点の到達予想・満潮時刻が detail に現れる", () => {
    setMaxObservations(1);
    const out = captureDisplay(manyStationInfo());
    const flat = flattenFrame(out);
    expect(flat).toContain("釜石");
    expect(flat).toContain("10:28:00");
  });

  it("observations: 折りたたまれた観測点の最大波高・到達時刻が detail に現れる", () => {
    setMaxObservations(1);
    const out = captureDisplay(manyStationInfo());
    const flat = flattenFrame(out);
    expect(flat).toContain("父島");
    expect(flat).toContain("０.４ｍ");
  });

  it("estimations: 折りたたまれた地域の波高・到達予想が detail に現れる", () => {
    setMaxObservations(1);
    const out = captureDisplay(manyStationInfo());
    const flat = flattenFrame(out);
    expect(flat).toContain("東京都");
    expect(flat).toContain("０.７ｍ");
  });
});

describe("severity 整合 (acceptance 9: 枠は tsunamiFrameLevel 由来)", () => {
  it("fixture 全件: frame と表示写像が粗く整合する", () => {
    for (const fx of ALL_VTSE_FIXTURES) {
      const info = parseTsunamiTelegram(createMockWsDataMessage(fx))!;
      const level = tsunamiFrameLevel(info);
      const rows = buildTsunamiForecastRows(info.forecast ?? []);
      if (level === "critical") {
        expect(rows.some((r) => r.severity === "major"), fx).toBe(true);
      } else if (level === "warning") {
        expect(rows.some((r) => r.severity === "warning"), fx).toBe(true);
      } else if (level === "normal") {
        expect(rows.filter((r) => r.known).some((r) => r.severity === "major" || r.severity === "warning"), fx).toBe(false);
      } else if (level === "cancel") {
        expect(info.infoType, fx).toBe("取消");
      }
    }
  });

  it("synthetic kind でも整合する (suffix 付き・解除・未知)", () => {
    const mk = (kind: string): ParsedTsunamiInfo => canonicalizeLegacyTsunamiInfo({
      ...syntheticLongInfo(),
      forecast: [{ areaName: "X", kind, maxHeightDescription: "", firstHeight: "" }],
    });
    // 大津波警報：発表 → frame critical / row major
    expect(tsunamiFrameLevel(mk("大津波警報：発表"))).toBe("critical");
    expect(buildTsunamiForecastRows(mk("大津波警報：発表").forecast!)[0].severity).toBe("major");
    // 津波警報解除 → frame warning / row warning (includes 判定が両層で一致)
    expect(tsunamiFrameLevel(mk("津波警報解除"))).toBe("warning");
    expect(buildTsunamiForecastRows(mk("津波警報解除").forecast!)[0].severity).toBe("warning");
    // 津波予報（若干の海面変動） → frame normal / row forecast
    expect(tsunamiFrameLevel(mk("津波予報（若干の海面変動）"))).toBe("normal");
    expect(buildTsunamiForecastRows(mk("津波予報（若干の海面変動）").forecast!)[0].severity).toBe("forecast");
    // 未知 kind → frame は normal のまま、行は warning 昇格 + known=false (raw 表示)
    expect(tsunamiFrameLevel(mk("謎の新種別"))).toBe("normal");
    const unknownRow = buildTsunamiForecastRows(mk("謎の新種別").forecast!)[0];
    expect(unknownRow.severity).toBe("warning");
    expect(unknownRow.known).toBe(false);
  });
});

describe("golden inventory (acceptance 7: 既存表示フィールドの欠落ゼロ)", () => {
  beforeEach(() => {
    chalk.level = 3;
    setMaxObservations(null);
  });
  afterEach(() => {
    setFrameWidth(60);
    setMaxObservations(null);
  });

  it.each(ALL_VTSE_FIXTURES)("%s: 全フィールドの内容が出力のどこかに現れる", (fx) => {
    setFrameWidth(160);
    const info = parseTsunamiTelegram(createMockWsDataMessage(fx))!;
    const out = captureDisplay(info);
    const flat = flattenFrame(out);
    const expectIn = (v: string | null | undefined): void => {
      if (!v) return;
      expect(flat, `${fx}: ${v.slice(0, 12)}`).toContain(v.replace(/[\s│]/g, "").slice(0, 24));
    };
    expectIn(info.headline);
    if (info.earthquake) {
      expectIn(info.earthquake.hypocenterName);
    }
    for (const f of info.forecast ?? []) {
      expectIn(f.areaName);
      expectIn(f.maxHeightDescription);
      for (const st of f.stations ?? []) {
        expectIn(st.name);
      }
    }
    for (const o of info.observations ?? []) {
      expectIn(o.name);
      expectIn(o.maxHeightCondition);
      expectIn(o.sensor);
    }
    for (const e of info.estimations ?? []) {
      expectIn(e.areaName);
      expectIn(e.maxHeightDescription);
    }
    expectIn(info.warningComment ? info.warningComment.split(/\r?\n/)[0] : null);
    expectIn(info.publishingOffice);
    expect(flat).toContain(info.type);
  });

  it("予報区の code は表示せず、従来どおり名称を表示する", () => {
    setFrameWidth(140);
    const info = canonicalizeLegacyTsunamiInfo({
      meta: testTelegramMeta(false),
      type: "VTSE41",
      infoType: "発表",
      title: "津波警報・注意報・予報",
      reportDateTime: "2026-07-02T10:00:00+09:00",
      headline: null,
      publishingOffice: "気象庁",
      warningComment: "",
      isTest: false,
      forecast: [{
        areaCode: "AREA-CODE-INTERNAL",
        kindCode: "KIND-CODE-INTERNAL",
        areaName: "表示地域",
        kind: "津波警報",
        maxHeightDescription: "３ｍ",
        firstHeight: "",
      }],
    });
    const plain = stripAnsi(captureDisplay(info));

    expect(plain).toContain("表示地域");
    expect(plain).toContain("津波警報");
    expect(plain).not.toContain("AREA-CODE-INTERNAL");
    expect(plain).not.toContain("KIND-CODE-INTERNAL");
  });

  it("isTest=true でテスト電文バッジが出る", () => {
    setFrameWidth(140);
    const out = captureDisplay({ ...syntheticLongInfo(), isTest: true });
    expect(stripAnsi(out)).toContain("テスト電文");
  });
});

describe("VTSE52 センサー列の standard 表示 (spec §8 R2-1)", () => {
  beforeEach(() => { chalk.level = 3; });
  afterEach(() => { setFrameWidth(60); });

  const obsInfo = (): ParsedTsunamiInfo => canonicalizeLegacyTsunamiInfo({
    meta: testTelegramMeta(false),
    type: "VTSE52",
    infoType: "発表",
    title: "沖合の津波観測に関する情報",
    reportDateTime: "2026-07-02T10:00:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    warningComment: "",
    isTest: false,
    observations: [
      { name: "神津島", sensor: "ＧＰＳ波浪計", arrivalTime: "2026-07-02T10:05:00+09:00", initial: "押し", maxHeightCondition: "０.２ｍ" , areaName: null, maxHeightValue: null },
      { name: "八丈島", sensor: "水圧計", arrivalTime: "2026-07-02T10:10:00+09:00", initial: "引き", maxHeightCondition: "０.３ｍ" , areaName: null, maxHeightValue: null },
    ],
  });

  it("幅 140 (standard): 沖合観測テーブルヘッダにセンサー列があり、[詳細] に「センサー: 」が出ない", () => {
    setFrameWidth(140);
    const out = stripAnsi(captureDisplay(obsInfo()));
    const header = out.split("\n").find((l) => l.includes("観測点") && l.includes("最大波高"));
    expect(header).toBeDefined();
    expect(header!).toContain("センサー");
    expect(out).toContain("ＧＰＳ波浪計"); // テーブル本体にセンサー値
    expect(out).not.toContain("センサー: "); // [詳細] 回収なし
  });

  it("幅 60 (ultra-narrow): センサー列は隠れ、[詳細] で回収される (hidden-only で正当)", () => {
    setFrameWidth(60);
    const out = stripAnsi(captureDisplay(obsInfo()));
    const header = out.split("\n").find((l) => l.includes("観測点") && l.includes("最大波高"));
    expect(header).toBeDefined();
    expect(header!).not.toContain("センサー");
    expect(out).toContain("センサー: ＧＰＳ波浪計");
  });
});
