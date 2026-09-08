/**
 * GitHub Issue #15 第 3 便 spec の段階 1（帰属の分離）の受入テスト。
 * 出典 spec: docs/specs/2026-09-09-standby-epoch-settle-cost.md（§3 段階 1 / §4.1 / §5.1 A1・A2・A13）。
 *
 * 段階 1 は製品の見え方も production の DOM も変えない。**計測だけ**を足す段階なので、
 * 本テストが守る契約は「観測点が preview / gate の外へ漏れないこと」と
 * 「`gateCapture` の 3 用途を分けたときに、止めたい 1 つだけが止まること」の 2 本である。
 *
 * ## なぜ属性を足すのか（spec §2.8）
 *
 * 1 epoch 2,526ms の内訳が「ノード読み取り (a)」なのか「pass 位置とともに増える別項 (b)〜(f)」
 * なのかは、段階 0 の実測（rc 線形 0.813 / idx 線形 0.823 / idx 二次 0.849 / rc 二次 0.848）から
 * 分離できない。分離できないと段階 2（prefix 計測のキャッシュ）の効果が 0〜75% の幅でしか
 * 書けない。`data-settle-read-ms ÷ epoch 総時間` がその幅を潰す主指標である。
 *
 * ## `gateCapture` の 3 用途（spec §1.3）
 *
 * | 用途 | 段階 1 での扱い |
 * |---|---|
 * | fixture シナリオの選択（URL の `gateScenario` そのもの） | **現行のまま** |
 * | settle トレースの記録と直列化（`recordSettleTrace` / `data-settle-trace`） | `?settleTrace=0` で切れる |
 * | `recentHypocentersClipped` の視覚 assertion | **現行のまま**（性能計測の対象ではない） |
 *
 * 3 つ目が「止まらない」ことを属性値では判定できない。jsdom の rect はすべて 0 なので、
 * assertion が走っても走らなくても `data-recent-hypocenters-horizontal-clipped` は "false" に
 * なるからである。そこで `.quakes-card .hypocenter` の `querySelectorAll` 呼び出しそのものを
 * 数えて、経路が実行されたことを直接観測する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `recordSettleTrace` の実行そのものを数えるための計数点。
 *
 * 属性 `data-settle-trace` の有無だけを見ると、テンプレート側のガードが効いていれば
 * **記録が走り続けていても緑になる**。段階 1 が落としたいのは属性ではなく pass ごとの
 * 記録コスト（`signature()` の再計算とトレース配列のコピー、spec §2.7 (f)）なので、
 * `recordSettleTrace` が唯一 probe step ごとに呼ぶ `pendingProbeCount()` を数える。
 *
 * 同じメソッドは `briefingPartitionDebugContext`（`:993`）も読むが、そちらは
 * `$derived` で render バッチごとに 1 回である。probe step ごとに回る記録が止まれば
 * 呼び出し回数ははっきり落ちる。
 */
const pendingProbeCountCalls = { value: 0 };

vi.mock("../../lib/legacy-standby/epoch-coordinator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/legacy-standby/epoch-coordinator")>();
  return {
    ...actual,
    createEpochCoordinator: (...args: Parameters<typeof actual.createEpochCoordinator>) => {
      const inner = actual.createEpochCoordinator(...args);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "pendingProbeCount") {
            return () => {
              pendingProbeCountCalls.value += 1;
              return target.pendingProbeCount();
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
const { baseSnapshot } = await import("../../lib/__tests__/fixtures");
const { collectWeatherExpandedKinds } = await import("../../lib/weather-expanded-kinds");
type DisplayStateSnapshotV1 = import("../../lib/protocol").DisplayStateSnapshotV1;
type DisplayWeatherAlertV1 = import("../../lib/protocol").DisplayWeatherAlertV1;

const now = new Date("2026-08-20T12:00:00+09:00");
const testMeasurementOverride = { layoutWidthPx: 1280, layoutHeightPx: 900, baselineGapPx: 10 };

/** `:1514` の視覚 assertion が使う唯一のセレクタ。 */
const HYPOCENTER_SELECTOR = ".quakes-card .hypocenter";

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

const BASE_AREAS = ["宮崎市", "都城市", "延岡市", "日南市", "日向市", "小林市", "串間市", "西都市"];

function snapshotWith(alerts: DisplayWeatherAlertV1[]): DisplayStateSnapshotV1 {
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
  });
}

const firstAlerts = [weatherAlert(BASE_AREAS, 4, "2026-08-20T12:00:00+09:00")];
const changedAlerts = [weatherAlert([...BASE_AREAS, "えびの市"], 5, "2026-08-20T12:05:00+09:00")];

/** settled=true になるまで microtask を回す。予算 240 の理由は standby-metadata-resettle.test.ts の同名関数を参照。 */
async function settle(container: HTMLElement, passes = 240): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await tick();
    const root = container.querySelector<HTMLElement>(".standby");
    if (pass > 8 && root?.dataset.measurementSettled === "true") return;
  }
}

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

