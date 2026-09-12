/**
 * GitHub Issue #15 の受入テスト。
 * 出典 spec: 2026-09-07-standby-metadata-resettle.md（作業ノート、repo 外）（§4.1 / §4.2 / §5.1）。
 *
 * 守る契約は二つある。
 *
 *  1. **配信 metadata だけでは再計測しない**。修正前の `$effect.pre` は contentKey に
 *     `snapshot.generatedAt` と `snapshot.seq` を含んでいたため、カード内容がまったく同じでも
 *     配信メタデータが変わるだけで `requestSettle()` が走り、`settleMeasurements()`
 *     （最大 4 パス・probe 再生成・scheduler hold）が全部やり直しになっていた。→ ケース (b)(c)
 *  2. **レイアウトに効く入力の変化は取りこぼさない**。metadata を鍵から外すと、これまで
 *     `generatedAt` が偶然塞いでいた穴（§2.5 の「未被覆」行、§2.6 の気象警報訂正報）が
 *     そのまま実害になる。→ ケース (e)〜(m)。(n) は §2.7 の carve-out の負のケース。
 *
 * 観測手段（コンポーネント内部変数には届かないので以下で代替）:
 *  - settle epoch 数        … `.standby[data-measurement-epoch]`
 *  - readMeasurements 回数  … `.standby[data-measurement-pass]`（readMeasurements 内で累積 +1）
 *  - probe 生成回数         … epoch-coordinator の `enqueueProbe` を module mock で spy
 *  - holdForEpoch 呼び出し  … time-slice-scheduler の rotation / cardPage を module mock で spy
 *
 * **レーン B の数値の読み方**（spec §4.3）: jsdom + StubResizeObserver の初回 settle は
 * 起草時の 48 tick 予算では収束せず、baseline が `settled: "false"` のまま採られていた
 * （spec §4.1 の実走出力）。本テストは `settle()` の予算を 240 へ上げて収束させてある
 * （理由は同関数の docstring）。それでもレーン B の絶対値（baseline pass 33・probe 132、
 * 内容変更 1 回あたり probe +114 など）は**実ブラウザの値ではない**。ResizeObserver を
 * スタブで黙らせた jsdom 上の値であり、**同一条件下の差分比較としてのみ**意味を持つ。
 * 「実機で 114 回 probe が走る」と読んではいけない。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

const spies = {
  enqueueProbe: 0,
  rotationHold: 0,
  cardPageHold: 0,
};

// jsdom は ResizeObserver を持たない。未定義のままだと StandbyScreen の
// cachedPagePartitionMeasurement が早期に 0 を返し、ページ分割 probe が一度も
// enqueue されない（= probe 生成回数が常に 0 になり観測にならない）。
// レーン B ではこのスタブを入れて実ブラウザ側の probe 経路を通す。
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
function installResizeObserver(): void {
  (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
}
function removeResizeObserver(): void {
  delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver;
}

vi.mock("../../lib/legacy-standby/epoch-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/legacy-standby/epoch-coordinator")>();
  return {
    ...actual,
    createEpochCoordinator: () => {
      const inner = actual.createEpochCoordinator();
      return {
        ...inner,
        isBusy: () => inner.isBusy(),
        onSettled: (cb: () => void) => inner.onSettled(cb),
        epochKey: () => inner.epochKey(),
        hasPendingProbes: () => inner.hasPendingProbes(),
        pendingProbeCount: () => inner.pendingProbeCount(),
        canSettle: (key: string) => inner.canSettle(key),
        enqueueProbe: (id: string, measure: () => void) => {
          spies.enqueueProbe += 1;
          inner.enqueueProbe(id, measure);
        },
      };
    },
  };
});

vi.mock("../../lib/legacy-standby/time-slice-scheduler.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/legacy-standby/time-slice-scheduler.svelte")>();
  return {
    ...actual,
    createRotationScheduler: (options?: Parameters<typeof actual.createRotationScheduler>[0]) => {
      const inner = actual.createRotationScheduler(options);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "holdForEpoch") {
            return () => {
              spies.rotationHold += 1;
              target.holdForEpoch();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    createCardPageCoordinator: (options?: Parameters<typeof actual.createCardPageCoordinator>[0]) => {
      const inner = actual.createCardPageCoordinator(options);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "holdForEpoch") {
            return () => {
              spies.cardPageHold += 1;
              target.holdForEpoch();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

const StandbyScreen = (await import("../StandbyScreen.svelte")).default;
const { baseSnapshot, baseState } = await import("../../lib/__tests__/fixtures");
const { reduce } = await import("../../lib/store");
const { collectWeatherExpandedKinds } = await import("../../lib/weather-expanded-kinds");
type DisplayStateSnapshotV1 = import("../../lib/protocol").DisplayStateSnapshotV1;
type DisplayWeatherAlertV1 = import("../../lib/protocol").DisplayWeatherAlertV1;
type ActiveStandbyCardV1 = import("../../lib/protocol").ActiveStandbyCardV1;

const now = new Date("2026-08-20T12:00:00+09:00");

function weatherAlert(over: Partial<DisplayWeatherAlertV1> = {}): DisplayWeatherAlertV1 {
  return {
    source: "vpws50",
    label: "気象警報",
    role: "weatherWarning",
    totalAreas: 8,
    items: [{
      kind: "大雨警報",
      phenomenonKey: "heavy-rain",
      displaySeverity: "warning",
      rank: "warning",
      shownAreas: ["宮崎市", "都城市", "延岡市", "日南市", "日向市", "小林市", "串間市", "西都市"],
      omittedAreaCount: 4,
    }],
    updatedAt: "2026-08-20T12:00:00+09:00",
    ...over,
  };
}

function briefing(headline = "大雨に警戒してください"): Extract<ActiveStandbyCardV1, { kind: "briefing" }> {
  return {
    kind: "briefing", surface: "corner-right", key: "briefing:active", sourceEventIds: ["card:vpbs:1"],
    updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: "2026-08-20T14:00:00+09:00", restored: false,
    severity: "warning",
    data: {
      generation: 1,
      entries: [{
        key: "card:vpbs:1", source: "vpbs50", sourceEventId: "vpbs-1", title: "気象速報",
        headline, conditions: [], targetAreas: [],
        reportDateTime: "2026-08-20T12:00:00+09:00", publishingOffice: "気象庁", infoType: "発表",
        frameLevel: "warning", severityEvidence: [], qualifier: null,
        updatedAt: "2026-08-20T12:00:00+09:00", expiresAt: "2026-08-20T14:00:00+09:00", generation: 1,
      }],
    },
  };
}

function snapshotWith(over: Partial<DisplayStateSnapshotV1> = {}): DisplayStateSnapshotV1 {
  const alerts = [weatherAlert()];
  return baseSnapshot({
    generatedAt: "2026-08-20T12:00:00.000Z",
    seq: 100,
    latestQuake: {
      eventId: "latest-1", headline: null, originTime: "2026-08-20T11:58:00+09:00",
      hypocenterName: "日向灘", depth: "20km", magnitude: "5.2", maxInt: "5弱", maxIntRank: 5,
      tsunamiWarning: false, intensityGroups: [], reportDateTime: "2026-08-20T12:00:00+09:00",
      updatedAtMs: 1,
    },
    weatherAlerts: alerts,
    weatherExpandedKinds: collectWeatherExpandedKinds(alerts),
    standbyItems: [briefing()],
    ...over,
  });
}

/** サーバの `state` メッセージと同じ経路で snapshot を差し替える（store.reduce の "state" 分岐）。 */
function viaStateMessage(previous: DisplayStateSnapshotV1, next: DisplayStateSnapshotV1): DisplayStateSnapshotV1 {
  const before = baseState();
  const seeded = { ...before, snapshot: previous };
  const after = reduce(seeded, { type: "state", snapshot: next } as never);
  return after.snapshot!;
}

