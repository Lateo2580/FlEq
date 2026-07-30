import { describe, expect, it, vi } from "vitest";
import { flushSync } from "svelte";
import {
  createTipsFeeder,
  TIP_FETCH_RETRY_MS,
  TIP_FETCH_TIMEOUT_MS,
  type DisplayTipDeckItem,
  type TipContext,
} from "../tips-feeder.svelte";
import { createTestSignal } from "../page-cycler.svelte";

const TIPS = ["豆知識1", "豆知識2", "豆知識3"];

function setup(tips: string[] = TIPS) {
  const eligible = createTestSignal(false);
  const blocked = createTestSignal(false);
  const fetchTips = vi.fn(async () => tips);
  const feeder = createTipsFeeder({
    eligible: () => eligible.value,
    blocked: () => blocked.value,
    fetchTips,
  });
  flushSync();
  return { eligible, blocked, fetchTips, feeder };
}

describe("createTipsFeeder", () => {
  it("context 切替では旧 deck を消し、emergency DTO に companion policy を付ける", async () => {
    vi.useFakeTimers();
    try {
      const context = createTestSignal<TipContext>("standby");
      let standbyResolve: ((tips: Array<{ id: string; text: string; hazards: [] }>) => void) | null = null;
      const fetchTips = vi.fn<(requested: TipContext) => Promise<DisplayTipDeckItem[]>>(
        (requested) => requested === "standby"
          ? new Promise<DisplayTipDeckItem[]>((resolve) => { standbyResolve = resolve; })
          : Promise.resolve([{ id: "emergency-1", text: "防災情報", hazards: ["eew"] }]),
      );
      const feeder = createTipsFeeder({ context: () => context.value, fetchTips });
      flushSync();
      context.value = "emergency";
      flushSync();
      standbyResolve!([{ id: "old", text: "旧文脈", hazards: [] }]);
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines[0]?.summary.text).toBe("防災情報");
      expect(feeder.lines[0]?.tipPolicy).toBe("emergency-companion");
      expect(feeder.lines[0]?.tickerCategory).toBe("防災情報");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("quakeMap context は専用 deck を idle-only で取得し、実電文中は供給を止める", async () => {
    vi.useFakeTimers();
    try {
      const context = createTestSignal<TipContext>("standby");
      const blocked = createTestSignal(false);
      const fetchTips = vi.fn(async (requested: TipContext) => [{
        id: `${requested}-1`,
        text: requested === "quakeMap" ? "地震への備え" : "待機中の豆知識",
        hazards: [] as const,
      }]);
      const feeder = createTipsFeeder({
        context: () => context.value,
        blocked: () => blocked.value,
        fetchTips,
      });
      flushSync();
      await vi.advanceTimersByTimeAsync(0);

      context.value = "quakeMap";
      blocked.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]);

      blocked.value = false;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchTips).toHaveBeenLastCalledWith("quakeMap", expect.any(AbortSignal));
      expect(feeder.lines[0]?.summary.text).toBe("地震への備え");
      expect(feeder.lines[0]?.title).toBe("地震の備え");
      expect(feeder.lines[0]?.tickerCategory).toBe("地震の備え");
      expect(feeder.lines[0]?.tipPolicy).toBe("idle-only");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("eligible になったら fetch して即 1 本流す", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, fetchTips, feeder } = setup();
      expect(feeder.lines).toEqual([]);
      expect(fetchTips).not.toHaveBeenCalled();

      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0); // fetch の microtask を流す

      expect(fetchTips).toHaveBeenCalledTimes(1);
      expect(feeder.lines.length).toBe(1);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識1");
      expect(feeder.lines[0]!.tickerCategory).toBe("豆知識");
      expect(feeder.lines[0]!.title).toBe("豆知識");
      expect(feeder.lines[0]!.tickerPriority).toBe("low");
      expect(feeder.lines[0]!.groupKey).toBe(null);
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("一致 key の完走でのみ次の tip へ差し替える (eventKey が変わる、間欠タイマーは無い)", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, feeder } = setup();
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      const firstKey = feeder.lines[0]!.eventKey;
      expect(feeder.lines[0]!.summary.text).toBe("豆知識1");

      feeder.notifyComplete(firstKey);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識2");
      expect(feeder.lines[0]!.eventKey).not.toBe(firstKey);

      feeder.notifyComplete(feeder.lines[0]!.eventKey);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識3");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("不一致 key の完走通知は無視する (電文 low の完走 / stale 通知で tip を飛ばさない)", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, feeder } = setup();
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      const key = feeder.lines[0]!.eventKey;
      expect(feeder.lines[0]!.summary.text).toBe("豆知識1");

      // 現在の tip と一致しない key (電文 job の完走や reset 前の遅延通知) では進まない
      feeder.notifyComplete("some-telegram-eventKey");
      expect(feeder.lines[0]!.eventKey).toBe(key);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識1");

      // 一致 key なら進む
      feeder.notifyComplete(key);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識2");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("eligible が false に戻ったら lines を空にする。false 中の notifyComplete は何もしない", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, fetchTips, feeder } = setup();
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines.length).toBe(1);
      const key = feeder.lines[0]!.eventKey;

      eligible.value = false;
      flushSync();
      expect(feeder.lines).toEqual([]);

      fetchTips.mockClear();
      feeder.notifyComplete(key); // 非 eligible 中は何もしない (fetch もしない、lines も空のまま)
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]);
      expect(fetchTips).not.toHaveBeenCalled();
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("デッキを使い切ったら notifyComplete が再 fetch し、完了時に emit する", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, fetchTips, feeder } = setup(["A", "B"]);
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines[0]!.summary.text).toBe("A");

      feeder.notifyComplete(feeder.lines[0]!.eventKey); // B (デッキ内に残っている、fetch なし)
      expect(feeder.lines[0]!.summary.text).toBe("B");
      expect(fetchTips).toHaveBeenCalledTimes(1);

      feeder.notifyComplete(feeder.lines[0]!.eventKey); // 枯渇 → 再 fetch
      expect(fetchTips).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(0); // fetch 完了 → 再シャッフルされたデッキから A
      expect(feeder.lines[0]!.summary.text).toBe("A");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy() 後に解決した in-flight fetch は lines/deck を書かない (Codex 指摘)", async () => {
    vi.useFakeTimers();
    try {
      const eligible = createTestSignal(false);
      let resolveFetch: ((tips: string[]) => void) | null = null;
      const fetchTips = vi.fn(() => new Promise<string[]>((resolve) => { resolveFetch = resolve; }));
      const feeder = createTipsFeeder({ eligible: () => eligible.value, fetchTips });
      flushSync();

      eligible.value = true;
      flushSync();
      expect(fetchTips).toHaveBeenCalledTimes(1);

      feeder.destroy(); // fetch はまだ未解決のまま破棄する
      resolveFetch!(TIPS);
      await vi.advanceTimersByTimeAsync(0);

      expect(feeder.lines).toEqual([]); // destroy 後に解決しても lines は書かれない

      // destroy 後の notifyComplete も同様に無視される (destroyed ガード)
      feeder.notifyComplete("tip-1");
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("destroy() 後に in-flight fetch が reject してもリトライタイマーを張らない (Codex 指摘)", async () => {
    vi.useFakeTimers();
    try {
      const eligible = createTestSignal(false);
      let rejectFetch: ((err: Error) => void) | null = null;
      const fetchTips = vi
        .fn<() => Promise<string[]>>()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFetch = reject; }));
      const feeder = createTipsFeeder({ eligible: () => eligible.value, fetchTips });
      flushSync();

      eligible.value = true;
      flushSync();
      expect(fetchTips).toHaveBeenCalledTimes(1);

      feeder.destroy(); // fetch はまだ未解決のまま破棄する
      rejectFetch!(new Error("boom"));
      await vi.advanceTimersByTimeAsync(0);

      expect(feeder.lines).toEqual([]); // destroy 後の reject では書かれない

      // リトライタイマーが張られていないことを、TIP_FETCH_RETRY_MS 経過後も fetch が再呼び出されないことで確認
      await vi.advanceTimersByTimeAsync(TIP_FETCH_RETRY_MS);
      expect(fetchTips).toHaveBeenCalledTimes(1);
      expect(feeder.lines).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocked=true 中は新規供給しないが、走行中の tip は消さない (供給と取消の分離)", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, blocked, fetchTips, feeder } = setup();
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines.length).toBe(1);
      const key = feeder.lines[0]!.eventKey;

      // 電文到着で blocked=true (待機モードは継続)。走行中 tip は残る (lines から消さない)
      blocked.value = true;
      flushSync();
      expect(feeder.lines.length).toBe(1);
      expect(feeder.lines[0]!.eventKey).toBe(key);

      // 走行中 tip が完走 → 供給不可なので次へ進まず帯を空にして止める
      fetchTips.mockClear();
      feeder.notifyComplete(key);
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]);
      expect(fetchTips).not.toHaveBeenCalled(); // 次の fetch もしない
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocked が解除されたら再び供給を再開する", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, blocked, feeder } = setup();
      // 電文走行中相当: eligible だが blocked → 供給されない
      eligible.value = true;
      blocked.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]); // blocked 中は供給されない

      // 電文が捌けて blocked 解除 → 供給再開
      blocked.value = false;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines.length).toBe(1);
      expect(feeder.lines[0]!.summary.text).toBe("豆知識1");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("eligible=false (緊急遷移) は blocked と無関係に帯を即 clear する", async () => {
    vi.useFakeTimers();
    try {
      const { eligible, blocked, feeder } = setup();
      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines.length).toBe(1);

      // 緊急遷移: eligible=false (待機モードを抜ける) → blocked の値に関わらず即 clear
      blocked.value = true;
      eligible.value = false;
      flushSync();
      expect(feeder.lines).toEqual([]);
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fetch 失敗時は例外を漏らさず、TIP_FETCH_RETRY_MS 後にリトライタイマーで再試行する", async () => {
    vi.useFakeTimers();
    try {
      const eligible = createTestSignal(false);
      const fetchTips = vi
        .fn<() => Promise<string[]>>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(TIPS);
      const feeder = createTipsFeeder({ eligible: () => eligible.value, fetchTips });
      flushSync();

      eligible.value = true;
      flushSync();
      await vi.advanceTimersByTimeAsync(0);
      expect(feeder.lines).toEqual([]); // 失敗 → 帯は空白のまま

      // リトライ間隔より前は再試行しない
      await vi.advanceTimersByTimeAsync(TIP_FETCH_RETRY_MS - 1);
      expect(fetchTips).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0); // 再試行 fetch の microtask
      expect(fetchTips).toHaveBeenCalledTimes(2);
      expect(feeder.lines.length).toBe(1);
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("emergency fetch の timeout abort は TIP_FETCH_RETRY_MS 後に再試行して回復する", async () => {
    vi.useFakeTimers();
    try {
      let attempt = 0;
      const fetchTips = vi.fn((_context: TipContext, signal: AbortSignal) => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<Array<{ id: string; text: string; hazards: ["eew"] }>>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("timed out", "AbortError")), { once: true });
          });
        }
        return Promise.resolve([{ id: "recovered", text: "回復後の防災情報", hazards: ["eew"] as ["eew"] }]);
      });
      const feeder = createTipsFeeder({ context: () => "emergency", fetchTips });
      flushSync();
      expect(fetchTips).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(TIP_FETCH_TIMEOUT_MS);
      expect(feeder.lines).toEqual([]);
      await vi.advanceTimersByTimeAsync(TIP_FETCH_RETRY_MS - 1);
      expect(fetchTips).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchTips).toHaveBeenCalledTimes(2);
      expect(feeder.lines[0]?.summary.text).toBe("回復後の防災情報");
      expect(feeder.lines[0]?.tipPolicy).toBe("emergency-companion");
      feeder.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
