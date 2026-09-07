/**
 * 待機時 sweep ホットパス spec §3.1.3 の双方向不変条件テスト (A5 / A6)。
 *
 * - **前進**: 保存状態 (旧実装と同じ指紋) が変わったなら `version()` は必ず進む
 * - **不動**: 保存状態が変わらないなら `version()` は進んではならない
 *
 * 過剰 bump は §3.3 の事前判定を毎周期無効化するので、取りこぼしと同じ重大度で扱う。
 *
 * 指紋は `cloneSnapshot()` から `version` を落としたもの。5 owner とも
 * `cloneSnapshot()` の中身は旧 `refreshOwnerVersion()` / `refreshVersion()` が
 * JSON 化していた集合と一致する (vpws50/vpww56 は `exportPersistedState()`、
 * standby は `snapshotData()`、tsunami / flood は snapshot の全フィールド)。
 *
 * A6 の網羅チェックは `Object.getOwnPropertyNames(Klass.prototype)` を表と突き合わせる。
 * 表に無い prototype メソッドが増えたら失敗する。
 */
import { describe, it, expect } from "vitest";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { computeMaxDisplaySeverity, computeMaxSoundLevel } from "../../../src/dmdata/weather-warning-level";
import { createTelegramMeta } from "../../../src/dmdata/telegram-meta";
import { canonicalizeLegacyTsunamiInfo } from "../../../src/dmdata/tsunami-legacy-adapter";
import { parseWeatherBriefing } from "../../../src/dmdata/briefing-parser";
import { parseTyphoonProbability } from "../../../src/dmdata/typhoon-probability-parser";
import {
  finalizeTyphoonProbabilityClassification,
  projectTyphoonProbability,
} from "../../../src/engine/display/project-typhoon-probability";
import {
  createVptaRouterOwnerToken,
  withVptaRouterOwnerToken,
  type VptaDisplayIngestCommand,
} from "../../../src/engine/display/types";
import type { VptaAcceptedCommit } from "../../../src/engine/messages/telegram-revision-gate";
import type { DisplayWeatherAlertV1 } from "../../../src/engine/display/protocol";
import type { VolcanoHolderSnapshot } from "../../../src/engine/messages/volcano-state";
import type {
  ParsedHeatAlertInfo,
  ParsedTsunamiInfo,
  ParsedWeatherWarning,
  TsunamiObservationStation,
  WeatherItem,
} from "../../../src/types";
import type { PresentationEvent } from "../../../src/engine/presentation/types";
import { testTelegramMeta } from "../../helpers/telegram-meta";
import { createMockWsDataMessage, FIXTURE_VPTA50_DAMREY } from "../../helpers/mock-message";
import {
  buildLargeVpws50Snapshot,
  largeStatePartialSubjectKey,
  largeStateVpws50Subjects,
  VPWS50_BASE_SUBJECT_KEY,
} from "../../helpers/standby-sweep-large-state";
import { DEADLINE_BASE_MS } from "../../helpers/standby-sweep-deadline-state";

interface VersionedOwner {
  version(): number;
  cloneSnapshot(): { version: number };
}

function fingerprintOf(owner: VersionedOwner): string {
  return JSON.stringify(
    { ...owner.cloneSnapshot(), version: 0 },
    (_key, child: unknown) => {
      if (child instanceof Map) return { $map: [...child] };
      if (child instanceof Set) return { $set: [...child] };
      return child;
    },
  );
}

/**
 * 表の 1 行。`run` を持つ行は双方向不変条件を実際に走らせる。
 * `run` を持たない行は「読み取り専用」「private 内部ヘルパ」「restore 契約」のいずれかで、
 * A6 の網羅チェックにだけ効く。
 */
interface MethodRow<T> {
  method: string;
  /** 同一メソッドを複数条件で試すときの識別子 (失敗メッセージ用)。 */
  label?: string;
  kind: "mutating" | "readonly" | "internal" | "restore";
  /** 実行して不変条件を確認する。省略時は理由を `note` に書く。 */
  run?: (holder: T) => void;
  note?: string;
}

function assertPrototypeCoverage<T>(
  prototype: object,
  rows: readonly MethodRow<T>[],
  label: string,
): void {
  const actual = Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== "constructor")
    .sort();
  // 同じメソッドを「変化あり」「変化なし」の 2 行で載せることがあるので重複を畳む。
  const declared = [...new Set(rows.map((row) => row.method))].sort();
  expect(actual, `${label}: prototype メソッド集合が表とずれている`).toEqual(declared);
}

function assertBidirectional<T extends VersionedOwner>(
  label: string,
  rows: readonly MethodRow<T>[],
  makeHolder: () => T,
): void {
  for (const row of rows) {
    if (row.run == null) continue;
    const holder = makeHolder();
    const name = row.label == null ? row.method : `${row.method}(${row.label})`;
    const fingerprintBefore = fingerprintOf(holder);
    const versionBefore = holder.version();
    row.run(holder);
    const fingerprintAfter = fingerprintOf(holder);
    const versionAfter = holder.version();
    const fingerprintChanged = fingerprintBefore !== fingerprintAfter;
    const versionAdvanced = versionAfter > versionBefore;
    expect(versionAfter, `${label}.${name}: version が後退した`)
      .toBeGreaterThanOrEqual(versionBefore);
    if (row.kind === "readonly") {
      expect(fingerprintChanged, `${label}.${name}: 読み取り専用のはずが state を変えた`)
        .toBe(false);
    }
    expect(
      versionAdvanced,
      `${label}.${name}: 指紋変化=${fingerprintChanged} なのに version 前進=${versionAdvanced}`,
    ).toBe(fingerprintChanged);
  }
}

// ── VPWS50 ───────────────────────────────────────────────────────────────────

function weatherReport(reportDateTime: string, areaCode: string): ParsedWeatherWarning {
  const items: WeatherItem[] = [{
    areaName: "検査区域",
    areaCode,
    kinds: [{ name: "大雨警報", code: "03", severity: "warning" }],
    statuses: [],
  }];
  const layers = [{ type: "気象警報・注意報（府県予報区等）", items }];
  return {
    meta: testTelegramMeta(false),
    type: "VPWS50",
    infoType: "発表",
    title: "気象警報・注意報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    editorialOffice: "気象庁",
    controlTitle: "気象警報・注意報",
    layers,
    comments: [],
    maxSeverity: "warning",
    maxDisplaySeverity: computeMaxDisplaySeverity(layers),
    maxSoundLevel: computeMaxSoundLevel(layers),
    warningAreaCount: 1,
    advisoryAreaCount: 0,
    isTest: false,
  };
}

