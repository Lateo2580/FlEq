import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeConfirmation } from "../../contracts/p2-shared-runtime.types";
import type { DisplaySnapshot } from "../../contracts/p2-snapshot-sse.types";
import type { DmdataClassification } from "../../contracts/p3-dmdata-connect.types";
import type { ListHead, PollResult, PoolPosition } from "../../contracts/p3-recovery.types";
import { EewWindow, FreshnessLedger } from "../../src/recovery/watch";
import { linkedUnitCodecs, linkedUnitTable } from "../../src/runtime/composition-root";
import { initialConfirmation, suspectFreshness } from "../../src/runtime/shared-runtime";
import { harnessedRoot, startHarness } from "../execution-split/owner-harness";

const MINUTE = 60_000;
const EQ: DmdataClassification = "telegram.earthquake", WX: DmdataClassification = "telegram.weather";
const head = (id: string, unit: ListHead["unit"] = "U-Q", operation: ListHead["operation"] = "normal"): ListHead => ({ id, unit,
  headType: unit === "U-Q" ? "VXSE53" : "VPWS50", receivedAtMs: 0, operation, title: "t", headline: null, reportDateTime: null, infoType: null, serial: null, eventId: null, controlDateTime: null,
  controlStatus: "通常", test: false, editorialOffice: null });

describe("P3-REC-T05 acceptance (ledger): the freshness ledger (AC13 (3), RET-02)", () => {
  it("a middle item not received is suspected at its 2 min expiry although the last one matched; received while pending or a reset clears it", () => {
    const ledger = new FreshnessLedger();
    ledger.received("U-Q", EQ, "last", 100);
    expect(ledger.compare(EQ, [head("middle"), head("last")], 3, 900, 1_000)).toEqual({ unmatched: [] });
    expect(ledger.expire(1_000 + 2 * MINUTE - 1)).toEqual([]);
    expect(ledger.expire(1_000 + 2 * MINUTE)).toEqual([{ epoch: 3, scope: { unit: "U-Q", kind: "unit", operation: "normal" }, oldestReceivedAtMs: 0 }]);
    // 保留の間に受けた報では疑いが立たない。保留の間の切断（reset）でも立たない。
    ledger.compare(EQ, [head("late")], 3, 2_000, 2_000);
    ledger.received("U-Q", EQ, "late", 2_500);
    ledger.compare(EQ, [head("cut")], 3, 2_000, 2_000);
    ledger.reset();
    expect(ledger.expire(10 * MINUTE)).toEqual([]);
  });

  // 実不具合（r7 の確認 ヘルツ P2）: 最後の成功を終わった時の now で書くと、要求の最中に受けた X が 30 分で捨てられて復旧後に疑われた。
  it("X received 2 s after the cycle boundary stays through a failing weather list and another class's compare; the recovered list does not suspect X", () => {
    const ledger = new FreshnessLedger();
    const boundary = 10 * 60 * MINUTE;
    ledger.received("U-W", WX, "x", boundary + 2_000);
    expect(ledger.compare(WX, [], 1, boundary, boundary + 5_000)).toEqual({ unmatched: [] });
    // weather の一覧は失敗し続けて compare を呼ばない。earthquake の照合は weather の id を消さない。
    ledger.compare(EQ, [], 1, boundary + 40 * MINUTE, boundary + 40 * MINUTE);
    ledger.compare(WX, [head("x", "U-W")], 1, boundary + 45 * MINUTE, boundary + 45 * MINUTE);
    expect(ledger.expire(boundary + 60 * MINUTE)).toEqual([]);
  });

  it("RET-02: an id dropped at 4,096 per unit makes that unit unmatched (no suspicion) instead of suspected", () => {
    const ledger = new FreshnessLedger();
    for (let index = 0; index < 4_096; index++) ledger.received("U-Q", EQ, `r${index}`, index);
    ledger.received("U-Q", EQ, "dropped", 5_000);
    expect(ledger.compare(EQ, [head("dropped")], 1, 6_000, 6_000)).toEqual({ unmatched: ["U-Q"] });
    expect(ledger.expire(6_000 + 2 * MINUTE)).toEqual([]);
  });

  // 実不具合（発注 2 のレビュー ヘルツ P2）: 超過の印が最初の時刻のままだと、40 分後に捨てた X の保護が成功の照合で外れ、次の一覧で X が疑われた。
  it("RET-02: the overflow mark follows the last dropped id, so X dropped 40 min later stays protected after a success without X", () => {
    const ledger = new FreshnessLedger();
    for (let index = 0; index < 4_096; index++) ledger.received("U-Q", EQ, `r${index}`, index);
    ledger.received("U-Q", EQ, "early", 5_000);
    const boundary = 40 * MINUTE;
    ledger.received("U-Q", EQ, "x", boundary + 1_000); // 一覧の要求の待ちの間に受理
    ledger.compare(EQ, [], 1, boundary, boundary + 2_000);
    expect(ledger.compare(EQ, [head("x")], 1, boundary + 10 * MINUTE, boundary + 10 * MINUTE)).toEqual({ unmatched: ["U-Q"] });
    expect(ledger.expire(boundary + 13 * MINUTE)).toEqual([]);
  });
});

