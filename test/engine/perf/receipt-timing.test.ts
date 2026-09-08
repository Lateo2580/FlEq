/**
 * 電文受理経路の所要時間計測ログ spec
 * (`docs/specs/2026-09-08-receipt-path-timing-log.md`) の受入 A1〜A12。
 *
 * - A1 / A2 (§4.1): off で計測モジュールの時計を 1 回も呼ばず `[perf-` 行も出さない
 * - A3 / A4 (§4.2): on で電文 1 通 = `[perf-receipt]` 1 行。`:2001` 経路でも出る
 * - A5 / A6 (§4.3): `serCalls` の実測固定と、deps 差し替え / P4 カウンタの一致
 * - A7 (§4.4): off / on で受理結果・v2/v1 バイト列・owner snapshot・outcome 列が一致
 * - A8 (§4.5): off / on で 1MB 超の JSON.stringify / structuredClone 回数が一致
 * - A9 / A10: 却下・非 admission 電文の `admit=`、`sweepPre=` の 3 出口
 * - A11: スイート全体で `[perf-receipt-lost]` が 0 行
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as log from "../../../src/logger";
import {
  __test_setReceiptPerfClock,
  __test_setReceiptPerfEnabled,
  beginReceipt,
  beginSweep,
  beginTurn,
  endReceipt,
  endSweep,
  endTurn,
  mark,
  receiptPerfEnabled,
} from "../../../src/engine/perf/receipt-timing";
import { createMessageHandler } from "../../../src/engine/messages/message-router";
import {
  StandbyPersistenceAdmissionCoordinator,
  STANDBY_PERSISTENCE_OWNER_ORDER,
  type StandbyPersistenceDomainSnapshots,
  type StandbySerializedPair,
} from "../../../src/engine/display/standby-persistence-admission";
import { StandbyStateStore } from "../../../src/engine/display/standby-state-store";
import { Vpws50StateHolder } from "../../../src/engine/messages/vpws50-state";
import { Vpww56StateHolder } from "../../../src/engine/messages/vpww56-state";
import { TsunamiStateHolder } from "../../../src/engine/messages/tsunami-state";
import { VolcanoStateHolder } from "../../../src/engine/messages/volcano-state";
import { FloodForecastStateHolder } from "../../../src/engine/messages/flood-forecast-state";
import { TelegramRevisionGate } from "../../../src/engine/messages/telegram-revision-gate";
import {
  buildDeadlineScatteredDomains,
  DEADLINE_BASE_MS,
} from "../../helpers/standby-sweep-deadline-state";
import {
  createMockWsDataMessageFromXml,
  FIXTURE_VPWS50_AGGREGATE,
  FIXTURE_VPTA50_DAMREY,
  FIXTURE_VPWP50_NAGANO,
  FIXTURE_VXSE45_S1,
  FIXTURE_VXSE51_SHINDO,
  readFixture,
} from "../../helpers/mock-message";
import { InfoDisplayHub } from "../../../src/engine/display/hub";
import { DisplayStateStore } from "../../../src/engine/display/state-store";
import { STATE_DEBOUNCE_MS, SWEEP_INTERVAL_MS } from "../../../src/engine/display/constants";
import type { WsDataMessage } from "../../../src/types";

const ONE_MIB = 1024 * 1024;

const SERIALIZATION_ENVELOPE = {
  logicalGeneration: "1",
  savedAt: "2026-09-08T00:00:00.000Z",
} as const;

/** 電文行の必須 7 キーと、順序だけ固定した区間キー (§4.2)。 */
const RECEIPT_SEGMENT_ORDER = [
  "sweepPre",
  "cap",
  "draft",
  "red",
  "redParse",
  "diff",
  "serD",
  "serB",
  "pre",
  "commit",
  "save",
] as const;

const RECEIPT_LINE = new RegExp(
  "^\\[perf-receipt\\] id=(\\S*) type=(\\S+) route=(\\S+) bytes=(\\d+)"
  + " admit=(\\S+) serCalls=(\\d+) total=(-?\\d+\\.\\d)"
  + "((?: [A-Za-z]+=-?\\d+\\.\\d(?:/(?:precheck|nochange|full|skipped))?)*)$",
);

interface ParsedReceipt {
  id: string;
  type: string;
  route: string;
  bytes: number;
  admit: string;
  serCalls: number;
  total: number;
  segments: { key: string; value: number; suffix: string | null }[];
}

function parseReceiptLine(line: string): ParsedReceipt {
  const matched = RECEIPT_LINE.exec(line);
  if (matched == null) throw new Error(`unparsable [perf-receipt] line: ${line}`);
  const segments = (matched[8] ?? "").trim().length === 0
    ? []
    : matched[8].trim().split(" ").map((token) => {
        const [key, raw] = token.split("=");
        const [value, suffix] = raw.split("/");
        return { key, value: Number(value), suffix: suffix ?? null };
      });
  return {
    id: matched[1],
    type: matched[2],
    route: matched[3],
    bytes: Number(matched[4]),
    admit: matched[5],
    serCalls: Number(matched[6]),
    total: Number(matched[7]),
    segments,
  };
}

