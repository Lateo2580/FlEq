import { testTelegramMeta } from "../helpers/telegram-meta";
import { describe, it, expect } from "vitest";
import {
  __vpws50_internals,
  formatDisplayToken,
  buildVpws50DisplayGroups,
  vpws50BannerSeverity,
  buildVpws50BannerText,
} from "../../src/ui/weather-formatter-vpws50";
import { drawSeverityBanner, getDisplaySeverityText } from "../../src/ui/weather-warning-level-theme";
import { stripAnsi, visualWidth } from "../../src/ui/formatter";
import { parseWeatherWarning } from "../../src/dmdata/weather-parser";
import {
  createMockWsDataMessage,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPWW55_OAME,
} from "../helpers/mock-message";
import type {
  ParsedWeatherWarning,
  Vpws50Diff,
  Vpws50CurrentAreasForDisplay,
  DisplaySeverity,
} from "../../src/types";
import {
  createRenderBuffer,
  setDisplayMode,
  getDisplayMode,
  setFrameWidth,
  clearFrameWidth,
} from "../../src/ui/formatter";
import { displayWeatherWarning } from "../../src/ui/weather-formatter";

describe("kindToShortLabel - Code map 主", () => {
  const { kindToShortLabel } = __vpws50_internals;

  // 実 fixture (15_18_01_250630_VPWS50.xml) で観測された Code 13 種を網羅
  it("レベル２大雨注意報 (Code 10) → 大雨", () => {
    expect(kindToShortLabel({ name: "レベル２大雨注意報", code: "10", severity: "advisory" })).toBe("大雨");
  });
  it("レベル４土砂災害危険警報 (Code 49) → 土砂災害", () => {
    expect(kindToShortLabel({ name: "レベル４土砂災害危険警報", code: "49", severity: "warning" })).toBe("土砂災害");
  });
  it("暴風警報 (Code 05) → 暴風", () => {
    expect(kindToShortLabel({ name: "暴風警報", code: "05", severity: "warning" })).toBe("暴風");
  });
  it("強風注意報 (Code 15) → 強風", () => {
    expect(kindToShortLabel({ name: "強風注意報", code: "15", severity: "advisory" })).toBe("強風");
  });
  it("波浪注意報 (Code 16) → 波浪", () => {
    expect(kindToShortLabel({ name: "波浪注意報", code: "16", severity: "advisory" })).toBe("波浪");
  });
  it("レベル２高潮注意報 (Code 19) → 高潮", () => {
    expect(kindToShortLabel({ name: "レベル２高潮注意報", code: "19", severity: "advisory" })).toBe("高潮");
  });
  it("濃霧注意報 (Code 20) → 濃霧", () => {
    expect(kindToShortLabel({ name: "濃霧注意報", code: "20", severity: "advisory" })).toBe("濃霧");
  });
  it("レベル２土砂災害注意報 (Code 29) → 土砂災害", () => {
    expect(kindToShortLabel({ name: "レベル２土砂災害注意報", code: "29", severity: "advisory" })).toBe("土砂災害");
  });
  it("雷注意報 (Code 14) → 雷", () => {
    expect(kindToShortLabel({ name: "雷注意報", code: "14", severity: "advisory" })).toBe("雷");
  });
});

// 公式 37 Code 全件 table-driven test
describe("kindToShortLabel - 公式 37 Code 全件 table-driven", () => {
  const { kindToShortLabel, KIND_CODE_LABELS } = __vpws50_internals;

  // 公式コード表 (R06) の期待値
  const OFFICIAL_EXPECTED: Array<[string, string, string]> = [
    ["00", "解除", "解除"],
    ["02", "暴風雪警報", "暴風雪"],
    ["03", "レベル3大雨警報", "大雨"],
    ["04", "洪水警報", "洪水"],
    ["05", "暴風警報", "暴風"],
    ["06", "大雪警報", "大雪"],
    ["07", "波浪警報", "波浪"],
    ["08", "レベル3高潮警報", "高潮"],
    ["09", "レベル3土砂災害警報", "土砂災害"],
    ["10", "レベル2大雨注意報", "大雨"],
    ["12", "大雪注意報", "大雪"],
    ["13", "風雪注意報", "風雪"],
    ["14", "雷注意報", "雷"],
    ["15", "強風注意報", "強風"],
    ["16", "波浪注意報", "波浪"],
    ["17", "融雪注意報", "融雪"],
    ["18", "洪水注意報", "洪水"],
    ["19", "レベル2高潮注意報", "高潮"],
    ["20", "濃霧注意報", "濃霧"],
    ["21", "乾燥注意報", "乾燥"],
    ["22", "なだれ注意報", "なだれ"],
    ["23", "低温注意報", "低温"],
    ["24", "霜注意報", "霜"],
    ["25", "着氷注意報", "着氷"],
    ["26", "着雪注意報", "着雪"],
    ["27", "（上記以外の）その他の注意報", "その他注意報"],
    ["29", "レベル2土砂災害注意報", "土砂災害"],
    ["32", "暴風雪特別警報", "暴風雪"],
    ["33", "レベル5大雨特別警報", "大雨"],
    ["35", "暴風特別警報", "暴風"],
    ["36", "大雪特別警報", "大雪"],
    ["37", "波浪特別警報", "波浪"],
    ["38", "レベル5高潮特別警報", "高潮"],
    ["39", "レベル5土砂災害特別警報", "土砂災害"],
    ["43", "レベル4大雨危険警報", "大雨"],
    ["48", "レベル4高潮危険警報", "高潮"],
    ["49", "レベル4土砂災害危険警報", "土砂災害"],
  ];

  it.each(OFFICIAL_EXPECTED)("Code %s (%s) → %s", (code, name, expected) => {
    expect(kindToShortLabel({ name, code, severity: "warning" })).toBe(expected);
  });

  it("KIND_CODE_LABELS の登録 Code 数は 37 ('00' 解除含む、表示対象 36)", () => {
    expect(Object.keys(KIND_CODE_LABELS).length).toBe(37);
  });
});

describe("kindToShortLabel - regex fallback", () => {
  const { kindToShortLabel } = __vpws50_internals;

  it("Code 99 (map 完全未登録) + 仮想 Kind 名 → 「レベルN」+ suffix を regex で除去", () => {
    expect(kindToShortLabel({ name: "レベル4洪水危険警報", code: "99", severity: "warning" })).toBe("洪水");
  });

  it("Code 28 (公式予約・未割当) + サフィックスなし → 元名そのまま", () => {
    expect(kindToShortLabel({ name: "謎情報", code: "28", severity: "advisory" })).toBe("謎情報");
  });

  it("Code 99 + 警報のみ suffix → suffix 除去", () => {
    expect(kindToShortLabel({ name: "新警報", code: "99", severity: "warning" })).toBe("新");
  });

  it("Code 99 + 全部 suffix で空になる → 元名にフォールバック", () => {
    expect(kindToShortLabel({ name: "警報", code: "99", severity: "warning" })).toBe("警報");
  });
});

describe("isColorAvailable (chalk.level > 0 主体)", () => {
  const { isColorAvailable } = __vpws50_internals;
  it("chalk.level > 0 のとき true", () => {
    const chalkRef = (require("chalk").default ?? require("chalk"));
    const original = chalkRef.level;
    chalkRef.level = 2;
    try {
      expect(isColorAvailable()).toBe(true);
    } finally {
      chalkRef.level = original;
    }
  });
  it("chalk.level === 0 のとき false", () => {
    const chalkRef = (require("chalk").default ?? require("chalk"));
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      expect(isColorAvailable()).toBe(false);
    } finally {
      chalkRef.level = original;
    }
  });
});

// ── Phase C Task 6: displaySeverity トークン (tier prefix + L 後置注釈) ──
describe("displaySeverity トークン (Phase C)", () => {
  it("officialL3 (Code 03): ☆大雨(L3) 形式", () => {
    const token = formatDisplayToken({ code: "03", name: "大雨警報" });
    expect(stripAnsi(token)).toBe("☆大雨(L3)");
  });
  it("officialL4 (Code 49): ★土砂災害(L4)、bg-chip", () => {
    const token = formatDisplayToken({ code: "49", name: "レベル４土砂災害危険警報" });
    expect(stripAnsi(token)).toBe("★土砂災害(L4)");
  });
  it("nonLevelWarning (Code 05): ◆暴風 (L 注釈なし)", () => {
    expect(stripAnsi(formatDisplayToken({ code: "05", name: "暴風警報" }))).toBe("◆暴風");
  });
  it("nonLevelAdvisory (Code 14): △雷", () => {
    expect(stripAnsi(formatDisplayToken({ code: "14", name: "雷注意報" }))).toBe("△雷");
  });
  it("nonLevelSpecial (Code 35): ◆◆暴風 (bg-chip 経路、L 注釈なし)", () => {
    expect(stripAnsi(formatDisplayToken({ code: "35", name: "暴風特別警報" }))).toBe("◆◆暴風");
  });
  it("未知 Code: ?謎 (name に警報/注意報を含めない — nameFallback を踏まないため)", () => {
    expect(stripAnsi(formatDisplayToken({ code: "99", name: "謎" }))).toBe("?謎");
  });
});

