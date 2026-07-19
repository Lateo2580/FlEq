import { initialState, reduce, setSseConnected, type DisplayClientState } from "./store";
import type { DisplayServerMessage } from "./protocol";

// サーバの keepalive ping 周期 (src/engine/display/constants.ts HEARTBEAT_MS と同値、手動複製)。
// ping は sse-clients.ts が名前付き "ping" イベントで送る (SSE コメントは EventSource から観測できない)。
const SERVER_PING_MS = 15_000;
// この時間 (ping 周期の 3 倍) 何も受信しなければゾンビ SSE (TCP は ESTAB のまま更新が届かない状態)
// とみなし、EventSource を明示 close して再接続 + 再同期する。seq gap 検知は「メッセージ自体が
// 届かない停止」には無力なため、無音そのものを監視する別系統の安全弁 (2026-07-11 実機確定根因)。
const WATCHDOG_SILENCE_MS = SERVER_PING_MS * 3;
// 無音の点検周期。閾値より短くして検知遅延を抑える (最悪 WATCHDOG_SILENCE_MS + この周期で発火)。
const WATCHDOG_CHECK_MS = SERVER_PING_MS;
// 自動リロードのループ抑止窓。同一 buildId への reload を直近この時間内は繰り返さない
// (reload しても資産が新版に載らない異常や、サーバの buildId フラッピングで無限リロードに陥るのを防ぐ)。
const RELOAD_SUPPRESS_MS = 60_000;
const RELOAD_GUARD_KEY = "fleq-display-reload";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null;
}

function hasValidSeq(value: unknown): boolean {
  return isRecord(value) && typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0;
}

/** SSE payload の最小限の境界検証。詳細な DTO の整合性は reducer 以下の既存契約に委ねる。 */
function isDisplayServerMessage(value: unknown): value is DisplayServerMessage {
  if (!isRecord(value)) return false;
  if (value.type === "event") return hasValidSeq(value.event);
  if (value.type === "snapshot" || value.type === "state") return hasValidSeq(value.snapshot);
  return false;
}

/** ページ URL の ?token= を SSE 接続 URL へ引き継ぐ (非 loopback アクセスのトークン認証)。
 *  トークンなしでページが開けている (loopback アクセス) 場合は URL を変えない */
export function withPageToken(url: string): string {
  const token = new URLSearchParams(location.search).get("token");
  if (token == null || token === "") return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
}

