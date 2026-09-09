/**
 * 待機時 sweep ホットパス spec (docs/specs/2026-09-07-standby-sweep-hot-path.md) の
 * 段階 1〜4 の受入テスト。
 *
 * 段階 1 (owner version の O(1) 化) / 段階 3 (capture 前の事前判定):
 * - §4.1 / A7: 大容量合法状態 helper が痩せていないこと
 * - §4.2 / A1-A3: no-op sweep が 1MB 超の JSON.stringify / structuredClone / serializePair を呼ばない
 * - §4.3 / A4: 事前判定あり / なしで結果と全 owner snapshot が全時刻で一致する
 * - §4.5 / A8: 期限到来・取消・restore・時計巻き戻しで通常経路が走る
 *
 * 段階 2 (実削除ベースの変更検知) / 段階 4 (base の遅延取得と owner 比較の version 化):
 * - §3.2: retainActiveSubjects の戻り値が旧 stringify 判定と一致し、1MB 超の
 *   JSON.stringify を呼ばない。flood の実削除 boolean が changedKeys を立てる
 * - §3.4.3 / A11: strict モードで version 比較と version 抜き payload 比較が一致する。
 *   取りこぼし (under-bump) と過剰 bump の両方を throw で捕まえる
 * - §3.4.2: owner 集合が token・snapshot・OWNER_ORDER で一致する
 */
