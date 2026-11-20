import { describe, expect, it } from "vitest";

import { band, eewUnits, filled, plain, rule, terminal } from "./terminal-fixture";

// 期待の行の作り方: spec §5.1 の図の行の順・項目・区切りに、fixture の値を当てた（罫線は 80 桁に伸ばす）。
// 図の警報（第2報・M6.6）は 37_01_02 の実物で、前の報（37_01_01）の値からの変化が「旧 → 新」になる。予報・最終報・PLUM・取消は図の値のまま。
describe("P3-TL-T01 緊急地震速報（spec §5.1 の図）", () => {
  it("警報の第1報→第2報は値の場所に「旧 → 新」が付いた図の行で、取消の 3 行目は前の報の震源名と発表時刻。覚えの無い端末は EventID の時刻", () => {
    const print = terminal();
    const [first, second, cancel] = eewUnits(["37_01_01_240613_VXSE43.xml", "37_01_02_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"]);
    print(first);
    const lines = print(second);
    expect(lines.slice(0, 11)).toEqual([
      "",
      band("緊急地震速報（警報） 第2報", "23:15:10"),
      "最大予測震度 5弱 →  6弱  愛媛県南予",
      "四国　九州　中国で強い揺れ",
      "強い揺れに警戒してください。",
      "震源: 豊後水道 ・ M5.8 →  6.6 ・ 深さ30km →  40km ・ 長周期階級 1 →  2",
      rule(),
      "予測震度    地域              到達予想時刻  長周期階級",
      "6弱         愛媛県南予        23:15:04      階級1",
      "5強         高知県西部        23:15:05      階級1",
      "5弱         大分県南部        到達と推測    階級1",
    ]);
    expect(lines.slice(-4)).toEqual([rule(), "最大予測震度 6弱  愛媛県南予", "強い揺れに警戒してください。（23:15:10 発表）", "VXSE43 ・ ID 20240417231454"]);
    expect(print(cancel)).toEqual(["", band("緊急地震速報（警報） 取消", "23:17:00"), "緊急地震速報（警報）を取り消します。",
      "取り消したのは 23:15:10 発表の豊後水道の地震です", "VXSE43 ・ ID 20240417231454"]);
    // 覚えの無い端末（37_01_03 だけ）は図の 3 行目（EventID の時刻＝検知時刻）。
    expect(terminal()(eewUnits(["37_01_03_240613_VXSE43.xml"])[0])[3]).toBe("取り消したのは 23:14 頃に検知した地震です");
  });

  it("予報の第1報・最終報・PLUM は図の行（見出し文が空の報は要点が 2 行、仮定の震源は M と深さを出さない、表が要点の繰り返しなら出さない）", () => {
    expect(terminal()(eewUnits(["77_01_01_240613_VXSE45.xml"])[0])).toEqual([
      "", band("緊急地震速報（予報） 第1報", "23:14:57"), "最大予測震度 3", "震源: 豊後水道 ・ M4.2 ・ 深さ40km", "VXSE45 ・ ID 20240417231454"]);
    expect(terminal()(eewUnits(["77_01_30_260101_VXSE45_FINAL.xml"])[0])).toEqual([
      "", band("緊急地震速報（予報） 第30報 最終報", "12:00:30"), "最大予測震度 4  テスト地域", "テスト地域で地震", "震源: テスト震源 ・ M5.0 ・ 深さ10km",
      rule(), "この情報をもって、緊急地震速報：最終報とします。", "VXSE45 ・ ID 20260101120000"]);
    expect(terminal()(eewUnits(["77_02_01_260101_VXSE45_PLUM.xml"])[0])).toEqual([
      "", band("緊急地震速報（予報） 第3報", "09:00:10"), "最大予測震度 5弱  石川県能登", "震源: 石川県能登地方（仮定の震源、PLUM法で推定）", rule(),
      "予測震度    地域          到達予想時刻", "5弱         石川県能登    PLUM法で推定", "4           富山県東部    到達と推測", rule(),
      "VXSE45 ・ ID 20260101090005"]);
  });

  it("色ありの 80 桁は、警報の帯を塗り、帯の下の行を縦線の 2 桁の分だけ右端を縮めて出す", () => {
    const [first] = eewUnits(["37_01_01_240613_VXSE43.xml"]);
    const colorless = terminal()(first);
    expect(terminal(80, 3)(first).map(plain)).toEqual(["", filled("緊急地震速報（警報） 第1報", "23:14:59"),
      ...colorless.slice(2).map((text) => `  ${text.startsWith("─") ? rule(78) : text}`)]);
  });
});

