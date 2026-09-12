/**
 * GitHub Issue #15 第 3 便 spec の段階 2'（外側 77% の帰属分離）の受入テスト。
 * 出典 spec: 2026-09-09-standby-epoch-settle-cost.md（作業ノート、repo 外）（§3 段階 2' / §4.2' / §5.1 A2b・A13）。
 *
 * 段階 1 の `standby-settle-cost-probe.test.ts` と同型である。製品の見え方も production の
 * DOM も変えない。守る契約は 3 本。
 *
 * 1. 観測点 8 属性が preview / gate の外へ漏れない（A2b 前半）
 * 2. ガードが false のとき、計測用の `performance.now()` が **1 回も呼ばれない**（A2b 中盤）
 * 3. `-calls` が対応する関数の実呼び出し回数と整合する（A2b 後半）
 *
 * ## なぜ 5 本足すのか（spec §2.9 / §2.10）
 *
 * 段階 1 の実測で「読み取り時間 ÷ epoch 総時間」= 0.179 が出た（分子の属性名は段階 1 の
 * テストにだけ書く。あちらの A13 grep が許可ファイル 2 本しか認めないため）。つまり
 * `readMeasurements()` の内側は 1 epoch 2,291.5ms のうち 18% しかない。gate トレースが 5%。
 * **残る約 77%（約 1,764ms）は `readMeasurements()` の外側にある**が、その内訳は未知である。
 * 段階 2' はそこを 5 区分（partition / revision / signature / flush / solve）に割る。
 *
 * ## 包含関係（レポート側で差し引く）
 *
 * `data-settle-flush-ms` は内側 probe ループの `await tick()` と `flushSync()` を上位から
 * 包むので、その中で走る partition / revision / solve を**重複計上する**。5 本の合計が
 * 外側 77% を超えても異常ではない。差し引きは親の計測スクリプトが行う（spec §3 段階 2'）。
 *
 * ## なぜ計数器が `$state` ではないのか
 *
 * `weatherMeasurementRanges` / `tornadoMeasurementRanges` / `solvePlan` と 2 つの
 * partition revision は `$derived` またはテンプレート式の中で走る。そこで signal を書くと
 * Svelte 5 は `state_unsafe_mutation` を投げる。加えて 1 epoch に数百回の signal 書き込みは
 * 可視ルートを無効化し、**測ろうとしている数値そのものを膨らませる**。そこで素の `let` に
 * 貯め、reaction の外（`recordSettleReadCost` の末尾と settled publish）で 1 本の
 * `$state` ミラーへ写している。本テストの単調増加ケースはこの写しが効いていることの固定でもある。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import StandbyScreen from "../StandbyScreen.svelte";
import { baseSnapshot } from "../../lib/__tests__/fixtures";
import { collectWeatherExpandedKinds } from "../../lib/weather-expanded-kinds";
import type { DisplayStateSnapshotV1, DisplayWeatherAlertV1 } from "../../lib/protocol";

const now = new Date("2026-08-20T12:00:00+09:00");
const testMeasurementOverride = { layoutWidthPx: 1280, layoutHeightPx: 900, baselineGapPx: 10 };

/** 段階 2' が足した観測属性。ms 系と calls 系で扱いが違うので分けて持つ。 */
const MS_ATTRIBUTES = [
  "data-settle-partition-ms",
  "data-settle-revision-ms",
  "data-settle-signature-ms",
  "data-settle-flush-ms",
  "data-settle-solve-ms",
] as const;
const CALLS_ATTRIBUTES = [
  "data-settle-partition-calls",
  "data-settle-signature-calls",
  "data-settle-solve-calls",
] as const;
const ALL_ATTRIBUTES = [...MS_ATTRIBUTES, ...CALLS_ATTRIBUTES];

const BASE_AREAS = ["宮崎市", "都城市", "延岡市", "日南市", "日向市", "小林市", "串間市", "西都市"];

function weatherAlert(areas: string[], omitted: number, updatedAt: string): DisplayWeatherAlertV1 {
  return {
    source: "vpws50",
    label: "気象警報",
    role: "weatherWarning",
    totalAreas: areas.length + omitted,
    items: [{
      kind: "大雨警報", phenomenonKey: "heavy-rain", displaySeverity: "warning", rank: "warning",
      shownAreas: areas, omittedAreaCount: omitted,
    }],
    updatedAt,
  };
}

function snapshotWith(alerts: DisplayWeatherAlertV1[]): DisplayStateSnapshotV1 {
  return baseSnapshot({
    generatedAt: "2026-08-20T12:00:00.000Z",
    seq: 100,
    weatherAlerts: alerts,
    weatherExpandedKinds: collectWeatherExpandedKinds(alerts),
  });
}