const testMeasurementOverride = { layoutWidthPx: 1280, layoutHeightPx: 900, baselineGapPx: 10 };

interface Counters {
  epoch: number;
  pass: number;
  enqueueProbe: number;
  rotationHold: number;
  cardPageHold: number;
  settled: string;
  nonConverged: string;
}

function readCounters(container: HTMLElement): Counters {
  const root = container.querySelector<HTMLElement>(".standby")!;
  return {
    epoch: Number(root.dataset.measurementEpoch),
    pass: Number(root.dataset.measurementPass),
    enqueueProbe: spies.enqueueProbe,
    rotationHold: spies.rotationHold,
    cardPageHold: spies.cardPageHold,
    settled: root.dataset.measurementSettled ?? "?",
    nonConverged: root.dataset.measurementNonconverged ?? "?",
  };
}

/**
 * settled=true になるまで microtask を回す。tick 予算は 240。
 *
 * 起草時の再現テストは 48 だった。レーン B（ResizeObserver スタブあり）の初回 settle は
 * 48 tick では収束せず baseline が `settled: "false"` のまま採られるため、差分に**前 epoch の
 * settle の残り**（pass +1）が混ざる。修正後はそれが唯一の残差になり、(b)(c)(n) の
 * 「delta 全項目 0」が harness 都合だけで満たせなくなる。240 に上げるとレーン B も
 * `settled: "true"`・pass 33 で確定し、差分が次 snapshot の起こした分だけになる。
 * 早期 return があるのでレーン A の所要時間は変わらない。
 */
