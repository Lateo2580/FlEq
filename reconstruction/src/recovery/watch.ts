import type { ConfirmationScope, RuntimeUnitId } from "../../contracts/p2-shared-runtime.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { EewWindowCard, ListHead } from "../../contracts/p3-recovery.types";

// P3-RECOVERY-001【発注 2】: publisher が run の中だけで持つ 2 つの見張り。鮮度の突き合わせの帳簿（H41）と、切れていた間の EEW の札（H28）。
// どちらも保存しない（再起動の間は穴 d として取り直しが埋める）。時計はどれも host の時計で、dmdata の時刻と host の wall を比べない。

const PENDING_MS = 2 * 60_000; // P3-REC-AC13 (3)(b): 一覧で初めて見てから live で受けるまでの保留（置き値）
const SWEEP_MS = 30 * 60_000; // P3-REC-AC13 (3)(c3): 一覧の反映の遅れを覆う余白（置き値）
const UNIT_LIMIT = 4_096; // P3-REC-RET-02: unit ごとの受信済みと保留の和
const EEW_WINDOW_MS = 10 * 60_000; // P3-REC-D-EEW-WINDOW=A: 繋がり直してから札を外すまで

type UnitScope = Extract<ConfirmationScope, { kind: "unit" }>;
type Pending = Readonly<{ scope: UnitScope; sinceMs: number; epoch: number; receivedAtMs: number }>; // receivedAtMs は一覧の receivedTime（dmdata の時刻）

/**
 * live で受けた電文の id と一覧の id の照合（P3-REC-AC13 (3)・RET-02）。無いと: 繋がったまま一部の報だけ届かない不達（8 日の実例）に気付けない。
 * 受信済みの id は区分ごとに受けた順の Map（受けた時の monotonic は単調なので、時間の掃除は先頭から条件の合う所までで償却 O(1)）。
 * 保留は id ごとに初めて一覧で見た順の Map（compare の now も単調なので、満了は先頭から）。件数は unit ごとに数える。
 */
class FreshnessLedger {
  private readonly receivedIds = new Map<DmdataClassification, Map<string, Readonly<{ unit: RuntimeUnitId; atMs: number }>>>();
  private readonly pending = new Map<string, Pending>();
  private readonly counts = new Map<RuntimeUnitId, number>();
  // RET-02 の上限で受信済みに足せなかった id があった unit と、最後に捨てた時刻（区分ごと）。捨てた id のどれかが一覧に出うる間は突き合わせない。
  private readonly overflow = new Map<DmdataClassification, Map<RuntimeUnitId, number>>();

  /** live の受信 1 回に O(1)。保留にあればそこで外し、受信済みには足さない（P3-REC-RET-02）。 */
  received(unit: RuntimeUnitId, classification: DmdataClassification, dmdataId: string, atMonotonicMs: number): void {
    const waiting = this.pending.get(dmdataId);
    if (waiting != null) { this.pending.delete(dmdataId); this.count(waiting.scope.unit, -1); return; }
    let ids = this.receivedIds.get(classification);
    if (ids == null) this.receivedIds.set(classification, ids = new Map());
    if (ids.has(dmdataId)) return;
    if ((this.counts.get(unit) ?? 0) >= UNIT_LIMIT) {
      let marks = this.overflow.get(classification);
      if (marks == null) this.overflow.set(classification, marks = new Map());
      // 捨てるたびに最後の時刻へ進める（最初の時刻のままだと、後で捨てた id の保護が先に外れる。発注 2 のレビュー ヘルツ P2）。
      marks.set(unit, atMonotonicMs);
      return;
    }
    ids.set(dmdataId, { unit, atMs: atMonotonicMs });
    this.count(unit, 1);
  }

  /**
   * 区分の全ページが揃い epoch が合った後に同期で 1 回（P3-REC-AC13 (3)）。(a) 一致を外す → (b) 受けていない id を保留に足す（始まりは now）→
   * (c) 区分の最後の成功を cycleStartMonotonicMs（その周期で最初の一覧の要求を出す直前）として、受けた時刻がそれより 30 分前の id を消す。
   * 消すのはこの区分の id だけ。unmatched は RET-02 の上限で突き合わせできなかった unit（疑いにも確認にもしない）。O(heads＋消した id)。
   */
  compare(classification: DmdataClassification, heads: readonly ListHead[], epoch: number, cycleStartMonotonicMs: number,
    nowMonotonicMs: number): Readonly<{ unmatched: readonly RuntimeUnitId[] }> {
    const ids = this.receivedIds.get(classification);
    const missing = new Map<string, ListHead>();
    const adding = new Map<RuntimeUnitId, number>();
    // 同じ id がページの間に重なって来ても 1 回だけ見る（一致で外した後の 2 件目を未受信と数えない。発注 2 のレビュー ヘルツ P2）。
    const seen = new Set<string>();
    for (const head of heads) {
      if (seen.has(head.id)) continue;
      seen.add(head.id);
      const hit = ids?.get(head.id);
      if (ids != null && hit != null) { ids.delete(head.id); this.count(hit.unit, -1); }
      else if (!this.pending.has(head.id)) {
        missing.set(head.id, head);
        adding.set(head.unit, (adding.get(head.unit) ?? 0) + 1);
      }
    }
    const marks = this.overflow.get(classification);
    const unmatched = new Set<RuntimeUnitId>();
    for (const [unit, added] of adding)
      if (marks?.has(unit) || (this.counts.get(unit) ?? 0) + added > UNIT_LIMIT) unmatched.add(unit);
    for (const head of missing.values()) if (!unmatched.has(head.unit)) {
      this.pending.set(head.id, { scope: { unit: head.unit, kind: "unit", operation: head.operation }, sinceMs: nowMonotonicMs, epoch,
        receivedAtMs: head.receivedAtMs });
      this.count(head.unit, 1);
    }
    const before = cycleStartMonotonicMs - SWEEP_MS;
    if (ids != null) for (const [id, entry] of ids) {
      if (entry.atMs >= before) break;
      ids.delete(id);
      this.count(entry.unit, -1);
    }
    if (marks != null) for (const [unit, atMs] of marks) if (atMs < before) marks.delete(unit);
    return { unmatched: [...unmatched] };
  }

