import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import chalk from "chalk";
import { displayEewInfo, buildEewAccuracyLine, buildEewCardLine } from "../../src/ui/eew-formatter";
import { parseEewTelegram } from "../../src/dmdata/telegram-parser";
import { setFrameWidth, stripAnsi, setMaxObservations, setDisplayMode, visualWidth } from "../../src/ui/formatter";
import type { EewAccuracy } from "../../src/types";
import type { ParsedEewInfo } from "../../src/types";
import type { EewDiff } from "../../src/engine/eew/eew-tracker";
import {
  buildEewForecastRows,
  eewForecastColumns,
  formatEewIntensityRange,
  eewStatusBadges,
  applyEewDetailCap,
  EEW_DETAIL_HARD_CAP,
} from "../../src/ui/eew-formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE45_PLUM,
  FIXTURE_VXSE45_FINAL,
  FIXTURE_VXSE45_S26,
  FIXTURE_VXSE45_MIXED,
  FIXTURE_VXSE43_WARNING_S1,
  FIXTURE_VXSE45_CANCEL,
  FIXTURE_VXSE43_WARNING_S3,
} from "../helpers/mock-message";

function eewMsg(fixture: string, type: string) {
  return createMockWsDataMessage(fixture, {
    head: { type, author: "気象庁", time: new Date().toISOString(), test: false },
  });
}

describe("EEW 震源詳細ブロック (Phase 4b)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(140);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });
  const output = () => logSpy.mock.calls.map((a) => stripAnsi(String(a[0] ?? ""))).join("\n");

  it("検知時刻・内陸/海域・精度行が表示される (77_01_01)", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_S1, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    expect(output()).toContain("検知:");
    expect(output()).toContain("（海域）");
    expect(output()).toContain("精度:");
  });

  it("PLUM 時は検知時刻が発生 (仮定) より先に出る", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_PLUM, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    const lines = output().split("\n");
    const arrivalIdx = lines.findIndex((l) => l.includes("検知:"));
    const originIdx = lines.findIndex((l) => l.includes("発生:"));
    expect(arrivalIdx).toBeGreaterThan(-1);
    expect(originIdx).toBeGreaterThan(arrivalIdx);
    expect(lines[originIdx]).toContain("(仮定)");
  });

  it("accuracy undefined (77_01_30) では精度行を出さない", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_FINAL, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    expect(output()).not.toContain("精度:");
  });

  it("PLUM (77_02_01) の精度行に仮定震源要素相当のラベルが出る", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_PLUM, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    expect(output()).toContain("仮定震源要素");
  });
});

describe("buildEewAccuracyLine", () => {
  it("既知 rank をラベル化し M は観測点数を併記する", () => {
    const acc: EewAccuracy = { epicenterRank: 4, epicenterRank2: 4, depthRank: 4, magnitudeRank: 2, magnitudeCalcCount: 5 };
    const line = buildEewAccuracyLine(acc)!;
    expect(line).toContain("震央");
    expect(line).toContain("深さ");
    expect(line).toContain("(5点)");
  });
  it("未知 rank は「不明(N)」で fail-open する", () => {
    const acc: EewAccuracy = { epicenterRank: 99, epicenterRank2: null, depthRank: null, magnitudeRank: null, magnitudeCalcCount: null };
    expect(buildEewAccuracyLine(acc)).toContain("不明(99)");
  });
  it("全 rank null なら null (行ごと省略)", () => {
    const acc: EewAccuracy = { epicenterRank: null, epicenterRank2: null, depthRank: null, magnitudeRank: null, magnitudeCalcCount: null };
    expect(buildEewAccuracyLine(acc)).toBeNull();
  });
});

function syntheticEew(areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"]): ParsedEewInfo {
  return {
    type: "VXSE45",
    infoType: "発表",
    title: "緊急地震速報（地震動予報）",
    reportDateTime: new Date().toISOString(),
    headline: null,
    publishingOffice: "気象庁",
    serial: "1",
    eventId: "20260705000000",
    isTest: false,
    isWarning: false,
    isAssumedHypocenter: false,
    forecastIntensity: { areas },
  };
}