const firstAlerts = [weatherAlert(BASE_AREAS, 4, "2026-08-20T12:00:00+09:00")];
const changedAlerts = [weatherAlert([...BASE_AREAS, "えびの市"], 5, "2026-08-20T12:05:00+09:00")];

function standbyRoot(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>(".standby")!;
}

function propsWith(extra: Record<string, unknown> = {}) {
  return {
    snapshot: snapshotWith(firstAlerts),
    now, dim: false, sseConnected: true, testMeasurementOverride,
    ...extra,
  };
}

/** settled=true になるまで microtask を回す。予算 240 の理由は段階 1 の同名関数を参照。 */
async function settle(container: HTMLElement, passes = 240): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await tick();
    const root = container.querySelector<HTMLElement>(".standby");
    if (pass > 8 && root?.dataset.measurementSettled === "true") return;
  }
}

interface Observation {
  epoch: number;
  attrs: Record<string, string | null>;
}

function observe(container: HTMLElement): Observation {
  const root = standbyRoot(container);
  const attrs: Record<string, string | null> = {};
  for (const name of ALL_ATTRIBUTES) attrs[name] = root.getAttribute(name);
  return { epoch: Number(root.dataset.measurementEpoch), attrs };
}

/** 初回 settle → weatherAlerts の内容変更で 2 epoch 目を開き、両 epoch の観測値を返す。 */
async function renderAndResettle(extra: Record<string, unknown> = {}) {
  const props = propsWith(extra);
  const view = render(StandbyScreen, props);
  await settle(view.container);
  const first = observe(view.container);

  await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
  await settle(view.container);
  return { view, first, second: observe(view.container) };
}

/**
 * `performance.now()` の呼び出しを **StandbyScreen 内の関数名ごと**に数える。
 *
 * 段階 2' の計測点はすべて「入口と出口で 1 回ずつ」の形なので、関数 F の計測が n 回走れば
 * F を含むスタックフレームからの呼び出しはちょうど 2n 回になる。これで `-calls` 属性が
 * 実呼び出し回数と一致していることを外から検証できる。
 *
 * 帰属は **直接の呼び出し元フレーム 1 枚だけ**で決める。スタックのどこかに
 * StandbyScreen が現れるかで判定すると、`time-slice-scheduler` の単調時計のように
 * StandbyScreen から間接的に呼ばれるだけの `performance.now()` まで拾ってしまう
 * （実測 13 件）。それらは `(outside)` に落とす。A2b の「ガード false で 1 回も
 * 呼ばれない」は、`(outside)` を除いた合計がゼロであることで判定する。
 */
