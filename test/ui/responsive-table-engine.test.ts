import { describe, it, expect, beforeEach } from "vitest";
import chalk from "chalk";
import {
  decideDisplayMode,
  renderResponsiveTable,
  collectDetailForTable,
  type ColumnSpec,
  type DetailItem,
} from "../../src/ui/responsive-table-engine";
import {
  createRenderBuffer,
  stripAnsi,
  visualWidth,
} from "../../src/ui/formatter";
import { DEFAULT_CONFIG } from "../../src/types";

describe("decideDisplayMode (3 段 breakpoint)", () => {
  it("<120 / 120-159 / 160+ で分岐する", () => {
    expect(decideDisplayMode(60)).toBe("ultra-narrow");
    expect(decideDisplayMode(119)).toBe("ultra-narrow");
    expect(decideDisplayMode(120)).toBe("standard");
    expect(decideDisplayMode(159)).toBe("standard");
    expect(decideDisplayMode(160)).toBe("wide");
    expect(decideDisplayMode(200)).toBe("wide");
  });

  it("閾値が weather 系デフォルト (120/160) と一致する (型共有はせず値で担保)", () => {
    expect(decideDisplayMode(DEFAULT_CONFIG.weatherWarningStandardThreshold - 1)).toBe("ultra-narrow");
    expect(decideDisplayMode(DEFAULT_CONFIG.weatherWarningStandardThreshold)).toBe("standard");
    expect(decideDisplayMode(DEFAULT_CONFIG.weatherWarningWideThreshold)).toBe("wide");
  });
});

