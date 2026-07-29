import { describe, expect, it } from "vitest";
import {
  AVG_CITIES_PER_LINE,
  DETAIL_SECTION_HEADER_WEIGHT,
  EEW_STATIC_LIST_MAX,
  PAGE_CITY_BUDGET,
  STATIC_LIST_MAX,
  cityBudgetFromArea,
  effectiveAreaCount,
  isStackedLayout,
  paginateAreas,
  rowCapacity,
  sectionAvailableHeight,
  shouldPageDetails,
} from "../instrument-layout";
import { shouldCompactTopGroup, TOP_GROUP_COMPACT_AREA_THRESHOLD } from "../latest-quake-card-layout";
import type { DisplayIntensityGroupV1 } from "../protocol";

function group(intensity: string, rank: number, areas: string[], omittedAreaCount = 0): DisplayIntensityGroupV1 {
  return { intensity, rank, areas, omittedAreaCount };
}

function areasOfLength(count: number, prefix = "地域"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}`);
}

describe("effectiveAreaCount", () => {
  it("omittedAreaCount なしなら areas.length のまま", () => {
    expect(effectiveAreaCount(group("6強", 8, areasOfLength(20), 0))).toBe(20);
  });

  it("omittedAreaCount を加算する (areas 20 + omitted 15 = 35)", () => {
    expect(effectiveAreaCount(group("7", 9, areasOfLength(20), 15))).toBe(35);
  });
});

// T5c: ページ行容量の画面高さ駆動化 (spec §2-c)。rowCapacity は「実測px + JS算出」の純関数部分、
// cityBudgetFromArea はそれを観測震度の市町村数バジェットに換算する
describe("rowCapacity", () => {
  it("ぴったり割り切れるときはその行数", () => {
    expect(rowCapacity(240, 30, 8)).toBe(8);
  });

  it("端数は切り捨てる (floor)", () => {
    expect(rowCapacity(250, 30, 8)).toBe(8); // 250/30 = 8.33...
  });

  it("areaHeightPx が 0 なら fallback", () => {
    expect(rowCapacity(0, 30, 8)).toBe(8);
  });

  it("rowHeightPx が 0 なら fallback (ゼロ除算回避)", () => {
    expect(rowCapacity(240, 0, 8)).toBe(8);
  });

  it("負値は fallback へ安全側で倒す", () => {
    expect(rowCapacity(-10, 30, 8)).toBe(8);
    expect(rowCapacity(240, -30, 8)).toBe(8);
  });

  it("NaN は fallback へ安全側で倒す", () => {
    expect(rowCapacity(NaN, 30, 8)).toBe(8);
    expect(rowCapacity(240, NaN, 8)).toBe(8);
  });

  it("行高が領域高さを超えて行数0になるときも fallback (0 行のページャは無意味)", () => {
    expect(rowCapacity(10, 30, 8)).toBe(8);
  });

  it("実測値が有効な行数を導出するときは fallback を使わない", () => {
    expect(rowCapacity(600, 40, 8)).toBe(15);
  });
});

describe("cityBudgetFromArea", () => {
  it("未実測 (0,0) のときは PAGE_CITY_BUDGET と同値の fallback になる (jsdom clientHeight=0 対策)", () => {
    expect(cityBudgetFromArea(0, 0, PAGE_CITY_BUDGET)).toBe(PAGE_CITY_BUDGET);
  });

  it("実測値から行数 × AVG_CITIES_PER_LINE のバジェットを導出する", () => {
    // 行高 20px の領域 200px → 10 行 → 10 * AVG_CITIES_PER_LINE
    expect(cityBudgetFromArea(200, 20, PAGE_CITY_BUDGET)).toBe(10 * AVG_CITIES_PER_LINE);
  });

  it("バジェットは最小 1 を保証する (極端に小さい領域でも 0 にならない)", () => {
    expect(cityBudgetFromArea(1, 100, PAGE_CITY_BUDGET)).toBeGreaterThanOrEqual(1);
  });
});

// T6 (Codex レビュー M3 の最終解決、TsunamiPanel): 静的表示中のタイルは自身の実測がすでに
// 「全件が収まる自然高さ」を返すため、rowCapacity への入力にそのまま使うと自己参照になり
// 狭い画面でも needsPaging へ昇格できない。sectionAvailableHeight は「相手セクションの実測高さ
// + gap を .tiles 全高から差し引く」ことでこの自己参照を断ち切る純関数部分
describe("sectionAvailableHeight", () => {
  it("相手セクションの実測高さ + gap を差し引いた残りを返す", () => {
    expect(sectionAvailableHeight(600, 200, 16)).toBe(600 - 200 - 16);
  });

  it("差し引いた結果が負になるときは 0 に clamp する (rowCapacity の fallback ガードに委ねる)", () => {
    expect(sectionAvailableHeight(200, 400, 16)).toBe(0);
  });

  it(".tiles 自体が未実測 (0) なら 0 を返す (jsdom clientHeight=0 対策、rowCapacity の fallback へ)", () => {
    expect(sectionAvailableHeight(0, 0, 16)).toBe(0);
    expect(sectionAvailableHeight(-1, 0, 16)).toBe(0);
  });

  it("otherSectionCompetesForHeight=false (相手セクションが未マウント、または T6b: 横並びで縦方向に競合しない) のときは gap も引かず全高をそのまま返す", () => {
    expect(sectionAvailableHeight(600, 999, 16, false)).toBe(600);
  });

  it("静的表示中の『狭い領域』相当の測定値を渡すと、rowCapacity と組み合わせて昇格判定 (needsPaging) が真になる", () => {
    // TsunamiPanel の実運用値を模す: .tiles 実測 300px、相手 (観測) タイルが自然高さ 180px を
    // 消費、行高 24px、8 行分のデータがある狭い画面シナリオ。可用高さ 104px は 0 ではない
    // (rowCapacity の fallback ガードに落ちない) が、4 行分しか収まらず 8 行には足りない
    const available = sectionAvailableHeight(300, 180, 16);
    expect(available).toBe(104);
    const capacity = rowCapacity(available, 24, 8);
    expect(capacity).toBe(4);
    const needsPaging = 8 > capacity; // TsunamiPanel の needsPaging = coasts.length > coastRowCapacity と同型
    expect(needsPaging).toBe(true);
  });

  it("双方が同一の実測値を読み続ける限り、繰り返し呼び出しても値が変わらない (振動しない)", () => {
    // TsunamiPanel の実際の収束は ResizeObserver が実測 $state (leaf) を更新することで進むが、
    // この関数自体は純関数で「相手の実測値」を読むだけ・自分の計算結果を書き戻さない
    // (自己参照が無い) ため、同じ入力を何度呼んでも同じ出力になることを保証する
    const tilesHeight = 500;
    const coastsHeight = 220;
    const obsHeight = 260;
    const gap = 16;
    const coastsAvail1 = sectionAvailableHeight(tilesHeight, obsHeight, gap);
    const obsAvail1 = sectionAvailableHeight(tilesHeight, coastsHeight, gap);
    // 実測値 (coastsHeight/obsHeight) はこの関数の戻り値からは更新されない (呼び出し側の
    // ResizeObserver だけが更新する) ため、同じ引数で再計算しても同じ結果になる
    const coastsAvail2 = sectionAvailableHeight(tilesHeight, obsHeight, gap);
    const obsAvail2 = sectionAvailableHeight(tilesHeight, coastsHeight, gap);
    expect(coastsAvail2).toBe(coastsAvail1);
    expect(obsAvail2).toBe(obsAvail1);
  });
});

// T6b M-a (TsunamiPanel の `@container (min-width: 1200px)` 2 カラム grid 対応): container query
// の評価結果は JS から直接読めないため、2 tile の実測 top/bottom から縦積みかどうかを逆算する
describe("isStackedLayout", () => {
  it("後続要素の上端が先行要素の下端以降なら縦積み (stacked)", () => {
    // 予報区 tile: top 0 / bottom 200、観測 tile: top 216 (200 + gap16) → 縦積み
    expect(isStackedLayout(200, 216)).toBe(true);
  });

  it("後続要素の上端が先行要素の下端とちょうど同じでも縦積み (gap 0 の境界値)", () => {
    expect(isStackedLayout(200, 200)).toBe(true);
  });

  it("後続要素の上端が先行要素の下端よりずっと小さいなら横並び (grid 2 カラム、同じ行に並ぶ)", () => {
    // 予報区 tile: top 0 / bottom 400、観測 tile: top 0 (同じ行の隣カラム) → 横並び
    expect(isStackedLayout(400, 0)).toBe(false);
  });

  it("サブピクセルの丸め誤差 (既定 epsilon 1px) は縦積み判定を壊さない", () => {
    // 本来ぴったり隣接 (top===bottom) のはずが計測誤差で 0.6px だけ食い込んだケース
    expect(isStackedLayout(200, 199.4)).toBe(true);
  });

  it("epsilon を超えて食い込んでいれば横並びと判定する (誤差ではなく本当に重なっている)", () => {
    expect(isStackedLayout(200, 195)).toBe(false);
  });

  it("未実測 (top/bottom とも 0) の初期値では縦積み扱いになる (狭い画面優先の保守的な既定)", () => {
    expect(isStackedLayout(0, 0)).toBe(true);
  });
});

describe("shouldPageDetails", () => {
  it("STATIC_LIST_MAX と同値 (30) は false", () => {
    expect(shouldPageDetails(STATIC_LIST_MAX)).toBe(false);
    expect(shouldPageDetails(30)).toBe(false);
  });

  it("STATIC_LIST_MAX を超えたら (31) true", () => {
    expect(shouldPageDetails(STATIC_LIST_MAX + 1)).toBe(true);
    expect(shouldPageDetails(31)).toBe(true);
  });
});

describe("shouldCompactTopGroup (effectiveAreaCount 化後の既存挙動維持)", () => {
  it("null なら false", () => {
    expect(shouldCompactTopGroup(null)).toBe(false);
  });

  it("地域件数が閾値以下なら false (3.11 級相当)", () => {
    expect(shouldCompactTopGroup(group("6強", 8, areasOfLength(19)))).toBe(false);
    expect(shouldCompactTopGroup(group("7", 9, areasOfLength(TOP_GROUP_COMPACT_AREA_THRESHOLD)))).toBe(false);
  });

  it("地域件数が閾値を超えたら true (南海トラフ級、153件相当)", () => {
    expect(shouldCompactTopGroup(group("7", 9, areasOfLength(TOP_GROUP_COMPACT_AREA_THRESHOLD + 1)))).toBe(true);
    expect(shouldCompactTopGroup(group("7", 9, areasOfLength(153)))).toBe(true);
  });

  it("omittedAreaCount 加算で閾値を超えたら true (areas 20 + omitted 15 = 35)", () => {
    expect(shouldCompactTopGroup(group("7", 9, areasOfLength(20), 15))).toBe(true);
  });

  it("omittedAreaCount 加算後も閾値以下なら false (areas 20 + omitted 5 = 25)", () => {
    expect(shouldCompactTopGroup(group("7", 9, areasOfLength(20), 5))).toBe(false);
  });
});

describe("EEW_STATIC_LIST_MAX", () => {
  it("eew-region-tiers.ts の非 compact 22px 境界 (count <= 10) と揃えて 10 である", () => {
    expect(EEW_STATIC_LIST_MAX).toBe(10);
  });
});

describe("paginateAreas", () => {
  it("空入力なら空配列", () => {
    expect(paginateAreas([])).toEqual([]);
  });

  it("budget 引数を省略すると PAGE_CITY_BUDGET が使われる (既存呼び出しの挙動不変)", () => {
    const g = group("7", 9, Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`));
    expect(paginateAreas([g])).toEqual(paginateAreas([g], PAGE_CITY_BUDGET));
  });

  it("budget 引数を明示すると、それに基づいてページ分割する (T5c: 画面高さ駆動バジェットを渡す経路)", () => {
    const g = group("6強", 8, [
      ...Array.from({ length: 6 }, (_, i) => `高知県市町村${i}`),
      ...Array.from({ length: 6 }, (_, i) => `徳島県市町村${i}`),
    ]);
    // budget=20 (既定) なら 12 件は 1 ページに収まるが、budget=10 だと 2 ページに割れる
    expect(paginateAreas([g], 20)).toHaveLength(1);
    expect(paginateAreas([g], 10)).toHaveLength(2);
  });

  it("1 県のみなら 1 ページ (バジェット内なので continuation は立たない)", () => {
    const g = group("5弱", 5, ["宮崎県宮崎市", "宮崎県都城市"]);
    const pages = paginateAreas([g]);
    expect(pages).toHaveLength(1);
    expect(pages[0].intensity).toBe("5弱");
    expect(pages[0].rank).toBe(5);
    expect(pages[0].prefGroups).toEqual([
      { pref: "宮崎県", cities: ["宮崎市", "都城市"], continuation: false },
    ]);
  });

  // 旧・県数固定 (3県/ページ) は高知県31市町村のような大県1つで破綻したため、市町村数
  // バジェット制へ改訂 (review-T5a-2 FIX-A)。1県単独でバジェットを超えるときはページを
  // またいで分割し、継続ページの prefGroups に continuation:true を立てる
  it("1県が PAGE_CITY_BUDGET を超えるとページをまたいで分割し、継続ページに continuation が立つ (大県分断)", () => {
    const g = group("7", 9, Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`));
    const pages = paginateAreas([g]);
    expect(pages).toHaveLength(Math.ceil(31 / PAGE_CITY_BUDGET));
    expect(pages).toHaveLength(2);

    expect(pages[0].prefGroups).toHaveLength(1);
    expect(pages[0].prefGroups[0].pref).toBe("高知県");
    expect(pages[0].prefGroups[0].continuation).toBe(false);
    const contentCapacity = PAGE_CITY_BUDGET - DETAIL_SECTION_HEADER_WEIGHT;
    expect(pages[0].prefGroups[0].cities).toHaveLength(contentCapacity);

    expect(pages[1].prefGroups).toHaveLength(1);
    expect(pages[1].prefGroups[0].pref).toBe("高知県");
    expect(pages[1].prefGroups[0].continuation).toBe(true);
    expect(pages[1].prefGroups[0].cities).toHaveLength(31 - contentCapacity);

  });

  it("複数県がバジェット内に収まるときは分断せず同一ページに詰める (通常ケース)", () => {
    const g = group("6強", 8, [
      ...Array.from({ length: 10 }, (_, i) => `高知県市町村${i}`),
      ...Array.from({ length: 10 }, (_, i) => `徳島県市町村${i}`),
      ...Array.from({ length: 5 }, (_, i) => `愛媛県市町村${i}`),
    ]);
    const pages = paginateAreas([g]);
    // 本文容量は見出しを除く16。高知(10)で1ページ、徳島(10)+愛媛(5)で次ページ。
    expect(pages).toHaveLength(2);
    expect(pages[0].prefGroups.map((pg) => pg.pref)).toEqual(["高知県"]);
    expect(pages[0].prefGroups.every((pg) => !pg.continuation)).toBe(true);
    expect(pages[1].prefGroups.map((pg) => pg.pref)).toEqual(["徳島県", "愛媛県"]);
  });

  it("10 県 153 市町村は各県 15〜18 件でバジェット (20) の半分を超えるため、県ごとに1ページとなる (10ページ)", () => {
    const prefectures = [
      "高知県", "徳島県", "愛媛県", "香川県", "静岡県",
      "愛知県", "三重県", "和歌山県", "宮崎県", "大分県",
    ];
    // 153 件を 10 県へ配分 (端数調整は最後の県で吸収)
    const perPref = Math.floor(153 / prefectures.length);
    const areas: string[] = [];
    prefectures.forEach((pref, idx) => {
      const count = idx === prefectures.length - 1 ? 153 - perPref * (prefectures.length - 1) : perPref;
      for (let i = 0; i < count; i++) areas.push(`${pref}市町村${i}`);
    });
    expect(areas).toHaveLength(153);

    const g = group("7", 9, areas);
    const pages = paginateAreas([g]);

    expect(pages).toHaveLength(11);
    for (const [index, page] of pages.entries()) {
      expect(page.intensity).toBe("7");
      expect(page.rank).toBe(9);
      // 最後の18件だけ本文容量16を超えるため2ページ目が continuation になる
      expect(page.prefGroups).toHaveLength(1);
      expect(page.prefGroups[0].continuation).toBe(index === pages.length - 1);
    }
    // 全ページの県バケツを合算すると 10 県ぶんに一致する
    const totalPrefBuckets = pages.reduce((sum, p) => sum + p.prefGroups.length, 0);
    expect(totalPrefBuckets).toBe(11);
  });

  it("震度グループをまたぐときはページ境界を切る", () => {
    const g7 = group("7", 9, ["高知県高知市", "徳島県徳島市"]);
    const g6 = group("6強", 8, ["宮城県仙台市"]);
    const pages = paginateAreas([g7, g6]);
    expect(pages).toHaveLength(2);
    expect(pages[0].intensity).toBe("7");
    expect(pages[1].intensity).toBe("6強");
    // g6 のページに g7 の県は混在しない
    expect(pages[1].prefGroups).toEqual([{ pref: "宮城県", cities: ["仙台市"], continuation: false }]);
  });

  it("QuakePanel/LatestQuakeCard 共通モデルは最初の section 見出しもページ予算に含める", () => {
    const contentCapacity = 20 - DETAIL_SECTION_HEADER_WEIGHT;
    const exact = paginateAreas([group("7", 9, areasOfLength(contentCapacity))], 20);
    const budgetFull = paginateAreas([group("7", 9, areasOfLength(20))], 20);

    expect(exact).toHaveLength(1);
    expect(exact[0].prefGroups[0].cities).toHaveLength(contentCapacity);
    expect(budgetFull).toHaveLength(2);
    expect(budgetFull.map((page) => page.prefGroups[0].cities.length)).toEqual([contentCapacity, 4]);
  });

  it("震度横断併合は反復見出し 1 行分もページ予算に含める", () => {
    const high = group("7", 9, areasOfLength(9, "高"));
    const lower = group("6強", 8, areasOfLength(8, "低"));
    const pages = paginateAreas([high, lower], 20, { allowCrossIntensity: true });

    // 地域だけなら 9 + 8 <= 20 だが、2 section 目の見出し 1 行 (=4) を足すと overflow する。
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.sections.map((section) => section.intensity))).toEqual([["7"], ["6強"]]);
  });

  it("反復見出し込みで予算ちょうどなら震度横断併合する", () => {
    const high = group("7", 9, areasOfLength(9, "高"));
    const lower = group("6強", 8, areasOfLength(3, "低"));
    const pages = paginateAreas([high, lower], 20, { allowCrossIntensity: true });

    // 9 + 3 地域 + 2 section 分の見出し (4 * 2) = 20。
    expect(pages).toHaveLength(1);
    expect(pages[0].sections.map((section) => section.intensity)).toEqual(["7", "6強"]);
  });

  it("areas が空のグループはページを生成しない", () => {
    const g = group("1", 1, []);
    expect(paginateAreas([g])).toEqual([]);
  });

  it("「その他」(pref:null) バケツもページ容量にカウントして同じページへ収める", () => {
    const g = group("5弱", 5, ["宮崎県宮崎市", "宗谷地方"]);
    const pages = paginateAreas([g]);
    expect(pages).toHaveLength(1);
    // バジェット内 (2件<=PAGE_CITY_BUDGET) なので「その他」バケツも同一ページに収まる
    expect(pages[0].prefGroups).toEqual([
      { pref: "宮崎県", cities: ["宮崎市"], continuation: false },
      { pref: null, cities: ["宗谷地方"], continuation: false },
    ]);
  });
});

// pageGroupMeta/PageGroupMeta (震度グループ内の通し番号) は T8① でドットインジケータへ統合され、
// 境界 gap の任意機能でも一時利用したが T8⑤ でその機能ごと撤去され、他に参照が無くなったため
// instrument-layout.ts から削除した (このテストブロックも道連れで削除)
