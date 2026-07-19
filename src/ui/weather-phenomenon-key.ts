import * as log from "../logger";
import type { PhenomenonKey } from "../types";

/**
 * Kind code (気象庁公式 2 桁コード) を phenomenon family にまとめた canonical key へ正規化する。
 *
 * 気象庁の Kind code は severity ごとに別 code が振られるため、差分計算で
 * 「大雨注意報 (10)」と「大雨警報 (03)」を直接比較すると「解除+新規」になってしまう。
 * 本マップで `(10, 03, 33, 43) → "大雨"` のように同 phenomenon の code をまとめ、
 * 昇格・降格を正しく検知できるようにする。
 *
 * spec §3.1 と整合。新 code が追加されたら本マップに追記する運用。
 */
const KIND_CODE_TO_PHENOMENON: Record<string, PhenomenonKey> = {
  "02": "暴風雪", "32": "暴風雪",
  "03": "大雨", "10": "大雨", "33": "大雨", "43": "大雨",
  "04": "洪水", "18": "洪水",
  "05": "暴風", "35": "暴風",
  "06": "大雪", "12": "大雪", "36": "大雪",
  "07": "波浪", "16": "波浪", "37": "波浪",
  "08": "高潮", "19": "高潮", "38": "高潮", "48": "高潮",
  "09": "土砂災害", "29": "土砂災害", "39": "土砂災害", "49": "土砂災害",
  "13": "風雪",
  "14": "雷",
  "15": "強風",
  "17": "融雪",
  "20": "濃霧",
  "21": "乾燥",
  "22": "なだれ",
  "23": "低温",
  "24": "霜",
  "25": "着氷",
  "26": "着雪",
  "27": "その他注意報",
};

const warnedUnknown = new Set<string>();

/**
 * Kind code を phenomenon key に変換。未知 code は `"unknown_" + code` で
 * フォールバックし、初回のみ warn ログを出す。
 */
export function kindCodeToPhenomenonKey(code: string): PhenomenonKey {
  const known = KIND_CODE_TO_PHENOMENON[code];
  if (known != null) return known;
  if (!warnedUnknown.has(code)) {
    log.warn(`[weather-phenomenon-key] unknown kind code: "${code}" → fallback to "unknown_${code}"`);
    warnedUnknown.add(code);
  }
  return `unknown_${code}`;
}

/** テスト用 internal export */
export const __phenomenonKey_internals = {
  KIND_CODE_TO_PHENOMENON,
  warnedUnknown,
};
