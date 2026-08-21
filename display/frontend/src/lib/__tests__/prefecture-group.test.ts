import { describe, expect, it } from "vitest";
import {
  countByPrefecture,
  groupByPrefecture,
  groupByPrefectureOrRegion,
  PREFECTURES,
  PREFECTURE_BY_CODE,
  prefectureFromMunicipalityCode,
} from "../prefecture-group";

describe("groupByPrefecture", () => {
  it("県名を含む地域名を都道府県ごとにグループ化し、市区町村名だけを cities に残す", () => {
    const groups = groupByPrefecture(["宮崎県延岡市", "宮崎県日向市", "熊本県山鹿市"]);
    expect(groups).toEqual([
      { pref: "宮崎県", cities: ["延岡市", "日向市"] },
      { pref: "熊本県", cities: ["山鹿市"] },
    ]);
  });

  it("県名で始まらない地域名 (地方名等) は pref: null の「その他」バケツにまとめる", () => {
    const groups = groupByPrefecture(["宗谷地方", "石狩地方"]);
    expect(groups).toEqual([{ pref: null, cities: ["宗谷地方", "石狩地方"] }]);
  });

  it("県名そのもの (残りが空文字) は pref 行のみで cities を積まない", () => {
    const groups = groupByPrefecture(["茨城県"]);
    expect(groups).toEqual([{ pref: "茨城県", cities: [] }]);
  });

  it("「京都府」を「京都」+「府」に誤分割しない (完全名の前方一致)", () => {
    const groups = groupByPrefecture(["京都府京都市"]);
    expect(groups).toEqual([{ pref: "京都府", cities: ["京都市"] }]);
  });

  it("出現順を保持する (最初に登場した pref/その他の順)", () => {
    const groups = groupByPrefecture(["熊本県山鹿市", "宮崎県延岡市", "熊本県菊池市"]);
    expect(groups.map((g) => g.pref)).toEqual(["熊本県", "宮崎県"]);
  });
});

describe("groupByPrefectureOrRegion", () => {
  it("県名プレフィックスなしでも市区町村コードから都道府県を解決する", () => {
    const groups = groupByPrefectureOrRegion(["宮崎市", "都城市"], ["4520100", "4520200"]);
    expect(groups).toEqual([{ pref: "宮崎県", cities: ["宮崎市", "都城市"] }]);
  });

  it("コードなし旧形式は従来の県名完全前方一致へ fallback する", () => {
    const groups = groupByPrefectureOrRegion(["宮崎県延岡市", "宮崎県日向市"]);
    expect(groups).toEqual([{ pref: "宮崎県", cities: ["延岡市", "日向市"] }]);
  });

  it("不正コードや市区町村以外の地域コードは県名完全前方一致へ fallback する", () => {
    expect(groupByPrefectureOrRegion(["宮崎県延岡市"], ["invalid"]))
      .toEqual([{ pref: "宮崎県", cities: ["延岡市"] }]);
    expect(groupByPrefectureOrRegion(["能登北部"], ["390010"]))
      .toEqual([{ pref: "能登北部", cities: [] }]);
  });

  it("県名で始まらない地域名を「その他」1バケツにまとめず、地域ごとに県名見出しと同格の独立グループにする (backlog §1)", () => {
    const groups = groupByPrefectureOrRegion(["宗谷地方", "石狩地方"]);
    expect(groups).toEqual([
      { pref: "宗谷地方", cities: [] },
      { pref: "石狩地方", cities: [] },
    ]);
  });

  it("県名グループはそのまま素通しする", () => {
    const groups = groupByPrefectureOrRegion(["宮崎県延岡市", "宮崎県日向市"]);
    expect(groups).toEqual([{ pref: "宮崎県", cities: ["延岡市", "日向市"] }]);
  });

  it("県名グループと地方名グループが混在するとき、出現順を保ったまま並ぶ", () => {
    const groups = groupByPrefectureOrRegion(["熊本県山鹿市", "沖縄本島地方", "宮崎県延岡市"]);
    expect(groups.map((g) => g.pref)).toEqual(["熊本県", "沖縄本島地方", "宮崎県"]);
  });

  it("地方名グループが県グループを挟んで2つ出現しても、それぞれ入力順どおりの位置に独立して並ぶ (Codex P2 回帰: groupByPrefecture 委譲だと1バケツに先集約され順序が崩れていた)", () => {
    const groups = groupByPrefectureOrRegion(["沖縄本島地方", "熊本県山鹿市", "宗谷地方"]);
    expect(groups).toEqual([
      { pref: "沖縄本島地方", cities: [] },
      { pref: "熊本県", cities: ["山鹿市"] },
      { pref: "宗谷地方", cities: [] },
    ]);
  });
});

describe("prefectureFromMunicipalityCode", () => {
  it("標準 JIS 01〜47 を欠落なく 47 都道府県へ対応づける", () => {
    const codes = Array.from({ length: 47 }, (_, index) => String(index + 1).padStart(2, "0"));
    expect(new Set(Object.keys(PREFECTURE_BY_CODE))).toEqual(new Set(codes));
    expect(codes.map((code) => PREFECTURE_BY_CODE[code])).toEqual(PREFECTURES);
  });

  it("01〜47 の JIS 都道府県コードを 7 桁市区町村コードの先頭から解決する", () => {
    expect(prefectureFromMunicipalityCode("0110100")).toBe("北海道");
    expect(prefectureFromMunicipalityCode("4520100")).toBe("宮崎県");
    expect(prefectureFromMunicipalityCode("4720100")).toBe("沖縄県");
  });

  it("範囲外・桁不正・欠落は null にする", () => {
    expect(prefectureFromMunicipalityCode("0020100")).toBeNull();
    expect(prefectureFromMunicipalityCode("4820100")).toBeNull();
    expect(prefectureFromMunicipalityCode("452010")).toBeNull();
    expect(prefectureFromMunicipalityCode(undefined)).toBeNull();
  });
});

describe("countByPrefecture", () => {
  it("都道府県ごとの件数だけを数える (市区町村名は持たない)", () => {
    const counts = countByPrefecture(["高知県高知市", "高知県南国市", "愛知県名古屋市"]);
    expect(counts).toEqual([
      { pref: "高知県", count: 2 },
      { pref: "愛知県", count: 1 },
    ]);
  });

  it("県名そのもの (groupByPrefecture では cities に積まれない area) も 1 件として数える", () => {
    const counts = countByPrefecture(["茨城県", "茨城県水戸市"]);
    expect(counts).toEqual([{ pref: "茨城県", count: 2 }]);
  });

  it("県名で始まらない地域名は pref:null の「その他」として数える", () => {
    const counts = countByPrefecture(["宗谷地方", "石狩地方"]);
    expect(counts).toEqual([{ pref: null, count: 2 }]);
  });

  it("出現順を保持する", () => {
    const counts = countByPrefecture(["高知県高知市", "愛知県名古屋市", "高知県南国市"]);
    expect(counts.map((c) => c.pref)).toEqual(["高知県", "愛知県"]);
  });
});
