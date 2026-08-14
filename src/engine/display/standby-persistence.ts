import fs from "node:fs";
import path from "node:path";
import * as log from "../../logger";
import type {
  DisplayFloodHydrographV1,
  DisplayFloodRiverV1,
  DisplayFloodStationV1,
  DisplayHeatAreaV1,
  DisplayTyphoonV1,
  DisplayVolcanoAlertClassV1,
  DisplayVolcanoEventV1,
  DisplayWeatherAlertItemV1,
  DisplayWeatherAlertV1,
  DisplayWeatherSourceV1,
} from "./protocol";
import type { PersistedFloodEventState, PersistedFloodState } from "./flood-active-reducer";
import type { PersistedSeenEntry } from "./revision-guard";
import { compareRevision, type StandbyRevision } from "./standby-registry";
import type {
  ParsedTsunamiInfo,
  SpecialValue,
  SpecialValueDiagnostic,
  StrictTextMeta,
  TelegramMeta,
  TsunamiObservationStation,
  TsunamiParserDiagnostic,
  Vpws50CurrentAreasForDisplay,
} from "../../types";
import {
  createTelegramMeta,
  FUTURE_REPORT_DATETIME_SKEW_MS,
  parseStrictReportDateTime,
  parseTelegramSerial,
} from "../../dmdata/telegram-meta";
import {
  copyDisplayPlumeHeightSemantic,
  isDisplayPlumeHeightSemantic,
  legacyDisplayPlumeHeightSemantics,
} from "./plume-height-semantic";
import {
  canonicalizeLegacyTsunamiInfo,
  canonicalizeLegacyTsunamiObservation,
  type LegacyParsedTsunamiInfoInput,
  type LegacyTsunamiForecastItemInput,
  type LegacyTsunamiObservationInput,
} from "../../dmdata/tsunami-legacy-adapter";
import {
  VPWS50_SNAPSHOT_GENERATION,
  Vpws50StateHolder,
  type PersistedVpws50StateV2,
  type WeatherReportIdentity,
} from "../messages/vpws50-state";
import {
  TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY,
} from "../messages/tsunami-state";
import {
  compactPersistedSemanticKeys,
  TELEGRAM_REVISION_MAX_ENTRIES,
  type PersistedTelegramRevisionGateEntryV2,
} from "../messages/telegram-revision-gate";
import {
  TSUNAMI_REVISION_FAMILY_POLICIES,
  tsunamiStateSubjectKey,
  VPWW56_REVISION_FAMILY_POLICY,
  VPWS50_REVISION_FAMILY_POLICY,
  FLOOD_FORECAST_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  TORNADO_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
} from "../messages/revision-family-registry";
import { weatherAlertsFromVpws50, weatherAlertsFromVpww56 } from "./weather-alert-view";
import { resolveTsunamiLevel } from "../../utils/tsunami-kind";
import {
  depthValueFromLegacyScalar,
  magnitudeValueFromLegacyScalar,
  normalizeNumericSpecialValueForPersistence,
  parsePersistedDepthSpecialValue,
  parsePersistedNumericSpecialValue,
} from "../magnitude-depth-persistence";
import {
  VPWW56_SNAPSHOT_GENERATION,
  Vpww56StateHolder,
  type PersistedVpww56StateV2,
} from "../messages/vpww56-state";
import type { PersistedVolcanoStateV2 } from "../messages/volcano-state";
import {
  VOLCANO_ALERT_REVISION_FAMILY_POLICY,
  VOLCANO_ERUPTION_REVISION_FAMILY_POLICY,
} from "../messages/revision-family-registry";
import {
  normalizeTyphoonNumericValueForPersistence,
  parsePersistedTyphoonNumericValue,
  typhoonNumericValueFromLegacyScalar,
} from "../typhoon-numeric-persistence";

const PERSIST_SCHEMA_VERSION = 2;

export interface PersistedHeatStateV1 {
  key: string;
  sourceEventIds: string[];
  targetDate: string;
  targetDateEndMs: number;
  areas: DisplayHeatAreaV1[];
  isSpecial: boolean;
  revision: StandbyRevision;
  appliedSemanticKey?: string;
}

export interface PersistedStandbyStateV1 {
  version: 1;
  savedAt: string;
  heat: PersistedHeatStateV1[];
  typhoons: PersistedTyphoonStateV1[];
  volcanoes: PersistedVolcanoStateV1[];
  floods?: PersistedFloodState;
  weatherAlerts?: PersistedWeatherAlertStateV1[];
  tornado?: PersistedTornadoStateV1[];
  longPeriod?: PersistedLongPeriodStateV1[];
  quakeHost?: PersistedQuakeHostStateV1 | null;
  nankaiTrough?: PersistedNankaiStateV1 | null;
  seen: PersistedSeenEntry[];
}

/** Phase 4B 単位 4 の v2 observation schema。旧 JSON の areaCode 欠落も許容する。 */
export type PersistedTsunamiObservationV2 = TsunamiObservationStation;

export interface PersistedTsunamiObservationGroupsV2 {
  VTSE51: PersistedTsunamiObservationV2[];
  VTSE52: PersistedTsunamiObservationV2[];
}

export type PersistedTsunamiActiveV2 = Omit<ParsedTsunamiInfo, "observations"> & {
  observations?: PersistedTsunamiObservationV2[];
};

