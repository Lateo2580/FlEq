// テロップ待機中 Tips の走行完了駆動フィーダ (spec: 設計メモ 2026-07-12-ticker-tips-design.md §4,
// 2026-07-13 フィラー化: tips を電文 low と合成 catalog に混ぜ、Ticker の job 完走通知
// (onJobComplete → notifyComplete) で次の 1 本へ差し替える連続供給)。「待機モード」の間だけ、
// サーバ (GET /tips) から取得した知識系 Tips を 1 本ずつ合成 DTO として供給する。lines は常に 0 or 1
// 要素で、差し替えごとに eventKey が変わるため Ticker.svelte の新着 enqueue 経路に乗る。合成 catalog では
// tips は low job として ticker-schedule の巡回補充・ラウンドロビンに乗り、電文 (high/mid) が優先される。
//
// flushSync() は「effect 実行の外 (setTimeout / Promise の then/catch/finally)」からの呼び出しにのみ使う。
// eligible 遷移 $effect から呼ばれる attemptSupply() は「進行中のフラッシュの内側」なので、その場で
// flushSync() を呼ぶと「進行中のフラッシュへの再入」になり得る (page-cycler.svelte.ts が実際に踏んだ
// 無限再帰と同型の危険、コンストラクタ内 flushSync を撤去した経緯を参照)。effect 駆動の同期パスでは
// $state 書き込みのみ行い、Svelte 自身の同一フラッシュ内解決に任せる。notifyComplete() は Ticker の
// DOM イベントハンドラ (onScrollEnd 経路) 内から呼ばれ effect フラッシュの外なので、その先の fetch
// .finally() の flushSync() は安全。
// $effect.root を自前で張る factory 構造は page-cycler.svelte.ts を踏襲 (コンストラクタ内 flushSync は
// リアクティブマウント時の無限再帰を踏むため置かない。page-cycler.svelte.ts 末尾コメント参照)。
import { flushSync, untrack } from "svelte";
import { DISPLAY_PROTOCOL_VERSION } from "./protocol";
import type { DisplayTickerDtoV1 } from "./ticker-schedule";

export const TIP_FETCH_RETRY_MS = 30_000; // fetch 失敗時のみのリトライ間隔 (帯は空白のまま = 現状と同じで悪化しない)
// Tips (フィラー) の eventKey/id はこの prefix で始まる (key 生成専用)。フィラー判定自体は
// DTO の kind==="tip" に一本化した (key prefix 判定は廃止、2026-07-14 フィラー排他化 v2)。
export const TIP_EVENT_KEY_PREFIX = "tip-";

export interface TipsFeeder {
  /** Ticker へ渡す合成 DTO (kind="tip")。常に 0 or 1 要素 */
  readonly lines: DisplayTickerDtoV1[];
  /**
   * Ticker の job 完走通知 (onJobComplete) から呼ぶ。完走した job の eventKey が現在の tip と
   * 一致するときだけ次の 1 本へ差し替える。不一致 (電文 low の完走 / snapshot reset 前の stale
   * 通知) は無視する。
   */
  notifyComplete(eventKey: string): void;
  destroy(): void;
}

async function defaultFetchTips(): Promise<string[]> {
  const res = await fetch("/tips");
  if (!res.ok) throw new Error(`GET /tips -> ${res.status}`);
  const body = (await res.json()) as { tips?: unknown };
  if (!Array.isArray(body.tips)) return [];
  return body.tips.filter((t): t is string => typeof t === "string" && t.length > 0);
}

function tipToDto(text: string, n: number): DisplayTickerDtoV1 {
  return {
    version: DISPLAY_PROTOCOL_VERSION,
    seq: 0, // hub 採番なし → Ticker 側の fallbackSeq (toTickerJob 第2引数) が使われる
    kind: "tip", // フィラー判定の真実源 (Ticker/スケジューラはこの kind で排他・purge する)
    id: `${TIP_EVENT_KEY_PREFIX}${n}`,
    eventKey: `${TIP_EVENT_KEY_PREFIX}${n}`,
    groupKey: null, // 続報管理・畳み込み対象外
    domain: "system",
    type: "tip",
    infoType: "発表",
    reportDateTime: new Date().toISOString(),
    title: "豆知識",
    headline: null,
    publishingOffice: "FlEq",
    isTest: false,
    frameLevel: "info",
    isCancellation: false,
    summary: { text, role: "info" }, // info = ticker-chip.ts の中立 (neutral) 経路
    emergency: null,
    recentQuake: null,
    latestQuake: null,
    tickerDetail: null,
    tickerCategory: "豆知識",
    tickerSentence: text,
    tickerPriority: "low",
  };
}

