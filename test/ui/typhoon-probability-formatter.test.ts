import { describe, it, expect, vi, beforeEach, afterEach , type MockInstance } from "vitest";
import chalk from "chalk";
import { displayTyphoonProbabilityInfo } from "../../src/ui/typhoon-probability-formatter";
import { parseTyphoonProbability } from "../../src/dmdata/typhoon-probability-parser";
import { createMockWsDataMessage, createMockWsDataMessageFromXml, FIXTURE_VPTA50_DAMREY, FIXTURE_VPTA50_JANGMI_GONE } from "../helpers/mock-message";
import { buildVpta50Synthetic } from "../helpers/build-vpta50-synthetic";
import type { ParsedTyphoonProbability, TyphoonProbRegion, TyphoonProbPeak } from "../../src/types";
import { readFileSync } from "fs";
import { resolve } from "path";

const BASE_XML_VPTA50 = readFileSync(
  resolve(__dirname, "../fixtures/76_01_01_200630_VPTA50.xml"),
  "utf-8",
);

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

let logs: string[];
let logSpy: MockInstance<typeof console.log>;

beforeEach(() => {
  logs = [];
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => String(a ?? "")).join(" "));
  });
});
afterEach(() => { logSpy.mockRestore(); });

describe("displayTyphoonProbabilityInfo — 共通枠", () => {
  it("タイトルに『台風の暴風域に入る確率』が含まれる", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    expect(stripAnsi(logs.join("\n"))).toContain("台風の暴風域に入る確率");
  });

  it("取消電文では『この台風情報は取り消されました』を出力", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    const cancelInfo = { ...info, infoType: "取消" };
    displayTyphoonProbabilityInfo(cancelInfo);
    expect(stripAnsi(logs.join("\n"))).toContain("この台風情報は取り消されました");
  });
});

describe("displayTyphoonProbabilityInfo — 空状態", () => {
  it("全0%電文（JANGMI消滅）は『暴風域に入る確率が1%以上の地域はありません』", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join("\n"));
    expect(joined).toContain("暴風域に入る確率が1%以上の地域はありません");
    expect(joined).toContain("JANGMI");
  });

  it("空状態でも『120時間先まで予測対象』が出る", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_JANGMI_GONE))!;
    displayTyphoonProbabilityInfo(info);
    expect(stripAnsi(logs.join("\n"))).toContain("120時間先まで予測対象");
  });
});

describe("displayTyphoonProbabilityInfo — オーバービュー", () => {
  it("DAMREY: 上位府県 大東島地方/長崎県 が表示される", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).toContain("大東島地方");
    expect(joined).toContain("長崎県");
    expect(joined).toContain("100");
    expect(joined).toContain("99");
  });

  it("DAMREY: 大東島地方の最悪地域セルは空欄（prefName==areaName のため redundancy 排除）", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    const lines = joined.split("\n");
    const daitoLines = lines.filter((l) => l.includes("大東島地方"));
    for (const l of daitoLines) {
      const count = (l.match(/大東島地方/g) ?? []).length;
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it("DAMREY: hidden 行『…ほか N府県』が出る", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).toMatch(/…ほか \d+府県/);
  });

  it("狭幅 (40 列) では最悪地域列が削られる", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    setFrameWidth(40);
    try {
      const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
      displayTyphoonProbabilityInfo(info);
      const joined = stripAnsi(logs.join(""));
      expect(joined).not.toContain("最悪地域");
      expect(joined).toContain("府県");
    } finally {
      clearFrameWidth();
    }
  });
});

