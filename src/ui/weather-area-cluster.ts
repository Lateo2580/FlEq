import * as log from "../logger";

/**
 * 予報区コード (6 桁) の上 2 桁 = 都道府県コード を基準に
 * 気象庁公式 11 地方区分へマップする。
 *
 * 公式 11 区分:
 *   北海道 / 東北 / 北陸 / 関東甲信 / 東海 / 近畿 /
 *   中国 / 四国 / 九州北部 / 九州南部・奄美 / 沖縄
 *
 * 北海道内部の予報区は 011000-018000 まで分散しているが
 * すべて prefix=01 で「北海道」に集約する。
 * 鹿児島県の本土 (461100) と奄美地方 (462000) は同じ「九州南部・奄美」。
 */

const PREFECTURE_TO_CLUSTER: Record<string, string> = {
  "01": "北海道",
  "02": "東北", "03": "東北", "04": "東北", "05": "東北", "06": "東北", "07": "東北",
  "08": "関東甲信", "09": "関東甲信", "10": "関東甲信", "11": "関東甲信",
  "12": "関東甲信", "13": "関東甲信", "14": "関東甲信",
  "19": "関東甲信", "20": "関東甲信",
  "15": "北陸", "16": "北陸", "17": "北陸", "18": "北陸",
  "21": "東海", "22": "東海", "23": "東海", "24": "東海",
  "25": "近畿", "26": "近畿", "27": "近畿", "28": "近畿", "29": "近畿", "30": "近畿",
  "31": "中国", "32": "中国", "33": "中国", "34": "中国", "35": "中国",
  "36": "四国", "37": "四国", "38": "四国", "39": "四国",
  "40": "九州北部", "41": "九州北部", "42": "九州北部", "43": "九州北部", "44": "九州北部",
  "45": "九州南部・奄美", "46": "九州南部・奄美",
  "47": "沖縄",
};

const warnedCodes = new Set<string>();

/**
 * 6 桁の予報区コードから 11 地方区分名を返す。
 * 未知コードは "その他" を返し、初回のみ warn ログ。
 */
export function predictionRegionCodeToCluster(code: string): string {
  if (!code || code.length < 2) {
    if (!warnedCodes.has(code)) {
      log.warn(`[weather-area-cluster] empty/short code: "${code}"`);
      warnedCodes.add(code);
    }
    return "その他";
  }
  const prefCode = code.slice(0, 2);
  const cluster = PREFECTURE_TO_CLUSTER[prefCode];
  if (cluster == null) {
    if (!warnedCodes.has(code)) {
      log.warn(`[weather-area-cluster] unknown prefecture prefix: "${prefCode}" (full: "${code}")`);
      warnedCodes.add(code);
    }
    return "その他";
  }
  return cluster;
}

/** テスト用 internal export */
export const __weatherAreaCluster_internals = {
  PREFECTURE_TO_CLUSTER,
  warnedCodes,
};
