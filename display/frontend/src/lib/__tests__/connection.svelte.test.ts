import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDisplayConnection } from "../connection.svelte";
import { baseSnapshot, tickerEvent } from "./fixtures";

/** EventSource のテストダブル。browser 実装同様 addEventListener/close のみ持てば足りる */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: MessageEvent) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  close(): void {
    this.closed = true;
  }

  /** サーバから type イベントで data が飛んできたことをシミュレートする */
  emit(type: string, data: unknown): void {
    const msg = { data: JSON.stringify(data) } as MessageEvent<string>;
    for (const cb of this.listeners[type] ?? []) cb(msg);
  }

  emitRaw(type: string, data: string): void {
    const msg = { data } as MessageEvent<string>;
    for (const cb of this.listeners[type] ?? []) cb(msg);
  }
}

describe("createDisplayConnection: seq gap 検知での再同期 (2026-07-10, レビュー M1)", () => {
  let original: typeof EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
    original = globalThis.EventSource;
    // @ts-expect-error テストダブルに差し替える (実 EventSource のフル API は要らない)
    globalThis.EventSource = FakeEventSource;
  });

  afterEach(() => {
    globalThis.EventSource = original;
  });

  it("壊れた SSE payload は例外を外へ出さず、接続を張り直して再同期する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;

    expect(() => first.emitRaw("snapshot", "{")).not.toThrow();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it("type または seq の最低限の shape を満たさない SSE payload は再同期する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;

    first.emit("snapshot", { type: "unknown", snapshot: baseSnapshot({ seq: 1 }) });
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);

    const second = FakeEventSource.instances[1]!;
    second.emit("event", { type: "event", event: { seq: "2" } });
    expect(second.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(3);
  });

  it("reconcile SSE を listener から受け、source を除去して canonical state へ一回で反映する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    const source = tickerEvent({ id: "source", eventKey: "source:key", seq: 1 });
    const keep = tickerEvent({ id: "keep", eventKey: "keep:key", seq: 1 });
    const canonical = tickerEvent({
      id: "canonical",
      eventKey: "canonical:key",
      seq: 2,
      type: "VPBS50",
      domain: "legacyCounterpart",
    });

    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, recentTicker: [source, keep] }) });
    expect(first.listeners.reconcile).toHaveLength(1);
    first.emit("reconcile", { type: "reconcile", event: canonical, sourceEventKeys: ["source:key"] });

    expect(conn.state.ticker.map((event) => event.eventKey)).toEqual(["canonical:key", "keep:key"]);
    expect(conn.state.reconcile).toMatchObject({ type: "reconcile", event: { eventKey: "canonical:key" } });
    expect(conn.state.lastEventSeq).toBe(2);
    expect(conn.state.seqGapDetected).toBe(false);
  });

  it("reconcile 直後の再接続 snapshot は同じ canonical ticker 構成へ収束する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    const source = tickerEvent({ id: "source", eventKey: "source:key", seq: 1 });
    const keep = tickerEvent({ id: "keep", eventKey: "keep:key", seq: 1 });
    const canonical = tickerEvent({
      id: "canonical",
      eventKey: "canonical:key",
      seq: 2,
      type: "VPBS50",
      domain: "legacyCounterpart",
    });

    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, recentTicker: [source, keep] }) });
    first.emit("reconcile", { type: "reconcile", event: canonical, sourceEventKeys: ["source:key"] });
    const reconciledKeys = conn.state.ticker.map((event) => event.eventKey);

    // missed event を表す state.seq で既存の gap recovery を起動し、直後の接続 snapshot に収束させる。
    first.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 3 }) });
    expect(first.closed).toBe(true);
    const second = FakeEventSource.instances[1]!;
    second.emit("snapshot", {
      type: "snapshot",
      snapshot: baseSnapshot({ seq: 3, recentTicker: [canonical, keep] }),
    });

    expect(conn.state.seqGapDetected).toBe(false);
    expect(conn.state.ticker.map((event) => event.eventKey)).toEqual(reconciledKeys);
  });

  it("blocked 中に event が欠落 → drain 後の定期 state で gap を検知 → 接続を張り直して "
    + "新しい snapshot から ticker が回復する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    expect(FakeEventSource.instances.length).toBe(1);
    const first = FakeEventSource.instances[0]!;

    // 初回 snapshot (seq=1)
    first.emit("snapshot", {
      type: "snapshot",
      snapshot: baseSnapshot({ seq: 1, recentTicker: [tickerEvent({ id: "e1", seq: 1 })] }),
    });
    expect(conn.state.ticker.map((e) => e.id)).toEqual(["e1"]);
    expect(conn.state.seqGapDetected).toBe(false);

    // event seq=2,3 は backpressure で blocked のままサーバ側 (SseClients.writeToClient) が
    // 書き込みをスキップし、クライアントには一切届かない (= emit しない)。
    // drain 後、次の定期 state (hub の seq カウンタは進んでいるので seq=4) が届く
    first.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 4 }) });
    expect(conn.state.seqGapDetected).toBe(true);

    // gap 検知で resync() が発火し、旧接続が close されて新しい EventSource が張られている
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    const second = FakeEventSource.instances[1]!;
    expect(second).not.toBe(first);

    // 新接続の初回 snapshot で ticker が全再構築される (欠落していた e2/e3 込みの最新状態)
    second.emit("snapshot", {
      type: "snapshot",
      snapshot: baseSnapshot({
        seq: 4,
        recentTicker: [tickerEvent({ id: "e4", seq: 4 }), tickerEvent({ id: "e2", seq: 2 })],
      }),
    });
    expect(conn.state.seqGapDetected).toBe(false);
    expect(conn.state.ticker.map((e) => e.id)).toEqual(["e4", "e2"]);
  });

  it("【レビュー再指摘の off-by-one 回帰、統合ケース】event が 1 件だけ欠落し、直後に同じ次番の "
    + "state が届いても gap を検知して再接続する", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;

    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });
    // event seq=2 だけが backpressure でスキップされ (emit しない)、直後の定期 state が
    // 同じ次番 (seq=2) で届く。旧実装 (lastSeq を +1 閾値で比較) はこの 1 件欠落を見逃していた
    first.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 2 }) });

    expect(conn.state.seqGapDetected).toBe(true);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
  });

  it("gap が無ければ再接続しない (通常の event/state 受信では EventSource は張り直されない)", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;

    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });
    first.emit("event", { type: "event", event: tickerEvent({ id: "e2", seq: 2 }) });
    // event を欠落なく受信できていれば、定期 state の seq は最後に受信した event の seq 以下になる
    // (hub は event を先に broadcast してから state を配信するため)
    first.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 2 }) });

    expect(conn.state.seqGapDetected).toBe(false);
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(1);
  });
});

