import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import StandbyScreen from "../StandbyScreen.svelte";
import { baseSnapshot } from "../../lib/__tests__/fixtures";
import type {
  DisplayLatestQuakeStateV1,
  DisplayRecentQuakeV1,
  DisplayStatsV1,
  DisplayTsunamiStateV1,
  DisplayWeatherAlertV1,
  ActiveStandbyCardV1,
  DisplayFloodRiverV1,
} from "../../lib/protocol";

function weatherAlert(over: Partial<DisplayWeatherAlertV1> = {}): DisplayWeatherAlertV1 {
  return {
    source: "vpww56",
    label: "気象特別警報",
    role: "weatherEmergency",
    totalAreas: 1,
    items: [
      {
        kind: "大雨特別警報",
        displaySeverity: "Emergency",
        rank: "emergency",
        shownAreas: ["宮崎市"],
        omittedAreaCount: 0,
      },
    ],
    updatedAt: "2026-07-06T21:00:00+09:00",
    ...over,
  };
}

function latestQuakeState(over: Partial<DisplayLatestQuakeStateV1> = {}): DisplayLatestQuakeStateV1 {
  return {
    eventId: "Q1",
    headline: null,
    originTime: "2026-07-06T20:58:00+09:00",
    hypocenterName: "日向灘",
    depth: "20km",
    magnitude: "5.2",
    maxInt: "5弱",
    maxIntRank: 5,
    tsunamiWarning: false,
    intensityGroups: [],
    reportDateTime: "2026-07-06T21:00:00+09:00",
    updatedAtMs: 0,
    ...over,
  };
}

function statsState(over: Partial<DisplayStatsV1> = {}): DisplayStatsV1 {
  return {
    sparklineData: [1, 2, 3],
    totalReceived: 42,
    todayQuakeCount: 3,
    todayMaxInt: "5弱",
    todayMaxIntRank: 5,
    ...over,
  };
}

function tsunamiState(over: Partial<DisplayTsunamiStateV1> = {}): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [{ name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: null }],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-06T21:00:00+09:00",
    updatedAtMs: 0,
    ...over,
  };
}

function recentQuake(over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: "Q1",
    reportDateTime: "2026-07-06T21:00:00+09:00",
    originTime: "2026-07-06T20:58:00+09:00",
    hypocenterName: "浦河沖",
    magnitude: "5.2",
    maxInt: "4",
    maxIntRank: 5,
    depth: "30km",
    tsunamiWarning: false,
    ...over,
  };
}

function floodStandbyItem(surface: "corner-right" | "clock-top-wide", count: number): Extract<ActiveStandbyCardV1, { kind: "flood" }> {
  const rivers: DisplayFloodRiverV1[] = Array.from({ length: count }, (_, index) => ({
    riverKey: `river-${index}`, riverName: `第${index + 1}川`, level: index === 0 ? "L4" : "L3",
    levelRank: index === 0 ? 40 : 30, kindName: index === 0 ? "氾濫危険情報" : "氾濫警戒情報",
    reportDateTime: "2026-07-21T00:00:00.000Z",
  }));
  return {
    kind: "flood", surface, key: "flood:active", sourceEventIds: ["flood-1"],
    updatedAt: "2026-07-21T00:00:00.000Z", expiresAt: "2026-07-21T12:00:00.000Z",
    restored: false, severity: "critical", data: { rivers },
  };
}

const now = new Date("2026-07-06T21:00:00+09:00");

// ② weatherAlerts render / ③ tsunami 常駐バナー のテストは Phase B (Expressive
// Instrument 再構成) で ActiveAlerts ブロックを StandbyScreen から削除したため撤去した。
// weatherAlerts・tsunami バナーはもう待機画面に出ない (ActiveAlerts.svelte は非テスト参照
// ゼロを確認の上、デッドコードとして削除済み)。

