import * as log from "../../logger";
import type { PresentationEvent } from "../presentation/types";
import {
  KILL_SWITCH_ERRORS,
  RECENT_TICKER_MAX,
  STATE_DEBOUNCE_MS,
  SWEEP_INTERVAL_MS,
  TICKER_SYNC_RETRY_MS,
} from "./constants";
import { degradeSnapshotToBudget, degradeSyncedStateToBudget } from "./http-server";
import { projectDisplayEvent } from "./project-event";
import type { DisplayStateStore } from "./state-store";
import { tickerTtlMs } from "./ticker-ttl";
import type {
  DisplayConnectionStateV1,
  DisplayEventDtoV1,
  DisplayIngestSink,
  DisplayStateSnapshotV1,
  DisplayStatsV1,
  DisplayTransport,
  DisplayWeatherAlertV1,
} from "./types";

export interface InfoDisplayHubDeps {
  /** monitor が DisplayCallbacks.renderSummaryLine の DI で渡す (engine から ui を import しない) */
  summarize: (event: PresentationEvent) => string;
  /** VPWS50 受信時に読み直す。updatedAt には hub が dto.reportDateTime を渡す */
  weatherAlerts: (updatedAt: string) => DisplayWeatherAlertV1[];
  /** テスト注入用。省略時 Date.now */
  now?: () => number;
  /** kill switch 発火時の通知 */
  onFatal?: (reason: string) => void;
  /** フロント資産のビルド識別子 (display/dist/index.html 内容ハッシュ) を返す getter。
   *  snapshot/state に載せてクライアントの自動リロードに使う。省略・null 返却は「識別子なし」
   *  (クライアントは何もしない)。呼び出しごとに dist を stat して変化時のみ再ハッシュする実装を想定 */
  frontendBuildId?: () => string | null;
}

// 電文 1 件を「射影 → 状態適用 → ring buffer → transport broadcast」に束ねる中枢。
// ingest は例外を外へ漏らさない (表示系の障害で電文処理を殺さない)。
// 連続 KILL_SWITCH_ERRORS 回のエラーで stop() + onFatal (kill switch)。
export class InfoDisplayHub implements DisplayIngestSink {
  private seq = 0;
  private recent: Array<{ dto: DisplayEventDtoV1; receivedMs: number }> = [];
  private transport: DisplayTransport | null = null;
  private consecutiveErrors = 0;
  private stopped = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private stateDirty = false;
  private stateTimer: NodeJS.Timeout | null = null;
  /** sweepTicker が recentTicker の構成を変えたら true。次の state 配信で一発同期し、
   *  配信が実際に broadcast されるまで保持する (縮退で送信スキップされた場合は次回に持ち越す、spec §3-2) */
  private tickerSyncPending = false;
  /** pending 中に完全同期を送れなかった (縮退で持ち越し or fail-loud スキップ) ときの明示的な
   *  再試行タイマー。定期 state は dirty 駆動なので、外部 dirty が偶然来なければ pending が永久に
   *  残る恐れがある (spec §3-5、レビュー R3 Important 対応) */
  private tickerSyncRetryTimer: NodeJS.Timeout | null = null;
  private lastStatsJson: string | null = null;
  /** クライアントへ実際に配信している安定 buildId。新しい観測値は連続 2 回 (sweep 2 周期) 同一を
   *  確認してからこの値へ昇格させ、ビルド書き込み途中の中間状態や mtime 揺れによるフラッピングを
   *  源で潰す (レビュー high)。 */
  private publishedBuildId: string | null = null;
  /** 昇格待ちの候補 buildId (未確定の 1 回目観測)。次の観測でも同じなら published へ昇格する。 */
  private pendingBuildId: string | null = null;
  /** publishedBuildId を一度でも観測で初期化したか (初回観測は即採用し、以降の変化のみ 2 回確認)。 */
  private buildIdSeeded = false;
  private readonly now: () => number;

