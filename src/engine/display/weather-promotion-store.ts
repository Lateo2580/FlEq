/**
 * 気象警報の昇格 lifecycle を持つストア。
 *
 * DisplayStateStore ではなく monitor が所有する (standby active-state と同じ所有形)。
 * 昇格の時計は「電文を受理してからの壁時計経過」であって display セッションの都合ではないため、
 * REPL の `display off` → `on` で runtime ごと作り直されても lifecycle を途切れさせない。
 * 時刻は全メソッドで nowMs 注入 (クラス内で Date.now() を呼ばない)。
 */

import * as log from "../../logger";
import {
  WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS,
  WEATHER_PROMOTION_DEMOTE_MIN,
} from "./constants";
import type {
  DisplayWeatherAlertV1,
  DisplayWeatherPromotionLevelV1,
  DisplayWeatherSourceV1,
} from "./types";
import { classifyWeatherPromotion, WEATHER_PROMOTION_SOURCES } from "./weather-promotion";

const MIN_MS = 60_000;

/**
 * 気象警報の昇格状態 (source 別)。demoted は主役パネルからの降格だけを意味し、
 * 警報自体は継続しているので tier 維持のため level を保持する (level: null を持たせない)。
 * signature は「昇格対象 item の集合」で、変化時に generation を更新する判定に使う。
 */
export type WeatherPromotionRecord =
  | {
      state: "active";
      level: DisplayWeatherPromotionLevelV1;
      promotedAtMs: number;
      generation: number;
      signature: string;
    }
  | {
      state: "demoted";
      level: DisplayWeatherPromotionLevelV1;
      generation: number;
      signature: string;
    };

/** 永続化・復元の受け渡し形 (シリアライズ可能な素直な構造)。wire プロトコルには載らない */
export interface WeatherPromotionPersistedV1 {
  records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null>;
  /** record 削除後も保持する source 別 generation watermark */
  generations: Record<DisplayWeatherSourceV1, number>;
}

export class WeatherPromotionStore {
  private records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null> = {
    vpws50: null, vpww56: null,
  };
  /** record 削除後も保持する generation watermark。500ms debounce 内の「解除 → 再発表」で
   *  同じ generation に戻らないよう nullable record の外に置く */
  private generations: Record<DisplayWeatherSourceV1, number> = { vpws50: 0, vpww56: 0 };
  private durableListener: (() => void) | null = null;

  /** 永続化が必要な変化 (昇格・再開・降格・解除) の通知先。受信コールスタック上で I/O しない */
  onDurable(listener: (() => void) | null): void {
    this.durableListener = listener;
  }

  get(source: DisplayWeatherSourceV1): WeatherPromotionRecord | null {
    return this.records[source];
  }

  /**
   * 1 source 分の気象カード view から昇格状態を更新する。source は完全に独立で、
   * 呼ばれなかった source の record には一切触れない (hub が両 source を再射影しても
   * 時計を動かすのは受信した source だけ)。呼び出し側は confirmed な更新でだけ呼ぶこと
   * (state 非更新のまま outcome が通る unsafe 報を再昇格契機にしない)。
   * nowMs は engine 受理時刻 — 電文の updatedAt / reportDateTime は判定に使わない。
   */
  apply(source: DisplayWeatherSourceV1, view: DisplayWeatherAlertV1[], nowMs: number): boolean {
    const next = classifyWeatherPromotion(view);
    const prev = this.records[source];
    if (next == null) {
      // 高 severity 集合が空 = 警報解除。demote ではなく即終了 (watermark は保持)
      if (prev == null) return false;
      this.records[source] = null;
      this.notifyDurable();
      return true;
    }
    // 内容が同じ続報は generation 据置で 30 分だけ再開、変化 (L4→L5・地域追加・L5→L4) は
    // watermark から新しい generation を採って再開する。
    // signature が変われば増減の方向によらず generation を更新する — L5 地域が減る等の縮退も
    // 「別内容の昇格」として扱う (spec は上位遷移しか明記していないが、フロントが generation を
    // 再アニメーションの契機に使うなら縮退も新しい表示として扱うのが素直なため)
    const unchanged = prev != null && prev.level === next.level && prev.signature === next.signature;
    const generation = unchanged ? prev.generation : ++this.generations[source];
    this.records[source] = {
      state: "active",
      level: next.level,
      promotedAtMs: nowMs,
      generation,
      signature: next.signature,
    };
    this.notifyDurable();
    return true;
  }

