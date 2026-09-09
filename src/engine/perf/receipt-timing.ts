import * as log from "../../logger";

/**
 * 電文受理経路の所要時間計測 (spec `docs/specs/2026-09-08-receipt-path-timing-log.md`)。
 *
 * 目的は**帰属の確定であって削減ではない**。どの区間が何 ms 食っているかを実機の数字で
 * 確定させるための一時的な計測で、既定 off・挙動不変を厳格に守る。
 *
 * - 環境変数 `FLEQ_PERF_RECEIPT=1` を **module load 時に 1 回だけ**読む
 *   (`FLEQ_STANDBY_SWEEP_STRICT` と同じ作法。実行中の `process.env` 変更は反映しない)
 * - off のときのコストは `collector === null` の分岐 1 回と、呼び出し側が作るクロージャ
 *   1 個だけ。`performance.now()` を呼ばず、collector も文字列も作らない
 * - `JSON.stringify` / `structuredClone` / `Date.now()` を hot path に足さない
 * - `mark` は `try` / `finally` で計測を閉じ、例外はそのまま再 throw する
 */

/**
 * 電文行 `[perf-receipt]` に載る区間キー。出力順もこの並びで固定する。
 *
 * `serIn` / `serEnc` は `serD` / `serB` / `save` の**内数**で、1 電文ぶんを合算する
 * (`redParse` が `red` の内数なのと同じ読み方。入れ子は親から引かない)。
 * `sched` は `scheduleSerializedPair` — commit 後の pair を pending に載せるまで。
 */
export type Segment =
  | "sweepPre"
  | "cap"
  | "draft"
  | "red"
  | "redParse"
  | "diff"
  | "serD"
  | "serB"
  | "serIn"
  | "serEnc"
  | "pre"
  | "commit"
  | "save"
  | "sched";

const RECEIPT_SEGMENT_ORDER: readonly Segment[] = [
  "sweepPre",
  "cap",
  "draft",
  "red",
  "redParse",
  "diff",
  "serD",
  "serB",
  "serIn",
  "serEnc",
  "pre",
  "commit",
  "save",
  "sched",
];

/** `sweepAll` の成功出口 3 つ。到達しなかった場合 (rejected / staleVersion) は `skipped`。 */
export type SweepPath = "precheck" | "nochange" | "full";

/** `id` は先頭 16 文字に切る (電文本文・subject 名・地域名はログに出さない)。 */
const MAX_ID_CHARS = 16;

let enabled = process.env.FLEQ_PERF_RECEIPT === "1";

/**
 * module スコープに保持する時計参照。受入 A1 (off で `performance.now` を 1 回も呼ばない)
 * はグローバルの `performance.now` を spy しても測れない — 本番コードが既に別用途で使って
 * いるため (`quake-extreme-store.ts:106`、`hub.ts:139`)。この参照を注入可能にして数える。
 */
const defaultClock = (): number => performance.now();
let clock: () => number = defaultClock;

/** テスト専用。計測の有効/無効を切り替え、直前の値を返す (finally で必ず戻すこと)。 */
export function __test_setReceiptPerfEnabled(value: boolean): boolean {
  const previous = enabled;
  enabled = value;
  if (!value) {
    collector = null;
    turn = null;
    stateStartedAt = null;
  }
  return previous;
}

/** テスト専用。時計参照を差し替え、直前の値を返す (finally で必ず戻すこと)。 */
export function __test_setReceiptPerfClock(next: (() => number) | null): () => number {
  const previous = clock;
  clock = next ?? defaultClock;
  return previous;
}

export function receiptPerfEnabled(): boolean {
  return enabled;
}

interface ReceiptCollector {
  readonly kind: "receipt";
  readonly id: string;
  readonly type: string;
  readonly route: string;
  readonly bytes: number;
  readonly startedAt: number;
  readonly segments: Partial<Record<Segment, number>>;
  serCalls: number;
  admission: string | null;
  sweepPath: SweepPath | null;
  /**
   * `mark("sweepPre")` の内側にいる間だけ true。`setSweepPath` の guard に使う。
   *
   * 受理コールスタック上には `sweepStandbyBeforeAdmission` 以外の `sweepAll` もある
   * (`volcano-route-handler.ts:186` / `:230` の `sweepStatefulFoundation`)。guard が無いと
   * それらが `sweepPath` を上書きし、`sweepPre=<ms>/<path>` の ms と path が別々の sweep を
   * 指す行が出る。計測しなかった sweep の出口は記録しない。
   */
  inSweepPreMark: boolean;
}

