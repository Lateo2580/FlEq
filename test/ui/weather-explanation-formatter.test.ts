import { describe, it, expect, afterEach } from "vitest";
import chalk from "chalk";
import { displayWeatherExplanation } from "../../src/ui/weather-explanation-formatter";
import { parseWeatherExplanation } from "../../src/dmdata/weather-explanation-parser";
import { setDisplayMode, clearFrameWidth, setFrameWidth, visualWidth } from "../../src/ui/formatter";
import {
  createMockWsDataMessage,
  FIXTURE_VPZJ51_SENJOU,
  FIXTURE_VPZJ51_TYPHOON,
  FIXTURE_VPCJ51_KANTO_SNOW,
  FIXTURE_VPFJ51_KANTO,
  FIXTURE_VMCJ53_OSHIO,
  FIXTURE_VMCJ55_FUKUSHINDO,
  FIXTURE_VMCJ55_OSHIO_CHIBA,
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

describe("displayWeatherExplanation - VPZJ51 全般 + 予想", () => {
  it("全般ラベル + 線状降水帯の県が表示される", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_SENJOU))!;
    const out = capture(() => displayWeatherExplanation(info));
    expect(out).toContain("全般気象解説情報");
    expect(out).not.toContain("地方気象解説情報");
    expect(out).toContain("高知県");
  });

  it("台風: 風/波/雨の値が出て、台風コード・地方ラベルは出ない", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    const out = capture(() => displayWeatherExplanation(info));
    expect(out).toContain("全般気象解説情報");
    expect(out).not.toContain("T2410");
    expect(out).toMatch(/22|25|35/); // 風速の値
    expect(out).toContain("うねり");
  });

  it.each([80, 100, 120])("幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    const out = capture(() => displayWeatherExplanation(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("予想テーブルがセクション見出し (▸) より左に飛び出さない", () => {
    setFrameWidth(100);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    expect(info.forecast?.fallback).toBe("none"); // テーブルがフル描画される前提
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const lines = out.split("\n");

    const heading = lines.find((l) => l.includes("▸ 予想"));
    expect(heading).toBeDefined();
    const headingCol = heading!.indexOf("▸");

    // テーブル罫線行 (┼ を含む) とヘッダ/データ行 (列区切り │ を内部に含む) を対象にする
    const tableLines = lines.filter(
      (l) => l.includes("┼") || /^.. +\S.* │ /.test(l),
    );
    expect(tableLines.length).toBeGreaterThan(0);
    for (const line of tableLines) {
      // 枠線 1 文字 + 空白 1 文字の後の本文開始桁が見出し ▸ の桁以上であること
      const content = line.slice(2);
      const indentWidth = content.length - content.trimStart().length;
      expect(2 + indentWidth).toBeGreaterThanOrEqual(headingCol);
    }
  });

  it("fallback=raw のとき予想詳細を抑制し省略注記を出す", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    // 実 fixture は予想規模が閾値内 (none) のため、raw 分岐を検証するには fallback を上書きする
    info.forecast!.fallback = "raw";
    const out = capture(() => displayWeatherExplanation(info));
    expect(out).toContain("省略");
    expect(out).not.toContain("うねり"); // 定量詳細セルが描画されない
  });

  it("fallback=compactOnly のとき件数サマリのみで定量詳細を出さない", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
    // 実 fixture は予想規模が閾値内 (none) のため、compactOnly 分岐を検証するには fallback を上書きする
    info.forecast!.fallback = "compactOnly";
    const out = capture(() => displayWeatherExplanation(info));
    expect(out).toContain("時間帯"); // 件数サマリ (例 "7 地域 × 2 時間帯")
    expect(out).toMatch(/\d+\s*地域\s*×\s*\d+\s*時間帯/);
    // 定量詳細テーブルのセル (例 "風速22"/"波高6"/"瞬間風速35") は描画されない。
    // ※ intro 散文には「うねり」等の語が含まれ得るため、値付きセルのパターンで判定する。
    expect(out).not.toMatch(/風速\d/);
    expect(out).not.toMatch(/波高\d/);
    expect(out).not.toMatch(/最大雨量\d/);
  });
});

