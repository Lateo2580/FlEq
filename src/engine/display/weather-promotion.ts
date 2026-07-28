/**
 * 気象警報の主役パネル昇格判定 (集合ベース)。
 * rank 1 点代表 (maxDisplaySeverity) ではなく全 item を走査して最大昇格レベルを採る —
 * L4 (rank 90) と特別警報級 nonLevelSpecial (rank 85) の共存で L5 相当が潰れないようにする
 * (computeMaxSoundLevel と同じ集合ベース判定)。alert.role は使わない。
 */

import * as log from "../../logger";
import { kindCodeToPhenomenonKey } from "../../dmdata/weather-phenomenon-key";
import { formatLevelLabel } from "../../dmdata/weather-warning-level";
import type { Vpws50CurrentAreasForDisplay } from "../../types";
import { displayWeatherPromotionLevel, isDisplayWeatherSeverity } from "./protocol";
import type {
  DisplayWeatherAlertItemV1,
  DisplayWeatherPromotionLevelV1,
  DisplayWeatherSourceV1,
} from "./types";

export const WEATHER_PROMOTION_SOURCES: readonly DisplayWeatherSourceV1[] = ["vpws50", "vpww56"];

/** 既に warn を出した未知 displaySeverity。未知コードの配信が始まってもログを埋めない */
const warnedUnknownSeverities = new Set<string>();

/**
 * 昇格対象 1 件 (現象 × 地域) の安定キーと表示名。
 *
 * **判定は安定キー (`phenomenonKey` = 電文の kindCode / `areaCode`) で行い、表示名は wire へ
 * 射影するときだけ使う** (spec 追補 C2)。表示ラベル (`L4 大雨警報` 形式) で判定すると、
 * L4→L5 の悪化で同じ地域が「追加された地域」に化ける。
 */
export interface WeatherPromotionMemberV1 {
  level: DisplayWeatherPromotionLevelV1;
  severity: string;
  /** 電文の生 kindCode。**レベルごとに別コードが振られる** (大雨は L4=43 / L5=33)。
   *  判定には使わず、永続化して復元時に `phenomenonKey` を再生成する材料にする
   *  (保存後に正規化マップが育っても追従できる) */
  kindCode: string;
  /** 現象の正規化キー (`kindCodeToPhenomenonKey`)。レベルが変わっても不変。
   *  **内容変化 (signature) も地域追加も、判定はこちらで行う** (spec 追補 C2)。
   *  生 kindCode で判定すると L4→L5 の悪化で同じ地域が「追加された」に化ける */
  phenomenonKey: string;
  areaCode: string;
  /** 表示用 (wire 射影・控えの組み立てにのみ使う) */
  kind: string;
  areaName: string;
}

/**
 * 内容変化の判定に使う 1 件ぶんのキー (spec 追補 C2: `severity|phenomenonKey|areaCode`)。
 *
 * **生 `kindCode` は使わない**。同じ現象・同じ severity に別コードが割り当てられている
 * (あるいは将来割り当てられる) と、内容が変わっていないのに再点灯する。
 * レベルの悪化は `severity` が拾うので、これで検出力は落ちない
 * (Codex レビュー 3 巡目 2026-07-27)。
 */
export function signatureMemberOf(m: WeatherPromotionMemberV1): string {
  return `${m.severity}|${m.phenomenonKey}|${m.areaCode}`;
}

/** 地域追加の判定に使う 1 件ぶんのキー (**レベル変化を追加と数えない**、spec 追補 C2) */
export function areaMemberOf(m: WeatherPromotionMemberV1): string {
  return `${m.phenomenonKey}|${m.areaCode}`;
}

export interface WeatherPromotionClassification {
  level: DisplayWeatherPromotionLevelV1;
  /** 昇格対象の集合を表す安定キー。変化したら generation を更新する */
  signature: string;
  /**
   * 昇格の根拠になった item そのもの (L4/L5 相当のみ)。record と一緒に永続化して、
   * 再起動直後に live な view がまだ空でも主役パネルが中身を持てるようにする。
   * L3 以下は主役パネルに出ないので載せない (保存サイズの削減)。
   */
  items: DisplayWeatherAlertItemV1[];
  /** 安定キー付きの昇格対象。追加地域の差分と永続化に使う */
  members: WeatherPromotionMemberV1[];
}