describe("createDisplayConnection: frontendBuildId 自動リロード", () => {
  let original: typeof EventSource;
  const RELOAD_SUPPRESS_MS = 60_000; // connection.svelte.ts と同値
  const RELOAD_GUARD_KEY = "fleq-display-reload"; // connection.svelte.ts と同値

  beforeEach(() => {
    FakeEventSource.instances = [];
    original = globalThis.EventSource;
    // @ts-expect-error テストダブルに差し替える
    globalThis.EventSource = FakeEventSource;
    sessionStorage.clear();
    // now() と setTimeout を同じ fake clock に載せる (満了後リトライタイマーの検証のため)
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = original;
    sessionStorage.clear();
  });

  function connect(reload: () => void): FakeEventSource {
    const conn = createDisplayConnection("/events", Date.now, reload);
    conn.start();
    return FakeEventSource.instances[0]!;
  }

  it("最初に観測した buildId は基準として保持するだけで reload しない", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    expect(reload).not.toHaveBeenCalled();
  });

  it("基準と異なる buildId を受信したら reload する", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    // 無停止 display:build 反映を模す定期 state (seq は連番で gap を作らない)
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("同一 buildId を受信し続けても reload しない", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("event", { type: "event", event: tickerEvent({ id: "e2", seq: 2 }) });
    expect(reload).not.toHaveBeenCalled();
  });

  it("buildId 欠落 (旧サーバ・null) では何もしない", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) }); // frontendBuildId なし
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1 }) });
    expect(reload).not.toHaveBeenCalled();
  });

  it("buildId がフラッピング (A→B→A→B) しても reload は 1 回に抑えられる (レビュー high)", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "a" }) }); // baseline=a
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b" }) }); // 差異 → reload
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "a" }) }); // baseline 一致 → 無視
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b" }) }); // クールダウン中 → 抑止
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "a" }) }); // baseline 一致 → 無視
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("クールダウンで抑止しても、満了後に最新観測 buildId が baseline とまだ異なれば reload を再試行する (レビュー high: 最終版への未追従を防ぐ)", () => {
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) }); // reload(1), クールダウン開始
    expect(reload).toHaveBeenCalledTimes(1);

    // クールダウン中に同 buildId が再送される (spy なので baseline は b1 のまま = 未反映)。抑止 + リトライ予約
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS / 2);
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });
    expect(reload).toHaveBeenCalledTimes(1);

    // 以降サーバは b2 で安定 (新規メッセージ無し)。満了後リトライタイマーが baseline と再比較して reload
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("sessionStorage が例外を投げてもメモリクールダウンでフラッピングの reload を 1 回に抑える (レビュー high)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("sessionStorage unavailable");
    });
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("sessionStorage unavailable");
    });
    try {
      const reload = vi.fn();
      const es = connect(reload);
      es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "a" }) });
      es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b" }) }); // reload(1)
      es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "a" }) });
      es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b" }) }); // メモリで抑止
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      setItem.mockRestore();
      getItem.mockRestore();
    }
  });

  it("stop() で満了後リトライタイマーが解除され、以降 reload の再試行が起きない", () => {
    const reload = vi.fn();
    const conn = createDisplayConnection("/events", Date.now, reload);
    conn.start();
    const es = FakeEventSource.instances[0]!;
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) }); // reload(1)
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS / 2);
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) }); // 抑止 + リトライ予約
    conn.stop();
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS * 3);
    expect(reload).toHaveBeenCalledTimes(1); // リトライタイマーが解除され再試行しない
  });

  it("ページロード直後 (メモリ側の記録なし) に sessionStorage のクールダウンで抑止した場合、リトライは"
    + "残り時間で 1 度だけ張る (1ms 間隔の短周期ループにしない)", () => {
    // 前のページ寿命で b2 への reload を記録済み。この寿命では lastReloadAtMs は null のまま
    sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ buildId: "b2", ts: 0 }));
    const reload = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });

    vi.advanceTimersByTime(10_000);
    setTimeoutSpy.mockClear();
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });

    // sessionStorage 側のクールダウンが効くので reload は抑止される
    expect(reload).not.toHaveBeenCalled();
    // 張られるタイマーは 1 本、遅延は「クールダウン満了までの残り」でなければならない
    expect(setTimeoutSpy.mock.calls.map((c) => c[1])).toEqual([RELOAD_SUPPRESS_MS - 10_000 + 1]);

    // 満了まで進めても短周期リトライが積み上がらず、満了後に 1 回だけ reload される
    setTimeoutSpy.mockClear();
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("sessionStorage の ts が非有限値なら記録を無視して reload する (壊れた記録で抑止し続けない)", () => {
    // JSON の 1e999 は parse すると Infinity になる
    sessionStorage.setItem(RELOAD_GUARD_KEY, '{"buildId":"b2","ts":1e999}');
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("sessionStorage の ts が未来すぎる (時計の巻き戻り等) 場合も記録を無視し、抑止が居座らない", () => {
    sessionStorage.setItem(
      RELOAD_GUARD_KEY,
      JSON.stringify({ buildId: "b2", ts: RELOAD_SUPPRESS_MS * 100 }),
    );
    const reload = vi.fn();
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });
    expect(reload).toHaveBeenCalledTimes(1);
    // 記録は現在時刻で貼り直され、以降のクールダウンは通常どおり効く
    vi.advanceTimersByTime(RELOAD_SUPPRESS_MS / 2);
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("リトライの遅延はクールダウン長を超えない (メモリ側の記録が未来でもクランプされる)", () => {
    const reload = vi.fn();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const es = connect(reload);
    es.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b1" }) });
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) }); // reload(1)

    setTimeoutSpy.mockClear();
    es.emit("state", { type: "state", snapshot: baseSnapshot({ seq: 1, frontendBuildId: "b2" }) }); // 抑止 + 予約
    for (const call of setTimeoutSpy.mock.calls) {
      expect(call[1]).toBeGreaterThan(0);
      expect(call[1]).toBeLessThanOrEqual(RELOAD_SUPPRESS_MS + 1);
    }
  });
});