const VPWS50_ROWS: readonly MethodRow<Vpws50StateHolder>[] = [
  { method: "mutationFingerprint", kind: "internal", note: "mutation 入口の指紋。読み取り経路からは呼ばない" },
  { method: "bumpIfChanged", kind: "internal", note: "mutation 入口を包む owner version の choke point" },
  { method: "hasDueSweepWork", kind: "readonly", run: (h) => void h.hasDueSweepWork(DEADLINE_BASE_MS) },
  { method: "rollbackInternal", kind: "internal", note: "rollback の実体 (bumpIfChanged の内側)" },
  { method: "restorePreviousInternal", kind: "internal", note: "restorePrevious の実体" },
  { method: "restorePersistedStateInternal", kind: "internal", note: "restorePersistedState の実体" },
  { method: "version", kind: "readonly", run: (h) => void h.version() },
  { method: "cloneSnapshot", kind: "readonly", run: (h) => void h.cloneSnapshot() },
  {
    method: "replacePrevalidated",
    kind: "restore",
    note: "commit 経路。gate / volcano と同じく version を必ず 1 進める復元契約 (§3.1 の incremental 方式)",
  },
  { method: "loadSnapshot", kind: "internal", note: "fromSnapshot / replacePrevalidated の実体" },
  {
    method: "diffAndUpdate",
    kind: "mutating",
    run: (h) => void h
      .diffAndUpdate(weatherReport("2026-09-08T00:00:00Z", "1000005"), "m-new"),
  },
  {
    method: "diffAndUpdateWithDisplay",
    kind: "mutating",
    run: (h) => void h.diffAndUpdateWithDisplay(
      weatherReport("2026-09-08T01:00:00Z", "1000008"),
      "m-new-2",
      { reportDateTime: "2026-09-08T01:00:00Z", serial: "1" },
    ),
  },
  { method: "diffAndUpdateInternal", kind: "internal", note: "diffAndUpdate 系の実体" },
  { method: "applyStaleResync", kind: "internal", note: "diffAndUpdateInternal の分岐" },
  { method: "prunePartialLedgersOlderThanBase", kind: "internal", note: "受理経路と復元経路の内側" },
  {
    method: "mergePartialWithDisplay",
    kind: "mutating",
    run: (h) => void h.mergePartialWithDisplay(
      weatherReport("2026-09-08T02:00:00Z", "1000011"),
      "m-partial",
      { reportDateTime: "2026-09-08T02:00:00Z", serial: "1" },
      largeStatePartialSubjectKey(0),
    ),
  },
  {
    method: "clearPartial",
    kind: "mutating",
    run: (h) => void h
      .clearPartial(largeStatePartialSubjectKey(1)),
  },
  {
    method: "restorePreviousPartial",
    kind: "mutating",
    run: (h) => void h
      .restorePreviousPartial(largeStatePartialSubjectKey(2)),
  },
  {
    method: "clearEmergencyPartialAreas",
    kind: "mutating",
    run: (h) => void h.clearEmergencyPartialAreas(
      "weather:office:大容量試験官署003",
      ["1000005"],
      { reportDateTime: "2026-09-08T03:00:00Z", serial: "1" },
    ),
  },
  {
    method: "retainActivePartialSubjects",
    kind: "mutating",
    run: (h) => h
      .retainActivePartialSubjects(largeStateVpws50Subjects().slice(0, 60)),
  },
  {
    method: "retainActiveSubjects",
    kind: "mutating",
    run: (h) => void h
      .retainActiveSubjects(largeStateVpws50Subjects().slice(0, 40)),
  },
  { method: "activePartialSubjects", kind: "readonly", run: (h) => void h.activePartialSubjects() },
  { method: "trimPartialSubjects", kind: "internal", note: "partial 系 mutator の内側" },
  { method: "partialTransition", kind: "internal", note: "partial 系 mutator の内側" },
  { method: "effectiveSnapshot", kind: "internal", note: "表示合成 (読み取り専用)" },
  { method: "applyEmergencyClearTombstones", kind: "internal", note: "引数の snapshot だけを変える" },
  {
    method: "previewUnsafe",
    kind: "readonly",
    run: (h) => void h
      .previewUnsafe(weatherReport("2026-09-08T00:00:00Z", "1000005")),
  },
  { method: "classifyUpdate", kind: "internal", note: "判定のみ" },
  { method: "unsafeReasonFor", kind: "internal", note: "判定のみ" },
  {
    method: "rollback",
    kind: "mutating",
    run: (h) => void h.rollback("vpws50-large-current"),
  },
  { method: "matchesCurrentReport", kind: "internal", note: "判定のみ" },
  {
    method: "restorePrevious",
    kind: "mutating",
    run: (h) => void h.restorePrevious(),
  },
  { method: "exportPersistedState", kind: "readonly", run: (h) => void h.exportPersistedState() },
  {
    method: "restorePersistedState",
    kind: "mutating",
    run: (h) => h.restorePersistedState({
      current: null,
      history: [],
      lastSuccessfulFullDisplayAt: null,
    }),
  },
  { method: "buildCurrentAreasForDisplay", kind: "internal", note: "表示投影のみ" },
  { method: "buildUnsafeDiff", kind: "internal", note: "純関数" },
  { method: "getCurrentAreasForDisplay", kind: "readonly", run: (h) => void h.getCurrentAreasForDisplay() },
  { method: "getCurrentIdentity", kind: "readonly", run: (h) => void h.getCurrentIdentity() },
  { method: "getDetail", kind: "readonly", run: (h) => void h.getDetail() },
  {
    method: "__test_setLastSuccessfulFullDisplayAt",
    kind: "mutating",
    run: (h) => h
      .__test_setLastSuccessfulFullDisplayAt(new Date(DEADLINE_BASE_MS + 999)),
  },
  {
    method: "__test_getLastSuccessfulFullDisplayAt",
    kind: "readonly",
    run: (h) => void h.__test_getLastSuccessfulFullDisplayAt(),
  },
];

describe("§3.1.3 Vpws50StateHolder の owner version 不変条件", () => {
  const makeHolder = () => Vpws50StateHolder.fromSnapshot(buildLargeVpws50Snapshot(DEADLINE_BASE_MS));

  it("A6: prototype メソッドが表に全て載っている", () => {
    assertPrototypeCoverage(
      Vpws50StateHolder.prototype,
      VPWS50_ROWS,
      "Vpws50StateHolder",
    );
  });

  it("A5: 指紋変化 ⟺ version 前進 が双方向で成立する", () => {
    assertBidirectional("Vpws50StateHolder", VPWS50_ROWS, makeHolder);
  });

  it("A5(不動): 何も消さない retainActiveSubjects は version を進めない", () => {
    const holder = makeHolder();
    const before = holder.version();
    expect(holder.retainActiveSubjects(largeStateVpws50Subjects())).toBe(false);
    expect(holder.version()).toBe(before);
  });

  it("version() と cloneSnapshot() は state を読むだけで version を動かさない", () => {
    const holder = makeHolder();
    const first = holder.version();
    holder.cloneSnapshot();
    holder.version();
    holder.cloneSnapshot();
    expect(holder.version()).toBe(first);
  });

  it("replacePrevalidated は復元契約どおり version を 1 進める", () => {
    const holder = makeHolder();
    const before = holder.version();
    holder.replacePrevalidated(holder.cloneSnapshot());
    expect(holder.version()).toBe(before + 1);
  });
});