/** `log.info` を差し替えて `[perf-` 行だけ拾う。戻す責務は呼び出し側の finally。 */
function capturePerfLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(log, "info").mockImplementation((msg: string) => {
    if (msg.startsWith("[perf-")) lines.push(msg);
  });
  return { lines, restore: () => spy.mockRestore() };
}

/** 計測 on / off と時計注入を必ず戻す (§3.1)。 */
function withPerf<T>(
  enabled: boolean,
  run: (ctx: { lines: string[]; clockCalls: () => number }) => T,
): T {
  let clockCalls = 0;
  let tick = 0;
  const previousEnabled = __test_setReceiptPerfEnabled(enabled);
  const previousClock = __test_setReceiptPerfClock(() => {
    clockCalls += 1;
    tick += 1;
    return tick;
  });
  const captured = capturePerfLines();
  try {
    return run({ lines: captured.lines, clockCalls: () => clockCalls });
  } finally {
    captured.restore();
    __test_setReceiptPerfClock(previousClock);
    __test_setReceiptPerfEnabled(previousEnabled);
  }
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

/**
 * deps 差し替えで数えた serialize 回数 (1) と、P4 のカウンタが読む
 * `[perf-receipt] serCalls=` (2) を突き合わせるための harness (§4.3)。
 */
function makeHarness(options: {
  serializePair?: (
    domains: Readonly<StandbyPersistenceDomainSnapshots>,
  ) => StandbySerializedPair;
  validateCandidate?: () => string | null;
  wireDurableSave?: boolean;
} = {}) {
  const owners = makeOwners();
  let depsCalls = 0;
  const serialize = options.serializePair
    ?? ((domains: Readonly<StandbyPersistenceDomainSnapshots>) => {
      const encoded = new TextEncoder().encode(JSON.stringify(domains));
      return { v2: encoded, v1: encoded };
    });
  const coordinator = new StandbyPersistenceAdmissionCoordinator({
    owners,
    serializePair: (domains) => {
      depsCalls += 1;
      return serialize(domains);
    },
    ...(options.validateCandidate == null
      ? {}
      : { validateCandidate: options.validateCandidate }),
  });
  if (options.wireDurableSave === true) {
    // monitor.ts:387-390 と同じ形。commit 後の 3 回目 serialize (§2.4 / P5)。
    coordinator.onDurable(() => {
      mark("save", () => coordinator.captureSerializedPair(SERIALIZATION_ENVELOPE));
    });
  }
  return { owners, coordinator, depsCalls: () => depsCalls };
}

/** 電文 1 通ぶんの受理境界を張って `[perf-receipt]` を 1 行出させる。 */
function withReceipt<T>(meta: {
  id?: string;
  type?: string;
  route?: string;
  bytes?: number;
}, run: () => T): T {
  beginReceipt(meta.id ?? "probe", meta.type ?? "PROBE", meta.route ?? "probe", meta.bytes ?? 0);
  try {
    return run();
  } finally {
    endReceipt();
  }
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => {
    if (child instanceof Map) return { $map: [...child] };
    if (child instanceof Set) return { $set: [...child] };
    return child;
  });
}

function ownerSnapshotFingerprint(
  coordinator: StandbyPersistenceAdmissionCoordinator,
): Record<string, string> {
  const domains = coordinator.capture().domains as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const owner of STANDBY_PERSISTENCE_OWNER_ORDER) {
    out[owner] = canonicalJson(domains[owner]);
  }
  return out;
}

