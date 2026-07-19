import type {
  SignificancyFamily,
  SignificancyInfo,
  SignificancySeverity,
} from "../types";

/**
 * VPWP50 (気象警報・注意報時系列情報) の Significancy Code 公式表。
 *
 * 公式仕様書 `0206-0206_appendix.pdf` 別表5 に基づく現行 11 Code。
 * 将来追加の可能性は否定しないが、未知 Code は parser 側で
 * `unknownCodes[]` に分離し、本体最大 (`maxKnownSignificancy`) には混ぜない。
 *
 * 公式 Code 体系:
 *   - grade 系 (注意報級/警報級/特別警報級): 00 / 01 / 20 / 30 / 50
 *   - alertLevel 系 (警戒レベル相当): 11 / 21 / 22 / 31 / 41 / 51
 *
 * frame level 判定は `src/engine/presentation/level-helpers.ts` の
 * `weatherWarningTimeseriesFrameLevel` 側に分離 (R3 レビュー指摘)。
 */
const COMMON: Record<
  string,
  Omit<SignificancyInfo, "code" | "known">
> = {
  "00": {
    rank: 0,
    family: "none",
    label: "値なし",
    compact: "なし",
    severity: "none",
  },
  "01": {
    rank: 1,
    family: "grade",
    label: "注意報級未満",
    compact: "未満",
    severity: "below",
  },
  "11": {
    rank: 1,
    family: "alertLevel",
    label: "警戒レベル2未満",
    compact: "L2未",
    severity: "below",
  },
  "20": {
    rank: 2,
    family: "grade",
    label: "注意報級",
    compact: "注",
    severity: "advisory",
  },
  "21": {
    rank: 2,
    family: "alertLevel",
    label: "警戒レベル2",
    compact: "L2",
    severity: "advisory",
  },
  "22": {
    rank: 2,
    family: "alertLevel",
    label: "警戒レベル2相当",
    compact: "L2相",
    severity: "advisory",
  },
  "30": {
    rank: 3,
    family: "grade",
    label: "警報級",
    compact: "警",
    severity: "warning",
  },
  "31": {
    rank: 3,
    family: "alertLevel",
    label: "警戒レベル3相当",
    compact: "L3相",
    severity: "warning",
  },
  "41": {
    rank: 4,
    family: "alertLevel",
    label: "警戒レベル4相当",
    compact: "L4相",
    severity: "warning",
  },
  "50": {
    rank: 5,
    family: "grade",
    label: "特別警報級",
    compact: "特",
    severity: "special",
  },
  "51": {
    rank: 5,
    family: "alertLevel",
    label: "警戒レベル5相当",
    compact: "L5相",
    severity: "special",
  },
};

/**
 * Property Type ごとの override (将来「高潮だけ解釈差」等が来た場合の差し替え用)。
 * 現状は空。
 */
const PROPERTY_OVERRIDES: Record<string, Partial<typeof COMMON>> = {};

/**
 * Significancy Code を分類する。
 *
 * - 公式表に存在する Code: `known: true` でメタ情報を返す
 * - 未知の Code: `known: false`、`family: "unknown"`、`rank: 999`、表示 `?XX` で返す
 *
 * 「数値順比較」「推測補完」は禁止 — このテーブル経由でのみ rank/severity を決める。
 */
export function classifySignificancyCode(
  propertyType: string,
  code: string,
): SignificancyInfo {
  const def = PROPERTY_OVERRIDES[propertyType]?.[code] ?? COMMON[code];
  if (def == null) {
    return {
      code,
      known: false,
      rank: 999,
      family: "unknown" as SignificancyFamily,
      label: `未知Code ${code}`,
      compact: `?${code}`,
      severity: "unknown" as SignificancySeverity,
    };
  }
  return { code, known: true, ...def };
}

/**
 * 既知 Code 同士で worst を選ぶ。
 * 未知 Code は呼び出し側で別経路 (`unknownCodes[]`) に分離されている前提。
 * 同 rank なら severity の優先度 (special > warning > advisory > below > none) で決める。
 */
export function pickWorstKnownSignificancy(
  candidates: SignificancyInfo[],
): SignificancyInfo | null {
  const known = candidates.filter((c) => c.known);
  if (known.length === 0) return null;
  return known.reduce((best, cur) => {
    if (cur.rank > best.rank) return cur;
    if (cur.rank < best.rank) return best;
    return severityPriority(cur.severity) > severityPriority(best.severity)
      ? cur
      : best;
  });
}

