import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { flushSync } from "svelte";
import EmergencyScreen from "../EmergencyScreen.svelte";
import { PAGE_HOLD_MS } from "../../lib/page-cycler.svelte";
import { expectCurrentDot } from "./page-dots-test-utils";
import type { EmergencyPanelModel } from "../../lib/derive";
import type {
  DisplayEewInputV1,
  DisplayLargeQuakeInputV1,
  DisplayTsunamiInputV1,
} from "../../lib/protocol";

// T5c: ページ切替は {#key} + transition:fade (重ねクロスフェード、231ms) になった。
// fake timers 環境では element.animate() スタブ (test-setup.ts) の完了が setTimeout 経由なので、
// ページ送りのタイマーを進めた直後だけでなく、フェード時間ぶんも追加で進めてから DOM を読む
function settleFade(): void {
  vi.advanceTimersByTime(1000);
  flushSync();
}

function eewInput(over: Partial<DisplayEewInputV1> = {}): DisplayEewInputV1 {
  return {
    kind: "eew",
    eventId: "E1",
    serial: "3",
    isWarning: true,
    isFinal: false,
    isCancellation: false,
    hypocenterName: "浦河沖",
    forecastMaxInt: "5強",
    forecastMaxIntRank: 5,
    magnitude: "6.1",
    colorIndex: null,
    reportDateTime: "2026-07-07T10:00:00+09:00",
    isAssumedHypocenter: false,
    depth: "30km",
    maxLgInt: null,
    regions: [],
    ...over,
  };
}

function tsunamiInput(over: Partial<DisplayTsunamiInputV1> = {}): DisplayTsunamiInputV1 {
  return {
    kind: "tsunami",
    level: "warning",
    levelLabel: "津波警報",
    coasts: [
      { name: "岩手県", kind: "warning", maxHeight: null, firstHeight: null },
      { name: "宮城県", kind: "warning", maxHeight: null, firstHeight: null },
    ],
    warningComment: null,
    observations: [],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    ...over,
  };
}

function quakeInput(over: Partial<DisplayLargeQuakeInputV1> = {}): DisplayLargeQuakeInputV1 {
  return {
    kind: "largeQuake",
    eventId: "Q1",
    originTime: "2026-07-07T09:58:00+09:00",
    hypocenterName: "浦河沖",
    magnitude: "6.1",
    maxInt: "5強",
    maxIntRank: 9,
    intensityGroups: [
      { intensity: "5強", rank: 9, areas: ["浦河町", "様似町"], omittedAreaCount: 0 },
      { intensity: "4", rank: 7, areas: ["帯広市"], omittedAreaCount: 0 },
    ],
    reportDateTime: "2026-07-07T10:00:00+09:00",
    depth: "30km",
    maxLgInt: null,
    tsunamiWarning: false,
    ...over,
  };
}

function panel(key: string, input: EmergencyPanelModel["input"]): EmergencyPanelModel {
  return { key, input };
}

