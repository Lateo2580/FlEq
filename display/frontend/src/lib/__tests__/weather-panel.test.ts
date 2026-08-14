import { describe, expect, it } from "vitest";
import {
  acceptsMeasurement,
  buildWeatherEmergencyInput as buildWeatherEmergencyInputAt,
  capRowAreas,
  paginateWeatherRows,
  selectPagedItems,
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

const buildWeatherEmergencyInput = (snapshot: ReturnType<typeof baseSnapshot>) =>
  buildWeatherEmergencyInputAt(snapshot, Date.parse(snapshot.generatedAt));

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

  it("点灯元 source の updatedAt を緊急パネル入力へ渡す", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ activationKey: "a1" }),
        vpww56: entry({ activationKey: "a2" }),
        activationKey: "a2",
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報" })], {
          updatedAt: "2026-07-25T10:00:00+09:00",
        }),
        alert("vpww56", [item({ kind: "L4 土砂災害警戒情報", displaySeverity: "officialL4" })], {
          updatedAt: "2026-07-25T10:05:00+09:00",
        }),
      ],
    });

    expect(buildWeatherEmergencyInput(snap)?.updatedAt).toBe("2026-07-25T10:05:00+09:00");
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

  it("phenomenonKey が両方にあるとき、source 間で同じ現象を 1 行に統合する", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ activationKey: "1" }),
        vpww56: entry({
          generation: 2,
          activationKey: "2",
          trigger: "update",
          addedAreas: [{ kind: "L4 土砂災害危険警報", areas: ["千葉県"] }],
        }),
        activationKey: "2",
      },
      weatherAlerts: [
        alert("vpws50", [
          item({
            kind: "L4 土砂災害危険警報",
            phenomenonKey: "土砂災害",
            displaySeverity: "officialL4",
            shownAreas: ["東京都", "長野県"],
            omittedAreaCount: 2,
          }),
        ]),
        alert("vpww56", [
          item({
            kind: "L4 土砂災害危険警報",
            phenomenonKey: "土砂災害",
            displaySeverity: "officialL4",
            shownAreas: ["長野県", "千葉県"],
            omittedAreaCount: 3,
          }),
        ]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.items).toEqual([
      {
        key: "officialL4|土砂災害",
        source: "vpws50",
        kind: "L4 土砂災害危険警報",
        level: 4,
        shownAreas: ["東京都", "長野県", "千葉県"],
        omittedAreaCount: 5,
        addedAreas: ["千葉県"],
      },
    ]);
    expect(input?.firstPageRowKey).toBe("officialL4|土砂災害");
  });

  it("phenomenonKey が両方にないとき、表示名で同じ行へ統合する", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都"] })]),
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["千葉県"] })]),
      ],
    });
    const items = buildWeatherEmergencyInput(snap)?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe("officialL5|L5 大雨特別警報");
    expect(items[0].shownAreas).toEqual(["東京都", "千葉県"]);
  });

  it("phenomenonKey の有無が混在しても、表示名 alias で安定キーの行へ統合する", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry(),
        vpww56: entry({
          restoredItems: [
            item({
              kind: "L5 大雨特別警報",
              shownAreas: ["千葉県"],
            }),
          ],
        }),
      },
      weatherAlerts: [
        alert("vpws50", [
          item({
            kind: "L5 大雨特別警報",
            phenomenonKey: "大雨",
            shownAreas: ["東京都"],
          }),
        ]),
      ],
    });

    const input = buildWeatherEmergencyInput(snap);
    expect(input?.items).toEqual([
      {
        key: "officialL5|大雨",
        source: "vpws50",
        kind: "L5 大雨特別警報",
        level: 5,
        shownAreas: ["東京都", "千葉県"],
        omittedAreaCount: 0,
        addedAreas: [],
      },
    ]);
    expect(input?.restored).toBe(true);
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
    addedAreas: [],
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

  it("同名・別 code 由来の要素が上限境界をまたいでも位置単位で省略数を数える", () => {
    const row = capRowAreas(panelItem({
      shownAreas: ["同名市", "別名市", "同名市"],
      omittedAreaCount: 0,
    }), 2);
    expect(row.areas).toEqual(["同名市", "別名市"]);
    expect(row.hiddenAreaCount).toBe(1);
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

// ── spec 追補 (2026-07-26/27): trigger / addedAreas / activationKey の合成 ──

describe("buildWeatherEmergencyInput (点灯規則の追補)", () => {
  it("trigger は entry から、activationKey はパネル全体の値から受け取る", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ trigger: "update", activationKey: "3" }),
        vpww56: null,
        activationKey: "3",
      },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.trigger).toBe("update");
    expect(input?.activationKey).toBe("3");
  });

  it("trigger 欠落 (旧サーバ) は null (バッジを出さない)", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    expect(buildWeatherEmergencyInput(snap)?.trigger).toBeNull();
  });

  it("追加地域は点灯を起こした source だけから統合行へ載る", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({
          activationKey: "9",
          trigger: "update",
          addedAreas: [{ kind: "L5 大雨特別警報", areas: ["千葉県"] }],
        }),
        vpww56: entry({ generation: 2, activationKey: "8" }), // vpww56 側に追加地域は無い
        activationKey: "9",
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都", "千葉県"] })]),
        // 別 source 側にも同名地域があるが、装飾の供給元にはしない
        alert("vpww56", [item({ kind: "L5 大雨特別警報", shownAreas: ["千葉県"] })]),
      ],
    });
    const items = buildWeatherEmergencyInput(snap)?.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].addedAreas).toEqual(["千葉県"]);
  });

  it("複数 source が点いていたら最新の点灯を trigger に採る", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ activationKey: "1", trigger: "new" }),
        vpww56: entry({ activationKey: "2", trigger: "update", generation: 2 }),
        activationKey: "2", // engine の watermark = 最後に点いた vpww56 の番号
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報" })]),
        alert("vpww56", [item({ kind: "L5 暴風特別警報" })]),
      ],
    });
    expect(buildWeatherEmergencyInput(snap)?.trigger).toBe("update");
  });

  // Codex レビュー 4 巡目 Important: 「点灯を起こした source」以外の装飾を寄せ集めると、
  // 前の点灯のハイライトとバッジが次の点灯へ持ち越される
  it("装飾を出すのは今回の点灯を起こした source だけ (前の点灯のハイライトを持ち越さない)", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        // 前に点いた vpws50。追加地域を持ったまま active で残っている
        vpws50: entry({
          activationKey: "4",
          trigger: "update",
          addedAreas: [{ kind: "L5 大雨特別警報", areas: ["千葉県"] }],
        }),
        // 後から点いた vpww56 が現在の点灯 (watermark と一致する)
        vpww56: entry({ activationKey: "5", trigger: "new", generation: 2 }),
        activationKey: "5",
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都", "千葉県"] })]),
        alert("vpww56", [item({ kind: "L5 暴風特別警報", shownAreas: ["高知県"] })]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.trigger).toBe("new"); // 古い "update" が残らない
    expect(input?.items.find((i) => i.source === "vpws50")?.addedAreas).toEqual([]);
    expect(input?.firstPageRowKey).toBeNull();
  });

  it("点灯を起こした source が降格したら装飾は消える (古いバッジが復活しない)", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({
          activationKey: "4",
          trigger: "update",
          addedAreas: [{ kind: "L5 大雨特別警報", areas: ["千葉県"] }],
        }),
        vpww56: null, // watermark を持っていた側が降格 = wire 上 null
        activationKey: "5",
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報", shownAreas: ["東京都", "千葉県"] })]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.trigger).toBeNull();
    expect(input?.items[0].addedAreas).toEqual([]);
  });

  it("行キーは出現位置を使わない (種別が増えても既存行のキーがずれない)", () => {
    const before = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    const after = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "L5 暴風特別警報" }), // 先頭に別種別が増える
          item({ kind: "L5 大雨特別警報" }),
        ]),
      ],
    });
    const keyOf = (snap: Parameters<typeof buildWeatherEmergencyInput>[0]) =>
      buildWeatherEmergencyInput(snap)?.items.find((i) => i.kind === "L5 大雨特別警報")?.key;
    expect(keyOf(after)).toBe(keyOf(before));
  });

  it("追加地域を含む行のキーを firstPageRowKey に載せる (最初のページに出すため)", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({
          activationKey: "3",
          trigger: "update",
          addedAreas: [{ kind: "L5 暴風特別警報", areas: ["高知県"] }],
        }),
        vpww56: null,
        activationKey: "3",
      },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "L5 大雨特別警報", shownAreas: ["東京都"] }),
          item({ kind: "L5 暴風特別警報", shownAreas: ["高知県"] }),
        ]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    expect(input?.firstPageRowKey).toBe("officialL5|L5 暴風特別警報");
  });
});