  constructor(
    private readonly store: DisplayStateStore,
    private readonly deps: InfoDisplayHubDeps,
  ) {
    this.now = deps.now ?? Date.now;
  }

  attachTransport(t: DisplayTransport): void {
    this.transport = t;
  }

  ingest(event: PresentationEvent): void {
    if (this.stopped) return;
    try {
      const nowMs = this.now();
      const dto = projectDisplayEvent(event, this.deps.summarize(event));
      dto.seq = ++this.seq;
      this.store.setConnection({ lastReceivedAt: new Date(nowMs).toISOString() }, nowMs);
      // event.tsunamiObservations は DTO の emergency には (VTSE51/52 で level が組めないと) 載らないため、
      // PresentationEvent から直接渡す (protocol 型は変えない server-internal な橋渡し)
      let stateChanged = this.store.applyEvent(dto, nowMs, event.tsunamiObservations ?? null);
      if (dto.type === "VPWS50" || dto.type === "VPWW56") {
        this.store.seedWeatherAlerts(this.deps.weatherAlerts(dto.reportDateTime));
        stateChanged = true;
      }
      this.recent.push({ dto, receivedMs: nowMs });
      if (this.recent.length > RECENT_TICKER_MAX) this.recent.shift();
      this.transport?.broadcast({ type: "event", event: dto });
      if (stateChanged) this.markStateDirty();
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors += 1;
      if (this.consecutiveErrors >= KILL_SWITCH_ERRORS) {
        try {
          this.stop();
          this.deps.onFatal?.(`display hub: ${String(err)}`);
        } catch {
          // onFatal (DI) の障害も ingest から漏らさない (例外封じ込めの絶対不変条件)
        }
      }
    }
  }

  publishConnection(patch: Partial<DisplayConnectionStateV1>): void {
    if (this.stopped) return;
    this.store.setConnection(patch, this.now());
    this.markStateDirty();
  }

  /** 前回値 (JSON 文字列比較) と変化がない場合は配信をスキップする */
  publishStats(stats: DisplayStatsV1): void {
    if (this.stopped) return;
    const json = JSON.stringify(stats);
    if (json === this.lastStatsJson) return;
    this.lastStatsJson = json;
    this.store.setStats(stats);
    this.markStateDirty();
  }

  /** recentTicker (新しい順) 込みの現在状態。SSE 接続時に transport (getSnapshot) が呼ぶ */
  buildSnapshot(): DisplayStateSnapshotV1 {
    const snap = this.store.snapshot(this.seq, this.now());
    snap.recentTicker = this.recent.map((e) => e.dto).reverse();
    this.stampFrontendBuildId(snap);
    return snap;
  }

  /** 安定 buildId (publishedBuildId) を snapshot に刻む。null (getter 無し・dist 未解決) のときは
   *  載せない (クライアントは欠落として何もしない)。縮退ラダーは spread で全フィールドを引き継ぐため、
   *  ここで載せた値はどの縮退段でも保持される (小さな string なので縮退対象にもしない)。
   *  startTimers 前 (接続時 snapshot 単体呼び出し等) にも値が要るので、未初期化なら遅延で seed する */
  private stampFrontendBuildId(snap: DisplayStateSnapshotV1): void {
    if (!this.buildIdSeeded) this.observeFrontendBuildId();
    if (this.publishedBuildId != null) snap.frontendBuildId = this.publishedBuildId;
  }