  /**
   * 「30 分 + 最大 5 秒」の降格。classifier は受理時のみ走らせ、ここでは active → demoted の
   * 遷移だけを行う (record 削除は解除受理の責務)。
   */
  sweepDemote(nowMs: number): boolean {
    let changed = false;
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const rec = this.records[source];
      if (rec == null || rec.state !== "active") continue;
      if (nowMs - rec.promotedAtMs <= WEATHER_PROMOTION_DEMOTE_MIN * MIN_MS) continue;
      this.records[source] = {
        state: "demoted", level: rec.level, generation: rec.generation, signature: rec.signature,
      };
      changed = true;
    }
    if (changed) this.notifyDurable();
    return changed;
  }

  /** 永続化用の lifecycle 一式 (promotedAtMs / state / generation / watermark)。 */
  export(): WeatherPromotionPersistedV1 {
    return { records: { ...this.records }, generations: { ...this.generations } };
  }

  /**
   * 起動時復元。**残り時間だけを復元する** (再起動による延命を作らない):
   * - 既に 30 分経過済みの active → demoted として格納 (record は消さない。警報自体は継続しうる)
   * - promotedAtMs が許容誤差を超えて未来 → **record を破棄する** (demoted にもしない)。
   *   RTC を持たない Pi で NTP 同期前に起動すると保存時刻が未来になりえるが、そのとき
   *   「30 分経ったか」も「まだ有効か」も判定できない。demoted で残すと tier と
   *   weatherL5Active だけが無期限に固定される最悪の縮退になるため、判定不能なら捨てる。
   *   警報が継続していれば VPWS50 の定期再掲ですぐ再昇格する
   * - それ以外の active → promotedAtMs をそのまま引き継ぐ (残り時間が減った状態で復元される)
   *
   * generation は必ず維持し、watermark は保存値と record の generation の大きい方を採る
   * (record を破棄しても watermark は残すので generation は再利用されない)。
   */
  restore(state: WeatherPromotionPersistedV1, nowMs: number): void {
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const saved = state.records[source] ?? null;
      const record = saved == null ? null : reviveRecord(saved, nowMs, source);
      this.records[source] = record;
      this.generations[source] = Math.max(
        state.generations[source] ?? 0,
        saved?.generation ?? 0,
      );
    }
  }

  /**
   * display runtime の起動 (`display on` 含む) 時に経過判定だけを通す。
   *
   * 昇格の受信更新は monitor の displaySink が display の on/off に関わらず行うので、
   * off 中の新規昇格・続報・解除はここに来る時点で反映済み。したがって view と record を
   * 突き合わせる reconcile は不要 (view から昇格させない原則も自動的に守られる)。
   *
   * 残る仕事は 30 分降格だけ。降格 sweep は hub の 5 秒タイマー駆動なので display off 中は
   * 止まっており、`display on` の直後に経過済みの active が初回 sweep まで最大 5 秒
   * 見えてしまう。それを塞ぐために復元時と同じ規則をここでも通す。
   */
  resume(nowMs: number): boolean {
    let changed = false;
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const current = this.records[source];
      if (current == null) continue;
      const next = reviveRecord(current, nowMs, source);
      if (next !== current) {
        this.records[source] = next;
        changed = true;
      }
    }
    if (changed) this.notifyDurable();
    return changed;
  }

  private notifyDurable(): void {
    this.durableListener?.();
  }
}

/** null = この record は復元しない (判定不能なので捨てる) */
function reviveRecord(
  record: WeatherPromotionRecord,
  nowMs: number,
  source: DisplayWeatherSourceV1,
): WeatherPromotionRecord | null {
  if (record.state !== "active") return record;
  const elapsed = nowMs - record.promotedAtMs;
  if (elapsed < -WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS) {
    log.warn(
      `[weather-promotion] 保存時刻が未来で経過を判定できないため ${source} の昇格を破棄しました ` +
      `(promotedAtMs=${record.promotedAtMs})`,
    );
    return null;
  }
  if (elapsed > WEATHER_PROMOTION_DEMOTE_MIN * MIN_MS) {
    return { state: "demoted", level: record.level, generation: record.generation, signature: record.signature };
  }
  return record;
}