// ── Codex レビュー 2026-07-27: 追加地域が画面から消える経路を塞ぐ ──

describe("追加地域の保護", () => {
  it("行の地域上限を超えても、追加地域は落とさず残す (compact でも)", () => {
    const areas = Array.from({ length: 20 }, (_, i) => `地域${i}`);
    const row = capRowAreas(
      panelItem({ shownAreas: areas, addedAreas: ["地域19"], omittedAreaCount: 0 }),
      3,
    );
    expect(row.areas).toContain("地域19"); // 末尾にある追加地域が残る
    expect(row.areas).toHaveLength(3);
    // 並び順は元のまま (読み手の見え方を変えない)
    expect(row.areas).toEqual([...row.areas].sort((a, b) => areas.indexOf(a) - areas.indexOf(b)));
    expect(row.hiddenAreaCount).toBe(17);
  });

  it("追加地域が無ければ従来どおり先頭から詰める", () => {
    const areas = ["A", "B", "C", "D"];
    const row = capRowAreas(panelItem({ shownAreas: areas, addedAreas: [] }), 2);
    expect(row.areas).toEqual(["A", "B"]);
  });

  // ご主人決定 2026-07-27: 「L5 継続中に L4 の地域が増えた」で更新点灯するのに、下位レベルが
  // 種別名 + 件数へ畳まれていると**どこが増えたのかが一度も読めない**。追加を含む下位行だけを
  // 例外として地域名つきでページ送り列に参加させ、firstPageRowKey もその行を指せるようにする
  // (旧テストは「下位の追加行は指さない」を正解として固定していた。ここで反転する)
  it("追加を含む下位レベルの行はページ送り列に載り、firstPageRowKey も指せる", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({
          activationKey: "6",
          trigger: "update",
          addedAreas: [{ kind: "L4 洪水警報", areas: ["千葉県"] }],
        }),
        vpww56: null,
        activationKey: "6",
      },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "L5 大雨特別警報", displaySeverity: "officialL5", shownAreas: ["東京都"] }),
          // 追加地域を持つのは下位レベルの方
          item({ kind: "L4 洪水警報", displaySeverity: "officialL4", shownAreas: ["千葉県"] }),
        ]),
      ],
    });
    const input = buildWeatherEmergencyInput(snap);
    const subRow = input?.items.find((i) => i.level === 4);
    expect(subRow?.addedAreas).toEqual(["千葉県"]);
    // ページ送り列に載る = 指し先が見つかる
    const paged = selectPagedItems(input?.items ?? [], 5);
    expect(paged.map((i) => i.key)).toContain(subRow?.key);
    expect(input?.firstPageRowKey).toBe(subRow?.key);
  });

  it("主レベルにも追加があれば、そちらを優先して最初のページに出す", () => {
    const snap = baseSnapshot({
      weatherPromotion: {
        vpws50: entry({
          activationKey: "7",
          trigger: "update",
          addedAreas: [
            { kind: "L5 大雨特別警報", areas: ["東京都"] },
            { kind: "L4 洪水警報", areas: ["千葉県"] },
          ],
        }),
        vpww56: null,
        activationKey: "7",
      },
      weatherAlerts: [
        alert("vpws50", [
          item({ kind: "L5 大雨特別警報", displaySeverity: "officialL5", shownAreas: ["東京都"] }),
          item({ kind: "L4 洪水警報", displaySeverity: "officialL4", shownAreas: ["千葉県"] }),
        ]),
      ],
    });
    expect(buildWeatherEmergencyInput(snap)?.firstPageRowKey).toBe(
      "officialL5|L5 大雨特別警報",
    );
  });
});

