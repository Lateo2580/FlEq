import * as path from "path";
import * as fs from "fs";
import {
  NotifyCategory,
  NotifySettings,
  ParsedEewInfo,
  ParsedEarthquakeInfo,
  ParsedTsunamiInfo,
  ParsedSeismicTextInfo,
  ParsedNankaiTroughInfo,
  ParsedLgObservationInfo,
  ParsedVolcanoInfo,
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
  ParsedLegacyCounterpartInfo,
  ParsedEarthquakeHypocenter,
  TyphoonProbPeak,
  DEFAULT_CONFIG,
} from "../../types";
import { VolcanoPresentation } from "../presentation/volcano-presentation";
import { loadConfig, saveConfig } from "../../config";
import {
  EewUpdateResult,
  getMaxForecastIntensityEvaluation,
} from "../eew/eew-tracker";
import {
  formatMagnitudeLabel,
  formatMagnitudeSpecialValue,
} from "../../utils/magnitude";
import { playSound, SoundLevel } from "./sound-player";
import {
  weatherSoundLevel,
  tornadoSoundLevel,
  briefingSoundLevel,
  earlyWeatherSoundLevel,
  weatherWarningTimeseriesSoundLevel,
  climateInfoSoundLevel,
  weatherExplanationSoundLevel,
  heatAlertSoundLevel,
  typhoonAnalysisSoundLevel,
  tsunamiSoundLevel,
  eewSoundLevel,
  earthquakeSoundLevel,
  formatIntensitySpecialValue,
  formatLgIntensitySpecialValue,
  lgObservationSoundLevel,
} from "../presentation/level-helpers";
import { extractLeadSentence } from "../../dmdata/heat-alert-parser";
import * as nodeNotifierLoader from "./node-notifier-loader";
import * as log from "../../logger";
import { normalizeLegacyCounterpartDisplayText } from "../presentation/legacy-counterpart-display-text";

/** 通知アイコンディレクトリ */
const ICONS_DIR = path.resolve(__dirname, "../../../assets/icons");

/**
 * R1 #9: 通知本文に「いつ・どこで」を入れるため、worst Significancy の詳細を取り出す。
 * 最大本体 Code と一致する最初の Significancy を探し、timeWindow / peak / criteriaPeriod /
 * 所属 Area 名を返す。
 */
function findWorstSignificancyDetail(
  info: ParsedWeatherWarningTimeseriesInfo,
): {
  window?: import("../../types").TimeWindow;
  peak?: import("../../types").SignificancyPeakTime;
  criteriaPeriod?: import("../../types").SignificancyCriteriaPeriod;
  areaName?: string;
} | null {
  if (info.maxKnownSignificancy == null) return null;
  const maxCode = info.maxKnownSignificancy.code;
  for (const area of info.areas) {
    for (const tsNum of [1, 2, 3] as const) {
      for (const k of area.kinds[tsNum]) {
        const v = k.significancyWorst?.base;
        if (v?.info.code === maxCode && v.info.known) {
          return {
            window: v.timeWindow,
            peak: v.peak,
            criteriaPeriod: v.criteriaPeriod,
            areaName: area.name,
          };
        }
        if (k.significancyWorst?.locals) {
          for (const lv of k.significancyWorst.locals) {
            if (lv.value.info.code === maxCode && lv.value.info.known) {
              return {
                window: lv.value.timeWindow,
                peak: lv.value.peak,
                criteriaPeriod: lv.value.criteriaPeriod,
                areaName: lv.areaName
                  ? `${area.name}/${lv.areaName}`
                  : area.name,
              };
            }
          }
        }
      }
    }
  }
  return null;
}

/** 通知用の TimeWindow 短縮表記 */
function formatTimeWindowForNotify(
  w: import("../../types").TimeWindow,
): string {
  if (w.count <= 1) return w.startName;
  if (w.contiguous) return `${w.startName}-${w.endName}(${w.count}枠)`;
  return `${w.startName}ほか${w.count - 1}枠`;
}

/** NotifyCategory → アイコンファイル名プレフィックス */
const CATEGORY_ICON_PREFIX: Record<NotifyCategory, string> = {
  eew: "eew",
  earthquake: "earthquake",
  tsunami: "tsunami",
  seismicText: "seismic-text",
  nankaiTrough: "nankai-trough",
  lgObservation: "lg-observation",
  volcano: "volcano",
  weather: "weather",
  tornado: "tornado",
  briefing: "briefing",
  earlyWeather: "early-weather",
  weatherWarningTimeseries: "weather-warning-timeseries",
  climateInfo: "climate-info",
  weatherExplanation: "weather-explanation",
  heatAlert: "heat-alert",
  typhoonAnalysis: "typhoon-analysis",
  // 方針A: VPTW のアイコン/音資産を流用 (台風解析と同じ通知ベース)
  typhoonProbability: "typhoon-analysis",
  // 指定河川洪水予報 (VXKO50-89 / VXSU50-59)。気象警報級の通知のため weather プレフィックスを流用
  // (typhoonProbability が typhoon-analysis を流用するのと同じパターン。
  //  3段 fallback で `weather*.png` 未配置時は default.png に落ちる安全策)
  floodForecast: "weather",
};