/** 測定中だけ `JSON.stringify` / `structuredClone` を包む (§4.5、hot-path テストの流用)。 */
function withCallCounters<T>(run: () => T): {
  result: T;
  bigStringifyCalls: number;
  bigStructuredCloneCalls: number;
} {
  const originalStringify = JSON.stringify;
  const originalClone = globalThis.structuredClone;
  let bigStringifyCalls = 0;
  let bigStructuredCloneCalls = 0;
  let counting = false;
  JSON.stringify = ((value: unknown, replacer?: unknown, space?: unknown): string => {
    const out = (originalStringify as (
      value: unknown,
      replacer?: unknown,
      space?: unknown,
    ) => string)(value, replacer, space);
    if (counting && typeof out === "string" && out.length > ONE_MIB) bigStringifyCalls += 1;
    return out;
  }) as typeof JSON.stringify;
  globalThis.structuredClone = ((value: unknown, cloneOptions?: unknown): unknown => {
    const out = (originalClone as (value: unknown, options?: unknown) => unknown)(
      value,
      cloneOptions,
    );
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
    counting = false;
    return { result, bigStringifyCalls, bigStructuredCloneCalls };
  } finally {
    counting = false;
    JSON.stringify = originalStringify;
    globalThis.structuredClone = originalClone;
  }
}

// ── 電文 fixture ──────────────────────────────────────────────

const CLASSIFICATION_NOW = Date.parse("2025-06-30T00:00:00.000Z");

function fixtureMessage(
  fixture: string,
  headType: string,
  id: string,
  receivedAtMs = CLASSIFICATION_NOW,
): WsDataMessage {
  const message = createMockWsDataMessageFromXml(readFixture(fixture), headType);
  if (message.meta == null) throw new Error(`fixture meta missing: ${fixture}`);
  return {
    ...message,
    id,
    meta: { ...message.meta, messageId: id, receivedAtMs },
  };
}

function vpws50Message(id = "vpws50-perf"): WsDataMessage {
  return fixtureMessage(FIXTURE_VPWS50_AGGREGATE, "VPWS50", id);
}

function vpta50Message(id = "vpta50-perf"): WsDataMessage {
  const xml = readFixture(FIXTURE_VPTA50_DAMREY).replace(
    /<ReportDateTime>[^<]*<\/ReportDateTime>/,
    "<ReportDateTime>2020-09-30T15:30:00+09:00</ReportDateTime>",
  );
  const message = createMockWsDataMessageFromXml(xml, "VPTA50");
  if (message.meta == null) throw new Error("VPTA50 fixture meta missing");
  return {
    ...message,
    id,
    meta: {
      ...message.meta,
      messageId: id,
      receivedAtMs: Date.parse("2020-09-30T07:00:00.000Z"),
    },
  };
}

function vpwp50Message(id = "vpwp50-perf"): WsDataMessage {
  return fixtureMessage(FIXTURE_VPWP50_NAGANO, "VPWP50", id, Date.parse("2026-06-05T10:55:00.000Z"));
}

function quakeMessage(id = "vxse51-perf"): WsDataMessage {
  return fixtureMessage(FIXTURE_VXSE51_SHINDO, "VXSE51", id);
}

function eewMessage(id = "vxse45-perf"): WsDataMessage {
  return fixtureMessage(FIXTURE_VXSE45_S1, "VXSE45", id);
}

interface RouterHarness {
  handler: (message: WsDataMessage) => void;
  outcomes: unknown[];
  coordinator: StandbyPersistenceAdmissionCoordinator;
  depsCalls: () => number;
}

function routerHarness(options: { isolateEewLogger?: boolean } = {}): RouterHarness {
  const harness = makeHarness({ wireDurableSave: true });
  const outcomes: unknown[] = [];
  const router = createMessageHandler({
    clock: { nowMs: () => CLASSIFICATION_NOW },
    // 既定の `new EewEventLogger()` は作業ディレクトリの `eew-logs/` へ実書き込みし、
    // `test/engine/replay/replay-isolation.test.ts` を落とす。EEW を流すときだけ隔離する。
    ...(options.isolateEewLogger === true
      ? {
          eewLogger: {
            logReport: () => undefined,
            closeEvent: () => undefined,
            closeAll: () => undefined,
          } as never,
        }
      : {}),
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
  return {
    handler: (message) => router.handler(message),
    outcomes,
    coordinator: harness.coordinator,
    depsCalls: harness.depsCalls,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── A1 / A2: off のゼロコスト ────────────────────────────────

describe("§4.1 off のゼロコスト検証", () => {
  it("A1 / A2: off で計測モジュールの時計を 1 回も呼ばず [perf- 行も出さない", () => {
    const captured = withPerf(false, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("off-1"));
      router.handler(vpta50Message("off-2"));
      router.handler(quakeMessage("off-3"));
      return { clockCalls: ctx.clockCalls(), lines: [...ctx.lines] };
    });
    expect(captured.clockCalls).toBe(0);
    expect(captured.lines).toEqual([]);
  });

  it("off では receiptPerfEnabled が false で mark が素通しする", () => {
    withPerf(false, (ctx) => {
      expect(receiptPerfEnabled()).toBe(false);
      expect(mark("cap", () => 42)).toBe(42);
      withReceipt({}, () => undefined);
      expect(ctx.clockCalls()).toBe(0);
      expect(ctx.lines).toEqual([]);
    });
  });
});

// ── A3 / A4 / A9: 行フォーマットと admit ──────────────────────

describe("§4.2 on の行フォーマット検証", () => {
  it("A3 / A4: VPWS50 で [perf-receipt] がちょうど 1 行出て必須 7 キーが揃う", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("on-vpws50"));
      return [...ctx.lines];
    });
    const receipts = lines.filter((line) => line.startsWith("[perf-receipt] "));
    expect(receipts).toHaveLength(1);
    const parsed = parseReceiptLine(receipts[0]);
    expect(parsed.id).toBe("on-vpws50");
    expect(parsed.type).toBe("VPWS50");
    expect(parsed.route).toBe("weather");
    expect(parsed.bytes).toBeGreaterThan(0);
    expect(Number.isFinite(parsed.total)).toBe(true);
    expect(Number.isFinite(parsed.serCalls)).toBe(true);
    for (const segment of parsed.segments) {
      expect(Number.isFinite(segment.value)).toBe(true);
    }
    expect(lines.some((line) => line.startsWith("[perf-receipt-lost]"))).toBe(false);
  });

  it("A4: 区間キーの順序が固定されている", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("order-vpws50"));
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    const keys = parsed.segments.map((segment) => segment.key);
    for (const key of keys) expect(RECEIPT_SEGMENT_ORDER).toContain(key);
    const positions = keys.map((key) => RECEIPT_SEGMENT_ORDER.indexOf(key as never));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("P6: weather 経路では reducer 内の 2 回目 parse が redParse として red の内数で出る", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("redparse-vpws50"));
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    const red = parsed.segments.find((segment) => segment.key === "red");
    const redParse = parsed.segments.find((segment) => segment.key === "redParse");
    expect(red).toBeDefined();
    expect(redParse).toBeDefined();
    // 入れ子は親から引かない。`red` のうち `redParse` が内数になる (§3.2)。
    expect(redParse!.value).toBeLessThanOrEqual(red!.value);
    expect(parsed.segments.find((segment) => segment.key === "sweepPre")?.suffix).toBe("nochange");
  });

  it("A3 (B1 回帰): :2001 の suppression 経路 (VPTA50 / VPWP50) でも 1 行出る", () => {
    for (const [message, route] of [
      [vpta50Message("supp-vpta"), "typhoonProbability"],
      [vpwp50Message("supp-vpwp"), "weatherWarningTimeseries"],
    ] as const) {
      const lines = withPerf(true, (ctx) => {
        const router = routerHarness();
        router.handler(message);
        return [...ctx.lines];
      });
      const receipts = lines.filter((line) => line.startsWith("[perf-receipt] "));
      expect(receipts).toHaveLength(1);
      expect(parseReceiptLine(receipts[0]).route).toBe(route);
    }
  });

  /**
   * 起草時の spec §3.3 P3i は「地震・EEW 等は admit=none」と書いていたが、地震 (VXSE51) は
   * `standby:quakeHost` で admission に入り `admit=committed` になる (実測)。admission へ
   * 到達しない本来の例は EEW (VXSE45)。router の実 `EewEventLogger` は `eew-logs/` へ
   * 実書き込みするので隔離 sink を渡す。
   */
  it("A9: admission に入らない電文 (EEW) は admit=none", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness({ isolateEewLogger: true });
      router.handler(eewMessage("none-vxse45"));
      return [...ctx.lines];
    });
    const receipts = lines.filter((line) => line.startsWith("[perf-receipt] "));
    expect(receipts).toHaveLength(1);
    const parsed = parseReceiptLine(receipts[0]);
    expect(parsed.admit).toBe("none");
    expect(parsed.serCalls).toBe(0);
  });

  /**
   * §1.2 の仮説 (events ファイルが無いのに停止する電文) に対応する行。この VPWP50 は
   * **日付ゲートで `futureSkewExceeded` として弾かれた**電文であって、admission へ入って
   * から抜けた電文ではない。弾かれても行が 1 行出ることを固定する。
   */
  it("A9: 日付ゲートで弾かれた電文でも行が 1 行出て admit=none になる", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpwp50Message("gated-vpwp50"));
      return [...ctx.lines];
    });
    const receipts = lines.filter((line) => line.startsWith("[perf-receipt] "));
    expect(receipts).toHaveLength(1);
    const parsed = parseReceiptLine(receipts[0]);
    expect(parsed.admit).toBe("none");
    expect(parsed.segments).toEqual([]);
  });

  it("[perf-env] / [perf-turn] は独立行として出る", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("lines-vpws50"));
      return [...ctx.lines];
    });
    expect(lines.filter((line) => line.startsWith("[perf-env] "))).toHaveLength(1);
    expect(lines.filter((line) => line.startsWith("[perf-turn] "))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith("[perf-env] "))).toMatch(
      /^\[perf-env\] ordinal=\d+ ms=-?\d+\.\d bytes=\d+$/,
    );
    expect(lines.find((line) => line.startsWith("[perf-turn] "))).toMatch(
      /^\[perf-turn\] envelopes=\d+ total=-?\d+\.\d heapDeltaMB=-?\d+\.\d$/,
    );
  });
});