export interface PersistedTelegramFoundationV2 {
  vpws50: {
    /** false は v1 adapter 由来で、表示 snapshot は旧 field を正とする。 */
    authoritative: boolean;
    state: PersistedVpws50StateV2 | null;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  vpww56: {
    /** writer は常に付与する。欠落は市町村等粒度へ切替える前の旧 foundation。 */
    generation?: typeof VPWW56_SNAPSHOT_GENERATION;
    /** false は v1 の union 表示だけを復元した状態で、subject watermark には採用しない。 */
    authoritative: boolean;
    state: PersistedVpww56StateV2 | null;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  tsunami: {
    /**
     * v2 scalar schema の migration input。writer は出力しない。読み込み時は
     * keyedActive または legacyActive へ一方向に移す。
     */
    active?: PersistedTsunamiActiveV2 | null;
    /** EventID ごとの keyed snapshot。各 forecast は EventID + Area.Code + Kind.Code で復元する。 */
    keyedActive?: PersistedTsunamiActiveV2[];
    /** 名称-only の旧 snapshot。表示専用で gate / 取消照合には使わない。 */
    legacyActive?: PersistedTsunamiActiveV2 | null;
    observations: PersistedTsunamiObservationGroupsV2;
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  volcano: {
    /** false は legacy 表示だけを復元し、watermark には採用しない。 */
    authoritative: boolean;
    state: PersistedVolcanoStateV2 | null;
    active: PersistedVolcanoStateV1[];
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  floodForecast: {
    /** false means only the legacy display snapshot was recovered. */
    authoritative: boolean;
    active: PersistedFloodEventState[];
    /** gate 未移行の v1 / pre-flood-v2 projection。各 EventID の正規受理か期限切れまで保全する。 */
    legacyEventIds?: string[];
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
  standbyDomains: {
    gateEntries: PersistedTelegramRevisionGateEntryV2[];
  };
}

export type PersistedTelegramFoundationInputV2 = Omit<
  PersistedTelegramFoundationV2,
  "tsunami" | "vpww56" | "volcano" | "floodForecast" | "standbyDomains"
> & {
  tsunami?: PersistedTelegramFoundationV2["tsunami"];
  vpww56?: PersistedTelegramFoundationV2["vpww56"];
  volcano?: PersistedTelegramFoundationV2["volcano"];
  floodForecast?: PersistedTelegramFoundationV2["floodForecast"];
  standbyDomains?: PersistedTelegramFoundationV2["standbyDomains"];
};

/**
 * v2 は新しい foundation state を正とし、v1 fields を rollback 互換として同じ
 * envelope に dual-write する。
 */
export interface PersistedStandbyStateV2 extends Omit<PersistedStandbyStateV1, "version"> {
  version: 2;
  telegramFoundation: PersistedTelegramFoundationV2;
}

export type PersistedStandbyState = PersistedStandbyStateV1 | PersistedStandbyStateV2;

export function standbyPersistenceV2Path(legacyPath: string): string {
  return legacyPath.endsWith("-v1.json")
    ? `${legacyPath.slice(0, -"-v1.json".length)}-v2.json`
    : `${legacyPath}.v2`;
}

function volcanoLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
  state: PersistedVolcanoStateV2 | null,
): PersistedSeenEntry[] {
  const activeEventIds = new Map<string, string | null>();
  for (const eruption of state?.eruptions ?? []) {
    const code = eruption.volcanoCode.trim();
    const eventId = eruption.eventId?.trim() || null;
    if (code === "" || eventId == null) continue;
    activeEventIds.set(code, activeEventIds.has(code) ? null : eventId);
  }
  return entries.flatMap((entry) => {
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    if (reportTimeMs == null) return [];
    const code = entry.stateSubjectKey.replace(/^volcano:(?:alert|eruption):/, "");
    const key = entry.legacyRevisionKey?.trim()
      || (entry.revisionFamily === "volcanoAlert"
        ? `volcano:alert:${code}`
        : `volcano:event:${activeEventIds.get(code) ?? code}`);
    const fallbackRetentionMs = entry.revisionFamily === "volcanoAlert"
      ? VOLCANO_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.tombstoneRetentionMs;
    const retentionMs = entry.tombstoneRetentionMs ?? fallbackRetentionMs;
    if (retentionMs == null) return [];
    return [{
      key,
      revision: {
        reportTimeMs,
        serial: entry.comparison.revision.serial.raw,
      },
      // gate は age > retention で落とす。旧 guard の forgetAt <= now と境界を揃える。
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

function floodLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedSeenEntry[] {
  return entries.flatMap((entry) => {
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    const eventId = entry.legacyRevisionKey?.trim();
    const retentionMs = entry.tombstoneRetentionMs
      ?? FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs;
    if (reportTimeMs == null || eventId == null || eventId === "" || retentionMs == null) return [];
    return [{
      key: eventId,
      revision: {
        reportTimeMs,
        serial: entry.comparison.revision.serial.raw,
      },
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

const STANDBY_FOUNDATION_POLICIES = [
  TORNADO_REVISION_FAMILY_POLICY,
  HEAT_ALERT_REVISION_FAMILY_POLICY,
  TYPHOON_ANALYSIS_REVISION_FAMILY_POLICY,
  NANKAI_REVISION_FAMILY_POLICY,
  LG_OBSERVATION_REVISION_FAMILY_POLICY,
] as const;

function standbyFoundationPolicy(entry: PersistedTelegramRevisionGateEntryV2) {
  return STANDBY_FOUNDATION_POLICIES.find((policy) =>
    policy.domain === entry.domain && policy.revisionFamily === entry.revisionFamily);
}

function standbyLegacySeenEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedSeenEntry[] {
  return entries.flatMap((entry) => {
    const policy = standbyFoundationPolicy(entry);
    const reportTimeMs = entry.comparison.revision.reportDateTime.epochMs;
    const retentionMs = entry.tombstoneRetentionMs ?? policy?.tombstoneRetentionMs;
    if (policy == null || reportTimeMs == null || retentionMs == null) return [];
    return [{
      key: entry.legacyRevisionKey?.trim() || entry.stateSubjectKey,
      revision: { reportTimeMs, serial: entry.comparison.revision.serial.raw },
      forgetAtMs: entry.acceptedAtMs + retentionMs + 1,
    }];
  });
}

function mergeLegacySeenEntries(
  existing: readonly PersistedSeenEntry[],
  added: readonly PersistedSeenEntry[],
): PersistedSeenEntry[] {
  const merged = new Map(existing.map((entry) => [entry.key, structuredClone(entry)]));
  for (const entry of added) {
    // foundation gate は厳密 metadata 検証済み。旧 guard が invalid/future
    // ReportDateTime を受信時刻へ昇格した untrusted seen より必ず優先する。
    merged.set(entry.key, structuredClone(entry));
  }
  return [...merged.values()];
}

export interface PersistedTyphoonStateV1 {
  key: string;
  sourceEventId: string;
  typhoon: DisplayTyphoonV1;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  pressureHpaValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  maxWindMsValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  maxGustMsValue?: SpecialValue<number>;
  /** Phase 5B canonical。旧 scalar-only snapshot では欠落する。 */
  moveSpeedKmhValue?: SpecialValue<number>;
  revision: StandbyRevision;
  expiresAtMs: number;
  appliedSemanticKey?: string;
}
export interface PersistedVolcanoStateV1 {
  code: string;
  name: string;
  alertLevel: number | null;
  alertClass?: DisplayVolcanoAlertClassV1 | null;
  warningKind?: string | null;
  targetKinds?: string[];
  alertExpiresAtMs: number | null;
  /** string は構造化前の v1 保存状態との互換専用。新規保存は DisplayVolcanoEventV1。 */
  latestEvent?: DisplayVolcanoEventV1 | string | null;
  /** 空コードの取消を EventID で直近噴火へ結び直すための逆引き。 */
  latestEventId?: string | null;
  eventExpiresAtMs: number | null;
  sourceEventIds: string[];
  alertRevision: StandbyRevision | null;
  eventRevision: StandbyRevision | null;
}
export interface PersistedTornadoStateV1 { publishingOffice: string; sourceEventId: string; areas: string[]; isSighted: boolean; revision: StandbyRevision; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedLongPeriodStateV1 { eventId: string; maxLgInt: string; safetyRank?: number | null; revision: StandbyRevision; hosted: boolean; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedQuakeHostStateV1 { eventId: string; maxIntRank: number; revision: StandbyRevision; expiresAtMs: number; }
export interface PersistedNankaiStateV1 { sourceEventId: string; statusCode: string; label: string; revision: StandbyRevision; expiresAtMs: number; appliedSemanticKey?: string; }
export interface PersistedWeatherAlertStateV1 { source: DisplayWeatherSourceV1; alerts: DisplayWeatherAlertV1[]; revision: StandbyRevision; expiresAtMs: number; }

/**
 * schedule() が実際に書き込むまでの遅延。
 * 電文が連続する場面で同期 I/O を毎報走らせず、最新状態だけを 1 回書くための窓。
 * 失うのは強制電源断の直前この秒数ぶんで、正常終了時は flush() が書き切る。
 */
const SAVE_DEBOUNCE_MS = 3000;

interface PersistedReadResult {
  state: PersistedStandbyStateV2 | null;
  migrationConflict: boolean;
}

export class StandbyPersistence {
  private pending: { state: PersistedStandbyStateV2; seq: number } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private writing = false;
  /** 内容を確定した順の通し番号。書き込み完了の順序が入れ替わっても最新が勝つようにする */
  private seq = 0;
  /** 実際に rename まで到達した最大 seq。これより古い書き込みは rename せずに捨てる */
  private renamedSeq = 0;
  private migrationConflictCount = 0;

  constructor(
    private readonly persistPath: string,
    private readonly debounceMs: number = SAVE_DEBOUNCE_MS,
    private readonly foundationProvider: (() => PersistedTelegramFoundationInputV2) | null = null,
  ) {}

  load(): PersistedStandbyStateV2 | null {
    this.cleanStaleTmpFiles();
    const v2Path = standbyPersistenceV2Path(this.persistPath);
    const v2 = this.readPath(v2Path, false);
    if (v2.state != null) {
      // rollback 用 standalone v1 も必ず検査する。v2 を正として採用する方針は変えず、
      // rename 間の停止・旧 binary 運用・v1 欠損を telemetry へ出す。
      const standaloneV1 = this.readPath(this.persistPath, true);
      const standaloneConflict = standaloneV1.state == null
        || JSON.stringify(this.toV1(v2.state)) !== JSON.stringify(this.toV1(standaloneV1.state));
      if (v2.migrationConflict || standaloneV1.migrationConflict || standaloneConflict) {
        this.recordMigrationConflict("telegram foundation persistence sources conflict; canonical v2 is authoritative");
      }
      return v2.state;
    }
    // Phase 3B 導入途中に同じ path へ書かれた v2 も読み取れるようにしつつ、
    // 現行 writer は旧 reader 用の version:1 と新 schema を別ファイルへ dual-write する。
    const fallback = this.readPath(this.persistPath, true);
    if (fallback.migrationConflict) {
      this.recordMigrationConflict("telegram foundation envelope fields differ; new schema is authoritative");
    }
    if (fallback.state == null || fallback.state.telegramFoundation.vpww56.authoritative) {
      return fallback.state;
    }
    return {
      ...fallback.state,
      weatherAlerts: fallback.state.weatherAlerts?.filter((entry) => entry.source !== "vpww56"),
    };
  }

  save(state: PersistedStandbyState): void {
    this.writeSync(this.toV2(state), ++this.seq);
  }

  /**
   * 最新状態の保存を予約する。debounceMs 後に 1 回だけ非同期で書く。
   * 予約中に再度呼ばれた場合は最新状態で上書きし、書き込み回数は増やさない。
   */
  schedule(state: PersistedStandbyState): void {
    // seq は「内容を確定した時点」で採る。書き込み開始時に採ると、予約 → 同期保存の順で
    // 呼ばれたとき古い内容の方が大きい seq を持ってしまい、順序保証が逆転する
    this.pending = { state: this.toV2(state), seq: ++this.seq };
    this.armTimer();
  }

  /**
   * 予約済みの状態を同期で書き切る。シャットダウン経路から呼ぶ。
   * 予約がなければ何もしない (既存ファイルを空書きしない)。
   */
  flush(): void {
    this.clearTimer();
    const pending = this.pending;
    this.pending = null;
    if (pending == null) return;
    this.writeSync(pending.state, pending.seq);
  }

  /** 予約を捨てる (テスト・再初期化用。ディスク上の内容は触らない) */
  dispose(): void {
    this.clearTimer();
    this.pending = null;
  }

  takeMigrationConflictCount(): number {
    const count = this.migrationConflictCount;
    this.migrationConflictCount = 0;
    return count;
  }

  private recordMigrationConflict(detail: string): void {
    this.migrationConflictCount++;
    log.warn(`[standby-persistence] persistenceMigrationConflict: ${detail}`);
  }

  private toV2(state: PersistedStandbyState): PersistedStandbyStateV2 {
    const foundation = this.foundationProvider?.()
      ?? (state.version === 2 ? state.telegramFoundation : emptyTelegramFoundation());
    const tsunami = normalizeTsunamiFoundationForWrite(
      foundation.tsunami ?? emptyTsunamiFoundation(),
    );
    const vpww56 = normalizeVpww56FoundationForWrite(
      foundation.vpww56 ?? emptyVpww56Foundation(),
    );
    const volcano = normalizeVolcanoFoundationForWrite(
      foundation.volcano ?? emptyVolcanoFoundation(),
    );
    const floodForecast = normalizeFloodFoundationForWrite(
      foundation.floodForecast ?? emptyFloodFoundation(),
    );
    const standbyDomains = normalizeStandbyDomainsFoundationForWrite(
      foundation.standbyDomains ?? emptyStandbyDomainsFoundation(),
    );
    const typhoons = normalizeTyphoonStatesForWrite(state.typhoons);
    const projectionState = salvageStandbyDomainProjections(
      { ...state, version: 1, typhoons },
      standbyDomains,
    );
    const seen = mergeLegacySeenEntries(
      projectionState.seen,
      volcanoLegacySeenEntries(volcano.gateEntries, volcano.state),
    );
    const rollbackSeen = mergeLegacySeenEntries(seen, standbyLegacySeenEntries(standbyDomains.gateEntries));
    return {
      ...projectionState,
      version: 2,
      seen: rollbackSeen,
      floods: floodForecast.authoritative
        ? {
            events: structuredClone(floodForecast.active),
            seen: floodLegacySeenEntries(floodForecast.gateEntries),
          }
        : state.floods,
      telegramFoundation: structuredClone({
        ...foundation,
        vpww56,
        tsunami,
        volcano,
        floodForecast,
        standbyDomains,
      }),
    };
  }

  private toV1(state: PersistedStandbyStateV2): PersistedStandbyStateV1 {
    const { telegramFoundation: _foundation, version: _version, ...legacy } = state;
    return {
      ...legacy,
      version: 1,
      seen: mergeLegacySeenEntries(
        mergeLegacySeenEntries(
          legacy.seen,
          volcanoLegacySeenEntries(
            state.telegramFoundation.volcano.gateEntries,
            state.telegramFoundation.volcano.state,
          ),
        ),
        standbyLegacySeenEntries(state.telegramFoundation.standbyDomains.gateEntries),
      ),
      floods: state.telegramFoundation.floodForecast.authoritative
        ? {
            events: structuredClone(state.telegramFoundation.floodForecast.active),
            seen: floodLegacySeenEntries(state.telegramFoundation.floodForecast.gateEntries),
          }
        : legacy.floods,
    };
  }

  private readPath(filePath: string, allowV1: boolean): PersistedReadResult {
    if (!fs.existsSync(filePath)) return { state: null, migrationConflict: false };
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const version = isRecord(parsed) ? parsed.version : undefined;
      const sanitized = version === PERSIST_SCHEMA_VERSION
        ? sanitizePersistedStandbyStateV2(parsed)
        : allowV1 && version === 1
          ? migratePersistedStandbyStateV1(parsed)
          : null;
      if (sanitized == null) {
        log.warn(`[standby-persistence] top-level structure validation 失敗 — 破棄 (${path.basename(filePath)})`);
      }
      return {
        state: sanitized,
        migrationConflict: sanitized != null
          && version === PERSIST_SCHEMA_VERSION
          && hasFoundationMigrationConflict(parsed, sanitized),
      };
    } catch (err) {
      log.warn(`[standby-persistence] load 失敗 (${path.basename(filePath)}): ${err instanceof Error ? err.message : String(err)}`);
      return { state: null, migrationConflict: false };
    }
  }

  /**
   * rename 前に強制終了すると seq 固有名の tmp が残る (Pi は電源断が起こりうる)。
   * 起動時の load で同ディレクトリの残骸を掃除する。掃除の失敗は起動を妨げない。
   */
  private cleanStaleTmpFiles(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) return;
      const bases = [this.persistPath, standbyPersistenceV2Path(this.persistPath)].map((item) => path.basename(item));
      for (const name of fs.readdirSync(dir)) {
        if (bases.some((base) => name.startsWith(`${base}.`) && name.endsWith(".tmp"))) {
          fs.rmSync(path.join(dir, name), { force: true });
        }
      }
    } catch (err) {
      log.debug(`[standby-persistence] 残留 tmp の掃除に失敗: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** tmp 名は書き込みごとに一意にする (同期・非同期が同じ tmp を奪い合わないため) */
  private tmpPathFor(filePath: string, seq: number): string {
    return `${filePath}.${seq}.tmp`;
  }

  private writeSync(state: PersistedStandbyStateV2, seq: number): void {
    const v2Path = standbyPersistenceV2Path(this.persistPath);
    const v2TmpPath = this.tmpPathFor(v2Path, seq);
    const v1TmpPath = this.tmpPathFor(this.persistPath, seq);
    try {
      fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
      fs.writeFileSync(v2TmpPath, JSON.stringify(state), "utf8");
      fs.writeFileSync(v1TmpPath, JSON.stringify(this.toV1(state)), "utf8");
      if (seq < this.renamedSeq) {
        // 既により新しい内容が置かれている。追い越された書き込みは反映しない
        fs.rmSync(v2TmpPath, { force: true });
        fs.rmSync(v1TmpPath, { force: true });
        return;
      }
      fs.renameSync(v2TmpPath, v2Path);
      fs.renameSync(v1TmpPath, this.persistPath);
      this.renamedSeq = seq;
    } catch (err) {
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      for (const tmpPath of [v2TmpPath, v1TmpPath]) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
      }
    }
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
    const v2Path = standbyPersistenceV2Path(this.persistPath);
    const v2TmpPath = this.tmpPathFor(v2Path, pending.seq);
    const v1TmpPath = this.tmpPathFor(this.persistPath, pending.seq);
    try {
      await fs.promises.mkdir(path.dirname(this.persistPath), { recursive: true });
      await fs.promises.writeFile(v2TmpPath, JSON.stringify(pending.state), "utf8");
      await fs.promises.writeFile(v1TmpPath, JSON.stringify(this.toV1(pending.state)), "utf8");
      // ここから rename までは await を挟まない。await で中断すると、guard 通過後・rename 完了前に
      // 同期保存が割り込み、そのあと古い rename が完了して旧内容で上書き + renamedSeq 逆行が起きる
      if (pending.seq < this.renamedSeq) {
        fs.rmSync(v2TmpPath, { force: true });
        fs.rmSync(v1TmpPath, { force: true });
        return;
      }
      fs.renameSync(v2TmpPath, v2Path);
      fs.renameSync(v1TmpPath, this.persistPath);
      this.renamedSeq = pending.seq;
    } catch (err) {
      log.warn(`[standby-persistence] save 失敗: ${err instanceof Error ? err.message : String(err)}`);
      for (const tmpPath of [v2TmpPath, v1TmpPath]) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* 後始末の失敗は無視 */ }
      }
    } finally {
      this.writing = false;
      // 書き込み中に届いた更新は、終わってからもう一度だけ書く
      if (this.pending != null) this.armTimer();
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isRevision(value: unknown): value is StandbyRevision {
  if (!isRecord(value)) return false;
  return typeof value.reportTimeMs === "number" && Number.isFinite(value.reportTimeMs)
    && (value.serial == null || typeof value.serial === "string");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isHeatAreaArray(value: unknown): value is DisplayHeatAreaV1[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.areaName === "string" && typeof item.isSpecial === "boolean",
  );
}

function isHeatState(value: unknown): value is PersistedHeatStateV1 {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isStringArray(value.sourceEventIds)
    && typeof value.targetDate === "string"
    && typeof value.targetDateEndMs === "number"
    && Number.isFinite(value.targetDateEndMs)
    && isHeatAreaArray(value.areas)
    && typeof value.isSpecial === "boolean"
    && isRevision(value.revision);
}

function isSeenEntry(value: unknown): value is PersistedSeenEntry {
  if (!isRecord(value)) return false;
  return typeof value.key === "string"
    && isRevision(value.revision)
    && typeof value.forgetAtMs === "number"
    && Number.isFinite(value.forgetAtMs);
}

function isFloodTrend(value: unknown): value is DisplayFloodStationV1["trend"] {
  return value == null || value === "rising" || value === "falling" || value === "steady";
}

function isFloodHydrograph(value: unknown): value is DisplayFloodHydrographV1 {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.points) || value.points.length === 0) return false;
  const pointsWellFormed = value.points.every((point, i) => isRecord(point)
    && typeof point.dateTime === "string"
    && isNullableFiniteNumber(point.valueM)
    // phase 不変条件: 先頭 (i===0) は現況 observed、以降はすべて予測 forecast。
    // 描画側は phase を読まず先頭=現況/残り=予測として扱うため、逆順の壊れた永続データは破棄する
    && point.phase === (i === 0 ? "observed" : "forecast"));
  if (!pointsWellFormed) return false;
  // 有効値が 1 点も無い hydrograph は描画不能なので破棄 (project-flood.ts の生成条件と同じ)
  if (!value.points.some((point) => isRecord(point) && point.valueM != null)) return false;
  return isNullableFiniteNumber(value.dangerLevelM);
}

function isFloodStation(value: unknown): value is DisplayFloodStationV1 {
  if (!isRecord(value)) return false;
  return typeof value.name === "string"
    && isNullableFiniteNumber(value.levelM)
    && isFloodTrend(value.trend)
    && isNullableString(value.thresholdLabel)
    && (!Object.hasOwn(value, "hydrograph") || value.hydrograph == null || isFloodHydrograph(value.hydrograph));
}

function isFloodRiver(value: unknown): value is DisplayFloodRiverV1 {
  if (!isRecord(value)) return false;
  return typeof value.riverKey === "string"
    && typeof value.riverName === "string"
    && typeof value.level === "string"
    && typeof value.levelRank === "number"
    && Number.isFinite(value.levelRank)
    && typeof value.kindName === "string"
    && typeof value.reportDateTime === "string"
    && (!Object.hasOwn(value, "station") || value.station == null || isFloodStation(value.station));
}

function isFloodEvent(value: unknown): value is PersistedFloodState["events"][number] {
  return isRecord(value)
    && typeof value.eventId === "string"
    && isRevision(value.revision)
    && (!Object.hasOwn(value, "appliedRevision") || isRevision(value.appliedRevision))
    && (!Object.hasOwn(value, "appliedSemanticKey") || typeof value.appliedSemanticKey === "string")
    && Array.isArray(value.rivers)
    && value.rivers.every(isFloodRiver)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeFloodState(value: unknown): PersistedFloodState | undefined {
  if (!isRecord(value) || !Array.isArray(value.events) || !Array.isArray(value.seen)) return undefined;
  const events = value.events.filter(isFloodEvent);
  const validEventIds = new Set(events.map((event) => event.eventId));
  const discardedEventIds = new Set<string>();
  for (const event of value.events) {
    if (isRecord(event) && typeof event.eventId === "string" && !validEventIds.has(event.eventId)) {
      discardedEventIds.add(event.eventId);
    }
  }
  const seen = value.seen.filter(
    (entry): entry is PersistedSeenEntry => isSeenEntry(entry) && !discardedEventIds.has(entry.key),
  );
  if (value.events.length > 0 && events.length === 0 && seen.length === 0) return undefined;
  if (events.length !== value.events.length || seen.length !== value.seen.length) {
    log.warn("[standby-persistence] floods の壊れた EventID/seen entry だけを破棄");
  }
  return { events, seen };
}

function isNullableString(value: unknown): value is string | null {
  return value == null || typeof value === "string";
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value == null || typeof value === "number" && Number.isFinite(value);
}

function hasNullableString(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableString(value[key]);
}

function hasNullableFiniteNumber(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key) && isNullableFiniteNumber(value[key]);
}

function isTyphoon(value: unknown): value is DisplayTyphoonV1 {
  if (!isRecord(value)) return false;
  return typeof value.typhoonKey === "string"
    && hasNullableString(value, "name")
    && hasNullableString(value, "nameKana")
    && hasNullableString(value, "remark")
    && hasNullableString(value, "typhoonNumber")
    && hasNullableString(value, "category")
    && hasNullableString(value, "location")
    && hasNullableFiniteNumber(value, "pressureHpa")
    && (!Object.hasOwn(value, "pressureDeltaHpa") || isNullableFiniteNumber(value.pressureDeltaHpa))
    && hasNullableFiniteNumber(value, "maxWindMs")
    && (!Object.hasOwn(value, "maxGustMs") || isNullableFiniteNumber(value.maxGustMs))
    && (!Object.hasOwn(value, "maxWindDeltaMs") || isNullableFiniteNumber(value.maxWindDeltaMs))
    && (!Object.hasOwn(value, "intensityTrend")
      || value.intensityTrend == null
      || value.intensityTrend === "developing"
      || value.intensityTrend === "weakening"
      || value.intensityTrend === "steady")
    && hasNullableString(value, "moveDirection")
    && hasNullableFiniteNumber(value, "moveSpeedKmh")
    && typeof value.reportDateTime === "string";
}

function sanitizeTyphoonState(value: unknown): PersistedTyphoonStateV1 | null {
  if (
    !isRecord(value)
    || typeof value.key !== "string"
    || typeof value.sourceEventId !== "string"
    || !isTyphoon(value.typhoon)
    || !isRevision(value.revision)
    || typeof value.expiresAtMs !== "number"
    || !Number.isFinite(value.expiresAtMs)
    || Object.hasOwn(value, "appliedSemanticKey")
      && typeof value.appliedSemanticKey !== "string"
  ) return null;
  const parseOrMigrate = (
    key: "pressureHpaValue" | "maxWindMsValue" | "maxGustMsValue" | "moveSpeedKmhValue",
    scalar: number | null,
  ): SpecialValue<number> | null => Object.hasOwn(value, key)
    ? parsePersistedTyphoonNumericValue(value[key])
    : typhoonNumericValueFromLegacyScalar(scalar);
  const pressureHpaValue = parseOrMigrate("pressureHpaValue", value.typhoon.pressureHpa);
  const maxWindMsValue = parseOrMigrate("maxWindMsValue", value.typhoon.maxWindMs);
  const maxGustMsValue = parseOrMigrate("maxGustMsValue", value.typhoon.maxGustMs ?? null);
  const moveSpeedKmhValue = parseOrMigrate("moveSpeedKmhValue", value.typhoon.moveSpeedKmh);
  if (
    pressureHpaValue == null
    || maxWindMsValue == null
    || maxGustMsValue == null
    || moveSpeedKmhValue == null
  ) return null;
  return {
    key: value.key,
    sourceEventId: value.sourceEventId,
    typhoon: structuredClone(value.typhoon),
    pressureHpaValue,
    maxWindMsValue,
    maxGustMsValue,
    moveSpeedKmhValue,
    revision: { ...value.revision },
    expiresAtMs: value.expiresAtMs,
    ...(typeof value.appliedSemanticKey === "string"
      ? { appliedSemanticKey: value.appliedSemanticKey }
      : {}),
  };
}

function sanitizeTyphoonStates(value: unknown): PersistedTyphoonStateV1[] {
  if (!Array.isArray(value)) {
    log.warn("[standby-persistence] typhoons structure validation 失敗 — domain 破棄");
    return [];
  }
  const states = value.map(sanitizeTyphoonState);
  if (states.some((state) => state == null)) {
    log.warn("[standby-persistence] typhoons structure validation 失敗 — domain 破棄");
    return [];
  }
  return states as PersistedTyphoonStateV1[];
}

function normalizeTyphoonStatesForWrite(
  states: readonly PersistedTyphoonStateV1[],
): PersistedTyphoonStateV1[] {
  return states.map((state) => {
    const normalized = sanitizeTyphoonState(state);
    if (normalized == null) throw new Error("invalid persisted typhoon state");
    return {
      ...normalized,
      pressureHpaValue: normalizeTyphoonNumericValueForPersistence(normalized.pressureHpaValue!),
      maxWindMsValue: normalizeTyphoonNumericValueForPersistence(normalized.maxWindMsValue!),
      maxGustMsValue: normalizeTyphoonNumericValueForPersistence(normalized.maxGustMsValue!),
      moveSpeedKmhValue: normalizeTyphoonNumericValueForPersistence(normalized.moveSpeedKmhValue!),
    };
  });
}

function isVolcanoState(value: unknown): value is PersistedVolcanoStateV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && hasNullableFiniteNumber(value, "alertLevel")
    && (!Object.hasOwn(value, "alertClass")
      || value.alertClass == null
      || isVolcanoAlertClass(value.alertClass))
    && (!Object.hasOwn(value, "warningKind") || hasNullableString(value, "warningKind"))
    && (!Object.hasOwn(value, "targetKinds") || isStringArray(value.targetKinds))
    && hasNullableFiniteNumber(value, "alertExpiresAtMs")
    && (!Object.hasOwn(value, "latestEvent")
      || value.latestEvent == null
      || typeof value.latestEvent === "string"
      || isVolcanoEvent(value.latestEvent))
    && (!Object.hasOwn(value, "latestEventId") || hasNullableString(value, "latestEventId"))
    && hasNullableFiniteNumber(value, "eventExpiresAtMs")
    && isStringArray(value.sourceEventIds)
    && Object.hasOwn(value, "alertRevision") && (value.alertRevision == null || isRevision(value.alertRevision))
    && Object.hasOwn(value, "eventRevision") && (value.eventRevision == null || isRevision(value.eventRevision));
}

function isVolcanoAlertClass(value: unknown): value is DisplayVolcanoAlertClassV1 {
  return isRecord(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && (value.severity === "warning" || value.severity === "info")
    && typeof value.isActive === "boolean";
}

function isVolcanoEvent(value: unknown): value is DisplayVolcanoEventV1 {
  return isRecord(value)
    && typeof value.label === "string"
    && hasNullableString(value, "craterName")
    && hasNullableString(value, "eventDateTime")
    && hasNullableFiniteNumber(value, "plumeHeightM")
    && typeof value.plumeHeightUnknown === "boolean"
    && hasNullableString(value, "plumeDirection");
}

function migrateVolcanoEventForRead(
  event: DisplayVolcanoEventV1 | string | null | undefined,
): DisplayVolcanoEventV1 | string | null | undefined {
  if (event == null || typeof event === "string") return event;
  const migrated = legacyDisplayPlumeHeightSemantics(
    event.plumeHeightM,
    event.plumeHeightUnknown,
  );
  const rawEvent = event as unknown as Record<string, unknown>;
  const craterSemantic = isDisplayPlumeHeightSemantic(
    rawEvent.plumeHeightAboveCraterSemantic,
    "aboveCrater",
    "m",
  )
    ? rawEvent.plumeHeightAboveCraterSemantic
    : migrated.plumeHeightAboveCraterSemantic;
  const seaLevelSemantic = isDisplayPlumeHeightSemantic(
    rawEvent.plumeHeightAboveSeaLevelSemantic,
    "aboveSeaLevel",
    "FT",
  )
    ? rawEvent.plumeHeightAboveSeaLevelSemantic
    : migrated.plumeHeightAboveSeaLevelSemantic;
  return {
    ...event,
    plumeHeightAboveCraterSemantic: copyDisplayPlumeHeightSemantic(
      craterSemantic,
    ),
    plumeHeightAboveSeaLevelSemantic: copyDisplayPlumeHeightSemantic(
      seaLevelSemantic,
    ),
  };
}

function migrateVolcanoStateForRead(
  state: PersistedVolcanoStateV1,
): PersistedVolcanoStateV1 {
  return {
    ...structuredClone(state),
    latestEvent: migrateVolcanoEventForRead(state.latestEvent),
  };
}

function sanitizeVolcanoStates(value: unknown): PersistedVolcanoStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every(isVolcanoState)) {
    log.warn("[standby-persistence] volcanoes structure validation 失敗 — domain 破棄");
    return [];
  }
  return (value as PersistedVolcanoStateV1[]).map(migrateVolcanoStateForRead);
}

function isTornadoState(value: unknown): value is PersistedTornadoStateV1 {
  return isRecord(value)
    && typeof value.publishingOffice === "string"
    && typeof value.sourceEventId === "string"
    && isStringArray(value.areas)
    && typeof value.isSighted === "boolean"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isLongPeriodState(value: unknown): value is PersistedLongPeriodStateV1 {
  const hasSafetyRank = isRecord(value) && Object.hasOwn(value, "safetyRank");
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxLgInt === "string"
    && (!hasSafetyRank
      || value.safetyRank == null
      || typeof value.safetyRank === "number" && Number.isInteger(value.safetyRank)
        && value.safetyRank >= 0 && value.safetyRank <= 4)
    && (!hasSafetyRank || isLongPeriodSafetyRankConsistent(value.maxLgInt, value.safetyRank))
    && isRevision(value.revision)
    && typeof value.hosted === "boolean"
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function inferredLongPeriodSafetyRank(label: string): number | null | undefined {
  const normalized = label.normalize("NFKC").trim();
  const exact = /^([0-4])$/.exec(normalized);
  if (exact != null) return Number(exact[1]);
  const range = /^([0-4])\u301c([0-4])$/.exec(normalized);
  if (range != null) return Number(range[2]);
  const lower = /^([0-4])(?:程度)?以上$/.exec(normalized);
  if (lower != null) return Number(lower[1]);
  if (normalized === "不明" || normalized === "（空欄）" || normalized === "—") return null;
  return undefined;
}

function isLongPeriodSafetyRankConsistent(label: string, rank: unknown): boolean {
  const inferred = inferredLongPeriodSafetyRank(label);
  return inferred === undefined || Object.is(inferred, rank);
}

export function persistedLongPeriodSafetyRank(
  state: PersistedLongPeriodStateV1,
): number | null {
  if (Object.hasOwn(state, "safetyRank")) return state.safetyRank ?? null;
  return inferredLongPeriodSafetyRank(state.maxLgInt) ?? null;
}

function isQuakeHostState(value: unknown): value is PersistedQuakeHostStateV1 {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.maxIntRank === "number" && Number.isFinite(value.maxIntRank)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isNankaiState(value: unknown): value is PersistedNankaiStateV1 {
  return isRecord(value)
    && typeof value.sourceEventId === "string"
    && typeof value.statusCode === "string"
    && typeof value.label === "string"
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number" && Number.isFinite(value.expiresAtMs);
}

function isWeatherAlertItem(value: unknown): value is DisplayWeatherAlertItemV1 {
  return isRecord(value)
    && typeof value.kind === "string"
    && (!Object.hasOwn(value, "phenomenonKey") || typeof value.phenomenonKey === "string")
    && typeof value.displaySeverity === "string"
    && (value.rank === "emergency" || value.rank === "warning" || value.rank === "advisory")
    && isStringArray(value.shownAreas)
    && typeof value.omittedAreaCount === "number"
    && Number.isSafeInteger(value.omittedAreaCount)
    && value.omittedAreaCount >= 0;
}

function isWeatherAlert(value: unknown): value is DisplayWeatherAlertV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && typeof value.label === "string"
    && (value.role === "weatherEmergency" || value.role === "weatherWarning" || value.role === "weatherAdvisory")
    && typeof value.totalAreas === "number"
    && Number.isSafeInteger(value.totalAreas)
    && value.totalAreas >= 0
    && Array.isArray(value.items)
    && value.items.every(isWeatherAlertItem)
    && typeof value.updatedAt === "string"
    && Number.isFinite(Date.parse(value.updatedAt));
}

function isWeatherAlertState(value: unknown): value is PersistedWeatherAlertStateV1 {
  return isRecord(value)
    && (value.source === "vpws50" || value.source === "vpww56")
    && Array.isArray(value.alerts)
    && value.alerts.length > 0
    && value.alerts.every((alert) => isWeatherAlert(alert) && alert.source === value.source)
    && isRevision(value.revision)
    && typeof value.expiresAtMs === "number"
    && Number.isFinite(value.expiresAtMs);
}

function sanitizeWeatherAlertStates(value: unknown): PersistedWeatherAlertStateV1[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    log.warn("[standby-persistence] weatherAlerts structure validation 失敗 — domain 破棄");
    return [];
  }
  const states = value.filter(isWeatherAlertState);
  if (states.length !== value.length) {
    log.warn("[standby-persistence] weatherAlerts の壊れた source だけを破棄");
  }
  return states;
}

function validDomainArray<T>(value: unknown, predicate: (entry: unknown) => entry is T, domain: string): T[] {
  if (value == null) return [];
  if (Array.isArray(value) && value.every(predicate)) return value;
  log.warn(`[standby-persistence] ${domain} structure validation 失敗 — domain 破棄`);
  return [];
}

function sanitizePersistedStandbyStateV1(value: unknown): PersistedStandbyStateV1 | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.savedAt !== "string") return null;
  const floods = value.floods == null ? undefined : sanitizeFloodState(value.floods);
  if (value.floods != null && floods == null) log.warn("[standby-persistence] floods structure validation 失敗 — domain 破棄");
  const nankaiTrough = value.nankaiTrough == null || isNankaiState(value.nankaiTrough) ? value.nankaiTrough : null;
  if (value.nankaiTrough != null && nankaiTrough == null) log.warn("[standby-persistence] nankaiTrough structure validation 失敗 — domain 破棄");
  const quakeHost = value.quakeHost == null || isQuakeHostState(value.quakeHost) ? value.quakeHost : null;
  if (value.quakeHost != null && quakeHost == null) log.warn("[standby-persistence] quakeHost structure validation 失敗 — domain 破棄");
  return {
    version: 1,
    savedAt: value.savedAt,
    heat: validDomainArray(value.heat, isHeatState, "heat"),
    typhoons: sanitizeTyphoonStates(value.typhoons),
    volcanoes: sanitizeVolcanoStates(value.volcanoes),
    floods,
    weatherAlerts: sanitizeWeatherAlertStates(value.weatherAlerts),
    tornado: validDomainArray(value.tornado, isTornadoState, "tornado"),
    longPeriod: validDomainArray(value.longPeriod, isLongPeriodState, "longPeriod"),
    quakeHost,
    nankaiTrough,
    seen: validDomainArray(value.seen, isSeenEntry, "seen"),
  };
}

function emptyTsunamiFoundation(): PersistedTelegramFoundationV2["tsunami"] {
  return {
    active: null,
    keyedActive: [],
    legacyActive: null,
    observations: { VTSE51: [], VTSE52: [] },
    gateEntries: [],
  };
}

function emptyVpws50Foundation(): PersistedTelegramFoundationV2["vpws50"] {
  return { authoritative: true, state: null, gateEntries: [] };
}

function emptyVpww56Foundation(): PersistedTelegramFoundationV2["vpww56"] {
  // field 欠落・v1 adapter・domain salvage は官署別 subject を再構成できないため非 authoritative。
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: false,
    state: null,
    gateEntries: [],
  };
}

function emptyTelegramFoundation(): PersistedTelegramFoundationV2 {
  return {
    vpws50: emptyVpws50Foundation(),
    vpww56: emptyVpww56Foundation(),
    tsunami: emptyTsunamiFoundation(),
    volcano: emptyVolcanoFoundation(),
    floodForecast: emptyFloodFoundation(),
    standbyDomains: emptyStandbyDomainsFoundation(),
  };
}

function emptyStandbyDomainsFoundation(): PersistedTelegramFoundationV2["standbyDomains"] {
  return { gateEntries: [] };
}

function standbySubjectMatchesPolicy(
  entry: PersistedTelegramRevisionGateEntryV2,
): boolean {
  if (entry.domain === "tornado" && entry.revisionFamily === "tornado") {
    return entry.stateSubjectKey.startsWith("tornado:");
  }
  if (entry.domain === "heatAlert" && entry.revisionFamily === "VPFT50") {
    return entry.stateSubjectKey.startsWith("heat:");
  }
  if (entry.domain === "typhoonAnalysis" && entry.revisionFamily === "typhoonAnalysis") {
    return entry.stateSubjectKey.startsWith("typhoon:");
  }
  if (entry.domain === "nankaiTrough" && entry.revisionFamily === "nankaiTrough") {
    return entry.stateSubjectKey === "nankai:current";
  }
  if (entry.domain === "lgObservation" && entry.revisionFamily === "VXSE62") {
    return entry.stateSubjectKey.startsWith("longPeriod:");
  }
  return false;
}

function normalizeStandbyDomainsFoundationForWrite(
  value: PersistedTelegramFoundationV2["standbyDomains"],
): PersistedTelegramFoundationV2["standbyDomains"] {
  const perFamily = new Map<string, PersistedTelegramRevisionGateEntryV2[]>();
  for (const entry of value.gateEntries) {
    const policy = standbyFoundationPolicy(entry);
    if (policy == null || !standbySubjectMatchesPolicy(entry)) continue;
    const key = `${entry.domain}:${entry.revisionFamily}`;
    const entries = perFamily.get(key) ?? [];
    entries.push({
      ...structuredClone(entry),
      tombstoneRetentionMs: entry.tombstoneRetentionMs ?? policy.tombstoneRetentionMs,
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    });
    perFamily.set(key, entries);
  }
  return {
    gateEntries: [...perFamily.values()].flatMap((entries) => {
      const policy = standbyFoundationPolicy(entries[0]);
      return entries.slice(-(policy?.maxSubjects ?? TELEGRAM_REVISION_MAX_ENTRIES));
    }),
  };
}

function sanitizeStandbyDomainsFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["standbyDomains"] | null {
  if (!isRecord(value) || !Array.isArray(value.gateEntries)) return null;
  const gateEntries = value.gateEntries.flatMap((candidate) => {
    if (!isGateEntry(candidate)) return [];
    const entry = candidate as PersistedTelegramRevisionGateEntryV2;
    const policy = standbyFoundationPolicy(entry);
    if (policy == null || !standbySubjectMatchesPolicy(entry)) return [];
    return [{
      ...structuredClone(entry),
      tombstoneRetentionMs: entry.tombstoneRetentionMs ?? policy.tombstoneRetentionMs,
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }];
  });
  return normalizeStandbyDomainsFoundationForWrite({ gateEntries });
}

function emptyVolcanoFoundation(): PersistedTelegramFoundationV2["volcano"] {
  return { authoritative: false, state: null, active: [], gateEntries: [] };
}

function emptyFloodFoundation(): PersistedTelegramFoundationV2["floodForecast"] {
  return { authoritative: false, active: [], gateEntries: [] };
}

function isWeatherIdentity(value: unknown, receivedAtMs = Number.MAX_SAFE_INTEGER): boolean {
  if (!isRecord(value) || typeof value.reportDateTime !== "string") return false;
  if (!parseStrictReportDateTime(value.reportDateTime, receivedAtMs).valid) return false;
  if (value.serial == null || value.serial === "") return true;
  return typeof value.serial === "string" && parseTelegramSerial(value.serial).valid;
}

function isVpws50Kind(value: unknown): boolean {
  return isRecord(value)
    && typeof value.phenomenonKey === "string"
    && typeof value.kindCode === "string"
    && typeof value.kindName === "string"
    && (value.severity === "specialWarning" || value.severity === "warning" || value.severity === "advisory" || value.severity === "release" || value.severity === "unknown")
    && (value.displaySeverity === "release" || value.displaySeverity === "officialL1"
      || value.displaySeverity === "officialL2"
      || value.displaySeverity === "officialL3" || value.displaySeverity === "officialL4"
      || value.displaySeverity === "officialL5" || value.displaySeverity === "nonLevelWarning"
      || value.displaySeverity === "nonLevelAdvisory"
      || value.displaySeverity === "nonLevelSpecial" || value.displaySeverity === "unknown")
    && (value.officialAlertLevel == null || value.officialAlertLevel === 1 || value.officialAlertLevel === 2
      || value.officialAlertLevel === 3 || value.officialAlertLevel === 4 || value.officialAlertLevel === 5)
    && (value.resolutionSource === "map" || value.resolutionSource === "nameFallback" || value.resolutionSource === "unknown");
}

function isVpws50Snapshot(value: unknown): boolean {
  return isRecord(value)
    && value.generation === VPWS50_SNAPSHOT_GENERATION
    && Array.isArray(value.areas) && value.areas.every((area) =>
    isRecord(area)
    && typeof area.areaCode === "string"
    && typeof area.areaName === "string"
    && Array.isArray(area.kinds)
    && area.kinds.every(isVpws50Kind),
  );
}

function isVpws50State(value: unknown): value is PersistedVpws50StateV2 {
  if (!isRecord(value) || !Array.isArray(value.history)) return false;
  const isEntry = (entry: unknown, identityRequired: boolean): boolean =>
    isRecord(entry)
    && typeof entry.messageId === "string"
    && (identityRequired ? isWeatherIdentity(entry.identity) : entry.identity == null || isWeatherIdentity(entry.identity))
    && isVpws50Snapshot(entry.snapshot);
  return (value.current == null || isEntry(value.current, true))
    && value.history.every((entry) => isEntry(entry, false))
    && (value.lastSuccessfulFullDisplayAt == null
      || typeof value.lastSuccessfulFullDisplayAt === "string" && Number.isFinite(Date.parse(value.lastSuccessfulFullDisplayAt)));
}

function isEmptyVpws50State(value: PersistedVpws50StateV2): boolean {
  return value.current == null
    && value.history.length === 0
    && value.lastSuccessfulFullDisplayAt == null;
}

function isStrictText(value: unknown): value is StrictTextMeta {
  return isRecord(value)
    && (value.raw == null || typeof value.raw === "string")
    && (value.value == null || typeof value.value === "string")
    && typeof value.valid === "boolean";
}

function isGateEntry(value: unknown): value is PersistedTelegramRevisionGateEntryV2 {
  if (!isRecord(value) || !isRecord(value.comparison) || !isRecord(value.comparison.revision)) return false;
  const revision = value.comparison.revision;
  if (typeof value.acceptedAtMs !== "number" || !Number.isFinite(value.acceptedAtMs)) return false;
  if (!isRecord(revision.reportDateTime) || typeof revision.reportDateTime.raw !== "string") return false;
  const strictDate = parseStrictReportDateTime(revision.reportDateTime.raw, value.acceptedAtMs);
  if (!strictDate.valid || strictDate.epochMs == null) return false;
  if (revision.reportDateTime.epochMs !== strictDate.epochMs || revision.reportDateTime.valid !== true) return false;
  if (!isRecord(revision.serial) || !(revision.serial.raw == null || typeof revision.serial.raw === "string")) return false;
  const serialRaw = revision.serial.raw ?? null;
  const parsedSerial = parseTelegramSerial(serialRaw);
  const serialMissing = serialRaw == null || serialRaw === "";
  if (serialMissing) {
    if (revision.serial.numeric != null || revision.serial.valid !== false) return false;
  } else if (
    !parsedSerial.valid
    || revision.serial.valid !== true
    || revision.serial.numeric !== parsedSerial.numeric
  ) return false;
  const eventId = revision.eventId;
  const type = revision.type;
  if (
    !isStrictText(eventId)
    || !isStrictText(type)
    || eventId.valid !== true
    || type.valid !== true
  ) return false;
  return typeof value.domain === "string"
    && typeof value.revisionFamily === "string"
    && typeof value.stateSubjectKey === "string"
    && value.comparison.stateSubjectKey === value.stateSubjectKey
    && isRecord(revision.infoType)
    && (revision.infoType.raw == null || typeof revision.infoType.raw === "string")
    && (revision.infoType.value === "発表" || revision.infoType.value === "訂正" || revision.infoType.value === "取消")
    && revision.infoType.valid === true
    && isStringArray(value.semanticKeys)
    && value.semanticKeys.length <= TELEGRAM_REVISION_MAX_ENTRIES
    && value.semanticKeys.every((key) => key.length <= 1_048_576)
    && typeof value.cancelled === "boolean"
    && (value.legacyRevisionKey == null
      || typeof value.legacyRevisionKey === "string" && value.legacyRevisionKey.length <= 1_024)
    && (value.legacyRevisionKeyProvenance == null
      || value.legacyRevisionKey != null
      && (value.legacyRevisionKeyProvenance === "eventId"
        || value.legacyRevisionKeyProvenance === "codeFallback"))
    && (value.tombstoneRetentionMs == null
      || typeof value.tombstoneRetentionMs === "number"
      && Number.isFinite(value.tombstoneRetentionMs)
      && value.tombstoneRetentionMs > 0)
    && eventId.value === value.stateSubjectKey
    && type.value === value.revisionFamily;
}

function isTsunamiObservation(value: unknown): boolean {
  return isRecord(value)
    && (value.areaName == null || typeof value.areaName === "string")
    && (value.areaCode == null || typeof value.areaCode === "string")
    && typeof value.stationCode === "string"
    && value.stationCode.trim() !== ""
    && typeof value.name === "string"
    && typeof value.sensor === "string"
    && typeof value.arrivalTime === "string"
    && typeof value.initial === "string"
    && typeof value.maxHeightCondition === "string"
    && (value.maxHeightValue == null || typeof value.maxHeightValue === "string")
    && (value.maxHeightValueCondition == null || typeof value.maxHeightValueCondition === "string");
}

function parseTsunamiHeightDiagnostics(value: unknown): SpecialValueDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is SpecialValueDiagnostic =>
    item === "unmappedSpecialValue"
    || item === "specialValueConflict"
    || item === "legacyNullUnknown")) return null;
  return [...value];
}

function parseTsunamiParserDiagnostics(value: unknown): TsunamiParserDiagnostic[] | null {
  if (!Array.isArray(value)) return null;
  if (!value.every((item): item is TsunamiParserDiagnostic =>
    item === "unknownTsunamiAreaCode"
    || item === "unknownTsunamiKindCode")) return null;
  return [...value];
}

function sanitizeTsunamiParserDiagnostics(value: Record<string, unknown>): void {
  if (!Object.hasOwn(value, "diagnostics")) return;
  const diagnostics = parseTsunamiParserDiagnostics(value.diagnostics);
  if (diagnostics == null) delete value.diagnostics;
  else value.diagnostics = diagnostics;
}

function isStrictNullableString(value: unknown): value is string | null {
  return value == null ? value !== undefined : typeof value === "string";
}

function isStrictNullableFiniteNumber(value: unknown): value is number | null {
  return value == null
    ? value !== undefined
    : typeof value === "number" && Number.isFinite(value);
}

function parsePersistedTsunamiHeight(value: unknown): SpecialValue<number> | null {
  if (
    !isRecord(value)
    || !Object.hasOwn(value, "raw")
    || !Object.hasOwn(value, "value")
    || !Object.hasOwn(value, "condition")
    || !Object.hasOwn(value, "description")
    || !Object.hasOwn(value, "presence")
    || !isStrictNullableString(value.raw)
    || !isStrictNullableFiniteNumber(value.value)
    || !isStrictNullableString(value.condition)
    || !isStrictNullableString(value.description)
    || !["value", "missing", "empty", "unknown", "qualitative", "range"].includes(
      typeof value.presence === "string" ? value.presence : "",
    )
  ) return null;
  if (Object.hasOwn(value, "lowerBound") && !isStrictNullableFiniteNumber(value.lowerBound)) return null;
  if (Object.hasOwn(value, "upperBound") && !isStrictNullableFiniteNumber(value.upperBound)) return null;
  if (Object.hasOwn(value, "rawLowerBound") && !isStrictNullableString(value.rawLowerBound)) return null;
  if (Object.hasOwn(value, "rawUpperBound") && !isStrictNullableString(value.rawUpperBound)) return null;
  const hasDiagnostics = Object.hasOwn(value, "diagnostics");
  const diagnostics = hasDiagnostics ? parseTsunamiHeightDiagnostics(value.diagnostics) : undefined;
  if (hasDiagnostics && diagnostics == null) return null;

  const parsed: SpecialValue<number> = {
    raw: value.raw as string | null,
    value: value.value as number | null,
    condition: value.condition as string | null,
    description: value.description as string | null,
    presence: value.presence as SpecialValue<number>["presence"],
    ...(Object.hasOwn(value, "lowerBound")
      ? { lowerBound: value.lowerBound as number | null }
      : {}),
    ...(Object.hasOwn(value, "upperBound")
      ? { upperBound: value.upperBound as number | null }
      : {}),
    ...(Object.hasOwn(value, "rawLowerBound")
      ? { rawLowerBound: value.rawLowerBound as string | null }
      : {}),
    ...(Object.hasOwn(value, "rawUpperBound")
      ? { rawUpperBound: value.rawUpperBound as string | null }
      : {}),
    ...(diagnostics == null ? {} : { diagnostics }),
  };
  const hasLower = Object.hasOwn(parsed, "lowerBound");
  const hasUpper = Object.hasOwn(parsed, "upperBound");
  const hasCanonicalBounds = hasLower || hasUpper;
  const hasRawLower = Object.hasOwn(parsed, "rawLowerBound");
  const hasRawUpper = Object.hasOwn(parsed, "rawUpperBound");
  if (hasRawLower !== hasRawUpper) return null;
  if (parsed.presence === "value" ? parsed.value == null : parsed.value != null) return null;
  if (parsed.presence === "missing") {
    return parsed.raw == null
      && parsed.condition == null
      && parsed.description == null
      && !hasCanonicalBounds
      && !hasRawLower
      ? parsed
      : null;
  }
  if (parsed.presence === "value") {
    return parsed.raw != null && !hasCanonicalBounds ? parsed : null;
  }
  if (parsed.presence === "empty") {
    return parsed.raw != null
      && parsed.raw.trim() === ""
      && !hasCanonicalBounds
      && !hasRawLower
      ? parsed
      : null;
  }
  if (parsed.presence === "range") {
    return parsed.raw != null
      && (hasLower && parsed.lowerBound != null || hasUpper && parsed.upperBound != null)
      ? parsed
      : null;
  }
  if (parsed.presence === "qualitative") return parsed.raw != null ? parsed : null;
  const legacyNull = parsed.diagnostics?.includes("legacyNullUnknown") === true;
  return (parsed.raw != null || legacyNull) && !hasCanonicalBounds ? parsed : null;
}

function sanitizePersistedTsunamiForecast(
  value: unknown,
): LegacyTsunamiForecastItemInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  sanitizeTsunamiParserDiagnostics(sanitized);
  if (Object.hasOwn(sanitized, "areaCode") && !isStrictNullableString(sanitized.areaCode)) {
    delete sanitized.areaCode;
  }
  if (Object.hasOwn(sanitized, "kindCode") && !isStrictNullableString(sanitized.kindCode)) {
    delete sanitized.kindCode;
  }
  if (typeof sanitized.kindName !== "string") delete sanitized.kindName;
  const maxHeight = parsePersistedTsunamiHeight(sanitized.maxHeight);
  if (maxHeight == null) delete sanitized.maxHeight;
  else sanitized.maxHeight = maxHeight;
  return sanitized as unknown as LegacyTsunamiForecastItemInput;
}

function sanitizePersistedTsunamiObservation(
  value: unknown,
): LegacyTsunamiObservationInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  if (Object.hasOwn(sanitized, "areaCode") && !isStrictNullableString(sanitized.areaCode)) {
    delete sanitized.areaCode;
  }
  const maxHeight = parsePersistedTsunamiHeight(sanitized.maxHeight);
  if (maxHeight == null) delete sanitized.maxHeight;
  else sanitized.maxHeight = maxHeight;
  return sanitized as unknown as LegacyTsunamiObservationInput;
}

function sanitizePersistedTsunamiActive(value: unknown): LegacyParsedTsunamiInfoInput {
  const sanitized = structuredClone(value) as Record<string, unknown>;
  sanitizeTsunamiParserDiagnostics(sanitized);
  sanitized.forecast = (sanitized.forecast as unknown[]).map(sanitizePersistedTsunamiForecast);
  if (Array.isArray(sanitized.observations)) {
    sanitized.observations = sanitized.observations.map(sanitizePersistedTsunamiObservation);
  }
  if (isRecord(sanitized.earthquake)) {
    const earthquake = sanitized.earthquake;
    const magnitudeScalar = typeof earthquake.magnitude === "string" ? earthquake.magnitude : "";
    const depthScalar = typeof earthquake.depth === "string" ? earthquake.depth : "";
    earthquake.magnitudeValue = Object.hasOwn(earthquake, "magnitudeValue")
      ? parsePersistedNumericSpecialValue(earthquake.magnitudeValue)!
      : magnitudeValueFromLegacyScalar(earthquake.magnitude as string | null);
    earthquake.depthValue = Object.hasOwn(earthquake, "depthValue")
      ? parsePersistedDepthSpecialValue(earthquake.depthValue)!
      : depthValueFromLegacyScalar(earthquake.depth as string | null);
    earthquake.magnitude = magnitudeScalar;
    earthquake.depth = depthScalar;
  }
  return sanitized as unknown as LegacyParsedTsunamiInfoInput;
}

function isPersistedTelegramMeta(value: unknown): value is TelegramMeta {
  if (
    !isRecord(value)
    || typeof value.messageId !== "string"
    || !(value.status == null || typeof value.status === "string")
    || typeof value.isTest !== "boolean"
    || typeof value.receivedAtMs !== "number"
    || !Number.isFinite(value.receivedAtMs)
    || !isRecord(value.eventId)
    || !isRecord(value.type)
    || !isRecord(value.reportDateTime)
    || !isRecord(value.serial)
    || !isRecord(value.infoType)
  ) return false;
  const rebuilt = createTelegramMeta({
    messageId: value.messageId,
    eventId: typeof value.eventId.raw === "string" ? value.eventId.raw : null,
    type: typeof value.type.raw === "string" ? value.type.raw : null,
    reportDateTime: typeof value.reportDateTime.raw === "string"
      ? value.reportDateTime.raw
      : null,
    serial: typeof value.serial.raw === "string" ? value.serial.raw : null,
    infoType: typeof value.infoType.raw === "string" ? value.infoType.raw : null,
    receivedAtMs: value.receivedAtMs,
    status: value.status ?? null,
    isTest: value.isTest,
  });
  return JSON.stringify(rebuilt.eventId) === JSON.stringify(value.eventId)
    && JSON.stringify(rebuilt.type) === JSON.stringify(value.type)
    && JSON.stringify(rebuilt.reportDateTime) === JSON.stringify(value.reportDateTime)
    && JSON.stringify(rebuilt.serial) === JSON.stringify(value.serial)
    && JSON.stringify(rebuilt.infoType) === JSON.stringify(value.infoType);
}

function isPersistedTsunamiEarthquake(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    typeof value.originTime !== "string"
    || typeof value.hypocenterName !== "string"
    || typeof value.latitude !== "string"
    || typeof value.longitude !== "string"
    || !Object.hasOwn(value, "depth")
    || value.depth !== null && typeof value.depth !== "string"
    || !Object.hasOwn(value, "magnitude")
    || value.magnitude !== null && typeof value.magnitude !== "string"
  ) return false;
  if (
    (Object.hasOwn(value, "magnitudeValue")
      && parsePersistedNumericSpecialValue(value.magnitudeValue) == null)
    || (Object.hasOwn(value, "depthValue")
      && parsePersistedNumericSpecialValue(value.depthValue) == null)
  ) return false;
  return value.magnitudeInfo == null || (
    isRecord(value.magnitudeInfo)
    && typeof value.magnitudeInfo.value === "string"
    && (value.magnitudeInfo.condition == null || typeof value.magnitudeInfo.condition === "string")
    && (value.magnitudeInfo.description == null || typeof value.magnitudeInfo.description === "string")
  );
}

function isPersistedTsunamiActive(value: unknown): boolean {
  if (
    !isRecord(value)
    || value.type !== "VTSE41"
    || typeof value.infoType !== "string"
    || typeof value.title !== "string"
    || typeof value.reportDateTime !== "string"
    || !(value.headline == null || typeof value.headline === "string")
    || typeof value.publishingOffice !== "string"
    || typeof value.warningComment !== "string"
    || typeof value.isTest !== "boolean"
    || !isPersistedTelegramMeta(value.meta)
  ) return false;
  if (
    value.meta.type.value !== "VTSE41"
    || value.meta.reportDateTime.raw !== value.reportDateTime
    || value.meta.infoType.value !== value.infoType
    || value.meta.isTest !== value.isTest
  ) return false;
  if (!Array.isArray(value.forecast) || !value.forecast.every((item) =>
    isRecord(item)
    && typeof item.areaName === "string"
    && typeof item.kind === "string"
    && typeof item.maxHeightDescription === "string"
    && typeof item.firstHeight === "string"
    && (item.stations == null || Array.isArray(item.stations) && item.stations.every((station) =>
      isRecord(station)
      && typeof station.name === "string"
      && typeof station.highTideDateTime === "string"
      && typeof station.arrivalTime === "string"))
  )) return false;
  if (value.observations != null && (!Array.isArray(value.observations) || !value.observations.every((item) =>
    isRecord(item)
    && (item.areaName == null || typeof item.areaName === "string")
    && (item.areaCode == null || typeof item.areaCode === "string")
    && (item.stationCode == null || typeof item.stationCode === "string")
    && typeof item.name === "string"
    && typeof item.sensor === "string"
    && typeof item.arrivalTime === "string"
    && typeof item.initial === "string"
    && typeof item.maxHeightCondition === "string"
    && (item.maxHeightValue == null || typeof item.maxHeightValue === "string")
    && (item.maxHeightValueCondition == null || typeof item.maxHeightValueCondition === "string")
  ))) return false;
  if (value.estimations != null && (!Array.isArray(value.estimations) || !value.estimations.every((item) =>
    isRecord(item)
    && typeof item.areaName === "string"
    && typeof item.maxHeightDescription === "string"
    && typeof item.firstHeight === "string"
  ))) return false;
  return value.earthquake == null || isPersistedTsunamiEarthquake(value.earthquake);
}

function persistedTsunamiSubjectFromUnknown(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.meta) || !isRecord(value.meta.eventId)) return null;
  const eventId = value.meta.eventId;
  return eventId.valid === true
    && typeof eventId.value === "string"
    && eventId.value.trim() !== ""
    ? `tsunami:${eventId.value}`
    : null;
}

function isPersistedTsunamiCancellationUnknown(value: unknown): boolean {
  return isRecord(value)
    && isRecord(value.meta)
    && isRecord(value.meta.infoType)
    && value.meta.infoType.value === "取消";
}

function tsunamiActiveMatchesGate(
  active: ParsedTsunamiInfo,
  gateEntry: PersistedTelegramRevisionGateEntryV2,
): boolean {
  // 取消 payload は表示 state ではない。revision が一致しても active projection
  // として復元せず、gate / tombstone だけを残す。
  if (active.meta.infoType.value === "取消") return false;
  const revision = gateEntry.comparison.revision;
  const exactSubject = gateEntry.stateSubjectKey === tsunamiStateSubjectKey(active.meta);
  const subjectMatches = exactSubject
    // v2 の固定 subject は migration 前 snapshot を読めるように残す。
    || gateEntry.stateSubjectKey === "tsunami:current";
  const sameRevision = revision.reportDateTime.raw === active.meta.reportDateTime.raw
    && revision.serial.raw === active.meta.serial.raw
    && revision.infoType.value === active.meta.infoType.value;
  const gateReportMs = revision.reportDateTime.epochMs;
  const activeReportMs = active.meta.reportDateTime.epochMs;
  const gateSerialMissing = revision.serial.raw == null || revision.serial.raw === "";
  const activeSerialMissing = active.meta.serial.raw == null || active.meta.serial.raw === "";
  const watermarkDoesNotPrecedeActive = gateReportMs != null
    && activeReportMs != null
    && (
      gateReportMs > activeReportMs
      || gateReportMs === activeReportMs
      && (
        gateSerialMissing && activeSerialMissing
        || !gateSerialMissing
        && !activeSerialMissing
        && revision.serial.valid
        && active.meta.serial.valid
        && revision.serial.numeric != null
        && active.meta.serial.numeric != null
        && revision.serial.numeric >= active.meta.serial.numeric
      )
    );
  // 部分取消・照合不能取消・unkeyed 通常続報は、holder を変えずに
  // revision だけを non-cancel watermark として進める。正式 comparator と同じく
  // 同一日時は Serial 順を要求し、片側だけ欠落する unordered な組は拒否する。
  const retainedActivePrecedesWatermark = exactSubject
    && !gateEntry.cancelled
    && watermarkDoesNotPrecedeActive;
  return gateEntry.domain === "tsunami"
    && gateEntry.revisionFamily === "VTSE41"
    && subjectMatches
    && (sameRevision || retainedActivePrecedesWatermark);
}

function isTsunamiVtse41Subject(subject: string): boolean {
  return subject === "tsunami:current" || /^tsunami:\S+$/.test(subject);
}

function matchingTsunamiActiveGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2 | null {
  const subject = tsunamiStateSubjectKey(active.meta);
  const exactEntries = subject == null
    ? []
    : entries.filter((entry) => entry.stateSubjectKey === subject);
  // EventID gate が存在する snapshot では旧 fixed gate へ fallback しない。
  const candidates = exactEntries.length > 0
    ? exactEntries
    : entries.filter((entry) => entry.stateSubjectKey === "tsunami:current");
  return candidates.find((entry) =>
    !entry.cancelled && tsunamiActiveMatchesGate(active, entry)) ?? null;
}

function matchingKeyedTsunamiActiveGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2 | null {
  const subject = tsunamiStateSubjectKey(active.meta);
  if (subject == null) return null;
  return entries.find((entry) =>
    entry.stateSubjectKey === subject
    && !entry.cancelled
    && tsunamiActiveMatchesGate(active, entry)) ?? null;
}

function fixedTsunamiGateDoesNotPrecedeActive(
  gate: PersistedTelegramRevisionGateEntryV2,
  active: ParsedTsunamiInfo,
): boolean {
  const revision = gate.comparison.revision;
  const gateMs = revision.reportDateTime.epochMs;
  const activeMs = active.meta.reportDateTime.epochMs;
  if (gateMs == null || activeMs == null) return false;
  if (gateMs !== activeMs) return gateMs > activeMs;
  const gateMissing = revision.serial.raw == null || revision.serial.raw === "";
  const activeMissing = active.meta.serial.raw == null || active.meta.serial.raw === "";
  if (gateMissing || activeMissing) return gateMissing && activeMissing;
  return revision.serial.valid
    && active.meta.serial.valid
    && revision.serial.numeric != null
    && active.meta.serial.numeric != null
    && revision.serial.numeric >= active.meta.serial.numeric;
}

function migrateLegacyFixedTsunamiGate(
  active: ParsedTsunamiInfo,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
  cancelledOnly = false,
): PersistedTelegramRevisionGateEntryV2[] {
  const subject = tsunamiStateSubjectKey(active.meta);
  if (subject == null) return [...entries];
  const fixedGate = entries.find((entry) =>
    entry.domain === "tsunami"
    && entry.revisionFamily === "VTSE41"
    && entry.stateSubjectKey === "tsunami:current"
    && (!cancelledOnly || entry.cancelled)
    && fixedTsunamiGateDoesNotPrecedeActive(entry, active));
  if (fixedGate == null) return [...entries];
  const migrated = entries.map((entry) => entry !== fixedGate ? entry : {
    ...structuredClone(entry),
    stateSubjectKey: subject,
    comparison: {
      ...structuredClone(entry.comparison),
      stateSubjectKey: subject,
      revision: {
        ...structuredClone(entry.comparison.revision),
        eventId: { raw: subject, value: subject, valid: true },
      },
    },
  });
  // canonical subject が既にある部分 migration 形も revision 規則で一件へ畳む。
  return collapseTsunamiGateEntries(migrated).entries;
}

function limitTsunamiVtse41Entries(
  active: readonly ParsedTsunamiInfo[],
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): PersistedTelegramRevisionGateEntryV2[] {
  const maxSubjects = TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.maxSubjects;
  if (entries.length <= maxSubjects) return [...entries];
  const activeGates = new Set(active.map((item) => matchingTsunamiActiveGate(item, entries)));
  const ranked = entries.map((entry, index) => ({ entry, index })).sort((left, right) => {
    const leftPriority = activeGates.has(left.entry) ? 0 : left.entry.cancelled ? 1 : 2;
    const rightPriority = activeGates.has(right.entry) ? 0 : right.entry.cancelled ? 1 : 2;
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    const timeOrder = right.entry.acceptedAtMs - left.entry.acceptedAtMs;
    return timeOrder !== 0 ? timeOrder : right.index - left.index;
  });
  const retainedIndexes = new Set(
    ranked.slice(0, maxSubjects).map(({ index }) => index),
  );
  return entries.filter((_, index) => retainedIndexes.has(index));
}

function isKeyedTsunamiActive(active: ParsedTsunamiInfo): boolean {
  const eventId = active.meta.eventId;
  return active.meta.infoType.value !== "取消"
    && eventId.valid
    && eventId.value != null
    && eventId.value.trim() !== ""
    && (active.forecast ?? []).length > 0
    && (active.forecast ?? []).every((item) =>
      item.areaCode != null
      && item.areaCode.trim() !== ""
      && item.kindCode != null
      && item.kindCode.trim() !== "");
}

function isDisplayableLegacyTsunamiActive(active: ParsedTsunamiInfo): boolean {
  const forecast = active.forecast ?? [];
  return active.meta.infoType.value !== "取消"
    && !isKeyedTsunamiActive(active)
    && forecast.some((item) =>
      item.areaCode == null
      || item.areaCode.trim() === ""
      || item.kindCode == null
      || item.kindCode.trim() === "")
    && resolveTsunamiLevel(forecast.map((item) => item.kind)) != null;
}

function comparePersistedTsunamiRevision(
  incoming: ParsedTsunamiInfo,
  current: ParsedTsunamiInfo,
): "newer" | "equal" | "older" | "unordered" {
  const incomingMs = incoming.meta.reportDateTime.epochMs;
  const currentMs = current.meta.reportDateTime.epochMs;
  if (incomingMs == null || currentMs == null) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incoming.meta.serial.raw == null || incoming.meta.serial.raw === "";
  const currentMissing = current.meta.serial.raw == null || current.meta.serial.raw === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = incoming.meta.serial.numeric;
  const currentSerial = current.meta.serial.numeric;
  if (
    !incoming.meta.serial.valid
    || !current.meta.serial.valid
    || incomingSerial == null
    || currentSerial == null
  ) return "unordered";
  if (incomingSerial === currentSerial) return "equal";
  return incomingSerial > currentSerial ? "newer" : "older";
}

function comparePersistedTsunamiGateRevision(
  incoming: PersistedTelegramRevisionGateEntryV2,
  current: PersistedTelegramRevisionGateEntryV2,
): "newer" | "equal" | "older" | "unordered" {
  const incomingRevision = incoming.comparison.revision;
  const currentRevision = current.comparison.revision;
  const incomingMs = incomingRevision.reportDateTime.epochMs;
  const currentMs = currentRevision.reportDateTime.epochMs;
  if (incomingMs == null || currentMs == null) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incomingRevision.serial.raw == null || incomingRevision.serial.raw === "";
  const currentMissing = currentRevision.serial.raw == null || currentRevision.serial.raw === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = incomingRevision.serial.numeric;
  const currentSerial = currentRevision.serial.numeric;
  if (
    !incomingRevision.serial.valid
    || !currentRevision.serial.valid
    || incomingSerial == null
    || currentSerial == null
  ) return "unordered";
  if (incomingSerial === currentSerial) return "equal";
  return incomingSerial > currentSerial ? "newer" : "older";
}

function tsunamiInfoTypePrecedence(entry: PersistedTelegramRevisionGateEntryV2): number {
  switch (entry.comparison.revision.infoType.value) {
    case "取消": return 2;
    case "訂正": return 1;
    default: return 0;
  }
}

function mergeEqualTsunamiGateEntries(
  current: PersistedTelegramRevisionGateEntryV2,
  incoming: PersistedTelegramRevisionGateEntryV2,
): PersistedTelegramRevisionGateEntryV2 {
  const incomingWins = incoming.cancelled !== current.cancelled
    ? incoming.cancelled
    : tsunamiInfoTypePrecedence(incoming) > tsunamiInfoTypePrecedence(current);
  const winner = incomingWins ? incoming : current;
  return {
    ...structuredClone(winner),
    acceptedAtMs: Math.max(current.acceptedAtMs, incoming.acceptedAtMs),
    semanticKeys: compactPersistedSemanticKeys([
      ...current.semanticKeys,
      ...incoming.semanticKeys,
    ]),
  };
}

function collapseTsunamiGateEntries(
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): { entries: PersistedTelegramRevisionGateEntryV2[]; rejectedKeys: Set<string> } {
  const grouped = new Map<string, PersistedTelegramRevisionGateEntryV2[]>();
  for (const entry of entries) {
    const key = `${entry.domain}:${entry.revisionFamily}:${entry.stateSubjectKey}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  const collapsed: PersistedTelegramRevisionGateEntryV2[] = [];
  const rejectedKeys = new Set<string>();
  for (const [key, group] of grouped) {
    let unordered = false;
    for (let left = 0; left < group.length && !unordered; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (comparePersistedTsunamiGateRevision(group[left], group[right]) === "unordered") {
          unordered = true;
          break;
        }
      }
    }
    if (unordered) {
      rejectedKeys.add(key);
      continue;
    }
    let retained = group[0];
    for (const incoming of group.slice(1)) {
      const order = comparePersistedTsunamiGateRevision(incoming, retained);
      if (order === "newer") retained = incoming;
      else if (order === "equal") retained = mergeEqualTsunamiGateEntries(retained, incoming);
    }
    collapsed.push(retained);
  }
  return { entries: collapsed, rejectedKeys };
}

interface KeyedTsunamiActiveSelection {
  active: ParsedTsunamiInfo[];
  rejectedSubjects: Set<string>;
}

/** EventID 重複は reportDateTimeThenSerial で選び、unordered subject は全件拒否する。 */
function retainNewestKeyedTsunamiActive(
  candidates: readonly ParsedTsunamiInfo[],
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): KeyedTsunamiActiveSelection {
  const grouped = new Map<string, ParsedTsunamiInfo[]>();
  for (const active of candidates) {
    if (!isKeyedTsunamiActive(active)) continue;
    const subject = tsunamiStateSubjectKey(active.meta);
    if (subject == null) continue;
    const group = grouped.get(subject) ?? [];
    group.push(active);
    grouped.set(subject, group);
  }
  const active: ParsedTsunamiInfo[] = [];
  const rejectedSubjects = new Set<string>();
  for (const [subject, group] of grouped) {
    let unordered = false;
    for (let left = 0; left < group.length && !unordered; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (comparePersistedTsunamiRevision(group[left], group[right]) === "unordered") {
          unordered = true;
          break;
        }
      }
    }
    if (unordered) {
      rejectedSubjects.add(subject);
      continue;
    }
    // gate と結合可能な古い candidate へ巻き戻さない。まず全 active から最新を
    // 決め、その一件が gate と結合できなければ subject 全体を拒否する。
    let retained = group[0];
    for (const incoming of group.slice(1)) {
      const order = comparePersistedTsunamiRevision(incoming, retained);
      const incomingCorrection = incoming.meta.infoType.value === "訂正";
      const currentCorrection = retained.meta.infoType.value === "訂正";
      if (
        order === "newer"
        || order === "equal" && incomingCorrection && !currentCorrection
      ) retained = incoming;
    }
    if (matchingKeyedTsunamiActiveGate(retained, entries) == null) {
      rejectedSubjects.add(subject);
      continue;
    }
    active.push(retained);
  }
  return { active, rejectedSubjects };
}

function normalizeTsunamiActiveInputs(
  value: PersistedTelegramFoundationV2["tsunami"],
): { keyedActive: ParsedTsunamiInfo[]; legacyActive: ParsedTsunamiInfo | null } {
  if (value.keyedActive != null) {
    return {
      keyedActive: value.keyedActive.map((item) => structuredClone(item)),
      legacyActive: value.legacyActive == null ? null : structuredClone(value.legacyActive),
    };
  }
  if (value.active == null) {
    return {
      keyedActive: [],
      legacyActive: value.legacyActive == null ? null : structuredClone(value.legacyActive),
    };
  }
  const scalar = structuredClone(value.active);
  return isKeyedTsunamiActive(scalar)
    ? { keyedActive: [scalar], legacyActive: null }
    : { keyedActive: [], legacyActive: scalar };
}

/**
 * gate の global compaction と holder 更新の境界でも自己整合した envelope だけを書く。
 * whole watermark が失われた family は state と item watermark をまとめて落とし、
 * orphan 観測が v2 全体を壊さないようにする。
 */
function normalizeTsunamiFoundationForWrite(
  value: PersistedTelegramFoundationV2["tsunami"],
): PersistedTelegramFoundationV2["tsunami"] {
  const observations: PersistedTsunamiObservationGroupsV2 = { VTSE51: [], VTSE52: [] };
  const gateEntries: PersistedTelegramRevisionGateEntryV2[] = [];
  const inputs = normalizeTsunamiActiveInputs(value);
  const rawVtse41Candidates = value.gateEntries.filter(
    (entry) => entry.domain === "tsunami"
      && entry.revisionFamily === "VTSE41"
      && isTsunamiVtse41Subject(entry.stateSubjectKey),
  );
  let vtse41Candidates = collapseTsunamiGateEntries(rawVtse41Candidates).entries;
  const scalarMigrationActive = value.keyedActive == null
    && value.active != null
    && tsunamiStateSubjectKey(value.active.meta) != null
    ? value.active
    : null;
  if (scalarMigrationActive != null) {
    vtse41Candidates = migrateLegacyFixedTsunamiGate(scalarMigrationActive, vtse41Candidates);
  }
  if (
    inputs.legacyActive != null
    && tsunamiStateSubjectKey(inputs.legacyActive.meta) != null
  ) {
    vtse41Candidates = migrateLegacyFixedTsunamiGate(
      inputs.legacyActive,
      vtse41Candidates,
      !isKeyedTsunamiActive(inputs.legacyActive),
    );
  }
  const keyedInputCandidates = [
    ...inputs.keyedActive,
    ...(inputs.legacyActive != null && isKeyedTsunamiActive(inputs.legacyActive)
      ? [inputs.legacyActive]
      : []),
  ];
  const candidateSelection = retainNewestKeyedTsunamiActive(
    keyedInputCandidates,
    vtse41Candidates,
  );
  const candidateKeyedActive = candidateSelection.active;
  const keyedSubjects = new Set(candidateKeyedActive.flatMap((active) => {
    const subject = tsunamiStateSubjectKey(active.meta);
    return subject == null ? [] : [subject];
  }));
  const candidateLegacyActive = inputs.legacyActive != null
    && isDisplayableLegacyTsunamiActive(inputs.legacyActive)
    && !keyedSubjects.has(tsunamiStateSubjectKey(inputs.legacyActive.meta) ?? "")
    ? inputs.legacyActive
    : null;
  const legacySubject = candidateLegacyActive == null
    ? null
    : tsunamiStateSubjectKey(candidateLegacyActive.meta);
  const eligibleVtse41Entries = vtse41Candidates.filter((entry) =>
    (entry.cancelled || !candidateSelection.rejectedSubjects.has(entry.stateSubjectKey))
    // legacy display は revision gate / 取消照合に参加させない。
    && (entry.cancelled
      || legacySubject == null
      || entry.stateSubjectKey !== legacySubject && entry.stateSubjectKey !== "tsunami:current"));
  const vtse41Entries = limitTsunamiVtse41Entries(
    candidateKeyedActive,
    eligibleVtse41Entries,
  );
  gateEntries.push(...vtse41Entries.map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
  })));
  const keyedActive = retainNewestKeyedTsunamiActive(candidateKeyedActive, vtse41Entries).active
    .map(projectPersistedTsunamiActive);
  const legacyActive = candidateLegacyActive == null
    ? null
    : projectPersistedTsunamiActive(candidateLegacyActive);
  for (const family of ["VTSE51", "VTSE52"] as const) {
    const familyEntries = value.gateEntries.filter(
      (entry) => entry.domain === "tsunamiObservation" && entry.revisionFamily === family,
    );
    const wholeSubject = `tsunami:observations:${family}`;
    const wholeEntries = familyEntries.filter((entry) => entry.stateSubjectKey === wholeSubject);
    if (wholeEntries.length !== 1) continue;
    gateEntries.push(...familyEntries.map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    })));
    if (wholeEntries[0].cancelled) continue;
    const activeCodes = new Set(familyEntries.flatMap((entry) =>
      entry.stateSubjectKey !== wholeSubject && !entry.cancelled
        ? [entry.stateSubjectKey]
        : []));
    observations[family] = value.observations[family]
      .filter((item) => {
        const code = item.stationCode?.trim();
        return code != null && code !== "" && activeCodes.has(code);
      })
      .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY)
      .map(projectPersistedTsunamiObservation);
  }
  // null の旧 field だけは rollback projection の空状態として維持する。実 payload
  // は keyedActive / legacyActive にのみ書き、scalar snapshot を書き戻さない。
  return {
    ...(value.active === null ? { active: null } : {}),
    keyedActive,
    legacyActive,
    observations,
    gateEntries,
  };
}

/**
 * 構造的型付けと structuredClone だけでは将来の余剰 property が残るため、
 * schema に存在する field だけを列挙して投影する。areaCode は単位4で正式な field。
 */
function projectPersistedTsunamiObservation(
  item: TsunamiObservationStation,
): PersistedTsunamiObservationV2 {
  return {
    areaName: item.areaName,
    ...(Object.hasOwn(item, "areaCode") ? { areaCode: item.areaCode ?? null } : {}),
    ...(item.stationCode != null ? { stationCode: item.stationCode } : {}),
    name: item.name,
    sensor: item.sensor,
    arrivalTime: item.arrivalTime,
    initial: item.initial,
    maxHeightCondition: item.maxHeightCondition,
    maxHeightValue: item.maxHeightValue,
    maxHeight: structuredClone(item.maxHeight),
    ...(Object.hasOwn(item, "maxHeightValueCondition")
      ? { maxHeightValueCondition: item.maxHeightValueCondition }
      : {}),
  };
}

function projectPersistedTsunamiActive(
  active: ParsedTsunamiInfo,
): PersistedTsunamiActiveV2 {
  const projected = structuredClone(active) as PersistedTsunamiActiveV2;
  if (active.earthquake != null) {
    projected.earthquake = {
      ...structuredClone(active.earthquake),
      magnitudeValue: normalizeNumericSpecialValueForPersistence(
        active.earthquake.magnitudeValue
          ?? magnitudeValueFromLegacyScalar(active.earthquake.magnitude),
      ),
      depthValue: normalizeNumericSpecialValueForPersistence(
        active.earthquake.depthValue
          ?? depthValueFromLegacyScalar(active.earthquake.depth),
      ),
    };
  }
  if (active.observations == null) {
    delete projected.observations;
  } else {
    projected.observations = active.observations.map(projectPersistedTsunamiObservation);
  }
  return projected;
}

function sanitizeTsunamiFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["tsunami"] | null {
  if (!isRecord(value) || !isRecord(value.observations) || !Array.isArray(value.gateEntries)) {
    return null;
  }
  const parseActive = (raw: unknown): ParsedTsunamiInfo | undefined =>
    isPersistedTsunamiActive(raw)
      ? canonicalizeLegacyTsunamiInfo(
          structuredClone(sanitizePersistedTsunamiActive(raw)),
        )
      : undefined;
  const rejectedActiveSubjects = new Set<string>();
  const rememberRejectedActiveSubject = (raw: unknown): void => {
    const subject = persistedTsunamiSubjectFromUnknown(raw);
    if (subject != null && !isPersistedTsunamiCancellationUnknown(raw)) {
      rejectedActiveSubjects.add(subject);
    }
  };
  const hasKeyedSchema = Object.hasOwn(value, "keyedActive");
  let scalarActive: ParsedTsunamiInfo | null = null;
  if (!hasKeyedSchema && value.active != null) {
    scalarActive = parseActive(value.active) ?? null;
    if (scalarActive == null) {
      rememberRejectedActiveSubject(value.active);
      log.warn("[standby-persistence] tsunami の壊れた旧 scalar active を破棄");
    }
  } else if (hasKeyedSchema && value.active != null && parseActive(value.active) == null) {
    // keyed schema が権威入力なので、rollback projection の破損は domain を巻き込まない。
    rememberRejectedActiveSubject(value.active);
    log.warn("[standby-persistence] tsunami keyed schema と併存する壊れた scalar active を無視");
  }

  const rawKeyedCandidates = hasKeyedSchema && Array.isArray(value.keyedActive)
    ? value.keyedActive
    : [];
  if (hasKeyedSchema && !Array.isArray(value.keyedActive)) {
    log.warn("[standby-persistence] tsunami keyedActive 配列の破損を局所破棄");
  }
  const parsedKeyedCandidates = rawKeyedCandidates.flatMap((raw) => {
    const active = parseActive(raw);
    if (active == null || !isKeyedTsunamiActive(active)) {
      log.warn("[standby-persistence] tsunami の壊れた keyed EventID state を局所破棄");
      const subject = persistedTsunamiSubjectFromUnknown(raw);
      if (subject != null && !isPersistedTsunamiCancellationUnknown(raw)) {
        rejectedActiveSubjects.add(subject);
      }
      return [];
    }
    return [active];
  });
  if (!hasKeyedSchema && scalarActive != null && isKeyedTsunamiActive(scalarActive)) {
    parsedKeyedCandidates.push(scalarActive);
  }

  const schemaLegacy = value.legacyActive == null ? null : parseActive(value.legacyActive) ?? null;
  if (value.legacyActive != null && schemaLegacy == null) {
    rememberRejectedActiveSubject(value.legacyActive);
    log.warn("[standby-persistence] tsunami の壊れた legacy active を局所破棄");
  }
  const candidateLegacy = schemaLegacy
    ?? (!hasKeyedSchema && scalarActive != null && !isKeyedTsunamiActive(scalarActive)
      ? scalarActive
      : null);
  if (schemaLegacy != null && isKeyedTsunamiActive(schemaLegacy)) {
    parsedKeyedCandidates.push(schemaLegacy);
  }
  const displayableLegacy = candidateLegacy != null
    && isDisplayableLegacyTsunamiActive(candidateLegacy)
    ? candidateLegacy
    : null;
  const rawGroups = value.observations;
  if (
    !Array.isArray(rawGroups.VTSE51)
    || !rawGroups.VTSE51.every(isTsunamiObservation)
    || !Array.isArray(rawGroups.VTSE52)
    || !rawGroups.VTSE52.every(isTsunamiObservation)
  ) return null;
  const validEntries = value.gateEntries.flatMap((entry) => {
    if (!isGateEntry(entry)) return [];
    if (entry.domain === "tsunami") {
      return entry.revisionFamily === "VTSE41" && isTsunamiVtse41Subject(entry.stateSubjectKey)
        ? [entry]
        : [];
    }
    if (entry.domain !== "tsunamiObservation") return [];
    if (entry.revisionFamily !== "VTSE51" && entry.revisionFamily !== "VTSE52") return [];
    const wholeSubject = `tsunami:observations:${entry.revisionFamily}`;
    return entry.stateSubjectKey === wholeSubject || /^\d+$/.test(entry.stateSubjectKey)
      ? [entry]
      : [];
  }) as PersistedTelegramRevisionGateEntryV2[];
  if (validEntries.length !== value.gateEntries.length) {
    log.warn("[standby-persistence] tsunami の壊れた gate subject を局所破棄");
  }
  const collapsedEntries = collapseTsunamiGateEntries(validEntries);
  if (collapsedEntries.rejectedKeys.size > 0) {
    log.warn("[standby-persistence] tsunami の unordered な重複 gate subject を局所破棄");
  } else if (collapsedEntries.entries.length !== validEntries.length) {
    log.warn("[standby-persistence] tsunami の重複 gate subject を revision 順で一件へ集約");
  }
  let entries = collapsedEntries.entries;
  if (
    !hasKeyedSchema
    && scalarActive != null
    && tsunamiStateSubjectKey(scalarActive.meta) != null
  ) {
    entries = migrateLegacyFixedTsunamiGate(scalarActive, entries);
  }
  if (schemaLegacy != null && tsunamiStateSubjectKey(schemaLegacy.meta) != null) {
    entries = migrateLegacyFixedTsunamiGate(
      schemaLegacy,
      entries,
      !isKeyedTsunamiActive(schemaLegacy),
    );
  }

  const vtse41Candidates = entries.filter(
    (entry) => entry.domain === "tsunami",
  ) as PersistedTelegramRevisionGateEntryV2[];
  const matchedSelection = retainNewestKeyedTsunamiActive(
    parsedKeyedCandidates,
    vtse41Candidates,
  );
  const matchedKeyedActive = matchedSelection.active;
  for (const subject of matchedSelection.rejectedSubjects) rejectedActiveSubjects.add(subject);
  if (matchedKeyedActive.length !== parsedKeyedCandidates.length) {
    log.warn("[standby-persistence] tsunami の不整合または重複 keyed EventID state を局所破棄");
  }
  const keyedSubjectsBeforeCompaction = new Set(matchedKeyedActive.flatMap((active) => {
    const subject = tsunamiStateSubjectKey(active.meta);
    return subject == null ? [] : [subject];
  }));
  const salvageableVtse41Candidates = vtse41Candidates.filter((entry) =>
    entry.cancelled
    || !rejectedActiveSubjects.has(entry.stateSubjectKey)
    || keyedSubjectsBeforeCompaction.has(entry.stateSubjectKey));
  // 正規 keyed state が同じ EventID を持つ場合、legacy 表示を先に退場させる。
  const legacyActive = displayableLegacy != null
    && !keyedSubjectsBeforeCompaction.has(tsunamiStateSubjectKey(displayableLegacy.meta) ?? "")
    ? displayableLegacy
    : null;
  const legacySubject = legacyActive == null ? null : tsunamiStateSubjectKey(legacyActive.meta);
  const vtse41Entries = limitTsunamiVtse41Entries(matchedKeyedActive, salvageableVtse41Candidates.filter(
    (entry) => entry.cancelled
      || legacySubject == null
      || entry.stateSubjectKey !== legacySubject && entry.stateSubjectKey !== "tsunami:current",
  ));
  const retainedVtse41Subjects = new Set(vtse41Entries.map((entry) => entry.stateSubjectKey));
  const keyedActive = retainNewestKeyedTsunamiActive(matchedKeyedActive, vtse41Entries).active;
  const boundedEntries = (entries as PersistedTelegramRevisionGateEntryV2[]).filter(
    (entry) => entry.domain !== "tsunami"
      || retainedVtse41Subjects.has(entry.stateSubjectKey),
  );

  const groups = {
    VTSE51: rawGroups.VTSE51
      .map((item) => canonicalizeLegacyTsunamiObservation(sanitizePersistedTsunamiObservation(item)))
      .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY),
    VTSE52: rawGroups.VTSE52
      .map((item) => canonicalizeLegacyTsunamiObservation(sanitizePersistedTsunamiObservation(item)))
      .slice(-TSUNAMI_OBSERVATION_MAX_STATIONS_PER_FAMILY),
  };
  for (const family of ["VTSE51", "VTSE52"] as const) {
    const familyEntries = boundedEntries.filter((entry) => entry.revisionFamily === family);
    const wholeSubject = `tsunami:observations:${family}`;
    const wholeEntries = familyEntries.filter((entry) => entry.stateSubjectKey === wholeSubject);
    if ((familyEntries.length > 0 || groups[family].length > 0) && wholeEntries.length !== 1) {
      return null;
    }
    if (wholeEntries[0]?.cancelled === true && groups[family].length > 0) return null;
    const codes = groups[family].map((item) => item.stationCode!.trim());
    if (new Set(codes).size !== codes.length) return null;
    if (codes.some((code) => !familyEntries.some(
      (entry) => entry.stateSubjectKey === code && !entry.cancelled,
    ))) return null;
  }

  // active は caller 互換の read-only projection。writer は keyedActive /
  // legacyActive だけを出力し、旧 scalar form へ書き戻さない。
  const compatibilityActive = keyedActive.length === 1
    ? keyedActive[0]
    : keyedActive.length === 0 ? legacyActive : null;
  return {
    ...(compatibilityActive != null || Object.hasOwn(value, "active")
      ? { active: compatibilityActive == null ? null : structuredClone(compatibilityActive) }
      : {}),
    keyedActive: keyedActive.map((active) => structuredClone(active)),
    legacyActive: legacyActive == null ? null : structuredClone(legacyActive),
    observations: groups,
    gateEntries: boundedEntries.map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
      // 旧 v2 の欠落値は各 family の無期限 tombstone policy へ移行する。
      tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
        ? entry.domain === "tsunami"
          ? TSUNAMI_REVISION_FAMILY_POLICIES.VTSE41.tombstoneRetentionMs
          : TSUNAMI_REVISION_FAMILY_POLICIES[entry.revisionFamily as "VTSE51" | "VTSE52"].tombstoneRetentionMs
        : entry.tombstoneRetentionMs,
    })),
  };
}

function compareWeatherIdentity(
  incoming: WeatherReportIdentity,
  current: WeatherReportIdentity,
): "newer" | "equal" | "older" | "unordered" {
  const incomingMs = Date.parse(incoming.reportDateTime);
  const currentMs = Date.parse(current.reportDateTime);
  if (!Number.isFinite(incomingMs) || !Number.isFinite(currentMs)) return "unordered";
  if (incomingMs !== currentMs) return incomingMs > currentMs ? "newer" : "older";
  const incomingMissing = incoming.serial == null || incoming.serial === "";
  const currentMissing = current.serial == null || current.serial === "";
  if (incomingMissing || currentMissing) {
    return incomingMissing && currentMissing ? "equal" : "unordered";
  }
  const incomingSerial = parseTelegramSerial(incoming.serial);
  const currentSerial = parseTelegramSerial(current.serial);
  if (
    !incomingSerial.valid
    || !currentSerial.valid
    || incomingSerial.numeric == null
    || currentSerial.numeric == null
  ) return "unordered";
  if (incomingSerial.numeric === currentSerial.numeric) return "equal";
  return incomingSerial.numeric > currentSerial.numeric ? "newer" : "older";
}

function gateWeatherIdentity(entry: PersistedTelegramRevisionGateEntryV2): WeatherReportIdentity {
  return {
    reportDateTime: entry.comparison.revision.reportDateTime.raw ?? "",
    serial: entry.comparison.revision.serial.raw ?? null,
  };
}

function vpws50FoundationIsConsistent(
  authoritative: boolean,
  state: PersistedVpws50StateV2 | null,
  entries: readonly PersistedTelegramRevisionGateEntryV2[],
): boolean {
  if (entries.length > 1) return false;
  // v1 adapter は表示 snapshot と trusted legacy watermark のみを運び、holder は正にしない。
  if (!authoritative) return state == null;
  if (state == null) return entries.length === 0;
  if (isEmptyVpws50State(state)) return entries.length === 0;
  if (entries.length !== 1) return false;

  const gateEntry = entries[0];
  if (state.current == null) {
    return gateEntry.cancelled && state.history.length === 0;
  }

  const historyIdentities = state.history.map((item) => item.identity);
  if (historyIdentities.some((identity) => identity == null)) return false;
  const ordered = [
    ...(historyIdentities as WeatherReportIdentity[]),
    state.current.identity,
  ];
  for (let index = 1; index < ordered.length; index++) {
    if (compareWeatherIdentity(ordered[index - 1], ordered[index]) !== "older") return false;
  }

  const currentToGate = compareWeatherIdentity(state.current.identity, gateWeatherIdentity(gateEntry));
  return gateEntry.cancelled ? currentToGate === "older" : currentToGate === "equal";
}

function sanitizeVpws50Foundation(
  value: unknown,
): PersistedTelegramFoundationV2["vpws50"] | null {
  if (!isRecord(value) || typeof value.authoritative !== "boolean") return null;
  const state = value.state;
  const entries = value.gateEntries;
  if ((state != null && !isVpws50State(state)) || !Array.isArray(entries) || !entries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWS50"
    && entry.stateSubjectKey === "weather:vpws50",
  )) return null;
  const validatedState = state as PersistedVpws50StateV2 | null;
  const validatedEntries = entries as PersistedTelegramRevisionGateEntryV2[];
  if (!vpws50FoundationIsConsistent(value.authoritative, validatedState, validatedEntries)) return null;
  const compactedEntries = validatedEntries.map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    // tombstoneRetentionMs 導入前の v2 は domain policy を欠く。
    // VPWS50 は固定 1 subject なので、取消 latch を期限なく保持する現行 policy へ移行する。
    tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
      ? VPWS50_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : entry.tombstoneRetentionMs,
  }));
  if (state != null) {
    if (entries.length === 0 && !isEmptyVpws50State(state)) return null;
    const receivedAtMs = Math.max(...entries.map((entry) => entry.acceptedAtMs));
    const identities = [
      state.current?.identity,
      ...state.history.map((entry) => entry.identity),
    ].filter((identity) => identity != null);
    if (!identities.every((identity) => isWeatherIdentity(identity, receivedAtMs))) return null;
  }
  return {
    authoritative: value.authoritative,
    state: state == null ? null : structuredClone(state),
    gateEntries: compactedEntries,
  };
}

