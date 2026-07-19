// jsdom は Web Animations API (Element.prototype.animate) を実装していない。
// Svelte 5 の svelte/transition・svelte/animate (flip) はこの API を直接呼ぶため、
// 未実装のままだと `element.animate is not a function` で render が例外を投げる。
// テストは完了イベントを待たないため、最小限のスタブ (即時 finish 可能) を用意すれば足りる。
class FakeAnimation {
  currentTime = 0;
  playState: AnimationPlayState = "running";
  onfinish: (() => void) | null = null;
  effect: AnimationEffect | null = null;
  cancel(): void {
    this.playState = "idle";
  }
  finish(): void {
    this.playState = "finished";
    this.onfinish?.();
  }
}

if (typeof Element !== "undefined" && typeof Element.prototype.animate !== "function") {
  Element.prototype.animate = function (
    _keyframes: unknown,
    _options?: number | KeyframeAnimationOptions,
  ): Animation {
    const anim = new FakeAnimation();
    // teardown 後に onfinish が発火するリスクを断つため、実 duration を待たず即時 finish する
    setTimeout(() => anim.finish(), 0);
    return anim as unknown as Animation;
  };
}

// jsdom は Element.prototype.getAnimations も未実装。Svelte 5 の animate:flip は要素の既存アニメを
// getAnimations() で取得してキャンセルしてから新アニメを張るため、keyed each の post-mount 増減
// (地震履歴クリックで corner-item が入れ替わる等) で未実装だと `getAnimations is not a function` を
// 投げ、outro が完了せず要素が残る。空配列を返すスタブで足りる (キャンセル対象なし)。
if (typeof Element !== "undefined" && typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = function (): Animation[] {
    return [];
  };
}
