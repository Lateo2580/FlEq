import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXIT_MS, springEffectsOut, springSpatialOut } from "../motion";
import { SPRING_DURATIONS_MS, SPRING_LINEARS } from "../motion.generated";
import { spatialScaleIn } from "../transitions";

function themeCss(): string {
  return readFileSync(join(__dirname, "..", "theme.css"), "utf-8");
}

function durMs(css: string, token: string): number {
  const m = css.match(new RegExp(`--${token}:\\s*(\\d+)ms`));
  expect(m, `token --${token} が theme.css に無い`).toBeTruthy();
  return Number(m![1]);
}

describe("theme.css の spring block は motion.generated.ts の忠実なミラー", () => {
  it("各 spring の dur と linear() が生成物と一致する", () => {
    const css = themeCss();
    for (const name of Object.keys(SPRING_DURATIONS_MS)) {
      expect(durMs(css, `${name}-dur`)).toBe(SPRING_DURATIONS_MS[name]);
      expect(css, `--${name} の linear() が生成物と不一致 (generate-springs.mjs --write を再実行)`)
        .toContain(`--${name}: ${SPRING_LINEARS[name]};`);
    }
  });

  it("退場 duration は 200ms で theme.css の --dur-exit と一致する", () => {
    expect(durMs(themeCss(), "dur-exit")).toBe(EXIT_MS);
  });

  it("StandbyScreen は duration をハードコードせず motion から読む", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components", "StandbyScreen.svelte"), "utf-8");
    expect(src).toContain('from "../lib/motion"');
    expect(src).not.toMatch(/reducedMotion \? 0 : 435/);
    expect(src).not.toMatch(/reducedMotion \? 0 : 200/);
  });
});

describe("springSpatialOut easing", () => {
  it("0→0, 1→1、区間内で overshoot する", () => {
    expect(springSpatialOut(0)).toBe(0);
    expect(springSpatialOut(1)).toBe(1);
    expect(Math.abs(springSpatialOut(0.999) - 1)).toBeLessThan(0.02);
    let maxV = 0;
    for (let i = 1; i < 100; i++) maxV = Math.max(maxV, springSpatialOut(i / 100));
    expect(maxV).toBeGreaterThan(1); // spatial は overshoot あり
  });
});

// T5c: ページ切替の重ねクロスフェード (spec §3 再々改訂)。新規の時間定数を作らず既存の
// spring-effects-default (231ms, damping=1 臨界減衰) を Svelte transition:fade の easing として
// 再利用する。CSS の --spring-effects-default linear() を生成する式と同じ物理の JS 版
describe("springEffectsOut easing", () => {
  it("0→0, 1→1、overshoot なし (effects=opacity は overshoot 禁止)", () => {
    expect(springEffectsOut(0)).toBe(0);
    expect(springEffectsOut(1)).toBe(1);
    expect(Math.abs(springEffectsOut(0.999) - 1)).toBeLessThan(0.02);
    for (let i = 0; i <= 100; i++) {
      expect(springEffectsOut(i / 100)).toBeLessThanOrEqual(1.0001);
    }
  });

  it("単調増加 (臨界減衰は振動しない)", () => {
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = springEffectsOut(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

describe("spatialScaleIn custom transition", () => {
  it("transform は spring (overshoot 可)、opacity は overshoot しない", () => {
    const cfg = spatialScaleIn(document.createElement("div"), { duration: 435, start: 0.97 });
    const css = cfg.css!;
    // 端点
    expect(css(0, 1)).toContain("opacity: 0");
    expect(css(1, 0)).toContain("opacity: 1");
    // opacity は全域で [0,1] を超えない (effects=overshoot 禁止)
    for (let i = 0; i <= 100; i++) {
      const s = css(i / 100, 1 - i / 100);
      const op = Number(s.match(/opacity:\s*([\d.]+)/)![1]);
      expect(op).toBeLessThanOrEqual(1);
      expect(op).toBeGreaterThanOrEqual(0);
    }
  });

  it("既存 transform を保持して scale を前置合成する (Codex R2-4)", () => {
    const node = document.createElement("div");
    node.style.transform = "translateX(10px)";
    const cfg = spatialScaleIn(node, { duration: 435, start: 0.97 });
    // 既存 transform が scale の前に残る (flip 等と同時走行しても潰さない)
    expect(cfg.css!(0.5, 0.5)).toMatch(/transform:\s*translateX\(10px\)\s+scale\(/);
  });
});
