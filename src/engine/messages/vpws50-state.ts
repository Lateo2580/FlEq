import type {
  ParsedWeatherWarning,
  WeatherSeverity,
  Vpws50Diff,
  Vpws50AreaChange,
  Vpws50KindTransition,
  Vpws50DisplayDiff,
  Vpws50DisplayAreaChange,
  Vpws50DisplayKindTransition,
  Vpws50CurrentAreasForDisplay,
  Vpws50DisplayKindGroup,
  PhenomenonKey,
  DetailProvider,
  DetailSnapshotOf,
  DisplaySeverity,
  OfficialAlertLevel,
  ResolutionSource,
} from "../../types";
import * as log from "../../logger";
import { selectPreferredWeatherLayer } from "../../dmdata/weather-parser";
import { kindCodeToPhenomenonKey } from "../../dmdata/weather-phenomenon-key";
import {
  resolvePhenomenonFamily,
  resolveDisplaySeverity,
  DISPLAY_SEVERITY_RANK,
} from "../../dmdata/weather-warning-level";
import {
  normalizeWeatherOfficeWatermarkKey,
  weatherOfficeFromStreamKey,
  weatherOfficeWatermarkKey,
} from "./weather-stream-key";
// Plan-R3: displayVpws50FromState は Task 6 で実装される。dynamic import で順序問題を回避

const HISTORY_DEPTH = 8;
const PARTIAL_SUBJECT_LIMIT = 128;
const RECAP_INTERVAL_MS = 60 * 60 * 1000;
// 比率だけで正当な広域解除を拒まない。明示解除が無いまま 4 key 以上失われる payload だけを
// 異常候補とし、完全電文の解除 evidence があれば件数を問わず受理する。
const ABNORMAL_UNEXPLAINED_RELEASE_MIN = 4;

type AreaSnapshot = Map<string, {
  phenomenonKey: PhenomenonKey;
  kindCode: string;
  kindName: string;
  severity: WeatherSeverity;            // 旧 3 段 (集計互換用)
  displaySeverity: DisplaySeverity;     // Phase C: 昇降格判定の主軸
  officialAlertLevel: OfficialAlertLevel | null;
  resolutionSource: ResolutionSource;   // 監査用に保持 (現状未参照。nameFallback ヒットの検出は resolver 側テストが担う)
}>;

interface Snapshot {
  areas: Map<string, { areaName: string; kinds: AreaSnapshot }>;
  /** 部分報が明示解除した area×現象。overlay 合成時に古い base/overlay を覆う。 */
  clearedPhenomena: Map<string, Set<PhenomenonKey>>;
}

interface PartialStreamEntry {
  messageId: string;
  identity: WeatherReportIdentity;
  snapshot: Snapshot;
}

interface PersistedPartialStreamEntry {
  messageId: string;
  identity: WeatherReportIdentity;
  snapshot: PersistedVpws50SnapshotV2;
}

/** 市町村等を基準にした snapshot 世代。marker 欠落の旧府県粒度 state は復元しない。 */
export const VPWS50_SNAPSHOT_GENERATION = 1 as const;

export interface PersistedVpws50KindV2 {
  phenomenonKey: PhenomenonKey;
  kindCode: string;
  kindName: string;
  severity: WeatherSeverity;
  displaySeverity: DisplaySeverity;
  officialAlertLevel: OfficialAlertLevel | null;
  resolutionSource: ResolutionSource;
}

export interface PersistedVpws50SnapshotV2 {
  generation: typeof VPWS50_SNAPSHOT_GENERATION;
  areas: Array<{
    areaCode: string;
    areaName: string;
    kinds: PersistedVpws50KindV2[];
  }>;
  /** 旧 v2 では欠落する。部分報の明示解除 tombstone。 */
  clearedPhenomena?: Array<{
    areaCode: string;
    phenomenonKeys: PhenomenonKey[];
  }>;
}

export interface PersistedVpws50StateV2 {
  current: {
    messageId: string;
    identity: WeatherReportIdentity;
    snapshot: PersistedVpws50SnapshotV2;
  } | null;
  history: Array<{
    messageId: string;
    identity: WeatherReportIdentity | null;
    snapshot: PersistedVpws50SnapshotV2;
  }>;
  /** VPWW55-61 の官署別部分報。全国 base より新しい stream だけを表示時に overlay する。 */
  partialStreams?: Array<{
    subjectKey: string;
  } & PersistedPartialStreamEntry>;
  /** VPWW55-61 取消時に restorePrevious する官署別 bounded history。欠落した旧 schema は空として扱う。 */
  partialHistory?: Array<{
    subjectKey: string;
    entries: PersistedPartialStreamEntry[];
  }>;
  /** 取消 tombstone を維持したまま表示上だけ直前報へ戻した subject。 */
  restoredPartialSubjects?: string[];
  /** VPNO50 が確定した官署別（head type 非依存）の emergency 終了 watermark。 */
  emergencyClearWatermarks?: Array<{
    subjectKey: string;
    identity: WeatherReportIdentity;
  }>;
  lastSuccessfulFullDisplayAt: string | null;
}

function serializeSnapshot(snapshot: Snapshot): PersistedVpws50SnapshotV2 {
  return {
    generation: VPWS50_SNAPSHOT_GENERATION,
    areas: [...snapshot.areas].map(([areaCode, area]) => ({
      areaCode,
      areaName: area.areaName,
      kinds: [...area.kinds.values()].map((kind) => ({ ...kind })),
    })),
    ...(snapshot.clearedPhenomena.size === 0 ? {} : {
      clearedPhenomena: [...snapshot.clearedPhenomena].map(([areaCode, phenomenonKeys]) => ({
        areaCode,
        phenomenonKeys: [...phenomenonKeys],
      })),
    }),
  };
}

