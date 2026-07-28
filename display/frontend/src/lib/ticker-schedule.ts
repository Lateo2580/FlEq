// テロップ全体スケジューラの純関数コア (spec §4)。割込み・退避・再試行・保留・巡回・競合の
// 状態遷移を副作用なしで計算する。setTimeout / DOM / animationName 読取は Ticker.svelte 側の
// 薄い副作用層に置き、ここは state を受け取り次 state (と次に張る timer 時刻 wakeAt) を返す。
import type { DisplayColorRole, DisplayEventDtoV1, DisplayTickerPriority, DisplayTickerSurface } from "./protocol";
import { normalizeTickerSurface } from "./display-contract";
import { mapEmphasisToSegments, segmentTickerBody, splitRuns, type EmphasisSpan, type TickerRun } from "./ticker-segment";
import { isAlertRole } from "./alert-roles";
import type { EmergencyCompanionControl, EmergencyHazard } from "./emergency-tips-policy";

export type TickerPriority = DisplayTickerPriority;

// ジョブの出自種別 (2026-07-14 フィラー排他化 v2)。key prefix (isFillerKey) 判定を廃し、
// Ticker/スケジューラ/App の分岐をこの kind に一本化する。
//   "event"  = サーバ電文 (DisplayEventDtoV1、既定)
//   "tip"    = 待機中 Tips (フィラー)。排他割当・emergency purge の対象
//   "replay" = 津波 replay 等のフロント合成再放送 (後続タスクで配線。ここでは型のみ定義)
export type TickerJobKind = "event" | "tip" | "replay";
export type TipPolicy = "idle-only" | "emergency-companion";

/**
 * フロントが Ticker へ渡す DTO。サーバ電文 (DisplayEventDtoV1) に、フロント合成ジョブの
 * 種別 kind を任意付与できる拡張。kind 省略時は "event" (= サーバ電文)。protocol の wire 型
 * (PROTOCOL-SYNC ブロック) は変更しない — kind はフロント合成 (Tips / replay) 専用の付帯情報。
 */
export interface DisplayTickerDtoV1 extends DisplayEventDtoV1 {
  kind?: TickerJobKind;
  tipPolicy?: TipPolicy;
  tipHazards?: readonly EmergencyHazard[];
  /**
   * replay ジョブの投入時点の津波 snapshot 世代 (2026-07-14 津波チップ再生)。津波 state が
   * 更新/解除で世代不一致になったら未開始 replay を purge・走行中 replay を停止する判定に使う。
   * kind !== "replay" の DTO では未設定 (protocol の wire 型には載せない、フロント合成専用)。
   */
  replayGeneration?: number;
}

// 割込みで途中退避した low (初回退避 = deferKind "quiet") を再開するまでの連続静穏時間。
// 実機フィードバック (2026-07-11「読みかけの続きだけ早く」) で 60 秒 → 5 秒へ短縮。調整前提。
export const INTERRUPTED_RESUME_MS = 5_000;
export const LONG_DEFER_MS = 300_000; // 再割込みされた low の長期保留 (5 分固定)。緊急ラッシュ後の乱歩防止で据え置き
export const FADE_MS = 150; // 割込みフェードの尺 (通常時のみ。reduced-motion は 0ms)
export const LANES = 2;
export const HIGH_SLICE_MS = 8_000; // high 2 件同時の上段時間量子 (§7-2)
export const CYCLE_MIN_INTERVAL_MS = 120_000; // 巡回 low の最低再登場間隔 (§4)

export const MIN_VISIBLE_MS = 2_500; // 同格続報で現在文を最低表示する時間 (§5-1)
export const REVISION_COALESCE_MS = 750; // 続報を最新 1 件へ畳む debounce (§5-1)
export const MAX_REVISION_WAIT_MS = 4_500; // 境界が来なくても切り替える上限 (§5-1)
export const REVISION_BADGE_MS = 600_000; // 続報バッジ保持時間 10 分 (§5-2/§12)。判定式は Spec C が親で書く

const PRI: Record<TickerPriority, number> = { high: 2, mid: 1, low: 0 };

export interface TickerJob {
  key: string; // eventKey (重複排除・版管理のキー)
  groupKey: string | null; // 同一イベント続報の版管理
  seq: number; // 到着順 (同優先度の安定ソート用)
  kind: TickerJobKind; // 出自種別 (排他割当・purge 判定の唯一の真実源、key prefix 判定は廃止)
  tipPolicy: TipPolicy | null;
  tipHazards: readonly EmergencyHazard[];
  priority: TickerPriority;
  role: DisplayColorRole;
  category: string | null;
  subject: string | null; // 件名チップ (tickerSubject)。null は種別ラベルのみ
  segments: string[];
  segmentEmphasis: EmphasisSpan[][]; // segments と同長。各 segment 内の強調区間 (ローカル座標)。無強調は空配列 (backlog §3)
  runs: TickerRun[]; // 連続走行の境界 (通常電文は 1 要素、§2-5)
  runIndex: number; // 現在流している run
  segmentIndex: number; // 次に流すセグメント (割込み再走で保存/復元)
  retryCount: number; // 割込まれた回数 (2 で飽和)
  deferUntil: number | null; // epoch ms。long 保留の固定期限
  deferKind: "quiet" | "long" | null; // quiet=静穏依存の可変期限 / long=5分固定
  revisionAt: number | null; // 続報が実表示へ昇格した時刻。Spec C バッジ発火 (§5-2)
  isCancellation: boolean; // 取消判定。二段制御の即時フェード条件 (§5-1)
  /** engine 権威の面契約。scheduler は判定も書換も行わない。 */
  surface: DisplayTickerSurface;
  replayGeneration?: number; // replay ジョブの投入時点の津波 snapshot 世代 (世代不一致 purge 用、非 replay は未設定)
}

export const EMERGENCY_COMPANION_COOLDOWN_MS = 120_000;
export const EMERGENCY_COMPANION_SESSION_MAX = 1;
const DISABLED_COMPANION: EmergencyCompanionControl = { sessionId: "none", enabled: false, hazards: [] };

export type LanePhase = "idle" | "running" | "fading";

