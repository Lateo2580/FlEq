// 気象警報・注意報 (VPWW55-61) の Kind.Code を
//   (1) PhenomenonFamily (災害種別)
//   (2) OfficialAlertLevel (公式警戒レベル相当、対応災害のみ)
//   (3) DisplaySeverity (FlEq 内部の表示・通知強度、全災害共通)
// に解決する。spec: 設計メモ 2026-06-07-vpww-warning-phase-a.md (Phase A.1)
//
// Phase B (VPWP50 retrofit): DisplaySeverity / OfficialAlertLevel / ResolutionSource /
// ResolvedKind の「型定義」は src/types.ts (import ゼロの leaf) に移し、ここからは再 export する。
// FrameLevel も types.ts 定義なので、DISPLAY_SEVERITY_TO_FRAME_LEVEL を dmdata 層に置いても
// engine→ui の依存方向問題は起きない。

import type { FrameLevel, SoundLevel, SignificancyInfo, WeatherAreaLayer, WeatherBriefingTag, TelegramSeverityResolutionSource } from "../types";

export type {
  OfficialAlertLevel,
  DisplaySeverity,
  ResolutionSource,
  ResolvedKind,
  TelegramSeverityResolutionSource,
  BriefingSeverityEvidence,
} from "../types";
import type {
  OfficialAlertLevel,
  DisplaySeverity,
  ResolvedKind,
} from "../types";

// ── PhenomenonFamily ──

export type PhenomenonFamily =
  | "heavyRain"      // 大雨・浸水害 (公式 Level 対応)
  | "landslide"      // 土砂災害 (公式 Level 対応)
  | "stormSurge"     // 高潮 (公式 Level 対応)
  | "flood"          // 洪水 (警戒レベル非対応、riverFlood は別電文系統)
  | "blizzard"       // 暴風雪
  | "storm"          // 暴風
  | "snow"           // 大雪
  | "wave"           // 波浪
  | "gale"           // 強風
  | "snowstorm"      // 風雪
  | "thunder"        // 雷
  | "fog"            // 濃霧
  | "dry"            // 乾燥
  | "avalanche"      // なだれ
  | "lowTemp"        // 低温
  | "frost"          // 霜
  | "iceAccretion"   // 着氷
  | "snowAccretion"  // 着雪
  | "snowmelt"       // 融雪
  | "other"          // その他
  | "release";       // 解除

const CODE_TO_FAMILY: Record<string, PhenomenonFamily> = {
  "00": "release",
  "02": "blizzard", "32": "blizzard",
  "03": "heavyRain", "10": "heavyRain", "33": "heavyRain", "43": "heavyRain",
  "04": "flood", "18": "flood",
  "05": "storm", "35": "storm",
  "06": "snow", "12": "snow", "36": "snow",
  "07": "wave", "16": "wave", "37": "wave",
  "08": "stormSurge", "19": "stormSurge", "38": "stormSurge", "48": "stormSurge",
  "09": "landslide", "29": "landslide", "39": "landslide", "49": "landslide",
  "13": "snowstorm",
  "14": "thunder",
  "15": "gale",
  "17": "snowmelt",
  "20": "fog",
  "21": "dry",
  "22": "avalanche",
  "23": "lowTemp",
  "24": "frost",
  "25": "iceAccretion",
  "26": "snowAccretion",
  "27": "other",
};

export function resolvePhenomenonFamily(
  code: string,
  _kindName: string,
): PhenomenonFamily {
  return CODE_TO_FAMILY[code] ?? "other";
}

// ── OfficialAlertLevel / DisplaySeverity ──
// 型定義は src/types.ts に移設済 (上部で再 export)。値 (RANK 表 / 対応表 / resolver) はここに置く。

export const DISPLAY_SEVERITY_RANK: Record<DisplaySeverity, number> = {
  officialL5:      100,
  officialL4:       90,
  nonLevelSpecial:  85,
  officialL3:       80,
  nonLevelWarning:  75,
  officialL2:       60,
  nonLevelAdvisory: 55,
  officialL1:       40,
  unknown:          30,
  release:          10,
};

// ── 公式警戒レベル相当 Code 表 (対応 4 災害のうち VPWW55-61 内は 3 種別) ──

export const OFFICIAL_LEVEL_CODES: Partial<Record<
  PhenomenonFamily,
  Record<string, OfficialAlertLevel>