describe("buildVpws50Row", () => {
  const { buildVpws50Row } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("非 release のみ: severity 降順で tokens", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const row = buildVpws50Row({
        areaName: "神奈川県",
        areaCode: "140000",
        statuses: [],
        kinds: [
          { name: "雷注意報", code: "14", severity: "advisory" },
          { name: "レベル３大雨警報", code: "03", severity: "warning" },
        ],
      });
      expect(row).not.toBeNull();
      expect(row!.areaName).toBe("神奈川県");
      expect(row!.maxSeverity).toBe("warning");
      // Task 7: トークンは displaySeverity 形式 (tier prefix + L 後置注釈)
      expect(row!.tokens).toEqual(["☆大雨(L3)", "△雷"]);
    } finally {
      chalkRef.level = original;
    }
  });

  it("release のみ: null", () => {
    const row = buildVpws50Row({
      areaName: "静岡県",
      areaCode: "220000",
      statuses: [],
      kinds: [
        { name: "解除", code: "00", severity: "release" },
      ],
    });
    expect(row).toBeNull();
  });

  it("kinds 空: null", () => {
    const row = buildVpws50Row({
      areaName: "沖縄県",
      areaCode: "470000",
      statuses: [],
      kinds: [],
    });
    expect(row).toBeNull();
  });

  it("specialWarning が最高 severity", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const row = buildVpws50Row({
        areaName: "鹿児島県",
        areaCode: "460000",
        statuses: [],
        kinds: [
          { name: "雷注意報", code: "14", severity: "advisory" },
          { name: "レベル５大雨特別警報", code: "33", severity: "specialWarning" },
        ],
      });
      expect(row!.maxSeverity).toBe("specialWarning");
      // Task 7: Code 33 = officialL5 トークン
      expect(row!.tokens[0]).toBe("★★大雨(L5)");
    } finally {
      chalkRef.level = original;
    }
  });
});

describe("aggregateVpws50ByForecastZone", () => {
  const { aggregateVpws50ByForecastZone } = __vpws50_internals;

  it("実 fixture: rows + releasedItems を返す、rows は severity 降順", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
    const info = parseWeatherWarning(msg)!;
    const result = aggregateVpws50ByForecastZone(info);

    expect(result.rows.length).toBeGreaterThan(0);
    const rankMap: Record<string, number> = { specialWarning: 4, warning: 3, advisory: 2 };
    // maxSeverity は null を取りうる (対象 Kind なしの予報区)。null は最下位として比較する
    const rank = (row: { maxSeverity: string | null }): number =>
      row.maxSeverity == null ? 0 : rankMap[row.maxSeverity] ?? 0;
    for (let i = 0; i < result.rows.length - 1; i++) {
      expect(rank(result.rows[i]!)).toBeGreaterThanOrEqual(rank(result.rows[i + 1]!));
    }
  });

  it("解除は statuses[].lastKindName から抽出 (人工 fixture)", () => {
    const fakeInfo: ParsedWeatherWarning = {
      meta: testTelegramMeta(false),
      type: "VPWS50",
      infoType: "発表",
      title: "テスト",
      reportDateTime: "2025-01-01T00:00:00",
      headline: null,
      publishingOffice: "気象庁",
      editorialOffice: "気象庁",
      controlTitle: "テスト",
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [{
          areaName: "テスト県",
          areaCode: "999999",
          kinds: [{ name: "解除", code: "00", severity: "release" }],
          statuses: [
            { kindCode: "00", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" },
            { kindCode: "00", status: "解除", lastKindName: "雷注意報", lastKindCode: "14" },
          ],
        }],
      }],
      comments: [],
      maxSeverity: "release",
      maxDisplaySeverity: null, maxSoundLevel: null,
      warningAreaCount: 0,
      advisoryAreaCount: 0,
      isTest: false,
    };
    const result = aggregateVpws50ByForecastZone(fakeInfo);
    expect(result.rows).toEqual([]);
    expect(result.releasedItems).toEqual([
      { areaName: "テスト県", lastKinds: ["大雨警報", "雷注意報"] },
    ]);
  });

  it("府県予報区等レイヤー不在: 空結果", () => {
    const fakeInfo: ParsedWeatherWarning = {
      meta: testTelegramMeta(false),
      type: "VPWS50",
      infoType: "発表",
      title: "テスト",
      reportDateTime: "",
      headline: null,
      publishingOffice: "",
      editorialOffice: "",
      controlTitle: "",
      layers: [],
      comments: [],
      maxSeverity: "release",
      maxDisplaySeverity: null, maxSoundLevel: null,
      warningAreaCount: 0,
      advisoryAreaCount: 0,
      isTest: false,
    };
    const result = aggregateVpws50ByForecastZone(fakeInfo);
    expect(result.rows).toEqual([]);
    expect(result.releasedItems).toEqual([]);
  });
});

describe("displayVpws50List (RenderBuffer 検査)", () => {
  const { displayVpws50List } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("実 fixture: buf に主要要素が push される (NO_COLOR)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
      const info = parseWeatherWarning(msg)!;
      const buf = createRenderBuffer();
      // Task 6: diff=undefined → legacy fallback path で従来の list を出す
      displayVpws50List(info, undefined, "warning", 80, buf);
      // R2 修正: buf.lines は { text, kind } の配列なので .map(l => l.text)
      const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
      expect(joined).toContain("[気象警報・注意報（府県予報区等）]");
      // Task 7: 旧 [警]/[注] 略記 → displaySeverity トークン、区切りは " | " → " / "
      expect(joined).toMatch(/[☆◆★]/);  // 警報級トークン
      expect(joined).toContain("△");      // 注意報級トークン
      expect(joined).toContain(" / ");
      expect(joined).toContain("凡例:");
      // R3 後追加: dot leader (─) が予報区名とトークンの間に挿入される
      // (実 fixture には短い予報区名「宮城県」3 文字あり、これは leader が出る)
      expect(joined).toContain("─");
    } finally {
      chalkRef.level = original;
    }
  });

  it("rows + releasedItems が空: セクションヘッダ + 「現在発令中の警報・注意報はありません」+ 凡例", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
const fakeInfo: ParsedWeatherWarning = {
  meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [{ type: "気象警報・注意報（府県予報区等）", items: [] }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      const buf = createRenderBuffer();
      // Task 6: diff=undefined → legacy fallback path
      displayVpws50List(fakeInfo, undefined, "info", 80, buf);
      const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
      expect(joined).toContain("[気象警報・注意報（府県予報区等）]");
      expect(joined).toContain("現在発令中の警報・注意報はありません");
      expect(joined).toContain("凡例:");
    } finally {
      chalkRef.level = original;
    }
  });

  it("rows=0 + releasedItems>0: 発令中なし + 解除セクション両方", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
const fakeInfo: ParsedWeatherWarning = {
  meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "テスト県",
            areaCode: "999999",
            kinds: [{ name: "解除", code: "00", severity: "release" }],
            statuses: [
              { kindCode: "00", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" },
            ],
          }],
        }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      const buf = createRenderBuffer();
      // Task 6: diff=undefined → legacy fallback path
      displayVpws50List(fakeInfo, undefined, "normal", 80, buf);
      const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
      expect(joined).toContain("現在発令中の警報・注意報はありません");
      expect(joined).toContain("■ 今回解除された警報・注意報");
      expect(joined).toContain("大雨警報");
    } finally {
      chalkRef.level = original;
    }
  });
});

describe("hasForecastZoneLayer", () => {
  const { hasForecastZoneLayer } = __vpws50_internals;

  it("府県予報区等レイヤーあり: true", () => {
    const info: ParsedWeatherWarning = {
      meta: testTelegramMeta(false),
      type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
      headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
      layers: [{ type: "気象警報・注意報（府県予報区等）", items: [] }],
      comments: [], maxSeverity: "release",
      maxDisplaySeverity: null, maxSoundLevel: null,
      warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
    };
    expect(hasForecastZoneLayer(info)).toBe(true);
  });

  it("府県予報区等レイヤーなし (他レイヤーのみ): false", () => {
    const info: ParsedWeatherWarning = {
      meta: testTelegramMeta(false),
      type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
      headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
      layers: [{ type: "気象警報・注意報（市町村等）", items: [] }],
      comments: [], maxSeverity: "release",
      maxDisplaySeverity: null, maxSoundLevel: null,
      warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
    };
    expect(hasForecastZoneLayer(info)).toBe(false);
  });

  it("layers 空: false", () => {
    const info: ParsedWeatherWarning = {
      meta: testTelegramMeta(false),
      type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
      headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
      layers: [],
      comments: [], maxSeverity: "release",
      maxDisplaySeverity: null, maxSoundLevel: null,
      warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
    };
    expect(hasForecastZoneLayer(info)).toBe(false);
  });
});

