import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DisplayIntensitySemanticV1 } from "../protocol";
import {
  intensityVisual,
  QUAKE_MAP_BADGE_FONT_USER_UNITS,
  QUAKE_MAP_BADGE_MIN_1080P_SCALE,
  QUAKE_MAP_BADGE_RADIUS_USER_UNITS,
  quakeMapPathCenter,
  quakeMapPathContainsPoint,
  quakeMapRankClass,
  quakeMapRankToken,
} from "../quake-map-colors";

function semantic(over: Partial<DisplayIntensitySemanticV1>): DisplayIntensitySemanticV1 {
  return {
    raw: "4",
    presence: "value",
    label: "4",
    condition: null,
    description: null,
    lowerBound: null,
    upperBound: null,
    rawLowerBound: null,
    rawUpperBound: null,
    badge: null,
    color: "normalRank",
    render: true,
    safetyLowerRank: 4,
    safetyUpperRank: 4,
    safetyRank: 4,
    colorRank: 4,
    ...over,
  };
}

describe("quake map colors", () => {
  it("rank 1〜9 を既存 --int-* token と同じ意味へ対応させる", () => {
    expect(Array.from({ length: 9 }, (_, index) => quakeMapRankClass(index + 1))).toEqual([
      "quake-map-rank-1",
      "quake-map-rank-2",
      "quake-map-rank-3",
      "quake-map-rank-4",
      "quake-map-rank-5",
      "quake-map-rank-6",
      "quake-map-rank-7",
      "quake-map-rank-8",
      "quake-map-rank-9",
    ]);
    expect(Array.from({ length: 9 }, (_, index) => quakeMapRankToken(index + 1))).toEqual([
      "var(--int-1)",
      "var(--int-2)",
      "var(--int-3)",
      "var(--int-4)",
      "var(--int-5)",
      "var(--int-6)",
      "var(--int-7)",
      "var(--int-8-bg)",
      "var(--int-9-bg)",
    ]);
  });

  it("未観測と未知震度を別 class にする", () => {
    expect(quakeMapRankClass(undefined)).toBe("quake-map-unobserved");
    expect(quakeMapRankClass(null)).toBe("quake-map-unobserved");
    expect(quakeMapRankClass(0)).toBe("quake-map-unknown");
    expect(quakeMapRankClass(10)).toBe("quake-map-unknown");
    expect(quakeMapRankClass(1.5)).toBe("quake-map-unknown");
    expect(quakeMapRankToken(10)).toBeNull();
  });

  it.each([
    ["value", null, "normalRank", 4, "quake-map-rank-4", true],
    ["range", "↔", "safetyUpperRank", 5, "quake-map-rank-5", true],
    ["qualitative", "≥", "safetyRank", 5, "quake-map-rank-5", true],
    ["unknown", "?", "unknown", null, "quake-map-unknown", true],
    ["empty", "∅", "neutral", null, "quake-map-neutral", true],
    ["missing", null, "notRendered", null, "quake-map-unobserved", false],
  ] as const)("semantic %s を色・badge・描画可否へ投影する", (presence, badge, color, colorRank, className, render) => {
    const visual = intensityVisual(semantic({ presence, badge, color, colorRank, render }), "9", 9);
    expect(visual).toMatchObject({ badge, colorRank, colorClass: className, render });
  });

  it("qualifier と理由を tooltip/aria へ残し、旧 wire では scalar 表示を維持する", () => {
    const lower = intensityVisual(semantic({
      raw: "5弱以上未入電",
      presence: "qualitative",
      label: "5弱以上未入電",
      condition: "5弱以上未入電",
      lowerBound: "5-",
      badge: "≥",
      color: "safetyRank",
      safetyLowerRank: 5,
      safetyUpperRank: null,
      safetyRank: 5,
      colorRank: 5,
    }), "", 0);
    expect(lower.tooltip).toBe("震度5弱以上未入電、記号 ≥: 以上（下限値）");
    expect(lower.ariaLabel).toBe(lower.tooltip);
    expect(intensityVisual(undefined, "5-", 5)).toMatchObject({ label: "5-", badge: null });
  });

  it("旧 wire の地域値は label 欠落時も rank から読み上げ文を復元する", () => {
    expect(intensityVisual(undefined, null, 5)).toMatchObject({
      render: true,
      label: "5弱",
      tooltip: "震度5弱",
      ariaLabel: "震度5弱",
    });
    expect(intensityVisual(undefined, null, 99)).toMatchObject({
      render: true,
      label: "不明",
      colorClass: "quake-map-unknown",
    });
    expect(intensityVisual(undefined, null, null).render).toBe(false);
  });

  it("Condition と Description を重複排除しつつ双方 tooltip/aria へ保持する", () => {
    const visual = intensityVisual(semantic({
      raw: "未入電",
      presence: "unknown",
      label: "不明",
      condition: "未入電",
      description: "観測値を受信していません",
      badge: "?",
      color: "unknown",
      safetyLowerRank: null,
      safetyUpperRank: null,
      safetyRank: null,
      colorRank: null,
    }), "", 0);
    expect(visual.tooltip).toBe("震度不明、記号 ?: 不明、条件: 未入電、説明: 観測値を受信していません");
    expect(visual.ariaLabel).toBe(visual.tooltip);

    const deduplicated = intensityVisual(semantic({
      condition: "注記",
      description: "注記",
    }), "", 0);
    expect(deduplicated.tooltip).toBe("震度4、理由: 注記");
  });

  it("SVG path の内部 scanline 中点を badge 座標へ解決する", () => {
    const path = "M0,0L20,0L20,10Z";
    const point = quakeMapPathCenter(path);
    expect(point).not.toBeNull();
    expect(quakeMapPathContainsPoint(path, point!)).toBe(true);
    expect(quakeMapPathCenter("Z")).toBeNull();
  });

  it("実 SVG asset 全188地域の badge 点が自地域 path 内にあり、既知の別地域侵入例も解消する", () => {
    const assetPath = join(
      __dirname,
      "..", "..", "..", "public", "maps", "quake", "area-forecast-local-e.v1.json",
    );
    const asset = JSON.parse(readFileSync(assetPath, "utf8")) as {
      pathsByCode: Record<string, string>;
    };
    const entries = Object.entries(asset.pathsByCode);
    expect(entries).toHaveLength(188);
    for (const [code, path] of entries) {
      const point = quakeMapPathCenter(path);
      expect(point, `${code} の内部点`).not.toBeNull();
      expect(quakeMapPathContainsPoint(path, point!), `${code} の内部判定`).toBe(true);
    }
    for (const [code, wrongCode] of [["110", "105"], ["251", "250"], ["702", "700"], ["711", "712"], ["753", "740"]]) {
      const ownPath = asset.pathsByCode[code]!;
      const point = quakeMapPathCenter(ownPath)!;
      expect(quakeMapPathContainsPoint(ownPath, point)).toBe(true);
      expect(quakeMapPathContainsPoint(asset.pathsByCode[wrongCode]!, point)).toBe(false);
    }
  });

  it("1080p main-stack の最小縮尺でも badge 文字を14px以上に保つ", () => {
    expect(QUAKE_MAP_BADGE_FONT_USER_UNITS * QUAKE_MAP_BADGE_MIN_1080P_SCALE).toBeGreaterThanOrEqual(14);
    expect(QUAKE_MAP_BADGE_RADIUS_USER_UNITS * 2).toBeGreaterThan(QUAKE_MAP_BADGE_FONT_USER_UNITS);
  });
});
