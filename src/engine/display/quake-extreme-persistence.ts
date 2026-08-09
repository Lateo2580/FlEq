import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type { QuakeExtremePersistedV1, QuakeExtremeRecordV1 } from "./quake-extreme-store";
import type { PersistedSeenEntry } from "./revision-guard";
import {
  depthValueFromLegacyScalar,
  depthSemanticFromLegacyScalar,
  magnitudeValueFromLegacyScalar,
  magnitudeSemanticFromLegacyScalar,
  normalizeNumericSpecialValueForPersistence,
  numericSpecialValueFromDisplaySemantic,
  parsePersistedDepthSemantic,
  parsePersistedMagnitudeSemantic,
  parsePersistedNumericSpecialValue,
} from "../magnitude-depth-persistence";
import {
  projectDepthSemantic,
  projectMagnitudeSemantic,
} from "./magnitude-depth-semantic";

const PERSIST_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedQuakeExtremeV1 extends QuakeExtremePersistedV1 {
  version: typeof PERSIST_SCHEMA_VERSION;
  savedAt: string;
}

/** 震度 7 専用時計の小さな永続化層。強制終了以外では debounce 後に原子的に書く。 */
export class QuakeExtremePersistence {
  private pending: QuakeExtremePersistedV1 | null = null;
  private pendingNowMs: number | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly persistPath: string, private readonly debounceMs = SAVE_DEBOUNCE_MS) {}

  load(nowMs: number): QuakeExtremePersistedV1 | null {
    try {
      if (!fs.existsSync(this.persistPath)) return null;
      const parsed: unknown = JSON.parse(fs.readFileSync(this.persistPath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== PERSIST_SCHEMA_VERSION || !Array.isArray(parsed.records)) return null;
      const records = parsed.records.filter(isRecord).flatMap((record): QuakeExtremeRecordV1[] => {
        const groupKey = record.groupKey;
        const originTime = record.originTime;
        const reportDateTime = record.reportDateTime;
        const hypocenterName = record.hypocenterName;
        const magnitude = record.magnitude;
        const hasMagnitudeSemantic = Object.hasOwn(record, "magnitudeSemantic");
        const hasMagnitudeValue = Object.hasOwn(record, "magnitudeValue");
        const depth = record.depth;
        const hasDepthSemantic = Object.hasOwn(record, "depthSemantic");
        const hasDepthValue = Object.hasOwn(record, "depthValue");
        const sourceTypes = nonEmptyStrings(record.sourceTypes);
        const observationSourceType = record.observationSourceType;
        if (typeof groupKey !== "string" || groupKey === "" || typeof originTime !== "string" ||
            reportDateTime !== undefined &&
              (typeof reportDateTime !== "string" || !Number.isFinite(Date.parse(reportDateTime))) ||
            !isOptionalNullableString(hypocenterName) ||
            !isOptionalNullableString(magnitude) ||
            !isOptionalNullableString(depth) ||
            sourceTypes == null ||
            observationSourceType != null &&
              (typeof observationSourceType !== "string" || observationSourceType === "" ||
                !sourceTypes.includes(observationSourceType))) return [];
        const persistedMagnitudeSemantic = hasMagnitudeSemantic
          ? parsePersistedMagnitudeSemantic(record.magnitudeSemantic)
          : undefined;
        const persistedDepthSemantic = hasDepthSemantic
          ? parsePersistedDepthSemantic(record.depthSemantic)
          : undefined;
        const magnitudeValue = hasMagnitudeValue
          ? parsePersistedNumericSpecialValue(record.magnitudeValue)
          : persistedMagnitudeSemantic != null
            ? numericSpecialValueFromDisplaySemantic(persistedMagnitudeSemantic)
            : magnitude === undefined
              ? undefined
              : magnitudeValueFromLegacyScalar(magnitude);
        const depthValue = hasDepthValue
          ? parsePersistedNumericSpecialValue(record.depthValue)
          : persistedDepthSemantic != null
            ? numericSpecialValueFromDisplaySemantic(persistedDepthSemantic)
            : depth === undefined
              ? undefined
              : depthValueFromLegacyScalar(depth);
        if (
          (magnitudeValue == null && hasMagnitudeValue)
          || (depthValue == null && hasDepthValue)
          || (persistedMagnitudeSemantic == null && hasMagnitudeSemantic && !hasMagnitudeValue)
          || (persistedDepthSemantic == null && hasDepthSemantic && !hasDepthValue)
        ) {
          return [];
        }
        const magnitudeSemantic = magnitudeValue == null
          ? persistedMagnitudeSemantic
          : projectMagnitudeSemantic(magnitudeValue);
        const depthSemantic = depthValue == null
          ? persistedDepthSemantic
          : projectDepthSemantic(depthValue);
        const originMs = Date.parse(originTime);
        if (!Number.isFinite(originMs) || originMs > nowMs) return [];
        return [{
          groupKey,
          originTime,
          ...(reportDateTime === undefined ? {} : { reportDateTime }),
          ...(hypocenterName === undefined ? {} : { hypocenterName }),
          ...(magnitude === undefined ? {} : { magnitude }),
          ...(magnitudeSemantic == null ? {} : { magnitudeSemantic }),
          ...(magnitudeValue == null ? {} : { magnitudeValue }),
          ...(depth === undefined ? {} : { depth }),
          ...(depthSemantic == null ? {} : { depthSemantic }),
          ...(depthValue == null ? {} : { depthValue }),
          sourceTypes: [...new Set(sourceTypes)],
          ...(observationSourceType == null ? {} : { observationSourceType }),
        }];
      });
      const seen = Array.isArray(parsed.seen)
        ? parsed.seen.filter(isRecord).flatMap((entry): PersistedSeenEntry[] => {
          const revision = entry.revision;
          if (typeof entry.key !== "string" || entry.key === "" || !isRecord(revision) ||
              typeof revision.reportTimeMs !== "number" || !Number.isFinite(revision.reportTimeMs) ||
              revision.serial != null && typeof revision.serial !== "string" ||
              typeof entry.forgetAtMs !== "number" || !Number.isFinite(entry.forgetAtMs) ||
              entry.forgetAtMs <= nowMs) return [];
          return [{
            key: entry.key,
            revision: { reportTimeMs: revision.reportTimeMs, serial: revision.serial ?? null },
            forgetAtMs: entry.forgetAtMs,
          }];
        })
        : [];
      return { records, seen };
    } catch (err) {
      log.warn(`[quake-extreme-persistence] load 失敗: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  schedule(state: QuakeExtremePersistedV1, nowMs: number): void {
    this.pending = state;
    this.pendingNowMs = nowMs;
    if (this.timer != null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.pending;
      const pendingNowMs = this.pendingNowMs;
      this.pending = null;
      this.pendingNowMs = null;
      if (pending != null && pendingNowMs != null) this.save(pending, pendingNowMs);
    }, this.debounceMs);
    this.timer.unref();
  }

  save(state: QuakeExtremePersistedV1, nowMs: number): void {
    const data: PersistedQuakeExtremeV1 = {
      version: PERSIST_SCHEMA_VERSION,
      savedAt: new Date(nowMs).toISOString(),
      records: state.records.map((record) => {
        const magnitudeValue = record.magnitudeValue
          ?? (record.magnitudeSemantic == null
            ? record.magnitude === undefined ? undefined : magnitudeValueFromLegacyScalar(record.magnitude)
            : numericSpecialValueFromDisplaySemantic(record.magnitudeSemantic) ?? undefined);
        const depthValue = record.depthValue
          ?? (record.depthSemantic == null
            ? record.depth === undefined ? undefined : depthValueFromLegacyScalar(record.depth)
            : numericSpecialValueFromDisplaySemantic(record.depthSemantic) ?? undefined);
        const magnitudeSemantic = magnitudeValue == null
          ? record.magnitudeSemantic
            ?? (record.magnitude === undefined ? undefined : magnitudeSemanticFromLegacyScalar(record.magnitude))
          : projectMagnitudeSemantic(magnitudeValue);
        const depthSemantic = depthValue == null
          ? record.depthSemantic
            ?? (record.depth === undefined ? undefined : depthSemanticFromLegacyScalar(record.depth))
          : projectDepthSemantic(depthValue);
        return {
          ...record,
          ...(magnitudeSemantic == null
            ? {}
            : { magnitudeSemantic: { ...magnitudeSemantic } }),
          ...(magnitudeValue == null
            ? {}
            : { magnitudeValue: normalizeNumericSpecialValueForPersistence(magnitudeValue) }),
          ...(depthSemantic == null
            ? {}
            : { depthSemantic: { ...depthSemantic } }),
          ...(depthValue == null
            ? {}
            : { depthValue: normalizeNumericSpecialValueForPersistence(depthValue) }),
        };
      }),
      seen: state.seen ?? [],
    };
    const dir = path.dirname(this.persistPath);
    const tmpPath = `${this.persistPath}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmpPath, `${JSON.stringify(data)}\n`, "utf8");
      fs.renameSync(tmpPath, this.persistPath);
    } catch (err) {
      log.warn(`[quake-extreme-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 取消・下方修正用。予約済みの旧 active を破棄し、tombstone を同期保存する。 */
  saveImmediate(state: QuakeExtremePersistedV1, nowMs: number): void {
    this.dispose();
    this.save(state, nowMs);
  }

  dispose(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.pendingNowMs = null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function nonEmptyStrings(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 ||
      !value.every((item): item is string => typeof item === "string" && item !== "")) return null;
  return value;
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value == null || typeof value === "string";
}