function isVpww56SubjectKey(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("weather:VPWW56:")
    && value.length > "weather:VPWW56:".length;
}

function isVpww56View(value: unknown): value is Vpws50CurrentAreasForDisplay {
  if (!isRecord(value)) return false;
  if (
    !Number.isSafeInteger(value.totalAreas) || (value.totalAreas as number) < 0
    || !Number.isSafeInteger(value.specialAreas) || (value.specialAreas as number) < 0
    || !Number.isSafeInteger(value.warningAreas) || (value.warningAreas as number) < 0
    || !Number.isSafeInteger(value.advisoryAreas) || (value.advisoryAreas as number) < 0
    || !Array.isArray(value.kinds)
  ) return false;
  return value.kinds.every((group) =>
    isRecord(group)
    && typeof group.kindCode === "string"
    && typeof group.kindShortName === "string"
    && typeof group.kindName === "string"
    && typeof group.displaySeverity === "string"
    && [
      "officialL5", "officialL4", "officialL3", "officialL2", "officialL1",
      "nonLevelSpecial", "nonLevelWarning", "nonLevelAdvisory", "release", "unknown",
    ].includes(group.displaySeverity)
    && (group.officialAlertLevel == null
      || group.officialAlertLevel === 1 || group.officialAlertLevel === 2
      || group.officialAlertLevel === 3 || group.officialAlertLevel === 4
      || group.officialAlertLevel === 5)
    && Array.isArray(group.areas)
    && group.areas.every((area) =>
      isRecord(area) && typeof area.areaName === "string" && typeof area.areaCode === "string"),
  );
}