describe("P3-REC-T09 acceptance (window): the EEW window card (AC14 (1)(2)(5), OVERLAP=A, NEVER=A)", () => {
  it("from the last frame to the first frame of the new WS; out 10 min after the reconnect; open without a frame does not move the start", () => {
    const window = new EewWindow(1);
    window.lost(1_000);
    window.lost(1_500); // open の後に frame を受けずに再び切れた
    expect(window.card()).toBeNull();
    window.connected(9_000, 50_000);
    expect(window.tick(50_000 + 10 * MINUTE - 1)).toEqual({ card: { fromWallMs: 1_000, toWallMs: 9_000 }, expired: null });
    expect(window.tick(50_000 + 10 * MINUTE)).toEqual({ card: null, expired: { fromWallMs: 1_000, toWallMs: 9_000 } });
  });

  it("OVERLAP=A: a cut while the card shows keeps one card, its old 10 min passes silently, the reconnect extends it; a stop in the cut gives [start, stop]", () => {
    const window = new EewWindow(1);
    window.lost(1_000);
    window.connected(9_000, 50_000);
    window.lost(20_000);
    expect(window.tick(50_000 + 11 * MINUTE)).toEqual({ card: { fromWallMs: 1_000, toWallMs: 9_000 }, expired: null });
    window.connected(30_000, 50_000 + 12 * MINUTE);
    expect(window.tick(50_000 + 22 * MINUTE)).toEqual({ card: null, expired: { fromWallMs: 1_000, toWallMs: 30_000 } });
    const stopped = new EewWindow(1);
    stopped.lost(1_000);
    stopped.connected(9_000, 50_000);
    stopped.lost(20_000);
    expect(stopped.stop(40_000)).toEqual({ fromWallMs: 1_000, toWallMs: 40_000 });
  });

  it("NEVER=A: a first connection that never received a frame starts the window at startup", () => {
    const window = new EewWindow(100);
    window.lost(null);
    window.connected(200, 0);
    expect(window.card()).toEqual({ fromWallMs: 100, toWallMs: 200 });
  });
});

describe("P3-REC-T05 contractBoundary: the suspicion rank (P3-REC-D-SUSPECT-RANK=A)", () => {
  it("capacityExceeded is not overwritten; the slot moves its one count to freshnessSuspect; another epoch is ignored", () => {
    const base = initialConfirmation();
    const units = linkedUnitTable;
    const confirmation: RuntimeConfirmation = { ...base, units: { ...base.units, "U-V": { ...base.units["U-V"],
      normal: { ...base.units["U-V"].normal, whole: "capacityExceeded", counts: { capacityExceeded: 1 } } } } };
    const input = (epoch: number) => ({ kind: "freshnessSuspected" as const, runId: "run", epoch, clock: { wallTimeMs: 0, monotonicMs: 0 },
      scopes: [{ unit: "U-V" as const, kind: "unit" as const, operation: "normal" as const }, { unit: "U-Q" as const, kind: "unit" as const, operation: "normal" as const }] });
    const next = suspectFreshness(confirmation, units, "run", input(0));
    expect([next.units["U-V"].normal.whole, next.units["U-Q"].normal.whole, next.units["U-Q"].normal.counts]).toEqual(["capacityExceeded", "freshnessSuspect", { freshnessSuspect: 1 }]);
    expect(suspectFreshness(confirmation, units, "run", input(1))).toBe(confirmation);
  });
});