export interface LaneState {
  phase: LanePhase;
  current: TickerJob | null; // 走行中 (running) / 退避対象 (fading) の job
  replacement: TickerJob | null; // fade 開始時に queue から原子確保した割込み job
  coalescedRevision: TickerJob | null; // 同格続報の最新版のみ (容量 1、§5-1)
  currentStartedAt: number | null; // current 走行開始時刻 (coalescing 最短表示、§5-1)
  highSliceStartedAt: number | null; // high 交代量子の起点 (§7-2)。別 groupKey high への交替時のみ張り直す (coalescing とは別時計)
  revisionFirstQueuedAt: number | null; // 最初の同格続報が来た時刻 (§5-1)
  revisionDebounceUntil: number | null; // この時刻まで続報を畳む (§5-1)
  generation: number; // この要素の世代 (animationend ガードの唯一の真実源)
  completedGeneration: number; // advance 済みの最終世代 (完了済みガード)
}

export interface SchedulerState {
  lanes: LaneState[]; // LANES 本
  queue: TickerJob[]; // 待機列 (pull 時に優先度降順 → seq 昇順で取り出す)
  deferred: TickerJob[]; // 保留中 (deferUntil/deferKind 付き)
  quietSince: number | null; // high/mid が両レーンから消えた時刻。走行中は null
  cyclePos: number; // low 巡回の位置
  catalog: TickerJob[]; // low 巡回の供給元 (groupKey 畳み込み済み)
  lastShownAt: Record<string, number>; // key ごとの最終走行開始時刻 (巡回間隔判定、§4)
  emergencyCompanion: EmergencyCompanionControl;
  companionShown: number;
  companionLastShownAt: number | null;
}

// ─── 生成 ──────────────────────────────────────────────

function fallbackText(dto: DisplayEventDtoV1): string {
  if (dto.tickerSentence != null && dto.tickerSentence.length > 0) return dto.tickerSentence;
  return dto.tickerDetail != null ? `${dto.summary.text} ▪ ${dto.tickerDetail}` : dto.summary.text;
}

/**
 * DTO → TickerJob 変換 (純関数)。segments は本文を分割、空本文は tickerSentence 1 本へフォールバック。
 * seq は dto.seq を使い、0/欠落時のみ親の fallbackSeq を振る (snapshot 由来 job の先着順逆転を防ぐ)。
 */
export function toTickerJob(dto: DisplayTickerDtoV1, fallbackSeq: number): TickerJob {
  let segments = dto.tickerBody != null ? segmentTickerBody(dto.tickerBody) : [];
  // 強調区間は本文由来の segments が生きているときだけ写像する。フォールバック文
  // (tickerSentence 1 本) には強調を載せない (index が本文座標で合わないため)。
  let segmentEmphasis: EmphasisSpan[][] =
    dto.tickerBody != null && segments.length > 0 && dto.tickerEmphasis != null && dto.tickerEmphasis.length > 0
      ? mapEmphasisToSegments(dto.tickerBody, segments, dto.tickerEmphasis)
      : segments.map(() => []);
  if (segments.length === 0) {
    segments = [fallbackText(dto)];
    segmentEmphasis = [[]];
  }
  return {
    key: dto.eventKey,
    groupKey: dto.groupKey,
    seq: dto.seq !== 0 ? dto.seq : fallbackSeq,
    kind: dto.kind ?? "event",
    tipPolicy: dto.tipPolicy ?? null,
    tipHazards: dto.tipHazards ?? [],
    priority: dto.tickerPriority ?? "low",
    role: dto.summary.role,
    category: dto.tickerCategory ?? null,
    subject: dto.tickerSubject ?? null,
    segments,
    segmentEmphasis,
    runs: splitRuns(segments),
    runIndex: 0,
    segmentIndex: 0,
    retryCount: 0,
    deferUntil: null,
    deferKind: null,
    revisionAt: null,
    isCancellation: dto.isCancellation,
    surface: normalizeTickerSurface(dto.tickerSurface),
    ...(dto.replayGeneration != null ? { replayGeneration: dto.replayGeneration } : {}),
  };
}

function idleLane(generation = 0): LaneState {
  return {
    phase: "idle", current: null, replacement: null, coalescedRevision: null,
    currentStartedAt: null, highSliceStartedAt: null, revisionFirstQueuedAt: null, revisionDebounceUntil: null,
    generation, completedGeneration: generation,
  };
}

/**
 * catalog を groupKey ごとに 1 件へ畳み込む (groupKey==null はそのまま、順序保持)。
 * 入力 (lines) は新しい順なので **先勝ち = 最新版が残る** (Medium 1。後勝ちだと最古版が残る)。
 */
export function foldCatalog(jobs: TickerJob[]): TickerJob[] {
  const seenGroups = new Set<string>();
  const out: TickerJob[] = [];
  for (const job of jobs) {
    if (job.groupKey == null) {
      out.push(job);
      continue;
    }
    if (seenGroups.has(job.groupKey)) continue; // 先勝ち (新しい順入力なので最新が残る)
    seenGroups.add(job.groupKey);
    out.push(job);
  }
  return out;
}

/**
 * @param generationSeed reset を跨いで世代を単調増加させる種 (旧レーンの generation の最大値)。
 *   これより大きい世代から再構築し、{#key generation} が必ず変化して旧 DOM を再利用しない +
 *   旧要素の遅延 animationend が新状態を通過しないようにする (Critical 1)。
 */
export function createSchedulerState(catalog: TickerJob[], generationSeed = 0): SchedulerState {
  const folded = foldCatalog(catalog);
  return {
    lanes: Array.from({ length: LANES }, () => idleLane(generationSeed)),
    // 初回 queue にも畳み込み済み catalog を積み、priority→seq でレーンへ割り当てる (Critical 2)。
    // 巡回 (cycle) は queue が空になってから priority==="low" のみを供給する。
    queue: folded.map((j) => ({ ...j })),
    deferred: [],
    quietSince: null,
    cyclePos: 0,
    catalog: folded,
    lastShownAt: {},
    emergencyCompanion: DISABLED_COMPANION,
    companionShown: 0,
    companionLastShownAt: null,
  };
}

