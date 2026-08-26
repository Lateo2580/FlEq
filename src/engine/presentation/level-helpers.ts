import type { FrameLevel } from "../../types";
import type { SoundLevel } from "../notification/sound-player";
import type {
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedSeismicTextInfo,
  ParsedLgObservationInfo,
  ParsedTsunamiInfo,
  ParsedNankaiTroughInfo,
  ParsedWeatherWarning,
  ParsedTornadoAdvisory,
  ParsedWeatherBriefing,
  ParsedEarlyWeatherInfo,
  ParsedWeatherWarningTimeseriesInfo,
  ParsedClimateInfo,
  ParsedWeatherExplanation,
  ParsedHeatAlertInfo,
  ParsedTyphoonAnalysis,
  ParsedTyphoonProbability,
  ParsedFloodForecastInfo,
  FloodLevel,
  JmaIntensity,
  JmaLgIntensity,
  SpecialValue,
} from "../../types";
import {
  evaluateIntensitySafetyRank,
  evaluateLgIntensitySafetyRank,
  intensityToRank,
} from "../../utils/intensity";
import {
  DISPLAY_SEVERITY_TO_FRAME_LEVEL,
  SOUND_LEVEL_RANK,
} from "../../dmdata/weather-warning-level";
import {
  FLOOD_LEVEL_RANK,
  maxFloodLevel,
  floodKindCodeToLevel,
  floodLevelToFrameLevel,
  floodLevelToSoundLevel,
} from "../../dmdata/flood-level";
import {
  evaluateEewIntensitySafetyGate,
  getMaxForecastIntensityEvaluation,
  type EewIntensitySafetyGate,
} from "../eew/eew-tracker";

// ── frameLevel ──

export interface EewLevels {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
  forecastSafetyGate: EewIntensitySafetyGate;
}

export type SpecialValueTextMode = "detail" | "display" | "notification" | "ticker";

function intensityTextToken(value: JmaIntensity): string {
  return ({
    "0": "0", "1": "1", "2": "2", "3": "3", "4": "4",
    "5-": "5弱", "5+": "5強", "6-": "6弱", "6+": "6強", "7": "7",
  } satisfies Record<JmaIntensity, string>)[value];
}

function specialValueQualifier<T extends string>(value: SpecialValue<T>): string | null {
  for (const candidate of [value.condition, value.description, value.raw]) {
    const normalized = candidate?.normalize("NFKC").trim();
    if (normalized != null && normalized !== "") {
      return normalized.replace(/^(?:震度|階級)/, "");
    }
  }
  return null;
}

/** CLI・通知・ticker が共用する SpecialValue の純粋本文 formatter。 */
function formatSpecialValueText<T extends string>(
  value: SpecialValue<T> | undefined,
  scalar: string | null | undefined,
  token: (item: T) => string,
  mode: SpecialValueTextMode,
): string | null {
  if (value == null) return scalar == null || scalar === "" ? null : scalar;
  switch (value.presence) {
    case "value":
      return scalar != null && scalar !== "" ? scalar : value.value == null ? null : token(value.value);
    case "missing":
      return mode === "detail" || mode === "display" ? "—" : null;
    case "empty":
      return mode === "detail" || mode === "display" ? "（空欄）" : null;
    case "unknown": {
      if (mode === "detail" || mode === "ticker") return "不明";
      const reason = specialValueQualifier(value);
      return reason == null || reason === "不明" ? "不明" : `不明（${reason}）`;
    }
    case "range": {
      const lower = value.lowerBound == null ? null : token(value.lowerBound);
      const upper = value.upperBound == null ? null : token(value.upperBound);
      if (lower != null && upper != null) return lower === upper ? lower : `${lower}〜${upper}`;
      if (lower != null) {
        return value.rawUpperBound?.normalize("NFKC").trim().toLowerCase() === "over"
          ? `${lower}程度以上`
          : `${lower}以上`;
      }
      if (upper != null) return `${upper}以下`;
      return "不明";
    }
    case "qualitative": {
      const qualifier = specialValueQualifier(value);
      if (qualifier != null) return qualifier;
      const lower = value.lowerBound == null ? null : token(value.lowerBound);
      const upper = value.upperBound == null ? null : token(value.upperBound);
      if (lower != null && upper != null) return lower === upper ? `${lower}程度` : `${lower}〜${upper}`;
      if (lower != null) return `${lower}以上`;
      if (upper != null) return `${upper}以下`;
      return "不明";
    }
  }
}

