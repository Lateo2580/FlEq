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

export class Vpwp50DetailCache implements DetailProvider<"vpwp50"> {
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
