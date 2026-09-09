/**
 * 電文受理経路のシリアライズ削減 spec
 * (`docs/specs/2026-09-09-receipt-serialize-reduction.md`) **段階 1** の受入。
 *
 * - A1 / A8' (§4.1): `scheduleSerializedPair` に渡るバイト列が再利用経路・フォールバック
 *   経路で完全一致する。volcano owner を変える transact を必須 fixture に含める
 * - A2 / A3 (§4.2): `serCalls` の段階別期待値と、deps 差し替えの計数との一致
 * - A4 (§4.1 / §4.4): 受理結果・`durableChanged`・owner snapshot が再利用の有無で一致
 * - A7 (§4.4): `changed.length === 0` の committed / `deferredDurabilityMismatch` の保持
 * - A8 (§4.4): C の strict 経路が壊れた base で throw する (空回りでない)
 * - A9 (§4.6): 1 通あたりの 1MB 超 `JSON.stringify` / `structuredClone` / `JSON.parse` が
 *   段階 1 で単調減少する
 *
 * `Vpws50StateHolder` は `lastSuccessfulFullDisplayAt` に `new Date()` を 5 箇所で書く
 * (`vpws50-state.ts:845 / :882 / :1149 / :1301 / :1343`、いずれも DI 無し) ので、
 * バイト比較は `vi.useFakeTimers({ toFake: ["Date"] })` で時計を固定してから採る。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as log from "../../../src/logger";
import {
  __test_setReceiptPerfClock,
  __test_setReceiptPerfEnabled,
  beginReceipt,
  endReceipt,
  mark,
} from "../../../src/engine/perf/receipt-timing";
import { StandbyPersistence } from "../../../src/engine/display/standby-persistence";
import {
  __test_setStandbyBodyReuseEnabled,
  __test_setStandbySweepStrictOwnerDiff,
  standbyAdmissionSerializeSplit,
  StandbyPersistenceAdmissionCoordinator,
  STANDBY_PERSISTENCE_OWNER_ORDER,
  type StandbyPersistenceDomainSnapshots,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoRouteHandler } from "../../../src/engine/messages/volcano-route-handler";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { VolcanoTransactionCoordinator } from "../../../src/engine/messages/volcano-transaction-coordinator";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VFVO50_ALERT_LV3,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPWW55_OAME,
  FIXTURE_VPWW56_DOSHA,
  readFixture,
} from "../../helpers/mock-message";
import type { WsDataMessage } from "../../../src/types";

const ONE_MIB = 1024 * 1024;
const CLASSIFICATION_NOW = Date.parse("2025-06-30T00:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `fleq-reduce-${tag}-`));
  roots.push(root);
  return root;
}

function makeOwners() {
  return {
    telegramRevisionGate: new TelegramRevisionGate(() => undefined),
    standbyStateStore: new StandbyStateStore(),
    vpws50State: new Vpws50StateHolder(),
    vpww56State: new Vpww56StateHolder(),
    tsunamiState: new TsunamiStateHolder(),
    volcanoState: new VolcanoStateHolder(),
    floodForecastState: new FloodForecastStateHolder(),
  };
}

interface CapturedPair {
  v2: string;
  v1: string;
}

/**
 * 本番と同じ配線 (`monitor.ts:362-376`)。`serializePairSplit` を渡すので commit 後の
 * body 再利用が効く。`onDurable` は `monitor.ts:390-397` と同じく
 * `captureSerializedPair` → writer へ渡す形にし、**writer 側の
 * `validateCapturedPair` を必ず通す** — 再利用したバイト列が canonical / v1 射影 /
 * generation 予約の検査を素通りすることまで確かめるため。
 */