function normalizeVpww56FoundationForWrite(
  value: PersistedTelegramFoundationV2["vpww56"],
): PersistedTelegramFoundationV2["vpww56"] {
  if (!value.authoritative) return emptyVpww56Foundation();
  const gateEntries = value.gateEntries
    .filter((entry) => entry.domain === "weather"
      && entry.revisionFamily === "VPWW56"
      && isVpww56SubjectKey(entry.stateSubjectKey))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const activeSubjects = new Set(
    gateEntries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const pendingSubjects = (value.state?.pendingSubjects ?? [])
    .filter((subject) => activeSubjects.has(subject))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!);
  const streams = (value.state?.streams ?? [])
    .filter((stream) => stream.generation === VPWW56_SNAPSHOT_GENERATION
      && activeSubjects.has(stream.subjectKey)
      && !pendingSubjects.includes(stream.subjectKey))
    .slice(-VPWW56_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((stream) => ({
      ...structuredClone(stream),
      generation: VPWW56_SNAPSHOT_GENERATION,
    }));
  const retainedSubjects = new Set(streams.map((stream) => stream.subjectKey));
  for (const subject of pendingSubjects) retainedSubjects.add(subject);
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: retainedSubjects.size === 0 ? null : {
      generation: VPWW56_SNAPSHOT_GENERATION,
      streams,
      pendingSubjects,
    },
    gateEntries: gateEntries.filter((entry) => entry.cancelled || retainedSubjects.has(entry.stateSubjectKey)),
  };
}