// 続報の変化（P3-TL-AC05）。77_01_03（予報）→77_01_04（警報）→77_01_05 は同じ EventID の VXSE45 で、値が変わった場所にだけ矢印が付く。
describe("P3-TL-T02 続報の変化", () => {
  it("変わった値の場所に「旧 → 新」が付き、変わらない値・地域の件数・比較の文は何も出さない。長周期階級は旧が無ければ矢印なし", () => {
    const print = terminal();
    const [third, fourth, fifth] = eewUnits(["77_01_03_240613_VXSE45.xml", "77_01_04_240613_VXSE45.xml", "77_01_05_240613_VXSE45.xml"]);
    print(third);
    const four = print(fourth), five = print(fifth);
    expect(four.slice(2, 6)).toEqual(["最大予測震度 4 →  5弱  愛媛県南予", "四国　九州　中国で強い揺れ", "強い揺れに警戒してください。", "震源: 豊後水道 ・ M5.1 →  5.8 ・ 深さ30km ・ 長周期階級 1"]);
    expect(five.slice(2, 6)).toEqual(["最大予測震度 5弱  愛媛県南予", "四国　九州　中国で強い揺れ", "強い揺れに警戒してください。", "震源: 豊後水道 ・ M5.8 →  5.9 ・ 深さ30km →  40km ・ 長周期階級 1"]);
    expect([...four, ...five].filter((text) => /同じ|件/.test(text))).toEqual([]);
  });

  it("覚えの無い端末と、family の違う報（VXSE45 の第4報の後の VXSE43 の第1報）では矢印が出ない。PLUM の次の報は M と深さに矢印を付けない", () => {
    expect(terminal()(eewUnits(["77_01_04_240613_VXSE45.xml"])[0]).filter((text) => text.includes("→"))).toEqual([]);
    const print = terminal();
    const [pre, warning] = eewUnits(["77_01_04_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml"]);
    print(pre);
    expect(print(warning).filter((text) => text.includes("→"))).toEqual([]);
    const plum = terminal();
    const [assumed, mixed] = eewUnits(["77_02_01_260101_VXSE45_PLUM.xml", "77_02_02_260101_VXSE45_MIXED.xml"]);
    plum(assumed);
    expect(plum(mixed).slice(2, 4)).toEqual(["最大予測震度 5弱 →  6弱  石川県能登", "震源: 石川県能登地方 ・ M6.5 ・ 深さ10km"]);
  });

  it("PLUM の次の報で震源の名前が変わったら名前に矢印が付く（M と深さは覚えが無いので付かない）", () => {
    const print = terminal();
    const renamed = { path: "77_02_02_260101_VXSE45_MIXED.xml", transform: (xml: string) => xml.replace(/<Name>石川県能登地方<\/Name>/g, "<Name>能登半島沖</Name>") };
    const [assumed, mixed] = eewUnits(["77_02_01_260101_VXSE45_PLUM.xml", renamed]);
    print(assumed);
    expect(print(mixed)[3]).toBe("震源: 石川県能登地方 →  能登半島沖 ・ M6.5 ・ 深さ10km");
  });

  it("PLUM の次の報の長周期階級は、PLUM の報の階級からの矢印が付く", () => {
    const lg = (value: string) => (xml: string) => xml.replace(/<ForecastLgInt><From>0<\/From><To>0<\/To><\/ForecastLgInt>/g, `<ForecastLgInt><From>${value}</From><To>${value}</To></ForecastLgInt>`);
    const print = terminal();
    const [assumed, mixed] = eewUnits([{ path: "77_02_01_260101_VXSE45_PLUM.xml", transform: lg("2") }, { path: "77_02_02_260101_VXSE45_MIXED.xml", transform: lg("3") }]);
    print(assumed);
    expect(print(mixed)[3]).toBe("震源: 石川県能登地方 ・ M6.5 ・ 深さ10km ・ 長周期階級 2 →  3");
  });

  it("改行の入った見出し文でも例外にならず、改行は全角の空白になる", () => {
    const text = (xml: string) => xml.replace("<Text>豊後水道で地震　四国　九州　中国で強い揺れ</Text>", "<Text>四国\n九州で強い揺れ</Text>");
    const lines = terminal()(eewUnits([{ path: "37_01_01_240613_VXSE43.xml", transform: text }])[0]);
    expect(lines).toContain("四国　九州で強い揺れ");
  });

  // P3-TRL-T01（台帳 132）: 地方名の部分に CR・U+2028・U+2029 があると旧は例外で batch ごと出なかった。P3-TRL-D-BREAK=A で全角の空白に揃える。
  it("文字参照の CR・U+2028・U+2029 の入った見出し文でも例外にならず、全角の空白になる", () => {
    for (const mark of ["&#13;", "\u2028", "\u2029"]) {
      const text = (xml: string) => xml.replace("<Text>豊後水道で地震　四国　九州　中国で強い揺れ</Text>", `<Text>豊後水道で地震　四国${mark}九州　中国で強い揺れ</Text>`);
      expect(terminal()(eewUnits([{ path: "37_01_01_240613_VXSE43.xml", transform: text }])[0])).toContain("四国　九州　中国で強い揺れ");
    }
  });

  // P3-TRL-T02（台帳 133）: 見出し文の改行の揃えと行末の空白の消し（trimEnd）は空白の並びの長さに線形。旧はどちらも並びの開始位置ごとに読み直し、この報で片方だけ旧に戻すと 120〜170 ms、両方で約 0.3 秒。
  it("見出し文に半角空白 16,382 字の並びがあっても、整形 1 回（3 回の最小）は 100 ms 未満で、報が出る", () => {
    const text = (xml: string) => xml.replace("<Text>豊後水道で地震　四国　九州　中国で強い揺れ</Text>", `<Text>a${" ".repeat(16_382)}a</Text>`);
    const [units] = eewUnits([{ path: "37_01_01_240613_VXSE43.xml", transform: text }]);
    // 最初の整形は JIT が冷えていて遅いので、新しい端末で 3 回整形した最小と比べる（旧は最小でも数百 ms）。
    let lines: string[] = [];
    const times = [0, 1, 2].map(() => { const print = terminal(), started = performance.now(); lines = print(units); return performance.now() - started; });
    expect([Math.min(...times) < 100, lines[1]]).toEqual([true, band("緊急地震速報（警報） 第1報", "23:14:59")]);
  });

  it("同じ EventID の訓練の報は通常の報の覚えを上書きせず、通常の取消の 3 行目は通常の報の震源名（覚えの鍵は operation・family・EventID）", () => {
    const training = { path: "37_01_01_240613_VXSE43.xml", transform: (xml: string) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>")
      .replace(/<Name>豊後水道<\/Name>/g, "<Name>訓練の震源</Name>").replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2024-04-17T23:15:30+09:00</ReportDateTime>") };
    const print = terminal();
    const [warning, drill, cancel] = eewUnits(["37_01_01_240613_VXSE43.xml", training, "37_01_03_240613_VXSE43.xml"]);
    print(warning);
    expect(print(drill)[1]).toBe(band("緊急地震速報（警報）（訓練） 第1報", "23:15:30"));
    expect(print(cancel)[3]).toBe("取り消したのは 23:14:59 発表の豊後水道の地震です");
  });
});

// P3-TCC-T01（台帳 134）: 端末へ書く手前で電文の制御の字を替える（P3-TERMINAL-CONTROL-CHARS-001）。
describe("P3-TCC-T01 端末の制御の字", () => {
  // 旧は CR などを生で書き、端末は CR で行の頭へ戻って「強い揺れに」を上書きしうる。書く手前で半角の空白 1 字に替え、組みは空白を置いた報と同じ。
  it("行動の文に TAB・CR（文字参照）・U+0085・U+2028・U+2029・C1・DEL があっても生で書かず、同じ所に半角の空白を置いた報と同じ行になる", () => {
    const lines = (mark: string) => terminal(80, 3)(eewUnits([{ path: "37_01_01_240613_VXSE43.xml",
      transform: (xml: string) => xml.replace("<Text>強い揺れに警戒してください。</Text>", `<Text>強い揺れに${mark}警戒してください。</Text>`) }])[0]);
    const spaced = lines(" ");
    expect(spaced.map(plain)).toContain("  強い揺れに 警戒してください。");
    for (const mark of ["&#13;", "&#9;", "\u0085", "\u2028", "\u2029", "\u009b", "\u007f"]) {
      const shown = lines(mark);
      expect([mark, shown.some((text) => /[\t\r\u007f-\u009f\u2028\u2029]/.test(text)), shown]).toEqual([mark, false, spaced]);
    }
  });
});

// P3-TET-T02（台帳 136）: 文でない欄の LF は縦線の無い行を始めるので空白に替える。文の LF は段落の区切りのまま（P3-TERMINAL-EXTERNAL-TEXT-001）。
describe("P3-TET-T02 文でない欄の LF", () => {
  it("regression / AC02: 震源名の LF は空白 1 字になり「水道」で始まる行が無く、文の LF は別の行のまま", () => {
    const lines = terminal(80, 3)(eewUnits([{ path: "37_01_01_240613_VXSE43.xml",
      transform: (xml: string) => xml.replace("<Name>豊後水道</Name>", "<Name>豊後&#10;水道</Name>")
        .replace("<Text>強い揺れに警戒してください。</Text>", "<Text>強い揺れに&#10;警戒してください。</Text>") }])[0]).map(plain);
    expect([lines.includes("  震源: 豊後 水道 ・ M5.8 ・ 深さ30km ・ 長周期階級 1"), lines.some((text) => text.startsWith("水道")),
      lines.includes("  強い揺れに"), lines.includes("  警戒してください。")]).toEqual([true, false, true, true]);
  });
});

// P3-FRF-T01（R1）: 震度・長周期階級の字は表の key に電文のまま使うので、表は自分の key だけを引く（P3-FINAL-REVIEW-FIX-001）。
describe("P3-FRF-T01 震度と長周期階級の表引き", () => {
  it("regression / AC01: 予測震度が toString、長周期階級が constructor の報も例外を投げず、字のまま行になる", () => {
    const lines = (transform: (xml: string) => string) => terminal(80, 3)(eewUnits([{ path: "37_01_01_240613_VXSE43.xml", transform }])[0]).map(plain);
    const intensity = lines((xml) => xml.replace("<ForecastInt><From>5-</From><To>5-</To></ForecastInt>", "<ForecastInt><From>toString</From><To>toString</To></ForecastInt>"));
    const lg = lines((xml) => xml.replace(/<ForecastLgInt><From>1<\/From><To>1<\/To><\/ForecastLgInt>/g, "<ForecastLgInt><From>constructor</From><To>constructor</To></ForecastLgInt>"));
    expect([intensity.some((text) => text.includes("toString")), lg.some((text) => text.includes("constructor"))]).toEqual([true, true]);
  });
});
