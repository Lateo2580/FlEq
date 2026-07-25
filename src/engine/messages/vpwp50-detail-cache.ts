import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type {
  DetailProvider,
  DetailSnapshotOf,
  FrameLevel,
  ParsedWeatherWarningTimeseriesInfo,
} from "../../types";
import { weatherWarningTimeseriesFrameLevel } from "../presentation/level-helpers";
import {
  flattenEntries,
  type WeatherSeverityEntry,
} from "../presentation/weather-severity-pyramid";

const PERSIST_DIR = "data/runtime";
const PERSIST_FILE = "vpwp50-latest.json";
const PERSIST_SCHEMA_VERSION = 2;

interface PersistedVpwp50 {
  version: number;
  savedAt: string;
  reportDateTime: string;
  targetArea: string | null;
  entries: WeatherSeverityEntry[];
  unknownCodes: ParsedWeatherWarningTimeseriesInfo["unknownCodes"];
  infoType: string;
  frameLevel: FrameLevel;
}

const VALID_FRAME_LEVELS = ["critical", "warning", "normal", "info", "cancel"] as const;
const VALID_SEVERITIES = ["special", "warning", "advisory", "unknown"] as const;
const VALID_DISPLAY_SEVERITIES = [
  "officialL5", "officialL4", "nonLevelSpecial", "officialL3", "nonLevelWarning",
  "officialL2", "nonLevelAdvisory", "officialL1", "unknown", "release",
] as const;
const VALID_RESOLUTION_SOURCES = ["map", "nameFallback", "unknown"] as const;

/**
 * rememberLatest() が実際にディスクへ書くまでの遅延。
 * VPWP50 は 2 MB 級で、パース直後の同期保存が受信スレッドを止めていた。
 * メモリ上の latest は即時更新されるため、REPL の detail 表示は遅延しない。
 */
const SAVE_DEBOUNCE_MS = 3000;

export class Vpwp50DetailCache implements DetailProvider<"vpwp50"> {
  readonly category = "vpwp50";
  readonly emptyMessage = "VPWP50 (気象警報・注意報時系列情報) はまだ受信していません";
  private latest: PersistedVpwp50 | null = null;
  private readonly persistPath: string;
  private readonly debounceMs: number;
  private pending: { persisted: PersistedVpwp50; seq: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** 内容を確定した順の通し番号。書き込み完了の順序が入れ替わっても最新が勝つようにする */
  private seq = 0;
  /** 実際に rename まで到達した最大 seq。これより古い書き込みは rename せずに捨てる */
  private renamedSeq = 0;

  constructor(opts: { persistRoot?: string; debounceMs?: number } = {}) {
    const root = opts.persistRoot ?? process.cwd();
    this.persistPath = path.join(root, PERSIST_DIR, PERSIST_FILE);
    this.debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS;
    this.loadFromDisk();
  }

  rememberLatest(info: ParsedWeatherWarningTimeseriesInfo): void {
    const entries = flattenEntries(info);
    const persisted: PersistedVpwp50 = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      reportDateTime: info.reportDateTime ?? "",
      targetArea: info.targetArea?.name ?? null,
      entries,
      unknownCodes: info.unknownCodes,
      infoType: info.infoType,
      frameLevel: weatherWarningTimeseriesFrameLevel(info),
    };
    this.latest = persisted;
    // seq は「内容を確定した時点」で採る。書き込み開始時に採ると、予約 → 同期保存の順で
    // 呼ばれたとき古い内容の方が大きい seq を持ってしまい、順序保証が逆転する
    this.pending = { persisted, seq: ++this.seq };
    this.armTimer();
  }