async function settle(container: HTMLElement, passes = 240): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await tick();
    const root = container.querySelector<HTMLElement>(".standby");
    if (pass > 8 && root?.dataset.measurementSettled === "true") return;
  }
}

interface Delta {
  epoch: number;
  pass: number;
  enqueueProbe: number;
  rotationHold: number;
  cardPageHold: number;
}

function delta(before: Counters, after: Counters): Delta {
  return {
    epoch: after.epoch - before.epoch,
    pass: after.pass - before.pass,
    enqueueProbe: after.enqueueProbe - before.enqueueProbe,
    rotationHold: after.rotationHold - before.rotationHold,
    cardPageHold: after.cardPageHold - before.cardPageHold,
  };
}

function report(lane: string, label: string, before: Counters, d: Delta): void {
  // vitest は成功したテストの stdout も出す (--disable-console-intercept 併用時)。
  // 数値そのものが成果物なので、成否によらず必ず出力する。
  // eslint-disable-next-line no-console
  console.log(`[#15][${lane}] ${label} baseline=${JSON.stringify(before)} delta=${JSON.stringify(d)}`);
}

/** 1 ケース: 初回 settle → next snapshot を state 経路で流し込み → 差分を返す。 */
async function runCase(
  next: (first: DisplayStateSnapshotV1) => DisplayStateSnapshotV1,
  firstOver: Partial<DisplayStateSnapshotV1> = {},
) {
  const first = snapshotWith(firstOver);
  const props = { snapshot: first, now, dim: false, sseConnected: true, testMeasurementOverride };
  const view = render(StandbyScreen, props);
  await settle(view.container);
  const before = readCounters(view.container);

  await view.rerender({ ...props, snapshot: viaStateMessage(first, next(first)) });
  await settle(view.container);
  const after = readCounters(view.container);
  return { before, after, d: delta(before, after) };
}

const changedAlerts = [weatherAlert({
  updatedAt: "2026-08-20T12:05:00+09:00",
  totalAreas: 9,
  items: [{
    kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
    shownAreas: ["宮崎市", "都城市", "延岡市", "日南市", "日向市", "小林市", "串間市", "西都市", "えびの市"],
    omittedAreaCount: 5,
  }],
})];

// ---- §4.2 の追加ケース用のヘルパ ----
// いずれも generatedAt / seq を初回と同値に固定したまま、当該入力だけを動かす。
// 「配信 metadata が偶然塞いでいた穴」（§2.5 の未被覆行・§2.6）を閉じるのが目的。

type DisplayStatsV1 = import("../../lib/protocol").DisplayStatsV1;
type DisplayRecentQuakeV1 = import("../../lib/protocol").DisplayRecentQuakeV1;
type DisplayTsunamiStateV1 = import("../../lib/protocol").DisplayTsunamiStateV1;

function stats(over: Partial<DisplayStatsV1> = {}): DisplayStatsV1 {
  return {
    sparklineData: [1, 2, 3, 4, 5],
    totalReceived: 120,
    todayQuakeCount: 3,
    todayMaxInt: "3",
    todayMaxIntRank: 3,
    ...over,
  };
}