export function formatIntensitySpecialValue(
  value: SpecialValue<JmaIntensity> | undefined,
  scalar?: string | null,
  mode: SpecialValueTextMode = "display",
): string | null {
  const normalizedScalar = scalar != null && intensityToRank(scalar) > 0
    ? scalar.replace(/\s+/g, "")
    : scalar;
  return formatSpecialValueText(value, normalizedScalar, intensityTextToken, mode);
}

export function formatLgIntensitySpecialValue(
  value: SpecialValue<JmaLgIntensity> | undefined,
  scalar?: string | null,
  mode: SpecialValueTextMode = "display",
): string | null {
  return formatSpecialValueText(value, scalar, (item) => item, mode);
}

/** EEW の公式 warning 区分と予測震度 safety gate を一度に解決する。 */
export function resolveEewLevels(
  info: ParsedEewInfo,
  minimumForecastRank = 5,
): EewLevels {
  const forecast = getMaxForecastIntensityEvaluation(info.forecastIntensity);
  const forecastSafetyGate = evaluateEewIntensitySafetyGate(forecast, minimumForecastRank);
  return {
    frameLevel: info.infoType === "取消"
      ? "cancel"
      : info.isWarning
        ? "critical"
        : "warning",
    // 取消音は他 domain と同じ cancel。通常報は unknown gate で静音化しない。
    soundLevel: info.infoType === "取消"
      ? "cancel"
      : info.isWarning
        ? "critical"
        : "warning",
    forecastSafetyGate,
  };
}

export function eewForecastSafetyGate(
  info: ParsedEewInfo,
  minimumRank: number,
): EewIntensitySafetyGate {
  return resolveEewLevels(info, minimumRank).forecastSafetyGate;
}

export function eewFrameLevel(info: ParsedEewInfo): FrameLevel {
  return resolveEewLevels(info).frameLevel;
}

/** SpecialValue の safety 側代表 rank。range は上端、lower-only/qualitative は下端を使う。 */
export function resolveIntensitySafetyRank(
  value: SpecialValue<JmaIntensity> | undefined,
  scalar?: string | null,
): number | null {
  if (value != null) {
    const safety = evaluateIntensitySafetyRank(value);
    if (safety.kind !== "known") return null;
    return value.presence === "range" ? safety.upper ?? safety.lower : safety.lower;
  }
  if (scalar == null || scalar.trim() === "") return null;
  return intensityToRank(scalar);
}

/** 長周期階級の safety 側代表 rank。震度とは別の 0〜4 評価を使う。 */
export function resolveLgIntensitySafetyRank(
  value: SpecialValue<JmaLgIntensity> | undefined,
  scalar?: string | null,
): number | null {
  if (value != null) {
    const safety = evaluateLgIntensitySafetyRank(value);
    if (safety.kind !== "known") return null;
    return value.presence === "range" ? safety.upper ?? safety.lower : safety.lower;
  }
  if (scalar == null || !/^[0-4]$/.test(scalar.trim())) return null;
  return Number(scalar.trim());
}

export function earthquakeFrameLevel(info: ParsedEarthquakeInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.intensity) {
    if (info.intensity.maxIntValue?.presence === "unknown") return "info";
    const rank = resolveIntensitySafetyRank(
      info.intensity.maxIntValue,
      info.intensity.maxInt,
    ) ?? 0;
    if (rank >= 7) return "critical";
    if (rank >= 4) return "warning";
  }
  return "normal";
}

export function tsunamiFrameLevel(info: ParsedTsunamiInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const kinds = (info.forecast || []).map((f) => f.kind);
  if (kinds.some((kind) => kind.includes("大津波警報"))) return "critical";
  if (kinds.some((kind) => kind.includes("津波警報"))) return "warning";
  return "normal";
}

export function seismicTextFrameLevel(info: ParsedSeismicTextInfo): FrameLevel {
  return info.infoType === "取消" ? "cancel" : "info";
}

