import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { createPageCycler, createTestSignal, PAGE_HOLD_MS } from "../page-cycler.svelte";

// createPageCycler はコンストラクタ内 flushSync を撤去した (リアクティブマウント時の再入クラッシュ回避、
// 2026-07-12)。コンポーネント文脈を持たない本ファイルでは、$effect.root の初期 effect (周回タイマー・
// total 追従・matchMedia 購読) を確定させるため、createPageCycler 直後に明示 flushSync() する。

// prefers-reduced-motion: reduce をシミュレートする matchMedia モック
// (jsdom は未実装なのでテスト内でのみスタブする。ticker-lane.test.ts と同じパターン)
function stubReducedMotion(matches: boolean): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

describe("createPageCycler", () => {
  it("PAGE_HOLD_MS ごとに index が 0→1→2→0 と周回する", () => {
    vi.useFakeTimers();
    try {
      const cycler = createPageCycler({ pageCount: () => 3 });
      flushSync();
      expect(cycler.index).toBe(0);
      expect(cycler.total).toBe(3);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(1);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(2);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(0);

      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("total=1 のときはタイマーが発火せず index=0 のまま", () => {
    vi.useFakeTimers();
    try {
      const cycler = createPageCycler({ pageCount: () => 1 });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS * 3);
      expect(cycler.index).toBe(0);
      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pageCount が減って index が範囲外になったら 0 へ巻き戻る", () => {
    vi.useFakeTimers();
    try {
      const count = createTestSignal(5);
      const cycler = createPageCycler({ pageCount: () => count.value });
      flushSync();

      vi.advanceTimersByTime(PAGE_HOLD_MS * 3); // index: 0→1→2→3
      expect(cycler.index).toBe(3);

      count.value = 2; // 現在の index=3 が範囲外になる
      flushSync();
      expect(cycler.total).toBe(2);
      expect(cycler.index).toBe(0);

      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resetKey が変わったら index=0 にリセットされる (同一値では巻き戻らない)", () => {
    vi.useFakeTimers();
    try {
      const resetSeq = createTestSignal(0);
      const cycler = createPageCycler({ pageCount: () => 4, resetKey: () => resetSeq.value });
      flushSync();

      vi.advanceTimersByTime(PAGE_HOLD_MS * 2); // index: 0→1→2
      expect(cycler.index).toBe(2);

      resetSeq.value = 0; // 無変化
      flushSync();
      expect(cycler.index).toBe(2);

      resetSeq.value = 1; // 単調増加 → リセット
      flushSync();
      expect(cycler.index).toBe(0);

      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy 後はタイマーが発火しない (cleanup 検証)", () => {
    vi.useFakeTimers();
    try {
      const cycler = createPageCycler({ pageCount: () => 3 });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(1);

      cycler.destroy();
      vi.advanceTimersByTime(PAGE_HOLD_MS * 5);
      expect(cycler.index).toBe(1); // destroy 時点のまま変化しない
    } finally {
      vi.useRealTimers();
    }
  });

  // ドットインジケータのクリック配線用 (spec §3 改訂、T8①)
  describe("jumpTo", () => {
    it("index を設定し、そのページから静止タイマーを再スタートする", () => {
      vi.useFakeTimers();
      try {
        const cycler = createPageCycler({ pageCount: () => 5 });
        flushSync();
        vi.advanceTimersByTime(PAGE_HOLD_MS); // index: 0→1
        expect(cycler.index).toBe(1);

        cycler.jumpTo(3);
        expect(cycler.index).toBe(3);

        // ジャンプ直後は残り時間が PAGE_HOLD_MS まるごと再スタートしているはず
        vi.advanceTimersByTime(PAGE_HOLD_MS - 1);
        expect(cycler.index).toBe(3); // まだ進まない
        vi.advanceTimersByTime(1);
        expect(cycler.index).toBe(4); // ジャンプ先から1つ進む (旧 index=1 からの周回ではない)

        cycler.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("範囲外 (負数・total 以上) の index は無視する", () => {
      vi.useFakeTimers();
      try {
        const cycler = createPageCycler({ pageCount: () => 3 });
        flushSync();
        cycler.jumpTo(-1);
        expect(cycler.index).toBe(0);
        cycler.jumpTo(3); // total=3 なので 0,1,2 のみ有効
        expect(cycler.index).toBe(0);
        cycler.jumpTo(1);
        expect(cycler.index).toBe(1);
        cycler.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("現在ページと同じ index への再ジャンプでも静止タイマーを再スタートする", () => {
      vi.useFakeTimers();
      try {
        const cycler = createPageCycler({ pageCount: () => 3 });
        flushSync();
        vi.advanceTimersByTime(PAGE_HOLD_MS - 100); // あと100ms で index=1 に進むところ
        expect(cycler.index).toBe(0);

        cycler.jumpTo(0); // 同じ index=0 への再クリック

        vi.advanceTimersByTime(100);
        expect(cycler.index).toBe(0); // 再スタートしていれば、まだ進んでいないはず

        vi.advanceTimersByTime(PAGE_HOLD_MS - 100);
        expect(cycler.index).toBe(1); // ジャンプから丸々 PAGE_HOLD_MS 後に進む

        cycler.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("destroy 後は jumpTo を呼んでも例外を投げない", () => {
      const cycler = createPageCycler({ pageCount: () => 3 });
      flushSync();
      cycler.destroy();
      expect(() => cycler.jumpTo(1)).not.toThrow();
    });
  });

  it("reduced-motion でも reducedMotion=true を返しつつページ送りは継続する (1枚固定禁止)", () => {
    const restoreMatchMedia = stubReducedMotion(true);
    vi.useFakeTimers();
    try {
      const cycler = createPageCycler({ pageCount: () => 3 });
      flushSync();
      expect(cycler.reducedMotion).toBe(true);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(1);
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(2);

      cycler.destroy();
    } finally {
      vi.useRealTimers();
      restoreMatchMedia();
    }
  });
});
