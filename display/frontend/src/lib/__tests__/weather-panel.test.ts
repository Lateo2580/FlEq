import { describe, expect, it } from "vitest";
import {
  buildWeatherEmergencyInput,
  capRowAreas,
  paginateWeatherRows,
  selectSubKinds,
  stripLevelPrefix,
  weatherPageCapacity,
  weatherRowAreaMax,
  type WeatherPanelItemV1,
} from "../weather-panel";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherPromotionEntryV1,
} from "../protocol";
import { baseSnapshot } from "./fixtures";

function item(over: Partial<DisplayWeatherAlertItemV1> & { kind: string }): DisplayWeatherAlertItemV1 {
  return {
    displaySeverity: "officialL5",
    rank: "emergency",
    shownAreas: ["東京都"],
    omittedAreaCount: 0,
    ...over,
  };
}

function alert(
  source: "vpws50" | "vpww56",
  items: DisplayWeatherAlertItemV1[],
  over: Partial<DisplayWeatherAlertV1> = {},
): DisplayWeatherAlertV1 {
  return {
    source,
    label: "気象警報",
    role: "weatherEmergency",
    totalAreas: items.length,
    items,
    updatedAt: "2026-07-25T10:00:00+09:00",
    ...over,
  };
}

function entry(over: Partial<DisplayWeatherPromotionEntryV1> = {}): DisplayWeatherPromotionEntryV1 {
  return { level: 5, promotedAt: "2026-07-25T10:00:00+09:00", generation: 1, ...over };
}