function restoreSnapshot(snapshot: PersistedVpws50SnapshotV2): Snapshot {
  return {
    areas: new Map(snapshot.areas.map((area) => [
      area.areaCode,
      {
        areaName: area.areaName,
        kinds: new Map(area.kinds.map((kind) => [kind.phenomenonKey, { ...kind }])),
      },
    ])),
    clearedPhenomena: new Map((snapshot.clearedPhenomena ?? []).map((entry) => [
      entry.areaCode,
      new Set(entry.phenomenonKeys),
    ])),
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    areas: new Map([...snapshot.areas].map(([areaCode, area]) => [
      areaCode,
      { areaName: area.areaName, kinds: new Map([...area.kinds].map(([key, kind]) => [key, { ...kind }])) },
    ])),
    clearedPhenomena: new Map([...snapshot.clearedPhenomena].map(([areaCode, keys]) => [
      areaCode,
      new Set(keys),
    ])),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isPersistedWeatherIdentity(value: unknown): value is WeatherReportIdentity {
  return isRecord(value)
    && typeof value.reportDateTime === "string"
    && (value.serial == null || typeof value.serial === "string");
}

function isPersistedSnapshot(value: unknown): value is PersistedVpws50SnapshotV2 {
  if (
    !isRecord(value)
    || value.generation !== VPWS50_SNAPSHOT_GENERATION
    || !Array.isArray(value.areas)
  ) return false;
  const areasValid = value.areas.every((area) => {
    if (!isRecord(area) || typeof area.areaCode !== "string" || typeof area.areaName !== "string") return false;
    if (!Array.isArray(area.kinds)) return false;
    return area.kinds.every((kind) => isRecord(kind)
      && typeof kind.phenomenonKey === "string"
      && typeof kind.kindCode === "string"
      && typeof kind.kindName === "string"
      && typeof kind.severity === "string"
      && typeof kind.displaySeverity === "string"
      && (kind.officialAlertLevel == null || typeof kind.officialAlertLevel === "number")
      && typeof kind.resolutionSource === "string");
  });
  const clearsValid = value.clearedPhenomena == null
    || Array.isArray(value.clearedPhenomena)
    && value.clearedPhenomena.every((entry) => isRecord(entry)
      && typeof entry.areaCode === "string"
      && Array.isArray(entry.phenomenonKeys)
      && entry.phenomenonKeys.every((key) => typeof key === "string"));
  return areasValid && clearsValid;
}

/** 旧形式・破損 snapshot を直接渡された場合も holder 内で例外にしない。 */
function isPersistedState(value: unknown): value is PersistedVpws50StateV2 {
  if (!isRecord(value) || !Object.hasOwn(value, "current") || !Array.isArray(value.history)) return false;
  const isEntry = (entry: unknown, identityRequired: boolean): boolean => {
    if (!isRecord(entry) || typeof entry.messageId !== "string" || !isPersistedSnapshot(entry.snapshot)) return false;
    if (entry.identity == null) return !identityRequired;
    return isPersistedWeatherIdentity(entry.identity);
  };
  const partialStreamsValid = value.partialStreams == null || Array.isArray(value.partialStreams)
    && value.partialStreams.length <= PARTIAL_SUBJECT_LIMIT
    && value.partialStreams.every((entry) => isRecord(entry)
      && typeof entry.subjectKey === "string"
      && isEntry(entry, true));
  const partialHistoryValid = value.partialHistory == null || Array.isArray(value.partialHistory)
    && value.partialHistory.length <= PARTIAL_SUBJECT_LIMIT
    && value.partialHistory.every((group) => isRecord(group)
      && typeof group.subjectKey === "string"
      && Array.isArray(group.entries)
      && group.entries.length <= HISTORY_DEPTH
      && group.entries.every((entry) => isEntry(entry, true)));
  const restoredSubjectsValid = value.restoredPartialSubjects == null
    || Array.isArray(value.restoredPartialSubjects)
    && value.restoredPartialSubjects.length <= PARTIAL_SUBJECT_LIMIT
    && value.restoredPartialSubjects.every((subject) => typeof subject === "string");
  const watermarksValid = value.emergencyClearWatermarks == null
    || Array.isArray(value.emergencyClearWatermarks)
    && value.emergencyClearWatermarks.length <= PARTIAL_SUBJECT_LIMIT
    && value.emergencyClearWatermarks.every((entry) => isRecord(entry)
      && typeof entry.subjectKey === "string"
      && normalizeWeatherOfficeWatermarkKey(entry.subjectKey) != null
      && isPersistedWeatherIdentity(entry.identity));
  return partialStreamsValid
    && partialHistoryValid
    && restoredSubjectsValid
    && watermarksValid
    && (value.current == null || isEntry(value.current, true))
    && value.history.every((entry) => isEntry(entry, false))
    && (value.lastSuccessfulFullDisplayAt == null || typeof value.lastSuccessfulFullDisplayAt === "string");
}

/** 気象警報系電文の単調性・取消対象を識別する Head identity。 */
export interface WeatherReportIdentity {
  reportDateTime: string;
  serial: string | null;
}

function normalizeSerial(serial: string | null): string | null {
  const normalized = serial?.trim() ?? "";
  return normalized === "" ? null : normalized;
}

function compareSerial(a: string | null, b: string | null): number {
  const normalizedA = normalizeSerial(a);
  const normalizedB = normalizeSerial(b);
  if (normalizedA === normalizedB) return 0;
  if (normalizedA == null) return -1;
  if (normalizedB == null) return 1;

  if (/^\d+$/.test(normalizedA) && /^\d+$/.test(normalizedB)) {
    const numericA = BigInt(normalizedA);
    const numericB = BigInt(normalizedB);
    if (numericA === numericB) return 0;
    return numericA < numericB ? -1 : 1;
  }
  return normalizedA < normalizedB ? -1 : 1;
}

/** reportDateTime を主、同時刻では Serial を従として identity を比較する。 */
export function compareWeatherReportIdentity(
  a: WeatherReportIdentity,
  b: WeatherReportIdentity,
): number | null {
  const timeA = Date.parse(a.reportDateTime);
  const timeB = Date.parse(b.reportDateTime);
  if (!Number.isFinite(timeA) || !Number.isFinite(timeB)) return null;
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  return compareSerial(a.serial, b.serial);
}

export function weatherReportIdentityEquals(
  a: WeatherReportIdentity,
  b: WeatherReportIdentity,
): boolean {
  return compareWeatherReportIdentity(a, b) === 0;
}

/** 電文由来の Kind 名称からレベル接頭辞・種別接尾辞を取り除く。Vpww56StateHolder からも再利用 (DRY) */
export function shortKindName(name: string): string {
  return name
    .replace(/^レベル[０-９0-9]+/, "")
    .replace(/特別警報$/, "")
    .replace(/危険警報$/, "")
    .replace(/警戒情報$/, "")
    .replace(/警報$/, "")
    .replace(/注意報$/, "")
    .trim() || name;
}

function infoToSnapshot(info: ParsedWeatherWarning): Snapshot | null {
  const layer = selectPreferredWeatherLayer(info.layers);
  if (!layer) return null;
  const areas = new Map<string, { areaName: string; kinds: AreaSnapshot }>();
  const clearedPhenomena = new Map<string, Set<PhenomenonKey>>();
  for (const item of layer.items) {
    const kinds: AreaSnapshot = new Map();
    const releasedKindCodes = new Set<string>();
    for (const status of item.statuses) {
      if (status.status.trim() !== "解除") continue;
      const kindCode = [status.lastKindCode, status.kindCode]
        .map((code) => code?.trim() ?? "")
        .find((code) => code !== "" && code !== "00");
      if (kindCode == null) continue;
      releasedKindCodes.add(status.kindCode);
      releasedKindCodes.add(kindCode);
      const tombstones = clearedPhenomena.get(item.areaCode) ?? new Set<PhenomenonKey>();
      tombstones.add(kindCodeToPhenomenonKey(kindCode));
      clearedPhenomena.set(item.areaCode, tombstones);
    }
    for (const k of item.kinds) {
      const family = resolvePhenomenonFamily(k.code, k.name);
      const resolved = resolveDisplaySeverity(k.code, k.name, family);
      // Phase C: release のみ除外。unknown (rank 30) も保持して沈黙させない (Codex R1 P1)
      if (resolved.displaySeverity === "release") continue;
      if (k.severity === "release") continue; // 名前ベース解除の防御 (従来挙動維持)
      if (releasedKindCodes.has(k.code)) continue;
      const phenomenonKey = kindCodeToPhenomenonKey(k.code);
      const existing = kinds.get(phenomenonKey);
      if (existing == null ||
          DISPLAY_SEVERITY_RANK[resolved.displaySeverity] > DISPLAY_SEVERITY_RANK[existing.displaySeverity]) {
        kinds.set(phenomenonKey, {
          phenomenonKey,
          kindCode: k.code,
          kindName: k.name,
          severity: k.severity,
          displaySeverity: resolved.displaySeverity,
          officialAlertLevel: resolved.officialAlertLevel,
          resolutionSource: resolved.source,
        });
      }
    }
    areas.set(item.areaCode, { areaName: item.areaName, kinds });
  }
  return { areas, clearedPhenomena };
}

function computeDiff(prev: Snapshot | null, curr: Snapshot): {
  added: Vpws50AreaChange[];
  upgraded: Vpws50AreaChange[];
  downgraded: Vpws50AreaChange[];
  released: Vpws50AreaChange[];
} {
  const added: Vpws50AreaChange[] = [];
  const upgraded: Vpws50AreaChange[] = [];
  const downgraded: Vpws50AreaChange[] = [];
  const released: Vpws50AreaChange[] = [];

  const prevAreas = prev?.areas ?? new Map<string, { areaName: string; kinds: AreaSnapshot }>();

  for (const [areaCode, currArea] of curr.areas) {
    const prevArea = prevAreas.get(areaCode);
    const addedKinds: Vpws50KindTransition[] = [];
    const upgradedKinds: Vpws50KindTransition[] = [];
    const downgradedKinds: Vpws50KindTransition[] = [];

    for (const [phKey, currKind] of currArea.kinds) {
      const prevKind = prevArea?.kinds.get(phKey);
      const t: Vpws50KindTransition = {
        phenomenonKey: phKey,
        kindShortName: shortKindName(currKind.kindName),
        prevKindCode: prevKind?.kindCode ?? null,
        newKindCode: currKind.kindCode,
        prevSeverity: prevKind?.severity ?? null,
        newSeverity: currKind.severity,
        prevDisplaySeverity: prevKind?.displaySeverity ?? null,
        newDisplaySeverity: currKind.displaySeverity,
        prevOfficialAlertLevel: prevKind?.officialAlertLevel ?? null,
        newOfficialAlertLevel: currKind.officialAlertLevel,
      };
      if (prevKind == null) {
        addedKinds.push(t);
      } else if (prevKind.displaySeverity !== currKind.displaySeverity) {
        const prevRank = DISPLAY_SEVERITY_RANK[prevKind.displaySeverity];
        const currRank = DISPLAY_SEVERITY_RANK[currKind.displaySeverity];
        if (currRank > prevRank) upgradedKinds.push(t);
        else downgradedKinds.push(t);
      }
      // 同 displaySeverity (Code 変化のみ等) は変化なし扱い (従来挙動と同じ粒度)
    }
    if (addedKinds.length > 0) added.push({ areaName: currArea.areaName, areaCode, changes: addedKinds });
    if (upgradedKinds.length > 0) upgraded.push({ areaName: currArea.areaName, areaCode, changes: upgradedKinds });
    if (downgradedKinds.length > 0) downgraded.push({ areaName: currArea.areaName, areaCode, changes: downgradedKinds });
  }

  for (const [areaCode, prevArea] of prevAreas) {
    const currArea = curr.areas.get(areaCode);
    const releasedKinds: Vpws50KindTransition[] = [];
    for (const [phKey, prevKind] of prevArea.kinds) {
      if (currArea == null || !currArea.kinds.has(phKey)) {
        releasedKinds.push({
          phenomenonKey: phKey,
          kindShortName: shortKindName(prevKind.kindName),
          prevKindCode: prevKind.kindCode,
          newKindCode: null,
          prevSeverity: prevKind.severity,
          newSeverity: null,
          prevDisplaySeverity: prevKind.displaySeverity,
          newDisplaySeverity: null,
          prevOfficialAlertLevel: prevKind.officialAlertLevel,
          newOfficialAlertLevel: null,
        });
      }
    }
    if (releasedKinds.length > 0) {
      released.push({ areaName: prevArea.areaName, areaCode, changes: releasedKinds });
    }
  }

  return { added, upgraded, downgraded, released };
}

/** 緊急画面だけの細粒度差分。通知・CLI 用 computeDiff の意味には混ぜない。 */
function computeDisplayDiff(prev: Snapshot | null, curr: Snapshot): Vpws50DisplayDiff {
  const added: Vpws50DisplayAreaChange[] = [];
  const upgraded: Vpws50DisplayAreaChange[] = [];
  const downgraded: Vpws50DisplayAreaChange[] = [];
  const released: Vpws50DisplayAreaChange[] = [];
  const kindChanged: Vpws50DisplayAreaChange[] = [];
  const prevAreas = prev?.areas ?? new Map<string, { areaName: string; kinds: AreaSnapshot }>();

  for (const [areaCode, currArea] of curr.areas) {
    const prevArea = prevAreas.get(areaCode);
    const buckets = {
      added: [] as Vpws50DisplayKindTransition[],
      upgraded: [] as Vpws50DisplayKindTransition[],
      downgraded: [] as Vpws50DisplayKindTransition[],
      kindChanged: [] as Vpws50DisplayKindTransition[],
    };
    for (const [phenomenonKey, currKind] of currArea.kinds) {
      const prevKind = prevArea?.kinds.get(phenomenonKey);
      const transition: Vpws50DisplayKindTransition = {
        phenomenonKey,
        kindShortName: shortKindName(currKind.kindName),
        prevKindShortName: prevKind == null ? null : shortKindName(prevKind.kindName),
        prevKindCode: prevKind?.kindCode ?? null,
        newKindCode: currKind.kindCode,
        prevSeverity: prevKind?.severity ?? null,
        newSeverity: currKind.severity,
        prevDisplaySeverity: prevKind?.displaySeverity ?? null,
        newDisplaySeverity: currKind.displaySeverity,
        prevOfficialAlertLevel: prevKind?.officialAlertLevel ?? null,
        newOfficialAlertLevel: currKind.officialAlertLevel,
      };
      if (prevKind == null) buckets.added.push(transition);
      else if (prevKind.displaySeverity !== currKind.displaySeverity) {
        const prevRank = DISPLAY_SEVERITY_RANK[prevKind.displaySeverity];
        const currRank = DISPLAY_SEVERITY_RANK[currKind.displaySeverity];
        (currRank > prevRank ? buckets.upgraded : buckets.downgraded).push(transition);
      } else if (
        prevKind.kindCode !== currKind.kindCode
        || transition.prevKindShortName !== transition.kindShortName
      ) buckets.kindChanged.push(transition);
    }
    for (const kind of ["added", "upgraded", "downgraded", "kindChanged"] as const) {
      if (buckets[kind].length > 0) {
        ({ added, upgraded, downgraded, kindChanged })[kind].push({
          areaName: currArea.areaName,
          areaCode,
          changes: buckets[kind],
        });
      }
    }
  }

  for (const [areaCode, prevArea] of prevAreas) {
    const currArea = curr.areas.get(areaCode);
    const changes: Vpws50DisplayKindTransition[] = [];
    for (const [phenomenonKey, prevKind] of prevArea.kinds) {
      if (currArea != null && currArea.kinds.has(phenomenonKey)) continue;
      changes.push({
        phenomenonKey,
        kindShortName: shortKindName(prevKind.kindName),
        prevKindShortName: shortKindName(prevKind.kindName),
        prevKindCode: prevKind.kindCode,
        newKindCode: null,
        prevSeverity: prevKind.severity,
        newSeverity: null,
        prevDisplaySeverity: prevKind.displaySeverity,
        newDisplaySeverity: null,
        prevOfficialAlertLevel: prevKind.officialAlertLevel,
        newOfficialAlertLevel: null,
      });
    }
    if (changes.length > 0) released.push({ areaName: prevArea.areaName, areaCode, changes });
  }
  return { added, upgraded, downgraded, released, kindChanged };
}

function countAreaKeys(snap: Snapshot | null): number {
  if (snap == null) return 0;
  let n = 0;
  for (const a of snap.areas.values()) n += a.kinds.size;
  return n;
}

/**
 * 完全な警報電文では、消える既存 key は同じ Area の解除 Kind で明示される。
 * 件数比ではなくこの完全性を根拠にして、途中で切れたような payload による state 破壊を防ぐ。
 */
function hasExplicitReleasesForAllMissing(
  info: ParsedWeatherWarning,
  previous: Snapshot,
  next: Snapshot,
): boolean {
  const layer = selectPreferredWeatherLayer(info.layers);
  if (layer == null) return false;
  const releaseAreaCodes = new Set(
    layer.items
      .filter((item) => item.kinds.some((kind) => {
        const family = resolvePhenomenonFamily(kind.code, kind.name);
        return kind.severity === "release"
          || resolveDisplaySeverity(kind.code, kind.name, family).displaySeverity === "release";
      }))
      .map((item) => item.areaCode),
  );
  for (const [areaCode, previousArea] of previous.areas) {
    const nextArea = next.areas.get(areaCode);
    for (const phenomenonKey of previousArea.kinds.keys()) {
      if (nextArea?.kinds.has(phenomenonKey) !== true && !releaseAreaCodes.has(areaCode)) return false;
    }
  }
  return true;
}

function prefecturePrefix(areaCode: string): string | null {
  const normalized = areaCode.trim();
  return /^\d{6}$/.test(normalized) && normalized.endsWith("0000")
    ? normalized.slice(0, 2)
    : null;
}

function removeEmergencyKinds(
  snapshot: Snapshot,
  targetAreaCodes: ReadonlySet<string>,
  clearAll = false,
): boolean {
  const prefixes = new Set([...targetAreaCodes].flatMap((code) => {
    const prefix = prefecturePrefix(code);
    return prefix == null ? [] : [prefix];
  }));
  let changed = false;
  for (const [areaCode, area] of snapshot.areas) {
    if (!clearAll
      && !targetAreaCodes.has(areaCode)
      && ![...prefixes].some((prefix) => areaCode.startsWith(prefix))) continue;
    for (const [phenomenonKey, kind] of area.kinds) {
      if (kind.displaySeverity !== "officialL5" && kind.displaySeverity !== "nonLevelSpecial") continue;
      area.kinds.delete(phenomenonKey);
      changed = true;
    }
    if (area.kinds.size === 0) snapshot.areas.delete(areaCode);
  }
  return changed;
}

/** 60 分再掲条件: displaySeverity が警報級相当 (rank >= nonLevelWarning) 以上を含むか */
function hasWarningOrHigher(snap: Snapshot | null): boolean {
  if (snap == null) return false;
  const threshold = DISPLAY_SEVERITY_RANK["nonLevelWarning"];
  for (const a of snap.areas.values()) {
    for (const k of a.kinds.values()) {
      if (DISPLAY_SEVERITY_RANK[k.displaySeverity] >= threshold) return true;
    }
  }
  return false;
}

export class Vpws50StateHolder implements DetailProvider<"vpws50"> {
  readonly category = "vpws50";
  readonly emptyMessage = "VPWS50 の最新電文を受信していません";

  private current: Snapshot | null = null;
  private currentMessageId: string | null = null;
  private currentIdentity: WeatherReportIdentity | null = null;
  private history: Array<{
    messageId: string;
    identity: WeatherReportIdentity | null;
    snapshot: Snapshot;
  }> = [];
  private partialStreams = new Map<string, PartialStreamEntry>();
  private partialHistory = new Map<string, PartialStreamEntry[]>();
  private restoredPartialSubjects = new Set<string>();
  private emergencyClearWatermarks = new Map<string, WeatherReportIdentity>();
  private lastSuccessfulFullDisplayAt: Date | null = null;

  diffAndUpdate(info: ParsedWeatherWarning, messageId: string): Vpws50Diff;
  diffAndUpdate(
    info: ParsedWeatherWarning,
    messageId: string,
    identity: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): Vpws50Diff | null;
  diffAndUpdate(
    info: ParsedWeatherWarning,
    messageId: string,
    identity?: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): Vpws50Diff | null {
    return this.diffAndUpdateInternal(info, messageId, identity, options).diff;
  }

  /** 通知用 diff と緊急画面専用 diff を同じ state 遷移から原子的に生成する。 */
  diffAndUpdateWithDisplay(
    info: ParsedWeatherWarning,
    messageId: string,
    identity: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    return this.diffAndUpdateInternal(info, messageId, identity, options);
  }

  private diffAndUpdateInternal(
    info: ParsedWeatherWarning,
    messageId: string,
    identity?: WeatherReportIdentity,
    options?: { replaceCurrentRevision?: boolean },
  ): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const previousEffective = this.effectiveSnapshot();
    const newSnap = infoToSnapshot(info);
    const unsafeReason = this.unsafeReasonFor(newSnap, info);
    if (unsafeReason != null) return { diff: this.buildUnsafeDiff(unsafeReason), displayDiff: null };
    if (newSnap == null) return { diff: this.buildUnsafeDiff("layer_missing"), displayDiff: null };

    const isFirstReport = previousEffective == null;
    const nextEffective = this.effectiveSnapshot(newSnap, identity ?? null) ?? newSnap;
    const diffParts = isFirstReport
      ? { added: [], upgraded: [], downgraded: [], released: [] }
      : computeDiff(previousEffective, nextEffective);
    const displayDiff = isFirstReport ? null : computeDisplayDiff(previousEffective, nextEffective);
    const isUnchanged =
      !isFirstReport &&
      diffParts.added.length === 0 &&
      diffParts.upgraded.length === 0 &&
      diffParts.downgraded.length === 0 &&
      diffParts.released.length === 0;

    const shouldRecap = (() => {
      if (!isUnchanged) return false;
      if (!hasWarningOrHigher(nextEffective)) return false;
      if (this.lastSuccessfulFullDisplayAt == null) return false;
      return Date.now() - this.lastSuccessfulFullDisplayAt.getTime() >= RECAP_INTERVAL_MS;
    })();

    if (this.current != null && options?.replaceCurrentRevision !== true) {
      this.history.push({
        messageId: this.currentMessageId ?? "",
        identity: this.currentIdentity,
        snapshot: this.current,
      });
      while (this.history.length > HISTORY_DEPTH) this.history.shift();
    }
    this.current = newSnap;
    this.currentMessageId = messageId;
    this.currentIdentity = identity ?? null;

    if (!isUnchanged || shouldRecap || isFirstReport) {
      this.lastSuccessfulFullDisplayAt = new Date();
    }

    return {
      diff: {
        isFirstReport,
        isUnchanged,
        isCancelRollback: false,
        shouldRecap,
        confidence: "confirmed",
        ...diffParts,
      },
      displayDiff,
    };
  }

  /** VPWW55-61 の受理済み部分報を官署・現象 stream 単位で重ね、他現象と他地域を保持する。 */
  mergePartialWithDisplay(
    info: ParsedWeatherWarning,
    messageId: string,
    identity: WeatherReportIdentity,
    subjectKey: string,
    options?: { replaceCurrentRevision?: boolean },
  ): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const parsedPartial = infoToSnapshot(info);
    const partial = parsedPartial == null ? null : cloneSnapshot(parsedPartial);
    if (partial == null) return { diff: this.buildUnsafeDiff("layer_missing"), displayDiff: null };
    const current = this.partialStreams.get(subjectKey);
    const layer = selectPreferredWeatherLayer(info.layers);
    for (const item of layer?.items ?? []) {
      const isReleasePlaceholder = item.kinds.some((kind) =>
        kind.code === "00" || kind.severity === "release" || kind.name.includes("解除"));
      if (!isReleasePlaceholder || (partial.clearedPhenomena.get(item.areaCode)?.size ?? 0) > 0) continue;
      const ownedPhenomena = new Set<PhenomenonKey>(
        current?.snapshot.areas.get(item.areaCode)?.kinds.keys() ?? [],
      );
      for (const phenomenonKey of current?.snapshot.clearedPhenomena.get(item.areaCode) ?? []) {
        ownedPhenomena.add(phenomenonKey);
      }
      if (ownedPhenomena.size === 0) continue;
      partial.clearedPhenomena.set(item.areaCode, ownedPhenomena);
    }
    const officeWatermarkKey = weatherOfficeWatermarkKey(info.publishingOffice);
    const watermark = officeWatermarkKey == null
      ? undefined
      : this.emergencyClearWatermarks.get(officeWatermarkKey);
    if (watermark != null && (compareWeatherReportIdentity(identity, watermark) ?? 1) <= 0) {
      removeEmergencyKinds(partial, new Set(), true);
    }
    const previous = this.effectiveSnapshot();
    if (current != null && options?.replaceCurrentRevision !== true) {
      const history = this.partialHistory.get(subjectKey) ?? [];
      history.push(current);
      while (history.length > HISTORY_DEPTH) history.shift();
      this.partialHistory.set(subjectKey, history);
    }
    this.restoredPartialSubjects.delete(subjectKey);
    this.partialStreams.delete(subjectKey);
    if (partial.areas.size > 0) {
      this.partialStreams.set(subjectKey, { messageId, identity: { ...identity }, snapshot: partial });
    }
    this.trimPartialSubjects();
    return this.partialTransition(previous);
  }

  /** VPWW55-61 取消で当該官署・head type overlay だけを外し、全国 base と他 stream を保持する。 */
  clearPartial(subjectKey: string): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const previous = this.effectiveSnapshot();
    this.partialStreams.delete(subjectKey);
    this.partialHistory.delete(subjectKey);
    this.restoredPartialSubjects.delete(subjectKey);
    return this.partialTransition(previous);
  }

  /** VPWW55-61 取消の restorePrevious 契約。官署・head type stream 内だけを一報戻し、初報なら clear する。 */
  restorePreviousPartial(subjectKey: string): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const previous = this.effectiveSnapshot();
    const history = this.partialHistory.get(subjectKey);
    const restored = history?.pop();
    if (history != null && history.length === 0) this.partialHistory.delete(subjectKey);
    if (restored == null) {
      this.partialStreams.delete(subjectKey);
      this.restoredPartialSubjects.delete(subjectKey);
    } else {
      this.partialStreams.set(subjectKey, restored);
      this.restoredPartialSubjects.add(subjectKey);
    }
    this.trimPartialSubjects();
    return this.partialTransition(previous);
  }

  /**
   * VPNO50 の府県予報区解除を、同じ官署の VPWW55-61 overlay へ cross-type で反映する。
   * VPNO50 自身は後続の警報内容を作らないため、対象地域の L5 相当だけを外す。
   */
  clearEmergencyPartialAreas(
    officeWatermarkKey: string,
    areaCodes: readonly string[],
    identity: WeatherReportIdentity,
  ): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const normalizedOfficeKey = normalizeWeatherOfficeWatermarkKey(officeWatermarkKey)
      ?? officeWatermarkKey;
    const targets = new Set(areaCodes.filter((code) => code.trim() !== ""));
    const previous = this.effectiveSnapshot();
    const currentWatermark = this.emergencyClearWatermarks.get(normalizedOfficeKey);
    if (currentWatermark != null) {
      const relation = compareWeatherReportIdentity(identity, currentWatermark);
      if (relation == null || relation <= 0) return this.partialTransition(previous);
    }
    const recordWatermark = (subjectKey: string): void => {
      const current = this.emergencyClearWatermarks.get(subjectKey);
      if (current == null || (compareWeatherReportIdentity(identity, current) ?? -1) > 0) {
        // Map.set は既存 key の挿入順を更新しない。更新 watermark を LRU 末尾へ移す。
        this.emergencyClearWatermarks.delete(subjectKey);
        this.emergencyClearWatermarks.set(subjectKey, { ...identity });
      }
    };
    recordWatermark(normalizedOfficeKey);
    const isNotNewerThanClear = (entryIdentity: WeatherReportIdentity): boolean =>
      (compareWeatherReportIdentity(entryIdentity, identity) ?? 1) <= 0;
    for (const [subjectKey, entry] of this.partialStreams) {
      if (!isNotNewerThanClear(entry.identity)) continue;
      if (weatherOfficeWatermarkKey(weatherOfficeFromStreamKey(subjectKey)) !== normalizedOfficeKey) continue;
      const next = cloneSnapshot(entry.snapshot);
      if (!removeEmergencyKinds(next, targets, true)) continue;
      if (next.areas.size === 0) {
        this.partialStreams.delete(subjectKey);
        this.restoredPartialSubjects.delete(subjectKey);
      } else this.partialStreams.set(subjectKey, { ...entry, snapshot: next });
    }
    // 取消で過去報へ戻って終了済み特別警報を復元しないよう、stream history 側も同じ解除を適用する。
    for (const [subjectKey, entries] of this.partialHistory) {
      if (weatherOfficeWatermarkKey(weatherOfficeFromStreamKey(subjectKey)) !== normalizedOfficeKey) continue;
      let changed = false;
      const kept = entries.map((entry) => {
        if (!isNotNewerThanClear(entry.identity)) return entry;
        const snapshot = cloneSnapshot(entry.snapshot);
        changed = removeEmergencyKinds(snapshot, targets, true) || changed;
        return { ...entry, snapshot };
      }).filter((entry) => entry.snapshot.areas.size > 0);
      if (!changed) continue;
      if (kept.length === 0) this.partialHistory.delete(subjectKey);
      else this.partialHistory.set(subjectKey, kept);
    }
    while (this.emergencyClearWatermarks.size > PARTIAL_SUBJECT_LIMIT) {
      const oldestSubject = this.emergencyClearWatermarks.keys().next().value as string | undefined;
      if (oldestSubject == null) break;
      this.emergencyClearWatermarks.delete(oldestSubject);
    }
    return this.partialTransition(previous);
  }

  retainActivePartialSubjects(subjectKeys: readonly string[]): void {
    const retained = new Set(subjectKeys);
    for (const subjectKey of this.partialStreams.keys()) {
      if (!retained.has(subjectKey) && !this.restoredPartialSubjects.has(subjectKey)) {
        this.partialStreams.delete(subjectKey);
        this.partialHistory.delete(subjectKey);
      }
    }
    // VPNO50 が emergency current だけを除いた subject は history-only になり得る。
    // gate capacity eviction 後も残さないよう、stream と独立に active 集合へ同期する。
    for (const subjectKey of this.partialHistory.keys()) {
      if (!retained.has(subjectKey) && !this.restoredPartialSubjects.has(subjectKey)) {
        this.partialHistory.delete(subjectKey);
      }
    }
    this.trimPartialSubjects();
  }

  private trimPartialSubjects(): void {
    while (this.partialStreams.size > PARTIAL_SUBJECT_LIMIT) {
      const oldestSubject = this.partialStreams.keys().next().value as string | undefined;
      if (oldestSubject == null) break;
      this.partialStreams.delete(oldestSubject);
      this.partialHistory.delete(oldestSubject);
      this.restoredPartialSubjects.delete(oldestSubject);
    }
    while (this.partialHistory.size > PARTIAL_SUBJECT_LIMIT) {
      const oldestSubject = this.partialHistory.keys().next().value as string | undefined;
      if (oldestSubject == null) break;
      this.partialHistory.delete(oldestSubject);
    }
  }

  private partialTransition(
    previous: Snapshot | null,
  ): { diff: Vpws50Diff; displayDiff: Vpws50DisplayDiff | null } {
    const next = this.effectiveSnapshot() ?? { areas: new Map(), clearedPhenomena: new Map() };
    const isFirstReport = previous == null;
    const diffParts = isFirstReport
      ? { added: [], upgraded: [], downgraded: [], released: [] }
      : computeDiff(previous, next);
    const displayDiff = isFirstReport ? null : computeDisplayDiff(previous, next);
    const isUnchanged = !isFirstReport
      && diffParts.added.length === 0
      && diffParts.upgraded.length === 0
      && diffParts.downgraded.length === 0
      && diffParts.released.length === 0;
    if (!isUnchanged || isFirstReport) this.lastSuccessfulFullDisplayAt = new Date();
    return {
      diff: {
        isFirstReport,
        isUnchanged,
        isCancelRollback: false,
        shouldRecap: false,
        confidence: "confirmed",
        ...diffParts,
      },
      displayDiff,
    };
  }

  private effectiveSnapshot(
    baseOverride: Snapshot | null = this.current,
    baseIdentityOverride: WeatherReportIdentity | null = this.currentIdentity,
  ): Snapshot | null {
    let effective = baseOverride == null ? null : cloneSnapshot(baseOverride);
    const overlays = [...this.partialStreams.values()]
      .filter((entry) => baseIdentityOverride == null
        || (compareWeatherReportIdentity(entry.identity, baseIdentityOverride) ?? -1) > 0)
      .sort((a, b) => compareWeatherReportIdentity(a.identity, b.identity) ?? 0);
    for (const overlay of overlays) {
      effective ??= { areas: new Map(), clearedPhenomena: new Map() };
      for (const [areaCode, phenomenonKeys] of overlay.snapshot.clearedPhenomena) {
        const effectiveArea = effective.areas.get(areaCode);
        if (effectiveArea == null) continue;
        for (const phenomenonKey of phenomenonKeys) effectiveArea.kinds.delete(phenomenonKey);
        if (effectiveArea.kinds.size === 0) effective.areas.delete(areaCode);
      }
      for (const [areaCode, area] of overlay.snapshot.areas) {
        if (area.kinds.size === 0) continue;
        const effectiveArea = effective.areas.get(areaCode);
        if (effectiveArea == null) {
          effective.areas.set(areaCode, {
            areaName: area.areaName,
            kinds: new Map([...area.kinds].map(([key, kind]) => [key, { ...kind }])),
          });
          continue;
        }
        effectiveArea.areaName = area.areaName;
        for (const [phenomenonKey, kind] of area.kinds) {
          effectiveArea.kinds.set(phenomenonKey, { ...kind });
        }
      }
    }
    return effective;
  }

  /** revision gate を確定する前に、state を変更せず安全性だけを判定する。 */
  previewUnsafe(info: ParsedWeatherWarning): Vpws50Diff | null {
    const reason = this.unsafeReasonFor(infoToSnapshot(info), info);
    return reason == null ? null : this.buildUnsafeDiff(reason);
  }

  private unsafeReasonFor(
    newSnap: Snapshot | null,
    info?: ParsedWeatherWarning,
  ): "layer_missing" | "abnormal_release_rate" | null {
    if (newSnap == null) return "layer_missing";
    if (this.current == null) return null;
    let actualReleased = 0;
    for (const [areaCode, prevArea] of this.current.areas) {
      const currArea = newSnap.areas.get(areaCode);
      for (const phKey of prevArea.kinds.keys()) {
        if (currArea == null || !currArea.kinds.has(phKey)) actualReleased++;
      }
    }
    // 全解除は正当な一斉解除。残存 state があるときだけ、解除 Kind の完全性を確認する。
    const remaining = countAreaKeys(newSnap);
    return remaining > 0
      && actualReleased >= ABNORMAL_UNEXPLAINED_RELEASE_MIN
      && (info == null || !hasExplicitReleasesForAllMissing(info, this.current, newSnap))
      ? "abnormal_release_rate"
      : null;
  }

  rollback(target: string | WeatherReportIdentity): Vpws50Diff | null {
    if (!this.matchesCurrentReport(target)) {
      const identityText = typeof target === "string"
        ? `messageId=${target}`
        : `reportDateTime=${target.reportDateTime}, serial=${target.serial ?? ""}`;
      log.warn(`[vpws50-state] cancellation target does not match current report - ignored (${identityText})`);
      return null;
    }

    const last = this.history.pop();
    if (last == null) {
      this.current = null;
      this.currentMessageId = null;
      this.currentIdentity = null;
      return {
        isFirstReport: true,
        isUnchanged: false,
        isCancelRollback: true,
        shouldRecap: false,
        confidence: "confirmed",
        added: [], upgraded: [], downgraded: [], released: [],
      };
    }
    this.current = last.snapshot;
    this.currentMessageId = last.messageId;
    this.currentIdentity = last.identity;
    this.lastSuccessfulFullDisplayAt = new Date();
    return {
      isFirstReport: false,
      isUnchanged: false,
      isCancelRollback: true,
      shouldRecap: false,
      confidence: "confirmed",
      added: [], upgraded: [], downgraded: [], released: [],
      currentAreasForDisplay: this.buildCurrentAreasForDisplay(),
    };
  }

  private matchesCurrentReport(target: string | WeatherReportIdentity): boolean {
    if (typeof target === "string") {
      return this.current != null && target === this.currentMessageId;
    }
    if (this.current == null || this.currentIdentity == null) {
      return false;
    }
    return weatherReportIdentityEquals(target, this.currentIdentity);
  }

  /** 共通 revision gate が対象一致を確認した後に、一つ前の完全 snapshot へ戻す。 */
  restorePrevious(): Vpws50Diff {
    const last = this.history.pop();
    if (last == null) {
      this.current = null;
      this.currentMessageId = null;
      this.currentIdentity = null;
      return {
        isFirstReport: true, isUnchanged: false, isCancelRollback: true,
        shouldRecap: false, confidence: "confirmed",
        added: [], upgraded: [], downgraded: [], released: [],
      };
    }
    this.current = last.snapshot;
    this.currentMessageId = last.messageId;
    this.currentIdentity = last.identity;
    this.lastSuccessfulFullDisplayAt = new Date();
    return {
      isFirstReport: false, isUnchanged: false, isCancelRollback: true,
      shouldRecap: false, confidence: "confirmed",
      added: [], upgraded: [], downgraded: [], released: [],
      currentAreasForDisplay: this.buildCurrentAreasForDisplay(),
    };
  }

  exportPersistedState(): PersistedVpws50StateV2 {
    return {
      current: this.current == null || this.currentIdentity == null ? null : {
        messageId: this.currentMessageId ?? "",
        identity: { ...this.currentIdentity },
        snapshot: serializeSnapshot(this.current),
      },
      history: this.history.map((entry) => ({
        messageId: entry.messageId,
        identity: entry.identity == null ? null : { ...entry.identity },
        snapshot: serializeSnapshot(entry.snapshot),
      })),
      ...(this.partialStreams.size === 0 ? {} : {
        partialStreams: [...this.partialStreams].map(([subjectKey, entry]) => ({
          subjectKey,
          messageId: entry.messageId,
          identity: { ...entry.identity },
          snapshot: serializeSnapshot(entry.snapshot),
        })),
      }),
      ...(this.partialHistory.size === 0 ? {} : {
        partialHistory: [...this.partialHistory].map(([subjectKey, entries]) => ({
          subjectKey,
          entries: entries.map((entry) => ({
            messageId: entry.messageId,
            identity: { ...entry.identity },
            snapshot: serializeSnapshot(entry.snapshot),
          })),
        })),
      }),
      ...(this.restoredPartialSubjects.size === 0 ? {} : {
        restoredPartialSubjects: [...this.restoredPartialSubjects],
      }),
      ...(this.emergencyClearWatermarks.size === 0 ? {} : {
        emergencyClearWatermarks: [...this.emergencyClearWatermarks].map(([subjectKey, identity]) => ({
          subjectKey,
          identity: { ...identity },
        })),
      }),
      lastSuccessfulFullDisplayAt: this.lastSuccessfulFullDisplayAt?.toISOString() ?? null,
    };
  }

  restorePersistedState(state: PersistedVpws50StateV2): void {
    if (!isPersistedState(state)) {
      log.warn("[vpws50-state] persisted snapshot is incompatible; discarding it");
      this.current = null;
      this.currentMessageId = null;
      this.currentIdentity = null;
      this.history = [];
      this.partialStreams.clear();
      this.partialHistory.clear();
      this.restoredPartialSubjects.clear();
      this.emergencyClearWatermarks.clear();
      this.lastSuccessfulFullDisplayAt = null;
      return;
    }
    this.current = state.current == null ? null : restoreSnapshot(state.current.snapshot);
    this.currentMessageId = state.current?.messageId ?? null;
    this.currentIdentity = state.current == null ? null : { ...state.current.identity };
    this.history = state.history.slice(-HISTORY_DEPTH).map((entry) => ({
      messageId: entry.messageId,
      identity: entry.identity == null ? null : { ...entry.identity },
      snapshot: restoreSnapshot(entry.snapshot),
    }));
    this.partialStreams = new Map((state.partialStreams ?? []).map((entry) => [entry.subjectKey, {
      messageId: entry.messageId,
      identity: { ...entry.identity },
      snapshot: restoreSnapshot(entry.snapshot),
    }]));
    this.partialHistory = new Map((state.partialHistory ?? []).map((group) => [group.subjectKey,
      group.entries.slice(-HISTORY_DEPTH).map((entry) => ({
        messageId: entry.messageId,
        identity: { ...entry.identity },
        snapshot: restoreSnapshot(entry.snapshot),
      })),
    ]));
    const partialSubjects = new Set(this.partialStreams.keys());
    this.restoredPartialSubjects = new Set((state.restoredPartialSubjects ?? [])
      .filter((subject) => partialSubjects.has(subject)));
    this.emergencyClearWatermarks.clear();
    for (const entry of (state.emergencyClearWatermarks ?? []).slice(-PARTIAL_SUBJECT_LIMIT)) {
      const officeKey = normalizeWeatherOfficeWatermarkKey(entry.subjectKey);
      if (officeKey == null) continue;
      const current = this.emergencyClearWatermarks.get(officeKey);
      if (current == null || (compareWeatherReportIdentity(entry.identity, current) ?? -1) > 0) {
        this.emergencyClearWatermarks.delete(officeKey);
        this.emergencyClearWatermarks.set(officeKey, { ...entry.identity });
      }
    }
    this.lastSuccessfulFullDisplayAt = state.lastSuccessfulFullDisplayAt == null
      ? null
      : new Date(state.lastSuccessfulFullDisplayAt);
  }

  private buildCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    const current = this.effectiveSnapshot();
    if (current == null) return undefined;
    const allAreas = new Set<string>();
    const specialAreas = new Set<string>();
    const warningAreas = new Set<string>();
    const advisoryAreas = new Set<string>();
    const byKindCode = new Map<string, Vpws50DisplayKindGroup>();
    for (const [areaCode, area] of current.areas) {
      for (const kind of area.kinds.values()) {
        allAreas.add(areaCode);
        // 旧 3 段カウント (サマリ行 特X/警Y/注Z 用の互換維持。Code 43/48/49 は severity=warning
        // なので警枠に入る。Task 7 (displaySeverity セクション化) 完了時に互換維持で確定 —
        // セクション側は ★ 危険警報 (L4) に独立する一方カウントは警枠のままで、見かけ上のズレは
        // 2026-06-12 目視ゲートでレビュー決定: 現状維持 (互換カウント確定))
        if (kind.severity === "specialWarning") specialAreas.add(areaCode);
        else if (kind.severity === "warning") warningAreas.add(areaCode);
        else if (kind.severity === "advisory") advisoryAreas.add(areaCode);
        let group = byKindCode.get(kind.kindCode);
        if (group == null) {
          group = {
            kindCode: kind.kindCode,
            kindShortName: shortKindName(kind.kindName),
            kindName: kind.kindName,
            displaySeverity: kind.displaySeverity,
            officialAlertLevel: kind.officialAlertLevel,
            areas: [],
          };
          byKindCode.set(kind.kindCode, group);
        }
        group.areas.push({ areaName: area.areaName, areaCode });
      }
    }
    const kinds = Array.from(byKindCode.values()).sort(
      (a, b) => DISPLAY_SEVERITY_RANK[b.displaySeverity] - DISPLAY_SEVERITY_RANK[a.displaySeverity],
    );
    return {
      totalAreas: allAreas.size,
      specialAreas: specialAreas.size,
      warningAreas: warningAreas.size,
      advisoryAreas: advisoryAreas.size,
      kinds,
    };
  }

  private buildUnsafeDiff(reason: "layer_missing" | "abnormal_release_rate"): Vpws50Diff {
    return {
      isFirstReport: false,
      isUnchanged: false,
      isCancelRollback: false,
      shouldRecap: false,
      confidence: "unsafe",
      unsafeReason: reason,
      added: [], upgraded: [], downgraded: [], released: [],
    };
  }

  /** 表示ディスプレイ用: 現在発表中の警報・注意報の集約ビュー (未受信なら undefined) */
  getCurrentAreasForDisplay(): Vpws50CurrentAreasForDisplay | undefined {
    return this.buildCurrentAreasForDisplay();
  }

  getCurrentIdentity(): WeatherReportIdentity | null {
    const identities = [
      ...(this.currentIdentity == null ? [] : [this.currentIdentity]),
      ...[...this.partialStreams.values()].map((entry) => entry.identity),
    ];
    const latest = identities.sort((a, b) => compareWeatherReportIdentity(b, a) ?? 0)[0];
    return latest == null ? null : { ...latest };
  }

  getDetail(): DetailSnapshotOf<"vpws50"> | null {
    const display = this.buildCurrentAreasForDisplay();
    if (display == null) return null;
    return { kind: "vpws50", display };
  }

  __test_setLastSuccessfulFullDisplayAt(d: Date | null): void {
    this.lastSuccessfulFullDisplayAt = d;
  }
  __test_getLastSuccessfulFullDisplayAt(): Date | null {
    return this.lastSuccessfulFullDisplayAt;
  }
}