interface SweepCollector {
  readonly kind: "sweep";
  readonly startedAt: number;
  readonly segments: Partial<Record<Segment, number>>;
  serCalls: number;
  path: SweepPath | null;
  changedKeys: number;
  durable: boolean;
}

/**
 * 3 状態 (`null` / receipt / sweep)。`null` のとき `mark` は計測せず素通しする。
 * `transactInternal` と `sweepAll` は受理経路の外からも呼ばれるので (startup 復元・
 * 火山 REST repair・briefing critical・startup sweep)、素通しにしないとそれらの区間が
 * 直前の電文行へ誤って加算される。
 */
let collector: ReceiptCollector | SweepCollector | null = null;

interface TurnState {
  readonly startedAt: number;
  readonly heapBefore: number;
}

let turn: TurnState | null = null;
let stateStartedAt: number | null = null;

function ms(value: number): string {
  return value.toFixed(1);
}

function truncateId(id: string): string {
  return id.length > MAX_ID_CHARS ? id.slice(0, MAX_ID_CHARS) : id;
}

/**
 * 未確定の collector を捨てる。黙って捨てると計測点の取り付け漏れが露出しないので、
 * receipt を捨てるときは必ず 1 行残す。**この行が出たら計測点が漏れている。**
 */
function discardCollector(reason: string): void {
  const active = collector;
  collector = null;
  if (active === null || active.kind !== "receipt") return;
  log.info(`[perf-receipt-lost] id=${truncateId(active.id)} reason=${reason}`);
}

/**
 * 区間を計測する。collector が `null` なら計測せず素通しする。入れ子は許す
 * (`red` の中に `redParse`)。入れ子分は親から引かない — 行の読み手が
 * 「`red` のうち `redParse` が内数」と読める形にする。
 */
export function mark<T>(segment: Segment, fn: () => T): T {
  const active = collector;
  if (active === null) return fn();
  const guarded = segment === "sweepPre" && active.kind === "receipt" ? active : null;
  const previousGuard = guarded?.inSweepPreMark ?? false;
  if (guarded !== null) guarded.inSweepPreMark = true;
  const startedAt = clock();
  try {
    return fn();
  } finally {
    active.segments[segment] = (active.segments[segment] ?? 0) + (clock() - startedAt);
    if (guarded !== null) guarded.inSweepPreMark = previousGuard;
  }
}

/** `this.serializePair` の呼び出しを 1 回数える (P4、コンストラクタのラッパから)。 */
export function countSerializePair(): void {
  if (collector !== null) collector.serCalls += 1;
}

/**
 * `transactInternal` の戻り値から `admit=` を決める (P3i)。早期 return が 8 本あるので
 * 各 return に散らさず、出口 1 箇所のラッパから呼ぶ。
 */
export function setAdmissionResult(kind: string, reason?: string): void {
  const active = collector;
  if (active === null || active.kind !== "receipt") return;
  active.admission = reason == null ? kind : `${kind}:${reason}`;
}

/**
 * `sweepAll` の成功出口 3 つを区別する (P2')。上 2 つは戻り値が同一なので
 * 呼び出し側からは区別できない。
 */
export function setSweepPath(path: SweepPath, changedKeys: number, durable: boolean): void {
  const active = collector;
  if (active === null) return;
  if (active.kind === "receipt") {
    // 計測した受理前 sweep の出口だけを記録する (`inSweepPreMark` の説明を参照)。
    if (active.inSweepPreMark) active.sweepPath = path;
    return;
  }
  active.path = path;
  active.changedKeys = changedKeys;
  active.durable = durable;
}

/** 電文 1 通の境界を開く (P0')。`endReceipt` は必ず `finally` から呼ぶこと。 */
export function beginReceipt(id: string, type: string, route: string, bytes: number): void {
  if (!enabled) return;
  discardCollector("overwritten");
  collector = {
    kind: "receipt",
    id,
    type,
    route,
    bytes,
    startedAt: clock(),
    segments: {},
    serCalls: 0,
    admission: null,
    sweepPath: null,
    inSweepPreMark: false,
  };
}