// ── A9: 却下ケースの admit ────────────────────────────────────

describe("§4.2 拡張 / A9 却下ケースの admit", () => {
  function standbyMutation(tag: string) {
    return (draft: StandbyPersistenceDomainSnapshots) => {
      draft.standbyStateStore = {
        ...draft.standbyStateStore,
        data: {
          ...draft.standbyStateStore.data,
          briefingGeneration: draft.standbyStateStore.data.briefingGeneration + 1,
        },
      };
      return { kind: "accepted" as const, value: tag, durableChanged: true };
    };
  }

  it("reducer の rejected は admit=rejected:<reason> で serialize 前に抜ける", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness();
      withReceipt({ id: "reducer-reject" }, () => {
        const result = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          () => ({ kind: "rejected" as const, reason: "probeReducerRejected" }),
        );
        expect(result.kind).toBe("rejected");
      });
      expect(harness.depsCalls()).toBe(0);
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.admit).toBe("rejected:probeReducerRejected");
    expect(parsed.serCalls).toBe(0);
  });

  it("admissionFailure は admit=rejected:<reason> で serialize を 2 回払っている", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness({ validateCandidate: () => "probeAdmissionFailure" });
      withReceipt({ id: "admission-fail" }, () => {
        const result = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          standbyMutation("A"),
        );
        expect(result).toEqual({ kind: "rejected", reason: "probeAdmissionFailure" });
      });
      expect(harness.depsCalls()).toBe(2);
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.admit).toBe("rejected:probeAdmissionFailure");
    expect(parsed.serCalls).toBe(2);
  });

  it("invalidTouchedOwners は capture 前に抜けるので区間キーが 1 つも立たない", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness();
      withReceipt({ id: "invalid-owners" }, () => {
        const result = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate"],
          standbyMutation("B"),
        );
        expect(result).toEqual({ kind: "rejected", reason: "invalidTouchedOwners" });
      });
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.admit).toBe("rejected:invalidTouchedOwners");
    expect(parsed.segments).toEqual([]);
  });

  it("staleVersion は admit=staleVersion で出る", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness();
      withReceipt({ id: "stale" }, () => {
        const result = harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          (draft) => {
            // reduce の内側で実 owner を進め、captured.token を陳腐化させる。
            harness.owners.standbyStateStore.replacePrevalidated(
              structuredClone(harness.coordinator.capture().domains.standbyStateStore),
            );
            return standbyMutation("C")(draft);
          },
        );
        expect(result.kind).toBe("staleVersion");
      });
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.admit).toBe("staleVersion");
    expect(parsed.serCalls).toBe(2);
  });
});