export function nankaiTroughFrameLevel(
  info: ParsedNankaiTroughInfo,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.infoSerial) return "warning";
  const code = info.infoSerial.code;
  if (code === "120") return "critical";
  if (code === "130") return "warning";
  if (code === "111" || code === "112" || code === "113") return "warning";
  if (code === "210" || code === "219") return "warning";
  if (code === "190" || code === "200") return "info";
  return "warning";
}

export function lgObservationFrameLevel(
  info: ParsedLgObservationInfo,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const rank = resolveLgIntensitySafetyRank(info.maxLgIntValue, info.maxLgInt);
  if (rank != null && rank >= 4) return "critical";
  if (rank != null && rank >= 3) return "warning";
  if (rank != null && rank >= 2) return "normal";
  return "info";
}

/**
 * 気象警報・注意報 (VPWW55-61, VPWS50) の FrameLevel 判定。
 * Phase C: displaySeverity ベース (spec 乖離 3 解消、表示 weatherCoreFrameLevel と整合)。
 *   - 取消 → cancel
 *   - maxDisplaySeverity = officialL5/L4/nonLevelSpecial → critical
 *   - officialL3/nonLevelWarning → warning
 *   - officialL2/nonLevelAdvisory → normal
 *   - officialL1/unknown → info / null (解除のみ等) → info
 */
export function weatherFrameLevel(info: ParsedWeatherWarning): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.maxDisplaySeverity == null) return "info";
  // maxDisplaySeverity は release を取りえない (computeMaxDisplaySeverity が除外するため、
  // DISPLAY_SEVERITY_TO_FRAME_LEVEL[release]="cancel" には到達しない)
  return DISPLAY_SEVERITY_TO_FRAME_LEVEL[info.maxDisplaySeverity];
}

// ── soundLevel ──

export function eewSoundLevel(info: ParsedEewInfo): SoundLevel {
  return resolveEewLevels(info).soundLevel;
}

export function earthquakeSoundLevel(info: ParsedEarthquakeInfo): SoundLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.intensity) return "normal";
  if (info.intensity.maxIntValue?.presence === "unknown") return "info";
  const rank = resolveIntensitySafetyRank(
    info.intensity.maxIntValue,
    info.intensity.maxInt,
  );
  return rank != null && rank >= 4 ? "warning" : "normal";
}

export function tsunamiSoundLevel(info: ParsedTsunamiInfo): SoundLevel {
  if (info.infoType === "取消") return "cancel";
  if (!info.forecast || info.forecast.length === 0) return "normal";
  const kinds = info.forecast.map((f) => f.kind);
  if (kinds.every((k) => k.includes("津波予報"))) return "warning";
  if (kinds.some((k) => k.includes("津波") && !k.includes("解除")))
    return "critical";
  if (kinds.some((k) => k.includes("解除"))) return "warning";
  return "normal";
}

export function seismicTextSoundLevel(
  _info: ParsedSeismicTextInfo,
): SoundLevel {
  return "info";
}

export function nankaiTroughSoundLevel(
  info: ParsedNankaiTroughInfo,
): SoundLevel {
  return info.infoSerial?.code === "120" ? "critical" : "warning";
}

export function lgObservationSoundLevel(
  info: ParsedLgObservationInfo,
): SoundLevel {
  if (info.infoType === "取消") return "cancel";
  const rank = resolveLgIntensitySafetyRank(info.maxLgIntValue, info.maxLgInt);
  if (rank != null && rank >= 3) return "critical";
  if (rank != null && rank >= 1) return "warning";
  return "normal";
}

/**
 * 気象警報・注意報 (VPWW55-61, VPWS50) の SoundLevel 判定。
 * 2026-06-12 目視ゲートでレビュー決定: 通知音は表示 (weatherFrameLevel) と独立。
 * critical 音は特別警報級 (officialL5/nonLevelSpecial) のみで、officialL4 は
 * 表示 critical のまま音だけ warning。
 *
 * 音は parser が集合ベースで導出する maxSoundLevel を見る (2026-06-12 共存エッジ解消)。
 * maxDisplaySeverity (RANK 1 点代表) 経由だと officialL4 (rank 90) と nonLevelSpecial
 * (rank 85) の共存で特別警報の critical 音が warning に潰れていた。
 *   - 取消 → cancel (据置)
 *   - maxSoundLevel = null (対象 Kind なし) → info (据置)
 *   - その他 → maxSoundLevel (集合ベース最大)
 */
