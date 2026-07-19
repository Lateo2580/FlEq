import { describe, it, expect } from "vitest";
import {
  typhoonAnalysisToText,
  typhoonProbabilityToText,
} from "../../../../src/engine/presentation/events/typhoon-to-text";
import { processTyphoonAnalysis } from "../../../../src/engine/presentation/processors/process-typhoon-analysis";
import { processTyphoonProbability } from "../../../../src/engine/presentation/processors/process-typhoon-probability";
import {
  createMockWsDataMessage,
  FIXTURE_VPTW60_2020,
  FIXTURE_VPTW62,
  FIXTURE_VPTW60_CANCEL,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPTA50_JANGMI_GONE,
} from "../../../helpers/mock-message";
import type { ParsedTyphoonAnalysis, TyphoonFrame } from "../../../../src/types";

/** 実況 frame を階級・確定座標・非対称風域つきで合成する (fixture が持たない項目の決定的検証用) */
function syntheticAnalysis(frame: Partial<TyphoonFrame>): ParsedTyphoonAnalysis {
  const base: TyphoonFrame = {
    kind: "実況",
    label: "実況",
    validTime: "2017-09-13T09:00:00+09:00",
    typhoonClass: { category: "台風(TS)", intensity: "非常に強い", size: "大型" },
    center: {
      location: "南大東島の南南東",
      coordinate: "北緯22.0度東経132.0度",
      forecastCircleRadiusKm: null,
      moveDirection: "北西",
      moveSpeedKmh: 20,
      pressureHpa: 940,
    },
    wind: {
      maxWindMs: 45,
      maxGustMs: 60,
      stormArea: { thresholdMs: 25, axes: [
        { direction: "南東", radiusKm: 300 },
        { direction: "北西", radiusKm: 150 },
      ] },
      galeArea: { thresholdMs: 15, axes: [{ direction: "全域", radiusKm: 600 }] },
      stormWarningArea: null,
    },
    ...frame,
  };
  return {
    type: "VPTW60", infoType: "発表", title: "台風解析", controlTitle: "台風解析・予報情報",
    infoKind: "台風解析・予報情報（５日予報）", infoKindVersion: "1.0_2",
    reportDateTime: "2017-09-13T09:00:00+09:00", publishingOffice: "気象庁",
    eventId: "TC1718", serial: "1", headline: null,
    name: { name: "TALIM", nameKana: "タリム", number: "1718", remark: null },
    frames: [base], isTest: false,
  };
}

function analysisText(fixture: string): string | null {
  const out = processTyphoonAnalysis(createMockWsDataMessage(fixture));
  expect(out).not.toBeNull();
  return typhoonAnalysisToText(out!.parsed);
}

function probabilityText(fixture: string): string | null {
  const out = processTyphoonProbability(createMockWsDataMessage(fixture));
  expect(out).not.toBeNull();
  return typhoonProbabilityToText(out!.parsed);
}