describe("buildWeatherEmergencyInput", () => {
  it("weatherPromotion が欠落 (旧サーバ) なら null", () => {
    expect(buildWeatherEmergencyInput(baseSnapshot())).toBeNull();
  });

  it("両 source とも null (demoted は wire 上 null) なら null", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: null, vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    expect(buildWeatherEmergencyInput(snap)).toBeNull();
  });

  it("非 null source があれば L4/L5 相当 item だけを集めた 1 枚を返す (L3 以下は落とす)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "L5 大雨特別警報", displaySeverity: "officialL5", shownAreas: ["東京都"] }),
          item({ kind: "L4 洪水警報", displaySeverity: "officialL4", shownAreas: ["千葉県"] }),
          item({ kind: "L2 雷注意報", displaySeverity: "officialL2", shownAreas: ["埼玉県"] }),
        ]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.kind).toBe("weather");
    expect(input?.level).toBe(5);
    expect(input?.items.map((i) => i.kind)).toEqual(["L5 大雨特別警報", "L4 洪水警報"]);
    expect(input?.items.map((i) => i.level)).toEqual([5, 4]);
  });

  it("L4 のみなら主レベルは 4", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry({ level: 4 }), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L4 洪水警報", displaySeverity: "officialL4" })])],
    });
    expect(buildWeatherEmergencyInput(snap)?.level).toBe(4);
  });

  it("nonLevelSpecial は L5 相当として扱う", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "暴風雪特別警報", displaySeverity: "nonLevelSpecial" })]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.level).toBe(5);
    expect(input?.items[0].level).toBe(5);
  });

  it("未知の displaySeverity は昇格 item に採らない (閉じた union 外は無視)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "謎警報", displaySeverity: "officialL9" }),
          item({ kind: "L5 大雨特別警報", displaySeverity: "officialL5" }),
        ]),
      ],
    });
    expect(buildWeatherEmergencyInput(snap)?.items.map((i) => i.kind)).toEqual(["L5 大雨特別警報"]);
  });

  it("昇格していない source の item は混ぜない (source は完全独立)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報" })]),
        alert("vpww56", [item({ kind: "L4 洪水警報", displaySeverity: "officialL4" })]),
      ],
    });
    expect(buildWeatherEmergencyInput(snap)?.items.map((i) => i.kind)).toEqual(["L5 大雨特別警報"]);
  });

  it("source 間で同じ kind でも統合せず、地域数も合算しない (非合算契約は新パネル限定)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: entry({ generation: 2 }) },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都"], omittedAreaCount: 2 })]),
        alert("vpww56", [item({ kind: "L5 大雨特別警報", shownAreas: ["千葉県"], omittedAreaCount: 3 })]),
      ],
    });
    const items = buildWeatherEmergencyInput(snap)?.items ?? [];
    expect(items.length).toBe(2);
    expect(items.map((i) => i.source)).toEqual(["vpws50", "vpww56"]);
    expect(items.map((i) => i.omittedAreaCount)).toEqual([2, 3]);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it("同 source 内で同じ kind が rank 別 alert に分かれていても key が衝突しない", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都"] })]),
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["千葉県"] })]),
      ],
    });
    const items = buildWeatherEmergencyInput(snap)?.items ?? [];
    expect(items.length).toBe(2);
    expect(new Set(items.map((i) => i.key)).size).toBe(2);
  });

  it("items は L5 → L4 の順に並ぶ (source 順は昇格 source の並び順)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry({ level: 4 }), vpww56: entry() },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L4 洪水警報", displaySeverity: "officialL4" })]),
        alert("vpww56", [item({ kind: "L5 大雨特別警報" })]),
      ],
    });
    const items = buildWeatherEmergencyInput(snap)?.items ?? [];
    expect(items.map((i) => i.kind)).toEqual(["L5 大雨特別警報", "L4 洪水警報"]);
  });

  it("live な weatherAlerts に当該 source が無ければ restoredItems を使い restored=true になる", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ restoredItems: [item({ kind: "L5 大雨特別警報", shownAreas: ["高知県"] })] }),
        vpww56: null,
      },
      weatherAlerts: [],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.items.map((i) => i.kind)).toEqual(["L5 大雨特別警報"]);
    expect(input?.restored).toBe(true);
  });

  it("live な weatherAlerts があれば restoredItems は見ない (live が権威)", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ restoredItems: [item({ kind: "L5 暴風特別警報", shownAreas: ["高知県"] })] }),
        vpww56: null,
      },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都"] })])],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.items.map((i) => i.kind)).toEqual(["L5 大雨特別警報"]);
    expect(input?.restored).toBe(false);
  });

  it("片方が live・片方が控えなら restored=true (控え混在は「同期中」を出す)", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry(),
        vpww56: entry({ restoredItems: [item({ kind: "L5 暴風特別警報" })] }),
      },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    expect(buildWeatherEmergencyInput(snap)?.restored).toBe(true);
  });

  // Codex R5: 昇格状態の権威は engine。中身が組めないことを理由にフロントがパネルを畳むと
  // 実質的なフロント独自の降格になる (spec §3「非 null source があれば気象パネルを 1 枚合成」)
  it("昇格中に描く item が 1 件も組めなくてもパネルは出す (中身 0 件・engine のレベルを採る)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L2 雷注意報", displaySeverity: "officialL2" })])],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input).not.toBeNull();
    expect(input?.items).toEqual([]);
    expect(input?.level).toBe(5); // engine の昇格レベル (item からの推定ではない)
  });

  it("主レベルは engine の昇格レベルを採る (両 source のうち高い方)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry({ level: 4 }), vpww56: entry({ level: 5 }) },
      weatherAlerts: [alert("vpws50", [item({ kind: "L4 洪水警報", displaySeverity: "officialL4" })])],
    });
    expect(buildWeatherEmergencyInput(snap)?.level).toBe(5);
  });

  it("omittedAreaCount があれば truncated=true (「表示は一部です」の契機)", () => {
    const withOmit = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報", omittedAreaCount: 4 })])],
    });
    const withoutOmit = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報", omittedAreaCount: 0 })])],
    });
    expect(buildWeatherEmergencyInput(withOmit)?.truncated).toBe(true);
    expect(buildWeatherEmergencyInput(withoutOmit)?.truncated).toBe(false);
  });

  it("generation は昇格中 source の generation を連結した安定キー (source 別に独立)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry({ generation: 3 }), vpww56: entry({ generation: 7 }) },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報" })]),
        alert("vpww56", [item({ kind: "L5 暴風特別警報" })]),
      ],
    });
    expect(buildWeatherEmergencyInput(snap)?.generation).toBe("vpws50:3|vpww56:7");

    const only56 = baseSnapshot({
      weatherPromotion: { vpws50: null, vpww56: entry({ generation: 7 }) },
      weatherAlerts: [alert("vpww56", [item({ kind: "L5 暴風特別警報" })])],
    });
    expect(buildWeatherEmergencyInput(only56)?.generation).toBe("vpww56:7");
  });
});