describe("StandbyScreen", () => {
  it("南海トラフバッジは中央帯 (.bottom-stack) の統計行より前に置き、時計スタックには含めない (等間隔リズム 2026-07-22)", () => {
    const src = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    // 時計スタックには南海バッジを含めない (時計高さ実測に混ぜない)
    const clockStack = src.slice(src.indexOf('<div class="clock-stack"'), src.indexOf('</div>', src.indexOf('<div class="clock-stack"')));
    expect(clockStack.indexOf("<Clock {now} />")).toBeGreaterThanOrEqual(0);
    expect(clockStack.indexOf("<NankaiBadge")).toBe(-1);
    // 南海バッジは .bottom-stack 内で統計行スロットより前 (時計下端→南海→統計→カードの順)
    const bottomStack = src.slice(src.indexOf('<div class="bottom-stack">'), src.indexOf('<style>'));
    const nankaiIdx = bottomStack.indexOf("<NankaiBadge");
    const instrumentIdx = bottomStack.indexOf('class="instrument-slot"');
    expect(nankaiIdx).toBeGreaterThanOrEqual(0);
    expect(instrumentIdx).toBeGreaterThan(nankaiIdx);
    // 4 区間の等間隔は space-evenly で作る
    expect(src).toContain("justify-content: space-evenly");
  });

  it("renders normal and wide flood surfaces through one keyed flood slot", async () => {
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [floodStandbyItem("corner-right", 3)] }),
      now, dim: false, sseConnected: true,
    });
    expect(container.querySelectorAll(".flood-slot")).toHaveLength(1);
    expect(container.querySelector(".flood-slot.flood-corner .flood-card")).toBeTruthy();
    expect(container.querySelector(".flood-wide-card")).toBeFalsy();

    await rerender({
      snapshot: baseSnapshot({ standbyItems: [floodStandbyItem("clock-top-wide", 4)] }),
      now, dim: false, sseConnected: true,
    });
    await tick();
    expect(container.querySelectorAll(".flood-slot")).toHaveLength(1);
    expect(container.querySelector(".flood-slot.clock-top-slot .flood-wide-card")).toBeTruthy();
    expect(container.querySelector(".flood-card")).toBeFalsy();
  });

  it("二層 slot: transition は .slot-motion 内枠が持ち、外枠 (dim/計測/flip 対象) は transition を持たない", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    // 4 系統すべて内枠に in/out がある (flood-slot / weather-corner / standby-corner / corner-item)
    expect(source.match(/class="slot-motion"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    // transition ディレクティブは slot-motion 内枠の行にしか現れない (外枠 4 系統のどれに
    // 残存しても FAIL する全称検査。実装は内枠 div を 1 行で書くこと)
    for (const line of source.split("\n").filter((l) => l.includes("in:spatialScaleIn") || l.includes("out:fade"))) {
      expect(line).toContain('class="slot-motion"');
    }
    // 内枠は intro |global (画面切替時の入場演出を維持) + local outro (画面切替を遅らせない)
    expect(source).toContain('class="slot-motion" in:spatialScaleIn|global');
    expect(source).not.toContain("out:fade|global");
  });

  it("flood-slot の surface 切替は独立 translate プロパティの手動 FLIP で補間する (transform 合成を壊さない)", () => {
    const source = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf8");
    // FLIP 対象の外枠に bind がある
    expect(source).toContain("bind:this={floodSlotEl}");
    // 可視 rect → cancel → final rect の順 (先に cancel すると開始点が飛ぶ)。読取が cancel より前
    const readIdx = source.indexOf("floodFlipFirst = floodSlotEl.getBoundingClientRect()");
    const cancelIdx = source.indexOf("floodFlipAnim?.cancel()");
    expect(readIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeGreaterThan(readIdx);
    // ガード: 初回/null 遷移/同値/reduced-motion を除外
    expect(source).toContain("next === prevFloodSurface");
    expect(source).toContain("if (!changed || el == null || first == null || reducedMotion) return");
    expect(source).toMatch(/translate: `\$\{dx\}px \$\{dy\}px`/);
    expect(source).toContain('{ translate: "0px 0px" }');
    // onfinish/oncancel は animation identity を確認する
    expect(source).toContain("if (floodFlipAnim === anim) floodFlipAnim = null");
  });

  it("recentQuakes が空のとき .quakes-card ごと非表示になる (2026-07-11 目視観察の修正)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".quakes-card")).toBeFalsy();
  });

  it("地震カード無し (recentQuakes 0 件) でも統計行は .instrument-slot 内に置かれ、.quakes-card は無い (2026-07-12 中間配置)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [] }),
      now,
      dim: false,
      sseConnected: true,
    });
    const slot = container.querySelector(".bottom-stack .instrument-slot");
    expect(slot).toBeTruthy();
    // 統計行 (.instrument-row-wrap) はスロットの子として存在する
    expect(slot?.querySelector(".instrument-row-wrap")).toBeTruthy();
    expect(container.querySelector(".bottom-stack .quakes-card")).toBeFalsy();
  });

  it("地震カード有り (recentQuakes 1 件以上) では .bottom-stack 内で統計行スロット → カードの縦順になる (2026-07-12 中間配置)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [recentQuake()] }),
      now,
      dim: false,
      sseConnected: true,
    });
    const children = Array.from(container.querySelector(".bottom-stack")?.children ?? []);
    const slotIdx = children.findIndex((c) => c.classList.contains("instrument-slot"));
    const cardIdx = children.findIndex((c) => c.classList.contains("quakes-card"));
    expect(slotIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    // 統計行スロットがカードより前 (= カードは最下段、統計行はその上の残余に中央寄せ)
    expect(slotIdx).toBeLessThan(cardIdx);
    // 統計行はどちらの状態でも同じ .instrument-slot 内にある (状態間で移動する同一要素)
    expect(children[slotIdx].querySelector(".instrument-row-wrap")).toBeTruthy();
  });

  it("統計行の帯上端は時計ブロックの実下端に追従する (時計高さ実測 → calc、日付行との重なり回避 2026-07-12)", () => {
    const src = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    // 時計ブロック (clock-stack) の高さを既存 ResizeObserver action で実測する
    expect(src).toContain("measureBorderHeight");
    expect(src).toMatch(/clockHalfPx\s*=\s*h\s*\/\s*2/);
    // 帯上端は素の 50% ではなく「50% + 時計高さの半分」= 時計ブロック下端
    expect(src).toContain("calc(50% + var(--clock-half, 0px))");
    // 時計高さは px 直値でなく実測値を CSS var 経由で渡す
    expect(src).toMatch(/--clock-half:\s*\{clockHalfPx\}px/);
  });

  it("統計行の状態間移動は spatial spring トークンを流用した FLIP で繋ぐ (新規時間定数を作らない / reduced-motion で瞬時)", () => {
    const src = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    // FLIP: 遷移前後の top を測って WAAPI で translateY アニメを乗せる
    expect(src).toContain("getBoundingClientRect");
    expect(src).toMatch(/\.animate\(/);
    // easing/duration は既存の spatial spring トークンを流用 (新規定数を作らない)
    expect(src).toContain('SPRING_LINEARS["spring-spatial-default"]');
    expect(src).toContain("SPRING_SPATIAL_DEFAULT_MS");
    // reduced-motion では FLIP を打たず瞬時切替にする
    expect(src).toMatch(/reducedMotion\)\s*return/);
    // 走行中アニメのハンドルを保持し、次回計測前と unmount で cancel する (往復時の
    // transform 混入・アニメ蓄積の防止、レビュー Minor)
    expect(src).toMatch(/flipAnim\s*:\s*Animation\s*\|\s*null/);
    expect(src).toMatch(/flipAnim\?\.cancel\(\)/);
    // cancel は計測 (getBoundingClientRect) より前に置く (transform を計測に混ぜない)
    const preBody = src.match(/\$effect\.pre\(\(\)\s*=>\s*\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(preBody.indexOf("cancel()")).toBeGreaterThanOrEqual(0);
    expect(preBody.indexOf("cancel()")).toBeLessThan(preBody.indexOf("getBoundingClientRect"));
  });

  it("recentQuakes が1件以上あれば .quakes-card が render される", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [recentQuake()] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".quakes-card")).toBeTruthy();
  });

  it("① 直近地震 (震央名) が render される", () => {
    render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: [recentQuake({ hypocenterName: "浦河沖" })] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(screen.getByText("浦河沖")).toBeTruthy();
  });

  it("② 震度チップ (短縮表記)・深さ・時刻・津波マークが RecentQuakes 経由で render される", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        recentQuakes: [
          recentQuake({ hypocenterName: "日向灘", maxInt: "5弱", maxIntRank: 5, depth: "20km", tsunamiWarning: true }),
        ],
      }),
      now,
      dim: false,
      sseConnected: true,
    });
    // 待機画面のチップは formatIntShort で「5弱」→「5-」に短縮される (緊急パネル側は従来表記のまま)
    expect(screen.getByText("5-")).toBeTruthy();
    expect(screen.getByText("20km")).toBeTruthy();
    expect(screen.getByText("津波")).toBeTruthy();
    expect(container.querySelector(".int-r5")).toBeTruthy();
  });

  it("④ connection.dmdata===\"disconnected\" で「切断されています」通知が時計上に出る", () => {
    render(StandbyScreen, {
      snapshot: baseSnapshot({
        connection: { dmdata: "disconnected", lastReceivedAt: null, disconnectedSince: "t", reason: "timeout" },
      }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(screen.getByText("切断されています")).toBeTruthy();
  });

  it("⑤ dim=true で root 要素に class=\"dim\" が付く", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot(),
      now,
      dim: true,
      sseConnected: true,
    });
    expect(container.querySelector(".standby")?.classList.contains("dim")).toBe(true);
  });

  it("dim=false では root 要素に class=\"dim\" が付かない", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot(),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".standby")?.classList.contains("dim")).toBe(false);
  });

  it("snapshot.tsunami != null なら津波継続バナーが左上に render される (Phase 2)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: tsunamiState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".tsunami-corner")).toBeTruthy();
    expect(container.querySelector(".banner-title")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "津波警報 発令中",
    );
  });

  it("snapshot.tsunami が null なら津波継続バナーは render されない", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: null }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".tsunami-corner")).toBeFalsy();
  });

  it("dim=true のとき津波継続バナーも他の周辺ブロック (quakes-card 等) と同じ dim 対象に含まれる", () => {
    // CSS の実解決値 (opacity) ではなく、.standby.dim 配下に .tsunami-corner が
    // quakes-card と同格の子要素として存在すること (CSS ルールの適用対象) を検証する。
    // 実 opacity 値のテストは jsdom の CSS 解決の信頼性が低いため避ける (このプロジェクトの既存規約)。
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: tsunamiState(), recentQuakes: [recentQuake()] }),
      now,
      dim: true,
      sseConnected: true,
    });
    const root = container.querySelector(".standby.dim");
    expect(root?.querySelector(".tsunami-corner")).toBeTruthy();
    expect(root?.querySelector(".quakes-card")).toBeTruthy();
  });

  it("weatherAlerts に特別警報を積むと .weather-corner 配下に「気象特別警報」が render される (Task 13)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ weatherAlerts: [weatherAlert()] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".weather-corner")?.textContent).toContain("気象特別警報");
  });

  it("VPWW56 の officialL4 は wire label を変えず待機カード見出しを「気象危険警報」へ昇格する", () => {
    const alert = weatherAlert({
      source: "vpww56",
      label: "土砂災害警戒情報",
      role: "weatherWarning",
      items: [{
        kind: "L4 土砂災害危険警報",
        displaySeverity: "officialL4",
        rank: "warning",
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
    });
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ weatherAlerts: [alert] }),
      now,
      dim: false,
      sseConnected: true,
    });

    expect(container.querySelector(".weather-corner .card-header")?.textContent).toContain("気象危険警報");
  });

  it("officialL4 と officialL5 の併発では「気象特別警報」が勝つ", () => {
    const l4 = weatherAlert({
      source: "vpww56",
      label: "土砂災害警戒情報",
      role: "weatherWarning",
      items: [{
        kind: "L4 土砂災害危険警報",
        displaySeverity: "officialL4",
        rank: "warning",
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
    });
    const l5 = weatherAlert({
      source: "vpws50",
      label: "気象特別警報",
      role: "weatherEmergency",
      items: [{
        kind: "L5 大雨特別警報",
        displaySeverity: "officialL5",
        rank: "emergency",
        shownAreas: ["千葉県"],
        omittedAreaCount: 0,
      }],
    });
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ weatherAlerts: [l4, l5] }),
      now,
      dim: false,
      sseConnected: true,
    });

    expect(container.querySelector(".weather-corner .card-header")?.textContent).toContain("気象特別警報");
    expect(container.querySelector(".weather-corner .card-header")?.textContent).not.toContain("気象危険警報");
  });

  it("L4 を含まない続報へ更新されると見出しを「気象警報」へ戻す", async () => {
    const l4 = weatherAlert({
      source: "vpww56",
      label: "土砂災害警戒情報",
      role: "weatherWarning",
      items: [{
        kind: "L4 土砂災害危険警報",
        displaySeverity: "officialL4",
        rank: "warning",
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
    });
    const l3 = weatherAlert({
      source: "vpws50",
      label: "気象警報",
      role: "weatherWarning",
      items: [{
        kind: "L3 大雨警報",
        displaySeverity: "officialL3",
        rank: "warning",
        shownAreas: ["東京都"],
        omittedAreaCount: 0,
      }],
    });
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ weatherAlerts: [l4] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".weather-corner .card-header")?.textContent).toContain("気象危険警報");

    await rerender({
      snapshot: baseSnapshot({ weatherAlerts: [l3] }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".weather-corner .card-header")?.textContent).toContain("気象警報");
    expect(container.querySelector(".weather-corner .card-header")?.textContent).not.toContain("気象危険警報");
  });

  it("latestQuake を積むと .quake-corner 配下に震源名が render される (Task 13)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ latestQuake: latestQuakeState({ hypocenterName: "日向灘" }) }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".quake-corner")?.textContent).toContain("日向灘");
  });

  it("stats を積むと .instrument-row-wrap 配下に「受信」が render される (Task 13)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ stats: statsState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(container.querySelector(".instrument-row-wrap")?.textContent).toContain("受信");
  });

  it("dim=true のとき .weather-corner / .quake-corner / .instrument-row-wrap も同格の子として dim 対象に含まれる (Task 13)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        weatherAlerts: [weatherAlert()],
        latestQuake: latestQuakeState(),
        stats: statsState(),
      }),
      now,
      dim: true,
      sseConnected: true,
    });
    const root = container.querySelector(".standby.dim");
    expect(root?.querySelector(".weather-corner")).toBeTruthy();
    expect(root?.querySelector(".quake-corner")).toBeTruthy();
    expect(root?.querySelector(".instrument-row-wrap")).toBeTruthy();
  });

  it("津波 null + latestQuake ありのとき .corner-left 最上段に .quake-corner が来る (tsunami-corner 不在) (Task 13)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: null, latestQuake: latestQuakeState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    const cornerLeft = container.querySelector(".corner-left");
    expect(cornerLeft?.querySelector(".tsunami-corner")).toBeFalsy();
    expect(cornerLeft?.firstElementChild?.classList.contains("quake-corner")).toBe(true);
  });

  it("津波+地震 両方ありのとき .corner-left の先頭は .tsunami-corner (Task 13 修正)", () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: tsunamiState(), latestQuake: latestQuakeState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    const cornerLeft = container.querySelector(".corner-left");
    expect(cornerLeft?.firstElementChild?.classList.contains("tsunami-corner")).toBe(true);
  });

  it("待機カードの int-chip は radius-s トークン参照で直値 8px を持たない", () => {
    const recent = readFileSync(join(__dirname, "..", "RecentQuakes.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [recent, latest]) {
      expect(src).toContain("var(--radius-s)");
      expect(src).not.toMatch(/border-radius:\s*8px/);
    }
  });

  it("津波あり/なしで .corner-left の keyed item (.corner-item) 数が変わる (Task 7: flip/transition スタック化)", () => {
    const { container: withTsunami } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: tsunamiState(), latestQuake: latestQuakeState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(withTsunami.querySelectorAll(".corner-left .corner-item").length).toBe(2);

    const { container: withoutTsunami } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: null, latestQuake: latestQuakeState() }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(withoutTsunami.querySelectorAll(".corner-left .corner-item").length).toBe(1);
  });

  it("津波バナーは一般減光グループではなく警報級 (専用) グループに属する (Task 13 修正: severity 反転回帰ガード)", () => {
    // jsdom は実効 opacity を解決しないため、コンポーネント CSS ソースのセレクタ構造を
    // 直接検査する。「.tsunami-corner が .quake-corner 等の一般セレクタ列に
    // 含まれず、.weather-corner と同じ専用減光ルールに属する」ことを固定する。
    // 現状は両グループとも子 opacity 0.7 (親 0.35 と乗算で実効約 0.25) だが、
    // 減光率を分けられる構造 (別セレクタ列) が保たれていることを検証する。
    const source = readFileSync(
      join(__dirname, "..", "StandbyScreen.svelte"),
      "utf-8",
    );
    const generalDimMatch = source.match(/\.standby\.dim\s+\.quake-corner[\s\S]*?\{\s*opacity:\s*0\.7;\s*\}/);
    expect(generalDimMatch).toBeTruthy();
    expect(generalDimMatch?.[0]).not.toContain(".tsunami-corner");

    const emergencyDimMatch = source.match(
      /\.standby\.dim\s+\.weather-corner[\s\S]*?\{\s*opacity:\s*0\.7;\s*\}/,
    );
    expect(emergencyDimMatch).toBeTruthy();
    expect(emergencyDimMatch?.[0]).toContain(".tsunami-corner");
  });

  it("待機カード類は elevation-2 の box-shadow を持つ (B2b)", () => {
    for (const f of ["LatestQuakeCard.svelte", "WeatherAlertCard.svelte", "TsunamiStandbyBanner.svelte"]) {
      const src = readFileSync(join(__dirname, "..", f), "utf-8");
      expect(src, f).toContain("box-shadow: var(--elevation-2)");
    }
  });

  it("StandbyScreen は spatialScaleIn/springSpatialOut を使い組込 scale を使わない (B3, Codex R2)", () => {
    const src = readFileSync(join(__dirname, "..", "StandbyScreen.svelte"), "utf-8");
    expect(src).toContain("spatialScaleIn");
    expect(src).toContain("springSpatialOut");
    // opacity に overshoot が乗る組込 scale transition を使っていないこと
    expect(src).not.toMatch(/in:scale\b/);
    // svelte/transition から scale を import していないこと
    expect(src).not.toMatch(/import\s*\{[^}]*\bscale\b[^}]*\}\s*from\s*"svelte\/transition"/);
  });
});