// publisher の 1 秒の tick と一覧の口の mock で、周期・保留の満了・切断を通す（host の apiKey と lane は poll に閉じる）。
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await fileSystem.rm(path, { recursive: true, force: true }); });

async function publisher() {
  const path = await fileSystem.mkdtemp(join(tmpdir(), "fleq-rec-watch-"));
  temporary.push(path);
  const published: DisplaySnapshot[] = [];
  const now = { wallTimeMs: 1_800_000_000_000, monotonicMs: 1 };
  const diagnosticDirectory = join(path, "diagnostics");
  const h = harnessedRoot({ appName: "fleq-p2", legacyAppName: "fleq", stateDirectory: join(path, "state"),
    legacyStateDirectory: join(path, "legacy"), diagnosticDirectory }, linkedUnitCodecs,
  { clock: () => ({ ...now }), display: { publish: (snapshot) => { published.push(snapshot); } } });
  await startHarness(h, "run-watch", { ...now });
  const tick = async (advanceMs = 0) => {
    now.monotonicMs += advanceMs;
    h.root.tick({ ...now });
    await h.settle();
    await new Promise((done) => setImmediate(done));
  };
  const lines = async () => {
    await h.root.diagnostics.flush();
    const names = await fileSystem.readdir(diagnosticDirectory).catch(() => [] as string[]);
    const text = (await Promise.all(names.map((name) => fileSystem.readFile(join(diagnosticDirectory, name), "utf8")))).join("");
    return text.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
  };
  return { h, root: h.root, published, now, tick, lines };
}

describe("P3-REC-T05 acceptance (publisher): the H41 cycle on the existing tick (AC13 (1)(3)(5))", () => {
  it("seeds first, compares from the second cycle, suspects the unreceived one at the tick 2 min later; the unit state stays; a 15 min wall skew changes nothing", async () => {
    const { h, root, published, now, tick } = await publisher();
    const calls: (PoolPosition | null)[] = [];
    const answers: PollResult[] = [{ kind: "seeded", position: { token: "p1", latestRawReceivedAtMs: 10 } },
      { kind: "ok", heads: [head("missing"), head("received")], position: { token: "p2", latestRawReceivedAtMs: 20 } }];
    root.watchFreshness([EQ]);
    root.startFreshness(async (_classification, position) => { calls.push(position); return answers.shift()!; });
    await tick();
    expect(calls).toEqual([]); // start を受けた WS まで周期を起こさない
    root.recordConnected(now.wallTimeMs);
    await tick();
    await tick(MINUTE);
    expect(calls).toEqual([null]);
    now.wallTimeMs += 15 * MINUTE; // dmdata の時刻と host の wall は比べない
    root.recordLiveId("VXSE53", "received", now.monotonicMs);
    const unit = h.unit("U-Q");
    await tick(9 * MINUTE);
    expect(calls).toEqual([null, { token: "p1", latestRawReceivedAtMs: 10 }]);
    await tick(2 * MINUTE - 1);
    expect(published.at(-1)!.current.earthquake.items[0].unconfirmed).not.toHaveProperty("freshnessSuspect");
    await tick(1);
    expect(published.at(-1)!.current.earthquake.items[0].unconfirmed).toEqual({ freshnessSuspect: 1 });
    expect(root.state.confirmation.units["U-Q"].normal.whole).toBe("freshnessSuspect");
    expect(h.unit("U-Q")).toBe(unit);
  });

  // 指摘（発注 2 のレビュー Opus P3）: 帳簿は辿りの完了の前から live の id を集める（AC13 (8)・RET-02）。
  it("an id received before the startup walk ended is in the ledger: the first compare matches it, no suspicion", async () => {
    const { root, now, tick } = await publisher();
    root.watchFreshness([EQ]);
    root.recordLiveId("VXSE53", "before-walk", now.monotonicMs);
    const answers: PollResult[] = [{ kind: "seeded", position: { token: "p1", latestRawReceivedAtMs: 10 } },
      { kind: "ok", heads: [head("before-walk")], position: { token: "p2", latestRawReceivedAtMs: 20 } }];
    root.startFreshness(async () => answers.shift()!);
    root.recordConnected(now.wallTimeMs);
    await tick();
    await tick(10 * MINUTE);
    await tick(3 * MINUTE);
    expect([answers.length, root.state.confirmation.units["U-Q"].normal.counts]).toEqual([0, { startup: 1 }]);
  });

  it("a cycle answered after a disconnect is dropped by its epoch: no pending, no suspicion; the next connection seeds again", async () => {
    const { root, now, tick } = await publisher();
    const calls: (PoolPosition | null)[] = [];
    let answer: (result: PollResult) => void = () => {};
    root.watchFreshness([EQ]);
    root.startFreshness((_classification, position) => {
      calls.push(position);
      return calls.length === 1 ? Promise.resolve<PollResult>({ kind: "seeded", position: { token: "p1", latestRawReceivedAtMs: 10 } })
        : new Promise<PollResult>((done) => { answer = done; });
    });
    root.recordConnected(now.wallTimeMs);
    await tick();
    await tick(10 * MINUTE);
    root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: { ...now } });
    answer({ kind: "ok", heads: [head("missing")], position: { token: "p2", latestRawReceivedAtMs: 20 } });
    await tick(3 * MINUTE);
    expect(root.state.confirmation.units["U-Q"].normal.counts).not.toHaveProperty("freshnessSuspect");
    root.recordConnected(now.wallTimeMs);
    await tick();
    expect(calls).toEqual([null, { token: "p1", latestRawReceivedAtMs: 10 }, null]);
  });
});