export function createTipsFeeder(opts: {
  // eligible: 待機モードか (ハード信号)。false = 緊急遷移等 → 帯を即 clear する。
  eligible: () => boolean;
  // blocked: 電文が走行/待機中か (ソフト信号、2026-07-14 フィラー排他化 v2)。true の間は新規 Tips を
  //   供給しないが、**走行中の Tips は消さない** (lines から消すと Ticker の props purge で即時空白化
  //   するため。走行中 tip は完走させ、その完了通知 notifyComplete で帯を空にする)。省略時は常に false。
  blocked?: () => boolean;
  fetchTips?: () => Promise<string[]>; // テスト・preview 用の注入口。省略時は GET /tips
}): TipsFeeder {
  const fetchTips = opts.fetchTips ?? defaultFetchTips;
  const isBlocked = opts.blocked ?? ((): boolean => false);
  // 供給可能 = 待機モード (eligible) かつ 電文なし (!blocked)。fetch/emit 経路はこれで判定する。
  const canSupply = (): boolean => !destroyed && opts.eligible() && !isBlocked();
  let lines = $state<DisplayTickerDtoV1[]>([]);
  let deck: string[] = [];
  let counter = 0;
  let fetching = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false; // destroy() 後に解決した in-flight fetch が lines/deck を書くのを防ぐ (Codex 指摘)

  function emitFromDeck(): void {
    const text = deck.shift();
    if (text == null) return;
    counter += 1;
    lines = [tipToDto(text, counter)];
  }

  function clearRetryTimer(): void {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry(): void {
    clearRetryTimer();
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!canSupply()) return; // 供給不可 (非待機/電文中/破棄) に遅れて起床しても孤立 fetch を作らない
      fetchAndMaybeEmit();
    }, TIP_FETCH_RETRY_MS);
  }

  // デッキ枯渇時の再取得。成功時はまだ eligible なら即 1 本 emit、失敗時のみリトライタイマーを張る。
  // then/catch/finally はいずれも呼び出し元の effect 実行の外 (microtask) で走るので flushSync してよい
  function fetchAndMaybeEmit(): void {
    if (fetching) return;
    fetching = true;
    fetchTips()
      .then((tips) => {
        if (destroyed) return; // destroy() 後に解決したフェッチは無視する
        deck = [...tips]; // 呼び出し元の配列を shift() で破壊しないようコピーする (fetchTips の再利用/共有参照対策)
        if (canSupply() && deck.length > 0) emitFromDeck();
      })
      .catch(() => {
        // 取得失敗は握りつぶす。リトライタイマーで再試行 (帯は空白のまま = 機能追加前と同じ)。
        // destroy() 後 / 供給不可中の reject では新規タイマーを張らない (Codex 指摘)
        if (canSupply()) scheduleRetry();
      })
      .finally(() => {
        fetching = false;
        flushSync();
      });
  }

  // eligible 遷移 ($effect) と job 完走通知 (notifyComplete) の共通供給ロジック。デッキがあれば即 emit、
  // 無ければ fetch (完了時に再確認)。effect 実行の内側から呼ばれ得るため flushSync は呼ばない
  // (Svelte 自身の同一フラッシュ内解決に任せる。上部コメント参照)
  function attemptSupply(): void {
    if (!canSupply()) return;
    if (deck.length > 0) {
      emitFromDeck();
      return;
    }
    fetchAndMaybeEmit();
  }

  // 完走した job の eventKey が現在の tip と一致するときだけ処理する。不一致は無視 (電文 low の完走や
  // snapshot reset を跨いだ遅延通知で tip を飛ばさない)。lines は $state だが effect 外 (DOM イベント
  // ハンドラ) からの読みなので購読は作られない。
  // 一致完走時: 供給可能なら次の tip へ進める。供給不可 (電文が走行/待機中になった等) なら、走行させて
  // いた tip がちょうど完走したので帯を空にして止める (供給と取消の分離: 走行中は消さず、完走で止める)。
  function notifyComplete(eventKey: string): void {
    if (destroyed) return;
    const currentKey = lines[0]?.eventKey;
    if (currentKey == null || eventKey !== currentKey) return;
    if (canSupply()) {
      attemptSupply();
    } else {
      lines = [];
      clearRetryTimer();
    }
  }

  const destroyRoot = $effect.root(() => {
    $effect(() => {
      // eligible (ハード) と blocked (ソフト) の両方に反応する。値そのものの変化 (=遷移) で再走。
      const eligible = opts.eligible();
      const blocked = isBlocked();
      // lines/deck の読み書きをこの effect の依存に含めない (untrack)。
      untrack(() => {
        if (!eligible) {
          // 待機モードでない (緊急遷移等) → 帯を即 clear。Ticker 側は App の displayTickerLines 除外 +
          // kind ベース purge で走行中 tip を即座に落とす。ここは feeder 内部状態を揃え stale 再表示を防ぐ
          lines = [];
          clearRetryTimer();
          return;
        }
        if (blocked) {
          // 待機中だが電文が走行/待機中 → 新規供給は止めるが、走行中の tip は **消さない**
          // (lines から外すと Ticker の props purge で即時空白化する)。完走は notifyComplete が止める
          clearRetryTimer();
          return;
        }
        // 供給可能: eligible 遷移起点の初回 emit は lines が空のときだけ (notifyComplete 起点と重なったら
        // 完走側が勝つ、spec §4)
        if (lines.length === 0) {
          attemptSupply();
        }
      });
    });
  });

  return {
    get lines() {
      return lines;
    },
    notifyComplete,
    destroy(): void {
      destroyed = true;
      clearRetryTimer();
      destroyRoot();
    },
  };
}