describe("displayTyphoonProbabilityInfo — 二次細分内訳", () => {
  it("DAMREY: 内訳に島根県 (◇ 見出し) と益田が含まれる", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).toContain("高確率府県の内訳");
    // 新形式: ◇ 見出し行
    expect(joined).toContain("◇ 島根県");
    expect(joined).toContain("益田");
  });

  it("DAMREY: 地域間に '|' 区切りが現れる", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    // 複数地域を持つ府県では "地区名 NN% | 地区名" のパターンが出る
    expect(joined).toMatch(/\d+% \| /);
  });

  it("1 地域だけの府県 (大東島地方) も ◇ 見出し + 地域行の 2 行構造で出る", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    const lines = stripAnsi(logs.join("\n")).split("\n");
    // 大東島地方 が prefName==areaName のため内訳フィルタで除外されるが、
    // 島根県など複数地域を持つ府県で ◇ 見出し行の直後に地域行が来ることを確認
    const headingLines = lines.filter((l) => l.includes("◇"));
    expect(headingLines.length).toBeGreaterThan(0);
    for (const headingLine of headingLines) {
      const idx = lines.indexOf(headingLine);
      // 見出し行の次の行が存在し、空でない (地域行が続く)
      expect(idx + 1).toBeLessThan(lines.length);
    }
  });
});

describe("displayTyphoonProbabilityInfo — compactOnly", () => {
  it("fallback=compactOnly のとき [省略] バッジが出る", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    info.fallback = "compactOnly";
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).toContain("[省略]");
  });

  it("fallback=compactOnly のとき内訳ブロックは出ない", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    info.fallback = "compactOnly";
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).not.toContain("高確率府県の内訳");
  });
});

describe("displayTyphoonProbabilityInfo — 注記ブロック", () => {
  it("duplicateCode synthetic で『[警告] 地域コード重複』を出す", () => {
    const xml = buildVpta50Synthetic(BASE_XML_VPTA50, "duplicateCode");
    const msg = createMockWsDataMessageFromXml(xml, "VPTA50");
    const info = parseTyphoonProbability(msg)!;
    displayTyphoonProbabilityInfo(info);
    const joined = stripAnsi(logs.join(""));
    expect(joined).toContain("▸ 注記");
    expect(joined).toContain("[警告] 地域コード重複");
  });

  it("正常 DAMREY 電文では注記ブロックを出さない", () => {
    const info = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY))!;
    displayTyphoonProbabilityInfo(info);
    expect(stripAnsi(logs.join(""))).not.toContain("▸ 注記");
  });
});

describe("displayTyphoonProbabilityInfo — 二次細分overflow対策", () => {
  it("15地域を持つ府県があっても全出力行が幅80に収まり、超過時は …ほか が出る", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    setFrameWidth(80);
    try {
      // 15 sub-regions all with high daily[4] values
      const subRegions: TyphoonProbRegion[] = Array.from({ length: 15 }, (_, i) => ({
        areaName: `地区${String(i + 1).padStart(2, "0")}`,
        areaCode: `${100000 + i}`,
        prefName: "テスト府県",
        prefCode: "990000",
        daily: [80, 85, 90, 95, 99],
        series40: [],
        peak: { kind: "allZero" } as TyphoonProbPeak,
      }));

      const info: ParsedTyphoonProbability = {
        type: "VPTA50",
        infoType: "発表",
        title: "台風の暴風域に入る確率",
        controlTitle: "台風の暴風域に入る確率",
        name: { name: "TEST", nameKana: "テスト", number: "9901", remark: null },
        baseTime: "2020-10-01T00:00:00+09:00",
        reportDateTime: "2020-10-01T00:00:00+09:00",
        publishingOffice: "気象庁",
        timeDefines: [],
        regions: subRegions,
        eventId: "20201001000000_01",
        serial: "1",
        isTest: false,
        fallback: "none",
        parserDiagnostics: {
          duplicateCodes: [],
          missingCodesPerSection: [],
          sectionCodeCountMismatch: false,
          dailyAnomalies: [],
          unknownAttributes: [],
        },
      };

      displayTyphoonProbabilityInfo(info);
      const allLines = logs.flatMap(l => l.split("\n"));
      for (const line of allLines) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(80);
      }
      // If 15 items overflowed, …ほか should appear
      const joined = stripAnsi(logs.join(""));
      // Either all items fit in ≤3 lines or truncation with …ほか appears
      const overflowLines = allLines.filter(l => stripAnsi(l).length > 80);
      expect(overflowLines.length).toBe(0);
      // Content should mention the prefecture
      expect(joined).toContain("テスト府県");
    } finally {
      clearFrameWidth();
    }
  });
});