describe("displayWeatherExplanation - VPCJ51 回帰", () => {
  it("地方ラベル維持・予想なし", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW))!;
    const out = capture(() => displayWeatherExplanation(info));
    expect(out).toContain("地方気象解説情報");
    expect(out).not.toContain("全般気象解説情報");
  });
});

describe("displayWeatherExplanation - VPFJ51 観測実況", () => {
  it("VPFJ51 観測実況セクションを描画 (台風 fixture 85_01_01)", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_KANTO);
    const info = parseWeatherExplanation(msg)!;
    expect(info).not.toBeNull();

    const out = capture(() => displayWeatherExplanation(info));
    const plain = stripAnsi(out);

    // 観測実況ヘッダ
    expect(plain).toContain("観測実況");
    // 三宅島が含まれる
    expect(plain).toContain("三宅島");
    // remark (観測史上１位) が含まれる
    expect(plain).toContain("観測史上１位");
  });

  it("観測実況の副見出しがセクション見出しより右、配下行がさらに右にインデントされる", () => {
    setFrameWidth(120);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPFJ51_KANTO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const lines = out.split("\n");

    // "│ " (枠線 + 空白) を除いた本文インデント幅
    const indentOf = (l: string): number => {
      const content = l.slice(2);
      return content.length - content.trimStart().length;
    };

    const heading = lines.find((l) => l.includes("▸ 観測実況"));
    expect(heading).toBeDefined();
    const headingIndent = indentOf(heading!);

    // 副見出し行 (element ヘッダ「雨の実況」「風の実況」) — 見出し (2) より深い 4 以上
    const subheads = lines.filter((l) => /^│ \s*(雨|風|雪)の実況/.test(l));
    expect(subheads.length).toBeGreaterThanOrEqual(2);
    for (const l of subheads) {
      expect(indentOf(l)).toBeGreaterThanOrEqual(4);
      expect(indentOf(l)).toBeGreaterThan(headingIndent);
    }
    const subheadIndent = indentOf(subheads[0]);

    // 配下行 (観測点行「三宅島 …」) — 副見出し (4) よりさらに深い 6 以上
    const stations = lines.filter((l) => /^│ \s*三宅島/.test(l));
    expect(stations.length).toBeGreaterThan(0);
    for (const l of stations) {
      expect(indentOf(l)).toBeGreaterThanOrEqual(6);
      expect(indentOf(l)).toBeGreaterThan(subheadIndent);
    }
  });

  it.each([60, 80, 120])("VPFJ51: 幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPFJ51_KANTO))!;
    const out = capture(() => displayWeatherExplanation(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("VPFJ51 WindPart の WindDirection + WindSpeed を 1 行に併記", () => {
    const msg = createMockWsDataMessage(FIXTURE_VPFJ51_KANTO);
    const info = parseWeatherExplanation(msg)!;
    expect(info).not.toBeNull();

    const out = capture(() => displayWeatherExplanation(info));
    const plain = stripAnsi(out);

    // 三宅島の風行で「北東」(風向) と数字 (風速) が同じ行に出る
    const lines = plain.split("\n");
    const windLine = lines.find((l) => l.includes("三宅島") && l.includes("北東"));
    expect(windLine).toBeDefined();
    // 風速値 (数字) が含まれる
    expect(windLine!).toMatch(/\d/);
  });
});

describe("displayWeatherExplanation - VPFJ51 Becoming/Local/WindDirection 描画", () => {
  it("Becoming 連鎖 + Local ' 海上' + WindDirection (value=null) が cell 文字列に畳み込まれる", () => {
    // synthetic/vpfj51_becoming_chain.xml:
    //   Base 北東 + Becoming "のち" 東 + Becoming "のち" 南
    //   + Local "海上" の Becoming "ときどき" 南東
    // → "北東 のち 東 のち 南 / [海上] ときどき 南東" 相当が出ること
    const msg = createMockWsDataMessage("synthetic/vpfj51_becoming_chain.xml", {
      head: {
        type: "VPFJ51",
        author: "気象庁",
        time: new Date().toISOString(),
        test: false,
        xml: true,
      },
    });
    const info = parseWeatherExplanation(msg)!;
    expect(info).not.toBeNull();
    expect(info.forecast).not.toBeNull();

    const out = capture(() => displayWeatherExplanation(info));
    const plain = stripAnsi(out);

    // Base WindDirection (raw="北東") — value=null だが raw fallback で描画される
    expect(plain).toContain("北東");
    // Becoming modifier がそのまま語頭に出る
    expect(plain).toContain("のち");
    // Becoming "のち" 東 / Becoming "のち" 南
    expect(plain).toMatch(/東/);
    expect(plain).toMatch(/南/);
    // Local AreaName が "[海上]" の形で描画される
    expect(plain).toContain("[海上]");
    // Local "海上" の Becoming "ときどき" modifier
    expect(plain).toContain("ときどき");
    // Local "海上" の値 (raw="南東")
    expect(plain).toContain("南東");
  });
});

describe("displayWeatherExplanation - VMCJ53-55 潮位セクション", () => {
  it("VMCJ55 の潮位実況・予想の値が表示される (対応セクションへ統合)", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    // 値は「▸ 観測実況」「▸ 予想: 次の満潮・干潮時刻」配下に統合される (指摘 #3)
    expect(out).toContain("観測実況");
    expect(out).toContain("苫小牧東（港湾局）");
    expect(out).toContain("１９日１２時２０分ごろ　約８０センチ　約６０分");
    expect(out).toContain("▸ 予想: 次の満潮・干潮時刻");
    expect(out).toContain("満潮時刻");
  });

  it("VMCJ55 (千葉・大潮) は満潮/干潮の区別が表示される", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_OSHIO_CHIBA))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    // 89_02 は Sentence に満潮/干潮の語が無いため levelType で補う。
    // ヘッドライン散文にも「満潮」があるため、補助ラベルと 89_02 固有 Sentence の
    // 隣接 (「満潮 ０１時０１分」) を直接検証する (幅 80 で当該行は折り返されない)
    expect(out).toContain("満潮 ０１時０１分");
    // timeName (日付) も出ること (TimeDefine Name は "７月　４日" 形式)
    expect(out).toContain("７月　４日");
  });

  it("VMCJ55 (副振動) は Sentence に満潮の語が既にあるため二重表記しない", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    // levelType 補助 ("満潮 ") が Sentence 「満潮時刻　…」の前に重ねて出ない
    expect(out).not.toMatch(/満潮\s+満潮時刻/);
  });

  it("VMCJ55 (副振動): 観測実況セクションの直下に実況値が出る (指摘 #3)", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const obsHeading = out.indexOf("▸ 観測実況");
    // 実況値 Sentence (fixture 内で一意。「約８０センチ」はヘッドラインにも出るため使わない)
    const obsValue = out.indexOf("１９日１２時２０分ごろ");
    const bousai = out.indexOf("▸ 防災事項");
    expect(obsHeading).toBeGreaterThanOrEqual(0);
    expect(obsValue).toBeGreaterThan(obsHeading);
    expect(obsValue).toBeLessThan(bousai); // 値が観測実況〜防災事項の間にある
    expect(out).not.toContain("▸ 潮位実況"); // standalone 見出しが消える
  });

  it("VMCJ55 (副振動): 観測実況の見出しは 1 回だけ出る (解説+気象要素の Text 2 本は同一グループ)", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const matches = out.match(/▸ 観測実況/g) ?? [];
    expect(matches.length).toBe(1);
    // 解説と気象要素の両テキストがその見出しの下に残っていること
    // (気象要素キャプションは幅 80 で折り返されるため、枠線・空白を畳んで照合する)
    expect(out).toContain("１９日１３時０５分までに観測された");
    const flat = out.replace(/[│\n\s]/g, "");
    expect(flat).toContain("観測された海面昇降の山から谷の高さの最大値の発生時刻と高さ及び周期（速報値）");
    // tidal 実況値も引き続き観測実況グループ内 (防災事項より前)
    const value = out.indexOf("１９日１２時２０分ごろ");
    expect(value).toBeGreaterThan(out.indexOf("▸ 観測実況"));
    expect(value).toBeLessThan(out.indexOf("防災事項"));
  });

  it("VMCJ55 (副振動): 予想見出しの直下に満潮・干潮時刻が出る (指摘 #3)", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const intro = out.indexOf("次の満潮・干潮時刻は、以下のとおりです。");
    const first = out.indexOf("満潮時刻　１９日１７時０２分");
    const last = out.indexOf("干潮時刻　１９日２３時３９分");
    expect(intro).toBeGreaterThanOrEqual(0);
    expect(first).toBeGreaterThan(intro); // 「以下のとおりです」の直下に値が来る
    expect(last).toBeGreaterThan(first); // 4 行 (苫小牧東×2 + 苫小牧西×2) 全てが後続
    expect(out).not.toContain("▸ 潮位予想"); // standalone 見出しが消える
  });

  it("VMCJ55 (千葉・大潮): 予想見出しの直下に標高潮位が出る (指摘 #3)", () => {
    setFrameWidth(80);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_OSHIO_CHIBA))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    const heading = out.indexOf("▸ 予想: 予想される満潮時刻及び平常時の潮位");
    const value = out.indexOf("満潮 ０１時０１分");
    expect(heading).toBeGreaterThanOrEqual(0);
    expect(value).toBeGreaterThan(heading); // 見出しの直下 (後) に値が来る
    expect(out).not.toContain("▸ 潮位予想"); // standalone 見出しが消える
  });

  it("NO_COLOR snapshot: VMCJ53 大潮 / VMCJ55 副振動 / VMCJ55 千葉・大潮", () => {
    setFrameWidth(80);
    for (const fx of [FIXTURE_VMCJ53_OSHIO, FIXTURE_VMCJ55_FUKUSHINDO, FIXTURE_VMCJ55_OSHIO_CHIBA]) {
      const info = parseWeatherExplanation(createMockWsDataMessage(fx))!;
      expect(stripAnsi(capture(() => displayWeatherExplanation(info)))).toMatchSnapshot();
    }
  });

  it.each([60, 80, 120])("VMCJ55: 幅 %i で全描画行の visualWidth が width 以下", (w) => {
    setFrameWidth(w);
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VMCJ55_FUKUSHINDO))!;
    const out = capture(() => displayWeatherExplanation(info));
    for (const line of out.split("\n")) {
      expect(visualWidth(stripAnsi(line))).toBeLessThanOrEqual(w);
    }
  });

  it("tidal 無し電文 (VPCJ51) では潮位セクションが出ない (回帰)", () => {
    const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPCJ51_KANTO_SNOW))!;
    const out = stripAnsi(capture(() => displayWeatherExplanation(info)));
    expect(out).not.toContain("潮位実況");
    expect(out).not.toContain("潮位予想");
  });
});

describe("displayWeatherExplanation - Phase D 罫線色割れ回帰", () => {
  it("forecast テーブル罫線に frameNormal (sky) 色が混入しない (borderColor 透過)", () => {
    // pushFrameTable へ borderColor を渡し忘れると、テーブル罫線だけ
    // frameNormal = sky rgb(86,180,233) で描かれて本文 (WHITE_BORDER #e8e8e8) と
    // 色割れする。stripAnsi 後の構造比較では検出できないため、ANSI シーケンスを直接見る。
    const prevLevel = chalk.level;
    chalk.level = 3;
    try {
      setFrameWidth(100);
      const info = parseWeatherExplanation(createMockWsDataMessage(FIXTURE_VPZJ51_TYPHOON))!;
      // フル描画 (fallback=none → テーブルあり) であることの前提確認
      expect(info.forecast?.fallback).toBe("none");
      const out = capture(() => displayWeatherExplanation(info));
      // テーブルが実際に描画されていること (ヘッダ "地域" 列)
      expect(stripAnsi(out)).toContain("地域");
      // sky の truecolor シーケンスが出力のどこにも現れないこと
      expect(out).not.toContain("38;2;86;180;233");
    } finally {
      chalk.level = prevLevel;
    }
  });
});
