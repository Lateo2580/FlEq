import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import LatestQuakeCard from "../LatestQuakeCard.svelte";
import WeatherAlertCard from "../WeatherAlertCard.svelte";
import { TIME_SLICE_PERIOD_MS, createCardPageCoordinator } from "../../lib/legacy-standby/time-slice-scheduler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";
import type { DisplayIntensitySemanticV1, DisplayLatestQuakeStateV1, DisplayMagnitudeSemanticV1 } from "../../lib/protocol";

// Scheduler の callback と Svelte の同期 DOM flush をまとめて進める。
function settlePage(): void {
  flushSync();
}

// 10県 (1県あたり areasPerPref 件) の intensityGroups を作る、詳細ページングテスト用ヘルパー
function tenPrefAreas(areasPerPref: number): string[] {
  const prefectures = [
    "高知県", "徳島県", "愛媛県", "香川県", "静岡県",
    "愛知県", "三重県", "和歌山県", "宮崎県", "大分県",
  ];
  return prefectures.flatMap((pref) =>
    Array.from({ length: areasPerPref }, (_, i) => `${pref}市町村${i}`),
  );
}

function latestQuake(over: Partial<DisplayLatestQuakeStateV1> = {}): DisplayLatestQuakeStateV1 {
  return {
    eventId: "20260708090000",
    headline: null,
    originTime: "2026-07-08T09:00:00+09:00",
    hypocenterName: "宮崎県南部平野部",
    depth: "10km",
    magnitude: "5.2",
    maxInt: "5弱",
    maxIntRank: 5,
    tsunamiWarning: false,
    intensityGroups: [],
    reportDateTime: "2026-07-08T09:03:00+09:00",
    updatedAtMs: 1783587780000,
    ...over,
  };
}

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4", presence: "value", label: "4", condition: null, description: null,
    lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "normalRank", render: true, safetyLowerRank: 4,
    safetyUpperRank: 4, safetyRank: 4, colorRank: 4, ...over,
  };
}

function magnitudeSemantic(over: Partial<DisplayMagnitudeSemanticV1>): DisplayMagnitudeSemanticV1 {
  return {
    raw: null, presence: "missing", label: null, condition: null, description: null,
    value: null, lowerBound: null, upperBound: null, rawLowerBound: null, rawUpperBound: null,
    badge: null, color: "notRendered", render: false, rank: { kind: "unranked" }, ...over,
  };
}