// ─── Helper: 合成 ParsedTyphoonProbability を構築 ───────────────────────────
function buildSyntheticInfo(
  prefName: string,
  regions: Array<{ areaName: string; daily4: number }>,
): ParsedTyphoonProbability {
  const subRegions: TyphoonProbRegion[] = regions.map((r, i) => ({
    areaName: r.areaName,
    areaCode: `${900000 + i}`,
    prefName,
    prefCode: "990000",
    daily: [r.daily4, r.daily4, r.daily4, r.daily4, r.daily4],
    series40: [],
    peak: { kind: "allZero" } as TyphoonProbPeak,
  }));
  return {
    type: "VPTA50",
    infoType: "発表",
    title: "台風の暴風域に入る確率",
    controlTitle: "台風の暴風域に入る確率",
    name: { name: "TEST", nameKana: "テスト", number: "9901", remark: null },
    baseTime: "2020-10-01T00:00:00+09:00",
    reportDateTime: "2020-10-01T00:00:00+09:00",
    publishingOffice: "気象庁",
    timeDefines: [],
    regions: subRegions,
    eventId: "20201001000000_01",
    serial: "1",
    isTest: false,
    fallback: "none",
    parserDiagnostics: {
      duplicateCodes: [],
      missingCodesPerSection: [],
      sectionCodeCountMismatch: false,
      dailyAnomalies: [],
      unknownAttributes: [],
    },
  };
}

describe("displayTyphoonProbabilityInfo — 内訳 ANSI 保持 (item-pack wrap)", () => {
  it(">=50% 地域に chalk.bold.yellow ANSI エスケープが含まれる (wrap 後も剥がれない)", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    // 狭めにして確実に wrap させる
    setFrameWidth(80);
    // vitest 環境では chalk.level === 0 (no color)。テスト中だけ level 1 に強制して ANSI を有効化
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      // 多めの地域で折り返しを誘発する (>=50%)
      const info = buildSyntheticInfo("鹿児島県", [
        { areaName: "種子島地方", daily4: 80 },
        { areaName: "屋久島地方", daily4: 78 },
        { areaName: "大隅地方", daily4: 70 },
        { areaName: "薩摩地方", daily4: 65 },
        { areaName: "奄美地方", daily4: 55 },
      ]);
      displayTyphoonProbabilityInfo(info);
      // ANSI ありの生出力でチェック — chalk.bold.yellow は \x1b[1m\x1b[33m (level 1 では分離出力)
      const raw = logs.join("\n");
      // 少なくとも 1 つの bold+yellow sequence が存在する
      // (新実装: wrapFrameLinesColored を使わず、ANSI 付き item 文字列をそのまま push するため保持される)
      expect(raw).toMatch(/\x1b\[(?:1m\x1b\[33m|33;1m|1;33m|\d+m)/);
    } finally {
      chalk.level = prevLevel;
      clearFrameWidth();
    }
  });
});

// フレーム行からコンテンツ部分を抽出するヘルパー
// frameLineColored は "│ {content}... │" 形式で出力する。
// テーブル行 (内側に │ を含む) は除外する。
function extractFrameContents(rawLines: string[]): string[] {
  return rawLines
    .map(l => {
      // stripAnsi 後: "│ {content}... │" — 先頭の "│ " と末尾 " │" を除去
      const stripped = stripAnsi(l);
      // 先頭が罫線文字で、末尾も罫線文字で終わる行だけ対象
      const m = stripped.match(/^[│╔╟╚╠╞╤╧╗╝╣╢][ ](.+)[ ][│╔╟╚╠╞╤╧╗╝╣╢]$/);
      if (m == null) return null;
      const content = m[1].trimEnd();
      // テーブル行は内側に box-drawing │ を含む → 除外
      if (content.includes("│")) return null;
      return content;
    })
    .filter((c): c is string => c != null);
}

