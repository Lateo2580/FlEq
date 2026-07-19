import { describe, expect, it } from "vitest";
import { borderBoxHeightOf, measureBorderHeight, measureHeight, observeResize, readBox } from "../measure-height";

// jsdom は ResizeObserver 未実装 (T5c 前提)。onMeasure が呼ばれないこと・例外を投げないことだけを
// 保証する (実測の幾何自体は T7 Chrome 実測対象)
describe("measureHeight", () => {
  it("ResizeObserver 未実装環境 (jsdom) では例外を投げず、onMeasure も呼ばれない", () => {
    const node = document.createElement("div");
    let called = false;
    const action = measureHeight(node, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(() => action.update?.(() => {})).not.toThrow();
    expect(() => action.destroy?.()).not.toThrow();
  });

  it("onMeasure が undefined でも例外を投げない (代表行以外の #each 要素用)", () => {
    const node = document.createElement("li");
    expect(() => measureHeight(node, undefined)).not.toThrow();
  });
});

// T6b (Codex R レビュー M3 派生 M-b 対応): border-box (padding/border 込み) を報告する variant。
// jsdom では ResizeObserver 自体が無いので measureHeight と同じく no-op 経路しか検証できない
// (border-box 抽出ロジック本体は borderBoxHeightOf の単体テストで担保する)
describe("measureBorderHeight", () => {
  it("ResizeObserver 未実装環境 (jsdom) では例外を投げず、onMeasure も呼ばれない", () => {
    const node = document.createElement("li");
    let called = false;
    const action = measureBorderHeight(node, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(() => action.update?.(() => {})).not.toThrow();
    expect(() => action.destroy?.()).not.toThrow();
  });
});

// T6c (M-a rect 鮮度対応): ペイロード無しの汎用 resize 通知 action。呼び出し側 (TsunamiPanel の
// remeasureTiles) が両方の要素を毎回まとめて読み直すことで、サイズは変わらず位置だけ動いた
// 相手要素の rect が stale になる問題を解消する (旧 measureBox は自分の rect だけを返す構造だった)
describe("observeResize", () => {
  it("ResizeObserver 未実装環境 (jsdom) では例外を投げず、onResize も呼ばれない", () => {
    const node = document.createElement("div");
    let called = false;
    const action = observeResize(node, () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(() => action.update?.(() => {})).not.toThrow();
    expect(() => action.destroy?.()).not.toThrow();
  });

  it("onResize が undefined でも例外を投げない", () => {
    const node = document.createElement("div");
    expect(() => observeResize(node, undefined)).not.toThrow();
  });
});

// readBox: getBoundingClientRect() から border-box 高さ・top/bottom をそのまま読む薄いヘルパー。
// jsdom は layout 未解決 (getBoundingClientRect は全 0 を返す) だが、0 が一貫して返ることと
// 例外を投げないことは検証できる (幾何の実値自体は T7 Chrome 実測対象)
describe("readBox", () => {
  it("getBoundingClientRect() の height/top/bottom をそのまま MeasuredBox として返す", () => {
    const node = document.createElement("div");
    const box = readBox(node);
    expect(box).toEqual({ height: 0, top: 0, bottom: 0 }); // jsdom は layout 未解決なので全 0
  });
});

// borderBoxHeightOf: ResizeObserverEntry から border-box 高さを取り出す純関数部分。
// 実ブラウザの ResizeObserverEntry を jsdom で再現できないため、必要なプロパティだけを
// 持つ最小限のフェイクオブジェクトで両方の分岐 (borderBoxSize 対応 / 未対応フォールバック) を検証する
describe("borderBoxHeightOf", () => {
  function fakeEntry(overrides: { borderBoxSize?: unknown; getBoundingClientRectHeight?: number }) {
    const { getBoundingClientRectHeight = 0, borderBoxSize } = overrides;
    return {
      target: {
        getBoundingClientRect: () => ({ height: getBoundingClientRectHeight }) as DOMRect,
      } as Element,
      borderBoxSize,
    } as unknown as ResizeObserverEntry;
  }

  it("borderBoxSize が配列で提供されるとき、先頭要素の blockSize を返す (仕様どおりの主要ブラウザ経路)", () => {
    const entry = fakeEntry({
      borderBoxSize: [{ blockSize: 48, inlineSize: 300 }],
      getBoundingClientRectHeight: 999, // borderBoxSize があればこちらは使われないはず
    });
    expect(borderBoxHeightOf(entry)).toBe(48);
  });

  it("borderBoxSize が単一オブジェクトで提供されるとき (過去実装との互換) も blockSize を返す", () => {
    const entry = fakeEntry({ borderBoxSize: { blockSize: 36, inlineSize: 200 } });
    expect(borderBoxHeightOf(entry)).toBe(36);
  });

  it("borderBoxSize が無い (未対応環境) ときは getBoundingClientRect().height にフォールバックする", () => {
    const entry = fakeEntry({ borderBoxSize: undefined, getBoundingClientRectHeight: 52 });
    expect(borderBoxHeightOf(entry)).toBe(52);
  });

  it("borderBoxSize が空配列のときも getBoundingClientRect().height にフォールバックする", () => {
    const entry = fakeEntry({ borderBoxSize: [], getBoundingClientRectHeight: 40 });
    expect(borderBoxHeightOf(entry)).toBe(40);
  });
});