describe("LatestQuakeCard", () => {
  // 看板ヘッダ (津波/気象カードと同じ D 案標準文法): ラベルは固定文字列「地震情報」、
  // 色ロールは maxIntRank>=7 (震度6弱以上) で critical、それ未満・null で warning
  describe("看板ヘッダ", () => {
    it("ラベル「地震情報」を render する", () => {
      const quake = latestQuake();
      const { container } = render(LatestQuakeCard, { quake });
      expect(container.querySelector(".banner-header")?.textContent).toBe("地震情報");
    });

    it("maxIntRank が7未満 (震度6弱未満) では critical クラスを持たない", () => {
      const quake = latestQuake({ maxIntRank: 5 });
      const { container } = render(LatestQuakeCard, { quake });
      expect(container.querySelector(".banner-header")?.classList.contains("critical")).toBe(false);
    });

    it("maxIntRank が7以上 (震度6弱以上) では critical クラスを持つ", () => {
      const quake = latestQuake({ maxIntRank: 7 });
      const { container } = render(LatestQuakeCard, { quake });
      expect(container.querySelector(".banner-header")?.classList.contains("critical")).toBe(true);
    });

    it("maxIntRank が null では critical クラスを持たない", () => {
      const quake = latestQuake({ maxIntRank: null });
      const { container } = render(LatestQuakeCard, { quake });
      expect(container.querySelector(".banner-header")?.classList.contains("critical")).toBe(false);
    });
  });

  it("震源名・M・深さ・時刻 (日付込み) を render する", () => {
    const quake = latestQuake();
    const { container } = render(LatestQuakeCard, { quake });
    expect(container.querySelector(".hypocenter")?.textContent).toBe("宮崎県南部平野部");
    // 規模は「M 小 + 数値 大」の NumberUnit prefix 形式 (spec 2026-07-23 数値表記統一)
    expect(container.querySelector(".magnitude .nu-prefix")?.textContent).toBe("M");
    expect(container.querySelector(".magnitude .nu-value")?.textContent).toBe("5.2");
    expect(container.querySelector(".magnitude")?.textContent).toBe("M5.2");
    expect(container.querySelector(".depth")?.textContent).toBe("10km");
    // 深さは数値大・単位小の NumberUnit (値=10 / 単位=km)
    expect(container.querySelector(".depth .nu-value")?.textContent).toBe("10");
    expect(container.querySelector(".depth .nu-unit")?.textContent).toBe("km");
    // 第3波 Fix9: 発生時刻は日付を跨いだ事象と区別できるよう M/D も表示する
    expect(container.querySelector(".time")?.textContent).toBe("7/8 09:00");
  });

  it("Magnitude/Depth semantic の特殊値を badge・tooltip・ARIA・凡例付きで表示する", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({
      magnitude: "9.9",
      magnitudeSemantic: magnitudeSemantic({
        raw: "NaN", presence: "unknown", label: "M不明", condition: "不明",
        badge: "?", color: "unknown", render: true,
      }),
      depth: "600km",
      depthSemantic: {
        ...magnitudeSemantic({}), presence: "range", label: "600km以上", condition: "600km以上",
        lowerBound: 600, badge: "≥", color: "safetyRank", render: true,
      },
    }) });
    expect(container.querySelector(".magnitude")?.textContent).toContain("M不明?");
    expect(container.querySelector(".magnitude")?.getAttribute("aria-label")).toContain("条件: 不明");
    expect(container.querySelector(".depth")?.textContent).toContain("600km以上≥");
    expect(container.querySelector(".numeric-semantic-legend")?.textContent).toContain("以上（下限値）");
    expect(container.querySelector(".numeric-semantic-legend")?.textContent).toContain("不明・定性値");
  });

  it("magnitude が null なら規模欄は空のまま (NumberUnit を出さない)", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({ magnitude: null }) });
    expect(container.querySelector(".magnitude")?.textContent).toBe("");
    expect(container.querySelector(".magnitude")?.getAttribute("aria-label")).toBe("マグニチュード: 空欄");
  });

  it("巨大地震 description は M を重ねず通常テキストで描画する", () => {
    const { container } = render(LatestQuakeCard, {
      quake: latestQuake({ magnitude: "M8 を超える巨大地震" }),
    });
    expect(container.querySelector(".magnitude")?.textContent).toBe("M8 を超える巨大地震");
    expect(container.querySelector(".magnitude .nu-value")).toBeNull();
    expect(container.textContent).not.toContain("NaN");
  });

  it("旧保存状態の NaN も M不明へ縮退する", () => {
    const { container } = render(LatestQuakeCard, {
      quake: latestQuake({ magnitude: "NaN" }),
    });
    expect(container.querySelector(".magnitude")?.textContent).toBe("M不明");
    expect(container.textContent).not.toContain("NaN");
  });

  it("ごく浅い震源は距離へ置換せず、数値用 NumberUnit ではなく通常テキストで描画する", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({ depth: "ごく浅い" }) });
    expect(container.querySelector(".depth")?.textContent).toBe("ごく浅い");
    expect(container.querySelector(".depth .nu-value")).toBeNull();
    expect(container.textContent).not.toContain("~10km");
  });

  it("upper bound 付きのごく浅い震源は文言だけを表示し ? badge を付けない", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({
      depth: "ごく浅い",
      depthSemantic: {
        ...magnitudeSemantic({}),
        raw: "-0",
        presence: "qualitative",
        label: "ごく浅い",
        description: "ごく浅い",
        upperBound: 5,
        badge: null,
        color: "safetyRank",
        render: true,
      },
    }) });
    const depth = container.querySelector(".depth");
    expect(depth?.textContent).toBe("ごく浅い");
    expect(depth?.querySelector(".semantic-badge")).toBeNull();
    expect(depth?.getAttribute("aria-label")).toBe("深さ: ごく浅い");
  });

  it("stat-value は他カードと同じ px 床を持ち、int-chip は tabular-nums を持つ", () => {
    const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf8");
    expect(source).toContain("font-size: max(14px, var(--type-body-l-fluid))");
    expect(source).toMatch(/\.int-chip[^}]*font-variant-numeric: tabular-nums/s);
  });

  it("restored な長周期 rider を『同期中』付きで描画する", () => {
    const { container } = render(LatestQuakeCard, {
      quake: latestQuake(),
      longPeriod: { maxLgInt: "3", restored: true },
    });
    expect(container.querySelector(".long-period-rider")?.textContent).toContain("長周期地震動階級 3");
    expect(container.textContent).toContain("同期中");
  });

  it("intensityGroups の地域を都道府県 → 市区町村の階層で render する (第3波 Fix7)", () => {
    const quake = latestQuake({
      intensityGroups: [
        { intensity: "5弱", rank: 5, areas: ["宮崎県宮崎市", "宮崎県都城市"], omittedAreaCount: 0 },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });
    const groups = container.querySelectorAll(".groups li");
    expect(groups.length).toBe(1);
    expect(groups[0].textContent).toContain("震度5弱");
    expect(groups[0].querySelector(".pref-name")?.textContent).toBe("宮崎県");
    // 第3波 Fix14: 市区町村名は個別 span (white-space:nowrap) で render し、区切りは
    // 文字 (旧「・」) ではなく gap で表現する (名前の途中で改行しない)
    expect(
      Array.from(groups[0].querySelectorAll(".city-name")).map((el) => el.textContent),
    ).toEqual(["宮崎市", "都城市"]);
  });

  it("最大値と地域別の qualifier を badge・tooltip・aria 付きで完全表示する", () => {
    const lower = semantic({
      raw: "5弱以上未入電", presence: "qualitative", label: "5弱以上（未入電）",
      condition: "5弱以上未入電", lowerBound: "5-", badge: "≥", color: "safetyRank",
      safetyLowerRank: 5, safetyUpperRank: null, safetyRank: 5, colorRank: 5,
    });
    const unknown = semantic({
      raw: "未入電", presence: "unknown", label: "不明（未入電）", condition: "未入電",
      badge: "?", color: "unknown", safetyLowerRank: null, safetyUpperRank: null,
      safetyRank: null, colorRank: null,
    });
    const { container } = render(LatestQuakeCard, { quake: latestQuake({
      maxInt: "", maxIntRank: 5, maxIntSemantic: lower,
      intensityGroups: [{
        intensity: "不明（未入電）", rank: -1, intensitySemantic: unknown,
        areas: ["宮崎県宮崎市"], omittedAreaCount: 0,
      }],
    }) });
    const maximum = container.querySelector(".int-chip");
    expect(maximum?.textContent).toBe("5弱以上（未入電）≥");
    expect(maximum?.getAttribute("title")).toContain("以上（下限値）");
    const group = container.querySelector(".g-int");
    expect(group?.textContent).toBe("震度不明（未入電）?");
    expect(group?.classList.contains("special-unknown")).toBe(true);
    expect(group?.getAttribute("title")).toBe("震度不明（未入電）、記号 ?: 不明、理由: 未入電");
    expect(group?.getAttribute("aria-label")).toBe("震度不明（未入電）、記号 ?: 不明、理由: 未入電");
    const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf8");
    expect(source).toMatch(/\.int-chip\s*\{[^}]*max-width: 12em;[^}]*overflow-wrap: anywhere;/s);
  });

  it("semantic missing は旧 scalar より権威があり最大値・地域行を描画しない", () => {
    const missing = semantic({
      raw: null, presence: "missing", label: null, badge: null, color: "notRendered",
      render: false, safetyLowerRank: null, safetyUpperRank: null, safetyRank: null, colorRank: null,
    });
    const { container } = render(LatestQuakeCard, { quake: latestQuake({
      maxInt: "7", maxIntRank: 9, maxIntSemantic: missing,
      intensityGroups: [
        { intensity: "4", rank: 4, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 },
        { intensity: "7", rank: 9, intensitySemantic: missing, areas: ["地域欠落"], omittedAreaCount: 0 },
      ],
    }) });
    expect(container.querySelector(".summary-row .int-chip")).toBeNull();
    expect(container.querySelector(".banner-header")?.classList.contains("critical")).toBe(false);
    expect(container.querySelectorAll(".groups li")).toHaveLength(1);
    expect(container.textContent).not.toContain("地域欠落");
    expect(container.textContent).not.toContain("震度7");
  });

  it("unknown 専用色規則は全 rank 規則より後かつ高詳細度で定義する", () => {
    const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf8");
    const rankEnd = source.lastIndexOf(".int-r9");
    const unknownRule = source.indexOf(".int-chip.special-unknown");
    expect(unknownRule).toBeGreaterThan(rankEnd);
    expect(source).toMatch(/\.int-chip\.special-unknown,[\s\S]*?\.g-int\.special-unknown\s*\{\s*color: var\(--c-raspberry\)/);
  });

  // T7 回帰修正 (spec §2-b の静的リスト例「震度6強 宮崎市 日南市」どおり): 県名で始まらない
  // 地域名は静的リストでは「その他」ラベルを出さず、市名だけを render する (旧実装は
  // pref:null バケツにも「その他」ラベルを出しており、2026-07-08 の groupByPrefecture
  // 3分岐化前の見た目からの劣化だった)
  it("県名で始まらない地域名は「その他」ラベル無しで市名だけ render する", () => {
    const quake = latestQuake({
      intensityGroups: [
        { intensity: "5弱", rank: 5, areas: ["宮崎市", "都城市"], omittedAreaCount: 0 },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });
    const group = container.querySelector(".groups li");
    expect(group?.querySelector(".pref-name")).toBeNull();
    expect(
      Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
    ).toEqual(["宮崎市", "都城市"]);
  });

  it("複数県にまたがる intensityGroups でも震度チップが行頭に固定される (第3波 Fix6)", () => {
    const quake = latestQuake({
      intensityGroups: [
        {
          intensity: "6強", rank: 8,
          areas: ["宮城県涌谷町", "宮城県登米市", "福島県白河市", "福島県須賀川市"],
          omittedAreaCount: 0,
        },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });
    const li = container.querySelector(".groups li");
    expect(li?.querySelectorAll(".pref-group").length).toBe(2);
    // align-items: flex-start でチップが行頭固定されていることをスタイルソースで確認
    const src = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    expect(src).toMatch(/\.groups li \{[\s\S]*?align-items:\s*flex-start;[\s\S]*?\}/);
  });

  it("tsunamiWarning: true で「津波」マークを render する", () => {
    const quake = latestQuake({ tsunamiWarning: true });
    const { container } = render(LatestQuakeCard, { quake });
    expect(container.querySelector(".tsunami-mark")?.textContent).toBe("津波");
  });

  it("tsunamiWarning: false では「津波」マークを render しない", () => {
    const quake = latestQuake({ tsunamiWarning: false });
    const { container } = render(LatestQuakeCard, { quake });
    expect(container.querySelector(".tsunami-mark")).toBeFalsy();
  });

  it("intensityGroups[0].omittedAreaCount: 4 で当該行に「ほか4地域」を render する", () => {
    const quake = latestQuake({
      intensityGroups: [
        { intensity: "5弱", rank: 5, areas: ["宮崎県宮崎市", "宮崎県都城市"], omittedAreaCount: 4 },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });
    const omitted = container.querySelector(".g-omitted");
    expect(omitted?.textContent).toBe("ほか4地域");
  });

  // 固定サマリ計器 + ページング転換 (T5a): 全件を静的リストに収まらない (totalEffective>30)
  // ときだけ詳細ページングへ降ろす。収まる間は groups-fixed/groups-scroll の分割をせず、
  // 全グループを1本の静的リストで並べる (spec §4 決定表、自動スクロールは撤去)
  it("静的リスト (totalEffective<=30) では全グループを .groups に大きい震度順で並べ、ページャは出さない", () => {
    const quake = latestQuake({
      intensityGroups: [
        { intensity: "7", rank: 9, areas: ["宮城県栗原市"], omittedAreaCount: 0 },
        { intensity: "6強", rank: 8, areas: ["福島県白河市"], omittedAreaCount: 0 },
        { intensity: "6弱", rank: 7, areas: ["岩手県大船渡市"], omittedAreaCount: 0 },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });
    const items = Array.from(container.querySelectorAll(".groups li"));
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("震度7"),
      expect.stringContaining("震度6強"),
      expect.stringContaining("震度6弱"),
    ]);
    expect(container.querySelector(".page-detail")).toBeFalsy();
  });

  // 南海トラフ級 (震度7 単体で 153市町村) では totalEffective>30 のため詳細ページングへ降りる。
  it("totalEffective が閾値超なら .groups は render されず詳細ページング (.page-detail) に置き換わる", () => {
    const bigAreas = [
      ...Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`),
      ...Array.from({ length: 27 }, (_, i) => `愛知県市町村${i}`),
    ];
    const quake = latestQuake({
      intensityGroups: [
        { intensity: "7", rank: 9, areas: bigAreas, omittedAreaCount: 0 },
        { intensity: "6強", rank: 8, areas: ["山梨県甲府市"], omittedAreaCount: 0 },
      ],
    });
    const { container } = render(LatestQuakeCard, { quake });

    expect(container.querySelector(".groups")).toBeFalsy();

    // 詳細ページ (先頭ページは最大震度グループ、市町村数バジェットで分割される)
    const page = container.querySelector(".page-detail");
    expect(page?.querySelector(".page-title")?.textContent).toBe("観測震度 詳細");
    expect(page?.querySelector(".page-count")).toBeFalsy();
    expect(container.querySelector(".instruments")).toBeFalsy();
    // sequential partition は overflow まで詰めるため、末尾の半端ページへ次の震度を同居させる。
    expectCurrentDot(page, 1, 4);
    expect(page?.querySelector(".pref-name")?.textContent).toBe("高知県");
  });

  it("1件のみの通常データではページャを出さず静的リストのまま", () => {
    const quake = latestQuake({
      intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 }],
    });
    const { container } = render(LatestQuakeCard, { quake });
    expect(container.querySelector(".groups li")?.textContent).toContain("震度5弱");
    expect(container.querySelector(".page-detail")).toBeFalsy();
  });

  it("市区町村名は white-space:nowrap の city-name span で、名前の途中で改行しない (第3波 Fix14)", () => {
    const src = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    expect(src).toMatch(/\.city-name\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/);
    expect(src).not.toContain('pg.cities.join("・")');
  });

  // 詳細ページング (T5a: spec §3/§4、市町村数バジェット制 review-T5a-2 FIX-A)
  describe("詳細ページング", () => {
    it("本文 budget 20 満杯でも最初の section 見出しを含めて 2 ページに割る", () => {
      const areas = Array.from({ length: 20 }, (_, i) => `高知県市町村${i}`);
      const quake = latestQuake({
        intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 11 }],
      });
      const { container } = render(LatestQuakeCard, { quake });

      expectCurrentDot(container.querySelector(".page-detail"), 1, 2);
    });

    it("10県153市町村は各県 15〜18件でバジェット(20)の半分を超えるため県ごとに1ページ、計10ページに割れる", () => {
      const perPref = Math.floor(153 / 10);
      const areas = tenPrefAreas(perPref);
      // 端数 (153 - perPref*10) を最後の県に足す
      for (let i = 0; i < 153 - perPref * 10; i++) areas.push(`大分県市町村${perPref + i}`);
      const quake = latestQuake({
        intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
      });
      const { container } = render(LatestQuakeCard, { quake });
      const page = container.querySelector(".page-detail");
      expect(page?.querySelector(".page-title")?.textContent).toBe("観測震度 詳細");
      expect(page?.querySelector(".g-int")?.textContent).toContain("震度7");
      expect(page?.querySelector(".page-count")).toBeFalsy();
      expectCurrentDot(page, 1, 11);
    });

    // 大県分断 (review-T5a-2 FIX-A): 1県がバジェット超のときページをまたいで分割し、
    // 継続ページの県名に「（続き）」を付ける
    it("1県がバジェット(20)を超えるページ送り後、続きページの県名に「（続き）」が付く", () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
        const quake = latestQuake({
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        });
        const { container } = render(LatestQuakeCard, { quake });
        expectCurrentDot(container, 1, 2);
        expect(container.querySelector(".pref-name")?.textContent).toBe("高知県");

        vi.advanceTimersByTime(TIME_SLICE_PERIOD_MS);
        settlePage();
        expectCurrentDot(container, 2, 2);
        expect(container.querySelector(".pref-name")?.textContent).toBe("高知県（続き）");
      } finally {
        vi.useRealTimers();
      }
    });

    it("15秒共有機構だけで1ページ進み、旧10秒 cycler の二重 timer を持たない", () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
        const view = render(LatestQuakeCard, { quake: latestQuake({
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        }) });
        const card = view.container.querySelector<HTMLElement>(".quake-card")!;
        expect(card.dataset.cardPage).toBe("1/2");
        expect(vi.getTimerCount()).toBe(1);
        vi.advanceTimersByTime(10_000);
        settlePage();
        expect(card.dataset.cardPage).toBe("1/2");
        vi.advanceTimersByTime(5_000);
        settlePage();
        expect(card.dataset.cardPage).toBe("2/2");
        expect(vi.getTimerCount()).toBe(1);
        expect(new Set(JSON.parse(card.dataset.cardPageIdentities ?? "[]") as string[]).size).toBe(2);
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("実カードが1ページ化した exit で page substate と timer を解放する", async () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
        const view = render(LatestQuakeCard, { quake: latestQuake({
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        }) });
        expect(view.container.querySelector<HTMLElement>(".quake-card")?.dataset.cardPage).toBe("1/2");
        expect(vi.getTimerCount()).toBe(1);
        await view.rerender({ quake: latestQuake({
          intensityGroups: [{ intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 0 }],
        }) });
        settlePage();
        expect(view.container.querySelector<HTMLElement>(".quake-card")?.dataset.cardPage).toBe("1/1");
        expect(vi.getTimerCount()).toBe(0);
        view.unmount();
      } finally {
        vi.useRealTimers();
      }
    });

    it("実カード消滅は自分だけをexitし、最後のpageableカードで共有timerを解放する", async () => {
      vi.useFakeTimers();
      try {
        const pageCoordinator = createCardPageCoordinator();
        const quakeView = render(LatestQuakeCard, { pageCoordinator, quake: latestQuake({
          intensityGroups: [{ intensity: "7", rank: 9, areas: Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`), omittedAreaCount: 0 }],
        }) });
        const weatherView = render(WeatherAlertCard, {
          pageCoordinator,
          pageScheduling: true,
          alerts: [{
            source: "vpww56", label: "気象警報", role: "weatherWarning", totalAreas: 9,
            updatedAt: "2026-07-08T09:00:00+09:00",
            items: [{ kind: "大雨警報", displaySeverity: "warning", rank: "warning", shownAreas: Array.from({ length: 9 }, (_, i) => `地域${i}`), omittedAreaCount: 0 }],
          }],
        });
        expect(vi.getTimerCount()).toBe(1);
        await quakeView.rerender({ pageCoordinator, pageScheduling: false, quake: latestQuake() });
        settlePage();
        expect(vi.getTimerCount()).toBe(1);
        await weatherView.rerender({ pageCoordinator, pageScheduling: false, alerts: [] });
        settlePage();
        expect(vi.getTimerCount()).toBe(0);
        quakeView.unmount();
        weatherView.unmount();
        pageCoordinator.dispose();
      } finally {
        vi.useRealTimers();
      }
    });

    it("U3 probe が最初の候補を収容不能と返したら infeasible を明示して恒久ページ化しない", () => {
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [{ intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 3 }] }),
        partitionProbe: () => 2,
      });
      const card = view.container.querySelector<HTMLElement>(".quake-card")!;
      expect(card.dataset.cardPageInfeasible).toBe("true");
      expect(card.dataset.cardPage).toBe("0/0");
      expect(view.container.querySelector(".page-detail")).toBeNull();
    });

    it("measurementRange は一枚でも専用 page body に固定し、静的全候補表示へ戻さない", () => {
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [{
          intensity: "7", rank: 9, areas: ["高知県高知市", "高知県室戸市"], omittedAreaCount: 0,
        }] }),
        measurementRange: { start: 0, end: 1, tails: [], omittedAreaCount: 0 },
      });
      expect(view.container.querySelector("[data-page-probe-body]")).toBeTruthy();
      expect(view.container.querySelector(".groups")).toBeNull();
      expect(view.container.querySelector("[data-page-probe-body]")?.textContent).toContain("高知市");
      expect(view.container.querySelector("[data-page-probe-body]")?.textContent).not.toContain("室戸市");
    });

    it("tail-only 震度group は他groupの複数ページ後にも残置行へ到達する", () => {
      const pageCoordinator = createCardPageCoordinator({ tickOverride: 2 });
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [
          { intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 0 },
          { intensity: "6強", rank: 8, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 },
          { intensity: "6弱", rank: 7, areas: [], omittedAreaCount: 13 },
        ] }),
        pageCoordinator,
        partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
      });
      const card = view.container.querySelector<HTMLElement>(".quake-card")!;
      expect(card.dataset.cardPage).toBe("3/3");
      expect(card.textContent).toContain("ほか13地域");
      view.unmount();
      pageCoordinator.dispose();
    });

    it("先行 tail-only 震度group は後続の複数ページより前のcanonical位置に残る", () => {
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [
          { intensity: "7", rank: 9, areas: [], omittedAreaCount: 13 },
          { intensity: "6強", rank: 8, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 },
          { intensity: "6弱", rank: 7, areas: ["高知県高知市"], omittedAreaCount: 0 },
        ] }),
        partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
      });
      const card = view.container.querySelector<HTMLElement>(".quake-card")!;
      expect(card.dataset.cardPage).toBe("1/3");
      expect(card.textContent).toContain("ほか13地域");
      expect(card.textContent).not.toContain("宮崎市");
    });

    it("tail-only identity は前方候補の追加削除後も同じページを維持する", async () => {
      const pageCoordinator = createCardPageCoordinator();
      const tail = { intensity: "6強", rank: 8, areas: [], omittedAreaCount: 13 };
      const after = { intensity: "6弱", rank: 7, areas: ["高知県高知市"], omittedAreaCount: 0 };
      const partitionProbe = (_key: string, _placement: "side" | "center", range: { start: number; end: number }) => range.end - range.start > 1 ? 2 : 0;
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [{ intensity: "7", rank: 9, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 }, tail, after] }),
        pageCoordinator,
        partitionProbe,
      });
      const card = view.container.querySelector<HTMLElement>(".quake-card")!;
      expect(JSON.parse(card.dataset.cardPageIdentities ?? "[]")).toContain("8:6強|<tail>|0");
      pageCoordinator.jumpTo("quake", 1);
      await tick();
      expect(card.dataset.cardPage).toBe("2/3");
      await view.rerender({
        quake: latestQuake({ intensityGroups: [{ intensity: "5弱", rank: 5, areas: ["愛媛県松山市"], omittedAreaCount: 0 }, { intensity: "7", rank: 9, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 }, tail, after] }),
        pageCoordinator,
        partitionProbe,
      });
      await tick();
      expect(card.dataset.cardPage).toBe("3/4");
      await view.rerender({
        quake: latestQuake({ intensityGroups: [{ intensity: "7", rank: 9, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 }, tail, after] }),
        pageCoordinator,
        partitionProbe,
      });
      await tick();
      expect(card.dataset.cardPage).toBe("2/3");
      view.unmount();
      pageCoordinator.dispose();
    });

    it("同名地域の repartition でもcanonical occurrenceで次のページを維持する", async () => {
      const pageCoordinator = createCardPageCoordinator({ tickOverride: 1 });
      const quake = latestQuake({ intensityGroups: [
        { intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 0 },
        { intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 0 },
        { intensity: "7", rank: 9, areas: ["高知県高知市"], omittedAreaCount: 0 },
      ] });
      const view = render(LatestQuakeCard, {
        quake,
        pageCoordinator,
        partitionProbe: (_key, _placement, range) => range.end - range.start > 1 ? 2 : 0,
      });
      const card = view.container.querySelector<HTMLElement>(".quake-card")!;
      expect(JSON.parse(card.dataset.cardPageIdentities ?? "[]")).toEqual(["9:7|高知市|0", "9:7|高知市|1", "9:7|高知市|2"]);
      await view.rerender({
        quake,
        pageCoordinator,
        partitionProbe: (_key, _placement, range) => range.end - range.start > 2 ? 2 : 0,
      });
      expect(JSON.parse(card.dataset.cardPageIdentities ?? "[]")).toEqual(["9:7|高知市|0", "9:7|高知市|2"]);
      expect(card.dataset.cardPage).toBe("2/2");
      view.unmount();
      pageCoordinator.dispose();
    });

    it("candidate truncated の残数を該当震度の最終ページに残す", () => {
      const pageCoordinator = createCardPageCoordinator({ tickOverride: 1 });
      const view = render(LatestQuakeCard, {
        quake: latestQuake({ intensityGroups: [{
          intensity: "7", rank: 9,
          areas: Array.from({ length: 20 }, (_, i) => `高知県市町村${i}`),
          omittedAreaCount: 11,
        }] }),
        pageCoordinator,
      });
      expect(view.container.querySelector<HTMLElement>(".quake-card")?.dataset.cardPage).toBe("2/2");
      expect(view.container.querySelector(".page-section")?.textContent).toContain("ほか11地域");
      view.unmount();
      pageCoordinator.dispose();
    });

    // Codex R レビュー M2: severityTier (地震は最大震度 rank) が同一イベントの続報中に
    // 「上昇」したときもページを先頭に戻す。下降・同値ではリセットしない (spec §3)
    it("同一イベントで maxIntRank が上昇したらページが先頭に戻る。下降・同値では維持する", async () => {
      vi.useFakeTimers();
      try {
        const areas = tenPrefAreas(15);
        const quake1 = latestQuake({
          eventId: "E-M2",
          maxIntRank: 7,
          intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
        });
        const { container, rerender } = render(LatestQuakeCard, { quake: quake1 });
        expectCurrentDot(container, 1, 10);

        vi.advanceTimersByTime(TIME_SLICE_PERIOD_MS * 2);
        settlePage();
        expectCurrentDot(container, 3, 10);

        // 下降 (rank 7→5、同一 eventId): リセットしない
        await rerender({ quake: { ...quake1, maxIntRank: 5 } });
        settlePage();
        expectCurrentDot(container, 3, 10);

        // 同値 (rank 5→5): リセットしない
        await rerender({ quake: { ...quake1, maxIntRank: 5 } });
        settlePage();
        expectCurrentDot(container, 3, 10);

        // 上昇 (rank 5→9、同一 eventId): 先頭ページに戻る
        await rerender({ quake: { ...quake1, maxIntRank: 9 } });
        settlePage();
        expectCurrentDot(container, 1, 10);
      } finally {
        vi.useRealTimers();
      }
    });

    it("resetSeq (eventId 変化) でページが先頭に戻る。同一イベントの続報ではリセットしない", async () => {
      vi.useFakeTimers();
      try {
        // 10県 x 15件 (バジェット20の半分超) → 県同士が同居せず10ページに割れる
        const areas = tenPrefAreas(15);
        const quake1 = latestQuake({
          eventId: "E1",
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        });
        const { container, rerender } = render(LatestQuakeCard, { quake: quake1 });
        expectCurrentDot(container, 1, 10);

        vi.advanceTimersByTime(TIME_SLICE_PERIOD_MS * 2);
        settlePage();
        expectCurrentDot(container, 3, 10);

        // 同一 eventId の続報 (reportDateTime だけ変わる) ではリセットしない
        await rerender({ quake: { ...quake1, reportDateTime: "2026-07-08T09:05:00+09:00" } });
        settlePage();
        expectCurrentDot(container, 3, 10);

        // 別イベント (eventId 変化) では先頭ページに戻る
        const quake2 = latestQuake({
          eventId: "E2",
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        });
        await rerender({ quake: quake2 });
        settlePage();
        expectCurrentDot(container, 1, 10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // T5c: ページ行容量の画面高さ駆動化 (spec §2-c)。jsdom は ResizeObserver 未実装
  // かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査する
  describe("LatestQuakeCard T5c 配線 (画面高さ駆動)", () => {
    it("Standby path は U3 shelf probe の実組版結果を逐次 partition へ渡す", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain("if (partitionProbe != null) return sequentialPartitionRanges(");
      expect(source).toContain("data-page-probe-body");
      expect(source).not.toContain("detailPageWeight");
      expect(source).toContain("sequentialPartitionRanges(");
    });

    it("ページ切替は共有 coordinator の index を唯一の描画源にして原子的に差し替える", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain("{#key currentPageIndex}");
      expect(source).toContain('pageCoordinator.activeIndex("quake")');
      expect(source).not.toContain("transition:fade");
      expect(source).not.toContain("createPageCycler");
    });

    // Codex R レビュー M1: createPageCycler は $effect.root で独立 root を持つため、消費側が
    // destroy() を呼ばないと unmount (待機カードの流れ替え) で timer/matchMedia listener が
    // リークする。page-cycler.svelte.ts 側には「destroy 後はタイマーが発火しない」の単体
    // テストが既にあるため、消費側はソースの配線だけを検査する
    it("所有する coordinator だけを unmount で dispose し、共有 substate は placement remount で破棄しない", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain("if (ownsPageCoordinator) pageCoordinator.dispose()");
      expect(source).not.toContain("cycler.destroy()");
    });

    it("原子的なページ差し替え用の固定枠として .page-detail と .page-fade の寸法を維持する", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toMatch(/\.page-detail\s*\{[^}]*position: relative;/);
      expect(source).toMatch(/\.page-detail\s*\{[^}]*height: calc\(7 \* 1\.6em \+ 4px\);/);
      expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    });
  });
});