>> = {
  heavyRain:  { "10": 2, "03": 3, "43": 4, "33": 5 },
  landslide:  { "29": 2, "09": 3, "49": 4, "39": 5 },
  stormSurge: { "19": 2, "08": 3, "48": 4, "38": 5 },
};

export function resolveAlertLevel(
  kindCode: string,
  family: PhenomenonFamily,
): OfficialAlertLevel | null {
  return OFFICIAL_LEVEL_CODES[family]?.[kindCode] ?? null;
}

// ── 種別名の正規化 + L 表記 ──
// engine (display 射影) と ui (CLI formatter) の双方から使うため import-free の leaf に置く。
// ui/weather-warning-level-theme.ts はここから re-export する (色情報を持たない純関数)。

/**
 * 実 Kind.Name が内包する「レベル<数字>」接頭を除去する。
 * 例: "レベル３大雨警報" → "大雨警報" / "レベル４土砂災害危険警報" → "土砂災害危険警報"
 * 全角・半角どちらの数字も対象。レベル語が無い名前 (暴風警報 等) は変更しない。
 */
export function normalizeKindName(kindName: string): string {
  return kindName.replace(/^レベル[0-9０-９]+/, "");
}

/**
 * 公式警戒レベルを持つ種別は「L3 大雨警報」形式、持たない種別は種別名そのまま。
 * kindName はレベル接頭辞を含む生の Kind.Name でよい (normalizeKindName で剥がす)。
 */
export function formatLevelLabel(
  level: OfficialAlertLevel | null,
  kindName: string,
): string {
  const base = normalizeKindName(kindName);
  return level == null ? base : `L${level} ${base}`;
}

// ── 警戒レベル非対応災害 → displaySeverity ──

export const NON_LEVEL_DISPLAY_SEVERITY: Partial<Record<
  PhenomenonFamily,
  Record<string, DisplaySeverity>
>> = {
  flood:         { "04": "nonLevelWarning", "18": "nonLevelAdvisory" },
  storm:         { "35": "nonLevelSpecial", "05": "nonLevelWarning" },
  blizzard:      { "32": "nonLevelSpecial", "02": "nonLevelWarning" },
  snow:          { "36": "nonLevelSpecial", "06": "nonLevelWarning",
                   "12": "nonLevelAdvisory" },
  wave:          { "37": "nonLevelSpecial", "07": "nonLevelWarning",
                   "16": "nonLevelAdvisory" },
  gale:          { "15": "nonLevelAdvisory" },
  snowstorm:     { "13": "nonLevelAdvisory" },
  thunder:       { "14": "nonLevelAdvisory" },
  fog:           { "20": "nonLevelAdvisory" },
  dry:           { "21": "nonLevelAdvisory" },
  avalanche:     { "22": "nonLevelAdvisory" },
  lowTemp:       { "23": "nonLevelAdvisory" },
  frost:         { "24": "nonLevelAdvisory" },
  iceAccretion:  { "25": "nonLevelAdvisory" },
  snowAccretion: { "26": "nonLevelAdvisory" },
  snowmelt:      { "17": "nonLevelAdvisory" },
  other:         { "27": "nonLevelAdvisory" },
};

export function resolveDisplaySeverity(
  kindCode: string,
  kindName: string,
  family: PhenomenonFamily,
): ResolvedKind {
  const level = resolveAlertLevel(kindCode, family);
  if (level != null) {
    return {
      displaySeverity: `officialL${level}` as DisplaySeverity,
      officialAlertLevel: level,
      source: "map",
    };
  }

  if (kindCode === "00" || kindName.includes("解除")) {
    return { displaySeverity: "release", officialAlertLevel: null, source: "map" };
  }

  const fromMap = NON_LEVEL_DISPLAY_SEVERITY[family]?.[kindCode];
  if (fromMap) {
    return { displaySeverity: fromMap, officialAlertLevel: null, source: "map" };
  }

  // Code/family map に無い場合のフォールバック (Phase A test で nameFallback ヒットがあれば失敗扱い)
  if (kindName.includes("特別警報")) {
    return { displaySeverity: "nonLevelSpecial", officialAlertLevel: null, source: "nameFallback" };
  }
  if (kindName.includes("警報")) {
    return { displaySeverity: "nonLevelWarning", officialAlertLevel: null, source: "nameFallback" };
  }
  if (kindName.includes("注意報")) {
    return { displaySeverity: "nonLevelAdvisory", officialAlertLevel: null, source: "nameFallback" };
  }

  return { displaySeverity: "unknown", officialAlertLevel: null, source: "unknown" };
}