describe("EEW 予測震度テーブル (Phase 4b)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(140);
    setMaxObservations(null);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
    setMaxObservations(null);
  });
  const output = () => logSpy.mock.calls.map((a) => stripAnsi(String(a[0] ?? ""))).join("\n");

  it("To 基準降順 (一枚テーブル): 範囲行 (4〜5弱) が From 同値の 4 の行より上に出る", () => {
    displayEewInfo(syntheticEew([
      { name: "南部", intensity: "4" },
      { name: "北部", intensity: "4", intensityTo: "5-" },
    ]));
    const lines = output().split("\n");
    const rangeRow = lines.findIndex((l) => l.includes("4〜5弱") && l.includes("北部"));
    const plainRow = lines.findIndex((l) => l.includes("南部"));
    expect(rangeRow).toBeGreaterThan(-1);  // 範囲表記が行内にある
    expect(plainRow).toBeGreaterThan(rangeRow); // 悲観側 (To=5弱) の行が先 (To 基準降順は不変)
  });

  it("予測震度テーブルが一枚統合される (divider 1 本・ヘッダ 1 回・階級 divider なし)", () => {
    displayEewInfo(syntheticEew([
      { name: "南部", intensity: "5-" },
      { name: "北部", intensity: "4" },
    ]));
    const lines = output().split("\n");
    // labeled divider「予測震度」は 1 本 (カード行の「最大予測震度」は行頭 ╠ でないため数えない)
    const dividerLines = lines.filter((l) => /^[╠├]\s*予測震度\s/.test(l));
    expect(dividerLines.length).toBe(1);
    // テーブルヘッダ (震度 │ 地域) は 1 回のみ
    const headerLines = lines.filter((l) => l.includes("震度") && l.includes("│") && l.includes("地域"));
    expect(headerLines.length).toBe(1);
    // 階級 divider (╠ 震度5弱 ═╣ など) は存在しない
    expect(lines.some((l) => /^[╠├]\s*震度5弱/.test(l))).toBe(false);
  });

  it("状態列 badge 併記: 到達済+PLUM 同時付与 / HH:MM:SS 到達予測", () => {
    displayEewInfo(syntheticEew([
      { name: "併記地域", intensity: "5-", isPlum: true, hasArrived: true },
      { name: "予測地域", intensity: "4", arrivalTime: "2026-07-05T12:34:56+09:00" },
    ]));
    expect(output()).toContain("到達済 PLUM");
    expect(output()).toContain("12:34:56 到達予測");
    // 旧独立セクションは撤去 (acceptance 7)
    expect(output()).not.toContain("既に主要動到達と推測:");
  });

  it("長周期列: 階級1以上の行があるときだけ表示、ultra-narrow では省略 (詳細逃がし廃止, spec §8 R2-4)", () => {
    const areas: NonNullable<ParsedEewInfo["forecastIntensity"]>["areas"] = [
      { name: "階級あり", intensity: "5-", lgIntensity: "2" },
      { name: "階級なし", intensity: "4", lgIntensity: "0" },
    ];
    displayEewInfo(syntheticEew(areas));
    expect(output()).toContain("長周期"); // standard 幅では列あり
    logSpy.mockClear();
    setFrameWidth(60); // ultra-narrow
    displayEewInfo(syntheticEew(areas));
    const narrow = output();
    const headerLine = narrow.split("\n").find((l) => l.includes("震度") && l.includes("地域"))!;
    expect(headerLine).not.toContain("長周期");   // 列は消える
    expect(narrow).not.toContain("長周期: 階級2"); // [詳細] へも逃がさない (高さ削減優先)
    expect(narrow).not.toContain("[詳細]");        // 表示上限超過が無ければ [詳細] divider ごと出ない
  });

  it("全行 lg 0/null なら長周期列ごと省略", () => {
    displayEewInfo(syntheticEew([{ name: "地域A", intensity: "4", lgIntensity: "0" }]));
    const headerLine = output().split("\n").find((l) => l.includes("震度") && l.includes("地域"))!;
    expect(headerLine).not.toContain("長周期");
  });

  it("件数制限: getMaxObservations 超過分は明示打ち切り + 詳細逃がし (fail-closed)", () => {
    setMaxObservations(2);
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_S26, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    expect(output()).toMatch(/… 他 \d+ 地域/); // 全角三点リーダーに統一 (ASCII "..." は使わない)
    // hidden 行は 1 地域 1 entry で詳細に全列復元される
    expect(output()).toContain("(表示上限で省略)");
    expect(output()).toContain("状態:");
  });

  it("eewForecastColumns(ultra-narrow): minWidth 合計 + separator が幅 40 の内幅 36 に収まる", () => {
    const cols = eewForecastColumns("ultra-narrow", true);
    expect(cols.map((c) => c.header)).toEqual(["震度", "地域", "状態"]);
    const total = cols.reduce((a, c) => a + c.minWidth, 0) + (cols.length - 1) * 3;
    expect(total).toBeLessThanOrEqual(36); // renderResponsiveTable は minWidth を縮めない — silent 欠落防止
  });

  it("幅 40 でも 3 列が欠けない (行全体 clamp への fallback が起きない)", () => {
    setFrameWidth(40);
    displayEewInfo(syntheticEew([
      { name: "地域A", intensity: "4", arrivalTime: "2026-07-05T12:00:00+09:00" },
    ]));
    const headerLine = output().split("\n").find((l) => l.includes("震度") && l.includes("地域"))!;
    expect(headerLine).toContain("状態"); // 3 列目まで header が生存
  });

  it("buildEewForecastRows: sortKey は悲観側、同階級内は名前順で決定的", () => {
    const rows = buildEewForecastRows([
      { name: "い", intensity: "4" },
      { name: "あ", intensity: "4" },
      { name: "う", intensity: "4", intensityTo: "5-" },
    ]);
    expect(rows.map((r) => r.name)).toEqual(["う", "あ", "い"]);
    expect(rows[0].sortKey).toBe("5-");
  });

  it("formatEewIntensityRange: over は「◯程度以上」", () => {
    expect(formatEewIntensityRange({ intensity: "5-", intensityTo: "over" })).toBe("5弱程度以上");
    expect(formatEewIntensityRange({ intensity: "4", intensityTo: "5-" })).toBe("4〜5弱");
    expect(formatEewIntensityRange({ intensity: "6-" })).toBe("6弱");
  });

  it("applyEewDetailCap: hard cap 超過は fail-closed で omitted を返す", () => {
    const items = Array.from({ length: EEW_DETAIL_HARD_CAP + 3 }, (_, i) => ({ head: `h${i}`, body: ["    x"] }));
    const capped = applyEewDetailCap(items);
    expect(capped.items.length).toBe(EEW_DETAIL_HARD_CAP);
    expect(capped.omitted).toBe(3);
  });
});