function recentQuake(index: number, over: Partial<DisplayRecentQuakeV1> = {}): DisplayRecentQuakeV1 {
  return {
    eventId: `recent-${index}`,
    reportDateTime: `2026-08-20T11:5${index}:00+09:00`,
    originTime: "2026-08-20T11:50:00+09:00",
    hypocenterName: "日向灘",
    magnitude: "4.1",
    maxInt: "2",
    maxIntRank: 2,
    depth: "30km",
    tsunamiWarning: false,
    ...over,
  };
}

function tsunamiState(): DisplayTsunamiStateV1 {
  return {
    kind: "tsunami", eventId: "T1", level: "warning", levelLabel: "津波警報",
    coasts: [{ name: "宮崎県", kind: "津波警報", maxHeight: "3m", firstHeight: null }],
    warningComment: null, observations: [], reportDateTime: "2026-08-20T12:00:00+09:00",
    updatedAtMs: 1, unkeyedSequence: null,
  };
}

/** items だけを差し替え、updatedAt は初回と同値に据え置く（§2.6 の訂正報）。 */
const correctedAlerts = [weatherAlert({
  totalAreas: 9,
  items: [{
    kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
    shownAreas: ["宮崎市", "都城市", "延岡市", "日南市", "日向市", "小林市", "串間市", "西都市", "えびの市"],
    omittedAreaCount: 5,
  }],
})];

const lanes = [
  {
    name: "A: jsdom 既定 (ResizeObserver なし・settle は収束する)",
    setup: removeResizeObserver,
  },
  {
    name: "B: ResizeObserver スタブあり (ページ分割 probe 経路が生きる)",
    setup: installResizeObserver,
  },
] as const;

