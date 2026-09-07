/**
 * 待機時 sweep ホットパス spec (docs/specs/2026-09-07-standby-sweep-hot-path.md) §4.1 の
 * 「大容量の合法状態を作る helper」。
 *
 * Pi 実機の永続 v2 は 7.08MB で、その内 VPWS50 holder が 5.9MB を占める
 * (history 2.17MB x 8 件 / partialHistory 3.07MB x 127 subject / partialStreams 0.39MB /
 * current 0.27MB)。実電文由来の状態ファイルはリポジトリに置けないので、同じ order of
 * magnitude の**合成された合法状態**をここで組み立てる。
 *
 * 生成は決定的 (乱数なし・添字から全フィールドを導出) にしてある。`npm run test:shuffle`
 * で実行順が変わっても同じ state が出る。
 */
import type {
  DisplaySeverity,
  OfficialAlertLevel,
  ResolutionSource,
  WeatherSeverity,
} from "../../src/types";
import type {
  PersistedVpws50KindV2,
  PersistedVpws50SnapshotV2,
  PersistedVpws50StateV2,
  Vpws50StateSnapshot,
} from "../../src/engine/messages/vpws50-state";
import type { WeatherReportIdentity } from "../../src/engine/messages/vpws50-state";
import { VPWS50_SNAPSHOT_GENERATION } from "../../src/engine/messages/vpws50-state";
import type { TelegramRevisionGateSnapshot } from "../../src/engine/messages/telegram-revision-gate";

/** 全国 base の subject key。`Vpws50StateHolder.retainActiveSubjects` が特別扱いする。 */
export const VPWS50_BASE_SUBJECT_KEY = "weather:vpws50";

/** partialStreams / partialHistory に載せる官署 stream の件数 (LRU 上限 128 の 1 つ下)。 */
export const LARGE_STATE_PARTIAL_SUBJECT_COUNT = 127;

/** 全国 base snapshot の区域数。1 区域あたり 3 現象を持たせる。 */
const BASE_AREA_COUNT = 450;
const BASE_KINDS_PER_AREA = 3;
/** 官署別部分報 1 通あたりの区域数。 */
const PARTIAL_AREA_COUNT = 5;
const PARTIAL_KINDS_PER_AREA = 3;
/** 全国 base の world history 段数と、官署 stream ごとの history 段数 (どちらも HISTORY_DEPTH)。 */
const HISTORY_DEPTH = 8;

const SEVERITIES: readonly WeatherSeverity[] = ["advisory", "warning", "specialWarning"];
const DISPLAY_SEVERITIES: readonly DisplaySeverity[] = [
  "nonLevelAdvisory",
  "nonLevelWarning",
  "officialL4",
];
const RESOLUTION_SOURCES: readonly ResolutionSource[] = ["map", "nameFallback", "unknown"];
const OFFICIAL_LEVELS: readonly (OfficialAlertLevel | null)[] = [null, 3, 4];

/** 実電文の区域名・現象名に近い長さの文字列を、添字から決定的に作る。 */
function paddedName(prefix: string, index: number): string {
  return `${prefix}${index.toString().padStart(6, "0")}` + "の区域及び周辺市町村";
}

function buildKinds(areaIndex: number, salt: number): PersistedVpws50KindV2[] {
  const kinds: PersistedVpws50KindV2[] = [];
  for (let kindIndex = 0; kindIndex < BASE_KINDS_PER_AREA; kindIndex++) {
    const rotate = (areaIndex + kindIndex + salt) % 3;
    kinds.push({
      phenomenonKey: `phenomenon:${(areaIndex * 7 + kindIndex) % 32}:${kindIndex}`,
      kindCode: (10 + ((areaIndex + kindIndex) % 40)).toString().padStart(2, "0"),
      kindName: `${paddedName("気象警報現象", areaIndex * 3 + kindIndex)}注意報`,
      severity: SEVERITIES[rotate]!,
      displaySeverity: DISPLAY_SEVERITIES[rotate]!,
      officialAlertLevel: OFFICIAL_LEVELS[rotate]!,
      resolutionSource: RESOLUTION_SOURCES[rotate]!,
    });
  }
  return kinds;
}

function buildSnapshot(
  areaCount: number,
  areaOffset: number,
  salt: number,
): PersistedVpws50SnapshotV2 {
  const areas: PersistedVpws50SnapshotV2["areas"] = [];
  for (let index = 0; index < areaCount; index++) {
    const areaIndex = areaOffset + index;
    areas.push({
      areaCode: (1_000_000 + areaIndex * 3).toString(),
      areaName: paddedName("観測対象", areaIndex),
      kinds: buildKinds(areaIndex, salt).slice(0, index % 2 === 0 ? BASE_KINDS_PER_AREA : PARTIAL_KINDS_PER_AREA),
    });
  }
  return { generation: VPWS50_SNAPSHOT_GENERATION, areas };
}

/** ISO 文字列は `new Date(x).toISOString()` を通しても一致する形にしておく (復元が可逆)。 */
function isoAt(baseMs: number, offsetMs: number): string {
  return new Date(baseMs + offsetMs).toISOString();
}

