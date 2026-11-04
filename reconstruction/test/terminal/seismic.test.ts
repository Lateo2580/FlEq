import { describe, expect, it } from "vitest";

import { depthText, magnitudeText, seismicLevel } from "../../src/terminal/format";
import { terminalReport } from "../../src/terminal/material";
import { band, decodeFixture, reportOf, reportUnit, rule, terminal } from "./terminal-fixture";

const seismic = (path: string) => {
  const report = reportOf(path, "U-Q");
  if (report.kind !== "seismic") throw new Error(report.kind);
  return report;
};
const print = (path: string) => terminal()([reportUnit(seismic(path))]);

// 期待の行の作り方: spec §5.2 の図の行の順・項目・区切りに fixture の値を当て、罫線は 80 桁、地域の一覧と電文の文は 80 桁で折り返した。
// 図と fixture の値が違う所: VXSE51 の図は別の地震（2010-07-05）なので 32-35_07_01 の値を当てた。VXSE53・VXSE52 は Status が「訓練」なので
// 帯の題名に「（訓練）」が付く（P3-TO-D-STATUS-MARK、作者裁定 A。図は通常の報を描いた）。VXSE62 の階級の中の並びは図のとおり名前順（旧築と同じ）。
describe("P3-TL-T03 地震（spec §5.2 の図）", () => {
  it("5 つの fixture が図の形の行になり、VXSE53 の帯は warning", () => {
    expect(print("32-35_01_03_240613_VXSE53.xml")).toEqual([
      "",
      band("震源・震度に関する情報（訓練）", "13:50:00"),
      "最大震度 5弱  静岡県伊豆　静岡県中部",
      "この地震による津波の心配はありません。",
      "震源: 駿河湾 ・ M5.9 ・ 深さ10km ・ 発生 13:45ころ",
      rule(),
      "震度    地域",
      "5弱     静岡県伊豆　静岡県中部",
      "4       静岡県東部　静岡県西部　神奈川県東部　神奈川県西部　山梨県中・西部",
      "3       山梨県東部・富士五湖　埼玉県南部　千葉県南部　東京都２３区　神津島",
      "        伊豆大島　新島　長野県南部　愛知県東部　愛知県西部",
      rule(),
      "１日１３時４５分ころ、地震がありました。各地の震度をお知らせします。",
      "VXSE53 ・ ID 20091001134500",
    ]);
    expect(seismicLevel(seismic("32-35_01_03_240613_VXSE53.xml"))).toBe("warning");
    expect(print("32-35_07_01_100915_VXSE51.xml")).toEqual([
      "",
      band("震度速報", "05:09:00"),
      "最大震度 6弱  静岡県中部　静岡県西部",
      "震源: 調査中 ・ 発生 05:07ころ",
      rule(),
      "震度    地域",
      "6弱     静岡県中部　静岡県西部",
      "5強     静岡県伊豆　静岡県東部",
      "4       千葉県南部　東京都２３区　新島　神奈川県東部　神奈川県西部",
      "        山梨県中・西部　山梨県東部・富士五湖　長野県中部　長野県南部",
      "        岐阜県美濃東部　愛知県西部",
      "3       千葉県北西部　東京都多摩東部　神津島　伊豆大島　三宅島　長野県北部",
      "        岐阜県飛騨　岐阜県美濃中西部　愛知県東部　群馬県北部　群馬県南部",
      "        埼玉県北部　埼玉県南部　埼玉県秩父　富山県東部　石川県加賀　福井県嶺北",
      "        福井県嶺南　三重県北部　滋賀県北部　滋賀県南部　奈良県",
      rule(),
      "１１日０５時０７分ころ、地震による強い揺れを感じました。",
      "震度３以上が観測された地域をお知らせします。",
      "VXSE51 ・ ID 20090811050711",
    ]);
    expect(print("32-35_01_02_240613_VXSE52.xml")).toEqual([
      "",
      band("震源に関する情報（訓練）", "13:48:00"),
      "震源: 駿河湾 ・ M6.6 ・ 深さ10km ・ 発生 13:45ころ",
      "この地震による津波の心配はありません。",
      rule(),
      "１日１３時４５分ころ、地震がありました。",
      "VXSE52 ・ ID 20091001134500",
    ]);
    expect(print("selected_xml/78_01_01_240613_VXSE62.xml")).toEqual([
      "",
      band("長周期地震動に関する観測情報", "02:33:10"),
      "最大長周期階級 3 ・ 最大震度 5弱",
      "震源: 岩手県沖 ・ M6.3 ・ 深さ30km ・ 発生 02:23ころ",
      rule(),
      "長周期階級  地域",
      "階級3       宮城県北部（震度4）",
      "階級1       岩手県内陸南部（震度3）　岩手県内陸北部（震度5弱）",
      "            青森県三八上北（震度4）　青森県津軽北部（震度3）",
      rule(),
      "２１日０２時２３分ころの地震により、長周期地震動階級３を観測した地域があります。",
      "以下の地域では、最大震度は４以下でしたが、大きな長周期地震動階級（階級３以上）を",
      "  観測しています。",
      "高層ビル高層階では非常に大きな揺れとなっていた可能性があります。",
      "宮城県北部",
      "長周期地震動についての詳しい情報は、以下のURL（気象庁ホームページ）からご確認く",
      "  ださい",
      "https://www.data.jma.go.jp/eew/data/ltpgm/202011211100000/index.html",
      "VXSE62 ・ ID 20201121023300",
    ]);
    expect(print("32-35_03_02_240613_VXSE61.xml")).toEqual([
      "",
      band("顕著な地震の震源要素更新のお知らせ", "08:55:00"),
      "震源: 駿河湾 ・ M6.5 ・ 深さ20km ・ 発生 05:07ころ",
      rule(),
      "平成２１年　８月１１日０６時４５分をもって、地震の発生場所と規模を更新します。",
      "VXSE61 ・ ID 20090811050711",
    ]);
  });

  it("未入電の区域が先頭の段に来ても、要点の最大震度の行に最大の段の地域が残る", () => {
    const base = seismic("32-35_01_03_240613_VXSE53.xml");
    const report = { ...base, areas: [{ name: "未入電地域", maxInt: "", maxIntCondition: "未入電", maxLgInt: null }, ...base.areas] };
    expect(terminal()([reportUnit(report)])[2]).toBe("最大震度 5弱  静岡県伊豆　静岡県中部");
  });

  it("発生の時刻が発表の日と違う日なら日を添える（transform で OriginTime を前日にした 1 報）", () => {
    const moved = terminalReport(decodeFixture("32-35_01_03_240613_VXSE53.xml", "replay", (xml) => xml.replace("2009-10-01T13:45:00", "2009-09-30T23:58:00")), "U-Q");
    expect(terminal()([reportUnit(moved!)])[4]).toBe("震源: 駿河湾 ・ M5.9 ・ 深さ10km ・ 発生 30日 23:58ころ");
  });
});