function observe(container: HTMLElement) {
  const root = standbyRoot(container);
  return {
    epoch: Number(root.dataset.measurementEpoch),
    readNodes: root.getAttribute("data-settle-read-nodes"),
    readMs: root.getAttribute("data-settle-read-ms"),
    keyCounts: root.getAttribute("data-prefix-probe-key-counts"),
    probeCount: root.getAttribute("data-prefix-probe-count"),
    trace: root.getAttribute("data-settle-trace"),
  };
}

beforeEach(() => {
  history.replaceState({}, "", "/");
  pendingProbeCountCalls.value = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  history.replaceState({}, "", "/");
});

describe("A1: settle コスト観測点は preview / gate に閉じている", () => {
  it("(a) 既定 props（App.svelte と同じ形）では 3 属性が生えない", async () => {
    const { view, first, second } = await renderAndResettle();

    for (const sample of [first, second]) {
      expect(sample.readNodes).toBeNull();
      expect(sample.readMs).toBeNull();
      expect(sample.keyCounts).toBeNull();
    }
    // 属性が無いのは「epoch が動いていない」からではない。
    expect(second.epoch).toBeGreaterThan(first.epoch);
    // 既存の production 属性は現行どおり出続ける（総数側は触っていない）。
    expect(second.probeCount).not.toBeNull();
    expect(standbyRoot(view.container).hasAttribute("data-measurement-read-count")).toBe(true);
  });

  it("(b) gateFixture 付きでは 3 属性が生え、read-nodes は epoch 内で単調に増える", async () => {
    const props = propsWith({ gateFixture: "briefing-single-page" as const });
    const view = render(StandbyScreen, props);

    const series: number[] = [];
    for (let pass = 0; pass < 240; pass += 1) {
      await tick();
      const root = standbyRoot(view.container);
      const raw = root.getAttribute("data-settle-read-nodes");
      if (raw != null) series.push(Number(raw));
      if (pass > 8 && root.dataset.measurementSettled === "true") break;
    }

    const sample = observe(view.container);
    expect(sample.readNodes).not.toBeNull();
    expect(sample.readMs).not.toBeNull();
    expect(sample.keyCounts).not.toBeNull();

    // 単調非減少（epoch 内でリセットされない）かつ実際に増えている。
    expect(series.length).toBeGreaterThan(1);
    for (let index = 1; index < series.length; index += 1) {
      expect(series[index]).toBeGreaterThanOrEqual(series[index - 1]!);
    }
    expect(Number(sample.readNodes)).toBeGreaterThan(series[0]!);
    // 固定 14 本 × pass 数だけでも下限を超える。瞬間値ではなく累計であることの固定。
    expect(Number(sample.readNodes)).toBeGreaterThan(Number(standbyRoot(view.container).dataset.measurementReadCount));
  });

  it("(b') partitionDebug 単独（preview の実経路）でも 3 属性が生える", async () => {
    const { second } = await renderAndResettle({ partitionDebug: true });

    expect(second.readNodes).not.toBeNull();
    expect(second.readMs).not.toBeNull();
    expect(second.keyCounts).not.toBeNull();
  });

  it("(c) read-ms は有限の非負値で、epoch の壁時計時間を超えない", async () => {
    const startedAt = performance.now();
    const { second } = await renderAndResettle({ partitionDebug: true });
    const wallClockMs = performance.now() - startedAt;

    const readMs = Number(second.readMs);
    expect(Number.isFinite(readMs)).toBe(true);
    expect(readMs).toBeGreaterThanOrEqual(0);
    expect(readMs).toBeLessThanOrEqual(wallClockMs);
  });

  it("(d) read-nodes と read-ms は epoch 境界でリセットされる（累計が epoch を跨がない）", async () => {
    const props = propsWith({ partitionDebug: true });
    const view = render(StandbyScreen, props);
    await settle(view.container);
    const first = observe(view.container);

    await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
    // settle 中（settled=false）の最初の観測は、前 epoch の累計より小さいはずである。
    let mid: number | null = null;
    for (let pass = 0; pass < 240; pass += 1) {
      await tick();
      const root = standbyRoot(view.container);
      if (Number(root.dataset.measurementEpoch) > first.epoch && mid == null) {
        mid = Number(root.getAttribute("data-settle-read-nodes"));
      }
      if (pass > 8 && root.dataset.measurementSettled === "true") break;
    }

    expect(Number(first.readNodes)).toBeGreaterThan(0);
    expect(mid).not.toBeNull();
    expect(mid!).toBeLessThan(Number(first.readNodes));
  });

  it("(e) key 別内訳は entries と reads を持ち、reads の総和が read-nodes を超えない", async () => {
    const { second } = await renderAndResettle({ partitionDebug: true });

    const counts = JSON.parse(second.keyCounts!) as Record<string, { entries: number; reads: number }>;
    expect(typeof counts).toBe("object");
    let totalEntries = 0;
    let totalReads = 0;
    for (const [key, value] of Object.entries(counts)) {
      expect(typeof key).toBe("string");
      expect(Number.isInteger(value.entries)).toBe(true);
      expect(Number.isInteger(value.reads)).toBe(true);
      totalEntries += value.entries;
      totalReads += value.reads;
    }
    // entries の総和は production 側の総数属性と一致する（同じ配列から導いている）。
    expect(totalEntries).toBe(Number(second.probeCount));
    // reads は prefix ノードだけの累計なので、カード＋固定を含む read-nodes を超えない。
    expect(totalReads).toBeLessThanOrEqual(Number(second.readNodes));
  });
});