import { describe, it, expect, vi } from "vitest";
import {
  StandbyPersistenceAdmissionCoordinator,
  STANDBY_PERSISTENCE_OWNER_ORDER,
  __test_setStandbySweepStrictOwnerDiff,
  type StandbyPersistenceDomainSnapshots,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import {
  FloodForecastStateHolder,
  type FloodForecastStateSnapshot,
} from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import {
  buildLargeVpws50GateSnapshot,
  buildLargeVpws50PersistedState,
  buildLargeVpws50Snapshot,
  largeStatePartialSubjectKeys,
  largeStateVpws50Subjects,
  VPWS50_BASE_SUBJECT_KEY,
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
  // 段階 3-E で world history が 8 段 → 2 段になり、helper の合法最大は 6.8MB → 4.9MB に下がった。
  // 計測対象 (1MB 超の stringify / clone が出るか) には十分な大きさなので閾値だけ追従させる。
  it("A7: VPWS50 の exportPersistedState JSON が 4.5MB 以上ある", () => {
    const state = buildLargeVpws50PersistedState(DEADLINE_BASE_MS);
    expect(JSON.stringify(state).length).toBeGreaterThanOrEqual(4.5 * 1_000_000);
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

  /**
   * 事前判定を無効化した参照実装の残存コスト。
   *
   * **測っているのは「通常経路に入りつつ変更ゼロで終わる周期」**であって、電文受理直後の
   * sweep ではない。`changed` が空なので base の 2 回目 capture・`serializePair` ×2・
   * `preflight` は通らない。電文受理直後は `changed` が非空になり、そのぶんが上乗せされる
   * (spec §5.2 B3 はそちらを対象にした条件)。ここで測れるのは capture / scratch holder
   * 再構築 / retain 系という、どちらの経路にも共通の土台部分。
   *
   * 段階 1＋3 の時点では、ここで 1MB 超の `JSON.stringify` が発生することが計測の
   * 妥当性の証拠になっていた。§3.2 補遺 (復元時の指紋計算の省略) を入れた後は
   * **この土台からも 1MB 超の stringify が消える**ので、期待値を 0 に更新する。
   * 計測が空回りでないことは `structuredClone` 側が引き続き 1MB 超を数えることで示す。
   */
  it("事前判定を無効化した参照実装でも 1MB 超の stringify は 0 回 (clone だけが残る)", () => {
    // 本番経路のコストを測るテストなので strict は明示的に off にする。strict の
    // ground truth (version 抜き payload の canonicalJson) 自体が 5.9MB の stringify を
    // 2 回払うため、`FLEQ_STANDBY_SWEEP_STRICT=1` で回すと計測値が汚れる。
    const previous = __test_setStandbySweepStrictOwnerDiff(false);
    try {
      const { coordinator } = largeStateCoordinator(DEADLINE_BASE_MS, {
        disableSweepPrecheck: true,
        serializePair: () => ({ v2: new Uint8Array(), v1: new Uint8Array() }),
      });
      coordinator.sweepAll(DEADLINE_BASE_MS);
      const measured = withCallCounters(() => coordinator.sweepAll(DEADLINE_BASE_MS + 5_000));
      expect(measured.result.kind).toBe("committed");
      expect(measured.bigStringifyCalls).toBe(0);
      expect(measured.maxStringifyBytes).toBeLessThan(ONE_MIB);
      // capture の cloneSnapshot / fromSnapshot の復元 clone / draft への書き戻しが残る。
      // ここが 0 になったら計測の側が壊れている。
      expect(measured.bigStructuredCloneCalls).toBeGreaterThan(0);
    } finally {
      __test_setStandbySweepStrictOwnerDiff(previous);
    }
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

describe("§3.2 段階 2: 実削除ベースの変更検知", () => {
  /** 旧実装の判定 (保存状態全体の前後 stringify) をテスト側で再現した参照。 */
  function retainWithFingerprintReference(
    holder: Vpws50StateHolder,
    subjectKeys: readonly string[],
  ): { changed: boolean; versionAdvanced: boolean } {
    const before = JSON.stringify(holder.cloneSnapshot().state);
    const versionBefore = holder.version();
    holder.retainActiveSubjects(subjectKeys);
    return {
      changed: before !== JSON.stringify(holder.cloneSnapshot().state),
      versionAdvanced: holder.version() > versionBefore,
    };
  }

  const RETAIN_CASES: ReadonlyArray<{ label: string; subjects: () => string[] }> = [
    { label: "全 subject を保つ", subjects: () => largeStateVpws50Subjects() },
    { label: "全 subject を落とす", subjects: () => [] },
    {
      label: "官署 stream だけ一部落とす",
      subjects: () => largeStateVpws50Subjects().slice(0, 40),
    },
    {
      label: "全国 base だけ落とす",
      subjects: () => largeStatePartialSubjectKeys(),
    },
    {
      label: "全国 base だけ残す",
      subjects: () => [VPWS50_BASE_SUBJECT_KEY],
    },
  ];

  it.each(RETAIN_CASES)(
    "retainActiveSubjects の戻り値が旧 stringify 判定と一致する ($label)",
    ({ subjects }) => {
      const keys = subjects();
      const probe = Vpws50StateHolder.fromSnapshot(buildLargeVpws50Snapshot(DEADLINE_BASE_MS));
      const reference = retainWithFingerprintReference(probe, keys);

      const holder = Vpws50StateHolder.fromSnapshot(buildLargeVpws50Snapshot(DEADLINE_BASE_MS));
      const versionBefore = holder.version();
      const changed = holder.retainActiveSubjects(keys);

      expect(changed).toBe(reference.changed);
      expect(holder.version() > versionBefore).toBe(reference.versionAdvanced);
      expect(holder.version() > versionBefore).toBe(changed);
      // 実削除の結果そのものも旧経路と同じであること。
      expect(canonicalJson(holder.cloneSnapshot().state))
        .toBe(canonicalJson(probe.cloneSnapshot().state));
    },
  );

  it("retainActiveSubjects が 1MB 超の JSON.stringify を呼ばない", () => {
    const holder = Vpws50StateHolder.fromSnapshot(buildLargeVpws50Snapshot(DEADLINE_BASE_MS));
    const measured = withCallCounters(() =>
      holder.retainActiveSubjects(largeStateVpws50Subjects().slice(0, 40)));
    expect(measured.result).toBe(true);
    expect(measured.bigStringifyCalls).toBe(0);
  });

  it("何も落とさない retainActiveSubjects も 1MB 超の JSON.stringify を呼ばない", () => {
    const holder = Vpws50StateHolder.fromSnapshot(buildLargeVpws50Snapshot(DEADLINE_BASE_MS));
    const measured = withCallCounters(() =>
      holder.retainActiveSubjects(largeStateVpws50Subjects()));
    expect(measured.result).toBe(false);
    expect(measured.bigStringifyCalls).toBe(0);
  });

  it("currentMessageId だけが残った状態では version を進めない (過剰 bump の回帰)", () => {
    // exportPersistedState() の current は current と currentIdentity が揃って
    // いるときだけ非 null になる。messageId 単独は保存状態に載らない。
    const holder = new Vpws50StateHolder();
    const snapshot = holder.cloneSnapshot();
    expect(snapshot.state.current).toBeNull();
    const versionBefore = holder.version();
    expect(holder.retainActiveSubjects([])).toBe(false);
    expect(holder.version()).toBe(versionBefore);
  });

  it("FloodForecastStateHolder.retainActiveEventIds が実削除の有無を返す", () => {
    const holder = new FloodForecastStateHolder();
    holder.diffAndUpdate("flood-a", [], null, DEADLINE_BASE_MS);
    holder.diffAndUpdate("flood-b", [], null, DEADLINE_BASE_MS);
    const versionBefore = holder.version();
    expect(holder.retainActiveEventIds(["flood-a", "flood-b"])).toBe(false);
    expect(holder.version()).toBe(versionBefore);
    expect(holder.retainActiveEventIds(["flood-a"])).toBe(true);
    expect(holder.version()).toBe(versionBefore + 1);
    expect(holder.activeEventIds()).toEqual(["flood-a"]);
  });

  it("sweepAll の flood 判定が前後 canonicalJson なしで changedKeys を立てる", () => {
    const { coordinator, owners } = makeCoordinator();
    owners.floodForecastState.diffAndUpdate("flood-a", [], null, DEADLINE_BASE_MS);
    // gate に active subject を持たせていないので、sweep が holder 側を掃除する。
    const swept = coordinator.sweepAll(DEADLINE_BASE_MS + 1_000);
    expect(swept.kind).toBe("committed");
    if (swept.kind !== "committed") return;
    expect(swept.value.changedKeys).toContain("floodForecast:floodForecast");
    expect(owners.floodForecastState.activeEventIds()).toEqual([]);
  });
});

describe("§3.4 段階 4: base の遅延取得と owner 比較の version 化", () => {
  it("A11: strict モードで全 probe 時刻を回しても version 比較と payload 比較が一致する", () => {
    const previous = __test_setStandbySweepStrictOwnerDiff(true);
    try {
      const seed = makeCoordinator();
      const domains = buildDeadlineScatteredDomains(
        structuredClone(seed.coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
      );
      const strict = makeCoordinator();
      strict.coordinator.restorePrevalidated(
        structuredClone(domains) as StandbyPersistenceDomainSnapshots,
      );
      const reference = makeCoordinator({ disableSweepPrecheck: true });
      reference.coordinator.restorePrevalidated(
        structuredClone(domains) as StandbyPersistenceDomainSnapshots,
      );

      let observedChangeCount = 0;
      for (const nowMs of deadlineProbeTimes()) {
        const left = strict.coordinator.sweepAll(nowMs);
        const right = reference.coordinator.sweepAll(nowMs);
        expect(left.kind, `kind at ${nowMs}`).toBe(right.kind);
        if (left.kind === "committed" && right.kind === "committed") {
          expect([...left.value.changedKeys].sort(), `changedKeys at ${nowMs}`)
            .toEqual([...right.value.changedKeys].sort());
          if (left.value.changedKeys.length > 0) observedChangeCount += 1;
        }
        expect(canonicalJson(strict.coordinator.capture().domains), `domains at ${nowMs}`)
          .toBe(canonicalJson(reference.coordinator.capture().domains));
      }
      expect(observedChangeCount).toBeGreaterThanOrEqual(5);
    } finally {
      __test_setStandbySweepStrictOwnerDiff(previous);
    }
  });

  // 注: これは token 側 (version()) と snapshot 側 (cloneSnapshot().version) の desync で、
  // under-bump そのものではない。実 under-bump は下の VersionFrozenFlood のテストが模す。
  it("strict モードは token と snapshot の version desync を throw で捕まえる", () => {
    // cloneSnapshot() の version を固定した owner を仕込むと、token 側 (version())
    // と snapshot 側 (cloneSnapshot()) の version がずれ、version 比較だけが
    // 「変わった」と言う状態を作れる。全文比較はこれを変更なしと見る。
    class VersionPinnedFloodHolder extends FloodForecastStateHolder {
      override cloneSnapshot(): FloodForecastStateSnapshot {
        return { ...super.cloneSnapshot(), version: 4242 };
      }
    }
    const previous = __test_setStandbySweepStrictOwnerDiff(true);
    try {
      const coordinator = new StandbyPersistenceAdmissionCoordinator({
        owners: {
          telegramRevisionGate: new TelegramRevisionGate(() => undefined),
          standbyStateStore: new StandbyStateStore(),
          vpws50State: new Vpws50StateHolder(),
          vpww56State: new Vpww56StateHolder(),
          tsunamiState: new TsunamiStateHolder(),
          volcanoState: new VolcanoStateHolder(),
          floodForecastState: new VersionPinnedFloodHolder(),
        },
      });
      expect(() => coordinator.sweepAll(DEADLINE_BASE_MS))
        .toThrow(/strict sweep owner diff mismatch/);
    } finally {
      __test_setStandbySweepStrictOwnerDiff(previous);
    }
  });

  it("strict モードは取りこぼし (payload が動いたのに version が進まない) を throw で捕まえる", () => {
    // 実コードで起こりうる under-bump をそのまま模す: scratch holder が実際に
    // event を消して payload を変えるのに、version は base のまま据え置かれる。
    // version 比較だけでは「変更なし」に見え、owner が commit されず取りこぼす。
    class VersionFrozenFlood extends FloodForecastStateHolder {
      private frozen = 0;
      setFrozen(version: number): void { this.frozen = version; }
      override cloneSnapshot(): FloodForecastStateSnapshot {
        return { ...super.cloneSnapshot(), version: this.frozen };
      }
    }
    const previous = __test_setStandbySweepStrictOwnerDiff(true);
    const spy = vi.spyOn(FloodForecastStateHolder, "fromSnapshot")
      .mockImplementation((snapshot) => {
        const holder = new VersionFrozenFlood();
        holder.replacePrevalidated(snapshot);
        holder.setFrozen(snapshot.version);
        return holder;
      });
    try {
      const { coordinator, owners } = makeCoordinator();
      // gate に active な flood subject が無いので、sweep はこの event を消す。
      owners.floodForecastState.diffAndUpdate("flood-a", [], null, DEADLINE_BASE_MS);
      expect(() => coordinator.sweepAll(DEADLINE_BASE_MS + 1_000))
        .toThrow(/version=\[\] payload=\[floodForecastState\]/);
    } finally {
      spy.mockRestore();
      __test_setStandbySweepStrictOwnerDiff(previous);
    }
  });

  it("strict モードは過剰 bump (version だけ進んで payload 不変) も throw で捕まえる", () => {
    // scratch holder の cloneSnapshot が payload を変えずに version だけ進める状況を作る。
    // 旧 strict (snapshot 全文比較) は snapshot に version が載っているため
    // 「version が動いた ⟹ 全文も動く」が恒真で、この過剰 bump を素通りさせていた。
    class VersionInflatingFlood extends FloodForecastStateHolder {
      override cloneSnapshot(): FloodForecastStateSnapshot {
        const snapshot = super.cloneSnapshot();
        return { ...snapshot, version: snapshot.version + 1 };
      }
    }
    const previous = __test_setStandbySweepStrictOwnerDiff(true);
    const spy = vi.spyOn(FloodForecastStateHolder, "fromSnapshot")
      .mockImplementation((snapshot) => {
        const holder = new VersionInflatingFlood();
        holder.replacePrevalidated(snapshot);
        return holder;
      });
    try {
      const { coordinator } = makeCoordinator();
      // 取りこぼしではなく過剰 bump 側で落ちていることを文面で固定する。
      expect(() => coordinator.sweepAll(DEADLINE_BASE_MS))
        .toThrow(/version=\[floodForecastState\] payload=\[\]/);
    } finally {
      spy.mockRestore();
      __test_setStandbySweepStrictOwnerDiff(previous);
    }
  });

  it("strict モードでは no-op 経路で base 取得の capture が 1 回増える (空回りでない証拠)", () => {
    // commit 経路では strict が取った base をそのまま使い回すので capture は増えない。
    // ここで測るのは通常経路に入りつつ変更ゼロで終わる周期 (= base を本来取らない側)。
    function bigCloneCount(strictOn: boolean): number {
      const previous = __test_setStandbySweepStrictOwnerDiff(strictOn);
      try {
        const { coordinator } = largeStateCoordinator(DEADLINE_BASE_MS, {
          disableSweepPrecheck: true,
          serializePair: () => ({ v2: new Uint8Array(), v1: new Uint8Array() }),
        });
        coordinator.sweepAll(DEADLINE_BASE_MS);
        return withCallCounters(() =>
          coordinator.sweepAll(DEADLINE_BASE_MS + 5_000)).bigStructuredCloneCalls;
      } finally {
        __test_setStandbySweepStrictOwnerDiff(previous);
      }
    }
    const off = bigCloneCount(false);
    const on = bigCloneCount(true);
    expect(off).toBeGreaterThan(0);
    expect(on).toBeGreaterThan(off);
  });

  it("owner 集合は token・snapshot・OWNER_ORDER で一致する (version 比較の取りこぼし防止)", () => {
    const { coordinator } = makeCoordinator();
    const captured = coordinator.capture();
    const order = [...STANDBY_PERSISTENCE_OWNER_ORDER].sort();
    expect(Object.keys(captured.token.ownerVersions).sort()).toEqual(order);
    expect(Object.keys(captured.domains).sort()).toEqual(order);
  });
});