function makeProductionHarness(tag: string, options: {
  /** preflight を必ず失敗させる (`admissionFailure` 経路の固定に使う)。 */
  validateCandidate?: () => string | null;
  /**
   * encode を定数 pair にする。`pairEqual` が恒真になるので `durableChanged` が
   * 常に false になり、「durable 変化なし」の serCalls を測れる。
   */
  constantEncode?: boolean;
} = {}) {
  const root = makeRoot(tag);
  const persistence = new StandbyPersistence(join(root, "display-active-state-v1.json"));
  const owners = makeOwners();
  const split = standbyAdmissionSerializeSplit(persistence);
  let buildCalls = 0;
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners,
    serializePairSplit: {
      build: (domains) => {
        buildCalls += 1;
        return split.build(domains);
      },
      encode: (body, envelope) => (options.constantEncode === true
        ? { v2: new Uint8Array([1]), v1: new Uint8Array([1]) }
        : split.encode(body, envelope)),
    },
    ...(options.validateCandidate == null
      ? {}
      : { validateCandidate: options.validateCandidate }),
    canReserveLogicalGeneration: () => persistence.canReserveLogicalGeneration(),
  });
  const pairs: CapturedPair[] = [];
  const durableFailures: string[] = [];
  coordinator.onDurable(() => {
    try {
      // `monitor.ts:390-397` と同じく `save=` で包む。
      const pair = mark("save", () =>
        coordinator.captureSerializedPair(persistence.reserveSerializationEnvelope()));
      const saved = persistence.saveSerializedPair(pair);
      if (saved.kind !== "written") durableFailures.push(`save:${saved.kind}`);
      pairs.push({
        v2: Buffer.from(pair.v2).toString("base64"),
        v1: Buffer.from(pair.v1).toString("base64"),
      });
    } catch (error) {
      // `emitDurable` は callback の throw を握って `log.warn` するだけなので、
      // ここで拾わないと「pair が 1 本足りない」だけの静かな失敗になる。
      durableFailures.push(error instanceof Error ? error.message : String(error));
    }
  });
  return { coordinator, owners, persistence, pairs, durableFailures, buildCalls: () => buildCalls };
}

type ProductionHarness = ReturnType<typeof makeProductionHarness>;

function weatherRouter(harness: ProductionHarness) {
  const outcomes: unknown[] = [];
  const router = createMessageHandler({
    clock: { nowMs: () => CLASSIFICATION_NOW },
    persistenceAdmission: harness.coordinator,
    revisionGate: harness.owners.telegramRevisionGate,
    vpws50State: harness.owners.vpws50State,
    vpww56State: harness.owners.vpww56State,
    tsunamiState: harness.owners.tsunamiState,
    volcanoState: harness.owners.volcanoState,
    floodForecastState: harness.owners.floodForecastState,
    outcomeTaps: [(outcome) => { outcomes.push(outcome); }],
    onVptaAdmissionCompletion: () => ({ kind: "notRequired" as const }),
    withStandbyDurableNotificationsSuppressed: (callback) => callback(),
  });
  return { handler: (message: WsDataMessage) => router.handler(message), outcomes };
}

function fixtureMessage(fixture: string, headType: string, id: string): WsDataMessage {
  const message = createMockWsDataMessageFromXml(readFixture(fixture), headType);
  if (message.meta == null) throw new Error(`fixture meta missing: ${fixture}`);
  return {
    ...message,
    id,
    meta: { ...message.meta, messageId: id, receivedAtMs: CLASSIFICATION_NOW },
  };
}

/** owner snapshot の指紋。A4 の「保存状態が改修前後で完全一致」に使う。 */
function ownerFingerprint(
  coordinator: StandbyPersistenceAdmissionCoordinator,
): Record<string, string> {
  const domains = coordinator.capture().domains as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const owner of STANDBY_PERSISTENCE_OWNER_ORDER) {
    out[owner] = JSON.stringify(domains[owner]);
  }
  return out;
}

/** 再利用 on / off を必ず戻す。 */
function withBodyReuse<T>(enabled: boolean, run: () => T): T {
  const previous = __test_setStandbyBodyReuseEnabled(enabled);
  try {
    return run();
  } finally {
    __test_setStandbyBodyReuseEnabled(previous);
  }
}

