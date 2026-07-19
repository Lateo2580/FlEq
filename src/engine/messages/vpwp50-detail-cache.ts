import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type { DetailProvider, ParsedWeatherWarningTimeseriesInfo } from "../../types";
import {
  getFrameWidth,
  createRenderBuffer,
  frameTop,
  frameLine,
  frameDivider,
  frameBottom,
  flushWithRecap,
  type FrameLevel,
} from "../../ui/formatter";
import { weatherWarningTimeseriesFrameLevel } from "../presentation/level-helpers";
import {
  flattenEntries,
  partitionBySeverity,
  formatSeriesWindows,
  formatPeakBySeries,
  formatCriteriaTimeBySeries,
  type WeatherSeverityEntry,
} from "../presentation/weather-severity-pyramid";
import { pushFrameTable } from "../../ui/frame-table-builder";

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

export class Vpwp50DetailCache implements DetailProvider {
  readonly category = "vpwp50";
  readonly emptyMessage = "VPWP50 (気象警報・注意報時系列情報) はまだ受信していません";
  private latest: PersistedVpwp50 | null = null;
  private readonly persistPath: string;

  constructor(opts: { persistRoot?: string } = {}) {
    const root = opts.persistRoot ?? process.cwd();
    this.persistPath = path.join(root, PERSIST_DIR, PERSIST_FILE);
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
    this.saveToDisk(persisted);
  }

  hasDetail(): boolean {
    return this.latest != null;
  }

  showDetail(): void {
    const data = this.latest;
    if (data == null) return;
    const level: FrameLevel = data.frameLevel;
    const width = getFrameWidth();
    const buf = createRenderBuffer();

    buf.push(frameTop(level, width));
    buf.push(
      frameLine(
        level,
        `[detail] VPWP50 ${data.targetArea ?? ""} (${data.infoType})  保存 ${data.savedAt.slice(0, 19).replace("T", " ")}`,
        width,
      ),
    );

    const part = partitionBySeverity(data.entries);

    if (part.advisory.length > 0) {
      buf.push(frameDivider(level, width));
      buf.push(frameLine(level, "▽ 注意報フル", width));
      pushAdvisoryFull(buf, level, width, part.advisory);
    }

    const detailRows: string[][] = [];
    for (const e of [...part.special, ...part.warning]) {
      for (const w of e.windows) {
        if (w.criteriaPeriod == null) continue;
        detailRows.push([
          `${e.kindLabel} @${e.areaName} (${w.series})`,
          w.criteriaPeriod.sentence,
          w.criteriaPeriod.duration,
        ]);
      }
    }
    if (detailRows.length > 0) {
      buf.push(frameDivider(level, width));
      buf.push(frameLine(level, "[基準到達詳細]", width));
      pushFrameTable(
        buf,
        level,
        width,
        [{ header: "対象" }, { header: "Sentence" }, { header: "Duration" }],
        detailRows,
      );
    }

    if (data.unknownCodes.length > 0) {
      buf.push(frameDivider(level, width));
      buf.push(frameLine(level, "[未知コード]", width));
      for (const u of data.unknownCodes) {
        buf.push(
          frameLine(
            level,
            `  ${u.areaName} ${u.propertyType} code=${u.code} ref=${u.timeRef} 高め扱い`,
            width,
          ),
        );
      }
    }

    buf.push(frameBottom(level, width));
    flushWithRecap(buf, level, width);
  }

  private loadFromDisk(): void {
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

  private saveToDisk(persisted: PersistedVpwp50): void {
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      const tmpPath = `${this.persistPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(persisted), "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (e) {
      log.warn(`[vpwp50-cache] persist save 失敗: ${(e as Error).message}`);
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

function pushAdvisoryFull(
  buf: ReturnType<typeof createRenderBuffer>,
  level: FrameLevel,
  width: number,
  advisory: WeatherSeverityEntry[],
): void {
  const rows: (string | null)[][] = advisory.map((e) => [
    e.kindLabel,
    e.areaName,
    formatSeriesWindows(e.windows),
    formatPeakBySeries(e.windows, e.windows.length > 1),
    formatCriteriaTimeBySeries(e.windows, e.windows.length > 1),
  ]);
  pushFrameTable(
    buf,
    level,
    width,
    [
      { header: "種別" },
      { header: "地域" },
      { header: "時刻枠" },
      { header: "ピーク" },
      { header: "基準到達" },
    ],
    rows,
  );
}