// 地震履歴クリック overlay (2026-07-14, 設計 v2 確定事項 5)。transition のちらつきを避けるため
// reduced-motion を強制し exit/enter を 0ms にする (jsdom の raf 駆動 transition を待たない)。
describe("StandbyScreen 地震履歴クリック overlay", () => {
  let matchMediaOriginal: typeof window.matchMedia;
  beforeEach(() => {
    matchMediaOriginal = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: true, // reduced-motion 強制 → enter/exit 0ms
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = matchMediaOriginal;
  });

  function renderWithQuakes(quakes = [recentQuake({ eventId: "A", hypocenterName: "浦河沖" })]) {
    return render(StandbyScreen, {
      snapshot: baseSnapshot({ recentQuakes: quakes }),
      now,
      dim: false,
      sseConnected: true,
    });
  }

  function rowButtons(container: Element): HTMLButtonElement[] {
    return Array.from(container.querySelectorAll<HTMLButtonElement>(".quakes-card button.row"));
  }

  it("履歴行クリックで詳細カードが表示される", async () => {
    const { container } = renderWithQuakes();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    const card = container.querySelector(".quake-replay-card");
    expect(card).toBeTruthy();
    expect(card?.textContent).toContain("浦河沖");
  });

  it("詳細カードは corner-left の地震情報スロット (LatestQuakeCard と同じ位置) に出る (実機フィードバック 2026-07-14)", async () => {
    const { container } = renderWithQuakes();
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    // 画面中央 overlay ではなく corner-left の .corner-item.quake-corner 内に置かれる (時計と被らない)
    const card = container.querySelector(".corner-left .corner-item.quake-corner .quake-replay-card");
    expect(card).toBeTruthy();
    // 旧・中央 overlay 用ラッパは撤去済み
    expect(container.querySelector(".quake-overlay")).toBeFalsy();
  });

  it("LatestQuakeCard 表示中に履歴クリックすると replay がスロットを占有し、LatestQuakeCard は隠れる。閉じると戻る (二重表示しない)", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        latestQuake: latestQuakeState({ hypocenterName: "石垣島近海" }),
        recentQuakes: [recentQuake({ eventId: "A", hypocenterName: "浦河沖" })],
      }),
      now,
      dim: false,
      sseConnected: true,
    });
    // 初期: LatestQuakeCard (.quake-card) がスロットに居る、replay は無い
    expect(container.querySelector(".corner-left .quake-card")).toBeTruthy();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();

    // 履歴クリック → replay がスロットを占有、LatestQuakeCard は消える (別スロットに二重表示しない)
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".corner-left .quake-replay-card")).toBeTruthy();
    expect(container.querySelector(".corner-left .quake-card")).toBeFalsy();
    // corner-left の quake 系スロットは 1 つだけ (二重表示していない)
    expect(container.querySelectorAll(".corner-left .corner-item.quake-corner").length).toBe(1);

    // 閉じる (再クリック) → LatestQuakeCard に戻る
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".corner-left .quake-card")).toBeTruthy();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("20 秒経過で自動クローズする", async () => {
    const { container } = renderWithQuakes();
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
    vi.advanceTimersByTime(19_999);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy(); // まだ開いている
    vi.advanceTimersByTime(1);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy(); // 20 秒で閉じる
  });

  it("同じ項目の再クリックで即クローズする (トグル)", async () => {
    const { container } = renderWithQuakes();
    const btn = rowButtons(container)[0];
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
    btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("別項目クリックで差し替え + タイマーがリセットされる", async () => {
    const { container } = renderWithQuakes([
      recentQuake({ eventId: "A", hypocenterName: "浦河沖" }),
      recentQuake({ eventId: "B", hypocenterName: "日向灘" }),
    ]);
    const btns = rowButtons(container);
    btns[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("浦河沖");

    vi.advanceTimersByTime(15_000); // 1件目のタイマーを 15 秒進める
    btns[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("日向灘"); // 差し替え

    // 1件目クリックから 20 秒 (=差し替え後 5 秒) 経過してもタイマーはリセット済みで閉じない
    vi.advanceTimersByTime(5_000);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
    // 差し替えから 20 秒でようやく閉じる
    vi.advanceTimersByTime(15_000);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("unmount 後に stale なクローズタイマーが発火しても crash しない (タイマー残留なし)", async () => {
    const { container, unmount } = renderWithQuakes();
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    unmount();
    expect(() => {
      vi.advanceTimersByTime(20_000);
    }).not.toThrow();
  });

  it("履歴行クリックは window の click (減光トグル) へ伝播しない", async () => {
    const { container } = renderWithQuakes();
    const windowClick = vi.fn();
    window.addEventListener("click", windowClick);
    try {
      rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("click", windowClick);
    }
  });

  function rerenderQuakes(rerender: (props: Record<string, unknown>) => Promise<void>, quakes: DisplayRecentQuakeV1[]) {
    return rerender({ snapshot: baseSnapshot({ recentQuakes: quakes }), now, dim: false, sseConnected: true });
  }

  it("snapshot 更新で選択中地震が最新 DTO へ差し替わる (訂正報追従、指摘2)。タイマーはリセットしない", async () => {
    const { container, rerender } = renderWithQuakes([recentQuake({ eventId: "A", hypocenterName: "浦河沖", magnitude: "5.2" })]);
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("M5.2");

    vi.advanceTimersByTime(5_000);
    // 同じ eventId で訂正 (規模更新)
    await rerenderQuakes(rerender, [recentQuake({ eventId: "A", hypocenterName: "浦河沖", magnitude: "5.8" })]);
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("M5.8"); // 最新版へ差し替え
    expect(container.querySelector(".quake-replay-card")?.textContent).not.toContain("M5.2");

    // タイマーは維持: 開いてから 20 秒 (差し替え後 15 秒) でちょうど閉じる (リセットなら 25 秒まで開く)
    vi.advanceTimersByTime(14_999);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
    vi.advanceTimersByTime(1);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("選択中地震が snapshot から消えたら overlay を閉じる (5 件押し出し、指摘2)", async () => {
    const { container, rerender } = renderWithQuakes([recentQuake({ eventId: "A", hypocenterName: "浦河沖" })]);
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();

    // A が消え、別の地震だけになる
    await rerenderQuakes(rerender, [recentQuake({ eventId: "Z", hypocenterName: "択捉島" })]);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("公開 closeQuakeCard() で外部から閉じられる (App が emergency 遷移で呼ぶ経路、指摘5)", async () => {
    const { container, component } = renderWithQuakes();
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();
    (component as unknown as { closeQuakeCard: () => void }).closeQuakeCard();
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
    // 閉じた後にタイマーが遅れて発火しても crash しない (タイマー破棄済み)
    expect(() => vi.advanceTimersByTime(20_000)).not.toThrow();
  });

  it("eventId null の訂正報 (reportDateTime のみ変化) でも追従が維持される (指摘2, originTime 主キー)", async () => {
    const base = { eventId: null, originTime: "2026-07-14T20:58:00+09:00", hypocenterName: "浦河沖" };
    const { container, rerender } = renderWithQuakes([
      recentQuake({ ...base, reportDateTime: "2026-07-14T21:00:00+09:00", magnitude: "5.0" }),
    ]);
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("M5.0");

    // reportDateTime だけ変わる訂正報 (originTime|hypocenter は不変 → 同じ ID)
    await rerenderQuakes(rerender, [
      recentQuake({ ...base, reportDateTime: "2026-07-14T21:05:00+09:00", magnitude: "5.6" }),
    ]);
    await tick();
    expect(container.querySelector(".quake-replay-card")?.textContent).toContain("M5.6"); // 追従維持
  });

  it("選択 ID が recentQuakes 内で複数行に衝突したら追従を諦めて閉じる (指摘2)", async () => {
    const dup = { eventId: null, originTime: "2026-07-14T20:58:00+09:00", hypocenterName: "浦河沖" };
    const { container, rerender } = renderWithQuakes([recentQuake({ ...dup, reportDateTime: "2026-07-14T21:00:00+09:00" })]);
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();

    // 同一 ID (originTime|hypocenter が一致) の行が 2 つになる → 一意でないので閉じる
    await rerenderQuakes(rerender, [
      recentQuake({ ...dup, reportDateTime: "2026-07-14T21:00:00+09:00" }),
      recentQuake({ ...dup, reportDateTime: "2026-07-14T21:05:00+09:00" }),
    ]);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });

  it("eventId が途中付与されると ID が変わり追従が切れて閉じる (許容挙動の明文化、指摘2)", async () => {
    const base = { originTime: "2026-07-14T20:58:00+09:00", hypocenterName: "浦河沖", reportDateTime: "2026-07-14T21:00:00+09:00" };
    const { container, rerender } = renderWithQuakes([recentQuake({ ...base, eventId: null })]);
    rowButtons(container)[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeTruthy();

    // 同じ地震に eventId が後付けされると ID が originTime|hypocenter → eventId へ変わり不一致で閉じる。
    // これはサーバ系列 ID 供給 (残課題) までの許容挙動。
    await rerenderQuakes(rerender, [recentQuake({ ...base, eventId: "E1" })]);
    await tick();
    expect(container.querySelector(".quake-replay-card")).toBeFalsy();
  });
});

describe("StandbyScreen 津波チップ replay 配線", () => {
  it("津波チップクリックで onTsunamiReplay(level) が呼ばれる (banner → standby → App 配線)", () => {
    const onTsunamiReplay = vi.fn();
    const multi = tsunamiState({
      level: "majorWarning",
      coasts: [
        { name: "宮崎県", kind: "大津波警報", maxHeight: "10m超", firstHeight: null },
        { name: "高知県", kind: "津波警報", maxHeight: "3m", firstHeight: null },
      ],
    });
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ tsunami: multi }),
      now,
      dim: false,
      sseConnected: true,
      onTsunamiReplay,
    });
    const chips = container.querySelectorAll<HTMLButtonElement>(".count-chip");
    expect(chips.length).toBe(2);
    chips[1].dispatchEvent(new MouseEvent("click", { bubbles: true })); // 「警報」チップ
    expect(onTsunamiReplay).toHaveBeenCalledWith("warning");
  });
});

// 通常モーション (reduced-motion を stub しない → out:fade が非0ms) での排他スロット検証。
// 別 key 実装だと latest↔replay 切替時に旧カードが outro 完了まで残り 2 枚同時に積まれる回帰
// (増分レビュー)。同一 key "quake-slot" で内側だけ差し替える修正を固定する。
describe("StandbyScreen 排他スロットの二重化防止 (通常モーション)", () => {
  // このブロックでは matchMedia を stub しない (jsdom 既定で未実装 → reducedMotion=false = 通常モーション)。
  // fake timer も使わない: 切替直後 (outro があるなら完了前) の DOM を観測するため。
  function slotCount(container: Element): number {
    return container.querySelectorAll(".corner-left .corner-item.quake-corner").length;
  }

  it("latest→replay 切替直後に quake-corner 要素が同時に 2 枚存在しない", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        latestQuake: latestQuakeState({ hypocenterName: "石垣島近海" }),
        recentQuakes: [recentQuake({ eventId: "A", hypocenterName: "浦河沖" })],
      }),
      now,
      dim: false,
      sseConnected: true,
    });
    expect(slotCount(container)).toBe(1); // 初期: LatestQuakeCard 1 枚
    container.querySelector(".quakes-card button.row")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    // 同一 key スロットなので旧カードの outro が発生せず、切替直後も常に 1 枚
    expect(slotCount(container)).toBe(1);
    expect(container.querySelector(".corner-left .quake-replay-card")).toBeTruthy();
    expect(container.querySelector(".corner-left .quake-card")).toBeFalsy();
  });

  it("replay→latest 切替 (クローズ) 直後も quake-corner は 1 枚のまま", async () => {
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({
        latestQuake: latestQuakeState({ hypocenterName: "石垣島近海" }),
        recentQuakes: [recentQuake({ eventId: "A", hypocenterName: "浦河沖" })],
      }),
      now,
      dim: false,
      sseConnected: true,
    });
    const row = container.querySelector(".quakes-card button.row")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true })); // latest→replay
    await tick();
    row.dispatchEvent(new MouseEvent("click", { bubbles: true })); // 再クリックでクローズ replay→latest
    await tick();
    expect(slotCount(container)).toBe(1);
    expect(container.querySelector(".corner-left .quake-card")).toBeTruthy();
    expect(container.querySelector(".corner-left .quake-replay-card")).toBeFalsy();
  });
});