/**
 * strict を明示的に固定する。CI は `FLEQ_STANDBY_SWEEP_STRICT=1` 便を持つので、
 * 「strict off の挙動」を測る試験は env に関わらず自分で off にしないと反転する。
 */
function withStrictMode<T>(enabled: boolean, run: () => T): T {
  const previous = __test_setStandbySweepStrictOwnerDiff(enabled);
  try {
    return run();
  } finally {
    __test_setStandbySweepStrictOwnerDiff(previous);
  }
}

// ── A1 / A4 / A8': バイト列同一の固定 ────────────────────────

describe("§4.1 A1: 再利用経路とフォールバック経路でバイト列が一致する", () => {
  /**
   * 同じ電文列を 2 つの独立した coordinator へ流し、`captureSerializedPair` が返した
   * v2 / v1 を base64 で突き合わせる。片方は body 再利用 on、もう片方は off
   * (`__test_setStandbyBodyReuseEnabled(false)`) で従来の `capture()` +
   * 全体 serialize を通る。
   */
  function runWeather(tag: string, reuse: boolean): {
    pairs: CapturedPair[];
    fingerprint: Record<string, string>;
    failures: string[];
  } {
    vi.useFakeTimers({ toFake: ["Date"], now: CLASSIFICATION_NOW });
    try {
      return withBodyReuse(reuse, () => {
        const harness = makeProductionHarness(tag);
        const router = weatherRouter(harness);
        router.handler(fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", "a1-vpws50"));
        router.handler(fixtureMessage(FIXTURE_VPWW55_OAME, "VPWW55", "a1-vpww55"));
        router.handler(fixtureMessage(FIXTURE_VPWW56_DOSHA, "VPWW56", "a1-vpww56"));
        return {
          pairs: harness.pairs,
          fingerprint: ownerFingerprint(harness.coordinator),
          failures: harness.durableFailures,
        };
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("A1 / A4: weather 3 通で v2 / v1 バイト列と owner snapshot が一致する", () => {
    const reused = runWeather("reuse", true);
    const fallback = runWeather("fallback", false);
    expect(reused.failures).toEqual([]);
    expect(fallback.failures).toEqual([]);
    expect(reused.pairs.length).toBeGreaterThan(0);
    expect(reused.pairs).toEqual(fallback.pairs);
    expect(reused.fingerprint).toEqual(fallback.fingerprint);
  });

  /**
   * A8': volcano owner だけ `assertLosslessOwnerSnapshot` による往復検査が無く
   * (`standby-persistence-admission.ts` の volcano 枝は code 集合の重複と対応しか
   * 見ていない)、Pi 実測 15 通も全部 `route=weather` だったので、A の健全性が
   * 一度も観測されていなかった。volcano を動かす transact で必ず採る。
   */
  function runVolcano(tag: string, reuse: boolean): {
    pairs: CapturedPair[];
    fingerprint: Record<string, string>;
    failures: string[];
    composites: number;
  } {
    // fixture `45_01_01_200522_VFVO50.xml` の ReportDateTime に時計を合わせる。
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse("2020-05-22T04:03:00.000Z") });
    try {
      return withBodyReuse(reuse, () => {
        const harness = makeProductionHarness(tag);
        const transactions = new VolcanoTransactionCoordinator(harness.coordinator);
        const handler = new VolcanoRouteHandler({
          volcanoState: harness.owners.volcanoState,
          revisionGate: harness.owners.telegramRevisionGate,
          volcanoTransactionCoordinator: transactions,
          notifier: { notifyVolcano: vi.fn(), notifyVolcanoBatch: vi.fn() } as never,
          runDisplayPipeline: (_outcome, show) => {
            show();
            return true;
          },
          display: { displayVolcano: vi.fn(), displayVolcanoBatch: vi.fn() } as never,
        });
        const alert = createMockWsDataMessageFromXml(
          readFixture(FIXTURE_VFVO50_ALERT_LV3),
          "VFVO50",
        );
        expect(handler.handle(alert).kind).toBe("accepted");
        handler.flushAndDispose();
        return {
          pairs: harness.pairs,
          fingerprint: ownerFingerprint(harness.coordinator),
          failures: harness.durableFailures,
          composites: transactions.snapshot().holder.composites.length,
        };
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("A8': volcano owner を変える transact でもバイト列と owner snapshot が一致する", () => {
    const reused = runVolcano("volcano-reuse", true);
    const fallback = runVolcano("volcano-fallback", false);
    expect(reused.failures).toEqual([]);
    expect(fallback.failures).toEqual([]);
    // fixture が実際に volcano owner を動かしていることを先に確かめる
    // (composites が空のままだと「一致した」が無意味になる)。
    expect(reused.composites).toBeGreaterThan(0);
    expect(reused.pairs.length).toBeGreaterThan(0);
    expect(reused.pairs).toEqual(fallback.pairs);
    expect(reused.fingerprint).toEqual(fallback.fingerprint);
  });
});

// ── A2 / A3: serCalls の段階別期待値 ─────────────────────────

const RECEIPT_LINE = /^\[perf-receipt\] .* serCalls=(\d+) /;

function withPerfLines<T>(run: (lines: string[]) => T): T {
  const lines: string[] = [];
  const previousEnabled = __test_setReceiptPerfEnabled(true);
  let tick = 0;
  const previousClock = __test_setReceiptPerfClock(() => ++tick);
  const spy = vi.spyOn(log, "info").mockImplementation((msg: string) => {
    if (msg.startsWith("[perf-")) lines.push(msg);
  });
  try {
    return run(lines);
  } finally {
    spy.mockRestore();
    __test_setReceiptPerfClock(previousClock);
    __test_setReceiptPerfEnabled(previousEnabled);
  }
}

function serCallsOf(lines: string[]): number {
  const line = lines.find((entry) => entry.startsWith("[perf-receipt] "));
  if (line == null) throw new Error("no [perf-receipt] line");
  const matched = RECEIPT_LINE.exec(line);
  if (matched == null) throw new Error(`unparsable line: ${line}`);
  return Number(matched[1]);
}

function segmentKeys(lines: string[]): string[] {
  const line = lines.find((entry) => entry.startsWith("[perf-receipt] "));
  if (line == null) throw new Error("no [perf-receipt] line");
  return line.split(" ").slice(8).map((token) => token.split("=")[0]);
}

/**
 * standbyStateStore だけを動かす reducer。`changed` を非空にして serialize 経路へ入れる
 * 最小ケース (`admissionFailure` / `staleVersion` の固定に使う)。
 */
function standbyMutation(tag: string) {
  return (draft: StandbyPersistenceDomainSnapshots) => {
    draft.standbyStateStore = {
      ...draft.standbyStateStore,
      version: draft.standbyStateStore.version + 1,
      data: {
        ...draft.standbyStateStore.data,
        briefingGeneration: draft.standbyStateStore.data.briefingGeneration + 1,
      },
    };
    return { kind: "accepted" as const, value: tag, durableChanged: true };
  };
}

/** 何も変えない reducer。`changed.length === 0` の早期スキップ (C) を通す。 */
function noopMutation(durableChanged: boolean) {
  return () => ({ kind: "accepted" as const, value: "noop", durableChanged });
}

describe("§4.2 A2 / A3: serCalls の段階別期待値", () => {
  /**
   * durable 変化ありの受理は**実電文で作る**。`briefingGeneration` を進めるだけの
   * 合成 reducer では本番 serializer の出力が動かず (projection に出ない)、
   * `durableChanged` が false になって `save` が走らない — 起草時にそれで
   * 「serCalls=2」が達成されたように見えた。
   */
  function measureWeatherReceipt(tag: string, reuse: boolean): {
    serCalls: number;
    buildCalls: number;
    keys: string[];
    pairs: number;
  } {
    vi.useFakeTimers({ toFake: ["Date"], now: CLASSIFICATION_NOW });
    try {
      return withBodyReuse(reuse, () => {
        const harness = makeProductionHarness(tag);
        const router = weatherRouter(harness);
        const lines = withPerfLines((collected) => {
          router.handler(fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", `${tag}-msg`));
          return collected;
        });
        expect(harness.durableFailures).toEqual([]);
        return {
          serCalls: serCallsOf(lines),
          buildCalls: harness.buildCalls(),
          keys: segmentKeys(lines),
          pairs: harness.pairs.length,
        };
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("A2 / A3: 受理 commit + durable 変化ありで serCalls=2 (段階 1 で 3 から減る)", () => {
    const measured = measureWeatherReceipt("sercalls-durable", true);
    // durable callback が実際に走ったことを先に確かめる (走らないと 2 が偽陽性になる)。
    expect(measured.pairs).toBe(1);
    expect(measured.serCalls).toBe(2);
    // A3: deps 差し替えの計数 (中間表現を作った回数) と P4 カウンタが一致する。
    // 再利用が効いた `save` は build を 1 回も走らせない。
    expect(measured.buildCalls).toBe(measured.serCalls);
    // M2: 内訳区間が両方立つ。`save` の内側は `serEnc` だけになる。
    expect(measured.keys).toContain("serIn");
    expect(measured.keys).toContain("serEnc");
    expect(measured.keys).toContain("save");
  });

  it("A2 / A3: 再利用を off にすると従来どおり serCalls=3 に戻る", () => {
    const measured = measureWeatherReceipt("sercalls-fallback", false);
    expect(measured.pairs).toBe(1);
    expect(measured.serCalls).toBe(3);
    expect(measured.buildCalls).toBe(measured.serCalls);
  });

  it("A2: changed.length === 0 の受理で serCalls=0 になり serD / serB / pre が立たない", () => {
    vi.useFakeTimers({ toFake: ["Date"], now: CLASSIFICATION_NOW });
    const harness = makeProductionHarness("sercalls-noop");
    const lines = withStrictMode(false, () => withPerfLines((collected) => {
      beginReceipt("noop-probe", "PROBE", "probe", 0);
      try {
        const result = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          noopMutation(false),
        );
        expect(result.kind).toBe("committed");
      } finally {
        endReceipt();
      }
      return collected;
    }));
    expect(serCallsOf(lines)).toBe(0);
    const keys = segmentKeys(lines);
    expect(keys).not.toContain("serD");
    expect(keys).not.toContain("serB");
    expect(keys).not.toContain("pre");
  });

  /** transact 1 本を receipt 境界で包み、その行の `serCalls` と区間キーを返す。 */
  function measureTransact(
    harness: ReturnType<typeof makeProductionHarness>,
    reduce: Parameters<typeof harness.coordinator.transact>[2],
  ): { serCalls: number; buildCalls: number; keys: string[]; kind: string } {
    let kind = "";
    const lines = withStrictMode(false, () => withPerfLines((collected) => {
      beginReceipt("t-probe", "PROBE", "probe", 0);
      try {
        kind = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          reduce,
        ).kind;
      } finally {
        endReceipt();
      }
      return collected;
    }));
    return {
      serCalls: serCallsOf(lines),
      buildCalls: harness.buildCalls(),
      keys: segmentKeys(lines),
      kind,
    };
  }

  it("A2 / A3: admissionFailure による却下は serCalls=2 のまま", () => {
    const harness = makeProductionHarness("sercalls-reject", {
      validateCandidate: () => "volcanoSubtreeBytesExceeded",
    });
    const measured = measureTransact(harness, standbyMutation("reject"));
    expect(measured.kind).toBe("rejected");
    // serialize は判定より前なので、却下でも 2 回払う (段階 1 で変わらない)。
    expect(measured.serCalls).toBe(2);
    expect(measured.buildCalls).toBe(measured.serCalls);
  });

  it("A2 / A3: staleVersion も serCalls=2 のまま", () => {
    const harness = makeProductionHarness("sercalls-stale");
    const measured = measureTransact(harness, (draft) => {
      const mutated = standbyMutation("stale")(draft);
      // reducer の中から実 owner を直接動かし、`captured.token` を古くする。
      const snapshot = harness.owners.standbyStateStore.cloneSnapshot();
      harness.owners.standbyStateStore.replacePrevalidated({
        ...snapshot,
        version: snapshot.version + 1,
      });
      return mutated;
    });
    expect(measured.kind).toBe("staleVersion");
    expect(measured.serCalls).toBe(2);
    expect(measured.buildCalls).toBe(measured.serCalls);
  });

  /**
   * 受理前 sweep の上乗せを**実電文**で測る。`buildDeadlineScatteredDomains` は
   * 簡易 serializer 向けの fixture で、本番 serializer の不変条件
   * (`unmapped durable revision gate entry` ほか) を満たさず sweep が
   * `candidateSerializationFailed` で `skipped` になる。同じ電文を 2 通流すと
   * 2 通目の受理前 sweep が `full` に落ちるので、そちらを使う。
   */
  function measureSecondReceipt(harness: ReturnType<typeof makeProductionHarness>): {
    serCalls: number;
    buildCalls: number;
    path: string | null;
    keys: string[];
  } {
    vi.useFakeTimers({ toFake: ["Date"], now: CLASSIFICATION_NOW });
    try {
      const router = weatherRouter(harness);
      router.handler(fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", "sweep-first"));
      const before = harness.buildCalls();
      const lines = withStrictMode(false, () => withPerfLines((collected) => {
        router.handler(fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", "sweep-second"));
        return collected;
      }));
      const line = lines.find((entry) => entry.startsWith("[perf-receipt] "));
      const suffix = line?.split(" ").find((token) => token.startsWith("sweepPre="))
        ?.split("/")[1];
      return {
        serCalls: serCallsOf(lines),
        buildCalls: harness.buildCalls() - before,
        path: suffix ?? null,
        keys: segmentKeys(lines),
      };
    } finally {
      vi.useRealTimers();
    }
  }

  it("A2 / A3: 受理前 sweep が full (durable 変化なし) なら +2", () => {
    const harness = makeProductionHarness("sweep-full", { constantEncode: true });
    const measured = measureSecondReceipt(harness);
    expect(measured.path).toBe("full");
    // transact 側は `changed` 空で 0 なので、この行の全量が sweep の上乗せになる。
    expect(measured.keys).not.toContain("serD");
    expect(measured.serCalls).toBe(2);
    expect(measured.buildCalls).toBe(measured.serCalls);
  });

  /**
   * B-2 の決定: `sweepAll` は body を保存も再利用もしない。sweep が commit すると
   * owner version が進むので `captureSerializedPair` は必ずフォールバックし、
   * 段階 1 後も **+3 のまま**になる。ここが +2 に落ちていたら A が sweep へ
   * 漏れ出している。
   */
  it("A2 / A3: 受理前 sweep が full かつ durable 変化ありなら段階 1 後も +3", () => {
    const harness = makeProductionHarness("sweep-full-durable");
    const measured = measureSecondReceipt(harness);
    expect(measured.path).toBe("full");
    expect(measured.keys).not.toContain("serD");
    expect(measured.serCalls).toBe(3);
    expect(measured.buildCalls).toBe(measured.serCalls);
  });
});

// ── A7: C の挙動固定 ────────────────────────────────────────

describe("§4.4 A7: changed が空の transact の契約", () => {
  it("A7: committed / durableChanged=false を返し、owner を 1 bit も変えない", () => {
    const harness = makeProductionHarness("c-committed");
    const before = ownerFingerprint(harness.coordinator);
    const result = harness.coordinator.transact(
      "standby:tornado",
      ["telegramRevisionGate", "standbyStateStore"],
      noopMutation(false),
    );
    expect(result.kind).toBe("committed");
    expect(ownerFingerprint(harness.coordinator)).toEqual(before);
    // durable callback は走らない (`durableChanged=false` なので `emitDurable` に入らない)。
    expect(harness.pairs).toEqual([]);
  });

  it("A7: transactDeferred が durable を申告しつつ changed 空なら deferredDurabilityMismatch", () => {
    const harness = makeProductionHarness("c-deferred");
    const result = harness.coordinator.transactDeferred(
      "typhoonProbability:VPTA50",
      ["telegramRevisionGate", "standbyStateStore"],
      noopMutation(true),
    );
    expect(result).toEqual({ kind: "rejected", reason: "deferredDurabilityMismatch" });
  });

  it("A7: transactDeferred が durable なしを申告した changed 空は committed のまま", () => {
    const harness = makeProductionHarness("c-deferred-ok");
    const result = harness.coordinator.transactDeferred(
      "typhoonProbability:VPTA50",
      ["telegramRevisionGate", "standbyStateStore"],
      noopMutation(false),
    );
    expect(result.kind).toBe("committed");
  });

  it("A7: changed 空でも reducer 内で owner が動いたら staleVersion を返す", () => {
    const harness = makeProductionHarness("c-stale");
    const result = harness.coordinator.transact(
      "standby:tornado",
      ["telegramRevisionGate", "standbyStateStore"],
      () => {
        // reducer の中から実 owner を直接動かす。draft は変えないので
        // `changed` は空のまま、`captured.token` だけが古くなる。
        harness.owners.standbyStateStore.replacePrevalidated({
          ...harness.owners.standbyStateStore.cloneSnapshot(),
          version: harness.owners.standbyStateStore.cloneSnapshot().version + 1,
        });
        return { kind: "accepted" as const, value: "stale", durableChanged: false };
      },
    );
    expect(result.kind).toBe("staleVersion");
  });
});

// ── A8: C の strict 経路が空回りでない ───────────────────────

describe("§4.4 A8: strict モードは changed 空でも壊れた base を検出する", () => {
  const withStrict = <T>(run: () => T): T => withStrictMode(true, run);

  /**
   * base 側の破損は serializer / preflight を差し替えて作る。owner snapshot を
   * 手で壊す方法は `replacePrevalidated` が `new Set(...)` などで正規化してしまい
   * (`telegram-revision-gate.ts:1163-1172`)、壊れたまま座らせられない。
   * ここで確かめたいのは「C が非 strict で見逃す検出を、strict は throw で拾うか」
   * であって、破損の作り方ではない。
   */
  function brokenHarness(options: {
    failSerialize?: boolean;
    failPreflight?: boolean;
  }) {
    const root = makeRoot("c-strict");
    const persistence = new StandbyPersistence(join(root, "display-active-state-v1.json"));
    const split = standbyAdmissionSerializeSplit(persistence);
    return new StandbyPersistenceAdmissionCoordinator({
      owners: makeOwners(),
      serializePairSplit: {
        build: (domains) => {
          if (options.failSerialize === true) {
            throw new Error("standby volcano mirror coupling mismatch");
          }
          return split.build(domains);
        },
        encode: (body, envelope) => split.encode(body, envelope),
      },
      ...(options.failPreflight === true
        ? { validateCandidate: () => "volcanoSubtreeBytesExceeded" }
        : {}),
      canReserveLogicalGeneration: () => persistence.canReserveLogicalGeneration(),
    });
  }

  it("A8: serializer が投げる base (candidateSerializationFailed 系) で strict が throw する", () => {
    const coordinator = brokenHarness({ failSerialize: true });
    withStrict(() => {
      expect(() => coordinator.transact(
        "standby:tornado",
        ["telegramRevisionGate", "standbyStateStore"],
        noopMutation(false),
      )).toThrow(/strict no-op check failed: candidateSerializationFailed/);
    });
    // strict off では同じ入力が committed で素通りする (これが C の (c) 製品緩和)。
    expect(withStrictMode(false, () => coordinator.transact(
      "standby:tornado",
      ["telegramRevisionGate", "standbyStateStore"],
      noopMutation(false),
    )).kind).toBe("committed");
  });

  it("A8: preflight が失敗する base でも strict が throw する", () => {
    const coordinator = brokenHarness({ failPreflight: true });
    withStrict(() => {
      expect(() => coordinator.transact(
        "standby:tornado",
        ["telegramRevisionGate", "standbyStateStore"],
        noopMutation(false),
      )).toThrow(/strict no-op check failed: volcanoSubtreeBytesExceeded/);
    });
    expect(withStrictMode(false, () => coordinator.transact(
      "standby:tornado",
      ["telegramRevisionGate", "standbyStateStore"],
      noopMutation(false),
    )).kind).toBe("committed");
  });

  it("A8: 健全な base では strict が空回りせず committed を返す", () => {
    const harness = makeProductionHarness("c-strict-clean");
    withStrict(() => {
      expect(harness.coordinator.transact(
        "standby:tornado",
        ["telegramRevisionGate", "standbyStateStore"],
        noopMutation(false),
      ).kind).toBe("committed");
    });
  });
});

// ── A9: hot path を重くしていない ────────────────────────────

describe("§4.6 A9: 1MB 超の重い呼び出しが段階 1 で単調減少する", () => {
  function withCallCounters<T>(run: () => T): {
    result: T;
    stringify: number;
    clone: number;
    parse: number;
  } {
    const originalStringify = JSON.stringify;
    const originalParse = JSON.parse;
    const originalClone = globalThis.structuredClone;
    let stringify = 0;
    let clone = 0;
    let parse = 0;
    let counting = false;
    JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown): string => {
      const out = (originalStringify as (
        value: unknown, replacer?: unknown, space?: unknown,
      ) => string)(value, replacer, space);
      if (counting && typeof out === "string" && out.length > ONE_MIB) stringify += 1;
      return out;
    }) as typeof JSON.stringify;
    JSON.parse = ((text: string, reviver?: unknown): unknown => {
      if (counting && typeof text === "string" && text.length > ONE_MIB) parse += 1;
      return (originalParse as (text: string, reviver?: unknown) => unknown)(text, reviver);
    }) as typeof JSON.parse;
    globalThis.structuredClone = ((value: unknown, options?: unknown): unknown => {
      const out = (originalClone as (value: unknown, options?: unknown) => unknown)(
        value,
        options,
      );
      if (counting) {
        let size = 0;
        try {
          size = originalStringify(value)?.length ?? 0;
        } catch {
          size = 0;
        }
        if (size > ONE_MIB) clone += 1;
      }
      return out;
    }) as typeof globalThis.structuredClone;
    try {
      counting = true;
      const result = run();
      counting = false;
      return { result, stringify, clone, parse };
    } finally {
      counting = false;
      JSON.stringify = originalStringify;
      JSON.parse = originalParse;
      globalThis.structuredClone = originalClone;
    }
  }

  function measure(tag: string, reuse: boolean) {
    vi.useFakeTimers({ toFake: ["Date"], now: CLASSIFICATION_NOW });
    try {
      return withBodyReuse(reuse, () => {
        const harness = makeProductionHarness(tag);
        const router = weatherRouter(harness);
        // 1 通目で state を積み、2 通目 (計測対象) を大きな状態の上で流す。
        router.handler(fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", "a9-warm"));
        const counted = withCallCounters(() => {
          router.handler(fixtureMessage(FIXTURE_VPWW55_OAME, "VPWW55", "a9-measure"));
        });
        expect(harness.durableFailures).toEqual([]);
        return counted;
      });
    } finally {
      vi.useRealTimers();
    }
  }

  it("A9: 再利用ありの重い呼び出し回数が、再利用なしを上回らない", () => {
    const reused = measure("a9-reuse", true);
    const fallback = measure("a9-fallback", false);
    expect(reused.stringify).toBeLessThanOrEqual(fallback.stringify);
    expect(reused.clone).toBeLessThanOrEqual(fallback.clone);
    expect(reused.parse).toBeLessThanOrEqual(fallback.parse);
  });
});
