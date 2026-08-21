/**
 * 気象警報の昇格 lifecycle を持つストア。
 *
 * DisplayStateStore ではなく monitor が所有する (standby active-state と同じ所有形)。
 * 昇格の時計は「点灯が見られていた時間の合計」。display off → on はフルリセットし、
 * display on の SSE 無客区間は停止して lifecycle を途切れさせない。
 * 時刻は全メソッドで nowMs 注入 (クラス内で Date.now() を呼ばない)。
 */

import * as log from "../../logger";
import {
  WEATHER_PROMOTION_CLOCK_SKEW_TOLERANCE_MS,
  WEATHER_PROMOTION_DEMOTE_MIN,
} from "./constants";
import type { Vpws50CurrentAreasForDisplay } from "../../types";
import { VPWW56_SNAPSHOT_GENERATION } from "../messages/vpww56-state";
import { VPWS50_SNAPSHOT_GENERATION } from "../messages/vpws50-state";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherPromotionLevelV1,
  DisplayWeatherSourceV1,
} from "./types";
import {
  addedMembers,
  areaMemberOf,
  classifyWeatherPromotion,
  WEATHER_PROMOTION_SOURCES,
  type WeatherPromotionMemberV1,
} from "./weather-promotion";

const MIN_MS = 60_000;

/**
 * 気象警報の昇格状態 (source 別)。demoted は主役パネルからの降格だけを意味し、
 * 警報自体は継続しているので tier 維持のため level を保持する (level: null を持たせない)。
 * signature は「昇格対象 item の集合」で、変化時に generation を更新する判定に使う。
 *
 * items は昇格の根拠になった item の控え (view スナップショット)。**record の中に持つ**ことで
 * record を捨てる操作がそのままスナップショットの破棄になり、「片方だけ生き残る」状態を
 * 型の上で作れなくしている (24 時間足切り・savedAt 未来・promotedAtMs 未来・破損・version
 * 不一致のいずれでも、record が消えれば控えも一緒に消える)。
 */
/** この点灯が新規発表か更新発表か (spec 追補 3)。判定材料が無いときは null = バッジを出さない */
export type WeatherPromotionTrigger = "new" | "update";

/** 点灯に伴う装飾 (バッジ・追加地域ハイライト)。record と一緒に永続化する (C4) */
interface WeatherPromotionDecoration {
  /** 安定キー付きの昇格対象。追加地域の差分に使う */
  members: WeatherPromotionMemberV1[];
  /** **null = 判定材料が無い** (旧データ・壊れた装飾)。バッジを出さない。
   *  ここで "update" などに補正すると、復元直後から根拠のないバッジが出る (Codex 2026-07-27) */
  trigger: WeatherPromotionTrigger | null;
  /** この点灯で追加された (現象 × 地域)。新規発表では空 */
  addedAreas: WeatherPromotionMemberV1[];
  /**
   * **点灯イベントの通し番号**。new / update のときだけ増える (Codex レビュー 2026-07-27)。
   * 保持の時計 (`promotedAtMs`) は resume で測り直すため、時計を再点灯の契機に使うと
   * 「display on しただけで再点灯」「複数 source が同時刻になり発生順を失う」が起きる。
   * 時計と点灯イベントを分離して、フロントの再点灯はこの番号だけで決める
   */
  activationSeq: number;
}

export type WeatherPromotionRecord =
  | ({
      state: "active";
      level: DisplayWeatherPromotionLevelV1;
      promotedAtMs: number;
      generation: number;
      signature: string;
      items: DisplayWeatherAlertItemV1[];
    } & WeatherPromotionDecoration)
  | ({
      state: "demoted";
      level: DisplayWeatherPromotionLevelV1;
      generation: number;
      signature: string;
      items: DisplayWeatherAlertItemV1[];
    } & WeatherPromotionDecoration);