describe("EmergencyScreen", () => {
  it("④ EewPanel が 震央/推定最大震度/M/続報番号 を render する", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("eew:1", eewInput())] });
    expect(screen.getByText("浦河沖")).toBeTruthy();
    // v3 で震度表記が「5強」→「5+」に統一された (formatIntShort)
    // 推定最大震度: プレフィックスは静止テキスト、値は RollingNumber (data-value) で取る
    expect(container.querySelector(".max-int")?.textContent).toContain("推定最大震度");
    expect(container.querySelector('.max-int [data-value="5+"]')).toBeTruthy();
    // Phase B タイル化で M はラベル (「M」) と値 (「6.1」) が別要素の stat タイルに分かれた
    expect(screen.getByText("M", { selector: ".stat-label" })).toBeTruthy();
    expect(container.querySelector('.stat-value [data-value="6.1"]')).toBeTruthy();
    expect(container.querySelector('.stat-tile [data-value="6.1"]')).toBeTruthy();
    expect(screen.getByText(/第3報/)).toBeTruthy();
  });

  it("⑤ 続報 (同 key の input 差し替え) で再マウントされず内容が更新される", async () => {
    const { rerender } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput({ serial: "1" }))],
    });
    const before = screen.getByTestId("eew:1");
    await rerender({ panels: [panel("eew:1", eewInput({ serial: "2" }))] });
    const after = screen.getByTestId("eew:1");
    expect(after).toBe(before);
    expect(screen.getByText(/第2報/)).toBeTruthy();
  });

  it("⑥ TsunamiPanel が levelLabel と沿岸名を render、level 別 class が付く", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "tsunami:current",
          tsunamiInput({ level: "majorWarning", levelLabel: "大津波警報" }),
        ),
      ],
    });
    expect(screen.getByText("大津波警報")).toBeTruthy();
    expect(screen.getByText("岩手県")).toBeTruthy();
    expect(container.querySelector(".tsunami-majorWarning")).toBeTruthy();
  });

  it("⑦ QuakePanel が震度別リストを大きい順に render する", () => {
    render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    const strong = screen.getByText(/浦河町/);
    const weak = screen.getByText(/帯広市/);
    // DOM 順序: compareDocumentPosition の PRECEDING/FOLLOWING で判定
    // strong (5強=表示上は5+) が weak (4) より前に出現する
    // eslint-disable-next-line no-bitwise
    const position = strong.compareDocumentPosition(weak);
    expect((position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true);
  });

  it("⑧ 緊急画面はヘッダ帯の小時計を持たない (第3波でテロップへ移設)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput())],
    });
    expect(container.querySelector(".clock-corner")).toBeFalsy();
  });

  it("⑨ QuakePanel の地域別震度が待機画面と同じ int-chip 形式で render される", () => {
    const { container } = render(EmergencyScreen, { panels: [panel("quake:1", quakeInput())] });
    expect(container.querySelector(".int-chip.int-r9")).toBeTruthy();
  });

  // compact 切替の遅延 (spec §3): 新規キーは即時、既存キーが主役⇔副役を移るときだけ quick 遷移
  // 完了後に compact を反映する。142ms 内の逆転操作 (割込み → 即取り消し) で古い timer が誤適用
  // されないことを固定する。jsdom は matchMedia 未実装 = reducedMotion false = 遅延が有効。
  it("compact 遅延: 142ms 内の主役⇔副役 逆転操作で古い timer が誤適用されない (spec §3)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      // 初期: quake 主役 (compact なし) / eew 副役 (compact)
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // priority 割込みで役割逆転。compact は遷移完了 (142ms) 後に反映されるため、この時点では据え置き
      await rerender({ panels: [eew, quake] });
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();

      // 142ms 未満で元へ戻す (逆転操作) → 保留中の timer は取り消される
      vi.advanceTimersByTime(50);
      await rerender({ panels: [quake, eew] });
      flushSync();

      // 以降いくら時間を進めても古い timer は誤適用されず、元の割り当てのまま
      vi.advanceTimersByTime(500);
      flushSync();
      expect(container.querySelector(".quake-panel.compact")).toBeFalsy();
      expect(container.querySelector(".eew-panel.compact")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R2: deriveEmergencyPanels() は毎レンダ新配列を返すため、同一目標のまま頻繁に再レンダされると
  // 旧実装は役割変更 timer を毎回張り直して永久に発火しなかった。目標が変わらない再レンダでは timer を
  // 継続させ、142ms 経過で確実に反映されることを固定する。
  it("compact 遅延: 目標が変わらない頻繁な再レンダでも timer が永久リセットされず反映される (Codex R2)", async () => {
    vi.useFakeTimers();
    try {
      const quake = panel("quake:1", quakeInput());
      const eew = panel("eew:1", eewInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [quake, eew] });
      flushSync();
      // 役割逆転: eew 主役 / quake 副役 → quake の compact target が false→true になる (この時点で timer 起動)
      await rerender({ panels: [eew, quake] });
      flushSync();
      // 目標を変えずに 30ms ごとの再レンダを 6 回 (毎レンダ新配列を模す)。142ms を跨ぐが timer は継続すべき
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(30);
        await rerender({ panels: [eew, quake] });
        flushSync();
      }
      vi.advanceTimersByTime(50);
      flushSync();
      // 累計 >142ms: timer が発火し役割変更が反映される (quake 副役=compact / eew 主役=非compact)
      expect(container.querySelector(".quake-panel.compact")).toBeTruthy();
      expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R1: settling は「新しい遷移が始まるたびに fallback timer を張り直す」方式。割込み遷移
  // (142ms 内の再遷移) で先に終わる列の遷移完了が settling を早期解除しないこと (data-settling で観測)。
  it("settling: 割込み遷移で fallback を張り直し、遷移収束まで data-settling を保つ (Codex R1)", async () => {
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1] });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;
      // 初期マウントは整定しない
      expect(settling()).toBe("false");

      // 1→2: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2] });
      flushSync();
      expect(settling()).toBe("true");

      // t=100 で 2→3 に再遷移 → fallback 張り直し (新 fallback fires t=322)
      vi.advanceTimersByTime(100);
      await rerender({ panels: [p1, p2, p3] });
      flushSync();

      // t=250: 旧 fallback (222) の時刻を越えても張り直しにより settling 継続
      vi.advanceTimersByTime(150);
      flushSync();
      expect(settling()).toBe("true");

      // t=450 > 322: 最後の fallback 窓を越えたら解除
      vi.advanceTimersByTime(200);
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
    }
  });

  // Codex R4: TsunamiPanel の compact 配線。副役スロット (index!==0) で compact 表示になる。
  it("TsunamiPanel は副役スロットで compact 表示になり、主役は compact でない (Codex R4)", () => {
    const { container } = render(EmergencyScreen, {
      panels: [panel("eew:1", eewInput()), panel("tsunami:1", tsunamiInput())],
    });
    expect(container.querySelector(".tsunami-panel.compact")).toBeTruthy();
    expect(container.querySelector(".eew-panel.compact")).toBeFalsy();
  });

  // Codex R6: 遷移中に OS で reduced-motion がオンになると CSS transition は即停止するが、grid sig が
  // 不変だと fallback timer だけが残り settling 解除が最大 222ms 遅延していた。reduced-motion は同期反映
  // 経路として、進行中の fallback を取り消して settling を即時解除する。jsdom は matchMedia 未実装のため
  // 制御可能な matchMedia モックを差し込んで change を発火させる (他テストへ漏らさないよう finally で復元)。
  it("settling: 遷移中に reduced-motion がオンになると fallback を待たず即時解除する (Codex R6)", async () => {
    const origMatchMedia = window.matchMedia;
    const listeners = new Set<(e: MediaQueryListEvent) => void>();
    let rmMatches = false;
    window.matchMedia = ((query: string) => ({
      get matches() {
        return rmMatches;
      },
      media: query,
      onchange: null,
      addEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_t: string, cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: (cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
      removeListener: (cb: (e: MediaQueryListEvent) => void) => listeners.delete(cb),
      dispatchEvent: () => true,
    })) as unknown as typeof window.matchMedia;
    vi.useFakeTimers();
    try {
      const p1 = panel("quake:1", quakeInput());
      const p2 = panel("eew:1", eewInput());
      const p3 = panel("tsunami:1", tsunamiInput());
      const { container, rerender } = render(EmergencyScreen, { panels: [p1, p2] });
      flushSync();
      const settling = (): string | null => container.querySelector(".panels")?.getAttribute("data-settling") ?? null;

      // 2→3: settling 開始 (fallback fires t=222)
      await rerender({ panels: [p1, p2, p3] });
      flushSync();
      expect(settling()).toBe("true");

      // fallback を待たず (t=50) に reduced-motion をオン → grid sig 不変でも即時解除
      vi.advanceTimersByTime(50);
      rmMatches = true;
      for (const cb of listeners) cb({ matches: true } as MediaQueryListEvent);
      flushSync();
      expect(settling()).toBe("false");
    } finally {
      vi.useRealTimers();
      if (origMatchMedia === undefined) {
        delete (window as unknown as { matchMedia?: unknown }).matchMedia;
      } else {
        window.matchMedia = origMatchMedia;
      }
    }
  });

  it("⑪ QuakePanel は看板ヘッダ (固定ラベル) + 本文に震源概要を表示する統一文法へ再構成されている", () => {
    const { container } = render(EmergencyScreen, {
      panels: [
        panel(
          "quake:1",
          quakeInput({
            hypocenterName: "浦河沖",
            magnitude: "6.1",
            depth: "30km",
            maxLgInt: "3",
            tsunamiWarning: true,
            originTime: "2026-07-07T09:58:00+09:00",
          }),
        ),
      ],
    });
    // ヘッダは種別名の看板のみ (震源名等の概要を含まない)
    const heading = container.querySelector(".quake-panel .heading");
    expect(heading?.textContent).toContain("地震情報");
    expect(heading?.textContent).not.toContain("浦河沖");
    // 概要情報 (震源名・最大震度・M・深さ・長周期・津波・発生時刻) は本文 (.tiles) 側で値単位に render される
    const tiles = container.querySelector(".quake-panel .tiles");
    expect(tiles?.querySelector(".hypocenter")?.textContent).toContain("浦河沖");
    expect(tiles?.querySelector(".max-int")?.textContent).toContain("最大震度");
    expect(tiles?.querySelector(".stat-value")?.textContent).toContain("6.1");
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("30km")),
    ).toBe(true);
    expect(
      Array.from(tiles?.querySelectorAll(".stat-value") ?? []).some((el) => el.textContent?.includes("3")),
    ).toBe(true);
    expect(tiles?.querySelector(".chip.tsunami-mark")).toBeTruthy();
    expect(tiles?.querySelector(".chip.origin-time")?.textContent).toContain("発生");
  });

  it("⑩ EewPanel/TsunamiPanel/QuakePanel の主見出しが共通トークン (--panel-header-*) で高さを揃えている (第4波)", () => {
    // jsdom はレイアウト計算をしないため実測 height は信頼できない (このプロジェクトの既存規約)。
    // ソース上で3パネルとも同じ --panel-header-min-h / --panel-header-padding-* を参照していることを
    // 検査し、TsunamiPanel だけ headline-l (40px) を使って高さがずれていた回帰を防ぐ
    const eewSource = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunamiSource = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quakeSource = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const source of [eewSource, tsunamiSource, quakeSource]) {
      expect(source).toContain("--panel-header-min-h");
      expect(source).toContain("--panel-header-padding-v");
      expect(source).toContain("--panel-header-padding-h");
    }
    expect(tsunamiSource).not.toContain("--type-headline-l-size");
  });

  it("パネルの角丸は shape scale トークン参照で、tile/chip の直値角丸を持たない (B1 contrasting shapes)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toContain("var(--radius-m)");
      // 内側タイル/チップの px 直値角丸が残っていないこと
      expect(src).not.toMatch(/border-radius:\s*1[026]px/);
    }
    expect(eew).toContain("var(--radius-s)"); // assumed-chip
    expect(quake).toContain("var(--radius-s)"); // int-chip
  });

  it("パネルヘッダは container/on-container + 下端 CUD 帯で、旧 --bar-* solid を使わない (B2a)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    const tsunami = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    for (const src of [eew, tsunami, quake]) {
      expect(src).toMatch(/var\(--header-\w+-container\)/);
      expect(src).toMatch(/var\(--header-band-width\)\s+solid\s+var\(--header-band-\w+\)/);
      expect(src).not.toContain("var(--bar-");
    }
  });

  it("緊急パネルは elevation-3、内側タイルは elevation-1 の box-shadow を持つ (B2b、selector 単位で検証: Codex R10)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    // 宣言をセレクタブロックに紐付けて検査する (コメント・別ブロックでの誤マッチを避ける)
    expect(eew).toMatch(/\.eew-panel\s*\{[^}]*box-shadow:\s*var\(--elevation-3\)/);
    expect(eew).toMatch(/\.tile\s*\{[^}]*box-shadow:\s*var\(--elevation-1\)/);
  });

  // B3 hero moment: 旧・hero-in の opacity 0 スタート入場 (frame-1 可視を破る 3 経路の一つ) は
  // モーション振り付け spec (2026-07-10) で撤去した。主役スロットの「最大面積」は入場アニメでは
  // なく main-stack の grid-row span 構造 (grid-column:1 / grid-row:1 / -1) が担う。入場は
  // revealScaleIn (初期は演出なし=frame-1 可視、後発は transform+opacity) へ転換した
  it("緊急画面の主役スロットは main-stack で grid-row span の最大面積を持つ (B3 hero moment、opacity 0 入場は撤去)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    // 主役スロットは grid-column:1 / grid-row:1 / -1 で列全体を占める
    expect(src).toMatch(/\.layout-main-stack \.panel-slot\.is-main \{[^}]*grid-row: 1 \/ -1;/);
    // opacity 0 スタートの hero-in / panel-in keyframe は撤去済み
    expect(src).not.toContain("@keyframes hero-in");
    expect(src).not.toContain("@keyframes panel-in");
    // 入場は外枠 revealScaleIn を撤去し、枚数増減のグリッド track 補間 (grid-template の CSS transition) が担う
    expect(src).not.toContain("revealScaleIn");
    expect(src).toContain("grid-template-columns");
    expect(src).toContain("var(--spring-spatial-quick)");
  });

  it("tier ウェイトスウェル: EewPanel hero が font-weight transition を持ち、color/surface は瞬時のまま (wght #2)", () => {
    const src = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(src).toMatch(/transition:\s*font-weight var\(--dur-weight-swell\)/);
    // 色や surface を tier で transition していない (weight のみ)
    expect(src).not.toMatch(/transition:[^;]*background/);
  });

  it("緊急画面の gap/padding が space トークンを使う (B4)", () => {
    const src = readFileSync(join(__dirname, "..", "EmergencyScreen.svelte"), "utf-8");
    expect(src).toContain("var(--space-3)");
  });

  it("QuakePanel の市区町村名は white-space:nowrap の city-name span で、名前の途中で改行しない (第3波 Fix14)", () => {
    const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    expect(src).toMatch(/\.city-name\s*\{[\s\S]*?white-space:\s*nowrap;[\s\S]*?\}/);
    expect(src).not.toContain('pg.cities.join("・")');
  });

  // T5a (詳細ページング配線) でスクロール機構を撤去し、静的リスト + ページャに置き換えた
  it("QuakePanel/LatestQuakeCard はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T5a)", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [quake, latest]) {
      expect(src).not.toContain("vertical-ping-pong-scroll");
      expect(src).not.toMatch(/translateY\(-?100%\)/);
      // 各コンポーネント側に phase 状態機械の再実装 (setTimeout チェーン) が残っていないこと
      expect(src).not.toMatch(/type ScrollPhase/);
    }
  });

  it("QuakePanel/LatestQuakeCard は詳細ページングに共有のページャ部品 (lib/page-cycler.svelte) を参照し、実装がコピペ複製されていない", () => {
    const quake = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
    const latest = readFileSync(join(__dirname, "..", "LatestQuakeCard.svelte"), "utf-8");
    for (const src of [quake, latest]) {
      expect(src).toContain("../lib/page-cycler.svelte");
      expect(src).toContain("createPageCycler");
    }
  });

  it("EewPanel はスクロール機構 (vertical-ping-pong-scroll) を参照しない (T4a 全廃)", () => {
    const eew = readFileSync(join(__dirname, "..", "EewPanel.svelte"), "utf-8");
    expect(eew).not.toContain("vertical-ping-pong-scroll");
  });

  // 固定サマリ計器: ヘッドライン2行 (spec §2-b 改訂 2026-07-09、review-T5a-3、T4b から改修)。
  // 旧・震度分布行 (dist-item/「広域」連呼) と県別件数行 (pref-count) は廃止された
  describe("QuakePanel: 固定サマリ計器 (ヘッドライン2行)", () => {
    it("最大震度規模行に各グループの県数・市町村数を render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6強", rank: 8, areas: ["高知県高知市", "愛知県名古屋市"], omittedAreaCount: 0 },
                { intensity: "6弱", rank: 7, areas: ["宮崎県宮崎市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      const top = container.querySelector(".instrument-top");
      // v3 で震度表記が「6強」→「6+」に統一されている (formatIntShort)
      expect(top?.querySelector(".int-chip")?.textContent).toContain("6+");
      expect(top?.querySelector(".instrument-value")?.textContent).toBe("2県2市町村");
    });

    it("グループが1つだけなら拡大範囲行は render されない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6強", rank: 8, areas: ["高知県高知市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      expect(container.querySelector(".instrument-expanded")).toBeFalsy();
    });

    // T7 preview 実測の回帰修正 (#standby-cards): areas が県プレフィックス無しの市名だけ
    // (spec §2-b の静的リスト例そのもの「宮崎市」「日南市」) だと県数が 0 になり、
    // 「0県2市町村」「0県に拡大」という意味不明な表示になっていた
    it("県プレフィックス無しの areas だけのときは規模行が「N県」を省いて市町村数だけ render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const value = container.querySelector(".instrument-top .instrument-value");
      expect(value?.textContent).toBe("2市町村");
    });

    it("両グループとも県プレフィックス無しで累積県数が 0 のときは拡大範囲行が render されない (1グループのみと同じ扱い)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
                { intensity: "5強", rank: 6, areas: ["都城市", "延岡市"], omittedAreaCount: 3 },
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".instrument-expanded")).toBeFalsy();
    });

    it("最大震度グループが県プレフィックス無しでも2番目のグループに県があれば拡大範囲行は通常どおり render する (県あり/なし混在)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6弱", rank: 7, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 },
                { intensity: "5強", rank: 6, areas: ["高知県高知市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      const expanded = container.querySelector(".instrument-expanded");
      expect(expanded?.querySelector(".instrument-value")?.textContent).toBe("1県に拡大");
    });

    it("拡大範囲行は2番目のランクラベルと累積 (最大震度含む) distinct 県数を render する", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "7", rank: 9, areas: ["宮城県栗原市"], omittedAreaCount: 0 },
                {
                  intensity: "6強", rank: 8,
                  areas: Array.from({ length: 19 }, (_, i) => `福島県市町村${i}`),
                  omittedAreaCount: 0,
                },
              ],
            }),
          ),
        ],
      });
      const expanded = container.querySelector(".instrument-expanded");
      expect(expanded?.querySelector(".instrument-label")?.textContent).toBe("6強以上");
      expect(expanded?.querySelector(".instrument-value")?.textContent).toBe("2県に拡大");
    });

    it("最大震度グループが153件でも規模行は数値のまま出す (縮退・ページングと無関係)", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                {
                  intensity: "7", rank: 9,
                  areas: Array.from({ length: 153 }, (_, i) => `高知県市町村${i}`),
                  omittedAreaCount: 0,
                },
              ],
            }),
          ),
        ],
      });
      const value = container.querySelector(".instrument-top .instrument-value");
      expect(value?.textContent).toBe("1県153市町村");
    });
  });

  // 詳細ページング (T5a: spec §3/§4)
  describe("QuakePanel: 詳細ページング", () => {
    it("静的リスト (totalEffective<=30) では .tile-groups の全件を静的表示し、ページャは出さない", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [
                { intensity: "6強", rank: 8, areas: ["高知県高知市"], omittedAreaCount: 0 },
                { intensity: "6弱", rank: 7, areas: ["愛知県名古屋市"], omittedAreaCount: 0 },
              ],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeTruthy();
      expect(container.querySelector(".tile-page-detail")).toBeFalsy();
    });

    // T7 回帰修正 (spec §2-b の静的リスト例「震度6強 宮崎市 日南市」どおり): 静的リストは
    // pref:null バケツに「その他」ラベルを出さず市名だけにする (ページング側は維持、別テスト参照)
    it("静的リストでは県プレフィックス無しの area がラベル無しで市名だけ render される", () => {
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "6強", rank: 8, areas: ["宮崎市", "日南市"], omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const group = container.querySelector(".tile-groups .group");
      expect(group?.querySelector(".pref-name")).toBeNull();
      expect(
        Array.from(group?.querySelectorAll(".city-name") ?? []).map((el) => el.textContent),
      ).toEqual(["宮崎市", "日南市"]);
    });

    // 詳細ページング側は「その他」ラベルを維持する (レビュー指示: 原則3のラベル明示はページ側に
    // だけ意味がある)。31件超で shouldPageDetails が発火し、県プレフィックス無しの area は
    // .tile-page-detail 側の pg.pref ?? "その他" 分岐に流れることを確認する
    it("詳細ページングでは県プレフィックス無しの area が「その他」ラベル付きで render される (静的リストとは異なり維持)", () => {
      const areas = Array.from({ length: 35 }, (_, i) => `市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({ intensityGroups: [{ intensity: "6強", rank: 8, areas, omittedAreaCount: 0 }] }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("その他");
    });

    it("10県153市町村 (南海トラフ級) は各県がバジェット(20)の半分を超え県ごとに1ページ、計10ページに割れる", () => {
      const prefectures = [
        "高知県", "徳島県", "愛媛県", "香川県", "静岡県",
        "愛知県", "三重県", "和歌山県", "宮崎県", "大分県",
      ];
      const perPref = Math.floor(153 / prefectures.length);
      const areas: string[] = [];
      prefectures.forEach((pref, idx) => {
        const count = idx === prefectures.length - 1 ? 153 - perPref * (prefectures.length - 1) : perPref;
        for (let i = 0; i < count; i++) areas.push(`${pref}市町村${i}`);
      });
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      expect(container.querySelector(".tile-groups")).toBeFalsy();
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".page-title")?.textContent).toBe("観測震度 詳細");
      expect(page?.querySelector(".page-count")?.textContent).toBe("10県153市町村");
      expectCurrentDot(page, 1, 10);
    });

    it("1県がバジェット超なら続きラベルを付けてページをまたぐ (大県分断)", () => {
      const areas = Array.from({ length: 31 }, (_, i) => `高知県市町村${i}`);
      const { container } = render(EmergencyScreen, {
        panels: [
          panel(
            "quake:1",
            quakeInput({
              intensityGroups: [{ intensity: "7", rank: 9, areas, omittedAreaCount: 0 }],
            }),
          ),
        ],
      });
      const page = container.querySelector(".tile-page-detail");
      expect(page?.querySelector(".pref-name")?.textContent).toBe("高知県");
      expectCurrentDot(page, 1, 2);
    });

    // Codex R レビュー M2: severityTier (地震は最大震度 rank) が同一イベントの続報中に
    // 「上昇」したときもページを先頭に戻す。下降・同値ではリセットしない (spec §3)
    it("同一イベントで maxIntRank が上昇したらページが先頭に戻る。下降・同値では維持する", async () => {
      vi.useFakeTimers();
      try {
        const areas = Array.from({ length: 60 }, (_, i) => `高知県市町村${i}`);
        const { container, rerender } = render(EmergencyScreen, {
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 7,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        expectCurrentDot(container, 1, 3);

        vi.advanceTimersByTime(PAGE_HOLD_MS * 2);
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 下降 (rank 7→5、同一 eventId): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 同値 (rank 5→5): リセットしない
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 5,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 3, 3);

        // 上昇 (rank 5→9、同一 eventId): 先頭ページに戻る
        await rerender({
          panels: [
            panel(
              "quake:1",
              quakeInput({
                eventId: "Q-M2",
                maxIntRank: 9,
                intensityGroups: [{ intensity: "6強", rank: 7, areas, omittedAreaCount: 0 }],
              }),
            ),
          ],
        });
        settleFade();
        expectCurrentDot(container, 1, 3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Codex R レビュー M1: createPageCycler は $effect.root で独立 root を持つため、消費側が
  // destroy() を呼ばないと unmount (main-stack のモード切替・panel 差替え) で timer /
  // matchMedia listener がリークする。page-cycler.svelte.ts 側には「destroy 後はタイマーが
  // 発火しない」の単体テストが既にあるため、消費側はソースの配線だけを検査する
  describe("QuakePanel/TsunamiPanel: page-cycler の onDestroy 配線 (Codex R M1)", () => {
    it("QuakePanel は onDestroy で cycler.destroy() を呼ぶ", () => {
      const src = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => cycler.destroy())");
    });

    it("TsunamiPanel は onDestroy で pageCycler.destroy() と obsPageCycler.destroy() を呼ぶ", () => {
      const src = readFileSync(join(__dirname, "..", "TsunamiPanel.svelte"), "utf-8");
      expect(src).toContain('import { onDestroy } from "svelte"');
      expect(src).toContain("onDestroy(() => pageCycler.destroy())");
      expect(src).toContain("onDestroy(() => obsPageCycler.destroy())");
    });
  });

  // T5c: ページ行容量の画面高さ駆動化 + 切替フェード (spec §2-c)。jsdom は ResizeObserver 未実装
  // かつ layout 未解決のため実測 px の挙動 (T7 preview 実測対象) はソース文字列で配線を検査する
  describe("QuakePanel T5c 配線 (画面高さ駆動 + フェード)", () => {
    it("ページ本文は measureHeight (面積+代表行) で実測し、cityBudgetFromArea でバジェットを導出する", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("cityBudgetFromArea(pageBodyAreaHeight, pageBodyLineHeight, PAGE_CITY_BUDGET)");
      expect(source).toContain("use:measureHeight={applyPageBodyArea}");
      expect(source).toContain("paginateAreas(input.intensityGroups, cityBudget)");
    });

    it("ページ切替は {#key cycler.index} + transition:fade の重ねクロスフェードで、時間/easing は既存の spring-effects-default を流用する (新規定数なし)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toContain("{#key cycler.index}");
      expect(source).toContain('import { fade } from "svelte/transition"');
      // モーション振り付け spec で revealScaleIn/heightReveal 用に SPRING_SPATIAL_DEFAULT_MS も
      // motion から取り込むため、import 行の固定はやめ必要シンボルの取り込みを個別に確認する
      expect(source).toMatch(/import \{[^}]*\bSPRING_EFFECTS_DEFAULT_MS\b[^}]*\bspringEffectsOut\b[^}]*\} from "\.\.\/lib\/motion"/);
      expect(source).toMatch(
        /transition:fade=\{\{\s*duration: cycler\.reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,\s*\}\}/,
      );
    });

    it("旧ページと新ページが重なるよう、.tile-page-detail は position:relative、.page-fade は position:absolute で重ねる", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.tile-page-detail\s*\{[^}]*position: relative;/);
      expect(source).toMatch(/\.page-fade\s*\{[^}]*position: absolute;[^}]*inset: 0;/);
    });

    // T6c ②: 文字がカード縁に密着するバグの修正 (preview 目視指摘)。position:absolute な
    // .page-fade の containing block は最も近い positioned 祖先 (.tile-page-detail) の
    // padding box になり、祖先自身の padding 宣言は絶対配置の子には効かないため、
    // .tile-page-detail の padding (var(--space-4) var(--space-5)) が実質無視されていた。
    // .page-fade 自体に同じトークンで padding を持たせて復元する。pageBodyAreaHeight は
    // .page-body を直接 measureHeight する構造なので、この padding 変更は次回実測で自動的に
    // 反映される (TsunamiPanel の coastRowCapacity のような明示補正定数は不要)
    it(".page-fade には .tile-page-detail と同じ既存 spacing トークンで内側 padding を持たせる (新規直値・opacity 減光は使わない)", () => {
      const source = readFileSync(join(__dirname, "..", "QuakePanel.svelte"), "utf-8");
      expect(source).toMatch(/\.page-fade\s*\{[^}]*padding: var\(--space-4\) var\(--space-5\);/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*\d+px/);
      expect(source).not.toMatch(/\.page-fade\s*\{[^}]*opacity/);
    });
  });
});
