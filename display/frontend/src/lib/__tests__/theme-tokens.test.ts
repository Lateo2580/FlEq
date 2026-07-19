import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "..", "theme.css"), "utf-8");

function hasToken(name: string, value: string): void {
  // 空白差を吸収して "--name: value;" の存在を確認する
  const re = new RegExp(`--${name}:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*;`);
  expect(css, `token --${name}: ${value}; が theme.css に無い`).toMatch(re);
}

describe("theme.css トークン定義 (Phase A2)", () => {
  it("shape scale 7 段が定義されている", () => {
    hasToken("radius-xs", "4px");
    hasToken("radius-s", "8px");
    hasToken("radius-m", "12px");
    hasToken("radius-l", "16px");
    hasToken("radius-xl", "28px");
    hasToken("radius-full", "999px");
  });
  it("surface container 5 段が定義されている", () => {
    hasToken("surface-lowest", "#030405");
    hasToken("surface-low", "#070a0c");
    hasToken("surface-container", "#0b0f12");
    hasToken("surface-high", "#10161a");
    hasToken("surface-highest", "#171f25");
  });
  it("elevation 3 段が定義されている", () => {
    for (const n of ["elevation-1", "elevation-2", "elevation-3"]) {
      expect(css).toMatch(new RegExp(`--${n}:\\s*[^;]*rgba`));
    }
  });
  it("spacing scale 12 段 (4px グリッド) が定義されている", () => {
    hasToken("space-1", "4px");
    hasToken("space-6", "24px");
    hasToken("space-12", "48px");
  });
  it("ヘッダ container/on/band トークンが 10 ロール分 + band-width + jma-purple alias まで theme.css に定義されている (Codex R4/R6)", () => {
    const roles = [
      "eewWarning", "eewForecast", "quakeCritical", "quakeWarning",
      "tsunamiMajor", "tsunamiWarning", "tsunamiAdvisory",
      "weatherEmergency", "weatherWarning", "weatherAdvisory",
    ];
    for (const r of roles) {
      expect(css, `--header-${r}-container 未定義`).toMatch(new RegExp(`--header-${r}-container:\\s*[^;]+;`));
      expect(css, `--header-${r}-on 未定義`).toMatch(new RegExp(`--header-${r}-on:\\s*[^;]+;`));
      expect(css, `--header-band-${r} 未定義`).toMatch(new RegExp(`--header-band-${r}:\\s*[^;]+;`));
    }
    expect(css).toMatch(/--header-band-width:\s*calc\(4px \* var\(--panel-scale, 1\)\)/);
    expect(css).toMatch(/--c-jma-purple-bar:\s*var\(--c-tsunami-purple-bar\)/);
  });
  it("待機時計は白寄り輝度 (#eef2f6) に更新されている", () => {
    hasToken("clock-fg", "#eef2f6");
  });
  it("weight スウェル duration トークンが定義され、tier の num-weight 上書きは残っている", () => {
    hasToken("dur-weight-swell", "200ms");
    expect(css).toMatch(/data-tier="critical"[\s\S]*--num-weight:\s*var\(--type-weight-heavy\)/);
  });
  it("ticker-label のパディングが instrument 化で 0.9em に更新されている", () => {
    hasToken("ticker-label-pad", "0.9em");
  });
});