/** 控えの実値が変わったかを見る (同内容再掲での無駄なディスク書き込みを避ける、C8) */
function sameItems(a: readonly DisplayWeatherAlertItemV1[], b: readonly DisplayWeatherAlertItemV1[]): boolean {
  if (a.length !== b.length) return false;
  const canonical = (items: readonly DisplayWeatherAlertItemV1[]): string =>
    items
      .map(
        (it) =>
          `${it.displaySeverity}|${it.phenomenonKey ?? ""}|${it.kind}|${it.shownAreas
            .map((area, index) => `${area}:${it.shownAreaCodes?.[index] ?? ""}`)
            .sort()
            .join(",")}`,
      )
      .sort()
      .join("\n");
  return canonical(a) === canonical(b);
}

/**
 * 追加地域を最新の member 集合へ引き直す (安定キーで照合し、表示名だけ差し替える)。
 * 同内容の再掲でも地域名・警報名の訂正は起こりうる。wire では `areaName` で照合するので、
 * 古い名前のまま持つとハイライトが画面から消える (Codex レビュー 3 巡目 2026-07-27)。
 */
function remapAddedAreas(
  added: readonly WeatherPromotionMemberV1[],
  members: readonly WeatherPromotionMemberV1[],
): WeatherPromotionMemberV1[] {
  if (added.length === 0) return [];
  const byKey = new Map(members.map((m) => [areaMemberOf(m), m]));
  const out: WeatherPromotionMemberV1[] = [];
  for (const a of added) {
    // 消えた地域は落とす (もう画面に無いのでハイライトのしようがない)
    const fresh = byKey.get(areaMemberOf(a));
    if (fresh != null) out.push(fresh);
  }
  return out;
}

/** 追加地域の**表示名**が変わったか (永続化の要否判定に使う) */
function sameAreaNames(
  a: readonly WeatherPromotionMemberV1[],
  b: readonly WeatherPromotionMemberV1[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.areaName === b[i]?.areaName && m.kind === b[i]?.kind);
}

/** 永続化・復元の受け渡し形 (シリアライズ可能な素直な構造)。wire プロトコルには載らない */
export interface WeatherPromotionPersistedV1 {
  /** VPWS50 の地域粒度世代。欠落・不一致の record は旧府県粒度として復元しない。 */
  vpws50SnapshotGeneration?: number;
  /** VPWW56 の地域粒度世代。欠落・不一致の record は旧府県粒度として復元しない。 */
  vpww56SnapshotGeneration?: number;
  records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null>;
  /** record 削除後も保持する source 別 generation watermark */
  generations: Record<DisplayWeatherSourceV1, number>;
  /** SSE クライアントが 0 件になった壁時計時刻。欠落は旧 envelope = 時計停止なし */
  unseenSinceMs?: number | null;
  /**
   * **点灯イベントの通し番号 watermark** (パネル全体、record の外)。
   * record から復元すると「最後に点いた source が解除済み」のときに番号が巻き戻り、
   * 再起動後の点灯キーが過去の値と衝突する (Codex レビュー 2026-07-27)
   */
  activationSeq?: number;
  /**
   * 永続化層が record を捨てた source と、**捨てる前に読めていた signature** (C5)。
   * 次の受理を「新規発表」と偽らないための印。
   *
   * - `string` = record は読めたが時計が信用できず捨てた。signature が残っているので
   *   「同内容の再掲なら点灯しない」を再起動後も守れる
   * - `null`   = record ごと壊れていて比較材料が無い。点灯はするがバッジは出さない
   *   (spec 追補 C5「嘘の『新規』より無表示を採る」)
   */
  uncertainSources?: Partial<Record<DisplayWeatherSourceV1, string | null>>;
}