describe("displayVpws50Compact", () => {
  const { displayVpws50Compact } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("実 fixture: 1 行で 予報区数集約、二重括弧バグなし", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
      const info = parseWeatherWarning(msg)!;
      displayVpws50Compact(info, "warning");
      const out = logs.join("");

      expect(out).toContain("VPWS50");
      expect(out).toContain("予報区");
      expect(out).toContain("[警告]");
      // R2 修正: SEVERITY_LABELS[level] が既に [警告] 形式なので二重括弧バグなし
      expect(out).not.toContain("[[");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("取消電文", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const fakeInfo: ParsedWeatherWarning = {
        meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "取消", title: "", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [], comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      displayVpws50Compact(fakeInfo, "cancel");
      expect(logs.join("")).toContain("取消");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("発令なし (rows + 注意報 0): 「発令なし」を出す", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const fakeInfo: ParsedWeatherWarning = {
        meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "発表", title: "", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [{ type: "気象警報・注意報（府県予報区等）", items: [] }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      displayVpws50Compact(fakeInfo, "info");
      expect(logs.join("")).toContain("発令なし");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

describe("displayWeatherWarning - VPWS50 統合", () => {
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("normal モード: VPWS50 fixture → リスト形式で出力", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
      const info = parseWeatherWarning(msg)!;
      displayWeatherWarning(info);
      const output = logs.join("\n");
      // 実 fixture は warning と advisory のみ、specialWarning なし
      expect(output).toContain("[気象警報・注意報（府県予報区等）]");
      // Task 7: 旧 [警]/[注] 略記 → displaySeverity トークン、区切りは " | " → " / "
      expect(output).toMatch(/[☆◆★]/);
      expect(output).toContain("△");
      expect(output).toContain(" / ");
      expect(output).toContain("凡例:");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("VPWW55 (regression): 既存パスが走る、府県予報区等セクション無し", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWW55_OAME);
      const info = parseWeatherWarning(msg)!;
      displayWeatherWarning(info);
      const output = logs.join("\n");
      // 既存パスの ■ 警報/注意報 グルーピングが残ること
      expect(output).toContain("■");
      // VPWS50 リストのセクションヘッダは出ないこと
      expect(output).not.toContain("[気象警報・注意報（府県予報区等）]");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  // R2 追加: 取消電文・狭幅・layer不在・release-only テスト

  it("VPWS50 取消: 「この情報は取り消されました」のみ、リスト本体なし", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const fakeInfo: ParsedWeatherWarning = {
        meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "取消", title: "テスト取消", reportDateTime: "2025-01-01T00:00:00",
        headline: null, publishingOffice: "気象庁", editorialOffice: "気象庁", controlTitle: "",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{ areaName: "テスト県", areaCode: "999999", kinds: [], statuses: [] }],
        }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      displayWeatherWarning(fakeInfo);
      const output = logs.join("\n");
      expect(output).toContain("この情報は取り消されました");
      expect(output).not.toContain("[気象警報・注意報（府県予報区等）]");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("VPWS50 狭幅 (60列): visualPadEnd で全角整合、wrap でレイアウト破綻なし", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    // R3 修正: setFrameWidth(80) で戻すのは元値前提を作る。clearFrameWidth() で自動復元
    setFrameWidth(60);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
      const info = parseWeatherWarning(msg)!;
      displayWeatherWarning(info);
      const output = logs.join("\n");
      // 主要要素はすべて出る
      expect(output).toContain("[気象警報・注意報（府県予報区等）]");
      expect(output).toContain(" / ");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
      clearFrameWidth();
    }
  });

  it("VPWS50 layer 不在: 既存パスに fallthrough", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      // VPWS50 だが府県予報区等レイヤーが無い人工 fixture (壊れた電文相当)
      const fakeInfo: ParsedWeatherWarning = {
        meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "発表", title: "テスト", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [{
          type: "気象警報・注意報（市町村等）",
          items: [],
        }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      displayWeatherWarning(fakeInfo);
      const output = logs.join("\n");
      // VPWS50 リストのセクションヘッダは出ないこと (既存パスにフォールスルー)
      expect(output).not.toContain("[気象警報・注意報（府県予報区等）]");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("狭幅で長い行が wrap しても displaySeverity トークンが分断されない", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    setFrameWidth(60);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const msg = createMockWsDataMessage(FIXTURE_VPWS50_AGGREGATE);
      const info = parseWeatherWarning(msg)!;
      displayWeatherWarning(info);
      const output = logs.join("\n");
      // Task 7: トークンは `☆大雨(L3)` 形式。wrap が token の途中で改行すると
      // 行頭が `(L3)` や `L3)` の断片で始まる — それが無いことを確認
      const lines = output.split("\n");
      for (const line of lines) {
        // フレームの罫線スペース等を除去
        const trimmed = line.replace(/^║?\s*/, "").trim();
        expect(trimmed).not.toMatch(/^\(L\d/);
        expect(trimmed).not.toMatch(/^L\d\)/);
      }
    } finally {
      console.log = origLog;
      chalkRef.level = original;
      clearFrameWidth();
    }
  });

  it("VPWS50 release-only (rows=0, releasedItems>0): 発令中なし + 解除セクション", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const fakeInfo: ParsedWeatherWarning = {
        meta: testTelegramMeta(false),
        type: "VPWS50", infoType: "発表", title: "テスト", reportDateTime: "",
        headline: null, publishingOffice: "", editorialOffice: "", controlTitle: "",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "テスト県", areaCode: "999999",
            kinds: [{ name: "解除", code: "00", severity: "release" }],
            statuses: [
              { kindCode: "00", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" },
            ],
          }],
        }],
        comments: [], maxSeverity: "release",
        maxDisplaySeverity: null, maxSoundLevel: null,
        warningAreaCount: 0, advisoryAreaCount: 0, isTest: false,
      };
      displayWeatherWarning(fakeInfo);
      const output = logs.join("\n");
      expect(output).toContain("[気象警報・注意報（府県予報区等）]");
      expect(output).toContain("現在発令中の警報・注意報はありません");
      expect(output).toContain("■ 今回解除された警報・注意報");
      expect(output).toContain("大雨警報");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

// ── Task 6: 6 状態分岐レンダラ ──

/** 6 状態テスト用の共通ファクトリ: ParsedWeatherWarning と diff を組み合わせる */
function makeFakeInfo(opts?: Partial<ParsedWeatherWarning>): ParsedWeatherWarning {
  const base: ParsedWeatherWarning = {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime: "2026-06-05T10:30:00+09:00",
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "VPWS50",
    layers: [{ type: "気象警報・注意報（府県予報区等）", items: [] }],
    comments: [],
    maxSeverity: "release",
    maxDisplaySeverity: null, maxSoundLevel: null,
    warningAreaCount: 0,
    advisoryAreaCount: 0,
    isTest: false,
  };
  return { ...base, ...opts };
}

/** baseline diff: 全フラグ false、配列空 */
function makeDiff(opts?: Partial<Vpws50Diff>): Vpws50Diff {
  return {
    isFirstReport: false,
    isUnchanged: false,
    isCancelRollback: false,
    shouldRecap: false,
    confidence: "confirmed",
    added: [],
    upgraded: [],
    downgraded: [],
    released: [],
    ...opts,
  };
}

describe("displayVpws50List 6 状態分岐 (新規)", () => {
  const { displayVpws50List } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  // ── (1) unsafe ──
  describe("unsafe (layer_missing)", () => {
    it("サブ行『解析不能 — state を更新せず維持』+ 理由表示 (NO_COLOR)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({ layers: [] });
        const diff = makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("解析不能 — state を更新せず維持");
        expect(joined).toContain("府県予報区レイヤーを抽出できませんでした");
      } finally {
        chalkRef.level = original;
      }
    });

    it("unsafeReason=abnormal_release_rate のメッセージ", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo();
        const diff = makeDiff({ confidence: "unsafe", unsafeReason: "abnormal_release_rate" });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("異常な解除率を検出しました");
      } finally {
        chalkRef.level = original;
      }
    });

    it("色付き環境でも subline 出力", () => {
      const original = chalkRef.level;
      chalkRef.level = 2;
      try {
        const info = makeFakeInfo();
        const diff = makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("解析不能");
      } finally {
        chalkRef.level = original;
      }
    });
  });

  // ── (2) cancelRollback ──
  describe("isCancelRollback", () => {
    it("サブ行『取消報 — 直前報を巻き戻し』+ currentAreasForDisplay 描画", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const display: Vpws50CurrentAreasForDisplay = {
          totalAreas: 2,
          specialAreas: 0,
          warningAreas: 1,
          advisoryAreas: 1,
          kinds: [
            {
              kindCode: "03",
              kindShortName: "大雨",
              kindName: "レベル３大雨警報",
              displaySeverity: "officialL3",
              officialAlertLevel: 3,
              areas: [{ areaName: "茨城県", areaCode: "080000" }],
            },
            {
              kindCode: "14",
              kindShortName: "雷",
              kindName: "雷注意報",
              displaySeverity: "nonLevelAdvisory",
              officialAlertLevel: null,
              areas: [{ areaName: "栃木県", areaCode: "090000" }],
            },
          ],
        };
        const info = makeFakeInfo({ infoType: "取消", layers: [] });
        const diff = makeDiff({ isCancelRollback: true, currentAreasForDisplay: display });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "cancel", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("取消報 — 直前報を巻き戻し");
        expect(joined).toContain("直前報を取り消しました");
        expect(joined).toContain("■ 現況サマリ");
        // 警報セクションは予報区名そのまま、注意報セクションは cluster 集約
        expect(joined).toContain("茨城県");
        // 栃木県(09) は cluster 集約で「関東甲信」になる
        expect(joined).toContain("関東甲信");
      } finally {
        chalkRef.level = original;
      }
    });

    it("currentAreasForDisplay 無しならフォールバックメッセージ", () => {
      const info = makeFakeInfo({ infoType: "取消", layers: [] });
      const diff = makeDiff({ isCancelRollback: true });
      const buf = createRenderBuffer();
      displayVpws50List(info, diff, "cancel", 80, buf);
      const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
      expect(joined).toContain("取消報 — 直前報を巻き戻し");
      expect(joined).toContain("state を保持していません");
    });
  });

  // ── (3) unchanged-compact (defensive: 早期 return で本来ここまで来ない) ──
  describe("isUnchanged + !shouldRecap (defensive)", () => {
    it("displayVpws50Unchanged を間接呼び出し (console.log)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: unknown) => logs.push(String(msg));
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "茨城県",
              areaCode: "080000",
              kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({ isUnchanged: true, shouldRecap: false });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "info", 80, buf);
        const joined = logs.join("\n");
        expect(joined).toContain("最後に受信した VPWS50 から変化なし");
      } finally {
        console.log = origLog;
        chalkRef.level = original;
      }
    });
  });

  // ── (4) unchanged + recap ──
  describe("isUnchanged + shouldRecap (60 分再掲)", () => {
    it("サブ行『定期再掲 (60 分間隔) — 警報級発令中』+ 現況サマリ", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "茨城県",
              areaCode: "080000",
              kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({ isUnchanged: true, shouldRecap: true });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("定期再掲 (60 分間隔) — 警報級発令中");
        expect(joined).toContain("■ 現況サマリ");
        expect(joined).toContain("1予報区");
        expect(joined).toContain("茨城県");
        expect(joined).toContain("凡例:");
        // Phase C Task 6 レビュー反映: 新凡例文言のピン留め
        expect(joined).toContain("★★L5");
        expect(joined).toContain("L表記");
      } finally {
        chalkRef.level = original;
      }
    });
  });

  // ── (5) firstReport ──
  describe("isFirstReport (初回起動)", () => {
    it("サブ行『起動時現況』+ 現況サマリ + 凡例", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "鹿児島県",
              areaCode: "460000",
              kinds: [
                { name: "レベル５大雨特別警報", code: "33", severity: "specialWarning" },
              ],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({ isFirstReport: true });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "critical", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("起動時現況");
        expect(joined).toContain("■ 現況サマリ");
        expect(joined).toContain("特1");
        // Task 7: 旧 `─ 特別警報` 見出し → displaySeverity divider chip (Code 33 = officialL5)
        // 2026-06-12 目視ゲート決定: divider 文言は VPWW 形式に三電文統一
        expect(joined).toContain("★★ 特別警報 (L5)");
        expect(joined).toContain("凡例:");
      } finally {
        chalkRef.level = original;
      }
    });
  });

  // ── (6) hasChanges (差分セクション/解除別枠) ──
  describe("差分あり (added/upgraded/downgraded/released)", () => {
    it("added: ▲ 新規発令 + 区域名 + token", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "茨城県",
              areaCode: "080000",
              kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({
          added: [{
            areaName: "茨城県",
            areaCode: "080000",
            changes: [{
              phenomenonKey: "大雨",
              kindShortName: "大雨",
              prevKindCode: null,
              newKindCode: "03",
              prevSeverity: null,
              newSeverity: "warning",
              prevDisplaySeverity: null,
              newDisplaySeverity: "officialL3",
              prevOfficialAlertLevel: null,
              newOfficialAlertLevel: 3,
            }],
          }],
        });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("更新報");
        expect(joined).toContain("★ 今回の変化");
        expect(joined).toContain("▲ 新規発令");
        expect(joined).toContain("茨城県");
        // Phase C Task 6: 差分セクションは tier prefix + L 後置注釈
        expect(joined).toContain("☆大雨(L3)");
        expect(joined).toContain("■ 現況サマリ");
      } finally {
        chalkRef.level = original;
      }
    });

    it("upgraded: ▲ 昇格 + prev → new", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "鹿児島県",
              areaCode: "460000",
              kinds: [{ name: "レベル５大雨特別警報", code: "33", severity: "specialWarning" }],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({
          upgraded: [{
            areaName: "鹿児島県",
            areaCode: "460000",
            changes: [{
              phenomenonKey: "大雨",
              kindShortName: "大雨",
              prevKindCode: "03",
              newKindCode: "33",
              prevSeverity: "warning",
              newSeverity: "specialWarning",
              prevDisplaySeverity: "officialL3",
              newDisplaySeverity: "officialL5",
              prevOfficialAlertLevel: 3,
              newOfficialAlertLevel: 5,
            }],
          }],
        });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "critical", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("▲ 昇格");
        // Phase C Task 6: prev/new とも tier prefix + L 後置注釈
        expect(joined).toContain("☆大雨(L3)");
        expect(joined).toContain("→");
        expect(joined).toContain("★★大雨(L5)");
      } finally {
        chalkRef.level = original;
      }
    });

    it("downgraded: ▽ 降格 + prev → new", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "栃木県",
              areaCode: "090000",
              kinds: [{ name: "レベル２大雨注意報", code: "10", severity: "advisory" }],
              statuses: [],
            }],
          }],
        });
        const diff = makeDiff({
          downgraded: [{
            areaName: "栃木県",
            areaCode: "090000",
            changes: [{
              phenomenonKey: "大雨",
              kindShortName: "大雨",
              prevKindCode: "03",
              newKindCode: "10",
              prevSeverity: "warning",
              newSeverity: "advisory",
              prevDisplaySeverity: "officialL3",
              newDisplaySeverity: "officialL2",
              prevOfficialAlertLevel: 3,
              newOfficialAlertLevel: 2,
            }],
          }],
        });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("▽ 降格");
        // Phase C Task 6: prev/new とも tier prefix + L 後置注釈
        expect(joined).toContain("☆大雨(L3)");
        expect(joined).toContain("△大雨(L2)");
      } finally {
        chalkRef.level = original;
      }
    });

    it("released: ▼ 今回解除 が独立位置 (frameDivider 後)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [],
          }],
        });
        const diff = makeDiff({
          released: [{
            areaName: "茨城県",
            areaCode: "080000",
            changes: [{
              phenomenonKey: "大雨",
              kindShortName: "大雨",
              prevKindCode: "03",
              newKindCode: null,
              prevSeverity: "warning",
              newSeverity: null,
              prevDisplaySeverity: "officialL3",
              newDisplaySeverity: null,
              prevOfficialAlertLevel: 3,
              newOfficialAlertLevel: null,
            }],
          }],
        });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "info", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("▼ 今回解除");
        expect(joined).toContain("茨城県");
        // Phase C Task 6: released トークンも tier prefix + L 後置注釈 (グレー)
        expect(joined).toContain("☆大雨(L3)");
      } finally {
        chalkRef.level = original;
      }
    });

    it("複合: added + released で changeCount/releasedCount が正しい", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo();
        const diff = makeDiff({
          added: [
            {
              areaName: "A県", areaCode: "010000",
              changes: [{
                phenomenonKey: "大雨", kindShortName: "大雨",
                prevKindCode: null, newKindCode: "03",
                prevSeverity: null, newSeverity: "warning",
                prevDisplaySeverity: null, newDisplaySeverity: "officialL3",
                prevOfficialAlertLevel: null, newOfficialAlertLevel: 3,
              }],
            },
            {
              areaName: "B県", areaCode: "020000",
              changes: [{
                phenomenonKey: "大雨", kindShortName: "大雨",
                prevKindCode: null, newKindCode: "03",
                prevSeverity: null, newSeverity: "warning",
                prevDisplaySeverity: null, newDisplaySeverity: "officialL3",
                prevOfficialAlertLevel: null, newOfficialAlertLevel: 3,
              }],
            },
          ],
          released: [{
            areaName: "C県", areaCode: "030000",
            changes: [{
              phenomenonKey: "雷", kindShortName: "雷",
              prevKindCode: "14", newKindCode: null,
              prevSeverity: "advisory", newSeverity: null,
              prevDisplaySeverity: "nonLevelAdvisory", newDisplaySeverity: null,
              prevOfficialAlertLevel: null, newOfficialAlertLevel: null,
            }],
          }],
        });
        const buf = createRenderBuffer();
        displayVpws50List(info, diff, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("3予報区");      // changeCount(2) + releasedCount(1)
        expect(joined).toContain("変化 2");
        expect(joined).toContain("解除 1");
      } finally {
        chalkRef.level = original;
      }
    });
  });
});

