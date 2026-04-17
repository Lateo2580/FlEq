import * as fs from "fs";
import * as path from "path";
import * as log from "../../logger";
import { toPresentationEvent } from "../presentation/events/to-presentation-event";
import type { ProcessOutcome, VolcanoBatchOutcome, PresentationEvent } from "../presentation/types";

/** イベントファイルの JSON スキーマ */
export interface EventFilePayload {
  version: 1;
  exportedAt: string;
  event: PresentationEvent;
}

/** EventFileWriter の設定 */
export interface EventFileWriterOptions {
  outputDir?: string;
  enabled?: boolean;
  includeRaw?: boolean;
  maxFiles?: number;
}

/** デフォルト出力ディレクトリ */
const DEFAULT_OUTPUT_DIR = path.join(process.cwd(), "events");

/** デフォルトのファイル上限 */
const DEFAULT_MAX_FILES = 1000;

/** クリーンアップを実行する書き込みカウント間隔 */
const CLEANUP_INTERVAL = 10;

/** eventId / msgId をファイル名安全にサニタイズ */
function sanitizeId(value: string, maxLen: number): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLen);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const pad3 = (n: number): string => String(n).padStart(3, "0");

function nowTimestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}${pad3(d.getMilliseconds())}`;
}

/**
 * 受信した表示対象電文を個別 JSON ファイルとして書き出すライター。
 * FlEq の CLI 表示パイプラインとは独立に動作する。
 */
export class EventFileWriter {
  private enabled: boolean;
  private includeRaw: boolean;
  private readonly outputDir: string;
  private readonly maxFiles: number;
  private writeCount = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(options?: EventFileWriterOptions) {
    this.outputDir = options?.outputDir ?? DEFAULT_OUTPUT_DIR;
    this.enabled = options?.enabled ?? false;
    this.includeRaw = options?.includeRaw ?? false;
    this.maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }
  setIncludeRaw(includeRaw: boolean): void { this.includeRaw = includeRaw; }
  isIncludeRaw(): boolean { return this.includeRaw; }
  getOutputDir(): string { return this.outputDir; }

  /** ProcessOutcome / VolcanoBatchOutcome を JSON ファイルとして書き出す */
  write(outcome: ProcessOutcome | VolcanoBatchOutcome): void {
    if (!this.enabled) return;

    const event = toPresentationEvent(outcome);
    const eventId = sanitizeId(event.eventId ?? "unknown", 64);
    const msgId = sanitizeId(outcome.msg.id ?? "nomsg", 32);
    const timestamp = nowTimestamp();
    const fileName = `${timestamp}_${event.domain}_${eventId}_${msgId}.json`;

    if (!this.includeRaw) {
      event.raw = null;
    }

    const payload: EventFilePayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      event,
    };

    const json = JSON.stringify(payload, null, 2);
    const filePath = path.join(this.outputDir, fileName);

    this.enqueueWrite(filePath, json);
    this.writeCount++;

    if (this.writeCount % CLEANUP_INTERVAL === 0) {
      this.enqueueCleanup();
    }
  }

  /** 全書き込みの完了を待つ (テスト用) */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** 手動でクリーンアップを実行 (テスト用) */
  async triggerCleanup(): Promise<void> {
    await this.cleanup();
  }

  private enqueueWrite(filePath: string, data: string): void {
    this.writeChain = this.writeChain
      .then(() => this.writeFile(filePath, data))
      .catch(() => {});
  }

  private enqueueCleanup(): void {
    this.writeChain = this.writeChain
      .then(() => this.cleanup())
      .catch(() => {});
  }

  /** ディレクトリ確保 + アトミック書き込み (.tmp → rename) */
  private async writeFile(filePath: string, data: string): Promise<void> {
    const tmpPath = `${filePath}.tmp`;
    try {
      if (!this.dirEnsured) {
        await fs.promises.mkdir(this.outputDir, { recursive: true });
        this.dirEnsured = true;
      }
      await fs.promises.writeFile(tmpPath, data, "utf-8");
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      if (err instanceof Error) {
        log.error(`イベントファイル書き込み失敗: ${err.message}`);
      }
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        // noop
      }
      this.dirEnsured = false;
    }
  }

  /** 上限超過時に古いファイルを削除 */
  private async cleanup(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.outputDir);
      const jsonFiles = files.filter((f) => f.endsWith(".json")).sort();
      if (jsonFiles.length <= this.maxFiles) return;

      const deleteCount = Math.max(1, Math.ceil(this.maxFiles * 0.1));
      const toDelete = jsonFiles.slice(0, deleteCount);

      for (const file of toDelete) {
        try {
          await fs.promises.unlink(path.join(this.outputDir, file));
        } catch {
          // ベストエフォート
        }
      }
      log.debug(`イベントファイル: ${toDelete.length} 件の古いファイルを削除しました`);
    } catch (err) {
      if (err instanceof Error) {
        log.error(`イベントファイル クリーンアップ失敗: ${err.message}`);
      }
    }
  }
}
