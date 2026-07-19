import { describe, it, expect } from "vitest";
import chalk from "chalk";
import { pushFrameTable } from "../../src/ui/frame-table-builder";
import { createRenderBuffer, visualWidth as vw } from "../../src/ui/formatter";

chalk.level = 0;

describe("pushFrameTable", () => {
  it("null/undefined セルを placeholder (既定 ─) に置換する", () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "warning",
      80,
      [
        { header: "種別" },
        { header: "ピーク" },
      ],
      [
        ["大雨警報", "05日朝"],
        ["洪水警報", null],
        ["風注意報", undefined],
      ],
    );
    const lines = buf.lines.map((l) => l.text);
    expect(lines.some((l) => l.includes("05日朝"))).toBe(true);
    expect(lines.some((l) => l.includes("─"))).toBe(true);
  });

  it("emptyPlaceholder を上書きできる", () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "normal",
      60,
      [
        { header: "A" },
        { header: "B", emptyPlaceholder: "N/A" },
      ],
      [["x", null]],
    );
    const lines = buf.lines.map((l) => l.text);
    const naLine = lines.find((l) => l.includes("N/A"));
    expect(naLine).toBeDefined();
    // データ行 (N/A を含む) は既定 placeholder ─ を含まないこと。
    // (ヘッダ下のセパレータ行は ─ を含むがそれは別行)
    expect(naLine).not.toContain("─");
  });

  it("内側幅が列ヘッダ合計より狭いときは行ベース fallback に切り替える", () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "info",
      30,
      [
        { header: "種別" },
        { header: "地域" },
        { header: "時刻枠" },
        { header: "ピーク" },
        { header: "基準到達" },
      ],
      [["大雨警報", "北部(飯山)", "朝-夕方(4枠)", "05日朝", "04 23:00"]],
    );
    const lines = buf.lines.map((l) => l.text);
    expect(lines.some((l) => l.includes("種別:"))).toBe(true);
    expect(lines.some((l) => l.includes("地域:"))).toBe(true);
  });

  it("最後列セルが長くフレーム外溢れする組合せでも fallback で吸収する", () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "warning",
      60,
      [
        { header: "A" },
        { header: "B" },
        { header: "C" },
        { header: "D" },
        { header: "E" },
      ],
      [
        [
          "短",
          "短",
          "短",
          "短",
          "これはとても長いセル文字列でフレーム外に溢れます基準到達期間情報",
        ],
      ],
    );
    for (const line of buf.lines) {
      expect(vw(line.text)).toBeLessThanOrEqual(60);
    }
    expect(buf.lines.some((l) => l.text.includes("A: "))).toBe(true);
  });
});

describe("pushFrameTable - indent", () => {
  const columns = [
    { header: "地域" },
    { header: "２９日(m/s)" },
    { header: "３０日(m/s)" },
  ];
  const rows = [
    ["東海地方", "風速22 瞬間風速35", "−"],
    ["近畿地方", "風速25 瞬間風速35", "−"],
  ];

  it("indent=4 でテーブル全行 (ヘッダ・罫線・データ) の本文が 4 桁右にずれる", () => {
    const buf = createRenderBuffer();
    pushFrameTable(buf, "normal", 80, columns, rows, undefined, 4);
    const lines = buf.lines.map((l) => l.text);
    expect(lines.length).toBeGreaterThanOrEqual(4); // ヘッダ + 罫線 + データ 2
    for (const line of lines) {
      // frameLine 形式: <枠線 1 文字> + " " + 本文。indent 4 → 本文先頭に 4 スペース
      expect(line.slice(2, 6)).toBe("    ");
      expect(line[6]).not.toBe(" ");
    }
  });

  it("indent=0 (既定) は従来出力と同一 (indent 省略呼び出しと一致)", () => {
    const bufDefault = createRenderBuffer();
    pushFrameTable(bufDefault, "normal", 80, columns, rows);
    const bufZero = createRenderBuffer();
    pushFrameTable(bufZero, "normal", 80, columns, rows, undefined, 0);
    expect(bufZero.lines.map((l) => l.text)).toEqual(
      bufDefault.lines.map((l) => l.text),
    );
  });

  it.each([60, 80, 100])(
    "indent=4 + width=%i でも全行 visualWidth が width 以下 (有効幅が indent 分減る)",
    (width) => {
      const buf = createRenderBuffer();
      pushFrameTable(
        buf,
        "warning",
        width,
        [
          { header: "種別" },
          { header: "地域" },
          { header: "時刻枠" },
          { header: "ピーク" },
          { header: "基準到達" },
        ],
        [
          ["大雨警報", "北部(飯山)", "朝-夕方(4枠)", "05日朝06時", "04 23:00"],
          ["洪水警報", "北部(飯山)", "昼-夕方(2枠)", null, "05 10:00"],
        ],
        undefined,
        4,
      );
      for (const line of buf.lines) {
        expect(vw(line.text)).toBeLessThanOrEqual(width);
      }
    },
  );

  it("indent 指定でも狭幅では fallback に切り替わり width 以内を保つ", () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "info",
      34,
      [
        { header: "種別" },
        { header: "地域" },
        { header: "時刻枠" },
        { header: "ピーク" },
        { header: "基準到達" },
      ],
      [["大雨警報", "北部(飯山)", "朝-夕方(4枠)", "05日朝", "04 23:00"]],
      undefined,
      4,
    );
    const lines = buf.lines.map((l) => l.text);
    expect(lines.some((l) => l.includes("種別:"))).toBe(true);
    for (const line of buf.lines) {
      expect(vw(line.text)).toBeLessThanOrEqual(34);
    }
  });
});

describe.each([80, 100, 120])("width=%i での全行 visualWidth 保証", (width) => {
  it(`5 列 + 普通の長さのセルで全行が width 以内`, () => {
    const buf = createRenderBuffer();
    pushFrameTable(
      buf,
      "warning",
      width,
      [
        { header: "種別" },
        { header: "地域" },
        { header: "時刻枠" },
        { header: "ピーク" },
        { header: "基準到達" },
      ],
      [
        ["大雨警報", "北部(飯山)", "朝-夕方(4枠)", "05日朝06時", "04 23:00"],
        ["大雨警報", "北部(長野)", "朝-夕方(3枠)", "05日昼前", "05 00:30"],
        ["洪水警報", "北部(飯山)", "昼-夕方(2枠)", null, "05 10:00"],
      ],
    );
    for (const line of buf.lines) {
      expect(vw(line.text)).toBeLessThanOrEqual(width);
    }
  });
});
