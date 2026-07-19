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
export function groupByPrefectureOrRegion(areas: string[]): PrefGroup[] {
  const order: PrefGroup[] = [];
  const prefIndex = new Map<string, number>();
  for (const area of areas) {
    const pref = matchPrefecture(area);
    if (pref != null) {
      let idx = prefIndex.get(pref);
      if (idx == null) {
        idx = order.length;
        prefIndex.set(pref, idx);
        order.push({ pref, cities: [] });
      }
      const city = area.slice(pref.length);
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