describe("EEW 速報カード行 + compact 全廃 (Phase 4b)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(140);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setDisplayMode("full");
    setFrameWidth(60);
  });
  const output = () => logSpy.mock.calls.map((a) => stripAnsi(String(a[0] ?? ""))).join("\n");

  it("compact モードでもフル表示 (compact 分岐が消えている — acceptance 1)", () => {
    setDisplayMode("compact");
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_S1, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 1, colorIndex: 0 });
    expect(output()).toContain("EventID:");       // フル表示の証拠
    expect(output()).toContain("緊急地震速報");    // バナーも出る
  });

  it("buildEewCardLine: 幅不足時は 長周期 → 深さ → M の順に落ち、最大予測震度は落ちない", () => {
    const parts = [
      { text: "予報", priority: 0 },
      { text: "最大予測震度 5強", priority: 0 },
      { text: "長周期階級 2", priority: 3 },
      { text: "M7.2", priority: 1 },
      { text: "深さ 30km", priority: 2 },
    ];
    const wide = buildEewCardLine(parts, 200);
    expect(wide).toContain("長周期階級");
    const narrow = buildEewCardLine(parts, 40);
    expect(narrow).toContain("最大予測震度 5強");
    expect(narrow).not.toContain("長周期階級");
    expect(narrow).not.toContain("深さ");
  });

  it("カード行の最大予測震度は To 基準 (範囲行がある電文で悲観側が出る)", () => {
    displayEewInfo(syntheticEew([
      { name: "南部", intensity: "4" },
      { name: "北部", intensity: "4", intensityTo: "5-" },
    ]));
    const cardLine = output().split("\n").find((l) => l.includes("最大予測震度"))!;
    expect(cardLine).toContain("5弱");
  });

  it("diff 4 系統 (最大予測震度/M/深さ/震源地) が一度の更新表示で全て出る", () => {
    const info: ParsedEewInfo = {
      ...syntheticEew([{ name: "地域A", intensity: "5+" }]),
      earthquake: {
        hypocenterName: "石川県能登地方",
        latitude: "N37.5",
        longitude: "E137.3",
        magnitude: "6.5",
        depth: "10km",
        originTime: new Date().toISOString(),
      },
    };
    const diff: EewDiff = {
      previousMaxInt: "5-",
      previousMagnitude: "6.2",
      previousDepth: "20km",
      hypocenterChange: true,
    };
    displayEewInfo(info, { activeCount: 1, colorIndex: 0, diff });
    const text = output();

    // 最大予測震度: 旧 → 新
    const maxIntLine = text.split("\n").find((l) => l.includes("最大予測震度"))!;
    expect(maxIntLine).toContain("5弱");
    expect(maxIntLine).toContain("→");
    expect(maxIntLine).toContain("5強");

    // M: 旧 → 新
    const magLine = text.split("\n").find((l) => l.includes("規模:"))!;
    expect(magLine).toContain("M6.2");
    expect(magLine).toContain("→");
    expect(magLine).toContain("M6.5");

    // 深さ: 旧 → 新
    const depthLine = text.split("\n").find((l) => l.includes("深さ:"))!;
    expect(depthLine).toContain("20km");
    expect(depthLine).toContain("→");
    expect(depthLine).toContain("10km");

    // 震源地: (変更) 注記
    const hypoLine = text.split("\n").find((l) => l.includes("震源地:"))!;
    expect(hypoLine).toContain("石川県能登地方");
    expect(hypoLine).toContain("(変更)");
  });
});

