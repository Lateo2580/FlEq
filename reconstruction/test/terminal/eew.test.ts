import { describe, expect, it } from "vitest";

import { band, eewUnits, rule, terminal } from "./terminal-fixture";

// 期待の行の作り方: spec §5.1 の図の行の順・項目・区切りに、fixture の値を当てた（罫線は 80 桁に伸ばす）。
// 警報の図（作者のイメージ図、第2報・M6.6）は fixture に無い値なので、37_01_01（第1報・M5.8・深さ30km・長周期階級 1・9 地域）の値を当て、
// 前の報 77_01_01 の最大予測震度 3 と違うので「3 →」が付く。予報・最終報・PLUM・取消は図の値のまま。
describe("P3-TO-T01 緊急地震速報（spec §5.1 の図）", () => {
  it("予報→警報→取消を同じ端末に流すと図の行になり、取消の 3 行目は前の報の震源名と発表時刻。覚えの無い端末は EventID の時刻", () => {
    const print = terminal();
    const [forecast, warning, cancel] = eewUnits(["77_01_01_240613_VXSE45.xml", "37_01_01_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"]);
    expect(print(forecast)).toEqual([
      band("緊急地震速報（予報） 第1報", "23:14:57"),
      "震源: 豊後水道 ・ M4.2 ・ 深さ40km",
      "最大予測震度 3",
      rule(),
      "VXSE45 | 20240417231454",
    ]);
    expect(print(warning)).toEqual([
      band("緊急地震速報（警報） 第1報", "23:14:59"),
      "豊後水道で地震　四国　九州　中国で強い揺れ",
      "最大予測震度 3 → 5弱",
      "震源: 豊後水道 ・ M5.8 ・ 深さ30km ・ 長周期階級 1",
      rule(),
      "予測震度    地域          到達予想時刻  長周期階級",
      "5弱         愛媛県南予    到達済み",
      "4           高知県西部    23:15:02",
      "4           大分県南部    23:15:03",
      "4           大分県中部    23:15:04      階級1",
      "4           愛媛県中予    23:15:08",
      "4           大分県北部    23:15:09",
      "4           愛媛県東予    23:15:13",
      "4           山口県東部    23:15:13",
      "3〜4        広島県南西部  23:15:19",
      rule(),
      "VXSE43 | 20240417231454",
    ]);
    const cancelLines = [
      band("緊急地震速報（警報） 取消", "23:17:00"),
      "緊急地震速報（警報）を取り消します。",
      "取り消したのは 23:14:59 発表の豊後水道の地震です",
      rule(),
      "VXSE43 | 20240417231454",
    ];
    expect(print(cancel)).toEqual(cancelLines);
    // 新しい端末（覚えが無い）は図の 3 行目（EventID の時刻＝検知時刻）。
    const [alone] = eewUnits(["37_01_03_240613_VXSE43.xml"]);
    expect(terminal()(alone)).toEqual([...cancelLines.slice(0, 2), "取り消したのは 23:14 頃に検知した地震です", ...cancelLines.slice(3)]);
  });

  it("同じ EventID の訓練の報は通常の報の覚えを上書きせず、通常の取消の 3 行目は通常の報の震源名（覚えの鍵は operation と EventID）", () => {
    const training = { path: "37_01_01_240613_VXSE43.xml", transform: (xml: string) => xml.replace("<Status>通常</Status>", "<Status>訓練</Status>")
      .replace(/<Name>豊後水道<\/Name>/g, "<Name>訓練の震源</Name>").replace(/<ReportDateTime>[^<]*<\/ReportDateTime>/, "<ReportDateTime>2024-04-17T23:15:30+09:00</ReportDateTime>") };
    const print = terminal();
    const [warning, drill, cancel] = eewUnits(["37_01_01_240613_VXSE43.xml", training, "37_01_03_240613_VXSE43.xml"]);
    print(warning);
    expect(print(drill)[0]).toBe(band("緊急地震速報（警報）（訓練） 第1報", "23:15:30"));
    expect(print(cancel)[2]).toBe("取り消したのは 23:14:59 発表の豊後水道の地震です");
  });

  it("最終報と PLUM は図の行になる（見出し文の無い PLUM は震源の行が先、仮定の震源は M と深さを出さない）", () => {
    const [final] = eewUnits(["77_01_30_260101_VXSE45_FINAL.xml"]);
    expect(terminal()(final)).toEqual([
      band("緊急地震速報（予報） 第30報 最終報", "12:00:30"),
      "テスト地域で地震",
      "最大予測震度 4",
      "震源: テスト震源 ・ M5.0 ・ 深さ10km",
      rule(),
      "予測震度    地域          到達予想時刻  長周期階級",
      "4           テスト地域",
      rule(),
      "この情報をもって、緊急地震速報：最終報とします。",
      "VXSE45 | 20260101120000",
    ]);
    const [plum] = eewUnits(["77_02_01_260101_VXSE45_PLUM.xml"]);
    expect(terminal()(plum)).toEqual([
      band("緊急地震速報（予報） 第3報", "09:00:10"),
      "震源: 石川県能登地方（仮定の震源、PLUM法で推定）",
      "最大予測震度 5弱",
      rule(),
      "予測震度    地域          到達予想時刻  長周期階級",
      "5弱         石川県能登    PLUM法で推定",
      "4           富山県東部    到達済み",
      rule(),
      "VXSE45 | 20260101090005",
    ]);
  });
});