// ── A5 / A6: serCalls の実測固定 ─────────────────────────────

describe("§4.3 serCalls の実測固定", () => {
  function standbyMutation(tag: string) {
    return (draft: StandbyPersistenceDomainSnapshots) => {
      draft.standbyStateStore = {
        ...draft.standbyStateStore,
        data: {
          ...draft.standbyStateStore.data,
          briefingGeneration: draft.standbyStateStore.data.briefingGeneration + 1,
        },
      };
      return { kind: "accepted" as const, value: tag, durableChanged: true };
    };
  }

  /** 定数 pair を返す serializer。`durableChanged` を必ず false にする。 */
  const constantPair = (): StandbySerializedPair => ({
    v2: new Uint8Array([1]),
    v1: new Uint8Array([1]),
  });

  function measureTransact(options: {
    serializePair?: (
      domains: Readonly<StandbyPersistenceDomainSnapshots>,
    ) => StandbySerializedPair;
    wireDurableSave?: boolean;
  }): { serCalls: number; depsCalls: number; admit: string } {
    return withPerf(true, (ctx) => {
      const harness = makeHarness(options);
      withReceipt({ id: "ser-probe" }, () => {
        harness.coordinator.transact(
          "standby:tornado",
          ["telegramRevisionGate", "standbyStateStore"],
          standbyMutation("X"),
        );
      });
      const parsed = parseReceiptLine(
        ctx.lines.filter((line) => line.startsWith("[perf-receipt] "))[0],
      );
      return { serCalls: parsed.serCalls, depsCalls: harness.depsCalls(), admit: parsed.admit };
    });
  }

  it("A5 / A6: 受理 commit + durable 変化ありで serCalls=3", () => {
    const measured = measureTransact({ wireDurableSave: true });
    expect(measured.admit).toBe("committed");
    expect(measured.serCalls).toBe(3);
    expect(measured.depsCalls).toBe(measured.serCalls);
  });

  it("A5 / A6: 受理 commit + durable 変化なしで serCalls=2", () => {
    const measured = measureTransact({ serializePair: constantPair, wireDurableSave: true });
    expect(measured.admit).toBe("committed");
    expect(measured.serCalls).toBe(2);
    expect(measured.depsCalls).toBe(measured.serCalls);
  });

  /** 受理前 sweep の 3 出口ぶんの上乗せを測る。 */
  function measureSweep(options: {
    seedDeadlineState: boolean;
    serializePair?: (
      domains: Readonly<StandbyPersistenceDomainSnapshots>,
    ) => StandbySerializedPair;
    wireDurableSave?: boolean;
    warmUp: boolean;
    sweepAtMs: number;
  }): { serCalls: number; depsCalls: number; path: string | null; sweepSeen: boolean } {
    return withPerf(true, (ctx) => {
      const harness = makeHarness({
        ...(options.serializePair == null ? {} : { serializePair: options.serializePair }),
        ...(options.wireDurableSave == null ? {} : { wireDurableSave: options.wireDurableSave }),
      });
      if (options.seedDeadlineState) {
        harness.coordinator.restorePrevalidated(buildDeadlineScatteredDomains(
          structuredClone(harness.coordinator.capture().domains) as StandbyPersistenceDomainSnapshots,
        ));
      }
      if (options.warmUp) harness.coordinator.sweepAll(options.sweepAtMs);
      const before = harness.depsCalls();
      withReceipt({ id: "sweep-probe" }, () => {
        mark("sweepPre", () => harness.coordinator.sweepAll(options.sweepAtMs));
      });
      const parsed = parseReceiptLine(
        ctx.lines.filter((line) => line.startsWith("[perf-receipt] "))[0],
      );
      const sweepSegment = parsed.segments.find((segment) => segment.key === "sweepPre");
      return {
        serCalls: parsed.serCalls,
        depsCalls: harness.depsCalls() - before,
        path: sweepSegment?.suffix ?? null,
        sweepSeen: sweepSegment != null,
      };
    });
  }

  it("A5 / A10: 受理前 sweep が precheck なら +0", () => {
    const measured = measureSweep({
      seedDeadlineState: false,
      warmUp: true,
      sweepAtMs: DEADLINE_BASE_MS,
    });
    expect(measured.sweepSeen).toBe(true);
    expect(measured.path).toBe("precheck");
    expect(measured.serCalls).toBe(0);
    expect(measured.depsCalls).toBe(0);
  });

  it("A5 / A10: 受理前 sweep が nochange なら +0", () => {
    const measured = measureSweep({
      seedDeadlineState: false,
      warmUp: false,
      sweepAtMs: DEADLINE_BASE_MS,
    });
    expect(measured.sweepSeen).toBe(true);
    expect(measured.path).toBe("nochange");
    expect(measured.serCalls).toBe(0);
    expect(measured.depsCalls).toBe(0);
  });

  it("A5 / A10: 受理前 sweep が full (durable 変化なし) なら +2", () => {
    const measured = measureSweep({
      seedDeadlineState: true,
      serializePair: constantPair,
      warmUp: false,
      sweepAtMs: DEADLINE_BASE_MS + 30 * 24 * 60 * 60_000,
    });
    expect(measured.path).toBe("full");
    expect(measured.serCalls).toBe(2);
    expect(measured.depsCalls).toBe(2);
  });

  it("A5 / A10: 受理前 sweep が full かつ durable 変化ありなら +3", () => {
    const measured = measureSweep({
      seedDeadlineState: true,
      wireDurableSave: true,
      warmUp: false,
      sweepAtMs: DEADLINE_BASE_MS + 30 * 24 * 60 * 60_000,
    });
    expect(measured.path).toBe("full");
    expect(measured.serCalls).toBe(3);
    expect(measured.depsCalls).toBe(3);
  });
});