/**
 * 1 source 分の **holder view** (`Vpws50CurrentAreasForDisplay`、VPWW56 も同じ形) から昇格レベルを
 * 判定する。null = 昇格対象なし (L3 以下のみ)。未知の displaySeverity は判定に使わず warn のみ。
 *
 * **表示用 view (`DisplayWeatherAlertV1[]`) ではなく holder view を入力に採る** (spec 追補 C2):
 * 表示用へ射影した時点で `kindCode` / `areaCode` が落ち、表示ラベル (`L4 大雨警報`) しか残らない。
 * それで判定すると L4→L5 の悪化で同じ地域が「追加された地域」に化ける。
 *
 * `items` (控え) は判定に使った member から**同じ材料で**組み立てる。表示用 view を別経路で
 * 作って突き合わせると、2 つの射影がずれたときに控えと判定が食い違う。
 */
export function classifyWeatherPromotion(
  view: Vpws50CurrentAreasForDisplay | undefined,
  source: DisplayWeatherSourceV1,
): WeatherPromotionClassification | null {
  if (view == null) return null;
  let level: DisplayWeatherPromotionLevelV1 | null = null;
  const members: WeatherPromotionMemberV1[] = [];
  for (const group of view.kinds) {
    if (!isDisplayWeatherSeverity(group.displaySeverity)) {
      // 値ごとに 1 回だけ警告する (異常検知としては初回で足りる)
      if (!warnedUnknownSeverities.has(group.displaySeverity)) {
        warnedUnknownSeverities.add(group.displaySeverity);
        log.warn(
          `display: 未知の displaySeverity "${group.displaySeverity}" (${source} ${group.kindName}) を昇格判定から除外しました`,
        );
      }
      continue;
    }
    const groupLevel = displayWeatherPromotionLevel(group.displaySeverity);
    if (groupLevel == null) continue;
    if (level == null || groupLevel > level) level = groupLevel;
    const kind = formatLevelLabel(group.officialAlertLevel, group.kindName);
    for (const area of group.areas) {
      members.push({
        level: groupLevel,
        severity: group.displaySeverity,
        kindCode: group.kindCode,
        phenomenonKey: kindCodeToPhenomenonKey(group.kindCode),
        areaCode: area.areaCode,
        kind,
        areaName: area.areaName,
      });
    }
  }
  if (level == null) return null;
  return {
    level,
    signature: buildSignature(members),
    items: itemsFromMembers(members),
    members,
  };
}

/** 内容変化の判定キー。**整列前に Set 化**する (holder が同じペアを二度出しても signature を
 *  変えない、spec 追補 C13)。並び順に依存しないのは従来どおり */
export function buildSignature(members: readonly WeatherPromotionMemberV1[]): string {
  return [...new Set(members.map(signatureMemberOf))].sort().join("\n");
}

/** 控え (表示用 item) を member から組む。同一 (kind, severity) の地域をまとめる */
export function itemsFromMembers(
  members: readonly WeatherPromotionMemberV1[],
): DisplayWeatherAlertItemV1[] {
  const byKind = new Map<string, DisplayWeatherAlertItemV1>();
  for (const m of members) {
    const key = `${m.severity}|${m.kindCode}`;
    const existing = byKind.get(key);
    if (existing == null) {
      byKind.set(key, {
        kind: m.kind,
        phenomenonKey: m.phenomenonKey,
        displaySeverity: m.severity,
        rank: m.level === 5 ? "emergency" : "warning",
        shownAreas: [m.areaName],
        omittedAreaCount: 0,
      });
      continue;
    }
    if (!existing.shownAreas.includes(m.areaName)) existing.shownAreas.push(m.areaName);
  }
  return [...byKind.values()];
}

/**
 * 前回から**追加された** (現象 × 地域) を求める。レベル変化は追加と数えない (`areaMemberOf`)。
 * 削除された地域は扱わない — 消えたものは画面に無いのでハイライトのしようがない。
 */
export function addedMembers(
  prev: readonly WeatherPromotionMemberV1[] | undefined,
  next: readonly WeatherPromotionMemberV1[],
): WeatherPromotionMemberV1[] {
  // 前回の member を持たない (旧データからの復元・装飾を失った record) ときは
  // **差分を作らない**。空集合と比べると全地域が「追加」になり、画面が全面ハイライトになる
  if (prev == null || prev.length === 0) return [];
  const before = new Set(prev.map(areaMemberOf));
  const seen = new Set<string>();
  const added: WeatherPromotionMemberV1[] = [];
  for (const m of next) {
    const key = areaMemberOf(m);
    if (before.has(key) || seen.has(key)) continue;
    seen.add(key);
    added.push(m);
  }
  return added;
}

/** テスト用: 値ごと 1 回の warn 抑制状態をリセットする */
export function __test_resetUnknownSeverityWarnings(): void {
  warnedUnknownSeverities.clear();
}
