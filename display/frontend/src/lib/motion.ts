// motion duration/physics は generate-springs.mjs が単一真実源。ここは生成物 (motion.generated.ts)
// を型付きで再公開する薄いラッパ。__tests__/motion.test.ts が theme.css を生成物のミラーとして固定する。
import { SPRING_DURATIONS_MS, SPRING_LINEARS, SPRING_SPECS } from "./motion.generated";

export const SPRING_SPATIAL_DEFAULT_MS = SPRING_DURATIONS_MS["spring-spatial-default"];
export const SPRING_SPATIAL_QUICK_MS = SPRING_DURATIONS_MS["spring-spatial-quick"];
export const SPRING_SPATIAL_SLOW_MS = SPRING_DURATIONS_MS["spring-spatial-slow"];
export const SPRING_EFFECTS_DEFAULT_MS = SPRING_DURATIONS_MS["spring-effects-default"];
export const SPRING_EFFECTS_SLOW_MS = SPRING_DURATIONS_MS["spring-effects-slow"];
// 退場 (opacity のみ) の共通 duration。spring 非依存 (spec §4「消失感を出さない」)。theme.css の --dur-exit と一致。
export const EXIT_MS = 200;

export { SPRING_LINEARS, SPRING_SPECS };

// spatial spring の easing (JS 版)。物理は generator 単一真実源 (SPRING_SPECS の
// spring-spatial-default) から取る。t∈[0,1] を settle 時刻まで正規化した単位ステップ応答を返す。
// 位置・スケール用で overshoot (>1) を許す。opacity には使わない (transitions.ts で分離)。
const SPATIAL = SPRING_SPECS["spring-spatial-default"];
const SPATIAL_WN = Math.sqrt(SPATIAL.stiffness); // = sqrt(stiffness/mass), mass=1
const SPATIAL_ZETA = SPATIAL.damping;
const SPATIAL_SETTLE_S = SPRING_SPATIAL_DEFAULT_MS / 1000; // generator と同じ settle 時刻 (秒)
function springPos(tSec: number): number {
  const wd = SPATIAL_WN * Math.sqrt(1 - SPATIAL_ZETA * SPATIAL_ZETA);
  return (
    1 -
    Math.exp(-SPATIAL_ZETA * SPATIAL_WN * tSec) *
      (Math.cos(wd * tSec) + ((SPATIAL_ZETA * SPATIAL_WN) / wd) * Math.sin(wd * tSec))
  );
}
export function springSpatialOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return springPos(t * SPATIAL_SETTLE_S);
}

// effects spring (opacity/色用、overshoot 禁止) の easing (JS 版)。物理は generate-springs.mjs の
// SPRING_SPECS["spring-effects-default"] (damping=1、臨界減衰) と同じ式 — CSS 側の
// --spring-effects-default linear() を生成する式そのものを JS 関数として再公開する (二重定義では
// なく同じ物理の別表現)。Svelte の transition:fade の easing にそのまま渡せる (T5c、ページ切替の
// 重ねクロスフェード。spec §3 再々改訂「新規の時間定数は作らない、既存トークンを流用」)
const EFFECTS = SPRING_SPECS["spring-effects-default"];
const EFFECTS_WN = Math.sqrt(EFFECTS.stiffness);
const EFFECTS_SETTLE_S = SPRING_EFFECTS_DEFAULT_MS / 1000;
function springEffectsPos(tSec: number): number {
  // 臨界減衰 (damping=1) の閉形式。underdamped 式 (springPos 上) は zeta=1 で wd=0 になり
  // 0 除算するため、generate-springs.mjs の springPos と同じ分岐式をそのまま使う
  return 1 - Math.exp(-EFFECTS_WN * tSec) * (1 + EFFECTS_WN * tSec);
}
export function springEffectsOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return springEffectsPos(t * EFFECTS_SETTLE_S);
}
