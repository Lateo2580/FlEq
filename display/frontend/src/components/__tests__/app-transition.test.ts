import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, describe, it, expect, vi } from "vitest";
import App from "../../App.svelte";
import type {
  DisplayActiveEewV1,
  DisplayQuakeMapEventV1,
  DisplayStateSnapshotV1,
} from "../../lib/protocol";
import { resetQuakeMapLoaderForTest } from "../../lib/quake-map-loader";
import { baseSnapshot } from "../../lib/__tests__/fixtures";

type SseListener = (event: MessageEvent<string>) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, SseListener[]>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string | URL) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback = listener as unknown as SseListener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }

  emit(type: "snapshot" | "state", snapshot: DisplayStateSnapshotV1): void {
    const event = new MessageEvent<string>(type, {
      data: JSON.stringify({ type, snapshot }),
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {}
}

function mapEvent(): DisplayQuakeMapEventV1 {
  return {
    eventKey: "earthquake:Q1",
    eventId: "Q1",
    sourceType: "VXSE53",
    revision: { reportTimeMs: 100, serial: "1" },
    reportDateTime: "2026-07-30T12:00:00+09:00",
    originTime: "2026-07-30T11:59:00+09:00",
    hypocenterName: "静岡県東部",
    depth: "10km",
    magnitude: "4.8",
    maxInt: "4",
    maxIntRank: 4,
    tsunamiWarning: false,
    intensityGroups: [{
      intensity: "4",
      rank: 4,
      areas: ["静岡県東部"],
      omittedAreaCount: 0,
    }],
    localAreas: [{ code: "440", rank: 4 }],
    updatedAtMs: 100,
  };
}

function eew(): DisplayActiveEewV1 {
  return {
    kind: "eew",
    eventId: "E1",
    serial: "1",
    isWarning: true,
    isFinal: false,
    isCancellation: false,
    hypocenterName: "駿河湾",
    forecastMaxInt: "5弱",
    forecastMaxIntRank: 5,
    magnitude: "5.0",
    colorIndex: null,
    reportDateTime: "2026-07-30T12:00:01+09:00",
    originTime: "2026-07-30T12:00:00+09:00",
    isAssumedHypocenter: false,
    depth: "10km",
    maxLgInt: null,
    regions: [],
    updatedAtMs: 101,
  };
}

function mapAssetResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

afterEach(() => {
  cleanup();
  resetQuakeMapLoaderForTest();
  FakeEventSource.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ソース契約に加え、下段で FakeEventSource を通した App 本体の実レンダー遷移も固定する。
const src = readFileSync(join(__dirname, "..", "..", "App.svelte"), "utf-8");

describe("App クロスフェード中の入力所有権 (指摘1 → レビュー再検証)", () => {
  it("pointer-events:none は現 mode と一致しない (退場中の) 層だけに掛かる。常時 none にはしない", () => {
    // main に現 mode を属性化している
    expect(src).toContain("data-mode={mode}");
    // 非活性層のみ無効化するルール (三つの mode の全組合せ)
    expect(src).toMatch(/main\[data-mode="standby"\]\s+\.screen-layer\[data-kind="quakeMap"\]/);
    expect(src).toMatch(/main\[data-mode="standby"\]\s+\.screen-layer\[data-kind="emergency"\]/);
    expect(src).toMatch(/main\[data-mode="quakeMap"\]\s+\.screen-layer\[data-kind="standby"\]/);
    expect(src).toMatch(/main\[data-mode="quakeMap"\]\s+\.screen-layer\[data-kind="emergency"\]/);
    expect(src).toMatch(/main\[data-mode="emergency"\]\s+\.screen-layer\[data-kind="standby"\]/);
    expect(src).toMatch(/main\[data-mode="emergency"\]\s+\.screen-layer\[data-kind="quakeMap"\]/);
    // 緊急層を無条件で pointer-events:none にするルールは存在しない (緊急画面の対話を殺すため)
    expect(src).not.toMatch(/\.screen-layer\[data-kind="emergency"\]\s*\{\s*z-index:\s*2;\s*pointer-events:\s*none/);
    // 緊急層の単独ルールは z-index のみ (pointer-events を含まない)
    const emergencyRule = src.match(/\.screen-layer\[data-kind="emergency"\]\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(emergencyRule).not.toContain("pointer-events");
  });

  it("quakeMap は専用画面層を使い、時計・待機 stack・緊急 reveal と競合しない", () => {
    expect(src).toContain('import QuakeMapScreen from "./components/QuakeMapScreen.svelte"');
    expect(src).toContain('data-kind="quakeMap"');
    expect(src).toContain("<QuakeMapScreen event={quakeMapEvent} dim={effectiveDim} />");
    expect(src).toMatch(/mode === "quakeMap"[\s\S]*?in:fade=\{\{ duration: calmDur \}\}/);
    expect(src).not.toMatch(/data-kind="quakeMap"[\s\S]{0,180}data-motion-reveal/);
    expect(src).toMatch(/deriveMode\(connection\.state,\s*clock\.now\.getTime\(\)\)/);
  });

  it("減光トグルは <svelte:window> のガード付きハンドラが担う (層に依存しない)", () => {
    // onclick に shouldToggleDimOnClick ガード経由で dim.toggle() を呼ぶ
    expect(src).toMatch(/onclick=\{[^}]*shouldToggleDimOnClick[^}]*dim\.toggle\(\)[^}]*\}/);
    // onkeydown に shouldToggleDimOnKey 経由で dim.toggle() を呼ぶ
    expect(src).toMatch(/onkeydown=\{[^}]*shouldToggleDimOnKey[^}]*dim\.toggle\(\)[^}]*\}/);
  });
});