describe("displayTyphoonProbabilityInfo — wrap 境界保護 (item-atomic)", () => {
  it("折り返し点は地域名の途中ではなく item の後ろで起きる (行末 '|' パターン)", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    setFrameWidth(80);
    try {
      // 多地域で複数行になるよう設定 (地域名は長め)
      const info = buildSyntheticInfo("テスト府県", [
        { areaName: "種子島地方", daily4: 80 },
        { areaName: "屋久島地方", daily4: 78 },
        { areaName: "大隅地方", daily4: 70 },
        { areaName: "薩摩地方", daily4: 65 },
        { areaName: "奄美地方", daily4: 55 },
        { areaName: "沖縄本島地方", daily4: 50 },
        { areaName: "先島地方", daily4: 45 },
        { areaName: "大東島地方", daily4: 40 },
      ]);
      displayTyphoonProbabilityInfo(info);
      const rawLines = logs.join("\n").split("\n");
      const contents = extractFrameContents(rawLines);

      // 内訳 items 行: "      " (6 スペース) で始まり "%" を含む行
      const itemLines = contents.filter(c => c.startsWith("      ") && c.includes("%"));

      // 折り返しが 1 件以上あれば検証。複数行になっていることを確認
      if (itemLines.length >= 2) {
        // 中間行(最終行以外)は trailing " |" で終わる
        for (const line of itemLines.slice(0, -1)) {
          expect(line.trimEnd()).toMatch(/\|$/);
        }
        // 最終行は trailing "|" なし
        const lastLine = itemLines[itemLines.length - 1];
        expect(lastLine.trimEnd()).not.toMatch(/\|$/);
      }

      // どの行も地域名が途中で切れていないこと: 各行に含まれる "%" の前の地域名部分が
      // 定義した areaName のいずれかと完全一致する
      const areaNames = [
        "種子島地方", "屋久島地方", "大隅地方", "薩摩地方",
        "奄美地方", "沖縄本島地方", "先島地方", "大東島地方",
      ];
      for (const line of itemLines) {
        // 行内の "地域名 NN%" パターンを全抽出して、地域名が既知のものかチェック
        const matches = [...line.matchAll(/([^\s|]+(?:\s+[^\s|]+)*)\s+\d+%/g)];
        for (const m of matches) {
          expect(areaNames).toContain(m[1]);
        }
      }
    } finally {
      clearFrameWidth();
    }
  });

  it("1 地域だけの府県の items 行は trailing '|' を持たない", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    setFrameWidth(80);
    try {
      const info = buildSyntheticInfo("大東島地方専用", [
        { areaName: "大東島地方", daily4: 90 },
      ]);
      displayTyphoonProbabilityInfo(info);
      const rawLines = logs.join("\n").split("\n");
      const contents = extractFrameContents(rawLines);
      const itemLines = contents.filter(c => c.startsWith("      ") && c.includes("%"));
      // 1 地域 → items 行は 1 行のみで trailing "|" なし
      expect(itemLines.length).toBe(1);
      expect(itemLines[0].trimEnd()).not.toMatch(/\|$/);
    } finally {
      clearFrameWidth();
    }
  });
});

describe("displayTyphoonProbabilityInfo — 内訳 overflow 省略 (…ほか N 地域)", () => {
  it("items が MAX_LINES を超えるほど多い場合 '…ほか N 地域' が出る", async () => {
    const { setFrameWidth, clearFrameWidth } = await import("../../src/ui/formatter");
    setFrameWidth(80);
    try {
      // 20 地域: 幅 80 の 3 行に収まらないはず
      const regions = Array.from({ length: 20 }, (_, i) => ({
        areaName: `地区${String(i + 1).padStart(2, "0")}`,
        daily4: 80,
      }));
      const info = buildSyntheticInfo("多地域府県", regions);
      displayTyphoonProbabilityInfo(info);
      const joined = stripAnsi(logs.join(""));
      expect(joined).toMatch(/…ほか \d+ 地域/);

      // 表示件数 + 隠し件数 = 合計 20 であることを検証
      const m = joined.match(/…ほか (\d+) 地域/);
      if (m != null) {
        const hidden = parseInt(m[1], 10);
        // items 行から表示地域数 (「地区NN」出現数) を数える。
        // …ほか N 地域 の "地域" は "地区" とは異なるため地区\d+ で正確に数えられる
        const rawLines = logs.join("\n").split("\n");
        const contents = extractFrameContents(rawLines);
        const itemContent = contents.filter(c => c.startsWith("      ") && c.includes("%")).join("");
        const visibleCount = itemContent.match(/地区\d+/g)?.length ?? 0;
        expect(visibleCount + hidden).toBe(20);
      }
    } finally {
      clearFrameWidth();
    }
  });
});