// ── A7 / A8: 挙動不変 ────────────────────────────────────────

describe("§4.4 / §4.5 挙動不変の検証", () => {
  const invarianceMessage = vpws50Message("invariance");

  function runFixture(): {
    outcomes: string;
    owners: Record<string, string>;
    pair: { v2: string; v1: string };
    serialized: number;
  } {
    const router = routerHarness();
    router.handler(invarianceMessage);
    const captured = router.coordinator.captureSerializedPair(SERIALIZATION_ENVELOPE);
    return {
      outcomes: canonicalJson(router.outcomes),
      owners: ownerSnapshotFingerprint(router.coordinator),
      pair: {
        v2: Buffer.from(captured.v2).toString("base64"),
        v1: Buffer.from(captured.v1).toString("base64"),
      },
      serialized: router.depsCalls(),
    };
  }

  /**
   * `Vpws50StateHolder` は `lastSuccessfulFullDisplayAt` に `new Date()` を書く
   * (`vpws50-state.ts:845` / `:882`、DI 無し)。同一入力の 2 回実行でも壁時計ぶんだけ
   * snapshot と serialize 結果がずれるので、Date だけを固定してから比較する。
   */
  function withFrozenDate<T>(run: () => T): T {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T00:00:00.000Z"));
    try {
      return run();
    } finally {
      vi.useRealTimers();
    }
  }

  it("A7: off / on で outcome 列・owner snapshot・v2/v1 バイト列が完全一致する", () => {
    const off = withFrozenDate(() => withPerf(false, () => runFixture()));
    const on = withFrozenDate(() => withPerf(true, () => runFixture()));
    expect(on.outcomes).toBe(off.outcomes);
    expect(on.owners).toEqual(off.owners);
    expect(on.pair).toEqual(off.pair);
    expect(on.serialized).toBe(off.serialized);
  });

  it("A8: off / on で 1MB 超の JSON.stringify / structuredClone 回数が一致する", () => {
    const off = withFrozenDate(() => withPerf(false, () => withCallCounters(() => runFixture())));
    const on = withFrozenDate(() => withPerf(true, () => withCallCounters(() => runFixture())));
    // 「0 === 0」の空検査にならないこと。1MiB 超が 1 度も出ないなら計測の側が壊れている。
    expect(off.bigStringifyCalls + off.bigStructuredCloneCalls).toBeGreaterThan(0);
    expect(on.bigStringifyCalls).toBe(off.bigStringifyCalls);
    expect(on.bigStructuredCloneCalls).toBe(off.bigStructuredCloneCalls);
  });
});

