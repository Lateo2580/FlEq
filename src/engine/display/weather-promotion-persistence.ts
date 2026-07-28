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
import type { DisplayWeatherAlertItemV1, DisplayWeatherSourceV1 } from "./types";
import { kindCodeToPhenomenonKey } from "../../dmdata/weather-phenomenon-key";
import { WEATHER_PROMOTION_SOURCES, type WeatherPromotionMemberV1 } from "./weather-promotion";
import type {
  WeatherPromotionPersistedV1,
  WeatherPromotionRecord,
  WeatherPromotionTrigger,
} from "./weather-promotion-store";

// v2: record に items (昇格根拠の view スナップショット) を追加。
// v1 のデータは items を持たず「昇格しているのに中身が無い」状態になるため復元しない
// (既存の version 不一致経路で debug ログ 1 行を出して破棄される)。
const PERSIST_SCHEMA_VERSION = 2;

/** standby-persistence と同じ debounce 窓。失うのは強制電源断の直前この秒数ぶん */
const SAVE_DEBOUNCE_MS = 3000;

export interface PersistedWeatherPromotionV1 extends WeatherPromotionPersistedV1 {
  version: typeof PERSIST_SCHEMA_VERSION;
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
        return discardedWithoutMaterial();
      }
      if (parsed.version !== PERSIST_SCHEMA_VERSION) {
        log.debug(
          `[weather-promotion-persistence] schema 世代交代 (v${String(parsed.version)} → v${PERSIST_SCHEMA_VERSION}) — 旧データ破棄`,
        );
        return discardedWithoutMaterial();
      }
      const savedAtMs = typeof parsed.savedAt === "string" ? Date.parse(parsed.savedAt) : Number.NaN;
      if (!Number.isFinite(savedAtMs)) {
        log.warn("[weather-promotion-persistence] savedAt が不正 — 破棄");
        return discardedWithoutMaterial();
      }
      if (nowMs - savedAtMs > WEATHER_PROMOTION_MAX_RESTORE_AGE_MS) {
        log.debug(`[weather-promotion-persistence] 保存から時間が経ちすぎているため破棄 (savedAt=${String(parsed.savedAt)})`);
        // 古すぎる lifecycle は捨てるが、**内容 (signature) は読めている**。継続中の警報を
        // 次の受理で「新規発表」と偽らないよう tombstone だけ残す (spec 追補 C5)
        const aged = sanitizePersisted(parsed);
        return {
          records: { vpws50: null, vpww56: null },
          generations: aged.generations,
          activationSeq: aged.activationSeq,
          uncertainSources: tombstonesOf(aged),
        };
      }
      // savedAt 自体が未来 = 時計が信用できない。この状態では record の古さを判定できず、
      // demoted record が tier と weatherL5Active を無期限に固定しうるので record を捨てる
      // (promotedAtMs を持たない demoted は record 単位の未来判定では守れないため、ここで落とす)
      const sanitized = sanitizePersisted(parsed);
      if (savedAtMs - nowMs > WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS) {
        log.warn(`[weather-promotion-persistence] 保存時刻が未来のため record を破棄 (savedAt=${String(parsed.savedAt)})`);
        // record は捨てるが watermark は時刻と無関係なので残す。
        // 捨てると次の昇格が generation 1 に戻り「generation を再利用しない」契約が壊れる。
        // **signature は tombstone として残す** — 時計が信用できないだけで内容は読めているので、
        // 次の受理が同内容なら点灯しない (spec 追補 C5)
        return {
          records: { vpws50: null, vpww56: null },
          generations: sanitized.generations,
          activationSeq: sanitized.activationSeq,
          uncertainSources: tombstonesOf(sanitized),
        };
      }
      return sanitized;
    } catch (err) {
      log.warn(`[weather-promotion-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return discardedWithoutMaterial();
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
    // **フィールドを列挙せず spread する**。`WeatherPromotionPersistedV1` の新フィールドは
    // optional で入るため、列挙式だと書き忘れても型検査を通り抜ける
    // (activationSeq / uncertainSources が実際に落ちていた、Codex レビュー 3 巡目 2026-07-27)
    return {
      ...state,
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
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

/**
 * 保存ファイルはあったが中身を一切使えなかった場合の戻り値 (spec 追補 C5)。
 *
 * `null` (= ファイル自体が無い / 初回起動) と**区別する**のが要点。null を返すと store は
 * 「記録なし = 本当の新規」と解釈し、継続中の警報に「新規発表」バッジを出してしまう。
 * 比較材料が無いので tombstone の値は null = バッジを出さない。
 */
function discardedWithoutMaterial(): WeatherPromotionPersistedV1 {
  return {
    records: { vpws50: null, vpww56: null },
    generations: { vpws50: 0, vpww56: 0 },
    uncertainSources: Object.fromEntries(WEATHER_PROMOTION_SOURCES.map((s) => [s, null])),
  };
}

/** lifecycle を捨てるが内容は読めているときの tombstone (source → signature)。 */
function tombstonesOf(
  state: WeatherPromotionPersistedV1,
): Partial<Record<DisplayWeatherSourceV1, string | null>> {
  const out: Partial<Record<DisplayWeatherSourceV1, string | null>> = { ...state.uncertainSources };
  for (const source of WEATHER_PROMOTION_SOURCES) {
    const record = state.records[source];
    if (record != null) out[source] = record.signature;
  }
  return out;
}

/** source 単位で検証する。片方が壊れていても、もう片方は生かす */
function sanitizePersisted(parsed: Record<string, unknown>): WeatherPromotionPersistedV1 {
  const rawRecords = isRecord(parsed.records) ? parsed.records : {};
  const rawGenerations = isRecord(parsed.generations) ? parsed.generations : {};
  const records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null> = {
    vpws50: null, vpww56: null,
  };
  const generations: Record<DisplayWeatherSourceV1, number> = { vpws50: 0, vpww56: 0 };
  // 「壊れていたので捨てた」source。**正常に record が無かった場合と区別して store へ渡す** —
  // 区別しないと、継続中の警報を次の受理で「新規発表」と偽る (Codex レビュー 2026-07-27)
  const uncertainSources: Partial<Record<DisplayWeatherSourceV1, string | null>> = {};
  for (const source of WEATHER_PROMOTION_SOURCES) {
    const record = sanitizeRecord(rawRecords[source]);
    if (record === undefined) {
      log.warn(`[weather-promotion-persistence] ${source} の record が不正 — この source だけ破棄`);
      // 壊れた record からは signature も信用できない → 比較材料なし (バッジを出さない)
      uncertainSources[source] = null;
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
  const rawSeq = parsed.activationSeq;
  const activationSeq =
    typeof rawSeq === "number" && Number.isSafeInteger(rawSeq) && rawSeq >= 0 ? rawSeq : 0;
  const rawUnseenSinceMs = parsed.unseenSinceMs;
  const unseenSinceMs =
    typeof rawUnseenSinceMs === "number"
    && Number.isFinite(rawUnseenSinceMs)
    && Math.abs(rawUnseenSinceMs) <= MAX_TIME_VALUE
      ? rawUnseenSinceMs
      : null;
  // 保存時点で立っていた印も引き継ぐ (次の受理まで維持される)。
  // 値は tombstone の signature、文字列でなければ「材料なし」に倒す
  const savedUncertain = sanitizeUncertainSources(parsed.uncertainSources);
  return {
    records,
    generations,
    unseenSinceMs,
    activationSeq,
    // この load で壊れていた source が優先 (今回の観測の方が新しい)
    uncertainSources: { ...savedUncertain, ...uncertainSources },
  };
}

/**
 * 保存済みの印 (`uncertainSources`) の復元。**旧形式の配列も受ける**。
 *
 * この印は追補の実装途中で `DisplayWeatherSourceV1[]`（signature を持たない「捨てた source の
 * 一覧」）だった。schema version は 2 のまま signature 付き object へ変えたので、**旧形式で
 * 書かれたファイルは version 検査を通過してしまう**。配列を無視すると印が丸ごと落ち、
 * 継続中の警報が再起動後の初回受理で「新規発表」として点く (spec 追補 C5 が塞ぐはずの穴)。
 * 配列には比較材料 (signature) が無いので `null` = バッジを出さない、へ移行する。
 */
function sanitizeUncertainSources(
  value: unknown,
): Partial<Record<DisplayWeatherSourceV1, string | null>> {
  const out: Partial<Record<DisplayWeatherSourceV1, string | null>> = {};
  if (Array.isArray(value)) {
    for (const source of WEATHER_PROMOTION_SOURCES) {
      if (value.includes(source)) out[source] = null;
    }
    return out;
  }
  if (!isRecord(value)) return out;
  for (const source of WEATHER_PROMOTION_SOURCES) {
    if (!(source in value)) continue;
    const signature = value[source];
    out[source] = typeof signature === "string" ? signature : null;
  }
  return out;
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
  // items (view スナップショット) は record の一部。壊れていれば record ごと捨てる —
  // 「昇格しているのに中身が無い」状態を復元しないため
  const items = sanitizeItems(value.items);
  if (items === undefined) return undefined;
  // 昇格 record は必ず L4/L5 相当の item を伴う (classifier が空で level を返すことはない)。
  // 空で保存されているのは破損なので record ごと捨てる — 復元しても「昇格しているのに
  // 中身が無い」状態を作るだけで、この機能が塞ごうとしている穴そのものになる
  if (items.length === 0) return undefined;
  // 装飾 (members / trigger / addedAreas) は**壊れていても record は捨てない** (spec 追補 C4)。
  // 装飾は「なぜ光っているか」の説明であって昇格の根拠ではないので、失っても record を生かし、
  // バッジとハイライトだけを落とす (装飾なし = trigger の判定材料が無い state)
  const decor = sanitizeDecoration(value);
  if (state === "demoted") return { state, level, generation, signature, items, ...decor };
  const promotedAtMs = value.promotedAtMs;
  // 有限なだけでは足りない: 1e20 のような値は Date 範囲外で、後段の日時整形が RangeError になる
  if (typeof promotedAtMs !== "number" || !Number.isFinite(promotedAtMs)) return undefined;
  if (Math.abs(promotedAtMs) > MAX_TIME_VALUE) return undefined;
  return { state, level, promotedAtMs, generation, signature, items, ...decor };
}

/**
 * 装飾 (安定キー集合・trigger・追加地域) の復元。**壊れていれば装飾だけを落とす** (C4)。
 * `trigger` を失った record は「装飾なし」として復元され、次の受理で嘘の「新規発表」を
 * 出さないよう store 側が update に倒す (C5)。
 */
function sanitizeDecoration(value: Record<string, unknown>): {
  members: WeatherPromotionMemberV1[];
  trigger: WeatherPromotionTrigger | null;
  addedAreas: WeatherPromotionMemberV1[];
  activationSeq: number;
} {
  const members = sanitizeMembers(value.members);
  const addedAreasRaw = sanitizeMembers(value.addedAreas);
  // 追加地域は members の部分集合でなければ信用しない (別物を指していれば装飾ごと捨てる)
  const memberKeys = new Set((members ?? []).map((m) => `${m.kindCode}|${m.areaCode}`));
  const addedAreas =
    addedAreasRaw == null || members == null
      ? undefined
      : addedAreasRaw.every((m) => memberKeys.has(`${m.kindCode}|${m.areaCode}`))
        ? addedAreasRaw
        : undefined;
  const rawTrigger = value.trigger;
  // **補正しない**。旧データ・壊れた装飾は null にしてバッジを出さない
  const trigger: WeatherPromotionTrigger | null =
    rawTrigger === "new" || rawTrigger === "update" ? rawTrigger : null;
  // members が復元できないと追加地域の差分が取れない。次の受理を「全部が追加」と誤判定
  // しないよう、その場合は addedAreas も落とす
  const rawSeq = value.activationSeq;
  const activationSeq =
    typeof rawSeq === "number" && Number.isSafeInteger(rawSeq) && rawSeq >= 0 ? rawSeq : 0;
  // 1 つでも壊れていたら装飾ごと落とす (record 自体は生かす)
  if (members == null || members.length === 0 || addedAreas == null) {
    return { members: [], trigger: null, addedAreas: [], activationSeq };
  }
  return { members, trigger, addedAreas, activationSeq };
}

/**
 * member 集合の復元。**all-or-nothing** で検証する (Codex 再レビュー 2026-07-27)。
 * 要素単位で読み飛ばすと、部分的に欠けた集合が「前回の全量」として扱われ、
 * 次の更新で実際には増えていない地域まで「追加」としてハイライトされる。
 * `phenomenonKey` は保存値を信用せず `kindCode` から再生成する (保存後にマップが育っても追従する)。
 */
function sanitizeMembers(value: unknown): WeatherPromotionMemberV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WeatherPromotionMemberV1[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const { level, severity, kindCode, areaCode, kind, areaName } = raw;
    if (level !== 4 && level !== 5) return undefined;
    if (typeof severity !== "string" || typeof kindCode !== "string") return undefined;
    if (typeof areaCode !== "string" || typeof kind !== "string" || typeof areaName !== "string") return undefined;
    out.push({
      level, severity, kindCode,
      phenomenonKey: kindCodeToPhenomenonKey(kindCode),
      areaCode, kind, areaName,
    });
  }
  return out;
}

/** undefined = 不正 (record ごと破棄) */
function sanitizeItems(value: unknown): DisplayWeatherAlertItemV1[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: DisplayWeatherAlertItemV1[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return undefined;
    const { kind, phenomenonKey, displaySeverity, rank, shownAreas, omittedAreaCount } = raw;
    if (typeof kind !== "string" || typeof displaySeverity !== "string") return undefined;
    if (rank !== "emergency" && rank !== "warning" && rank !== "advisory") return undefined;
    if (!Array.isArray(shownAreas) || shownAreas.some((a) => typeof a !== "string")) return undefined;
    if (typeof omittedAreaCount !== "number" || !Number.isSafeInteger(omittedAreaCount) || omittedAreaCount < 0) {
      return undefined;
    }
    items.push({
      kind,
      ...(typeof phenomenonKey === "string" ? { phenomenonKey } : {}),
      displaySeverity,
      rank,
      shownAreas: shownAreas as string[],
      omittedAreaCount,
    });
  }
  return items;
}