/**
 * 市町村等粒度 marker 導入前の active stream は、官署 identity と revision watermark だけを
 * 救済する。旧 view は表示せず、各官署の次の受理報まで pending とする。取消済み subject は
 * active 官署ではないため旧 tombstone ごと捨てる。
 */
function migrateLegacyVpww56Foundation(
  value: Record<string, unknown>,
): PersistedTelegramFoundationV2["vpww56"] | null {
  if (value.authoritative !== true || !Array.isArray(value.gateEntries)) return null;
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWW56"
    && isVpww56SubjectKey(entry.stateSubjectKey),
  )) return null;
  if (value.state == null) return emptyVpww56Foundation();
  if (!isRecord(value.state) || !Array.isArray(value.state.streams)) return null;
  if (value.state.streams.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (!value.state.streams.every((stream) =>
    isRecord(stream) && isVpww56SubjectKey(stream.subjectKey) && isVpww56View(stream.view),
  )) return null;

  const rawStreams = value.state.streams as Array<{
    generation?: typeof VPWW56_SNAPSHOT_GENERATION;
    subjectKey: string;
    view: Vpws50CurrentAreasForDisplay;
  }>;
  const streamSubjects = rawStreams.map((stream) => stream.subjectKey);
  if (new Set(streamSubjects).size !== streamSubjects.length) return null;
  const streams = rawStreams
    .filter((stream) => stream.generation === VPWW56_SNAPSHOT_GENERATION)
    .map((stream) => ({
      generation: VPWW56_SNAPSHOT_GENERATION,
      subjectKey: stream.subjectKey,
      view: structuredClone(stream.view),
    }));
  const pendingSubjects = rawStreams
    .filter((stream) => stream.generation !== VPWW56_SNAPSHOT_GENERATION)
    .map((stream) => stream.subjectKey);
  const representedSet = new Set(streamSubjects);
  const activeEntries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[])
    .filter((entry) => !entry.cancelled && representedSet.has(entry.stateSubjectKey))
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
      tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
        ? VPWW56_REVISION_FAMILY_POLICY.tombstoneRetentionMs
        : entry.tombstoneRetentionMs,
    }));
  if (activeEntries.length !== streamSubjects.length) return null;
  const activeSubjects = new Set(activeEntries.map((entry) => entry.stateSubjectKey));
  if (activeSubjects.size !== streamSubjects.length
    || streamSubjects.some((subject) => !activeSubjects.has(subject))) return null;
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: {
      generation: VPWW56_SNAPSHOT_GENERATION,
      streams,
      pendingSubjects,
    },
    gateEntries: activeEntries,
  };
}