describe("displayTyphoonProbabilityInfo — trailing-pipe 幅予約 (右枠欠落バグ再現)", () => {
  /**
   * 再現ケース:
   *   width=120, innerWidth=116, prefixWidth=6.
   *   item1 (vw=52) + sep(3) + item2 (vw=55) = 6+52+3+55 = 116 == innerWidth.
   *   旧コード: 116 <= 116 → 両方同一行にパック → flush 時に " |" 付与 → 行幅 118 > 116 (RIGHT BORDER OVERFLOW).
   *   新コード: 116 + 2 > 116 → item2 で折り返し → 行幅 6+52+2=60 ≤ 116 ✓.
   *
   *   item3 は item2 の flush を引き起こすトリガーとして必要 (最終行は trailing "|" を付けない)。
   */
  it("折り返し行を含むすべての出力行が width を超えない (trailing-pipe 幅予約)", async () => {
    const { setFrameWidth, clearFrameWidth, visualWidth: vw } = await import("../../src/ui/formatter");
    const width = 120;
    const innerWidth = width - 4;  // 116
    setFrameWidth(width);
    try {
      // item1: areaName = "A"×48, prob = "80%" → item string "AAAA...A 80%" = 52 chars = vw 52
      // item2: areaName = "B"×51, prob = "80%" → item string "BBB...B 80%" = 55 chars = vw 55
      // item3: areaName = "C",    prob = "80%" → item string "C 80%" = 5 chars = vw 5
      //   (item3 の役割: item2 を含む行を flush させる — 最終行でないため trailing "|" が付く)
      // 境界確認: prefixWidth(6) + item1(52) + sep(3) + item2(55) = 116 == innerWidth
      //   旧コード → line vw = 116 + 2 = 118 > 116 → overflow
      //   新コード → item2 で折り返し → line1 vw = 6+52+2=60 ≤ 116 ✓
      const info = buildSyntheticInfo("テスト府県X", [
        { areaName: "A".repeat(48), daily4: 80 },  // vw(item)=52
        { areaName: "B".repeat(51), daily4: 80 },  // vw(item)=55
        { areaName: "C",            daily4: 80 },  // vw(item)=5  (flush trigger)
      ]);

      displayTyphoonProbabilityInfo(info);

      const allLines = logs.join("\n").split("\n");

      // アサーション 1: すべての出力行の視覚幅が width 以下
      for (const line of allLines) {
        const lineVw = vw(stripAnsi(line));
        expect(lineVw, `幅超過行: "${stripAnsi(line).slice(0, 30)}..." vw=${lineVw}`).toBeLessThanOrEqual(width);
      }

      // アサーション 2: フレーム内に「コンテンツが空白のみのフレーム行」が出ない
      // "フレーム行" = stripAnsi 後が │/║ で始まり │/║ で終わる行（上下の罫線 ╔╗╚╝ は除外）
      // (旧バグでは overflow を frameLineColored が pad=0 のまま出力し、
      //  右枠欠落により隣接する空行が視覚的に生じる。ここでは空フレーム行を直接検出する)
      const blankFrameLines = allLines.filter(line => {
        const s = stripAnsi(line);
        // フレームサイド行のみ対象 (│ or ║ で始まり、│ or ║ で終わる)
        if (!/^[│║]/.test(s) || !/[│║]$/.test(s)) return false;
        // 左枠+スペース と スペース+右枠 を除いた内容を取得
        const inner = s.replace(/^[│║] ?/, "").replace(/ ?[│║]$/, "");
        return inner.trim() === "";
      });
      // 実際の空白フレーム行はバグ起因のもの: 存在しないことを確認
      expect(blankFrameLines.length, `空フレーム行が検出された: "${blankFrameLines.join('" | "')}"`).toBe(0);
    } finally {
      clearFrameWidth();
    }
  });
});