describe("renderResponsiveTable (自前 clip + ClipReport)", () => {
  interface TestRow { a: string; b: string }
  const cols: ColumnSpec<TestRow>[] = [
    { header: "A", minWidth: 4, maxWidth: 8, cell: (r) => r.a },
    { header: "B", minWidth: 4, maxWidth: 8, cell: (r) => r.b },
  ];

  beforeEach(() => { chalk.level = 3; });

  it("clip されなかった行は ClipReport に載らない", () => {
    const buf = createRenderBuffer();
    const report = renderResponsiveTable(buf, "warning", 60, cols, [{ a: "ok", b: "ok" }]);
    expect(report.size).toBe(0);
    // ヘッダ + データの 2 行
    expect(buf.getLines().length).toBe(2);
  });

  it("maxWidth を超えるセルは clip され、行 index と列ヘッダが記録される", () => {
    const buf = createRenderBuffer();
    const longB = "とても長い波高の記述で確実にあふれる";
    const report = renderResponsiveTable(buf, "warning", 30, cols, [
      { a: "ok", b: "ok" },
      { a: "ok", b: longB },
    ]);
    expect(report.has(0)).toBe(false);
    expect(report.get(1)).toEqual({ B: true });
  });

  it("sum(minWidths) + セパレータ幅 > innerWidth でも全行 (ヘッダ含む) が width を超えない", () => {
    // cols: minWidth 4+4=8, sepWidth 3 → 必要 innerWidth 11 (width 15)。
    // width 8-14 では minWidth 合計が入りきらず、最終 clamp が効くことを検証する。
    const rows: TestRow[] = [{ a: "北海道太平洋沿岸東部", b: "１０ｍ超" }];
    for (let w = 8; w <= 20; w++) {
      const buf = createRenderBuffer();
      renderResponsiveTable(buf, "warning", w, cols, rows);
      const lines = buf.getLines();
      expect(lines.length).toBe(2); // ヘッダ + データ
      for (const line of lines) {
        expect(visualWidth(stripAnsi(line)), `width=${w} line=${stripAnsi(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("長いヘッダも列幅に clip され、ヘッダ行が width を超えない", () => {
    const longHeaderCols: ColumnSpec<TestRow>[] = [
      { header: "とても長い列見出しの例", minWidth: 4, maxWidth: 8, cell: (r) => r.a },
      { header: "B", minWidth: 4, maxWidth: 8, cell: (r) => r.b },
    ];
    const buf = createRenderBuffer();
    renderResponsiveTable(buf, "warning", 30, longHeaderCols, [{ a: "ok", b: "ok" }]);
    for (const line of buf.getLines()) {
      expect(visualWidth(stripAnsi(line)), `line=${stripAnsi(line)}`).toBeLessThanOrEqual(30);
    }
  });

  it("全行が width を超えない (幅 40-200 sweep)", () => {
    const longRow: TestRow = { a: "北海道太平洋沿岸東部", b: "１０ｍ超の巨大な津波" };
    for (let w = 40; w <= 200; w++) {
      const buf = createRenderBuffer();
      renderResponsiveTable(buf, "critical", w, cols, [longRow]);
      for (const line of buf.getLines()) {
        expect(visualWidth(stripAnsi(line)), `width=${w} line=${stripAnsi(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("wrap 列は折り返して全内容を複数物理行で出力する", () => {
    const buf = createRenderBuffer();
    const wrapCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 4, maxWidth: 6, cell: (r) => r.a },
      { header: "B", minWidth: 8, maxWidth: 10, wrap: true, cell: (r) => r.b },
    ];
    const long = "青森県, 岩手県, 宮城県, 秋田県, 山形県, 福島県";
    renderResponsiveTable(buf, "warning", 30, wrapCols, [{ a: "x", b: long }]);
    const out = buf.getLines().map(stripAnsi).join("\n");
    // 全地域名が出力に含まれる (clip されない)。wrapTextLines は文字単位のハード折り返し
    // のため語の途中で改行・pad 空白・枠線を挟んで分割されうる。空白/改行/枠線記号を除去した
    // 連結文字列で「文字が省略されていない」ことを検証する。
    const flat = out.replace(/[\s║│]/g, "");
    for (const pref of ["青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県"]) {
      expect(flat).toContain(pref);
    }
    // ヘッダ + 複数物理行 (>2)
    expect(buf.getLines().length).toBeGreaterThan(2);
  });

  it("wrap 列の継続行では非 wrap 列が空白 pad される", () => {
    const buf = createRenderBuffer();
    const wrapCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 4, maxWidth: 4, cell: (r) => r.a },
      { header: "B", minWidth: 8, maxWidth: 8, wrap: true, cell: (r) => r.b },
    ];
    renderResponsiveTable(buf, "warning", 24, wrapCols, [{ a: "府県", b: "あいうえおかきくけこ" }]);
    const dataLines = buf.getLines().slice(1).map(stripAnsi); // ヘッダ除く
    expect(dataLines.length).toBeGreaterThan(1);
    // 1 物理行目は "府県" を含む、継続行は A 列が空白
    expect(dataLines[0]).toContain("府県");
    expect(dataLines[1]).not.toContain("府県");
  });

  it("wrap 列は ClipReport に載らない", () => {
    const buf = createRenderBuffer();
    const wrapCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 4, maxWidth: 6, cell: (r) => r.a },
      { header: "B", minWidth: 6, maxWidth: 8, wrap: true, cell: (r) => r.b },
    ];
    const report = renderResponsiveTable(buf, "warning", 20, wrapCols, [
      { a: "ok", b: "とても長い波高の記述で確実にあふれる内容" },
    ]);
    expect(report.size).toBe(0);
  });

  it("wrap 列: カンマ折りの継続行先頭の半角スペース 1 個を除去する (spec §9 R3-1, engine 責務)", () => {
    const buf = createRenderBuffer();
    const wrapCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 4, maxWidth: 4, cell: (r) => r.a },
      { header: "B", minWidth: 20, maxWidth: 20, wrap: true, cell: (r) => r.b },
    ];
    // 幅 31 → innerWidth 27 = A(4) + sep(3) + B(20)。B セルは v2 の優先改行で
    // "February," の直後に折れ、lossless のため次行は " March" (スペース保持) で返る
    // → engine が継続行先頭のスペース 1 個を除去して "March" になる
    renderResponsiveTable(buf, "warning", 31, wrapCols, [
      { a: "x", b: "January, February, March" },
    ]);
    const data = buf.getLines().slice(1).map(stripAnsi); // ヘッダ除く
    expect(data.length).toBe(2);
    const cellB = (line: string): string => line.split(" │ ")[1] ?? "";
    expect(cellB(data[0])).toContain("January, February,");
    expect(cellB(data[1]).startsWith("March")).toBe(true); // 先頭スペースが除去されている
  });

  it("omitHeader: true でヘッダ行を出さない", () => {
    const buf = createRenderBuffer();
    renderResponsiveTable(buf, "warning", 60, cols, [{ a: "ok", b: "ok" }], { omitHeader: true });
    const out = buf.getLines().map(stripAnsi).join("\n");
    expect(out).not.toContain("A");
    expect(out).not.toContain("B");
    expect(buf.getLines().length).toBe(1); // データ 1 行のみ
  });

  it("wrap 列があっても全物理行が width を超えない (幅 40-200 sweep)", () => {
    const wrapCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 6, maxWidth: 10, cell: (r) => r.a },
      { header: "B", minWidth: 12, maxWidth: 80, wrap: true, cell: (r) => r.b },
    ];
    const longRow: TestRow = { a: "震度5弱", b: "青森県, 岩手県, 宮城県, 秋田県, 山形県, 福島県, 茨城県, 栃木県, 群馬県, 埼玉県" };
    for (let w = 40; w <= 200; w++) {
      const buf = createRenderBuffer();
      renderResponsiveTable(buf, "critical", w, wrapCols, [longRow]);
      for (const line of buf.getLines()) {
        expect(visualWidth(stripAnsi(line)), `width=${w} line=${stripAnsi(line)}`).toBeLessThanOrEqual(w);
      }
    }
  });

  it("mergeRepeated: 連続同値は 2 行目以降が空白セルになる", () => {
    const buf = createRenderBuffer();
    const mCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 8, maxWidth: 12, mergeRepeated: true, cell: (r) => r.a },
      { header: "B", minWidth: 6, maxWidth: 10, cell: (r) => r.b },
    ];
    renderResponsiveTable(buf, "warning", 40, mCols, [
      { a: "宮城県", b: "石巻" },
      { a: "宮城県", b: "女川" },
      { a: "岩手県", b: "宮古" },
    ]);
    const data = buf.getLines().slice(1).map(stripAnsi); // ヘッダ除く
    expect(data[0]).toContain("宮城県");
    expect(data[1]).not.toContain("宮城県"); // 2 行目は空白
    expect(data[1]).toContain("女川");
    expect(data[2]).toContain("岩手県"); // 値が変われば再表示
  });

  it("mergeRepeated: merge で空白化した行は ClipReport に記録されない (初回表示行のみ記録)", () => {
    const buf = createRenderBuffer();
    // maxWidth 8 に対し raw 値 (視覚幅 20) が確実に溢れる → 初回表示行は clip 記録される
    const mCols: ColumnSpec<TestRow>[] = [
      { header: "A", minWidth: 6, maxWidth: 8, mergeRepeated: true, cell: (r) => r.a },
      { header: "B", minWidth: 6, maxWidth: 10, cell: (r) => r.b },
    ];
    const long = "北海道太平洋沿岸東部";
    const report = renderResponsiveTable(buf, "warning", 40, mCols, [
      { a: long, b: "石巻" },
      { a: long, b: "女川" },
    ]);
    // row 0 (初回表示): clip 発生 → 記録あり
    expect(report.get(0)).toEqual({ A: true });
    // row 1 (merge で空白セル): clip 判定スキップ → 記録なし
    expect(report.has(1)).toBe(false);
  });
});

describe("collectDetailForTable (hidden-only, spec §2.4)", () => {
  interface R { area: string; time: string }
  it("hidden:true の列だけ回収し、clip されただけの列は回収しない", () => {
    const details: DetailItem[] = [];
    const rows: R[] = [{ area: "北海道太平洋沿岸東部という非常に長い地域名", time: "10:00" }];
    collectDetailForTable(
      rows,
      (r) => `【予報区】${r.area}`,
      [
        { header: "地域名", value: (r) => r.area, hidden: false }, // clip されても回収しない
        { header: "満潮時刻", value: (r) => r.time, hidden: true }, // 幅で隠れた列は回収する
      ],
      details,
    );
    expect(details.length).toBe(1);
    const body = details[0].body.join("\n");
    expect(body).toContain("満潮時刻: 10:00");
    expect(body).not.toContain("地域名:");
  });

  it("hidden 列が全て空値なら detail entry を作らない", () => {
    const details: DetailItem[] = [];
    collectDetailForTable(
      [{ area: "A", time: "" }],
      (r) => r.area,
      [{ header: "満潮時刻", value: (r) => r.time, hidden: true }],
      details,
    );
    expect(details.length).toBe(0);
  });
});
