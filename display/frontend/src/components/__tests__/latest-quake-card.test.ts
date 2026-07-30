import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import LatestQuakeCard from "../LatestQuakeCard.svelte";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";
import type { DisplayLatestQuakeStateV1 } from "../../lib/protocol";

// T5c: ページ切替は {#key} + transition:fade (重ねクロスフェード、231ms) になった。
// fake timers 環境では element.animate() スタブ (test-setup.ts) の完了が setTimeout 経由なので、
// ページ送りのタイマーを進めた直後だけでなく、フェード時間ぶんも追加で進めてから DOM を読む
// (現物のブラウザでも「切替が完了してから次の状態を見る」のと同じ意味)
function settleFade(): void {
  vi.advanceTimersByTime(1000);
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

  it("magnitude が null なら規模欄は空のまま (NumberUnit を出さない)", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({ magnitude: null }) });
    expect(container.querySelector(".magnitude")?.textContent).toBe("");
  });

  it("ごく浅い震源は距離へ置換せず、数値用 NumberUnit ではなく通常テキストで描画する", () => {
    const { container } = render(LatestQuakeCard, { quake: latestQuake({ depth: "ごく浅い" }) });
    expect(container.querySelector(".depth")?.textContent).toBe("ごく浅い");
    expect(container.querySelector(".depth .nu-value")).toBeNull();
    expect(container.textContent).not.toContain("~10km");
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
    // 高知(31)・愛知(27) ともバジェット(20)超のため各県が2ページに分断され、震度7グループ内で計4ページ
    // 最終の半端ページは次の震度セクションを同居させるため、全4ページになる
    expectCurrentDot(page, 1, 5);
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

        vi.advanceTimersByTime(PAGE_HOLD_MS);
        settleFade();
        expectCurrentDot(container, 2, 2);
        expect(container.querySelector(".pref-name")?.textContent).toBe("高知県（続き）");
      } finally {
        vi.useRealTimers();
      }
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

        vi.advanceTimersByTime(PAGE_HOLD_MS * 2);
        settleFade();
        expectCurrentDot(container, 3, 10);

        // 下降 (rank 7→5、同一 eventId): リセットしない
        await rerender({ quake: { ...quake1, maxIntRank: 5 } });
        settleFade();
        expectCurrentDot(container, 3, 10);

        // 同値 (rank 5→5): リセットしない
        await rerender({ quake: { ...quake1, maxIntRank: 5 } });
        settleFade();
        expectCurrentDot(container, 3, 10);

        // 上昇 (rank 5→9、同一 eventId): 先頭ページに戻る
        await rerender({ quake: { ...quake1, maxIntRank: 9 } });
        settleFade();
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

        vi.advanceTimersByTime(PAGE_HOLD_MS * 2);
        settleFade();
        expectCurrentDot(container, 3, 10);

        // 同一 eventId の続報 (reportDateTime だけ変わる) ではリセットしない
        await rerender({ quake: { ...quake1, reportDateTime: "2026-07-08T09:05:00+09:00" } });
        settleFade();
        expectCurrentDot(container, 3, 10);

        // 別イベント (eventId 変化) では先頭ページに戻る
        const quake2 = latestQuake({
          eventId: "E2",
          intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
        });
        await rerender({ quake: quake2 });
        settleFade();
        expectCurrentDot(container, 1, 10);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // T5c: ページ行容量の画面高さ駆動化 + 切替フェード (spec §2-c)。jsdom は ResizeObserver 未実装
  // かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査する
  describe("LatestQuakeCard T5c 配線 (画面高さ駆動 + フェード)", () => {
    it("ページ本文は measureHeight (面積+代表行) で実測し、cityBudgetFromArea でバジェットを導出する", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain("cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET)");
      expect(source).toContain('use:measureHeight={(h) => (pageBodyAreaHeight = h)}');
      expect(source).toContain("paginateAreas(quake.intensityGroups, cityBudget, { allowCrossIntensity: true })");
    });

    it("ページ切替は {#key cycler.index} + transition:fade の重ねクロスフェードで、時間/easing は既存の spring-effects-default を流用する (新規定数なし)", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain("{#key cycler.index}");
      expect(source).toContain('import { fade } from "svelte/transition"');
      expect(source).toContain('import { SPRING_EFFECTS_DEFAULT_MS, springEffectsOut } from "../lib/motion"');
      expect(source).toMatch(
        /transition:fade=\{\{\s*duration: cycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
      );
    });

    // Codex R レビュー M1: createPageCycler は $effect.root で独立 root を持つため、消費側が
    // destroy() を呼ばないと unmount (待機カードの流れ替え) で timer/matchMedia listener が
    // リークする。page-cycler.svelte.ts 側には「destroy 後はタイマーが発火しない」の単体
    // テストが既にあるため、消費側はソースの配線だけを検査する
    it("onDestroy で cycler.destroy() を呼ぶ (Codex R M1)", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toContain('import { onDestroy } from "svelte"');
      expect(source).toContain("onDestroy(() => cycler.destroy())");
    });

    it("旧ページと新ページが重なるよう、.page-detail は position:relative + 明示 height を持ち .page-fade は position:absolute で重ねる", () => {
      const source = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
      expect(source).toMatch(/\.page-detail\s*\{[^}]*position: relative;/);
      expect(source).toMatch(/\.page-detail\s*\{[^}]*height: calc\(7 \* 1\.6em \+ 4px\);/);
      expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    });
  });
});
