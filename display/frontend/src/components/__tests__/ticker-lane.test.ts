import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentProps } from "svelte";
import TickerLane from "../TickerLane.svelte";
import type { TickerJob } from "../../lib/ticker-schedule";

function job(over: Partial<TickerJob> = {}): TickerJob {
  const segments = over.segments ?? ["セグメント本文"];
  return {
    key: "k", groupKey: null, seq: 1, kind: "event", priority: "low", role: "info", category: null,
    subject: null,
    segments,
    segmentEmphasis: over.segmentEmphasis ?? segments.map(() => []),
    runs: over.runs ?? [{ startSegmentIndex: 0, endSegmentIndexExclusive: segments.length }],
    runIndex: 0, segmentIndex: 0, retryCount: 0, deferUntil: null, deferKind: null,
    revisionAt: null, isCancellation: false, tipPolicy: null, tipHazards: [], surface: "none",
    ...over,
  };
}

function stubReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches, media: query, addEventListener: () => {}, removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = original; };
}

const noop = (): void => {};
const noopBookmark = (): void => {};

// C 用 render helper: 必須 props (runEnd / onBookmarkCapture 等) を機械的に補う。
// runEnd は job の現 run の endSegmentIndexExclusive を既定にする (B の run 契約)
function renderLane(
  props: Partial<ComponentProps<typeof TickerLane>> & { job: TickerJob | null },
) {
  const j = props.job;
  const runEnd = j != null ? j.runs[j.runIndex]!.endSegmentIndexExclusive : 0;
  return render(TickerLane, {
    segmentIndex: 0,
    generation: 1,
    phase: "running",
    runEnd,
    onScrollEnd: noop,
    onFadeEnd: noop,
    onBookmarkCapture: noopBookmark,
    ...props,
  } as ComponentProps<typeof TickerLane>);
}