// ── 現況サマリ (displaySeverity セクション) ──
describe("現況サマリ (renderCurrentSummary)", () => {
  const { renderCurrentSummary } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("特・警・注 相当のセクションが全て描かれる + 注意報級は cluster 集約", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [
            {
              areaName: "鹿児島県", areaCode: "460000",
              kinds: [{ name: "レベル５大雨特別警報", code: "33", severity: "specialWarning" }],
              statuses: [],
            },
            {
              areaName: "茨城県", areaCode: "080000",
              kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
              statuses: [],
            },
            {
              areaName: "栃木県", areaCode: "090000",
              kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
              statuses: [],
            },
          ],
        }],
      });
      const buf = createRenderBuffer();
      renderCurrentSummary(info, "warning", 80, buf);
      const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
      expect(joined).toContain("■ 現況サマリ");
      expect(joined).toContain("3予報区");
      // Task 7: 旧 `─ 特別警報` / `─ 警報` / `─ 注意報` 見出し → displaySeverity divider chip
      // (文言は 2026-06-12 目視ゲート決定で VPWW 形式に統一)
      expect(joined).toContain("★★ 特別警報 (L5)");  // Code 33 (officialL5)
      expect(joined).toContain("☆ 警報 (L3)");       // Code 03 (officialL3)
      expect(joined).toContain("△ 注意報");           // Code 14 (nonLevelAdvisory)
      // 警報級行: 予報区名そのまま
      expect(joined).toContain("茨城県");
      // 注意報級行: cluster 集約 (栃木県 → 関東甲信)
      expect(joined).toContain("関東甲信");
    } finally {
      chalkRef.level = original;
    }
  });
});

