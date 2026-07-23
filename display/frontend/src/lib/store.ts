import type { DisplayEventDtoV1, DisplayServerMessage, DisplayStateSnapshotV1 } from "./protocol";
import { filterStaleEews } from "./ticker-freshness";

// RECENT_TICKER_MAX (src/engine/display/constants.ts) と同値。protocol.ts の SYNC 複製対象外のため
// ここではローカル定数として複製する。
const TICKER_MAX = 200;

export interface DisplayClientState {
  snapshot: DisplayStateSnapshotV1 | null;
  ticker: DisplayEventDtoV1[]; // 新しい順、TICKER_MAX で丸める
  sseConnected: boolean;
  lastSeq: number;
  /**
   * 「確実に ticker に反映できた」最後の seq (= 最後に受信できた event の seq。snapshot 受信時は
   * その snapshot.seq を baseline として採用する)。state メッセージはこれを進めない —
   * state.snapshot.seq は hub 側の現在の seq カウンタをそのまま運ぶだけで、event 配信の成否とは
   * 独立している (hub は ingest 成功ごとに dto.seq=++this.seq で採番した直後に
   * transport.broadcast({type:"event",...}) するので、event が
   * SseClients の backpressure/バイト上限でスキップされても hub 側の seq は進んだままになる) ため、
   * lastSeq (state 込みで進む値) と同じもので比較すると「1 件だけ欠落 → 直後に state」という
   * ケースで `stateSeq > lastSeq+1` が false になり見逃す (off-by-one)。gap 判定は必ず
   * lastEventSeq (state で進まない値) を基準にする。
   */
  lastEventSeq: number;
  /**
   * event/state の seq が lastEventSeq を跳び越えていたら true (SseClients の backpressure スキップや
   * MAX_EVENT_BYTES 超過で event が欠落したことの検知フラグ)。定期 state はもう recentTicker を
   * 運ばない (2026-07-10 バイト上限対策) ため、event 欠落を state の recentTicker が偶然補完する
   * 従来の safety net が失われた。connection 層はこのフラグを見て再接続 (snapshot 再取得) を発火し、
   * 次の snapshot 受信で ticker を全再構築してからクリアする。
   */
  seqGapDetected: boolean;
  /**
   * ticker が recentTicker から丸ごと作り直された回数 (spec §6)。**reduce の "snapshot" 分岐**、および
   * "state" 分岐で tickerSynced:true (sweepTicker 変化の一発同期、spec §3-2) を受けたときに +1 する。
   * それ以外の "state"/"event" 分岐では据え置く。テロップの親スケジューラはこれを resetKey として購読し、
   * 値が変わったら job キュー・active・deferred を全破棄して再構築する。snapshot.seq を resetKey に
   * すると定期 state のたびに全 reset してしまう (lastSeq は Math.max で進む) ため seq 値に依存しない。
   * 同一 seq の再 snapshot・seq 巻戻り (hub 再起動) でも snapshot 受信ごとに進むので確実に検出できる。
   */
  tickerGeneration: number;
}

export function initialState(): DisplayClientState {
  return {
    snapshot: null, ticker: [], sseConnected: false, lastSeq: 0, lastEventSeq: 0, seqGapDetected: false,
    tickerGeneration: 0,
  };
}

/** event の seq が lastEventSeq+1 を跳び越えていたら (= 間の event が欠落していたら) true。
 *  古い/重複 seq (incomingSeq <= lastEventSeq) は gap ではない (既存の再送・順序入れ替わり許容と同じ扱い) */
function hasEventSeqGap(lastEventSeq: number, incomingSeq: number): boolean {
  return incomingSeq > lastEventSeq + 1;
}

/** state の snapshot.seq が lastEventSeq を超えていたら (= state が知っている最新 seq より
 *  古い event までしか受信できていなければ) true。event と違い +1 ではなく等号越えで判定する:
 *  event を 1 件も欠落せず全部受信できていれば、state 受信時点で lastEventSeq は必ず
 *  state.snapshot.seq 以上になっている (hub は seq 採番後すぐ event を broadcast するため、
 *  正常経路では event が後続の state より先に配信される)。 */
function hasStateSeqGap(lastEventSeq: number, stateSeq: number): boolean {
  return stateSeq > lastEventSeq;
}

export function reduce(state: DisplayClientState, msg: DisplayServerMessage): DisplayClientState {
  switch (msg.type) {
    case "snapshot":
      // 接続時 snapshot のみ recentTicker で ticker を初期化する。ticker を全再構築するので
      // それまでの gap は解消済み扱いにし、snapshot.seq を新しい baseline として採用する。
      // lastEventSeq は Math.max ではなく代入でリセットする: hub 再起動で seq が巻き戻ると
      // (プロセス内カウンタのため実経路)、max では古い高水位が残り以後の gap を検知できなくなる
      return {
        ...state,
        snapshot: msg.snapshot,
        ticker: filterStaleEews(msg.snapshot.recentTicker, msg.snapshot).slice(0, TICKER_MAX),
        lastSeq: Math.max(state.lastSeq, msg.snapshot.seq),
        lastEventSeq: msg.snapshot.seq,
        seqGapDetected: false,
        // ticker 全差し替えなので generation を進める (スケジューラ reset の契機、§6)
        tickerGeneration: state.tickerGeneration + 1,
      };
    case "state": {
      // 定期 state は通常 recentTicker を送らない (hub 側でペイロード肥大を避けるため空にする)。
      // ticker は event メッセージの積み上げで既に維持されているので据え置く。lastEventSeq は
      // 進めない (state 自身は event 配信の成否を保証しないため)。
      // tickerSynced:true のときだけ例外: サーバの sweepTicker が recentTicker の構成を変えた
      // 一発同期 (spec §3-2)。この場合は recentTicker (空配列もあり得る = 全滅) を権威値として
      // 丸ごと差し替え、tickerGeneration を進めてスケジューラを再構築させる (snapshot 受信と同じ扱い)
      const tickerSynced = msg.snapshot.tickerSynced === true;
      return {
        ...state,
        snapshot: msg.snapshot,
        ticker: tickerSynced ? filterStaleEews(msg.snapshot.recentTicker, msg.snapshot).slice(0, TICKER_MAX) : state.ticker,
        lastSeq: Math.max(state.lastSeq, msg.snapshot.seq),
        seqGapDetected: state.seqGapDetected || hasStateSeqGap(state.lastEventSeq, msg.snapshot.seq),
        tickerGeneration: tickerSynced ? state.tickerGeneration + 1 : state.tickerGeneration,
      };
    }
    case "event":
      return {
        ...state,
        ticker: [msg.event, ...state.ticker].slice(0, TICKER_MAX),
        lastSeq: Math.max(state.lastSeq, msg.event.seq),
        lastEventSeq: Math.max(state.lastEventSeq, msg.event.seq),
        seqGapDetected: state.seqGapDetected || hasEventSeqGap(state.lastEventSeq, msg.event.seq),
      };
  }
}

export function setSseConnected(state: DisplayClientState, connected: boolean): DisplayClientState {
  return { ...state, sseConnected: connected };
}