// ── A11: 未確定 collector の上書き ───────────────────────────

describe("§3.2 未確定 collector の上書き", () => {
  it("beginReceipt が未確定の receipt を捨てるとき [perf-receipt-lost] を 1 行出す", () => {
    const lines = withPerf(true, (ctx) => {
      beginReceipt("first-telegram-id-that-is-long", "VPWS50", "weather", 10);
      beginReceipt("second", "VPWS50", "weather", 20);
      endReceipt();
      return [...ctx.lines];
    });
    const lost = lines.filter((line) => line.startsWith("[perf-receipt-lost] "));
    expect(lost).toEqual(["[perf-receipt-lost] id=first-telegram-i reason=overwritten"]);
    expect(lines.filter((line) => line.startsWith("[perf-receipt] "))).toHaveLength(1);
  });

  it("M1: mark(\"sweepPre\") の外で走った sweepAll は suffix を書かない", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness();
      withReceipt({ id: "outside-sweep" }, () => {
        // volcano-route-handler.ts:186 / :230 の sweepStatefulFoundation 相当。
        // 受理スタック上だが mark("sweepPre") の外。
        harness.coordinator.sweepAll(DEADLINE_BASE_MS);
      });
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.segments.find((segment) => segment.key === "sweepPre")).toBeUndefined();
  });

  it("M1: 計測した sweep の出口だけが suffix になり、外側の sweepAll に上書きされない", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness();
      withReceipt({ id: "guarded-sweep" }, () => {
        harness.coordinator.sweepAll(DEADLINE_BASE_MS);                    // nochange (計測外)
        mark("sweepPre", () => harness.coordinator.sweepAll(DEADLINE_BASE_MS)); // precheck (計測)
        harness.coordinator.sweepAll(DEADLINE_BASE_MS);                    // 計測外の後続
      });
      return [...ctx.lines];
    });
    const parsed = parseReceiptLine(lines.filter((l) => l.startsWith("[perf-receipt] "))[0]);
    expect(parsed.segments.find((segment) => segment.key === "sweepPre")?.suffix).toBe("precheck");
  });

  it("M2: turn が閉じないまま次の turn が始まったら [perf-turn-lost] を出す", () => {
    const lines = withPerf(true, (ctx) => {
      beginTurn();
      beginTurn();
      endTurn(1);
      return [...ctx.lines];
    });
    expect(lines.filter((line) => line.startsWith("[perf-turn-lost]")))
      .toEqual(["[perf-turn-lost] reason=overwritten"]);
    expect(lines.filter((line) => line.startsWith("[perf-turn] "))).toHaveLength(1);
  });

  it("beginSweep が生きた receipt を潰すときも lost 行を残す", () => {
    const lines = withPerf(true, (ctx) => {
      beginReceipt("live-receipt", "VPWS50", "weather", 1);
      beginSweep();
      endSweep();
      return [...ctx.lines];
    });
    expect(lines.filter((line) => line.startsWith("[perf-receipt-lost]")))
      .toEqual(["[perf-receipt-lost] id=live-receipt reason=sweepOverwrote"]);
  });

  it("closer の kind 違いも黙って捨てず lost 行を残す", () => {
    const receiptClosedSweep = withPerf(true, (ctx) => {
      beginSweep();
      endReceipt();
      return [...ctx.lines];
    });
    expect(receiptClosedSweep).toEqual(["[perf-receipt-lost] id=- reason=kindMismatch"]);
    const sweepClosedReceipt = withPerf(true, (ctx) => {
      beginReceipt("mismatched", "VPWS50", "weather", 1);
      endSweep();
      return [...ctx.lines];
    });
    expect(sweepClosedReceipt).toEqual(["[perf-receipt-lost] id=mismatched reason=kindMismatch"]);
  });

  it("A11: 通常の router 経路では [perf-receipt-lost] が出ない", () => {
    const lines = withPerf(true, (ctx) => {
      const router = routerHarness();
      router.handler(vpws50Message("no-loss-1"));
      router.handler(vpta50Message("no-loss-2"));
      router.handler(vpwp50Message("no-loss-3"));
      router.handler(quakeMessage("no-loss-4"));
      return [...ctx.lines];
    });
    expect(lines.filter((line) => line.startsWith("[perf-receipt-lost]"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("[perf-turn-lost]"))).toEqual([]);
    expect(lines.filter((line) => line.startsWith("[perf-receipt] "))).toHaveLength(4);
  });
});