// ── Phase C Task 7: displaySeverity セクション現況サマリ ──
describe("displaySeverity セクション現況サマリ (Phase C Task 7)", () => {
  const { renderCurrentSummary, renderCurrentSummaryFromDisplay } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  /** Code 49 (officialL4) + 05 (nonLevelWarning) + 14 (nonLevelAdvisory) を含む info */
  function makeSectionInfo(): ParsedWeatherWarning {
    return makeFakeInfo({
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [
          {
            areaName: "鹿児島県", areaCode: "460000",
            kinds: [
              { name: "レベル４土砂災害危険警報", code: "49", severity: "warning" },
              { name: "暴風警報", code: "05", severity: "warning" },
            ],
            statuses: [],
          },
          {
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "暴風警報", code: "05", severity: "warning" }],
            statuses: [],
          },
          {
            areaName: "石狩地方", areaCode: "011000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          },
          {
            areaName: "青森県", areaCode: "020000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          },
        ],
      }],
    });
  }

  /** NO_COLOR で renderCurrentSummary を描画して stripAnsi 済みテキストを返す */
  function renderNoColor(info: ParsedWeatherWarning): string {
    const buf = createRenderBuffer();
    renderCurrentSummary(info, "critical", 80, buf);
    return stripAnsi(buf.lines.map((l: { text: string }) => l.text).join("\n"));
  }

  it("RANK 降順の divider chip セクションで描画される", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const joined = renderNoColor(makeSectionInfo());
      const idxL4 = joined.indexOf("★ 危険警報 (L4)");
      const idxWarn = joined.indexOf("◆ 警報");
      const idxAdv = joined.indexOf("△ 注意報");
      expect(idxL4).toBeGreaterThanOrEqual(0);
      expect(idxL4).toBeLessThan(idxWarn);
      expect(idxWarn).toBeLessThan(idxAdv);
      // 旧 3 バケツ見出しは出ない
      expect(joined).not.toContain("─ 特別警報");
      expect(joined).not.toContain("─ 注意報  (詳細");
    } finally {
      chalkRef.level = original;
    }
  });

  it("注意報級セクションは地方クラスタ集約を維持する (北海道 / 東北 + N予報区)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const joined = renderNoColor(makeSectionInfo());
      expect(joined).toContain("△雷 / 北海道 / 東北 / 2予報区");
    } finally {
      chalkRef.level = original;
    }
  });

  it("警報級以上の行は `{token} / {area1} / {area2}` 構造 (折返し invariant)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const joined = renderNoColor(makeSectionInfo());
      expect(joined).toContain("★土砂災害(L4) / 鹿児島県");
      expect(joined).toContain("◆暴風 / 鹿児島県 / 茨城県");
    } finally {
      chalkRef.level = original;
    }
  });

  it("サマリ行は 3 段階カウントを維持し、詳細案内をサマリ行末尾に残す", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const joined = renderNoColor(makeSectionInfo());
      expect(joined).toContain("■ 現況サマリ  4予報区  特0 / 警2 / 注2");
      expect(joined).toContain("(詳細: `detail vpws50`)");
    } finally {
      chalkRef.level = original;
    }
  });

  it("unknown セクションは ◆ 警報 直後に置かれる (見落とし防止)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [
              { name: "暴風警報", code: "05", severity: "warning" },
              { name: "謎", code: "99", severity: "warning" },
              { name: "雷注意報", code: "14", severity: "advisory" },
            ],
            statuses: [],
          }],
        }],
      });
      const joined = renderNoColor(info);
      const idxWarn = joined.indexOf("◆ 警報");
      const idxUnknown = joined.indexOf("? 未知");
      const idxAdv = joined.indexOf("△ 注意報");
      expect(idxWarn).toBeGreaterThanOrEqual(0);
      expect(idxWarn).toBeLessThan(idxUnknown);
      expect(idxUnknown).toBeLessThan(idxAdv);
    } finally {
      chalkRef.level = original;
    }
  });

  it("unknown のみ存在 (nonLevelWarning 不在): 末尾 fallback で unknown セクションが出る", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      // Code 99 + name「謎」(警報/注意報を含まない名前 → nameFallback を踏まず unknown 解決)
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "謎", code: "99", severity: "warning" }],
            statuses: [],
          }],
        }],
      });
      const joined = renderNoColor(info);
      // nonLevelWarning 直後挿入パスを通らず、renderSummarySections 末尾 fallback で divider が出る
      expect(joined).toContain("? 未知");
      expect(joined).toContain("?謎");
      expect(joined).not.toContain("◆ 警報");
    } finally {
      chalkRef.level = original;
    }
  });

  it("色付き環境: セクション行頭の色 token は折返しで分断されない (ANSI が行内に閉じる)", () => {
    const original = chalkRef.level;
    chalkRef.level = 2;
    try {
      const buf = createRenderBuffer();
      renderCurrentSummary(makeSectionInfo(), "critical", 80, buf);
      const lines = buf.lines.map((l: { text: string }) => l.text);
      expect(lines.join("\n")).toMatch(/\x1b\[/);
      for (const line of lines) {
        const plain = stripAnsi(line);
        // 折返し後の継続行が token の途中 (L4) 等) から始まらない
        expect(plain).not.toMatch(/^\s*\(L\d/);
        expect(plain).not.toMatch(/^\s*L\d\)/);
      }
    } finally {
      chalkRef.level = original;
    }
  });

  it("display 経由 (renderCurrentSummaryFromDisplay) も同じセクション構造で描画される", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const display: Vpws50CurrentAreasForDisplay = {
        totalAreas: 2,
        specialAreas: 0,
        warningAreas: 1,
        advisoryAreas: 1,
        kinds: [
          {
            kindCode: "03",
            kindShortName: "大雨",
            kindName: "レベル３大雨警報",
            displaySeverity: "officialL3",
            officialAlertLevel: 3,
            areas: [{ areaName: "茨城県", areaCode: "080000" }],
          },
          {
            kindCode: "14",
            kindShortName: "雷",
            kindName: "雷注意報",
            displaySeverity: "nonLevelAdvisory",
            officialAlertLevel: null,
            areas: [{ areaName: "栃木県", areaCode: "090000" }],
          },
        ],
      };
      const buf = createRenderBuffer();
      renderCurrentSummaryFromDisplay(display, "warning", 80, buf);
      const joined = stripAnsi(buf.lines.map((l: { text: string }) => l.text).join("\n"));
      expect(joined).toContain("■ 現況サマリ  2予報区  特0 / 警1 / 注1");
      const idxL3 = joined.indexOf("☆ 警報 (L3)");
      const idxAdv = joined.indexOf("△ 注意報");
      expect(idxL3).toBeGreaterThanOrEqual(0);
      expect(idxL3).toBeLessThan(idxAdv);
      expect(joined).toContain("☆大雨(L3) / 茨城県");
      // nonLevelAdvisory は cluster 集約 (栃木県 → 関東甲信)
      expect(joined).toContain("△雷 / 関東甲信 / 1予報区");
    } finally {
      chalkRef.level = original;
    }
  });
});

// ── Phase C Task 7: buildVpws50DisplayGroups (Task 8 バナー本文と共有) ──
describe("buildVpws50DisplayGroups", () => {
  it("kindCode 単位グループ + RANK 降順 + release 除外 + areaCode 重複排除", () => {
    const info = makeFakeInfo({
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [
          {
            areaName: "鹿児島県", areaCode: "460000",
            kinds: [
              { name: "暴風警報", code: "05", severity: "warning" },
              { name: "レベル４土砂災害危険警報", code: "49", severity: "warning" },
            ],
            statuses: [],
          },
          {
            areaName: "茨城県", areaCode: "080000",
            kinds: [
              { name: "暴風警報", code: "05", severity: "warning" },
              // 同一 areaCode + 同一 kindCode の重複 → areas は 1 件のまま
              { name: "暴風警報", code: "05", severity: "warning" },
              { name: "解除", code: "00", severity: "release" },
            ],
            statuses: [],
          },
          {
            areaName: "青森県", areaCode: "020000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          },
        ],
      }],
    });
    const groups = buildVpws50DisplayGroups(info);
    // RANK 降順: officialL4 (49) → nonLevelWarning (05) → nonLevelAdvisory (14)。release (00) は除外
    expect(groups.map((g) => g.kindCode)).toEqual(["49", "05", "14"]);
    expect(groups[0].displaySeverity).toBe("officialL4");
    expect(groups[0].officialAlertLevel).toBe(4);
    expect(groups[0].kindShortName).toBe("土砂災害");
    const storm = groups[1];
    expect(storm.displaySeverity).toBe("nonLevelWarning");
    expect(storm.areas).toEqual([
      { areaName: "鹿児島県", areaCode: "460000" },
      { areaName: "茨城県", areaCode: "080000" },
    ]);
  });

  it("府県予報区等レイヤー不在: 空配列", () => {
    expect(buildVpws50DisplayGroups(makeFakeInfo({ layers: [] }))).toEqual([]);
  });
});