describe("typhoonAnalysisToText", () => {
  it("VPTW60 実況 fixture は文章体の実況行を出す (数値列挙でなく述語文)", () => {
    const text = analysisText(FIXTURE_VPTW60_2020);
    expect(text).not.toBeNull();
    expect(text).toContain("【実況】");
    // 地名付近 + 移動の文章体。座標・中心気圧は出さない
    expect(text).toContain("マリアナ諸島付近にあり");
    expect(text).toContain("進んでいます");
    expect(text).not.toContain("中心気圧");
    expect(text).not.toContain("北緯");
  });

  it("VPTW62 予報 fixture は文章体で見込みを出す (予報円半径は出さない)", () => {
    const text = analysisText(FIXTURE_VPTW62);
    expect(text).not.toBeNull();
    expect(text).toContain("【予報】");
    expect(text).toContain("見込みです");
    expect(text).not.toContain("予報円半径");
    expect(text).not.toContain("中心気圧");
  });

  it("予報は【予報】1 見出しの文章体 1 行に畳む (予報時点ごとの行列挙・改行を持たない、§2b)", () => {
    const text = analysisText(FIXTURE_VPTW60_2020);
    expect(text).not.toBeNull();
    // 予報時点ごとの【予報N時間後】見出しは立てない
    expect(text).not.toMatch(/【予報[^】]*時間後】/);
    // 予報部分は 1 行 = 予報見出し以降に改行を含まない
    const forecastPart = text!.slice(text!.indexOf("【予報】"));
    expect(forecastPart).not.toContain("\n");
    expect(forecastPart.startsWith("【予報】")).toBe(true);
  });

  it("予報は全時点を落とさず時刻付きで句点区切りに繋ぐ (§2b)", () => {
    const text = analysisText(FIXTURE_VPTW60_2020);
    // VPTW60 fixture は 12/24/48/72/96/120 時間後の 6 予報時点。文章体は「◯日◯時には、」で始める
    for (const t of ["29日03時には、", "29日15時には、", "30日15時には、", "1日15時には、", "2日15時には、", "3日15時には、"]) {
      expect(text).toContain(t);
    }
    // 予報部分は句点で区切られた複文になる
    const forecastPart = text!.slice(text!.indexOf("【予報】"));
    expect(forecastPart).toContain("。");
  });

  it("予報の階級は記号なしで主語化し変化時のみ出す (TS→TD、階級記号は落とす §2b)", () => {
    const text = analysisText(FIXTURE_VPTW60_2020);
    // TS(12h で変化) → ... → TD(120h で変化)。階級記号 (TS)/(TD) は主語に残さない
    const forecastPart = text!.slice(text!.indexOf("【予報】"));
    expect(forecastPart).not.toContain("(TS)");
    expect(forecastPart).not.toContain("(TD)");
    // 末尾で熱帯低気圧へ落ちた時点は記号なしの階級を主語に出す
    expect(forecastPart).toContain("熱帯低気圧は");
    // TS 帯は既定主語「台風は」で連呼を畳む
    expect(forecastPart).toContain("台風は");
  });

  it("述語が全欠損でも階級変化のある予報時点は「〜に変わる見込み」で残す (階級のみは落とさない)", () => {
    const fc = (over: Partial<TyphoonFrame>): TyphoonFrame => ({
      kind: "予報", label: "予報", validTime: "2020-09-29T03:00:00+09:00",
      typhoonClass: { category: null, intensity: null, size: null },
      center: {
        location: null, coordinate: null, forecastCircleRadiusKm: null,
        moveDirection: null, moveSpeedKmh: null, pressureHpa: null,
      },
      wind: null,
      ...over,
    });
    const info: ParsedTyphoonAnalysis = {
      ...syntheticAnalysis({}),
      frames: [
        // 発達 (TS へ): 移動あり → 通常の予報文
        fc({
          validTime: "2020-09-29T03:00:00+09:00",
          typhoonClass: { category: "台風(TS)", intensity: null, size: null },
          center: {
            location: null, coordinate: null, forecastCircleRadiusKm: 110,
            moveDirection: "北", moveSpeedKmh: 25, pressureHpa: 998,
          },
          wind: { maxWindMs: 18, maxGustMs: 25, stormArea: null, galeArea: null, stormWarningArea: null },
        }),
        // 述語ゼロ + 階級変化なし (TS のまま) → 落とす
        fc({
          validTime: "2020-10-02T15:00:00+09:00",
          typhoonClass: { category: "台風(TS)", intensity: null, size: null },
        }),
        // 述語ゼロ + 階級変化 (温低化) → 「熱帯低気圧に変わる見込みです」で残す
        fc({
          validTime: "2020-10-03T15:00:00+09:00",
          typhoonClass: { category: "熱帯低気圧(TD)", intensity: null, size: null },
        }),
      ],
    };
    const text = typhoonAnalysisToText(info);
    expect(text).not.toBeNull();
    const forecastPart = text!.slice(text!.indexOf("【予報】"));
    // 発達時点は通常の予報文
    expect(forecastPart).toContain("台風は北へ時速25kmで進み");
    // 述語ゼロ + 階級変化は階級のみの文で残す (記号は落とす)
    expect(forecastPart).toContain("3日15時には、熱帯低気圧に変わる見込みです。");
    expect(forecastPart).not.toContain("(TD)");
    // 述語ゼロ + 階級変化なしの時点 (2日15時) は落とす
    expect(forecastPart).not.toContain("2日15時には");
  });

  it("先頭予報が階級のみ・実況と同一階級なら変化断定せず落とす (prevClass に実況階級を引き継ぐ)", () => {
    const nowcast: TyphoonFrame = {
      kind: "実況", label: "実況", validTime: "2020-09-29T00:00:00+09:00",
      typhoonClass: { category: "台風(TS)", intensity: null, size: null },
      center: {
        location: "南大東島の南南東", coordinate: "北緯22.0度東経132.0度", forecastCircleRadiusKm: null,
        moveDirection: "北", moveSpeedKmh: 20, pressureHpa: 990,
      },
      wind: { maxWindMs: 20, maxGustMs: 30, stormArea: null, galeArea: null, stormWarningArea: null },
    };
    const forecastClassOnly: TyphoonFrame = {
      kind: "予報", label: "予報　１２時間後", validTime: "2020-09-29T15:00:00+09:00",
      typhoonClass: { category: "台風(TS)", intensity: null, size: null },
      center: {
        location: null, coordinate: null, forecastCircleRadiusKm: null,
        moveDirection: null, moveSpeedKmh: null, pressureHpa: null,
      },
      wind: null,
    };
    const info: ParsedTyphoonAnalysis = { ...syntheticAnalysis({}), frames: [nowcast, forecastClassOnly] };
    const text = typhoonAnalysisToText(info);
    expect(text).not.toBeNull();
    expect(text).toContain("【実況】");            // 実況行は出る
    expect(text).not.toContain("に変わる見込み");   // 実況と同一階級なので変化断定しない
    expect(text).not.toContain("【予報】");         // 唯一の予報時点が落ち予報行ごと消える
  });

  it("先頭予報が階級のみ・実況から変化なら「〜に変わる見込み」を出す", () => {
    const nowcast: TyphoonFrame = {
      kind: "実況", label: "実況", validTime: "2020-09-29T00:00:00+09:00",
      typhoonClass: { category: "台風(TS)", intensity: null, size: null },
      center: {
        location: "南大東島の南南東", coordinate: "北緯22.0度東経132.0度", forecastCircleRadiusKm: null,
        moveDirection: "北", moveSpeedKmh: 20, pressureHpa: 990,
      },
      wind: { maxWindMs: 20, maxGustMs: 30, stormArea: null, galeArea: null, stormWarningArea: null },
    };
    const forecastDecay: TyphoonFrame = {
      kind: "予報", label: "予報　１２０時間後", validTime: "2020-10-03T15:00:00+09:00",
      typhoonClass: { category: "熱帯低気圧(TD)", intensity: null, size: null },
      center: {
        location: null, coordinate: null, forecastCircleRadiusKm: null,
        moveDirection: null, moveSpeedKmh: null, pressureHpa: null,
      },
      wind: null,
    };
    const info: ParsedTyphoonAnalysis = { ...syntheticAnalysis({}), frames: [nowcast, forecastDecay] };
    const text = typhoonAnalysisToText(info);
    expect(text).not.toBeNull();
    expect(text).toContain("3日15時には、熱帯低気圧に変わる見込みです。");
    expect(text).not.toContain("(TD)");
  });

  it("予報末尾で最大風速 0 になった時点は風速句を出さない (§2b)", () => {
    const text = analysisText(FIXTURE_VPTW60_2020);
    expect(text).not.toContain("最大風速は0m/s");
    expect(text).not.toContain("最大風速0m/s");
  });

  it("取消は null (→ tickerSentence フォールバック)", () => {
    expect(analysisText(FIXTURE_VPTW60_CANCEL)).toBeNull();
  });

  it("frames 全空なら null", () => {
    const out = processTyphoonAnalysis(createMockWsDataMessage(FIXTURE_VPTW60_2020));
    const stripped = { ...out!.parsed, frames: [] };
    expect(typhoonAnalysisToText(stripped)).toBeNull();
  });

  it("実況は地名付近の文章体で座標 (北緯..東経..) を出さない", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({}));
    expect(text).toContain("南大東島の南南東付近にあり");
    expect(text).not.toContain("北緯22.0度");
  });

  it("階級 (強さ・大きさ) を冠した「〜の台風」を主語にし階級記号は落とす", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({}));
    expect(text).toContain("非常に強い大型の台風");
    expect(text).not.toContain("台風(TS)");
  });

  it("実況は暴風域を数値でなく「暴風域を伴って」と述語化し方位別半径を出さない", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({}));
    expect(text).toContain("暴風域を伴って北西へ時速20kmで進んでいます");
    expect(text).not.toContain("南東側300km");
    expect(text).not.toContain("強風域");
  });

  it("実況の風速は「最大風速は..、最大瞬間風速は..です」の文章体", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({}));
    expect(text).toContain("最大風速は45m/s、最大瞬間風速は60m/sです。");
  });

  it("予報 frame は数値半径でなく「暴風警戒域を伴う見込み」に簡略化する", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      kind: "予報", label: "予報　１２時間後",
      // 階級変化なし (前時点と同一) の主語「台風は」を検証したいので階級を持たせない
      typhoonClass: { category: null, intensity: null, size: null },
      center: {
        location: null, coordinate: null, forecastCircleRadiusKm: 110,
        moveDirection: "北", moveSpeedKmh: 25, pressureHpa: 950,
      },
      wind: {
        maxWindMs: 40, maxGustMs: 55, stormArea: null, galeArea: null,
        stormWarningArea: { thresholdMs: 25, axes: [{ direction: "全域", radiusKm: 220 }] },
      },
    }));
    expect(text).toContain("台風は北へ時速25kmで進み、最大風速は40m/s、最大瞬間風速は55m/sで、暴風警戒域を伴う見込みです。");
    expect(text).not.toContain("予報円半径");
    expect(text).not.toContain("220km");
  });

  // ── 欠損フォールバック ──────────────────────────────

  it("地名なし実況は確定座標を「北緯..・東経..付近」に整えて位置にする", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      center: {
        location: null, coordinate: "北緯22.0度東経132.0度", forecastCircleRadiusKm: null,
        moveDirection: "北西", moveSpeedKmh: 20, pressureHpa: 940,
      },
    }));
    expect(text).toContain("北緯22.0度・東経132.0度付近にあり");
  });

  it("最大瞬間風速なしは「最大風速は..です」だけにする", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      wind: {
        maxWindMs: 45, maxGustMs: null,
        stormArea: { thresholdMs: 25, axes: [{ direction: "全域", radiusKm: 200 }] },
        galeArea: null, stormWarningArea: null,
      },
    }));
    expect(text).toContain("最大風速は45m/sです。");
    expect(text).not.toContain("最大瞬間風速");
  });

  it("暴風域なしは「暴風域を伴って」を出さず移動句だけにする", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      wind: {
        maxWindMs: 30, maxGustMs: 40, stormArea: null, galeArea: null, stormWarningArea: null,
      },
    }));
    expect(text).toContain("南大東島の南南東付近にあり、北西へ時速20kmで進んでいます。");
    expect(text).not.toContain("暴風域を伴って");
  });

  it("位置も移動もなしは「〜の台風です。」の独立文に落とす", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      center: {
        location: null, coordinate: null, forecastCircleRadiusKm: null,
        moveDirection: null, moveSpeedKmh: null, pressureHpa: null,
      },
      wind: null,
    }));
    expect(text).toContain("【実況】非常に強い大型の台風です。");
  });

  it("速度 0/欠損で方向だけなら「〜へ進んでいます」にする", () => {
    const text = typhoonAnalysisToText(syntheticAnalysis({
      center: {
        location: "南大東島の南南東", coordinate: "北緯22.0度東経132.0度", forecastCircleRadiusKm: null,
        moveDirection: "北西", moveSpeedKmh: 0, pressureHpa: 940,
      },
      wind: null,
    }));
    expect(text).toContain("南大東島の南南東付近にあり、北西へ進んでいます。");
    expect(text).not.toContain("時速");
  });
});

