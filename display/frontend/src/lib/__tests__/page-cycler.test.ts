import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import { createPageCycler, createTestSignal, PAGE_HOLD_MS } from "../page-cycler.svelte";

// createPageCycler はコンストラクタ内 flushSync を撤去した (リアクティブマウント時の再入クラッシュ回避、
// 2026-07-12)。コンポーネント文脈を持たない本ファイルでは、$effect.root の初期 effect (周回タイマー・
// total 追従・外部注入された reduced-motion 値) を確定させるため、createPageCycler 直後に明示 flushSync() する。

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

  it("1ページも保持時間満了を通知し、index=0 のまま", () => {
    vi.useFakeTimers();
    try {
      const completed: number[] = [];
      const cycler = createPageCycler({ pageCount: () => 1, onHoldComplete: (index) => completed.push(index) });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(0);
      expect(completed).toEqual([0]);
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

  it("active page の identity/fingerprint が保持途中で変わると、その保持をやり直す", () => {
    vi.useFakeTimers();
    try {
      const identity = createTestSignal("page:a");
      const fingerprint = createTestSignal("v1");
      const completed: Array<[number, string | undefined, string | undefined]> = [];
      const cycler = createPageCycler({
        pageCount: () => 1,
        pageIdentity: () => identity.value,
        pageFingerprint: () => fingerprint.value,
        onHoldComplete: (index, heldIdentity, heldFingerprint) => completed.push([index, heldIdentity, heldFingerprint]),
      });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS - 1);
      fingerprint.value = "v2";
      flushSync();
      vi.advanceTimersByTime(1);
      expect(completed).toEqual([]);
      vi.advanceTimersByTime(PAGE_HOLD_MS - 2);
      expect(completed).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(completed).toEqual([[0, "page:a", "v2"]]);
      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("1ページの満了後に2ページへ増えても巡回タイマーを再評価する", () => {
    vi.useFakeTimers();
    try {
      const count = createTestSignal(1);
      const cycler = createPageCycler({ pageCount: () => count.value });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(0);
      count.value = 2;
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(1);
      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("他 page の追加が10秒未満で続いても、安定した active page は保持満了する", () => {
    vi.useFakeTimers();
    try {
      const count = createTestSignal(2);
      const completed: string[] = [];
      const cycler = createPageCycler({
        pageCount: () => count.value,
        pageIdentity: () => "stable:page",
        pageFingerprint: () => "stable:v1",
        onHoldComplete: (_index, identity) => { if (identity != null) completed.push(identity); },
      });
      flushSync();
      for (let update = 0; update < 9; update += 1) {
        vi.advanceTimersByTime(1_000);
        count.value += 1;
        flushSync();
      }
      expect(completed).toEqual([]);
      vi.advanceTimersByTime(1_000);
      expect(completed).toEqual(["stable:page"]);
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

  it("保持満了前の destroy は完了通知を出さず、満了後にだけ出す", () => {
    vi.useFakeTimers();
    try {
      const abandoned: number[] = [];
      const abandonedCycler = createPageCycler({ pageCount: () => 2, onHoldComplete: (index) => abandoned.push(index) });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS - 1);
      abandonedCycler.destroy();
      vi.advanceTimersByTime(1);
      expect(abandoned).toEqual([]);

      const completed: number[] = [];
      const cycler = createPageCycler({ pageCount: () => 2, onHoldComplete: (index) => completed.push(index) });
      flushSync();
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(completed).toEqual([0]);
      cycler.destroy();
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

  it("App から注入された reduced-motion 値でもページ送りは継続する (1枚固定禁止)", () => {
    vi.useFakeTimers();
    try {
      const reduced = createTestSignal(true);
      const cycler = createPageCycler({ pageCount: () => 3, reducedMotion: () => reduced.value });
      flushSync();
      expect(cycler.reducedMotion).toBe(true);

      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(1);
      vi.advanceTimersByTime(PAGE_HOLD_MS);
      expect(cycler.index).toBe(2);

      cycler.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("注入済み pager は matchMedia listener を作らない", () => {
    const original = window.matchMedia;
    const matchMedia = vi.fn();
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    try {
      const cycler = createPageCycler({ pageCount: () => 2, reducedMotion: () => false });
      flushSync();
      expect(matchMedia).not.toHaveBeenCalled();
      cycler.destroy();
    } finally {
      window.matchMedia = original;
    }
  });

  it("未注入 pager も matchMedia listener を作らず、App からの注入がない間は通常 motion に縮退する", () => {
    const original = window.matchMedia;
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    window.matchMedia = vi.fn(() => ({
      matches: true,
      media: "(prefers-reduced-motion: reduce)",
      addEventListener,
      removeEventListener,
    })) as unknown as typeof window.matchMedia;
    try {
      const cycler = createPageCycler({ pageCount: () => 2 });
      flushSync();
      expect(cycler.reducedMotion).toBe(false);
      expect(addEventListener).not.toHaveBeenCalled();
      cycler.destroy();
      expect(removeEventListener).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });
});