function severityPriority(s: SignificancySeverity): number {
  switch (s) {
    case "special": return 5;
    case "warning": return 4;
    case "advisory": return 3;
    case "below": return 2;
    case "none": return 1;
    case "unknown": return 0;
  }
}

/**
 * Property.Type ごとの自然語マップ。
 *
 * 構造: propertyType → { base: 基本名, severity ごとの完全名上書き (任意) }
 *
 * 「危険度」サフィックスを持つ propertyType (土砂災害危険度 / 高潮危険度 / 浸水危険度) は
 * base から「危険度」を取り除いた名前 + severity suffix で表示する。
 * 一部の propertyType は severity で base 名が変わる (例: 風 → 強風/暴風)。
 */
export type KindNameEntry = {
  base: string;
  overrides?: Partial<Record<SignificancySeverity, string>>;
};

export const KIND_NAME_MAP: Record<string, KindNameEntry> = {
  // 雨・洪水・浸水系
  "雨":             { base: "大雨" },         // 「雨」= 大雨
  "大雨":           { base: "大雨" },
  "大雨浸水危険度": { base: "大雨" },         // 浸水危険度 = 大雨警報の浸水部分
  "洪水":           { base: "洪水" },
  "浸水危険度":     { base: "浸水" },
  "土砂災害危険度": { base: "土砂災害" },

  // 風系 (severity で完全名が変わる)
  "風": {
    base: "風",
    overrides: {
      advisory: "強風注意報",
      warning: "暴風警報",
      special: "暴風特別警報",
    },
  },
  "風危険度": {
    base: "風",
    overrides: {
      advisory: "強風注意報",
      warning: "暴風警報",
      special: "暴風特別警報",
    },
  },
  "暴風":   { base: "暴風" },
  "強風":   { base: "強風" },
  "暴風雪": { base: "暴風雪" },

  // 雪・寒気系
  "雪":         { base: "大雪" },             // 「雪」= 大雪
  "大雪":       { base: "大雪" },
  "雪危険度":   { base: "大雪" },
  "なだれ":     { base: "なだれ" },
  "着雪":       { base: "着雪" },
  "着雪危険度": { base: "着雪" },
  "着氷":       { base: "着氷" },
  "着氷危険度": { base: "着氷" },
  "融雪":       { base: "融雪" },
  "融雪危険度": { base: "融雪" },
  "霜":         { base: "霜" },
  "低温":       { base: "低温" },

  // 海岸系
  "波":         { base: "波浪" },             // 「波」= 波浪
  "波浪":       { base: "波浪" },
  "波危険度":   { base: "波浪" },
  "高潮":       { base: "高潮" },
  "高潮危険度": { base: "高潮" },

  // その他
  "雷":         { base: "雷" },
  "雷危険度":   { base: "雷" },
  "濃霧":       { base: "濃霧" },
  "濃霧危険度": { base: "濃霧" },
  "乾燥":       { base: "乾燥" },
};

/**
 * Property.Type と severity から自然語の種別名を組み立てる。
 *
 * 1. KIND_NAME_MAP を引く
 * 2. overrides に severity 完全名があればそれを返す
 * 3. base + tier suffix (special: 特別警報、warning: 警報、advisory: 注意報、unknown: 警報)
 * 4. KIND_NAME_MAP に無い propertyType は fallback (`/危険度$/` 除去 + tier suffix)
 * 5. none/below severity は base のみ
 */
export function normalizeKindName(
  propertyType: string,
  severity: SignificancySeverity,
): string {
  const entry = KIND_NAME_MAP[propertyType];

  if (severity === "none" || severity === "below") {
    return entry?.base ?? propertyType;
  }

  const tierSuffix =
    severity === "special" ? "特別警報"
    : severity === "warning" ? "警報"
    : severity === "advisory" ? "注意報"
    : "警報";  // unknown は warning 扱い

  if (entry) {
    const override = entry.overrides?.[severity];
    if (override) return override;
    return entry.base + tierSuffix;
  }

  // fallback: 機械式
  const base = propertyType.replace(/危険度$/, "");
  return base + tierSuffix;
}