// ─── clone (純関数化のための draft コピー) ───────────────

function cloneState(s: SchedulerState): SchedulerState {
  return {
    lanes: s.lanes.map((l) => ({ ...l })),
    queue: [...s.queue],
    deferred: [...s.deferred],
    quietSince: s.quietSince,
    cyclePos: s.cyclePos,
    catalog: s.catalog,
    lastShownAt: { ...s.lastShownAt },
    emergencyCompanion: s.emergencyCompanion,
    companionShown: s.companionShown,
    companionLastShownAt: s.companionLastShownAt,
  };
}

// ─── 優先度・静穏の導出 ─────────────────────────────────

/** レーンの実効優先度。fading は replacement を「実効優先度」として数える (§4-2)。idle は -1。 */
function laneEffectivePriority(lane: LaneState): number {
  if (lane.phase === "fading" && lane.replacement != null) return PRI[lane.replacement.priority];
  if (lane.phase === "running" && lane.current != null) return PRI[lane.current.priority];
  return -1;
}

function anyHighMidActive(lanes: LaneState[]): boolean {
  return lanes.some((l) => laneEffectivePriority(l) >= PRI.mid);
}

/** scheduler が保持する全 job を走査する。lane 内は表示・交代待ち・続報の順で扱う。 */
function* schedulerJobs(s: SchedulerState): Generator<TickerJob> {
  for (const lane of s.lanes) {
    if (lane.current != null) yield lane.current;
    if (lane.replacement != null) yield lane.replacement;
    if (lane.coalescedRevision != null) yield lane.coalescedRevision;
  }
  yield* s.queue;
  yield* s.deferred;
}

function someSchedulerJob(s: SchedulerState, predicate: (job: TickerJob) => boolean): boolean {
  for (const job of schedulerJobs(s)) if (predicate(job)) return true;
  return false;
}

/**
 * kind !== "tip" のジョブがどこか (レーンの current/replacement/coalescedRevision・queue・deferred)
 * に居るか。tip 排他割当のガードと、App へ上げる activity 通知の両方が使う (2026-07-14 フィラー排他化)。
 * これが true の間、tip ジョブはレーンへ載せない (電文が 1 件でも走行/待機中なら豆知識は始めない)。
 */
export function hasNonTipActivity(s: SchedulerState): boolean {
  return someSchedulerJob(s, (job) => job.kind !== "tip");
}

/** 警報級 (意味重大度) のジョブが掲載中 (走行/交代待ち/続報/queue/deferred) か (spec D5)。
 *  tip と取消は対象外。判定は isAlertRole (fail-bright)。 */
export function hasAlertActivity(s: SchedulerState): boolean {
  return someSchedulerJob(s, (job) =>
    job.kind !== "tip" && !job.isCancellation && isAlertRole(job.role),
  );
}

/**
 * kind==="replay" かつ groupKey 一致のジョブが scheduler 上 (lane の current/replacement/
 * coalescedRevision・queue・deferred) に居るか (2026-07-14 津波チップ再生の連打ガード)。
 * true の間は同 groupKey (=同レベル) の replay 再投入を無視し、同じテロップの二重走行を防ぐ。
 */
export function hasActiveReplay(s: SchedulerState, groupKey: string): boolean {
  return someSchedulerJob(s, (job) => job.kind === "replay" && job.groupKey === groupKey);
}

/**
 * 続報バッジ (§5-2) の表示可否。revisionAt から REVISION_BADGE_MS 未満なら表示する。
 * 判定式を親 (Ticker) の template から関数へ寄せ、下の期限計算と同じ境界 (`< MS`) を共有する。
 */
export function isRevisionBadgeVisible(job: TickerJob | null, now: number): boolean {
  return job != null && job.revisionAt != null && now - job.revisionAt < REVISION_BADGE_MS;
}

/**
 * 表示中 (lane.current) の続報バッジが失効する時刻のうち、now より後で最も近いもの。無ければ null。
 * バッジは「真 → 偽」へ一度変わるだけなので、Ticker はこの 1 点にだけ one-shot timer を張る
 * (毎秒 interval を廃止、バッジ対象ゼロの平常時はタイマーを張らない)。
 * now 以前に失効済みの期限は返さない (既に isRevisionBadgeVisible が偽になっているため)。
 */