// ── DisplaySeverity → FrameLevel 対応表 (VPWW / VPWP50 共有) ──
// FrameLevel も DisplaySeverity も types.ts 由来なので dmdata 層に置ける (Phase B)。
// weather-core-entry.ts のローカル定義はこれを import する (挙動不変)。

export const DISPLAY_SEVERITY_TO_FRAME_LEVEL: Record<DisplaySeverity, FrameLevel> = {
  officialL5:       "critical",
  officialL4:       "critical",
  nonLevelSpecial:  "critical",
  officialL3:       "warning",
  nonLevelWarning:  "warning",
  officialL2:       "normal",
  nonLevelAdvisory: "normal",
  officialL1:       "info",
  unknown:          "info",
  release:          "cancel",
};

// ── DisplaySeverity → SoundLevel 対応表 (通知音、表示 FrameLevel とは独立) ──
// 2026-06-12 目視ゲートでレビュー決定: 気象警報・注意報系の通知項目が多いため、
// critical 音は特別警報級 (officialL5 / nonLevelSpecial) のみに限定する。
// officialL4 は表示 critical のまま音だけ warning (将来の通知レベル細分化の布石)。
export const DISPLAY_SEVERITY_TO_SOUND_LEVEL: Record<DisplaySeverity, SoundLevel> = {
  officialL5:       "critical",
  nonLevelSpecial:  "critical",
  officialL4:       "warning",
  officialL3:       "warning",
  nonLevelWarning:  "warning",
  officialL2:       "normal",
  nonLevelAdvisory: "normal",
  officialL1:       "info",
  unknown:          "info",
  release:          "cancel",
};

/** SoundLevel の強さ順 (cancel は比較対象外の特殊値) */
export const SOUND_LEVEL_RANK: Record<Exclude<SoundLevel, "cancel">, number> = {
  critical: 4,
  warning: 3,
  normal: 2,
  info: 1,
};

// ── maxDisplaySeverity helper (Phase C) ──

/**
 * 全 layer の全 Kind から DISPLAY_SEVERITY_RANK 最大の displaySeverity を返す。
 * release は対象外、unknown は rank 30 で参加。layer 選択に依存しない (真実源の一本化、Codex R3 P0-1)。
 */
export function computeMaxDisplaySeverity(layers: WeatherAreaLayer[]): DisplaySeverity | null {
  let best: DisplaySeverity | null = null;
  for (const layer of layers) {
    for (const item of layer.items) {
      for (const k of item.kinds) {
        const family = resolvePhenomenonFamily(k.code, k.name);
        const r = resolveDisplaySeverity(k.code, k.name, family);
        if (r.displaySeverity === "release") continue;
        if (best == null || DISPLAY_SEVERITY_RANK[r.displaySeverity] > DISPLAY_SEVERITY_RANK[best]) {
          best = r.displaySeverity;
        }
      }
    }
  }
  return best;
}

// ── maxSoundLevel helper (2026-06-12 共存エッジ解消) ──

/**
 * 全 layer の全 Kind の displaySeverity を音レベルに写して最大を返す (release 除外)。
 * maxDisplaySeverity (RANK 1 点代表) と違い集合ベース — L4 (rank 90) と特別警報級
 * nonLevelSpecial (rank 85) の共存で、特別警報の critical 音が rank 上位の L4
 * (音 warning) に潰されない (2026-06-12 レビュー決定「特別警報級は critical 音」の趣旨)。
 */
export function computeMaxSoundLevel(layers: WeatherAreaLayer[]): SoundLevel | null {
  let best: Exclude<SoundLevel, "cancel"> | null = null;
  for (const layer of layers) {
    for (const item of layer.items) {
      for (const k of item.kinds) {
        const family = resolvePhenomenonFamily(k.code, k.name);
        const r = resolveDisplaySeverity(k.code, k.name, family);
        if (r.displaySeverity === "release") continue;
        const sound = DISPLAY_SEVERITY_TO_SOUND_LEVEL[r.displaySeverity];
        if (sound === "cancel") continue; // release のみが cancel に写るため到達しない防御
        if (best == null || SOUND_LEVEL_RANK[sound] > SOUND_LEVEL_RANK[best]) {
          best = sound;
        }
      }
    }
  }
  return best;
}