function panelItem(over: Partial<WeatherPanelItemV1> = {}): WeatherPanelItemV1 {
  return {
    key: "vpws50:0:L5 大雨特別警報",
    source: "vpws50",
    kind: "L5 大雨特別警報",
    level: 5,
    shownAreas: ["東京都", "千葉県", "埼玉県"],
    omittedAreaCount: 0,
    ...over,
  };
}

describe("capRowAreas", () => {
  it("上限以内なら地域はそのまま、ほか N 地域は engine 縮退ぶんだけ", () => {
    const row = capRowAreas(panelItem({ omittedAreaCount: 2 }), 12);
    expect(row.areas).toEqual(["東京都", "千葉県", "埼玉県"]);
    expect(row.hiddenAreaCount).toBe(2);
  });

  it("上限を超えたら畳み、落とした件数を engine 縮退ぶんと合算する (黙って減らさない)", () => {
    const row = capRowAreas(panelItem({ omittedAreaCount: 5 }), 2);
    expect(row.areas).toEqual(["東京都", "千葉県"]);
    expect(row.hiddenAreaCount).toBe(6); // 5 (engine) + 1 (UI 上限)
  });

  it("上限 0 以下でも 1 件は必ず出す (全滅させない)", () => {
    expect(capRowAreas(panelItem(), 0).areas).toEqual(["東京都"]);
    expect(capRowAreas(panelItem(), -3).areas).toEqual(["東京都"]);
  });
});

describe("paginateWeatherRows", () => {
  it("capacity ごとに等分割し、全行が必ずどこかのページに入る", () => {
    const rows = [1, 2, 3, 4, 5];
    const pages = paginateWeatherRows(rows, 2);
    expect(pages).toEqual([[1, 2], [3, 4], [5]]);
    expect(pages.flat()).toEqual(rows);
  });

  it("capacity が行数以上なら 1 ページ", () => {
    expect(paginateWeatherRows([1, 2], 5)).toEqual([[1, 2]]);
  });

  it("実測失敗 (0 / 負 / NaN) でも 1 行ずつに割って全行を到達可能にする", () => {
    for (const capacity of [0, -1, Number.NaN]) {
      expect(paginateWeatherRows([1, 2, 3], capacity)).toEqual([[1], [2], [3]]);
    }
  });

  it("空なら空 (空ページを作らない)", () => {
    expect(paginateWeatherRows([], 3)).toEqual([]);
  });
});

// Codex R2 Important: 実測経路の境界。過積載 (overflow:hidden での無言切り捨て) を作らないこと、
// 「未実測」と「実測して 0」を混同しないことを固定する
describe("weatherPageCapacity", () => {
  it("未実測 (どちらか null) は fallback を返す", () => {
    expect(weatherPageCapacity(null, 20, 4)).toBe(4);
    expect(weatherPageCapacity(100, null, 4)).toBe(4);
    expect(weatherPageCapacity(null, null, 4)).toBe(4);
  });

  // Codex R4: 「未実測」だけが fallback。実測した結果が使えない値なら詰め込まず 1 行へ落とす
  it("行高が使えない値 (0 以下・NaN) なら fallback で詰め込まず 1 行に絞る", () => {
    expect(weatherPageCapacity(100, 0, 4)).toBe(1);
    expect(weatherPageCapacity(100, -5, 4)).toBe(1);
    expect(weatherPageCapacity(100, Number.NaN, 4)).toBe(1);
  });

  it("領域が実測 0 (潰れている) / 非有限なら 1 行に絞る", () => {
    expect(weatherPageCapacity(0, 20, 4)).toBe(1);
    expect(weatherPageCapacity(Number.NaN, 20, 4)).toBe(1);
    expect(weatherPageCapacity(Number.POSITIVE_INFINITY, 20, 4)).toBe(1);
  });

  it("実測できたら領域 / 行高 の切り捨て (行間は行の padding 込みで測る前提)", () => {
    expect(weatherPageCapacity(100, 28, 4)).toBe(3); // 3 行 = 84px、4 行 (112px) は溢れる
    expect(weatherPageCapacity(84, 28, 4)).toBe(3);
    expect(weatherPageCapacity(83, 28, 4)).toBe(2);
  });

  it("1 行も入らない高さでも最低 1 行は返す (0 ページ化して情報を消さない)", () => {
    expect(weatherPageCapacity(10, 28, 4)).toBe(1);
  });
});