  /**
   * publisher の 1 秒の tick で呼ぶ。初めて見てから 2 分を越えた保留を、立てる疑いとして返して外す（unit と運用区分で 1 つ）。
   * oldestReceivedAtMs はその scope の保留のうち最も古い一覧の receivedTime（鮮度で起こす取り直しの起点、P3-REC-AC02 (7)）。
   */
  expire(nowMonotonicMs: number): readonly Readonly<{ epoch: number; scope: UnitScope; oldestReceivedAtMs: number }>[] {
    const due = new Map<string, Readonly<{ epoch: number; scope: UnitScope; oldestReceivedAtMs: number }>>();
    for (const [id, entry] of this.pending) {
      if (nowMonotonicMs - entry.sinceMs < PENDING_MS) break;
      this.pending.delete(id);
      this.count(entry.scope.unit, -1);
      const key = `${entry.epoch}/${entry.scope.unit}/${entry.scope.operation}`;
      due.set(key, { epoch: entry.epoch, scope: entry.scope,
        oldestReceivedAtMs: Math.min(due.get(key)?.oldestReceivedAtMs ?? Infinity, entry.receivedAtMs) });
    }
    return [...due.values()];
  }

  /** 切断で全部捨てる（P3-REC-AC13 (1)）。 */
  reset(): void {
    this.receivedIds.clear();
    this.pending.clear();
    this.counts.clear();
    this.overflow.clear();
  }

  private count(unit: RuntimeUnitId, delta: number): void {
    this.counts.set(unit, (this.counts.get(unit) ?? 0) + delta);
  }
}

/**
 * 切れていた間の EEW の札（P3-REC-AC14）。無いと: 切れていた間に EEW が出たかもしれないことが画面にも履歴にも残らない。
 * 札は 1 枚（P3-REC-D-EEW-WINDOW-OVERLAP=A）。始まりは切断の前に受けた最後の frame の wall（起動から 1 つも受けていなければ起動の時刻、
 * P3-REC-D-EEW-WINDOW-NEVER=A）、終わりは新しい WS で最初に受けた start か data の wall。10 分は最後の繋がり直しから monotonic で数える。
 */
class EewWindow {
  // fromWallMs: 窓の始まり。toWallMs: 繋がり直した時の wall（札が出ている間だけ）。connectedAtMs: 最後の繋がり直しの monotonic（切れている間は null）。
  private window: { fromWallMs: number; toWallMs: number | null; connectedAtMs: number | null } | null = null;

  constructor(private readonly startupWallMs: number) {}

  /** 切断。切れている間の次の切断（frame を受けずに切れた再接続）は始まりを動かさない。札が出ている間の切断は始まりを保つ。 */
  lost(lastFrameWallMs: number | null): void {
    if (this.window == null) this.window = { fromWallMs: lastFrameWallMs ?? this.startupWallMs, toWallMs: null, connectedAtMs: null };
    else this.window.connectedAtMs = null;
  }

  /** 繋がり直し。切れている間だけ終わりを置き、10 分を数え直す。 */
  connected(firstFrameWallMs: number, atMonotonicMs: number): void {
    if (this.window == null || this.window.connectedAtMs != null) return;
    this.window.toWallMs = firstFrameWallMs;
    this.window.connectedAtMs = atMonotonicMs;
  }

  /** 1 秒の tick。card は snapshot に載せる札、expired は 10 分で外した札（WARN 診断にする）。 */
  tick(nowMonotonicMs: number): Readonly<{ card: EewWindowCard | null; expired: EewWindowCard | null }> {
    const current = this.card();
    if (current == null || this.window?.connectedAtMs == null || nowMonotonicMs - this.window.connectedAtMs < EEW_WINDOW_MS)
      return { card: current, expired: null };
    this.window = null;
    return { card: null, expired: current };
  }

  /** 停止の開始。残っている札を出す。切れている間なら [始まり, 停止の開始] の窓にする。 */
  stop(stopWallMs: number): EewWindowCard | null {
    const window = this.window;
    this.window = null;
    if (window == null) return null;
    return { fromWallMs: window.fromWallMs, toWallMs: window.connectedAtMs == null ? stopWallMs : window.toWallMs ?? stopWallMs };
  }

  card(): EewWindowCard | null {
    return this.window?.toWallMs == null ? null : { fromWallMs: this.window.fromWallMs, toWallMs: this.window.toWallMs };
  }
}

export { EewWindow, FreshnessLedger };
