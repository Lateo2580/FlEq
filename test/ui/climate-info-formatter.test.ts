import { describe, it, expect, afterEach } from "vitest";
import { displayClimateInfo } from "../../src/ui/climate-info-formatter";
import { parseClimateInfo } from "../../src/dmdata/climate-info-parser";
import {
  setDisplayMode,
  clearFrameWidth,
  setFrameWidth,
  visualWidth,
} from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPZI50_HOT_DRY,
  FIXTURE_VPCI50_KANTO_TSUYU,
  FIXTURE_VPCI50_TOHOKU_TSUYU,
  FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE,
} from "../helpers/mock-message";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
function capture(fn: () => void): string {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (m?: unknown) => logs.push(String(m ?? ""));
  try { fn(); } finally { console.log = orig; }
  return logs.join("\n");
}
afterEach(() => { setDisplayMode("normal"); clearFrameWidth(); });

describe("displayClimateInfo - controlTitle 出し分け + seasonEvents", () => {
  it("VPCI50 はヘッダに「地方天候情報」と出る (controlTitle ベース)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU))!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("地方天候情報");
    expect(out).not.toContain("全般天候情報");
  });

  it("VPCI50 の seasonEvents (梅雨明け日・平年・昨年) が表示される", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU))!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("梅雨明け");
    expect(out).toContain("７月１９日ごろ");
    expect(out).toContain("平年");
    expect(out).toContain("昨年");
  });

  it("NO_COLOR snapshot: VPZI50 既存表示 (controlTitle 化の退行ガード)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY))!;
    expect(stripAnsi(capture(() => displayClimateInfo(info)))).toMatchSnapshot();
  });

  it("NO_COLOR snapshot: VPCI50 地方天候情報", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU))!;
    expect(stripAnsi(capture(() => displayClimateInfo(info)))).toMatchSnapshot();
  });

  it.each([60, 80, 120])("VPCI50: 幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU))!;
    const out = capture(() => displayClimateInfo(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("VPCI50 取消: 取消文言が「地方天候情報は取り消されました」になる", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU))!;
    info.infoType = "取消";
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("地方天候情報は取り消されました");
  });
});

describe("displayClimateInfo - 観測点別気候値の列揃え (VPZI50)", () => {
  it("各行の「気温」「降水」「平年比」ラベルの開始桁が一致する", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY))!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    // 観測点行のみ抽出 (℃ と mm を両方含む行は station 行だけ)
    const stationLines = out
      .split("\n")
      .filter((l) => l.includes("℃") && l.includes("mm"));
    expect(stationLines.length).toBe(7);
    for (const label of ["気温", "降水", "平年比"]) {
      // indexOf は CJK の文字数ベースで視覚揃えを検証できないため、
      // ラベル前置部の visualWidth (= 視覚開始桁) で比較する
      const cols = stationLines.map((l) =>
        visualWidth(l.slice(0, l.indexOf(label))),
      );
      expect(new Set(cols).size).toBe(1);
      expect(cols[0]).toBeGreaterThan(0);
    }
  });

  it("数値は右揃えされ、列内最大小数桁に統一される (58 → 58.0mm)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(createMockWsDataMessage(FIXTURE_VPZI50_HOT_DRY))!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    // 広島の降水量は電文原文 "58.0" → parseFloat で 58 になるが、
    // 列内最大小数桁 (1 桁) に揃えて表示が復元される
    expect(out).toContain("58.0mm");
    // 東京 (9.2℃) は鹿児島 (11.4℃) と右端が揃うよう右揃えされる
    expect(out).toMatch(/気温 {2}9\.2℃/);
    expect(out).toMatch(/気温 11\.4℃/);
  });
});

describe("displayClimateInfo - VPCI50 観測点の値表示 + 値なし観測点", () => {
  it("30_02: 降水量と平年値が「降水 132.5mm (平年 153.0mm)」形式で表示される", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU),
    )!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("132.5mm");
    expect(out).toContain("(平年 153.0mm)");
    expect(out).toContain("283.0mm");
    expect(out).toContain("(平年 265.4mm)");
  });

  it("全フィールド null の観測点はスラッシュ区切りで連結される", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_KANTO_TSUYU),
    )!;
    // 値なし観測点 (「表題」型など) を synthetic に再現
    info.stations = ["水戸", "宇都宮", "前橋"].map((name) => ({
      stationName: name,
      stationCode: "00000",
      temperatureCelsius: null,
      temperatureAnomalyCelsius: null,
      temperatureNormalCelsius: null,
      precipitationMm: null,
      precipitationAnomalyPercent: null,
      precipitationNormalMm: null,
      periodLabel: null,
    }));
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("水戸 / 宇都宮 / 前橋");
    // 1 行 1 局の縦積みになっていない
    expect(out).not.toMatch(/^│ {3}水戸 *│$/m);
  });

  it("値あり観測点と値なし観測点が混在しても両方表示される", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU),
    )!;
    info.stations.push({
      stationName: "テスト局",
      stationCode: "99999",
      temperatureCelsius: null,
      temperatureAnomalyCelsius: null,
      temperatureNormalCelsius: null,
      precipitationMm: null,
      precipitationAnomalyPercent: null,
      precipitationNormalMm: null,
      periodLabel: null,
    });
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("132.5mm");
    expect(out).toContain("テスト局");
  });

  it("NO_COLOR snapshot: VPCI50 東北 30_02 (降水量 + 平年値)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU),
    )!;
    expect(stripAnsi(capture(() => displayClimateInfo(info)))).toMatchSnapshot();
  });

  it.each([60, 80, 120])(
    "VPCI50 30_02: 幅 %i で全描画行の visualWidth が width 以下",
    (w) => {
      setFrameWidth(w);
      const info = parseClimateInfo(
        createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_TSUYU),
      )!;
      const out = capture(() => displayClimateInfo(info));
      for (const line of out.split("\n")) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
      }
    },
  );
});

describe("displayClimateInfo - seasonEvents 発表なし + 地域表示 (30_03 東北)", () => {
  it("Date 無し seasonEvent は「（発表なし）」と出る (「日付不明」はミスリード)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE),
    )!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    expect(out).toContain("（発表なし）");
    expect(out).not.toContain("（日付不明）");
  });

  it("seasonEvents 2 件 (東北北部/南部) が「対象: …」形式で区別できる", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE),
    )!;
    const out = stripAnsi(capture(() => displayClimateInfo(info)));
    // 本文に「東北北部」自体は既出のため、地域表示行の形式まで含めて assert する
    expect(out).toContain("対象: 東北北部");
    expect(out).toContain("対象: 東北南部");
  });

  it("NO_COLOR snapshot: VPCI50 東北 梅雨明け非発表 (seasonEvents 地域表示つき)", () => {
    setFrameWidth(80);
    const info = parseClimateInfo(
      createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE),
    )!;
    expect(stripAnsi(capture(() => displayClimateInfo(info)))).toMatchSnapshot();
  });

  it.each([60, 80, 120])(
    "VPCI50 東北: 幅 %i で全描画行の visualWidth が width 以下",
    (w) => {
      setFrameWidth(w);
      const info = parseClimateInfo(
        createMockWsDataMessage(FIXTURE_VPCI50_TOHOKU_NO_TSUYUAKE),
      )!;
      const out = capture(() => displayClimateInfo(info));
      for (const line of out.split("\n")) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
      }
    },
  );
});