describe("A2: settleTrace パラメータはトレース記録だけを止める", () => {
  function countHypocenterQueries(): { value: number } {
    const counter = { value: 0 };
    const original = Element.prototype.querySelectorAll;
    vi.spyOn(Element.prototype, "querySelectorAll").mockImplementation(function (this: Element, selector: string) {
      if (selector === HYPOCENTER_SELECTOR) counter.value += 1;
      return original.call(this, selector) as ReturnType<typeof original>;
    });
    return counter;
  }

  it("(a) gateScenario だけのときは従来どおり data-settle-trace が生える", async () => {
    history.replaceState({}, "", "/?gateScenario=max");
    const { second } = await renderAndResettle();

    expect(second.trace).not.toBeNull();
    expect(JSON.parse(second.trace!).length).toBeGreaterThan(0);
  });

  it("(b) settleTrace=0 で data-settle-trace が消え、視覚 assertion は走り続ける", async () => {
    history.replaceState({}, "", "/?gateScenario=max&settleTrace=0");
    const counter = countHypocenterQueries();
    const { second } = await renderAndResettle();

    expect(second.trace).toBeNull();
    // :1514 は `gateCapture &&` のままなので、トレースを切っても経路は実行される。
    expect(counter.value).toBeGreaterThan(0);
  });

  /**
   * **これは documentation ケースであって、分割の退行を捕まえる検出器ではない。**
   *
   * fixture 選択は `PreviewApp.svelte:238-240` が URL の `gateScenario` を直接読んで
   * `legacyStandbyGateSnapshot()` へ渡す経路であり、`StandbyScreen` の `gateCapture` も
   * `settleTraceCapture` も通らない。ここで渡している `gateFixture` は prop なので、
   * 段階 1 の用途分割がどう壊れてもこのケースは緑のままになる。
   *
   * fixture 選択が止まっていないことの実際の根拠は、**`PreviewApp.svelte` に差分が無いこと**
   * （A13 / `git diff --stat`）である。本ケースは「prop 経路と URL 経路が別物である」という
   * 読み手向けの記録として置く。
   */
  it("(c) settleTrace=0 でも fixture 選択（gateFixture prop）は効いたままである", async () => {
    history.replaceState({}, "", "/?gateScenario=max&settleTrace=0");
    const { view, second } = await renderAndResettle({ gateFixture: "overflow" as const });

    expect(second.trace).toBeNull();
    expect(standbyRoot(view.container).classList.contains("gate-overflow")).toBe(true);
    // 観測属性側は gateFixture のガードで生きている（切ったのはトレースだけ）。
    expect(second.readNodes).not.toBeNull();
  });

  it("(d) gateScenario 無しで settleTrace=0 だけを付けても従来どおり（トレースは元から無い）", async () => {
    history.replaceState({}, "", "/?settleTrace=0");
    const { second } = await renderAndResettle();

    expect(second.trace).toBeNull();
  });

  it("(e) gateScenario 有りのとき、視覚 assertion はトレースの on / off どちらでも走る", async () => {
    history.replaceState({}, "", "/?gateScenario=max");
    const withTrace = countHypocenterQueries();
    await renderAndResettle();
    const withTraceCount = withTrace.value;
    vi.restoreAllMocks();

    history.replaceState({}, "", "/?gateScenario=max&settleTrace=0");
    const withoutTrace = countHypocenterQueries();
    await renderAndResettle();

    expect(withTraceCount).toBeGreaterThan(0);
    expect(withoutTrace.value).toBeGreaterThan(0);
  });

  it("(f) settleTrace=0 は属性だけでなく記録そのものを止める（§2.7 (f) のコスト）", async () => {
    history.replaceState({}, "", "/?gateScenario=max");
    await renderAndResettle();
    const withTrace = pendingProbeCountCalls.value;

    pendingProbeCountCalls.value = 0;
    history.replaceState({}, "", "/?gateScenario=max&settleTrace=0");
    await renderAndResettle();
    const withoutTrace = pendingProbeCountCalls.value;

    // 記録が止まれば、probe step ごとの呼び出しが丸ごと消える。
    expect(withTrace).toBeGreaterThan(0);
    expect(withoutTrace).toBeLessThan(withTrace);
  });
});