export class WeatherPromotionStore {
  private records: Record<DisplayWeatherSourceV1, WeatherPromotionRecord | null> = {
    vpws50: null, vpww56: null,
  };
  /** record 削除後も保持する generation watermark。500ms debounce 内の「解除 → 再発表」で
   *  同じ generation に戻らないよう nullable record の外に置く */
  private generations: Record<DisplayWeatherSourceV1, number> = { vpws50: 0, vpww56: 0 };
  /** 点灯イベントの通し番号 (source をまたいで単調増加)。発生順の真実源 */
  private activationSeq = 0;
  /** SSE 無客区間の壁時計始点。永続化し、再起動中も表示されていない時間として扱う */
  private unseenSinceMs: number | null = null;
  private durableListener: (() => void) | null = null;
  /** 復元で装飾 (members/trigger/addedAreas) を失った、または record ごと破棄した source と、
   *  捨てる前に読めていた signature (null = 比較材料なし)。
   *  次の受理で「新規発表」と嘘をつかないための印 (spec 追補 C5) */
  private restoredWithoutDecor = new Map<DisplayWeatherSourceV1, string | null>();

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
  apply(source: DisplayWeatherSourceV1, view: Vpws50CurrentAreasForDisplay | undefined, nowMs: number): boolean {
    const next = classifyWeatherPromotion(view, source);
    const prev = this.records[source];
    if (next == null) {
      // 高 severity 集合が空 = 警報解除。demote ではなく即終了 (watermark は保持)。
      // **「装飾なし復元」の印もここで落とす** — 解除で前の文脈は終わったので、
      // 次に来る昇格は本当に新規発表。印を残すと「更新発表」と誤表示する
      this.restoredWithoutDecor.delete(source);
      if (prev == null) return false;
      this.records[source] = null;
      this.notifyDurable();
      return true;
    }
    // signature が変われば増減の方向によらず「別内容」として点灯し直す — L5 地域が減る等の
    // 縮退も新しい表示として扱う。
    const unchanged = prev != null && prev.level === next.level && prev.signature === next.signature;
    if (unchanged) {
      // **同内容の再掲では点灯しない** (spec 追補 2)。VPWS50 は定時通報が来るので、ここで
      // promotedAtMs を更新すると保持時間が延び続け「出っぱなし」になる (実機観測 2026-07-26)。
      // 控え (items / members) だけは最新へ寄せて現況から遅れないようにするが、点灯契機ではないので
      // promotedAtMs・state・generation・trigger・addedAreas はすべて据え置く。
      // durable 通知は**値が実際に変わったときだけ** (定時通報のたびのディスク書き込みを避ける、C8)
      // 追加地域は**安定キーで引き直して表示名だけ最新に寄せる** (地域名・警報名の訂正報が
      // 来ると、wire 上は areaName で照合するので古い名前だとハイライトが消える)
      const addedAreas = remapAddedAreas(prev.addedAreas, next.members);
      const decorChanged =
        (prev.items !== next.items && !sameItems(prev.items, next.items))
        || !sameAreaNames(prev.addedAreas, addedAreas);
      this.records[source] = { ...prev, items: next.items, members: next.members, addedAreas };
      if (decorChanged) this.notifyDurable();
      return false; // wire の再点灯は起こさない
    }
    // 復元で record を捨てた source は、捨てる前の signature が残っていれば**再起動をまたいで
    // 「同内容の再掲」を判定できる** (spec 追補 C5)。一致したら点灯しない — 印だけ落として抜ける
    if (prev == null && this.restoredWithoutDecor.get(source) === next.signature) {
      this.restoredWithoutDecor.delete(source);
      this.records[source] = {
        state: "demoted", level: next.level, generation: this.generations[source],
        signature: next.signature, items: next.items, members: next.members,
        trigger: null, addedAreas: [], activationSeq: this.activationSeq,
      };
      this.notifyDurable();
      return false;
    }
    const generation = ++this.generations[source];
    // 新規発表か更新発表か (spec 追補 3)。
    // - prev が居る            → 内容が変わったので update
    // - 復元で材料を失っている  → 新規とも更新とも断言できないので **バッジを出さない** (C5)
    // - どちらでもない          → 本当の新規発表
    const trigger: WeatherPromotionTrigger | null =
      prev != null ? "update"
        : this.restoredWithoutDecor.has(source) ? null
          : "new";
    this.restoredWithoutDecor.delete(source);
    this.records[source] = {
      state: "active",
      level: next.level,
      // 無客中の新規点灯・内容変化はまだ一度も見られていない。無客開始へ正規化しておくと、
      // 再接続・再起動時に全 active へ同じ停止区間をシフトしても可視時間 0 から始められる
      promotedAtMs: this.unseenSinceMs ?? nowMs,
      generation,
      signature: next.signature,
      // 受理のたびに最新の view で上書きする = 控えが現況から遅れない
      items: next.items,
      members: next.members,
      activationSeq: ++this.activationSeq,
      trigger,
      // 新規発表では追加地域を出さない — 全部が新規なので全面ハイライトは意味を失う
      addedAreas: trigger === "update" ? addedMembers(prev?.members, next.members) : [],
    };
    this.notifyDurable();
    return true;
  }