// ── displayVpws50Unchanged (compact 1 行) ──
describe("displayVpws50Unchanged", () => {
  const { displayVpws50Unchanged } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("「最後に受信した VPWS50 から変化なし」を console.log で 1 行出力", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({
        reportDateTime: "2026-06-05T10:30:00+09:00",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [
            {
              areaName: "茨城県", areaCode: "080000",
              kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
              statuses: [],
            },
            {
              areaName: "栃木県", areaCode: "090000",
              kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
              statuses: [],
            },
          ],
        }],
      });
      displayVpws50Unchanged(info);
      const out = logs.join("\n");
      expect(out).toContain("気象警報・注意報（全国集約）");
      expect(out).toContain("2予報区");
      expect(out).toContain("特0 / 警1 / 注1");
      expect(out).toContain("最後に受信した VPWS50 から変化なし");
      expect(out).toContain("10:30:00");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("府県予報区等レイヤー不在: 何も出さない (防御)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({ layers: [] });
      displayVpws50Unchanged(info);
      expect(logs.length).toBe(0);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

// ── displayVpws50FromState (REPL detail 用) ──
describe("displayVpws50FromState (REPL detail)", () => {
  const { displayVpws50FromState } = __vpws50_internals;
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("フレーム + 現況サマリ + ヘッダーを出力", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const display: Vpws50CurrentAreasForDisplay = {
        totalAreas: 1,
        specialAreas: 0,
        warningAreas: 1,
        advisoryAreas: 0,
        kinds: [{
          kindCode: "03",
          kindShortName: "大雨",
          kindName: "レベル３大雨警報",
          displaySeverity: "officialL3",
          officialAlertLevel: 3,
          areas: [{ areaName: "茨城県", areaCode: "080000" }],
        }],
      };
      displayVpws50FromState(display);
      const out = logs.join("\n");
      expect(out).toContain("気象警報・注意報（全国集約）");
      expect(out).toContain("最新受信内容 (REPL detail)");
      expect(out).toContain("■ 現況サマリ");
      expect(out).toContain("1予報区");
      expect(out).toContain("茨城県");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("色付き環境でも安全に出力 (ANSI 含む)", () => {
    const original = chalkRef.level;
    chalkRef.level = 2;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const display: Vpws50CurrentAreasForDisplay = {
        totalAreas: 0,
        specialAreas: 0,
        warningAreas: 0,
        advisoryAreas: 0,
        kinds: [],
      };
      displayVpws50FromState(display);
      const out = logs.join("\n");
      expect(out).toContain("気象警報・注意報");
      // ANSI escapes are present
      expect(out).toMatch(/\x1b\[/);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

// ── displayWeatherWarning — 6 状態統合 (フレーム外まで含めて) ──
describe("displayWeatherWarning + diff の統合 (VPWS50)", () => {
  const chalkRef = (require("chalk").default ?? require("chalk"));

  it("unchanged + !shouldRecap: フレームなし、console.log 1 行のみ", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isUnchanged: true, shouldRecap: false });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("最後に受信した VPWS50 から変化なし");
      // フレーム罫線が出ない (║ や ╔ など)
      expect(out).not.toMatch(/[║╔╚]/);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("同 rank の表示名だけが変わっても unchanged の CLI 出力は変化しない", () => {
    const diff = makeDiff({ isUnchanged: true, shouldRecap: false });
    const outputFor = (name: string): string => {
      const logs: string[] = [];
      const original = console.log;
      console.log = (message: unknown) => logs.push(String(message));
      try {
        displayWeatherWarning(makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "神奈川県",
              areaCode: "140000",
              kinds: [{ name, code: "33", severity: "specialWarning" }],
              statuses: [],
            }],
          }],
        }), diff);
        return logs.join("\n");
      } finally {
        console.log = original;
      }
    };

    expect(outputFor("大雨極端危険情報")).toBe(outputFor("大雨特別警報"));
  });

  it("unchanged + shouldRecap: フレーム付きで再掲", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isUnchanged: true, shouldRecap: true });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("定期再掲 (60 分間隔) — 警報級発令中");
      expect(out).toContain("■ 現況サマリ");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("isFirstReport: フレーム付き、起動時現況", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isFirstReport: true });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("起動時現況");
      expect(out).toContain("■ 現況サマリ");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("isCancelRollback: 取消報サブ行 + currentAreasForDisplay", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const display: Vpws50CurrentAreasForDisplay = {
        totalAreas: 1,
        specialAreas: 0,
        warningAreas: 1,
        advisoryAreas: 0,
        kinds: [{
          kindCode: "03",
          kindShortName: "大雨",
          kindName: "レベル３大雨警報",
          displaySeverity: "officialL3",
          officialAlertLevel: 3,
          areas: [{ areaName: "茨城県", areaCode: "080000" }],
        }],
      };
      const info = makeFakeInfo({ infoType: "取消", layers: [] });
      const diff = makeDiff({ isCancelRollback: true, currentAreasForDisplay: display });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("取消報 — 直前報を巻き戻し");
      expect(out).toContain("■ 現況サマリ");
      expect(out).toContain("茨城県");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("unsafe: layer 不在 + frame は表示される (Plan-R2)", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({ layers: [] });
      const diff = makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("解析不能");
      expect(out).toContain("府県予報区レイヤーを抽出できませんでした");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("isFirstReport + 色付き: バナー非発火 (maxDS undefined) なら最初の非空行はフレーム上辺", () => {
    const original = chalkRef.level;
    chalkRef.level = 2;
    const logs: string[] = [];
    const origLog = console.log;
    // 空行 console.log() を "undefined" にしない (引数なし対応)
    console.log = (msg?: unknown) => logs.push(msg == null ? "" : String(msg));
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isFirstReport: true });
      displayWeatherWarning(info, diff);
      const lines = logs.join("\n").split("\n");
      const firstNonEmpty = lines.find((l) => stripAnsi(l).trim().length > 0)!;
      expect(stripAnsi(firstNonEmpty)).toMatch(/^[╔┌]/);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });

  it("色付き環境 (chalk.level=2) でも 6 状態の主要要素が出力される", () => {
    const original = chalkRef.level;
    chalkRef.level = 2;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isFirstReport: true });
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      expect(out).toContain("起動時現況");
      // ANSI escapes are present
      expect(out).toMatch(/\x1b\[/);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

// ── Phase C Task 8: 配色言語 + バナー ──

/**
 * chalk.level=3 (truecolor) で colorizer を実呼び出しして ANSI 前景色シーケンスを導出する
 * (Codex M-1: theme の TEXT_RGB 変更に自動追従。期待値ハードコード撤廃)。
 * chalk v4 の builder は生成時の level を捕捉するため、factory を level=3 スコープ内で呼ぶ。
 */
function deriveAnsiSeq(makeColorize: () => (s: string) => string): string {
  const chalkRef = (require("chalk").default ?? require("chalk"));
  const original = chalkRef.level;
  chalkRef.level = 3;
  try {
    const m = makeColorize()("x").match(/^\x1b\[([0-9;]+)m/);
    if (m == null) throw new Error("ANSI シーケンスを導出できませんでした (truecolor 非対応?)");
    return m[1];
  } finally {
    chalkRef.level = original;
  }
}

const deriveSeverityAnsi = (severity: DisplaySeverity): string =>
  deriveAnsiSeq(() => getDisplaySeverityText(severity));

const ANSI_RELEASE = deriveSeverityAnsi("release");
const ANSI_L3 = deriveSeverityAnsi("officialL3");
// 白系罫線 (weather-formatter.ts の WHITE_BORDER = chalk.rgb(232,232,232) と同定義)
const ANSI_WHITE = deriveAnsiSeq(() => {
  const chalkRef = (require("chalk").default ?? require("chalk"));
  return chalkRef.rgb(232, 232, 232);
});

describe("VPWS50 配色言語 + バナー (Phase C)", () => {
  const chalkRef = (require("chalk").default ?? require("chalk"));

  /** Code 49 (officialL4) の added 1 件 diff */
  function makeL4AddedDiff(): Vpws50Diff {
    return makeDiff({
      added: [{
        areaName: "千葉県北西部", areaCode: "120010",
        changes: [{
          phenomenonKey: "土砂災害", kindShortName: "土砂災害",
          prevKindCode: null, newKindCode: "49",
          prevSeverity: null, newSeverity: "warning",
          prevDisplaySeverity: null, newDisplaySeverity: "officialL4",
          prevOfficialAlertLevel: null, newOfficialAlertLevel: 4,
        }],
      }],
    });
  }

  /** Code 49 (officialL4) 1 予報区の info */
  function makeL4Info(): ParsedWeatherWarning {
    return makeFakeInfo({
      maxDisplaySeverity: "officialL4",
      maxSeverity: "warning",
      warningAreaCount: 1,
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [{
          areaName: "千葉県北西部", areaCode: "120010",
          kinds: [{ name: "レベル４土砂災害危険警報", code: "49", severity: "warning" }],
          statuses: [],
        }],
      }],
    });
  }

  it("L4 の added があるとバナー発火 (officialL4 色面)", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    setFrameWidth(80);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const info = makeL4Info();
      const diff = makeL4AddedDiff();
      expect(vpws50BannerSeverity(info, diff)).toBe("officialL4");
      displayWeatherWarning(info, diff);
      const out = logs.join("\n");
      const text = buildVpws50BannerText("officialL4", info, diff, 78);
      const banner = drawSeverityBanner("officialL4", text, 80);
      expect(out).toContain(banner[1]);  // officialL4 chip 色面の本文行
      expect(stripAnsi(text)).toContain("★ 土砂災害(L4)");
      expect(stripAnsi(text)).toContain("千葉県北西部");
      expect(stripAnsi(text)).toContain("新規1");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
      clearFrameWidth();
    }
  });

  it("解除のみ・降格のみではバナーが出ない (unsafe / diff なし / L3 のみも)", () => {
    // 現況に L4 が残っていても added/upgraded が無ければ発火しない (全国集約の騒音防止)
    const info = makeL4Info();
    const releasedOnly = makeDiff({
      released: [{
        areaName: "茨城県", areaCode: "080000",
        changes: [{
          phenomenonKey: "土砂災害", kindShortName: "土砂災害",
          prevKindCode: "49", newKindCode: null,
          prevSeverity: "warning", newSeverity: null,
          prevDisplaySeverity: "officialL4", newDisplaySeverity: null,
          prevOfficialAlertLevel: 4, newOfficialAlertLevel: null,
        }],
      }],
    });
    const downgradedOnly = makeDiff({
      downgraded: [{
        areaName: "茨城県", areaCode: "080000",
        changes: [{
          phenomenonKey: "土砂災害", kindShortName: "土砂災害",
          prevKindCode: "49", newKindCode: "29",
          prevSeverity: "warning", newSeverity: "advisory",
          prevDisplaySeverity: "officialL4", newDisplaySeverity: "officialL2",
          prevOfficialAlertLevel: 4, newOfficialAlertLevel: 2,
        }],
      }],
    });
    const l3Added = makeDiff({
      added: [{
        areaName: "茨城県", areaCode: "080000",
        changes: [{
          phenomenonKey: "大雨", kindShortName: "大雨",
          prevKindCode: null, newKindCode: "03",
          prevSeverity: null, newSeverity: "warning",
          prevDisplaySeverity: null, newDisplaySeverity: "officialL3",
          prevOfficialAlertLevel: null, newOfficialAlertLevel: 3,
        }],
      }],
    });
    expect(vpws50BannerSeverity(info, releasedOnly)).toBeNull();
    expect(vpws50BannerSeverity(info, downgradedOnly)).toBeNull();
    expect(vpws50BannerSeverity(info, l3Added)).toBeNull();
    expect(vpws50BannerSeverity(info, makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" }))).toBeNull();
    expect(vpws50BannerSeverity(info, undefined)).toBeNull();
  });

  it("初回起動で current max が officialL4 以上ならバナー発火、本文に種別と地域が入る", () => {
    const original = chalkRef.level;
    chalkRef.level = 0;
    try {
      const info = makeL4Info();
      const diff = makeDiff({ isFirstReport: true });
      expect(vpws50BannerSeverity(info, diff)).toBe("officialL4");
      const text = buildVpws50BannerText("officialL4", info, diff, 78);
      expect(stripAnsi(text)).toContain("★ 土砂災害(L4)");
      expect(stripAnsi(text)).toContain("千葉県北西部");
      expect(stripAnsi(text)).toContain("起動時現況");
      // 初回起動でも current max が L3 止まりなら発火しない
      const infoL3 = makeFakeInfo({ maxDisplaySeverity: "officialL3" });
      expect(vpws50BannerSeverity(infoL3, diff)).toBeNull();
    } finally {
      chalkRef.level = original;
    }
  });

  it("取消 (rollback) はフレーム全体 release 単色", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    setFrameWidth(80);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      const display: Vpws50CurrentAreasForDisplay = {
        totalAreas: 0, specialAreas: 0, warningAreas: 0, advisoryAreas: 0, kinds: [],
      };
      const info = makeFakeInfo({ infoType: "取消", maxDisplaySeverity: null, layers: [] });
      const diff = makeDiff({ isCancelRollback: true, currentAreasForDisplay: display });
      expect(vpws50BannerSeverity(info, diff)).toBe("release");
      displayWeatherWarning(info, diff);
      const lines = logs.join("\n").split("\n");
      // フレーム罫線行 (上辺/divider/本文罫線/下辺) はすべて release 色、白系罫線は出ない
      const borderLines = lines.filter((l) => /^[╔┌╠├║│╚└]/.test(stripAnsi(l)));
      expect(borderLines.length).toBeGreaterThan(0);
      for (const line of borderLines) {
        expect(line).toContain(ANSI_RELEASE);
        expect(line).not.toContain(ANSI_WHITE);
      }
    } finally {
      console.log = origLog;
      chalkRef.level = original;
      clearFrameWidth();
    }
  });

  it("本文ありフレーム: 上辺 = maxDisplaySeverity 色 / footer 直前 divider + 下辺 = 白系", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    setFrameWidth(80);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      // officialL3 max (バナー非発火) の初回起動
      const info = makeFakeInfo({
        maxDisplaySeverity: "officialL3",
        maxSeverity: "warning",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
            statuses: [],
          }],
        }],
      });
      const diff = makeDiff({ isFirstReport: true });
      displayWeatherWarning(info, diff);
      const lines = logs.join("\n").split("\n");
      const top = lines.find((l) => /^[╔┌]/.test(stripAnsi(l)))!;
      const bottom = lines.find((l) => /^[╚└]/.test(stripAnsi(l)))!;
      const dividers = lines.filter((l) => /^[╠├]/.test(stripAnsi(l)));
      expect(top).toContain(ANSI_L3);          // 上辺 = maxDS 色
      expect(top).not.toContain(ANSI_WHITE);
      expect(bottom).toContain(ANSI_WHITE);    // 下辺 = 白系
      expect(bottom).not.toContain(ANSI_L3);
      // footer 直前 divider (最後の divider) = 白系
      expect(dividers.length).toBeGreaterThan(0);
      expect(dividers[dividers.length - 1]).toContain(ANSI_WHITE);
    } finally {
      console.log = origLog;
      chalkRef.level = original;
      clearFrameWidth();
    }
  });

  it("compact: maxDisplaySeverity=officialL4 で強調ラベル『★ 危険警報 (L4)』が入る (L3 では入らない)", () => {
    const { displayVpws50Compact } = __vpws50_internals;
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));
    try {
      displayVpws50Compact(makeL4Info(), "critical");
      expect(logs.join("\n")).toContain("★ 危険警報 (L4)");
      logs.length = 0;
      const infoL3 = makeFakeInfo({
        maxDisplaySeverity: "officialL3",
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [{
            areaName: "茨城県", areaCode: "080000",
            kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
            statuses: [],
          }],
        }],
      });
      displayVpws50Compact(infoL3, "warning");
      expect(logs.join("\n")).not.toContain("危険警報 (L4)");
      expect(logs.join("\n")).not.toContain("警報 (L3)");
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
  });
});