/** resolveIconPath の結果キャッシュ。キー: "{category}:{level|''}" */
const iconPathCache = new Map<string, string | undefined>();

/**
 * resolveIconPath のキャッシュをクリアする (テスト用)。
 */
export function clearIconPathCache(): void {
  iconPathCache.clear();
}

/**
 * カテゴリとレベルからアイコンパスを解決する。
 * 3段フォールバック: {prefix}-{level}.png → {prefix}.png → default.png
 * いずれも見つからなければ undefined を返す。結果はキャッシュして再利用する。
 */
export function resolveIconPath(
  category: NotifyCategory,
  level?: SoundLevel,
): string | undefined {
  const cacheKey = `${category}:${level ?? ""}`;
  if (iconPathCache.has(cacheKey)) {
    return iconPathCache.get(cacheKey);
  }

  const prefix = CATEGORY_ICON_PREFIX[category];
  const candidates: string[] = [];

  if (level) {
    candidates.push(path.join(ICONS_DIR, `${prefix}-${level}.png`));
  }
  candidates.push(path.join(ICONS_DIR, `${prefix}.png`));
  candidates.push(path.join(ICONS_DIR, "default.png"));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      iconPathCache.set(cacheKey, candidate);
      return candidate;
    }
  }
  iconPathCache.set(cacheKey, undefined);
  return undefined;
}

/** 通知アプリ名 */
const NOTIFY_APP_NAME = "FlEq";

/**
 * controlTitle が空 (空文字) のときに使う汎用フォールバック名 (VPCJ51/VPZJ51 共通)。
 * formatter の DEFAULT_CONTROL_TITLE と意図的にファイル間独立 — 通知層と表示層は
 * 用途が異なる (通知本文 vs フレーム内タイトル) ため、まとめての集約は別 Phase に送る。
 */
const DEFAULT_CONTROL_TITLE = "気象解説情報";

/** 通知カテゴリと日本語ラベルの対応 */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  eew: "緊急地震速報",
  earthquake: "地震情報",
  tsunami: "津波情報",
  seismicText: "地震活動テキスト",
  nankaiTrough: "南海トラフ関連",
  lgObservation: "長周期地震動",
  volcano: "火山情報",
  weather: "気象警報・注意報",
  tornado: "竜巻注意情報",
  briefing: "気象防災速報",
  earlyWeather: "早期天候情報",
  weatherWarningTimeseries: "気象警報・注意報時系列",
  // VPZI50 (全般) と VPCI50 (地方) の両方を扱うカテゴリのため総称の「天候情報」
  climateInfo: "天候情報",
  weatherExplanation: "気象解説情報",
  heatAlert: "熱中症警戒アラート",
  typhoonAnalysis: "台風解析・予報情報",
  typhoonProbability: "台風の暴風域に入る確率",
  floodForecast: "洪水予報",
};

function correctionNotification(
  infoType: string,
  title: string,
  body: string,
): { title: string; body: string } {
  return infoType === "訂正"
    ? { title: `[訂正] ${title}`, body: `訂正: ${body}` }
    : { title, body };
}

/** canonical がある電文だけ SpecialValue 表示へ移し、legacy は従来 formatter を保つ。 */
function notificationMagnitude(
  earthquake: Pick<
    ParsedEarthquakeHypocenter,
    "magnitude" | "magnitudeInfo" | "magnitudeValue"
  >,
): string | null {
  if (earthquake.magnitudeValue == null) return formatMagnitudeLabel(earthquake);
  const formatted = formatMagnitudeSpecialValue(earthquake.magnitudeValue);
  if (
    earthquake.magnitudeValue.presence === "missing"
    || earthquake.magnitudeValue.presence === "empty"
  ) return formatMagnitudeLabel(earthquake);
  return formatted;
}

export class Notifier {
  private settings: NotifySettings;
  private soundEnabled: boolean;
  private muteUntil: number | null = null;
  constructor() {
    const fileConfig = loadConfig();
    this.settings = {
      ...DEFAULT_CONFIG.notify,
      ...fileConfig.notify,
    };
    this.soundEnabled = fileConfig.sound ?? DEFAULT_CONFIG.sound;
  }

