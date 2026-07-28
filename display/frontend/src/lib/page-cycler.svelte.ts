// 固定サマリ計器の詳細ページング用の周期フェーズマシン (summary-instrument-paging spec §3)。
// T6 で撤去済みの vertical-ping-pong-scroll.svelte.ts (フェーズマシン構造・reduced-motion 購読・
// cleanup パターン) を下敷きにしたが、あちらはコンポーネントの <script> 直下で呼ばれることで
// 暗黙的に effect context を借りている。ページャは単体テストで vi.useFakeTimers を使い周回・
// 巻き戻し・cleanup を検証したいため、$effect.root を自前で張ってコンポーネント文脈の有無に
// 依らず動作・破棄できる構造にする (destroy() は将来コンポーネント側が unmount 時に呼ぶ想定。
// 現状の EewPanel 等は常時マウントのため必須ではないが、テスト容易性のために自己完結させる)。
import { flushSync } from "svelte";

export const PAGE_HOLD_MS = 10_000; // 静止時間の初期値。8〜12 秒の中央 (要 preview + 実機調整)

// ページ切替の重ねクロスフェード (T5c、spec §3 再々改訂 2026-07-09「数十msの短いフェード」は
// 背景へのディップでチカチカするため撤回、旧ページと新ページを重ねてクロスフェード」に変更)。
// 時間/easing は新規に作らず既存の effects spring トークンを流用する: lib/motion.ts の
// SPRING_EFFECTS_DEFAULT_MS (231ms) + springEffectsOut (theme.css --spring-effects-default と
// 同じ物理の JS 版)。各パネルは {#key index} でキー化した要素に
// transition:fade={{ duration: cycler.reducedMotion ? 0 : SPRING_EFFECTS_DEFAULT_MS,
// easing: springEffectsOut }} を付け、outro/intro が同時に走ることで「重ね」クロスフェードに
// なる (要素は position:absolute で重ねる、コンポーネント側 CSS)。reducedMotion は下の
// PageCycler.reducedMotion をそのまま使う (ページ送り自体は止めない、既存規範)

export interface PageCycler {
  readonly index: number; // 現在ページ index (0-based)
  readonly total: number; // 総ページ数 (pageCount getter から派生。手動 set 口は無い)
  readonly reducedMotion: boolean; // 切替アニメを 0ms にするための購読値。ページ送り自体は止めない
  /** ドットインジケータのクリック等、任意のページへ直接ジャンプする (spec §3 改訂、T8①)。
   *  範囲外 (0 未満・total 以上) の index は無視する。自動巡回タイマーは打ち切らず、
   *  ジャンプ先のページから静止時間 (PAGE_HOLD_MS) を再スタートする — index の値が
   *  ジャンプ前と同じ (現在ページのドットを再クリック) でも必ず再スタートする */
  jumpTo(index: number, options?: { immediate?: boolean }): void;
  destroy(): void;
}