export function weatherSoundLevel(info: ParsedWeatherWarning): SoundLevel {
  // [Codex VPCJ51-R2 横展開] 取消は presentation 層でも "cancel" に統一。
  // 以前は "info" を返していたが、PresentationEvent.soundLevel や event log で
  // 取消フラグが薄まる懸念があった。通知本体 (notifier 側) は cancel を直指定して
  // いたが、presentation 層と統一することで層間整合が取れる。
  if (info.infoType === "取消") return "cancel";
  return info.maxSoundLevel ?? "info";
}

/**
 * 竜巻注意情報の FrameLevel 判定 (Phase D: parser 段の displaySeverity を単一真実源に)。
 *   - 取消 → cancel / displaySeverity=null (発表地域 0) → info
 *   - その他 → DISPLAY_SEVERITY_TO_FRAME_LEVEL[displaySeverity]
 *     (目撃=nonLevelSpecial→critical、発表=nonLevelWarning→warning)
 */
export function tornadoFrameLevel(info: ParsedTornadoAdvisory): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  if (info.displaySeverity == null) return "info";
  return DISPLAY_SEVERITY_TO_FRAME_LEVEL[info.displaySeverity];
}

export function tornadoSoundLevel(info: ParsedTornadoAdvisory): SoundLevel {
  // [Codex VPCJ51-R2 横展開] 取消は "cancel" に統一 (上記 weatherSoundLevel と同じ理由)。
  // Phase D: 音は parser 段の soundLevel を見る (表示と独立。目撃でも warning —
  // 2026-06-12 レビュー決定)。soundLevel=null (発表地域 0) は info。
  if (info.infoType === "取消") return "cancel";
  return info.soundLevel ?? "info";
}

/**
 * 気象防災速報の FrameLevel 判定 (Phase D: 集合ベース maxDisplaySeverity + unknown 昇格)。
 *   - 取消 → cancel
 *   - maxDisplaySeverity あり → DISPLAY_SEVERITY_TO_FRAME_LEVEL[maxDisplaySeverity]
 *     (線状降水帯発生 / 記録雨=nonLevelSpecial→critical、線状降水帯予想 / 短時間大雪=
 *     nonLevelWarning→warning)
 *   - 情報タグ由来の未分類 Condition (unknownConditions) は最低 warning へ昇格
 *     (critical を潰さないよう base が info/normal のときのみ)。VPWP50 の未知 Code
 *     昇格 (weatherWarningTimeseriesFrameLevel) も 2026-06-12 の降格バグ修正で
 *     同型になった
 */
export function briefingFrameLevel(info: ParsedWeatherBriefing): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const base: FrameLevel = info.maxDisplaySeverity != null
    ? DISPLAY_SEVERITY_TO_FRAME_LEVEL[info.maxDisplaySeverity]
    : "info";
  if (info.unknownConditions.length > 0 && (base === "info" || base === "normal")) {
    return "warning";
  }
  return base;
}

export function briefingSoundLevel(info: ParsedWeatherBriefing): SoundLevel {
  // [Codex VPCJ51-R2 横展開] 取消は "cancel" に統一 (上記 weatherSoundLevel と同じ理由)。
  // Phase D: 音は parser 段の集合ベース maxSoundLevel を見る (表示と独立。線状降水帯発生・
  // 記録雨でも warning — 2026-06-12 レビュー決定)。unknownConditions は最低 warning へ昇格
  // (critical は潰さない)。
  if (info.infoType === "取消") return "cancel";
  const base = info.maxSoundLevel;
  if (base == null) return info.unknownConditions.length > 0 ? "warning" : "info";
  // maxSoundLevel は cancel を取りえない (resolveBriefingSeverity が cancel を返さないため) — 型narrow用の防御
  if (base === "cancel") return "cancel";
  if (
    info.unknownConditions.length > 0 &&
    SOUND_LEVEL_RANK[base] < SOUND_LEVEL_RANK.warning
  ) {
    return "warning";
  }
  return base;
}