// ── Phase C Task 9: 幅境界 + ANSI 保持 ──

describe("幅境界 + ANSI 保持 (Phase C Task 9)", () => {
  const chalkRef = (require("chalk").default ?? require("chalk"));
  const { renderCurrentSummary } = __vpws50_internals;
  const widths = [55, 60, 80, 105, 159];

  /** displayWeatherWarning の console.log 出力を行配列で採取 (setFrameWidth 注入) */
  function captureDisplay(
    info: ParsedWeatherWarning,
    diff: Vpws50Diff | undefined,
    width: number,
  ): string[] {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => logs.push(msg == null ? "" : String(msg));
    setFrameWidth(width);
    try {
      displayWeatherWarning(info, diff);
    } finally {
      console.log = origLog;
      clearFrameWidth();
    }
    return logs.join("\n").split("\n");
  }

  /** 折返し誘発用: 全 displaySeverity 帯 + 長い予報区名を含む info */
  function makeWideInfo(over?: Partial<ParsedWeatherWarning>): ParsedWeatherWarning {
    return makeFakeInfo({
      maxDisplaySeverity: "officialL5",
      maxSeverity: "specialWarning",
      warningAreaCount: 3,
      advisoryAreaCount: 4,
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [
          {
            areaName: "鹿児島県（奄美地方除く）", areaCode: "460100",
            kinds: [
              { name: "レベル５大雨特別警報", code: "33", severity: "specialWarning" },
              { name: "レベル４土砂災害危険警報", code: "49", severity: "warning" },
            ],
            statuses: [],
          },
          {
            areaName: "千葉県北西部", areaCode: "120010",
            kinds: [
              { name: "暴風警報", code: "05", severity: "warning" },
              { name: "波浪警報", code: "07", severity: "warning" },
            ],
            statuses: [],
          },
          {
            areaName: "茨城県", areaCode: "080000",
            kinds: [
              { name: "レベル３大雨警報", code: "03", severity: "warning" },
              { name: "雷注意報", code: "14", severity: "advisory" },
            ],
            statuses: [],
          },
          {
            areaName: "石狩・空知・後志地方", areaCode: "011000",
            kinds: [{ name: "雷注意報", code: "14", severity: "advisory" }],
            statuses: [],
          },
          {
            areaName: "青森県", areaCode: "020000",
            kinds: [{ name: "濃霧注意報", code: "20", severity: "advisory" }],
            statuses: [],
          },
          {
            areaName: "栃木県", areaCode: "090000",
            kinds: [{ name: "強風注意報", code: "15", severity: "advisory" }],
            statuses: [],
          },
        ],
      }],
      ...over,
    });
  }

  /** 取消 rollback 用の巻き戻し後現況 */
  function makeRollbackDisplay(): Vpws50CurrentAreasForDisplay {
    return {
      totalAreas: 5, specialAreas: 0, warningAreas: 2, advisoryAreas: 3,
      kinds: [
        {
          kindCode: "03", kindShortName: "大雨", kindName: "レベル３大雨警報",
          displaySeverity: "officialL3", officialAlertLevel: 3,
          areas: [
            { areaName: "千葉県北西部", areaCode: "120010" },
            { areaName: "茨城県", areaCode: "080000" },
          ],
        },
        {
          kindCode: "14", kindShortName: "雷", kindName: "雷注意報",
          displaySeverity: "nonLevelAdvisory", officialAlertLevel: null,
          areas: [
            { areaName: "石狩・空知・後志地方", areaCode: "011000" },
            { areaName: "青森県", areaCode: "020000" },
            { areaName: "栃木県", areaCode: "090000" },
          ],
        },
      ],
    };
  }

  /** added/upgraded/downgraded/released を全部含む diff (バナーは L4 added で発火) */
  function makeChangesDiff(): Vpws50Diff {
    return makeDiff({
      added: [{
        areaName: "千葉県北西部", areaCode: "120010",
        changes: [{
          phenomenonKey: "土砂災害", kindShortName: "土砂災害",
          prevKindCode: null, newKindCode: "49",
          prevSeverity: null, newSeverity: "warning",
          prevDisplaySeverity: null, newDisplaySeverity: "officialL4",
          prevOfficialAlertLevel: null, newOfficialAlertLevel: 4,
        }],
      }],
      upgraded: [{
        areaName: "鹿児島県（奄美地方除く）", areaCode: "460100",
        changes: [{
          phenomenonKey: "大雨", kindShortName: "大雨",
          prevKindCode: "03", newKindCode: "33",
          prevSeverity: "warning", newSeverity: "specialWarning",
          prevDisplaySeverity: "officialL3", newDisplaySeverity: "officialL5",
          prevOfficialAlertLevel: 3, newOfficialAlertLevel: 5,
        }],
      }],
      downgraded: [{
        areaName: "栃木県", areaCode: "090000",
        changes: [{
          phenomenonKey: "大雨", kindShortName: "大雨",
          prevKindCode: "03", newKindCode: "10",
          prevSeverity: "warning", newSeverity: "advisory",
          prevDisplaySeverity: "officialL3", newDisplaySeverity: "officialL2",
          prevOfficialAlertLevel: 3, newOfficialAlertLevel: 2,
        }],
      }],
      released: [{
        areaName: "青森県", areaCode: "020000",
        changes: [{
          phenomenonKey: "大雨", kindShortName: "大雨",
          prevKindCode: "03", newKindCode: null,
          prevSeverity: "warning", newSeverity: null,
          prevDisplaySeverity: "officialL3", newDisplaySeverity: null,
          prevOfficialAlertLevel: 3, newOfficialAlertLevel: null,
        }],
      }],
    });
  }

  /** legacy fallback (diff=undefined) 用: 発令 + 解除 (statuses) 混在 */
  function makeLegacyInfo(): ParsedWeatherWarning {
    const info = makeWideInfo();
    const layer = info.layers[0];
    layer.items.push({
      areaName: "沖縄本島地方", areaCode: "471000",
      kinds: [{ name: "解除", code: "00", severity: "release" }],
      statuses: [
        { kindCode: "00", status: "解除", lastKindName: "大雨警報", lastKindCode: "03" },
        { kindCode: "00", status: "解除", lastKindName: "雷注意報", lastKindCode: "14" },
      ],
    });
    return info;
  }

  interface StateCase {
    name: string;
    info: ParsedWeatherWarning;
    diff: Vpws50Diff | undefined;
  }

  /** 6 状態: unsafe / cancelRollback / unchanged+recap / firstReport / hasChanges / legacy */
  function makeStates(): StateCase[] {
    return [
      {
        name: "unsafe",
        info: makeFakeInfo({ layers: [] }),
        diff: makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" }),
      },
      {
        name: "cancelRollback",
        info: makeFakeInfo({ infoType: "取消", maxDisplaySeverity: null, layers: [] }),
        diff: makeDiff({ isCancelRollback: true, currentAreasForDisplay: makeRollbackDisplay() }),
      },
      {
        name: "unchanged+recap",
        info: makeWideInfo(),
        diff: makeDiff({ isUnchanged: true, shouldRecap: true }),
      },
      {
        // maxDS=officialL5 のためバナーも発火する (バナー行込みで幅検査)
        name: "firstReport",
        info: makeWideInfo(),
        diff: makeDiff({ isFirstReport: true }),
      },
      {
        name: "hasChanges",
        info: makeWideInfo(),
        diff: makeChangesDiff(),
      },
      {
        name: "legacy fallback",
        info: makeLegacyInfo(),
        diff: undefined,
      },
    ];
  }

  it("全 6 状態 × 幅で visualWidth(stripAnsi(line)) <= width", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    try {
      for (const width of widths) {
        for (const state of makeStates()) {
          const lines = captureDisplay(state.info, state.diff, width);
          for (const line of lines) {
            expect(
              visualWidth(stripAnsi(line)),
              `${state.name} width=${width} line=${JSON.stringify(stripAnsi(line))}`,
            ).toBeLessThanOrEqual(width);
          }
        }
      }
    } finally {
      chalkRef.level = original;
    }
  });

  it("chalk.level=3: 現況サマリが折り返されても token 行に ANSI が残る", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    try {
      // 長い予報区列 (20 件、nonLevelWarning = cluster 集約なし) を width=60 で描画
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: Array.from({ length: 20 }, (_, i) => ({
            areaName: `テスト区${String(i + 1).padStart(2, "0")}`,
            areaCode: `${String(i + 1).padStart(2, "0")}0000`,
            kinds: [{ name: "暴風警報", code: "05", severity: "warning" as const }],
            statuses: [],
          })),
        }],
      });
      const buf = createRenderBuffer();
      renderCurrentSummary(info, "warning", 60, buf);
      const lines = buf.lines.map((l: { text: string }) => l.text);
      // 折返しが起きている (テスト区を含む行が複数行)
      const areaLines = lines.filter((l: string) => stripAnsi(l).includes("テスト区"));
      expect(areaLines.length).toBeGreaterThan(1);
      // 折返し後の先頭行 (token 行) に ESC シーケンスが残る — token 直前アンカー付き
      // (Task 4 formatter-colored.test.ts と同形: hard-wrap fallback だと stripAnsi され消える)
      const tokenLine = lines.find((l: string) => stripAnsi(l).includes("◆暴風"))!;
      expect(tokenLine).toBeDefined();
      expect(/\x1B\[[\d;]*m/.test(tokenLine)).toBe(true);
      expect(/\x1B\[[\d;]*m◆暴風/.test(tokenLine)).toBe(true);
      // 全行 width=60 以内 (折返し後も)
      for (const line of lines) {
        expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(60);
      }
    } finally {
      chalkRef.level = original;
    }
  });

  it("token 単体の visualWidth が width 55 の innerWidth (51) に収まる", () => {
    const original = chalkRef.level;
    chalkRef.level = 3;
    try {
      const INNER_WIDTH_55 = 51; // width 55 - 4 (左右罫線 + スペース)
      // 最長候補: ★★土砂災害(L5) / ★土砂災害(L4) / △その他注意報 / ◆◆暴風雪 など
      const longest: Array<[string, string]> = [
        ["39", "レベル5土砂災害特別警報"],
        ["49", "レベル4土砂災害危険警報"],
        ["33", "レベル5大雨特別警報"],
        ["27", "（上記以外の）その他の注意報"],
        ["32", "暴風雪特別警報"],
        ["22", "なだれ注意報"],
      ];
      for (const [code, name] of longest) {
        const token = formatDisplayToken({ code, name });
        expect(
          visualWidth(stripAnsi(token)),
          `code=${code} token=${stripAnsi(token)}`,
        ).toBeLessThanOrEqual(INNER_WIDTH_55);
      }
      // 参考: 実際の最長は ★★土砂災害(L5) = 14 cells 程度で十分な余裕がある
      expect(visualWidth(stripAnsi(formatDisplayToken({ code: "39", name: "レベル5土砂災害特別警報" }))))
        .toBeLessThanOrEqual(20);
    } finally {
      chalkRef.level = original;
    }
  });
});