export function createPageCycler(opts: {
  pageCount: () => number; // リアクティブ getter (例: () => pages.length)
  resetKey?: () => string | number; // 値が変わったら index=0。リセットすべきかの判定は呼び出し側の責務
}): PageCycler {
  const { pageCount, resetKey } = opts;
  let index = $state(0);
  let total = $state(pageCount());
  let reducedMotion = $state(false);
  // jumpTo が呼ばれるたびに単調増加する。周回タイマー effect がこれも依存に含めることで、
  // 「同じ index への再ジャンプ (現在ページのドットを再クリック)」でも Svelte の値等価性による
  // effect スキップを回避し、必ず静止タイマーを再スタートできる (jumpTo 自体は本文参照)
  let jumpEpoch = $state(0);
  // total>1 の crossing でのみ値が変わる派生値。周回 effect がこれを読むことで、total が
  // 3→5 のように複数ページのまま変化しても再スケジュールされない (Svelte の値等価性による)
  const hasMultiplePages = $derived(total > 1);

  let resetKeySeen = false;
  let prevResetKey: string | number | undefined;

  const destroyRoot = $effect.root(() => {
    // pageCount() の変化に total を追従させる。index が範囲外になったら 0 へ巻き戻す。
    // このEffect は index 自体を書き換えない限り周回 effect を再スケジュールしない
    // (「走行中の静止タイマーは打ち切らない、現在ページの静止は最後まで見せる」spec §3)
    $effect(() => {
      const next = pageCount();
      total = next;
      if (index >= next) {
        index = 0;
      }
    });

    // resetKey が変わったら index=0 にリセットする。初回実行は「変化」に数えない
    $effect(() => {
      if (resetKey == null) return;
      const key = resetKey();
      if (!resetKeySeen) {
        resetKeySeen = true;
        prevResetKey = key;
        return;
      }
      if (key !== prevResetKey) {
        prevResetKey = key;
        index = 0;
      }
    });

    // 現在ページを PAGE_HOLD_MS 静止させてから次ページへ進める周回タイマー
    $effect(() => {
      void index; // 依存: ページが変わる (周回・巻き戻し・reset・jumpTo) たびに静止をやり直す
      void jumpEpoch; // 依存: index が変わらないジャンプ (同じページへの再クリック) でも再スタートする
      if (!hasMultiplePages) return; // total<=1 はタイマー不要
      let cancelled = false;
      const timer = setTimeout(() => {
        if (!cancelled) {
          index = total > 0 ? (index + 1) % total : 0;
          // このコールバックは effect の同期実行の外 (マクロタスク) で走るため、Svelte の
          // 通常の非同期 flush 待ちだと次の advanceTimersByTime までに再スケジュール effect が
          // 走らない (fake timers 環境で顕在化)。直後に flushSync して即座に再登録する
          flushSync();
        }
      }, PAGE_HOLD_MS);
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    });

    // prefers-reduced-motion を購読する (撤去済みの vertical-ping-pong-scroll.svelte.ts と同一パターン)。
    // reduced でもページ送り自体 (上の周回 effect) は止めない — 1 枚固定は情報が消えるので禁止
    $effect(() => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      reducedMotion = mq.matches;
      const onChange = (e: MediaQueryListEvent): void => {
        reducedMotion = e.matches;
      };
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    });
  });
  // 旧: ここで flushSync() して初期 total/タイマーをコンストラクタ内で確定させていた。しかし
  // コンポーネントが初期 flush 完了後にリアクティブマウント (App.svelte の待機↔緊急 swap 等) される
  // と、この flushSync が進行中のフラッシュへ再入し destroy_effect が無限再帰する (Maximum call stack、
  // 2026-07-12 Chrome/jsdom 実測。実キオスクも実地震・実津波の緊急遷移で踏み得る本番バグだった)。
  // 撤去し、$effect.root の初期 effect は通常の (親コンポーネントの) フラッシュに載せて確定させる。
  // total/index の初期値は上の $state(pageCount()) が同期的に持つため、マウント直後の getter 読みは
  // flushSync 無しでも正しい。コンポーネント文脈を持たない単体テストは createPageCycler 直後に
  // 明示 flushSync() して周回タイマー等を確定させる (page-cycler.test.ts)。

  return {
    get index() {
      return index;
    },
    get total() {
      return total;
    },
    get reducedMotion() {
      return reducedMotion;
    },
    /**
     * 指定ページへ跳ぶ。
     *
     * `immediate` はイベントハンドラ (ドットクリック) 用の同期フラッシュ。
     * **`$effect` の中から呼ぶときは必ず false**。Svelte は effect 内の `flushSync()` を許さない。
     */
    jumpTo(targetIndex: number, options?: { immediate?: boolean }): void {
      if (!(targetIndex >= 0) || !(targetIndex < total)) return; // 範囲外は無視 (NaN もここで弾かれる)
      index = targetIndex;
      jumpEpoch += 1;
      if (options?.immediate !== false) flushSync();
    },
    destroy(): void {
      destroyRoot();
    },
  };
}

/**
 * テスト専用ヘルパー。vitest の test include (`**\/*.test.ts`) と vite-plugin-svelte の
 * rune コンパイル対象 (`*.svelte.ts`) は拡張子上両立できない (両方を満たすファイル名を作れない)
 * ため、page-cycler.test.ts (plain .ts、rune 不可) から pageCount()/resetKey() に渡す
 * reactive な入力を直接は作れない。コンパイルされる側のこのファイルに最小の $state ボックスを
 * 置いて回避する。本番コード (パネル側) では使わない。
 */
export function createTestSignal<T>(initial: T): { value: T } {
  let value = $state(initial);
  return {
    get value() {
      return value;
    },
    set value(v: T) {
      value = v;
    },
  };
}