// ── VPWW56 ───────────────────────────────────────────────────────────────────

const VPWW56_VIEW = {
  totalAreas: 1,
  specialAreas: 0,
  warningAreas: 1,
  advisoryAreas: 0,
  kinds: [{
    kindCode: "03",
    kindShortName: "大雨",
    kindName: "大雨警報",
    displaySeverity: "nonLevelWarning" as const,
    officialAlertLevel: null,
    areas: [{ areaName: "検査区域", areaCode: "1000005" }],
  }],
};

function vpww56Snapshot() {
  return {
    version: 3,
    state: {
      generation: 1 as const,
      streams: [
        { generation: 1 as const, subjectKey: "weather:VPWW56:官署A", view: VPWW56_VIEW },
        { generation: 1 as const, subjectKey: "weather:VPWW56:官署B", view: VPWW56_VIEW },
      ],
      pendingSubjects: ["weather:VPWW56:官署C"],
    },
  };
}

const VPWW56_ROWS: readonly MethodRow<Vpww56StateHolder>[] = [
  { method: "mutationFingerprint", kind: "internal", note: "mutation 入口の指紋。読み取り経路からは呼ばない" },
  { method: "bumpIfChanged", kind: "internal", note: "mutation 入口を包む owner version の choke point" },
  { method: "hasDueSweepWork", kind: "readonly", run: (h) => void h.hasDueSweepWork(DEADLINE_BASE_MS) },
  { method: "restorePersistedStateInternal", kind: "internal", note: "restorePersistedState の実体" },
  { method: "version", kind: "readonly", run: (h) => void h.version() },
  { method: "cloneSnapshot", kind: "readonly", run: (h) => void h.cloneSnapshot() },
  { method: "replacePrevalidated", kind: "restore", note: "復元契約 (version を 1 進める)" },
  { method: "loadSnapshot", kind: "internal", note: "fromSnapshot / replacePrevalidated の実体" },
  {
    method: "applyAccepted",
    kind: "mutating",
    run: (h) => h
      .applyAccepted(weatherReport("2026-09-08T00:00:00Z", "1000005"), "weather:VPWW56:官署D"),
  },
  {
    method: "clearSubject",
    kind: "mutating",
    run: (h) => h.clearSubject("weather:VPWW56:官署A"),
  },
  {
    method: "update",
    kind: "mutating",
    run: (h) => void h
      .update(weatherReport("2026-09-08T00:00:00Z", "1000005")),
  },
  { method: "getCurrentAreasForDisplay", kind: "readonly", run: (h) => void h.getCurrentAreasForDisplay() },
  { method: "trackedStreamCount", kind: "readonly", run: (h) => void h.trackedStreamCount() },
  { method: "activeSubjectKeys", kind: "readonly", run: (h) => void h.activeSubjectKeys() },
  { method: "pendingSubjectKeys", kind: "readonly", run: (h) => void h.pendingSubjectKeys() },
  {
    method: "retainActiveSubjects",
    kind: "mutating",
    run: (h) => void h
      .retainActiveSubjects(["weather:VPWW56:官署A"]),
  },
  { method: "exportPersistedState", kind: "readonly", run: (h) => void h.exportPersistedState() },
  {
    method: "restorePersistedState",
    kind: "mutating",
    run: (h) => h
      .restorePersistedState({ generation: 1, streams: [], pendingSubjects: [] }),
  },
  { method: "buildUnion", kind: "internal", note: "表示 union の構築 (unionCache は保存状態でない)" },
];

describe("§3.1.3 Vpww56StateHolder の owner version 不変条件", () => {
  const makeHolder = () => Vpww56StateHolder.fromSnapshot(vpww56Snapshot());

  it("A6: prototype メソッドが表に全て載っている", () => {
    assertPrototypeCoverage(Vpww56StateHolder.prototype, VPWW56_ROWS, "Vpww56StateHolder");
  });

  it("A5: 指紋変化 ⟺ version 前進 が双方向で成立する", () => {
    assertBidirectional("Vpww56StateHolder", VPWW56_ROWS, makeHolder);
  });

  it("A5(不動): 全 subject を保つ retainActiveSubjects は version を進めない", () => {
    const holder = makeHolder();
    const before = holder.version();
    expect(holder.retainActiveSubjects([
      "weather:VPWW56:官署A",
      "weather:VPWW56:官署B",
      "weather:VPWW56:官署C",
    ])).toBe(false);
    expect(holder.version()).toBe(before);
  });

  it("A5(不動): 存在しない subject の clearSubject は version を進めない", () => {
    const holder = makeHolder();
    const before = holder.version();
    holder.clearSubject("weather:VPWW56:未知官署");
    expect(holder.version()).toBe(before);
  });
});

// ── FloodForecastStateHolder ────────────────────────────────────────────────

function floodSnapshot() {
  return {
    version: 5,
    events: [
      {
        eventId: "flood-a",
        lastSeenMs: DEADLINE_BASE_MS,
        stations: [] as Array<[string, never]>,
      },
      {
        eventId: "flood-b",
        lastSeenMs: DEADLINE_BASE_MS,
        stations: [] as Array<[string, never]>,
      },
    ],
  };
}

const FLOOD_ROWS: readonly MethodRow<FloodForecastStateHolder>[] = [
  { method: "mutationFingerprint", kind: "internal", note: "mutation 入口の指紋。読み取り経路からは呼ばない" },
  { method: "bumpIfChanged", kind: "internal", note: "mutation 入口を包む owner version の choke point" },
  { method: "diffAndUpdateInternal", kind: "internal", note: "diffAndUpdate の実体" },
  { method: "version", kind: "readonly", run: (h) => void h.version() },
  { method: "cloneSnapshot", kind: "readonly", run: (h) => void h.cloneSnapshot() },
  { method: "replacePrevalidated", kind: "restore", note: "復元契約 (version を 1 進める)" },
  { method: "loadSnapshot", kind: "internal", note: "fromSnapshot / replacePrevalidated の実体" },
  {
    method: "diffAndUpdate",
    kind: "mutating",
    run: (h) => void h
      .diffAndUpdate("flood-c", [], null, DEADLINE_BASE_MS),
  },
  {
    method: "touch",
    kind: "mutating",
    run: (h) => h
      .touch("flood-a", DEADLINE_BASE_MS + 1_000),
  },
  {
    method: "rollback",
    kind: "mutating",
    run: (h) => h.rollback("flood-a"),
  },
  {
    method: "retainActiveEventIds",
    kind: "mutating",
    run: (h) => h.retainActiveEventIds(["flood-a"]),
  },
  { method: "activeEventIds", kind: "readonly", run: (h) => void h.activeEventIds() },
  {
    method: "sweep",
    kind: "mutating",
    run: (h) => void h
      .sweep(DEADLINE_BASE_MS + 40 * 24 * 60 * 60_000),
  },
  { method: "hasDueSweepWork", kind: "readonly", run: (h) => void h.hasDueSweepWork(DEADLINE_BASE_MS) },
  { method: "sweepExpired", kind: "internal", note: "sweep / diffAndUpdate / touch の内側" },
];