/**
 * 早期天候情報の FrameLevel 判定。
 *   - 取消 → cancel
 *   - その他 → normal (実時間警報ではなく長期予報のため控えめ)
 *
 * 内容によらず一律 normal で扱う。これは「実際の災害発生」ではなく
 * 「5〜7 日後の異常天候の可能性予告」のため。critical/warning は
 * 警報・注意報や竜巻情報に予約する。
 */
export function earlyWeatherFrameLevel(info: ParsedEarlyWeatherInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  return "normal";
}

export function earlyWeatherSoundLevel(
  info: ParsedEarlyWeatherInfo,
): SoundLevel {
  // [Codex R1 W2 (VPCJ51 で発覚) 横展開] 取消は presentation 層でも "cancel" に揃える。
  // 以前は "info" を返していたが、PresentationEvent.soundLevel や event log で
  // 取消フラグが薄まる懸念があった。通知本体 (notifier 側) は cancel を直指定して
  // いたが、presentation 層と統一することで層間整合が取れる。
  if (info.infoType === "取消") return "cancel";
  return "normal";
}

/**
 * 気象警報・注意報時系列情報 (VPWP50) の FrameLevel 判定 (Phase B: displaySeverity ベース)。
 *   - 取消                          → cancel
 *   - maxDisplaySeverity == null    → info (既知 Significancy なし)
 *   - その他                         → DISPLAY_SEVERITY_TO_FRAME_LEVEL[maxDisplaySeverity]
 *   - 未知 Code 含む                 → 最低 warning へ昇格 (見落とし防止。base が info/normal の
 *     ときのみ昇格し、critical/warning は潰さない — 音側ガード・briefingFrameLevel と同型)
 *
 * 2026-06-12 降格バグ修正: 旧実装は unknownCodes 非空で本体最大より先に warning を return
 * しており、Phase B の critical 導入 (Code 41/51/grade 50) 以降は L4/L5/特別警報級の表示を
 * warning に降格させていた (導入時は frame 最大が warning だったため無害だった早期 return が、
 * Phase B で潜在バグ化。音側は 2026-06-12 共存エッジ解消で先に修正済みだった)。
 *
 * Phase B の挙動変更は **Code 41 (officialL4) のみ: warning → critical** (VPWW と整合)。
 * 他 Code の frame/sound は維持される (officialL5/nonLevelSpecial=critical、officialL3/
 * nonLevelWarning=warning、officialL2/nonLevelAdvisory=normal)。
 *
 * 未知 Code 判定は `parsed.unknownCodes` (parser が本体最大と分離保持) を見る。本体最大に
 * 混ぜないことで、`?99` が L5/L4 より前に出るのを防ぐ。
 */
export function weatherWarningTimeseriesFrameLevel(
  info: ParsedWeatherWarningTimeseriesInfo,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  const base: FrameLevel = info.maxDisplaySeverity != null
    ? DISPLAY_SEVERITY_TO_FRAME_LEVEL[info.maxDisplaySeverity]
    : "info";
  if (info.unknownCodes.length > 0 && (base === "info" || base === "normal")) {
    return "warning";
  }
  return base;
}

/**
 * 気象警報・注意報時系列情報 (VPWP50) の SoundLevel 判定。
 * 2026-06-12 目視ゲートでレビュー決定: weatherSoundLevel と同じく通知音は表示と独立
 * (officialL4 は音だけ warning)。音は parser の集合ベース maxSoundLevel を見る
 * (2026-06-12 共存エッジ解消 — Code 41+50 共存で特別警報の critical 音が潰れない)。
 *
 * 未知 Code の warning 昇格 (見落とし防止ガード) は「最低 warning へ昇格」の意味で維持:
 * maxSoundLevel が critical ならそちらが勝つ (warning に降格させない)。
 */
