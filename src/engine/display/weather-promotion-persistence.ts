/**
 * 気象警報の昇格 lifecycle をローカル JSON へ保存・復元する。
 * 作法は standby-persistence.ts に揃える (debounce 予約 → 非同期で tmp write + rename、
 * 終了時は dispose() → save() で書き切る)。
 *
 * 津波・火山のような dmdata REST replay は使えない: promotedAtMs は engine の受理時刻、
 * generation は engine 内部のカウンタで、どちらも電文からは再構成できないため。
 */

import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import {
  WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS,
  WEATHER_PROMOTION_MAX_RESTORE_AGE_MS,
} from "./constants";
import type { DisplayWeatherSourceV1 } from "./types";
import { WEATHER_PROMOTION_SOURCES } from "./weather-promotion";
import type { WeatherPromotionPersistedV1, WeatherPromotionRecord } from "./weather-promotion-store";

const PERSIST_SCHEMA_VERSION = 1;

/** standby-persistence と同じ debounce 窓。失うのは強制電源断の直前この秒数ぶん */
const SAVE_DEBOUNCE_MS = 3000;

export interface PersistedWeatherPromotionV1 extends WeatherPromotionPersistedV1 {
  version: 1;
  savedAt: string;
}

/** Date が表現できる絶対値の上限 (ECMA-262)。有限でもこれを超える ms は Date 化で RangeError */
const MAX_TIME_VALUE = 8.64e15;

