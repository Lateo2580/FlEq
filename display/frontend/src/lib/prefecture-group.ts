import { weatherAreaIdentity } from "./weather-expanded-kinds";

// 都道府県 → 市区町村 の階層に整形する共有ユーティリティ。地域名が「◯◯県」等で始まらない
// 場合 (地方名など) は pref=null (「その他」グループ) にまとめる。
// WeatherAlertCard (気象警報カード) と LatestQuakeCard/QuakePanel (地震情報カード) で共有する
// (震度別グループの地域リストも気象カードと同じ文法で表示するため。第3波 Fix7)。

export interface PrefGroup {
  pref: string | null;
  cities: string[];
}

// 47 都道府県の完全名。正規表現の最短マッチだと「京都府」が「京都」+「府」に割れる
// (「京都」の「都」がサフィックスと誤認される) ため、完全名の前方一致で切り出す。
export const PREFECTURES = [
  "北海道",
  "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県",
  "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/** 標準 JIS 都道府県コード。市区町村コード (7 桁) の先頭 2 桁から県名を引く。 */
export const PREFECTURE_BY_CODE: Readonly<Record<string, string>> = {
  "01": "北海道",
  "02": "青森県", "03": "岩手県", "04": "宮城県", "05": "秋田県", "06": "山形県", "07": "福島県",
  "08": "茨城県", "09": "栃木県", "10": "群馬県", "11": "埼玉県", "12": "千葉県", "13": "東京都", "14": "神奈川県",
  "15": "新潟県", "16": "富山県", "17": "石川県", "18": "福井県", "19": "山梨県", "20": "長野県",
  "21": "岐阜県", "22": "静岡県", "23": "愛知県", "24": "三重県",
  "25": "滋賀県", "26": "京都府", "27": "大阪府", "28": "兵庫県", "29": "奈良県", "30": "和歌山県",
  "31": "鳥取県", "32": "島根県", "33": "岡山県", "34": "広島県", "35": "山口県",
  "36": "徳島県", "37": "香川県", "38": "愛媛県", "39": "高知県",
  "40": "福岡県", "41": "佐賀県", "42": "長崎県", "43": "熊本県", "44": "大分県", "45": "宮崎県", "46": "鹿児島県", "47": "沖縄県",
};

export function prefectureFromMunicipalityCode(areaCode: string | null | undefined): string | null {
  if (areaCode == null || !/^\d{7}$/.test(areaCode)) return null;
  return PREFECTURE_BY_CODE[areaCode.slice(0, 2)] ?? null;
}

/**
 * 緊急気象パネル用の、identity と入力位置を失わない地域 entry。
 * `areaName` は wire 原文、`displayName` は県見出し配下だけで使う表示名である。
 */
export interface CodedAreaEntry {
  sourceIndex: number;
  areaName: string;
  displayName: string;
  areaCode: string | null;
  identity: string;
  added: boolean;
}

export type CodedPrefectureGroup =
  | {
      kind: "prefecture";
      key: string;
      groupOrdinal: number;
      prefectureCode: string;
      prefectureName: string;
      areas: CodedAreaEntry[];
    }
  | {
      kind: "raw";
      key: string;
      groupOrdinal: number;
      areas: CodedAreaEntry[];
    };

export interface CodedAreaGroupingInput {
  logicalRowKey: string;
  areas: readonly string[];
  areaCodes?: readonly (string | null | undefined)[];
  sourceIndices?: readonly number[];
  addedAreas?: readonly string[];
  addedAreaCodes?: readonly (string | null | undefined)[];
}

export function weatherAreaGroupKey(
  logicalRowKey: string,
  groupOrdinal: number,
  groupKind: CodedPrefectureGroup["kind"],
  prefectureCode?: string,
): string {
  return JSON.stringify([
    "weather-area-group-v1",
    logicalRowKey,
    groupOrdinal,
    groupKind,
    groupKind === "prefecture" ? prefectureCode : "raw",
  ]);
}

/**
 * 7 桁市区町村コードだけを根拠に、入力上で連続する地域を県 / raw run へ投影する。
 * 既存カード用 API と違い、名称から県を推測せず、同県の再登場も前方へ移動しない。
 */
export function groupCodedAreasByPrefecture(
  input: CodedAreaGroupingInput,
): CodedPrefectureGroup[] {
  const addedIdentities = new Set(
    (input.addedAreas ?? []).map((area, index) =>
      weatherAreaIdentity(area, input.addedAreaCodes?.[index])),
  );
  const groups: CodedPrefectureGroup[] = [];

  input.areas.forEach((areaName, groupedInputIndex) => {
    const sourceIndex = input.sourceIndices?.[groupedInputIndex] ?? groupedInputIndex;
    const areaCode = input.areaCodes?.[groupedInputIndex] ?? null;
    const prefectureName = prefectureFromMunicipalityCode(areaCode);
    const prefectureCode = prefectureName == null ? null : areaCode!.slice(0, 2);
    const displayName = prefectureName != null
      && areaName.startsWith(prefectureName)
      && areaName.length > prefectureName.length
      ? areaName.slice(prefectureName.length)
      : areaName;
    const entry: CodedAreaEntry = {
      sourceIndex,
      areaName,
      displayName: prefectureName == null ? areaName : displayName,
      areaCode,
      identity: weatherAreaIdentity(areaName, areaCode),
      added: addedIdentities.has(weatherAreaIdentity(areaName, areaCode)),
    };
    const previous = groups.at(-1);

    if (prefectureName == null || prefectureCode == null) {
      if (previous?.kind === "raw") {
        previous.areas.push(entry);
        return;
      }
      const groupOrdinal = groups.length;
      groups.push({
        kind: "raw",
        key: weatherAreaGroupKey(input.logicalRowKey, groupOrdinal, "raw"),
        groupOrdinal,
        areas: [entry],
      });
      return;
    }

    if (previous?.kind === "prefecture" && previous.prefectureCode === prefectureCode) {
      previous.areas.push(entry);
      return;
    }
    const groupOrdinal = groups.length;
    groups.push({
      kind: "prefecture",
      key: weatherAreaGroupKey(input.logicalRowKey, groupOrdinal, "prefecture", prefectureCode),
      groupOrdinal,
      prefectureCode,
      prefectureName,
      areas: [entry],
    });
  });

  return groups;
}

// 47 都道府県の完全名の前方一致で area の pref を切り出す (groupByPrefecture /
// groupByPrefectureOrRegion / countByPrefecture で共有するマッチロジック)
function matchPrefecture(area: string): string | null {
  return PREFECTURES.find((p) => area.startsWith(p)) ?? null;
}

export function groupByPrefecture(areas: string[]): PrefGroup[] {
  const order: Array<string | null> = [];
  const buckets = new Map<string | null, string[]>();
  for (const area of areas) {
    const pref = matchPrefecture(area);
    if (!buckets.has(pref)) {
      buckets.set(pref, []);
      order.push(pref);
    }
    if (pref != null) {
      // 都道府県前方一致あり: 残りが空 (「茨城県」等、県名そのもの) なら市区町村は積まない
      // (pref 行と市区町村欄の二重表示を防ぐ)。残りがあれば市区町村として積む
      const city = area.slice(pref.length);
      if (city.length > 0) buckets.get(pref)!.push(city);
    } else {
      // 一致なし (「宗谷地方」等) は「その他」グループに area 全体を積む
      buckets.get(pref)!.push(area);
    }
  }
  return order.map((pref) => ({ pref, cities: buckets.get(pref)! }));
}

/** 県名で始まらない地域 (地方名・離島部等) を groupByPrefecture のように「その他」1バケツへ
 *  集約せず、地域ごとに県名見出しと同格の独立グループとして返す。気象警報カードの離島部ラベル
 *  (沖縄本島地方・宗谷地方 等) を県名見出しと同じ視覚階層で表示するために使う
 *  (実機フィードバックバックログ §1)。
 *
 *  groupByPrefecture への委譲ではなく単一パスで組む: 委譲すると非県名地域が先に1バケツへ
 *  集約されてしまい、展開後も県グループとの入力上の相対順が保てない (Codex レビュー P2)。
 *  例: ["沖縄本島地方", "熊本県山鹿市", "宗谷地方"] は (沖縄本島地方 → 熊本県 → 宗谷地方) の
 *  順を保つ必要がある */
export function groupByPrefectureOrRegion(
  areas: string[],
  areaCodes?: readonly (string | null | undefined)[],
): PrefGroup[] {
  const order: PrefGroup[] = [];
  const prefIndex = new Map<string, number>();
  for (const [areaIndex, area] of areas.entries()) {
    // VPWS50 の市町村粒度は Area.Name に県名を含まない。7 桁の市区町村コードを優先し、
    // code 欠落・不正・粗い地域コードでは従来の県名完全前方一致へ戻す。
    const pref = prefectureFromMunicipalityCode(areaCodes?.[areaIndex]) ?? matchPrefecture(area);
    if (pref != null) {
      let idx = prefIndex.get(pref);
      if (idx == null) {
        idx = order.length;
        prefIndex.set(pref, idx);
        order.push({ pref, cities: [] });
      }
      const city = area.startsWith(pref) ? area.slice(pref.length) : area;
      if (city.length > 0) order[idx].cities.push(city);
    } else {
      // 一致なし: 地域名そのものを独立グループの見出しにする (登場位置をそのまま保持)
      order.push({ pref: area, cities: [] });
    }
  }
  return order;
}

export interface PrefCount {
  pref: string | null;
  count: number;
}

/** 都道府県ごとの件数だけを数える (市区町村名は持たない)。南海トラフ級のような大量件数の
 *  グループを「震度7 高知県31 愛知県27 …」のような県集約サマリで表示するために使う
 *  (第3波 Fix17)。groupByPrefecture と違い「県名そのもの」の area も 1 件として数える
 *  (表示用の重複防止ではなく件数の正確さを優先するため) */
export function countByPrefecture(areas: string[]): PrefCount[] {
  const order: Array<string | null> = [];
  const counts = new Map<string | null, number>();
  for (const area of areas) {
    const pref = matchPrefecture(area);
    if (!counts.has(pref)) {
      counts.set(pref, 0);
      order.push(pref);
    }
    counts.set(pref, counts.get(pref)! + 1);
  }
  return order.map((pref) => ({ pref, count: counts.get(pref)! }));
}

// 都道府県の短縮名 (末尾の 都/府/県 を除去。「静岡県」→「静岡」「大阪府」→「大阪」「東京都」→「東京」)。
// 「北海道」はサフィックスが「道」単体ではなく国名相当のため除去しない (spec §2-a フラットリスト用)
export function shortPrefName(pref: string): string {
  if (pref === "北海道") return pref;
  if (pref.endsWith("都") || pref.endsWith("府") || pref.endsWith("県")) {
    return pref.slice(0, -1);
  }
  return pref;
}
