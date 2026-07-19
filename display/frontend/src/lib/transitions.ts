import { cubicOut } from "svelte/easing";
import type { TransitionConfig } from "svelte/transition";
import type { AnimationConfig } from "svelte/animate";
import { springSpatialOut, springEffectsOut } from "./motion";

// Svelte 組込 scale の代替。transform(scale) は spatial spring (overshoot 可)、
// opacity は non-overshoot ease (cubicOut) に分離する。組込 scale は両者を同一 easing で
// 動かすため overshoot が opacity にも乗る (effects=opacity は overshoot 禁止) のを避ける。
// 既存 transform (同時走行する animate:flip 等) を保持して scale を前置合成する
// (組込 scale も getComputedStyle で既存 transform を読み合成する。Codex R2-4)。
export function spatialScaleIn(
  node: Element,
  { duration, start = 0.97 }: { duration: number; start?: number },
): TransitionConfig {
  const existing = getComputedStyle(node).transform;
  const base = existing && existing !== "none" ? `${existing} ` : "";
  return {
    duration,
    css: (t: number): string => {
      const s = start + (1 - start) * springSpatialOut(t); // overshoot 可
      const o = cubicOut(t); // opacity は単調・overshoot なし
      return `transform: ${base}scale(${s}); opacity: ${o};`;
    },
  };
}

// 緊急コールド/入場の画面味付け。transform(scale) のみで opacity を書かない
// (情報は 1 フレーム目から可視、spec §1 原則1)。
export function emergencyEnter(
  node: Element,
  { duration }: { duration: number },
): TransitionConfig {
  const existing = getComputedStyle(node).transform;
  const base = existing && existing !== "none" ? `${existing} ` : "";
  return {
    duration,
    css: (t: number): string => `transform: ${base}scale(${0.985 + 0.015 * springSpatialOut(t)});`,
  };
}

// 汎用入場: transform(spatial, overshoot 可) + opacity(cubicOut)。第 2 引数 reveal で
// 初期 population (reveal=false) か後発追加 (reveal=true) かを明示制御する (spec §0-d)。
// reveal=false は演出なし (duration 0・opacity 1) で 1 フレーム目から可視。
export function revealScaleIn(
  node: Element,
  { reveal, duration }: { reveal: boolean; duration: number },
): TransitionConfig {
  if (!reveal) return { duration: 0, css: () => "opacity: 1;" };
  const existing = getComputedStyle(node).transform;
  const base = existing && existing !== "none" ? `${existing} ` : "";
  return {
    duration,
    css: (t: number): string =>
      `transform: ${base}scale(${0.97 + 0.03 * springSpatialOut(t)}); opacity: ${cubicOut(t)};`,
  };
}

// svelte/animate の flip と同型だが scale を出さない translate-only の並べ替えアニメ (spec §2、
// 2026-07-13)。緊急パネルの枚数増減による「サイズ変化」はグリッド track 補間 (EmergencyScreen の
// .panels CSS transition) が担うため、FLIP からは scale を外し priority 割込みによる「位置の入替」
// だけを補正する。組込 flip (node_modules/svelte/src/animate/index.js) と同じく getComputedStyle で
// 既存 transform を読み、translate を前置合成する (併走する transform を保持する)。
export function flipTranslate(
  node: Element,
  { from, to }: { from: DOMRect; to: DOMRect },
  { delay = 0, duration = 0, easing = cubicOut }: { delay?: number; duration?: number; easing?: (t: number) => number } = {},
): AnimationConfig {
  const style = getComputedStyle(node);
  const transform = style.transform === "none" ? "" : style.transform;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  return {
    delay,
    duration,
    easing,
    css: (_t: number, u: number): string => `transform: ${transform} translate(${u * dx}px, ${u * dy}px);`,
  };
}

// 高さ reveal: 0→自然高 (実測 scrollHeight, px)。easing は effects 系 (臨界減衰・単調、
// spec §0-e。spatial は overshoot して周囲を揺らすため使わない)。reveal=false は演出なし。
export function heightReveal(
  node: Element,
  { reveal, duration }: { reveal: boolean; duration: number },
): TransitionConfig {
  if (!reveal) return { duration: 0, css: () => "" };
  const h = (node as HTMLElement).scrollHeight;
  return {
    duration,
    css: (t: number): string => `height: ${springEffectsOut(t) * h}px; overflow: hidden;`,
  };
}
