import * as fs from "fs";
import * as path from "path";
import { ParsedEewInfo } from "../types";
import { EewDiff, EewUpdateResult } from "./eew-tracker";
import * as log from "../logger";

/** ログ出力のデフォルトディレクトリ */
const DEFAULT_LOG_DIR = path.join(process.cwd(), "eew-logs");

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
function formatDiff(diff: EewDiff): string {
  const parts: string[] = [];
  if (diff.magnitudeChange) parts.push(`M${diff.magnitudeChange}`);
  if (diff.depthChange) parts.push(`深さ${diff.depthChange}`);
  if (diff.maxIntChange) parts.push(diff.maxIntChange);
  if (diff.hypocenterChange) parts.push("震源変更");
  return parts.length > 0 ? `  [${parts.join(", ")}]` : "";
}

/**
 * EEW イベントごとにログファイルへ逐次追記するロガー。
 * 各報の受信時に appendFileSync で即座にディスクへ書き込み、
 * 停電・ネットワーク遮断時でもそれまでの記録を保全する。
 */
export class EewEventLogger {
  private readonly logDir: string;
  /** eventId → ファイルパス */
  private activeFiles = new Map<string, string>();

  constructor(logDir?: string) {
    this.logDir = logDir ?? DEFAULT_LOG_DIR;
  }

  /** EEW 報を受信した際に呼び出す。第1報でファイル作成、続報は追記。 */
  logReport(info: ParsedEewInfo, result: EewUpdateResult): void {
    const eventId = info.eventId || "unknown";

    try {
      if (result.isNew) {
        this.startNewEvent(eventId, info);
      } else {
        this.appendReport(eventId, info, result.diff);
      }
    } catch (err) {
      if (err instanceof Error) {
        log.error(`EEW ログ書き込み失敗: ${err.message}`);
      }
    }
  }

  /** イベント終了を記録し、追跡から除去する */
  closeEvent(eventId: string, reason: string): void {
    const filePath = this.activeFiles.get(eventId);
    if (filePath == null) return;

    try {
      const line = `\n--- 記録終了 (${reason}) ${nowTimeStr()} ---\n`;
      fs.appendFileSync(filePath, line, "utf-8");
      log.debug(`EEW ログ記録終了: ${filePath}`);
    } catch (err) {
      if (err instanceof Error) {
        log.error(`EEW ログ終了書き込み失敗: ${err.message}`);
      }
    }
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

  /** 新規イベントのログファイルを作成 */
  private startNewEvent(eventId: string, info: ParsedEewInfo): void {
    this.ensureLogDir();

    const fileName = `eew_${eventId}_${nowFileTimestamp()}.log`;
    const filePath = path.join(this.logDir, fileName);
    this.activeFiles.set(eventId, filePath);

    const header = this.buildHeader(eventId, info);
    const report = this.buildReportBlock(info, undefined);

    fs.appendFileSync(filePath, header + report, "utf-8");
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
    fs.appendFileSync(filePath, report, "utf-8");
  }

  /** ファイルヘッダを構築 */
  private buildHeader(eventId: string, info: ParsedEewInfo): string {
    const lines: string[] = [];
    lines.push(`=== 緊急地震速報 EventID: ${eventId} ===`);
    lines.push(`記録開始: ${formatLocalTime(info.reportDateTime)}`);
    lines.push("");
    return lines.join("\n");
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
      lines.push(`震源: ${eq.hypocenterName}`);

      let magDepth = `M${eq.magnitude}  深さ${eq.depth}`;
      if (diff) {
        magDepth += formatDiff(diff);
      }
      lines.push(magDepth);
    }

    if (info.forecastIntensity && info.forecastIntensity.areas.length > 0) {
      const topInt = info.forecastIntensity.areas[0].intensity;
      lines.push(`最大予測震度: ${topInt}`);

      // 震度ごとにグループ化して地域名を表示
      const byIntensity = new Map<string, string[]>();
      for (const area of info.forecastIntensity.areas) {
        const existing = byIntensity.get(area.intensity) ?? [];
        existing.push(area.name);
        byIntensity.set(area.intensity, existing);
      }
      for (const [intensity, names] of byIntensity) {
        lines.push(`  震度${intensity}: ${names.join(", ")}`);
      }
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
