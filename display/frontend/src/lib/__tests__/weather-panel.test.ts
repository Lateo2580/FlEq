import { describe, expect, it } from "vitest";
import {
  acceptsMeasurement,
  buildInitialWeatherFragments,
  buildWeatherEmergencyInput as buildWeatherEmergencyInputAt,
  buildWeatherBaseFragments,
  capRowAreas,
  evaluateWeatherFragmentRefinement,
  finitePositiveOrNull,
  paginateWeatherRows,
  packWeatherFragmentsByHeight,
  provisionalMinimumWeatherFragments,
  resolveWeatherInitialPageIndex,
  selectPagedItems,
  selectSubKinds,
  stripLevelPrefix,
  weatherAreaFragmentKey,
  weatherAreaOmissionKey,
  weatherBaseContentFingerprint,
  weatherBaseLayoutEpochKey,
  weatherInfeasiblePages,
  weatherPageCyclerResetKey,
  weatherPageCapacity,
  weatherPartitionSignature,
  weatherReferenceGeometrySourceKey,
  weatherRowAreaMax,
  weatherSyncingPages,
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

  it("同名でも別 Area.Code の地域を source 横断の昇格行と cap に保持する", () => {
    const snap = baseSnapshot({
      weatherPromotion: { vpws50: entry({ level: 4 }), vpww56: entry({ level: 4 }) },
      weatherAlerts: [
        alert("vpws50", [item({
          kind: "L4 大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "officialL4",
          shownAreas: ["府中市"], shownAreaCodes: ["1320600"],
        })]),
        alert("vpww56", [item({
          kind: "L4 大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "officialL4",
          shownAreas: ["府中市"], shownAreaCodes: ["3420600"],
        })]),
      ],
    });

    const panelItem = buildWeatherEmergencyInput(snap)?.items[0];
    expect(panelItem?.shownAreas).toEqual(["府中市", "府中市"]);
    expect(panelItem?.shownAreaCodes).toEqual(["1320600", "3420600"]);
    expect(capRowAreas(panelItem!, 1)).toMatchObject({
      areas: ["府中市"], areaCodes: ["1320600"], hiddenAreaCount: 1,
    });
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

  it("短い code 配列の欠落位置を空文字へ変えず null のまま保持する", () => {
    const row = capRowAreas(panelItem({
      shownAreas: ["福井市", "コード欠落地域"],
      shownAreaCodes: ["1820100"],
    }), 12);
    expect(row.areaCodes).toEqual(["1820100", null]);
    const fragments = buildInitialWeatherFragments([row], 12);
    const entries = fragments.flatMap((fragment) =>
      fragment.fragmentType === "group" ? fragment.areas : []);
    expect(entries.map((entry) => entry.areaCode)).toEqual(["1820100", null]);
    expect(weatherBaseContentFingerprint(fragments)).toContain(
      JSON.stringify([1, "コード欠落地域", "コード欠落地域", null, "name:コード欠落地域", false]),
    );
  });

  it("上限 0 以下でも 1 件は必ず出す (全滅させない)", () => {
    expect(capRowAreas(panelItem(), 0).areas).toEqual(["東京都"]);
    expect(capRowAreas(panelItem(), -3).areas).toEqual(["東京都"]);
  });
});

describe("気象警報の県 group / fragment 投影", () => {
  it("cap を先に適用し、prefecture は areaMax-1、raw は areaMax 件の連続 range へ分ける", () => {
    const prefectureAreas = Array.from({ length: 8 }, (_, index) => `福井市${index}`);
    const rawAreas = Array.from({ length: 7 }, (_, index) => `raw ${index}`);
    const fragments = buildWeatherBaseFragments([
      panelItem({
        key: "pref",
        shownAreas: prefectureAreas,
        shownAreaCodes: prefectureAreas.map((_, index) => `1820${String(index).padStart(3, "0")}`),
      }),
      panelItem({ key: "raw", shownAreas: rawAreas }),
    ], 6);

    expect(fragments.map((fragment) => fragment.fragmentType === "group"
      ? [fragment.logicalRowKey, fragment.group.kind, fragment.areaStart, fragment.areaEndExclusive]
      : [])).toEqual([
      ["pref", "prefecture", 0, 5],
      ["pref", "prefecture", 5, 6],
      ["raw", "raw", 0, 6],
    ]);
    // raw の7件目は cap で落ち、断片化で後続へ送る対象ではない。
    expect(fragments.at(-1)?.hiddenAreaCount).toBe(1);
  });

  it("fallback areaMax=12 は県11件、raw12件で、wire3件＋UI8件を最後だけへ付ける", () => {
    const areas = Array.from({ length: 20 }, (_, index) => `福井市${index}`);
    const fragments = buildWeatherBaseFragments([panelItem({
      key: "rain",
      shownAreas: areas,
      shownAreaCodes: areas.map((_, index) => `182${String(index).padStart(4, "0")}`),
      omittedAreaCount: 3,
    })], 12);
    expect(fragments).toHaveLength(2);
    expect(fragments.map((fragment) => fragment.fragmentType === "group"
      ? fragment.areaEndExclusive - fragment.areaStart
      : 0)).toEqual([11, 1]);
    expect(fragments.map((fragment) => fragment.hiddenAreaCount)).toEqual([0, 11]);
  });

  it("追加地域を cap で優先した後に元順へ戻し、identity と added を group へ保持する", () => {
    const fragments = buildWeatherBaseFragments([panelItem({
      key: "added",
      shownAreas: ["府中市", "福井市", "府中市"],
      shownAreaCodes: ["1320600", "1820100", "3420600"],
      addedAreas: ["府中市"],
      addedAreaCodes: ["3420600"],
    })], 2);
    const entries = fragments.flatMap((fragment) =>
      fragment.fragmentType === "group" ? fragment.areas : []);
    expect(entries.map((area) => [area.identity, area.added])).toEqual([
      ["code:1320600", false],
      ["code:3420600", true],
    ]);
    expect(entries.map((area) => area.sourceIndex)).toEqual([0, 2]);
    expect(fragments.at(-1)?.hiddenAreaCount).toBe(1);
  });

  it("fragment の areas は group の half-open slice と全 field が一致し、key は正規 JSON で一意", () => {
    const fragments = buildWeatherBaseFragments([panelItem({
      key: "quoted|\"雪",
      shownAreas: ["福井市", "敦賀市", "大野市"],
      shownAreaCodes: ["1820100", "1820200", "1820500"],
    })], 2);
    for (const fragment of fragments) {
      expect(fragment.fragmentType).toBe("group");
      if (fragment.fragmentType !== "group") continue;
      expect(fragment.areas).toEqual(
        fragment.group.areas.slice(fragment.areaStart, fragment.areaEndExclusive),
      );
      expect(fragment.continued).toBe(fragment.areaStart > 0);
      expect(fragment.key).toBe(weatherAreaFragmentKey(
        fragment.group.key,
        fragment.areaStart,
        fragment.areaEndExclusive,
      ));
    }
    expect(new Set(fragments.map((fragment) => fragment.key)).size).toBe(fragments.length);
  });

  it("表示0・省略ありだけ omission-only を作り、表示0・省略0は断片を作らない", () => {
    const omitted = buildWeatherBaseFragments([panelItem({
      key: "omitted",
      shownAreas: [],
      omittedAreaCount: 9,
    })], 12);
    expect(omitted).toEqual([{
      fragmentType: "omission-only",
      key: weatherAreaOmissionKey("omitted"),
      logicalRowKey: "omitted",
      kind: "L5 大雨特別警報",
      level: 5,
      hiddenAreaCount: 9,
      continued: false,
    }]);
    expect(buildWeatherBaseFragments([panelItem({ shownAreas: [] })], 12)).toEqual([]);
  });

  it("provisional は全地域を singleton page 単位へ展開し、省略数を論理行の最後だけに移す", () => {
    const base = buildWeatherBaseFragments([panelItem({
      key: "provisional",
      shownAreas: ["A", "B", "C"],
      omittedAreaCount: 4,
    })], 12);
    const provisional = provisionalMinimumWeatherFragments(base);
    expect(provisional.map((fragment) => fragment.fragmentType === "group"
      ? [fragment.areaStart, fragment.areaEndExclusive, fragment.hiddenAreaCount]
      : [])).toEqual([[0, 1, 0], [1, 2, 0], [2, 3, 4]]);
  });
});

describe("気象警報 fragment の実高 refinement / partition", () => {
  const fourAreaBase = () => buildWeatherBaseFragments([panelItem({
    key: "four",
    shownAreas: ["A", "B", "C", "D"],
  })], 12);

  it("過高 fragment を候補終端の降順で測り、最大 fitting prefix と残部へ分ける", () => {
    const base = fourAreaBase();
    const parent = base[0]!;
    expect(parent.fragmentType).toBe("group");
    if (parent.fragmentType !== "group") return;
    const heights = new Map<string, number>([[parent.key, 120]]);

    const first = evaluateWeatherFragmentRefinement(base, heights, 70);
    expect(first.state).toBe("pending");
    if (first.state !== "pending" || first.candidate == null) return;
    expect(first.candidate.areaEndExclusive).toBe(3);
    heights.set(first.candidate.key, 90);

    const second = evaluateWeatherFragmentRefinement(base, heights, 70);
    expect(second.state).toBe("pending");
    if (second.state !== "pending" || second.candidate == null) return;
    expect(second.candidate.areaEndExclusive).toBe(2);
    heights.set(second.candidate.key, 60);

    const split = evaluateWeatherFragmentRefinement(base, heights, 70);
    expect(split.state).toBe("split");
    if (split.state !== "split") return;
    expect(split.fragments.map((fragment) => fragment.fragmentType === "group"
      ? [fragment.areaStart, fragment.areaEndExclusive]
      : [])).toEqual([[0, 2], [2, 4]]);
    expect(split.fragments.flatMap((fragment) =>
      fragment.fragmentType === "group" ? fragment.areas.map((area) => area.identity) : []))
      .toEqual(parent.areas.map((area) => area.identity));
  });

  it("split 後は省略数を最終子だけへ移す", () => {
    const [parent] = buildWeatherBaseFragments([panelItem({
      key: "hidden",
      shownAreas: ["A", "B", "C"],
      omittedAreaCount: 5,
    })], 12);
    expect(parent?.fragmentType).toBe("group");
    if (parent?.fragmentType !== "group") return;
    const heights = new Map<string, number>([[parent.key, 100]]);
    const pending = evaluateWeatherFragmentRefinement([parent], heights, 70);
    if (pending.state !== "pending" || pending.candidate == null) return;
    heights.set(pending.candidate.key, 60);
    const split = evaluateWeatherFragmentRefinement([parent], heights, 70);
    expect(split.state).toBe("split");
    if (split.state !== "split") return;
    expect(split.fragments.map((fragment) => fragment.hiddenAreaCount)).toEqual([0, 5]);
  });

  it("単一地域・omission-only の過高は部分表示せず infeasible にする", () => {
    const singleton = provisionalMinimumWeatherFragments(fourAreaBase())[0]!;
    expect(evaluateWeatherFragmentRefinement(
      [singleton],
      new Map([[singleton.key, 80]]),
      70,
    )).toEqual({ state: "infeasible" });

    const omission = buildWeatherBaseFragments([panelItem({ shownAreas: [], omittedAreaCount: 2 })], 12)[0]!;
    expect(evaluateWeatherFragmentRefinement(
      [omission],
      new Map([[omission.key, 80]]),
      70,
    )).toEqual({ state: "infeasible" });
  });

  it("複数地域 fragment でも singleton 候補まで全て過高なら置換せず infeasible にする", () => {
    const [parent] = buildWeatherBaseFragments([panelItem({
      key: "all-too-tall",
      shownAreas: ["A", "B", "C"],
      omittedAreaCount: 6,
    })], 12);
    expect(parent?.fragmentType).toBe("group");
    if (parent?.fragmentType !== "group") return;
    const candidateTwoKey = weatherAreaFragmentKey(parent.group.key, 0, 2);
    const candidateOneKey = weatherAreaFragmentKey(parent.group.key, 0, 1);
    const result = evaluateWeatherFragmentRefinement([parent], new Map([
      [parent.key, 120],
      [candidateTwoKey, 90],
      [candidateOneKey, 80],
    ]), 70);
    expect(result).toEqual({ state: "infeasible" });
    expect(parent.hiddenAreaCount).toBe(6);
    expect(parent.areas).toHaveLength(3);
  });

  it("0・NaN・欠落測定を fitting とせず pending に保つ", () => {
    const [fragment] = fourAreaBase();
    for (const height of [undefined, 0, Number.NaN]) {
      const heights = new Map<string, number>();
      if (height !== undefined) heights.set(fragment!.key, height);
      expect(evaluateWeatherFragmentRefinement([fragment!], heights, 70))
        .toEqual({ state: "pending", candidate: null });
    }
  });

  it("全 fragment 高が揃ったときだけ greedy に詰め、各 fragment を一度だけ配置する", () => {
    const fragments = provisionalMinimumWeatherFragments(fourAreaBase());
    const heights = new Map(fragments.map((fragment, index) => [fragment.key, index === 3 ? 50 : 30]));
    const pages = packWeatherFragmentsByHeight(fragments, heights, 70);
    expect(pages?.map((page) => page.length)).toEqual([2, 1, 1]);
    expect(pages?.flat().map((fragment) => fragment.key)).toEqual(fragments.map((fragment) => fragment.key));
    expect(packWeatherFragmentsByHeight(fragments, new Map(), 70)).toBeNull();
  });
});

describe("気象警報 layout key / 公開 partition", () => {
  it("正規 content fingerprint は名称・追加・省略を含み、同 generation の訂正も区別する", () => {
    const before = buildWeatherBaseFragments([panelItem({ shownAreas: ["長い地域名称"] })], 12);
    const after = buildWeatherBaseFragments([panelItem({ shownAreas: ["短名"], addedAreas: ["短名"] })], 12);
    expect(weatherBaseContentFingerprint(before)).not.toBe(weatherBaseContentFingerprint(after));
  });

  it("reference / base epoch key は spec の正規 JSON tuple と一致する", () => {
    const fragments = fourFragmentFixture();
    const fingerprint = weatherBaseContentFingerprint(fragments);
    const referenceKey = weatherReferenceGeometrySourceKey({
      compact: false,
      layoutSettling: false,
      whereFrameWidth: 800,
      whereFrameHeight: 300,
      whereFontSize: 20,
      pagerReferenceTotal: 4,
    });
    expect(referenceKey).toBe(JSON.stringify([
      "weather-area-reference-geometry-v1", false, false, 800, 300, 20, 4,
    ]));
    expect(weatherBaseLayoutEpochKey({
      input: { generation: "g", level: 5, activationKey: "a" },
      referenceGeometrySourceKey: referenceKey,
      stableWhereBodyWidth: 600,
      stableWhereBodyHeight: 120,
      baseContentFingerprint: fingerprint,
      baseFragments: fragments,
    })).toBe(JSON.stringify([
      "weather-area-base-epoch-v2",
      "g", 5, "a", referenceKey, 600, 120, fingerprint,
      fragments.map((fragment) => fragment.key),
    ]));
  });

  it("syncing / infeasible は一意な専用1ページ、signature は公開 key 列だけで決まる", () => {
    const identity = { generation: "g", level: 5 as const, activationKey: "a" };
    const syncing = weatherSyncingPages(identity);
    const infeasible = weatherInfeasiblePages(identity, "fingerprint");
    expect(syncing).toHaveLength(1);
    expect(syncing[0]?.[0]).toMatchObject({
      fragmentType: "syncing", message: "対象地域を同期中です",
    });
    expect(infeasible[0]?.[0]).toMatchObject({
      fragmentType: "infeasible", message: "対象地域の一覧を表示できません",
    });
    const signature = weatherPartitionSignature(syncing);
    expect(signature).toBe(JSON.stringify([
      "weather-area-partition-v1",
      syncing.map((page) => page.map((entry) => entry.key)),
    ]));
    expect(weatherPageCyclerResetKey(signature)).toBe(JSON.stringify([
      "weather-area-cycle-v2", signature,
    ]));
  });

  it("initial page は同じ論理行の added 断片、行先頭、0 の順で解決する", () => {
    const fragments = provisionalMinimumWeatherFragments(buildWeatherBaseFragments([panelItem({
      key: "target",
      shownAreas: ["A", "B"],
      addedAreas: ["B"],
    })], 12));
    const pages = fragments.map((fragment) => [fragment]);
    expect(resolveWeatherInitialPageIndex(pages, "target")).toBe(1);
    expect(resolveWeatherInitialPageIndex(pages, "missing")).toBe(0);
    expect(resolveWeatherInitialPageIndex(pages, null)).toBe(0);

    const omission = buildWeatherBaseFragments([panelItem({
      key: "omitted",
      shownAreas: [],
      omittedAreaCount: 3,
    })], 12)[0]!;
    expect(resolveWeatherInitialPageIndex([[pages[0]![0]!], [omission]], "omitted")).toBe(0);
  });

  it("finitePositiveOrNull は正の有限値だけを通す", () => {
    expect(finitePositiveOrNull(1)).toBe(1);
    for (const value of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(finitePositiveOrNull(value)).toBeNull();
    }
  });
});

function fourFragmentFixture() {
  return provisionalMinimumWeatherFragments(buildWeatherBaseFragments([panelItem({
    key: "fixture",
    shownAreas: ["A", "B", "C", "D"],
  })], 12));
}

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

  it("使えない実測値 (0 以下・NaN・無限大) でも fallback", () => {
    expect(weatherRowAreaMax(0, 20, false)).toBe(12);
    expect(weatherRowAreaMax(-1, 20, false)).toBe(12);
    expect(weatherRowAreaMax(Number.NaN, 20, false)).toBe(12);
    expect(weatherRowAreaMax(Number.POSITIVE_INFINITY, 20, false)).toBe(12);
    expect(weatherRowAreaMax(600, 0, false)).toBe(12);
    expect(weatherRowAreaMax(600, -1, true)).toBe(6);
    expect(weatherRowAreaMax(600, Number.NaN, true)).toBe(6);
    expect(weatherRowAreaMax(600, Number.POSITIVE_INFINITY, true)).toBe(6);
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

  it("同名地域は Area.Code で追加を選び、先頭の別県を優先しない", () => {
    const row = capRowAreas(panelItem({
      shownAreas: ["府中市", "府中市"],
      shownAreaCodes: ["1320600", "3420600"],
      addedAreas: ["府中市"],
      addedAreaCodes: ["3420600"],
    }), 1);
    expect(row).toMatchObject({
      areas: ["府中市"], areaCodes: ["3420600"], hiddenAreaCount: 1,
    });
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
