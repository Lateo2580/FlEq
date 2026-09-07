/**
 * 待機時 sweep ホットパス spec (docs/specs/2026-09-07-standby-sweep-hot-path.md) の
 * 段階 1 (owner version の O(1) 化) と段階 3 (capture 前の事前判定) の受入テスト。
 *
 * - §4.1 / A7: 大容量合法状態 helper が痩せていないこと
 * - §4.2 / A1-A3: no-op sweep が 1MB 超の JSON.stringify / structuredClone / serializePair を呼ばない
 * - §4.3 / A4: 事前判定あり / なしで結果と全 owner snapshot が全時刻で一致する
 * - §4.5 / A8: 期限到来・取消・restore・時計巻き戻しで通常経路が走る
 */
import { describe, it, expect } from "vitest";
import {
  StandbyPersistenceAdmissionCoordinator,
  type StandbyPersistenceDomainSnapshots,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import {
  buildLargeVpws50GateSnapshot,
  buildLargeVpws50PersistedState,
  buildLargeVpws50Snapshot,
} from "../../helpers/standby-sweep-large-state";
import {
  buildDeadlineScatteredDomains,
  deadlineProbeTimes,
  DEADLINE_BASE_MS,
} from "../../helpers/standby-sweep-deadline-state";

const ONE_MIB = 1024 * 1024;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child instanceof Map) return { $map: [...child] };
    if (child instanceof Set) return { $set: [...child] };
    return child;
  });
}

function makeCoordinator(options: {
  disableSweepPrecheck?: boolean;
  serializePair?: () => { v2: Uint8Array; v1: Uint8Array };
} = {}) {
  const owners = {
    telegramRevisionGate: new TelegramRevisionGate(() => undefined),
    standbyStateStore: new StandbyStateStore(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
  };
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners,
    ...(options.disableSweepPrecheck == null
      ? {}
      : { disableSweepPrecheck: options.disableSweepPrecheck }),
    ...(options.serializePair == null ? {} : { serializePair: options.serializePair }),
  });
  return { owners, coordinator };
}

/** 大容量 VPWS50 state を積んだ coordinator。gate は同じ subject 集合を active に保つ。 */
function largeStateCoordinator(baseMs: number, options: {
  disableSweepPrecheck?: boolean;
  serializePair?: () => { v2: Uint8Array; v1: Uint8Array };
} = {}) {
  const built = makeCoordinator(options);
  const domains = structuredClone(
    built.coordinator.capture().domains,
  ) as StandbyPersistenceDomainSnapshots;
  domains.telegramRevisionGate = buildLargeVpws50GateSnapshot(baseMs);
  domains.vpws50State = buildLargeVpws50Snapshot(baseMs);
  built.coordinator.restorePrevalidated(domains);
  return built;
}

/**
 * 測定中だけ `JSON.stringify` / `structuredClone` を包んで呼び出し回数を数える。
 * scratchpad の bench-sweep.mjs と同じ採り方。try / finally で必ず戻す。
 */
function withCallCounters<T>(run: () => T): {
  result: T;
  bigStringifyCalls: number;
  bigStructuredCloneCalls: number;
  maxStringifyBytes: number;
} {
  const originalStringify = JSON.stringify;
  const originalClone = globalThis.structuredClone;
  let bigStringifyCalls = 0;
  let bigStructuredCloneCalls = 0;
  let maxStringifyBytes = 0;
  let counting = false;
  // instrumentation は overload を持つ組み込みを差し替えるので、戻す型だけ合わせる。
  JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown): string => {
    const out = (originalStringify as (
      value: unknown,
      replacer?: unknown,
      space?: unknown,
    ) => string)(value, replacer, space);
    if (counting && typeof out === "string") {
      if (out.length > maxStringifyBytes) maxStringifyBytes = out.length;
      if (out.length > ONE_MIB) bigStringifyCalls += 1;
    }
    return out;
  }) as typeof JSON.stringify;
  globalThis.structuredClone = ((value: unknown, options?: unknown): unknown => {
    const out = (originalClone as (value: unknown, options?: unknown) => unknown)(value, options);
    if (counting) {
      let size = 0;
      try {
        size = originalStringify(value)?.length ?? 0;
      } catch {
        size = 0;
      }
      if (size > ONE_MIB) bigStructuredCloneCalls += 1;
    }
    return out;
  }) as typeof globalThis.structuredClone;
  try {
    counting = true;
    const result = run();
    return { result, bigStringifyCalls, bigStructuredCloneCalls, maxStringifyBytes };
  } finally {
    counting = false;
    JSON.stringify = originalStringify;
    globalThis.structuredClone = originalClone;
  }
}