/** 電文 1 通の境界を閉じ、`[perf-receipt]` を 1 行出す。collector が無ければ何もしない。 */
export function endReceipt(): void {
  const active = collector;
  if (active === null) return;
  if (active.kind !== "receipt") {
    // sweep collector を receipt の closer で閉じるのは配線の誤り。黙って残すと
    // 次の `beginReceipt` まで生き延びて誤帰属するので、ここで捨てて 1 行残す。
    collector = null;
    log.info("[perf-receipt-lost] id=- reason=kindMismatch");
    return;
  }
  collector = null;
  const total = clock() - active.startedAt;
  let line = `[perf-receipt] id=${truncateId(active.id)} type=${active.type}`
    + ` route=${active.route} bytes=${active.bytes}`
    + ` admit=${active.admission ?? "none"} serCalls=${active.serCalls}`
    + ` total=${ms(total)}`;
  for (const segment of RECEIPT_SEGMENT_ORDER) {
    const value = active.segments[segment];
    // 区間キーが立たなかった場合はそのキーごと出さない (値 0 と「未通過」を混同させない)。
    if (value == null) continue;
    line += segment === "sweepPre"
      ? ` sweepPre=${ms(value)}/${active.sweepPath ?? "skipped"}`
      : ` ${segment}=${ms(value)}`;
  }
  log.info(line);
}

/** 5 秒タイマー経由の sweep 1 回の境界を開く (P8)。受理前 sweep はこちらには出ない。 */
export function beginSweep(): void {
  if (!enabled) return;
  discardCollector("sweepOverwrote");
  collector = {
    kind: "sweep",
    startedAt: clock(),
    segments: {},
    serCalls: 0,
    path: null,
    changedKeys: 0,
    durable: false,
  };
}

/**
 * sweep の境界を閉じ、`[perf-sweep]` を 1 行出す。成功出口に到達しなかったとき
 * (sweep が配線されていない / rejected / staleVersion) は行を出さない。
 */
export function endSweep(): void {
  const active = collector;
  if (active === null) return;
  if (active.kind !== "sweep") {
    discardCollector("kindMismatch");
    return;
  }
  collector = null;
  if (active.path === null) return;
  const total = clock() - active.startedAt;
  log.info(
    `[perf-sweep] path=${active.path} total=${ms(total)} serCalls=${active.serCalls}`
    + ` changedKeys=${active.changedKeys} durable=${active.durable}`,
  );
}

/** turn の境界を開く (P0)。`heapUsed` は turn 単位で 2 回だけ読む。 */
export function beginTurn(): void {
  if (!enabled) return;
  // `[perf-receipt-lost]` の対。turn が閉じないまま次の turn が始まったら 1 行残す。
  if (turn !== null) log.info("[perf-turn-lost] reason=overwritten");
  turn = { startedAt: clock(), heapBefore: process.memoryUsage().heapUsed };
}

/** turn の境界を閉じ、`[perf-turn]` を 1 行出す。 */
export function endTurn(envelopes: number): void {
  const active = turn;
  if (active === null) return;
  turn = null;
  const total = clock() - active.startedAt;
  const heapDeltaMB = (process.memoryUsage().heapUsed - active.heapBefore) / (1024 * 1024);
  log.info(
    `[perf-turn] envelopes=${envelopes} total=${ms(total)} heapDeltaMB=${heapDeltaMB.toFixed(1)}`,
  );
}

/**
 * `createEnvelope` 1 回を計測して `[perf-env]` を 1 行出す (P1)。turn 開始より前に走り、
 * 再入電文では別電文の receipt の内側で走るので、電文行の区間にはできない。
 */
export function measureEnvelope<T extends { readonly ordinal: number; readonly byteLength: number }>(
  fn: () => T,
): T {
  if (!enabled) return fn();
  const startedAt = clock();
  const envelope = fn();
  const elapsed = clock() - startedAt;
  log.info(
    `[perf-env] ordinal=${envelope.ordinal} ms=${ms(elapsed)} bytes=${envelope.byteLength}`,
  );
  return envelope;
}

/** state debounce コールバックの縮退ラダー区間を開く (P7)。 */
export function beginState(): void {
  if (!enabled) return;
  stateStartedAt = clock();
}

/**
 * 縮退ラダー区間を閉じ、`[perf-state]` を 1 行出す。**`bytes=` は出さない** —
 * `SnapshotDegradeResult` は wire バイト数を持たず、出すには新しい `JSON.stringify` が
 * 要るため (spec §2.6 / §3.5)。`level` が負のときは縮退結果が無い (配信スキップ)。
 */
export function endState(level: number, ladders: number): void {
  const startedAt = stateStartedAt;
  if (startedAt === null) return;
  stateStartedAt = null;
  const total = clock() - startedAt;
  log.info(`[perf-state] total=${ms(total)} level=${level} ladders=${ladders}`);
}