describe("§3.1.3 FloodForecastStateHolder の owner version 不変条件", () => {
  const makeHolder = () => FloodForecastStateHolder.fromSnapshot(floodSnapshot());

  it("A6: prototype メソッドが表に全て載っている", () => {
    assertPrototypeCoverage(FloodForecastStateHolder.prototype, FLOOD_ROWS, "FloodForecastStateHolder");
  });

  it("A5: 指紋変化 ⟺ version 前進 が双方向で成立する", () => {
    assertBidirectional("FloodForecastStateHolder", FLOOD_ROWS, makeHolder);
  });

  it("A5(不動): 期限未到来の sweep と全件 retain は version を進めない", () => {
    const holder = makeHolder();
    const before = holder.version();
    expect(holder.sweep(DEADLINE_BASE_MS + 1_000)).toBe(false);
    holder.retainActiveEventIds(["flood-a", "flood-b"]);
    holder.touch("unknown-event", DEADLINE_BASE_MS + 1_000);
    holder.rollback("unknown-event");
    expect(holder.version()).toBe(before);
  });
});

// ── TsunamiStateHolder ──────────────────────────────────────────────────────

function tsunamiInfo(
  reportDateTime: string,
  infoType: "発表" | "訂正" | "取消",
  kind = "津波警報",
  eventId = "tsunami-a",
): ParsedTsunamiInfo {
  const meta = createTelegramMeta({
    messageId: `${infoType}:${reportDateTime}:${kind}`,
    eventId,
    type: "VTSE41",
    reportDateTime,
    serial: null,
    infoType,
    receivedAtMs: Date.parse(reportDateTime) || 1,
    status: "通常",
    isTest: false,
  });
  return canonicalizeLegacyTsunamiInfo({
    meta,
    type: "VTSE41",
    infoType,
    title: "津波警報・注意報・予報",
    reportDateTime,
    headline: null,
    publishingOffice: "気象庁",
    forecast: infoType === "取消" ? [] : [{
      areaCode: "210",
      areaName: "岩手県",
      kindCode: kind === "津波注意報" ? "62" : "51",
      kind,
      maxHeightDescription: "3m",
      firstHeight: "到達中と推測",
    }],
    warningComment: "",
    isTest: false,
  });
}

function observationStation(name: string, code: string): TsunamiObservationStation {
  return {
    areaName: "岩手県",
    areaCode: "210",
    stationCode: code,
    name,
    sensor: "検潮所",
    arrivalTime: "2026-09-07T00:10:00+09:00",
    initial: "押し",
    maxHeightCondition: "",
    maxHeightValue: "0.3m",
    maxHeight: {
      raw: "0.3",
      value: 0.3,
      condition: null,
      description: "0.3m",
      presence: "value",
    },
  };
}

/** 発表 1 通と観測 1 点を積んだ holder。no-op 側の判定に実体が必要。 */
function seededTsunamiHolder(): TsunamiStateHolder {
  const holder = new TsunamiStateHolder();
  holder.applyAccepted(tsunamiInfo("2026-09-07T00:00:00+09:00", "発表"));
  holder.applyAcceptedObservations("VTSE51", [observationStation("宮古", "0001")]);
  return holder;
}