describe("P3-REC-T09 acceptance (publisher): the card in the snapshot and the history line (AC14 (1)(2)(5)(6))", () => {
  it("the card from the last frame (wall kept through a 1 h wall jump) to the new start reaches the snapshot; no EEW notice; out after 10 min with one WARN", async () => {
    const { root, published, now, tick, lines } = await publisher();
    root.watchEewWindow();
    const lastFrame = now.wallTimeMs;
    root.recordFrame(lastFrame);
    now.wallTimeMs += 60 * MINUTE; // 無通信の間に host の wall が動く
    root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: { ...now } });
    const before = published.length;
    root.recordFrame(now.wallTimeMs);
    root.recordConnected(now.wallTimeMs);
    await tick();
    const shown = published.at(-1)!;
    expect(published.length).toBeGreaterThan(before);
    expect(shown.recovery.eewUnverified).toEqual({ fromWallMs: lastFrame, toWallMs: now.wallTimeMs });
    expect([shown.notices, shown.current.eew.items[0].activeCount]).toEqual([[], 0]);
    await tick(10 * MINUTE);
    expect(published.at(-1)!.recovery.eewUnverified).toBeNull();
    expect((await lines()).filter((line) => line.reason === "eewWindowUnverified")).toEqual([expect.objectContaining({
      level: "WARN", count: 1, timestamp: now.wallTimeMs, durationMs: now.wallTimeMs - lastFrame })]);
  });

  it("a stop during a second cut leaves one line for [first start, stop]", async () => {
    const { root, now, tick, lines } = await publisher();
    root.watchEewWindow();
    const first = now.wallTimeMs;
    root.recordFrame(first);
    root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: { ...now } });
    now.wallTimeMs += MINUTE;
    root.recordConnected(now.wallTimeMs);
    await tick();
    root.recordFrame(now.wallTimeMs + 1_000);
    root.dispatch({ kind: "connectionLost", acceptedThroughSequence: -1, clock: { ...now } });
    now.wallTimeMs += 5 * MINUTE;
    await root.shutdownRuntime(0, { ...now });
    expect((await lines()).filter((line) => line.reason === "eewWindowUnverified").map((line) => [line.timestamp, line.durationMs]))
      .toEqual([[now.wallTimeMs, now.wallTimeMs - first]]);
  });
});