// Codex R3 Important: 副セクションの上限は distinct な種別数で数える。source が違うだけの
// 同一種別を 2 種別と数えると、実際には何も隠していないのに「ほか N 種別」が出る
describe("selectSubKinds", () => {
  it("同じ種別が両 source から来ても 1 種別として畳む (地域を持たない要約なので行は増えない)", () => {
    const { kinds, hiddenKindCount } = selectSubKinds(
      [
        panelItem({ key: "a", kind: "L4 洪水警報", source: "vpws50", level: 4 }),
        panelItem({ key: "b", kind: "L4 洪水警報", source: "vpww56", level: 4 }),
      ],
      1,
    );
    expect(kinds).toEqual(["L4 洪水警報"]);
    expect(hiddenKindCount).toBe(0);
  });

  it("上限を超えた種別だけを隠し、その distinct 件数を返す", () => {
    const items = ["A", "B", "C", "D", "D", "E"].map((k, i) =>
      panelItem({ key: `k${i}`, kind: k, level: 4 }),
    );
    const { kinds, hiddenKindCount } = selectSubKinds(items, 3);
    expect(kinds).toEqual(["A", "B", "C"]);
    expect(hiddenKindCount).toBe(2); // D と E (D の重複は 1 種別)
  });

  it("上限以内なら全部載り、隠れた種別は 0", () => {
    const { kinds, hiddenKindCount } = selectSubKinds([panelItem({ key: "a", kind: "A", level: 4 })], 3);
    expect(kinds).toEqual(["A"]);
    expect(hiddenKindCount).toBe(0);
  });

  it("上限 0 以下でも 1 種別は出す (全滅させない)", () => {
    const { kinds, hiddenKindCount } = selectSubKinds(
      [panelItem({ key: "a", kind: "A", level: 4 }), panelItem({ key: "b", kind: "B", level: 4 })],
      0,
    );
    expect(kinds).toEqual(["A"]);
    expect(hiddenKindCount).toBe(1);
  });
});


// Codex R3 Important (残件対応): 固定領域「何が」はページ送りを持たないので、警報名は有界にして
// 溢れる前に件数へ畳む

// ユーザー指摘 2026-07-26: 表示領域にゆとりがあるのに固定件数で省略しない
describe("weatherRowAreaMax", () => {
  it("未実測なら fallback (主役 12 / compact 6)", () => {
    expect(weatherRowAreaMax(null, 20, false)).toBe(12);
    expect(weatherRowAreaMax(600, null, false)).toBe(12);
    expect(weatherRowAreaMax(null, null, true)).toBe(6);
  });

  it("使えない実測値 (0 以下) でも fallback", () => {
    expect(weatherRowAreaMax(0, 20, false)).toBe(12);
    expect(weatherRowAreaMax(600, 0, false)).toBe(12);
  });

  it("幅とフォントサイズから 1 行あたり件数 × 許容折返し行数で決まる", () => {
    // 720px / (20px * 6em) = 6 件/行、主役は 2 行ぶん → 12
    expect(weatherRowAreaMax(720, 20, false)).toBe(12);
    // 広い領域ではもっと出る (1440px → 12 件/行 × 2 行)
    expect(weatherRowAreaMax(1440, 20, false)).toBe(24);
    // compact は 1 行ぶんだけ
    expect(weatherRowAreaMax(720, 20, true)).toBe(6);
  });

  it("極端に狭くても最低 1 件は出す", () => {
    expect(weatherRowAreaMax(10, 20, false)).toBe(1);
  });
});

describe("stripLevelPrefix", () => {
  it("L 接頭辞を落とす", () => {
    expect(stripLevelPrefix("L5 大雨特別警報")).toBe("大雨特別警報");
    expect(stripLevelPrefix("L4 洪水警報")).toBe("洪水警報");
  });

  it("接頭辞を持たない種別はそのまま (レベル非対応の特別警報)", () => {
    expect(stripLevelPrefix("暴風特別警報")).toBe("暴風特別警報");
  });

  it("名前の途中の L 数字は落とさない", () => {
    expect(stripLevelPrefix("記録的短時間大雨情報 L5 相当")).toBe("記録的短時間大雨情報 L5 相当");
  });
});