  /**
   * frontendBuildId getter を 1 回観測し、安定化ルールで publishedBuildId を更新する。
   * publishedBuildId が変わったら true (呼び出し元が state 配信を誘発する)。
   * - 初回観測: 即 published へ採用 (初回接続・初回ページロードに値が要る。変化ではないので false)
   * - published と一致: 揺れ戻り。pending をクリアするだけ (false)
   * - published と相違かつ pending と一致: 連続 2 回同一の新値 → published へ昇格 (true)
   * - published と相違かつ pending と相違: 新候補。pending に置くだけで配信しない (false)
   */
  private observeFrontendBuildId(): boolean {
    const observed = this.deps.frontendBuildId?.() ?? null;
    if (!this.buildIdSeeded) {
      this.buildIdSeeded = true;
      this.publishedBuildId = observed;
      this.pendingBuildId = observed;
      return false;
    }
    if (observed === this.publishedBuildId) {
      this.pendingBuildId = observed;
      return false;
    }
    if (observed === this.pendingBuildId) {
      this.publishedBuildId = observed;
      return true;
    }
    this.pendingBuildId = observed;
    return false;
  }

  /**
   * 優先度別 TTL で recentTicker を追い出す。EEW/津波 active な groupKey は残す (spec §3-1)。
   * 構成が変わったら tickerSyncPending を立て、次の state 配信に recentTicker を一発同梱させる
   * (spec §3-2)。定期 state は通常 recentTicker を運ばないため、これがないと接続中クライアントに
   * sweep 結果が届かず、特に「サーバは active 保持、フロントは時間切れで刈る」という逆向きの
   * 不整合が起きる (レビュー Important)。
   */
  sweepTicker(nowMs: number): boolean {
    const activeKeys = this.store.activeAlertKeys();
    const before = this.recent.length;
    this.recent = this.recent.filter((e) => {
      const priority = e.dto.tickerPriority ?? "low";
      const expired = nowMs - e.receivedMs > tickerTtlMs(priority);
      if (!expired) return true;
      return e.dto.groupKey != null && activeKeys.has(e.dto.groupKey); // active なら残す
    });
    const changed = this.recent.length !== before;
    if (changed) this.tickerSyncPending = true;
    return changed;
  }

  /**
   * 定期 state 配信用。通常は recentTicker を空にする (電文毎に totalReceived が変わり実質毎電文で
   * dirty になるため、200 件フル DTO を乗せ続けるとペイロードが肥大しバイト上限を毎回超えて
   * 送信スキップになる)。tickerSync=true で呼ばれたときだけ recentTicker を権威値として同梱し
   * tickerSynced:true を付す (spec §3-2、一発同期)。フロント側はこのフラグが無い state では
   * ticker を据え置く (store.ts の reduce 分岐)
   */
  private buildStateSnapshot(tickerSync: boolean): DisplayStateSnapshotV1 {
    const snap = this.store.snapshot(this.seq, this.now());
    if (tickerSync) {
      snap.recentTicker = this.recent.map((e) => e.dto).reverse();
      snap.tickerSynced = true;
    } else {
      snap.recentTicker = [];
    }
    this.stampFrontendBuildId(snap);
    return snap;
  }