export class WeatherPromotionPersistence {
  private pending: { state: PersistedWeatherPromotionV1; seq: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** 内容を確定した順の通し番号。書き込み完了の順序が入れ替わっても最新が勝つようにする */
  private seq = 0;
  /** 実際に rename まで到達した最大 seq。これより古い書き込みは rename せずに捨てる */
  private renamedSeq = 0;

  constructor(
    private readonly persistPath: string,
    private readonly debounceMs: number = SAVE_DEBOUNCE_MS,
  ) {}

  /**
   * 復元データを読む。version 不一致・破損・欠落・古すぎるデータは null で返し、起動は妨げない。
   * source 単位で検証し、片方が壊れていてももう片方は生かす。
   */
  load(nowMs: number): WeatherPromotionPersistedV1 | null {
    this.cleanStaleTmpFiles();
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      if (!isRecord(parsed)) {
        log.warn("[weather-promotion-persistence] top-level structure validation 失敗 — 破棄");
        return null;
      }
      if (parsed.version !== PERSIST_SCHEMA_VERSION) {
        log.debug(
          `[weather-promotion-persistence] schema 世代交代 (v${String(parsed.version)} → v${PERSIST_SCHEMA_VERSION}) — 旧データ破棄`,
        );
        return null;
      }
      const savedAtMs = typeof parsed.savedAt === "string" ? Date.parse(parsed.savedAt) : Number.NaN;
      if (!Number.isFinite(savedAtMs)) {
        log.warn("[weather-promotion-persistence] savedAt が不正 — 破棄");
        return null;
      }
      if (nowMs - savedAtMs > WEATHER_PROMOTION_MAX_RESTORE_AGE_MS) {
        log.debug(`[weather-promotion-persistence] 保存から時間が経ちすぎているため破棄 (savedAt=${String(parsed.savedAt)})`);
        return null;
      }
      // savedAt 自体が未来 = 時計が信用できない。この状態では record の古さを判定できず、
      // demoted record が tier と weatherL5Active を無期限に固定しうるので record を捨てる
      // (promotedAtMs を持たない demoted は record 単位の未来判定では守れないため、ここで落とす)
      const sanitized = sanitizePersisted(parsed);
      if (savedAtMs - nowMs > WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS) {
        log.warn(`[weather-promotion-persistence] 保存時刻が未来のため record を破棄 (savedAt=${String(parsed.savedAt)})`);
        // record は捨てるが watermark は時刻と無関係なので残す。
        // 捨てると次の昇格が generation 1 に戻り「generation を再利用しない」契約が壊れる
        return { records: { vpws50: null, vpww56: null }, generations: sanitized.generations };
      }
      return sanitized;
    } catch (err) {
      log.warn(`[weather-promotion-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * 予約する。debounceMs 後に 1 回だけ非同期で書く。
   * records が全 null (全解除) の状態も必ず書く — 書かないと前回の active が残り、
   * 次の再起動で解除済みの昇格が復活する。
   */
  schedule(state: WeatherPromotionPersistedV1, nowMs: number): void {
    // seq は「内容を確定した時点」で採る。書き込み開始時に採ると、予約 → 同期保存の順で
    // 呼ばれたとき古い内容の方が大きい seq を持ってしまい、順序保証が逆転する
    this.pending = { state: this.envelope(state, nowMs), seq: ++this.seq };
    this.armTimer();
  }

  save(state: WeatherPromotionPersistedV1, nowMs: number): void {
    this.writeSync(this.envelope(state, nowMs), ++this.seq);
  }

  /** 予約済みの状態を同期で書き切る。予約がなければ何もしない (既存ファイルを空書きしない) */
  flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending == null) return;
    this.writeSync(pending.state, pending.seq);
  }

  /** 予約を捨てる (ディスク上の内容は触らない) */
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  /** savedAt は呼び出し側の nowMs から作る (ストア/永続化層で Date.now() を呼ばない) */
  private envelope(state: WeatherPromotionPersistedV1, nowMs: number): PersistedWeatherPromotionV1 {
    return {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      records: state.records,
      generations: state.generations,
    };
  }

  /**
   * rename 前に強制終了すると seq 固有名の tmp が残る (Pi は電源断が起こりうる)。
   * 起動時の load で同ディレクトリの残骸を掃除する。掃除の失敗は起動を妨げない。
   */
  private cleanStaleTmpFiles(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) return;
      const base = path.basename(this.persistPath);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch (err) {
      log.debug(`[weather-promotion-persistence] 残留 tmp の掃除に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** tmp 名は書き込みごとに一意にする (同期・非同期が同じ tmp を奪い合わないため) */
  private tmpPathFor(seq: number): string {
    return `${this.persistPath}.${seq}.tmp`;
  }

  private writeSync(state: PersistedWeatherPromotionV1, seq: number): void {
    const tmpPath = this.tmpPathFor(seq);
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(state), "utf8");
      if (seq < this.renamedSeq) {
        // 既により新しい内容が置かれている。追い越された書き込みは反映しない
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = seq;
    } catch (err) {
      log.warn(`[weather-promotion-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    }
  }

  /** テスト用: 予約済みの書き込みをタイマーを待たずに実行する (実時間依存を避けるため) */
  __test_writePending(): Promise<void> {
    this.clearTimer();
    return this.writePending();
  }

  private armTimer(): void {
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writePending();
    }, this.debounceMs);
    // 保存予約だけでプロセスを生かし続けない (書き切りは flush の責務)
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async writePending(): Promise<void> {
    if (this.writing) return;
    const pending = this.pending;
    if (pending == null) return;
    this.pending = null;
    this.writing = true;
    const tmpPath = this.tmpPathFor(pending.seq);
    try {
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(pending.state), "utf8");
      // ここから rename までは await を挟まない。await で中断すると、guard 通過後・rename 完了前に
      // 同期保存が割り込み、そのあと古い rename が完了して旧内容で上書き + renamedSeq 逆行が起きる。
      // 重い書き込みは非同期のまま、guard と rename だけを同期で不可分に行う
      if (pending.seq < this.renamedSeq) {
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = pending.seq;
    } catch (err) {
      log.warn(`[weather-promotion-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    } finally {
      this.writing = false;
      // 書き込み中に届いた更新は、終わってからもう一度だけ書く
      if (this.pending != null) this.armTimer();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** source 単位で検証する。片方が壊れていても、もう片方は生かす */
function sanitizePersisted(parsed: Record<string, unknown>): WeatherPromotionPersistedV1 {
  const rawRecords = isRecord(parsed.records) ? parsed.records : {};
  const rawGenerations = isRecord(parsed.generations) ? parsed.generations : {};
  const records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null> = {
    vpws50: null, vpww56: null,
  };
  const generations: Record<DisplayWeatherSourceV1, number> = { vpws50: 0, vpww56: 0 };
  for (const source of WEATHER_PROMOTION_SOURCES) {
    const record = sanitizeRecord(rawRecords[source]);
    if (record === undefined) {
      log.warn(`[weather-promotion-persistence] ${source} の record が不正 — この source だけ破棄`);
    } else {
      records[source] = record;
    }
    const generation = rawGenerations[source];
    // safe integer でないと ++ で値が変わらず generation の更新が止まる
    if (typeof generation === "number" && Number.isSafeInteger(generation) && generation >= 0) {
      generations[source] = generation;
    }
    // watermark は record より小さくならないようにする (復元後の generation 逆行防止)
    const restored = records[source];
    if (restored != null && restored.generation > generations[source]) {
      generations[source] = restored.generation;
    }
  }
  return { records, generations };
}

/** null = 記録なし (正常) / undefined = 不正データ (この source を破棄) */
function sanitizeRecord(value: unknown): WeatherPromotionRecord | null | undefined {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  const { state, level, generation, signature } = value;
  if (state !== "active" && state !== "demoted") return undefined;
  if (level !== 4 && level !== 5) return undefined;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) return undefined;
  // signature が欠けると復元後の「同内容の続報」判定が効かず generation が無駄に進む
  if (typeof signature !== "string") return undefined;
  if (state === "demoted") return { state, level, generation, signature };
  const promotedAtMs = value.promotedAtMs;
  // 有限なだけでは足りない: 1e20 のような値は Date 範囲外で、後段の日時整形が RangeError になる
  if (typeof promotedAtMs !== "number" || !Number.isFinite(promotedAtMs)) return undefined;
  if (Math.abs(promotedAtMs) > MAX_TIME_VALUE) return undefined;
  return { state, level, promotedAtMs, generation, signature };
}