// ── VPWP50 Significancy → ResolvedKind (Phase B) ──

/** VPWP50 Significancy alertLevel 系 Code → 公式警戒レベル (0206 別表5)。rank 整合は test で担保 */
export const VPWP50_SIGNIFICANCY_ALERT_LEVEL: Record<string, OfficialAlertLevel> = {
  "21": 2, "22": 2, "31": 3, "41": 4, "51": 5,
};

/**
 * VPWP50 の SignificancyInfo を 2 系統設計の ResolvedKind に解決する。
 * none/below は表示対象外 → null。grade 系は severity から nonLevel*、alertLevel 系は dict。
 * spec v2.1 の「OFFICIAL_LEVEL_CODES へ登録」とは異なる実装を採る (専用 resolver):
 * VPWW Kind Code と VPWP50 Significancy Code は別語彙空間で、merge は将来の衝突リスクになるため。
 */
export function resolveVpwp50Significancy(sig: SignificancyInfo): ResolvedKind | null {
  if (sig.severity === "none" || sig.severity === "below") return null;
  if (sig.family === "alertLevel") {
    const level = VPWP50_SIGNIFICANCY_ALERT_LEVEL[sig.code];
    if (level != null) {
      return { displaySeverity: `officialL${level}` as DisplaySeverity, officialAlertLevel: level, source: "map" };
    }
    return { displaySeverity: "unknown", officialAlertLevel: null, source: "unknown" };
  }
  if (sig.family === "grade") {
    const ds: DisplaySeverity =
      sig.severity === "special" ? "nonLevelSpecial"
      : sig.severity === "warning" ? "nonLevelWarning"
      : "nonLevelAdvisory";
    return { displaySeverity: ds, officialAlertLevel: null, source: "map" };
  }
  return { displaySeverity: "unknown", officialAlertLevel: null, source: "unknown" };
}

// ── Phase D: 電文固有語彙 resolver (VPBS50 / VPHW50-51) ──

/**
 * Phase D: 電文固有語彙 → 2 系統 (表示・音) の解決結果。
 * ResolvedKind と違い soundLevel を明示で持つ — Phase D 電文の nonLevelSpecial 級
 * (線状降水帯発生・記録雨・竜巻目撃) は特別警報の名を持たないため
 * DISPLAY_SEVERITY_TO_SOUND_LEVEL (critical) を適用しない (2026-06-12 レビュー決定)。
 */
export interface ResolvedTelegramSeverity {
  /** null = 対象なし (VPWP50 の maxDisplaySeverity=null と同じ意味論) */
  displaySeverity: DisplaySeverity | null;
  soundLevel: Exclude<SoundLevel, "cancel"> | null;
  source: TelegramSeverityResolutionSource;
}

/** Condition の出自。情報タグ由来の未分類は unknown (安全側昇格)、fallback は none */
export type BriefingConditionOrigin = "tagInformation" | "fallback";

export function resolveBriefingSeverity(
  tag: WeatherBriefingTag,
  origin: BriefingConditionOrigin,
): ResolvedTelegramSeverity {
  switch (tag) {
    case "linearRainObserved":
    case "recordRain":
      return { displaySeverity: "nonLevelSpecial", soundLevel: "warning", source: "map" };
    case "linearRainPredicted":
    case "shortSnow":
      return { displaySeverity: "nonLevelWarning", soundLevel: "warning", source: "map" };
    default:
      return origin === "tagInformation"
        ? { displaySeverity: null, soundLevel: null, source: "unknown" }
        : { displaySeverity: null, soundLevel: null, source: "none" };
  }
}

export function resolveTornadoSeverity(
  hasSightingAreas: boolean,
  isSightingTelegram: boolean,
  activeAreaCount: number,
): ResolvedTelegramSeverity {
  // isSightingTelegram 単独 true は VPHW51 で目撃地域抽出に失敗したフェイルセーフ
  // (現行 tornadoFrameLevel と同じ安全側判定を維持)
  if (hasSightingAreas || isSightingTelegram) {
    return { displaySeverity: "nonLevelSpecial", soundLevel: "warning", source: "map" };
  }
  if (activeAreaCount > 0) {
    return { displaySeverity: "nonLevelWarning", soundLevel: "warning", source: "map" };
  }
  return { displaySeverity: null, soundLevel: null, source: "none" };
}
