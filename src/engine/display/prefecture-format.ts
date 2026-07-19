// 都道府県整形ユーティリティ。ticker-sentence と weather-ticker-facts の
// 双方から使う共通モジュール (値参照循環を避けるため独立ファイルに置く)。

/** 47 都道府県の完全名。正規表現の文字クラスだと「京都府」が「京都」+「府」に
 * 割れるため、完全名の前方一致で切り出す (frontend WeatherAlertCard と同方針)。 */
export const PREFECTURES: readonly string[] = [
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

export function prefectureOf(areaName: string): string | null {
  return PREFECTURES.find((p) => areaName.startsWith(p)) ?? null;
}

export const LIST_SEPARATOR = "・";
export const MAX_LISTED = 3;

/** 接尾辞合成: 含まれる 都/道/府/県 を「都道府県」の順で連結する */
function prefectureSuffix(prefs: string[]): string {
  const last = new Set(prefs.map((p) => p[p.length - 1]));
  return ["都", "道", "府", "県"].filter((c) => last.has(c)).join("");
}

/**
 * 地域名列を「茨城県・千葉県・神奈川県など12都県」形式に集約する。
 * 都道府県が取れない名前 (「宗谷地方」等) が混ざる場合はそのままの名前で列挙する。
 */
export function formatPrefectureList(names: string[]): string | null {
  if (names.length === 0) return null;
  const seen = new Set<string>();
  const units: string[] = [];
  let allPrefectures = true;
  for (const name of names) {
    const pref = prefectureOf(name);
    const unit = pref ?? name;
    if (pref == null) allPrefectures = false;
    if (!seen.has(unit)) {
      seen.add(unit);
      units.push(unit);
    }
  }
  if (units.length <= MAX_LISTED) return units.join(LIST_SEPARATOR);
  const listed = units.slice(0, MAX_LISTED).join(LIST_SEPARATOR);
  if (!allPrefectures) return `${listed}など`;
  return `${listed}など${units.length}${prefectureSuffix(units)}`;
}
