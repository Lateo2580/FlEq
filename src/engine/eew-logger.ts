import * as fs from "fs";
import * as path from "path";
import { ParsedEewInfo, EewLogField } from "../types";
import { EewDiff, EewUpdateResult } from "./eew-tracker";
import * as log from "../logger";

/** ログ出力のデフォルトディレクトリ */
const DEFAULT_LOG_DIR = path.join(process.cwd(), "eew-logs");

/** MaxIntChangeReason コードの表示ラベル */
const MAX_INT_CHANGE_REASON_LABELS: Record<number, string> = {
  0: "不明",
  1: "M変化",
  2: "震源変化",
  3: "M+震源",
  4: "深さ変化",
  9: "PLUM法",
};

/** eventId をファイル名に安全な文字列へサニタイズ (パストラバーサル防止) */
function sanitizeEventId(eventId: string): string {
  // 英数字・ハイフン・アンダースコアのみ残す
  return eventId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/** 数値を2桁ゼロ埋め */
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 日時をローカルタイムの読みやすい形式にフォーマット */
function formatLocalTime(isoStr: string): string {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 現在時刻を HH:mm:ss 形式で返す */
function nowTimeStr(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 現在時刻を YYYYMMDD_HHmmss 形式で返す */
function nowFileTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 差分情報をテキスト化 */
function formatDiff(diff: EewDiff, info: ParsedEewInfo): string {
  const parts: string[] = [];
  if (diff.previousMagnitude && info.earthquake?.magnitude) {
    parts.push(`M${diff.previousMagnitude}→M${info.earthquake.magnitude}`);
  }
  if (diff.previousDepth && info.earthquake?.depth) {
    parts.push(`${diff.previousDepth}→${info.earthquake.depth}`);
  }
  if (diff.previousMaxInt && info.forecastIntensity?.areas.length) {
    const topInt = info.forecastIntensity.areas[0].intensity;
    parts.push(`震度${diff.previousMaxInt}→${topInt}`);
  }
  if (diff.hypocenterChange) parts.push("震源変更");
  return parts.length > 0 ? `  [${parts.join(", ")}]` : "";
}

/** 非同期ファイル書き込み (エラーはログ出力のみ) */
async function appendFileAsync(filePath: string, data: string): Promise<void> {
  try {
    await fs.promises.appendFile(filePath, data, "utf-8");
  } catch (err) {
    if (err instanceof Error) {
      log.error(`EEW ログ書き込み失敗: ${err.message}`);
    }
  }
}

/**
 * EEW イベントごとにログファイルへ逐次追記するロガー。
 * 各報の受信時に非同期でディスクへ書き込む。
 */
export class EewEventLogger {
  private readonly logDir: string;
  /** eventId → ファイルパス */
  private activeFiles = new Map<string, string>();
  /** 書き込みの順序保証用チェーン (eventId → Promise) */
  private writeChains = new Map<string, Promise<void>>();
  /** ログ記録が有効かどうか */
  private enabled = true;
  /** 記録対象のフィールド */
  private fields: Record<EewLogField, boolean> = {
    hypocenter: true,
    originTime: true,
    coordinates: true,
    magnitude: true,
    forecastIntensity: true,
    maxLgInt: true,
    forecastAreas: true,
    lgIntensity: true,
    isPlum: true,
    hasArrived: true,
    diff: true,
    maxIntChangeReason: true,
  };

  constructor(logDir?: string) {
    this.logDir = logDir ?? DEFAULT_LOG_DIR;
  }

  /** ログ記録の有効/無効を設定 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** ログ記録が有効かどうかを返す */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** 記録対象フィールドを設定 */
  setFields(fields: Record<EewLogField, boolean>): void {
    this.fields = { ...fields };
  }

  /** 記録対象フィールドを返す */
  getFields(): Record<EewLogField, boolean> {
    return { ...this.fields };
  }

  /** 特定フィールドの有効/無効を切り替え */
  toggleField(field: EewLogField): boolean {
    this.fields[field] = !this.fields[field];
    return this.fields[field];
  }

  /** EEW 報を受信した際に呼び出す。第1報でファイル作成、続報は追記。 */
  logReport(info: ParsedEewInfo, result: EewUpdateResult): void {
    if (!this.enabled) return;

    const eventId = sanitizeEventId(info.eventId || "unknown");

    if (result.isNew) {
      this.startNewEvent(eventId, info);
    } else {
      this.appendReport(eventId, info, result.diff);
    }
  }

  /** イベント終了を記録し、追跡から除去する */
  closeEvent(eventId: string, reason: string): void {
    const filePath = this.activeFiles.get(eventId);
    if (filePath == null) return;

    const line = `\n--- 記録終了 (${reason}) ${nowTimeStr()} ---\n`;
    this.enqueueWrite(eventId, filePath, line);
    log.debug(`EEW ログ記録終了: ${filePath}`);
    this.activeFiles.delete(eventId);
  }

  /** 全アクティブイベントのログを閉じる (シャットダウン時) */
  closeAll(): void {
    const eventIds = [...this.activeFiles.keys()];
    for (const eventId of eventIds) {
      this.closeEvent(eventId, "シャットダウン");
    }
  }

  /** ログディレクトリを返す (テスト用) */
  getLogDir(): string {
    return this.logDir;
  }

  /** 全書き込みの完了を待つ (テスト用) */
  async flush(): Promise<void> {
    await Promise.all([...this.writeChains.values()]);
  }

  /** 新規イベントのログファイルを作成 */
  private startNewEvent(eventId: string, info: ParsedEewInfo): void {
    this.ensureLogDir();

    const fileName = `eew_${eventId}_${nowFileTimestamp()}.log`;
    const filePath = path.join(this.logDir, fileName);
    this.activeFiles.set(eventId, filePath);

    const header = this.buildHeader(eventId, info);
    const report = this.buildReportBlock(info, undefined);

    this.enqueueWrite(eventId, filePath, header + report);
    log.info(`EEW ログ記録開始: ${filePath}`);
  }

  /** 既存イベントに報を追記 */
  private appendReport(
    eventId: string,
    info: ParsedEewInfo,
    diff?: EewDiff
  ): void {
    // ファイルが未作成の場合（eventId なしで始まった等）は新規作成
    if (!this.activeFiles.has(eventId)) {
      this.startNewEvent(eventId, info);
      return;
    }

    const filePath = this.activeFiles.get(eventId)!;
    const report = this.buildReportBlock(info, diff);
    this.enqueueWrite(eventId, filePath, report);
  }

  /** 書き込みをチェーンに追加して順序を保証する */
  private enqueueWrite(eventId: string, filePath: string, data: string): void {
    const prev = this.writeChains.get(eventId) ?? Promise.resolve();
    const next = prev.then(() => appendFileAsync(filePath, data)).then(() => {
      // チェーンが完了し、かつアクティブファイルが閉じられていれば Map から除去
      if (!this.activeFiles.has(eventId) && this.writeChains.get(eventId) === next) {
        this.writeChains.delete(eventId);
      }
    });
    this.writeChains.set(eventId, next);
  }

  /** ファイルヘッダを構築 */
  private buildHeader(eventId: string, info: ParsedEewInfo): string {
    const lines: string[] = [];
    lines.push(`=== 緊急地震速報 EventID: ${eventId} ===`);
    lines.push(`記録開始: ${formatLocalTime(info.reportDateTime)}`);
    lines.push("");
    return lines.join("\n");
  }

  /** 地域名に注記 ({Lx,P,A}) を付与 */
  private formatAreaName(area: {
    name: string;
    lgIntensity?: string;
    isPlum?: boolean;
    hasArrived?: boolean;
  }): string {
    const flags: string[] = [];
    if (this.fields.lgIntensity && area.lgIntensity) {
      flags.push(`L${area.lgIntensity}`);
    }
    if (this.fields.isPlum && area.isPlum) {
      flags.push("P");
    }
    if (this.fields.hasArrived && area.hasArrived) {
      flags.push("A");
    }
    return flags.length > 0 ? `${area.name}{${flags.join(",")}}` : area.name;
  }

  /** 地域注記の凡例行が必要かどうか判定 */
  private needsAreaLegend(areas: { lgIntensity?: string; isPlum?: boolean; hasArrived?: boolean }[]): boolean {
    if (this.fields.lgIntensity && areas.some(a => a.lgIntensity)) return true;
    if (this.fields.isPlum && areas.some(a => a.isPlum)) return true;
    if (this.fields.hasArrived && areas.some(a => a.hasArrived)) return true;
    return false;
  }

  /** 1報分のテキストブロックを構築 */
  private buildReportBlock(info: ParsedEewInfo, diff?: EewDiff): string {
    const serial = info.serial ?? "?";
    const isCancelled = info.infoType === "取消";
    const typeLabel = isCancelled
      ? "取消"
      : info.isWarning
        ? "警報"
        : "予報";
    const time = nowTimeStr();

    const lines: string[] = [];
    lines.push(`--- 第${serial}報 (${typeLabel}) ${time} ---`);

    if (isCancelled) {
      lines.push("この地震についての緊急地震速報は取り消されました。");
      lines.push("");
      return lines.join("\n");
    }

    if (info.earthquake) {
      const eq = info.earthquake;
      if (this.fields.hypocenter) {
        lines.push(`震源: ${eq.hypocenterName}`);
      }

      // originTime (hypocenter が OFF なら非表示)
      if (this.fields.hypocenter && this.fields.originTime && eq.originTime) {
        lines.push(`  発生: ${formatLocalTime(eq.originTime)}`);
      }

      // coordinates (hypocenter が OFF なら非表示)
      if (this.fields.hypocenter && this.fields.coordinates && eq.latitude && eq.longitude) {
        lines.push(`  座標: ${eq.latitude} ${eq.longitude}`);
      }

      if (info.isAssumedHypocenter) {
        if (this.fields.hypocenter) {
          lines.push("仮定震源要素 (震源未確定・PLUM法による推定)");
        }
      } else {
        if (this.fields.magnitude) {
          lines.push(`M${eq.magnitude}  深さ${eq.depth}`);
        }
        if (this.fields.diff && diff) {
          const diffStr = formatDiff(diff, info);
          if (diffStr.length > 0) {
            lines.push(`変化:${diffStr}`);
          }
        }
        // maxIntChangeReason (diff の直下)
        if (this.fields.maxIntChangeReason && info.maxIntChangeReason != null) {
          const label = MAX_INT_CHANGE_REASON_LABELS[info.maxIntChangeReason] ?? "不明";
          lines.push(`震度変化理由: ${label} [${info.maxIntChangeReason}]`);
        }
      }
    }

    if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
      if (this.fields.forecastIntensity) {
        const topInt = info.forecastIntensity.areas[0].intensity;
        lines.push(`最大予測震度: ${topInt}`);
      }

      // maxLgInt (forecastIntensity が OFF なら非表示)
      if (this.fields.forecastIntensity && this.fields.maxLgInt && info.forecastIntensity.maxLgInt) {
        lines.push(`最大予測長周期階級: ${info.forecastIntensity.maxLgInt}`);
      }

      if (this.fields.forecastAreas) {
        // 注記の凡例行
        if (this.needsAreaLegend(info.forecastIntensity.areas)) {
          const legendParts: string[] = [];
          if (this.fields.lgIntensity) legendParts.push("Lx=長周期階級");
          if (this.fields.isPlum) legendParts.push("P=PLUM");
          if (this.fields.hasArrived) legendParts.push("A=主要動到達");
          lines.push(`  注記: {${legendParts.join(", ")}}`);
        }

        // 震度ごとにグループ化して地域名を表示
        const byIntensity = new Map<string, string[]>();
        for (const area of info.forecastIntensity.areas) {
          const existing = byIntensity.get(area.intensity) ?? [];
          existing.push(this.formatAreaName(area));
          byIntensity.set(area.intensity, existing);
        }
        for (const [intensity, names] of byIntensity) {
          lines.push(`  震度${intensity}: ${names.join(", ")}`);
        }
      }
    }

    // 最終報
    if (info.nextAdvisory) {
      lines.push(info.nextAdvisory);
    }

    lines.push("");
    return lines.join("\n");
  }

  /** ログディレクトリが存在しなければ作成 */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }
}