export function createDisplayConnection(
  url = "/events",
  /** テスト注入用。省略時 Date.now (watchdog の無音判定・reload ループ抑止の時刻に使う) */
  now: () => number = Date.now,
  /** テスト注入用。省略時 location.reload (jsdom では未実装のためテストで差し替える) */
  reload: () => void = () => location.reload(),
): {
  readonly state: DisplayClientState;
  start(): void;
  stop(): void;
} {
  let state = $state(initialState());
  let source: EventSource | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  /** 最後に「サーバから何らかのバイトを受信した」時刻。ping/snapshot/event/state いずれでも更新する */
  let lastReceivedMs = now();
  /** このページロードで最初に観測した frontendBuildId (基準値)。以後これと異なる値を受信したら
   *  フロント資産が新版に差し替わったとみなして reload する。null のまま (buildId 欠落サーバ) なら何もしない */
  let baselineBuildId: string | null = null;
  /** 直近に観測した frontendBuildId (満了後リトライで baseline と再比較する対象)。 */
  let latestObservedBuildId: string | null = null;
  /** sessionStorage 非依存のメモリ内クールダウン (private mode 等で sessionStorage が使えなくても
   *  同一ページ寿命内の reload 暴走を防ぐ)。最後に reload を発火した buildId とその時刻。 */
  let lastReloadBuildId: string | null = null;
  let lastReloadAtMs: number | null = null;
  /** クールダウンで抑止した reload を放置せず、満了後に baseline と再比較して必要なら再試行する
   *  タイマー (1 本のみ)。stop() で解除する。 */
  let reloadRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function markReceived(): void {
    lastReceivedMs = now();
  }

  function handleMessage(e: MessageEvent<string>): void {
    markReceived();
    try {
      const msg: unknown = JSON.parse(e.data);
      if (!isDisplayServerMessage(msg)) {
        resync();
        return;
      }
      state = reduce(state, msg);
      // フロント資産の版が上がっていれば自動リロード (snapshot/state のみ frontendBuildId を運ぶ。
      // event は snapshot を触らないので値は据え置かれ、誤発火しない)
      maybeReloadForBuild(state.snapshot?.frontendBuildId ?? null);
      // seq gap 検知 (backpressure 等で event が黙ってスキップされ、定期 state の recentTicker
      // 廃止で自然回復しなくなったケース) は接続を張り直して初回 snapshot 再取得に乗せる
      if (state.seqGapDetected) resync();
    } catch {
      // 壊れた payload は EventSource を張り直し、初回 snapshot の再取得へ戻す。
      resync();
    }
  }

  /** frontendBuildId を基準値と比較し、変化していたらフロントを reload する。
   *  - 欠落 (null): 旧サーバ・dist 未解決。何もしない
   *  - 初観測: 基準値として保持するだけ (reload しない)
   *  - 基準と一致: 何もしない
   *  - 基準と相違: フロント資産が新版に差し替わった → reload (クールダウン + 満了後リトライ付き)
   *  reload 後は新しい JS がロードされ baselineBuildId が新版の値で貼り直されるので通常ループしない。
   *  クールダウンは「reload しても値が変わらない異常」「buildId フラッピング」の保険。サーバ側でも
   *  buildId は連続 2 sweep 同一を確認してから配信するため、フラッピングは源で概ね潰れている。 */
  function maybeReloadForBuild(id: string | null): void {
    if (id == null) return;
    latestObservedBuildId = id;
    if (baselineBuildId == null) {
      baselineBuildId = id;
      return;
    }
    if (id === baselineBuildId) return;
    attemptReload(id);
  }

  /** クールダウン中でなければ reload、クールダウン中なら満了後リトライを予約する。 */
  function attemptReload(id: string): void {
    if (withinCooldown(id)) {
      scheduleReloadRetry();
      return;
    }
    lastReloadBuildId = id;
    lastReloadAtMs = now();
    recordReloadFor(id);
    reload();
  }

  /** 同一 buildId への reload が直近 RELOAD_SUPPRESS_MS 以内なら true。メモリ (sessionStorage 非依存)
   *  と sessionStorage (ページ再ロードをまたいだ抑止) の両方を見る。 */
  function withinCooldown(id: string): boolean {
    if (lastReloadBuildId === id && lastReloadAtMs != null && now() - lastReloadAtMs < RELOAD_SUPPRESS_MS) {
      return true;
    }
    try {
      const raw = sessionStorage.getItem(RELOAD_GUARD_KEY);
      if (raw == null) return false;
      const prev = JSON.parse(raw) as { buildId?: string; ts?: number };
      return prev.buildId === id && typeof prev.ts === "number" && now() - prev.ts < RELOAD_SUPPRESS_MS;
    } catch {
      return false; // sessionStorage 不可 (private mode 等) はメモリ側だけで抑止
    }
  }

  function recordReloadFor(id: string): void {
    try {
      sessionStorage.setItem(RELOAD_GUARD_KEY, JSON.stringify({ buildId: id, ts: now() }));
    } catch {
      // sessionStorage 不可でも reload 自体は行う (メモリクールダウンで抑止は効く)
    }
  }

  /** クールダウンで抑止した reload を満了後に再評価する。満了時点で最新観測 buildId が baseline と
   *  まだ異なれば reload を再試行する (サーバが新版で安定したのに画面が旧版のまま残るのを防ぐ)。 */
  function scheduleReloadRetry(): void {
    if (reloadRetryTimer != null) return;
    const elapsed = lastReloadAtMs == null ? RELOAD_SUPPRESS_MS : now() - lastReloadAtMs;
    const delay = Math.max(0, RELOAD_SUPPRESS_MS - elapsed) + 1; // クールダウン境界を確実に越える
    reloadRetryTimer = setTimeout(() => {
      reloadRetryTimer = null;
      if (baselineBuildId != null && latestObservedBuildId != null && latestObservedBuildId !== baselineBuildId) {
        attemptReload(latestObservedBuildId);
      }
    }, delay);
  }

  /** keepalive ping。reduce は通さず (JSON body は捨て値)、最終受信時刻だけ更新する。
   *  無音期間 (電文が来ない間) に watchdog が誤って再接続しないための「生存の証」。 */
  function handlePing(): void {
    markReceived();
  }

  /** 接続を張り直して sendInitialSnapshot (フル recentTicker) を再取得させる。
   *  EventSource の自動再接続と同じ経路 (onopen → snapshot 受信) を手動で起こすだけなので、
   *  再接続後の ticker 復元ロジックを別に持つ必要はない */
  function resync(): void {
    source?.close();
    source = null;
    start();
  }

  /** 無音監視。最終受信から WATCHDOG_SILENCE_MS 以上何も届いていなければゾンビ SSE とみなし
   *  再接続する。watchdog は接続ライフサイクルとは独立に 1 本だけ張り、stop() まで走り続ける
   *  (resync で EventSource を張り替えても止めない)。判定は `>=` にする: 点検周期は WATCHDOG_SILENCE_MS
   *  の約数 (3 分の 1) なので、`>` だと閾値ちょうどの点検 tick を素通りし発火が 1 周期 (最大 15 秒)
   *  遅れる (レビュー F1)。`>=` で閾値時点の tick で発火させる。 */
  function startWatchdog(): void {
    if (watchdogTimer != null) return;
    watchdogTimer = setInterval(() => {
      if (source == null) return;
      if (now() - lastReceivedMs >= WATCHDOG_SILENCE_MS) resync();
    }, WATCHDOG_CHECK_MS);
  }

  function start(): void {
    if (source != null) return;
    // (再)接続の起点では最終受信時刻をリセットする。直前まで無音だった値のまま watchdog に
    // 判定させると、張り直した直後の接続を即座にゾンビと誤認してしまう。
    markReceived();
    const es = new EventSource(withPageToken(url));
    es.addEventListener("snapshot", handleMessage);
    es.addEventListener("event", handleMessage);
    es.addEventListener("state", handleMessage);
    es.addEventListener("ping", handlePing);
    es.onopen = () => {
      markReceived();
      state = setSseConnected(state, true);
    };
    // EventSource が自動再接続する。再接続成功時は onopen が再度発火し、
    // サーバが snapshot を送り直すので取りこぼし分の補完は不要。
    es.onerror = () => {
      state = setSseConnected(state, false);
    };
    source = es;
    startWatchdog();
  }

  function stop(): void {
    source?.close();
    source = null;
    if (watchdogTimer != null) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    if (reloadRetryTimer != null) {
      clearTimeout(reloadRetryTimer);
      reloadRetryTimer = null;
    }
  }

  return {
    get state() {
      return state;
    },
    start,
    stop,
  };
}