export function nextRevisionBadgeDeadline(s: SchedulerState, now: number): number | null {
  let earliest: number | null = null;
  for (const lane of s.lanes) {
    const revisionAt = lane.current?.revisionAt;
    if (revisionAt == null) continue;
    const deadline = revisionAt + REVISION_BADGE_MS;
    if (deadline <= now) continue;
    if (earliest == null || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

/** queue から最優先 (priority 降順 → seq 昇順) の index を返す。key が excluded の候補は飛ばす。 */
function bestQueueIndexExcluding(queue: TickerJob[], excluded: Set<string>): number {
  let best = -1;
  for (let i = 0; i < queue.length; i++) {
    const a = queue[i]!;
    if (excluded.has(a.key)) continue;
    if (best < 0) { best = i; continue; }
    const b = queue[best]!;
    const aCompanion = isEmergencyCompanion(a);
    const bCompanion = isEmergencyCompanion(b);
    if (
      PRI[a.priority] > PRI[b.priority]
      || (PRI[a.priority] === PRI[b.priority] && bCompanion && !aCompanion)
      || (PRI[a.priority] === PRI[b.priority] && aCompanion === bCompanion && a.seq < b.seq)
    ) best = i;
  }
  return best;
}

function isEmergencyCompanion(job: TickerJob): boolean {
  return job.kind === "tip" && job.tipPolicy === "emergency-companion";
}

function companionMayRun(s: SchedulerState, job: TickerJob, now: number): boolean {
  if (!companionAllowedByControl(s, job)) return false;
  if (s.companionShown >= EMERGENCY_COMPANION_SESSION_MAX) return false;
  if (s.companionLastShownAt != null && now - s.companionLastShownAt < EMERGENCY_COMPANION_COOLDOWN_MS) return false;
  return true;
}

function companionAllowedByControl(s: SchedulerState, job: TickerJob): boolean {
  if (!isEmergencyCompanion(job) || !s.emergencyCompanion.enabled) return false;
  const hazards = job.tipHazards;
  return hazards.length > 0
    && hazards.every((hazard) => hazard === "eew" || hazard === "tsunami" || hazard === "earthquake" || hazard === "weather")
    && hazards.some((hazard) => s.emergencyCompanion.hazards.includes(hazard));
}

function markCompanionShown(s: SchedulerState, job: TickerJob, now: number): void {
  if (!isEmergencyCompanion(job)) return;
  s.companionShown += 1;
  s.companionLastShownAt = now;
}

/** App が mode/session の唯一所有者として渡す companion 制御値を同期する。 */
export function setEmergencyCompanionControl(
  state: SchedulerState,
  control: EmergencyCompanionControl,
  now: number,
): SchedulerState {
  const s = cloneState(state);
  if (s.emergencyCompanion.sessionId !== control.sessionId) {
    s.companionShown = 0;
    s.companionLastShownAt = null;
  }
  s.emergencyCompanion = control;
  // session 上限/cooldown は「新規割当」の gate。ここで走行中 companion まで消すと、無関係な
  // snapshot 更新で表示を途中停止してしまう。control 自体が unsafe になったときだけ即 purge する。
  return purgeJobs(s, (job) => isEmergencyCompanion(job) && !companionAllowedByControl(s, job), now);
}

/** scheduler が保持中 (lane/queue/deferred) の全 job key。known 刈り込みの活性集合に使う。 */
export function collectSchedulerKeys(s: SchedulerState): Set<string> {
  return activeKeys(s);
}

function activeKeys(s: SchedulerState): Set<string> {
  return new Set(Array.from(schedulerJobs(s), (job) => job.key));
}

// ─── 退避 (割込まれた job の行き先) ─────────────────────

/**
 * 割込まれた current を退避する。mid=即時 queue 復帰 / low=quiet or long 保留 (§4-2-3)。
 * @param policyPriority 退避方針 (queue 即時復帰か保留か) を決める priority。既定は job 本来の priority。
 *   pendingRevision 退避では旧 current の priority を渡すが、**保存する job.priority は job 本来の値を
 *   維持する** (新版の priority を書き換えない、Medium 1)。
 */
function evacuate(s: SchedulerState, job: TickerJob, now: number, policyPriority: TickerPriority = job.priority): void {
  if (PRI[policyPriority] >= PRI.mid) {
    // mid 方針: segmentIndex 保存で即時 queue へ (60 秒保留は課さない)。job.priority はそのまま
    s.queue.push({ ...job, deferUntil: null, deferKind: null });
    return;
  }
  // low 方針: 初回は quiet 保留、再割込みは long 保留 (retryCount 2 で飽和)
  const retryCount = Math.min(job.retryCount + 1, 2);
  if (job.retryCount < 1) {
    s.deferred.push({ ...job, retryCount, deferKind: "quiet", deferUntil: null });
  } else {
    s.deferred.push({ ...job, retryCount, deferKind: "long", deferUntil: now + LONG_DEFER_MS });
  }
}

// ─── assignLanes: 1 tick の割当・割込み・巡回 ───────────

/**
 * coalescing buffer を昇格判定する (§5-1)。最短表示 (MIN_VISIBLE) + debounce 完了、または待機上限
 * (MAX_REVISION_WAIT) 到達で fade を開始する。beginFade がバッファを消費し fading へ移す。
 */
function promoteCoalesced(s: SchedulerState, now: number): void {
  for (const lane of s.lanes) {
    if (lane.phase !== "running" || lane.coalescedRevision == null || lane.currentStartedAt == null) continue;
    const minVisibleAt = lane.currentStartedAt + MIN_VISIBLE_MS;
    const maxWaitAt = lane.currentStartedAt + MAX_REVISION_WAIT_MS;
    const debounceDone = lane.revisionDebounceUntil != null && now >= lane.revisionDebounceUntil;
    if (now >= maxWaitAt || (now >= minVisibleAt && debounceDone)) {
      beginFade(lane, { ...lane.coalescedRevision, revisionAt: now });
    }
  }
}

/** low の載せ先: lane1 (下段) 優先、lane1 が塞がっていて lane0 が idle なら lane0 流用 (§7-1)。 */
function preferLowLane(s: SchedulerState): number {
  if (s.lanes[1]?.phase === "idle") return 1;
  if (s.lanes[0]?.phase === "idle") return 0;
  return 1;
}

/**
 * ⓪ coalescing 昇格 → ① 期限到来 deferred を queue へ昇格 → ② queue をレーンへ割当・割込み →
 * ③ 巡回 low 補充、の順で処理し、次に張るべき timer 時刻 wakeAt を返す純関数 (spec §4-2-5/§5-1)。
 */
export function assignLanes(state: SchedulerState, now: number): { state: SchedulerState; wakeAt: number | null } {
  const s = cloneState(state);

  // TTL による queue/deferred/catalog の時間ベース刈り込みはフロントには持たない (spec §3-2)。
  // composition の真実源はサーバの sweepTicker + state tickerSync 一発同期に一本化した
  // (レビュー Important 対応)。フロントが独自の時間閾値で刈ると、同期が届く前に
  // (サーバ側で active 保持中のはずの) job を誤って先に刈ってしまう逆向きの不整合が起きるため。
  // 「event 到着後・次の tickerSync 前」の隙間は再接続時の完全な snapshot が必ず整合させる。

  // ⓪ coalescing buffer の昇格判定 (最短表示 + debounce / 待機上限)。fade 開始で fading へ移る
  promoteCoalesced(s, now);

  // ① 期限到来 deferred を queue へ昇格 (空きレーン有無に関わらず。timer ループ防止 §4-2-4)
  const remainingDeferred: TickerJob[] = [];
  for (const job of s.deferred) {
    const due =
      (job.deferKind === "long" && job.deferUntil != null && now >= job.deferUntil) ||
      (job.deferKind === "quiet" && s.quietSince != null && now - s.quietSince >= INTERRUPTED_RESUME_MS);
    if (due) s.queue.push({ ...job, deferUntil: null, deferKind: null });
    else remainingDeferred.push(job);
  }
  s.deferred = remainingDeferred;

  // ② 割当・割込み (レーン役割: high/mid は lane0 のみ、lane1 は low 専用、§7)
  const LANE_HIGH = 0; // 下段 lane1 は preferLowLane が直接扱う

  // high 交代 (§7-2 B 案) は assignLanes の壁時計判定では**行わない**。以前はここで
  // 「量子経過 かつ 別 groupKey high 待機」なら run 走行中でも fade を開始していたが、走行時間
  // (本文長依存) と量子 (固定 8 秒) が無同期のため長文 run が途中で刈られていた (実機バグ)。交代の
  // 発火は run 境界 (onLineComplete) に限定した。wakeAt の量子起床 bump も同様に廃止 (下の ⑤ 参照)。

  // 優先度降順に候補を走査。目的レーンへ載せられない候補は stuck に退けて次候補へ進む
  // (ブリーフ差分: 単純 break だと lane0 で詰まった mid が後続 low の lane1 割当を巻き添え飢餓させる)。
  let guard = 0;
  const stuck = new Set<string>();
  for (;;) {
    if (guard++ > LANES * 8) break;
    const qi = bestQueueIndexExcluding(s.queue, stuck);
    if (qi < 0) break; // 残り候補は全て目的レーンへ載せられない → 待つ
    const cand = s.queue[qi]!;
    // standby Tip は従来どおり電文排他。companion は安全 control を満たす場合だけ lane1 で共存する。
    if (isEmergencyCompanion(cand) && !companionMayRun(s, cand, now)) { stuck.add(cand.key); continue; }
    if (cand.kind === "tip" && !isEmergencyCompanion(cand) && hasNonTipActivity(s)) { stuck.add(cand.key); continue; }
    // companion は lane 1 専用。preferLowLane の lane0 fallback を絶対に通さない。
    const targetLane = isEmergencyCompanion(cand) ? 1 : cand.priority === "low" ? preferLowLane(s) : LANE_HIGH;
    const lane = s.lanes[targetLane];
    if (lane == null) { stuck.add(cand.key); continue; }

    if (lane.phase === "idle") {
      s.queue.splice(qi, 1);
      lane.phase = "running";
      lane.current = { ...cand, deferUntil: null, deferKind: null };
      lane.replacement = null;
      lane.currentStartedAt = now; // 新 current の最短表示起点 (§5-1)
      if (cand.priority === "high") lane.highSliceStartedAt = now; // 別 high 交代量子の起点
      lane.generation += 1;
      s.lastShownAt[cand.key] = now;
      markCompanionShown(s, cand, now);
      continue;
    }
    // idle でない → 割込み判定。走行中テロップへの即時割込みは **high 候補のみ** 許可する (§7-1)。
    // mid は走行中の文を割込まずキューで流し終わりを待つ (注意報 low の一斉着信時に警報 mid が
    // 次々割込んで low が読めないまま消える問題への対処、2026-07-13)。generation は据え置き
    // (現要素をその場で opacity フェードさせ走行位置のジャンプを防ぐ、Medium 5)。
    // 同 groupKey 続報の即差替え (取消・優先度上昇) は enqueueJob / mustReplaceImmediately 側で別途扱う。
    const ep = laneEffectivePriority(lane);
    if (lane.phase === "running" && cand.priority === "high" && ep < PRI.high) {
      s.queue.splice(qi, 1);
      lane.replacement = { ...cand, deferUntil: null, deferKind: null };
      lane.phase = "fading";
      if (cand.priority === "high") lane.highSliceStartedAt = now;
      continue;
    }
    stuck.add(cand.key); // このレーンには今 tick 載せられない → 次候補へ
  }

  // ③ 巡回 low 補充 (queue/deferred に走行可能 job が無く idle なレーンへ、両レーン重複防止)
  if (s.catalog.length > 0) {
    const excluded = activeKeys(s);
    for (let li = 0; li < s.lanes.length; li++) {
      const lane = s.lanes[li]!;
      if (lane.phase !== "idle") continue;
      let picked: TickerJob | null = null;
      for (let i = 0; i < s.catalog.length; i++) {
        const idx = (s.cyclePos + i) % s.catalog.length;
        const cand = s.catalog[idx]!;
        // 巡回候補は low のみ (Critical 2)。high/mid は queue 経由で 1 回流し、巡回再生しない
        // 直近に流したものは CYCLE_MIN_INTERVAL_MS 未満の再登場を避ける (§4)
        const tooSoon = now - (s.lastShownAt[cand.key] ?? Number.NEGATIVE_INFINITY) < CYCLE_MIN_INTERVAL_MS;
        // tip 排他 (2026-07-14): 電文が居る間は巡回補充でも tip を載せない (queue ガードと対)
        const companion = isEmergencyCompanion(cand);
        const tipBlocked = cand.kind === "tip" && !companion && hasNonTipActivity(s);
        if (
          cand.priority !== "low" || excluded.has(cand.key) || tooSoon || tipBlocked
          || (companion && (li !== 1 || !companionMayRun(s, cand, now)))
        ) continue;
        picked = cand;
        s.cyclePos = idx + 1;
        break;
      }
      if (picked == null) continue; // 全候補が除外中 → idle のまま (有限走査)
      excluded.add(picked.key);
      lane.phase = "running";
      lane.current = { ...picked, segmentIndex: 0, retryCount: 0, deferUntil: null, deferKind: null };
      lane.replacement = null;
      lane.currentStartedAt = now; // 新 current の最短表示起点 (§5-1)
      lane.generation += 1;
      s.lastShownAt[picked.key] = now;
      markCompanionShown(s, picked, now);
    }
  }

  // ④ quietSince 更新 (high/mid 走行で null、両レーンから消えた瞬間 now)
  if (anyHighMidActive(s.lanes)) s.quietSince = null;
  else if (s.quietSince == null) s.quietSince = now;

  // ⑤ wakeAt = deferred 起床 + coalescing 昇格予定の最小値
  let wakeAt: number | null = null;
  const bump = (t: number | null): void => { if (t != null && (wakeAt == null || t < wakeAt)) wakeAt = t; };
  for (const job of s.deferred) {
    if (job.deferKind === "long") bump(job.deferUntil);
    else if (job.deferKind === "quiet") bump(s.quietSince != null ? s.quietSince + INTERRUPTED_RESUME_MS : null);
  }
  for (const lane of s.lanes) {
    if (lane.phase === "running" && lane.coalescedRevision != null && lane.currentStartedAt != null) {
      const minVisibleAt = lane.currentStartedAt + MIN_VISIBLE_MS;
      const debounceAt = lane.revisionDebounceUntil ?? minVisibleAt;
      bump(Math.min(lane.currentStartedAt + MAX_REVISION_WAIT_MS, Math.max(minVisibleAt, debounceAt)));
    }
  }
  // high 交代 (§7-2 B 案) は run 境界 (onLineComplete) で判定するため、量子満了の timer 起床は張らない。
  // 以前はここで量子満了時刻を bump していたが、起床した runTick が run 中に fade を再発させていた。

  // lastShownAt 肥大防止: catalog+active+queue+deferred に無い key を削除
  const live = activeKeys(s);
  for (const j of s.catalog) live.add(j.key);
  for (const k of Object.keys(s.lastShownAt)) if (!live.has(k)) delete s.lastShownAt[k];

  return { state: s, wakeAt };
}

// ─── イベント reducer (Svelte 側から呼ぶ) ───────────────

/** 現 DTO だけで機械判定できる即時差替え条件 (取消・優先度上昇、§5-1)。 */
export function mustReplaceImmediately(current: TickerJob, next: TickerJob): boolean {
  return next.isCancellation || PRI[next.priority] > PRI[current.priority];
}

/** fade 開始 = replacement を確保し fading へ。coalescing 状態はリセット (currentStartedAt の更新は昇格側)。 */
function beginFade(lane: LaneState, replacement: TickerJob): void {
  lane.replacement = { ...replacement, deferUntil: null, deferKind: null };
  lane.phase = "fading";
  lane.coalescedRevision = null;
  lane.revisionFirstQueuedAt = null;
  lane.revisionDebounceUntil = null;
}

/** coalescing buffer へ最新続報を畳む (§5-1)。runIndex/segmentIndex を頭出し、buffer 内 revisionAt は null。 */
function bufferRevision(lane: LaneState, job: TickerJob, now: number): void {
  lane.coalescedRevision = {
    ...job,
    runIndex: 0,
    segmentIndex: job.runs[0]?.startSegmentIndex ?? 0,
    revisionAt: null,
  };
  lane.revisionFirstQueuedAt ??= now;
  lane.revisionDebounceUntil = now + REVISION_COALESCE_MS;
}

/**
 * 新規 job を投入する (§4-5/§5-1)。groupKey が既存と一致すれば所在別に置換。
 * running current 一致は二段制御: 取消・優先度上昇は即 fade、同格は coalescing buffer へ。
 */
export function enqueueJob(state: SchedulerState, job: TickerJob, now: number): SchedulerState {
  const s = cloneState(state);
  if (job.groupKey != null) {
    for (const lane of s.lanes) {
      // fading の replacement と同 groupKey → 差替え (fade 継続)。current 判定より先 (Medium 3)
      if (lane.phase === "fading" && lane.replacement?.groupKey === job.groupKey) {
        lane.replacement = { ...job, revisionAt: now };
        return s;
      }
      // fading の outgoing current と同 groupKey (replacement は別 group) → 最新版を coalescedRevision
      // に保持する。fade 完了時 onFadeComplete が旧 current ではなくこの最新版を退避するため、
      // quiet resume で旧版が stale 再表示される問題を防ぐ (最終レビュー finding 6)。replacement 一致判定の
      // 後に置き、別 group への交代 (replacement 差替え) を優先する
      if (lane.phase === "fading" && lane.current?.groupKey === job.groupKey) {
        bufferRevision(lane, job, now);
        return s;
      }
      // running current と同 groupKey → 二段制御
      if (lane.phase === "running" && lane.current?.groupKey === job.groupKey) {
        if (mustReplaceImmediately(lane.current, job)) {
          beginFade(lane, { ...job, revisionAt: now }); // 取消・優先度上昇は即 fade
        } else {
          bufferRevision(lane, job, now); // 同格: coalescing buffer へ畳む
        }
        return s;
      }
      // coalescedRevision と同 groupKey → 最新で上書き (buffer 内 revisionAt=null 維持、初回起点は保持)
      if (lane.coalescedRevision?.groupKey === job.groupKey) {
        bufferRevision(lane, job, now);
        return s;
      }
    }
    // queue 内: 旧 seq を継いで in-place 置換
    const qi = s.queue.findIndex((j) => j.groupKey === job.groupKey);
    if (qi >= 0) {
      s.queue[qi] = { ...job, seq: s.queue[qi]!.seq };
      return s;
    }
    // deferred 内: segmentIndex=0 (新本文)、retryCount/deferUntil/deferKind は継承
    const di = s.deferred.findIndex((j) => j.groupKey === job.groupKey);
    if (di >= 0) {
      const old = s.deferred[di]!;
      s.deferred[di] = { ...job, segmentIndex: 0, retryCount: old.retryCount, deferUntil: old.deferUntil, deferKind: old.deferKind };
      return s;
    }
  }
  s.queue.push(job);
  return s;
}

/**
 * running レーンの 1 run 走破 (spec §2-1/§2-5)。firedGeneration ガードで scroll/二重を弾く。
 * 次 run があれば遷移 (currentStartedAt を now で最短表示リセット)、最終 run でジョブ完了 → idle。
 */
export function onLineComplete(state: SchedulerState, laneIndex: number, firedGeneration: number, now: number): SchedulerState {
  const s = cloneState(state);
  const lane = s.lanes[laneIndex];
  if (lane == null || lane.phase !== "running" || lane.current == null) return s;
  if (firedGeneration !== lane.generation || lane.completedGeneration === lane.generation) return s;
  lane.completedGeneration = lane.generation;

  const job = lane.current;

  // high 交代 (§7-2 B 案)。走行中 high が量子 (HIGH_SLICE_MS = 最低出番時間) を使い切り、別 groupKey の
  // high が queue 待機中なら、次 run へ進まず「この run 境界で」h2 へ交代する。壁時計交代 (旧 assignLanes)
  // を廃し交代を run 境界に限定したので、長文 run が途中で刈られない。完走済み run は既に画面外へ
  // スクロールし切っているため fade を挟まず直接 h2 を走らせる (run 間遷移と同じ視覚。generation++ で
  // TickerLane が h2 を頭から fade-in + 走行させる)。退場する h1 は「次 run」から再開できるよう queue へ
  // 退避する — completedGeneration は上で現世代に固定済みなので、続く generation++ で
  // completedGeneration < generation となり、遅延 animationend の二重完了ガードは保たれる。
  // 最終 run (runIndex が末尾) は下の idle 化パスに任せる (走行完了で交代してよい、量子不問)。
  if (
    job.priority === "high" && job.runIndex < job.runs.length - 1
    && lane.highSliceStartedAt != null && now - lane.highSliceStartedAt >= HIGH_SLICE_MS
  ) {
    const qi = s.queue.findIndex((j) => j.priority === "high" && j.groupKey !== job.groupKey);
    if (qi >= 0) {
      const [nextHigh] = s.queue.splice(qi, 1); // 異 groupKey high を原子的に先取り
      const nextRunIndex = job.runIndex + 1;
      // 退場する h1 の退避先。未昇格の coalescedRevision (同格続報) があれば最新版を頭から、無ければ
      // h1 を「次 run」から退避する (完走済み run は見せ終えたので続きから再開、R1 必須2)。
      const outgoing = lane.coalescedRevision != null
        ? { ...lane.coalescedRevision, runIndex: 0, segmentIndex: 0 }
        : { ...job, runIndex: nextRunIndex, segmentIndex: job.runs[nextRunIndex]!.startSegmentIndex };
      evacuate(s, outgoing, now);
      lane.current = { ...nextHigh!, deferUntil: null, deferKind: null };
      lane.replacement = null;
      lane.coalescedRevision = null;
      lane.revisionFirstQueuedAt = null;
      lane.revisionDebounceUntil = null;
      lane.currentStartedAt = now; // 昇格 = 新 current の最短表示起点 (§5-1)
      lane.highSliceStartedAt = now; // 別 groupKey high への交替 = 量子を張り直す (§7-2)
      s.lastShownAt[nextHigh!.key] = now;
      lane.generation += 1;
      return s; // phase は running のまま h2 を流す
    }
    // 待機 high が無ければ通常の run 遷移 / idle 化へフォールスルー
  }

  if (job.runIndex < job.runs.length - 1) {
    const nextRunIndex = job.runIndex + 1;
    lane.current = { ...job, runIndex: nextRunIndex, segmentIndex: job.runs[nextRunIndex]!.startSegmentIndex };
    lane.currentStartedAt = now; // run 遷移で最短表示リセット (highSliceStartedAt は Task 6 で維持)
    lane.generation += 1;
    return s;
  }
  // 最終 run 走破。未昇格の coalescedRevision (同格続報) が残っていれば捨てず最新版を頭から昇格して
  // 走らせる (§5-1)。coalescing の promotion は本来 wakeAt タイマー駆動だが、背景タブの setTimeout
  // throttling や極端に短い本文で完走が promotion より先に来た場合、ここで拾わないと続報が消える。
  if (lane.coalescedRevision != null) {
    lane.current = { ...lane.coalescedRevision, runIndex: 0, segmentIndex: 0, revisionAt: now };
    lane.coalescedRevision = null;
    lane.revisionFirstQueuedAt = null;
    lane.revisionDebounceUntil = null;
    lane.currentStartedAt = now; // 昇格 = 新 current の最短表示起点
    lane.generation += 1;
    return s; // phase は running のまま
  }
  lane.phase = "idle";
  lane.current = null;
  return s;
}

/**
 * fading レーンの current に実測栞を保存する (spec §2-2)。DOM 実測部 (次の栞までの距離) は
 * TickerLane 側で nearBoundary に畳んで渡す。世代ガード + 一つ前丸め + clamp + 単調非減少。
 */
export function onBookmarkCapture(
  state: SchedulerState,
  laneIndex: number,
  firedGeneration: number,
  bookmarkIndex: number,
  nearBoundary: boolean,
): SchedulerState {
  const s = cloneState(state);
  const lane = s.lanes[laneIndex];
  if (lane == null || lane.phase !== "fading" || lane.current == null) return s;
  if (lane.generation !== firedGeneration) return s;
  const rounded = nearBoundary ? bookmarkIndex - 1 : bookmarkIndex;
  const clamped = Math.min(rounded, lane.current.segments.length - 1);
  lane.current = { ...lane.current, segmentIndex: Math.max(lane.current.segmentIndex, clamped) };
  return s;
}

/**
 * fading レーンのフェード完了。firedGeneration ガードで scroll/二重 fade を弾く。
 * current を退避 (自身の新版に superseded なら退避しない)、replacement を current へ昇格 (§4-2)。
 */
export function onFadeComplete(state: SchedulerState, laneIndex: number, firedGeneration: number, now: number): SchedulerState {
  const s = cloneState(state);
  const lane = s.lanes[laneIndex];
  if (lane == null || lane.phase !== "fading" || lane.replacement == null) return s;
  if (firedGeneration !== lane.generation || lane.completedGeneration === lane.generation) return s;
  lane.completedGeneration = lane.generation;

  const prevCurrent = lane.current;
  const replacement = lane.replacement;
  // 退場する job の退避。coalescedRevision (未昇格の同格続報) があれば最新版を頭から退避する (R1 必須2)。
  // replacement が旧 current の新版 (同 groupKey) なら旧 current は superseded → 退避しない。
  if (prevCurrent != null && !(replacement.groupKey != null && replacement.groupKey === prevCurrent.groupKey)) {
    const outgoing = lane.coalescedRevision != null
      ? { ...lane.coalescedRevision, runIndex: 0, segmentIndex: 0 } // 新本文は頭から
      : prevCurrent; // 栞は onBookmarkCapture 保存済み
    evacuate(s, outgoing, now);
  }
  lane.coalescedRevision = null; // 退場したレーンの続報バッファはクリア (retained/discarded を確定)
  lane.revisionFirstQueuedAt = null;
  lane.revisionDebounceUntil = null;
  lane.current = { ...replacement, deferUntil: null, deferKind: null };
  lane.replacement = null;
  lane.phase = "running";
  lane.currentStartedAt = now; // 昇格 = 新 current の最短表示起点
  if (replacement.priority === "high" && (prevCurrent == null || prevCurrent.groupKey !== replacement.groupKey)) {
    lane.highSliceStartedAt = now; // 別 groupKey high への交替でのみ量子を張り直す (同一 groupKey revision 昇格は維持、§7-2)
  }
  s.lastShownAt[replacement.key] = now; // 割込み昇格 = 走行開始 (§4)
  lane.generation += 1;
  return s;
}

/**
 * ticker 全差し替え (snapshot) 時の全 reset。新 catalog から作り直す (§6)。
 * generationSeed に旧 state の全レーン generation の最大値を渡すと、世代が reset を跨いで
 * 単調増加し、旧 DOM 再利用・旧遅延イベントの誤通過を防ぐ (Critical 1)。
 */
export function resetScheduler(catalog: TickerJob[], generationSeed = 0): SchedulerState {
  return createSchedulerState(catalog, generationSeed);
}

/** state の全レーン generation の最大値 (reset の generationSeed に使う)。 */
export function maxLaneGeneration(s: SchedulerState): number {
  return s.lanes.reduce((m, l) => Math.max(m, l.generation), 0);
}

/** lane / queue / deferred のどこかに purge 対象 job が居るか (no-op 早期 return 判定用)。 */
function hasPurgeTarget(s: SchedulerState, shouldPurge: (job: TickerJob) => boolean): boolean {
  for (const l of s.lanes) {
    if (l.current != null && shouldPurge(l.current)) return true;
    if (l.replacement != null && shouldPurge(l.replacement)) return true;
    if (l.coalescedRevision != null && shouldPurge(l.coalescedRevision)) return true;
  }
  return s.queue.some((j) => shouldPurge(j)) || s.deferred.some((j) => shouldPurge(j));
}

/**
 * shouldPurge(key)==true の job を scheduler から即座に除去する (spec 2026-07-13 フィラー化 R1)。
 * catalog 縮小の毎 effect 同期は「巡回補充で再登場させない」だけで、既に current/queue/deferred へ
 * 割り当て済みの job は保持したまま完走させる。緊急遷移で lines から外した Tips (フィラー) がそのまま
 * 走行 / 退避で緊急画面に残るのを防ぐため、モード遷移時に明示的に除去する経路を用意する。
 * 対象が居なければ入力 state をそのまま返す (無用な再割当を避ける)。
 *
 * 除去規則:
 *  - fading の replacement が対象 → レーンを idle 化 (退場中の current も一緒に落とす)
 *  - running current が対象 → レーンを idle 化 (generation +1 で purge した要素の遅延 animationend を無効化)
 *  - fading current が対象で replacement は非対象 → 割込んできた replacement を **即時 running へ昇格**し
 *    generation を進める。退場中の旧 current (対象) は退避せず破棄する。ここで current を null 化するだけ
 *    だと、描画側 (TickerLane) が job==null で fade 要素を外して animationend が発火せず、replacement が
 *    fading のまま永久停止する (Codex critical)。fade 演出 (150ms) を省いて完了状態まで進めるのは、緊急
 *    遷移という文脈では意味的にも自然
 *  - coalescedRevision が対象 → その続報バッファをクリア
 *  - queue / deferred の対象 → filter で除去
 *
 * 述語は job を受け取り kind で判定する (旧 key prefix 判定を廃止、2026-07-14)。
 */
export function purgeJobs(state: SchedulerState, shouldPurge: (job: TickerJob) => boolean, now: number): SchedulerState {
  if (!hasPurgeTarget(state, shouldPurge)) return state;
  const s = cloneState(state);
  for (let i = 0; i < s.lanes.length; i++) {
    const lane = s.lanes[i]!;
    const replacementPurge = lane.replacement != null && shouldPurge(lane.replacement);
    const currentPurge = lane.current != null && shouldPurge(lane.current);

    if (replacementPurge) {
      // 割込んできた job 自体が対象 → レーンごと idle 化 (退場中 current も一緒に落とす)
      s.lanes[i] = idleLane(lane.generation + 1);
      continue;
    }
    if (currentPurge && lane.phase === "fading" && lane.replacement != null) {
      // 退場中の current(対象) を fade を省いて破棄し、割込んできた replacement(非対象) を即 running へ昇格。
      // onFadeComplete の昇格経路と同じ状態更新を行う (退避だけは旧 current が purge 対象なのでスキップ)。
      const replacement = lane.replacement;
      const outgoing = lane.current; // 破棄する対象 (退避しない)
      lane.current = { ...replacement, deferUntil: null, deferKind: null };
      lane.replacement = null;
      lane.coalescedRevision = null;
      lane.revisionFirstQueuedAt = null;
      lane.revisionDebounceUntil = null;
      lane.phase = "running";
      lane.currentStartedAt = now; // 昇格 = 新 current の最短表示起点
      if (replacement.priority === "high" && (outgoing == null || outgoing.groupKey !== replacement.groupKey)) {
        lane.highSliceStartedAt = now; // 別 groupKey high への交替で量子を張り直す (§7-2)
      }
      s.lastShownAt[replacement.key] = now;
      lane.generation += 1;
      continue;
    }
    if (currentPurge) {
      // running (割込みなし) の current が対象 → レーンを idle 化。generation を進めて purge 済み要素の
      // 遅延 animationend が新状態を通過しないようにする
      s.lanes[i] = idleLane(lane.generation + 1);
      continue;
    }
    if (lane.coalescedRevision != null && shouldPurge(lane.coalescedRevision)) {
      lane.coalescedRevision = null;
      lane.revisionFirstQueuedAt = null;
      lane.revisionDebounceUntil = null;
    }
  }
  s.queue = s.queue.filter((j) => !shouldPurge(j));
  s.deferred = s.deferred.filter((j) => !shouldPurge(j));
  return s;
}