describe("typhoonProbabilityToText", () => {
  it("VPTA50 DAMREY は上位 5 府県に要約し最上位のみピーク時刻を添える", () => {
    const text = probabilityText(FIXTURE_VPTA50_DAMREY);
    expect(text).not.toBeNull();
    // 注記は「5日以内」に簡略化
    expect(text).toContain("暴風域に入る確率（5日以内）");
    // 地名は府県名 (prefName)。上位 5 府県 (確率降順)。最上位にだけ「◯日◯時ごろ」
    expect(text).toContain("奄美地方 100%（1日18時ごろ）");
    expect(text).toContain("沖縄本島地方 100%");
    expect(text).toContain("長崎県 99%");
    // 残りは「ほか◯府県。」に畳む (active 45 府県 → 上位 5 → 残 40)
    expect(text).toContain("、ほか40府県。");
    // 2 位以降にはピーク時刻を付けない
    expect(text).toMatch(/沖縄本島地方 100%[、。]/);
    // 市区町村名 (worstRegion.areaName) は前置しない
    expect(text).not.toContain("北部");
  });

  it("VPTA50 は上位 6 位以降の府県名を列挙しない (要約)", () => {
    const text = probabilityText(FIXTURE_VPTA50_DAMREY);
    expect(text).not.toBeNull();
    // 上位 5 のあとは個別府県名を出さず件数に畳む
    expect(text).toContain("熊本県 99%");   // 5 位までは出る
    expect(text).not.toContain("福岡県");   // 6 位以降は出さない
  });

  it("JANGMI_GONE (暴風域消滅 = active 0 件) は null", () => {
    expect(probabilityText(FIXTURE_VPTA50_JANGMI_GONE)).toBeNull();
  });
});