function countPerformanceNowByFunction(): Map<string, number> {
  const byFunction = new Map<string, number>();
  const original = performance.now.bind(performance);
  vi.spyOn(performance, "now").mockImplementation(() => {
    // 先頭 2 枚は spy 自身（この mock と @vitest/spy）なので落とす。
    const frames = (new Error().stack ?? "").split("\n").slice(1)
      .filter((line) => !line.includes("@vitest/spy") && !line.includes("standby-settle-attribution-probe"));
    const caller = frames[0] ?? "";
    const name = caller.includes("StandbyScreen.svelte")
      ? (/at ([\w$.<>]+) \(/.exec(caller)?.[1] ?? "(anonymous)")
      : "(outside)";
    byFunction.set(name, (byFunction.get(name) ?? 0) + 1);
    return original();
  });
  return byFunction;
}

function insideStandbyTotal(byFunction: Map<string, number>): number {
  let total = 0;
  for (const [name, count] of byFunction) if (name !== "(outside)") total += count;
  return total;
}

beforeEach(() => {
  history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

describe("A2b: 段階 2' の観測点は preview / gate に閉じている", () => {
  it("(a) 既定 props（App.svelte と同じ形）では 8 属性が生えない", async () => {
    const { view, first, second } = await renderAndResettle();

    for (const sample of [first, second]) {
      for (const name of ALL_ATTRIBUTES) expect(sample.attrs[name]).toBeNull();
    }
    // 属性が無いのは「epoch が動いていない」からではない。
    expect(second.epoch).toBeGreaterThan(first.epoch);
    // 段階 1 の観測属性が既定で出ないことは同段階のテストが押さえている。ここで
    // その属性名に触れると段階 1 の A13 grep（許可ファイル 2 本のみ）に引っかかるので
    // 書かない。共有しているガード `settleCostProbe` の側は (b') が押さえている。
    // production の総数属性は現行どおり出続ける。
    expect(standbyRoot(view.container).hasAttribute("data-measurement-pass")).toBe(true);
  });

  it("(b) gateFixture 付きでは 8 属性が生え、epoch 内で単調非減少に伸びる", async () => {
    const props = propsWith({ gateFixture: "briefing-single-page" as const });
    const view = render(StandbyScreen, props);

    const series: Record<string, number[]> = Object.fromEntries(ALL_ATTRIBUTES.map((name) => [name, []]));
    for (let pass = 0; pass < 240; pass += 1) {
      await tick();
      const root = standbyRoot(view.container);
      for (const name of ALL_ATTRIBUTES) {
        const raw = root.getAttribute(name);
        if (raw != null) series[name]!.push(Number(raw));
      }
      if (pass > 8 && root.dataset.measurementSettled === "true") break;
    }

    const sample = observe(view.container);
    for (const name of ALL_ATTRIBUTES) {
      expect(sample.attrs[name], name).not.toBeNull();
      expect(Number.isFinite(Number(sample.attrs[name])), name).toBe(true);
      expect(Number(sample.attrs[name]), name).toBeGreaterThanOrEqual(0);

      const values = series[name]!;
      expect(values.length, name).toBeGreaterThan(1);
      for (let index = 1; index < values.length; index += 1) {
        // 累計なので epoch の途中で減ることはない。
        expect(values[index], `${name}[${index}]`).toBeGreaterThanOrEqual(values[index - 1]!);
      }
    }
    // 「常にゼロだから単調」ではないことの番兵。この fixture は必ず solve を回す。
    expect(Number(sample.attrs["data-settle-solve-calls"])).toBeGreaterThan(0);
    expect(Number(sample.attrs["data-settle-signature-calls"])).toBeGreaterThan(0);
  });

  it("(b') partitionDebug 単独（preview の実経路）でも 8 属性が生える", async () => {
    const { second } = await renderAndResettle({ partitionDebug: true });

    for (const name of ALL_ATTRIBUTES) expect(second.attrs[name], name).not.toBeNull();
    // weather 警報を積んだ fixture なので partition 探索は必ず走っている。
    expect(Number(second.attrs["data-settle-partition-calls"])).toBeGreaterThan(0);
  });

  it("(c) 累計は epoch 境界でゼロに戻る（epoch を跨がない）", async () => {
    const props = propsWith({ partitionDebug: true });
    const view = render(StandbyScreen, props);
    await settle(view.container);
    const first = observe(view.container);

    await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
    let mid: Observation | null = null;
    for (let pass = 0; pass < 240; pass += 1) {
      await tick();
      const root = standbyRoot(view.container);
      if (mid == null && Number(root.dataset.measurementEpoch) > first.epoch) mid = observe(view.container);
      if (pass > 8 && root.dataset.measurementSettled === "true") break;
    }

    expect(mid).not.toBeNull();
    // 前 epoch が実際にコストを積んでいたこと（比較対象がゼロでないこと）を先に固定する。
    expect(Number(first.attrs["data-settle-solve-calls"])).toBeGreaterThan(0);
    for (const name of CALLS_ATTRIBUTES) {
      expect(Number(mid!.attrs[name]), name).toBeLessThanOrEqual(Number(first.attrs[name]));
    }
    // 新 epoch の最初の観測は前 epoch の累計より小さい（リセットが効いている）。
    expect(Number(mid!.attrs["data-settle-solve-calls"])).toBeLessThan(Number(first.attrs["data-settle-solve-calls"]));
  });

  it("(d) ms 系は有限の非負値で、epoch の壁時計時間を超えない", async () => {
    const startedAt = performance.now();
    const { second } = await renderAndResettle({ partitionDebug: true });
    const wallClockMs = performance.now() - startedAt;

    for (const name of MS_ATTRIBUTES) {
      const value = Number(second.attrs[name]);
      expect(Number.isFinite(value), name).toBe(true);
      expect(value, name).toBeGreaterThanOrEqual(0);
      expect(value, name).toBeLessThanOrEqual(wallClockMs);
    }
  });
});

describe("A2b: ガードが false のとき計測が 1 回も走らない", () => {
  it("(a) 既定 props では StandbyScreen 由来の performance.now が 0 回", async () => {
    const byFunction = countPerformanceNowByFunction();
    await renderAndResettle();

    // 検出器が生きていることを先に確認する。スケジューラの単調時計など
    // StandbyScreen 外の呼び出しは観測できている＝spy 自体は効いている。
    expect(byFunction.size).toBeGreaterThan(0);
    expect(insideStandbyTotal(byFunction)).toBe(0);
  });

  it("(b) partitionDebug を立てると同じ検出器が呼び出しを捉える（番兵）", async () => {
    const byFunction = countPerformanceNowByFunction();
    await renderAndResettle({ partitionDebug: true });

    // (a) の 0 件が「検出器が壊れていて 0」ではないことの対。
    expect(insideStandbyTotal(byFunction)).toBeGreaterThan(0);
    for (const fn of ["readMeasurements", "signature", "solvePlan", "weatherMeasurementRanges"]) {
      expect(byFunction.get(fn) ?? 0, fn).toBeGreaterThan(0);
    }
  });
});

describe("A2b: -calls が対応する関数の実呼び出し回数と一致する", () => {
  /**
   * `signature()` は settle ループと `recordSettleTrace` からしか呼ばれない。どちらも
   * epoch のリセット後なので、計数器の値とスタック観測は**厳密に一致**する。
   */
  it("(a) signature-calls は signature() の実行回数とちょうど一致する", async () => {
    const byFunction = countPerformanceNowByFunction();
    const props = propsWith({ partitionDebug: true });
    const view = render(StandbyScreen, props);
    await settle(view.container);

    // 2 epoch 目の頭で計数器も観測もリセットして、1 epoch を丸ごと測る。
    byFunction.clear();
    await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
    await settle(view.container);

    const calls = Number(observe(view.container).attrs["data-settle-signature-calls"]);
    expect(calls).toBeGreaterThan(0);
    expect(byFunction.get("signature") ?? 0).toBe(calls * 2);
  });

  /**
   * partition と solve は `$derived` / テンプレート式からも呼ばれる。epoch の開始前や
   * settled publish の後にも `plan` が再計算されうるので、スタック観測は計数器の
   * **下限**になる（epoch 外の実行はリセットで捨てられるが、spy には残る）。
   * 「入口/出口 2 回呼び」の形は崩れないので、差は必ず偶数である。
   */
  it("(b) partition-calls / solve-calls は実行回数の下限として整合する", async () => {
    const byFunction = countPerformanceNowByFunction();
    const props = propsWith({ partitionDebug: true });
    const view = render(StandbyScreen, props);
    await settle(view.container);

    byFunction.clear();
    await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
    await settle(view.container);

    const sample = observe(view.container);
    const partitionCalls = Number(sample.attrs["data-settle-partition-calls"]);
    const solveCalls = Number(sample.attrs["data-settle-solve-calls"]);
    const partitionObserved = (byFunction.get("weatherMeasurementRanges") ?? 0)
      + (byFunction.get("tornadoMeasurementRanges") ?? 0);
    const solveObserved = byFunction.get("solvePlan") ?? 0;

    expect(partitionCalls).toBeGreaterThan(0);
    expect(solveCalls).toBeGreaterThan(0);
    expect(partitionObserved).toBeGreaterThanOrEqual(partitionCalls * 2);
    expect(solveObserved).toBeGreaterThanOrEqual(solveCalls * 2);
    expect(partitionObserved % 2).toBe(0);
    expect(solveObserved % 2).toBe(0);
  });
});

describe("A13: 段階 2' の識別子が production パスへ漏れていない", () => {
  // 起点の解き方と `new URL(..., import.meta.url)` を使えない理由は段階 1 のテストを参照。
  const SOURCE_ROOT = `${join(fileURLToPath(import.meta.url), "..", "..", "..")}/`;
  const NEW_IDENTIFIERS = [
    ...ALL_ATTRIBUTES,
    "settleAttribution",
    "publishSettleAttribution",
    "settlePartitionMs",
    "settlePartitionCalls",
    "settleRevisionMs",
    "settleSignatureMs",
    "settleSignatureCalls",
    "settleFlushMs",
    "settleSolveMs",
    "settleSolveCalls",
  ];
  /** 段階 2' の allowed_paths。ここだけが新識別子を持ってよい。 */
  const ALLOWED = [
    "components/StandbyScreen.svelte",
    "components/__tests__/standby-settle-attribution-probe.test.ts",
  ];

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.(ts|svelte)$/.test(name)) acc.push(full);
    }
    return acc;
  }

  it("App.svelte にも他のモジュールにも新識別子が現れない", () => {
    // 起点が正しい木を指していることを先に固定する（空の木を歩いた 0 件を合格と読まない）。
    expect(existsSync(join(SOURCE_ROOT, "App.svelte"))).toBe(true);
    const files = sourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(50);

    const offenders: string[] = [];
    for (const file of files) {
      const relative = file.slice(SOURCE_ROOT.length);
      if (ALLOWED.includes(relative)) continue;
      const text = readFileSync(file, "utf8");
      for (const identifier of NEW_IDENTIFIERS) {
        if (text.includes(identifier)) offenders.push(`${relative}: ${identifier}`);
      }
    }
    expect(offenders).toEqual([]);

    // 許可された 1 ファイルの側では実際に全識別子が使われている（探索の妥当性確認）。
    const standby = readFileSync(join(SOURCE_ROOT, ALLOWED[0]!), "utf8");
    for (const identifier of NEW_IDENTIFIERS) expect(standby, identifier).toContain(identifier);
  });
});