describe("P3-TO-T18 特殊値と取消を保持（spec:382 の B13）", () => {
  it("区域の段の特殊値・取消の帯・M と深さの特殊値", () => {
    const special = seismic("synthetic_phase4a_VXSE51_special.xml");
    const lines = terminal()([reportUnit(special)]);
    const cases: [string, unknown, unknown][] = [
      ["値が空で condition「未入電」の区域", lines.includes("未入電         未入電地域"), true],
      ["値が「5弱以上未入電」の区域", lines.includes("5弱以上未入電  本文定性地域"), true],
      ["Observation の MaxInt が値の空いた「5弱以上未入電」の帯", seismicLevel(special), "warning"],
      ["32-35_10_01 の取消の帯", seismicLevel(seismic("32-35_10_01_220510_VXSE51.xml")), "cancel"],
      ["M の不明（description）", magnitudeText({ raw: "NaN", description: "Ｍ８を超える巨大地震", condition: "不明" }), "M8を超える巨大地震"],
      ["深さ ごく浅い", depthText({ raw: "", description: "ごく浅い", condition: null }), "ごく浅い"],
      ["深さ 700km以上", depthText({ raw: "", description: "７００ｋｍ以上", condition: null }), "700km以上"],
    ];
    for (const [name, actual, expected] of cases) expect(actual, name).toBe(expected);
  });
});