describe("measurement shelf (spec 2026-07-23 standby-right-stack T1/T3)", () => {
  type ROCallback = (entries: Array<{ target: Element }>) => void;
  let roInstances: Array<{ cb: ROCallback; observed: Element[]; observeCalls: Element[]; unobserveCalls: Element[] }>;

  class StubResizeObserver {
    cb: ROCallback;
    rec: { cb: ROCallback; observed: Element[]; observeCalls: Element[]; unobserveCalls: Element[] };
    constructor(cb: ROCallback) {
      this.cb = cb;
      this.rec = { cb, observed: [], observeCalls: [], unobserveCalls: [] };
      roInstances.push(this.rec);
    }
    observe(el: Element) { this.rec.observed.push(el); this.rec.observeCalls.push(el); }
    unobserve(el: Element) { this.rec.unobserveCalls.push(el); this.rec.observed = this.rec.observed.filter((e) => e !== el); }
    disconnect() { this.rec.observed = []; }
  }

  const cardItem = (kind: string, key: string, updatedAt: string, severity = "normal"): ActiveStandbyCardV1 =>
    ({
      kind, key, surface: "corner-right", severity, updatedAt,
      sourceEventIds: [], expiresAt: null, restored: false,
      data: kind === "typhoon"
        ? { typhoons: [{ typhoonKey: "TC1", name: null, nameKana: null, remark: "台風発生予想", typhoonNumber: null, category: "熱帯低気圧(TD)", location: "フィリピンの東", pressureHpa: 1000, maxWindMs: 15, moveDirection: "西", moveSpeedKmh: 20, reportDateTime: "2026-07-23T19:10:00+09:00" }] }
        : kind === "volcano"
          ? { volcanoes: [{ code: "506", name: "桜島", alertLevel: 3, action: "入山規制", updatedAt: "2026-07-23T19:00:00+09:00" }] }
          : { areas: [{ areaName: "埼玉県" }], targetDate: "2026-07-24", updatedAt: "2026-07-23T19:00:00+09:00" },
    }) as unknown as ActiveStandbyCardV1;

  // 高さを模擬発火する: borderBoxHeightOf は borderBoxSize 優先なので blockSize を与える
  const fire = (rec: (typeof roInstances)[number], pairs: Array<[Element, number]>) => {
    rec.cb(pairs.map(([target, h]) => ({ target, borderBoxSize: [{ blockSize: h, inlineSize: 360 }] })) as never);
  };

  beforeEach(() => {
    roInstances = [];
    vi.stubGlobal("ResizeObserver", StubResizeObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("(a)(b) overflow 候補も含め全候補が棚に描画され、棚は inert + aria-hidden", async () => {
    const items = [cardItem("volcano", "volcano:active", "v1", "warning"), cardItem("typhoon", "typhoon:active", "v1"), cardItem("heat", "heat:1", "v1", "warning"), cardItem("heat", "heat:2", "v1", "warning")];
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    const shelf = container.querySelector(".measure-shelf");
    expect(shelf).toBeTruthy();
    expect(shelf!.getAttribute("aria-hidden")).toBe("true");
    expect(shelf!.hasAttribute("inert")).toBe(true);
    expect(shelf!.querySelectorAll('[data-display-mode="full"]')).toHaveLength(4); // 選抜結果に関わらず全候補
    expect(shelf!.querySelectorAll('[data-display-mode="compact"]')).toHaveLength(1); // 台風だけ compact も実測
  });

  it("(d)(e) 実測発火で選抜が実測ベースに切り替わり、item 削除で計測も消える", async () => {
    // jsdom は高さ 0 のため初期は全件見積り (volcano240 + typhoon240+12 + heat160+12 ×2 > budget0) →
    // 棚経由の実測発火で全候補が現在版になった時点で実測選抜へ
    const items = [cardItem("volcano", "volcano:active", "v1", "warning"), cardItem("typhoon", "typhoon:active", "v1")];
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    const rec = roInstances.find((r) => r.observed.some((el) => (el as HTMLElement).classList?.contains("measure-shelf-item")));
    expect(rec).toBeTruthy();
    const shelfItems = [...container.querySelectorAll(".measure-shelf-item")];
    expect(shelfItems).toHaveLength(3); // full 2 枚 + 台風 compact 1 枚
    // 実測を発火: 両カードとも 100px (見積り 240 と大きく乖離)
    fire(rec!, shelfItems.map((el) => [el, 100] as [Element, number]));
    await tick();
    // standbyHeightPx は jsdom で 640 初期値 → budget = 640-48-0-0 = 592。実測 100×2+gap12 は余裕で visible
    expect(container.querySelectorAll(".corner-right .standby-corner")).toHaveLength(2);
    // item 削除 → 棚からも消える (Map prune は挙動としては棚 DOM 数で観測)
    await rerender({ snapshot: baseSnapshot({ standbyItems: [items[0]] }), now, dim: false, sseConnected: true });
    await tick();
    expect(container.querySelectorAll(".measure-shelf-item")).toHaveLength(1);
  });

  it("(c) updatedAt 変更・高さ同一で unobserve→observe が呼ばれる (再計測強制)", async () => {
    const items = [cardItem("typhoon", "typhoon:active", "v1")];
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    const rec = roInstances.find((r) => r.observed.some((el) => (el as HTMLElement).classList?.contains("measure-shelf-item")));
    const before = rec!.observeCalls.length;
    await rerender({ snapshot: baseSnapshot({ standbyItems: [cardItem("typhoon", "typhoon:active", "v2")] }), now, dim: false, sseConnected: true });
    await tick();
    expect(rec!.unobserveCalls.length).toBeGreaterThan(0);
    expect(rec!.observeCalls.length).toBeGreaterThan(before);
  });

  it("(f) 棚内のカードが本表示のセレクタ数を汚さない (visible は corner-right 直下のみで数える)", async () => {
    const items = [cardItem("typhoon", "typhoon:active", "v1")];
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    expect(container.querySelectorAll(".corner-right .standby-card").length)
      .toBeLessThanOrEqual(container.querySelectorAll(".standby-card").length - 1); // 棚に最低 1 枚
  });

  it("台風 full が予算外なら実測 compact を採用する", async () => {
    const items = [cardItem("typhoon", "typhoon:active", "v1")];
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    const rec = roInstances.find((r) => r.observed.some((el) => (el as HTMLElement).classList?.contains("measure-shelf-item")))!;
    const full = container.querySelector('[data-display-mode="full"]')!;
    const compact = container.querySelector('[data-display-mode="compact"]')!;
    fire(rec, [[full, 700], [compact, 300]]);
    await tick();
    expect(container.querySelector(".corner-right .typhoon-card.compact")).toBeTruthy();
    expect(container.querySelector(".corner-right .overflow")).toBeNull();
  });

  it("台風 compact も予算外なら従来の overflow 要約へ送る", async () => {
    const items = [cardItem("typhoon", "typhoon:active", "v1")];
    const { container } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: items }), now, dim: false, sseConnected: true,
    });
    await tick();
    const rec = roInstances.find((r) => r.observed.some((el) => (el as HTMLElement).classList?.contains("measure-shelf-item")))!;
    const full = container.querySelector('[data-display-mode="full"]')!;
    const compact = container.querySelector('[data-display-mode="compact"]')!;
    fire(rec, [[full, 700], [compact, 700]]);
    await tick();
    // 旧カードは outro 中だけ DOM に残り得るため、選抜結果が即時反映される要約で観測する。
    expect(container.querySelector(".corner-right .overflow")?.textContent).toBe("ほか1件: 台風");
  });

  it("実機シナリオ: 台風3件の表示中に気象警報が増えると full から compact へ縮約して台風を残す", async () => {
    const baseTyphoon = cardItem("typhoon", "typhoon:active", "v1", "warning");
    if (baseTyphoon.kind !== "typhoon") throw new Error("test fixture kind mismatch");
    const threeTyphoons: Extract<ActiveStandbyCardV1, { kind: "typhoon" }> = {
      ...baseTyphoon,
      data: {
        typhoons: Array.from({ length: 3 }, (_, index) => ({
          ...baseTyphoon.data.typhoons[0],
          typhoonKey: `TC${index + 1}`,
          typhoonNumber: `260${index + 1}`,
          nameKana: `TYPHOON-${index + 1}`,
          remark: null,
        })),
      },
    };
    const increasedAlert = weatherAlert({
      role: "weatherWarning",
      label: "気象警報",
      items: ["大雨警報", "洪水警報", "暴風警報"].map((kind, index) => ({
        kind,
        displaySeverity: "warning",
        rank: "warning" as const,
        shownAreas: [`関東地方${index + 1}`],
        omittedAreaCount: 0,
      })),
    });
    const { container, rerender } = render(StandbyScreen, {
      snapshot: baseSnapshot({ standbyItems: [threeTyphoons] }), now, dim: false, sseConnected: true,
    });
    await tick();
    expect(container.querySelector(".corner-right .typhoon-card.compact")).toBeNull();

    await rerender({
      snapshot: baseSnapshot({ standbyItems: [threeTyphoons], weatherAlerts: [increasedAlert] }),
      now,
      dim: false,
      sseConnected: true,
    });
    await tick();
    expect(container.querySelector(".weather-card")).toBeTruthy();
    expect(container.querySelector(".corner-right .typhoon-card.compact")).toBeTruthy();
    expect(container.querySelectorAll(".corner-right .typhoon-card.compact .typhoon")).toHaveLength(3);
    expect(container.querySelector(".corner-right .overflow")).toBeNull();
  });
});