export function weatherWarningTimeseriesSoundLevel(
  info: ParsedWeatherWarningTimeseriesInfo,
): SoundLevel {
  // [Codex VPCJ51-R2 横展開] 取消は "cancel" に統一 (上記 weatherSoundLevel と同じ理由)
  if (info.infoType === "取消") return "cancel";
  const sound = info.maxSoundLevel;
  if (sound == null) return info.unknownCodes.length > 0 ? "warning" : "info";
  // maxSoundLevel は cancel を取りえない (集合ベース導出が release を除外するため) — 型narrow用の防御
  if (sound === "cancel") return "cancel";
  if (
    info.unknownCodes.length > 0 &&
    SOUND_LEVEL_RANK[sound] < SOUND_LEVEL_RANK.warning
  ) {
    return "warning";
  }
  return sound;
}

/**
 * 全般天候情報 (VPZI50) の FrameLevel 判定。
 *   - 取消 → cancel
 *   - その他 → normal
 *
 * 内容によらず一律 normal で扱う。実時間警報ではなく長期 (1〜数ヶ月) の
 * 気候統計情報のため、critical / warning は警報・注意報や竜巻情報に予約する。
 * 早期天候情報 (VPAW51) と同じ方針。
 */
export function climateInfoFrameLevel(info: ParsedClimateInfo): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  return "normal";
}

export function climateInfoSoundLevel(info: ParsedClimateInfo): SoundLevel {
  // [Codex R1 W2 (VPCJ51 で発覚) 横展開] 取消は "cancel" に統一 (上記 earlyWeather と同じ)
  if (info.infoType === "取消") return "cancel";
  return "normal";
}

/** resolveHeatAlertLevels の戻り値 (frame と sound の pair) */
export interface HeatAlertLevels {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
}

/**
 * 熱中症警戒アラート (VPFT50) の表示・音レベルを解決する。
 * frame/sound を別関数に直書きすると将来 drift するため pair で返す (Codex R2)。
 * - 取消 > タイトル昇格 > 通常 の順で判定 (取消が最優先)
 * - タイトルに「特別警戒」を含む場合は表示 critical / 音 warning
 *   (将来、環境省の特別警戒アラート級が同型電文で配信された場合のフェイルセーフ。
 *    音は原則どおり warning 止まり — critical 音 = 特別警報そのもののみ)
 * - 通常の発表 = 表示 warning / 音 warning (nonLevelWarning 相当)
 * 語彙が増えて集合解決・未知語処理が要るようになったら parser 段 resolver
 * (weather-warning-level.ts) へ昇格する。
 */
export function resolveHeatAlertLevels(info: ParsedHeatAlertInfo): HeatAlertLevels {
  if (info.infoType === "取消") {
    return { frameLevel: "cancel", soundLevel: "cancel" };
  }
  if (info.title.includes("特別警戒")) {
    return { frameLevel: "critical", soundLevel: "warning" };
  }
  return { frameLevel: "warning", soundLevel: "warning" };
}

export function heatAlertFrameLevel(info: ParsedHeatAlertInfo): FrameLevel {
  return resolveHeatAlertLevels(info).frameLevel;
}

export function heatAlertSoundLevel(info: ParsedHeatAlertInfo): SoundLevel {
  return resolveHeatAlertLevels(info).soundLevel;
}

/** typhoonAnalysis の frame/sound pair 返却型 */
export interface TyphoonAnalysisLevels {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
}

/** 台風解析・予報情報 (VPTW60/61/62) の frame/sound を pair で解決。
 *  定時解析・予報のため一律 normal（解説扱い）。段階化は持ち越し⑤。 */
export function resolveTyphoonAnalysisLevels(
  info: Pick<ParsedTyphoonAnalysis, "infoType">,
): TyphoonAnalysisLevels {
  if (info.infoType === "取消") return { frameLevel: "cancel", soundLevel: "cancel" };
  return { frameLevel: "normal", soundLevel: "normal" };
}

export function typhoonAnalysisFrameLevel(info: ParsedTyphoonAnalysis): FrameLevel {
  return resolveTyphoonAnalysisLevels(info).frameLevel;
}

export function typhoonAnalysisSoundLevel(info: ParsedTyphoonAnalysis): SoundLevel {
  return resolveTyphoonAnalysisLevels(info).soundLevel;
}

