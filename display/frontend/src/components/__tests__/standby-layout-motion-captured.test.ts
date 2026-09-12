/**
 * GitHub Issue #15 第 2 便 spec の分岐 7-A（作者裁定 2026-09-08）の受入テスト。
 * 出典 spec: docs/specs/2026-09-08-standby-resettle-residual-load.md（§3.0 / §4.4 / §5.2 B6）。
 *
 * `LayoutMotionCoordinator.diagnostics().captured` は `preEpochCapture` が取った clone 枚数だが、
 * `runForEpoch` が `capture` を捨てた時点で 0 に戻る一過性の値である。そのため StandbyScreen は
 * `preEpochCapture` の直後に枚数を控え、`data-layout-motion-captured` として出す。
 *
 * 守る契約は三つ。
 *
 *  1. **production の DOM は変わらない**。`partitionDebug` も `gateFixture` も無い既定では
 *     属性が生えない（`src/App.svelte` はどちらも渡さない）。→ ケース (a)
 *  2. **preview / gate では coordinator の実値と一致する**。→ ケース (b)
 *  3. **clone 0 枚は `"0"` として出る／内容変更後の epoch では 0 でない**。段階 3 の
 *     「前倒し判定が広すぎて全 epoch で clone を止める」退行は、この 0 / 非 0 の対で検出する。
 *     → ケース (c)(d)
 *
 * **jsdom の epoch 1 が 0 になるのは jsdom 固有の姿である**（spec §3.0 の F1 注記）。
 * `settleMeasurements` は `fontsReady` が false の間 `StandbyScreen.svelte:1816` で早期 return し、
 * `fontsReady` の初期値は `document.fonts == null`（`:266`）。jsdom は `document.fonts` を持たないので
 * 最初から true になり、mount 前の `$effect.pre` が開いた epoch 1（登録カード 0 枚）がそのまま settle する。
 * 実ブラウザでは epoch 1 は settle せず、`document.fonts.ready` 後の epoch が初回 commit になるため
 * **枚数は非 0** である。本テストの 0 を実機の期待値として読んではいけない。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import { tick } from "svelte";

/** `preEpochCapture` 直後の `diagnostics().captured` を epoch 順に記録する。 */
const capturedPerEpoch: number[] = [];

vi.mock("../../lib/legacy-standby/layout-motion.svelte", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/legacy-standby/layout-motion.svelte")>();
  return {
    ...actual,
    createLayoutMotionCoordinator: (options: Parameters<typeof actual.createLayoutMotionCoordinator>[0]) => {
      const inner = actual.createLayoutMotionCoordinator(options);
      return new Proxy(inner, {
        get(target, prop, receiver) {
          if (prop === "preEpochCapture") {
            return (epoch: string) => {
              target.preEpochCapture(epoch);
              capturedPerEpoch.push(target.diagnostics().captured);
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

function gateProps(extra: Record<string, unknown> = {}) {
  return {
    snapshot: snapshotWith(firstAlerts),
    now, dim: false, sseConnected: true, testMeasurementOverride,
    gateFixture: "briefing-single-page" as const,
    ...extra,
  };
}

/** 初回 settle → weatherAlerts の内容変更で 2 epoch 目を開く → 両方の観測値を返す。 */
async function renderAndResettle(extra: Record<string, unknown>) {
  const props = {
    snapshot: snapshotWith(firstAlerts),
    now, dim: false, sseConnected: true, testMeasurementOverride,
    ...extra,
  };
  const view = render(StandbyScreen, props);
  await settle(view.container);
  const first = {
    epoch: Number(standbyRoot(view.container).dataset.measurementEpoch),
    attribute: standbyRoot(view.container).getAttribute("data-layout-motion-captured"),
  };

  await view.rerender({ ...props, snapshot: snapshotWith(changedAlerts) });
  await settle(view.container);
  const second = {
    epoch: Number(standbyRoot(view.container).dataset.measurementEpoch),
    attribute: standbyRoot(view.container).getAttribute("data-layout-motion-captured"),
  };
  return { view, first, second };
}

beforeEach(() => {
  capturedPerEpoch.length = 0;
});

describe("StandbyScreen data-layout-motion-captured (#15 分岐 7-A)", () => {
  it("(a) 既定（partitionDebug なし・gateFixture なし）では属性が生えない", async () => {
    const { view, first, second } = await renderAndResettle({});

    // production 相当の props。observation point は書き込みも属性出力もしない。
    expect(first.attribute).toBeNull();
    expect(second.attribute).toBeNull();
    expect(standbyRoot(view.container).hasAttribute("data-layout-motion-captured")).toBe(false);
    // 内容変更で epoch は実際に進んでいる（属性が無いのは「何も起きていない」からではない）。
    expect(second.epoch).toBeGreaterThan(first.epoch);
    // coordinator 側の観測は独立に成立している（属性だけが production で閉じている）。
    expect(capturedPerEpoch.length).toBeGreaterThanOrEqual(2);
    expect(capturedPerEpoch.at(-1)).toBeGreaterThan(0);
  });

  it("(b) gateFixture 付きでは属性が生え、値が coordinator の diagnostics().captured と一致する", async () => {
    const { second } = await renderAndResettle({ gateFixture: "briefing-single-page" });

    expect(second.attribute).not.toBeNull();
    expect(second.attribute).toBe(String(capturedPerEpoch.at(-1)));
  });

  it("(b') partitionDebug 単独（preview の実経路）でも属性が生える", async () => {
    const { second } = await renderAndResettle({ partitionDebug: true });

    expect(second.attribute).toBe(String(capturedPerEpoch.at(-1)));
  });

  it("(c) clone 0 枚の epoch は属性が消えず \"0\" が出る、内容変更後の epoch は 0 でない", async () => {
    const { first, second } = await renderAndResettle({ gateFixture: "briefing-single-page" });

    // jsdom の epoch 1 は mount 前の $effect.pre で開くので登録カードがまだ無い。
    expect(capturedPerEpoch[0]).toBe(0);
    // Svelte の set_attribute は値が == null のときだけ removeAttribute する。
    // 数値 0 は消えず "0" として残る（枚数 0 と「ガードが立っていない」を区別できる根拠）。
    expect(first.attribute).toBe("0");
    expect(second.epoch).toBeGreaterThan(first.epoch);
    expect(Number(second.attribute)).toBeGreaterThan(0);
  });

  it("(d) gate props では render 直後（settle 前）から epoch 1 の \"0\" が出ている", async () => {
    // レビュー指摘 F5 は「render 直後は属性が生えない」を想定していたが、実測で覆った。
    // $effect.pre は mount 前に epoch 1 を開き、その中で観測点が書かれるので、
    // 最初の DOM 反映時点で既に属性が存在する。属性の欠如は「ガード未成立」だけを意味する。
    const view = render(StandbyScreen, gateProps());
    const root = standbyRoot(view.container);

    expect(root.dataset.measurementEpoch).toBe("1");
    expect(root.dataset.measurementSettled).toBe("false");
    expect(root.hasAttribute("data-layout-motion-captured")).toBe(true);
    expect(root.getAttribute("data-layout-motion-captured")).toBe("0");
  });
});