const TSUNAMI_ROWS: readonly MethodRow<TsunamiStateHolder>[] = [
  { method: "mutationFingerprint", kind: "internal", note: "mutation 入口の指紋。読み取り経路からは呼ばない" },
  { method: "bumpIfChanged", kind: "internal", note: "mutation 入口を包む owner version の choke point" },
  { method: "retainedSubjectFingerprint", kind: "internal", note: "retainActiveEventIds の戻り値専用 (保持対象 3 集合)" },
  { method: "version", kind: "readonly", run: (h) => void h.version() },
  { method: "cloneSnapshot", kind: "readonly", run: (h) => void h.cloneSnapshot() },
  { method: "hasDueSweepWork", kind: "readonly", run: (h) => void h.hasDueSweepWork(DEADLINE_BASE_MS) },
  { method: "replacePrevalidated", kind: "restore", note: "復元契約 (version を 1 進める)" },
  { method: "loadSnapshot", kind: "internal", note: "fromSnapshot / replacePrevalidated の実体" },
  {
    method: "applyAccepted",
    label: "変化あり",
    kind: "mutating",
    run: (h) => h.applyAccepted(tsunamiInfo("2026-09-07T01:00:00+09:00", "発表", "大津波警報")),
  },
  {
    method: "applyAccepted",
    label: "同一報の再適用",
    kind: "mutating",
    run: (h) => h.applyAccepted(tsunamiInfo("2026-09-07T00:00:00+09:00", "発表")),
  },
  { method: "applyAcceptedInternal", kind: "internal", note: "applyAccepted の実体" },
  {
    method: "clearAccepted",
    label: "変化あり",
    kind: "mutating",
    run: (h) => h.clearAccepted(tsunamiInfo("2026-09-07T02:00:00+09:00", "取消")),
  },
  {
    method: "clearAccepted",
    label: "未知 EventID",
    kind: "mutating",
    run: (h) => h.clearAccepted(tsunamiInfo("2026-09-07T02:00:00+09:00", "取消", "津波警報", "unknown-event")),
  },
  { method: "clearAcceptedInternal", kind: "internal", note: "clearAccepted の実体" },
  {
    method: "applyAcceptedObservations",
    label: "変化あり",
    kind: "mutating",
    run: (h) => void h.applyAcceptedObservations("VTSE52", [observationStation("釜石", "0002")]),
  },
  {
    method: "applyAcceptedObservations",
    label: "同一観測点の再適用",
    kind: "mutating",
    run: (h) => void h.applyAcceptedObservations("VTSE51", [observationStation("宮古", "0001")]),
  },
  { method: "applyAcceptedObservationsInternal", kind: "internal", note: "applyAcceptedObservations の実体" },
  { method: "clearActive", label: "変化あり", kind: "mutating", run: (h) => h.clearActive() },
  { method: "clearActiveInternal", kind: "internal", note: "clearActive の実体" },
  { method: "clear", label: "変化あり", kind: "mutating", run: (h) => h.clear() },
  { method: "clearInternal", kind: "internal", note: "clear の実体" },
  {
    method: "replayPersistedEventEnvelope",
    label: "既知 EventID",
    kind: "mutating",
    run: (h) => h.replayPersistedEventEnvelope("tsunami-a"),
  },
  {
    method: "replayPersistedEventEnvelope",
    label: "未知 EventID",
    kind: "mutating",
    run: (h) => h.replayPersistedEventEnvelope("unknown-event"),
  },
  { method: "replayPersistedEventEnvelopeInternal", kind: "internal", note: "replayPersistedEventEnvelope の実体" },
  {
    method: "clearObservationFamily",
    label: "変化あり",
    kind: "mutating",
    run: (h) => h.clearObservationFamily("VTSE51"),
  },
  {
    method: "clearObservationFamily",
    label: "既に空",
    kind: "mutating",
    run: (h) => h.clearObservationFamily("VTSE52"),
  },
  { method: "clearObservationFamilyInternal", kind: "internal", note: "clearObservationFamily の実体" },
  {
    method: "restoreObservationGroups",
    kind: "mutating",
    run: (h) => h.restoreObservationGroups({ VTSE51: [], VTSE52: [] }),
  },
  { method: "restoreObservationGroupsInternal", kind: "internal", note: "restoreObservationGroups の実体" },
  {
    method: "restorePersistedState",
    kind: "mutating",
    run: (h) => h.restorePersistedState(null, { VTSE51: [], VTSE52: [] }),
  },
  { method: "restorePersistedStateInternal", kind: "internal", note: "restorePersistedState の実体" },
  {
    method: "retainActiveEventIds",
    label: "変化あり",
    kind: "mutating",
    run: (h) => void h.retainActiveEventIds([]),
  },
  {
    method: "retainActiveEventIds",
    label: "全件保持",
    kind: "mutating",
    run: (h) => void h.retainActiveEventIds(h.activeEventIds()),
  },
  { method: "retainActiveEventIdsInternal", kind: "internal", note: "retainActiveEventIds の実体" },
  { method: "activeEventIds", kind: "readonly", run: (h) => void h.activeEventIds() },
  { method: "getLevel", kind: "readonly", run: (h) => void h.getLevel() },
  { method: "getLastInfo", kind: "readonly", run: (h) => void h.getLastInfo() },
  { method: "getObservationGroups", kind: "readonly", run: (h) => void h.getObservationGroups() },
  { method: "getPersistedActive", kind: "readonly", run: (h) => void h.getPersistedActive() },
  { method: "getPersistedKeyedActive", kind: "readonly", run: (h) => void h.getPersistedKeyedActive() },
  { method: "getPersistedLegacyActive", kind: "readonly", run: (h) => void h.getPersistedLegacyActive() },
  {
    method: "getPresentationInfo",
    kind: "readonly",
    run: (h) => void h.getPresentationInfo(tsunamiInfo("2026-09-07T03:00:00+09:00", "発表")),
  },
  {
    method: "retainsEventAfterCancellation",
    kind: "readonly",
    run: (h) => void h.retainsEventAfterCancellation(tsunamiInfo("2026-09-07T03:00:00+09:00", "取消")),
  },
  { method: "hasPersistedEvent", kind: "readonly", run: (h) => void h.hasPersistedEvent("tsunami-a") },
  { method: "getPromptStatus", kind: "readonly", run: (h) => void h.getPromptStatus() },
  { method: "getDetail", kind: "readonly", run: (h) => void h.getDetail() },
  { method: "clearActiveState", kind: "internal", note: "mutator の内側" },
  { method: "clearObservationsIfInactive", kind: "internal", note: "mutator の内側" },
  { method: "rebuildActiveState", kind: "internal", note: "mutator の内側 (導出値の再構築)" },
  { method: "removeEvent", kind: "internal", note: "mutator の内側" },
];

describe("§3.1.3 TsunamiStateHolder の owner version 不変条件", () => {
  it("A6: prototype メソッドが表に全て載っている", () => {
    assertPrototypeCoverage(TsunamiStateHolder.prototype, TSUNAMI_ROWS, "TsunamiStateHolder");
  });

  it("A5: 指紋変化 ⟺ version 前進 が双方向で成立する", () => {
    assertBidirectional("TsunamiStateHolder", TSUNAMI_ROWS, seededTsunamiHolder);
  });

  it("version() / cloneSnapshot() は version を動かさない", () => {
    const holder = seededTsunamiHolder();
    const first = holder.version();
    holder.cloneSnapshot();
    holder.cloneSnapshot();
    expect(holder.version()).toBe(first);
  });

  it("retainActiveEventIds の戻り値は保持対象 3 集合だけを見る (余分な durable key を立てない)", () => {
    const holder = seededTsunamiHolder();
    // 全件保持なら、導出値の再構築が走っても false を返す。
    expect(holder.retainActiveEventIds(holder.activeEventIds())).toBe(false);
    expect(holder.retainActiveEventIds([])).toBe(true);
  });

  it("replacePrevalidated は復元契約どおり version を 1 進める", () => {
    const holder = seededTsunamiHolder();
    const before = holder.version();
    holder.replacePrevalidated(holder.cloneSnapshot());
    expect(holder.version()).toBe(before + 1);
  });
});

// ── StandbyStateStore ───────────────────────────────────────────────────────

function heatRaw(): ParsedHeatAlertInfo {
  return {
    meta: testTelegramMeta(false),
    type: "VPFT50",
    infoType: "発表",
    title: "東京都熱中症警戒アラート",
    controlTitle: "熱中症警戒アラート",
    reportDateTime: "2026-09-07T05:00:00+09:00",
    targetDateTime: "2026-09-07T05:00:00+09:00",
    headline: null,
    publishingOffice: "環境省 気象庁",
    editorialOffice: "環境省 気象庁",
    eventId: null,
    serial: "1",
    targetAreaName: "東京都",
    notice: null,
    bodyText: null,
    isTest: false,
  };
}

function heatEvent(over: Partial<PresentationEvent> = {}): PresentationEvent {
  const raw = heatRaw();
  return {
    id: "heat-invariant-1",
    classification: "meteorological",
    domain: "heatAlert",
    type: raw.type,
    infoType: raw.infoType,
    title: raw.title,
    controlTitle: raw.controlTitle,
    headline: raw.headline,
    reportDateTime: raw.reportDateTime,
    publishingOffice: raw.publishingOffice,
    isTest: raw.isTest,
    frameLevel: "warning",
    isCancellation: false,
    eventId: raw.eventId,
    serial: raw.serial,
    areaNames: ["東京都"],
    forecastAreaNames: [],
    municipalityNames: [],
    observationNames: [],
    areaCount: 1,
    forecastAreaCount: 0,
    municipalityCount: 0,
    observationCount: 0,
    areaItems: [],
    raw,
    ...over,
  };
}