// ご主人決定 2026-07-27: 例外は「追加が起きた行」だけ。追加を含まない下位行は従来どおり
// 副セクションの要約 (種別名 + 件数) に残す
describe("selectPagedItems", () => {
  const main = panelItem({ key: "m", level: 5, addedAreas: [] });
  const subPlain = panelItem({ key: "s0", level: 4, addedAreas: [] });
  const subAdded = panelItem({ key: "s1", level: 4, addedAreas: ["千葉県"] });

  it("主レベルの行はすべて載せる (追加の有無によらない)", () => {
    expect(selectPagedItems([main, subPlain], 5).map((i) => i.key)).toEqual(["m"]);
  });

  it("下位レベルは追加を含む行だけを載せる", () => {
    expect(selectPagedItems([main, subPlain, subAdded], 5).map((i) => i.key)).toEqual(["m", "s1"]);
  });

  it("主レベルが 4 のときは下位レベルが存在しない (全行が載る)", () => {
    const only4 = panelItem({ key: "a", level: 4, addedAreas: [] });
    expect(selectPagedItems([only4], 4).map((i) => i.key)).toEqual(["a"]);
  });
});

// Codex レビュー 4 巡目 Important: crossfade 中は旧・新の DOM が共存し、pointer-events では
// ResizeObserver が止まらない。旧レイアウトの高さが最後に届くとページ容量に残る
describe("acceptsMeasurement", () => {
  it("現行の点灯キーと一致する DOM の測定だけを受理する", () => {
    expect(acceptsMeasurement("a2", "a2", false)).toBe(true);
    expect(acceptsMeasurement("a1", "a2", false)).toBe(false); // 退場中の旧 DOM
  });

  it("レイアウト整定中は一致していても受理しない (過渡値を確定値へ昇格させない)", () => {
    expect(acceptsMeasurement("a2", "a2", true)).toBe(false);
  });
});