describe("EEW 取消報 (Phase 4b: cancelText 優先 + fallback)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    chalk.level = 3;
    setFrameWidth(140);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    setFrameWidth(60);
  });
  const output = () => logSpy.mock.calls.map((a) => stripAnsi(String(a[0] ?? ""))).join("\n");

  it("VXSE45 型取消 (77_01_33): Body/Text 由来の取消文が表示される", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE45_CANCEL, "VXSE45"))!;
    displayEewInfo(info, { activeCount: 0, colorIndex: 0 });
    expect(output()).toContain("先ほどの、緊急地震速報（地震動予報）を取り消します。");
    expect(output()).not.toContain("この地震についての緊急地震速報は取り消されました。"); // 固定文は fallback 専用
  });

  it("VXSE43 型取消 (37_01_03): Headline/Text 両持ちでも Body/Text (「先ほどの、」prefix) が優先される", () => {
    const info = parseEewTelegram(eewMsg(FIXTURE_VXSE43_WARNING_S3, "VXSE43"))!;
    displayEewInfo(info, { activeCount: 0, colorIndex: 0 });
    expect(output()).toContain("先ほどの、緊急地震速報（警報）を取り消します。");
  });

  it("cancelText 無し (synthetic): 固定文 fallback", () => {
    const info: ParsedEewInfo = {
      type: "VXSE45", infoType: "取消", title: "緊急地震速報（地震動予報）",
      reportDateTime: new Date().toISOString(), headline: null, publishingOffice: "気象庁",
      serial: "5", eventId: "20260705000000", isTest: false, isWarning: false, isAssumedHypocenter: false,
    };
    displayEewInfo(info, { activeCount: 0, colorIndex: 0 });
    expect(output()).toContain("この地震についての緊急地震速報は取り消されました。");
    expect(output()).toContain("EventID: 20260705000000");
  });
});