function briefingEvent(): PresentationEvent {
  const info = parseWeatherBriefing(createMockWsDataMessage("82_01_01_260324_VPBS50.xml"));
  if (info == null) throw new Error("briefing fixture did not parse");
  return heatEvent({
    id: info.meta.messageId,
    domain: "briefing",
    type: "VPBS50",
    infoType: info.infoType,
    title: info.title,
    controlTitle: info.controlTitle,
    headline: info.headline,
    reportDateTime: info.reportDateTime,
    publishingOffice: info.publishingOffice,
    isTest: info.isTest,
    frameLevel: "warning",
    isCancellation: info.infoType === "取消",
    eventId: info.eventId,
    serial: info.serial,
    areaNames: info.targetAreas.map((area): string => area.name),
    areaCount: info.targetAreas.length,
    areaItems: info.targetAreas.map((area) => ({
      name: area.name,
      code: area.code,
      kind: info.briefingCondition || "気象防災速報",
    })),
    raw: info,
  });
}

const STORE_NOW_MS = Date.parse("2026-09-07T00:00:00.000Z");

function volcanoHolderSnapshotFixture(): VolcanoHolderSnapshot {
  return {
    version: 1,
    composites: [{
      volcanoCode: "v-inv",
      volcanoName: "検査火山",
      sourceEventIds: ["ev-inv"],
      alert: {
        volcanoCode: "v-inv",
        volcanoName: "検査火山",
        alertLevel: 3,
        alertLevelCode: "3",
        action: "issue",
        reportDateTime: new Date(STORE_NOW_MS).toISOString(),
        alertClass: null,
        warningKind: "噴火警報",
        targetKinds: [],
        sourceFamily: "VFVO50",
        revision: { reportTimeMs: STORE_NOW_MS, serial: null },
        appliedSemanticKey: `発表:v-inv`,
      },
      eruption: null,
      ashfall: null,
    }],
    restored: [{ volcanoCode: "v-inv", alert: false, eruption: false, ashfall: false }],
    legacyEruptionIdentities: [],
  };
}

/** 熱中症 1 件を積んだ store。no-op 側の判定に実体が必要。 */
function seededStore(): StandbyStateStore {
  const store = new StandbyStateStore();
  store.applyEvent(heatEvent(), STORE_NOW_MS);
  return store;
}