  /** 指定ミリ秒間、通知をミュートする */
  mute(durationMs: number): void {
    this.muteUntil = Date.now() + durationMs;
  }

  /** ミュートを解除する */
  unmute(): void {
    this.muteUntil = null;
  }

  /** 現在ミュート中かどうか */
  isMuted(): boolean {
    if (this.muteUntil == null) return false;
    if (Date.now() >= this.muteUntil) {
      this.muteUntil = null;
      return false;
    }
    return true;
  }

  /** ミュート残り時間 (ms)。ミュート中でなければ 0 */
  muteRemaining(): number {
    if (this.muteUntil == null) return 0;
    const remaining = this.muteUntil - Date.now();
    if (remaining <= 0) {
      this.muteUntil = null;
      return 0;
    }
    return remaining;
  }

  /** カテゴリのトグル → 新しい状態を返す */
  toggleCategory(cat: NotifyCategory): boolean {
    this.settings[cat] = !this.settings[cat];
    this.persist();
    return this.settings[cat];
  }

  /** 一括 ON/OFF */
  setAll(enabled: boolean): void {
    for (const key of Object.keys(this.settings) as NotifyCategory[]) {
      this.settings[key] = enabled;
    }
    this.persist();
  }

  /** 現在の設定を返す */
  getSettings(): NotifySettings {
    return { ...this.settings };
  }

  /** 通知音が有効かどうか */
  getSoundEnabled(): boolean {
    return this.soundEnabled;
  }