// Spec C §4: night-dim は engine 算出の weatherL5Active を直接使う。severityTier === "critical" の
// 流用は禁止 (大津波警報など他要因が混入する)。パネル降格後も警報解除まで true なので、フロントは
// 期限計算をしない。App は EventSource を開くため jsdom で render できず、配線をソース契約で固定する
describe("App night-dim の気象 L5 サスペンド (spec C §4)", () => {
  // 判定そのものは computeSnapshotAlertActive の真理値表テスト (dim-interaction.test.ts) が
  // 状態値で固定する。ここは App がその純関数へ snapshot を渡して合成していることだけを見る
  it("snapshot の掲載判定を computeSnapshotAlertActive に委ね、テロップ走行と OR で合成する", () => {
    expect(src).toMatch(/computeSnapshotAlertActive\(connection\.state\.snapshot\)/);
    expect(src).toMatch(
      /computeEffectiveDim\(\s*dim\.requested,\s*tickerAlertActive \|\| snapshotAlertActive,?\s*\)/,
    );
  });

  it("severityTier を減光判定に流用していない (dim は weatherL5Active のみ)", () => {
    expect(src).not.toMatch(/computeEffectiveDim\([^)]*severityTier/);
  });
});

describe("App emergency 遷移での overlay 明示クローズ (指摘5)", () => {
  it("StandbyScreen を bind:this で参照し、mode が standby を離れたら closeQuakeCard を呼ぶ", () => {
    expect(src).toContain("bind:this={standbyRef}");
    // mode !== "standby" で standbyRef?.closeQuakeCard() を呼ぶ $effect がある
    expect(src).toMatch(/mode\s*!==\s*"standby"[\s\S]*?standbyRef\?\.closeQuakeCard\(\)/);
  });
});

describe("App 三画面 mode の実レンダー遷移", () => {
  it("quakeMap→emergency→期限内quakeMap復帰→期限切れstandbyで、outro層の入力所有権を外す", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-07-30T12:00:00+09:00");
    vi.setSystemTime(nowMs);
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    } as unknown as MediaQueryList)));
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).includes("/tips?")) return mapAssetResponse({ tips: [] });
      return mapAssetResponse({
        schemaVersion: 1,
        projectionInsetsVersion: "jma-quake-projection-insets-v1",
        dataset: "AreaForecastLocalE",
        codeType: "code",
        viewBox: [0, 0, 1000, 800],
        pathsByCode: { "440": "M0,0L10,0L10,10Z" },
        insets: [],
      });
    }));

    const event = mapEvent();
    const expiresAtMs = nowMs + 5_000;
    const quakeSnapshot = baseSnapshot({
      severityTier: "caution",
      backgroundTone: "caution",
      mapLayers: {
        quake: {
          events: [event],
          nonEmergencyHost: { eventKey: event.eventKey, expiresAtMs },
        },
      },
    });
    const { container } = render(App);
    flushSync();
    const source = FakeEventSource.instances[0];
    expect(source).toBeDefined();

    source!.emit("snapshot", quakeSnapshot);
    flushSync();
    const main = container.querySelector("main");
    expect(main?.getAttribute("data-mode")).toBe("quakeMap");
    expect(container.querySelector('.screen-layer[data-kind="quakeMap"]')).toBeTruthy();

    source!.emit("state", {
      ...quakeSnapshot,
      activeEews: [eew()],
      severityTier: "alert",
      backgroundTone: "alert",
    });
    flushSync();
    expect(main?.getAttribute("data-mode")).toBe("emergency");
    expect(container.querySelector('.screen-layer[data-kind="emergency"]')).toBeTruthy();
    const outgoingQuakeMap = container.querySelector<HTMLElement>(
      '.screen-layer[data-kind="quakeMap"]',
    );
    expect(outgoingQuakeMap).toBeTruthy();
    // vitest は component CSS を jsdom の computed style へ注入しないため、実 DOM が
    // pointer ownership selector に一致することを固定する。宣言自体は上のソース契約で検査済み。
    expect(container.querySelector(
      'main[data-mode="emergency"] .screen-layer[data-kind="quakeMap"]',
    )).toBe(outgoingQuakeMap);

    await vi.advanceTimersByTimeAsync(0);
    source!.emit("state", {
      ...quakeSnapshot,
      generatedAt: new Date(nowMs + 1_000).toISOString(),
    });
    flushSync();
    expect(main?.getAttribute("data-mode")).toBe("quakeMap");
    expect(container.querySelector('.screen-layer[data-kind="quakeMap"]')).toBeTruthy();
    const outgoingEmergency = container.querySelector<HTMLElement>(
      '.screen-layer[data-kind="emergency"]',
    );
    expect(outgoingEmergency).toBeTruthy();
    expect(container.querySelector(
      'main[data-mode="quakeMap"] .screen-layer[data-kind="emergency"]',
    )).toBe(outgoingEmergency);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    flushSync();
    expect(main?.getAttribute("data-mode")).toBe("standby");
    expect(container.querySelector('.screen-layer[data-kind="standby"]')).toBeTruthy();
  });
});