/** 台風の暴風域に入る確率 (VPTA50) の frame/sound を pair で解決。
 *  - 取消: cancel/cancel
 *  - 発表 maxDaily5>0: normal/normal
 *  - 発表 maxDaily5===0: normal/info（静音化）*/
export function resolveTyphoonProbabilityLevels(
  info: Pick<ParsedTyphoonProbability, "infoType" | "regions">,
): { frameLevel: FrameLevel; soundLevel: SoundLevel; maxDaily5: number } {
  if (info.infoType === "取消") {
    return { frameLevel: "cancel", soundLevel: "cancel", maxDaily5: 0 };
  }
  const maxDaily5 = info.regions.reduce(
    (m, r) => Math.max(m, r.daily[4] ?? 0),
    0,
  );
  const soundLevel: SoundLevel = maxDaily5 > 0 ? "normal" : "info";
  return { frameLevel: "normal", soundLevel, maxDaily5 };
}

/** resolveFloodForecastLevels の戻り値 */
export interface FloodForecastLevels {
  frameLevel: FrameLevel;
  soundLevel: SoundLevel;
  maxLevel: FloodLevel;
  maxRank: number;
}

/**
 * 指定河川洪水予報 (VXKO50-89 / VXSU50-59) の frame/sound を pair で解決。
 *
 *  - 取消: cancel/cancel (maxLevel=release)
 *  - 発表: headlines + rawStations の Kind.Code から最大 FloodLevel を導出し、
 *    floodLevelTo{Frame,Sound}Level で 写像 (spec §6.1):
 *      L1=info/info, L2=normal/normal, L3=warning/warning,
 *      L4=critical/warning (音は warning 止まり), L5=critical/critical,
 *      release=cancel/cancel, unknown=info/info
 *
 * critical 音 = 特別警報の名を持つもの (= L5 氾濫発生情報) のみ。L4 (氾濫危険警報)
 * は表示 critical / 音 warning。memory `vpww_phase_d_complete` の原則
 * (heatAlert / weather / VPWP50 と同型)。
 *
 * `maxLevel` の決定は headlines (scope 関係なく) と rawStations の
 * headlineKindCode を全部集めて maxFloodLevel で取る。scope=河川 の headline 優先
 * は formatter 側の表示代表決定 (headlineText 抽出) で別途実施する。
 */
export function resolveFloodForecastLevels(
  info: Pick<ParsedFloodForecastInfo, "infoType" | "headlines" | "rawStations">,
): FloodForecastLevels {
  if (info.infoType === "取消") {
    return {
      frameLevel: "cancel",
      soundLevel: "cancel",
      maxLevel: "release",
      maxRank: FLOOD_LEVEL_RANK.release,
    };
  }
  const levels: FloodLevel[] = [];
  for (const h of info.headlines) {
    levels.push(floodKindCodeToLevel(h.kindCode));
  }
  for (const s of info.rawStations) {
    levels.push(floodKindCodeToLevel(s.headlineKindCode));
  }
  const maxLevel = maxFloodLevel(levels);
  return {
    frameLevel: floodLevelToFrameLevel(maxLevel),
    soundLevel: floodLevelToSoundLevel(maxLevel),
    maxLevel,
    maxRank: FLOOD_LEVEL_RANK[maxLevel],
  };
}

/**
 * 気象解説情報 (VPCJ51/VPZJ51 共有) の FrameLevel 判定。
 *   - 取消 → cancel
 *   - その他 → normal
 *
 * 警報級ではないが「強い冬型・大雪」「高温」など具体的な事象解説のため
 * 早期天候情報 (normal) と同じ扱いから始める。
 * 将来、Headline.Information.Condition のキーワードで上げる余地はある
 * (例: "豪雨"/"猛暑"/"大雪" を warning に) が、Phase 5 第2弾では保守的に normal 据置。
 */
export function weatherExplanationFrameLevel(
  info: ParsedWeatherExplanation,
): FrameLevel {
  if (info.infoType === "取消") return "cancel";
  return "normal";
}

export function weatherExplanationSoundLevel(
  info: ParsedWeatherExplanation,
): SoundLevel {
  // [Codex R1 W2] 取消は presentation 層でも "cancel" に揃える (層間整合のため)
  if (info.infoType === "取消") return "cancel";
  return "normal";
}