describe("createDisplayConnection: liveness watchdog (ゾンビ SSE 対策、2026-07-11 実機確定根因)", () => {
  let original: typeof EventSource;
  const PING_MS = 15_000;
  const SILENCE_MS = PING_MS * 3; // WATCHDOG_SILENCE_MS と同値

  beforeEach(() => {
    FakeEventSource.instances = [];
    original = globalThis.EventSource;
    // @ts-expect-error テストダブルに差し替える
    globalThis.EventSource = FakeEventSource;
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.EventSource = original;
  });

  it("最終受信から無音が SILENCE_MS に達した点検 tick で EventSource を張り直して再同期する (レビュー F1)", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });

    // SILENCE_MS 未満 (最後の PING_MS 手前) の無音では再接続しない
    vi.advanceTimersByTime(SILENCE_MS - PING_MS);
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(1);

    // diff が SILENCE_MS ちょうどに達する点検 tick (60 秒ではなく 45 秒) で watchdog が発火する
    vi.advanceTimersByTime(PING_MS);
    expect(first.closed).toBe(true);
    expect(FakeEventSource.instances.length).toBe(2);
    expect(FakeEventSource.instances[1]).not.toBe(first);
  });

  it("keepalive ping を受信し続けている限り watchdog は再接続しない (無音でないため)", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });

    // ping 周期ごとにサーバから ping が届く状況を再現する (電文自体は来ない無音期間)
    for (let elapsed = 0; elapsed < SILENCE_MS * 3; elapsed += PING_MS) {
      vi.advanceTimersByTime(PING_MS);
      first.emit("ping", 1);
    }
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("通常の event 受信でも最終受信時刻が更新され watchdog は再接続しない", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });

    // seq は連番にする (飛ばすと seqGap 再同期が誘発され watchdog の検証にならない)
    let seq = 1;
    for (let elapsed = 0; elapsed < SILENCE_MS * 2; elapsed += PING_MS) {
      vi.advanceTimersByTime(PING_MS);
      seq += 1;
      first.emit("event", { type: "event", event: tickerEvent({ id: `e${seq}`, seq }) });
    }
    expect(first.closed).toBe(false);
    expect(FakeEventSource.instances.length).toBe(1);
  });

  it("stop() で watchdog タイマーが解除され、以降の時間経過で再接続が起きない", () => {
    const conn = createDisplayConnection("/events");
    conn.start();
    const first = FakeEventSource.instances[0]!;
    first.emit("snapshot", { type: "snapshot", snapshot: baseSnapshot({ seq: 1 }) });
    conn.stop();
    expect(first.closed).toBe(true);

    vi.advanceTimersByTime(SILENCE_MS * 3);
    // stop 後に張られた新規接続は無い (watchdog は解除済み)
    expect(FakeEventSource.instances.length).toBe(1);
  });
});