function identityAt(baseMs: number, offsetMs: number, serial: string | null): WeatherReportIdentity {
  return { reportDateTime: isoAt(baseMs, offsetMs), serial };
}

/** 官署別部分報の subject key。`weatherOfficeStreamKey` と同じ形にする。 */
export function largeStatePartialSubjectKey(index: number): string {
  return `weather:VPWW55:大容量試験官署${index.toString().padStart(3, "0")}`;
}

export function largeStatePartialSubjectKeys(): string[] {
  return Array.from(
    { length: LARGE_STATE_PARTIAL_SUBJECT_COUNT },
    (_value, index) => largeStatePartialSubjectKey(index),
  );
}

/** VPWS50 gate が active に保つべき subject 集合 (全国 base + 官署 stream)。 */
export function largeStateVpws50Subjects(): string[] {
  return [VPWS50_BASE_SUBJECT_KEY, ...largeStatePartialSubjectKeys()];
}

/**
 * 5MB 級の合法 VPWS50 保存状態を組み立てる。
 *
 * `exportPersistedState()` が省略する空フィールドは入力側でも省略し、フィールド順も
 * export と揃える。`Vpws50StateHolder.fromSnapshot(...).cloneSnapshot()` が入力と
 * canonical 一致する (= `assertLosslessOwnerSnapshot` を通る) ことが helper の契約。
 */
export function buildLargeVpws50PersistedState(baseMs: number): PersistedVpws50StateV2 {
  const partialSubjectKeys = largeStatePartialSubjectKeys();
  return {
    current: {
      messageId: "vpws50-large-current",
      identity: identityAt(baseMs, 0, "1"),
      snapshot: buildSnapshot(BASE_AREA_COUNT, 0, 0),
    },
    history: Array.from({ length: HISTORY_DEPTH }, (_value, index) => ({
      messageId: `vpws50-large-history-${index}`,
      identity: identityAt(baseMs, -(HISTORY_DEPTH - index) * 600_000, String(index + 1)),
      snapshot: buildSnapshot(BASE_AREA_COUNT, index * 11, index + 1),
    })),
    partialStreams: partialSubjectKeys.map((subjectKey, index) => ({
      subjectKey,
      messageId: `vpww55-large-stream-${index}`,
      // 全国 base より新しい identity にして overlay を active に保つ。
      identity: identityAt(baseMs, 60_000 + index * 1_000, "1"),
      snapshot: buildSnapshot(PARTIAL_AREA_COUNT, 3_000 + index * PARTIAL_AREA_COUNT, index),
    })),
    partialHistory: partialSubjectKeys.map((subjectKey, index) => ({
      subjectKey,
      entries: Array.from({ length: HISTORY_DEPTH }, (_value, entryIndex) => ({
        messageId: `vpww55-large-history-${index}-${entryIndex}`,
        identity: identityAt(
          baseMs,
          60_000 + index * 1_000 - (HISTORY_DEPTH - entryIndex) * 60,
          String(entryIndex + 1),
        ),
        snapshot: buildSnapshot(
          PARTIAL_AREA_COUNT,
          3_000 + index * PARTIAL_AREA_COUNT + entryIndex,
          index + entryIndex,
        ),
      })),
    })),
    lastSuccessfulFullDisplayAt: isoAt(baseMs, 0),
  };
}

export function buildLargeVpws50Snapshot(baseMs: number, version = 1): Vpws50StateSnapshot {
  return { version, state: buildLargeVpws50PersistedState(baseMs) };
}

/**
 * 大容量 VPWS50 state を「sweep しても変化しない」状態に保つ gate snapshot。
 *
 * VPWS50 family の active entry は `activeRetentionMs` を持たない (policy に無い) ので
 * lifecycle 期限では消えない。tombstone (cancelled) は作らない。
 */
export function buildLargeVpws50GateSnapshot(
  baseMs: number,
  version = 1,
): TelegramRevisionGateSnapshot {
  return {
    version,
    states: largeStateVpws50Subjects().map((subjectKey, index) => ({
      key: `weather:VPWS50:${subjectKey}`,
      comparison: {
        stateSubjectKey: subjectKey,
        revision: {
          eventId: { raw: null, value: null, valid: false },
          type: { raw: "VPWS50", value: "VPWS50", valid: true },
          reportDateTime: {
            raw: isoAt(baseMs, index),
            epochMs: baseMs + index,
            valid: true,
          },
          serial: { raw: "1", numeric: 1, valid: true },
          infoType: { raw: "発表", value: "発表", valid: true },
        },
      },
      semanticKeys: [`発表:${subjectKey}`],
      cancelled: false,
      acceptedAtMs: baseMs,
      durable: true,
      tombstoneRetentionMs: 7 * 24 * 60 * 60_000,
      retainForFamilyCapacity: false,
      legacyRevisionKey: subjectKey,
      legacyRevisionKeyProvenance: "codeFallback",
    })),
    transientStates: [],
    transientSemanticKeys: [],
    warnedFamilyCapacity: [],
  };
}