// ── 誤帰属の防止 ─────────────────────────────────────────────

describe("§3.2 受理経路外の呼び出しは計測しない", () => {
  it("collector が null のとき transact / sweepAll の区間は誰にも加算されない", () => {
    const lines = withPerf(true, (ctx) => {
      const harness = makeHarness({ wireDurableSave: true });
      // 受理境界の外 (startup 復元・REST repair 相当)。
      harness.coordinator.sweepAll(DEADLINE_BASE_MS);
      harness.coordinator.transact(
        "standby:tornado",
        ["telegramRevisionGate", "standbyStateStore"],
        (draft) => {
          draft.standbyStateStore = {
            ...draft.standbyStateStore,
            data: {
              ...draft.standbyStateStore.data,
              briefingGeneration: draft.standbyStateStore.data.briefingGeneration + 1,
            },
          };
          return { kind: "accepted" as const, value: 1, durableChanged: true };
        },
      );
      // 直後の電文行に前段の区間が混ざらないこと。
      withReceipt({ id: "clean" }, () => undefined);
      return [...ctx.lines];
    });
    const receipts = lines.filter((line) => line.startsWith("[perf-receipt] "));
    expect(receipts).toHaveLength(1);
    const parsed = parseReceiptLine(receipts[0]);
    expect(parsed.segments).toEqual([]);
    expect(parsed.serCalls).toBe(0);
    expect(parsed.admit).toBe("none");
  });
});

// ── P7 / P8: hub の独立行 ────────────────────────────────────

describe("§3.3 P7 / P8 hub の独立行", () => {
  const HUB_NOW = Date.parse("2026-09-08T00:00:00.000Z");

  function makeHub(standbySweep: (nowMs: number) => { viewChanged: boolean; durableChanged: boolean }) {
    const store = new DisplayStateStore();
    return new InfoDisplayHub(store, {
      summarize: () => "要約",
      weatherAlerts: () => [],
      now: () => HUB_NOW,
      standbySweep,
    });
  }

  it("5 秒タイマーの sweep は [perf-sweep] 1 行、debounce 後の縮退ラダーは [perf-state] 1 行", () => {
    vi.useFakeTimers();
    try {
      const lines = withPerf(true, (ctx) => {
        const harness = makeHarness();
        const hub = makeHub((nowMs) => {
          harness.coordinator.sweepAll(nowMs);
          return { viewChanged: true, durableChanged: false };
        });
        hub.startTimers();
        vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
        vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
        hub.stopTimers();
        return [...ctx.lines];
      });
      const sweeps = lines.filter((line) => line.startsWith("[perf-sweep] "));
      expect(sweeps).toHaveLength(1);
      expect(sweeps[0]).toMatch(
        /^\[perf-sweep\] path=nochange total=-?\d+\.\d serCalls=0 changedKeys=0 durable=false$/,
      );
      const states = lines.filter((line) => line.startsWith("[perf-state] "));
      expect(states).toHaveLength(1);
      expect(states[0]).toMatch(/^\[perf-state\] total=-?\d+\.\d level=\d+ ladders=1$/);
      // §2.6 / B4: 縮退結果は wire バイト数を持たないので bytes= は出さない。
      expect(states[0]).not.toContain("bytes=");
      expect(lines.filter((line) => line.startsWith("[perf-receipt]"))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("off では hub からも [perf- 行が出ず時計も呼ばれない", () => {
    vi.useFakeTimers();
    try {
      const captured = withPerf(false, (ctx) => {
        const harness = makeHarness();
        const hub = makeHub((nowMs) => {
          harness.coordinator.sweepAll(nowMs);
          return { viewChanged: true, durableChanged: false };
        });
        hub.startTimers();
        vi.advanceTimersByTime(SWEEP_INTERVAL_MS);
        vi.advanceTimersByTime(STATE_DEBOUNCE_MS);
        hub.stopTimers();
        return { lines: [...ctx.lines], clockCalls: ctx.clockCalls() };
      });
      expect(captured.lines).toEqual([]);
      expect(captured.clockCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