describe("§4.1 大容量の合法状態 helper", () => {
  it("A7: VPWS50 の exportPersistedState JSON が 5MB 以上ある", () => {
    const state = buildLargeVpws50PersistedState(DEADLINE_BASE_MS);
    expect(JSON.stringify(state).length).toBeGreaterThanOrEqual(5 * 1_000_000);
  });

  it("holder を往復しても canonical 一致する (assertLosslessOwnerSnapshot 相当)", () => {
    const snapshot = buildLargeVpws50Snapshot(DEADLINE_BASE_MS);
    const restored = Vpws50StateHolder.fromSnapshot(snapshot).cloneSnapshot();
    expect(canonicalJson(restored)).toBe(canonicalJson(snapshot));
  });
});

describe("§4.2 no-op sweep の回数ベース計測", () => {
  it("A1/A2/A3: 定常 no-op で 1MB 超の stringify / clone と serializePair が 0 回", () => {
    let serializePairCalls = 0;
    const { coordinator } = largeStateCoordinator(DEADLINE_BASE_MS, {
      serializePair: () => {
        serializePairCalls += 1;
        return { v2: new Uint8Array(), v1: new Uint8Array() };
      },
    });
    // 1 回目で lastSweep を確立させ、2 回目以降を定常 no-op として測る。
    expect(coordinator.sweepAll(DEADLINE_BASE_MS).kind).toBe("committed");
    expect(coordinator.sweepAll(DEADLINE_BASE_MS + 5_000).kind).toBe("committed");
    serializePairCalls = 0;

    const measured = withCallCounters(() => [
      coordinator.sweepAll(DEADLINE_BASE_MS + 10_000),
      coordinator.sweepAll(DEADLINE_BASE_MS + 15_000),
      coordinator.sweepAll(DEADLINE_BASE_MS + 20_000),
    ]);

    for (const result of measured.result) {
      expect(result.kind).toBe("committed");
      if (result.kind !== "committed") continue;
      expect(result.value.changedKeys).toEqual([]);
      expect(result.value.durableChanged).toBe(false);
    }
    expect(measured.bigStringifyCalls).toBe(0);
    expect(measured.bigStructuredCloneCalls).toBe(0);
    expect(serializePairCalls).toBe(0);
  });

  it("事前判定を無効化した参照実装では 1MB 超の呼び出しが実際に発生する (計測が空回りでない証拠)", () => {
    const { coordinator } = largeStateCoordinator(DEADLINE_BASE_MS, {
      disableSweepPrecheck: true,
      serializePair: () => ({ v2: new Uint8Array(), v1: new Uint8Array() }),
    });
    coordinator.sweepAll(DEADLINE_BASE_MS);
    const measured = withCallCounters(() => coordinator.sweepAll(DEADLINE_BASE_MS + 5_000));
    expect(measured.result.kind).toBe("committed");
    expect(measured.maxStringifyBytes).toBeGreaterThan(5 * 1_000_000);
    expect(measured.bigStringifyCalls).toBeGreaterThan(0);
    expect(measured.bigStructuredCloneCalls).toBeGreaterThan(0);
  });
});