describe("A13: 新しい識別子が他の production モジュールへ漏れていない", () => {
  // 起点はテストファイル自身の位置から解く。`--root display` のように cwd が動く
  // 呼び出し方でも壊れないよう、process.cwd() は使わない。
  //
  // `new URL("...", import.meta.url)` の形は使えない。Vite がこのリテラル形を
  // **アセット URL 構築として静的に書き換える**ため、`/frontend/src/` のような
  // root 相対文字列に化けて file スキームでなくなる（実測で確認）。
  // `import.meta.url` を単独で読む経路にはこの書き換えが掛からない。
  const SOURCE_ROOT = `${join(fileURLToPath(import.meta.url), "..", "..", "..")}/`;
  /** 段階 1 で新設した識別子。既存の `settleTrace` 変数（:245 / :1821）は spec §5.1 A13 の対象外。 */
  const NEW_IDENTIFIERS = [
    "settleTraceCapture",
    "data-settle-read-nodes",
    "data-settle-read-ms",
    "data-prefix-probe-key-counts",
  ];
  /** 段階 1 の allowed_paths。ここだけが新識別子を持ってよい。 */
  const ALLOWED = ["components/StandbyScreen.svelte", "components/__tests__/standby-settle-cost-probe.test.ts"];

  function sourceFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sourceFiles(full, acc);
      else if (/\.(ts|svelte)$/.test(name)) acc.push(full);
    }
    return acc;
  }

  it("App.svelte にも他のモジュールにも新識別子が現れない", () => {
    // 起点が正しい木を指していることを先に固定する。解決が狂った場合に
    // 「空の木を歩いて 0 件だった」を合格と読まないための番兵である。
    expect(existsSync(join(SOURCE_ROOT, "App.svelte"))).toBe(true);

    const files = sourceFiles(SOURCE_ROOT);
    // 探索対象が実在することを先に確定させる（0 件の grep を「合格」と読まないため）。
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
    for (const identifier of NEW_IDENTIFIERS) expect(standby).toContain(identifier);
  });

  it("production の App.svelte は settle コスト観測点を有効にしない", () => {
    const app = readFileSync(join(SOURCE_ROOT, "App.svelte"), "utf8");

    expect(app).not.toContain("partitionDebug");
    expect(app).not.toContain("gateFixture");
    expect(app).not.toContain("settleTrace");
  });
});
