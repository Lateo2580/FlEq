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
  DEFAULT_CONFIG,
} from "../types";
import { loadConfig, saveConfig } from "../config";
import { EewUpdateResult } from "./eew-tracker";
import { playSound, SoundLevel } from "./sound-player";
import * as nodeNotifierLoader from "./node-notifier-loader";
import * as log from "../logger";

/** 通知アイコンのパス (assets/icons/icon.png が存在する場合に使用) */
const NOTIFY_ICON_PATH = path.resolve(__dirname, "../../assets/icons/icon.png");

/** 通知アプリ名 */
const NOTIFY_APP_NAME = "FlEq";

/** 通知カテゴリと日本語ラベルの対応 */
export const NOTIFY_CATEGORY_LABELS: Record<NotifyCategory, string> = {
  eew: "緊急地震速報",
  earthquake: "地震情報",
  tsunami: "津波情報",
  seismicText: "地震活動テキスト",
  nankaiTrough: "南海トラフ関連",
  lgObservation: "長周期地震動",
};

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
    if (!this.settings.eew) return;

    // 通知条件: 第1報 / 予報→警報切替 / 取消報 / 最終報
    const isUpgradeToWarning =
      result.previousInfo?.isWarning === false && info.isWarning === true;
    const isFinal = info.nextAdvisory != null;

    if (!result.isNew && !isUpgradeToWarning && !result.isCancelled && !isFinal) {
      return;
    }

    if (result.isCancelled) {
      this.send("[取消] 緊急地震速報", "緊急地震速報は取り消されました", "cancel");
      return;
    }

    const soundLevel: SoundLevel = info.isWarning ? "critical" : "warning";

    const title = info.isWarning
      ? "緊急地震速報（警報）"
      : "緊急地震速報（予報）";
    const maxInt = info.forecastIntensity?.areas?.[0]
      ? this.findMaxForecastInt(info)
      : "不明";
    const body = info.earthquake
      ? `${info.earthquake.hypocenterName} / M${info.earthquake.magnitude} / 最大予測震度${maxInt}`
      : title;

    this.send(title, body, soundLevel);
  }

  notifyEarthquake(info: ParsedEarthquakeInfo): void {
    if (!this.settings.earthquake) return;

    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "cancel");
      return;
    }

    const soundLevel = this.earthquakeSoundLevel(info);

    const parts: string[] = [];
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
      parts.push(`M${info.earthquake.magnitude}`);
    }
    if (info.intensity) {
      parts.push(`最大震度${info.intensity.maxInt}`);
    }
    this.send(info.title, parts.length > 0 ? parts.join(" / ") : (info.headline ?? info.title), soundLevel);
  }

  notifyTsunami(info: ParsedTsunamiInfo): void {
    if (!this.settings.tsunami) return;

    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "cancel");
      return;
    }

    const soundLevel = this.tsunamiSoundLevel(info);

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
    this.send(info.title, parts.length > 0 ? parts.join(" / ") : info.title, soundLevel);
  }

  notifySeismicText(info: ParsedSeismicTextInfo): void {
    if (!this.settings.seismicText) return;

    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "cancel");
      return;
    }

    const body = info.headline ?? info.bodyText.slice(0, 80);
    this.send(info.title, body, "info");
  }

  notifyNankaiTrough(info: ParsedNankaiTroughInfo): void {
    if (!this.settings.nankaiTrough) return;

    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "cancel");
      return;
    }

    const body = info.headline ?? info.bodyText.slice(0, 80);
    this.send(info.title, body, "warning");
  }

  notifyLgObservation(info: ParsedLgObservationInfo): void {
    if (!this.settings.lgObservation) return;

    if (info.infoType === "取消") {
      this.send(`[取消] ${info.title}`, "この情報は取り消されました", "cancel");
      return;
    }

    const soundLevel = this.lgObservationSoundLevel(info);

    const parts: string[] = [];
    if (info.earthquake) {
      parts.push(info.earthquake.hypocenterName);
    }
    if (info.maxLgInt) {
      parts.push(`長周期階級${info.maxLgInt}`);
    }
    if (info.maxInt) {
      parts.push(`最大震度${info.maxInt}`);
    }
    this.send(info.title, parts.length > 0 ? parts.join(" / ") : info.title, soundLevel);
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

  private send(title: string, message: string, level?: SoundLevel): void {
    if (this.isMuted()) return;
    try {
      const nn = this.getNotifier();
      if (nn) {
        nn.notify({
          title,
          message,
          sound: false,
          appID: NOTIFY_APP_NAME,
          ...(fs.existsSync(NOTIFY_ICON_PATH) ? { icon: NOTIFY_ICON_PATH } : {}),
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

  /** 地震情報のサウンドレベルを判定 */
  private earthquakeSoundLevel(info: ParsedEarthquakeInfo): SoundLevel {
    if (!info.intensity) return "normal";
    const num = intensityToSortNum(info.intensity.maxInt);
    if (num >= 4) return "warning";  // 震度4以上
    return "normal";
  }

  /** 津波情報のサウンドレベルを判定 */
  private tsunamiSoundLevel(info: ParsedTsunamiInfo): SoundLevel {
    if (!info.forecast || info.forecast.length === 0) return "normal";
    const kinds = info.forecast.map((f) => f.kind);
    // 注意報・警報・大津波警報のいずれかが含まれていれば critical
    if (kinds.some((k) => k.includes("津波") && !k.includes("解除"))) return "critical";
    // 解除のみの場合は warning
    if (kinds.some((k) => k.includes("解除"))) return "warning";
    return "normal";
  }

  /** 長周期地震動観測のサウンドレベルを判定 */
  private lgObservationSoundLevel(info: ParsedLgObservationInfo): SoundLevel {
    if (!info.maxLgInt) return "normal";
    if (info.maxLgInt === "4" || info.maxLgInt === "3") return "critical";
    if (info.maxLgInt === "2" || info.maxLgInt === "1") return "warning";
    return "normal";
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

  /** EEW の予測震度配列から最大震度を取得 */
  private findMaxForecastInt(info: ParsedEewInfo): string {
    if (!info.forecastIntensity?.areas || info.forecastIntensity.areas.length === 0) {
      return "不明";
    }
    // areas の先頭が最大震度のケースが多いが、安全のため全走査
    let maxLabel = info.forecastIntensity.areas[0].intensity;
    let maxNum = intensityToSortNum(maxLabel);
    for (const area of info.forecastIntensity.areas) {
      const num = intensityToSortNum(area.intensity);
      if (num > maxNum) {
        maxNum = num;
        maxLabel = area.intensity;
      }
    }
    return maxLabel;
  }
}

/** 震度文字列をソート用数値に変換 */
function intensityToSortNum(int: string): number {
  const norm = int.replace(/\s+/g, "");
  const map: Record<string, number> = {
    "1": 1, "2": 2, "3": 3, "4": 4,
    "5-": 5, "5弱": 5, "5+": 6, "5強": 6,
    "6-": 7, "6弱": 7, "6+": 8, "6強": 8, "7": 9,
  };
  return map[norm] ?? 0;
}