  /**
   * 「可視時間の合計 3 分 (+ 最大 5 秒)」の降格。classifier は受理時のみ走らせ、ここでは active → demoted の
   * 遷移だけを行う (record 削除は解除受理の責務)。
   */
  sweepDemote(nowMs: number): boolean {
    let changed = false;
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const rec = this.records[source];
      if (rec == null || rec.state !== "active") continue;
      const elapsed = nowMs - rec.promotedAtMs;
      // 稼働中に壁時計が巻き戻った場合、元の時刻へ追いつくまで active が残り続けないよう
      // 現在時刻から測り直す。復元時・display on 時の未来時刻防御と同じ向きの縮退
      if (elapsed < 0) {
        this.records[source] = { ...rec, promotedAtMs: nowMs };
        changed = true;
        continue;
      }
      if (elapsed <= WEATHER_PROMOTION_DEMOTE_MIN * MIN_MS) continue;
      this.records[source] = {
        state: "demoted", level: rec.level, generation: rec.generation,
        signature: rec.signature, items: rec.items,
        members: rec.members, trigger: rec.trigger, addedAreas: rec.addedAreas,
        activationSeq: rec.activationSeq,
      };
      changed = true;
    }
    if (changed) this.notifyDurable();
    return changed;
  }

  /** 永続化用の lifecycle 一式 (promotedAtMs / state / generation / watermark)。 */
  export(): WeatherPromotionPersistedV1 {
    return {
      vpws50SnapshotGeneration: VPWS50_SNAPSHOT_GENERATION,
      vpww56SnapshotGeneration: VPWW56_SNAPSHOT_GENERATION,
      records: { ...this.records },
      generations: { ...this.generations },
      unseenSinceMs: this.unseenSinceMs,
      activationSeq: this.activationSeq,
      uncertainSources: Object.fromEntries(this.restoredWithoutDecor),
    };
  }

  /** パネル全体の点灯キー。**new / update でだけ変わる** — source の降格・解除では動かない */
  activationWatermark(): number {
    return this.activationSeq;
  }

  /**
   * 起動時復元。**残り時間だけを復元する** (再起動による延命を作らない):
   * - persisted unseen がある active → 無客時間を先に除外し、復元後も nowMs から無客を継続
   * - 既に保持時間 (3 分) を過ぎた active → demoted として格納 (record は消さない。警報自体は継続しうる)
   * - promotedAtMs が許容誤差を超えて未来 → **record を破棄する** (demoted にもしない)。
   *   RTC を持たない Pi で NTP 同期前に起動すると保存時刻が未来になりえるが、そのとき
   *   「保持時間を過ぎたか」も「まだ有効か」も判定できない。demoted で残すと tier と
   *   weatherL5Active だけが無期限に固定される最悪の縮退になるため、判定不能なら捨てる。
   *   警報が継続していれば VPWS50 の定期再掲ですぐ再昇格する
   * - それ以外の active → 補正後の promotedAtMs を引き継ぐ (残り時間が減った状態で復元される)
   *
   * generation は必ず維持し、watermark は保存値と record の generation の大きい方を採る
   * (record を破棄しても watermark は残すので generation は再利用されない)。
   */
  restore(state: WeatherPromotionPersistedV1, nowMs: number): void {
    const persistedUnseenSinceMs =
      typeof state.unseenSinceMs === "number" && Number.isFinite(state.unseenSinceMs)
        ? state.unseenSinceMs
        : null;
    // プロセス停止中も閲覧者はいない。壁時計が巻き戻った場合はプロセスを跨ぐ単調時計が
    // 存在しないため負値を 0 に clamp し、復元後は nowMs から無客状態を継続する
    const restoredUnseenMs =
      persistedUnseenSinceMs == null ? 0 : Math.max(0, nowMs - persistedUnseenSinceMs);
    this.unseenSinceMs = persistedUnseenSinceMs == null ? null : nowMs;
    this.activationSeq = Math.max(this.activationSeq, state.activationSeq ?? 0);
    // 永続化層が「捨てた」と判断した source は、次の受理を新規発表にしない。
    // 値は捨てる前の signature (null = 比較材料なし)
    for (const [source, signature] of Object.entries(state.uncertainSources ?? {})) {
      this.restoredWithoutDecor.set(source as DisplayWeatherSourceV1, signature ?? null);
    }
    for (const source of WEATHER_PROMOTION_SOURCES) {
      // 装飾を持たない旧データがそのまま渡ることがある (permissive な入口)。
      // 欠落は null / 空へ正規化してから扱う — undefined のまま持つと「材料が無い」の
      // 判定が型でしか守られず、wire へ undefined が漏れる
      const rawSaved = state.records[source] ?? null;
      const saved = rawSaved == null ? null : {
        ...rawSaved,
        members: rawSaved.members ?? [],
        addedAreas: rawSaved.addedAreas ?? [],
        trigger: rawSaved.trigger ?? null,
        activationSeq: rawSaved.activationSeq ?? 0,
      };
      const shiftedSaved =
        saved != null && saved.state === "active" && restoredUnseenMs > 0
          ? { ...saved, promotedAtMs: saved.promotedAtMs + restoredUnseenMs }
          : saved;
      // persisted unseen の停止時間を足してから経過判定する。先に revive すると、誰にも
      // 見られていない停止中の時間だけで demoted になり resume でも戻せなくなる
      const record = shiftedSaved == null ? null : reviveRecord(shiftedSaved, nowMs, source);
      // 装飾を失った / record ごと捨てた source は印を付ける。次の受理で「新規発表」と
      // 偽らないため (spec 追補 C5)。saved があったのに record が消えた場合も同じ扱い
      if (saved != null && (record == null || record.trigger == null || record.members.length === 0)) {
        // record ごと落ちた場合だけ signature を tombstone に残す (再起動をまたいで
        // 「同内容の再掲」を判定するため)。record が生きているなら prev で判定できるので不要
        this.restoredWithoutDecor.set(source, record == null ? saved.signature : null);
      }
      this.records[source] = record;
      // 復元後の採番が既存 record と衝突しないようにする (点灯の同一性キーが巻き戻らない)
      this.activationSeq = Math.max(this.activationSeq, saved?.activationSeq ?? 0);
      // 「解除済みの source が最後に点いていた」場合、record からは番号を復元できない。
      // トップレベル watermark (restore 冒頭で反映済み) が真実源
      this.generations[source] = Math.max(
        state.generations[source] ?? 0,
        saved?.generation ?? 0,
      );
    }
  }

  /**
   * display runtime の起動 (`display on` 含む) 時に、**active な点灯の時計を測り直す**
   * (spec 追補 C6 = 案 B、ご主人決定 2026-07-27)。
   *
   * 昇格の受信更新は monitor の displaySink が display の on/off に関わらず行うので、
   * off 中の新規昇格・続報・解除はここに来る時点で反映済み。したがって view と record を
   * 突き合わせる reconcile は不要 (view から昇格させない原則も自動的に守られる)。
   *
   * **経過判定はここでは行わない**。降格 sweep は hub の 5 秒タイマー駆動で display off 中は
   * 止まっているため、`display on` の時点で `active` が残っているのは「誰にも見られないまま
   * 保持時間が過ぎた」状態にほかならない。ここで経過判定を先に通すと、その点灯が見られる前に
   * 捨てられる — C6 が塞ごうとしている穴そのもの。したがって `active` は経過時間にかかわらず
   * `nowMs` へ測り直す。`demoted` は据え置く (降格は既に見られた点灯の結末)。
   *
   * 再起動での延命は `restore()` 側の経過判定が防ぐ (責務を分ける)。起動 seed でも resume は
   * 通るが、その直前の `restore()` で経過済みの `active` は `demoted` へ落ちているので、
   * ここで測り直されるのは「再起動時点でまだ保持時間内だった点灯」だけになる。
   *
   * 点灯イベントの通し番号 (`activationSeq`) は増やさない — 再点灯ではなく表示機会の付与。
   */
  resume(nowMs: number): boolean {
    let changed = false;
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const current = this.records[source];
      if (current == null || current.state !== "active") continue;
      if (current.promotedAtMs === nowMs) continue;
      this.records[source] = { ...current, promotedAtMs: nowMs };
      changed = true;
    }
    if (changed) this.notifyDurable();
    return changed;
  }

  /**
   * SSE クライアントが 0 件になった壁時計時刻を永続状態へ記録する。
   */
  beginUnseenPeriod(nowMs: number): boolean {
    if (this.unseenSinceMs === nowMs) return false;
    this.unseenSinceMs = nowMs;
    this.notifyDurable();
    return true;
  }

  /** display on のフルリセットが無客状態を上書きするとき、永続 marker だけを解除する。 */
  clearUnseenPeriod(): boolean {
    if (this.unseenSinceMs == null) return false;
    this.unseenSinceMs = null;
    this.notifyDurable();
    return true;
  }

  /**
   * プロセス内の無客時間を単調クロック差分で受け取り、壁時計上の promotedAtMs へ反映する。
   * 壁時計が無客中に動いた分は adjustment として同時に rebase し、切断前の可視時間を保つ。
   */
  endUnseenPeriod(unseenDurationMs: number, nowMs: number): boolean {
    const unseenSinceMs = this.unseenSinceMs;
    if (unseenSinceMs == null) return false;
    this.unseenSinceMs = null;
    const durationMs = Number.isFinite(unseenDurationMs) ? Math.max(0, unseenDurationMs) : 0;
    const expectedNowMs = unseenSinceMs + durationMs;
    const wallClockAdjustmentMs = nowMs - expectedNowMs;
    const shiftMs = durationMs + wallClockAdjustmentMs;
    for (const source of WEATHER_PROMOTION_SOURCES) {
      const current = this.records[source];
      if (current == null || current.state !== "active") continue;
      if (shiftMs === 0) continue;
      this.records[source] = {
        ...current,
        promotedAtMs: current.promotedAtMs + shiftMs,
      };
    }
    // active が無くても unseen marker の解除は永続化が必要
    this.notifyDurable();
    return true;
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
    return {
      state: "demoted", level: record.level, generation: record.generation,
      signature: record.signature, items: record.items,
      members: record.members, trigger: record.trigger, addedAreas: record.addedAreas,
      activationSeq: record.activationSeq,
    };
  }
  return record;
}