// Codex レビュー 2026-07-27: 片方の source が降格しただけで再点灯しない。
// 再点灯の契機は **engine が採番するパネル全体の watermark** で、source 別キーの
// 最大値ではない (最後に点いた source が降格すると値が巻き戻るため)
describe("activationKey の安定性", () => {
  const twoSources = (over: { vpww56?: boolean; panelKey?: string } = {}) =>
    baseSnapshot({
      weatherPromotion: {
        vpws50: entry({ activationKey: "5", trigger: "new" }),
        vpww56: over.vpww56 === false ? null : entry({ activationKey: "7", trigger: "update", generation: 2 }),
        activationKey: over.panelKey ?? "7",
      },
      weatherAlerts: [
        alert("vpws50", [item({ kind: "L5 大雨特別警報" })]),
        ...(over.vpww56 === false ? [] : [alert("vpww56", [item({ kind: "L5 暴風特別警報" })])]),
      ],
    });

  it("パネル全体の activationKey をそのまま使う (source 別キーを連結・比較しない)", () => {
    expect(buildWeatherEmergencyInput(twoSources())?.activationKey).toBe("7");
  });

  it("片方の source が降格して消えても、点灯キーは変わらない (再点灯しない)", () => {
    const both = buildWeatherEmergencyInput(twoSources());
    // vpww56 が降格 = wire 上 null。engine の watermark は動かないので同じ値が来る
    const afterDemote = buildWeatherEmergencyInput(twoSources({ vpww56: false, panelKey: "7" }));
    expect(afterDemote?.activationKey).toBe(both?.activationKey);
  });

  it("新しい点灯があったときだけキーが変わる", () => {
    const before = buildWeatherEmergencyInput(twoSources({ panelKey: "7" }));
    const after = buildWeatherEmergencyInput(twoSources({ panelKey: "8" }));
    expect(after?.activationKey).not.toBe(before?.activationKey);
  });

  it("バッジは最後に点いた source のものを出す (点灯順で決める)", () => {
    expect(buildWeatherEmergencyInput(twoSources())?.trigger).toBe("update");
  });

  it("パネル全体キーが欠落 (旧サーバ) なら空文字 = 演出なし", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry(), vpww56: null },
      weatherAlerts: [alert("vpws50", [item({ kind: "L5 大雨特別警報" })])],
    });
    expect(buildWeatherEmergencyInput(snap)?.activationKey).toBe("");
  });
});