// ── Codex 最終レビュー反映 (unsafe/unknown エッジ): F-1〜F-5 ──

describe("Codex 最終レビュー反映 (unsafe/unknown エッジ)", () => {
  const chalkRef = (require("chalk").default ?? require("chalk"));
  const { displayVpws50Compact, displayVpws50List, renderCurrentSummary, buildVpws50Row } =
    __vpws50_internals;

  /** console.log 出力を採取して NO_COLOR で fn を実行する */
  function captureNoColor(fn: () => void): string[] {
    const original = chalkRef.level;
    chalkRef.level = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg?: unknown) => logs.push(msg == null ? "" : String(msg));
    try {
      fn();
    } finally {
      console.log = origLog;
      chalkRef.level = original;
    }
    return logs;
  }

  /** unknown-only (Code 99, name 謎, severity unknown) の info */
  function makeUnknownOnlyInfo(): ParsedWeatherWarning {
    return makeFakeInfo({
      layers: [{
        type: "気象警報・注意報（府県予報区等）",
        items: [{
          areaName: "茨城県", areaCode: "080000",
          kinds: [{ name: "謎", code: "99", severity: "unknown" }],
          statuses: [],
        }],
      }],
    });
  }

  // ── F-1: unsafe の表示 frame level が info に落ちない ──
  describe("F-1: unsafe の表示 frame level", () => {
    it("unsafe + layer 無し info を normal モードで描画するとフレームに [警告] が出る", () => {
      const info = makeFakeInfo({ layers: [] });
      const diff = makeDiff({ confidence: "unsafe", unsafeReason: "layer_missing" });
      const out = captureNoColor(() => displayWeatherWarning(info, diff)).join("\n");
      expect(out).toContain("解析不能");
      expect(out).toContain("[警告]");   // SEVERITY_LABELS["warning"]
      expect(out).not.toContain("[通知]"); // maxDisplaySeverity=null の info 落ちを起こさない
    });
  });

  // ── F-4: unknown kind が compact / legacy fallback から落ちない ──
  describe("F-4: unknown kind の compact / legacy fallback 表示", () => {
    it("buildVpws50Row: unknown-only でも null にならず ?謎 トークンを持つ", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const row = buildVpws50Row({
          areaName: "茨城県", areaCode: "080000", statuses: [],
          kinds: [{ name: "謎", code: "99", severity: "unknown" }],
        });
        expect(row).not.toBeNull();
        expect(row!.tokens).toEqual(["?謎"]);
        expect(row!.maxSeverity).toBeNull(); // 旧 3 段階に該当なし (警/注に数えない)
      } finally {
        chalkRef.level = original;
      }
    });

    it("legacy fallback: unknown-only 電文で ?謎 行が出る (発令なし扱いにしない)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const buf = createRenderBuffer();
        displayVpws50List(makeUnknownOnlyInfo(), undefined, "warning", 80, buf);
        const joined = buf.lines.map((l: { text: string }) => l.text).join("\n");
        expect(joined).toContain("?謎");
        expect(joined).toContain("茨城県");
        expect(joined).not.toContain("現在発令中の警報・注意報はありません");
      } finally {
        chalkRef.level = original;
      }
    });

    it("compact: unknown-only 電文で『発令なし』にならず『未知 1予報区』を出す", () => {
      const logs = captureNoColor(() => displayVpws50Compact(makeUnknownOnlyInfo(), "warning"));
      const out = logs.join("\n");
      expect(out).toContain("未知 1予報区");
      expect(out).not.toContain("発令なし");
    });

    it("compact: 警報 + unknown 混在では 警報カウント + 未知カウントが併記される", () => {
      const info = makeFakeInfo({
        layers: [{
          type: "気象警報・注意報（府県予報区等）",
          items: [
            {
              areaName: "茨城県", areaCode: "080000",
              kinds: [{ name: "レベル３大雨警報", code: "03", severity: "warning" }],
              statuses: [],
            },
            {
              areaName: "栃木県", areaCode: "090000",
              kinds: [{ name: "謎", code: "99", severity: "unknown" }],
              statuses: [],
            },
          ],
        }],
      });
      const logs = captureNoColor(() => displayVpws50Compact(info, "warning"));
      const out = logs.join("\n");
      expect(out).toContain("警報 1予報区");
      expect(out).toContain("未知 1予報区");
    });
  });

  // ── F-5: 現況サマリの totalAreas が unknown を数える ──
  describe("F-5: 現況サマリ totalAreas の unknown カウント", () => {
    it("unknown-only info の現況サマリで 1予報区 になる (特/警/注は 0 のまま)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const buf = createRenderBuffer();
        renderCurrentSummary(makeUnknownOnlyInfo(), "warning", 80, buf);
        const joined = stripAnsi(buf.lines.map((l: { text: string }) => l.text).join("\n"));
        expect(joined).toContain("■ 現況サマリ  1予報区  特0 / 警0 / 注0");
        expect(joined).toContain("? 未知");
      } finally {
        chalkRef.level = original;
      }
    });

    it("release-only info では totalAreas に数えない (0予報区)", () => {
      const original = chalkRef.level;
      chalkRef.level = 0;
      try {
        const info = makeFakeInfo({
          layers: [{
            type: "気象警報・注意報（府県予報区等）",
            items: [{
              areaName: "茨城県", areaCode: "080000",
              kinds: [{ name: "解除", code: "00", severity: "release" }],
              statuses: [],
            }],
          }],
        });
        const buf = createRenderBuffer();
        renderCurrentSummary(info, "info", 80, buf);
        const joined = stripAnsi(buf.lines.map((l: { text: string }) => l.text).join("\n"));
        expect(joined).toContain("■ 現況サマリ  0予報区  特0 / 警0 / 注0");
      } finally {
        chalkRef.level = original;
      }
    });
  });
});