describe("TickerLane (受動部品)", () => {
  it("① 与えられた segmentIndex のセグメントを render する", () => {
    render(TickerLane, {
      job: job({ segments: ["セグA", "セグB"], segmentIndex: 1 }),
      segmentIndex: 1, runEnd: 2, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(screen.getByText("セグB")).toBeTruthy();
  });

  it("② role に応じた class が付く", () => {
    const { container } = render(TickerLane, {
      job: job({ role: "eewWarning", segments: ["警報"] }),
      segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(container.querySelector(".role-eewWarning")).toBeTruthy();
  });

  it("engine が指定した solid だけが本文面を持つ", () => {
    const solid = renderLane({ job: job({ role: "weatherEmergency", surface: "solid" }) });
    expect(solid.container.querySelector(".ticker-line.solid")).not.toBeNull();
    solid.unmount();
    const plain = renderLane({ job: job({ role: "weatherEmergency", surface: "none" }) });
    expect(plain.container.querySelector(".ticker-line.solid")).toBeNull();
  });

  it("③ job が null は何も描かない (両レーン空欄、emptyLabel 撤去、spec §4-2)", () => {
    const { container } = render(TickerLane, {
      job: null, segmentIndex: 0, runEnd: 0, generation: 0, phase: "idle",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(container.querySelector(".ticker-line")).toBeFalsy();
    expect(container.textContent).not.toContain("受信待機中");
  });

  it("④ job.category が左端ラベルに出る (無ければラベル枠なし)", () => {
    const { container } = render(TickerLane, {
      job: job({ category: "気象警報・注意報", segments: ["本文"] }),
      segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(container.querySelector(".ticker-label")?.textContent).toBe("気象警報・注意報");

    const { container: c2 } = render(TickerLane, {
      job: job({ category: null }), segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(c2.querySelector(".ticker-label")).toBeNull();
  });

  it("⑤ ticker-scroll の animationend で onScrollEnd(generation) を呼ぶ", async () => {
    const onScrollEnd = vi.fn();
    const { container } = render(TickerLane, {
      job: job(), segmentIndex: 0, runEnd: 1, generation: 7, phase: "running",
      onScrollEnd, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-scroll" }));
    await tick();
    expect(onScrollEnd).toHaveBeenCalledWith(7);
  });

  it("⑥ ticker-fade-out の animationend で onFadeEnd(generation) を呼ぶ", async () => {
    const onFadeEnd = vi.fn();
    const { container } = render(TickerLane, {
      job: job(), segmentIndex: 0, runEnd: 1, generation: 9, phase: "fading",
      onScrollEnd: noop, onFadeEnd, onBookmarkCapture: noopBookmark,
    });
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-fade-out" }));
    await tick();
    expect(onFadeEnd).toHaveBeenCalledWith(9);
  });

  it("⑤-b Svelte スコープ名 (svelte-<hash>-ticker-scroll) の animationend でも onScrollEnd を呼ぶ (回帰)", async () => {
    // 実ブラウザは @keyframes 名をコンポーネントスコープでリネームするため、AnimationEvent.animationName
    // は素の "ticker-scroll" ではなくスコープ prefix 付きになる。完全一致だと発火せず走行が凍結する
    const onScrollEnd = vi.fn();
    const { container } = render(TickerLane, {
      job: job(), segmentIndex: 0, runEnd: 1, generation: 3, phase: "running",
      onScrollEnd, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "svelte-zlleu7-ticker-scroll" }));
    await tick();
    expect(onScrollEnd).toHaveBeenCalledWith(3);
  });

  it("⑥-b Svelte スコープ名の ticker-fade-out の animationend でも onFadeEnd を呼ぶ (回帰)", async () => {
    const onFadeEnd = vi.fn();
    const { container } = render(TickerLane, {
      job: job(), segmentIndex: 0, runEnd: 1, generation: 4, phase: "fading",
      onScrollEnd: noop, onFadeEnd, onBookmarkCapture: noopBookmark,
    });
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "svelte-abc123-ticker-fade-out" }));
    await tick();
    expect(onFadeEnd).toHaveBeenCalledWith(4);
  });

  it("⑦ animationName が一致しない (fade-in 等) イベントは無視する (誤 advance 防止)", async () => {
    const onScrollEnd = vi.fn();
    const onFadeEnd = vi.fn();
    const { container } = render(TickerLane, {
      job: job(), segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd, onFadeEnd, onBookmarkCapture: noopBookmark,
    });
    const line = container.querySelector(".ticker-line")!;
    line.dispatchEvent(Object.assign(new Event("animationend"), { animationName: "ticker-fade-in" }));
    await tick();
    expect(onScrollEnd).not.toHaveBeenCalled();
    expect(onFadeEnd).not.toHaveBeenCalled();
  });

  it("⑧ reduced-motion では animationend を待たずタイマー駆動で onScrollEnd する", async () => {
    const restore = stubReducedMotion(true);
    vi.useFakeTimers();
    try {
      const onScrollEnd = vi.fn();
      render(TickerLane, {
        job: job({ segments: ["静止ページ本文"] }), segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
        onScrollEnd, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      vi.advanceTimersByTime(8000);
      await tick();
      expect(onScrollEnd).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
      restore();
    }
  });

  it("⑨ dim=true でレーンに dim class が付く (減光の適用範囲に入る)", () => {
    const { container } = render(TickerLane, {
      job: job({ segments: ["本文"] }), segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      dim: true, onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(container.querySelector(".ticker-lane.dim")).toBeTruthy();

    const { container: c2 } = render(TickerLane, {
      job: job({ segments: ["本文"] }), segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      dim: false, onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(c2.querySelector(".ticker-lane.dim")).toBeNull();
  });

  it("⑩ テロップ減光は opacity でなく color-mix (§8 / §10 の dim 乗算事故回避)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // dim スコープで color-mix による最暗面ブレンドを使う
    expect(src).toMatch(/\.ticker-lane\.dim[\s\S]*?color-mix\(in srgb, var\(--tk-c\)/);
    // dim スコープで opacity を減光手段に使っていない
    expect(src).not.toMatch(/\.ticker-lane\.dim[^{]*\{[^}]*opacity:/);
  });

  it("⑪ dim 遷移は color/background/box-shadow のみで opacity を含まない (fade アニメ非干渉)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    const m = src.match(/transition:\s*color[^;]*;/);
    expect(m).toBeTruthy();
    const decl = m![0];
    // 待機画面 .standby と共有する dim 同期契約 (--dur-standby-dim = 600ms)
    expect(decl).toContain("var(--dur-standby-dim) ease");
    // color 系のみ。opacity には付けない (テロップ自身の fade-in/out と干渉するため)
    expect(decl).not.toContain("opacity");
    // reduced-motion では遷移を瞬時化する
    const rmIdx = src.search(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ticker-line,\s*\.ticker-label\s*\{\s*transition:\s*none/);
    expect(rmIdx).toBeGreaterThan(-1);
    // カスケード逆転ガード: reduced-motion の transition:none は基底 transition 宣言より**後**に
    // 置かねばならない (同一詳細度でソース順後勝ち)。前にあると基底 0.6s に上書きされて効かない
    const baseIdx = src.indexOf(decl);
    expect(rmIdx).toBeGreaterThan(baseIdx);
  });

  // ── CSS トークン退行ガード (ソース読み、API 非依存で維持) ──
  it("種別ラベルの右パディングは --ticker-label-pad トークン参照 (フォールバック直値を持たない)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toContain("var(--ticker-label-pad)");
    expect(src).not.toContain("var(--ticker-label-pad, 0.75em)");
  });

  it("種別ラベルは container 文法 (--chip-container 面 + --chip-on 文字) を CSS で消費する (Spec C §3-1)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // CSS 側で custom property を消費 (dim 規則が background を上書きできるようインライン直書きにしない)
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?background:\s*var\(--chip-container\)/);
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?color:\s*var\(--chip-on\)/);
    // 下端 band 帯は目視フィードバック (2026-07-11「ストライプが派手」) により削除。残置防止
    expect(src).not.toContain("--chip-band");
    expect(src).not.toMatch(/\.ticker-label\s*\{[\s\S]*?border-bottom/);
    // 角丸は矩形寄りの --radius-s、elevation は据え置き
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?border-radius:\s*var\(--radius-s\)/);
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?box-shadow:\s*var\(--ticker-label-shadow\)/);
  });

  it("チップに resolveChipTokens の解決値がインライン custom property で載る (Spec C §3-4)", () => {
    const { container } = renderLane({
      job: job({ role: "eewWarning", category: "緊急地震速報", segments: ["本文"] }),
    });
    const chip = container.querySelector(".ticker-label")!;
    const style = chip.getAttribute("style") ?? "";
    expect(style).toContain("--chip-container: var(--header-eewWarning-container)");
    expect(style).toContain("--chip-on: var(--header-eewWarning-on)");
    expect(style).not.toContain("--chip-band");
  });

  it("種別ラベルは --type-label-weight-emphasized (既存トークンの1段上) を使う", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/\.ticker-label\s*\{[^}]*font-weight: var\(--type-label-weight-emphasized\);/);
  });

  it("⑫ job.subject が非 null なら種別ラベルの後に件名が出る (null は種別のみ)", () => {
    const { container } = render(TickerLane, {
      job: job({ category: "火山情報", subject: "桜島", segments: ["本文"] }),
      segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    const label = container.querySelector(".ticker-label")?.textContent ?? "";
    expect(label).toContain("火山情報");
    expect(label).toContain("桜島");

    const { container: c2 } = render(TickerLane, {
      job: job({ category: "火山情報", subject: null, segments: ["本文"] }),
      segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
    });
    expect(c2.querySelector(".ticker-label")?.textContent).toBe("火山情報");
  });

  it("⑭ fading 中の栞捕捉は 1 世代 1 回だけ (親再描画で新 onBookmarkCapture 参照が来ても再走しない、B6 回帰)", async () => {
    // 実機バグ (effect_update_depth_exceeded): 高交代で上段が fading に入ると栞捕捉 $effect.pre が
    // onBookmarkCapture を呼ぶ。親 Ticker は毎再描画で新しいインライン arrow を onBookmarkCapture に
    // 渡すため、それを呼ぶ pre-effect が依存する参照が毎回変わり、capture→scheduler 更新→親再描画→
    // 新参照→pre-effect 再走…の read/write サイクルで凍結した。ここでは親再描画を rerender で模し、
    // 同一 generation では捕捉が 1 回に留まる (毎再描画で新コールバックが来ても再走しない) ことを固定する。
    let captures = 0;
    const bookmark = (): void => { captures += 1; };
    const j = job({ segments: ["本文"], segmentIndex: 0 });
    const { rerender } = render(TickerLane, {
      job: j, segmentIndex: 0, runEnd: 1, generation: 5, phase: "fading",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: bookmark,
    });
    await tick();
    // 親再描画を複数回模す: 毎回新しい onBookmarkCapture arrow + 新しい job オブジェクト参照を渡す
    // (generation は据え置き = 同一 fade サイクル)
    for (let i = 0; i < 5; i += 1) {
      await rerender({
        job: { ...j }, segmentIndex: 0, runEnd: 1, generation: 5, phase: "fading",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: (): void => { captures += 1; },
      });
      await tick();
    }
    expect(captures).toBe(1); // ガード無しだと再描画ごとに増える (>1) → 凍結の種

    // 次の fade サイクル (generation 更新) では再捕捉される
    await rerender({
      job: { ...j }, segmentIndex: 0, runEnd: 1, generation: 6, phase: "fading",
      onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: (): void => { captures += 1; },
    });
    await tick();
    expect(captures).toBe(2);
  });

  it("⑬ reduced-motion のページは run 全体を含む (先頭セグメントだけに縮退しない、B4 回帰)", async () => {
    // 描画の each ループは元々 run 全体を span 化していたが、reduced-motion は displayText (pages 由来)
    // を表示する。pages は runText = slice(segmentIndex, runEnd) の連結を pageSplit した結果でなければ
    // ならない。run 先頭 1 セグメントだけを食うと run 内 2 番目以降が丸ごと欠落する回帰が出る (§2-1/§5)
    const restore = stubReducedMotion(true);
    try {
      const { container } = render(TickerLane, {
        job: job({ segments: ["セグ壱", "セグ弐", "セグ参"] }),
        segmentIndex: 0, runEnd: 3, generation: 1, phase: "running",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick(); // reducedMotion は $effect で立つので DOM 反映を待つ
      // reduced 経路にいること (span 列 each ループではなく displayText 表示) を保証する。
      // each ループは元々全 span を出すので、これが無いと偽 pass になる
      expect(container.querySelector(".ticker-bookmark")).toBeFalsy();
      const text = container.querySelector(".ticker-line")?.textContent ?? "";
      expect(text).toContain("セグ壱");
      expect(text).toContain("セグ弐");
      expect(text).toContain("セグ参");
    } finally {
      restore();
    }
  });

  it("⑯ 流れきり (job=null) 後もチップを CHIP_LINGER_MS(0.5s) 残し、経過で消す (目視フィードバック 2026-07-11)", async () => {
    vi.useFakeTimers();
    try {
      const { rerender, container } = render(TickerLane, {
        job: job({ category: "地震情報", subject: "宮城県沖", segments: ["本文"] }),
        segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick();
      expect(container.querySelector(".ticker-label")?.textContent).toContain("地震情報");

      // 流れきり: job=null。チップは残るが走行文字 (.ticker-line) は消える
      await rerender({
        job: null, segmentIndex: 0, runEnd: 0, generation: 1, phase: "idle",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick();
      expect(container.querySelector(".ticker-label")?.textContent).toContain("地震情報"); // 残存
      expect(container.querySelector(".ticker-line")).toBeFalsy(); // 走行文字は残さない

      vi.advanceTimersByTime(499);
      await tick();
      expect(container.querySelector(".ticker-label")).toBeTruthy(); // 0.5 秒未満はまだ残る

      // 0.5 秒経過で linger タイマー発火 → #if 偽化。ここで |global の outro フェードが始まるため、
      // チップは即座には消えず outro 中は DOM に残る (= フェードして消える。|global が効いている証拠)
      vi.advanceTimersByTime(1);
      await tick();
      expect(container.querySelector(".ticker-label")).toBeTruthy(); // outro 中はまだ残る

      // outro を流し切る (FakeAnimation の setTimeout(0) finish を timer+tick 数巡) と消滅する
      for (let i = 0; i < 5; i += 1) {
        vi.runAllTimers();
        await tick();
      }
      expect(container.querySelector(".ticker-label")).toBeFalsy(); // フェード完了で消滅
    } finally {
      vi.useRealTimers();
    }
  });

  it("⑰ linger 中に次ジョブが来たらチップを即差替え (2 秒待たない)", async () => {
    vi.useFakeTimers();
    try {
      const { rerender, container } = render(TickerLane, {
        job: job({ category: "地震情報", subject: null, segments: ["本文"] }),
        segmentIndex: 0, runEnd: 1, generation: 1, phase: "running",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick();
      await rerender({
        job: null, segmentIndex: 0, runEnd: 0, generation: 1, phase: "idle",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick();
      vi.advanceTimersByTime(200); // linger 途中 (CHIP_LINGER_MS=500 の発火前)
      // 次ジョブ到着 → 新チップが即座に現れる (linger 0.5秒を待たない)。切替は {#key} + transition:fade の
      // cross-fade なので、旧チップは outro 中に一時的に共存し、フェード完了後に新チップだけが残る
      await rerender({
        job: job({ category: "気象警報・注意報", subject: "熊本県", segments: ["本文2"] }),
        segmentIndex: 0, runEnd: 1, generation: 2, phase: "running",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick();
      const labelTexts = (): string[] =>
        Array.from(container.querySelectorAll(".ticker-label")).map((e) => e.textContent ?? "");
      // 新チップは 0.5 秒待たず即座に存在する (即差替えの本質 = linger を待たない)
      expect(labelTexts().some((t) => t.includes("気象警報・注意報"))).toBe(true);
      // outro を流し切ると旧チップは消え、新チップだけが残る (fade 完了は
      // test-setup.ts の FakeAnimation が setTimeout(0) で finish させる → timer + tick を数巡回す)
      for (let i = 0; i < 5; i += 1) {
        vi.runAllTimers();
        await tick();
      }
      const after = labelTexts();
      expect(after.some((t) => t.includes("気象警報・注意報"))).toBe(true);
      expect(after.some((t) => t.includes("地震情報"))).toBe(false); // 旧チップは残さない
    } finally {
      vi.useRealTimers();
    }
  });

  // ── チップの出現・消滅・切替フェード (目視フィードバック 2026-07-11) ──
  it("チップは svelte/transition の fade で出現・消滅する (既存ページ切替と同じ spring-effects 文法)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // 既存要素 (TsunamiPanel のページ切替) と同じ import・easing・duration を流用 (新規定数を作らない)
    expect(src).toContain('import { fade } from "svelte/transition"');
    expect(src).toMatch(/import \{ SPRING_EFFECTS_DEFAULT_MS, springEffectsOut \} from "\.\.\/lib\/motion"/);
    // reduced-motion では duration 0 でフェードを止める。
    // **|global 必須**: {#if shownChip} > {#key} > <div transition> の入れ子では、既定 local の transition は
    // {#if} トグル (出現/linger 後の消え際) が祖先ブロック起因のためスキップされポップイン/アウトになる。
    // |global で {#if} トグル時の intro/outro も発火する (Change 2 レビュー Critical 対応)
    expect(src).toMatch(
      /transition:fade\|global=\{\{\s*duration: reducedMotion \? 0 : SPRING_EFFECTS_DEFAULT_MS,\s*easing: springEffectsOut,?\s*\}\}/,
    );
    // local に退行したら検出する negative guard (|global なしの素の transition:fade を許さない)
    expect(src).not.toMatch(/transition:fade=\{\{/);
  });

  it("チップ切替は {#key chipKey} の cross-fade で、旧チップ outro と新チップ intro を重ねる", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // role/種別/件名の合成キーで {#key} を張り、内容変化で入替演出を発火させる
    expect(src).toMatch(/chipKey = \$derived\([\s\S]*?shownChip\.role[\s\S]*?shownChip\.category[\s\S]*?shownChip\.subject/);
    expect(src).toContain("{#key chipKey}");
    // 重ねクロスフェード: slot を grid にし、旧/新チップを同一セル (grid-area 1/1) に重ねる
    // (横並び・幅潰れを防ぐ。TsunamiPanel .page-fade の絶対重ねと同じ狙い)
    expect(src).toMatch(/\.ticker-label-slot\s*\{[\s\S]*?display:\s*grid/);
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?grid-area:\s*1\s*\/\s*1/);
  });

  it("件名 (subject) があれば A の 2 span が出て、C の視覚意匠が乗る (Spec C §3-2)", () => {
    const { container } = renderLane({
      job: job({ category: "緊急地震速報", subject: "日向灘 M7.1", segments: ["本文"] }),
    });
    // DOM は A 由来 (.ticker-label-category / .ticker-label-subject)
    expect(container.querySelector(".ticker-label-category")?.textContent).toBe("緊急地震速報");
    expect(container.querySelector(".ticker-label-subject")?.textContent).toBe("日向灘 M7.1");
  });

  it("subject が null なら件名 span は出ない (A の分岐、C 非破壊)", () => {
    const { container } = renderLane({
      job: job({ category: "地震情報", subject: null, segments: ["本文"] }),
    });
    expect(container.querySelector(".ticker-label-category")?.textContent).toBe("地震情報");
    expect(container.querySelector(".ticker-label-subject")).toBeNull();
  });

  it("件名スタイルは縦仕切り + 省略 + ウェイト差 (Spec C §3-2)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/\.ticker-label-category\s*\{[\s\S]*?font-weight:\s*var\(--type-label-weight-emphasized\)/);
    expect(src).toMatch(/\.ticker-label-subject\s*\{[\s\S]*?border-left:[\s\S]*?text-overflow:\s*ellipsis/);
  });

  it("走行行に data-priority が付き、優先度でウェイト段階化する (Spec C §5)", () => {
    const { container } = renderLane({
      job: job({ priority: "high", segments: ["緊急本文"] }),
    });
    expect(container.querySelector('.ticker-line[data-priority="high"]')).toBeTruthy();
  });

  it("走行文字は tabular-nums で数字が等幅 (Spec C §5)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/\.ticker-line[\s\S]*?font-variant-numeric:\s*tabular-nums/);
  });

  it("優先度ウェイトは型トークン (regular/medium/bold) を使う (Spec C §5)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/data-priority="low"[\s\S]*?var\(--type-weight-regular\)/);
    expect(src).toMatch(/data-priority="mid"[\s\S]*?var\(--type-weight-medium\)/);
    expect(src).toMatch(/data-priority="high"[\s\S]*?var\(--type-weight-bold\)/);
  });

  it("showRevisionBadge=true でチップに続報バッジが出る / false で出ない (Spec C §3-3)", () => {
    const { container } = renderLane({
      job: job({ category: "地震情報", segments: ["本文"] }),
      showRevisionBadge: true,
    });
    expect(container.querySelector(".ticker-label-revision")?.textContent).toBe("続報");

    const { container: c2 } = renderLane({
      job: job({ category: "地震情報", segments: ["本文"] }),
      showRevisionBadge: false,
    });
    expect(c2.querySelector(".ticker-label-revision")).toBeNull();
  });

  it("emphasis='high' でレーンに data-emphasis='high' が付く (Spec C §4-1)", () => {
    const { container } = renderLane({
      job: job({ role: "eewWarning", priority: "high", segments: ["緊急"] }),
      emphasis: "high",
    });
    expect(container.querySelector('.ticker-lane[data-emphasis="high"]')).toBeTruthy();
  });

  it("レーン面に background transition が新設され、reduced-motion 用 lane transition:none が基底より後にある (Spec C §4-4 / R1-6)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // .ticker-lane 自体に background-color の transition を新設 (現行は line/label のみ)
    const laneTransition = src.match(/\.ticker-lane\s*\{[^}]*transition:\s*background-color var\(--dur-standby-dim\) ease[^}]*\}/);
    expect(laneTransition).toBeTruthy();
    // high tint は color-mix で面へ role 色を混ぜる (opacity 不使用)
    expect(src).toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\{[\s\S]*?color-mix\(in srgb, var\(--tk-c\)/);
    // reduced-motion の lane transition:none が基底の lane transition より後 (カスケード後勝ち)
    const baseIdx = src.search(/\.ticker-lane\s*\{[^}]*transition:\s*background-color var\(--dur-standby-dim\) ease/);
    const rmIdx = src.search(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.ticker-lane\s*\{\s*transition:\s*none/);
    expect(rmIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(baseIdx);
  });

  // ── high tint 親配線 (最終レビュー finding 1) ──
  it("job があるときレーンルートに --tk-c インラインが載る (high tint / dim×high の親計算源)", () => {
    const { container } = renderLane({
      job: job({ role: "eewWarning", priority: "high", segments: ["緊急"] }),
      emphasis: "high",
    });
    const lane = container.querySelector(".ticker-lane")!;
    const style = lane.getAttribute("style") ?? "";
    // CSS custom property は子→親へ伝播しないため、high tint (色-mix on --tk-c) を親レーンで
    // 計算するにはルート自身が --tk-c を持つ必要がある。role → var(--role-*) を inline 供給する
    expect(style).toContain("--tk-c: var(--role-eewWarning)");
  });

  it("job=null (linger/空) のレーンルートには --tk-c を載せない (emphasis 無しなら不要)", () => {
    const { container } = renderLane({ job: null });
    const lane = container.querySelector(".ticker-lane")!;
    const style = lane.getAttribute("style") ?? "";
    expect(style).not.toContain("--tk-c");
  });

  // ── role ↔ .role-* の完全一致 (最終レビュー finding 4) ──
  it("DisplayColorRole union と .role-* 規則 (--tk-c 供給) が 17 role で完全一致する", () => {
    const protoSrc = readFileSync(join(__dirname, "..", "..", "lib", "protocol.ts"), "utf-8");
    // DisplayFrameLevel + DisplayColorRole の 2 宣言から string literal を集める (union を展開)
    const frameDecl = protoSrc.match(/export type DisplayFrameLevel\s*=([^;]*);/)?.[1] ?? "";
    const roleDecl = protoSrc.match(/export type DisplayColorRole\s*=([^;]*);/)?.[1] ?? "";
    const unionRoles = new Set(
      [...frameDecl.matchAll(/"([a-zA-Z]+)"/g), ...roleDecl.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!),
    );
    expect(unionRoles.size).toBe(17); // 型が増減したらこの数も更新すること

    const laneSrc = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    const ruleRoles = new Set(
      [...laneSrc.matchAll(/\.role-([a-zA-Z]+)\s*\{\s*--tk-c:\s*var\(--role-([a-zA-Z]+)\)\s*;\s*\}/g)]
        .filter((m) => m[1] === m[2]) // クラス名と参照トークン名が一致していること
        .map((m) => m[1]!),
    );
    // 過不足なく一致 (muted 欠落など片方向の穴を検出)
    expect([...ruleRoles].sort()).toEqual([...unionRoles].sort());
  });

  it("全 17 role でレーンルートの --tk-c 親配線が成立する (finding 1 が muted 含む全 role で有効)", () => {
    const protoSrc = readFileSync(join(__dirname, "..", "..", "lib", "protocol.ts"), "utf-8");
    const frameDecl = protoSrc.match(/export type DisplayFrameLevel\s*=([^;]*);/)?.[1] ?? "";
    const roleDecl = protoSrc.match(/export type DisplayColorRole\s*=([^;]*);/)?.[1] ?? "";
    const roles = [...new Set(
      [...frameDecl.matchAll(/"([a-zA-Z]+)"/g), ...roleDecl.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]!),
    )];
    for (const role of roles) {
      const { container } = renderLane({
        job: job({ role: role as TickerJob["role"], category: "種別", segments: ["本文"] }),
        emphasis: "high",
      });
      const style = container.querySelector(".ticker-lane")!.getAttribute("style") ?? "";
      expect(style).toContain(`--tk-c: var(--role-${role})`);
    }
  });

  // ── high 時のチップ子 span ウェイト段階化 (最終レビュー finding 3) ──
  it("high 時に子 span を直接指す規則でウェイトを段階化する (親継承では span 自前 weight に負けるため)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // 走行文字は .ticker-line 継承 (.ticker-bookmark span は自前 weight を持たない) で heavy
    expect(src).toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\.ticker-line\s*\{[^}]*font-weight:\s*var\(--type-weight-heavy\)/);
    // 子 span は各々を直接指す規則で上書き: 種別・続報 semibold→bold / 件名 regular→medium
    expect(src).toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\.ticker-label-category\s*\{[^}]*font-weight:\s*var\(--type-weight-bold\)/);
    expect(src).toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\.ticker-label-revision\s*\{[^}]*font-weight:\s*var\(--type-weight-bold\)/);
    expect(src).toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\.ticker-label-subject\s*\{[^}]*font-weight:\s*var\(--type-weight-medium\)/);
    // 継承では効かないので、親 .ticker-label 単体への heavy 一括指定に戻していないこと (退行ガード)
    expect(src).not.toMatch(/\.ticker-lane\[data-emphasis="high"\]\s*\.ticker-label\s*\{[^}]*font-weight:\s*var\(--type-weight-heavy\)/);
  });

  // ── dim 時の件名仕切り・続報バッジの減光 (最終レビュー finding 5) ──
  it("件名仕切り・続報バッジは rendered トークンを参照し dim で減光後の値に差し替わる", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // 基底 .ticker-label で rendered トークンを生値に定義
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?--chip-on-rendered:\s*var\(--chip-on\)/);
    expect(src).toMatch(/\.ticker-label\s*\{[\s\S]*?--chip-container-rendered:\s*var\(--chip-container\)/);
    // dim 規則が rendered トークンを 35% 減光値へ差し替え
    expect(src).toMatch(/\.ticker-lane\.dim\s*\.ticker-label\s*\{[\s\S]*?--chip-on-rendered:\s*color-mix\(in srgb, var\(--chip-on\) 35%/);
    expect(src).toMatch(/\.ticker-lane\.dim\s*\.ticker-label\s*\{[\s\S]*?--chip-container-rendered:\s*color-mix\(in srgb, var\(--chip-container\) 35%/);
    // 仕切り・バッジは生 --chip-* ではなく rendered を参照する (dim を逃れない)
    expect(src).toMatch(/\.ticker-label-subject\s*\{[\s\S]*?border-left:[^;]*var\(--chip-on-rendered\)/);
    expect(src).toMatch(/\.ticker-label-revision\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--chip-on-rendered\)[^;]*var\(--chip-container-rendered\)/);
    expect(src).toMatch(/\.ticker-label-revision\s*\{[\s\S]*?color:\s*var\(--chip-on-rendered\)/);
  });

  // ── engine 権威の solid テロップ面 ──
  it("solid テロップは role 解決済みの container/on ペアで面を敷く", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    expect(src).toMatch(/class:solid=\{job\.surface === "solid"\}/);
    expect(src).toMatch(/\.ticker-line\.solid\s*\{[\s\S]*?background:\s*var\(--ticker-surface-container\)/);
    expect(src).toMatch(/\.ticker-line\.solid\s*\{[\s\S]*?color:\s*var\(--ticker-surface-on\)/);
    // 面が走行テキストに追従する矩形になるよう少量 padding + 角丸 (直値色は増やさない)
    expect(src).toMatch(/\.ticker-line\.solid\s*\{[\s\S]*?padding:/);
  });

  it("solid テロップの dim は面・文字とも color-mix 35% で沈め、警報級 floor は戻す (§10)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    const m = src.match(/\.ticker-lane\.dim\s*\.ticker-line\.solid\s*\{[^}]*\}/);
    expect(m).toBeTruthy();
    const decl = m![0];
    expect(decl).toMatch(/background:\s*color-mix\(in srgb, var\(--ticker-surface-container\) 35%, var\(--bg\)\)/);
    expect(decl).toMatch(/color:\s*color-mix\(in srgb, var\(--ticker-surface-on\) 35%, var\(--bg\)\)/);
    expect(decl).not.toContain("opacity");
  });

  it("走行文字の面遷移は background-color も対象 (dim 明転/暗転)。opacity は含まない", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // .ticker-line の transition 宣言 (末尾が background-color で終わり、box-shadow を含む
     // .ticker-label とは区別される)。面遷移を足したことで dim on/off の反転面が --dur-standby-dim で明転/暗転し、
     // かつ color/background-color のみで opacity を対象にしない (fade-in/out アニメ非干渉)
    expect(src).toContain("transition: color var(--dur-standby-dim) ease, background-color var(--dur-standby-dim) ease;");
    expect(src).not.toContain("transition: color var(--dur-standby-dim) ease, background-color var(--dur-standby-dim) ease, opacity");
  });

  // ── 重要語句ハイライト (backlog §3) ──
  it("segmentEmphasis の区間が .ticker-emph span で強調描画される (走行モード)", () => {
    const restore = stubReducedMotion(false);
    try {
      const { container } = renderLane({
        job: job({
          priority: "low",
          segments: ["中心気圧970hPa"],
          segmentEmphasis: [[{ start: 4, end: 10 }]], // "970hPa"
        }),
      });
      const emph = container.querySelector(".ticker-emph");
      expect(emph?.textContent).toBe("970hPa");
      // 栞 span 全体の文字は保存される (強調は内側の span へ切り出すだけ)
      expect(container.querySelector(".ticker-bookmark")?.textContent).toBe("中心気圧970hPa");
    } finally {
      restore();
    }
  });

  it("segmentEmphasis が空なら .ticker-emph は出ない (無強調は素の走行文字)", () => {
    const restore = stubReducedMotion(false);
    try {
      const { container } = renderLane({
        job: job({ priority: "low", segments: ["数値のない本文"], segmentEmphasis: [[]] }),
      });
      expect(container.querySelector(".ticker-emph")).toBeNull();
      expect(container.querySelector(".ticker-bookmark")?.textContent).toBe("数値のない本文");
    } finally {
      restore();
    }
  });

  it("reduced-motion でも強調がページローカル座標へ写像され .ticker-emph が出る (レビュー F3)", async () => {
    const restore = stubReducedMotion(true);
    try {
      const { container } = render(TickerLane, {
        job: job({
          priority: "low",
          segments: ["中心気圧970hPa", "最大風速25m/s"],
          // seg0 "970hPa" = 4..10 / seg1 "25m/s" = 4..9
          segmentEmphasis: [[{ start: 4, end: 10 }], [{ start: 4, end: 9 }]],
        }),
        segmentIndex: 0, runEnd: 2, generation: 1, phase: "running",
        onScrollEnd: noop, onFadeEnd: noop, onBookmarkCapture: noopBookmark,
      });
      await tick(); // reducedMotion は $effect で立つので DOM 反映を待つ
      // reduced 経路 (bookmark span ではなくページ表示) に居ること
      expect(container.querySelector(".ticker-bookmark")).toBeFalsy();
      const emphTexts = Array.from(container.querySelectorAll(".ticker-emph")).map((e) => e.textContent);
      expect(emphTexts).toContain("970hPa");
      expect(emphTexts).toContain("25m/s");
      // 全文は保存される (SEG_JOIN 連結の 1 ページ)
      const text = container.querySelector(".ticker-line")?.textContent ?? "";
      expect(text).toContain("中心気圧970hPa");
      expect(text).toContain("最大風速25m/s");
    } finally {
      restore();
    }
  });

  it(".ticker-emph はウェイト増のみで色を変えない (severity 色体系非干渉、backlog §3)", () => {
    const src = readFileSync(join(__dirname, "..", "TickerLane.svelte"), "utf-8");
    // font-weight を上げる。color / background / opacity は触らない
    expect(src).toMatch(/\.ticker-emph\s*\{[^}]*font-weight:\s*var\(--type-weight-bold\)/);
    const decl = src.match(/\.ticker-emph\s*\{[^}]*\}/)?.[0] ?? "";
    expect(decl).not.toContain("color");
    expect(decl).not.toContain("background");
    expect(decl).not.toContain("opacity");
  });

  it("role='tsunamiMajor' の走行行に .role-tsunamiMajor が付く / 他 role には付かない", () => {
    const { container } = renderLane({
      job: job({ role: "tsunamiMajor", segments: ["大津波警報 宮崎県・高知県"] }),
    });
    expect(container.querySelector(".ticker-line.role-tsunamiMajor")).toBeTruthy();

    const { container: c2 } = renderLane({
      job: job({ role: "weatherEmergency", segments: ["大雨特別警報 熊本県"] }),
    });
    // 気象特別警報 (同じ紫の走行文字色) には反転面クラスが付かない = 面の有無で差別化される
    expect(c2.querySelector(".ticker-line.role-tsunamiMajor")).toBeFalsy();
    expect(c2.querySelector(".ticker-line.role-weatherEmergency")).toBeTruthy();
  });
});