  /**
   * 予約済みの内容を同期で書き切る。シャットダウン経路から呼ぶ。
   * 予約がなければ何もしない。
   */
  flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending == null) return;
    this.saveToDisk(pending.persisted, pending.seq);
  }

  /** テスト用: 予約済みの書き込みをタイマーを待たずに実行する (実時間依存を避けるため) */
  __test_writePending(): Promise<void> {
    this.clearTimer();
    return this.writePending();
  }

  private armTimer(): void {
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.writePending();
    }, this.debounceMs);
    // 保存予約だけでプロセスを生かし続けない (書き切りは flush の責務)
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async writePending(): Promise<void> {
    if (this.writing) return;
    const pending = this.pending;
    if (pending == null) return;
    this.pending = null;
    this.writing = true;
    const tmpPath = this.tmpPathFor(pending.seq);
    try {
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(pending.persisted), "utf8");
      // ここから rename までは await を挟まない。await で中断すると、guard 通過後・rename 完了前に
      // 同期保存が割り込み、そのあと古い rename が完了して旧内容で上書き + renamedSeq 逆行が起きる
      if (pending.seq < this.renamedSeq) {
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = pending.seq;
    } catch (e) {
      log.warn(`[vpwp50-cache] persist save 失敗: ${(e as Error).message}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    } finally {
      this.writing = false;
      // 書き込み中に届いた更新は、終わってからもう一度だけ書く
      if (this.pending != null) this.armTimer();
    }
  }

  getDetail(): DetailSnapshotOf<"vpwp50"> | null {
    const data = this.latest;
    if (data == null) return null;
    return {
      kind: "vpwp50",
      detail: {
        savedAt: data.savedAt,
        targetArea: data.targetArea,
        entries: data.entries.map((entry) => ({
          severity: entry.severity,
          kindLabel: entry.kindLabel,
          areaName: entry.areaName,
          windows: entry.windows.map((window) => ({
            series: window.series,
            timeRef: window.timeRef,
            window: window.window,
            peak: window.peak,
            criteriaPeriod: window.criteriaPeriod,
          })),
        })),
        unknownCodes: data.unknownCodes,
        infoType: data.infoType,
        frameLevel: data.frameLevel,
      },
    };
  }

  /**
   * rename 前に強制終了すると seq 固有名の tmp が残る (Pi は電源断が起こりうる)。
   * 起動時の load で同ディレクトリの残骸を掃除する。掃除の失敗は起動を妨げない。
   */
  private cleanStaleTmpFiles(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) return;
      const base = path.basename(this.persistPath);
      for (const name of fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch (e) {
      log.debug(`[vpwp50-cache] 残留 tmp の掃除に失敗: ${(e as Error).message}`);
    }
  }

  /** tmp 名は書き込みごとに一意にする (同期・非同期が同じ tmp を奪い合わないため) */
  private tmpPathFor(seq: number): string {
    return `${this.persistPath}.${seq}.tmp`;
  }

  private loadFromDisk(): void {
    this.cleanStaleTmpFiles();
    try {
      if (!fs.existsSync(this.persistPath)) return;
      const raw = fs.readFileSync(this.persistPath, "utf8");
      const parsed = JSON.parse(raw);
      const version = (parsed as { version?: unknown } | null)?.version;
      if (version !== PERSIST_SCHEMA_VERSION) {
        // 予定されたスキーマ世代交代 — 静かに破棄 (本番再起動時に warn ノイズを出さない)
        log.debug(`[vpwp50-cache] persist schema 世代交代 (v${String(version)} → v${PERSIST_SCHEMA_VERSION}) — 旧データ破棄`);
        return;
      }
      if (!isValidPersisted(parsed)) {
        log.warn("[vpwp50-cache] persist structure validation 失敗 — 破棄");
        return;
      }
      this.latest = parsed;
    } catch (e) {
      log.warn(`[vpwp50-cache] persist load 失敗: ${(e as Error).message}`);
    }
  }

  private saveToDisk(persisted: PersistedVpwp50, seq: number): void {
    const tmpPath = this.tmpPathFor(seq);
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(persisted), "utf8");
      if (seq < this.renamedSeq) {
        // 既により新しい内容が置かれている。追い越された書き込みは反映しない
        fs.rmSync(tmpPath, { force: true });
        return;
      }
      fs.renameSync(tmpPath, this.persistPath);
      this.renamedSeq = seq;
    } catch (e) {
      log.warn(`[vpwp50-cache] persist save 失敗: ${(e as Error).message}`);
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
    }
  }
}

function isValidPersisted(obj: unknown): obj is PersistedVpwp50 {
  if (obj == null || typeof obj !== "object") return false;
  const o = obj as Record<string, unknown>;
  if (o.version !== PERSIST_SCHEMA_VERSION) return false;
  if (typeof o.savedAt !== "string") return false;
  if (typeof o.infoType !== "string") return false;
  if (!VALID_FRAME_LEVELS.includes(o.frameLevel as FrameLevel)) return false;
  if (!Array.isArray(o.entries)) return false;
  if (!Array.isArray(o.unknownCodes)) return false;
  for (const e of o.entries) {
    if (e == null || typeof e !== "object") return false;
    const en = e as Record<string, unknown>;
    if (!Array.isArray(en.windows)) return false;
    if (typeof en.areaName !== "string") return false;
    if (typeof en.code !== "string") return false;
    if (typeof en.phenomenon !== "string") return false;
    if (typeof en.kindLabel !== "string") return false;
    if (typeof en.severity !== "string") return false;
    if (!VALID_SEVERITIES.includes(en.severity as never)) return false;
    // Phase B: 2 系統フィールドの存在検証
    if (typeof en.displaySeverity !== "string") return false;
    if (!VALID_DISPLAY_SEVERITIES.includes(en.displaySeverity as never)) return false;
    if (typeof en.resolutionSource !== "string") return false;
    if (!VALID_RESOLUTION_SOURCES.includes(en.resolutionSource as never)) return false;
    // officialAlertLevel は null または 1-5 の number
    if (en.officialAlertLevel != null) {
      if (typeof en.officialAlertLevel !== "number") return false;
      if (![1, 2, 3, 4, 5].includes(en.officialAlertLevel as number)) return false;
    }
  }
  return true;
}