function sanitizeVpww56Foundation(
  value: unknown,
): PersistedTelegramFoundationV2["vpww56"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.gateEntries)
  ) {
    return null;
  }
  if (value.generation !== VPWW56_SNAPSHOT_GENERATION) {
    return migrateLegacyVpww56Foundation(value);
  }
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && entry.domain === "weather"
    && entry.revisionFamily === "VPWW56"
    && isVpww56SubjectKey(entry.stateSubjectKey),
  )) return null;
  const entries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    // 導入前 v2 に field が無い場合は VPWW56 の 6 時間 policy へ補完する。
    tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
      ? VPWW56_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : entry.tombstoneRetentionMs,
  }));
  if (entries.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const gateSubjects = new Set(entries.map((entry) => entry.stateSubjectKey));
  if (gateSubjects.size !== entries.length) return null;
  if (!value.authoritative) {
    return value.state == null && entries.length === 0
      ? emptyVpww56Foundation()
      : null;
  }
  if (value.state == null) {
    return entries.some((entry) => !entry.cancelled)
      ? null
      : {
          generation: VPWW56_SNAPSHOT_GENERATION,
          authoritative: true,
          state: null,
          gateEntries: entries,
        };
  }
  if (
    !isRecord(value.state)
    || !Array.isArray(value.state.streams)
  ) return null;
  if (value.state.generation !== VPWW56_SNAPSHOT_GENERATION) {
    return migrateLegacyVpww56Foundation(value);
  }
  if (value.state.streams.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (!Array.isArray(value.state.pendingSubjects)
    || value.state.streams.some((stream) =>
      !isRecord(stream) || stream.generation !== VPWW56_SNAPSHOT_GENERATION)) {
    return migrateLegacyVpww56Foundation(value);
  }
  if (!value.state.streams.every((stream) =>
    isRecord(stream)
    && stream.generation === VPWW56_SNAPSHOT_GENERATION
    && isVpww56SubjectKey(stream.subjectKey)
    && isVpww56View(stream.view),
  )) return null;
  if (value.state.pendingSubjects.length > VPWW56_REVISION_FAMILY_POLICY.maxSubjects!
    || !value.state.pendingSubjects.every(isVpww56SubjectKey)) return null;
  const streams = (value.state.streams as PersistedVpww56StateV2["streams"]).map((stream) =>
    structuredClone(stream));
  const pendingSubjects = value.state.pendingSubjects as string[];
  const streamSubjects = new Set(streams.map((stream) => stream.subjectKey));
  if (streamSubjects.size !== streams.length) return null;
  const pendingSet = new Set(pendingSubjects);
  if (pendingSet.size !== pendingSubjects.length
    || pendingSubjects.some((subject) => streamSubjects.has(subject))) return null;
  const activeGateSubjects = new Set(
    entries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const representedSubjects = new Set([...streamSubjects, ...pendingSet]);
  if (
    representedSubjects.size !== activeGateSubjects.size
    || [...representedSubjects].some((subject) => !activeGateSubjects.has(subject))
  ) return null;
  return {
    generation: VPWW56_SNAPSHOT_GENERATION,
    authoritative: true,
    state: { generation: VPWW56_SNAPSHOT_GENERATION, streams, pendingSubjects },
    gateEntries: entries,
  };
}

function isVolcanoFoundationSubject(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  return entry.domain === "volcano"
    && (
      entry.revisionFamily === "volcanoAlert"
        && /^volcano:alert:[^:]+$/.test(entry.stateSubjectKey)
        && (entry.legacyRevisionKey == null || entry.legacyRevisionKey === entry.stateSubjectKey)
      || entry.revisionFamily === "volcanoEruption"
        && /^volcano:eruption:[^:]+$/.test(entry.stateSubjectKey)
        && (entry.legacyRevisionKey == null || /^volcano:event:.+$/.test(entry.legacyRevisionKey))
    );
}

function isPersistedVolcanoHolderState(value: unknown): value is PersistedVolcanoStateV2 {
  if (!isRecord(value) || !Array.isArray(value.alerts) || !Array.isArray(value.eruptions)) return false;
  const alertCodes = value.alerts.flatMap((entry) =>
    isRecord(entry) && typeof entry.volcanoCode === "string" ? [entry.volcanoCode] : []);
  const eruptionCodes = value.eruptions.flatMap((entry) =>
    isRecord(entry) && typeof entry.volcanoCode === "string" ? [entry.volcanoCode] : []);
  return new Set(alertCodes).size === value.alerts.length
    && new Set(eruptionCodes).size === value.eruptions.length
    && value.alerts.length <= VOLCANO_ALERT_REVISION_FAMILY_POLICY.maxSubjects!
    && value.eruptions.length <= VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.maxSubjects!
    && value.alerts.every((entry) =>
      isRecord(entry)
      && typeof entry.volcanoCode === "string" && entry.volcanoCode.trim() !== ""
      && typeof entry.volcanoName === "string"
      && (entry.alertLevel == null || Number.isFinite(entry.alertLevel))
      && (entry.alertLevelCode == null || typeof entry.alertLevelCode === "string")
      && ["issue", "continue", "raise", "lower", "release", "cancel"].includes(String(entry.action))
      && typeof entry.reportDateTime === "string"
      && parseStrictReportDateTime(entry.reportDateTime, Number.MAX_SAFE_INTEGER).valid
      && (entry.alertClass == null || isVolcanoAlertClass(entry.alertClass))
      && typeof entry.warningKind === "string"
      && isStringArray(entry.targetKinds))
    && value.eruptions.every((entry) =>
      isRecord(entry)
      && typeof entry.volcanoCode === "string" && entry.volcanoCode.trim() !== ""
      && (entry.eventId == null || typeof entry.eventId === "string")
      && (entry.legacyV1Fallback == null || typeof entry.legacyV1Fallback === "boolean"));
}

function normalizeVolcanoFoundationForWrite(
  value: PersistedTelegramFoundationV2["volcano"],
): PersistedTelegramFoundationV2["volcano"] {
  if (!value.authoritative) return emptyVolcanoFoundation();
  const gateEntries = value.gateEntries
    .filter(isVolcanoFoundationSubject)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const activeSubjects = new Set(
    gateEntries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey),
  );
  const active = value.active.flatMap((entry) => {
    const keepAlert = activeSubjects.has(`volcano:alert:${entry.code}`);
    const keepEruption = activeSubjects.has(`volcano:eruption:${entry.code}`);
    if (!keepAlert && !keepEruption) return [];
    const copy = structuredClone(entry);
    if (!keepAlert) {
      copy.alertLevel = null;
      copy.alertClass = null;
      copy.warningKind = null;
      copy.targetKinds = [];
      copy.alertExpiresAtMs = null;
      copy.alertRevision = null;
    }
    if (!keepEruption) {
      copy.latestEvent = null;
      copy.latestEventId = null;
      copy.eventExpiresAtMs = null;
      copy.eventRevision = null;
    }
    return [copy];
  });
  const state = value.state == null ? null : {
    alerts: value.state.alerts
      .filter((entry) => activeSubjects.has(`volcano:alert:${entry.volcanoCode}`))
      .map((entry) => structuredClone(entry)),
    eruptions: value.state.eruptions
      .filter((entry) => activeSubjects.has(`volcano:eruption:${entry.volcanoCode}`))
      .map((entry) => structuredClone(entry)),
  };
  return {
    authoritative: true,
    state: state != null && (state.alerts.length > 0 || state.eruptions.length > 0) ? state : null,
    active,
    gateEntries,
  };
}

function sanitizeVolcanoFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["volcano"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.active)
    || !Array.isArray(value.gateEntries)
  ) return null;
  if (!value.authoritative) {
    return value.state == null && value.active.length === 0 && value.gateEntries.length === 0
      ? emptyVolcanoFoundation()
      : null;
  }
  if (!value.active.every(isVolcanoState)) return null;
  if (value.state != null && !isPersistedVolcanoHolderState(value.state)) return null;
  if (!value.gateEntries.every((entry) => isGateEntry(entry) && isVolcanoFoundationSubject(entry))) {
    return null;
  }
  const entries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    tombstoneRetentionMs: entry.tombstoneRetentionMs === undefined
      ? entry.revisionFamily === "volcanoAlert"
        ? VOLCANO_ALERT_REVISION_FAMILY_POLICY.tombstoneRetentionMs
        : VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.tombstoneRetentionMs
      : entry.tombstoneRetentionMs,
  }));
  const keys = new Set(entries.map((entry) => `${entry.revisionFamily}:${entry.stateSubjectKey}`));
  if (keys.size !== entries.length) return null;
  if (entries.filter((entry) => entry.revisionFamily === "volcanoAlert").length
    > VOLCANO_ALERT_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (entries.filter((entry) => entry.revisionFamily === "volcanoEruption").length
    > VOLCANO_ERUPTION_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const activeSubjects = new Set(entries.filter((entry) => !entry.cancelled).map((entry) => entry.stateSubjectKey));
  const active = (value.active as PersistedVolcanoStateV1[]).map(migrateVolcanoStateForRead);
  const gateBySubject = new Map(entries.map((entry) => [entry.stateSubjectKey, entry]));
  for (const volcano of active) {
    if (volcano.alertLevel != null || volcano.alertClass?.isActive === true) {
      const gate = gateBySubject.get(`volcano:alert:${volcano.code}`);
      if (
        gate == null || gate.cancelled || volcano.alertRevision == null
        || volcano.alertRevision.reportTimeMs !== gate.comparison.revision.reportDateTime.epochMs
        || volcano.alertRevision.serial !== gate.comparison.revision.serial.raw
      ) return null;
    }
    if (volcano.latestEvent != null) {
      const gate = gateBySubject.get(`volcano:eruption:${volcano.code}`);
      if (
        gate == null || gate.cancelled || volcano.eventRevision == null
        || volcano.eventRevision.reportTimeMs !== gate.comparison.revision.reportDateTime.epochMs
        || volcano.eventRevision.serial !== gate.comparison.revision.serial.raw
      ) return null;
    }
  }
  const state = value.state == null ? null : structuredClone(value.state as PersistedVolcanoStateV2);
  if (state == null && activeSubjects.size > 0) return null;
  if (state != null) {
    if (state.alerts.some((entry) => {
      const gate = gateBySubject.get(`volcano:alert:${entry.volcanoCode}`);
      return gate == null || gate.cancelled
        || gate.comparison.revision.reportDateTime.raw !== entry.reportDateTime;
    })) return null;
    if (state.eruptions.some((entry) => {
      if (!activeSubjects.has(`volcano:eruption:${entry.volcanoCode}`)) return true;
      const projection = active.find((candidate) => candidate.code === entry.volcanoCode);
      return projection?.latestEvent != null && projection.latestEventId !== entry.eventId;
    })) return null;
    for (const subject of activeSubjects) {
      if (subject.startsWith("volcano:alert:")
        && !state.alerts.some((entry) => subject === `volcano:alert:${entry.volcanoCode}`)) return null;
      if (subject.startsWith("volcano:eruption:")
        && !state.eruptions.some((entry) => subject === `volcano:eruption:${entry.volcanoCode}`)) return null;
    }
  }
  return { authoritative: true, state, active: structuredClone(active), gateEntries: entries };
}

function isFloodFoundationSubject(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  return entry.domain === "floodForecast"
    && entry.revisionFamily === "floodForecast"
    && entry.stateSubjectKey.startsWith("flood:event:")
    && entry.stateSubjectKey.length > "flood:event:".length;
}

function numericFloodSerial(serial: string | null): number | null {
  if (serial == null || !/^\d+$/u.test(serial)) return null;
  const numeric = Number(serial);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function floodGateHasValidSerial(entry: PersistedTelegramRevisionGateEntryV2): boolean {
  const serial = entry.comparison.revision.serial;
  return serial.valid
    && serial.raw != null
    && serial.numeric != null
    && numericFloodSerial(serial.raw) === serial.numeric;
}

function floodProjectionWasAppliedThroughGate(
  event: PersistedFloodEventState,
  gate: PersistedTelegramRevisionGateEntryV2,
): boolean {
  const gateTimeMs = gate.comparison.revision.reportDateTime.epochMs;
  const gateSerial = gate.comparison.revision.serial;
  const applied = event.appliedRevision ?? event.revision;
  if (
    gateTimeMs == null
    || !gateSerial.valid
    || gateSerial.raw == null
    || gateSerial.numeric == null
    || applied.serial == null
    || event.revision.serial == null
  ) return false;
  const appliedSerial = numericFloodSerial(applied.serial);
  const contentSerial = numericFloodSerial(event.revision.serial);
  if (appliedSerial == null || contentSerial == null) return false;
  if (applied.reportTimeMs !== gateTimeMs || appliedSerial !== gateSerial.numeric) return false;
  const gateSemanticKey = gate.semanticKeys.at(-1);
  if (gateSemanticKey == null) return false;
  if (event.appliedSemanticKey != null) {
    if (event.appliedSemanticKey !== gateSemanticKey) return false;
  } else if (
    // pre-semantic-watermark v2: only a sole normal publication can be proven safe.
    // A correction history without an applied token is deliberately not trusted.
    gate.semanticKeys.length !== 1
    || !gateSemanticKey.startsWith("発表:")
  ) {
    return false;
  }
  return event.revision.reportTimeMs < applied.reportTimeMs
    || event.revision.reportTimeMs === applied.reportTimeMs && contentSerial <= appliedSerial;
}

function normalizeFloodFoundationForWrite(
  value: PersistedTelegramFoundationV2["floodForecast"],
): PersistedTelegramFoundationV2["floodForecast"] {
  if (!value.authoritative) return emptyFloodFoundation();
  const gateEntries = value.gateEntries
    .filter(isFloodFoundationSubject)
    .slice(-FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!)
    .map((entry) => ({
      ...structuredClone(entry),
      semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    }));
  const gateByEventId = new Map(gateEntries.map((entry) => [
    entry.stateSubjectKey.slice("flood:event:".length),
    entry,
  ]));
  const activeGateByEventId = new Map(gateEntries.flatMap((entry) => {
    if (entry.cancelled) return [];
    return [[entry.stateSubjectKey.slice("flood:event:".length), entry] as const];
  }));
  const activeEventIds = new Set(value.active.map((event) => event.eventId));
  const legacyEventIds = [...new Set(value.legacyEventIds ?? [])]
    .filter((eventId) => activeEventIds.has(eventId) && !gateByEventId.has(eventId))
    .slice(-FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!);
  const legacyEvents = new Set(legacyEventIds);
  const active = value.active.flatMap((event) => {
    if (legacyEvents.has(event.eventId)) return [structuredClone(event)];
    const gate = activeGateByEventId.get(event.eventId);
    if (gate == null || !floodProjectionWasAppliedThroughGate(event, gate)) return [];
    return [structuredClone(event)];
  });
  return { authoritative: true, active, legacyEventIds, gateEntries };
}

function sanitizeFloodFoundation(
  value: unknown,
): PersistedTelegramFoundationV2["floodForecast"] | null {
  if (
    !isRecord(value)
    || typeof value.authoritative !== "boolean"
    || !Array.isArray(value.active)
    || !Array.isArray(value.gateEntries)
  ) return null;
  if (!value.authoritative) {
    return value.active.length === 0 && value.gateEntries.length === 0
      && (value.legacyEventIds == null
        || Array.isArray(value.legacyEventIds) && value.legacyEventIds.length === 0)
      ? emptyFloodFoundation()
      : null;
  }
  if (!value.active.every(isFloodEvent)) return null;
  if (value.legacyEventIds != null && (
    !Array.isArray(value.legacyEventIds)
    || !value.legacyEventIds.every((eventId) => typeof eventId === "string" && eventId !== "")
  )) return null;
  if (!value.gateEntries.every((entry) =>
    isGateEntry(entry)
    && isFloodFoundationSubject(entry)
    && floodGateHasValidSerial(entry))) {
    return null;
  }
  const gateEntries = (value.gateEntries as PersistedTelegramRevisionGateEntryV2[]).map((entry) => ({
    ...structuredClone(entry),
    semanticKeys: compactPersistedSemanticKeys(entry.semanticKeys),
    tombstoneRetentionMs: entry.tombstoneRetentionMs
      ?? FLOOD_FORECAST_REVISION_FAMILY_POLICY.tombstoneRetentionMs,
  }));
  if (gateEntries.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  if (new Set(gateEntries.map((entry) => entry.stateSubjectKey)).size !== gateEntries.length) return null;
  const gateByEventId = new Map(gateEntries.map((entry) => [
    entry.stateSubjectKey.slice("flood:event:".length),
    entry,
  ]));
  const active = value.active as PersistedFloodEventState[];
  if (active.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects! * 2) return null;
  if (new Set(active.map((event) => event.eventId)).size !== active.length) return null;
  const legacyEventIds = [...new Set((value.legacyEventIds ?? []) as string[])];
  if (legacyEventIds.length !== (value.legacyEventIds ?? []).length) return null;
  if (legacyEventIds.length > FLOOD_FORECAST_REVISION_FAMILY_POLICY.maxSubjects!) return null;
  const activeEventIds = new Set(active.map((event) => event.eventId));
  if (legacyEventIds.some((eventId) => !activeEventIds.has(eventId) || gateByEventId.has(eventId))) {
    return null;
  }
  const legacyEvents = new Set(legacyEventIds);
  const salvagedActive = active.filter((event) => {
    if (legacyEvents.has(event.eventId)) return true;
    const gate = gateByEventId.get(event.eventId);
    return gate != null
      && !gate.cancelled
      && floodProjectionWasAppliedThroughGate(event, gate);
  });
  if (salvagedActive.length !== active.length) {
    log.warn("[standby-persistence] flood active projection/gate coupling validation failed; salvaging gate entries");
  }
  return {
    authoritative: true,
    active: structuredClone(salvagedActive),
    legacyEventIds,
    gateEntries,
  };
}

function sanitizeFoundation(value: unknown): PersistedTelegramFoundationV2 | null {
  if (!isRecord(value)) return null;
  const validatedVpws50 = sanitizeVpws50Foundation(value.vpws50);
  const vpws50 = validatedVpws50 ?? emptyVpws50Foundation();
  if (validatedVpws50 == null) {
    log.warn("[standby-persistence] VPWS50 foundation structure validation 失敗 — domain 破棄");
  }
  const validatedVpww56 = value.vpww56 == null
    ? emptyVpww56Foundation()
    : sanitizeVpww56Foundation(value.vpww56);
  const vpww56 = validatedVpww56 ?? emptyVpww56Foundation();
  if (validatedVpww56 == null) {
    log.warn("[standby-persistence] VPWW56 foundation structure validation 失敗 — domain 破棄");
  }
  const validatedTsunami = value.tsunami == null
    ? emptyTsunamiFoundation()
    : sanitizeTsunamiFoundation(value.tsunami);
  const tsunami = validatedTsunami ?? emptyTsunamiFoundation();
  if (validatedTsunami == null) {
    log.warn("[standby-persistence] tsunami foundation structure validation 失敗 — domain 破棄");
  }
  const validatedVolcano = value.volcano == null
    ? emptyVolcanoFoundation()
    : sanitizeVolcanoFoundation(value.volcano);
  const volcano = validatedVolcano ?? emptyVolcanoFoundation();
  if (validatedVolcano == null) {
    log.warn("[standby-persistence] volcano foundation structure validation 失敗 — domain 破棄");
  }
  const validatedFlood = value.floodForecast == null
    ? emptyFloodFoundation()
    : sanitizeFloodFoundation(value.floodForecast);
  const floodForecast = validatedFlood ?? emptyFloodFoundation();
  if (validatedFlood == null) {
    log.warn("[standby-persistence] flood foundation structure validation failed; salvaging other domains");
  }
  const validatedStandbyDomains = value.standbyDomains == null
    ? emptyStandbyDomainsFoundation()
    : sanitizeStandbyDomainsFoundation(value.standbyDomains);
  const standbyDomains = validatedStandbyDomains ?? emptyStandbyDomainsFoundation();
  if (validatedStandbyDomains == null) {
    log.warn("[standby-persistence] standby domain foundation structure validation failed; domain watermarks discarded");
  }
  return { vpws50, vpww56, tsunami, volcano, floodForecast, standbyDomains };
}

function baseV1FromRecord(value: Record<string, unknown>): PersistedStandbyStateV1 | null {
  return sanitizePersistedStandbyStateV1({ ...value, version: 1 });
}

function standbyProjectionMatchesGate(
  revision: StandbyRevision,
  appliedSemanticKey: string | undefined,
  gate: PersistedTelegramRevisionGateEntryV2 | undefined,
): boolean {
  if (gate == null || gate.cancelled) return false;
  // tokenless projection is legacy only when no authoritative gate exists.
  // Once a gate exists, an application token is required to prove that the
  // projection was produced after that exact accepted payload.
  if (appliedSemanticKey == null) return false;
  return gate.comparison.revision.reportDateTime.epochMs === revision.reportTimeMs
    && gate.comparison.revision.serial.raw === revision.serial
    && gate.semanticKeys.at(-1) === appliedSemanticKey;
}

function salvageStandbyDomainProjections(
  base: PersistedStandbyStateV1,
  foundation: PersistedTelegramFoundationV2["standbyDomains"],
): PersistedStandbyStateV1 {
  const gates = new Map(foundation.gateEntries.map((entry) => [entry.stateSubjectKey, entry]));
  const keep = (subject: string, revision: StandbyRevision, semanticKey?: string) => {
    const gate = gates.get(subject);
    return gate == null
      ? semanticKey == null
      : standbyProjectionMatchesGate(revision, semanticKey, gate);
  };
  return {
    ...base,
    heat: base.heat.filter((state) => keep(state.key, state.revision, state.appliedSemanticKey)),
    typhoons: base.typhoons.filter((state) => keep(`typhoon:${state.key}`, state.revision, state.appliedSemanticKey)),
    tornado: base.tornado?.filter((state) => keep(
      `tornado:${state.publishingOffice}`,
      state.revision,
      state.appliedSemanticKey,
    )),
    longPeriod: base.longPeriod?.filter((state) => keep(
      `longPeriod:${state.eventId}`,
      state.revision,
      state.appliedSemanticKey,
    )),
    nankaiTrough: base.nankaiTrough != null && keep(
      "nankai:current",
      base.nankaiTrough.revision,
      base.nankaiTrough.appliedSemanticKey,
    ) ? base.nankaiTrough : null,
  };
}

function sanitizePersistedStandbyStateV2(value: unknown): PersistedStandbyStateV2 | null {
  if (!isRecord(value) || value.version !== 2) return null;
  const base = baseV1FromRecord(value);
  const telegramFoundation = sanitizeFoundation(value.telegramFoundation);
  if (base == null || telegramFoundation == null) return null;
  // 官署 provenance のない旧 VPWW56 union は subject 単位の復元待ちへ変換できない。
  // 非 authoritative foundation と併存する名称-only 表示は、旧粒度を固着させず破棄する。
  const withoutLegacyVpww56 = telegramFoundation.vpww56.authoritative
    ? base
    : {
        ...base,
        weatherAlerts: base.weatherAlerts?.filter((entry) => entry.source !== "vpww56"),
      };
  const salvaged = salvageStandbyDomainProjections(withoutLegacyVpww56, telegramFoundation.standbyDomains);
  return { ...salvaged, version: 2, telegramFoundation };
}

function migratedVpws50GateEntries(base: PersistedStandbyStateV1): PersistedTelegramRevisionGateEntryV2[] {
  const state = base.weatherAlerts?.find((entry) => entry.source === "vpws50");
  if (state == null || state.alerts.length === 0) return [];
  const reportDateTimes = new Set(state.alerts.map((alert) => alert.updatedAt));
  if (reportDateTimes.size !== 1) return [];
  const reportDateTime = [...reportDateTimes][0];
  const epochMs = Date.parse(reportDateTime);
  const savedAtMs = Date.parse(base.savedAt);
  if (!Number.isFinite(epochMs) || !Number.isFinite(savedAtMs) || epochMs !== state.revision.reportTimeMs) return [];
  if (epochMs > savedAtMs + FUTURE_REPORT_DATETIME_SKEW_MS) return [];
  const serialRaw = state.revision.serial;
  const serialMissing = serialRaw == null || serialRaw === "";
  const serialNumeric = !serialMissing && serialRaw != null && /^\d+$/.test(serialRaw)
    ? Number(serialRaw)
    : null;
  if (!serialMissing && (!Number.isSafeInteger(serialNumeric) || serialNumeric == null)) return [];
  return [{
    domain: "weather",
    revisionFamily: "VPWS50",
    stateSubjectKey: "weather:vpws50",
    comparison: {
      stateSubjectKey: "weather:vpws50",
      revision: {
        eventId: { raw: "weather:vpws50", value: "weather:vpws50", valid: true },
        type: { raw: "VPWS50", value: "VPWS50", valid: true },
        reportDateTime: { raw: reportDateTime, epochMs, valid: true },
        serial: {
          raw: serialRaw,
          numeric: serialMissing ? null : serialNumeric,
          valid: !serialMissing && serialNumeric != null,
        },
        infoType: { raw: "発表", value: "発表", valid: true },
      },
    },
    semanticKeys: [],
    cancelled: false,
    acceptedAtMs: Number.isFinite(savedAtMs) ? savedAtMs : epochMs,
  }];
}

function migratePersistedStandbyStateV1(value: unknown): PersistedStandbyStateV2 | null {
  const base = sanitizePersistedStandbyStateV1(value);
  if (base == null) return null;
  return {
    ...base,
    version: 2,
    telegramFoundation: {
      vpws50: { authoritative: false, state: null, gateEntries: migratedVpws50GateEntries(base) },
      vpww56: emptyVpww56Foundation(),
      tsunami: emptyTsunamiFoundation(),
      volcano: emptyVolcanoFoundation(),
      floodForecast: emptyFloodFoundation(),
      standbyDomains: emptyStandbyDomainsFoundation(),
    },
  };
}

function hasVpws50MigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.vpws50;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  const rawHasLegacyField = Object.hasOwn(raw, "weatherAlerts");
  const legacy = state.weatherAlerts?.find((entry) => entry.source === "vpws50");
  const current = foundation.state?.current ?? null;
  const legacyHasPayload = legacy != null && legacy.alerts.length > 0;
  if (current == null) return legacyHasPayload;
  if (!rawHasLegacyField || legacy == null) return true;

  if (
    legacy.revision.reportTimeMs !== Date.parse(current.identity.reportDateTime)
    || legacy.revision.serial !== current.identity.serial
  ) return true;

  const holder = new Vpws50StateHolder();
  holder.restorePersistedState(foundation.state!);
  const projected = weatherAlertsFromVpws50(
    holder.getCurrentAreasForDisplay(),
    current.identity.reportDateTime,
  );
  return JSON.stringify(projected) !== JSON.stringify(legacy.alerts);
}

function hasVpww56MigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.vpww56;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  const rawHasLegacyField = Object.hasOwn(raw, "weatherAlerts");
  const legacy = state.weatherAlerts?.find((entry) => entry.source === "vpww56");
  const legacyHasPayload = legacy != null && legacy.alerts.length > 0;
  const current = foundation.state;
  // 旧粒度 stream を官署別に復元待ちへ移した直後は canonical が意図的に部分集合になる。
  // legacy union との差は migration conflict ではなく世代移行そのものなので数えない。
  if ((current?.pendingSubjects?.length ?? 0) > 0) return false;
  if (current == null || current.streams.length === 0) return legacyHasPayload;
  if (!rawHasLegacyField || legacy == null) return true;

  const holder = new Vpww56StateHolder();
  holder.restorePersistedState(current);
  const canonical = weatherAlertsFromVpww56(holder.getCurrentAreasForDisplay(), "");
  const stripUpdatedAt = (alerts: DisplayWeatherAlertV1[]) =>
    alerts.map(({ updatedAt: _updatedAt, ...alert }) => alert);
  if (JSON.stringify(stripUpdatedAt(canonical)) !== JSON.stringify(stripUpdatedAt(legacy.alerts))) {
    return true;
  }

  const latestActive = [...foundation.gateEntries]
    .filter((entry) =>
      !entry.cancelled
      && entry.comparison.revision.reportDateTime.valid
      && entry.comparison.revision.reportDateTime.epochMs != null)
    .sort((left, right) => {
      const timeOrder = right.comparison.revision.reportDateTime.epochMs!
        - left.comparison.revision.reportDateTime.epochMs!;
      return timeOrder !== 0 ? timeOrder : right.acceptedAtMs - left.acceptedAtMs;
    })[0];
  if (latestActive == null) return true;
  return legacy.revision.reportTimeMs !== latestActive.comparison.revision.reportDateTime.epochMs
    || legacy.revision.serial !== latestActive.comparison.revision.serial.raw;
}

function hasVolcanoMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.volcano;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  if (!Object.hasOwn(raw, "volcanoes") || !Array.isArray(raw.volcanoes)) return true;
  for (const gate of foundation.gateEntries) {
    const prefix = gate.revisionFamily === "volcanoAlert"
      ? "volcano:alert:"
      : "volcano:eruption:";
    const code = gate.stateSubjectKey.slice(prefix.length);
    const legacy = state.volcanoes.find((entry) => entry.code === code);
    const canonical = foundation.active.find((entry) => entry.code === code);
    if (gate.revisionFamily === "volcanoAlert") {
      const legacySlice = legacy == null ? null : {
        alertLevel: legacy.alertLevel,
        alertClass: legacy.alertClass ?? null,
        warningKind: legacy.warningKind ?? null,
        targetKinds: legacy.targetKinds ?? [],
        alertRevision: legacy.alertRevision,
      };
      const canonicalSlice = gate.cancelled || canonical == null ? null : {
        alertLevel: canonical.alertLevel,
        alertClass: canonical.alertClass ?? null,
        warningKind: canonical.warningKind ?? null,
        targetKinds: canonical.targetKinds ?? [],
        alertRevision: canonical.alertRevision,
      };
      if (JSON.stringify(legacySlice) !== JSON.stringify(canonicalSlice)) return true;
    } else {
      const legacySlice = legacy?.latestEvent == null ? null : {
        latestEvent: legacy.latestEvent,
        latestEventId: legacy.latestEventId ?? null,
        eventExpiresAtMs: legacy.eventExpiresAtMs,
        eventRevision: legacy.eventRevision,
      };
      const canonicalSlice = gate.cancelled || canonical?.latestEvent == null ? null : {
        latestEvent: canonical.latestEvent,
        latestEventId: canonical.latestEventId ?? null,
        eventExpiresAtMs: canonical.eventExpiresAtMs,
        eventRevision: canonical.eventRevision,
      };
      if (JSON.stringify(legacySlice) !== JSON.stringify(canonicalSlice)) return true;
    }
  }
  return false;
}

function hasFloodMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  const foundation = state.telegramFoundation.floodForecast;
  if (!foundation.authoritative || !isRecord(raw)) return false;
  if (!Object.hasOwn(raw, "floods") || state.floods == null) {
    return foundation.active.length > 0 || foundation.gateEntries.length > 0;
  }
  const canonicalEvents = [...foundation.active].sort((a, b) => a.eventId.localeCompare(b.eventId));
  const legacyEvents = [...state.floods.events].sort((a, b) => a.eventId.localeCompare(b.eventId));
  if (JSON.stringify(canonicalEvents) !== JSON.stringify(legacyEvents)) return true;
  const canonicalSeen = floodLegacySeenEntries(foundation.gateEntries)
    .sort((a, b) => a.key.localeCompare(b.key));
  const legacySeen = [...state.floods.seen].sort((a, b) => a.key.localeCompare(b.key));
  return JSON.stringify(canonicalSeen) !== JSON.stringify(legacySeen);
}

function hasStandbyDomainsMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  if (!isRecord(raw)) return false;
  const projected = standbyLegacySeenEntries(state.telegramFoundation.standbyDomains.gateEntries);
  if (projected.length === 0) return false;
  if (!Object.hasOwn(raw, "seen")) return true;
  const legacyByKey = new Map(state.seen.map((entry) => [entry.key, entry]));
  return projected.some((entry) => JSON.stringify(legacyByKey.get(entry.key)) !== JSON.stringify(entry));
}

function hasFoundationMigrationConflict(raw: unknown, state: PersistedStandbyStateV2): boolean {
  return hasVpws50MigrationConflict(raw, state)
    || hasVpww56MigrationConflict(raw, state)
    || hasVolcanoMigrationConflict(raw, state)
    || hasFloodMigrationConflict(raw, state)
    || hasStandbyDomainsMigrationConflict(raw, state);
}