  startTimers(): void {
    if (this.stopped || this.sweepTimer != null) return;
    // 起動時点の buildId を基準に据える (初回観測は即 published 採用、変化とはみなさない)。
    // 以後 sweep で観測を重ね、連続 2 回同一の新値だけを published へ昇格させて state を誘発する
    this.observeFrontendBuildId();
    this.sweepTimer = setInterval(() => {
      const nowMs = this.now();
      let dirty = this.store.sweep(nowMs);
      dirty = this.sweepTicker(nowMs) || dirty;
      // 無停止の display:build (プロセス継続で dist だけ差し替え) を電文契機に頼らず検知する。
      // publishedBuildId が昇格したときだけ dirty 化して新 buildId を state で届ける
      dirty = this.observeFrontendBuildId() || dirty;
      if (dirty) this.markStateDirty();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  stopTimers(): void {
    if (this.sweepTimer != null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.stateTimer != null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
    this.clearTickerSyncRetry();
  }

  /** 完全同期を送れなかった tick の後、外部 dirty 契機に頼らず再試行するためのタイマーを張る
   *  (多重張り防止、spec §3-5)。発火時点でも pending が残っていれば markStateDirty で再試行する */
  private scheduleTickerSyncRetry(): void {
    if (this.stopped || this.tickerSyncRetryTimer != null) return;
    this.tickerSyncRetryTimer = setTimeout(() => {
      this.tickerSyncRetryTimer = null;
      if (this.stopped || !this.tickerSyncPending) return;
      this.markStateDirty();
    }, TICKER_SYNC_RETRY_MS);
    this.tickerSyncRetryTimer.unref();
  }

  private clearTickerSyncRetry(): void {
    if (this.tickerSyncRetryTimer != null) {
      clearTimeout(this.tickerSyncRetryTimer);
      this.tickerSyncRetryTimer = null;
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopTimers();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private markStateDirty(): void {
    this.stateDirty = true;
    if (this.stateTimer != null) return; // 実行待ちタイマーは再スケジュールしない (debounce)
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (!this.stateDirty || this.stopped) return;
      this.stateDirty = false;
      const hadTickerSync = this.tickerSyncPending;
      try {
        // tickerSyncPending 時は recentTicker を絶対に削らない専用ラダーを先に試す
        // (「同期 state は完全か、送らないか」の二値、spec §3-2、レビュー R2 Important 対応)。
        // それでも収まらなければ recentTicker を諦めた通常ラダーへフォールバックし、
        // pending は維持して次の dirty で改めて完全同期を試みる
        let result = hadTickerSync ? degradeSyncedStateToBudget(this.buildStateSnapshot(true)) : null;
        if (result == null) {
          // 接続時 snapshot と同じ縮退ラダーを安全弁として通す (recentTicker を外した後も
          // 気象警報の全国展開等でバイト上限を超えうる)
          result = degradeSnapshotToBudget(this.buildStateSnapshot(false), "state");
        }
        if (result == null) {
          log.warn("display hub: 縮退後も state が上限を超えたため配信をスキップしました");
          // tickerSyncPending はクリアしない (今回同梱できなかった分は次の dirty に持ち越す)。
          // 外部 dirty が偶然来なくても再試行できるよう明示的なタイマーを張る (レビュー R3 対応)
          if (hadTickerSync) this.scheduleTickerSyncRetry();
          return;
        }
        if (result.level > 0) {
          log.info(`display hub: state が上限を超えたため縮退段 ${result.level} まで縮退して配信しました`);
        }
        const delivery = this.transport?.broadcast({ type: "state", snapshot: result.snapshot });
        if (hadTickerSync) {
          // authoritative sync が「完全な構成で」かつ「全 client へ」届いたときだけ pending を落とす。
          // backpressure 中の client は state broadcast をスキップされるため、その分は届いておらず
          // pending を落とすと stale ticker が再接続まで残る (最終レビュー finding 2)。blockedSkipped>0 なら
          // pending 維持で再試行し、blocked client は drain で受け取るか MAX_BLOCKED_MS 超過で切断され
          // 再接続時の完全な snapshot で整合する。transport 未接続 (delivery==null) は client 0 扱い
          const fullyDelivered = delivery == null || delivery.blockedSkipped === 0;
          if (result.snapshot.tickerSynced === true && fullyDelivered) {
            this.tickerSyncPending = false;
            this.clearTickerSyncRetry();
          } else {
            // 完全同期を諦めた通常除外 state へフォールバックした、または backpressure で一部 client に
            // 届かなかった → pending は残る。再試行タイマーを張り、次の外部 dirty を待たずに再試行する
            this.scheduleTickerSyncRetry();
          }
        }
      } catch {
        // timer callback からの throw は uncaughtException として monitor を殺すためここで握る。
        // ingest 経路の連続エラーカウンタとは独立 (state 配信は次の dirty で再試行される)
      }
    }, STATE_DEBOUNCE_MS);
    this.stateTimer.unref();
  }
}