const STORE_ROWS: readonly MethodRow<StandbyStateStore>[] = [
  // ── version 機構 ──
  { method: "mutationFingerprint", kind: "internal", note: "mutation 入口の指紋。読み取り経路からは呼ばない" },
  { method: "bumpIfChanged", kind: "internal", note: "mutation 入口を包む owner version の choke point" },
  { method: "snapshotData", kind: "internal", note: "cloneSnapshot が返す隔離済み複製" },
  { method: "version", kind: "readonly", run: (s) => void s.version() },
  { method: "cloneSnapshot", kind: "readonly", run: (s) => void s.cloneSnapshot() },
  { method: "replacePrevalidated", kind: "restore", note: "復元契約 (version を 1 進める)" },
  { method: "loadSnapshot", kind: "internal", note: "fromSnapshot / replacePrevalidated の実体" },
  // ── 事前判定の述語 ──
  { method: "hasDueSweepWork", kind: "readonly", run: (s) => void s.hasDueSweepWork(STORE_NOW_MS) },
  { method: "hasDueBriefingLifecycleWork", kind: "internal", note: "hasDueSweepWork の内側" },
  {
    method: "hasDueTyphoonProbabilityMaintenance",
    kind: "readonly",
    run: (s) => void s.hasDueTyphoonProbabilityMaintenance(STORE_NOW_MS),
  },
  {
    method: "hasDueWeatherWarningForecastMaintenance",
    kind: "readonly",
    run: (s) => void s.hasDueWeatherWarningForecastMaintenance(STORE_NOW_MS),
  },
  // ── public mutation 入口 ──
  {
    method: "applyEvent",
    label: "変化あり",
    kind: "mutating",
    run: (s) => void s.applyEvent(heatEvent({ id: "heat-invariant-2" }), STORE_NOW_MS + 1),
  },
  {
    method: "applyEvent",
    label: "同一報の再適用",
    kind: "mutating",
    run: (s) => void s.applyEvent(heatEvent(), STORE_NOW_MS),
  },
  { method: "applyEventInternal", kind: "internal", note: "applyEvent の実体" },
  {
    method: "applyBriefingCardEvent",
    label: "変化あり",
    kind: "mutating",
    run: (s) => void s.applyBriefingCardEvent(briefingEvent(), STORE_NOW_MS),
  },
  {
    method: "applyBriefingCardEvent",
    label: "briefing でない",
    kind: "mutating",
    run: (s) => void s.applyBriefingCardEvent(heatEvent(), STORE_NOW_MS),
  },
  { method: "applyBriefingCardEventInternal", kind: "internal", note: "applyBriefingCardEvent の実体" },
  {
    method: "reconcileBriefingCard",
    label: "未知 sourceKey",
    kind: "mutating",
    run: (s) => void s.reconcileBriefingCard("unknown-source", briefingEvent(), STORE_NOW_MS),
  },
  { method: "reconcileBriefingCardInternal", kind: "internal", note: "reconcileBriefingCard の実体" },
  {
    method: "applyTyphoonProbabilityCommand",
    kind: "mutating",
    note: "router owner token が要る。下の個別 it で双方向を確認する",
  },
  { method: "applyTyphoonProbabilityCommandInternal", kind: "internal", note: "applyTyphoonProbabilityCommand の実体" },
  {
    method: "reconcileTyphoonProbabilityCommand",
    kind: "mutating",
    note: "router owner token が要る。下の個別 it で双方向を確認する",
  },
  { method: "reconcileTyphoonProbabilityCommandInternal", kind: "internal", note: "reconcileTyphoonProbabilityCommand の実体" },
  {
    method: "reconcileTyphoonProbabilitySubject",
    label: "未知 eventId",
    kind: "mutating",
    run: (s) => void s.reconcileTyphoonProbabilitySubject("TC9999"),
  },
  { method: "reconcileTyphoonProbabilitySubjectInternal", kind: "internal", note: "reconcileTyphoonProbabilitySubject の実体" },
  {
    method: "maintainTyphoonProbabilitySubjects",
    label: "空",
    kind: "mutating",
    run: (s) => void s.maintainTyphoonProbabilitySubjects(STORE_NOW_MS, []),
  },
  { method: "maintainTyphoonProbabilitySubjectsInternal", kind: "internal", note: "maintainTyphoonProbabilitySubjects の実体" },
  {
    method: "maintainWeatherWarningForecastSubjects",
    label: "空",
    kind: "mutating",
    run: (s) => void s.maintainWeatherWarningForecastSubjects(STORE_NOW_MS, []),
  },
  { method: "maintainWeatherWarningForecastSubjectsInternal", kind: "internal", note: "maintainWeatherWarningForecastSubjects の実体" },
  {
    method: "reconcileWeatherWarningForecastGateBindings",
    label: "空",
    kind: "mutating",
    run: (s) => void s.reconcileWeatherWarningForecastGateBindings([]),
  },
  { method: "reconcileWeatherWarningForecastGateBindingsInternal", kind: "internal", note: "reconcileWeatherWarningForecastGateBindings の実体" },
  {
    method: "applyWeatherAlerts",
    label: "変化あり",
    kind: "mutating",
    run: (s) => void s.applyWeatherAlerts(
      "vpws50",
      [weatherAlertFixture()],
      new Date(STORE_NOW_MS).toISOString(),
      "1",
      STORE_NOW_MS,
    ),
  },
  {
    method: "applyWeatherAlerts",
    label: "空 (未受信のまま)",
    kind: "mutating",
    run: (s) => void s.applyWeatherAlerts(
      "vpww56",
      [],
      new Date(STORE_NOW_MS).toISOString(),
      null,
      STORE_NOW_MS,
    ),
  },
  { method: "applyWeatherAlertsInternal", kind: "internal", note: "applyWeatherAlerts の実体" },
  {
    method: "restoreCanonicalVpws50Alerts",
    label: "変化あり",
    kind: "mutating",
    run: (s) => s.restoreCanonicalVpws50Alerts(
      [weatherAlertFixture()],
      new Date(STORE_NOW_MS).toISOString(),
      "1",
    ),
  },
  {
    method: "restoreCanonicalVpws50Alerts",
    label: "空",
    kind: "mutating",
    run: (s) => s.restoreCanonicalVpws50Alerts([], null, null),
  },
  { method: "restoreCanonicalVpws50AlertsInternal", kind: "internal", note: "restoreCanonicalVpws50Alerts の実体" },
  {
    method: "restoreCanonicalVpww56Alerts",
    label: "空",
    kind: "mutating",
    run: (s) => s.restoreCanonicalVpww56Alerts([], null, null),
  },
  { method: "restoreCanonicalVpww56AlertsInternal", kind: "internal", note: "restoreCanonicalVpww56Alerts の実体" },
  {
    method: "restoreCanonicalFloods",
    label: "空",
    kind: "mutating",
    run: (s) => s.restoreCanonicalFloods([], STORE_NOW_MS),
  },
  { method: "restoreCanonicalFloodsInternal", kind: "internal", note: "restoreCanonicalFloods の実体" },
  {
    method: "retainCanonicalFloodEvents",
    label: "空",
    kind: "mutating",
    run: (s) => void s.retainCanonicalFloodEvents([]),
  },
  { method: "retainCanonicalFloodEventsInternal", kind: "internal", note: "retainCanonicalFloodEvents の実体" },
  {
    method: "floodLegacyEventIds",
    kind: "mutating",
    note: "読み取り入口だが reconcileLegacyFloodEvents が保存状態を縮めうるので choke point を通す",
    run: (s) => void s.floodLegacyEventIds(),
  },
  {
    method: "replaceVolcanoDerived",
    label: "変化あり",
    kind: "mutating",
    run: (s) => void s.replaceVolcanoDerived(volcanoHolderSnapshotFixture()),
  },
  {
    method: "replaceVolcanoDerived",
    label: "空",
    kind: "mutating",
    run: (s) => void s.replaceVolcanoDerived({
      version: 1, composites: [], restored: [], legacyEruptionIdentities: [],
    }),
  },
  { method: "replaceVolcanoDerivedInternal", kind: "internal", note: "replaceVolcanoDerived の実体" },
  {
    method: "seedVolcanoAlerts",
    label: "変化あり",
    kind: "mutating",
    run: (s) => void s.seedVolcanoAlerts([{
      volcanoCode: "v-seed",
      volcanoName: "種火山",
      alertLevel: 2,
      reportDateTime: new Date(STORE_NOW_MS).toISOString(),
    }], "success", STORE_NOW_MS),
  },
  {
    method: "seedVolcanoAlerts",
    label: "空",
    kind: "mutating",
    run: (s) => void s.seedVolcanoAlerts([], "success", STORE_NOW_MS),
  },
  { method: "seedVolcanoAlertsInternal", kind: "internal", note: "seedVolcanoAlerts の実体" },
  {
    method: "restoreCanonicalVolcanoes",
    label: "空",
    kind: "mutating",
    run: (s) => s.restoreCanonicalVolcanoes([], [], STORE_NOW_MS),
  },
  { method: "restoreCanonicalVolcanoesInternal", kind: "internal", note: "restoreCanonicalVolcanoes の実体" },
  {
    method: "sweep",
    label: "期限未到来",
    kind: "mutating",
    run: (s) => void s.sweep(STORE_NOW_MS),
  },
  {
    method: "sweep",
    label: "期限到来",
    kind: "mutating",
    run: (s) => void s.sweep(STORE_NOW_MS + 30 * 24 * 60 * 60_000),
  },
  { method: "sweepInternal", kind: "internal", note: "sweep の実体" },
  {
    method: "restoreActiveState",
    kind: "mutating",
    run: (s) => void s.restoreActiveState(new StandbyStateStore().exportActiveState(), STORE_NOW_MS),
  },
  { method: "restoreActiveStateInternal", kind: "internal", note: "restoreActiveState の実体" },
  // ── 読み取り入口 ──
  { method: "snapshotItems", kind: "readonly", run: (s) => void s.snapshotItems() },
  { method: "exportActiveState", kind: "readonly", run: (s) => void s.exportActiveState() },
  { method: "snapshotWeatherAlerts", kind: "readonly", run: (s) => void s.snapshotWeatherAlerts() },
  { method: "snapshotBriefingCard", kind: "readonly", run: (s) => void s.snapshotBriefingCard() },
  { method: "activeTickerGroupKeys", kind: "readonly", run: (s) => void s.activeTickerGroupKeys() },
  {
    method: "activeTyphoonProbabilitySubjects",
    kind: "readonly",
    run: (s) => void s.activeTyphoonProbabilitySubjects(STORE_NOW_MS),
  },
  {
    method: "activeWeatherWarningForecastSubjects",
    kind: "readonly",
    run: (s) => void s.activeWeatherWarningForecastSubjects(STORE_NOW_MS),
  },
  { method: "briefingCardEntryCount", kind: "readonly", run: (s) => void s.briefingCardEntryCount() },
  { method: "briefingCardGeneration", kind: "readonly", run: (s) => void s.briefingCardGeneration() },
  { method: "onChange", kind: "readonly", run: (s) => s.onChange(() => undefined) },
  { method: "onDurable", kind: "readonly", run: (s) => s.onDurable(() => undefined) },
  // ── private 内部ヘルパ (すべて上の入口の内側でだけ動く) ──
  ...([
    "applyBriefingCancellation", "applyBriefingLifecycleCandidate", "applyEarthquakeHost",
    "applyHeat", "applyLinearRainForecastReplacement", "applyLongPeriod", "applyNankai",
    "applyRawBriefingLifecycle", "applySemanticBriefingLifecycle", "applyTornado",
    "applyTransientBriefingEntry", "applyTyphoon", "applyVolcano", "applyVolcanoUpdate",
    "applyWeatherWarningForecast", "briefingDurableFingerprint", "canReserveRawProtection",
    "commitBriefingCandidatePlan", "diagnoseTyphoonIdentityMismatch", "enforceBriefingEntryCapacity",
    "exportBriefingCritical", "forkBriefingCandidatePlan", "ignoredBriefingOutcome",
    "liveBriefingEntry", "notify", "projectLinearRainPredictionCandidate",
    "promoteRawBriefingLifecycle", "pruneBriefingLifecycle", "putBriefingEntry",
    "reconcileBriefingCriticalLifecycle", "reconcileLegacyFloodEvents", "reconcileTransientBriefing",
    "rejectBriefingCandidateBeforeProjection", "restoreBriefingCritical",
    "retainManagedStandbySubjects", "retainVolcanoSubjects", "semanticBriefingEntry",
    "semanticCancellationTargets", "snapshotWeatherWarningForecastCard",
  ] as const).map((method): MethodRow<StandbyStateStore> => ({
    method,
    kind: "internal",
    note: "private 内部ヘルパ。public 入口の bumpIfChanged の内側でだけ動く",
  })),
];