  /** 通知音の有効/無効を切り替える */
  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    this.persist();
  }

  // ── 電文タイプ別通知 ──

  notifyEew(info: ParsedEewInfo, result: EewUpdateResult): void {
    // 抑制された報は通知しない
    if (result.isSuppressed) return;

    // 重複報も通知しない (通常は processEew 上流で落ちるが、
    // Notifier 単体の契約としても初回扱いにならないようガード)
    if (result.isDuplicate) return;

    // 通知条件: tracker 発行の第1報 signal / 警報昇格 / 取消報 / 訂正 / 最終報
    const isFinal = info.nextAdvisory != null;
    const isCorrection = result.isCorrection === true;

    if (
      !result.firstReportSignal &&
      !result.isUpgradeToWarning &&
      !result.isCancelled &&
      !isCorrection &&
      !isFinal
    ) {
      return;
    }

    if (result.isCancelled) {
      this.send("[取消] 緊急地震速報", "緊急地震速報は取り消されました", "eew", "cancel");
      return;
    }

    const soundLevel = eewSoundLevel(info);

    const baseTitle = info.isWarning
      ? "緊急地震速報（警報）"
      : "緊急地震速報（予報）";
    const title = isCorrection ? `[訂正] ${baseTitle}` : baseTitle;
    const maxInt = getMaxForecastIntensityEvaluation(info.forecastIntensity)?.summaryLabel
      ?? "不明";
    const body = info.earthquake
      ? [
          info.earthquake.hypocenterName,
          notificationMagnitude(info.earthquake),
          `最大予測震度${maxInt}`,
        ].filter((part): part is string => part != null).join(" / ")
      : title;

    this.send(
      title,
      isCorrection ? `訂正: ${body}` : body,
      "eew",
      soundLevel,
    );
  }

  notifyEarthquake(info: ParsedEarthquakeInfo): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "この情報は取り消されました",
        "earthquake",
        earthquakeSoundLevel(info),
      );
      return;
    }

    const soundLevel = earthquakeSoundLevel(info);

    const parts: string[] = [];
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
      const magnitude = notificationMagnitude(info.earthquake);
      if (magnitude != null) parts.push(magnitude);
    }
    if (info.intensity) {
      const maxInt = formatIntensitySpecialValue(info.intensity.maxIntValue, info.intensity.maxInt, "notification");
      if (maxInt != null) parts.push(`最大震度${maxInt}`);
    }
    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : (info.headline ?? info.title),
    );
    this.send(notification.title, notification.body, "earthquake", soundLevel);
  }

  notifyTsunami(info: ParsedTsunamiInfo): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "tsunami", "cancel");
      return;
    }

    const soundLevel = tsunamiSoundLevel(info);

    const parts: string[] = [];
    if (info.forecast && info.forecast.length > 0) {
      const kinds = [...new Set(info.forecast.map((f) => f.kind))];
      parts.push(kinds.join("・"));
      const areas = info.forecast.slice(0, 3).map((f) => f.areaName);
      parts.push(areas.join(", "));
    }
    if (info.headline) {
      parts.push(info.headline);
    }
    const correction = info.infoType === "訂正";
    const title = correction ? `[訂正] ${info.title}` : info.title;
    const body = parts.length > 0 ? parts.join(" / ") : info.title;
    this.send(title, correction ? `訂正: ${body}` : body, "tsunami", soundLevel);
  }

  notifySeismicText(info: ParsedSeismicTextInfo): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "seismicText", "cancel");
      return;
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      info.headline ?? info.bodyText.slice(0, 80),
    );
    this.send(notification.title, notification.body, "seismicText", "info");
  }

  notifyNankaiTrough(
    info: ParsedNankaiTroughInfo,
    soundLevelOverride?: SoundLevel,
  ): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "nankaiTrough", "cancel");
      return;
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      info.headline ?? info.bodyText.slice(0, 80),
    );
    this.send(
      notification.title,
      notification.body,
      "nankaiTrough",
      soundLevelOverride ?? "warning",
    );
  }

  notifyLgObservation(info: ParsedLgObservationInfo): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "この情報は取り消されました",
        "lgObservation",
        lgObservationSoundLevel(info),
      );
      return;
    }

    const soundLevel = lgObservationSoundLevel(info);

    const parts: string[] = [];
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
    }
    const maxLgInt = formatLgIntensitySpecialValue(info.maxLgIntValue, info.maxLgInt, "notification");
    if (maxLgInt != null) parts.push(`長周期階級${maxLgInt}`);
    const maxInt = formatIntensitySpecialValue(info.maxIntValue, info.maxInt, "notification");
    if (maxInt != null) parts.push(`最大震度${maxInt}`);
    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(notification.title, notification.body, "lgObservation", soundLevel);
  }

  notifyVolcano(info: ParsedVolcanoInfo, presentation: VolcanoPresentation): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "volcano", "cancel");
      return;
    }

    const correction = info.infoType === "訂正";
    this.send(
      correction ? `[訂正] ${info.title}` : info.title,
      correction ? `訂正: ${presentation.summary}` : presentation.summary,
      "volcano",
      presentation.soundLevel,
    );
  }

  notifyVolcanoBatch(
    batch: { items: { volcanoName: string }[] },
    presentation: VolcanoPresentation,
    isCorrection = false,
  ): void {
    this.send(
      isCorrection ? "[訂正] 降灰予報（定時）" : "降灰予報（定時）",
      isCorrection ? `訂正: ${presentation.summary}` : presentation.summary,
      "volcano",
      presentation.soundLevel,
    );
  }

  /**
   * @param soundLevelOverride processWeather が unsafe 昇格等で決めた
   *   outcome.presentation.soundLevel (Codex 最終レビュー F-3)。再計算 drift を防ぐため
   *   呼び出し元が outcome を持つ経路では必ず渡す。取消は従来どおり cancel 直指定が優先
   */
  notifyWeatherWarning(info: ParsedWeatherWarning, soundLevelOverride?: SoundLevel): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "weather", "cancel");
      return;
    }

    // soundLevel は level-helpers の共通実装を再利用 (drift 防止、Phase C で displaySeverity ベース)。
    // override があればそちらを優先 (unsafe の "warning" 昇格を通知音に届ける)
    const soundLevel = soundLevelOverride ?? weatherSoundLevel(info);

    const parts: string[] = [];
    if (info.warningAreaCount > 0) {
      parts.push(`警報 ${info.warningAreaCount}地域`);
    }
    if (info.advisoryAreaCount > 0) {
      parts.push(`注意報 ${info.advisoryAreaCount}地域`);
    }
    if (info.headline) {
      parts.push(info.headline);
    }
    const isCorrection = info.infoType === "訂正";
    this.send(
      isCorrection ? `[訂正] ${info.title}` : info.title,
      isCorrection
        ? `訂正: ${parts.length > 0 ? parts.join(" / ") : info.title}`
        : parts.length > 0 ? parts.join(" / ") : info.title,
      "weather",
      soundLevel,
    );
  }

  /**
   * @param soundLevelOverride outcome.presentation.soundLevel (weather F-3 の横展開)。
   *   再計算 drift を予防する (tornado は現状 presentation 側に昇格経路がなく
   *   process-tornado も同じ tornadoSoundLevel で計算するため weather F-3 のような
   *   実乖離はないが、将来の昇格追加に備えて outcome を持つ経路では必ず渡す)。
   *   取消は cancel 直指定が優先
   */
  notifyTornadoAdvisory(info: ParsedTornadoAdvisory, soundLevelOverride?: SoundLevel): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "竜巻注意情報は取り消されました", "tornado", "cancel");
      return;
    }

    // soundLevel は level-helpers の共通実装を再利用 (drift 防止)。
    // override があればそちらを優先 (presentation 層の昇格を通知音に届ける)
    const soundLevel: SoundLevel = soundLevelOverride ?? tornadoSoundLevel(info);

    const parts: string[] = [];
    if (info.hasSightingAreas) {
      parts.push("目撃情報あり");
    } else if (info.isSightingTelegram) {
      // フェイルセーフ: 目撃電文だが地域抽出に失敗したケース (2026-06-12 レビュー決定)
      parts.push("目撃情報 (地域不明)");
    }
    if (info.activeAreaCount > 0) {
      parts.push(`発表中 ${info.activeAreaCount}地域`);
    }
    if (info.validDateTime) {
      // 有効期限を簡略表示
      parts.push(`有効期限 ${info.validDateTime.slice(11, 16)}`);
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(
      notification.title,
      notification.body,
      "tornado",
      soundLevel,
    );
  }

  notifyEarlyWeather(info: ParsedEarlyWeatherInfo): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "早期天候情報は取り消されました",
        "earlyWeather",
        "cancel",
      );
      return;
    }

    const soundLevel = earlyWeatherSoundLevel(info);

    const parts: string[] = [];
    // 対象地域
    if (info.targetArea) {
      parts.push(info.targetArea.name);
    }
    // 期間ラベル (最初の phenomenon の periodLabel)
    const firstWithPeriod = info.phenomena.find((p) => p.periodLabel);
    if (firstWithPeriod?.periodLabel) {
      parts.push(firstWithPeriod.periodLabel);
    }
    // 主要現象 (確率付き)
    const phenomenonParts = info.phenomena
      .filter((p) => p.type)
      .map((p) => {
        if (p.probabilityPercent != null) {
          return `${p.type} ${p.probabilityPercent}%`;
        }
        return p.type;
      });
    if (phenomenonParts.length > 0) {
      parts.push(phenomenonParts.join(" / "));
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(notification.title, notification.body, "earlyWeather", soundLevel);
  }

  notifyWeatherWarningTimeseries(
    info: ParsedWeatherWarningTimeseriesInfo,
  ): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "気象警報・注意報時系列は取り消されました",
        "weatherWarningTimeseries",
        "cancel",
      );
      return;
    }

    const soundLevel = weatherWarningTimeseriesSoundLevel(info);

    const parts: string[] = [];
    // 対象地域 (TargetArea 優先)
    if (info.targetArea) {
      parts.push(info.targetArea.name);
    }
    // [R1 #9] 最大本体 (既知 Code) + worst 時刻幅 + 最大リスク地点
    if (info.maxKnownSignificancy) {
      const worst = findWorstSignificancyDetail(info);
      const winTag = worst?.window
        ? ` ${formatTimeWindowForNotify(worst.window)}`
        : "";
      const areaTag = worst?.areaName ? ` @${worst.areaName}` : "";
      parts.push(
        `最大: ${info.maxKnownSignificancy.compact}${winTag}${areaTag}`,
      );
    }
    // [R1 #9] 高リスク (warning/special/未知) 時のみ PeakTime / CriteriaPeriod 短縮
    const sev = info.maxKnownSignificancy?.severity;
    const isHighRisk =
      sev === "warning" || sev === "special" || info.unknownCodes.length > 0;
    if (isHighRisk) {
      const detail = findWorstSignificancyDetail(info);
      if (detail?.peak) {
        parts.push(`ピーク=${detail.peak.date}${detail.peak.term}`);
      }
      if (detail?.criteriaPeriod) {
        const rank = detail.criteriaPeriod.criteriaClass.match(/レベル([0-9]+)/);
        const r = rank ? rank[1] : "?";
        const hhmm = detail.criteriaPeriod.time.slice(11, 16);
        parts.push(`基準${r}:${hhmm}`);
      }
    }
    // 未知 Code は別表示
    if (info.unknownCodes.length > 0) {
      const codes = Array.from(
        new Set(info.unknownCodes.map((u) => `?${u.code}`)),
      ).join(",");
      parts.push(`未知:${codes}`);
    }
    // Area 件数
    if (info.areas.length > 0) {
      parts.push(`${info.areas.length}地域`);
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(
      notification.title,
      notification.body,
      "weatherWarningTimeseries",
      soundLevel,
    );
  }

  notifyClimateInfo(info: ParsedClimateInfo): void {
    if (info.infoType === "取消") {
      // controlTitle は空文字になりうるので || を使用 (VPZI50=全般/VPCI50=地方)
      const label = info.controlTitle || "天候情報";
      this.send(
        `[取消] ${info.title}`,
        `${label}は取り消されました`,
        "climateInfo",
        "cancel",
      );
      return;
    }

    const soundLevel = climateInfoSoundLevel(info);

    const parts: string[] = [];
    if (info.targetArea) {
      parts.push(info.targetArea.name);
    }
    if (info.stations.length > 0) {
      parts.push(`観測点 ${info.stations.length}地点`);
    }
    if (info.headline) {
      // 通知本文は冗長になりがちなので 1 行目だけ
      const firstLine = info.headline.split("\n")[0];
      parts.push(firstLine.slice(0, 80));
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(notification.title, notification.body, "climateInfo", soundLevel);
  }

  notifyWeatherExplanation(info: ParsedWeatherExplanation): void {
    // info.controlTitle は string 型だが空文字になりうるので || を使用 (== null では空文字を拾えない)
    const controlTitle = info.controlTitle || DEFAULT_CONTROL_TITLE;

    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        `${controlTitle}は取り消されました`,
        "weatherExplanation",
        "cancel",
      );
      return;
    }

    const soundLevel = weatherExplanationSoundLevel(info);

    const parts: string[] = [];
    if (info.targetAreas.length > 0) {
      parts.push(info.targetAreas[0].name);
    }
    // 情報タグ (例: "強い冬型 大雪") を 1-2 個まで
    const tagLabels = info.informationTags
      .flatMap((t) => t.keywords)
      .filter((k, i, arr) => arr.indexOf(k) === i)
      .slice(0, 3);
    if (tagLabels.length > 0) {
      parts.push(tagLabels.join("・"));
    }
    if (info.headline) {
      const firstLine = info.headline.split("\n")[0];
      parts.push(firstLine.slice(0, 80));
    }

    // 観測実況の最重要 remark を 1 件だけ追加 (VPCJ51/VPZJ51 は observation=null のため挙動変化なし)
    let remarkLine: string | null = null;
    outer: for (const s of info.observation?.series ?? []) {
      for (const st of s.stations) {
        for (const m of st.measurements) {
          const remark = m.remark;
          if (remark == null) continue;
          // formatter の formatStationRow と同じ value fallback (sentence が空のとき値文字列で代替)
          const valueStr = m.values
            .map((v) => {
              if (v.value != null) return `${v.value}${v.unit}`;
              return v.description || v.raw || "";
            })
            .filter((x) => x.length > 0)
            .join(" ");
          const rendered = m.sentence || valueStr;
          remarkLine = `観測実況: ${st.stationName} ${rendered}`;
          if (!rendered.includes(remark)) {
            remarkLine += ` ※${remark}`;
          }
          break outer;
        }
      }
    }
    if (remarkLine != null) parts.push(remarkLine);

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(notification.title, notification.body, "weatherExplanation", soundLevel);
  }

  /**
   * @param soundLevelOverride outcome.presentation.soundLevel (weather F-3 の横展開)。
   *   再計算 drift を予防する (briefing は現状 presentation 側に昇格経路がなく
   *   process-briefing も同じ briefingSoundLevel で計算するため weather F-3 のような
   *   実乖離はないが、将来の昇格追加に備えて outcome を持つ経路では必ず渡す)。
   *   取消は cancel 直指定が優先
   */
  notifyWeatherBriefing(info: ParsedWeatherBriefing, soundLevelOverride?: SoundLevel): void {
    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "気象防災速報は取り消されました", "briefing", "cancel");
      return;
    }

    // override があればそちらを優先 (presentation 層の昇格を通知音に届ける)
    const soundLevel = soundLevelOverride ?? briefingSoundLevel(info);

    const parts: string[] = [];
    // Phase D: 代表 Condition + 残りを最大 3 件まで連結 (集合ベース化で複数 Condition が来る)
    const conditionSummary = [
      info.briefingCondition,
      ...info.briefingConditions.filter((c) => c !== info.briefingCondition),
    ]
      .filter((c) => c !== "")
      .slice(0, 3)
      .join(" / ");
    if (conditionSummary) {
      parts.push(conditionSummary);
    }
    // 対象地域 (1-2 件)
    const areaNames = info.targetAreas.slice(0, 2).map((a) => a.name);
    if (areaNames.length > 0) {
      parts.push(areaNames.join(", "));
    }
    // 観測実況: value 付き観測を優先、なければ description のある先頭を使う
    const observations = info.observations;
    const valueObs = observations.find(
      (o) => o.value != null && (o.locationName || o.description),
    );
    const firstObs = valueObs ?? observations.find((o) => o.description);
    if (firstObs) {
      const loc = firstObs.locationName ? `${firstObs.locationName} ` : "";
      const valuePart =
        firstObs.value != null
          ? `${firstObs.value}${firstObs.unit ?? ""}`
          : "";
      const desc = firstObs.description || valuePart || firstObs.observationType;
      parts.push(`${loc}${desc}`.trim());
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(notification.title, notification.body, "briefing", soundLevel);
  }

  /**
   * 熱中症警戒アラート (VPFT50)。
   * @param soundLevelOverride outcome.presentation.soundLevel (再計算 drift の予防)。
   *   outcome を持つ経路 (dispatchNotify) では必ず渡す。取消は cancel 直指定が優先
   */
  notifyHeatAlert(info: ParsedHeatAlertInfo, soundLevelOverride?: SoundLevel): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "熱中症警戒アラートは取り消されました",
        "heatAlert",
        "cancel",
      );
      return;
    }

    // override があればそちらを優先 (presentation 層の昇格を通知音に届ける)
    const soundLevel = soundLevelOverride ?? heatAlertSoundLevel(info);

    const parts: string[] = [];
    if (info.targetAreaName) {
      parts.push(info.targetAreaName);
    }
    // Headline が空電文のため本文先頭文を通知 body に使う (80 文字まで)
    const lead = extractLeadSentence(info.bodyText);
    if (lead) {
      parts.push(lead.slice(0, 80));
    }

    const notification = correctionNotification(
      info.infoType,
      info.title,
      parts.length > 0 ? parts.join(" / ") : info.title,
    );
    this.send(
      notification.title,
      notification.body,
      "heatAlert",
      soundLevel,
    );
  }

  /**
   * 台風解析・予報情報 (VPTW60/61/62)。
   * @param soundLevelOverride outcome.presentation.soundLevel (再計算 drift の予防)。
   *   outcome を持つ経路 (dispatchNotify) では必ず渡す。取消は cancel 直指定が優先
   */
  notifyTyphoonAnalysis(info: ParsedTyphoonAnalysis, soundLevelOverride?: SoundLevel): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "この台風情報は取り消されました",
        "typhoonAnalysis",
        "cancel",
      );
      return;
    }

    const soundLevel = soundLevelOverride ?? typhoonAnalysisSoundLevel(info);

    const nameLabel = info.name?.name
      ? `${info.name.name}${info.name.number ? ` (台風${info.name.number.slice(2)}号)` : ""}`
      : info.name?.remark || "熱帯低気圧";
    const location = info.frames[0]?.center.location ?? "";

    const notification = correctionNotification(
      info.infoType,
      info.title,
      `${nameLabel} ${location}`.trim(),
    );
    this.send(
      notification.title,
      notification.body,
      "typhoonAnalysis",
      soundLevel,
    );
  }

  /**
   * 台風の暴風域に入る確率 (VPTA50)。
   * @param soundLevelOverride outcome.presentation.soundLevel を必ず渡す。
   */
  notifyTyphoonProbability(
    info: ParsedTyphoonProbability,
    soundLevelOverride?: SoundLevel,
  ): void {
    if (info.infoType === "取消") {
      this.send(
        `[取消] ${info.title}`,
        "この台風情報は取り消されました",
        "typhoonProbability",
        "cancel",
      );
      return;
    }

    const soundLevel = soundLevelOverride ?? "normal";
    const nameLabel = info.name?.name
      ? `${info.name.name}${info.name.number ? ` (台風${info.name.number.slice(2)}号)` : ""}`
      : info.name?.remark || "熱帯低気圧";

    // 最悪情報を求める作業用ローカル型（any を避ける）
    interface WorstSummary {
      value: number;
      pref: string;
      area: string;
      peak: TyphoonProbPeak | null;
    }
    const init: WorstSummary = { value: 0, pref: "", area: "", peak: null };
    const worst = info.regions.reduce<WorstSummary>((m, r) => {
      const d4 = r.daily[4] ?? 0;
      if (d4 > m.value) {
        return { value: d4, pref: r.prefName, area: r.areaName, peak: r.peak };
      }
      return m;
    }, init);

    // peak 時刻を "MM/DD HH時頃" 形式に整形
    function jstHourLabel(iso: string): string {
      const m = iso.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2})/);
      if (!m) return "";
      return `${m[1]}/${m[2]} ${m[3]}時頃`;
    }

    let body: string;
    if (worst.value === 0) {
      body = `${nameLabel} 暴風域に入る確率1%以上の地域なし`;
    } else {
      const peakTxt =
        worst.peak?.kind === "value" ? jstHourLabel(worst.peak.time) : "";
      body = `${nameLabel} 最大 ${worst.value}% (${worst.pref}/${worst.area}${
        peakTxt ? `, ${peakTxt}` : ""
      })`;
    }

    const notification = correctionNotification(info.infoType, info.title, body);
    this.send(notification.title, notification.body, "typhoonProbability", soundLevel);
  }

  /**
   * 指定河川洪水予報 (VXKO50-89 / VXSU50-59)。
   * Headline-only 電文 (rawStations 空) でも fallback で body を埋める。
   * 取消パスは cancel 直指定が優先。
   * @param soundLevelOverride outcome.presentation.soundLevel を必ず渡す (再計算 drift 予防、weather F-3 の横展開)。
   */
  notifyFloodForecast(parsed: ParsedFloodForecastInfo, soundLevelOverride?: SoundLevel): void {
    if (parsed.infoType === "取消") {
      const cancelLabel =
        parsed.headlines[0]?.areas[0]?.name ?? parsed.rawStations[0]?.stationName ?? "";
      this.send(
        `[${NOTIFY_CATEGORY_LABELS.floodForecast}取消] ${parsed.headTitle}`,
        cancelLabel === ""
          ? "指定河川洪水予報の発表を取り消します"
          : `${cancelLabel} の発表を取り消します`,
        "floodForecast",
        "cancel",
      );
      return;
    }

    // Headline-only fallback (rawStations 空でも station 名相当を埋める)
    const stationLabel =
      parsed.rawStations[0]?.stationName ??
      parsed.headlines[0]?.areas[0]?.name ??
      parsed.headTitle;
    const headline =
      parsed.headlines.find((h) => h.scope === "河川")?.headlineText ??
      parsed.headlines[0]?.headlineText ??
      "";

    const body = headline === "" ? stationLabel : `${stationLabel}: ${headline}`;

    const correction = parsed.infoType === "訂正";
    this.send(
      correction
        ? `[訂正] ${NOTIFY_CATEGORY_LABELS.floodForecast} ${parsed.headTitle}`
        : `${NOTIFY_CATEGORY_LABELS.floodForecast} ${parsed.headTitle}`,
      correction ? `訂正: ${body}` : body,
      "floodForecast",
      soundLevelOverride ?? "warning",
    );
  }

  /** unmatched legacy は code registry が high を確定した場合だけ通知する。 */
  notifyLegacyCounterpart(
    info: ParsedLegacyCounterpartInfo,
    isHighSeverity: boolean,
  ): boolean {
    // VPOA50 の取消は severity rule 側でも unknown 固定だが、通知境界でも
    // 構造的に遮断する。将来の caller / rule の誤昇格で取消を通知しないため。
    if (info.type === "VPOA50" && info.infoType === "取消") return false;
    if (isHighSeverity !== true) return false;
    if (!this.settings.weather || this.isMuted()) return false;
    const qualifier = "対応電文未確認";
    const subject = normalizeLegacyCounterpartDisplayText(info.title).trim() || info.type;
    const headline = info.headline == null
      ? ""
      : normalizeLegacyCounterpartDisplayText(info.headline).trim();
    const detail = headline === "" ? subject : headline;
    const correction = info.infoType === "訂正";
    this.send(
      correction ? `[訂正] ${subject}（${qualifier}）` : `${subject}（${qualifier}）`,
      correction ? `訂正: ${detail}（${qualifier}）` : `${detail}（${qualifier}）`,
      "weather",
      "warning",
    );
    return true;
  }

  // ── 内部メソッド ──

  private _notifier: nodeNotifierLoader.NodeNotifierLike | null = null;

  private getNotifier(): nodeNotifierLoader.NodeNotifierLike | null {
    if (this._notifier == null) {
      this._notifier = nodeNotifierLoader.loadNodeNotifier();
      if (this._notifier == null) {
        log.debug("node-notifier の読み込みに失敗しました");
      }
    }
    return this._notifier;
  }

  private send(title: string, message: string, category: NotifyCategory, level?: SoundLevel): void {
    if (!this.settings[category] && level !== "critical") return;
    if (this.isMuted()) return;
    try {
      const nn = this.getNotifier();
      if (nn) {
        const iconPath = resolveIconPath(category, level);
        nn.notify({
          title,
          message,
          sound: false,
          appID: NOTIFY_APP_NAME,
          ...(iconPath ? { icon: iconPath } : {}),
        });
      }
    } catch (err) {
      if (err instanceof Error) {
        log.debug(`通知送信エラー: ${err.message}`);
      }
    }
    if (this.soundEnabled && level) {
      playSound(level);
    }
  }

  private persist(): void {
    try {
      const config = loadConfig();
      config.notify = { ...this.settings };
      config.sound = this.soundEnabled;
      saveConfig(config);
    } catch (err) {
      if (err instanceof Error) {
        log.warn(`通知設定の保存に失敗しました: ${err.message}`);
      }
    }
  }

}