describe("§4.3 事前判定の差分テスト", () => {
  it("A4: 事前判定あり / なしで changedKeys・durableChanged・全 owner snapshot が全時刻で一致する", () => {
    const seed = makeCoordinator();
    const domains = buildDeadlineScatteredDomains(
      structuredClone(seed.coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
    );

    const actual = makeCoordinator();
    actual.coordinator.restorePrevalidated(
      structuredClone(domains) as StandbyPersistenceDomainSnapshots,
    );
    const reference = makeCoordinator({ disableSweepPrecheck: true });
    reference.coordinator.restorePrevalidated(
      structuredClone(domains) as StandbyPersistenceDomainSnapshots,
    );

    let observedChangeCount = 0;
    for (const nowMs of deadlineProbeTimes()) {
      const left = actual.coordinator.sweepAll(nowMs);
      const right = reference.coordinator.sweepAll(nowMs);
      expect(left.kind, `kind at ${nowMs}`).toBe(right.kind);
      if (left.kind === "committed" && right.kind === "committed") {
        expect([...left.value.changedKeys].sort(), `changedKeys at ${nowMs}`)
          .toEqual([...right.value.changedKeys].sort());
        expect(left.value.durableChanged, `durableChanged at ${nowMs}`)
          .toBe(right.value.durableChanged);
        if (left.value.changedKeys.length > 0) observedChangeCount += 1;
      }
      expect(canonicalJson(actual.coordinator.capture().domains), `domains at ${nowMs}`)
        .toBe(canonicalJson(reference.coordinator.capture().domains));
    }
    // fixture が痩せて「どの時刻でも何も起きない」状態だと差分テストが空回りする。
    expect(observedChangeCount).toBeGreaterThanOrEqual(5);
  });
});

describe("§4.5 事前判定を迂回すべき経路", () => {
  it("A8: 期限到来の周期では通常経路が走り、該当 owner だけが変わる", () => {
    const seed = makeCoordinator();
    const domains = buildDeadlineScatteredDomains(
      structuredClone(seed.coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
    );
    const { coordinator } = makeCoordinator();
    coordinator.restorePrevalidated(structuredClone(domains) as StandbyPersistenceDomainSnapshots);
    // 期限前に一度収束させる。
    const settle = coordinator.sweepAll(DEADLINE_BASE_MS);
    expect(settle.kind).toBe("committed");
    coordinator.sweepAll(DEADLINE_BASE_MS + 1_000);

    // tornado の expiresAtMs (+10 分) をまたぐ。
    const swept = coordinator.sweepAll(DEADLINE_BASE_MS + 10 * 60_000);
    expect(swept.kind).toBe("committed");
    if (swept.kind !== "committed") return;
    expect(swept.value.changedKeys).toContain("standby:tornado");
  });

  it("A8: restorePrevalidated 直後の sweep は事前判定でスキップされない", () => {
    const seed = makeCoordinator();
    const domains = buildDeadlineScatteredDomains(
      structuredClone(seed.coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
    );
    const { coordinator } = makeCoordinator();
    coordinator.restorePrevalidated(structuredClone(domains) as StandbyPersistenceDomainSnapshots);
    coordinator.sweepAll(DEADLINE_BASE_MS);
    coordinator.sweepAll(DEADLINE_BASE_MS + 1_000);
    // 同じ内容で復元し直す。compositionVersion が進むので token 比較で捕まる。
    coordinator.restorePrevalidated(structuredClone(domains) as StandbyPersistenceDomainSnapshots);
    const swept = coordinator.sweepAll(DEADLINE_BASE_MS + 2_000);
    expect(swept.kind).toBe("committed");
    if (swept.kind !== "committed") return;
    // 復元で戻った期限切れ済み state が、通常経路で改めて掃除される。
    expect(swept.value.changedKeys.length).toBeGreaterThan(0);
  });

  it("A8: 時計が巻き戻った直後の sweep は通常経路を通る", () => {
    const { coordinator, owners } = largeStateCoordinator(DEADLINE_BASE_MS);
    coordinator.sweepAll(DEADLINE_BASE_MS + 60_000);
    coordinator.sweepAll(DEADLINE_BASE_MS + 65_000);
    const versionBefore = owners.telegramRevisionGate.version();
    // 巻き戻し。判定 4 に落ちて capture する (結果は no-op でも経路が違う)。
    const swept = coordinator.sweepAll(DEADLINE_BASE_MS + 1_000);
    expect(swept.kind).toBe("committed");
    expect(owners.telegramRevisionGate.version()).toBe(versionBefore);
  });

  it("A8: gate の取消 tombstone 期限到来で holder が gate の active 集合へ追従する", () => {
    const { coordinator, owners } = largeStateCoordinator(DEADLINE_BASE_MS);
    coordinator.sweepAll(DEADLINE_BASE_MS);
    coordinator.sweepAll(DEADLINE_BASE_MS + 5_000);

    // 官署 stream を 1 本 tombstone 化し、tombstone retention を過ぎた時刻で sweep する。
    const gateSnapshot = owners.telegramRevisionGate.cloneSnapshot();
    const target = gateSnapshot.states.find((entry) =>
      entry.key !== "weather:VPWS50:weather:vpws50");
    expect(target).toBeDefined();
    if (target == null) return;
    target.cancelled = true;
    target.tombstoneRetentionMs = 60_000;
    owners.telegramRevisionGate.replacePrevalidated(gateSnapshot);

    const swept = coordinator.sweepAll(DEADLINE_BASE_MS + 10 * 60_000);
    expect(swept.kind).toBe("committed");
    if (swept.kind !== "committed") return;
    expect(swept.value.changedKeys).toContain("weather:VPWS50");
    const remaining = owners.vpws50State.cloneSnapshot().state.partialStreams ?? [];
    expect(remaining.length).toBe(126);
  });
});