function weatherAlertFixture(): DisplayWeatherAlertV1 {
  return {
    source: "vpws50",
    label: "気象警報",
    role: "weatherWarning",
    totalAreas: 1,
    items: [{
      kind: "大雨警報",
      displaySeverity: "nonLevelWarning",
      rank: "warning",
      shownAreas: ["区域"],
      omittedAreaCount: 0,
    }],
    updatedAt: new Date(STORE_NOW_MS).toISOString(),
  };
}

const VPTA_SEMANTIC = `発表:${"a".repeat(64)}`;

/** router 所有 token つきの VPTA 受理コマンド。standby-state-store-vpta.test.ts と同じ組み立て。 */
function typhoonProbabilityCommand(): VptaDisplayIngestCommand {
  const ownerToken = createVptaRouterOwnerToken();
  const parsed = parseTyphoonProbability(createMockWsDataMessage(FIXTURE_VPTA50_DAMREY));
  if (parsed == null || parsed.baseTime == null || parsed.reportDateTime == null) {
    throw new Error("VPTA50 fixture parse failed");
  }
  parsed.eventId = "TC2001";
  parsed.infoType = "発表";
  const nowMs = Date.parse(parsed.baseTime) + 1;
  const classification = projectTyphoonProbability(parsed, "発表", nowMs);
  const revision = { reportTimeMs: Date.parse(parsed.reportDateTime), serial: "1" };
  const stateSubjectKey = "typhoonProbability:TC2001";
  const commit = {
    stateSubjectKey,
    revisionFamily: "VPTA50",
    decision: {
      kind: "accept",
      relation: "newer",
      accepted: true,
      isCorrection: false,
      isTerminal: false,
      resolvedTrigger: null,
    },
    comparison: {
      revision: {
        ...parsed.meta,
        eventId: { raw: "TC2001", value: "TC2001", valid: true },
        type: { raw: "VPTA50", value: "VPTA50", valid: true },
        serial: { raw: "1", numeric: 1, valid: true },
        infoType: { raw: "発表", value: "発表", valid: true },
      },
      stateSubjectKey,
    },
    semanticKeys: [VPTA_SEMANTIC],
    cancelled: classification.result.kind === "deactivateAllZero",
    acceptedAtMs: nowMs,
    tombstoneRetentionMs: 604_800_000,
    binding: { revision, appliedSemanticKey: VPTA_SEMANTIC },
  } as VptaAcceptedCommit;
  return {
    domain: "typhoonProbability",
    ownerToken,
    commit,
    finalized: finalizeTyphoonProbabilityClassification(classification, revision, VPTA_SEMANTIC),
    activeSubjects: classification.result.kind === "active" ? [stateSubjectKey] : [],
  };
}

describe("§3.1.3 StandbyStateStore の owner version 不変条件", () => {
  it("A6: prototype メソッドが表に全て載っている", () => {
    assertPrototypeCoverage(StandbyStateStore.prototype, STORE_ROWS, "StandbyStateStore");
  });

  it("A5: 指紋変化 ⟺ version 前進 が双方向で成立する", () => {
    assertBidirectional("StandbyStateStore", STORE_ROWS, seededStore);
  });

  it("A5: VPTA command 経路も双方向で成立する", () => {
    const command = typhoonProbabilityCommand();
    const store = seededStore();

    const beforeApply = { fingerprint: fingerprintOf(store), version: store.version() };
    withVptaRouterOwnerToken(command.ownerToken, () => store.applyTyphoonProbabilityCommand(command));
    expect(fingerprintOf(store)).not.toBe(beforeApply.fingerprint);
    expect(store.version()).toBeGreaterThan(beforeApply.version);

    // 同じ command をもう一度 reconcile しても保持条件を満たすので状態は動かない。
    const settled = { fingerprint: fingerprintOf(store), version: store.version() };
    withVptaRouterOwnerToken(
      command.ownerToken,
      () => store.reconcileTyphoonProbabilityCommand(command),
    );
    expect(fingerprintOf(store)).toBe(settled.fingerprint);
    expect(store.version()).toBe(settled.version);

    // subject を落とせば指紋も version も動く。
    withVptaRouterOwnerToken(
      command.ownerToken,
      () => store.reconcileTyphoonProbabilitySubject("TC2001"),
    );
    expect(fingerprintOf(store)).not.toBe(settled.fingerprint);
    expect(store.version()).toBeGreaterThan(settled.version);
  });

  it("version() / cloneSnapshot() は version を動かさない", () => {
    const store = seededStore();
    const first = store.version();
    store.cloneSnapshot();
    store.version();
    store.cloneSnapshot();
    expect(store.version()).toBe(first);
  });

  it("replacePrevalidated は復元契約どおり version を 1 進める", () => {
    const store = seededStore();
    const before = store.version();
    store.replacePrevalidated(store.cloneSnapshot());
    expect(store.version()).toBe(before + 1);
  });
});

describe("VPWS50 base subject の定数", () => {
  it("helper と holder の base subject key が一致している", () => {
    expect(largeStateVpws50Subjects()[0]).toBe(VPWS50_BASE_SUBJECT_KEY);
  });
});