for (const lane of lanes) {
  describe(`Issue #15 再現 — ${lane.name}`, () => {
    beforeEach(() => {
      lane.setup();
      spies.enqueueProbe = 0;
      spies.rotationHold = 0;
      spies.cardPageHold = 0;
    });
    afterEach(() => {
      removeResizeObserver();
    });

    it("(b) generatedAt だけの変化で再計測が走らない", async () => {
      const { before, d } = await runCase(() => snapshotWith({ generatedAt: "2026-08-20T12:00:00.500Z" }));
      report(lane.name[0], "(b) generatedAt only", before, d);
      // 期待挙動: 配信メタデータだけでは再計測しない。現行実装ではここで落ちる。
      expect(d, "generatedAt only should not re-settle").toEqual({
        epoch: 0, pass: 0, enqueueProbe: 0, rotationHold: 0, cardPageHold: 0,
      });
    });

    it("(c) seq だけの変化で再計測が走らない", async () => {
      const { before, d } = await runCase(() => snapshotWith({ seq: 101 }));
      report(lane.name[0], "(c) seq only", before, d);
      expect(d, "seq only should not re-settle").toEqual({
        epoch: 0, pass: 0, enqueueProbe: 0, rotationHold: 0, cardPageHold: 0,
      });
    });

    it("(d) 対照: weatherAlerts の中身が変わったら再計測する", async () => {
      const { before, d } = await runCase(() => snapshotWith({
        generatedAt: "2026-08-20T12:05:00.000Z",
        seq: 110,
        weatherAlerts: changedAlerts,
        weatherExpandedKinds: collectWeatherExpandedKinds(changedAlerts),
      }));
      report(lane.name[0], "(d) real content change", before, d);
      expect(d.epoch, "content change must open a new epoch").toBeGreaterThan(0);
      expect(d.pass, "content change must re-read measurements").toBeGreaterThan(0);
    });

    // ---- §4.2: generatedAt / seq を据え置いたままレイアウト入力を動かす ----
    // 修正前は generatedAt が偶然これらを塞いでいた。metadata を鍵から外した以上、
    // 各 field が自力で epoch を開けることを固定しておかないと「表示が古いまま止まる」に化ける。

    it("(e) severityTier の変化を取りこぼさない (CSS 経由の --num-weight 700→800)", async () => {
      const { before, d } = await runCase(() => snapshotWith({ severityTier: "alert" }));
      report(lane.name[0], "(e) severityTier", before, d);
      expect(d.epoch, "severityTier affects --num-weight via theme.css").toBeGreaterThan(0);
    });

    it("(f) stats の出現と桁数の変化を取りこぼさない", async () => {
      const appear = await runCase(() => snapshotWith({ stats: stats() }));
      report(lane.name[0], "(f1) stats null -> present", appear.before, appear.d);
      expect(appear.d.epoch, "stats row appearing must re-settle").toBeGreaterThan(0);

      const widen = await runCase(
        () => snapshotWith({ stats: stats({ totalReceived: 1200 }) }),
        { stats: stats({ totalReceived: 120 }) },
      );
      report(lane.name[0], "(f2) totalReceived digit count", widen.before, widen.d);
      expect(widen.d.epoch, "digit count changes the tabular-nums width").toBeGreaterThan(0);
    });

    it("(g) recentQuakes の件数と内容の変化を取りこぼさない", async () => {
      const appear = await runCase(() => snapshotWith({ recentQuakes: [recentQuake(0)] }));
      report(lane.name[0], "(g1) recentQuakes 0 -> 1", appear.before, appear.d);
      expect(appear.d.epoch, "recent quake list length must re-settle").toBeGreaterThan(0);

      const head = [0, 1, 2, 3, 4].map((index) => recentQuake(index));
      const changed = [recentQuake(0, { hypocenterName: "紀伊水道", magnitude: "6.4", maxInt: "5強", maxIntRank: 6 }), ...head.slice(1)];
      const edit = await runCase(() => snapshotWith({ recentQuakes: changed }), { recentQuakes: head });
      report(lane.name[0], "(g2) recentQuakes head content", edit.before, edit.d);
      expect(edit.d.epoch, "recent quake content must re-settle").toBeGreaterThan(0);
    });

    it("(h) connection.dmdata の変化を取りこぼさない", async () => {
      const { before, d } = await runCase(() => snapshotWith({
        connection: { dmdata: "disconnected", lastReceivedAt: null, disconnectedSince: "2026-08-20T12:00:00+09:00", reason: "socket closed" },
      }));
      report(lane.name[0], "(h) connection.dmdata", before, d);
      expect(d.epoch, "connection badge visibility must re-settle").toBeGreaterThan(0);
    });

    it("(i) tsunami の出現を取りこぼさない", async () => {
      const { before, d } = await runCase(() => snapshotWith({ tsunami: tsunamiState() }));
      report(lane.name[0], "(i) tsunami null -> present", before, d);
      expect(d.epoch, "tsunami banner must re-settle").toBeGreaterThan(0);
    });

    it("(j) weatherExpandedKinds の areas 変化を取りこぼさない", async () => {
      const base = snapshotWith();
      const expanded = (base.weatherExpandedKinds ?? []).map((kind, index) => index === 0
        ? { ...kind, areas: [...kind.areas, "えびの市"], totalAreaCount: kind.totalAreaCount + 1 }
        : kind);
      const { before, d } = await runCase(() => snapshotWith({ weatherExpandedKinds: expanded }));
      report(lane.name[0], "(j) weatherExpandedKinds", before, d);
      expect(d.epoch, "expanded area candidates must re-settle").toBeGreaterThan(0);
    });

    it("(k) 気象警報の訂正報 (updatedAt 同値・items 変化) を取りこぼさない", async () => {
      const { before, d } = await runCase(() => snapshotWith({ weatherAlerts: correctedAlerts }));
      report(lane.name[0], "(k) weatherAlerts corrected in place", before, d);
      // DisplayWeatherAlertV1 は wire 上 revision serial を持たない (protocol.ts:533-540)。
      // updatedAt だけを鍵にすると同一 ReportDateTime の訂正報が静かに落ちる (§2.6)。
      expect(d.epoch, "same updatedAt with changed items must re-settle").toBeGreaterThan(0);
    });

    it("(l) latestQuake.updatedAtMs の変化を取りこぼさない", async () => {
      const { before, d } = await runCase((first) => snapshotWith({
        latestQuake: { ...first.latestQuake!, updatedAtMs: 2, maxInt: "6弱", maxIntRank: 7 },
      }));
      report(lane.name[0], "(l) latestQuake.updatedAtMs", before, d);
      expect(d.epoch, "latest quake revision must re-settle").toBeGreaterThan(0);
    });

    it("(m) standbyItems の briefing generation 変化を取りこぼさない", async () => {
      const next = briefing();
      next.data = { ...next.data, generation: 2 };
      const { before, d } = await runCase(() => snapshotWith({ standbyItems: [next] }));
      report(lane.name[0], "(m) briefing generation", before, d);
      expect(d.epoch, "briefing generation must re-settle").toBeGreaterThan(0);
    });

    it("(n) 負のケース: sparklineData だけの変化では再計測しない", async () => {
      // sparkline は viewBox 固定 + CSS 120x20px なので中身は寸法に効かない
      // (InstrumentRow.svelte:5-7,23,39)。1 分ごとに変わるため鍵に含めない (§2.7)。
      const { before, d } = await runCase(
        () => snapshotWith({ stats: stats({ sparklineData: [9, 8, 7, 6, 5] }) }),
        { stats: stats() },
      );
      report(lane.name[0], "(n) sparklineData only", before, d);
      expect(d, "sparklineData is not a layout input").toEqual({
        epoch: 0, pass: 0, enqueueProbe: 0, rotationHold: 0, cardPageHold: 0,
      });
    });

    it("(o) 負のケース: 接続中は lastReceivedAt が変わっても再計測しない", async () => {
      // lastReceivedAt は電文を 1 通 ingest するたびに現在時刻へ書き換わり
      // (src/engine/display/hub.ts:161)、毎 snapshot に載る (state-store.ts:1258)。
      // ConnectionBadge は正常時に何も描かない (ConnectionBadge.svelte:16-21) ので、
      // 接続中の lastReceivedAt はレイアウト入力ではない。
      const { before, d } = await runCase(
        () => snapshotWith({
          connection: { dmdata: "connected", lastReceivedAt: "2026-08-20T12:03:41+09:00", disconnectedSince: null, reason: null },
        }),
        { connection: { dmdata: "connected", lastReceivedAt: "2026-08-20T12:00:07+09:00", disconnectedSince: null, reason: null } },
      );
      report(lane.name[0], "(o) lastReceivedAt while connected", before, d);
      expect(d, "ingest churn must not re-settle while the badge is hidden").toEqual({
        epoch: 0, pass: 0, enqueueProbe: 0, rotationHold: 0, cardPageHold: 0,
      });
    });

    it("(p) 切断中に lastReceivedAt が変われば再計測する (描画が変わる)", async () => {
      // 切断中だけ「最終受信 HH:MM」が描かれる (ConnectionBadge.svelte:19)。
      const { before, d } = await runCase(
        () => snapshotWith({
          connection: { dmdata: "disconnected", lastReceivedAt: "2026-08-20T12:41:00+09:00", disconnectedSince: "2026-08-20T12:00:00+09:00", reason: "socket closed" },
        }),
        { connection: { dmdata: "disconnected", lastReceivedAt: "2026-08-20T11:58:00+09:00", disconnectedSince: "2026-08-20T12:00:00+09:00", reason: "socket closed" } },
      );
      report(lane.name[0], "(p) lastReceivedAt while disconnected", before, d);
      expect(d.epoch, "the rendered last-received time must re-settle").toBeGreaterThan(0);
    });

    it("(q) 負のケース: tsunami.observations だけの変化では再計測しない", async () => {
      // 待機画面が描く津波は TsunamiStandbyBanner だけで (StandbyScreen.svelte:2114)、
      // coasts / level / eventId / unkeyedSequence / reportDateTime しか読まない。
      // observations を描く TsunamiPanel の唯一の描画点は緊急画面 (EmergencyScreen.svelte:177)。
      const observed = { ...tsunamiState(), observations: [{
        areaName: "宮崎県", areaKind: "津波警報", stationName: "油津", stationCode: "45151",
        arrivalTime: "2026-08-20T12:10:00+09:00", initial: "第1波", maxHeightValue: "0.3m",
        condition: null,
      }] };
      const { before, d } = await runCase(() => snapshotWith({ tsunami: observed }), { tsunami: tsunamiState() });
      report(lane.name[0], "(q) tsunami.observations only", before, d);
      expect(d, "standby banner never renders observations").toEqual({
        epoch: 0, pass: 0, enqueueProbe: 0, rotationHold: 0, cardPageHold: 0,
      });
    });
  });
}
