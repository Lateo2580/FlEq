import { describe, expect, it } from "vitest";
import { extractTickerEmphasis } from "../../../src/engine/display/ticker-emphasis";
import { normalizeTickerBody } from "../../../src/engine/display/ticker-body-normalize";

import type { DisplayTickerPriority } from "../../../src/engine/display/types";

/** span の中身を本文から切り出して照合する小道具 (index が正しいことを本文実体で確かめる) */
function texts(body: string, priority?: DisplayTickerPriority): string[] {
  return extractTickerEmphasis(body, priority).map((s) => body.slice(s.start, s.end));
}

describe("extractTickerEmphasis", () => {
  it("震度・マグニチュード・M 表記を抽出する", () => {
    expect(texts("最大震度5弱を観測")).toEqual(["震度5弱"]);
    expect(texts("震度7の揺れ")).toEqual(["震度7"]);
    expect(texts("マグニチュード7.1と推定")).toEqual(["マグニチュード7.1"]);
    expect(texts("規模はM6.5")).toEqual(["M6.5"]);
  });

  it("波高・雨量・気圧・風速・確率の数値+単位を抽出する", () => {
    expect(texts("高いところで35メートル")).toEqual(["35メートル"]);
    expect(texts("120ミリの雨")).toEqual(["120ミリ"]);
    expect(texts("総雨量120mm")).toEqual(["120mm"]);
    expect(texts("中心気圧970hPa")).toEqual(["970hPa"]);
    expect(texts("最大風速25m/s")).toEqual(["25m/s"]);
    expect(texts("暴風域に入る確率99%")).toEqual(["99%"]);
  });

  it("1 本文中の複数マッチを左から順に返す", () => {
    const body = "中心気圧970hPa、最大風速25m/s、確率90%";
    expect(texts(body)).toEqual(["970hPa", "25m/s", "90%"]);
    const spans = extractTickerEmphasis(body);
    // start は昇順・重なりなし
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });

  it("m/s は素の m より優先し、単位を食い切る (alternation 並び順の回帰)", () => {
    expect(texts("風速20m/s")).toEqual(["20m/s"]);
    // 素の m は後続が英字なら讓る (mm/hPa の一部を誤取得しない)
    expect(texts("雨量30mm")).toEqual(["30mm"]);
  });

  it("km / km/h を抽出し、km/h は km より優先する (レビュー F2 回帰)", () => {
    expect(texts("予報円の半径150km")).toEqual(["150km"]);
    expect(texts("時速20km/hで北上")).toEqual(["20km/h"]);
    // km/h が km より前: "20km/h" を丸ごと取り、"/h" を残さない
    const spans = extractTickerEmphasis("北へ20km/h、半径150km");
    expect(spans.map((s) => "北へ20km/h、半径150km".slice(s.start, s.end))).toEqual(["20km/h", "150km"]);
  });

  it("PM2.5 の M2.5 を誤強調しない (M の前方境界、レビュー F4)", () => {
    expect(extractTickerEmphasis("PM2.5濃度が上昇")).toEqual([]);
    // 文頭・非英数字直後の正当な M 表記は従来どおり拾う
    expect(texts("規模はM6.5")).toEqual(["M6.5"]);
    expect(texts("M7.1の地震")).toEqual(["M7.1"]);
  });

  it("マッチが無ければ空配列 (日時・裸の数値は強調しない)", () => {
    expect(extractTickerEmphasis("2日00時にかけて北上する見込み")).toEqual([]);
    // 状態変化語・重要状態語を含まない気象文はそのまま空
    expect(extractTickerEmphasis("上空の寒気の影響で大気の状態が不安定")).toEqual([]);
    expect(extractTickerEmphasis("")).toEqual([]);
    expect(extractTickerEmphasis(null)).toEqual([]);
  });

  it("正規化 (全角→半角) 後の本文に対して index が整合する", () => {
    // 全角数字は normalizeTickerBody で半角化される。抽出はその後に噛ませる前提
    const normalized = normalizeTickerBody("最大震度５弱、中心気圧９７０ｈＰａ")!;
    expect(texts(normalized)).toEqual(["震度5弱", "970hPa"]);
  });

  it("素の m は波高メートルとして拾う (後続が非英数字なら成立)", () => {
    expect(texts("津波の高さ3m")).toEqual(["3m"]);
    // 後続が英字の語 (mode 等) は誤取得しない
    expect(extractTickerEmphasis("time5mode")).toEqual([]);
  });

  it("状態変化語 (発表/解除/再開) を複合語として拾う (単独語では拾わない)", () => {
    expect(texts("土砂災害危険警報を発表しています")).toEqual(["警報を発表"]);
    expect(texts("大雨警報を解除しました")).toEqual(["警報を解除"]);
    expect(texts("暴風注意報を発表します")).toEqual(["注意報を発表"]);
    expect(texts("地震情報の発表を再開しました")).toEqual(["発表を再開"]);
    // 「警報」「発表」単独 (動詞を伴わない) では拾わない
    expect(extractTickerEmphasis("警報の種類について")).toEqual([]);
    expect(extractTickerEmphasis("次回の発表予定は未定です")).toEqual([]);
  });

  it("特別警報は警報より長く同開始位置で勝ち、全体を強調する", () => {
    expect(texts("大雨特別警報を発表しました")).toEqual(["特別警報を発表"]);
  });

  it("重要状態語 (避難情報の官製用語) を拾う", () => {
    expect(texts("市町村から発令される避難指示などの情報に留意")).toEqual(["避難指示"]);
    expect(texts("高齢者等避難の発令の目安です")).toEqual(["高齢者等避難"]);
    expect(texts("緊急安全確保が発令された地域")).toEqual(["緊急安全確保"]);
  });

  it("mid では transition/status が出るが value (数値) は出ない", () => {
    expect(texts("暴風警報を発表しました", "mid")).toEqual(["警報を発表"]);
    expect(texts("避難指示が発令されました", "mid")).toEqual(["避難指示"]);
    // 数値+単位は low 専用ルールなので mid では拾わない
    expect(extractTickerEmphasis("最大風速25m/s", "mid")).toEqual([]);
    expect(texts("最大風速25m/s", "low")).toEqual(["25m/s"]);
  });

  it("1 文 3 個上限を超えたら transition > status > value の順で残す", () => {
    // 1 文に value×3 + status×1 + transition×1 = 5 個。上限 3 で transition→status→value 順に残る
    const body = "970hPa 25m/s 90% で避難指示、大雨警報を発表";
    const kept = texts(body, "low");
    // transition (警報を発表) と status (避難指示) が必ず残り、value は 1 個だけ残る
    expect(kept).toContain("警報を発表");
    expect(kept).toContain("避難指示");
    expect(kept.length).toBe(3);
    // start 昇順で返る
    const spans = extractTickerEmphasis(body, "low");
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end);
    }
  });

  it("上限は文 (「。」区切り) ごとに独立して効く", () => {
    // 2 文それぞれに value×3。文をまたいで合算されず各文 3 個まで残る
    const body = "970hPa 25m/s 90% を観測。150km 120mm 99% を予想。";
    expect(texts(body, "low").length).toBe(6);
  });
});
